// (The command line: what each command does is in the modules beside it, Packages/Box/README.md.)
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plainName } from "../shared/text";
import { sleep } from "../shared/wait";
import { HangWatch, isBridge as runsBridge } from "../shared/hang";
import { joinPath, loginPath, saveLoginPath, savedLoginPath } from "../shared/platform";
import { watchAsks } from "./areas/asks";
import { watchWorkAsks } from "./work/asks";
import { watchGoals } from "./work/goals";
import { refreshBotsKeys } from "./areas/bot-keys";
import { setBoxKey } from "./areas/box-keys";
import { addMacDefaults, changeSettings, ownsSettings, readSettings } from "./areas/config";
import { engineConnect } from "./areas/engine";
import { answerOnce, reconnectEverywhere, upgradeBeforeEngine, upgradeIntegrations } from "./areas/integrations";
import { readApart } from "./github/graphql";
import "./work-queue/github";
import "./glance/github";
import { keepSkillTrashClear } from "./areas/skills";
import { sendWakes } from "./areas/wakes";
import { finishDeletes, forgetLeftKeys } from "./bots/edit";
import { keepJobs } from "./bots/jobs";
import { forgetOldKit, readKit } from "./bots/kit";
import { adoptBox } from "./compat/adopt-settings";
import { LaunchLockBusy } from "./compat/launch-lock";
import { forgetPhones } from "./compat/leave-running";
import { addressOf, newKey, publicOf } from "./crypto/keys";
import { IKInitiator, IKResponder, openOneWay, PROLOGUE, sealOneWay } from "./crypto/noise";
import { docsNoted, noteDocsChanged, onDocsChanged } from "./documents/changed";
import { docsChanged, macDocsChanged } from "./documents/exchange";
import { newSigningSeed, ownSign, SIGN } from "./documents/format";
import { docsWork, ownDocs, pruneDocs } from "./documents/work";
import { bridgeTarget, peerPlaces, peerTargets, readBridgeFile, readEngineFile } from "./engine/client";
import { applyCompatibility, engineConfigContent, knowsEngineSettings } from "./engine/compatibility";
import { keepEngineDefaults } from "./engine/defaults";
import { clearNotesLocks } from "./engine/notes";
import { watchBox } from "./engine/watch";
import { watchMoves } from "./moves/move";
import { writePrivate } from "./files";
import { browserStatus, installBrowser, startBrowserInstall } from "./browser/install";
import { BRIDGE_FILE, IS_MAC, K, NEEDED_FILE, OWN_RUNTIME, PID_FILE, REAL_BOX, RUN, scriptIs, socketKey, takeVaultSecrets, VERSION_FILE } from "./home";
import { isBridge, keepKeeper, needed, noLongerNeeded, runningBridge, startBridge } from "./keeper";
import { noteRelay } from "./letters/leave";
import { deliverLeftAnswers, outboxSoon, sendOutbox } from "./letters/outbox";
import { SENDING } from "./letters/letter";
import { watchFolders } from "./follow";
import { pushRows } from "./work/elsewhere";
import { pushNumbers } from "./work-queue/numbers";
import { noteSetupNow } from "./setup/lead";
import { macName, mainElsewhere, pairElsewhere } from "./setup/main-only";
import { writeCard } from "./setup/card";
import { hereNow } from "./setup/judge";
import { pushQueues } from "./work-queue/across";
import { FORWARDS, forwardsSoon, sendForwards } from "./work-queue/forward";
import { handUpkeepSoon } from "./work-queue/hand";
import { clearStaging } from "./work-queue/ops";
import { macLinkCheck } from "./mac/link";
import { macNoticeHold, macTell } from "./mac/notices";
import { runMacPeers } from "./mac/peers";
import { runMacLink } from "./mac/relay";
import { watchVaultAsks } from "./vault/asks";
import { watchSandboxAsks } from "./fence/outside";
import { holdVault } from "./vault/holder";
import { primeGenerations } from "./vault/store";
import { setVaultTell } from "./vault/use";
import { HELD_FILE, NoticeHold } from "./notices/hold";
import { keepTold, markTeller, watchSentByAgents } from "./notices/told";
import { sendToPhones } from "./notices/push";
import { announce, forgetMacsAgents, refreshOwn } from "./peers/agents";
import { forgetOldMacs, KEY, leaveMac, macsOf, noteOnline, peersOf, takeLegacyPeers } from "./peers/known";
import { peerMail, receiveMail } from "./peers/mail";
import { watchSeats } from "./peers/seats";
import { changePersonalities, mergePersonalities, readPersonalities } from "./personalities/library";
import { takePersonalities } from "./personalities/take";
import { authorizePhone, confirmPhone, foldPhones, newPairingToken, PAIRING_MINUTES, pairingLink } from "./phones";
import { connectOnce, nextTry } from "./relay/connection";
import { LinkHost } from "./relay/host";
import { engineHandler } from "./server/router";
import { serveBox } from "./server/serve";
import { macLink, macSign, onLinkWritten, readLink, updateLink } from "./state";
import { keepKeyFiles } from "./keys";
import { keepAwakeWhileWorking } from "./work/awake";
import { agentsWorking, checkDrift, confirmUpdate, isUpdating, noteLauncher, noteOlderMacs, noteUpdate, startUpdate, update, UPDATE_KEYS, updateNight, updatesBlocked, updateState, updateStatus } from "./updates/update";
import { BRIDGE_VERSION } from "./version";
import type { AddressInfo } from "node:net";
import type { SignedDoc } from "../shared/documents";
import type { EngineRecord } from "../shared/records";
import { fenceOwnPort, keepFence } from "./fence/state";
import { keepApprovals } from "./areas/approval";
import { keepGroupSettings } from "./areas/group-settings";
import { keepOldBranchPrefix } from "./areas/git-words";
import type { KeptNotice } from "./notices/hold";
import type { Notice } from "./notices/notice";
import type { GivenLibrary } from "./personalities/library";
import type { AnyPiece } from "./server/context";
import type { LinkState } from "./state";

