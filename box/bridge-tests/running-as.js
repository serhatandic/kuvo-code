// A process standing in for one of the box's own programs (the coding agents' bridge, the
// browser's keeper), for a test that tells the box it runs. The box checks that a process it's
// told of is still that program: on Linux by its command line (/proc), on a Mac by its being
// alive. A stand-in carries the program's name in its command line, so the same test holds on
// both, and it's ready (its command line its own) before it's handed over. It ends when the test
// file does, also when that's killed: its stdin, the file's pipe, closes then.
import { spawn } from "node:child_process";

export async function runningAs(name, t) {
  const child = spawn(process.execPath, ["-e", "process.stdin.on('end', () => process.exit()).on('error', () => process.exit()).resume(); process.stdout.write('ready')", name], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`the process running as ${name} ended before it was ready (${code})`)));
  });
  return child.pid;
}
