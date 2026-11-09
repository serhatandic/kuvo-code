// The agents' vault tools, the same on every box (PROTOCOL.md, "Vault"): vault_items, vault_ask and
// vault_run. Both tool servers (this Mac's app, a machine's kuvo-browser.js) pass a call here as it
// is and give back what this says. None of them ever gives an agent a value.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isObject } from "../../shared/json";
import { cut, oneLine } from "../../shared/text";
import type { VaultItem } from "../../shared/routes/vault";
import { homeFolder, IS_MAC, RUN } from "../home";
import { ask } from "./asks";
import { type Hidden, maskValues } from "./mask";
import { itemNamed, noteUsed, readItems, setGrant, siteOf, valuesOf, VaultRefusal } from "./store";
import { LEFT_UNDONE_WORDS } from "../work/autopilot";
import { type Caller, grantFor, untilOnAutopilot } from "./who";
import { allowOnce, AUTOPILOT_HOW, alwaysFor, mayUse, noteUse } from "./use";
import { note } from "./activity";
import { commandEnv, runCommand } from "../run-command";

/** What a tool answers: words for the agent, and whether it failed. */
export interface ToolAnswer {
  text: string;
  isError: boolean;
}

const failed = (text: string): ToolAnswer => ({ text, isError: true });

/** The tools, as both tool servers list them (`tools/list`). */
export const VAULT_TOOLS = [
  {
    name: "vault_items",
    description: "List the vault items you may use (sign-ins, keys, files and notes) by name, with where each may be used and whether the user is asked each time. You never see a value: you name an item, and Kuvo Code fills it in (browser_sign_in, browser_fill) or hands it to a command (vault_run).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vault_ask",
    description: "Ask the user for something you need from their vault that vault_items doesn't list, like a site's sign-in or an API key. They pick an item or say no; you get its name, never its value. Waits for their answer.",
    inputSchema: {
      type: "object",
      properties: {
        need: { type: "string", description: "What you need, in a few words, like “a sign-in for play.google.com”." },
        why: { type: "string", description: "Why you need it, in one sentence the user reads." },
        site: { type: "string", description: "The site or host it's for, if any." },
      },
      required: ["need", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_run",
    description: "Run a shell command in your project's folder with values from the vault in its environment, never on its command line: each variable gets an item's value (`\"GITHUB_TOKEN\": \"GitHub token\"`, or `\"Item.field\"` for one field), and a file item's variable gets the path of a temporary copy, removed when the command ends. Vault values are hidden in its output. Use the variables in the command (`curl -H \"Authorization: Bearer $GITHUB_TOKEN\" …`); never print them.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Run with the user's shell." },
        variables: { type: "object", additionalProperties: { type: "string" }, description: "Each variable, and the item (or `Item.field`) whose value it gets." },
        why: { type: "string", description: "Why you need these, in one sentence the user reads." },
        timeout: { type: "number", description: "In seconds: 300 by default, 600 at most." },
      },
      required: ["command", "variables", "why"],
      additionalProperties: false,
    },
  },
] as const;

export const VAULT_TOOL_NAMES: readonly string[] = VAULT_TOOLS.map(tool => tool.name);

const KIND_WORDS: Record<VaultItem["kind"], string> = { login: "sign-in", key: "key", file: "file", note: "note" };

// ── vault_items ───────────────────────────────────────────────────────────────────────────────

async function listItems(caller: Caller): Promise<ToolAnswer> {
  const items = readItems();
  const usable = items.map(item => ({ item, how: grantFor(item, caller) })).filter(each => each.how);
  const lines: string[] = [];
  for (const { item, how } of usable) {
    const where = item.sites.length ? ` on ${item.sites.join(", ")}` : "";
    const fields = item.kind === "key" && item.fields.length > 1 ? ` (fields: ${item.fields.join(", ")})` : "";
    const user = item.kind === "login" && item.username ? `, username ${item.username}` : "";
    const only = item.signInOnly ? ", only for signing in with browser_sign_in" : "";
    lines.push(`- “${item.name}”: a ${KIND_WORDS[item.kind]}${where}${user}${fields}${only}; ${how === "own" ? "yours to use" : "the user is asked each time"}.`);
    if (item.kind === "note" && item.readable && how === "own") {
      try {
        const text = (await valuesOf(item.id)).text;
        if (text) lines.push(`  It reads: ${cut(text, 4000)}`);
      } catch {}
    }
  }
  const others = items.length - usable.length;
  const more = others ? `\n\nThe vault has ${others === 1 ? "one more item" : `${others} more items`} you may not use. If you need one, ask with vault_ask.` : "";
  if (!lines.length) return { text: `You may use nothing in the vault yet.${others ? " " : ""}${more.trim()}${others ? "" : " If you need a sign-in or a key, ask with vault_ask."}`, isError: false };
  return { text: `What you may use, by name:\n${lines.join("\n")}${more}\n\nSign in with browser_sign_in (it fills a sign-in on its own site), fill one field with browser_fill, or hand values to a command with vault_run.`, isError: false };
}