// What moved into modules, as this file exported it (the bridge's tests import it from here).
export { addressOf, newKey, publicOf } from "./crypto/keys";
export { CipherState, IKInitiator, IKResponder, MAIL_PROLOGUE, openOneWay, PROLOGUE, sealOneWay } from "./crypto/noise";
export { decodeMessage, encodeMessage, Frame, frame, pieces, readFrame, readRelay, relayHello, relayPush, relaySend } from "./relay/frames";
export { isSecretName, markingHashes, masked, maskedHexValues, maskedNamed, namesHash, showsAll } from "./notices/mask";
export { docBytes, MOST_DOC, newSigningSeed, ownSign, readDoc, signDoc, signingKeyOf } from "./documents/format";
export { IS_MAC, LINK_FILE } from "./home";
export { boxPlaces } from "./places";
export { BRIDGE_VERSION } from "./version";
export { FEATURES } from "../shared/features";
export { macFeatures } from "../shared/routes/mac";
export { messageID } from "./engine/sessions";
export { forgetMovesInMemory, keepMoving, sendMovesWith, takeMoveMail, watchMoves } from "./moves/move";
export { movesElsewhere } from "./moves/elsewhere";
export { applyCompatibility, COMPATIBILITY_FILE, ENGINE_LAYER_FILE, engineConfigContent, learnCompatibility, readCompatibility } from "./engine/compatibility";
export { MODELS_DUE_FILE, refreshModels, settleDueModels } from "./engine/models";
export { queueOf, queueWatcher, readQueues, scanQueues, stopSession } from "./engine/queue";
export { PLACE_TRIES } from "./letters/letter";
export { forgetEverythingSent, SENDING_PATIENCE } from "./server/sent-once";
export { keepReadThroughSummary, keepWorkRead, settleWorkRead, under } from "./work/tree";
export { readAllOn, readGroups } from "./areas/read-all";
export { glances, Unreached } from "./areas/glance";
export { forgetModelLists, noteModelsEvent } from "./areas/session-models";
export { askedSince, forgetAsks, forgetAsksOn, noteAskEvent } from "./glance/asked";
export { checksOf, pullOf, queryFor, readPulls } from "./glance/github";
export { linkPull, pullCatcher, readPullLinks } from "./glance/pulls";
export { letAttachmentsGo } from "./server/attached";
export { FIRST_LOOK, WAITING_LOOK, workWatcher } from "./work/wakes";
export { forgetOldHomes } from "./work/homes";
export { AT_WORK_LIMIT, atWorkNow, noteStopped, readBackground, readStopped, stopWork } from "./work/background";
export { goalFollowers, goalHolds, settleGoalHolds, lookAtGoals, periodOf, periodEnd, pauseGoal, REVIEW_PAUSE } from "./work/goals";
export { awakeForWork, holdForWork, keptAwake, letGo, lookAtWork, UNTOLD_FOR, WORK_AWAKE_FILE } from "./work/awake";
export { macLink, readLink, updateLink, writeLink } from "./state";
export { searchPlugins } from "./areas/plugins";
export { listFolders, makeFolder } from "./areas/folders";
export { findProgram } from "./areas/programs";
export { providerModels } from "./areas/providers";
export { endedProviders, forgetPlan, noteSignIn } from "./areas/accounts";
export { answerAsk, askAnswer, askNotice, listedAsk, readAsks, watchAsks } from "./areas/asks";
export { BOT_MEMORY_RULE, addMacDefaults, changeSettings, deepMerged, keysNamedHere, ownsSettings, readSettings } from "./areas/config";
export { addFromCatalog, mcpCatalog } from "./areas/mcp-catalog";
export { adoptBox } from "./compat/adopt-settings";
export { setBoxKey } from "./areas/box-keys";
export { applySettings, translateSettings } from "./areas/apply";
export { NOTICE_LIMIT, noticeJSON, pushTo } from "./notices/notice";
export { notePushed, PUSHED_FILE, readPushed, sendToPhones } from "./notices/push";
export { LinkHost } from "./relay/host";
export { followed } from "./follow";
export { answerIntegrations, reconnectEverywhere, upgradeIntegrations } from "./areas/integrations";
export { allWakes, holdArchived, listWakes, nextWake, readWakes, repeatText, sendWakes, wakeFolder, wakeOf } from "./areas/wakes";
export { readRemovedWorktrees, readWorktrees } from "./areas/worktree-records";
export { answerProjects, boxProjects, changeProjects, readProjects } from "./areas/projects";
export { answerWorktrees, branchSlug, nameWorktreeBranch, tellWorktree, tidyWorktrees, worktreesWhere } from "./areas/worktrees";
export { SKILL_REPOSITORIES, answerSkills, keepSkillTrashClear, skillAbout, skillName, skillTrashEntry, skillsIn } from "./areas/skills";
export { agentsAllowed, allowed, canonicalPath, signInReturn, socketAllowed } from "./server/paths";
export { KEEP_FOR, SEEN_FILE, forgetPhones, phoneSeenLately } from "./compat/leave-running";
export { engineConnect, engineControl, toolRun } from "./areas/engine";
export { botPersonalities, changePersonalities, mergePersonalities, personalitiesDocument, readPersonalities } from "./personalities/library";
export { botVariable, keyFilesWait, syncKeyFiles } from "./keys";
export { UPDATE_KEYS, agentsWorking, boxVersion, checkDrift, confirmUpdate, isUpdating, newerVersion, noteLauncher, noteOlderMacs, startUpdate, update, updateNight, updateStatus, updatesBlocked, verifyBoxes, versionOrder } from "./updates/update";
export { FILE_LIMIT } from "./areas/file";
export { firstMessageOf, jobInMemory, jobLine, keepJobs } from "./bots/jobs";
export { listBots } from "./bots/list";
export { botInstructions, botTemplates, readKit, readWords } from "./bots/kit";
export { freshenBot, freshenBots, refreshedRules, settleBot } from "./bots/tell";
export { makeBot } from "./bots/make";
export { carryToAgents } from "./areas/carry";
export { changeBot, deleteBot, finishDeletes, forgetLeftKeys } from "./bots/edit";
export { ASK_HOLD, LONGEST_LEASE, NEWS_HOLD, NoticeHold, RESTORED_WAIT, SHOWN_WITHIN, attentionGiven, holdFor } from "./notices/hold";
export { alwaysTitle, describeForm, describePermission, groupNotice, noticeFor, projectNameOf, settleHeld } from "./notices/news";
export { STEER_AFTER, steering, watchBox, watchEvents } from "./engine/watch";
export { answerBotKeys, refreshBotsKeys } from "./areas/bot-keys";
export { forgetOldMacs, leaveMac, macsOf, mailFor, movedOf, noteOnline, openMail, peersOf, takeLegacyPeers } from "./peers/known";
export { noteDocsChanged } from "./documents/changed";
export { authorizePhone, confirmPhone, foldPhones, newPairing, pairPhone, removeAsMac, removePhones } from "./phones";
export { noLongerNeeded } from "./keeper";
export { changedWork, digestOf, docMails, docsWork, greetWork, macPeersBody, ownDoc, takeDoc } from "./documents/work";
export { leadsNow, noteSetupNow, settleOwnSetup } from "./setup/lead";
export { settleSetup, sharedMachine } from "./setup/settle";
export { followedSetup, newSetupID, startsFromOthers } from "./setup/record";
export { setupView } from "./setup/view";
export { foundOf, hereNow, judgeComputer, judgeHere, oursNow, OWN_BOX_RAN } from "./setup/judge";
export { cardNow, SETUP_CARD, writeCard } from "./setup/card";
export { keptFeatures, peerOf, readPeerAgents, takeAgents, vouchedOf } from "./peers/directory";
export { composeLetter } from "./letters/letter";
export { composeAgents } from "./peers/directory";
export { nameAgents, namedAgents, namesIn } from "./peers/naming";
export { bridgeAsk, bridgeClock, carrySeat, seatPayloads, seatPeers, takeLimits, takeSeat, tellSeatPeers, watchSeats } from "./peers/seats";
export { announce, ownAgents, refreshOwn, writeAgents } from "./peers/agents";
export { answered, deliverLeftAnswers, letterMail, letterWent, sendOutbox } from "./letters/outbox";
export { takeLetter } from "./letters/take";
export { answerResumed, callAs, callsBack, sendCall, takeCall } from "./letters/calls";
export { computerOf, resumeStarts, stopBotWorkElsewhere } from "./letters/start-call";
export { agentTool } from "./letters/tools";
export { stopBotWork } from "./work/stop";
export { allowOtherComputers, approvalOf, otherComputersAllowed } from "./work/approval";
export { reapplyApprovals } from "./areas/approval";
export { pushRows, takeRows } from "./work/elsewhere";
export { askToSend, blockArrived, BLOCK as QUEUE_BLOCK, CLAIM_REACH as QUEUE_CLAIM_REACH, claimNumbers, giveBlock, LOW as QUEUE_LOW, notePrimaryNow, primaryOf, pushNumbers, rankedPrimary, readNumbers, reclaimWaiting, takeBlock, takeNumber, takeNumbersMail } from "./work-queue/numbers";
export { forgetPushed as forgetQueuesTold, itemsElsewhere, pushQueues, takeWorkQueueMail, tellingNow as queueTellingNow, tellQueuesAgain } from "./work-queue/across";
export { handUpkeep } from "./work-queue/hand";
export { forgetActs as forgetQueueActs, FORWARDS as QUEUE_FORWARDS, forwardsSoon as queueForwardsSoon, forwardTiming as queueForwardTiming, sendForwards as sendQueueForwards, takeAct as takeQueueAct } from "./work-queue/forward";
export { actForPeer as queueActForPeer } from "./work-queue/acts";
export { mailsFor as queueMailsFor, takePart as takeQueuePart } from "./work-queue/parts";
export { parseBacklog } from "./work-queue/import";
export { carryWorkQueue, forgetWorkQueues, packWorkQueues, placeWorkQueues } from "./work-queue/moves";
export { readReach } from "./peers/reach";
export { peerPlaces } from "./engine/client";
export { answerPersonalities, retellBots, takePersonalities, takePersonalitiesDocument } from "./personalities/take";
export { docsChanged, macDocsChanged, receiveDocs } from "./documents/exchange";
export { peerMail, receiveMail } from "./peers/mail";
export { pairingLink } from "./phones";
export { ownRefreshed } from "./server/naming";
export { FROM_PHONE, fromPhone } from "./server/forward";
export { MAC_LINK_FILE, savedMacConfig, stopMacLink } from "./mac/link";
export { macNoticeHold, macTell } from "./mac/notices";
export { LETTER_WAIT, macSendOutbox, runMacPeers, stopMacPeers } from "./mac/peers";
export { setMacPeers } from "./mac/routes";
export { engineHandler } from "./server/router";
export { connectOnce, fromRelay, nextTry } from "./relay/connection";
export { MAC_APP_ROUTES, macAppAnswers, macFront, runMacLink } from "./mac/relay";
export { keepKeeper } from "./keeper";
export { serveBox } from "./server/serve";

