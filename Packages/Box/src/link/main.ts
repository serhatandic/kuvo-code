// @ts-nocheck
// (Typed modules take its parts out one at a time: Packages/Box/README.md. Until then it's checked
// as it runs, by the bridge's tests.)
// Kuvo Code's link on a machine: lets the phones you've paired reach this machine's engine
// through the relay, so its sessions and bots work from the phone with the Mac closed. The
// engine's own runtime runs it, so the machine needs nothing else:
//
//   BUN_BE_BUN=1 opencode kuvo-link.js run             the bridge, started beside the engine, which
//                                                      also tells your phones what happens in the
//                                                      machine's sessions while no Mac does
//   BUN_BE_BUN=1 opencode kuvo-link.js setup           the Mac's phones and relay, as JSON on stdin
//   BUN_BE_BUN=1 opencode kuvo-link.js pair [relay]    a link to pair a phone with this machine
//   BUN_BE_BUN=1 opencode kuvo-link.js selftest        checks the runtime has what it needs
//
// It keeps its state in ~/.kuvo-code/run/link.json (mode 600), reads the engine's port and
// password from run/engine.json, and connects out to the relay; it never listens. The protocol
// is in PROTOCOL.md beside this file's source (kuvo-ai's Packages/KuvoLink), with the same in
// Swift for the Mac and the phone.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_KINDS } from "../shared/documents";
import { FEATURES } from "../shared/features";
import { isObject, parsed } from "../shared/json";
import { processRuns as runs } from "../shared/platform";
import { sleep } from "../shared/wait";
import { endedProviders, forgetPlan } from "./areas/accounts";
import { applySettings } from "./areas/apply";
import { answerAsk, askAnswer, inConversation, listedAsk, readAsks, watchAsks } from "./areas/asks";
import { answerBotKeys, refreshBotsKeys } from "./areas/bot-keys";
import { answerKeys, setBoxKey } from "./areas/box-keys";
import { carryToAgents } from "./areas/carry";
import { addMacDefaults, changeSettings, ownsSettings, readSettings } from "./areas/config";
import { engineConnect, engineControl, engineDown, loadSignInReturn, stopShell } from "./areas/engine";
import { fileAt } from "./areas/file";
import { listFolders, makeFolder } from "./areas/folders";
import { forwardGroups, GROUP_ROUTE, groupJSON } from "./areas/groups";
import { answerIntegrations, answerOnce, reconnectEverywhere } from "./areas/integrations";
import { addFromCatalog, mcpCatalog } from "./areas/mcp-catalog";
import { searchPlugins } from "./areas/plugins";
import { answerProjects } from "./areas/projects";
import { answerSkills, keepSkillTrashClear } from "./areas/skills";
import { allWakes, answerWakes, holdArchived, listWakes, sendWakes, wakeFollowers } from "./areas/wakes";
import { readWorktrees, worktreeFollowers } from "./areas/worktree-records";
import { answerWorktrees, worktreesWhere } from "./areas/worktrees";
import { changeBot, deleteBot, forgetLeftKeys } from "./bots/edit";
import { botFollowers } from "./bots/here";
import { keepJobs } from "./bots/jobs";
import { botTemplates, forgetOldKit, NO_KIT, readKit } from "./bots/kit";
import { listBots } from "./bots/list";
import { makeBot } from "./bots/make";
import { freshenBots, settleBot } from "./bots/tell";
import { adoptBox } from "./compat/adopt-settings";
import { forgetPhones, phoneHere } from "./compat/leave-running";
import { addressOf, EMPTY, newKey, publicOf } from "./crypto/keys";
import { IKInitiator, IKResponder, openOneWay, PROLOGUE, sealOneWay } from "./crypto/noise";
import { docsNoted, noteDocsChanged, onDocsChanged } from "./documents/changed";
import { docsChanged, macDocsChanged, receiveDocs } from "./documents/exchange";
import { held, newSigningSeed, ownSign, SIGN } from "./documents/format";
import { digestOf, docsWork, macPeersBody, ownDoc, ownDocs, pruneDocs, takeDoc } from "./documents/work";
import { peerTargets, readBridgeFile, readEngineFile } from "./engine/client";
import { watchBox } from "./engine/watch";
import { locked, textOf, writePrivate } from "./files";
import { followed } from "./follow";
import { BOTS, ENGINE_FILE, IS_MAC, K, NEEDED_FILE, PID_FILE, RUN, scriptIs, SESSION_WAKES, VERSION_FILE } from "./home";
import { appHost, forgetHostProof, KeysUnavailable, linkHost, proveHost } from "./host-interface";
import { cutText, LETTER_ID, LETTER_MEMORY, LETTERS_SEEN, SENDING } from "./letters/letter";
import { answered, deliverLeftAnswers, macWaiting, sendOutbox } from "./letters/outbox";
import { lettersSeen } from "./letters/take";
import { attentionGiven, HELD_FILE, NoticeHold } from "./notices/hold";
import { noticeJSON, pushTo } from "./notices/notice";
import { announce, forgetMacsAgents, keepOwn, ownAgents, ownAsLast, refreshOwn } from "./peers/agents";
import { AGENTS_FILE, keptFeatures, PEER_LOCK, readPeerAgents } from "./peers/directory";
import { ADDRESS, cleanMoved, cleanPeer, fitsPeer, forgetOldMacs, KEY, leaveMac, macsOf, mailFor, MOST_PEERS, movedOf, needed, ownKey, peersOf, takeLegacyPeers } from "./peers/known";
import { peerMail, receiveMail } from "./peers/mail";
import { graphemes, nameAgents, namedAgents, namesIn, wordCharacter } from "./peers/naming";
import { watchSeats } from "./peers/seats";
import { changePersonalities, mergePersonalities, MOST_COUNT, PERSONALITIES_FILE, personalitiesDocument, personalityFollowers, readPersonalities } from "./personalities/library";
import { answerPersonalities, retellBots, takePersonalities, takePersonalitiesDocument } from "./personalities/take";
import { authorizePhone, confirmPhone, fits, foldPhones, MOST_KEPT, noLongerNeeded, pairPhone, removeAsMac, removedAlready, removePhones, takeOff } from "./phones";
import { readRelay, relayHello, relaySend } from "./relay/frames";
import { LinkHost } from "./relay/host";
import { agentsAllowed, allowed, canonicalPath, REQUEST_HEADERS, RESPONSE_HEADERS } from "./server/paths";
import { macLink, macSign, onLinkWritten, readLink, updateLink } from "./state";
import { checkDrift, confirmUpdate, isUpdating, noteLauncher, noteOlderMacs, noteUpdate, startUpdate, update, UPDATE_KEYS, updateNight, updatesBlocked, updateState, updateStatus } from "./updates/update";
import { BRIDGE_VERSION } from "./version";

// What moved into modules, as this file exported it (the bridge's tests import it from here).
export { addressOf, newKey, publicOf } from "./crypto/keys";
export { CipherState, IKInitiator, IKResponder, MAIL_PROLOGUE, openOneWay, PROLOGUE, sealOneWay } from "./crypto/noise";
export { decodeMessage, encodeMessage, Frame, frame, pieces, readFrame, readRelay, relayHello, relayPush, relaySend } from "./relay/frames";
export { isSecretName, markingHashes, masked, maskedHexValues, maskedNamed, namesHash, showsAll } from "./notices/mask";
export { docBytes, MOST_DOC, newSigningSeed, ownSign, readDoc, signDoc, signingKeyOf } from "./documents/format";
export { IS_MAC, LINK_FILE } from "./home";
export { BRIDGE_VERSION } from "./version";
export { FEATURES } from "../shared/features";
export { messageID } from "./engine/sessions";
export { macLink, readLink, updateLink, writeLink } from "./state";
export { searchPlugins } from "./areas/plugins";
export { listFolders, makeFolder } from "./areas/folders";
export { endedProviders, forgetPlan, noteSignIn } from "./areas/accounts";
export { answerAsk, askAnswer, askNotice, listedAsk, readAsks, watchAsks } from "./areas/asks";
export { BOT_MEMORY_RULE, addMacDefaults, changeSettings, deepMerged, keysNamedHere, ownsSettings, readSettings } from "./areas/config";
export { addFromCatalog, mcpCatalog } from "./areas/mcp-catalog";
export { adoptBox } from "./compat/adopt-settings";
export { setBoxKey } from "./areas/box-keys";
export { applySettings, translateSettings } from "./areas/apply";
export { NOTICE_LIMIT, noticeJSON, pushTo } from "./notices/notice";
export { LinkHost } from "./relay/host";
export { followed } from "./follow";
export { answerIntegrations, reconnectEverywhere } from "./areas/integrations";
export { allWakes, holdArchived, listWakes, nextWake, readWakes, repeatText, sendWakes, wakeFolder, wakeOf } from "./areas/wakes";
export { readRemovedWorktrees, readWorktrees } from "./areas/worktree-records";
export { answerProjects, boxProjects, changeProjects, readProjects } from "./areas/projects";
export { answerWorktrees, branchSlug, nameWorktreeBranch, tellWorktree, worktreesWhere } from "./areas/worktrees";
export { SKILL_REPOSITORIES, answerSkills, keepSkillTrashClear, skillAbout, skillName, skillTrashEntry, skillsIn } from "./areas/skills";
export { agentsAllowed, allowed, canonicalPath, signInReturn, socketAllowed } from "./server/paths";
export { KEEP_FOR, SEEN_FILE, forgetPhones, phoneSeenLately } from "./compat/leave-running";
export { engineConnect, engineControl, toolRun } from "./areas/engine";
export { botPersonalities, changePersonalities, mergePersonalities, personalitiesDocument, readPersonalities } from "./personalities/library";
export { botVariable } from "./keys";
export { UPDATE_KEYS, boxVersion, checkDrift, confirmUpdate, isUpdating, newerVersion, noteLauncher, noteOlderMacs, startUpdate, update, updateNight, updateStatus, updatesBlocked, verifyBoxes, versionOrder } from "./updates/update";
export { FILE_LIMIT } from "./areas/file";
export { firstMessageOf, jobInMemory, jobLine, keepJobs } from "./bots/jobs";
export { listBots } from "./bots/list";
export { botInstructions, botTemplates, readKit, readWords } from "./bots/kit";
export { freshenBot, freshenBots, refreshedRules, settleBot } from "./bots/tell";
export { makeBot } from "./bots/make";
export { carryToAgents } from "./areas/carry";
export { changeBot, deleteBot, forgetLeftKeys } from "./bots/edit";
export { ASK_HOLD, LONGEST_LEASE, NEWS_HOLD, NoticeHold, RESTORED_WAIT, SHOWN_WITHIN, attentionGiven, holdFor } from "./notices/hold";
export { describeForm, describePermission, groupNotice, noticeFor, projectNameOf, settleHeld } from "./notices/news";
export { STEER_AFTER, steering, watchBox, watchEvents } from "./engine/watch";
export { answerBotKeys, refreshBotsKeys } from "./areas/bot-keys";
export { forgetOldMacs, leaveMac, macsOf, mailFor, movedOf, openMail, peersOf, takeLegacyPeers } from "./peers/known";
export { noteDocsChanged } from "./documents/changed";
export { authorizePhone, confirmPhone, foldPhones, newPairing, noLongerNeeded, pairPhone, removeAsMac, removePhones } from "./phones";
export { changedWork, digestOf, docMails, docsWork, greetWork, ownDoc, takeDoc } from "./documents/work";
export { peerOf, readPeerAgents, takeAgents } from "./peers/directory";
export { composeLetter } from "./letters/letter";
export { composeAgents, nameAgents, namedAgents, namesIn } from "./peers/naming";
export { carrySeat, seatPayloads, seatPeers, takeSeat, tellSeatPeers, watchSeats } from "./peers/seats";
export { announce, ownAgents, refreshOwn, writeAgents } from "./peers/agents";
export { deliverLeftAnswers, letterMail, letterWent, sendOutbox } from "./letters/outbox";
export { takeLetter } from "./letters/take";
export { answerPersonalities, retellBots, takePersonalities, takePersonalitiesDocument } from "./personalities/take";
export { docsChanged, macDocsChanged, receiveDocs } from "./documents/exchange";
export { peerMail, receiveMail } from "./peers/mail";

// This file, for what the box runs again as a command of its own.
scriptIs(fileURLToPath(import.meta.url));

const PAIRING_MINUTES = 10;

// ---- Forwarding to the engine ----

const AGENTS = "kuvo/agents/";

// The block a prompt from a phone ends with, for the agent, in the Mac's words (FromPhone.swift):
// the user is on their iPhone, where a file is shown with show_file. Never shown.
export const FROM_PHONE = ["<from-phone>", "The user sent this from Kuvo Code on their iPhone.", "They read your reply on a small screen, and can't open file paths, links to files on the computer or Kuvo Code's side panel there. Keep your reply short and easy to read on a phone. To show them a file (a picture, a chart, a PDF, a document you made or found), use show_file: it puts the file in this conversation, where they see it. A widget (show_widget) shows there too: keep it narrow, and make it work with taps rather than hovering.", "</from-phone>"].join("\n");

// A prompt's body with the agents its text names with "&" told at its end (`naming(text, session)`),
// as this box lists everyone now; any other body as it is.
async function namedIn(body, session, naming) {
  if (!naming) return body;
  let prompt;
  try { prompt = JSON.parse(Buffer.from(body ?? "").toString()); } catch { return body; }
  if (typeof prompt?.text !== "string" || !prompt.text.includes("&")) return body;
  const text = await naming(prompt.text, session).catch(() => prompt.text);
  return text === prompt.text ? body : Buffer.from(JSON.stringify({ ...prompt, text }));
}

