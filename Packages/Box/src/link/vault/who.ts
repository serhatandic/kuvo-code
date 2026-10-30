// Who's asking the vault: the conversation an agent's tool call comes from, the conversation it
// works for (a subagent's root), that one's folder, and its bot when it's one. Grants are by bot,
// by project (the folder) or for everyone.

import path from "node:path";
import { processRuns as runs } from "../../shared/platform";
import type { BridgeRecord, EngineRecord, Target } from "../../shared/records";
import type { VaultGrant, VaultItem } from "../../shared/routes/vault";
import { listBots } from "../bots/list";
import { engineGet, type EngineAnswer } from "../engine/client";
import type { EngineSession } from "../engine/sessions";
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
  /** A bot's seat in a group chat, which nobody's there to answer for for good. */
  seat?: boolean;
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
  let current = await sessionAt(targets, session);
  for (let step = 0; step < 5 && current?.parentID; step++) current = (await sessionAt(targets, current.parentID)) ?? current;
  const root = current?.id ?? session;
  const bot = listBots().find(each => each.session === root);
  const folder = current?.location?.directory ?? current?.directory;
  return {
    session,
    root,
    ...(current?.title ? { sessionName: current.title } : {}),
    ...(folder ? { folder: path.resolve(folder) } : {}),
    ...(bot ? { bot: bot.id, botName: bot.name } : {}),
    ...(current?.metadata?.kuvo?.seat ? { seat: true } : {}),
  };
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
 * gives wins: a bot's, its project's or everyone's. */
export function grantFor(item: VaultItem, caller: Caller, grants: VaultGrant[] = readGrants()): VaultGrant["how"] | null {
  let how: VaultGrant["how"] | null = null;
  for (const grant of grants) {
    if (grant.item !== item.id) continue;
    const fits = grant.who.everyone
      || (grant.who.bot && grant.who.bot === caller.bot)
      || (grant.who.project && caller.folder && (caller.folder === grant.who.project || caller.folder.startsWith(grant.who.project + path.sep)));
    if (!fits) continue;
    if (grant.how === "own") return "own";
    how = "ask";
  }
  return how;
}