// This file, for what the box runs again as a command of its own.
scriptIs(fileURLToPath(import.meta.url));

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

// ---- The commands ----

// What a machine's link does once the relay's welcomed it: your other computers hear who's here,
// and it tells who's there; a new bridge an update put here says it's well.
function machineWelcomed(host: LinkHost): void {
  announce(host, readEngineFile, undefined, undefined, true).catch(() => {});
  try { docsChanged(host, { greet: true }); } catch {}
  updateIsWell();
}

// An update on trial is here to stay, if it's well: what waited for that goes on.
function updateIsWell(): void {
  try { if (confirmUpdate()) upgradeIntegrations().catch(() => {}); } catch {}
}

async function run(): Promise<void> {
  // One bridge at a time: a newer one (the engine restarted) takes over.
  let old: number | null = null;
  try {
    old = Number(fs.readFileSync(PID_FILE, "utf8"));
    if (isBridge(old)) process.kill(old, "SIGTERM");
  } catch {}
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  // (Sessions' turns' lock folders left by a box cut off: `engine/notes.ts`.)
  clearNotesLocks();
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
  fs.writeFileSync(VERSION_FILE, BRIDGE_VERSION, { mode: 0o600 });
  // The programs it looks for (an MCP server's `npx`) found where the engine finds them: on the
  // PATH your login shell sets up, as the engine's start read it, which the keeper's start doesn't get.
  const saved = savedLoginPath(K);
  if (saved) process.env.PATH = joinPath(path.join(K, "bin"), saved);
  // COMPAT(beta.1 connected): `run/connected` (beta.1) and `run/present` (0.7 with the phone link on), cleared. Goes when 0.8.0 ships.
  // The notes an earlier Kuvo Code on a Mac left that it was connected (it did some of the box's
  // work then): nothing reads them now.
  for (const folder of ["present", "connected"]) fs.rmSync(path.join(RUN, folder), { recursive: true, force: true });
  // Its bots' jobs kept in their folders, taken once from where they were before.
  try { keepJobs(); } catch {}
  forgetOldKit();
  // Its integrations and servers as its catalog has them now, and its bots' folders' settings as its
  // catalog and keys are (after an update, say).
  await upgradeIntegrations().catch(() => {});
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

  keepBridgeAnswering();
  // Stops when nothing's paired any more, or when another bridge took over; up while the engine
  // is down too, so a phone can start it. Phones removed since lose what they have open, and the
  // box's keeper, if it went, starts again (it keeps this bridge, and the engine, running).
  let current: LinkHost | null = null;
  setInterval(() => {
    let owner: number | null = null;
    try { owner = Number(fs.readFileSync(PID_FILE, "utf8")); } catch {}
    const link = readLink();
    if (!needed(link)) {
      forgetPhones();
      noLongerNeeded();
    }
    if (!needed(link) || owner !== process.pid) return cleanUp();
    current?.keepOnly(new Set((link!.phones ?? []).map(phone => phone.key)));
    keepKeeper();
  }, 30_000);

  // Your phones' notifications, on whichever relay connection is up: the engine's news, and what
  // agents ask for as they browse.
  // False when it can't go now (the relay isn't there, or its connection is closing), to be tried again.
  const tellPhones = (notice: Notice): boolean => sendToPhones(current, readLink(), notice);
  // Each held a little while a client's in use here (PROTOCOL.md, "kuvo/attention"); what's held
  // is kept in run/held-notices.json, for the next bridge to send if this one stops first: read
  // once the one before has gone (a few seconds at most), so it neither sends nor holds one more.
  for (let tries = 0; tries < 60 && old && isBridge(old); tries++) await sleep(50);
  let held: KeptNotice[] = [];
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
  const tell = (notice: Notice): boolean => hold.tell(notice);
  const answered = (id: string): void => hold.resolve(id);
  // Its engine and the coding agents here (their sessions, and group chats that live here),
  // through their bridge: each notice kept as told too, for clients to show (`kuvo/notices`).
  watchBox({ tell: notice => { keepTold(notice); return tell(notice); }, hold });
  // And what its agents send you on purpose (notify_user), whichever process answered them.
  watchSentByAgents(tell);
  // (So its clients know it tells them: a bridge from before didn't.)
  markTeller();
  // What its group chats send your other computers, carried on the relay connection that's up.
  watchSeats(() => current);
  // Moves to and from your other computers, carried on the same connection.
  watchMoves(() => current);
  watchAsks(tell, { answered });
  // Working outside a conversation's project asks first, as Settings › Permissions says
  // (engine/defaults.ts).
  keepEngineDefaults();
  // Agents' commands, in the sandbox wherever it can run (fence/state.ts), set up before the vault
  // goes by it.
  keepFence();
  // Conversations' approval kept to what it comes to as the sandbox starts or stops.
  keepApprovals();
  // What its group chats go by, worked out here and given to the bridge that runs them.
  keepGroupSettings();
  // The branch prefix it kept before Settings › Git was each computer's, made its setting.
  keepOldBranchPrefix();
  // The vault, held here: its key in this process's memory, its asks told to your phones.
  holdVault(engineHandler(readEngineFile, { name: os.hostname() }));
  setVaultTell(tell);
  watchVaultAsks(tell, answered);
  watchSandboxAsks(tell, answered);
  // What its bots ask you before they do it (making a project): told the same way.
  watchWorkAsks(tell, { answered });
  // Its bots' goals: carried on at limits' resets, what waits for you listed (and told quietly),
  // digests and reports, and this computer kept awake while one is at work.
  watchGoals(tell, peerTargets, { here: () => hold.inUse });
  // Your other computers: this box's agents told to them while the relay connection is up (and
  // listed here, relay or not), and its agents' letters sent; without the relay a while, those
  // not sent yet go to the Mac.
  let lastWelcomed = Date.now();
  refreshOwn(readEngineFile).catch(() => {});
  // Updates: the new bridge, once one put it here, says it's well (after the relay's welcome, or
  // three minutes); each night's window, one, when nothing runs (PROTOCOL.md, "Updates").
  setTimeout(updateIsWell, 180_000);
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
  // What a Work Queue change left half read as the box stopped.
  clearStaging();
  setInterval(() => {
    if (current?.welcomed) announce(current, readEngineFile).catch(() => {});
    else refreshOwn(readEngineFile).catch(() => {});
    // Running: its Macs' 30 days go on, the relay there or not (time off doesn't count).
    try { noteOnline(); } catch {}
  }, 60_000);
  const sendNow = () => {
    try { sendOutbox(current ?? { send() {} }, undefined, Date.now(), current?.welcomed ? 0 : Date.now() - lastWelcomed); } catch {}
  };
  // What this box answers goes at once; what its tools leave (another process's), the moment the
  // system says it's there (a watch on the folder, the same on macOS and Linux; a moment's gather,
  // as a tool writes it in more than one step). One that dies is made again each round, which also
  // sends what a watch missed.
  outboxSoon.send = sendNow;
  let soon: ReturnType<typeof setTimeout> | null = null;
  const leftNow = () => {
    soon ??= setTimeout(() => { soon = null; sendNow(); }, 50);
  };
  try { fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 }); } catch {}
  let outboxWatch = watchFolders([SENDING], leftNow, { recursive: false });
  // What you do to an item another computer keeps, left by a route (`box route` too): it goes at
  // once, and again each few seconds while it's waited for.
  const forwardNow = () => { try { sendForwards(current); } catch {} };
  forwardsSoon.send = forwardNow;
  try { fs.mkdirSync(FORWARDS, { recursive: true, mode: 0o700 }); } catch {}
  let forwardsWatch = watchFolders([FORWARDS], forwardNow, { recursive: false });
  setInterval(() => {
    if (!outboxWatch.whole) {
      outboxWatch.close();
      outboxWatch = watchFolders([SENDING], leftNow, { recursive: false });
    }
    if (!forwardsWatch.whole) {
      forwardsWatch.close();
      forwardsWatch = watchFolders([FORWARDS], forwardNow, { recursive: false });
    }
    forwardNow();
    if (current?.welcomed && docsNoted()) try { docsChanged(current, { tell: true }); } catch {}
    if (current?.welcomed) lastWelcomed = Date.now();
    noteRelay(Boolean(current?.welcomed), lastWelcomed);
    sendNow();
    deliverLeftAnswers().catch(() => {});
    // The rows of sessions here whose lead lives on another computer, told to it as they change.
    if (current?.welcomed) pushRows(current, readLink(), peerTargets()).catch(() => {});
    // The Work Queue's ask for more numbers, to the primary, while one is under way; and this box's
    // queue told to your other computers as it changes, with what it's handing to theirs.
    // Your setup, as this box leads it or follows it (once a minute), before its numbers go by it.
    noteSetupNow();
    try { pushNumbers(current); } catch {}
    if (current?.welcomed) pushQueues(current, readLink(), peerTargets()).catch(() => {});
    else try { handUpkeepSoon(readLink()); } catch {}
  }, 3_000);

  let attempt = 0;
  while (true) {
    const link = readLink();
    if (!needed(link)) {
      forgetPhones();
      noLongerNeeded();
      return cleanUp();
    }
    let engine: Partial<EngineRecord> = {};
    try { engine = readEngineFile(); } catch {}
    const host = new LinkHost({
      key: Buffer.from(link!.key!, "base64url"),
      hello: { v: 1, kind: "machine", name: link!.name || os.hostname(), app: BRIDGE_VERSION, engine: engine.version ?? null },
      authorize: authorizePhone,
      confirmed: confirmPhone,
      mail: (_from, body) => receiveMail(body, host, (sender, payload) => peerMail(sender, payload, host, peerPlaces), (mac, given, at) => hold.attend(`mac:${mac}`, given, at)),
      handle: engineHandler(readEngineFile, { name: link!.name || os.hostname() }, readBridgeFile, changed => host.keepOnly(new Set((changed.phones ?? []).map(phone => phone.key))), hold),
      connect: engineConnect(readEngineFile),
      send: () => {},
    });
    current = host;
    const started = Date.now();
    const welcomed = await connectOnce(link!.relay!, Buffer.from(link!.secret!, "base64url"), host, machineWelcomed);
    const next = nextTry(attempt, welcomed, Date.now() - started);
    attempt = next.attempt;
    await sleep(next.wait);
  }
}

