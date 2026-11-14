// Files a message carries with their contents (as a phone sends them): kept on this box, in its
// `attachments` folder, so the agent can open each with its tools. The session's model gets as
// files only what it can read, as the Mac's own messages do (Attachments.swift): words always, a
// PDF if it reads PDFs, a picture if it sees pictures. Anything else waits on the box for the
// agent, and the note at the message's end says where each file is. They're kept a folder for each
// session, and go with it (`letAttachmentsGo`).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { conversationOf, everySession } from "../engine/conversations";
import { engineGet } from "../engine/client";
import { attachmentRoots, K } from "../home";
import { droppedHere, frozen, movedAway } from "../moves/records";
import { withAttachedNote } from "../peers/naming";
import { AGENTS_TEXT_BYTES } from "../../shared/text";
import type { Target } from "../../shared/records";

// What the session's model takes as input ("text", "image", "pdf"…), or null when that can't be
// found out (then it gets every file, as before).
export type ModelInput = (session: string) => Promise<string[] | null>;

export interface PromptFile { uri?: unknown; name?: unknown }

// `body` with its inline files kept on the box and only what the model reads left as files;
// anything else as it is. A note the message ends with already joins this one only when it's the
// Mac's own (`joinsNote`), never words a phone's message ends with. When the model's input can't
// be found out, a PDF or a picture goes to it anyway, except for the coding agents (`toAgents`), who
// open files from where they're kept, and get text in the message only as much as their bridge
// puts in it.
export async function attachedIn(body: Buffer | undefined, session: string, modelInput: ModelInput, joinsNote = false, toAgents = false): Promise<Buffer | undefined> {
  let prompt: { text?: unknown; files?: unknown } | null;
  try { prompt = JSON.parse(Buffer.from(body ?? "").toString()); } catch { return body; }
  if (!prompt || !Array.isArray(prompt.files)) return body;
  const kept = await keptFiles(prompt.files, session, modelInput, toAgents);
  if (!kept) return body;
  const text = typeof prompt.text === "string" ? prompt.text : "";
  return Buffer.from(JSON.stringify({ ...prompt, text: withAttachedNote(text, kept.included, kept.paths, joinsNote), files: kept.files.length ? kept.files : undefined }));
}

/** A message's files as `attachedIn` sends them: those it carries inline kept on this box, and only
 * what the model reads left as files (`files`); where the kept ones are, for its note (`included`,
 * those it reads too; `paths`, those the agent opens). Null when it carries none inline. */
export async function keptFiles(given: unknown[], session: string, modelInput: ModelInput, toAgents = false): Promise<{ files: PromptFile[]; included: string[]; paths: string[] } | null> {
  const files = given as PromptFile[];
  if (!files.some(file => inline(file) !== null)) return null;
  const input = await modelInput(session).catch(() => null);
  const attachments = path.join(K, "attachments");
  letOldGo(attachments);
  const folder = SESSION.test(session) ? path.join(attachments, session) : attachments;
  const sent: PromptFile[] = [], included: string[] = [], paths: string[] = [];
  for (const file of files) {
    const data = inline(file);
    if (!data) {
      sent.push(file);
      continue;
    }
    const saved = save(folder, data.bytes, typeof file.name === "string" ? file.name : "");
    if (reads(data.mime, data.bytes.length, input, !toAgents, toAgents ? AGENTS_TEXT_BYTES : MODEL_BYTES)) {
      // Text the engine reads as words only when it's `text/plain`; any other type goes to the
      // model as a file it can't open (Markdown, JSON).
      sent.push(isText(data.mime) && data.mime !== "text/plain" ? { ...file, uri: `data:text/plain;base64,${data.bytes.toString("base64")}` } : file);
      if (saved) included.push(saved);
    } else if (saved) {
      paths.push(saved);
    } else {
      // It couldn't be kept here: it goes as it came.
      sent.push(file);
    }
  }
  return { files: sent, included, paths };
}

