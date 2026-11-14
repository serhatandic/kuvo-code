// Who's asking the vault: the conversation an agent's tool call comes from, the conversation it
// works for (a subagent's root), that one's folder, and its bot when it's one. Grants are by bot,
// by project (the folder) or for everyone.

import path from "node:path";
import { processRuns as runs } from "../../shared/platform";
import type { BridgeRecord, EngineRecord, Target } from "../../shared/records";
import type { VaultGrant, VaultItem } from "../../shared/routes/vault";
import { listBots } from "../bots/list";
import { engineGet, readBridgeFile, readEngineFile, type EngineAnswer } from "../engine/client";
import type { EngineSession } from "../engine/sessions";
import { worksFor } from "../work/tree";
import { readGrants } from "./store";

/** The caller, as far as it can be told. */
export interface Caller {
  /** The conversation the call came from. */
  session?: string;
  /** The conversation it works for, and its name. */
  root?: string;
  sessionName?: string;
  folder?: string;
  bot?: string;
  botName?: string;
  /** A bot's seat in a group chat, which nobody's there to answer for for good: it asks you each
   * time, whatever its grants (`grantFor`), and never for good (`alwaysFor`). So does a
   * conversation whose root the engine didn't say. */
  seat?: boolean;
  /** That seat's group chat, where its asks show. */
  group?: string;
  /** Its conversation is on Autopilot: nothing asks you for it. */
  autopilot?: boolean;
  /** A command of yours, not an agent's (by the folder it's in): Autopilot has no say in it. */
  yours?: boolean;
}

async function sessionAt(targets: Target[], id: string): Promise<EngineSession | null> {
  for (const target of targets) {
    try {
      const found = (await engineGet(target, `api/session/${encodeURIComponent(id)}`) as EngineAnswer<EngineSession> | null)?.data;
      if (found?.id) return found;
    } catch {}
  }
  return null;
}

/** Who `session` is: its root conversation, folder and bot, from the engine (or the coding agents'
 * bridge); only the session when neither knows it. */
export async function callerOf(session: unknown, readEngine: () => EngineRecord, readBridge: () => BridgeRecord): Promise<Caller> {
  if (typeof session !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(session)) return {};
  const targets: Target[] = [];
  try { targets.push(readEngine()); } catch {}
  try {
    const bridge = readBridge();
    if (bridge?.port && bridge?.password && runs(bridge.pid, "kuvo-agents")) targets.push(bridge);
  } catch {}
  // (Up through its subagents, and a coding agent's engine run, Auto's, to the conversation it runs for.)
  const above = (each: EngineSession | null) => {
    const runsFor = each?.metadata?.kuvo?.engineFor;
    return each?.parentID ?? (typeof runsFor === "string" ? runsFor : null);
  };
  let current = await sessionAt(targets, session);
  for (let step = 0; step < 5 && above(current); step++) current = (await sessionAt(targets, above(current)!)) ?? current;
  const root = current?.id ?? session;
  // (A conversation whose root the engine didn't say may be a seat's: it asks you, as one does.)
  const unsure = !!above(current);
  // (A seat is its bot's, by the chat's mark on it: its asks name the bot, and its pause holds.
  // So is a session the bot started for its work, by the box's mark on it.)
  const seat = current?.metadata?.kuvo?.seat as { bot?: unknown; group?: unknown } | undefined;
  const bots = listBots();
  const works = worksFor(current);
  const bot = seat ? bots.find(each => typeof seat.bot === "string" && each.id === seat.bot)
    : bots.find(each => each.session === root) ?? (works ? bots.find(each => each.id === works.bot) : undefined);
  const folder = current?.location?.directory ?? current?.directory;
  return {
    session,
    root,
    ...(current?.metadata?.kuvo?.autopilot === true ? { autopilot: true } : {}),
    ...(current?.title ? { sessionName: current.title } : {}),
    ...(folder ? { folder: path.resolve(folder) } : {}),
    ...(bot ? { bot: bot.id, botName: bot.name } : {}),
    ...(seat || unsure ? { seat: true, ...(typeof seat?.group === "string" && seat.group ? { group: seat.group } : {}) } : {}),
  };
}

/** How often an ask that's waiting looks whether its conversation went on Autopilot meanwhile. */
const AUTOPILOT_LOOK = 5_000;

