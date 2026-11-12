// The box's record of what its agents made (PROTOCOL.md, "Artifacts"): every file a conversation
// wrote or changed, with a version for each turn that changed it, who made it and where.
//
// Kept in one folder of the box's own:
//   log/<yyyy-mm>.jsonl   one line per change to an artifact or one of its versions, read back at start
//   copies/<ab>/<hash>    each version's bytes, by their SHA-256, kept once however many versions share them
//
// Nothing goes silently: the newest version of each file, and every version of memory, skills and
// what's pinned, stay. Older versions of the rest stay until the copies pass the box's budget, and
// then the oldest go first, each still listed as no longer kept. What it copies at all is
// `CopyPolicy`'s: never a likely secret, only the change for code git keeps, and nothing but what's
// always kept once the disk's free space is down to its floor.

import { createHash, createHmac, randomBytes } from "node:crypto"
import { appendFileSync, closeSync, existsSync, fchmodSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join, sep } from "node:path"
import { fromPatch, unified } from "../diff"
import { isBinary, isText, kindOf, typeOf, type Kind } from "./kinds"
import { CopyPolicy, freeSpace, privateReasons, type NoCopy } from "./policy"
import { inScratch } from "./turnfiles"
import { writeSecret } from "../../shared/files"

/** The biggest file a copy is kept of (as `kuvo/file` sends at most). */
export const copyLimit = 25 * 1024 * 1024
/** What the copies of older versions may take on a box before the oldest go, unless you say otherwise. */
export const defaultBudget = 1024 * 1024 * 1024
/** The biggest text whose lines added and removed are counted. */
const lineLimit = 1024 * 1024
/** The longest change kept of a code file git tracks (its tool call's patch). */
const patchLimit = 100_000
/** Changes made outside any turn this close together are one version (an editor saving as you type). */
const outsideWindow = 5 * 60_000

export type Trigger = "you" | "wake" | "group" | "agent"

/** Who made a version: an agent in a turn, you (from a client), or something outside any turn. */
export interface Who {
  kind: "agent" | "you" | "outside"
  session?: string
  bot?: string
  /** The coding agent it ran with ("claude", "codex"…), or "engine". */
  agent?: string
}

export interface Version {
  n: number
  at: string
  by: Who
  /** The turn that made it: its session, and the message of yours (or the wake-up) that started it. */
  turn?: { session: string; message?: string }
  group?: { id: string; message?: string }
  trigger?: Trigger
  /** How: edit, write, apply_patch, shell, show_file, generate_image, download, mark_final, restore… */
  via: string[]
  status: "added" | "modified" | "deleted"
  /** How many changes this turn made to it. */
  edits: number
  /** Against the version before, for text. */
  lines?: { added: number; removed: number }
  size: number
  /** `sha256:<hex>` of its bytes; `stat:<size>:<mtime>` for one too big to read; null once deleted. */
  hash: string | null
  /** A copy of it is kept (`versions/<n>` answers it). */
  kept: boolean
  /** Why it has no copy: a likely secret, ignored by git, code git keeps, too big, the disk low, or cleared. */
  reason?: NoCopy
  /** The change its tool call made, for code git keeps (which has no copy). */
  patch?: string
  /** It put back version `restored`. */
  restored?: number
  /** The file as it was before the record first saw it change, worked out from that change. */
  before?: true
  /** A bot in the same group chat made the version before: a hand-off. */
  handoff?: { from: string }
}

export interface Where {
  /** Each bot that made a version of it (two, when one handed it to another in a group chat). */
  bots: string[]
  project?: string
  sessions: string[]
  groups: string[]
}

export interface Artifact {
  id: string
  path: string
  name: string
  kind: Kind
  type: string
  where: Where
  pinned: { by: "bot" | "you"; at: string; note?: string } | null
  /** Deleted on disk then; its versions stay. */
  gone: string | null
  /** Last shown in a panel (show_file, show_in_panel). */
  shown?: string
  /** A document that wake-ups keep rewriting: a page kept up to date, as a Shelf shows it. */
  living?: true
  /** In a git repository (whose history git keeps). */
  git?: true
  updated: string
  versions: Version[]
}

/** An artifact as a list shows it: with only its newest version. */
export type Summary = Omit<Artifact, "versions"> & { versions: number; latest: Version }

/** What made a change, as a source of it tells the record. */
export interface Made {
  by: Who
  turn?: { session: string; message?: string }
  group?: { id: string; message?: string }
  trigger?: Trigger
  via: string
  where?: { bot?: string; project?: string; session?: string; group?: string }
  /** It came from the agent's browser. */
  download?: boolean
  /** The change the tool call reported (a unified diff), kept for code git keeps. */
  patch?: string
  /** A version of its own, never folded into another made close by (a restore). */
  separate?: boolean
  /** A copy kept whatever the policy says but privacy (what a restore replaces, so it can be undone). */
  keep?: boolean
  at?: Date
}

