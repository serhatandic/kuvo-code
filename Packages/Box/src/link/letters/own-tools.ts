// Kuvo Code's own tools that aren't about other agents (PROTOCOL.md, "Agents' tools"): a
// conversation's wake-ups and watches (schedule_wake_up, watch_for_change, list_wake_ups,
// cancel_wake_up), a bot's job (set_job), and what's checked before a file or a widget is shown
// (show_in_panel, show_file, mark_final, show_widget). Every box answers them alike through
// `POST kuvo/agent-tools`, so the tool servers (this Mac's app and keeper, a machine's
// kuvo-browser.js, and any client's to come) only pass the call on. Clients draw what's shown from
// the call; the box only says whether it goes ahead.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { changeBot } from "../bots/edit";
import { botHere, isMoving, MOVING } from "../bots/here";
import { listOf } from "../files";
import { BOTS, SESSION_WAKES, WAKE_COMMAND } from "../home";
import { wakeFolderFor, wakesChanged } from "../areas/wakes";
import type { Target } from "../../shared/records";
import type { SessionPlace } from "./letter";

/** What a tool says back: its words, and whether it didn't do what was asked. */
interface Said {
  text: string;
  isError: boolean;
}

const said = (text: string): Said => ({ text, isError: false });
const refused = (text: string): Said => ({ text, isError: true });

/** The conversation a call works for (`rootOf`), and the caller's own, as each runs here: null
 * where it isn't one here. */
export interface Calling {
  session: string | null;
  own: SessionPlace | null;
  root: { session: string; place: SessionPlace } | null;
}

// A group chat's seat, by its session's record.
const isSeat = (place: SessionPlace | null | undefined) => {
  const seat = place?.data.metadata?.kuvo?.seat;
  return seat !== undefined && seat !== null;
};

// The bot here whose conversation `session` is: its id and folder.
function botOf(session: string): { id: string; folder: string } | null {
  for (const id of listOf(BOTS).sort()) {
    const here = botHere(id);
    if (here?.session === session) return { id, folder: here.folder };
  }
  return null;
}

// Whether a session runs with the coding agents: its place is the agents' bridge.
const onBridge = (place: SessionPlace | null | undefined, bridge: Target | null) => Boolean(place && bridge && place.target.port === bridge.port);

/** The wake-up tools, by name. */
export const WAKE_TOOLS = ["schedule_wake_up", "watch_for_change", "list_wake_ups", "cancel_wake_up"] as const;
export type WakeToolName = (typeof WAKE_TOOLS)[number];

/** What an agent hears instead of a watch made without asking, in a conversation that asks before
 * commands: the same watch as a command, which asks the user with the check written out. */
export const WATCH_AS_COMMAND = "This conversation asks before running commands, and a watch runs its check by itself, so the user approves it first: start it with the shell command kuvo-wake watch <every> \"<check>\" \"<what to do when it changes>\" instead, which asks them.";

/** Whether a conversation with these rules asks before commands, but nothing asked the user about
 * a watch's check before its tool ran: its rules are from before watches asked, or it runs with the
 * coding agents (`agents`), whose bridge doesn't check Kuvo Code's tools against them. */
export function watchWentUnasked(rules: readonly { action: string; resource: string; effect: string }[] | undefined, agents: boolean): boolean {
  const all = rules ?? [];
  if (!all.some(rule => rule.action === "shell" && rule.resource === "*" && rule.effect === "ask")) return false;
  return agents || !all.some(rule => rule.action === "kuvo-browser_watch_for_change" && rule.effect === "ask");
}

/** A wake-up tool's call: through this computer's kuvo-wake, for the conversation the caller is
 * part of (a subagent's, the one that started it; a bot's, the bot's folder), run from the folder it
 * works in, so a session's wake-ups folder knows where that is. Never from a group chat's seat:
 * meetings are the chat's. Never stopped half way by the caller going: it changes what's kept. */
