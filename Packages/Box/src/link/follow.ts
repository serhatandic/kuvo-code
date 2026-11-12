// What a client follows (`kuvo/projects/events`, `kuvo/bots/events` and the rest): a list as JSON,
// a line now and one each time it changes, as this box changes it or the system says its files did.
// Platform: a watch on a folder with what's in it (`recursive`) is the system's own on macOS; on
// Linux it's as the runtime can, and where a watch can't be kept the list is looked at each second
// instead (`whole`), the same on both.

import fs from "node:fs";
import { watchFolder } from "../shared/watch";
import type { AnswerPiece } from "./server/context";

/** A watch on folders: whether the system tells of every change in them, and how to stop it. */
export interface FolderWatch {
  readonly whole: boolean;
  close: () => void;
}

/** `folders` watched, with what's in them (`recursive`) or only their own files, for `changed`:
 * whether the system tells of every change (a watch it can't keep goes, and so does that), and how
 * to stop. `changed` is also told, with nothing, a moment after any watch starts or stops, for what
 * the system missed then (`watchFolder`). */
export function watchFolders(folders: string[], changed: () => void, { recursive = true }: { recursive?: boolean } = {}): FolderWatch {
  let whole = folders.length > 0;
  const watchers: fs.FSWatcher[] = [];
  for (const folder of folders) {
    try {
      fs.mkdirSync(folder, { recursive: true });
      const watcher = watchFolder(folder, changed, { recursive });
      watcher.on("error", () => {
        whole = false;
        watcher.close();
      });
      watchers.push(watcher);
    } catch {
      whole = false;
    }
  }
  return { get whole() { return whole; }, close: () => { for (const watcher of watchers) watcher.close(); } };
}

/** What `read` says, a line now and one for each change after, in order: each change this process
 * makes as it's made (`followers` are told), and what another made, looked for each second; or,
 * given `folders` to watch, as the system says they change, looked for again every half minute
 * only for a change it missed. A watch starts a moment after it's asked for (a change in that
 * moment isn't told), so it's looked at once more just after. `watch`: the system's (a test's own). */
export async function* followed(
  read: () => unknown,
  followers: Set<() => void>,
  signal: AbortSignal | undefined,
  { folders = [], recursive = true, watch = watchFolders }: { folders?: string[]; recursive?: boolean; watch?: typeof watchFolders } = {},
): AsyncGenerator<AnswerPiece> {
  let wake: (() => void) | null = null;
  const queue: string[] = [];
  const told = () => {
    queue.push(JSON.stringify(read()));
    wake?.();
  };
  followers.add(told);
  const watching = watch(folders, told, { recursive });
  queue.push(JSON.stringify(read()));
  // (Later still under load: looked at again a little later, then a little later again; what
  // didn't change isn't sent twice.)
  const settled = WATCH_SETTLES.map(ms => setTimeout(told, ms));
  // Its client gone: it stops now, not at the next look.
  signal?.addEventListener("abort", () => wake?.(), { once: true });
  try {
    let last = "";
    while (!signal?.aborted) {
      while (queue.length) {
        const line = queue.shift()!;
        if (line !== last) {
          yield { body: Buffer.from(line + "\n") };
          last = line;
        }
      }
      if (signal?.aborted) break;
      await new Promise<void>(done => {
        // Its look-again timer goes once it's woken, so a client gone leaves nothing waiting.
        const timer = setTimeout(done, watching.whole ? 30_000 : 1000);
        wake = () => { clearTimeout(timer); done(); };
      });
      wake = null;
      queue.push(JSON.stringify(read()));
    }
  } finally {
    for (const timer of settled) clearTimeout(timer);
    followers.delete(told);
    watching.close();
  }
}

// When a watch on folders may have started telling changes: looked at again then.
const WATCH_SETTLES = [250, 1000, 5000];