export interface Scope {
  session?: string
  bot?: string
  group?: string
  project?: string
  kind?: Kind
  pinned?: boolean
  /** In a Timeline: only what this bot made. */
  by?: string
}

type Header = Omit<Artifact, "versions">
type Line = { a: Header; v?: Version }

const stamp = (date: Date) => date.toISOString()
const kindsKeptWhole = new Set<Kind>(["memory", "skill"])

export class ArtifactStore {
  private artifacts = new Map<string, Artifact>()
  /** How many kept versions use each copy, and its size. */
  private copies = new Map<string, { uses: number; size: number }>()
  /** What the copies take, all told. */
  private copyBytes = 0
  private listeners = new Set<(artifact: Artifact) => void>()

  private readonly policy: CopyPolicy
  /** What private files' hashes are keyed with (`key`, only you can read it): a change shows, the bytes never do. */
  private readonly key: Buffer
  /** Your budget for older versions (Settings › Storage), in `settings.json`. */
  private chosenBudget?: number

  constructor(
    private readonly root: string,
    private readonly options: {
      bots?: string
      budget?: number
      now?: () => Date
      disk?: () => { free: number; total: number }
      /** Files shown before the record heard it (a kept reply's, read again), and when: marked as it loads. */
      shown?: { path: string; at: number }[]
    } = {},
  ) {
    mkdirSync(join(root, "log"), { recursive: true })
    mkdirSync(join(root, "copies"), { recursive: true })
    this.policy = new CopyPolicy(options.disk ?? (() => freeSpace(root)))
    this.key = ArtifactStore.keyIn(root)
    try {
      const budget = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"))?.budget
      if (typeof budget === "number" && budget >= 0) this.chosenBudget = budget
    } catch {}
    this.load()
  }

  private now() {
    return this.options.now?.() ?? new Date()
  }

  /** Told of each artifact as it changes. */
  onChange(listener: (artifact: Artifact) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private static keyIn(root: string): Buffer {
    const file = join(root, "key")
    try {
      const key = readFileSync(file)
      if (key.length === 32) return key
    } catch {}
    const key = randomBytes(32)
    writeSecret(file, key)
    return key
  }

  static idOf(path: string) {
    return "art_" + createHash("sha256").update(path).digest("hex").slice(0, 24)
  }

  get(id: string): Artifact | undefined {
    return this.artifacts.get(id)
  }

  /**
   * Whether its file is still there, as it's opened, after what's being recorded: one taken away
   * with no change seen (a machine's browser clearing week-old downloads) is marked gone, its
   * versions and its newest copy kept as they were, so a client opens the record's copy of it; one
   * back again since isn't gone any more.
   */
  checkGone(id: string): Promise<Artifact | undefined> {
    return this.inTurn([], () => {
      const artifact = this.artifacts.get(id)
      if (!artifact || artifact.versions.at(-1)?.status === "deleted") return artifact
      let there = true
      try {
        statSync(artifact.path)
      } catch (error: any) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") there = false
      }
      if (there === !artifact.gone) return artifact
      artifact.gone = there ? null : stamp(this.now())
      this.write(artifact)
      return this.told(artifact)
    })
  }

  at(path: string): Artifact | undefined {
    return this.artifacts.get(ArtifactStore.idOf(path))
  }

  /** Whether `path` is as the record last saw it: its newest version, or gone (or never there) as it
   * says; or about to be, a change of it waiting its turn. */
  asSeen(path: string): boolean {
    if (this.waiting.has(path)) return true
    const artifact = this.at(path)
    const read = this.read(path)
    if (read === null) return true
    if (!read) return !artifact || artifact.gone !== null
    return !!artifact && !artifact.gone && artifact.versions.at(-1)?.hash === read.hash
  }

  /** What's being recorded: one at a time, in the order asked, each once git has said what it ignores. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Paths with something waiting its turn there, and how much. */
  private waiting = new Map<string, number>()

  private inTurn<T>(paths: string[], work: () => T): Promise<T | undefined> {
    for (const path of paths) this.waiting.set(path, (this.waiting.get(path) ?? 0) + 1)
    const next = this.queue.then(async () => {
      await this.policy.learn(paths)
      return work()
    }).catch((error) => {
      console.error("artifacts:", error?.message ?? error)
      return undefined
    }).finally(() => {
      for (const path of paths) {
        const left = (this.waiting.get(path) ?? 1) - 1
        if (left > 0) this.waiting.set(path, left)
        else this.waiting.delete(path)
      }
    })
    this.queue = next
    return next
  }

  /** Once all that's been asked so far is recorded. */
  async settled(): Promise<void> {
    await this.queue
  }

  /** The file at `path` as it is now, recorded as `made` it (`changeNow`). */
  change(path: string, made: Made): Promise<Artifact | undefined> {
    // As it is now, not once git has answered (another change may come meanwhile).
    const seen = this.look(path)
    return this.inTurn([path], () => this.changeNow(path, made, seen))
  }

