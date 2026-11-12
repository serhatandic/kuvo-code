// New bots made here (`POST kuvo/bots`), as New Bot makes them on the Mac.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import type { Fields } from "../../shared/json";
import { withNotes } from "../../shared/session-notes";
import { newID, plainName, stamp } from "../../shared/text";
import { settleAgain } from "../areas/approval";
import { boxProjects } from "../areas/projects";
import { call } from "../engine/client";
import { rewriteOn } from "../engine/notes";
import { BOTS, HERE, IS_MAC } from "../home";
import { botPersonalities } from "../personalities/library";
import { BOT_STEP, botLook, botModel, DESCRIPTION, isModel, noteBotsChanged } from "./here";
import { firstMessageOf } from "./jobs";
import { botInstructions, NO_KIT, readKit, runsWithAgents } from "./kit";
import { listBots } from "./list";
import { noteTold, toldDigest } from "./tell";
import { approvalOf, approvalRules } from "../work/approval";
import { usableModels } from "../work/models";
import type { Target } from "../../shared/records";
import type { BotLook, BotModel } from "../../shared/routes/bots";
import type { MadeBot } from "../../shared/routes/bots";
import type { JSONAnswer, OtherStatus } from "../server/context";
import type { BotDescription } from "./here";
import type { BotLooks, BotTemplate } from "./kit";

/** A bot to make, as New Bot sends it (`POST kuvo/bots`): its name, and the template, job,
 * personality, project, look and model it's made with, each whatever the client sent until it's
 * checked here. */
export interface GivenBot {
  name?: unknown;
  /** Where it lives: `mac`, or a machine's name (a Mac's box makes only its own). */
  machine?: unknown;
  /** A template's id, or null for none. */
  template?: unknown;
  /** A shared bot's job (File › Import Bot…): its line and all of it. */
  job?: unknown;
  /** A personality's id, or null for the template's. */
  personality?: unknown;
  /** One of its projects' folders, or null for its own workspace. */
  project?: unknown;
  /** A look (BotLook), or null for the template's or one picked. */
  look?: unknown;
  /** A model (BotModel), or null for the template's or the kit's. */
  model?: unknown;
  /** The client's own id for this New Bot, the same each time it sends it again (`MADE_FOR`). */
  request?: unknown;
}

/** What `makeBot` answers: the bot made and its job for your composer, or why not. */
export type MadeAnswer = JSONAnswer<MadeBot | { message: string }>;

// (Its parts read as whatever they are, once it's something, and checked against the kit's.)
export const fitsLook = (looks: BotLooks, look: unknown): look is BotLook => Boolean(look) && (looks.colors as unknown[]).includes((look as Fields<"color">).color) && (looks.shapes as unknown[]).includes((look as Fields<"shape">).shape) && (looks.faces as unknown[]).includes((look as Fields<"face">).face);

// Why a model of the engine's can't run here: its account isn't signed in here, and the engine
// would drop a message on it without a word; null when it can (or the engine doesn't say).
export async function signInRefusal(model: BotModel, engine: Target, signal?: AbortSignal): Promise<string | null> {
  const ready = await call(engine, "GET", "/api/provider", undefined, signal).catch(() => undefined);
  const ids = Array.isArray(ready) ? (ready as (Fields<"id"> | null)[]).map(each => each?.id) : [];
  return ids.length && !ids.includes(model.providerID) ? `${model.id} needs a sign-in on ${HERE}: sign in to it in Settings › Accounts, or choose another model.` : null;
}

// The model a new bot starts on here, as New Bot offers it: the one its Mac named (the model picked
// last there) while this box can use it (its account signed in here, and not one being retired); else
// the engine's default, or the first model this box can use. As the Mac named it when the engine
// can't say (or doesn't answer in time), and a coding agent's (the bridge says for itself whether it
// can run it).
export async function startingModelHere(named: BotModel | null, readEngine: () => Target, signal?: AbortSignal): Promise<BotModel | null> {
  if (named && runsWithAgents(named)) return named;
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  if (!engine) return named;
  const step = signal ? AbortSignal.any([signal, AbortSignal.timeout(BOT_STEP)]) : AbortSignal.timeout(BOT_STEP);
  const models = (await usableModels(engine, null, step)).filter(model => !model.retiring);
  if (!models.length) return named;
  const usable = (model: Partial<BotModel> | null | undefined) => Boolean(model) && models.some(each => each.id === model?.id && each.providerID === model?.providerID);
  if (usable(named)) return named;
  const fallback = await call(engine, "GET", "/api/model/default", undefined, step).catch(() => null);
  if (isObject(fallback) && usable(fallback as Partial<BotModel>)) return { id: fallback.id as string, providerID: fallback.providerID as string };
  return { id: models[0].id, providerID: models[0].providerID };
}