export async function wakeTool(name: WakeToolName, args: Record<string, unknown>, calling: Calling, readEngine: () => Target, readBridge: () => Target | null): Promise<Said> {
  const { session, own, root } = calling;
  const bridge = readBridge();
  if (!session) return refused("This needs a conversation of its own.");
  if (isSeat(own) || isSeat(root?.place)) return refused("Not from a group chat: a chat can meet on a schedule instead (its editor's Meets on a Schedule).");
  const owner = root?.session ?? session;
  const bot = botOf(owner);
  if (!bot && !root) return refused("Kuvo Code doesn't know this conversation yet. Try again in a moment.");
  // A coding agent's session: its wake-ups go to the agents' bridge.
  const viaBridge = onBridge(root?.place, bridge);
  const given = (key: string) => (typeof args[key] === "string" && (args[key] as string).trim() ? (args[key] as string).trim() : null);
  let verb: string[];
  switch (name) {
    case "schedule_wake_up": {
      const when = given("when"), note = given("note"), every = given("every"), summary = given("summary");
      if (!when) return refused("Say when (when): +20m, +2h, +1d, or a time like 2026-10-21T09:00.");
      if (!note) return refused("Add a note for yourself (note): what to do when you wake up.");
      verb = ["add", when, ...(every ? ["--every", every] : []), ...(summary ? ["--summary", summary] : []), note];
      break;
    }
    case "watch_for_change": {
      // A watch runs a command whenever it's due: in Ask First, only once the user was asked (the
      // engine asks for the tool in a conversation made since it does; not for one from before,
      // nor through the coding agents' bridge).
      const found = own ?? root?.place ?? null;
      if (watchWentUnasked(found?.data.permissions, found ? onBridge(found, bridge) : viaBridge)) return refused(WATCH_AS_COMMAND);
      const every = given("every"), check = given("check"), note = given("note"), summary = given("summary");
      if (!every || !check || !note) return refused("Give how often (every), the check (a shell command) and a note for when it changes.");
      verb = ["watch", every, check, ...(summary ? ["--summary", summary] : []), note];
      break;
    }
    case "list_wake_ups":
      verb = ["list"];
      break;
    case "cancel_wake_up": {
      const id = given("id");
      if (!id) return refused("Say which one (id), from list_wake_ups.");
      verb = ["cancel", id];
      break;
    }
  }
  // Its folder: a bot's own, or the session's in the wake-ups folder, made with its first wake-up
  // or watch as the routes make it.
  const folder = bot?.folder ?? path.join(SESSION_WAKES, owner);
  let exists = fs.existsSync(path.join(folder, bot ? "bot.json" : "session"));
  if (!exists && name === "cancel_wake_up") return refused(`No wake-up "${given("id")}". See list_wake_ups.`);
  if (!exists && (name === "schedule_wake_up" || name === "watch_for_change")) {
    try {
      exists = (await wakeFolderFor(owner, readEngine, readBridge)) !== null;
    } catch (error) {
      return refused(`Couldn't keep it: ${(error as Error | null)?.message ?? error}`);
    }
    if (!exists) return refused("Kuvo Code doesn't know this conversation yet. Try again in a moment.");
  }
  if (exists && isMoving(folder)) return refused(MOVING);
  const directory = root?.place.data.location?.directory ?? root?.place.data.directory;
  const cwd = directory && fs.existsSync(directory) ? directory : os.homedir();
  const env: NodeJS.ProcessEnv = { ...process.env, KUVO_BOTS: BOTS, KUVO_WAKES: SESSION_WAKES, KUVO_WAKE_TOOL: "1" };
  if (viaBridge) env.KUVO_WAKE_VIA = "bridge";
  else delete env.KUVO_WAKE_VIA;
  // (Never as the box's own conversation, nor in a sandbox's folder: it's named.)
  delete env.OPENCODE_SESSION_ID;
  delete env.KUVO_WAKE_FOLDER;
  const answer = await new Promise<Said>(resolve => {
    execFile(WAKE_COMMAND, [bot?.folder ?? owner, ...verb], { cwd, env, encoding: "utf8", timeout: 30_000 }, (error, out, errors) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return resolve(refused(`Couldn't run kuvo-wake here: there's none at ${WAKE_COMMAND}.`));
      const text = (String(out ?? "") + String(errors ?? "")).trim();
      resolve({ text: text || (error ? "That didn't work." : "Done."), isError: Boolean(error) });
    });
  });
  if (name !== "list_wake_ups") wakesChanged();
  return answer;
}

/** set_job: a bot keeping its job, in its record, as Edit Bot changes it (`PATCH kuvo/bots/<id>`
 * with `job`), for the bot whose conversation this is (a subagent's, the one that started it). */
