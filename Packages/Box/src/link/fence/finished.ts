// Whether one of the sandbox's checks finished: one that didn't (a busy computer) says nothing of
// whether the sandbox works here, so it's never taken for one that failed (fence/state.ts).

/** What ends a check before it's done: its time limit, or no room on the computer to start it
 * (processes, memory, files). */
const LOAD = new Set(["ETIMEDOUT", "EAGAIN", "ENOMEM", "EMFILE", "ENFILE"]);

/** Whether a check's process didn't finish: it never ended with a status of its own (what it
 * found, which counts whatever the time), but was cut off at its limit, couldn't start for lack of
 * room, or was killed by the system (out of memory). */
export function didntFinish(run: { status: number | null; signal?: NodeJS.Signals | null; error?: Error }): boolean {
  if (run.status !== null) return false;
  const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
  if (code) return LOAD.has(code);
  return run.signal === "SIGKILL";
}