  /** Each of `paths` as it is now, recorded as `made` it, git asked about them all at once. */
  changeAll(paths: string[], made: Made): Promise<unknown> {
    // (Read once git has answered, a file at a time: a turn's end, with nothing more to come of it.)
    return this.inTurn(paths, () => {
      paths.forEach((path) => {
        try {
          this.changeNow(path, made)
        } catch (error: any) {
          console.error("artifacts:", error?.message ?? error)
        }
      })
    })
  }

  /** What a file was before the record first saw it change (`beforeNow`). */
  before(path: string, bytes: Buffer, where: { bot?: string } = {}, at = this.now()): Promise<void> {
    return this.inTurn([path], () => this.beforeNow(path, bytes, where, at))
  }

  /** Pinned (marked final) or not (`pinNow`). */
  pin(id: string, pinned: { by: "bot" | "you"; note?: string } | null): Promise<Artifact | undefined> {
    const path = this.artifacts.get(id)?.path
    return this.inTurn(path ? [path] : [], () => this.pinNow(id, pinned))
  }

  /** Version `n` put back on disk (`restoreNow`): the artifact, or why not. */
  async restore(id: string, n: number, at = this.now()): Promise<Artifact | string> {
    const path = this.artifacts.get(id)?.path
    return (await this.inTurn(path ? [path] : [], () => this.restoreNow(id, n, at))) ?? "It couldn't be put back."
  }

  /** Shown in a panel just now (`shownNow`). */
  shown(path: string, made: Made): Promise<Artifact | undefined> {
    return this.inTurn([path], () => this.shownNow(path, made))
  }

  /**
   * The file at `path` as it is now, recorded as `made` it: a new version, or this turn's version
   * brought up to date, or (unchanged since its newest version) only who touched it noted. Returns
   * the artifact when anything changed.
   */
  private changeNow(path: string, made: Made, seen = this.look(path)): Artifact | undefined {
    const now = made.at ?? this.now()
    const read = this.read(path, seen)
    let artifact = this.at(path)
    // There, but it couldn't be read now (no permission, too many files open): nothing to say.
    if (read === null) return undefined
    if (!read) {
      // Gone: its last version says so, once.
      if (!artifact || artifact.gone) return undefined
      artifact.gone = stamp(now)
      this.note(artifact, made)
      return this.add(artifact, { status: "deleted", hash: null, size: 0, kept: false }, made, now)
    }
    if (!artifact) {
      const kind = this.refine(kindOf(path, { bots: this.options.bots, download: made.download }), read.bytes)
      artifact = { id: ArtifactStore.idOf(path), path, name: basename(path), kind, type: typeOf(path, !!read.bytes && isBinary(read.bytes)), where: { bots: [], sessions: [], groups: [] }, pinned: null, gone: null, updated: stamp(now), versions: [], ...(this.policy.inGit(path) ? { git: true as const } : {}) }
      this.artifacts.set(artifact.id, artifact)
    }
    const latest = artifact.versions.at(-1)
    // (Gone but not deleted: taken away unseen, and back as it was.)
    if (latest && latest.hash === read.hash && (!artifact.gone || latest.status !== "deleted")) {
      const back = artifact.gone !== null
      artifact.gone = null
      // Unchanged: only who touched it, and how; and a copy kept now, if one's needed and allowed.
      if (made.keep && !latest.kept && read.bytes && !(latest.reason && privateReasons.has(latest.reason))) {
        this.keep(read.hash, read.bytes)
        this.use(read.hash, read.size, 1)
        latest.kept = true
        delete latest.reason
        this.write(artifact, latest)
      }
      const noted = this.note(artifact, made)
      const sameTurn = this.sameTurn(latest, made, now)
      // (A watch seeing a tool's own write adds nothing.)
      if (sameTurn && !latest.via.includes(made.via) && made.via !== "shell" && made.via !== "outside") {
        latest.via = [...latest.via, made.via]
        this.write(artifact, latest)
        return this.told(artifact)
      }
      if (noted || back) {
        this.write(artifact)
        return this.told(artifact)
      }
      return undefined
    }
    artifact.gone = null
    this.note(artifact, made)
    const reason = read.private ?? (made.keep ? (read.bytes ? undefined : "too-big") : this.noCopy(artifact, read.size, Boolean(read.bytes)))
    if (!reason) this.keep(read.hash, read.bytes!)
    const patch = reason === "git" && made.patch ? made.patch.slice(0, patchLimit) : undefined
    return this.add(artifact, { status: latest && latest.status !== "deleted" ? "modified" : "added", hash: read.hash, size: read.size, kept: !reason, ...(reason ? { reason } : {}), ...(patch ? { patch } : {}) }, made, now, reason ? undefined : read.bytes)
  }

  /** Why a new version of `artifact` gets no copy, if it gets none (`readable`: its bytes were read). */
  private noCopy(artifact: Artifact, size: number, readable: boolean): NoCopy | undefined {
    if (!readable) return "too-big"
    const always = artifact.pinned || kindsKeptWhole.has(artifact.kind)
    if (!always && artifact.kind === "code" && this.policy.inGit(artifact.path)) return "git"
    return undefined
  }