export async function setJobTool(args: Record<string, unknown>, calling: Calling, readEngine: () => Target, bridge: () => Target | null): Promise<Said> {
  if (!calling.session) return refused("This needs a conversation of its own.");
  const bot = botOf(calling.root?.session ?? calling.session);
  if (!bot) return refused("Only a bot keeps a job, and this conversation isn't one.");
  const clear = args.clear === true;
  const line = args.summary ?? args.job;
  if (!clear && (typeof line !== "string" || !line.trim() || typeof args.details !== "string")) return refused("Provide a non-empty summary and details, or clear: true to clear your job.");
  const job = clear ? { line: "", details: "" } : { line: line as string, details: args.details as string };
  const { status, value } = await changeBot(bot.id, { job }, readEngine, bridge);
  if (status !== 200) return refused("message" in value && value.message ? value.message : `Couldn't keep it (${status}).`);
  const kept = "bot" in value ? value.bot?.job : undefined;
  if (typeof kept !== "string") return refused("The box returned an unreadable job response. Check the job before trying again.");
  return said(kept ? `Kept. Kuvo Code shows "${kept}" under your name.` : "Kept: you have no job now.");
}

/** The tools that show something in the conversation or beside it, by name. */
export const SHOW_TOOLS = ["show_in_panel", "show_file", "mark_final", "show_widget"] as const;
export type ShowToolName = (typeof SHOW_TOOLS)[number];

// A full path as given: from the root, with no "." or ".." in it.
const isFullPath = (given: string) => given.startsWith("/") && !given.split("/").some(part => part === "." || part === "..");
const home = (given: string) => given.replace(/^~(?=$|\/)/, os.homedir());

/** What show_in_panel's answer says when it goes ahead: shown now, kept until the user comes back
 * to the conversation, or (`inView` unknown, where no client said) sent. The words begin as
 * clients read them (`Shown: `, `Kept for later: `, `Sent: `, then "the folder" or "the file"). */
export function shownWords(full: string, isFolder: boolean, inView: boolean | undefined): string {
  const what = `the ${isFolder ? "folder" : "file"} ${full}`;
  if (inView === true) return `Shown: ${what} is open in Kuvo Code's side panel, beside this conversation.`;
  if (inView === false) return `Kept for later: ${what} opens in Kuvo Code's side panel when the user comes back to this conversation. They're in another one right now, so don't say it's open.`;
  return `Sent: ${what} opens in Kuvo Code's side panel beside this conversation, at once if the user is looking at it, or else when they come back to it.`;
}

/** A show tool's call: whether what it names is there to show. Clients show it from the call once
 * it goes ahead (the side panel, the transcript, the record of what was made). `inView`: whether the
 * user is looking at the conversation now, where the client passing the call on can tell. */
export function showTool(name: ShowToolName, args: Record<string, unknown>, calling: Calling, inView: boolean | undefined): Said {
  const raw = typeof args.path === "string" ? args.path : "";
  const kind = (full: string): "file" | "folder" | null => {
    try {
      return fs.statSync(full).isDirectory() ? "folder" : "file";
    } catch {
      return null;
    }
  };
  switch (name) {
    case "show_widget":
      if (typeof args.html !== "string" || !args.html.trim()) return refused("Missing html.");
      return said("Shown in the conversation, live. The user sees it now; what they click in it that calls kuvo.send comes to you as their message.");
    case "show_in_panel": {
      if (!raw) return refused("Missing path.");
      // A relative one is in the folder the conversation works in. A full path is taken as given
      // (resolving would take /private off /private/var/…, where projects in the temporary folder
      // are, and call the agent's own path wrong); a folder's may end in "/".
      const trimmed = (given: string) => given.replace(/\/+$/, "") || "/";
      const expanded = trimmed(home(raw));
      const place = calling.own ?? calling.root?.place;
      const base = place?.data.location?.directory ?? place?.data.directory ?? os.homedir();
      const full = isFullPath(expanded) ? expanded : path.resolve(base, expanded);
      if (full !== trimmed(raw)) return refused(`Give the full path: ${full}`);
      const found = kind(full);
      if (!found) return refused(`There's nothing at ${full}.`);
      return said(shownWords(full, found === "folder", inView));
    }
    case "show_file": {
      if (!raw) return refused("Missing path.");
      // As given, which is what the conversation shows it from: a full path, nothing to expand.
      if (!isFullPath(raw)) return refused("Give the file's full path" + (raw.startsWith("~") ? `: ${home(raw)}` : "."));
      const found = kind(raw);
      if (!found) return refused(`There's nothing at ${raw}.`);
      if (found === "folder") return refused(`${raw} is a folder: show a file in it, or the folder with show_in_panel.`);
      return said(`Shown in the conversation: the file ${raw}. The user sees it there, on their Mac and their phone.`);
    }
    case "mark_final":
      // Pinned by the box's record of what was made, from the call.
      if (!raw || !isFullPath(raw)) return refused("Give the file's full path.");
      if (kind(raw) !== "file") return refused(`There's no file at ${raw}.`);
      return said(`Marked final: ${raw}. It's kept at the top of what you made, for the user.`);
  }
}