// Who a message from a phone names with "&", for `forward`: everyone as this box lists them now,
// at once, and where it is; its own worked out again meanwhile, and waited for (two seconds at most)
// only when a name after "&" isn't there yet (one made a moment ago). One working out at a time.
let refreshingOwn = null;
const refreshOwnShared = readEngine => (refreshingOwn ??= refreshOwn(readEngine).catch(() => {}).finally(() => { refreshingOwn = null; }));
// That working out, done (what a test waits for before it removes its folders).
export const ownRefreshed = () => refreshingOwn ?? Promise.resolve();
// Everyone, as this box lists them now (`run/agents.json`), and its name there.
function listedAgents() {
  try {
    const read = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
    return { machine: read?.machine ?? null, agents: Array.isArray(read?.agents) ? read.agents : [] };
  } catch {
    return { machine: null, agents: [] };
  }
}
function namingHere(readEngine) {
  return async (text, session) => {
    let everyone = listedAgents();
    const working = refreshOwnShared(readEngine);
    if (nameMissing(text, everyone.agents)) {
      await Promise.race([working, new Promise(resolve => setTimeout(resolve, 2000).unref?.())]);
      everyone = listedAgents();
    }
    return nameAgents(text, { excluding: session, here: everyone.machine, agents: everyone.agents });
  };
}

// Whether `text` names with "&" someone `agents` don't have: an "&" starting a word, with none of
// their names after it, whole ("&Miranda" isn't "&Mira").
// (Its characters as `namesIn` reads them: what's before an "&" is a whole character.)
function nameMissing(text, agents) {
  if (!text.includes("&")) return false;
  const references = agents.map(agent => ({ name: String(agent.name ?? ""), session: agent.session }));
  const named = new Set(namesIn(text, references).map(each => each.lower));
  const characters = graphemes(text);
  for (let i = 0; i < characters.length; i++) {
    const { segment, index } = characters[i];
    if (segment !== "&" || named.has(index)) continue;
    if (wordCharacter.test(characters[i - 1]?.segment ?? "")) continue;
    const next = characters[i + 1]?.segment;
    if (next && !/^\s/u.test(next)) return true;
  }
  return false;
}

// A prompt's body with the block at the end of its text, once; any other body as it is.
export function fromPhone(body) {
  let prompt;
  try {
    prompt = JSON.parse(Buffer.from(body ?? "").toString());
  } catch {
    return body;
  }
  if (typeof prompt?.text !== "string" || prompt.text.trimEnd().endsWith("</from-phone>")) return body;
  return Buffer.from(JSON.stringify({ ...prompt, text: `${prompt.text}\n\n${FROM_PHONE}` }));
}