  /**
   * What a file was before the record first saw it change, worked out from that change: kept as
   * its version 0, so its first change has a before. Only for a file the record doesn't know yet.
   */
  private beforeNow(path: string, bytes: Buffer, where: { bot?: string } = {}, at = this.now()) {
    if (this.at(path) || bytes.length > copyLimit || this.policy.privacy(path)) return
    const kind = this.refine(kindOf(path, { bots: this.options.bots }), bytes)
    // Code git keeps, and anything but what's always kept while the disk is low: no before.
    if (!kindsKeptWhole.has(kind) && ((kind === "code" && this.policy.inGit(path)) || this.policy.lowOn(bytes.length))) return
    const hash = "sha256:" + createHash("sha256").update(bytes).digest("hex")
    const artifact: Artifact = {
      id: ArtifactStore.idOf(path), path, name: basename(path),
      kind, type: typeOf(path, isBinary(bytes)),
      where: { bots: where.bot ? [where.bot] : [], sessions: [], groups: [] }, pinned: null, gone: null, updated: stamp(at), versions: [],
    }
    const version: Version = { n: 0, at: stamp(at), by: { kind: "outside" }, via: [], status: "added", edits: 0, size: bytes.length, hash, kept: true, before: true }
    this.keep(hash, bytes)
    artifact.versions.push(version)
    this.artifacts.set(artifact.id, artifact)
    this.use(hash, bytes.length, 1)
    this.write(artifact, version)
  }

  /** Pinned (marked final) or not. */
  private pinNow(id: string, pinned: { by: "bot" | "you"; note?: string } | null): Artifact | undefined {
    const artifact = this.artifacts.get(id)
    if (!artifact) return undefined
    artifact.pinned = pinned ? { by: pinned.by, at: stamp(this.now()), ...(pinned.note ? { note: pinned.note } : {}) } : null
    this.write(artifact)
    // Pinned code git keeps: a copy of it now, as it is (when that's its newest version).
    const latest = artifact.versions.at(-1)
    if (pinned && latest && !latest.kept && latest.reason === "git") {
      const read = this.read(artifact.path)
      if (read?.bytes && read.hash === latest.hash) {
        this.keep(read.hash, read.bytes)
        this.use(read.hash, read.size, 1)
        latest.kept = true
        delete latest.reason
        this.write(artifact, latest)
      }
    }
    return this.told(artifact)
  }

  /**
   * Version `n` put back on disk, as a version by you; what it replaced is kept as a version first
   * (with a copy), so a restore can be undone the same way. Refused for a version with no copy.
   */
  /** Whether a version of it can be put back: it's in a bot's folder or the project it was made in. */
  canRestore(artifact: Omit<Artifact, "versions">): boolean {
    const inBots = Boolean(this.options.bots && artifact.path.startsWith(this.options.bots + sep))
    const inProject = Boolean(artifact.where.project && artifact.path.startsWith(artifact.where.project + sep))
    return inBots || inProject
  }

  private restoreNow(id: string, n: number, at: Date): Artifact | string {
    const artifact = this.artifacts.get(id)
    const version = artifact?.versions.find((each) => each.n === n)
    if (!artifact || !version) return "There's no such version."
    // Only in a bot's folder or the project it was made in: never anywhere else on the computer.
    if (!this.canRestore(artifact)) return "It's outside its bot's folder and its project, so it isn't put back from here."
    const bytes = this.bytes(id, n)
    if (!bytes) return version.status === "deleted" ? "That version is a deletion: there's nothing to put back." : "That version's copy isn't kept, so it can't be put back."
    // What's there now, kept first.
    this.changeNow(artifact.path, { by: { kind: "you" }, via: "replaced", separate: true, keep: true, at })
    const latest = artifact.versions.at(-1)
    if (latest && latest.status !== "deleted" && !latest.kept) return "What's there now can't be kept, so putting this back couldn't be undone."
    try {
      mkdirSync(join(artifact.path, ".."), { recursive: true })
      let mode: number | undefined
      try {
        mode = statSync(artifact.path).mode & 0o7777
      } catch {}
      // A file of its own, made new (never one there already, nor through a link someone left
      // by that name: written through, then put in place, it would give the file another name),
      // its mode set on what it opened, never on whatever has that name by then.
      rmSync(artifact.path + ".kuvo-restore", { force: true })
      const made = openSync(artifact.path + ".kuvo-restore", "wx", 0o600)
      try {
        writeFileSync(made, bytes)
        if (mode !== undefined) fchmodSync(made, mode)
      } finally {
        closeSync(made)
      }
      renameSync(artifact.path + ".kuvo-restore", artifact.path)
    } catch (error: any) {
      rmSync(artifact.path + ".kuvo-restore", { force: true })
      return `It couldn't be written: ${error?.message ?? error}`
    }
    this.changeNow(artifact.path, { by: { kind: "you" }, via: "restore", separate: true, keep: true, at })
    const restored = artifact.versions.at(-1)
    if (restored && restored.n !== latest?.n) {
      restored.restored = n
      this.write(artifact, restored)
    }
    return artifact
  }

