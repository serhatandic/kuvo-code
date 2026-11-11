// Documents, between this box and the others
// What other boxes send taken, and what changed here sent, as documents/work says.

import { IS_MAC } from "../home";
import { forgetMacsAgents, writeAgents } from "../peers/agents";
import { mailFor } from "../peers/known";
import { readPersonalities } from "../personalities/library";
import { takePersonalities } from "../personalities/take";
import { writeCard } from "../setup/card";
import { macLink, updateLink } from "../state";
import { changedWork, docMails, docsWork, greetWork } from "./work";
import type { PersonalityLibrary } from "../personalities/library";
import type { LinkHost } from "../relay/host";
import type { LinkState } from "../state";
import type { PendingParts } from "./parts";
import type { DocSend, DocSender, DocsMail, DocsState } from "./work";

/** What follows documents taken (`docsWork`): the Macs that let this box go, and what goes to whom. */
type DocsDone = Pick<ReturnType<typeof docsWork>, "left" | "send">;

// Parts of documents on their way here, from each box (`assemble`).
const docParts = new Map<string, PendingParts>();

// Sends what `work` says goes (`[{to, docs}]`), in as many mails as each takes.
function sendDocs(host: Pick<LinkHost, "send"> | null | undefined, link: LinkState, sends: DocSend[] | null | undefined): void {
  if (!host || !link?.key) return;
  for (const { to, docs } of sends ?? []) {
    for (const payload of docMails(docs)) {
      const bytes = mailFor(to, { docs: payload, at: Date.now() }, link);
      if (bytes) try { host.send(bytes); } catch {}
    }
  }
}

// What another box or a Mac sent of documents, taken under link.json's lock: your personalities met
// with this box's (its bots told of those that changed), its phones as its documents say now (one
// removed losing its sessions), a Mac that's let it go forgotten, and what goes on, sent.
export async function receiveDocs(sender: DocSender, docs: DocsMail, host: LinkHost | null | undefined): Promise<void> {
  const before = readPersonalities();
  // (Set inside updateLink's change, which TypeScript can't follow: hence the `as`.)
  let work = null as DocsDone | null, library = before, setup = "";
  const link = updateLink(link => {
    if (!link) return null;
    setup = JSON.stringify(link.setup ?? null);
    const state: DocsState = { link, library: before, parts: docParts };
    work = docsWork(state, sender, docs);
    library = state.library;
    return link;
  });
  if (!work || !link) return;
  // Its setup changed with them (taken, or set aside): its card says so now.
  if (JSON.stringify(link.setup ?? null) !== setup) try { writeCard(); } catch {}
  await afterDocs(work, before, library, link, host);
}

async function afterDocs(work: DocsDone, before: PersonalityLibrary, library: PersonalityLibrary, link: LinkState, host: LinkHost | null | undefined): Promise<void> {
  if (library !== before) await takePersonalities(library).catch(() => {});
  for (const mac of work.left) forgetMacsAgents(mac, link);
  host?.keepOnly?.(new Set((link.phones ?? []).map(phone => phone.key)));
  writeAgents(link);
  sendDocs(host, link, work.send);
}

// Something changed here, or this box just connected (`greet`): its own documents that changed go
// to the others, and with `tell` (a Mac's documents came over SSH) or `greet`, its digest.
export function docsChanged(host: LinkHost | null | undefined, { greet = false, tell = false }: { greet?: boolean; tell?: boolean } = {}): void {
  const library = readPersonalities();
  // (Set inside updateLink's change, which TypeScript can't follow: hence the `as`.)
  let work = null as { send: DocSend[] } | null;
  const link = updateLink(link => {
    if (!link?.sign) return null;
    work = greet ? greetWork({ link, library }) : changedWork({ link, library }, tell);
    return link;
  });
  if (work && link) {
    // (This Mac's box lets phones go a moment after, as it writes its link: a phone that removed
    // itself gets its answer first.)
    if (!IS_MAC) host?.keepOnly?.(new Set((link.phones ?? []).map(phone => phone.key)));
    sendDocs(host, link, work.send);
  }
}

// Something of this Mac's documents changed (a phone, a personality, your machines): what changed
// goes to your machines now, if it's on the relay; they get it as they meet otherwise.
export function macDocsChanged(): void {
  const host = macLink.host;
  if (host?.welcomed) try { docsChanged(host); } catch {}
}