// A file sent with its contents (a base64 `data:` URI): its type and bytes.
function inline(file: PromptFile): { mime: string; bytes: Buffer } | null {
  const match = typeof file?.uri === "string" ? /^data:([^;,]*)((?:;[^;,]*)*);base64,/.exec(file.uri) : null;
  if (!match) return null;
  return { mime: (match[1] || "application/octet-stream").toLowerCase(), bytes: Buffer.from((file.uri as string).slice(match[0].length), "base64") };
}

// What a file the model reads can weigh, as the Mac's own (Attachments.maxBytes): a bigger one
// waits on the box for the agent.
const MODEL_BYTES = 20 * 1024 * 1024;
// Kinds of text that aren't `text/…` by their type.
const TEXT_TYPES = new Set(["application/json", "application/javascript", "application/xml", "application/x-yaml", "application/yaml", "application/toml", "application/x-sh", "application/sql"]);

// Whether a file of type `mime` is words.
const isText = (mime: string): boolean => mime.startsWith("text/") || TEXT_TYPES.has(mime);

// Whether a model with `input` reads a file of type `mime`, `size` bytes, as it is; one whose
// input isn't known, as `guess` says. Text over `textBytes` it opens itself.
function reads(mime: string, size: number, input: string[] | null, guess: boolean, textBytes: number): boolean {
  if (size > MODEL_BYTES) return false;
  if (isText(mime)) return size <= textBytes;
  if (mime === "application/pdf") return input?.includes("pdf") ?? guess;
  if (mime.startsWith("image/")) return input?.includes("image") ?? guess;
  return false;
}

// How long a file sent with a message is kept on the box, for the agent to open again.
const KEPT_DAYS = 14;

// `bytes` in a folder of its own in `attachments` (two can have the same name), under its own
// name; its path, or null when it can't be written.
function save(attachments: string, bytes: Buffer, name: string): string | null {
  const given = path.basename(name.replace(/\\/g, "/")).trim();
  const base = ["", ".", ".."].includes(given) ? "attachment" : given;
  try {
    fs.mkdirSync(attachments, { recursive: true });
    let folder = "";
    // A folder that's there already (a name drawn twice) is never shared.
    for (let tries = 0; !folder; tries++) {
      const drawn = path.join(attachments, crypto.randomBytes(4).toString("hex"));
      try {
        fs.mkdirSync(drawn);
        folder = drawn;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || tries > 8) throw error;
      }
    }
    const file = path.join(folder, base);
    fs.writeFileSync(file, bytes);
    return file;
  } catch {
    return null;
  }
}

// The kept files sent more than `KEPT_DAYS` ago: in their session's folder (and that folder, once
// it's empty), or in `attachments` itself, as they were kept before.
function letOldGo(attachments: string): void {
  const before = Date.now() - KEPT_DAYS * 24 * 60 * 60 * 1000;
  for (const name of listOf(attachments)) {
    const folder = path.join(attachments, name);
    if (!SESSION.test(name)) {
      try { if (fs.statSync(folder).mtimeMs < before) fs.rmSync(folder, { recursive: true, force: true }); } catch {}
      continue;
    }
    for (const sent of listOf(folder)) {
      try { if (fs.statSync(path.join(folder, sent)).mtimeMs < before) fs.rmSync(path.join(folder, sent), { recursive: true, force: true }); } catch {}
    }
    try { fs.rmdirSync(folder); } catch {}
  }
}

// What's in `folder`, or nothing when it can't be read.
function listOf(folder: string): string[] {
  try { return fs.readdirSync(folder); } catch { return []; }
}

// A session's name, as its files' folder is named (anything else keeps them as before, in
// `attachments` itself).
const SESSION = /^ses_[A-Za-z0-9_-]{1,120}$/;

/** Where a box's sessions are: its engine, and its coding agents' bridge (null when it isn't running). */
export interface SessionPlaces { engine: Target; bridge: Target | null }

// Where sessions' files are kept: this box's, and on this Mac's box, the Mac app's.
const keptIn = attachmentRoots;