// ── vault_ask ─────────────────────────────────────────────────────────────────────────────────

async function askForItem(caller: Caller, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolAnswer> {
  const need = oneLine(typeof args.need === "string" ? args.need : "", 200).trim();
  const why = oneLine(typeof args.why === "string" ? args.why : "", 300).trim();
  if (!need || !why) return failed("Say what you need and why.");
  const site = siteOf(args.site) ?? undefined;
  const asker = { ...(caller.bot ? { bot: caller.bot, botName: caller.botName } : {}), ...(caller.root ? { session: caller.root, sessionName: caller.sessionName } : {}) };
  const leftUndone = (): ToolAnswer => {
    note({ what: "refused", ...asker, why: `${need}: ${why}`, ...(site ? { site } : {}), how: AUTOPILOT_HOW });
    return { text: LEFT_UNDONE_WORDS, isError: false };
  };
  if (caller.autopilot) return leftUndone();
  note({ what: "asked", ...asker, why: `${need}: ${why}`, ...(site ? { site } : {}) });
  const { value: answered, onAutopilot } = await untilOnAutopilot(caller.session, signal, stops => ask({
    kind: "item",
    need,
    why,
    ...(caller.group ? { group: caller.group } : {}),
    ...(site ? { site } : {}),
    ...asker,
    ...(IS_MAC ? {} : { machine: os.hostname() }),
  }, stops));
  if (onAutopilot) return leftUndone();
  const item = answered.item ? readItems().find(each => each.id === answered.item) : undefined;
  if (answered.answer === "no" || !item) return { text: "The user didn't give you anything for this. Go on without it, or say what's missing in your report.", isError: false };
  // Given always: this bot's (or project's) to use on its own; given once: its next use goes ahead.
  const always = answered.answer === "always" ? alwaysFor(caller) : null;
  if (always) setGrant(item.id, always, "own");
  else allowOnce(caller, item.id);
  note({ what: always ? "granted" : "allowed", item: item.id, itemName: item.name, kind: item.kind, ...(caller.bot ? { bot: caller.bot, botName: caller.botName } : {}), ...(caller.root ? { session: caller.root, sessionName: caller.sessionName } : {}), how: always ? "own" : "once", ...(answered.client ? { client: answered.client, by: answered.by } : {}) });
  const once = !always;
  return { text: `The user gave you “${item.name}” (a ${KIND_WORDS[item.kind]}${item.sites.length ? ` for ${item.sites.join(", ")}` : ""})${once ? ", for this once" : ""}. Use it by that name${item.kind === "login" ? " with browser_sign_in" : " with vault_run or browser_fill"}.`, isError: false };
}

// ── vault_run ─────────────────────────────────────────────────────────────────────────────────

const MOST_OUTPUT = 64 * 1024;
// (What's kept of a command's output, its last few megabytes, is masked before it's cut to its last
// MOST_OUTPUT, so a value the cut would split is still hidden.)
// What a call may take, the asking included: a little under the tool servers' 16 minutes.
const CALL_BUDGET = 15.5 * 60_000;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Where commands' copies of files go while they run: emptied as the vault is held, and as it ends. */
export const RUN_FOLDER = path.join(RUN, "vault-run");

/** The item and field a variable names: the whole as an item's name, else `Item.field`. */
function namedValue(named: string): { item: VaultItem; field: string | null } | null {
  const whole = itemNamed(named);
  if (whole) return { item: whole, field: null };
  const dot = named.lastIndexOf(".");
  if (dot <= 0) return null;
  const item = itemNamed(named.slice(0, dot));
  return item ? { item, field: named.slice(dot + 1).trim().toLowerCase() } : null;
}

/** The field a variable gets when it names none: a sign-in's password, a key's only field (or
 * `value`), a file's file, a note's text. */
function fieldOf(item: VaultItem, field: string | null): string | VaultRefusal {
  if (field) return item.fields.includes(field) ? field : new VaultRefusal(400, `“${item.name}” has no field “${field}”${item.fields.length ? `: it has ${item.fields.join(", ")}` : ""}.`);
  const fallback = { login: "password", file: "file", note: "text", key: item.fields.length === 1 ? item.fields[0] : "value" }[item.kind];
  if (item.fields.includes(fallback)) return fallback;
  return new VaultRefusal(400, `Say which of “${item.name}”'s fields: ${item.fields.join(", ") || "it has none"} (\`${item.name}.<field>\`).`);
}

async function runWith(caller: Caller, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolAnswer> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  const why = oneLine(typeof args.why === "string" ? args.why : "", 300).trim();
  if (!command) return failed("Give the command to run.");
  if (!why) return failed("Say why you need these values.");
  if (!isObject(args.variables) || !Object.keys(args.variables).length) return failed("Name at least one variable and the item it gets.");
  const started = Date.now();
  const program = path.basename(command.split(/\s+/)[0] ?? "");
  const folder = caller.folder && fs.existsSync(caller.folder) ? caller.folder : homeFolder();
  const wanted: { variable: string; item: VaultItem; field: string }[] = [];
  for (const [variable, named] of Object.entries(args.variables)) {
    if (!VARIABLE.test(variable)) return failed(`“${oneLine(variable, 40)}” isn't a variable's name.`);
    if (typeof named !== "string") return failed(`Name the item ${variable} gets.`);
    const found = namedValue(named);
    if (!found) return failed(`There's no item “${oneLine(named, 80)}” in the vault. See what you may use with vault_items.`);
    if (found.item.signInOnly) return failed(`“${found.item.name}” is only for signing in, in the browser: use browser_sign_in. It's never handed to a command.`);
    const field = fieldOf(found.item, found.field);
    if (field instanceof VaultRefusal) return failed(field.message);
    wanted.push({ variable, item: found.item, field });
  }
  // Each item once, as you allowed it.
  const allowed = new Map<string, string>();
  for (const { item } of wanted) {
    if (allowed.has(item.id)) continue;
    const may = await mayUse(item, caller, { program, why, askWithout: true, signal });
    // (What Autopilot leaves undone isn't a failed command.)
    if (!may.ok) return may.leftUndone ? { text: may.message, isError: false } : failed(may.message);
    allowed.set(item.id, may.how);
  }
  const scratch = path.join(RUN_FOLDER, crypto.randomBytes(8).toString("hex"));
  const env = commandEnv();
  const hidden: Hidden[] = [];
  try {
    fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    for (const { variable, item, field } of wanted) {
      const value = (await valuesOf(item.id))[field];
      if (value === undefined) return failed(`“${item.name}” has no ${field} kept.`);
      if (item.kind === "file" && field === "file") {
        // A folder for each variable, so two files of one name don't meet; the file under its own name.
        const name = path.basename(item.fileName ?? "");
        const file = path.join(scratch, variable, name && name !== "." && name !== ".." ? name : variable.toLowerCase());
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const bytes = Buffer.from(value, "base64");
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        env[variable] = file;
        // Its text, and its bytes as a command would print them: base64 whole and wrapped as
        // `base64` (76) and PEM (64) wrap it, and hex.
        const base64 = bytes.toString("base64");
        const wrapped = (width: number) => base64.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n");
        hidden.push({ item: item.name, value: bytes.toString("utf8") }, { item: item.name, value: base64 }, { item: item.name, value: wrapped(76) }, { item: item.name, value: wrapped(64) }, { item: item.name, value: bytes.toString("hex") });
      } else {
        env[variable] = value;
        hidden.push({ item: item.name, value });
      }
    }
    for (const [id, how] of allowed) {
      noteUsed(id);
      noteUse(wanted.find(each => each.item.id === id)!.item, caller, { program, why }, how);
    }
    // Within what a tool call may take altogether (the tool servers' 16 minutes), however long you took to answer.
    const left = Math.floor((CALL_BUDGET - (Date.now() - started)) / 1000);
    const seconds = Math.max(1, Math.min(600, left, Number(args.timeout) || 300));
    const { output, code, timedOut } = await runCommand(command, folder, env, seconds * 1000, signal, scratch, () => fs.rmSync(scratch, { recursive: true, force: true }));
    let shown = maskValues(output, hidden);
    // Its last part when there's a lot, from a line's start.
    if (shown.length > MOST_OUTPUT) shown = "…" + shown.slice(-MOST_OUTPUT).replace(/^[^\n]*\n/, "");
    const ended = timedOut ? `It was stopped after ${seconds} seconds.` : `It ended with ${code}.`;
    return { text: `${shown.trim() ? shown.trimEnd() + "\n\n" : "It printed nothing.\n\n"}${ended} (Values from the vault are shown as [vault: <item>].)`, isError: timedOut || code !== 0 };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ── The door ──────────────────────────────────────────────────────────────────────────────────

/** One of the tools, called for `caller`. */
export async function callTool(name: unknown, args: unknown, caller: Caller, signal?: AbortSignal): Promise<ToolAnswer> {
  const given = isObject(args) ? args : {};
  try {
    switch (name) {
      case "vault_items": return await listItems(caller);
      case "vault_ask": return await askForItem(caller, given, signal);
      case "vault_run": return await runWith(caller, given, signal);
      default: return failed(`There's no vault tool “${oneLine(name, 40)}”.`);
    }
  } catch (error) {
    if (error instanceof VaultRefusal) return failed(error.message);
    throw error;
  }
}