// Passes `path` to the engine or the agents' bridge on this machine, with its password, and
// streams back what it answers. What's sent is the path as `canonicalPath` writes it, which is
// what `allows` checks.
async function* forward(target, path, request, signal, allows, naming = null, down = engineDown) {
  const method = request.method.toUpperCase();
  const sent = canonicalPath(path);
  if (sent === null || !allows(sent, method)) {
    yield { head: { status: 403, headers: { "content-type": "text/plain" } } };
    yield { body: Buffer.from("That isn't available over the link.") };
    return;
  }
  const url = new URL(`http://127.0.0.1:${target.port}/${sent}`);
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` };
  const given = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of REQUEST_HEADERS) if (given[name]) headers[name] = given[name];
  // A message the phone sends: who it names with "&" (`naming`), and that it's from the phone, go
  // with it.
  const prompt = method === "POST" && /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname);
  // A session's metadata changed: whether it was archived before, as the engine has it (null when
  // it can't say). A phone sends all of it with any change (a pin, say), the flag as it was too.
  const changed = method === "PATCH" && /^\/api\/session\/([^/]+)$/.exec(url.pathname);
  let wasArchived = null;
  if (changed) {
    try {
      const before = await fetch(url, { headers, signal });
      if (before.ok) wasArchived = (await before.json())?.data?.metadata?.["kuvo.archived"] === true;
    } catch {}
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : prompt ? fromPhone(await namedIn(request.body, decodeURIComponent(prompt[1]), naming)) : request.body,
      signal,
    });
  } catch (error) {
    // Not answering (starting again, say): said so, unless the asker went.
    if (signal?.aborted) throw error;
    yield { head: { status: 503, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ message: down() })) };
    return;
  }
  const out = {};
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) out[name] = value;
  }
  // Archived or brought back (`kuvo.archived` in its metadata), here with the Mac closed too: its
  // wake-ups wait, or come back, as a Mac's Archive has it. Only when that changed.
  if (changed && response.ok) {
    let archived;
    try { archived = JSON.parse(Buffer.from(request.body ?? []).toString("utf8"))?.metadata?.["kuvo.archived"]; } catch {}
    if (typeof archived === "boolean" && archived !== wasArchived) try { holdArchived(decodeURIComponent(changed[1]), archived); } catch {}
  }
  yield { head: { status: response.status, headers: out } };
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield { body: Buffer.from(value) };
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// The handler LinkHost runs for each request. `hold`: the running bridge's notices held while
// you're at a computer (none in `box route`, a command of its own).
export function engineHandler(readEngine = readEngineFile, info = {}, readBridge = readBridgeFile, phonesChanged = () => {}, hold = null) {
  // The agents' bridge, while it runs: its record, while the process it names is still it.
  const bridge = () => {
    try {
      const found = readBridge();
      return found?.port && found?.password && runs(found.pid, "kuvo-agents") ? found : null;
    } catch {
      return null;
    }
  };
  return async function* (request, phone, signal) {
    const text = (status, words) => [{ head: { status, headers: { "content-type": "text/plain" } } }, { body: Buffer.from(words) }];
    // A phone using this machine, whatever it asks; not the app beside a Mac's own box.
    if (!request.fromApp) phoneHere();
    // Which route answers, by its path alone: a query string never changes it (as on a Mac).
    const route = request.path.split("?")[0];
    if (route === "kuvo/info") {
      let engine = {};
      try { engine = readEngine(); } catch {}
      // When the engine running now came up, in seconds since 1970 (each start writes its record):
      // a restart changes it.
      let started = null;
      if (engine.pid) try { started = fs.statSync(ENGINE_FILE).mtimeMs / 1000; } catch {}
      // COMPAT(0.7 engine-stop): `stopped`, an engine an older Mac's Stop left down. Goes 3 months after 0.8.0.
      // Whether it runs now, and whether it's stopped on purpose (until it's started, from anywhere).
      const running = Boolean(engine.pid && runs(engine.pid, `${K}/engine/`));
      const stopped = fs.existsSync(path.join(RUN, "stopped"));
      // Its folder of chats (conversations of no project), as a Mac names its own: made if it isn't
      // there yet, so a phone can start the first one.
      const chats = path.join(K, "chats");
      try { fs.mkdirSync(chats, { recursive: true }); } catch {}
      yield { head: { status: 200, headers: { "content-type": "application/json" } } };
      yield { body: Buffer.from(JSON.stringify({ kind: "machine", bridge: BRIDGE_VERSION, engine: engine.version ?? null, started, running, stopped, agents: Boolean(bridge()), chats, features: FEATURES, ...info })) };
      return;
    }
    const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
    if (route === "kuvo/file") return yield* fileAt(request.path, json);
    // This box's updates (PROTOCOL.md, "Updates"): how it stands, Update Now. It always updates
    // by itself: there's no switch.
    if (route === "kuvo/update") {
      const method = request.method.toUpperCase();
      if (method === "GET") return yield* json(200, updateStatus());
      if (method === "POST") {
        if (parsed(request.body)?.now !== true) return yield* json(400, { message: "Say to update now (now)." });
        if (!UPDATE_KEYS.length) return yield* json(409, { message: "Updates aren't set up for this machine yet." });
        const blocked = updatesBlocked();
        if (blocked) return yield* json(409, { message: blocked });
        return yield* (startUpdate({ now: true }) ? json(202, updateStatus()) : json(409, { message: "It's updating already." }));
      }
      return yield* json(405, {});
    }
    // Settings › Integrations (PROTOCOL.md, "Integrations"): this machine's own, added and removed
    // here from the catalog the Mac leaves (`bin/integrations.json`), with the Mac closed too.
    if (/^kuvo\/integrations(\/|\?|$)/.test(request.path)) {
      if (!ownsSettings()) return yield* json(409, { message: "This machine's settings still come from your Mac. Connect it from Kuvo Code on your Mac once." });
      let engine = null;
      try { engine = readEngine(); } catch {}
      const { status, value } = await answerIntegrations(request.method.toUpperCase(), request.path, parsed(request.body), engine, signal);
      return yield* json(status, value);
    }
    // A folder of this box's to choose, for a setting that names one (PROTOCOL.md, `kuvo/folders`).
    if (route === "kuvo/folders") {
      const method = request.method.toUpperCase();
      if (method !== "GET" && method !== "POST") return yield* json(405, {});
      const { status, value } = method === "GET" ? listFolders(request.path) : makeFolder(parsed(request.body));
      return yield* json(status, value);
    }
    // Settings › Engine's plugins (PROTOCOL.md, `kuvo/plugins/search`): npm's, found from this box.
    if (route === "kuvo/plugins/search") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      try {
        return yield* json(200, await searchPlugins(new URLSearchParams(request.path.split("?")[1] ?? "").get("q"), signal));
      } catch (error) {
        return yield* json(502, { message: "npm couldn't be reached from here. Check this computer's internet connection, then try again." });
      }
    }
    // Settings › Skills (PROTOCOL.md, "Skills"): this box's own skills folder, its Recently Deleted, and GitHub's
    // collections, which it reaches itself (a machine's with the Mac closed too).
    if (/^kuvo\/(skills|skill-library|skill-trash)(\/|\?|$)/.test(request.path)) {
      let engine = null;
      try { engine = readEngine(); } catch {}
      const { status, value } = await answerSkills(request.method.toUpperCase(), request.path, parsed(request.body), engine);
      return yield* json(status, value);
    }
    // Its own settings, and its integrations' keys (PROTOCOL.md, "Settings per box").
    if (/^kuvo\/(config|mcp\/catalog|keys)(\/|\?|$)/.test(request.path)) {
      // Its own, once Kuvo Code has made them so; until then, as the Mac that started it has them.
      if (!ownsSettings()) return yield* json(409, { message: "This machine's settings still come from your Mac. Connect it from Kuvo Code on your Mac once." });
      const method = request.method.toUpperCase();
      // A file that can't be used says why twice: in words to show (`message`), and the file's
      // problem alone (`problem`), for a page that names the file already.
      const answered = ({ status, settings, message, problem }) => json(status, message ? (problem ? { message, problem } : { message }) : settings ?? {});
      if (route === "kuvo/config") {
        if (method === "GET") {
          const { settings, problem } = readSettings();
          return yield* (problem ? json(409, { message: `The engine's settings file can't be changed from here: ${problem}`, problem }) : json(200, settings));
        }
        if (method === "PATCH") return yield* answered(changeSettings(parsed(request.body)?.changes));
        return yield* json(405, {});
      }
      if (route === "kuvo/config/apply") {
        if (method !== "POST") return yield* json(405, {});
        const { status, ...answer } = applySettings(parsed(request.body));
        return yield* json(status, answer);
      }
      if (route === "kuvo/mcp/catalog") {
        if (method !== "GET") return yield* json(405, {});
        return yield* json(200, mcpCatalog(readSettings().settings ?? {}));
      }
      const adding = route.match(/^kuvo\/mcp\/catalog\/([^/]+)$/);
      if (adding && method === "POST") return yield* answered(addFromCatalog(decodeURIComponent(adding[1])));
      // Its integrations' keys, where it keeps them (a machine's files, this Mac's Keychain through
      // its app): a bot's own aren't among them.
      if (route === "kuvo/keys" || route.startsWith("kuvo/keys/")) {
        const { status, value } = await answerKeys(method, route, parsed(request.body));
        return yield* json(status, value);
      }
      return yield* json(404, {});
    }
    // The phones paired with this machine, and removing some (a lost one, say), from any phone
    // paired with it: what a removal takes off stays off (see `removePhones`).
    if (route === "kuvo/phones") {
      const link = readLink();
      const asking = phone?.key?.toString("base64url");
      return yield* json(200, {
        phones: (link?.phones ?? []).map(each => ({ key: each.key, name: each.name, added: each.added ?? null, pairing: each.pairing ?? "", you: each.key === asking })),
      });
    }
    if (route === "kuvo/phones/remove") {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      const given = parsed(request.body);
      // This Mac's app removes as the Mac does (Settings › Phone, or a removal a machine's
      // document brought).
      const asMac = IS_MAC && request.fromApp;
      // On this Mac, one before any phone's paired here (no link file yet) is kept all the same,
      // so the phone stays out once it's taken.
      const changed = updateLink(kept => {
        const link = kept ?? (asMac ? { phones: [], removed: [] } : null);
        return link && (asMac ? removeAsMac(link, given?.phones) : removePhones(link, phone?.key?.toString("base64url"), given?.phones)) ? link : null;
      });
      if (!changed) return yield* json(400, { message: "Only phones paired here can be removed, and never your Mac." });
      noteDocsChanged();
      // Once this answer is on its way: a phone that removed itself gets it too.
      setTimeout(() => phonesChanged(readLink() ?? changed), 200);
      return yield* json(200, {});
    }
    // A link for another phone to pair with this machine, as `kuvo-link.js pair` shows one: good
    // once, for a while; a new one takes the place of the last. DELETE ends it.
    if (route === "kuvo/phones/pair") {
      const method = request.method.toUpperCase();
      // This Mac's Settings › Phone has one of its own, apart from a phone's.
      const slot = IS_MAC && request.fromApp ? "appPairing" : "pairing";
      if (method === "DELETE") {
        // `?token=`: that link alone, so one closed late never ends a newer one.
        const token = new URLSearchParams(String(request.path ?? "").split("?")[1] ?? "").get("token");
        updateLink(link => {
          if (!link?.[slot] || (token && link[slot].token !== token)) return null;
          delete link[slot];
          return link;
        });
        macLink.wake?.();
        return yield* json(200, {});
      }
      if (method !== "POST") return yield* json(405, {});
      if (IS_MAC && !macLink.config?.phones) return yield* json(409, { message: "The phone link is off on this Mac." });
      const link = updateLink(current => current?.relay && current?.secret ? { ...current, [slot]: newPairingToken() } : null);
      if (!link) return yield* json(409, { message: IS_MAC ? "The phone link isn't ready yet. Try again in a moment." : "This machine has no relay to pair through." });
      macLink.wake?.();
      return yield* json(200, { link: pairingLink({ ...link, pairing: link[slot] }), ends: Math.floor(link[slot].expires / 1000) });
    }
    // This Mac's box's link, for its app alone (PROTOCOL.md, "This Mac's box: the relay").
    if (route === "kuvo/link" || route.startsWith("kuvo/link/")) {
      if (!IS_MAC || !request.fromApp) return yield* json(403, { message: "Only Kuvo Code on this computer can do that." });
      return yield* macLinkRoute(route, request, signal);
    }
    // On this Mac, what only its app knows for your phones (an ask from its panel's browser), held
    // with the box's own; and one answered there, which then never goes. Its app's alone.
    if (route === "kuvo/attention/notice" || route === "kuvo/attention/answered") {
      if (!IS_MAC || !request.fromApp || !hold) return yield* json(403, { message: "Only Kuvo Code on this computer can do that." });
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      const given = parsed(request.body);
      if (route === "kuvo/attention/answered") {
        if (typeof given?.id !== "string") return yield* json(400, { message: "Send {id}." });
        hold.resolve(given.id);
        return yield* json(200, {});
      }
      if (!isObject(given?.notice) || typeof given.notice.title !== "string") return yield* json(400, { message: "Send {notice}." });
      macTell(given.notice);
      return yield* json(200, {});
    }
    // A client in use here (PROTOCOL.md, "kuvo/attention"): notices for your phones wait a little
    // while one is. GET says whether one is, and how many wait.
    if (route === "kuvo/attention") {
      const method = request.method.toUpperCase();
      if (!hold) return yield* json(503, { message: "Only this machine's bridge holds its notices." });
      if (method === "GET" || method === "HEAD") return yield* json(200, { inUse: hold.inUse, held: hold.count });
      if (method !== "POST") return yield* json(405, {});
      const given = attentionGiven(parsed(request.body));
      if (!given) return yield* json(400, { message: "Say for how many seconds you're in use (for: 0 for not), and which conversations are on your screen (sessions)." });
      // This Mac's app is "mac", as a Mac's word by mail is to a machine; and your machines hear it.
      hold.attend(IS_MAC && request.fromApp ? "mac" : `phone:${phone?.key?.toString("base64url") ?? ""}`, given);
      if (IS_MAC && request.fromApp) macAttendPeers(parsed(request.body), given);
      return yield* json(200, { for: given.seconds });
    }
    // Who `&` can name in a message here, as a Mac's composer offers them: this machine's bots and
    // latest sessions (`machine` null), then those its other computers told it of.
    if (route === "kuvo/named") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      const link = readLink();
      // Its own as last worked out while its engine can't say (starting), rather than none.
      const fresh = await ownAgents(readEngine, link?.id).catch(() => null);
      if (fresh) keepOwn(fresh, link?.id ?? null);
      const own = fresh ?? ownAsLast(link?.id ?? null);
      return yield* json(200, { agents: namedAgents(own, peersOf(link), readPeerAgents(undefined, undefined, link), movedOf(link)) });
    }
    // What agents ask for while they browse here: listed, followed (a line each time it changes,
    // as a Mac's), and answered.
    if (route === "kuvo/asks" || route === "kuvo/asks/events") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      const read = async () => ({
        asks: await Promise.all(readAsks().map(async ask => {
          const { ask: shown, asker } = await inConversation(ask, readEngine);
          return listedAsk(shown, info.name ?? os.hostname(), asker);
        })),
      });
      if (route === "kuvo/asks") return yield* json(200, await read());
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      let last = "";
      while (!signal?.aborted) {
        const line = JSON.stringify(await read());
        if (line !== last) {
          yield { body: Buffer.from(line + "\n") };
          last = line;
        }
        await new Promise(done => setTimeout(done, 1000));
      }
      return;
    }
    const answering = route.match(/^kuvo\/asks\/([^/]+)$/);
    if (answering) {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      const ask = readAsks().find(each => each.id === decodeURIComponent(answering[1]));
      if (!ask) return yield* json(404, {});
      const given = parsed(request.body);
      const answer = askAnswer(ask, given);
      if (!answer) return yield* json(400, given?.saved != null ? { message: "Saved passwords are on your Mac: type this one." } : {});
      return yield* json((await answerAsk(ask.id, answer)) ? 200 : 503, {});
    }
    // COMPAT(0.7 engine-stop): `kuvo/engine/start`, for an engine an older Mac's Stop left down. Goes 3 months after 0.8.0.
    // (No Stop: a machine's engine keeps running, and up to date. Start is for one an older Mac stopped.)
    const control = route.match(/^kuvo\/engine\/(start|restart)$/);
    if (control) {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      const { status, message } = await engineControl(control[1]);
      return yield* json(status, message ? { message } : {});
    }
    if (route === "kuvo/sign-in/return") {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      return yield* loadSignInReturn(request.body, signal);
    }
    // The coding agents' sessions, accounts and Auto, through their bridge, as the engine's go
    // to it; never where the engine is, nor an agent's update.
    if (request.path.startsWith(AGENTS)) {
      const path = request.path.slice(AGENTS.length);
      if (!agentsAllowed(path, request.method)) return yield* text(403, "That isn't available over the link.");
      const target = bridge();
      if (!target) {
        yield { head: { status: 503, headers: { "content-type": "application/json" } } };
        yield { body: Buffer.from(JSON.stringify({ message: "The coding agents aren't running on this machine." })) };
        return;
      }
      return yield* forward(target, path, request, signal, agentsAllowed, namingHere(readEngine), () => "The coding agents aren't answering on this computer. Try again in a moment.");
    }
    // The plans whose sign-in ran out and couldn't be renewed (a run on one was refused), and
    // signing out of one, as Settings › Accounts' Disconnect does (PROTOCOL.md, "kuvo/accounts").
    if (route === "kuvo/accounts/ended" || /^kuvo\/accounts\/[^/]+\/forget$/.test(route)) {
      let engine = null;
      try { engine = readEngine(); } catch {}
      if (!engine?.port) return yield* json(503, { message: "The engine isn't running." });
      if (route === "kuvo/accounts/ended") {
        if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* json(405, {});
        return yield* json(200, { providers: await endedProviders(engine).catch(() => []) });
      }
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      let id = null;
      try { id = decodeURIComponent(route.slice("kuvo/accounts/".length, -"/forget".length)); } catch {}
      if (!id || id.includes("/")) return yield* json(404, {});
      return yield* ((await forgetPlan(engine, id).catch(() => false)) ? json(200, {}) : json(404, {}));
    }
    // This machine's sign-ins, listed (`api/credential` has what each is signed in with too).
    if (route === "kuvo/accounts/credentials") {
      if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* text(405, "Read them with GET.");
      let engine;
      try {
        engine = readEngine();
      } catch {
        return yield* text(503, "The engine isn't running.");
      }
      let listed;
      try {
        const response = await fetch(`http://127.0.0.1:${engine.port}/api/credential`, {
          headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
          signal,
        });
        if (!response.ok) return yield* text(502, "The engine didn't answer.");
        listed = ((await response.json())?.data ?? []).map(credential => ({
          id: String(credential.id), integrationID: String(credential.integrationID), label: String(credential.label ?? ""), active: Boolean(credential.active),
        }));
      } catch {
        return yield* text(502, "The engine didn't answer.");
      }
      yield { head: { status: 200, headers: { "content-type": "application/json" } } };
      yield { body: Buffer.from(JSON.stringify({ credentials: listed })) };
      return;
    }
    // New bots and group chats, made here as New Bot and New Group Chat make them on the Mac,
    // which takes them in when it next connects.
    // The library followed: a line now, and again as it changes, from a route here, a peer's copy
    // met, or another process (a Mac's `box personalities` over SSH, the bridge beside this box).
    if (route === "kuvo/personalities/events") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(() => ({ personalities: readPersonalities().personalities }), personalityFollowers, signal, { folders: [path.dirname(PERSONALITIES_FILE)], recursive: false });
    }
    // The library whole, and another computer's copy met with it: for the app beside this box only
    // (it signs the library for your other computers), never a phone.
    if (route === "kuvo/personalities/document" || route === "kuvo/personalities/take") {
      if (!request.fromApp) return yield* json(403, { message: "Only Kuvo Code on this computer can do that." });
      const method = request.method.toUpperCase();
      if (route === "kuvo/personalities/document") return yield* method === "GET" ? json(200, personalitiesDocument()) : json(405, {});
      if (method !== "POST") return yield* json(405, {});
      const [status, value] = takePersonalitiesDocument(parsed(request.body), readEngine, readBridge);
      return yield* json(status, value);
    }
    // The personalities you make, this machine's copy of the library.
    const personality = route.match(/^kuvo\/personalities(?:\/([^/]+))?$/);
    if (personality) {
      let id;
      try { id = personality[1] === undefined ? undefined : decodeURIComponent(personality[1]); } catch { return yield* json(404, {}); }
      const [status, value] = answerPersonalities(request.method.toUpperCase(), id, parsed(request.body));
      // Its bots with it are told what it is now, or that it's gone.
      if (status === 200 && id !== undefined) retellBots([id], readEngine, readBridge).catch(() => {});
      return yield* json(status, value);
    }
    if (route === "kuvo/bots/templates") {
      const kit = readKit();
      if (!kit) return yield* json(409, { message: NO_KIT });
      return yield* json(200, botTemplates(kit, info.name));
    }
    if (request.method.toUpperCase() === "POST" && route === "kuvo/bots") {
      const { status, value } = await makeBot(parsed(request.body), readEngine, bridge, info.name, signal);
      return yield* json(status, value);
    }
    // The box's projects, as the sidebar and Edit Project change them (PROTOCOL.md, "Projects").
    if (route === "kuvo/projects" || route === "kuvo/projects/events") return yield* answerProjects(request, readEngine, readBridge, signal);
    // Its worktrees' records followed: a line now, and again each time they change (one made for
    // a phone, renamed, removed), as a Mac shows them.
    if (route === "kuvo/worktrees/events") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(() => ({ worktrees: readWorktrees() }), worktreeFollowers, signal);
    }
    // Settings › Worktrees, and a new session's worktree (PROTOCOL.md, "Worktrees").
    if (/^kuvo\/worktrees(\/(remove|record|where))?$/.test(route)) {
      let engine = null;
      try { engine = readEngine(); } catch {}
      if (route === "kuvo/worktrees/where") {
        if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
        return yield* json(200, await worktreesWhere(new URLSearchParams(request.path.split("?")[1] ?? "").get("directory"), engine, signal));
      }
      const { status, value } = await answerWorktrees(request.method.toUpperCase(), request.path, parsed(request.body), engine, signal);
      return yield* json(status, value);
    }
    // Its bots' folders' settings as their keys and this box's integrations are now, as a client
    // asks after it changes them (before the bot keys' route, which would take "keys" for a bot).
    if (route === "kuvo/bots/keys/refresh") {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      try {
        await refreshBotsKeys();
      } catch (error) {
        if (!(error instanceof KeysUnavailable)) throw error;
        return yield* json(503, { message: error.message });
      }
      return yield* json(200, {});
    }
    // A bot's keys of its own, as Edit Bot shows and changes them.
    if (/^kuvo\/bots\/[^/]+\/keys(\/[^/]+)?$/.test(route)) {
      let engine = null;
      try { engine = readEngine(); } catch {}
      const { status, value } = await answerBotKeys(request.method.toUpperCase(), request.path, parsed(request.body), engine);
      return yield* json(status, value);
    }
    // A conversation here carried on with the coding agents here, as picking one of their models
    // in it does.
    const toAgents = route.match(/^kuvo\/sessions\/([^/]+)\/agents$/);
    if (toAgents) {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      let id;
      try { id = decodeURIComponent(toAgents[1]); } catch { return yield* json(404, { message: "That conversation isn’t there any more." }); }
      const { status, value } = await carryToAgents(id, parsed(request.body)?.model, readEngine, bridge(), signal);
      return yield* json(status, value);
    }
    // A bot here changed as Edit Bot changes it, or deleted as Delete Bot… deletes it.
    const oneBot = route.match(/^kuvo\/bots\/([^/]+)$/);
    if (oneBot && ["PATCH", "DELETE"].includes(request.method.toUpperCase())) {
      let id;
      try {
        id = decodeURIComponent(oneBot[1]);
      } catch {
        return yield* json(404, { message: "That bot isn’t there any more." });
      }
      const { status, value } = request.method.toUpperCase() === "PATCH"
        ? await changeBot(id, parsed(request.body), readEngine, bridge, info.name, signal)
        : await deleteBot(id, readEngine, bridge, signal);
      return yield* json(status, value);
    }
    // The group chats that live here (`kuvo/groups`), from the coding agents' bridge, which runs them.
    if (GROUP_ROUTE.test(route)) {
      const target = bridge();
      if (!target) return yield* groupJSON(503, { message: IS_MAC ? "Group chats on this Mac are starting. Try again in a moment." : "Group chats run with the coding agents' bridge, which isn't running on this machine." });
      // Who a message names with "&" is worked out there, from the list as it is now: worked out
      // again meanwhile, and waited for (two seconds at most) only when a name after "&" isn't
      // there yet, as a message from a phone (`namingHere`).
      if (request.method.toUpperCase() === "POST" && route.split("/").length === 3 && Buffer.from(request.body ?? []).includes("&")) {
        let text = "";
        try { text = JSON.parse(Buffer.from(request.body).toString())?.text; } catch {}
        const working = refreshOwnShared(readEngine);
        if (typeof text === "string" && nameMissing(text, listedAgents().agents)) {
          await Promise.race([working, new Promise(resolve => setTimeout(resolve, 2000).unref?.())]);
        }
      }
      return yield* forwardGroups(target, route, request, signal);
    }
    // A bot brought here from another computer, made this box's (Move to Computer).
    const arrived = route.match(/^kuvo\/bots\/([^/]+)\/arrived$/);
    if (arrived) {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      let id;
      try { id = decodeURIComponent(arrived[1]); } catch { return yield* json(404, { message: "That bot isn’t there any more." }); }
      const { status, value } = await settleBot(id, readEngine, bridge, info.name);
      return yield* json(status, value);
    }
    // Its bots told what they are now where that changed, as its app asks after a change to its kit
    // (your personalities, on a Mac).
    if (route === "kuvo/bots/retell") {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      for (const read of [readEngine, readBridge]) {
        let target = null;
        try { target = read(); } catch {}
        if (target?.port) await freshenBots(target);
      }
      return yield* json(200, {});
    }
    // Its bots followed: a line now, and again as they change (made, changed, deleted, a wake-up
    // added or sent), as a client shows them.
    if (route === "kuvo/bots/events") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(() => ({ bots: listBots(info.name) }), botFollowers, signal, { folders: [BOTS] });
    }
    // This machine's bots and wake-ups, from their folders.
    if (route === "kuvo/bots") {
      if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* text(405, "Read them with GET.");
      yield { head: { status: 200, headers: { "content-type": "application/json" } } };
      // A Mac's read (`?memory=1`): with each one's job as its memory has it now.
      const memory = /(^|[?&])memory=1(&|$)/.test(request.path.split("?")[1] ?? "");
      yield { body: Buffer.from(JSON.stringify({ bots: listBots(info.name, { memory }) })) };
      return;
    }
    if (route === "kuvo/wakes") {
      if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* text(405, "Read them with GET.");
      yield { head: { status: 200, headers: { "content-type": "application/json" } } };
      yield { body: Buffer.from(JSON.stringify({ sessions: listWakes() })) };
      return;
    }
    // Every conversation's wake-ups and watches followed: a line now, and again as they change
    // (added, fired, canceled, paused), as a Mac shows them (PROTOCOL.md, "Wake-ups").
    if (route === "kuvo/wakes/events") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(() => ({ sessions: allWakes() }), wakeFollowers, signal, { folders: [BOTS, SESSION_WAKES] });
    }
    const wakes = route.match(/^kuvo\/wakes\/([^/]+)(?:\/(cancel|now|pause|watch))?$/);
    if (wakes) {
      let session;
      try {
        session = decodeURIComponent(wakes[1]);
      } catch {
        return yield* text(404, "No such session.");
      }
      return yield* answerWakes(session, wakes[2], request, readEngine, bridge, signal);
    }
    const stop = route.match(/^kuvo\/shell\/([^/]+)\/stop$/);
    if (!stop && !allowed(request.path, request.method)) return yield* text(403, "That isn't available over the link.");
    let engine = null;
    try {
      engine = readEngine();
    } catch {
      // A coding agent's command stops without the engine.
      if (!stop || !bridge()) return yield* json(503, { message: engineDown() });
    }
    if (stop) {
      if (request.method.toUpperCase() !== "POST") return yield* text(405, "Stop it with POST.");
      const headers = {};
      const given = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
      for (const name of REQUEST_HEADERS) if (given[name]) headers[name] = given[name];
      // The engine's, else a coding agent's, through their bridge.
      const runners = [engine, bridge()].filter(Boolean);
      return yield* stopShell(decodeURIComponent(stop[1]), runners, headers, signal);
    }
    return yield* forward(engine, request.path, request, signal, allowed, namingHere(readEngine));
  };
}

