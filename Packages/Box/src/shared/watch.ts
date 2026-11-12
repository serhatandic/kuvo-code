// A folder watched for what changes in it, with what the system's watch never tells looked for too.
//
// On macOS, a process's watches of folders (Bun's and Node's alike) share one FSEvents stream, made
// anew on a thread of its own each time a watch starts or stops, which tells only what changes once
// it runs: so a change as a watch starts is never told to it, nor one in that moment, or just
// before it, to any other watch in the process. Each watch made here is told to look again
// (`missed`) a moment after any of them starts or stops, by then on the new stream. (On Linux each
// watch is the system's own and starts as it's made: looking again costs a look, and misses
// nothing.)

import fs from "node:fs";

/** When each watch looks again after one starts or stops (in ms): once the stream is surely made
 * anew, and later still on a busy computer. */
export const WATCH_LOOKS_AGAIN = [250, 1000];

const watching = new Set<() => void>();
// Looks to come, by when (to the tenth of a second: many watches started at once look once).
const looks = new Map<number, ReturnType<typeof setTimeout>>();

function startedOrStopped() {
  for (const after of WATCH_LOOKS_AGAIN) {
    const at = Math.ceil((Date.now() + after) / 100) * 100;
    if (looks.has(at)) continue;
    const timer = setTimeout(() => {
      looks.delete(at);
      for (const look of [...watching]) {
        try { look(); } catch {}
      }
    }, at - Date.now());
    timer.unref?.();
    looks.set(at, timer);
  }
}

/**
 * `folder` watched as `fs.watch` watches it, `changed` told as it does; and `missed` (`changed` with
 * nothing, unless given) a moment after this or any other watch made here starts or stops, for what
 * the system didn't tell. Closing it stops both.
 */
export function watchFolder(
  folder: string,
  changed: (event?: fs.WatchEventType, name?: string | null) => void,
  { recursive = false, missed = () => changed() }: { recursive?: boolean; missed?: () => void } = {},
): fs.FSWatcher {
  const watcher = fs.watch(folder, { recursive }, (event, name) => changed(event, name === null ? null : String(name)));
  const look = () => missed();
  watching.add(look);
  startedOrStopped();
  const close = watcher.close.bind(watcher);
  watcher.close = () => {
    if (watching.delete(look)) startedOrStopped();
    close();
  };
  return watcher;
}