// `POST kuvo/bots`, as the Mac's: the bot made here, its folder, conversation and instructions,
// and the template's job for your composer, or else its greeting, so it writes first.
// New Bot sent again with the same `request` (the phone's connection dropped, and it tried again,
// while the first was made all the same): answered as the first was, while it's being made and for
// an hour after, rather than made twice. One that wasn't made is tried again.
// It's made whatever becomes of the request that asked (every one sent again waits on it): each step
// has its own time limit, and none goes with the phone's connection.
const REQUEST = /^[A-Za-z0-9_-]{8,64}$/;
const MADE_FOR = 3600_000;
const madeFor = new Map<string, { answer: Promise<MadeAnswer>; at: number }>();

export function makeBot(given: GivenBot | null | undefined, readEngine: () => Target, readBridge: () => Target | null, machine?: string): Promise<MadeAnswer> {
  const request = typeof given?.request === "string" && REQUEST.test(given.request) ? given.request : null;
  if (!request) return makeOnce(given, readEngine, readBridge, machine);
  const now = Date.now();
  for (const [id, made] of madeFor) if (now - made.at > MADE_FOR) madeFor.delete(id);
  const before = madeFor.get(request);
  if (before) return before.answer;
  const answer = makeOnce(given, readEngine, readBridge, machine).then(made => {
    if (made.status === 201) madeFor.set(request, { answer, at: Date.now() });
    else madeFor.delete(request);
    return made;
  });
  madeFor.set(request, { answer, at: now });
  return answer;
}

