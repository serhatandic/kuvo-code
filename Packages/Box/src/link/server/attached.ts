// Files a message carries with their contents (as a phone sends them): kept on this box, in its
// `attachments` folder, so the agent can open each with its tools. The session's model gets as
// files only what it can read, as the Mac's own messages do (Attachments.swift): words always, a
// PDF if it reads PDFs, a picture if it sees pictures. Anything else waits on the box for the
// agent, and the note at the message's end says where each file is.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { K } from "../home";
import { withAttachedNote } from "../peers/naming";

// What the session's model takes as input ("text", "image", "pdf"…), or null when that can't be
// found out (then it gets every file, as before).
export type ModelInput = (session: string) => Promise<string[] | null>;

interface PromptFile { uri?: unknown; name?: unknown }

// `body` with its inline files kept on the box and only what the model reads left as files;
// anything else as it is.
export async function attachedIn(body: Buffer | undefined, session: string, modelInput: ModelInput): Promise<Buffer | undefined> {
  let prompt: { text?: unknown; files?: unknown } | null;
  try { prompt = JSON.parse(Buffer.from(body ?? "").toString()); } catch { return body; }
  if (!prompt || !Array.isArray(prompt.files)) return body;
  const files = prompt.files as PromptFile[];
  if (!files.some(file => inline(file) !== null)) return body;
  const input = await modelInput(session).catch(() => null);
  const sent: PromptFile[] = [], included: string[] = [], paths: string[] = [];
  for (const file of files) {
    const data = inline(file);
    if (!data) {
      sent.push(file);
      continue;
    }
    const saved = save(data.bytes, typeof file.name === "string" ? file.name : "");
    if (reads(data.mime, input)) {
      sent.push(file);
      if (saved) included.push(saved);
    } else if (saved) {
      paths.push(saved);
    } else {
      // It couldn't be kept here: it goes as it came.
      sent.push(file);
    }
  }
  const text = typeof prompt.text === "string" ? prompt.text : "";
  return Buffer.from(JSON.stringify({ ...prompt, text: withAttachedNote(text, included, paths), files: sent.length ? sent : undefined }));
}

// A file sent with its contents (a base64 `data:` URI): its type and bytes.
function inline(file: PromptFile): { mime: string; bytes: Buffer } | null {
  const match = typeof file?.uri === "string" ? /^data:([^;,]*)((?:;[^;,]*)*);base64,/.exec(file.uri) : null;
  if (!match) return null;
  return { mime: (match[1] || "application/octet-stream").toLowerCase(), bytes: Buffer.from((file.uri as string).slice(match[0].length), "base64") };
}

// Whether a model with `input` reads a file of type `mime` as it is.
function reads(mime: string, input: string[] | null): boolean {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/pdf") return input?.includes("pdf") ?? true;
  if (mime.startsWith("image/")) return input?.includes("image") ?? true;
  return false;
}

// How long a file sent with a message is kept on the box, for the agent to open again.
const KEPT_DAYS = 14;

// `bytes` in a folder of its own in the box's attachments (two can have the same name), under
// its own name; its path, or null when it can't be written. Those kept longer than two weeks go.
function save(bytes: Buffer, name: string): string | null {
  const base = path.basename(name.replace(/\\/g, "/")).replace(/^\.+/, "").trim() || "attachment";
  const attachments = path.join(K, "attachments");
  letOldGo(attachments);
  const folder = path.join(attachments, crypto.randomBytes(4).toString("hex"));
  try {
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, base);
    fs.writeFileSync(file, bytes);
    return file;
  } catch {
    return null;
  }
}

// The kept files sent more than `KEPT_DAYS` ago.
function letOldGo(attachments: string): void {
  const before = Date.now() - KEPT_DAYS * 24 * 60 * 60 * 1000;
  let folders: string[];
  try { folders = fs.readdirSync(attachments); } catch { return; }
  for (const name of folders) {
    const folder = path.join(attachments, name);
    try { if (fs.statSync(folder).mtimeMs < before) fs.rmSync(folder, { recursive: true, force: true }); } catch {}
  }
}