  /** Shown in a panel just now. */
  private shownNow(path: string, made: Made): Artifact | undefined {
    const artifact = this.changeNow(path, made) ?? this.at(path)
    if (!artifact) return undefined
    artifact.shown = stamp(made.at ?? this.now())
    this.write(artifact)
    return this.told(artifact)
  }

  /** A version's bytes: undefined for none such, null for one no longer kept. */
  bytes(id: string, n: number): Buffer | null | undefined {
    const version = this.artifacts.get(id)?.versions.find((each) => each.n === n)
    if (!version) return undefined
    if (!version.kept || (version.reason && privateReasons.has(version.reason)) || !version.hash?.startsWith("sha256:")) return null
    try {
      return readFileSync(this.copyPath(version.hash))
    } catch {
      return null
    }
  }

  /**
   * The artifacts in `scope`: pinned first, then the latest changed (ties by id). `before`: the
   * `next` of the page before, an opaque cursor; `next` is null once there are no more.
   */
  list(scope: Scope, { limit = 200, before }: { limit?: number; before?: string } = {}): { artifacts: Summary[]; next: string | null } {
    const matching = [...this.artifacts.values()].filter((artifact) => this.matches(artifact, scope) && artifact.versions.some((version) => !version.before))
    const key = (artifact: Artifact) => [artifact.updated, artifact.id]
    const pinned = before ? [] : matching.filter((artifact) => artifact.pinned).sort((a, b) => later(key(a), key(b)))
    const after = before?.split("|")
    const rest = matching.filter((artifact) => !artifact.pinned && (!after || later(key(artifact), after) > 0)).sort((a, b) => later(key(a), key(b)))
    const page = rest.slice(0, Math.max(0, limit - pinned.length))
    const next = rest.length > page.length && page.length ? key(page.at(-1)!).join("|") : null
    return { artifacts: [...pinned, ...page].map(summary), next }
  }

  /**
   * Every version made in `scope`, newest first, each with its artifact: what a Timeline shows.
   * In a group chat, only what its bots made there; for a bot, only what it made; for a
   * conversation, only its turns'. `before`: older than this.
   */
  timeline(scope: Scope, { limit = 200, before }: { limit?: number; before?: string } = {}): { entries: { artifact: Header; version: Version }[]; next: string | null } {
    const entries: { artifact: Header; version: Version }[] = []
    const key = (entry: { artifact: Header; version: Version }) => [entry.version.at, entry.artifact.id, String(entry.version.n).padStart(9, "0")]
    const after = before?.split("|")
    for (const artifact of this.artifacts.values()) {
      if (!this.matches(artifact, scope)) continue
      const { versions, ...header } = artifact
      for (const version of versions) {
        if (version.before || (after && later(key({ artifact: header, version }), after) <= 0)) continue
        if (scope.group && version.group?.id !== scope.group) continue
        if (scope.bot && version.by.bot !== scope.bot && !(version.by.kind !== "agent" && artifact.where.bots.includes(scope.bot))) continue
        if (scope.session && version.turn?.session !== scope.session) continue
        if (scope.by && version.by.bot !== scope.by) continue
        entries.push({ artifact: header, version })
      }
    }
    // Newest first; made in the same moment, by artifact, the later version first.
    entries.sort((a, b) => later(key(a), key(b)))
    const page = entries.slice(0, limit)
    return { entries: page, next: entries.length > page.length ? key(page.at(-1)!).join("|") : null }
  }

  /** What the copies take, and how much of it is older versions that could go. */
  storage(): { copies: number; older: number; budget: number; free: number; floor: number; low: boolean } {
    const copies = this.copyBytes
    let older = 0
    for (const { version } of this.prunable()) older += version.size
    const { free, floor } = this.policy.space()
    return { copies, older, budget: this.budget, free, floor, low: free < floor }
  }

  /** Your budget for older versions, kept for the next start; older ones past it go now. */
  setBudget(bytes: number) {
    this.chosenBudget = Math.max(0, Math.floor(bytes))
    writeFileSync(join(this.root, "settings.json.new"), JSON.stringify({ budget: this.chosenBudget }))
    renameSync(join(this.root, "settings.json.new"), join(this.root, "settings.json"))
    this.settle()
  }

  /** Older versions' copies cleared (those from before `before`, or all): each stays listed, as no longer kept. */
  clearOlder(before?: string): number {
    let cleared = 0
    for (const { artifact, version } of this.prunable()) {
      if (before && version.at >= before) continue
      this.clear(artifact, version)
      cleared++
    }
    return cleared
  }

  private get budget() {
    return this.chosenBudget ?? this.options.budget ?? defaultBudget
  }