async function makeOnce(given: GivenBot | null | undefined, readEngine: () => Target, readBridge: () => Target | null, machine?: string): Promise<MadeAnswer> {
  const no = (status: OtherStatus, message: string): MadeAnswer => ({ status, value: { message } });
  const kit = readKit();
  if (!kit) return no(409, NO_KIT);
  if (!given || typeof given !== "object") return no(400, "That isn’t a bot to make.");
  const name = plainName(given.name);
  if (!name) return no(400, "A bot needs a name.");
  // This Mac's box makes this Mac's bots: one for a machine is made on that machine's box.
  if (IS_MAC && given.machine !== undefined && given.machine !== null && given.machine !== "mac") {
    return no(400, `This Mac makes only bots that live on it: make one for “${plainName(given.machine)}” there.`);
  }
  let template: BotTemplate | undefined;
  if (given.template !== undefined && given.template !== null) {
    template = kit.templates.find(each => each.id === given.template);
    if (!template) return no(400, `There’s no template “${given.template}”.`);
  }
  // A shared bot's job (File › Import Bot…): typed in its conversation for you, as a template's is.
  const shared = isObject(given.job) && (typeof given.job.line === "string" || typeof given.job.details === "string")
    ? firstMessageOf(given.job.line, given.job.details) || null
    : null;
  const personalityID = given.personality ?? template?.personality;
  const personality = personalityID ? botPersonalities(kit).find(each => each.id === personalityID) : undefined;
  if (personalityID && !personality) return no(400, `There’s no personality “${personalityID}”.`);
  const project = given.project ?? undefined;
  if (project !== undefined && !boxProjects(kit).some(each => each.directory === project)) return no(400, "That project isn’t in Kuvo Code.");
  const looks = kit.looks;
  const pick = (list: string[]): string => list[crypto.randomInt(list.length)];
  const look = fitsLook(looks, given.look) ? botLook(given.look) : template?.look ?? { color: pick(looks.colors), shape: pick(looks.shapes), face: pick(looks.faces) };
  const model = isModel(given.model) ? botModel(given.model) : await startingModelHere(kit.startingModel ?? null, readEngine);
  if (!model) return no(422, `There’s no model to start it on here: sign in to an account on ${HERE} first.`);
  const agents = runsWithAgents(model);
  let target: Target | null | undefined;
  try {
    target = agents ? readBridge() : readEngine();
  } catch {}
  if (!target) return no(503, agents ? `The coding agents aren’t running on ${HERE}.` : "The engine isn’t running.");
  if (!agents) {
    const refused = await signInRefusal(model, target, AbortSignal.timeout(BOT_STEP));
    if (refused) return no(422, refused);
  }

  const id = newID("bot_");
  const folder = path.join(BOTS, id);
  // (A project is one of its projects' folders, checked above.)
  const directory = (project as string | undefined) ?? path.join(folder, "workspace");
  const discard = () => fs.rmSync(folder, { recursive: true, force: true });
  let session: { id: string } | undefined;
  try {
    fs.mkdirSync(path.join(folder, "workspace"), { recursive: true });
    fs.mkdirSync(path.join(folder, "wakes"), { recursive: true });
    // What Claude Code remembers for it, kept in its own folder (its `autoMemoryDirectory`), so it
    // goes wherever the bot goes, rather than in Claude Code's folder for its workspace. Not for a
    // bot that works in a project: there it's the project's.
    if (!project) fs.mkdirSync(path.join(folder, "memory"), { recursive: true });
    fs.writeFileSync(path.join(folder, "MEMORY.md"), kit.memory.replaceAll("⟦name⟧", name));
    // Its own folder; the rest are made just below for this computer's default approval and its
    // Settings › Permissions.
    const rules = [{ action: "external_directory", resource: path.join(folder, "*"), effect: "allow" }];
    // The session it made, as far as its id.
    const made = await call(target, "POST", "/api/session", { title: name, location: { directory }, model, permissions: rules, metadata: { kuvo: { bot: id } } }, AbortSignal.timeout(BOT_STEP)) as Fields<"id"> | null;
    if (typeof made?.id !== "string" || !made.id) throw new Error("No conversation was made.");
    session = { id: made.id };
    // Marked as a bot's (without it, what it does would be news of an ordinary conversation), and
    // kept with the approval its rules say (Ask First where they ask before commands, else this
    // computer's default, as any new conversation's), its rules made for what that comes to here
    // (Auto asks first where the sandbox doesn't run).
    const kept = approvalOf({ permissions: rules }, { agents, bot: true });
    // (In its turn, onto its notes as they are then.)
    const marked = await rewriteOn(target, session.id, now => ({
      metadata: withNotes(now.metadata, { bot: id, approval: kept.approval, applied: kept.effective }),
      permissions: approvalRules(kept.effective, rules),
    }));
    if (!marked) throw new Error("The conversation it made went.");
    const told = botInstructions(kit, name, folder, personality?.instruction, project as string | undefined);
    await call(target, "PUT", `/api/experimental/session/${encodeURIComponent(session.id)}/instructions/entries/kuvo.bot`, { value: told }, AbortSignal.timeout(BOT_STEP));
    fs.writeFileSync(path.join(folder, "session"), session.id);
    noteTold(folder, { session: session.id, instructions: toldDigest(told), rules: folder });
    fs.writeFileSync(path.join(folder, "directory"), directory);
    // A machine's wake-ups go by your time zone; this Mac's, by its own clock as you change it.
    if (kit.timeZone && !IS_MAC) fs.writeFileSync(path.join(folder, "timezone"), kit.timeZone);
    if (kit.zoneinfo && !IS_MAC) fs.writeFileSync(path.join(folder, "zoneinfo"), Buffer.from(kit.zoneinfo, "base64"));
    if (agents) fs.writeFileSync(path.join(folder, "via"), "bridge");
    const now = stamp();
    const described = { created: now, id, job: "", kuvo: DESCRIPTION, look, model, name, ...(personality ? { personality: personality.id } : {}), ...(project ? { project: project as string } : {}), updated: now } satisfies BotDescription;
    fs.writeFileSync(path.join(folder, "bot.json"), JSON.stringify(described, null, 2));
    // (What it comes to may have changed meanwhile: the sandbox stopped. The box's round would, in a
    // moment.)
    await settleAgain(target, session.id, agents, AbortSignal.timeout(BOT_STEP)).catch(() => {});
  } catch (error) {
    if (session?.id) await call(target, "DELETE", `/api/session/${encodeURIComponent(session.id)}`, undefined, AbortSignal.timeout(BOT_STEP)).catch(() => {});
    discard();
    return no(503, `The bot couldn’t be made: ${(error as Error | null)?.message ?? error}`);
  }
  // Without a template's or a shared bot's job for you to send, it writes first.
  const firstMessage = (template ? firstMessageOf(template.job, template.instructions) || null : null) ?? shared;
  if (!firstMessage) await call(target, "POST", `/api/session/${encodeURIComponent(session.id)}/synthetic`, { text: kit.greeting, description: "A new bot's first message" }, AbortSignal.timeout(BOT_STEP)).catch(() => {});
  noteBotsChanged();
  // (It lists: it was just made.)
  const bot = listBots(machine).find(each => each.id === id)!;
  return { status: 201, value: { bot, firstMessage: firstMessage ?? null } };
}