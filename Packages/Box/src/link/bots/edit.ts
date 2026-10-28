// A bot here changed or deleted, as Edit Bot and Delete Bot… do on the Mac.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName, stamp } from "../../shared/text";
import { carryToAgents } from "../areas/carry";
import { askGroups } from "../areas/groups";
import { call } from "../engine/client";
import { textOf } from "../files";
import { BOTS, HERE, IS_MAC, K, RUN } from "../home";
import { hostTrash } from "../host-interface";
import { botVariable, deleteKey, keyNames } from "../keys";
import { botPersonalities } from "../personalities/library";
import { BOT_STEP, botHere, botLook, botModel, isModel, isMoving, MOVING, noteBotsChanged, sameModel } from "./here";
import { givenJob, jobOf, writeJob } from "./jobs";
import { NO_KIT, readKit, runsWithAgents } from "./kit";
import { listBots } from "./list";
import { fitsLook, signInRefusal } from "./make";
import { tellBot, toldNow } from "./tell";
import type { Target } from "../../shared/records";
import type { BotLook } from "../../shared/routes/bots";
import type { ChangedBot } from "../../shared/routes/bots";
import type { JSONAnswer, OtherStatus } from "../server/context";
import type { Job } from "./jobs";
import type { GivenBot } from "./make";

/** A change to a bot, as Edit Bot sends it (`PATCH kuvo/bots/<id>`): its name, look, personality,
 * job or model, each checked here (`personality` null for none). */
export type BotChange = Pick<GivenBot, "name" | "look" | "personality" | "job" | "model">;

/** What `changeBot` answers: the bot as it is after the change, or why not. */
export type ChangedAnswer = JSONAnswer<ChangedBot | { message: string }>;

/** What `deleteBot` answers: nothing once it's gone, or why not. */
export type DeletedAnswer = JSONAnswer<Record<string, never> | { message: string }>;

/** The group chats here as the coding agents' bridge lists them (`GET /api/kuvo/groups`,
 * src/agents/groups/routes.ts), as far as a bot deleted reads them: each chat's id and its bots. */
interface BridgeGroups {
  version?: number;
  data: { group: { id: string; members: string[]; [more: string]: unknown }; [more: string]: unknown }[];
}

