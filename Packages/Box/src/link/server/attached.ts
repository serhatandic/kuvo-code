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
// anything else as it is. A note the message ends with already joins this one only when it's the
// Mac's own (`joinsNote`), never words a phone's message ends with.
export async function attachedIn(body: Buffer | undefined, session: string, modelInput: ModelInput, joinsNote = false): Promise<Buffer | undefined> {
  let prompt: { text?: unknown; files?: unknown } | null;
  try { prompt = JSON.parse(Buffer.from(body ?? "").toString()); } catch { return body; }
  if (!prompt || !Array.isArray(prompt.files)) return body;
  const files = prompt.files as PromptFile[];
  if (!files.some(file => inline(file) !== null)) return body;
  const input = await modelInput(session).catch(() => null);
  const attachments = path.join(K, "attachments");
  letOldGo(attachments);
  const sent: PromptFile[] = [], included: string[] = [], paths: string[] = [];
  for (const file of files) {
    const data = inline(file);
    if (!data) {
      sent.push(file);
      continue;
    }
    const saved = save(attachments, data.bytes, typeof file.name === "string" ? file.name : "");
    if (reads(data.mime, data.bytes.length, input)) {
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
  return Buffer.from(JSON.stringify({ ...prompt, text: withAttachedNote(text, included, paths, joinsNote), files: sent.length ? sent : undefined }));
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

// Whether a model with `input` reads a file of type `mime`, `size` bytes, as it is.
function reads(mime: string, size: number, input: string[] | null): boolean {
  if (size > MODEL_BYTES) return false;
  if (mime.startsWith("text/") || TEXT_TYPES.has(mime)) return true;
  if (mime === "application/pdf") return input?.includes("pdf") ?? true;
  if (mime.startsWith("image/")) return input?.includes("image") ?? true;
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
