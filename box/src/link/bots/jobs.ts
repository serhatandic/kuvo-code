// A bot's job, kept in its folder (`job.json`): `{line, details}`, what it does in a few words (what
// shows under its name) and all of it, which the bot sets with its set_job tool and Edit Bot can
// change (`PATCH kuvo/bots/<id>` with `job`). Its memory is its own to write as it likes.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName, stamp } from "../../shared/text";
import { listOf, textOf } from "../files";
import { BOTS, IS_MAC } from "../home";
import { botHere, type BotHere, changeDescription, isMoving } from "./here";

const JOB_FILE = "job.json";
const MOST_JOB_LINE = 200, MOST_JOB_DETAILS = 8000;

/** A bot's job: what it does in a few words (`line`, what shows under its name), and all of it. */
export interface Job {
  line: string;
  details: string;
}

function readJob(folder: string): Job | null {
  try {
    const kept: unknown = JSON.parse(textOf(path.join(folder, JOB_FILE)) ?? "");
    return isObject(kept) ? { line: typeof kept.line === "string" ? kept.line : "", details: typeof kept.details === "string" ? kept.details : "" } : null;
  } catch {
    return null;
  }
}

export function writeJob(here: BotHere, job: Job): void {
  const file = path.join(here.folder, JOB_FILE);
  fs.writeFileSync(`${file}.new`, JSON.stringify({ line: job.line, details: job.details, updated: stamp() }, null, 2));
  fs.renameSync(`${file}.new`, file);
  // COMPAT(0.7 bot-json-job): the job's line in `bot.json` too, where an older Mac reads it. Goes 3 months after 0.8.0.
  // Its description says it in a few words too, for what reads only that (a Mac of an earlier version).
  // (Onto it as it is now, under its lock: what another change saved is kept.)
  if ((here.described.job ?? "") !== job.line) here.described = changeDescription(here.folder, now => ({ ...(now ?? here.described), job: job.line }));
}

// A bot's job. One from before bots kept it here is taken once from where it was: its memory's
// Job section, as bots kept it, which stays in its memory as it is; or, without one, what Edit Bot
// wrote before memories kept jobs (in the app's list, `bots.json`, for one of this Mac's; in its
// description, for a machine's).
export function jobOf(here: BotHere): Job {
  const kept = readJob(here.folder);
  if (kept) return kept;
  const memory = jobInMemory(textOf(path.join(here.folder, "MEMORY.md")) ?? "");
  // Without one in its memory, what its description said (a Mac kept a job Edit Bot gave it there).
  let job: Job = memory ? { line: memory.line, details: detailsBeyond(memory.line, memory.section) } : { line: plainName(here.described.job ?? ""), details: "" };
  if (IS_MAC && !memory) {
    const listed = macListed().find(each => each?.id === here.described.id);
    if (listed && listed.jobInMemory !== true) job = { line: plainName(listed.job ?? ""), details: detailsBeyond(plainName(listed.job ?? ""), listed.instructions) };
  }
  // Not while it moves: its folder is the move's until it's there.
  if (!isMoving(here.folder)) try { writeJob(here, job); } catch {}
  return job;
}

/** A bot as this Mac's app lists it (`bots.json`), as far as a job from before reads it. */
interface ListedBot {
  id?: string;
  job?: string;
  instructions?: string;
  /** Its job kept in its memory already (the app's, since memories kept jobs). */
  jobInMemory?: boolean;
}

// This Mac's app's list of its bots (`bots.json`, beside their folders), for a job from before:
// read only for a bot whose job isn't kept yet, once each.
function macListed(): (ListedBot | null)[] {
  try {
    const listed = JSON.parse(textOf(path.join(path.dirname(BOTS), "bots.json")) ?? "[]");
    return Array.isArray(listed) ? listed : [];
  } catch {
    return [];
  }
}

// Every bot's job kept in its folder, for one from before (as the box starts): what reads a bot's
// folder without asking the box (the coding agents' bridge, for group chats) finds it there.
export function keepJobs(): void {
  for (const id of listOf(BOTS)) {
    const here = botHere(id);
    if (here) jobOf(here);
  }
}

/** A job as `givenJob` takes it: the job, or why it can't be. */
export type GivenJob = { job: Job; error?: undefined } | { error: string; job?: undefined };

// A job as a bot or Edit Bot gives it: its line on one line, as it shows under the bot's name
// (Bots' `jobLine`), and its details as they are. An error's words for one that can't be.
export function givenJob(given: unknown): GivenJob {
  if (!isObject(given) || typeof given.line !== "string" || (given.details !== undefined && typeof given.details !== "string")) {
    return { error: "A job is {line, details}: what it does in a few words, and the details." };
  }
  const line = jobLine(plainName(given.line ?? ""));
  const details = trimmed(given.details ?? "");
  if (!line && (given.line !== "" || details)) return { error: "Provide a non-empty job line, or explicitly clear the job." };
  if ([...line].length > MOST_JOB_LINE) return { error: "Say what it does in a few words: that line is too long." };
  if ([...details].length > MOST_JOB_DETAILS) return { error: "That job is too long to keep: shorten its details." };
  return { job: { line, details } };
}