// ---- What follows a change to link.json (./state), or to this box's documents ----

onDocsChanged(macDocsChanged);
onLinkWritten(link => {
  if (IS_MAC) {
    for (const tell of macLink.phoneFollowers) tell();
    // Phones no longer paired lose what they have open, whoever removed them, and a link no longer
    // wanted (the last phone gone) leaves the relay: a moment after, so a phone that removed itself
    // gets its answer first (as a machine's bridge does). Known: closing once that answer has gone
    // would be surer than a moment's wait.
    setTimeout(() => {
      macLink.host?.keepOnly(new Set((readLink()?.phones ?? []).map(phone => phone.key)));
      macLinkCheck();
    }, 200);
    return;
  }
  // For the box's keeper, which keeps this bridge running while it's needed.
  if (needed(link)) fs.writeFileSync(NEEDED_FILE, "", { mode: 0o600 });
  else fs.rmSync(NEEDED_FILE, { force: true });
});

// ---- This Mac's box's link (PROTOCOL.md, "This Mac's box: the relay") ----
// On a Mac, `serve` holds the relay connection a machine's `run` holds, in the same process: your
// phones' sessions, paired and pairing as on a machine, answered here. Its keys stay in your
// Keychain: the app gives them as the link starts (`link/identity`), and they're kept in memory
// only; without them the link stays off and says why, and never makes keys of its own. Its app says
// whether it's wanted (`kuvo/link/config`: the phone link on, machines to meet). Your other
// computers' mail is taken here, as a machine takes it: documents, agents, letters, group chats'.
// What a phone asks of the Mac's own routes, which only the app answers yet, goes to it through the
// host (`link/route`).

// What this Mac's box answers a phone itself: the areas that have moved onto it (PhoneLink's
// `boxRoutes`), and its phones. The rest the app answers, through the host.
export const MAC_BOX_ROUTES = ["kuvo/projects", "kuvo/worktrees", "kuvo/plugins", "kuvo/folders", "kuvo/wakes", "kuvo/config", "kuvo/mcp/catalog", "kuvo/skills", "kuvo/skill-library",
  "kuvo/skill-trash", "kuvo/integrations", "kuvo/keys", "kuvo/bots", "kuvo/personalities", "kuvo/phones", "kuvo/attention", "kuvo/accounts/ended",
  "kuvo/accounts/credentials", "kuvo/file", "kuvo/sign-in/return", "kuvo/named", "kuvo/groups"];
// (A plan signed out from a phone, `kuvo/accounts/<id>/forget`, and a command stopped,
// `kuvo/shell/<id>/stop`: the box's too.)
const macAnswersAlso = route => /^kuvo\/accounts\/[^/]+\/forget$/.test(route) || /^kuvo\/shell\/[^/]+\/stop$/.test(route);
export const macAnswers = route => MAC_BOX_ROUTES.some(area => route === area || route.startsWith(`${area}/`)) || macAnswersAlso(route);

const APP_NOT_ANSWERING = "Kuvo Code on this Mac isn't answering. Try again in a moment.";

// Whether the link's wanted now: the phone link on, with a phone paired or a pairing waiting; or
// machines to meet.
function macNeeded(link, now = Date.now()) {
  const config = macLink.config;
  if (!config) return false;
  if (config.machines) return true;
  const pairing = ["pairing", "appPairing"].some(slot => link?.[slot] && now < link[slot].expires);
  return Boolean(config.phones && ((link?.phones ?? []).length || pairing));
}

// Off the relay once it's no longer wanted (the phone link turned off, the last phone gone, a
// pairing that ran out, no machines any more).
function macLinkCheck() {
  if (macLink.host && !macNeeded(readLink())) macLink.host.disconnect?.();
}

function setLinkStatus(state, reason) {
  const next = reason ? { state, reason } : { state };
  if (JSON.stringify(next) === JSON.stringify(macLink.status)) return;
  macLink.status = next;
  for (const tell of macLink.statusFollowers) tell();
}

// Waits `ms`, or until the link's told something changed (`macLink.wake`).
function macLinkWait(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (macLink.wake === done) macLink.wake = null;
      resolve();
    }
    macLink.wake = done;
  });
}

const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

// This Mac's keys, from its app (your Keychain): its link key, relay secret and signing key, kept
// with the relay and name it says once it's on. False when the app couldn't give them (the link
// says so).
async function macKeys() {
  const config = macLink.config;
  if (macLink.overlay || !config || !(config.phones || config.machines)) return true;
  const given = await linkHost("link/identity", {});
  if (!given || !["key", "secret", "sign"].every(name => KEY_TEXT.test(given[name] ?? ""))) {
    setLinkStatus("failed", "Kuvo Code couldn't give this Mac's link its keys from your Keychain. It tries again in a moment.");
    return false;
  }
  macLink.overlay = { key: given.key, secret: given.secret, sign: given.sign, relay: macLink.config.relay, name: macLink.config.name };
  // What it said of the keys before isn't so any more.
  if (macLink.status.state === "failed") setLinkStatus(macNeeded(readLink()) ? "connecting" : "off");
  return true;
}

// What a phone asks of the Mac's own routes, answered by the app (`link/route`), as it comes; 503,
// at once, when the app isn't answering, and a stream that ends when the app goes.
async function* toApp(request, phone, signal) {
  let response = null;
  const host = appHost();
  if (host) {
    try {
      // Nothing goes until it's proved it's this Mac's app: once for each host.json, which is
      // enough because this box (`serve`) ends with its app (its stdin closes), so no other
      // process can take the app's port while this box still trusts it, without the file changing.
      await proveHost(host);
      response = await fetch(`${host.url}/link/route`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json" },
        body: JSON.stringify({
          method: request.method,
          path: request.path,
          headers: request.headers ?? {},
          body: Buffer.from(request.body ?? EMPTY).toString("base64"),
          phone: phone?.key?.toString("base64url") ?? null,
        }),
        signal,
      });
    } catch {
      // Gone from there (or not proved): proved again before anything more is sent there.
      if (!signal?.aborted) forgetHostProof();
      response = null;
    }
  }
  // The app's own answer says so (`x-kuvo-answer`), whatever its status: without it, the app
  // isn't there to answer (gone, starting again, or an older one).
  if (!response || response.headers.get("x-kuvo-answer") !== "1") {
    await response?.body?.cancel().catch(() => {});
    yield { head: { status: 503, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ message: APP_NOT_ANSWERING })) };
    return;
  }
  const headers = { "content-type": response.headers.get("content-type") ?? "application/json" };
  const cache = response.headers.get("cache-control");
  if (cache) headers["cache-control"] = cache;
  yield { head: { status: response.status, headers } };
  if (!response.body) return;
  // One cut off as it came (the app gone halfway) ends as cut off, not as a whole answer.
  for await (const chunk of response.body) {
    if (signal?.aborted) break;
    yield { body: Buffer.from(chunk) };
  }
}

// A phone's request on this Mac: the box's own areas here, the rest from the app.
export function macFront(handle = engineHandler(readEngineFile, { name: os.hostname() })) {
  return async function* (request, phone, signal) {
    const route = String(request.path ?? "").split("?")[0];
    // (The engine's API and the coding agents', as a machine's bridge passes them on, who a message
    // names with "&" told: bridge 0.9.64.)
    if (macAnswers(route) || /^api(\/|$)/.test(route) || route.startsWith(AGENTS)) return yield* handle(request, phone, signal);
    yield* toApp(request, phone, signal);
  };
}

// Phones from where an earlier Kuvo Code kept them (`phone-link.json`), met with this box's: each
// paired one in, unless a removal of its pairing is known; each removal noted, and taking off what
// it removes.
export function takePhones(link, given) {
  const phones = Array.isArray(given?.phones) ? given.phones.slice(0, 64) : [];
  const removed = Array.isArray(given?.removed) ? given.removed.slice(0, MOST_KEPT) : [];
  for (const entry of removed) if (fits(entry, []) && typeof entry.pairing === "string") takeOff(link, entry.key, entry.pairing);
  for (const phone of phones) {
    if (!isObject(phone) || !fits(phone, []) || removedAlready(link, phone.key, phone.pairing ?? "")) continue;
    const known = (link.phones ?? []).find(each => each.key === phone.key);
    if (known && (known.pairing ?? "") === (phone.pairing ?? "")) continue;
    pairPhone(link, {
      key: phone.key,
      name: String(phone.name ?? "").slice(0, 100),
      added: Number.isFinite(phone.added) ? Math.floor(phone.added) : Math.floor(Date.now() / 1000),
      from: "pair",
      ...(ADDRESS.test(phone.address ?? "") ? { address: phone.address } : {}),
      pairing: typeof phone.pairing === "string" ? phone.pairing : "",
    });
  }
  return link;
}

// The phones as the app keeps a copy of them (all of each, with where it is, and every removal),
// and whether Settings › Phone's pairing link is still waiting (a phone came in with it, or it ran
// out: it's done).
const macPhones = () => {
  const link = readLink();
  return {
    phones: link?.phones ?? [],
    removed: link?.removed ?? [],
    pairing: Boolean(link?.appPairing && Date.now() < link.appPairing.expires),
    // For the app's copy (an older Kuvo Code goes on from these counts, never back).
    documents: { own: link?.own ?? {}, held: link?.docs ?? {}, views: link?.views ?? {}, left: link?.left ?? [] },
  };
};

