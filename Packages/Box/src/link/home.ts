// This box's home: its folder and the files every part of it reads, and what kind of box it is
// (a machine's, in `~/.kuvo-code`; or this Mac's, which its app starts in a folder of its own).

import os from "node:os";
import path from "node:path";

export const K = process.env.KUVO_HOME || path.join(os.homedir(), ".kuvo-code");
export const RUN = path.join(K, "run");
export const LINK_FILE = path.join(RUN, "link.json");
export const ENGINE_FILE = path.join(RUN, "engine.json");
// The coding agents' bridge beside the engine (kuvo-agents.js): its port and password.
export const BRIDGE_FILE = path.join(RUN, "bridge.json");
export const PID_FILE = path.join(RUN, "link.pid");
// While it's there, the box's keeper keeps this bridge running (`bin/kuvo-start keep`).
export const NEEDED_FILE = path.join(RUN, "link.needed");
export const VERSION_FILE = path.join(RUN, "link.version");

// COMPAT(0.7 settings): until a Mac adopts them (`adoptBox`), a machine's settings are the ones an older Mac's start left. Goes 3 months after 0.8.0.
// A machine's own settings and keys, in a folder of their own (`box`), which no older Kuvo Code
// writes: the engine reads the file (`OPENCODE_CONFIG`, over the global one) and reloads it when it
// changes. Before a Mac made them the machine's own (`adoptBox`), its Mac's.
export const BOX = path.join(K, "box");
// Its integrations' keys (KUVO_KEY_…), and its bots' own.
export const BOX_KEYS = path.join(BOX, "keys");
// Bots' own keys (`answerBotKeys`), the box's own beside its shared ones: a start from a Mac
// replaces what it sent in `keys`, and leaves `box` alone.
export const BOT_KEYS = path.join(K, "box", "bot-keys");
// What the box's own updates keep: the files a rollback puts back, what was installed.
export const UPDATES = path.join(K, "updates");
// The engine's settings and keys change one at a time, whoever changes them.
export const CONFIG_LOCK = path.join(RUN, ".config.lock");

// A Mac's box finds them where its app keeps them, as the engine does (KUVO_BOTS, KUVO_WAKES, and the
// app's own kuvo-wake); a machine's, in its folder.
export const BOTS = process.env.KUVO_BOTS || path.join(K, "bots");

// Whether this is a Mac's box, said two ways by two of what its app starts it with (both always
// together; they could be one):
// This Mac's box (BoxProcess says so as it starts it): its bots are the Mac's own, made with the
// kit its app gives it and told they run on this Mac; it names no machine, keeps no notes for a
// Mac to take in, and goes by the Mac's own clock.
export const ON_MAC = process.env.KUVO_BOX === "mac";
// This box's computer, as what it says names it.
export const HERE = ON_MAC ? "this Mac" : "this machine";
// This Mac's box: its settings are the app's engine's, where they've always been (KUVO_ENGINE_CONFIG,
// the engine's XDG_CONFIG_HOME), its own from the start; its keys are in the Mac's Keychain, which
// the engine reads from the files the app writes them to (KUVO_KEYS); and the servers that use a
// Mac's own apps run here.
export const ENGINE_CONFIG = process.env.KUVO_ENGINE_CONFIG;
export const IS_MAC = Boolean(ENGINE_CONFIG);
