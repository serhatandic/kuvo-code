// plan_limits: your plans' limits on this computer, for an agent to pace its work by (a lead
// handing out work, a bot deciding whether to start a long job now): each account's windows, how
// much of each is used and when it starts over, as of when, as the agents bridge states them
// (`api/kuvo/limits`, PROTOCOL.md "Plan limits"). Read only: it asks no maker for anything.

import { isObject } from "../../shared/json";
import { resetTime } from "../../shared/limits";
import type { Target } from "../../shared/records";
import { call } from "../engine/client";
import { HERE } from "../home";

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok", antigravity: "Antigravity" };
/** The engine's sign-ins, by the service they're limits of. */
const ENGINE_NAMES: Record<string, string> = { codex: "ChatGPT", grok: "SuperGrok", copilot: "GitHub Copilot", openrouter: "OpenRouter", zai: "Z.ai", ollama: "Ollama", opencode: "OpenCode Go" };

/** "$12.40", "180 requests". */
function amount(value: number, unit: unknown): string {
  return unit === "usd" ? `$${value.toFixed(2)}` : `${Math.round(value)} ${unit === "requests" ? "requests" : "credits"}`;
}

/** "in 2h 10m", "in 3 days": how long until `at`. */
function until(at: number, now: number): string {
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `in ${Math.round(hours / 24)} days`;
}