// What an earlier Kuvo Code kept of this Mac's documents (`phone-link.json`): how far each of its
// own has come (never back: your machines would refuse what comes next), the phones documents its
// machines signed, how far each machine's view of your personalities has come, and the machines it
// removed. Its machines are this box's peers by then, so what they signed is checked as it's taken.
export function takeMacDocuments(link, given) {
  if (!isObject(given)) return link;
  for (const [kind, had] of Object.entries(isObject(given.own) ? given.own : {})) {
    if (!DOC_KINDS.includes(kind) || !isObject(had) || !Number.isSafeInteger(had.n) || had.n < 1 || had.n > MOST_COUNT) continue;
    const now = link.own?.[kind];
    if (!now || had.n > now.n) link.own = { ...(link.own ?? {}), [kind]: { n: had.n, h: String(had.h ?? ""), b: String(had.b ?? "") } };
  }
  for (const envelope of Object.values(isObject(given.held) ? given.held : {}).slice(0, 256)) takeDoc(link, envelope);
  for (const [origin, seen] of Object.entries(isObject(given.views) ? given.views : {}).slice(0, 256)) {
    if (!SIGN.test(origin) || !isObject(seen) || !Number.isSafeInteger(seen.n) || seen.n < 1) continue;
    if (!link.views?.[origin] || seen.n > link.views[origin].n) link.views = { ...(link.views ?? {}), [origin]: { n: seen.n, h: String(seen.h ?? "") } };
  }
  const left = Array.isArray(given.left) ? given.left.filter(key => typeof key === "string" && KEY.test(key)) : [];
  if (left.length) link.left = [...new Set([...(Array.isArray(link.left) ? link.left : []), ...left])].slice(-64);
  return link;
}

// Your machines this Mac set up (over SSH), as its app says: those that sign their documents, each
// `{key, sign, address, name, id}`; the conversations being moved, `{session, key}` each; and the
// machines you removed, by key (`removed`): its peers document names them so they let this Mac go,
// and they hear that once. One just missing from the list (it can't be reached to be set up, say)
// isn't a peer now, and nothing more; one set up again is no longer removed. One that isn't a
// machine's record is left out (a line in the box's log says so), never the rest with it. No link
// for what isn't a list.
export function setMacPeers(link, given) {
  if (!isObject(given) || !Array.isArray(given.peers)) return { link: null, gone: [] };
  const now = given.peers.slice(0, MOST_PEERS).map(peer => ({ ...peer, kind: "machine" }))
    .filter(peer => fitsPeer(peer) && typeof peer.sign === "string" && SIGN.test(peer.sign)).map(cleanPeer);
  const skipped = Math.min(given.peers.length, MOST_PEERS) - now.length;
  if (skipped) console.error(`${skipped} of this Mac's machines weren't records the box could take, and were left out.`);
  const removed = (Array.isArray(given.removed) ? given.removed : []).filter(key => typeof key === "string" && KEY.test(key) && !now.some(peer => peer.key === key));
  const gone = peersOf(link).filter(peer => removed.includes(peer.key));
  const kept = (Array.isArray(link.left) ? link.left : []).filter(key => !now.some(peer => peer.key === key) && !removed.includes(key));
  link.left = [...kept, ...removed].slice(-64);
  link.macPeers = now;
  link.macMoved = cleanMoved(given.moved);
  pruneDocs(link);
  return { link, gone };
}

// Machines this Mac removed hear its peers document once, while it still knows where they are: they
// let this Mac go. Those it couldn't tell now (off the relay, or the connection closing) hear it
// once it's back (`link.untold`), each kept until it went.
function tellGone(gone) {
  if (!gone.length) return;
  const went = sendGone(gone);
  const left = gone.filter(peer => !went.includes(peer.key));
  updateLink(link => {
    if (!link) return null;
    const untold = (Array.isArray(link.untold) ? link.untold : []).filter(peer => !gone.some(each => each.key === peer.key));
    if (!left.length && untold.length === (link.untold?.length ?? 0)) return null;
    link.untold = [...untold, ...left].slice(-64);
    if (!link.untold.length) delete link.untold;
    return link;
  });
}

// Mails `gone` this Mac's peers document; the keys of those it went to.
function sendGone(gone) {
  const host = macLink.host;
  if (!host?.welcomed) return [];
  let envelope = null;
  const link = updateLink(link => {
    const made = link?.sign ? ownDoc(link, "peers", macPeersBody(link)) : null;
    envelope = made?.envelope ?? null;
    return made?.changed ? link : null;
  }) ?? readLink();
  if (!envelope || !link?.key) return [];
  const went = [];
  for (const peer of gone) {
    // (One that signs no documents takes none: nothing to tell it.)
    if (!peer.sign) {
      went.push(peer.key);
      continue;
    }
    const bytes = mailFor(peer, { docs: { give: [envelope] }, at: Date.now() }, link);
    try { if (bytes && host.send(bytes)) went.push(peer.key); } catch {}
  }
  return went;
}

// On the relay again: the machines removed meanwhile hear it now (one set up again since, not).
function tellUntold() {
  const link = readLink();
  const untold = (Array.isArray(link?.untold) ? link.untold : []).filter(fitsPeer);
  const again = untold.filter(peer => peersOf(link).some(each => each.key === peer.key));
  if (again.length) {
    updateLink(link => {
      if (!link?.untold) return null;
      link.untold = link.untold.filter(peer => !again.some(each => each.key === peer.key));
      return link;
    });
  }
  tellGone(untold.filter(peer => !again.includes(peer)).map(cleanPeer));
}

const ADDRESS_TEXT = /^[A-Za-z0-9_-]{22}$/;

// `kuvo/link/…`, for this Mac's app.
async function* macLinkRoute(route, request, signal) {
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const method = request.method.toUpperCase();
  switch (route) {
    case "kuvo/link/config": {
      if (method !== "PUT") return yield* json(405, {});
      const given = parsed(request.body);
      let relay = null;
      try { relay = given?.relay ? new URL(String(given.relay)) : null; } catch {}
      if (!isObject(given) || typeof given.phones !== "boolean" || typeof given.machines !== "boolean" || !relay || !["ws:", "wss:"].includes(relay.protocol)) {
        return yield* json(400, { message: "Say whether the phone link is on (phones) and there are machines (machines), and the relay." });
      }
      const config = { phones: given.phones, machines: given.machines, relay: relay.toString().replace(/\/$/, ""), name: String(given.name ?? "Mac").slice(0, 100), app: String(given.app ?? ""),
        ...(Array.isArray(given.features) ? { features: keptFeatures(given.features) } : {}) };
      const before = macLink.config;
      macLink.config = config;
      if (macLink.overlay) macLink.overlay = { ...macLink.overlay, relay: config.relay, name: config.name };
      // Phones not let in any more (the phone link off) lose what they have open; another relay
      // means another connection.
      if (!config.phones) macLink.host?.keepOnly(new Set());
      if (before && (before.relay !== config.relay || before.name !== config.name)) macLink.host?.disconnect?.();
      // Its keys before this answers, so a pairing link can be made right after.
      await macKeys();
      macLinkCheck();
      macLink.wake?.();
      // The phone link on or off: this Mac's phones document comes, or stops changing.
      if (before?.phones !== config.phones) macDocsChanged();
      return yield* json(200, macLink.status);
    }
    case "kuvo/link/status":
      if (method !== "GET") return yield* json(405, {});
      return yield* json(200, macLink.status);
    case "kuvo/link/status/events":
      if (method !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(() => macLink.status, macLink.statusFollowers, signal);
    case "kuvo/link/phones":
      if (method !== "GET") return yield* json(405, {});
      return yield* json(200, macPhones());
    case "kuvo/link/phones/events":
      if (method !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(macPhones, macLink.phoneFollowers, signal);
    case "kuvo/link/phones/take": {
      if (method !== "POST") return yield* json(405, {});
      const given = parsed(request.body);
      if (!isObject(given) || !Array.isArray(given.phones ?? []) || !Array.isArray(given.removed ?? [])) return yield* json(400, { message: "Send {phones, removed}." });
      updateLink(link => takeMacDocuments(takePhones(link ?? { phones: [] }, given), given.documents));
      macLink.wake?.();
      macDocsChanged();
      return yield* json(200, macPhones());
    }
    case "kuvo/link/peers": {
      if (method !== "PUT") return yield* json(405, {});
      let gone = [];
      const changed = updateLink(link => {
        const made = setMacPeers(link ?? { phones: [] }, parsed(request.body));
        gone = made.gone;
        return made.link;
      });
      if (!changed) return yield* json(400, { message: "Send {peers: [{key, sign, address, name, id}], moved}." });
      macDocsChanged();
      tellGone(gone);
      return yield* json(200, {});
    }
    case "kuvo/link/setup": {
      // What setting up a machine over SSH gives it: this Mac's key, the key its documents are
      // signed with, its own documents as they are now and those it keeps of your machines.
      if (method !== "GET") return yield* json(405, {});
      await macKeys();
      // `?key=`: a machine set up again, no longer one this Mac removed.
      const again = new URLSearchParams(String(request.path ?? "").split("?")[1] ?? "").get("key");
      const library = readPersonalities();
      let docs = [];
      const link = updateLink(link => {
        if (!link?.sign) return null;
        if (again && Array.isArray(link.left)) link.left = link.left.filter(key => key !== again);
        const own = ownDocs({ link, library });
        docs = [...Object.values(own).map(made => made.envelope), ...Object.values(link.docs ?? {}).sort((a, b) => (a.d < b.d ? -1 : 1))];
        return link;
      });
      if (!link) return yield* json(503, { message: "This Mac's link has no keys yet." });
      return yield* json(200, { mac: ownKey(link), macSign: ownSign(link), docs });
    }
    case "kuvo/link/docs": {
      // Documents a machine gave as it was set up (over SSH): taken as if they'd come by mail.
      if (method !== "POST") return yield* json(405, {});
      const given = parsed(request.body);
      const sender = peersOf(readLink()).find(peer => peer.key === given?.from);
      if (!sender || !isObject(given.docs)) return yield* json(404, { message: "That isn't one of this Mac's machines." });
      await receiveDocs(sender, given.docs, macLink.host);
      return yield* json(200, {});
    }
    case "kuvo/link/documents": {
      // This Mac's documents, its own brought up to date first, and its digest (what its agents'
      // mail carries, so a machine that missed one gets it).
      if (method !== "GET") return yield* json(405, {});
      const library = readPersonalities();
      updateLink(link => {
        if (!link?.sign) return null;
        const before = JSON.stringify(link.own ?? {});
        ownDocs({ link, library });
        return JSON.stringify(link.own ?? {}) === before ? null : link;
      });
      const link = readLink();
      return yield* json(200, { ...macPhones().documents, have: link?.sign ? digestOf(link) : [] });
    }
    case "kuvo/link/letters": {
      // A letter from one of this Mac's conversations for an agent on another of your computers
      // (`peer`, its key), left in the outbox as a machine's tool leaves one: sent now, and each
      // minute until it's there; with `wait`, its answer, for as long as this is asked.
      if (method !== "POST") return yield* json(405, {});
      const given = parsed(request.body);
      const link = readLink();
      const peer = peersOf(link).find(each => each.key === given?.peer);
      const from = typeof given?.from === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(given.from) ? given.from : null;
      if (!isObject(given) || typeof given.to !== "string" || !/^ses_[A-Za-z0-9]{1,60}$/.test(given.to) || typeof given.text !== "string" || !given.text.trim()) {
        return yield* json(400, { message: "Send {peer, to, text}, and from, wait." });
      }
      if (!peer) return yield* json(404, { message: "That isn't one of this Mac's computers." });
      const id = "ltr_" + crypto.randomBytes(16).toString("base64url");
      // Off the relay now: it goes once this Mac's back on it, and its answer can't be waited for.
      const online = Boolean(macLink.host?.welcomed);
      const wait = given.wait === true && Boolean(from) && online;
      try {
        fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
        writePrivate(path.join(SENDING, `${id}.json`), JSON.stringify({ from, to: given.to, text: cutText(given.text), wait, at: Date.now(), peer: peer.key }));
      } catch {
        return yield* json(500, { message: "This Mac's box couldn't keep it." });
      }
      if (!wait) {
        macSendOutbox();
        return yield* json(200, given.wait === true && from && !online ? { id, note: OFFLINE_LETTER } : { id });
      }
      // Waited for: a line once it's kept (so a request cut off after it knows it went), then one
      // with how it went.
      const answer = macLetterAnswer(id, signal);
      macSendOutbox();
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      yield { body: Buffer.from(JSON.stringify({ id }) + "\n") };
      yield { body: Buffer.from(JSON.stringify(await answer) + "\n") };
      return;
    }
    // COMPAT(beta.1 mac-letters): the letters an earlier Kuvo Code kept (`agent-letters.json`), into the outbox. Goes 3 months after 0.8.0.
    case "kuvo/link/letters/take": {
      // What an earlier Kuvo Code kept itself (PhoneLink, before this Mac's box took its peers): its
      // letters on their way, and the letters it had delivered (so one sent again isn't twice).
      if (method !== "POST") return yield* json(405, {});
      const given = parsed(request.body);
      if (!isObject(given)) return yield* json(400, { message: "Send {letters, seen}." });
      const now = Date.now();
      try {
        fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
        for (const letter of Array.isArray(given.letters) ? given.letters.slice(0, 500) : []) {
          if (!isObject(letter) || !LETTER_ID.test(letter.id ?? "") || typeof letter.to !== "string" || typeof letter.text !== "string" || typeof letter.peer !== "string") continue;
          const kept = { from: typeof letter.from === "string" ? letter.from : null, to: letter.to, text: cutText(letter.text), wait: false,
            at: typeof letter.at === "number" ? letter.at : now, peer: letter.peer, ...(typeof letter.answers === "string" ? { answers: letter.answers } : {}) };
          writePrivate(path.join(SENDING, `${letter.id}.json`), JSON.stringify(kept));
        }
        if (isObject(given.seen)) {
          locked(PEER_LOCK, () => {
            const seen = lettersSeen(now);
            for (const [id, at] of Object.entries(given.seen)) if (LETTER_ID.test(id) && typeof at === "number" && now - at < LETTER_MEMORY) seen[id] = Math.max(seen[id] ?? 0, at);
            writePrivate(LETTERS_SEEN, JSON.stringify(seen));
          });
        }
      } catch {
        return yield* json(500, { message: "This Mac's box couldn't keep them." });
      }
      macSendOutbox();
      return yield* json(200, {});
    }
    case "kuvo/link/agents/refresh": {
      // The list of everyone made again from this Mac's conversations as they are now (one made a
      // moment ago), before a group chat here names someone with &.
      if (method !== "POST") return yield* json(405, {});
      await refreshOwn(readEngineFile).catch(() => {});
      return yield* json(200, {});
    }
    case "kuvo/link/agents": {
      // The agents your other computers told this Mac of, by computer (its key, and its id here).
      if (method !== "GET") return yield* json(405, {});
      const link = readLink();
      const told = readPeerAgents(undefined, undefined, link);
      return yield* json(200, { peers: peersOf(link).map(peer => ({ key: peer.key, id: peer.id ?? null, at: told[peer.key]?.at ?? 0,
        list: told[peer.key]?.list ?? [], features: told[peer.key]?.features ?? [] })) });
    }
    default:
      return yield* json(404, {});
  }
}

// This Mac's notices for your phones (PROTOCOL.md, "kuvo/attention"): held a little while you're at
// a computer (the app says when, as "mac"), then sealed here for each paired phone that's said where
// it is and pushed on the link's connection; kept for a box that starts again, as a machine's are.
// `clock`: a test's own (NoticeHold's `now`, `setTimer`, `clearTimer`).
export function macNoticeHold(clock = {}) {
  let held = [];
  try { held = JSON.parse(fs.readFileSync(HELD_FILE, "utf8")); } catch {}
  return new NoticeHold({
    ...clock,
    send: notice => {
      const link = readLink();
      const phones = (link?.phones ?? []).filter(phone => phone.address);
      // Not told yet whether the phone link's on (the app hasn't said, as it starts): held.
      if (!macLink.config) return false;
      if (!phones.length || !macLink.config.phones) return true;
      const host = macLink.host;
      if (!host?.welcomed || !link?.key) return false;
      const json = noticeJSON(notice);
      const key = Buffer.from(link.key, "base64url");
      // Gone out to one at least, or held to try again (a connection closing as it's sent).
      let sent = 0;
      for (const phone of phones) {
        try { if (host.send(pushTo(phone, json, key))) sent += 1; } catch {}
      }
      return sent > 0;
    },
    held,
    save: entries => {
      try {
        if (entries.length) writePrivate(HELD_FILE, JSON.stringify(entries));
        else fs.rmSync(HELD_FILE, { force: true });
      } catch {}
    },
  });
}

// A notice of this Mac's for your phones (its news, its app's own asks): held and sent while the
// phone link's on, or until its app says whether it is (as it starts); none while it's off.
export function macTell(notice) {
  // Off: let go now, so turning it on later never sends what came while it was off.
  if (!macLink.hold || (macLink.config && !macLink.config.phones)) return true;
  return macLink.hold.tell(notice);
}

// This Mac's box's link: up while it's wanted, its keys from the app, your phones answered here,
// what's the app's yet passed to it. Nothing it meets (the relay gone, a frame that isn't one, the
// app away) stops the box's own routes.
export async function runMacLink() {
  let attempt = 0;
  macLink.stopped = false;
  while (!macLink.stopped) {
    try {
      const config = macLink.config;
      // Its keys as soon as it's on (a pairing link needs them before any phone's paired).
      if (!(await macKeys())) {
        await macLinkWait(30_000);
        continue;
      }
      if (macLink.stopped) break;
      if (!macNeeded(readLink())) {
        setLinkStatus("off");
        attempt = 0;
        await macLinkWait(60_000);
        continue;
      }
      const link = readLink();
      setLinkStatus("connecting");
      let engine = {};
      try { engine = readEngineFile(); } catch {}
      const host = new LinkHost({
        key: Buffer.from(link.key, "base64url"),
        hello: { v: 1, kind: "mac", name: config.name, app: config.app, engine: engine.version ?? null },
        // Phones only while the phone link's on (the relay can be up for your machines alone).
        authorize: (key, hello, address) => Boolean(macLink.config?.phones) && authorizePhone(key, hello, address),
        confirmed: confirmPhone,
        // Mail from your machines, taken here as a machine takes it (`peerMail`).
        mail: (_from, body) => receiveMail(body, host, (sender, payload) => peerMail(sender, payload, host, peerTargets)),
        handle: macFront(engineHandler(readEngineFile, { name: config.name }, readBridgeFile, changed => host.keepOnly(new Set((changed.phones ?? []).map(phone => phone.key))), macLink.hold)),
        connect: engineConnect(readEngineFile),
        send: () => {},
      });
      macLink.host = host;
      // A pairing can run out while it's up: looked at now and then.
      const looking = setInterval(macLinkCheck, 30_000);
      const started = Date.now();
      const welcomed = await connectOnce(link.relay, Buffer.from(link.secret, "base64url"), host, () => {
        setLinkStatus("connected");
        // Meeting your machines: who this Mac's agents are, asking for theirs; this Mac's
        // documents as they are now, and its digest to each; and those removed while it was away
        // hear it.
        announce(host, readEngineFile, undefined, undefined, true).catch(() => {});
        try { docsChanged(host, { greet: true }); } catch {}
        try { tellUntold(); } catch {}
      });
      clearInterval(looking);
      if (macLink.host === host) macLink.host = null;
      if (macLink.stopped) break;
      // Not wanted any more: off now, not after a wait.
      if (!macNeeded(readLink())) {
        setLinkStatus("off");
        attempt = 0;
        continue;
      }
      // Well only once a connection's held a while: one dropped right after its welcome (another
      // copy on the same address, say) backs off as one that never came up does.
      attempt = welcomed && Date.now() - started >= 60_000 ? 0 : attempt + 1;
      if (!welcomed) setLinkStatus("failed", `Can't reach the relay at ${new URL(link.relay).host}.`);
      else setLinkStatus("connecting");
      await macLinkWait(Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)));
    } catch (error) {
      macLink.host = null;
      setLinkStatus("failed", String(error?.message ?? error));
      await macLinkWait(5_000);
    }
  }
  setLinkStatus("off");
}