/** `ask`, waiting on you, handed a signal that also goes once the conversation `session` is part of
 * goes on Autopilot (from any client), where nothing waits for you; and whether it did. */
export async function untilOnAutopilot<T>(session: string | undefined, signal: AbortSignal | undefined, ask: (signal?: AbortSignal) => Promise<T>): Promise<{ value: T; onAutopilot: boolean }> {
  if (!session) return { value: await ask(signal), onAutopilot: false };
  const stop = new AbortController();
  let onAutopilot = false;
  let looking = false;
  const look = setInterval(async () => {
    if (looking) return;
    looking = true;
    const who = await callerOf(session, readEngineFile, readBridgeFile).catch((): Caller => ({}));
    looking = false;
    if (who.autopilot) { onAutopilot = true; stop.abort(); }
  }, AUTOPILOT_LOOK);
  try {
    const value = await ask(signal ? AbortSignal.any([signal, stop.signal]) : stop.signal);
    return { value, onAutopilot };
  } finally {
    clearInterval(look);
  }
}

/** A JSON value with its keys in order, to compare two. */
const ordered = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(ordered)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered((value as Record<string, unknown>)[key])]))
    : value;

interface ToolBlock { type?: string; id?: string; callID?: string; name?: string; state?: { status?: string; input?: unknown } }

/**
 * Whether `session` is making one of `tools` now, with `args` (when given): its engine (or the coding
 * agents' bridge) has that call running in it. A tool server names the session that calls, but so
 * could any command on this computer: only a call the conversation really makes uses its grants.
 * A tool's name may carry its server's (`kuvo-browser_vault_run`, `mcp__kuvo-browser__vault_run`).
 */
export async function isCalling(session: string | undefined, tools: string[], args: Record<string, unknown> | null, readEngine: () => EngineRecord, readBridge: () => BridgeRecord): Promise<boolean> {
  return (await callingNow(session, tools, args, readEngine, readBridge)) !== null;
}

/** The call `isCalling` finds, by its id (or its place, when it has none); null for none. */
export async function callingNow(session: string | undefined, tools: string[], args: Record<string, unknown> | null, readEngine: () => EngineRecord, readBridge: () => BridgeRecord): Promise<string | null> {
  if (!session || !/^[A-Za-z0-9_-]{1,100}$/.test(session)) return null;
  const targets: Target[] = [];
  try { targets.push(readEngine()); } catch {}
  try {
    const bridge = readBridge();
    if (bridge?.port && bridge?.password && runs(bridge.pid, "kuvo-agents")) targets.push(bridge);
  } catch {}
  const named = (name: unknown) => typeof name === "string" && tools.some(tool => name === tool || name.endsWith("_" + tool));
  const wanted = args ? JSON.stringify(ordered(args)) : null;
  for (const target of targets) {
    try {
      const page = await engineGet(target, `api/session/${encodeURIComponent(session)}/message?limit=6&order=desc`) as EngineAnswer<{ content?: ToolBlock[] }[]> | null;
      for (const [at, message] of (page?.data ?? []).entries()) {
        for (const [place, block] of (message.content ?? []).entries()) {
          if (block.type !== "tool" || !named(block.name) || !["running", "pending"].includes(block.state?.status ?? "")) continue;
          if (wanted === null || JSON.stringify(ordered(block.state?.input ?? {})) === wanted) return `${session}\0${block.callID ?? block.id ?? `${at}.${place}`}`;
        }
      }
    } catch {}
  }
  return null;
}

/** How `caller` may use `item`: on its own, by asking you, or not at all (null). The most a grant
 * gives wins: a bot's, its project's or everyone's; a seat in a group chat asks you, whatever it's given. */
export function grantFor(item: VaultItem, caller: Caller, grants: VaultGrant[] = readGrants()): VaultGrant["how"] | null {
  let how: VaultGrant["how"] | null = null;
  for (const grant of grants) {
    if (grant.item !== item.id) continue;
    const fits = grant.who.everyone
      || (grant.who.bot && grant.who.bot === caller.bot)
      || (grant.who.project && caller.folder && (caller.folder === grant.who.project || caller.folder.startsWith(grant.who.project + path.sep)));
    if (!fits) continue;
    if (grant.how === "own" && !caller.seat) return "own";
    how = "ask";
  }
  return how;
}
