// What kind of thing a file is, as a bot's Shelf sorts them: by where it is first (a bot's memory,
// a skill), then by its type.

import { basename, extname, sep } from "node:path"

export type Kind = "memory" | "skill" | "image" | "page" | "document" | "download" | "code" | "file"

const images = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "bmp", "tiff"])
const documents = new Set(["md", "markdown", "txt", "pdf", "docx", "doc", "rtf", "pages", "csv", "tsv", "xlsx", "xls", "numbers", "pptx", "key", "odt", "ods"])
const pages = new Set(["html", "htm"])
/** What's never text, by its name. */
const binaries = new Set(["zip", "gz", "tgz", "tar", "dmg", "pkg", "mp4", "mov", "mp3", "wav", "m4a", "woff", "woff2", "ttf", "otf", "sqlite", "db", "bin", "exe", "dylib", "so", "o", "a", "class", "jar", "wasm"])

const types: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  svg: "image/svg+xml", bmp: "image/bmp", tiff: "image/tiff", pdf: "application/pdf", mp4: "video/mp4", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv",
  tsv: "text/tab-separated-values", json: "application/json", html: "text/html", htm: "text/html", css: "text/css",
  js: "text/javascript", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip: "application/zip",
  doc: "application/msword", xls: "application/vnd.ms-excel", rtf: "application/rtf", pages: "application/vnd.apple.pages",
  numbers: "application/vnd.apple.numbers", odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
}

const extension = (path: string) => extname(path).slice(1).toLowerCase()

/**
 * Its media type, by its name, and where the name doesn't tell, by its bytes (`binary`: they aren't
 * text). (A `.key` is more often a secret than a Keynote file: told by neither.)
 */
export function typeOf(path: string, binary = false): string {
  const ext = extension(path)
  if (types[ext]) return types[ext]
  return binaries.has(ext) || binary ? "application/octet-stream" : "text/plain"
}

/** Whether bytes aren't text, by their start. */
export function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0)
}

/** Whether its changes read as words (prose) rather than lines (code). */
export function isProse(path: string): boolean {
  const ext = extension(path)
  return ext === "md" || ext === "markdown" || ext === "txt" || basename(path) === "job.json"
}

/** Whether a media type is text. */
export function isText(type: string): boolean {
  return type.startsWith("text/") || type === "application/rtf" || type === "application/json" || type === "image/svg+xml"
}

/**
 * Its kind. `bots`: the box's bots' folder, where a bot's memory, job and chat recaps are.
 * `download`: it came from the agent's browser.
 */
export function kindOf(path: string, { bots, download = false }: { bots?: string; download?: boolean } = {}): Kind {
  if (download) return "download"
  const parts = path.split(sep)
  const at = parts.lastIndexOf("skills")
  // A skill's own folder (…/.opencode/skills/<name>/…, a Claude Code or the engine's skills folder),
  // not any folder that happens to be called so.
  if (at > 0 && at < parts.length - 2 && [".opencode", ".claude", "opencode"].includes(parts[at - 1])) return "skill"
  if (bots && path.startsWith(bots + sep)) {
    const inside = path.slice(bots.length + 1).split(sep)
    // bots/<id>/MEMORY.md, bots/<id>/job.json, bots/<id>/groups/<chat>.md
    if (inside.length === 2 && (inside[1] === "MEMORY.md" || inside[1] === "job.json")) return "memory"
    if (inside.length === 3 && inside[1] === "groups" && inside[2].endsWith(".md")) return "memory"
  }
  const ext = extension(path)
  if (images.has(ext)) return "image"
  if (pages.has(ext)) return "page"
  if (documents.has(ext)) return "document"
  // Anything else is code, until its bytes say it isn't text (the store looks).
  return binaries.has(ext) ? "file" : "code"
}