// This Mac in use, or not any more, as its app says (`kuvo/attention`): each of your machines hears
// it by mail, with what of its own this Mac's notifications showed (`elsewhere`, by its id here), so
// notices for your phones wait a little there too, and one you saw here doesn't go.
function macAttendPeers(body, given) {
  const host = macLink.host;
  const link = readLink();
  if (!host?.welcomed || !link?.key) return;
  const at = Date.now();
  for (const peer of peersOf(link)) {
    const shown = isObject(body?.elsewhere) && Array.isArray(body.elsewhere[peer.id]) ? body.elsewhere[peer.id] : [];
    const theirs = attentionGiven({ for: 0, shown })?.shown ?? [];
    const bytes = mailFor(peer, { attention: { for: given.seconds, sessions: given.sessions, ...(theirs.length ? { shown: theirs } : {}) }, at }, link);
    if (bytes) try { host.send(bytes); } catch {}
  }
}

// This Mac's box's agents and their letters, as a machine's link keeps them (`run`): its own listed
// here, link or not (its group chats name them); told to your other computers, and its letters
// sent, while the link's up; its group chats' mail carried on it.
export function runMacPeers() {
  const stop = new AbortController();
  takeSeatLetters();
  watchSeats(() => macLink.host, stop.signal);
  refreshOwn(readEngineFile).catch(() => {});
  const rounds = [
    setInterval(() => {
      const host = macLink.host;
      if (host?.welcomed) announce(host, readEngineFile).catch(() => {});
      else refreshOwn(readEngineFile).catch(() => {});
    }, 60_000),
    setInterval(macSendOutbox, 3_000),
  ];
  macLink.stopPeers = () => {
    stop.abort();
    for (const round of rounds) clearInterval(round);
  };
}

// Stops them (a test's, as it ends).
export function stopMacPeers() {
  macLink.stopPeers?.();
  macLink.stopPeers = null;
}

// The outbox, sent now while this Mac's box is on the relay (and its letters kept, not sent, while
// it isn't).
function macSendOutbox() {
  const host = macLink.host;
  try { sendOutbox(host?.welcomed ? host : { send() {} }, undefined, Date.now(), host?.welcomed ? 0 : 1); } catch {}
}

// How long one of this Mac's conversations waits for a letter's answer at most.
export const LETTER_WAIT = 660_000;
const OFFLINE_LETTER = "Your other computers can't be reached through the relay now: it goes once this Mac's back on it, and its answer comes to you as a message.";

// The answer to letter `id` (`macWaiting`): its words; or how it went, when it didn't get there or
// its answer can't come; or `{text: null}` once it's waited `most`, or its asker went (`signal`).
// Then it goes on without waiting, and an answer that comes later reaches the conversation as a
// message.
function macLetterAnswer(id, signal, most = LETTER_WAIT) {
  return new Promise(resolve => {
    const waiter = { sentTo: null, gone: () => Boolean(signal?.aborted), done: value => finish(value) };
    const timer = setTimeout(() => finish(null), most);
    const abort = () => finish(null);
    signal?.addEventListener("abort", abort, { once: true });
    function finish(value) {
      if (macWaiting.get(id) !== waiter) return;
      macWaiting.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!value) {
        const file = path.join(SENDING, `${id}.json`);
        try { writePrivate(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), wait: false })); } catch {}
      }
      resolve(value ?? { text: null });
    }
    macWaiting.set(id, waiter);
  });
}

// Group chats' letters an earlier Kuvo Code kept itself (`run/seat-letters.json`, its SeatRelay),
// in the outbox now, as this box carries them.
export function takeSeatLetters(file = path.join(RUN, "seat-letters.json")) {
  let kept;
  try { kept = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  try {
    fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
    for (const [id, letter] of Object.entries(isObject(kept) ? kept : {})) {
      if (!LETTER_ID.test(id) || !isObject(letter) || typeof letter.peer !== "string" || typeof letter.seat !== "string") continue;
      let seat = null;
      try { seat = JSON.parse(Buffer.from(letter.seat, "base64").toString("utf8")); } catch {}
      if (!isObject(seat)) continue;
      writePrivate(path.join(SENDING, `${id}.json`), JSON.stringify({ peer: letter.peer, seat, at: typeof letter.at === "number" ? letter.at : Date.now(),
        ...(typeof letter.sentTo === "string" ? { sentTo: letter.sentTo } : {}), ...(letter.gaveUp === true ? { gaveUp: true } : {}),
        ...(typeof letter.aged === "number" ? { aged: letter.aged } : {}) }));
    }
    fs.rmSync(file, { force: true });
  } catch {}
}

// Stops it (a test's, as it ends): what's open goes, and the loop with it.
export function stopMacLink() {
  macLink.stopped = true;
  macLink.host?.disconnect?.();
  macLink.wake?.();
}

// ---- The relay connection ----


// What the relay sends once it's welcomed this connection, for `host`: something for it, or a phone
// gone (unreachable, or its connection went or was replaced), whose sessions end with nothing more
// sent. What this connection sends itself, to check it's alive, is only that.
export function fromRelay(host, message, self) {
  if (message.address.equals(self)) return;
  if (message.kind === "deliver") host.receive(message.address, message.payload);
  if (message.kind === "unreachable" || message.kind === "gone") host.forget(message.address);
}

// What a machine's link does once the relay's welcomed it: your other computers hear who's here,
// and it tells who's there; a new bridge an update put here says it's well.
function machineWelcomed(host) {
  announce(host, readEngineFile, undefined, undefined, true).catch(() => {});
  try { docsChanged(host, { greet: true }); } catch {}
  try { confirmUpdate(); } catch {}
}

// Connects once, serves until the connection ends (or `host.disconnect()`). Resolves whether it got
// as far as welcome. `onWelcome(host)`: what's done then.
export function connectOnce(relay, secret, host, onWelcome = machineWelcomed) {
  return new Promise(resolve => {
    const self = addressOf(secret);
    let welcomed = false;
    let lastHeard = Date.now();
    const socket = new WebSocket(relay);
    socket.binaryType = "arraybuffer";
    // Something sent to ourselves comes back through the relay: that shows the connection's
    // alive, where WebSocket pings can't be seen from here.
    const check = setInterval(() => {
      if (Date.now() - lastHeard > 90_000) return finish();
      if (welcomed) socket.send(relaySend(self, EMPTY));
    }, 30_000);
    // Once, however it ends: Node's WebSocket reports a refused connection as an error alone,
    // with no close to follow, and one that never opens has to be given up on.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(check);
      clearTimeout(opening);
      try { socket.close(); } catch {}
      host.reset();
      host.send = () => {};
      host.welcomed = false;
      resolve(welcomed);
    };
    const opening = setTimeout(() => { if (!welcomed) finish(); }, 15_000);
    host.disconnect = finish;
    // What's queued for the relay and not sent yet (a push, as the app quits).
    host.unsent = () => (finished ? 0 : socket.bufferedAmount ?? 0);
    socket.onopen = () => socket.send(relayHello(secret));
    socket.onmessage = event => {
      lastHeard = Date.now();
      const message = readRelay(Buffer.from(event.data));
      if (!message) return;
      if (!welcomed) {
        if (message.kind !== "welcome" || !message.address.equals(self)) return socket.close();
        welcomed = true;
        // Whether it went out (a connection that's closing takes nothing).
        host.send = bytes => {
          if (socket.readyState !== 1) return false;
          socket.send(bytes);
          return true;
        };
        host.welcomed = true;
        try { onWelcome(host); } catch {}
        return;
      }
      fromRelay(host, message, self);
    };
    socket.onerror = finish;
    socket.onclose = finish;
  });
}