// One look at a time: a session deleted while the box looks over the rest waits for it.
let looking: Promise<void> = Promise.resolve();

/** A deleted session's files (`session`), or with none named, those of every session the box no
 * longer has (looked over as it finds its engine again, for any deleted while it wasn't
 * listening): gone, unless a conversation still there shows them. Anything it can't be sure of
 * stays. */
export function letAttachmentsGo(places: SessionPlaces, session?: string): Promise<void> {
  looking = looking.then(() => letGo(places, session)).catch(() => {});
  return looking;
}

async function letGo({ engine, bridge }: SessionPlaces, session?: string): Promise<void> {
  // With the bridge not running, its sessions can't be told from deleted ones, nor read for what
  // they show: everything stays.
  if (!bridge) return;
  // One moving to another computer, moved there lately, or a copy of one let go of here as its move
  // was taken back, is deleted here as it goes: it lives on there, and the Mac app shows its files.
  const moving = new Set([...frozen(), ...movedAway().map(each => each.session), ...droppedHere()]);
  let gone: string[];
  if (session !== undefined) {
    if (!SESSION.test(session) || moving.has(session)) return;
    gone = [session];
  } else {
    // Only what neither place has, and only in this box's own folder: the Mac app's keeps the files
    // of conversations on other computers too, moved there long ago among them (the app lets those
    // go as they're deleted there).
    gone = [];
    for (const name of listOf(path.join(K, "attachments")).filter(name => SESSION.test(name) && !moving.has(name))) {
      if (await isGone(engine, name) && await isGone(bridge, name)) gone.push(name);
    }
  }
  const roots = session !== undefined ? keptIn() : [path.join(K, "attachments")];
  const folders = gone.flatMap(id => roots.map(root => path.join(root, id))).filter(folder => fs.existsSync(folder));
  if (!folders.length) return;
  const shown = await stillShown([engine, bridge], gone);
  for (const folder of folders) {
    if (!shown.has(path.basename(folder))) fs.rmSync(folder, { recursive: true, force: true });
  }
}

// Whether `place` says it has no session `id` (not that it couldn't answer).
const isGone = (place: Target, id: string) => engineGet(place, `api/session/${encodeURIComponent(id)}`).then(() => false, error => (error as Error)?.message === "404");

// What marks a conversation that started from another's words (a branch, a handoff, one carried on
// with the coding agents, or one an agent started; older ones `beside`), which can show the files
// in them.
const FROM = ["branchedFrom", "handoffFrom", "carriedFrom", "startedBy", "beside"];

// Which of the sessions `ids` a conversation in `places` still shows files of: read only where
// what it came from leads back to one of them, or to a session no longer here (whose own start
// can't be followed). It throws when they can't all be read: then everything stays.
async function stillShown(places: Target[], ids: string[]): Promise<Set<string>> {
  const gone = new Set(ids);
  // (One both places list is read in each.)
  const sessions = new Map<string, { places: Target[]; from: string[] }>();
  for (const place of places) {
    for (const session of await everySession(place)) {
      const kuvo = session.metadata?.kuvo as Record<string, unknown> | undefined;
      const seen = sessions.get(session.id) ?? { places: [], from: [] };
      seen.places.push(place);
      seen.from.push(...FROM.map(key => kuvo?.[key]).filter((each): each is string => typeof each === "string"));
      sessions.set(session.id, seen);
    }
  }
  const leadsBack = (id: string, seen: Set<string>): boolean => (sessions.get(id)?.from ?? []).some(from => {
    if (gone.has(from) || !sessions.has(from)) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return leadsBack(from, seen);
  });
  const shown = new Set<string>();
  for (const [id, { places }] of sessions) {
    if (!leadsBack(id, new Set([id]))) continue;
    for (const place of places) {
      const words = JSON.stringify(await conversationOf(place, id));
      for (const each of ids) if (new RegExp(`attachments/${each}/`, "i").test(words)) shown.add(each);
    }
  }
  return shown;
}