// `kuvo-link.js box <command>`: a Mac's way to a machine's own settings, over SSH, the same way a
// phone's goes (one answer, JSON, on stdout). `adopt` (a seed on stdin), `read`, `change`
// ({changes} on stdin), `key <name>` (its value on stdin; none removes it), `route` (a request,
// {method, path, body?}, answered as a phone's is: {status, body}), `bot-keys-refresh`.
async function box(command: string): Promise<void> {
  const input = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  };
  const say = (value: unknown): void => console.log(JSON.stringify(value));
  switch (command) {
    // COMPAT(0.7 settings): `box adopt`, which a Mac runs over SSH. Goes 3 months after 0.8.0.
    case "adopt": {
      let seed: { settings?: unknown; keys?: unknown } | null = null;
      try { seed = JSON.parse((await input()) || "null"); } catch {}
      let adopted: ReturnType<typeof adoptBox>;
      try {
        adopted = adoptBox(seed);
      } catch (error) {
        // Said as it is, for the Mac to show.
        if (!(error instanceof LaunchLockBusy)) throw error;
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      // Its settings its own now: the branch prefix it kept before, taken into them.
      keepOldBranchPrefix();
      // As its catalogs have them now: a Mac runs this as it connects, having just put newer ones here,
      // whether or not this box has a bridge or starts its engine again. (Stays when adopting goes.)
      await upgradeIntegrations().catch(() => {});
      return say({ ...adopted, settings: readSettings().settings ?? adopted.settings });
    }
    // COMPAT(beta.1 box-read-change): `box read` and `box change`, which beta.1 runs over SSH (`box route` took their place). Goes when 0.8.0 ships.
    case "read": {
      const { settings, problem } = readSettings();
      return say(problem ? { status: 409, message: problem } : { status: 200, settings, own: ownsSettings() });
    }
    case "change": {
      let given: { changes?: unknown } | null = {};
      try { given = JSON.parse(await input()); } catch {}
      // (Checked there.)
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
      spawn(process.execPath, [...OWN_RUNTIME, fileURLToPath(import.meta.url), "update", "--now"], { detached: true, stdio: "ignore", cwd: K, env: process.env }).unref();
      return say({ status: 202, ...updateStatus(), updating: "checking" });
    }
    case "route": {
      // A client's request, answered as the bridge answers a phone's: one that answers once,
      // never a stream that follows.
      answerOnce();
      let given: { method?: unknown; path?: unknown; body?: unknown; bodyText?: unknown; headers?: unknown } | null = {};
      try { given = JSON.parse(await input()); } catch {}
      // (The coding agents' bridge's sessions too: a wake-up held for one, say.)
      const handle = engineHandler(readEngineFile, { name: os.hostname() }, readBridgeFile);
      // With the folder it's asked about (`x-opencode-directory`), as a phone's request has it.
      const folder = (given?.headers as Record<string, unknown> | undefined)?.["x-opencode-directory"];
      // And the Mac's proof for a request to this machine's vault (or its unlock key, to unlock it),
      // which makes it a client there (areas/vault.ts); with the body as it was sent, which the proof covers.
      const vaultHeaders: Record<string, string> = {};
      for (const name of ["x-kuvo-vault-key", "x-kuvo-vault-proof"]) {
        const value = (given?.headers as Record<string, unknown> | undefined)?.[name];
        if (typeof value === "string") vaultHeaders[name] = value;
      }
      const sentBody = typeof given?.bodyText === "string" ? given.bodyText : given?.body === undefined ? "" : JSON.stringify(given.body);
      const request = { method: String(given?.method ?? "GET"), path: String(given?.path ?? ""), headers: { "content-type": "application/json", ...(typeof folder === "string" ? { "x-opencode-directory": folder } : {}), ...vaultHeaders }, body: Buffer.from(sentBody), fromMac: true };
      let status = 502;
      let type = "";
      const chunks: Buffer[] = [];
      // A route that follows something answers with what it says now: its first line. Stopped by
      // its caller (an agent's tool call that waits, cancelled), it stops waiting and answers.
      const stop = new AbortController();
      process.once("SIGTERM", () => stop.abort());
      for await (const part of handle(request, {}, stop.signal) as AsyncIterable<AnyPiece>) {
        if (part.head) {
          status = part.head.status;
          type = String(part.head.headers?.["content-type"] ?? "");
        }
        if (part.body) chunks.push(Buffer.from(part.body));
        if (type.startsWith("application/x-ndjson") && Buffer.concat(chunks).includes(10)) {
          stop.abort();
          const all = Buffer.concat(chunks);
          return say({ status, body: all.subarray(0, all.indexOf(10) + 1).toString("utf8") });
        }
      }
      const body = Buffer.concat(chunks);
      // Bytes that aren't text (a picture, a PDF, a file sent as text that isn't UTF-8) go as
      // base64, whole.
      const text = (!type || type.startsWith("text/") || type.includes("json")) && isUTF8(body);
      return say(text ? { status, body: body.toString("utf8") } : { status, bodyBase64: body.toString("base64"), type });
    }
    case "github-read":
      // A read of GitHub that was due as `route` answered, made here, outliving it.
      return void await readApart(process.argv[4], await input()).catch(() => {});
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
      let given: GivenLibrary | null = null;
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

/** The first line on stdin, as JSON (what the app sends `serve` there, before anything else). */
function firstLine(): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    let given = "";
    const take = (chunk: Buffer | string) => {
      given += chunk.toString();
      const end = given.indexOf("\n");
      if (end < 0) return;
      process.stdin.off("data", take);
      process.stdin.off("end", done);
      process.stdin.pause();
      try { resolve(JSON.parse(given.slice(0, end))); } catch { resolve({}); }
    };
    const done = () => resolve({});
    process.stdin.on("data", take);
    process.stdin.once("end", done);
  });
}

