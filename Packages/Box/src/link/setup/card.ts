// This box's setup card (PROTOCOL.md, "Your setup"): a short file beside link.json with nothing
// secret in it, `run/setup-card.json`, for what looks at this computer from outside the box to read
// (whether it's in a setup, and whose): Kuvo Code on this computer as it opens, and a Mac adding it
// over SSH. Written as the setup's looked at, and only when it changed.

import fs from "node:fs";
import path from "node:path";
import { writePrivate } from "../files";
import { IS_MAC, RUN } from "../home";
import { ATTACHED_FILE } from "./judge";
import { macsOf, ownKey } from "../peers/known";
import { readPeerAgents } from "../peers/directory";
import { readLink } from "../state";
import { allItems } from "../work-queue/store";
import { setupView } from "./view";

export const SETUP_CARD = path.join(RUN, "setup-card.json");

/** What the card says: the setup and its epoch, this box's role, its main computer (when it was last
 * heard from, ms; null on the main computer itself), this box, whether Kuvo Code's app runs it (or
 * attached to it in place), how
 * many computers the setup has, how many Work Queue items are here, the machines holding this Mac
 * back from leading one (`heldBy`), and the Macs that set this box up, by name (a machine's: none on
 * a Mac), for a box in no setup to be judged by (`judge.ts`). */
export function cardNow(): Record<string, unknown> {
  const link = readLink();
  const view = setupView(link);
  const own = link ? ownKey(link) : null;
  const primary = view.primary;
  const heard = !primary || primary.key === own ? null : (link?.macSeen?.[primary.key] ?? readPeerAgents()[primary.key]?.heard ?? null);
  let items = 0;
  try { items = allItems().filter(item => !item.removed).length; } catch {}
  return {
    setup: view.setup,
    epoch: view.epoch,
    role: view.you.role,
    primary: primary ? { key: primary.key, name: primary.name, heard } : null,
    self: { key: own, name: String(link?.name ?? ""), kind: IS_MAC ? "mac" : "machine" },
    // (Or Kuvo Code on this Mac attached to it in place: `POST kuvo/setup/attached`.)
    app: IS_MAC || fs.existsSync(path.join(RUN, ATTACHED_FILE)),
    computers: view.computers.length,
    items,
    heldBy: view.heldBy,
    macs: macsOf(link).map(key => ({ key, name: String(link?.macNames?.[key] ?? "") })),
  };
}

let written = "";
/** The card written, if it changed. */
export function writeCard(): void {
  const text = JSON.stringify(cardNow());
  if (text === written && fs.existsSync(SETUP_CARD)) return;
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  writePrivate(SETUP_CARD, text);
  written = text;
}
