// Waiting a while.

/** A pause of `ms`. */
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Waits `ms`, or until `signal` stops it. Leaves nothing listening on `signal` once done, so a
// long wait made of many pauses (an answer looked for every two seconds) doesn't pile them up.
export const pause = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  if (signal?.aborted) return resolve();
  const stopped = () => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", stopped);
    resolve();
  }, ms);
  signal?.addEventListener("abort", stopped, { once: true });
});

/** Runs `run` in `ms`, without keeping the process up for it. */
export const soon = (run: () => void, ms: number) => setTimeout(run, ms).unref?.();