/** The coding agents' bridge beside this box's engine, ended should it hang (it's started again as after
 * a crash), wherever this runs. The bridge watches the engine in turn (agents/main.ts). */
function keepBridgeAnswering(): void {
  new HangWatch({ name: "bridge", run: RUN, record: BRIDGE_FILE, isIt: runsBridge }).start();
}

async function serve(): Promise<void> {
  // Its password, and this Mac's vault's secrets, from the app on stdin (never its environment,
  // which any of your processes can read); a test's box, in OPENCODE_PASSWORD.
  let password = process.env.OPENCODE_PASSWORD;
  delete process.env.OPENCODE_PASSWORD;
  if (!password) {
    const given = await firstLine();
    if (typeof given.password === "string") password = given.password;
    takeVaultSecrets(given);
  }
  if (!password) {
    console.error("serve answers only with a password: on its stdin, {\"password\"}, or in OPENCODE_PASSWORD.");
    process.exit(2);
  }
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  // (Sessions' turns' lock folders left by a box cut off: `engine/notes.ts`.)
  clearNotesLocks();
  // This Mac's settings with what its engine starts with, before a client reads them.
  if (IS_MAC) addMacDefaults();
  // And as its catalogs have them now, before it says where it is: this Mac's engine starts only after
  // that. (Any key to take away comes after, below: its app may not answer yet, and an engine
  // running takes settings as they change.)
  try { upgradeBeforeEngine(); } catch {}
  // This Mac's notices for your phones, held while you're at a computer, as a machine's are.
  if (IS_MAC) macLink.hold = macNoticeHold();
  const server = serveBox(password, engineHandler(readEngineFile, { name: os.hostname() }, readBridgeFile, () => {}, macLink.hold));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // The key to its sockets, and agents' commands in the sandbox (fence/state.ts), which refuses them
  // this server too, there before it says where it is (holdVault, below, makes it too).
  try { socketKey(); } catch {}
  fenceOwnPort((server.address() as AddressInfo).port);
  keepFence();
  keepApprovals();
  keepGroupSettings();
  keepEngineDefaults();
  // The vault, held here (on a machine, `run` holds it; a test's box serves alone), its asks told
  // to your phones through this Mac's link: listening before it says where it is, so what reaches
  // the vault from then on finds it open.
  holdVault(engineHandler(readEngineFile, { name: os.hostname() }, readBridgeFile));
  console.log(JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  // This Mac's vault's newest generations, from its app, before agents use it (vault/store.ts).
  if (IS_MAC) void (async () => {
    for (let tries = 0; tries < 120; tries++) {
      try { return await primeGenerations(); } catch {}
      await sleep(1000);
    }
  })();
  if (IS_MAC) {
    setVaultTell(macTell);
    watchVaultAsks(macTell, id => macLink.hold?.resolve(id));
    watchSandboxAsks(macTell, id => macLink.hold?.resolve(id));
  }
  // Any integration's key to take away for its maker's server (the rest is done, above), and its bots'
  // folders' settings as its catalog and keys are (after an update, say), as a machine's bridge does
  // as it starts; where its keys can't be reached yet, they stay as they were.
  upgradeIntegrations().catch(() => {});
  refreshBotsKeys().catch(() => {});
  // A Mac's box in a home of its own: the files its engine reads its keys from, kept as its host
  // keeps them (its app did that in its folder), and its Mac kept awake while agents work, as its
  // setting says (its app's keeper did, by the app's).
  keepKeyFiles();
  keepAwakeWhileWorking(() => agentsWorking());
  // Keys of bots deleted while they couldn't be reached.
  forgetLeftKeys().catch(() => {});
  // And their conversations and places in group chats, where those weren't answering.
  finishDeletes(readEngineFile, bridgeTarget).catch(() => {});
  keepBridgeAnswering();
  // Its wake-ups and watches, sent while it runs, with the app's window closed too.
  sendWakes();
  // This Mac's link to your phones and machines, as its app last said it's wanted (kept in
  // run/mac-link.json, so it's back on the relay after a restart before the app opens), or once it says so.
  if (IS_MAC) runMacLink().catch(() => {});
  // Its agents and their letters, and its group chats' mail, for your other computers. (Not for
  // the app's route scenarios, `KUVO_TEST_NO_PEERS`, whose fixture tells its bridge who they are.)
  // Never a real box (a test's folder only).
  const testsAlone = process.env.KUVO_TEST_NO_PEERS && !REAL_BOX;
  if (IS_MAC && !testsAlone) runMacPeers();
  // Recently Deleted's skills past their 30 days, gone with no client there too.
  keepSkillTrashClear();
  // What a Work Queue change left half read as the box stopped.
  clearStaging();
  // Its bots' jobs kept in their folders, taken once from where they were before, once its app
  // makes them this box's (it gives the box its kit then).
  if (readKit()) try { keepJobs(); } catch {}
  // Its bots kept told what they are as their runs start, on the engine and with the coding agents;
  // on a Mac, its news for your phones too (while the phone link's on), and its sign-ins that ended.
  // Each notice kept as told too, for its clients to show (`kuvo/notices`); and what its agents send
  // you on purpose (notify_user).
  watchBox({ tell: notice => { keepTold(notice); return macTell(notice); }, hold: macLink.hold, bots: true, notices: IS_MAC });
  if (IS_MAC) watchSentByAgents(macTell);
  // Its bots' goals: carried on at limits' resets, what waits for you listed (and told quietly to
  // your phones), digests and reports, and this Mac kept awake while one is at work (on power).
  if (IS_MAC) watchGoals(macTell, peerTargets, { here: () => macLink.hold?.inUse ?? false });
  // Its app gone (its stdin closed): so is it, once what its link has queued for the relay is out
  // (a notice sent as the app quit), a moment at most.
  const leave = async (): Promise<void> => {
    for (let tries = 0; tries < 30 && (macLink.host?.unsent?.() ?? 0) > 0; tries++) await sleep(50);
    // What didn't get out in time isn't lost without a word.
    if ((macLink.host?.unsent?.() ?? 0) > 0) console.error("Kuvo Code quit before what its link had for your phones and machines went out.");
    process.exit(0);
  };
  process.stdin.on("end", leave);
  process.stdin.on("close", leave);
  process.stdin.resume();
}

/** What a Mac's `setup` sends on stdin: the relay, this machine's name, the Mac's key and signing
 * key, the documents it gives, its id for this machine, and (its ID) whether it leaves a newer box
 * as it is; from a beta.1 Mac, its peers as it lists them. Each checked as it's read. */
interface SetupInput {
  relay?: string;
  name?: string;
  mac?: string;
  macSign?: string;
  /** The Mac's own name, for who else uses this box. */
  macName?: string;
  docs?: SignedDoc[];
  id?: string;
  macID?: string;
  tolerates?: number;
  peers?: unknown[];
  peersAt?: number;
  at?: number;
  moved?: unknown[];
  /** The Mac's keys before (made anew since), which it no longer is: let go here. */
  replaces?: unknown;
}

// What the Mac sends: the relay, this machine's name, and the phones you've paired with the Mac,
// which may reach it directly. Keeps the machine's own keys (made the first time, and never
// leaving it) and phones paired with the machine itself, starts the bridge or restarts it (on
// another relay, or a newer one), and prints the machine's address and public key for the Mac
// to tell your phones. Nothing left to answer: the bridge stops, and the keys stay.
async function setup(): Promise<void> {
  let input: SetupInput;
  try {
    const chunks: Buffer[] = [];
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
  let link = null as LinkState | null, work = null as ReturnType<typeof docsWork> | null, library = before;
  // The Mac's keys before, made anew since (over SSH, so this box knows they were that Mac's).
  const replaced = mac && Array.isArray(input.replaces) ? input.replaces.filter((key): key is string => typeof key === "string" && KEY.test(key) && key !== mac).slice(0, 8) : [];
  let formerMacs: string[] = [];
  updateLink(current => {
    const next = current ?? { secret: crypto.randomBytes(32).toString("base64url"), key: newKey().toString("base64url"), phones: [] };
    next.sign ??= newSigningSeed();
    if (mac) {
      next.mac = mac;
      next.macs = [...new Set([...macsOf(next), mac])];
      forgetOldMacs(next, mac);
      if (typeof input.macName === "string" && plainName(input.macName)) next.macNames = { ...(next.macNames ?? {}), [mac]: plainName(input.macName).slice(0, 100) };
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
      // That Mac under its keys before: no Mac of this box's any more (never two of one Mac).
      formerMacs = replaced.filter(key => macsOf(next).includes(key));
      for (const key of formerMacs) leaveMac(next, key);
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
    // (docsWork has folded its phones, so there's a list.)
    if (!next.phones!.length && !peersOf(next).length) return current ? next : null;
    next.relay = String(input.relay);
    next.name = String(input.name || next.name || os.hostname()).slice(0, 100);
    link = next;
    return next;
  });
  if (work && library !== before) await takePersonalities(library).catch(() => {});
  // (What those keys' agents were, told here, goes with them.)
  const after = link ?? readLink();
  if (after) for (const key of formerMacs) forgetMacsAgents(key, after);
  // The running bridge tells your other computers what changed; its setup card says what it's in now.
  noteDocsChanged();
  try { writeCard(); } catch {}
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
    address: addressOf(Buffer.from(link.secret!, "base64url")).toString("base64url"),
    key: publicOf(Buffer.from(link.key!, "base64url")).toString("base64url"),
    // Talks to other boxes itself (PROTOCOL.md, "Peers").
    peers: true,
    // Its signing key, and the documents it has, for the Mac to take (PROTOCOL.md, "Documents").
    sign: ownSign(link),
    docs: setupDocs(link),
  }));
}

