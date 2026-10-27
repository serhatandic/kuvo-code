// Pictures an agent's step brought back or made (a screenshot, an image it generated, one it
// looked at), as a step's results carry them: the app shows them with the step.

import { extname } from "node:path"
import { pathToFileURL } from "node:url"
import type { ToolOutput } from "./wire"

const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic" }

/** A picture file on this Mac, or none for a path that isn't one. */
export function pictureFile(path: unknown): Extract<ToolOutput, { type: "file" }> | undefined {
  if (typeof path !== "string" || !path) return undefined
  const mime = types[extname(path).toLowerCase()]
  if (!mime) return undefined
  return { type: "file", uri: pathToFileURL(path).href, mime, name: path.split("/").pop() }
}

/** A picture carried as data (an MCP tool's image content). */
export function pictureData(data: unknown, mime: unknown): Extract<ToolOutput, { type: "file" }> | undefined {
  if (typeof data !== "string" || !data || typeof mime !== "string" || !mime.startsWith("image/")) return undefined
  return { type: "file", uri: `data:${mime};base64,${data}`, mime }
}

/** A step's words, with its pictures after them. */
export function withPictures(text: string, pictures: (ToolOutput | undefined)[]): string | ToolOutput[] {
  const files = pictures.filter((picture): picture is ToolOutput => Boolean(picture))
  return files.length ? [{ type: "text", text }, ...files] : text
}