// `PATCH kuvo/bots/<id>`, as the Mac's: a bot that lives here changed as Edit Bot changes it (its
// name, look, personality or model), in its description and in its conversation, which is told as
// the Mac tells it: the kit's words, with its job as its memory has it now. The Mac takes the
// change in as it next connects (Bots.takeIn).
export async function changeBot(id: string, given: BotChange | null | undefined, readEngine: () => Target, readBridge: () => Target | null, machine?: string, signal?: AbortSignal): Promise<ChangedAnswer> {
  const no = (status: OtherStatus, message: string): ChangedAnswer => ({ status, value: { message } });
  const here = botHere(id);
  if (!here) return no(404, "That bot isn’t there any more.");
  if (isMoving(here.folder)) return no(409, MOVING);
  const kit = readKit();
  if (!kit) return no(409, NO_KIT);
  if (!isObject(given)) return no(400, "That isn’t a change to a bot.");
  const { described } = here;
  const changed = { ...described };
  if ("name" in given) {
    changed.name = plainName(given.name);
    if (!changed.name) return no(400, "A bot needs a name.");
  }
  if ("look" in given) {
    if (!fitsLook(kit.looks, given.look)) return no(400, "That isn’t a look a bot can have.");
    changed.look = botLook(given.look);
  }
  const personalities = botPersonalities(kit);
  if ("personality" in given) {
    if (given.personality === null) delete changed.personality;
    else if (personalities.some(each => each.id === given.personality)) changed.personality = given.personality as string;
    else return no(400, `There’s no personality “${given.personality}”.`);
  }
  let job: Job | undefined;
  if ("job" in given) {
    const checked = givenJob(given.job);
    if (checked.error) return no(400, checked.error);
    job = checked.job;
  }
  if ("model" in given) {
    if (!isModel(given.model)) return no(400, "That isn’t a model.");
    const model = botModel(given.model);
    // The one it has is kept, whatever; another has to run where its conversation does.
    if (!sameModel(model, described.model)) {
      if (runsWithAgents(model)) {
        // Its conversation goes on with the coding agents, as it does on a Mac.
        if (!here.agents) {
          let agents: Target | null = null;
          try { agents = readBridge(); } catch {}
          const carried = await carryToAgents(here.session, model, readEngine, agents, signal);
          if (carried.status !== 200) return carried;
          Object.assign(here, botHere(id) ?? {});
        }
      } else {
        let engine: Target | undefined;
        try {
          engine = readEngine();
        } catch {}
        if (!engine) return no(503, "The engine isn’t running.");
        const refused = await signInRefusal(model, engine, signal);
        if (refused) return no(422, refused);
      }
    }
    changed.model = model;
  }
  let target: Target | null | undefined;
  try {
    target = here.agents ? readBridge() : readEngine();
  } catch {}
  if (!target) return no(503, here.agents ? `The coding agents aren’t running on ${HERE}.` : "The engine isn’t running.");
  const renamed = changed.name !== described.name;
  const was = jobOf(here);
  const newJob = job !== undefined && (job.line !== was.line || job.details !== was.details);
  const retold = renamed || changed.personality !== described.personality || newJob;
  const switched = !sameModel(changed.model, described.model);
  const looks = (["color", "shape", "face"] as const).some(part => (changed.look as BotLook | undefined)?.[part] !== (described.look as BotLook | undefined)?.[part]);
  if (retold || switched || looks) {
    // (Its job isn't an edit of its description's: the bot keeps it, and Edit Bot can too.)
    if (renamed || switched || looks || changed.personality !== described.personality) changed.updated = stamp();
    try {
      if (newJob) {
        writeJob(here, job!);
        changed.job = job!.line;
      }
      const file = path.join(here.folder, "bot.json");
      fs.writeFileSync(`${file}.new`, JSON.stringify(changed, null, 2));
      fs.renameSync(`${file}.new`, file);
      here.described = changed;
    } catch (error) {
      return no(503, `The bot couldn’t be changed: ${(error as Error | null)?.message ?? error}`);
    }
    // Its conversation hears of a new name, personality or model, as from Edit Bot.
    const session = encodeURIComponent(here.session);
    if (renamed) await call(target, "PATCH", `/api/session/${session}`, { title: changed.name }, signal).catch(() => {});
    if (switched && changed.model) await call(target, "POST", `/api/session/${session}/model`, { model: changed.model }, signal).catch(() => {});
    if (retold) await tellBot(target, here, here.session, toldNow(kit, here, changed), signal);
    noteBotsChanged();
  }
  return { status: 200, value: { bot: listBots(machine).find(each => each.id === id) ?? null } satisfies ChangedBot };
}

// Bots deleted here whose keys of their own are still to go (`run/bot-keys-left.json`): where the
// keys couldn't be reached as one was deleted (this Mac's app not answering), they go the next time
// they can be, as the box starts or another bot is deleted.
const KEYS_LEFT_FILE = path.join(RUN, "bot-keys-left.json");
function keysLeft(): string[] {
  try {
    const listed = JSON.parse(textOf(KEYS_LEFT_FILE) ?? "");
    return Array.isArray(listed?.bots) ? listed.bots.filter((each: unknown) => typeof each === "string" && /^bot_[A-Za-z0-9]+$/.test(each)) : [];
  } catch {
    return [];
  }
}
function noteKeysLeft(id: string, left: boolean): void {
  const bots = keysLeft().filter(each => each !== id);
  if (left) bots.push(id);
  try {
    fs.mkdirSync(RUN, { recursive: true });
    if (!bots.length) return fs.rmSync(KEYS_LEFT_FILE, { force: true });
    fs.writeFileSync(`${KEYS_LEFT_FILE}.new`, JSON.stringify({ bots }));
    fs.renameSync(`${KEYS_LEFT_FILE}.new`, KEYS_LEFT_FILE);
  } catch {}
}
export async function forgetLeftKeys(): Promise<void> {
  for (const id of keysLeft()) {
    if (botHere(id)) {
      // Here again (a move brought it back): its keys are its own.
      noteKeysLeft(id, false);
      continue;
    }
    try {
      for (const name of await keyNames({ suffix: botVariable("", id) })) await deleteKey(name);
      noteKeysLeft(id, false);
    } catch {}
  }
}