  /** Older versions that can go: not the newest of a file there now, not memory or a skill, not pinned. Oldest first. */
  private prunable(): { artifact: Artifact; version: Version }[] {
    const found: { artifact: Artifact; version: Version }[] = []
    for (const artifact of this.artifacts.values()) {
      if (artifact.pinned || kindsKeptWhole.has(artifact.kind)) continue
      // A deleted file's last copy can go too: it's no file's newest any more. Not one taken away
      // unseen (a machine's week-old downloads): its copy is how it's opened now.
      const newest = artifact.versions.at(-1)?.status === "deleted" ? undefined : [...artifact.versions].reverse().find((version) => version.kept)
      for (const version of artifact.versions) if (version.kept && version !== newest) found.push({ artifact, version })
    }
    return found.sort((a, b) => (a.version.at < b.version.at ? -1 : a.version.at > b.version.at ? 1 : 0))
  }

  private clear(artifact: Artifact, version: Version, reason: NoCopy = "cleared") {
    version.kept = false
    version.reason = reason
    if (version.hash) this.use(version.hash, version.size, -1)
    this.write(artifact, version)
    this.told(artifact)
  }

  /** Past its budget: the oldest older versions go until it's within it. */
  private settle() {
    // Older versions take no more than all the copies: within the budget, there's nothing to look at.
    if (this.copyBytes <= this.budget) return
    const prunable = this.prunable()
    let older = prunable.reduce((sum, { version }) => sum + version.size, 0)
    for (const { artifact, version } of prunable) {
      if (older <= this.budget) break
      this.clear(artifact, version)
      older -= version.size
    }
  }

  private matches(artifact: Artifact, scope: Scope) {
    if (scope.kind && artifact.kind !== scope.kind) return false
    if (scope.pinned && !artifact.pinned) return false
    if (scope.session && !artifact.where.sessions.includes(scope.session)) return false
    if (scope.bot && !artifact.where.bots.includes(scope.bot)) return false
    if (scope.group && !artifact.where.groups.includes(scope.group)) return false
    if (scope.project && artifact.where.project !== scope.project && !artifact.path.startsWith(scope.project + sep)) return false
    return true
  }

  /** Where it belongs, with `made`'s added. Whether that changed anything. */
  private note(artifact: Artifact, made: Made): boolean {
    const where = made.where ?? {}
    let changed = false
    if (where.bot && !artifact.where.bots.includes(where.bot)) {
      artifact.where.bots = [...artifact.where.bots, where.bot]
      changed = true
    }
    if (where.project && !artifact.where.project) {
      artifact.where.project = where.project
      changed = true
    }
    if (where.session && !artifact.where.sessions.includes(where.session)) {
      artifact.where.sessions = [...artifact.where.sessions, where.session]
      changed = true
    }
    if (where.group && !artifact.where.groups.includes(where.group)) {
      artifact.where.groups = [...artifact.where.groups, where.group]
      changed = true
    }
    return changed
  }

  private sameTurn(latest: Version, made: Made, now: Date) {
    if (latest.before || made.separate || latest.via.includes("restore") || latest.via.includes("replaced")) return false
    if (made.turn && latest.turn) return made.turn.session === latest.turn.session && made.turn.message === latest.turn.message
    if (!made.turn && !latest.turn && made.by.kind === latest.by.kind && made.by.kind !== "agent") return now.getTime() - Date.parse(latest.at) < outsideWindow
    return false
  }

  private add(artifact: Artifact, change: Pick<Version, "status" | "hash" | "size" | "kept" | "reason" | "patch">, made: Made, now: Date, bytes?: Buffer): Artifact {
    const latest = artifact.versions.at(-1)
    // A deletion is a version of its own: one folded into its turn's would lose what the file was
    // (a picture a command made and removed in one turn, its copy kept).
    const replacing = latest && change.status !== "deleted" && this.sameTurn(latest, made, now) ? latest : undefined
    const previous = replacing ? artifact.versions.at(-2) : latest
    const version: Version = {
      n: replacing ? replacing.n : (latest?.n ?? 0) + 1,
      at: stamp(now),
      by: made.by,
      ...(made.turn ? { turn: made.turn } : {}),
      ...(made.group ? { group: made.group } : {}),
      ...(made.trigger ? { trigger: made.trigger } : {}),
      via: replacing ? [...new Set([...replacing.via, made.via])] : [made.via],
      edits: (replacing?.edits ?? 0) + 1,
      ...change,
    }
    // Made in this turn, then changed again: still new in it.
    if (replacing?.status === "added" && change.status !== "deleted") version.status = "added"
    // Code git keeps: each of the turn's changes, one after another.
    if (replacing?.patch && change.patch) version.patch = (replacing.patch + "\n" + hunksOf(change.patch)).slice(0, patchLimit)
    const lines = version.patch
      ? fromPatch(artifact.path, version.patch)
      : bytes && previous ? this.lines(artifact.type, previous, bytes) : bytes && isText(artifact.type) && !previous && bytes.length <= lineLimit ? unified("", bytes.toString("utf8")) : undefined
    if (lines) version.lines = { added: lines.additions, removed: lines.deletions }
    // Another bot in the same chat made the one before: handed on.
    if (made.group && previous?.group?.id === made.group.id && previous.by.bot && made.by.bot && previous.by.bot !== made.by.bot) version.handoff = { from: previous.by.bot }
    if (replacing) {
      if (replacing.kept && replacing.hash) this.use(replacing.hash, replacing.size, -1)
      artifact.versions[artifact.versions.length - 1] = version
    } else {
      artifact.versions.push(version)
    }
    if (version.kept && version.hash) this.use(version.hash, version.size, 1)
    // The disk down to its floor: the version this one replaces keeps no copy (but what's always kept).
    if (previous?.kept && !replacing && !artifact.pinned && !kindsKeptWhole.has(artifact.kind) && this.policy.lowOn(0)) this.clear(artifact, previous, "low-disk")
    artifact.updated = version.at
    // Rewritten by two wake-ups or more: a page kept up to date.
    if (artifact.kind === "document" && !artifact.living && artifact.versions.filter((each) => each.trigger === "wake").length >= 2) artifact.living = true
    this.write(artifact, version)
    this.settle()
    return this.told(artifact)
  }

