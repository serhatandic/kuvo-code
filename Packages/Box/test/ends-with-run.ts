// What a test starts in a process group of its own (spawned `detached`) ends with the test run, even
// one cut off: killed, or its time up before its afterEach. A group of its own doesn't end with the
// run's, and the stand-in servers hang.test.ts starts can't notice by themselves (they're hung, or
// spinning, on purpose): one went on at full CPU for a day. So each gets a watchdog of its own, in a
// group of its own too (so the run's end doesn't take it first), that ends the child's group once
// the run's process is gone, looking once a second.
import { type ChildProcess, spawn } from "node:child_process"

/** Watches over `child` (the leader of its own process group); returns what ends the watchdog, for
 * when the test ends the child itself. */
export function endsWithRun(child: ChildProcess): () => void {
  const watchdog = spawn("/bin/sh", ["-c", 'while kill -0 "$0" 2>/dev/null; do sleep 1; done; kill -s KILL -- "-$1" 2>/dev/null', String(process.pid), String(child.pid)], { stdio: "ignore", detached: true })
  watchdog.unref()
  return () => {
    try { process.kill(-watchdog.pid!, "SIGKILL") } catch {}
  }
}
