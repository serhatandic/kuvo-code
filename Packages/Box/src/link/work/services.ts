// Which of the commands a session left running are services: a dev server, a preview, anything
// listening on a TCP port. A session's finish doesn't wait on one (it may run for good): its lead is
// told at once, naming it and its ports (work/wakes.ts). Found by the command's process group (the
// engine's own commands: their `pid` leads it), the same way on macOS (`lsof`) and Linux (`/proc`).

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The TCP ports each of `groups` (process group ids) listens on; one listening on none is left out. */
export async function listeningPorts(groups: number[], { proc = "/proc", platform = process.platform }: { proc?: string; platform?: string } = {}): Promise<Map<number, number[]>> {
  const wanted = [...new Set(groups.filter(group => Number.isInteger(group) && group > 1))];
  if (!wanted.length) return new Map();
  return platform === "linux" ? fromProc(wanted, proc) : fromLsof(wanted);
}

const add = (found: Map<number, number[]>, group: number, port: number) => {
  const ports = found.get(group) ?? [];
  if (!ports.includes(port)) found.set(group, [...ports, port].sort((a, b) => a - b));
};

// `lsof -F gn`: a `g<group>` line before each process's files, an `n<address>` line for each.
function fromLsof(groups: number[]): Promise<Map<number, number[]>> {
  return new Promise(resolve => {
    execFile("lsof", ["-nP", "-a", "-g", groups.join(","), "-iTCP", "-sTCP:LISTEN", "-F", "gn"], { timeout: 5000 }, (_error, stdout) => {
      // (It exits 1 when nothing listens: what it printed says.)
      const found = new Map<number, number[]>();
      let group = 0;
      for (const line of String(stdout ?? "").split("\n")) {
        if (line.startsWith("g")) group = Number(line.slice(1));
        const port = line.startsWith("n") ? Number(/:(\d+)$/.exec(line)?.[1]) : NaN;
        if (groups.includes(group) && Number.isInteger(port) && port > 0) add(found, group, port);
      }
      resolve(found);
    });
  });
}

// Linux: the listening sockets (`/proc/net/tcp`, state 0A), by their inodes, and each process in
// one of the groups (`/proc/<pid>/stat`'s fifth field) holding one (`/proc/<pid>/fd`).
async function fromProc(groups: number[], proc: string): Promise<Map<number, number[]>> {
  const listening = new Map<string, number>();
  for (const table of ["tcp", "tcp6"]) {
    let text = "";
    try { text = await fs.promises.readFile(path.join(proc, "net", table), "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== "0A" || !fields[1] || !fields[9]) continue;
      listening.set(fields[9], parseInt(fields[1].split(":").at(-1)!, 16));
    }
  }
  const found = new Map<number, number[]>();
  if (!listening.size) return found;
  let entries: string[] = [];
  try { entries = await fs.promises.readdir(proc); } catch { return found; }
  for (const pid of entries.filter(each => /^\d+$/.test(each))) {
    let stat = "";
    try { stat = await fs.promises.readFile(path.join(proc, pid, "stat"), "utf8"); } catch { continue; }
    // (After the name, which may hold spaces and parentheses: state, parent, group.)
    const group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    if (!groups.includes(group)) continue;
    let fds: string[] = [];
    try { fds = await fs.promises.readdir(path.join(proc, pid, "fd")); } catch { continue; }
    for (const fd of fds) {
      let target = "";
      try { target = await fs.promises.readlink(path.join(proc, pid, "fd", fd)); } catch { continue; }
      const port = listening.get(/^socket:\[(\d+)\]$/.exec(target)?.[1] ?? "");
      if (port) add(found, group, port);
    }
  }
  return found;
}