  /** Lines added and removed since `previous`, when both are text that was kept. */
  private lines(type: string, previous: Version, bytes: Buffer) {
    // Past a megabyte, not counted: the diff would hold up everything else here.
    if (!isText(type) || !previous.kept || !previous.hash?.startsWith("sha256:") || bytes.length > lineLimit || previous.size > lineLimit) return undefined
    try {
      return unified(readFileSync(this.copyPath(previous.hash)).toString("utf8"), bytes.toString("utf8"))
    } catch {
      return undefined
    }
  }

  /** Code by its name, but not text by its bytes: a file. */
  private refine(kind: Kind, bytes?: Buffer): Kind {
    if (kind !== "code" || !bytes) return kind
    return isBinary(bytes) ? "file" : kind
  }

  /**
   * The file as `seen` (now, unless given): its bytes when a copy could be kept, and a hash either way (keyed for what's
   * private, of its size and time for what's too big to read); undefined when it isn't there (or
   * isn't a file), null when it is but can't be read now.
   */
  private read(path: string, seen = this.look(path)): { hash: string; size: number; bytes?: Buffer; private?: NoCopy } | undefined | null {
    if (!seen) return seen
    const privacy = this.policy.privacy(path)
    if (!seen.bytes) return { hash: `stat:${seen.size}:${seen.mtime}`, size: seen.size, ...(privacy ? { private: privacy } : {}) }
    // What's private: keyed, so the record says when it changed and nothing of what it holds.
    if (privacy) return { hash: "keyed:" + createHmac("sha256", this.key).update(seen.bytes).digest("hex"), size: seen.size, private: privacy }
    return { hash: "sha256:" + createHash("sha256").update(seen.bytes).digest("hex"), size: seen.size, bytes: seen.bytes }
  }

  /**
   * The file as it is now: its bytes up to the copy limit, its size and time either way;
   * undefined when it isn't there (or isn't a file), null when it is but can't be read now.
   */
  private look(path: string): { size: number; mtime: number; bytes?: Buffer } | undefined | null {
    let stat
    try {
      stat = statSync(path)
    } catch (error: any) {
      return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? undefined : null
    }
    if (!stat.isFile()) return undefined
    if (stat.size > copyLimit) return { size: stat.size, mtime: stat.mtimeMs }
    try {
      const bytes = readFileSync(path)
      return { size: bytes.length, mtime: stat.mtimeMs, bytes }
    } catch (error: any) {
      return error?.code === "ENOENT" ? undefined : null
    }
  }

  /** The log as it adds up now, in place of `months`: written aside, then moved in, then they go. */
  private compact(months: string[]) {
    const lines: string[] = []
    for (const artifact of this.artifacts.values()) {
      const { versions, ...header } = artifact
      if (!versions.length) lines.push(JSON.stringify({ a: header }))
      for (const version of [...versions].sort((a, b) => a.n - b.n)) lines.push(JSON.stringify({ a: header, v: version }))
    }
    // Before every month, so later ones read after it.
    const file = join(this.root, "log", "0000-00.jsonl")
    try {
      writeFileSync(file + ".new", lines.join("\n") + "\n")
      renameSync(file + ".new", file)
      for (const month of months) if (month !== "0000-00.jsonl") rmSync(join(this.root, "log", month), { force: true })
    } catch (error: any) {
      rmSync(file + ".new", { force: true })
      console.error("artifacts: the log couldn't be compacted:", error?.message ?? error)
    }
  }

  private copyPath(hash: string) {
    const hex = hash.slice("sha256:".length)
    return join(this.root, "copies", hex.slice(0, 2), hex)
  }

