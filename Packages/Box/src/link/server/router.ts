// @ts-nocheck
// The box's routes
// What a phone, or this Mac's app, asks of this box: its own areas answered here, the rest passed
// on to the engine or the coding agents' bridge.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FEATURES } from "../../shared/features";
import { isObject, parsed } from "../../shared/json";
import { processRuns as runs } from "../../shared/platform";
import { endedProviders, forgetPlan } from "../areas/accounts";
import { applySettings } from "../areas/apply";
import { answerAsk, askAnswer, inConversation, listedAsk, readAsks } from "../areas/asks";
import { answerBotKeys, refreshBotsKeys } from "../areas/bot-keys";
import { answerKeys } from "../areas/box-keys";
import { carryToAgents } from "../areas/carry";
import { changeSettings, ownsSettings, readSettings } from "../areas/config";
import { engineControl, engineDown, loadSignInReturn, stopShell } from "../areas/engine";
import { fileAt } from "../areas/file";
import { listFolders, makeFolder } from "../areas/folders";
import { forwardGroups, GROUP_ROUTE, groupJSON } from "../areas/groups";
import { answerIntegrations } from "../areas/integrations";
import { addFromCatalog, mcpCatalog } from "../areas/mcp-catalog";
import { searchPlugins } from "../areas/plugins";
import { answerProjects } from "../areas/projects";
import { answerSkills } from "../areas/skills";
import { allWakes, answerWakes, listWakes, wakeFollowers } from "../areas/wakes";
import { readWorktrees, worktreeFollowers } from "../areas/worktree-records";
import { answerWorktrees, worktreesWhere } from "../areas/worktrees";
import { changeBot, deleteBot } from "../bots/edit";
import { botFollowers } from "../bots/here";
import { botTemplates, NO_KIT, readKit } from "../bots/kit";
import { listBots } from "../bots/list";
import { makeBot } from "../bots/make";
import { freshenBots, settleBot } from "../bots/tell";
import { phoneHere } from "../compat/leave-running";
import { noteDocsChanged } from "../documents/changed";
import { readBridgeFile, readEngineFile } from "../engine/client";
import { followed } from "../follow";
import { BOTS, ENGINE_FILE, IS_MAC, K, RUN, SESSION_WAKES } from "../home";
import { KeysUnavailable } from "../host-interface";
import { macTell } from "../mac/notices";
import { macAttendPeers } from "../mac/peers";
import { macLinkRoute } from "../mac/routes";
import { attentionGiven } from "../notices/hold";
import { keepOwn, ownAgents, ownAsLast } from "../peers/agents";
import { readPeerAgents } from "../peers/directory";
import { movedOf, peersOf } from "../peers/known";
import { namedAgents } from "../peers/naming";
import { PERSONALITIES_FILE, personalitiesDocument, personalityFollowers, readPersonalities } from "../personalities/library";
import { answerPersonalities, retellBots, takePersonalitiesDocument } from "../personalities/take";
import { newPairingToken, pairingLink, removeAsMac, removePhones } from "../phones";
import { macLink, readLink, updateLink } from "../state";
import { startUpdate, UPDATE_KEYS, updatesBlocked, updateStatus } from "../updates/update";
import { BRIDGE_VERSION } from "../version";
import { AGENTS, forward } from "./forward";
import { listedAgents, nameMissing, namingHere, refreshOwnShared } from "./naming";
import { agentsAllowed, allowed, REQUEST_HEADERS } from "./paths";

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