// (Whether a process is alive, and runs what it should: `alive` and `runs`, ../shared/platform.)

// Another bridge.
const isBridge = pid => pid !== process.pid && runs(pid, "kuvo-link.js");

// The box's keeper (`bin/kuvo-start`), started again if it went: it keeps the engine and this
// bridge running.
export function keepKeeper() {
  let start = path.join(K, "bin", "kuvo-start");
  if (!fs.existsSync(start)) return;
  // COMPAT(0.7 keeper): the keeper started from its own copy (`bin/.kuvo-start-keeper`) when an older Mac's kuvo-start has no `keep)`. Goes 3 months after 0.8.0.
  // An older Kuvo Code on a Mac (0.7 and before) put its own kuvo-start here, which only starts
  // the engine after a restart: the box's keeper, from the copy it keeps of itself (which puts
  // itself back).
  const copy = path.join(K, "bin", ".kuvo-start-keeper");
  if (!/\nkeep\)/.test(textOf(start) ?? "") && fs.existsSync(copy)) start = copy;
  let keeper = null;
  try { keeper = Number(fs.readFileSync(path.join(RUN, "box.pid"), "utf8")); } catch {}
  if (keeper && runs(keeper, "kuvo-start")) return;
  const environment = { ...process.env };
  delete environment.BUN_BE_BUN;
  delete environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  try {
    spawn("sh", [start], { cwd: K, env: environment, detached: true, stdio: "ignore" }).unref();
  } catch {}
}


async function run() {
  // One bridge at a time: a newer one (the engine restarted) takes over.
  let old = null;
  try {
    old = Number(fs.readFileSync(PID_FILE, "utf8"));
    if (isBridge(old)) process.kill(old, "SIGTERM");
  } catch {}
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
  fs.writeFileSync(VERSION_FILE, BRIDGE_VERSION, { mode: 0o600 });
  // COMPAT(beta.1 connected): `run/connected` (beta.1) and `run/present` (0.7 with the phone link on), cleared. Goes when 0.8.0 ships.
  // The notes an earlier Kuvo Code on a Mac left that it was connected (it did some of the box's
  // work then): nothing reads them now.
  for (const folder of ["present", "connected"]) fs.rmSync(path.join(RUN, folder), { recursive: true, force: true });
  // Its bots' jobs kept in their folders, taken once from where they were before.
  try { keepJobs(); } catch {}
  forgetOldKit();
  // Its bots' folders' settings, as its integrations are now (after an update, say).
  await refreshBotsKeys().catch(() => {});
  // A link from an earlier bridge: its signing key made, and kept as this one keeps it.
  updateLink(link => {
    if (!link) return null;
    link.sign ??= newSigningSeed();
    foldPhones(link);
    return link;
  });
  const cleanUp = () => {
    try { if (fs.readFileSync(PID_FILE, "utf8") === String(process.pid)) fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", cleanUp);
  process.on("SIGINT", cleanUp);

  // Stops when nothing's paired any more, or when another bridge took over; up while the engine
  // is down too, so a phone can start it. Phones removed since lose what they have open, and the
  // box's keeper, if it went, starts again (it keeps this bridge, and the engine, running).
  let current = null;
  setInterval(() => {
    let owner = null;
    try { owner = Number(fs.readFileSync(PID_FILE, "utf8")); } catch {}
    const link = readLink();
    if (!needed(link)) {
      forgetPhones();
      noLongerNeeded();
    }
    if (!needed(link) || owner !== process.pid) return cleanUp();
    current?.keepOnly(new Set((link.phones ?? []).map(phone => phone.key)));
    keepKeeper();
  }, 30_000);

  // Your phones' notifications, on whichever relay connection is up: the engine's news, and what
  // agents ask for as they browse.
  // False when it can't go now (the relay isn't there), to be tried again.
  const tellPhones = notice => {
    const link = readLink();
    const phones = (link?.phones ?? []).filter(phone => phone.address);
    if (!phones.length) return true;
    if (!current?.welcomed || !link?.key) return false;
    const json = noticeJSON(notice);
    const key = Buffer.from(link.key, "base64url");
    let sent = false;
    for (const phone of phones) {
      try {
        current.send(pushTo(phone, json, key));
        sent = true;
      } catch {}
    }
    return sent;
  };
  // Each held a little while a client's in use here (PROTOCOL.md, "kuvo/attention"); what's held
  // is kept in run/held-notices.json, for the next bridge to send if this one stops first: read
  // once the one before has gone (a few seconds at most), so it neither sends nor holds one more.
  for (let tries = 0; tries < 60 && old && isBridge(old); tries++) await sleep(50);
  let held = [];
  try { held = JSON.parse(fs.readFileSync(HELD_FILE, "utf8")); } catch {}
  const hold = new NoticeHold({
    send: tellPhones,
    held,
    save: entries => {
      try {
        if (entries.length) writePrivate(HELD_FILE, JSON.stringify(entries));
        else fs.rmSync(HELD_FILE, { force: true });
      } catch {}
    },
  });
  const tell = notice => hold.tell(notice);
  const answered = id => hold.resolve(id);
  // Its engine and the coding agents here (their sessions, and group chats that live here),
  // through their bridge.
  watchBox({ tell, hold });
  // What its group chats send your other computers, carried on the relay connection that's up.
  watchSeats(() => current);
  watchAsks(tell, { answered });
  // Your other computers: this box's agents told to them while the relay connection is up (and
  // listed here, relay or not), and its agents' letters sent; without the relay a while, those
  // not sent yet go to the Mac.
  let lastWelcomed = Date.now();
  refreshOwn(readEngineFile).catch(() => {});
  // Updates: the new bridge, once one put it here, says it's well (after the relay's welcome, or
  // three minutes); each night's window, one, when nothing runs (PROTOCOL.md, "Updates").
  setTimeout(() => { try { confirmUpdate(); } catch {} }, 180_000);
  const nightly = () => {
    noteLauncher();
    noteOlderMacs();
    try { checkDrift(); } catch {}
    const night = updateNight();
    if (!night || updateState().night === night || !UPDATE_KEYS.length) return;
    startUpdate({})?.then(outcome => { if (outcome && outcome.result !== "busy") noteUpdate({ night }); });
  };
  setTimeout(nightly, 60_000);
  setInterval(nightly, 600_000);
  // Recently Deleted's skills past their 30 days, gone with no client there too.
  keepSkillTrashClear();
  setInterval(() => {
    if (current?.welcomed) announce(current, readEngineFile).catch(() => {});
    else refreshOwn(readEngineFile).catch(() => {});
  }, 60_000);
  setInterval(() => {
    if (current?.welcomed && docsNoted()) try { docsChanged(current, { tell: true }); } catch {}
    if (current?.welcomed) lastWelcomed = Date.now();
    try { sendOutbox(current ?? { send() {} }, undefined, Date.now(), current?.welcomed ? 0 : Date.now() - lastWelcomed); } catch {}
    deliverLeftAnswers().catch(() => {});
  }, 3_000);

  let attempt = 0;
  while (true) {
    const link = readLink();
    if (!needed(link)) {
      forgetPhones();
      noLongerNeeded();
      return cleanUp();
    }
    let engine = {};
    try { engine = readEngineFile(); } catch {}
    const host = new LinkHost({
      key: Buffer.from(link.key, "base64url"),
      hello: { v: 1, kind: "machine", name: link.name || os.hostname(), app: BRIDGE_VERSION, engine: engine.version ?? null },
      authorize: authorizePhone,
      confirmed: confirmPhone,
      mail: (_from, body) => receiveMail(body, host, (sender, payload) => peerMail(sender, payload, host, peerTargets), (mac, given, at) => hold.attend(`mac:${mac}`, given, at)),
      handle: engineHandler(readEngineFile, { name: link.name || os.hostname() }, readBridgeFile, changed => host.keepOnly(new Set((changed.phones ?? []).map(phone => phone.key))), hold),
      connect: engineConnect(readEngineFile),
      send: () => {},
    });
    current = host;
    const welcomed = await connectOnce(link.relay, Buffer.from(link.secret, "base64url"), host);
    attempt = welcomed ? 0 : attempt + 1;
    await sleep(Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)));
  }
}

function runningBridge() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8"));
    return isBridge(pid) ? pid : null;
  } catch {
    return null;
  }
}

// Starts the bridge on its own, outliving this command, from the machine's workspace.
function startBridge() {
  const workspace = path.join(K, "workspace");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run"], {
    detached: true,
    stdio: "ignore",
    cwd: fs.existsSync(workspace) ? workspace : K,
    env: process.env,
  });
  child.unref();
}

// What the Mac sends: the relay, this machine's name, and the phones you've paired with the Mac,
// which may reach it directly. Keeps the machine's own keys (made the first time, and never
// leaving it) and phones paired with the machine itself, starts the bridge or restarts it (on
// another relay, or a newer one), and prints the machine's address and public key for the Mac
// to tell your phones. Nothing left to answer: the bridge stops, and the keys stay.
// `kuvo-link.js box <command>`: a Mac's way to a machine's own settings, over SSH, the same way a
// phone's goes (one answer, JSON, on stdout). `adopt` (a seed on stdin), `read`, `change`
// ({changes} on stdin), `key <name>` (its value on stdin; none removes it), `route` (a request,
// {method, path, body?}, answered as a phone's is: {status, body}), `bot-keys-refresh`.
async function box(command) {
  const input = async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  };
  const say = value => console.log(JSON.stringify(value));
  switch (command) {
    // COMPAT(0.7 settings): `box adopt`, which a Mac runs over SSH. Goes 3 months after 0.8.0.
    case "adopt": {
      let seed = null;
      try { seed = JSON.parse((await input()) || "null"); } catch {}
      return say(adoptBox(seed));
    }
    // COMPAT(beta.1 box-read-change): `box read` and `box change`, which beta.1 runs over SSH (`box route` took their place). Goes when 0.8.0 ships.
    case "read": {
      const { settings, problem } = readSettings();
      return say(problem ? { status: 409, message: problem } : { status: 200, settings, own: ownsSettings() });
    }
    case "change": {
      let given = {};
      try { given = JSON.parse(await input()); } catch {}
      return say(ownsSettings() ? changeSettings(given?.changes) : { status: 409, message: "This machine's settings aren't its own yet." });
    }
    case "key": {
      const name = process.argv[4];
      const value = await input();
      return say(setBoxKey(name, value.length ? value : null));
    }
    case "update-status":
      return say({ status: 200, ...updateStatus() });
    case "update-now": {
      // On its own, outliving this command: what it does shows in update-status.
      if (!UPDATE_KEYS.length) return say({ status: 409, message: "Updates aren't set up for this machine yet." });
      const blocked = updatesBlocked();
      if (blocked) return say({ status: 409, message: blocked });
      if (isUpdating()) return say({ status: 409, message: "It's updating already." });
      spawn(process.execPath, [fileURLToPath(import.meta.url), "update", "--now"], { detached: true, stdio: "ignore", cwd: K, env: process.env }).unref();
      return say({ status: 202, ...updateStatus(), updating: "checking" });
    }
    case "route": {
      // A client's request, answered as the bridge answers a phone's: one that answers once,
      // never a stream that follows.
      answerOnce();
      let given = {};
      try { given = JSON.parse(await input()); } catch {}
      const handle = engineHandler(readEngineFile, { name: os.hostname() });
      const request = { method: String(given?.method ?? "GET"), path: String(given?.path ?? ""), headers: { "content-type": "application/json" }, body: Buffer.from(given?.body === undefined ? "" : JSON.stringify(given.body)) };
      let status = 502;
      const chunks = [];
      for await (const part of handle(request, {}, undefined)) {
        if (part.head) status = part.head.status;
        if (part.body) chunks.push(Buffer.from(part.body));
      }
      return say({ status, body: Buffer.concat(chunks).toString("utf8") });
    }
    case "reconnect": {
      // An integration's server connected again everywhere, a moment after `route` changed its
      // keys, once the engine has read them.
      const id = process.argv[4];
      await new Promise(done => setTimeout(done, 2_000));
      let engine;
      try { engine = readEngineFile(); } catch { return; }
      if (id) await reconnectEverywhere(engine, id);
      return;
    }
    case "bot-keys-refresh":
      // Its bots' folders' settings as their keys and this machine's integrations are now.
      await refreshBotsKeys();
      return say({ status: 200 });
    case "personalities": {
      // A Mac's copy met with this one's: both end up as one, and the bridge tells your other
      // computers if this one changed.
      let given = null;
      try { given = JSON.parse((await input()) || "null"); } catch {}
      const before = JSON.stringify(readPersonalities());
      const met = changePersonalities(library => mergePersonalities(library, given));
      if (JSON.stringify(met) !== before) noteDocsChanged();
      return say({ status: 200, ...met });
    }
    default:
      console.error("Usage: kuvo-link.js box adopt | read | change | key <name> | route | reconnect <server> | bot-keys-refresh | personalities | update-status | update-now");
      process.exit(2);
  }
}