// What setup gives back of documents: those this box keeps, and its own as they are now.
/** Whether `bytes` read as UTF-8 text, every one of them. */
function isUTF8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function setupDocs(link: LinkState): SignedDoc[] {
  const state = { link, library: readPersonalities() };
  const own = ownDocs(state);
  return [...Object.values(link.docs ?? {}), ...Object.values(own).map(each => each.envelope)];
}

// `leave <mac>`: Mac `mac` removed this machine. It's no longer one of its Macs: its lists of
// peers and phones no longer count here, and what peers only it named told goes. Another Mac's
// stay; with no peers or phones left, the bridge stops.
export function leave(mac: unknown): boolean {
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
  try { writeCard(); } catch {}
  return true;
}

function pair(relay: string | undefined): void {
  // Only your setup's main computer pairs phones: a member names it, and pairs none (exit 3).
  const main = mainElsewhere(readLink());
  if (main) {
    console.error(pairElsewhere(main).message);
    // (Until a takeover can be made: a main computer that's gone for good is let go here, as
    // removing this computer from it would. What that costs is said with it.)
    const name = main.name || "it";
    console.error(`If ${name} is gone for good, \`kuvo-link.js leave ${main.key}\` takes this computer out of its setup: your other computers, and phones paired with ${name}, no longer reach it here. Then it pairs phones itself, or names another main computer.`);
    process.exit(3);
  }
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
  console.log(pairingLink(link as Parameters<typeof pairingLink>[0]));
  console.error(`Open this link on your phone within ${PAIRING_MINUTES} minutes. It works once.`);
  if (!runningBridge()) startBridge();
}

