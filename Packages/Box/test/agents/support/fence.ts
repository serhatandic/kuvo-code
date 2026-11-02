// The box's sandbox, set up for real in a test's own folder, for agents run whole in it.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { agentShellScript, launcherScript, type FencePlaces } from "../../../src/link/fence/files"
import { LANDLOCK_RUNNER, landlockPolicy, ownNamespace } from "../../../src/link/fence/landlock"
import type { FencePolicy } from "../../../src/link/fence/policy"
import { seatbeltProfile } from "../../../src/link/fence/seatbelt"

/**
 * The box's sandbox, on, as the box sets it up (link/fence/state.ts): its launcher and its rules in
 * this system's terms, in Kuvo Code's folder `kuvo`, which it hides; `more`, what else the box's
 * policy has (its tools' caches it writes, your secrets).
 */
export function realFence(kuvo: string, sockets: string[] = [], more: Partial<FencePolicy> = {}) {
  const folder = join(kuvo, "run", "fence")
  const platform = process.platform === "darwin" ? "darwin" : "linux"
  const places: FencePlaces = {
    folder, launcher: join(kuvo, "bin", "kuvo-fence"), runner: join(kuvo, "bin", "kuvo-fence.js"), inside: [join(kuvo, "bots")], shared: [join(kuvo, "chats")], probe: join(folder, "probe"),
    bots: join(kuvo, "bots"), wakes: join(kuvo, "wakes"), key: join(kuvo, "run", "socket.key"), sshFor: join(kuvo, "run", "ssh-for"), sshAgents: join(kuvo, "run", "ssh"), caches: { npm: join(kuvo, "cache", "sandbox-npm"), pnpm: join(kuvo, "cache", "sandbox-pnpm"), uv: join(kuvo, "cache", "sandbox-uv"), corepack: join(kuvo, "cache", "sandbox-corepack") }, platform,
  }
  const policy: FencePolicy = { home: kuvo, kuvo: [kuvo], kuvoPatterns: [], kuvoReadable: [join(kuvo, "bin")], writable: ["/dev"], readOnly: [], secrets: [], ports: [], sockets, commandCaches: ["sandbox-npm", "sandbox-pnpm", "sandbox-uv", "sandbox-corepack"].map(name => join(kuvo, "cache", name)), ...more }
  mkdirSync(join(folder, "shell"), { recursive: true })
  const write = (file: string, text: string, mode = 0o600) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text, { mode })
  }
  write(places.launcher, launcherScript(places), 0o700)
  write(join(folder, "shell", "run"), agentShellScript(places), 0o700)
  write(join(folder, "policy.json"), landlockPolicy(policy))
  if (platform === "darwin") for (const inside of [false, true]) for (const agent of [false, true]) write(join(folder, `${inside ? "inside" : "project"}${agent ? "-agent" : ""}.sb`), seatbeltProfile(policy, { inside, agent }))
  else {
    write(places.runner, LANDLOCK_RUNNER, 0o700)
    write(join(folder, "runtime"), process.execPath)
    // (Each command in a namespace of its own where the machine lets it, as the box sets it up.)
    mkdirSync(join(folder, "ns"), { recursive: true, mode: 0o700 })
    write(join(folder, "namespace"), ownNamespace(join(folder, "ns")) ?? "-")
    write(join(folder, "sockets"), sockets.map(each => each + "\n").join(""))
  }
  write(join(folder, "on"), "set up")
  return folder
}

export const canFence = process.platform === "darwin" ? existsSync("/usr/bin/sandbox-exec") : process.platform === "linux"


/** The short folder in `/tmp` the box set up in `kuvo` named for its commands' temporary folders,
 * where its own was too far down for a socket (link/fence/state.ts): null where it named none. */
export function shortFolder(kuvo: string): string | null {
  try {
    const named = readFileSync(join(kuvo, "run", "fence", "temporary"), "utf8").split("\n")[0]!
    return /^\/tmp\/kuvo-code-\d+-[0-9a-f]{6}$/.test(named) ? named : null
  } catch { return null }
}

/** That folder removed, as a test that set a box up is done with it. */
export function removeShortFolder(kuvo: string) {
  const short = shortFolder(kuvo)
  if (short) rmSync(short, { recursive: true, force: true })
}