  private keep(hash: string, bytes: Buffer) {
    const file = this.copyPath(hash)
    if (existsSync(file)) return
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file + ".new", bytes)
    renameSync(file + ".new", file)
  }

  /** A kept version more or less using a copy; a copy no version uses goes. */
  private use(hash: string, size: number, by: 1 | -1) {
    if (!hash.startsWith("sha256:")) return
    const entry = this.copies.get(hash) ?? { uses: 0, size }
    if (!entry.uses && by > 0) this.copyBytes += entry.size
    entry.uses += by
    if (entry.uses > 0) {
      this.copies.set(hash, entry)
      return
    }
    this.copies.delete(hash)
    this.copyBytes -= entry.size
    rmSync(this.copyPath(hash), { force: true })
  }

  private told(artifact: Artifact): Artifact {
    for (const listener of this.listeners) listener(artifact)
    return artifact
  }

  private write(artifact: Artifact, version?: Version) {
    const { versions: _, ...header } = artifact
    const line: Line = { a: header, ...(version ? { v: version } : {}) }
    appendFileSync(join(this.root, "log", stamp(this.now()).slice(0, 7) + ".jsonl"), JSON.stringify(line) + "\n")
  }

  private load() {
    let months: string[] = []
    try {
      months = readdirSync(join(this.root, "log")).filter((name) => name.endsWith(".jsonl")).sort()
    } catch {}
    let lines = 0
    for (const month of months) {
      let text = ""
      try {
        text = readFileSync(join(this.root, "log", month), "utf8")
      } catch {}
      for (const each of text.split("\n")) {
        if (!each) continue
        lines++
        let line: Line
        try {
          line = JSON.parse(each)
        } catch {
          // A line cut short as the box stopped: the rest still counts.
          continue
        }
        if (!line?.a?.id) continue
        const artifact = this.artifacts.get(line.a.id) ?? { ...line.a, versions: [] }
        Object.assign(artifact, line.a)
        if (line.v) {
          const at = artifact.versions.findIndex((version) => version.n === line.v!.n)
          if (at >= 0) artifact.versions[at] = line.v
          else artifact.versions.push(line.v)
        }
        this.artifacts.set(artifact.id, artifact)
      }
    }
    // Grown well past what it holds (each change wrote a line): written again, a line a version.
    let versions = 0
    for (const artifact of this.artifacts.values()) versions += artifact.versions.length + 1
    if (lines > 1000 && lines > versions * 2) this.compact(months)
    // Shown before the record heard it: marked, as it was then, with no version of its own.
    const marked = new Set<Artifact>()
    for (const { path, at } of this.options.shown ?? []) {
      const artifact = this.at(path)
      const when = stamp(new Date(at))
      if (!artifact || (artifact.shown && artifact.shown >= when)) continue
      artifact.shown = when
      marked.add(artifact)
    }
    // A command's scratch in a project's tmp folder, recorded before it was left out (a render to
    // check its work): not what it made, unless you kept it or it was shown.
    const dropped = new Set<string>()
    let any = false
    for (const artifact of [...this.artifacts.values()]) {
      const project = artifact.where.project
      if (!project || artifact.where.bots.length || artifact.pinned || artifact.shown || !inScratch(artifact.path, project)) continue
      if (!artifact.versions.every((version) => version.via.length && version.via.every((via) => via === "shell"))) continue
      this.artifacts.delete(artifact.id)
      any = true
      for (const version of artifact.versions) if (version.hash?.startsWith("sha256:")) dropped.add(version.hash)
    }
    // Written down: a dropped one's lines go with the log written again.
    if (any) this.compact(months)
    else for (const artifact of marked) this.write(artifact)
    for (const artifact of this.artifacts.values()) {
      artifact.versions.sort((a, b) => a.n - b.n)
      // Recorded before its kind told its type (bytes that aren't text, said to be text).
      artifact.type = typeOf(artifact.path, artifact.kind === "file" || artifact.type === "application/octet-stream")
      for (const version of artifact.versions) {
        if (!version.kept || !version.hash) continue
        // A copy that went missing (deleted by hand): no longer kept.
        if (!existsSync(this.copyPath(version.hash))) version.kept = false
        else this.use(version.hash, version.size, 1)
      }
    }
    // Their copies, when nothing else has the same bytes.
    for (const hash of dropped) if (!this.copies.has(hash)) rmSync(this.copyPath(hash), { force: true })
  }
}

/** A unified diff's hunks, without its file headers. */
function hunksOf(patch: string): string {
  const at = patch.indexOf("@@")
  return at < 0 ? patch : patch.slice(at)
}

/**
 * Keys compared part by part, newest first: negative when `a` is later than `b` (it comes first in
 * a list), positive when it's older (it comes after `b`, past a cursor at `b`).
 */
function later(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? ""
    const y = b[i] ?? ""
    if (x !== y) return x < y ? 1 : -1
  }
  return 0
}

function summary(artifact: Artifact): Summary {
  const { versions, ...header } = artifact
  return { ...header, versions: versions.filter((version) => !version.before).length, latest: versions.at(-1)! }
}
