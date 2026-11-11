import "./safety"
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { listeningPorts } from "../src/link/work/services"

// Which commands are services (a dev server): on Linux, read from /proc as the kernel lays it out.
// A /proc of the test's own: two processes in a command's group (one listening on :5173 over IPv4,
// one on :4173 over IPv6), one in another group listening too, and a socket that only connects.
test("on Linux, a process group's listening ports are read from /proc", async () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-proc-"))
  try {
    const head = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
    fs.mkdirSync(path.join(proc, "net"))
    fs.writeFileSync(path.join(proc, "net", "tcp"), head
      + "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 1001 1 0 100 0 0 10 0\n"
      + "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 1003 1 0 100 0 0 10 0\n"
      + "   2: 0100007F:C350 0100007F:1435 01 00000000:00000000 00:00000000 00000000   501        0 1004 1 0 100 0 0 10 0\n")
    fs.writeFileSync(path.join(proc, "net", "tcp6"), head
      + "   0: 00000000000000000000000000000000:104D 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 1002 1 0 100 0 0 10 0\n")
    const process_ = (pid: number, group: number, sockets: number[]) => {
      fs.mkdirSync(path.join(proc, String(pid), "fd"), { recursive: true })
      fs.writeFileSync(path.join(proc, String(pid), "stat"), `${pid} (node (dev) server) S 1 ${group} ${group} 0 -1 4194560`)
      sockets.forEach((inode, fd) => fs.symlinkSync(`socket:[${inode}]`, path.join(proc, String(pid), "fd", String(fd + 3))))
      fs.symlinkSync("/dev/null", path.join(proc, String(pid), "fd", "0"))
    }
    process_(4100, 4100, [1004])
    process_(4101, 4100, [1001])
    process_(4102, 4100, [1002])
    process_(4200, 4200, [1003])
    process_(4300, 4300, [1004])
    const found = await listeningPorts([4100, 4300], { proc, platform: "linux" })
    expect([...found]).toEqual([[4100, [4173, 5173]]])
  } finally {
    fs.rmSync(proc, { recursive: true, force: true })
  }
})

test("no groups, no look", async () => {
  expect((await listeningPorts([0, 1], { platform: "linux", proc: "/nonexistent" })).size).toBe(0)
})