// `serve`: this box's routes over HTTP, for a Mac, whose app starts its own box as it starts the
// coding agents' bridge: on 127.0.0.1, `{"url"}` said once it listens, answering only with the
// password in OPENCODE_PASSWORD, and gone when its stdin closes, so it never outlives the app. The
// same routes as a phone's through the relay, the path checked the same way; a stream goes as it
// comes, and stops when the client goes. The engine and the agents' bridge are found as on a
// machine (`run/engine.json`, `run/bridge.json`), which the app writes.
export function serveBox(password, handle = engineHandler(readEngineFile, { name: os.hostname() })) {
  const expected = Buffer.from("Basic " + Buffer.from(`opencode:${password}`).toString("base64"));
  return http.createServer(async (request, response) => {
    const given = Buffer.from(request.headers.authorization ?? "");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      response.writeHead(401);
      return response.end();
    }
    const sent = canonicalPath((request.url ?? "").replace(/^\/+/, ""));
    if (sent === null) {
      response.writeHead(403);
      return response.end();
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    let headed = false;
    try {
      // The app's own (the Mac's link says which aren't a phone's), not a phone using this box.
      const fromApp = request.headers["x-kuvo-from"] === "app";
      for await (const part of handle({ method: request.method ?? "GET", path: sent, headers: request.headers, body: Buffer.concat(chunks), fromApp }, {}, abort.signal)) {
        if (abort.signal.aborted) break;
        if (part.head && !headed) {
          response.writeHead(part.head.status, part.head.headers ?? {});
          response.flushHeaders();
          headed = true;
        }
        if (part.body) response.write(part.body);
      }
    } catch (error) {
      if (!headed) {
        response.writeHead(500, { "content-type": "application/json" });
        response.write(JSON.stringify({ message: String(error?.message ?? error) }));
        headed = true;
      }
    }
    if (!headed) response.writeHead(502);
    response.end();
  });
}

async function serve() {
  const password = process.env.OPENCODE_PASSWORD;
  if (!password) {
    console.error("serve answers only with a password: set OPENCODE_PASSWORD.");
    process.exit(2);
  }
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  // This Mac's settings with what its engine starts with, before a client reads them.
  if (IS_MAC) addMacDefaults();
  // This Mac's notices for your phones, held while you're at a computer, as a machine's are.
  if (IS_MAC) macLink.hold = macNoticeHold();
  const server = serveBox(password, engineHandler(readEngineFile, { name: os.hostname() }, readBridgeFile, () => {}, macLink.hold));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
  // Its bots' folders' settings, as its keys and integrations are now (after an update, say), as a
  // machine's bridge does as it starts; where its keys can't be reached yet, they stay as they were.
  refreshBotsKeys().catch(() => {});
  // Keys of bots deleted while they couldn't be reached.
  forgetLeftKeys().catch(() => {});
  // Its wake-ups and watches, sent while it runs, with the app's window closed too.
  sendWakes();
  // This Mac's link to your phones and machines, once its app says it's wanted.
  if (IS_MAC) runMacLink().catch(() => {});
  // Its agents and their letters, and its group chats' mail, for your other computers. (Not for
  // the app's route scenarios, `KUVO_TEST_NO_PEERS`, whose fixture tells its bridge who they are.)
  // Never the real app's box (`run.kuvo.code/box`).
  const testsAlone = process.env.KUVO_TEST_NO_PEERS && path.basename(path.dirname(path.resolve(K))) !== "run.kuvo.code";
  if (IS_MAC && !testsAlone) runMacPeers();
  // Recently Deleted's skills past their 30 days, gone with no client there too.
  keepSkillTrashClear();
  // Its bots' jobs kept in their folders, taken once from where they were before, once its app
  // makes them this box's (it gives the box its kit then).
  if (readKit()) try { keepJobs(); } catch {}
  // Its bots kept told what they are as their runs start, on the engine and with the coding agents;
  // on a Mac, its news for your phones too (while the phone link's on), and its sign-ins that ended.
  watchBox({ tell: macTell, hold: macLink.hold, bots: true, notices: IS_MAC });
  // Its app gone (its stdin closed): so is it, once what its link has queued for the relay is out
  // (a notice sent as the app quit), a moment at most.
  const leave = async () => {
    for (let tries = 0; tries < 30 && (macLink.host?.unsent?.() ?? 0) > 0; tries++) await sleep(50);
    // What didn't get out in time isn't lost without a word.
    if ((macLink.host?.unsent?.() ?? 0) > 0) console.error("Kuvo Code quit before what its link had for your phones and machines went out.");
    process.exit(0);
  };
  process.stdin.on("end", leave);
  process.stdin.on("close", leave);
  process.stdin.resume();
}

async function setup() {
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    console.error("setup takes JSON on stdin: {relay, name, mac, macSign, docs: [{d, s}], id, …}");
    process.exit(2);
  }
  const mac = typeof input.mac === "string" ? input.mac : undefined;
  const running = runningBridge();
  const old = readLink();
  const before = readPersonalities();
  let link = null, work = null, library = before;
  updateLink(current => {
    const next = current ?? { secret: crypto.randomBytes(32).toString("base64url"), key: newKey().toString("base64url"), phones: [] };
    next.sign ??= newSigningSeed();
    if (mac) {
      next.mac = mac;
      next.macs = [...new Set([...macsOf(next), mac])];
      forgetOldMacs(next, mac);
      // The key its documents are signed with (over SSH, so this box knows it's that Mac's), which
      // takes the place of a list it gave before it signed them.
      if (typeof input.macSign === "string" && SIGN.test(input.macSign)) {
        next.macSigns = { ...(next.macSigns ?? {}), [mac]: input.macSign };
        if (next.legacy) delete next.legacy[mac];
      } else if (Array.isArray(input.peers)) {
        // COMPAT(beta.1 peers-list): the list of peers a beta.1 Mac's setup gives. Goes when 0.8.0 ships.
        // A Mac that signs none yet (0.8.0-beta.1): its peers as it lists them.
        takeLegacyPeers(next, mac, input.peers, typeof input.peersAt === "number" ? input.peersAt : (typeof input.at === "number" ? input.at : 0), input.moved);
      }
    }
    if (typeof input.id === "string") next.id = input.id.slice(0, 200);
    // COMPAT(0.7 visits): a Mac that doesn't say it `tolerates` newer boxes holds updates back. Goes 3 months after 0.8.0.
    // Whether this Mac leaves a newer box as it is, by its ID (as its engine launches name it): the
    // box updates itself only while every Mac that started its engine lately does (PROTOCOL.md, "Updates").
    if (typeof input.macID === "string" && /^[A-Za-z0-9-]{1,100}$/.test(input.macID)) next.tolerantIDs = { ...(next.tolerantIDs ?? {}), [input.macID]: input.tolerates === 1 };
    // Its documents, and those it carries of your other computers: taken as any are.
    const state = { link: next, library: before };
    // (The Mac setting it up wants it: a removal it signed before never counts here now.)
    work = docsWork(state, { key: mac ?? "", sign: mac ? macSign(next, mac) : undefined }, { give: Array.isArray(input.docs) ? input.docs : [] }, { stay: mac ?? null });
    library = state.library;
    if (!next.phones.length && !peersOf(next).length) return current ? next : null;
    next.relay = String(input.relay);
    next.name = String(input.name || next.name || os.hostname()).slice(0, 100);
    link = next;
    return next;
  });
  if (work && library !== before) await takePersonalities(library).catch(() => {});
  // The running bridge tells your other computers what changed.
  noteDocsChanged();
  // None paired any more (each removed for good, as one at a time would be): no bridge.
  if (!link) {
    if (running) process.kill(running, "SIGTERM");
    forgetPhones();
    console.log("{}");
    return;
  }
  // A new relay or name needs a new connection, and a newer bridge replaces an older one.
  let runningVersion = null;
  try { runningVersion = fs.readFileSync(VERSION_FILE, "utf8").trim(); } catch {}
  const restart = old?.relay !== link.relay || old?.name !== link.name || runningVersion !== BRIDGE_VERSION;
  // Not while the box updates itself: the bridge running it would end, and the keeper starts the
  // new one once it's done.
  if (!isUpdating()) {
    if (running && restart) process.kill(running, "SIGTERM");
    if (!running || restart) startBridge();
  }
  console.log(JSON.stringify({
    address: addressOf(Buffer.from(link.secret, "base64url")).toString("base64url"),
    key: publicOf(Buffer.from(link.key, "base64url")).toString("base64url"),
    // Talks to other boxes itself (PROTOCOL.md, "Peers").
    peers: true,
    // Its signing key, and the documents it has, for the Mac to take (PROTOCOL.md, "Documents").
    sign: ownSign(link),
    docs: setupDocs(link),
  }));
}

// What setup gives back of documents: those this box keeps, and its own as they are now.
function setupDocs(link) {
  const state = { link, library: readPersonalities() };
  const own = ownDocs(state);
  return [...Object.values(link.docs ?? {}), ...Object.values(own).map(each => each.envelope)];
}

// `leave <mac>`: Mac `mac` removed this machine. It's no longer one of its Macs: its lists of
// peers and phones no longer count here, and what peers only it named told goes. Another Mac's
// stay; with no peers or phones left, the bridge stops.
export function leave(mac) {
  if (typeof mac !== "string" || !KEY.test(mac)) return false;
  const link = updateLink(link => {
    if (!link || !macsOf(link).includes(mac)) return null;
    leaveMac(link, mac);
    pruneDocs(link);
    foldPhones(link);
    return link;
  });
  if (!link) return false;
  forgetMacsAgents(mac, link);
  noteDocsChanged();
  return true;
}


// A pairing's token, good once, for `PAIRING_MINUTES`.
const newPairingToken = () => ({ token: crypto.randomBytes(16).toString("base64url"), expires: Date.now() + PAIRING_MINUTES * 60_000 });

// The link a phone pairs with, for `link`'s pairing.
export function pairingLink(link) {
  const query = new URLSearchParams({
    v: "1",
    relay: link.relay,
    host: addressOf(Buffer.from(link.secret, "base64url")).toString("base64url"),
    key: publicOf(Buffer.from(link.key, "base64url")).toString("base64url"),
    token: link.pairing.token,
    name: link.name,
  });
  return `kuvo-link://pair?${query}`;
}

function pair(relay) {
  const link = updateLink(current => {
    const next = current ?? { secret: crypto.randomBytes(32).toString("base64url"), key: newKey().toString("base64url"), name: os.hostname(), phones: [] };
    next.sign ??= newSigningSeed();
    if (relay) next.relay = relay;
    if (!next.relay) return null;
    next.pairing = newPairingToken();
    return next;
  });
  if (!link) {
    console.error("Give the relay's address: kuvo-link.js pair wss://…");
    process.exit(1);
  }
  console.log(pairingLink(link));
  console.error(`Open this link on your phone within ${PAIRING_MINUTES} minutes. It works once.`);
  if (!runningBridge()) startBridge();
}

// Checks this runtime has what the link needs, both ends of a session and a mail.
export function selftest() {
  const phone = newKey(), host = newKey();
  const initiator = new IKInitiator(phone, publicOf(host), PROLOGUE);
  const responder = new IKResponder(host, PROLOGUE);
  const said = responder.readMessage1(initiator.writeMessage1(Buffer.from("hello")));
  const { message, transport: hostSide } = responder.writeMessage2(Buffer.from("welcome"));
  const { payload, transport: phoneSide } = initiator.readMessage2(message);
  const echoed = hostSide.open(phoneSide.seal(Buffer.from("ping")));
  const mail = openOneWay(sealOneWay(Buffer.from("mail"), host, publicOf(phone)).message, phone, publicOf(host)).payload;
  const ok = said.toString() === "hello" && payload.toString() === "welcome" && echoed.toString() === "ping" && mail.toString() === "mail"
    && responder.rs.equals(publicOf(phone)) && typeof WebSocket === "function" && typeof fetch === "function";
  return ok;
}

const main = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (main) {
  const [mode, argument] = process.argv.slice(2);
  if (mode === "run") await run();
  else if (mode === "setup") await setup();
  else if (mode === "pair") pair(argument);
  else if (mode === "box") await box(argument);
  else if (mode === "serve") await serve();
  else if (mode === "leave") leave(argument);
  else if (mode === "update") {
    // `update [--now]`, and for a test's folder only, `--url <boxes.json> --key <public key>`. Once
    // it's updated, the running bridge goes, for the keeper to start the new one.
    const args = process.argv.slice(3);
    const option = name => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
    const test = option("--url") && option("--key") && path.resolve(K) !== path.join(os.homedir(), ".kuvo-code");
    const outcome = await update({ now: args.includes("--now"), step: running => noteUpdate({ running }), ...(test ? { url: option("--url"), keys: [option("--key")], blocked: null } : {}) });
    noteUpdate({ running: null, ...(outcome.result === "updated" ? {} : { last: { at: Date.now(), ...outcome } }) });
    if (outcome.result === "updated") {
      const pid = runningBridge();
      if (pid) process.kill(pid, "SIGTERM");
      // No bridge to start again (nothing for it to answer): the new version came up, so it's done.
      if (!needed(readLink())) confirmUpdate();
    }
    console.log(JSON.stringify(outcome));
  }
  else if (mode === "selftest") {
    const ok = selftest();
    console.log(ok ? "ok" : "failed");
    process.exit(ok ? 0 : 1);
  } else {
    console.error("Usage: kuvo-link.js run | serve | setup | pair [relay] | box <command> | leave <mac> | update [--now] | selftest");
    process.exit(2);
  }
}