// A bot's job as its memory kept it before bots kept it in a record (Bots.job(inMemory:), held to
// `test/agents/box-vectors.json`), for taking it from there once (`jobOf`): its line, what shows
// under its name, and its section, all of it; null for a memory without one.
const spaces = (text: string) => text.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
const trimmed = (text: string) => text.replace(/^[\p{Z}\t\n\v\f\r\u0085]+|[\p{Z}\t\n\v\f\r\u0085]+$/gu, "");
function headingLevel(line: string): number | undefined {
  const text = spaces(line);
  let marks = 0;
  while (marks < text.length && text[marks] === "#") marks++;
  if (marks < 1 || marks > 6) return undefined;
  const after = text.slice(marks);
  return after.length === 0 || after[0] === " " ? marks : undefined;
}
function isJobHeading(line: string): boolean {
  const text = spaces(line);
  if (!text.startsWith("#")) return false;
  const title = spaces(text.replace(/^#+/, "")).toLowerCase();
  if (title === "job" || title === "my job" || title === "the job" || title.startsWith("job:")) return true;
  if (!title.startsWith("job ")) return false;
  const first = spaces(title.slice(4))[0];
  return first !== undefined && "-–—:(".includes(first);
}
// What a job heading says after "Job" ("Job: …", "Job — …", "Job (…)"), and whether after a colon.
function jobInHeading(line: string): { text: string; isColon: boolean } | undefined {
  const title = spaces(spaces(line).replace(/^#+/, ""));
  if (!title.toLowerCase().startsWith("job")) return undefined;
  let rest = spaces(title.slice(3));
  const mark = rest[0];
  if (mark === undefined || !":-–—(".includes(mark)) return undefined;
  rest = spaces(rest.slice(1));
  if (mark === "(" && rest.endsWith(")")) rest = spaces(rest.slice(0, -1));
  return rest.length === 0 ? undefined : { text: rest, isColon: mark === ":" };
}
/** A job as a memory kept it: its line, and its section, all of it. */
export interface MemoryJob {
  line: string;
  section: string;
}

export function jobInMemory(text: string): MemoryJob | null {
  const all = text.split("\n");
  const start = all.findIndex(isJobHeading);
  if (start < 0) return null;
  const level = headingLevel(all[start]) ?? 1;
  let end = all.length;
  let inCode = false;
  for (let index = start + 1; index < all.length; index++) {
    const line = spaces(all[index]);
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inCode = !inCode;
      continue;
    }
    const other = inCode ? undefined : headingLevel(all[index]);
    if (other !== undefined && other <= level) {
      end = index;
      break;
    }
  }
  let section = trimmed(all.slice(start + 1, end).join("\n"));
  const inline = jobInHeading(all[start]);
  if (inline && (inline.isColon || section.length === 0)) section = [inline.text, section].filter(part => part.length > 0).join("\n");
  return { line: jobLine(section.split("\n").map(spaces).find(part => part.length > 0) ?? ""), section };
}

// A job's line as it shows under a bot's name: no list mark, bold or "Job:", its first sentence when
// it goes on, without the sentence's end ("Keeps the build green.").
export function jobLine(text: string): string {
  let line = spaces(text);
  for (const mark of ["- ", "* ", "> "]) if (line.startsWith(mark)) line = line.slice(mark.length);
  line = line.replaceAll("**", "").replaceAll("__", "");
  if (line.toLowerCase().startsWith("job:")) line = line.slice(4);
  line = spaces(line);
  // Long: its first sentence. (In characters as Swift counts them, what you'd see.)
  if ([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)].length > 48 && line.includes(". ")) line = line.slice(0, line.indexOf(". "));
  if (line.endsWith(".") && !line.endsWith("..")) line = line.slice(0, -1);
  return line;
}

// A bot's job as the first message to it, for your composer (BotTemplate.firstMessage): what it does
// in a few words, then how, then to start. Details that begin with the job's line say it once. ""
// for no job at all.
export function firstMessageOf(line: unknown, details: unknown): string {
  const job = trimmed(String(line ?? ""));
  const rest = detailsBeyond(job, details);
  if (!job && !rest) return "";
  return [job ? `Your job, in a few words: ${job}.` : "", rest,
    "Start now: ask me for anything you need first, do the first round, and if it repeats or keeps an eye on something, set that up."]
    .filter(part => part.length > 0).join("\n\n");
}

// A job's details without its line, for details that begin with it (as a memory's Job section did,
// and a template's or shared bot's job does): said once. A first line that goes on after the job's
// sentence keeps the rest.
function detailsBeyond(job: string, details: unknown): string {
  const lines = trimmed(String(details ?? "")).split("\n");
  if (!job || !lines.length || jobLine(lines[0]) !== job) return lines.join("\n");
  const first = lines[0];
  const end = first.indexOf(". ");
  if (end >= 0 && spaces(first.slice(end + 2)) && jobLine(first.slice(0, end)) === job) lines[0] = spaces(first.slice(end + 2));
  else lines.shift();
  return trimmed(lines.join("\n"));
}