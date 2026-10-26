// Waiting a while.

/** A pause of `ms`. */
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Waits `ms`, or until `signal` stops it.
export const pause = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});
