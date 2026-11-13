// The engine's read tool, given a file that isn't there, reads one beside it whose name looks the
// same in its place (engine 2.2.5: the one plain file whose name is the same composed, with no-break
// spaces as spaces and curly quotes as straight ones), without asking about it again: what's asked
// about, and judged, is the name it was given. Both the box (Auto's reviewer) and the engine's
// sandbox plugin (`pluginScript`, which takes this function's own text) go by this one rule, wider
// than the engine's on purpose, so an engine that widens its own is still covered.
import fs from "node:fs";
import path from "node:path";

/** A file name as a read tool might take another for it: compatibility-composed (NFKC), any space
 * as a space, any apostrophe-like mark as `'`, in lower case. Self-contained: the plugin takes its
 * text. */
export function alikeName(name: string): string {
  return name.normalize("NFKC").replace(/\p{Zs}/gu, " ").replace(/[\u2018\u2019\u201b\u2032\u02bc`\u00b4]/g, "'").toLowerCase();
}

/** The entries beside `file`, where it isn't there, whose names look the same as its (`alikeName`),
 * each as it's named there (links and all): what a read of `file` might open in its place. None
 * where it's there, or its folder can't be listed. */
export function lookalikesOf(file: string): string[] {
  // (As the engine finds it isn't there: a link that leads nowhere isn't.)
  try { fs.statSync(file); return []; } catch {}
  const name = alikeName(path.basename(file));
  try {
    return fs.readdirSync(path.dirname(file)).filter(each => each !== path.basename(file) && alikeName(each) === name).map(each => path.join(path.dirname(file), each));
  } catch { return []; }
}
