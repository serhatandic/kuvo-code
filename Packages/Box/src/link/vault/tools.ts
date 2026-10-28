// The agents' vault tools, the same on every box (PROTOCOL.md, "Vault"): vault_items, vault_ask and
// vault_run. Both tool servers (this Mac's app, a machine's kuvo-browser.js) pass a call here as it
// is and give back what this says. None of them ever gives an agent a value.

import { spawn } from "node:child_process";
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
import { itemNamed, noteUsed, readItems, siteOf, valuesOf, VaultRefusal } from "./store";
import { type Caller, grantFor } from "./who";
import { mayUse, noteUse } from "./use";
import { note } from "./activity";

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
    description: "List the items in the user's vault that you may use: sign-ins, keys, files and notes, by name, with where each may be used and whether you use it on your own or the user is asked each time. You never see a value: you name an item, and Kuvo Code fills it in (browser_sign_in, browser_fill) or hands it to a command (vault_run).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vault_ask",
    description: "Ask the user for something you need from their vault that vault_items doesn't list, such as a sign-in for a site or an API key. They pick an item (or say no); you get its name, never its value. Waits for their answer.",
    inputSchema: {
      type: "object",
      properties: {
        need: { type: "string", description: "What you need, in a few words: “a sign-in for play.google.com”, “an App Store Connect API key”." },
        why: { type: "string", description: "Why you need it, in one sentence the user reads." },
        site: { type: "string", description: "The site or host it's for, if any." },
      },
      required: ["need", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_run",
    description: "Run a shell command in your project's folder with values from the vault in its environment, never on its command line: each variable you name gets an item's value (`\"GITHUB_TOKEN\": \"GitHub token\"`, or `\"Item.field\"` for one field), and a file item's variable gets the path of a temporary copy of the file (removed when the command ends). Its output comes back with every vault value hidden. Use the variables in the command (`curl -H \"Authorization: Bearer $GITHUB_TOKEN\" …`); never print them.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command, run with the user's shell." },
        variables: { type: "object", additionalProperties: { type: "string" }, description: "Each environment variable, and the item (or `Item.field`) whose value it gets." },
        why: { type: "string", description: "Why you need these, in one sentence the user reads." },
        timeout: { type: "number", description: "How long it may run, in seconds (300 unless you say; at most 1800)." },
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
    lines.push(`- “${item.name}”: a ${KIND_WORDS[item.kind]}${where}${user}${fields}; ${how === "own" ? "yours to use" : "the user is asked each time"}.`);
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
  note({ what: "asked", ...(caller.bot ? { bot: caller.bot, botName: caller.botName } : {}), ...(caller.root ? { session: caller.root, sessionName: caller.sessionName } : {}), why: `${need}: ${why}`, ...(site ? { site } : {}) });
  const answered = await ask({
    kind: "item",
    need,
    why,
    ...(site ? { site } : {}),
    ...(caller.bot ? { bot: caller.bot, botName: caller.botName } : {}),
    ...(caller.root ? { session: caller.root, sessionName: caller.sessionName } : {}),
    ...(IS_MAC ? {} : { machine: os.hostname() }),
  }, signal);
  const item = answered.item ? readItems().find(each => each.id === answered.item) : undefined;
  if (answered.answer === "no" || !item) return { text: "The user didn't give you anything for this. Go on without it, or say what's missing in your report.", isError: false };
  const once = answered.answer === "once";
  return { text: `The user gave you “${item.name}” (a ${KIND_WORDS[item.kind]}${item.sites.length ? ` for ${item.sites.join(", ")}` : ""})${once ? ", for this once" : ""}. Use it by that name${item.kind === "login" ? " with browser_sign_in" : " with vault_run or browser_fill"}.`, isError: false };
}

// ── vault_run ─────────────────────────────────────────────────────────────────────────────────

const MOST_OUTPUT = 64 * 1024;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// What the box's own process has that no command it runs should.
const PRIVATE = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "KUVO_HOST_URL", "KUVO_HOST_PASSWORD"];

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
  const program = path.basename(command.split(/\s+/)[0] ?? "");
  const folder = caller.folder && fs.existsSync(caller.folder) ? caller.folder : homeFolder();
  const wanted: { variable: string; item: VaultItem; field: string }[] = [];
  for (const [variable, named] of Object.entries(args.variables)) {
    if (!VARIABLE.test(variable)) return failed(`“${oneLine(variable, 40)}” isn't a variable's name.`);
    if (typeof named !== "string") return failed(`Name the item ${variable} gets.`);
    const found = namedValue(named);
    if (!found) return failed(`There's no item “${oneLine(named, 80)}” in the vault. See what you may use with vault_items.`);
    const field = fieldOf(found.item, found.field);
    if (field instanceof VaultRefusal) return failed(field.message);
    wanted.push({ variable, item: found.item, field });
  }
  // Each item once, as you allowed it.
  const allowed = new Map<string, string>();
  for (const { item } of wanted) {
    if (allowed.has(item.id)) continue;
    const may = await mayUse(item, caller, { program, why, askWithout: true, signal });
    if (!may.ok) return failed(may.message);
    allowed.set(item.id, may.how);
  }
  const scratch = path.join(RUN, "vault-run", crypto.randomBytes(8).toString("hex"));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !PRIVATE.includes(name)) env[name] = value;
  const hidden: Hidden[] = [];
  try {
    fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    for (const { variable, item, field } of wanted) {
      const value = (await valuesOf(item.id))[field];
      if (value === undefined) return failed(`“${item.name}” has no ${field} kept.`);
      if (item.kind === "file" && field === "file") {
        const file = path.join(scratch, item.fileName || `${variable.toLowerCase()}`);
        const bytes = Buffer.from(value, "base64");
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        env[variable] = file;
        hidden.push({ item: item.name, value: bytes.toString("utf8") });
      } else {
        env[variable] = value;
        hidden.push({ item: item.name, value });
      }
    }
    for (const id of allowed.keys()) noteUsed(id);
    for (const [id, how] of allowed) {
      const item = wanted.find(each => each.item.id === id)!.item;
      noteUse(item, caller, { program, why }, how);
    }
    const seconds = Math.min(1800, Math.max(1, Number(args.timeout) || 300));
    const { output, code, timedOut } = await run(command, folder, env, seconds * 1000, signal);
    const shown = maskValues(output, hidden);
    const ended = timedOut ? `It was stopped after ${seconds} seconds.` : `It ended with ${code}.`;
    return { text: `${shown.trim() ? shown.trimEnd() + "\n\n" : "It printed nothing.\n\n"}${ended} (Values from the vault are shown as [vault: <item>].)`, isError: timedOut || code !== 0 };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Runs `command` with the user's shell in `folder`: its output (the last of it when there's a lot), its exit code, and whether it ran out of time. */
function run(command: string, folder: string, env: Record<string, string>, timeout: number, signal?: AbortSignal): Promise<{ output: string; code: number | null; timedOut: boolean }> {
  return new Promise(resolve => {
    const shell = env.SHELL && fs.existsSync(env.SHELL) ? env.SHELL : "/bin/sh";
    const child = spawn(shell, ["-lc", command], { cwd: folder, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = Buffer.alloc(0);
    const take = (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > MOST_OUTPUT * 2) output = output.subarray(output.length - MOST_OUTPUT);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const stop = () => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
      setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 3000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", error => take(Buffer.from(String(error.message))));
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      let text = output.toString("utf8");
      if (output.length > MOST_OUTPUT) text = "…" + text.slice(-MOST_OUTPUT);
      resolve({ output: text, code, timedOut });
    });
  });
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