// Checks this runtime has what the link needs, both ends of a session and a mail.
export function selftest(): boolean {
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
  else if (mode === "leave") {
    // (A Mac removing this machine runs it over SSH, and reads nothing it says.)
    const name = typeof argument === "string" ? macName(readLink(), argument) : "";
    if (!leave(argument)) {
      console.error("That isn't one of the Macs that set this computer up.");
      process.exit(1);
    }
    console.error(`${name || "That Mac"} is let go: this computer is no longer one of its computers.`);
  }
  // Kuvo Code as it opens on a Mac, before it starts a box (PROTOCOL.md, "Your setup", "Already in a
  // setup?"): whether it uses its own box, or the one already on this Mac, in place. `here <root>`,
  // root the machines' folder's name in the home folder (`.kuvo-code`, or a test's own), with
  // KUVO_HOME the app's own box's folder: both said, never guessed.
  else if (mode === "here") {
    try {
      console.log(JSON.stringify(hereNow(argument)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    }
  }
  // A machine's start scripts' (`kuvo-launch`): what its engine starts with, its OPENCODE_CONFIG_CONTENT
  // with the sandbox's note, and what some providers need beside its settings, as this box last
  // learned it (PROTOCOL.md, "Settings per box").
  else if (mode === "engine-config") {
    // A machine's start runs this before each start of its engine, with or without a bridge or a Mac:
    // its settings as its catalogs have them, before the engine reads them. (This Mac's app runs it
    // too, for what it prints, not as its box: `serve` did this, and there's no settings file here.)
    await upgradeIntegrations().catch(() => {});
    // What it learned before it kept it there (an older box's), or a copy taken away meanwhile.
    if (knowsEngineSettings()) {
      try { applyCompatibility(); } catch {}
    }
    process.stdout.write(engineConfigContent(process.env.OPENCODE_CONFIG_CONTENT));
  }
  // A machine's start scripts' too: the PATH your login shell sets up there (`~/.local/bin`, nvm's
  // node), then the folders of the one it was run with, for the engine and what it starts, which a
  // start over SSH or from cron doesn't get. Nothing when the shell doesn't give it, for the start
  // to keep the PATH it has.
  // Kept for the link and the agents' bridge (each read can leave a program a .bashrc starts running).
  else if (mode === "login-path") {
    const found = await loginPath();
    if (found) saveLoginPath(K, found);
    process.stdout.write(found ?? "");
  }
  else if (mode === "update") {
    // `update [--now]`, and for a test's folder only, `--url <boxes.json> --key <public key>`. Once
    // it's updated, the running bridge goes, for the keeper to start the new one.
    const args = process.argv.slice(3);
    const option = (name: string): string | undefined => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
    const test = option("--url") && option("--key") && !REAL_BOX;
    const outcome = await update({ now: args.includes("--now"), step: running => noteUpdate({ running }), ...(test ? { url: option("--url"), keys: [option("--key")!], blocked: null } : {}) });
    noteUpdate({ running: null, ...(outcome.result === "updated" ? {} : { last: { at: Date.now(), ...outcome } }) });
    if (outcome.result === "updated") {
      const pid = runningBridge();
      if (pid) process.kill(pid, "SIGTERM");
      // No bridge to start again (nothing for it to answer): the new version came up, so it's done.
      if (!needed(readLink())) {
        confirmUpdate();
        await upgradeIntegrations().catch(() => {});
      }
    }
    console.log(JSON.stringify(outcome));
  }
  // The browser agents use here (PROTOCOL.md, "The browser on a machine"): `browser install [--now]
  // [--repair]` sets it up, as the keeper starts it (one at a time); `browser start [--now]
  // [--repair]` has it set up in a process of its own, as a browser tool does, and says how it
  // stands then; `browser status` says how it stands.
  else if (mode === "browser") {
    const args = process.argv.slice(3);
    if (argument === "install") {
      const outcome = await installBrowser({ now: args.includes("--now"), repair: args.includes("--repair") });
      console.log(JSON.stringify({ outcome, ...browserStatus() }));
    } else if (argument === "start") {
      console.log(JSON.stringify(startBrowserInstall({ now: args.includes("--now"), repair: args.includes("--repair") })));
    } else if (argument === "status") {
      console.log(JSON.stringify(browserStatus()));
    } else {
      console.error("Usage: kuvo-link.js browser install|start [--now] [--repair] | status");
      process.exit(2);
    }
  }
  else if (mode === "selftest") {
    const ok = selftest();
    console.log(ok ? "ok" : "failed");
    process.exit(ok ? 0 : 1);
  } else {
    console.error("Usage: kuvo-link.js run | serve | setup | pair [relay] | box <command> | leave <mac> | here <root> | engine-config | login-path | update [--now] | browser install|start|status | selftest");
    process.exit(2);
  }
}
