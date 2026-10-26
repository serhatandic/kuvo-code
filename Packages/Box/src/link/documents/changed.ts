// This box's documents changed
// A phone paired or removed, a personality changed, by this process or another: the other boxes
// are told (on a Mac, at once: main.ts says how, `onDocsChanged`).

import fs from "node:fs";
import path from "node:path";
import { IS_MAC, RUN } from "../home";

// Something changed here, from another process (`setup`, `pair`, a Mac's `box personalities`, over
// SSH): the bridge notes it within seconds (`docsNoted`), and tells the others.
const DOCS_CHANGED = path.join(RUN, "docs.changed");
// How this Mac's box tells them: main.ts sets it as it loads, before anything here can be noted.
let changedHere: () => void = () => {};
export const onDocsChanged = (then: () => void) => {
  changedHere = then;
};
export function noteDocsChanged(): void {
  // This Mac's box holds its link in this process: told now.
  if (IS_MAC) return changedHere();
  try {
    fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
    fs.writeFileSync(DOCS_CHANGED, "", { mode: 0o600 });
  } catch {}
}
export function docsNoted(): boolean {
  try {
    fs.rmSync(DOCS_CHANGED);
    return true;
  } catch {
    return false;
  }
}