/** "3m ago", "2h ago": how long since `at`. */
function since(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`;
}

/** A window's name: the 5-hour one, the week, a model's own week. */
function windowName(window: Record<string, unknown>): string {
  const minutes = typeof window.minutes === "number" ? window.minutes : undefined;
  const length = minutes === 300 ? "5-hour window" : minutes === 10_080 ? "weekly limit" : minutes && minutes >= 40_000 && minutes <= 45_000 ? "monthly limit" : minutes ? `${minutes >= 1440 ? `${Math.round(minutes / 1440)}-day` : `${Math.round(minutes / 60)}-hour`} window` : "limit";
  if (typeof window.name === "string" && window.name) return window.name;
  return typeof window.model === "string" && window.model ? `${window.model} ${length}` : length;
}

/** An account's name, as an agent names it: "Codex", "Claude Code (Work)", "GitHub Copilot". */
export function rowTitle(account: Record<string, unknown>): string {
  const service = typeof account.agent === "string" ? (AGENT_NAMES[account.agent] ?? account.agent) : (ENGINE_NAMES[String(account.service)] ?? String(account.service));
  return `${service}${typeof account.label === "string" && account.label ? ` (${account.label})` : ""}`;
}

/** What a plan has beyond its windows, a line each: an amount, what's left, its resets (and how to use one). */
function extraLines(account: Record<string, unknown>, now: number): string[] {
  const lines: string[] = [];
  for (const extra of Array.isArray(account.extras) ? account.extras.filter(isObject) : []) {
    const name = typeof extra.name === "string" ? extra.name : String(extra.id);
    // (One that started over since it was read isn't known now.)
    if (typeof extra.resetsAt === "number" && extra.resetsAt <= now) continue;
    const resets = typeof extra.resetsAt === "number" ? `, starts over ${until(extra.resetsAt, now)}` : "";
    if (extra.kind === "spent" && typeof extra.amount === "number") lines.push(`  - ${name}: ${amount(extra.amount, extra.unit)} spent${resets}`);
    else if (extra.kind === "capped" && typeof extra.amount === "number" && typeof extra.limit === "number") lines.push(`  - ${name}: ${amount(extra.amount, extra.unit)} of ${amount(extra.limit, extra.unit)} used${resets}`);
    else if (extra.kind === "left" && typeof extra.amount === "number") lines.push(`  - ${name}: ${amount(extra.amount, extra.unit)} left`);
    else if (extra.kind === "resets") {
      const count = Number(extra.count) || 0;
      const where = isObject(extra.on) && extra.on.here !== true && typeof extra.on.name === "string" ? ` (used on ${extra.on.name}, which has its sign-in)` : "";
      const use = count > 0 && extra.usable === true ? `; use_limit_reset with account "${String(account.id ?? account.provider)}" uses one${where}${extra.agents === true ? " (the user allows it without asking)" : " (the user approves each)"}` : count > 0 ? "; none can be used from your computers now" : "";
      lines.push(`  - rate-limit resets: ${count} available${use}`);
    } else if (extra.kind === "unreadable" && typeof extra.message === "string") lines.push(`  - ${extra.message}`);
  }
  return lines;
}

/** The limits as an agent reads them: every account across your computers where the box lists
 * them so (`rows`, read wherever it was read last), this computer's first; else this one's own. */
export function describePlanLimits(data: unknown, now = Date.now()): string {
  const rows = isObject(data) && Array.isArray(data.rows) ? data.rows.filter(isObject) : null;
  const accounts = rows ?? (isObject(data) && Array.isArray(data.accounts) ? data.accounts.filter(isObject) : []);
  if (!accounts.length) return `No plan limits are known on ${HERE}: no coding agent here is signed in to a plan whose limits can be read.`;
  const lines = [rows ? `Plan limits of your accounts (signed in on ${HERE} unless it says where; used is how much of the window is gone):` : `Plan limits on ${HERE} (each account's own; used is how much of the window is gone):`];
  for (const account of accounts) {
    const service = typeof account.agent === "string" ? (AGENT_NAMES[account.agent] ?? account.agent) : (ENGINE_NAMES[String(account.service)] ?? String(account.service));
    const boxes = Array.isArray(account.boxes) ? account.boxes.filter(isObject) : [];
    const elsewhere = rows && !boxes.some(box => box.here === true) ? boxes.map(box => String(box.name || "another computer")) : [];
    const where = elsewhere.length ? `, signed in on ${elsewhere.join(", ")}${account.away === true ? " (not heard from lately: as last told)" : ""}` : "";
    const provider = rows ? (boxes.find(box => box.here === true)?.provider ?? account.provider) : account.provider;
    const name = `${service}${typeof account.label === "string" && account.label ? ` (${account.label})` : ""}${typeof account.plan === "string" && account.plan ? `, ${account.plan}` : ""}${elsewhere.length ? "" : `, provider ${String(provider)}`}${where}`;
    lines.push(`- ${name}:`);
    const windows = Array.isArray(account.windows) ? account.windows.filter(isObject) : [];
    for (const window of windows) {
      const resetsAt = typeof window.resetsAt === "number" ? window.resetsAt : undefined;
      // Started over since it was read: what's used now isn't known, only that it's less.
      if (resetsAt && resetsAt <= now) {
        lines.push(`  - ${windowName(window)}: started over at ${resetTime(resetsAt)}, not read since`);
        continue;
      }
      const used = Math.round(Number(window.used) * 100);
      const read = typeof window.read === "number" ? `, as of ${since(window.read, now)}` : "";
      const counted = isObject(window.amount) ? ` (${amount(Number(window.amount.used), window.amount.unit)} of ${amount(Number(window.amount.limit), window.amount.unit)})` : "";
      lines.push(`  - ${windowName(window)}: ${used}% used${counted}${resetsAt ? `, resets ${until(resetsAt, now)} (${resetTime(resetsAt)})` : ""}${read}`);
    }
    const balance = isObject(account.balance) ? account.balance : undefined;
    if (balance) lines.push(`  - credits: ${amount(Number(balance.left), balance.unit)} left${typeof balance.limit === "number" ? ` of ${amount(balance.limit, balance.unit)}` : ""}`);
    lines.push(...extraLines(account, now));
    if (!windows.length && !balance && !Array.isArray(account.extras)) lines.push("  - none read yet");
    const problem = isObject(account.problem) ? account.problem : undefined;
    if (problem && typeof problem.message === "string") {
      const next = typeof problem.until === "number" && problem.until > now ? ` Read again ${until(problem.until, now)}.` : "";
      lines.push(`  - Not read just now: ${problem.message}${next}`);
    }
  }
  return lines.join("\n");
}

/** plan_limits, from the coding agents' bridge here. */
export async function planLimitsTool(bridge: Target | null, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
  if (!bridge) return { text: `The coding agents aren't running on ${HERE} now, so their plan limits can't be read. Try again in a moment.`, isError: true };
  try {
    return { text: describePlanLimits(await call(bridge, "GET", "/api/kuvo/limits", undefined, signal)), isError: false };
  } catch (error) {
    return { text: `Couldn't read the plan limits on ${HERE}: ${String((error as Error | null)?.message ?? error)}`, isError: true };
  }
}
