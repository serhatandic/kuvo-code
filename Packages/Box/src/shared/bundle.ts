// Which build of the coding agents' bridge a bundle is (`kuvo-agents.js`): its line saying what it
// was built from (scripts/build-agents.sh), near its end, before what a Mac adds after it (its own
// `// kuvo-agents <hash>`). The bridge reads its own as it starts; the link reads the one in place
// now, for `kuvo/info`'s `pieces` (PROTOCOL.md, "A new version while it works").

import fs from "node:fs";

const BUILT = /\/\/ Built from Packages\/Box\/src\/agents ([0-9a-f]{16,64})\s*(?:\n|$)/g;

/** The build a bundle's text names (its last such line), or null for one that names none (a
 * bridge run from its sources). */
export function buildOf(text: string): string | null {
  let found: string | null = null;
  for (const match of text.matchAll(BUILT)) found = match[1];
  return found;
}

/** The build of the bundle at `file`, read from its end, or null (none there, or none named). */
export function bundleBuild(file: string): string | null {
  let handle: number | undefined;
  try {
    handle = fs.openSync(file, "r");
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, 1024);
    const tail = Buffer.alloc(length);
    fs.readSync(handle, tail, 0, length, size - length);
    return buildOf(tail.toString("utf8"));
  } catch {
    return null;
  } finally {
    if (handle !== undefined) try { fs.closeSync(handle); } catch {}
  }
}
