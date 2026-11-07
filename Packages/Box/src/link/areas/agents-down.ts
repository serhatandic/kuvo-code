// Why this Mac's coding agents' bridge can't be asked now, when that's more than its starting: it
// can't start or keeps stopping, as the app says (`run/agents-stopped`, why and whether it's tried
// again by itself), or the engine whose Bun runs it never came up. Nothing for a machine, whose bridge
// starts with its engine and whose answers say so.
import fs from "node:fs";
import path from "node:path";
import { IS_MAC, RUN } from "../home";
import { engineDown } from "./engine";

export function agentsDown(): string | null {
  if (!IS_MAC) return null;
  try {
    const { why, retrying } = JSON.parse(fs.readFileSync(path.join(RUN, "agents-stopped"), "utf8"));
    if (typeof why === "string" && why) return `This Mac's coding agents aren't running. ${why}${retrying === true ? "" : " Restart them in Kuvo Code on the Mac."}`;
  } catch {}
  return fs.existsSync(path.join(RUN, "engine-stopped")) ? engineDown() : null;
}