// COMPAT(beta.1 deleted-bots): `bots/deleted.json`, for a Mac of 0.8.0-beta.1 or earlier. Goes when 0.8.0 ships.
// The bots deleted here, the latest first (the last 500), for the Mac to let go of as it next
// connects: `{"deleted": [<bot id>…]}` (Bots.deletedFile).
const DELETED_FILE = path.join(BOTS, "deleted.json");

function noteDeleted(id: string): void {
  let kept: string[] = [];
  try {
    const listed = JSON.parse(textOf(DELETED_FILE) ?? "");
    if (Array.isArray(listed?.deleted)) kept = listed.deleted.filter((each: unknown) => typeof each === "string" && each !== id);
  } catch {}
  fs.mkdirSync(BOTS, { recursive: true });
  fs.writeFileSync(`${DELETED_FILE}.new`, JSON.stringify({ deleted: [id, ...kept].slice(0, 500) }));
  fs.renameSync(`${DELETED_FILE}.new`, DELETED_FILE);
}

// `DELETE kuvo/bots/<id>`, as the Mac's Delete Bot…: a bot that lives here goes, its folder (its
// memory, wake-ups and what it made) to Kuvo Code's trash here, then its keys of its own, its
// place in the group chats here and its conversation. It's noted for the Mac (`noteDeleted`) first,
// so it lets the bot go too. Once its folder has gone, the rest is done whatever becomes of the
// phone's request.
export async function deleteBot(id: string, readEngine: () => Target, readBridge: () => Target | null): Promise<DeletedAnswer> {
  const no = (status: OtherStatus, message: string): DeletedAnswer => ({ status, value: { message } });
  const here = botHere(id);
  if (!here) return no(404, "That bot isn’t there any more.");
  if (isMoving(here.folder)) return no(409, MOVING);
  let trashed: string;
  try {
    // For a Mac to let go of it as it next connects (this Mac's own box needs no note).
    if (!IS_MAC) noteDeleted(id);
    // To the trash as the Mac sends one there: a folder by when, and this process.
    const now = new Date();
    const two = (number: number) => String(number).padStart(2, "0");
    const when = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    const trash = path.join(K, "trash", `${when}-${process.pid}`);
    fs.mkdirSync(trash, { recursive: true });
    trashed = path.join(trash, id);
    fs.renameSync(here.folder, trashed);
  } catch (error) {
    return no(503, `The bot couldn’t be deleted: ${(error as Error | null)?.message ?? error}`);
  }
  // On this Mac, on to the Finder's Trash, where you look for what you deleted, and the folder that
  // held it here goes once it's empty.
  if (IS_MAC) {
    await hostTrash(trashed).catch(() => {});
    if (!fs.existsSync(trashed)) try { fs.rmdirSync(path.dirname(trashed)); } catch {}
  }
  // Its keys of its own (`KUVO_KEY_…__<ID>`). Where they can't be reached now (this Mac's app not
  // answering), the bot is deleted all the same, and its keys go once they can be.
  noteKeysLeft(id, true);
  await forgetLeftKeys();
  let agents: Target | null | undefined;
  try {
    agents = readBridge();
  } catch {}
  // Its group chats here go on without it, as the Mac's leave it. (Gone from its folder, it's
  // deleted whole, whatever becomes of the phone's request.)
  if (agents) {
    const listed = await askGroups<BridgeGroups>(agents, "GET", "", undefined, AbortSignal.timeout(BOT_STEP)).catch(() => null);
    for (const chat of listed?.status === 200 && Array.isArray(listed.value?.data) ? listed.value.data : []) {
      const members = chat?.group?.members;
      if (!Array.isArray(members) || !members.includes(id)) continue;
      await askGroups(agents, "PATCH", `/${encodeURIComponent(chat.group.id)}`, { members: members.filter(member => member !== id) }, AbortSignal.timeout(BOT_STEP)).catch(() => {});
    }
  }
  let target: Target | null | undefined;
  try {
    target = here.agents ? agents : readEngine();
  } catch {}
  if (target) await call(target, "DELETE", `/api/session/${encodeURIComponent(here.session)}`, undefined, AbortSignal.timeout(BOT_STEP)).catch(() => {});
  noteBotsChanged();
  return { status: 200, value: {} };
}