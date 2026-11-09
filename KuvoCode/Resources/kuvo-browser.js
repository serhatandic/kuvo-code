// Kuvo Code's browser on a machine: a Chromium kept running there, which the agent browses with
// and the app shows live in its panel. The engine's own runtime runs it, so the machine needs
// nothing else:
//
//   BUN_BE_BUN=1 opencode kuvo-browser.js mcp       the agent's browser tools, for the engine
//   BUN_BE_BUN=1 opencode kuvo-browser.js connect   the app's live view, over SSH
//   BUN_BE_BUN=1 opencode kuvo-browser.js host      the keeper, started by either of the others
//
// The keeper drives Chromium over a pipe, never a port, and lets the others in through a socket
// in ~/.kuvo-code/run, a folder only this user can open. It relays Chrome's DevTools protocol to
// each, and keeps which page is in use, so the agent and the app follow each other. It stops
// Chromium after a while with nobody connected.
//
// The app writes this file to the machine, with the browsing scripts and tools filled in below.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONFIG = /*KUVO_CONFIG*/ { scripts: {}, tools: [], instructions: "", version: "dev" };

const K = process.env.KUVO_HOME || path.join(os.homedir(), ".kuvo-code");
const RUN = path.join(K, "run");
const SOCKET = path.join(RUN, "browser.sock");
// What every connection to the keeper gives first, as to the box's vault: Kuvo Code's processes read
// it here, a command in the sandbox can't (it can connect to a socket it can't read the folder of).
// The same as the box's (`socketKey` in its home.ts).
const SOCKET_KEY_FILE = path.join(RUN, "socket.key");
const PIDFILE = path.join(RUN, "browser.pid");
// The pages open when the keeper last stopped (for an update, or with nobody around), to open
// again when it starts.
const PAGESFILE = path.join(RUN, "pages.json");
// What agents ask the user for now, for the machine's phone link, which answers it for a phone
// with the Mac closed (KuvoLink's PROTOCOL.md, "kuvo/asks"); gone while nothing is.
const ASKSFILE = path.join(RUN, "browser-asks.json");
const ERRORFILE = path.join(RUN, "browser.error");
const LOGFILE = path.join(RUN, "browser.log");
const BROWSER = path.join(K, "browser");
// The installed Chromium, with the libraries and fonts it needs.
const CURRENT = path.join(BROWSER, "current");
// Website data: cookies and sign-ins stay between starts.
const PROFILE = path.join(BROWSER, "profile");
// What pages download, under their own names; gone after a week.
const DOWNLOADS = path.join(BROWSER, "downloads");
// Chromium's temporary files: the socket its lock answers on, and the shared memory that
// --disable-dev-shm-usage puts there. Emptied each time it starts.
const TMP = path.join(BROWSER, "tmp");
const SCRIPT = process.argv[1];
// How long Chromium keeps running with nobody connected.
const IDLE = Number(process.env.KUVO_BROWSER_IDLE || 10 * 60) * 1000;
// The languages to ask sites for: those of the Mac that started it ("en-GB,en,tr-TR,tr").
const LANGUAGES = String(process.env.KUVO_LANG || "").split(",").filter((tag) => /^[A-Za-z0-9-]+$/.test(tag));
// How long a page only agents used, and no Mac has shown, stays open once they've left it, as the
// Mac's panel keeps an agent's tab you haven't looked at (Utilities.agentTabIdle).
const TAB_IDLE = Number(process.env.KUVO_BROWSER_TAB_IDLE || 3600) * 1000;

// Goes up with every change to the keeper (host mode): a newer one replaces one that's running
// (its pages close, its sign-ins stay), and an older one never replaces a newer.
const KEEPER = 49;
// Passkeys: none yet, as in the panel's browser on the Mac (Passkeys.swift, the same script).
const NO_PASSKEYS = "(() => {\n  try {\n    // Says a passkey was asked for with an event only this launch's listener, in a world of its\n    // own, knows the name of: nothing of it is left in the page's world. (Taken before the page\n    // can change them.)\n    const dispatch = EventTarget.prototype.dispatchEvent, Made = Event;\n    const tell = () => {\n      try {\n        dispatch.call(window, new Made(\"KUVO_PASSKEY_EVENT\"));\n      } catch {}\n    };\n    const none = (options) => {\n      // Asked of you, not looked for quietly as the page loads.\n      if (options.mediation !== \"conditional\") tell();\n      return Promise.reject(new DOMException(\"Passkeys can't be used in this browser.\", \"NotAllowedError\"));\n    };\n    const Container = window.CredentialsContainer;\n    if (Container && Container.prototype) {\n      const prototype = Container.prototype, get = prototype.get, create = prototype.create;\n      if (get) prototype.get = function (options) { return options && options.publicKey ? none(options) : get.call(this, options); };\n      if (create) prototype.create = function (options) { return options && options.publicKey ? none(options) : create.call(this, options); };\n    }\n    const Credential = window.PublicKeyCredential;\n    if (Credential) {\n      Credential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);\n      if (Credential.isConditionalMediationAvailable) Credential.isConditionalMediationAvailable = () => Promise.resolve(false);\n    }\n  } catch {}\n})();";
// The event it fires when a passkey is asked for (a name of this keeper's, which only the
// listener knows), the world of the keeper's own the listener runs in, and the binding it tells
// the keeper through there: nothing of them is in the page's world.
const PASSKEY_EVENT = "kuvo-" + crypto.randomUUID();
const PASSKEY_WORLD = "kuvo-passkeys";
const PASSKEY_BINDING = "kuvoPasskeyAsked";
// (The binding comes back a moment after a new page does, so it's looked for a while.)
const PASSKEY_LISTENER = `window.addEventListener(${JSON.stringify(PASSKEY_EVENT)}, () => {
  const tell = (tries) => {
    const binding = globalThis.${PASSKEY_BINDING};
    if (typeof binding === "function") binding("");
    else if (tries > 0) setTimeout(() => tell(tries - 1), 100);
  };
  tell(20);
});`;
// What the agent's look at a page says when its site asked for one (as BrowserAgent.swift's).
const PASSKEY_NOTE = "This site asked for a passkey, which this browser can't use. Don't choose its passkey option again: sign in another way (a password, a code or an email link), or ask the user.";

// Bun's own, never its settings (`bunfig.toml`, which can preload a script) or a `.env` from the
// folder it starts in (an agent's command can write them); a test's Node loads neither.
const OWN_RUNTIME = process.versions.bun ? ["--config=/dev/null", "--no-env-file"] : [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// The key for the box's sockets, made once (whole, before anyone can read it).
function socketKey() {
  const shape = /^[0-9a-f]{64}$/;
  try {
    const key = fs.readFileSync(SOCKET_KEY_FILE, "utf8").trim();
    if (shape.test(key)) return key;
  } catch {}
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const made = `${SOCKET_KEY_FILE}.${process.pid}`;
  fs.writeFileSync(made, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  // Linked into place: whoever made it first, the others take theirs. (One that isn't a key at all
  // is replaced, as it is where a folder can't link files.)
  try {
    fs.linkSync(made, SOCKET_KEY_FILE);
  } catch {
    let there = "";
    try {
      there = fs.readFileSync(SOCKET_KEY_FILE, "utf8").trim();
    } catch {}
    if (!shape.test(there)) {
      try {
        fs.renameSync(made, SOCKET_KEY_FILE);
      } catch {}
    }
  }
  fs.rmSync(made, { force: true });
  return fs.readFileSync(SOCKET_KEY_FILE, "utf8").trim();
}

/// Whether `given` is the key for the box's sockets.
function sameKey(given) {
  if (typeof given !== "string") return false;
  let key;
  try {
    key = Buffer.from(socketKey());
  } catch {
    return false;
  }
  const said = Buffer.from(given);
  return said.length === key.length && crypto.timingSafeEqual(said, key);
}

/// A connection to the keeper, the key given first.
function keeperConnection() {
  const socket = net.createConnection(SOCKET);
  socket.once("connect", () => {
    try {
      socket.write(JSON.stringify({ method: "Kuvo.key", params: { key: socketKey() } }) + "\n");
    } catch {
      socket.destroy();
    }
  });
  return socket;
}

/// Calls `handle` with each line `stream` sends; `tooLong`, with how much of a line it holds,
/// says whether it's held too much (and stops it).
function lines(stream, handle, separator = "\n", tooLong = () => false) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf(separator)) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line) handle(line);
    }
    if (tooLong(buffer.length)) buffer = "";
  });
}

/// Whether a keeper answers on the socket.
function reachable() {
  return new Promise((resolve) => {
    const socket = net.createConnection(SOCKET);
    const done = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), 1500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/// The running keeper's version, from its greeting (1 before keepers said).
function runningKeeper() {
  return new Promise((resolve) => {
    const socket = keeperConnection();
    let buffer = "";
    const done = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 2000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        done(JSON.parse(buffer.slice(0, end)).params?.keeper ?? 1);
      } catch {
        done(1);
      }
    });
    socket.once("error", () => done(null));
  });
}

/// Asks the running keeper to stop, and waits until it has.
async function stopKeeper() {
  await new Promise((resolve) => {
    const socket = keeperConnection();
    socket.once("connect", () => socket.end(JSON.stringify({ method: "Kuvo.stop" }) + "\n", resolve));
    socket.once("error", resolve);
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await reachable())) await sleep(200);
}

/// Starts the keeper if it isn't running (or an older one is), and waits for it: nil once it
/// answers, else what's wrong.
async function ensure() {
  if (await reachable()) {
    const running = await runningKeeper();
    if (running === null || running >= KEEPER) return null;
    await stopKeeper();
  }
  if (!browserBinary(CURRENT)) {
    return { kind: "missing", message: "The browser isn't on this machine yet. Kuvo Code puts it there when it connects to the machine; try again in a minute." };
  }
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  fs.rmSync(ERRORFILE, { force: true });
  // In a session of its own, so it outlives whoever started it.
  const child = spawn(process.execPath, [...OWN_RUNTIME, SCRIPT, "host"], { detached: true, stdio: "ignore", env: { ...process.env, BUN_BE_BUN: "1" }, cwd: BROWSER });
  child.unref();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await sleep(150);
    if (await reachable()) return null;
    if (fs.existsSync(ERRORFILE)) {
      try {
        return JSON.parse(fs.readFileSync(ERRORFILE, "utf8"));
      } catch {}
    }
  }
  return { kind: "failed", message: "The browser took too long to start." };
}

// MARK: - The keeper

function alive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // (Alive and not to be asked: taken as it.)
  return commandLine(pid)?.includes("kuvo-browser") ?? true;
}

/// A process's command line: in /proc on Linux, from `ps` on a Mac; undefined if it can't be read.
function commandLine(pid) {
  try {
    if (fs.existsSync("/proc/self")) return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/// Becomes the one keeper, unless another is running. The record of who it is appears whole (a
/// link to a file already written), so another keeper never reads it half-written; one that's left
/// from a keeper that died is taken over, and if two start at that moment, the one whose record
/// stays keeps going.
async function claim() {
  const mine = `${PIDFILE}.${process.pid}`;
  fs.writeFileSync(mine, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(mine, PIDFILE);
        await sleep(100 + Math.random() * 200);
        return Number(fs.readFileSync(PIDFILE, "utf8")) === process.pid;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let holder = 0;
        try {
          holder = Number(fs.readFileSync(PIDFILE, "utf8"));
        } catch {}
        if (alive(holder)) return false;
        fs.rmSync(PIDFILE, { force: true });
      }
    }
    return false;
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

function fail(kind, message) {
  fs.writeFileSync(ERRORFILE, JSON.stringify({ kind, message }), { mode: 0o600 });
  fs.rmSync(PIDFILE, { force: true });
  process.exit(1);
}

function chromiumVersion() {
  try {
    return fs.readFileSync(path.join(CURRENT, "chromium-version"), "utf8").trim();
  } catch {
    return "130.0.0.0";
  }
}

// What the browser says it is: Chromium on what it runs on (Linux, or a Mac, which every Mac's
// browser says it is on Intel's). Sites serve a reduced page, or none, to one that
// says "HeadlessChrome" (x.com answers 403), and it says so in two places: the user agent, and
// the brand hints (Sec-CH-UA) pages send and read.
function userAgent() {
  const major = chromiumVersion().split(".")[0];
  if (process.platform === "darwin") return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const platform = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `Mozilla/5.0 (X11; Linux ${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function identity() {
  const version = chromiumVersion();
  const major = version.split(".")[0];
  return {
    userAgent: userAgent(),
    ...(LANGUAGES.length ? { acceptLanguage: LANGUAGES.join(",") } : {}),
    userAgentMetadata: {
      brands: [{ brand: "Chromium", version: major }, { brand: "Not-A.Brand", version: "24" }],
      fullVersionList: [{ brand: "Chromium", version }, { brand: "Not-A.Brand", version: "24.0.0.0" }],
      platform: process.platform === "darwin" ? "macOS" : "Linux",
      platformVersion: "",
      architecture: process.arch === "arm64" ? "arm" : "x86",
      bitness: "64",
      model: "",
      mobile: false,
    },
  };
}

/// A finished download, from its temporary name to its own (numbered if that's taken). Its path,
/// or null if it's gone.
function finishDownload(guid, name) {
  // At most 200 bytes, whole characters, its extension kept (a name can't be longer than 255
  // bytes there).
  const whole = path.basename(String(name)).replace(/^\.+/, "") || "download";
  let extension = path.extname(whole);
  let stem = whole.slice(0, whole.length - extension.length);
  if (Buffer.byteLength(extension) > 20) [stem, extension] = [whole, ""];
  // 200 characters first, then fewer while they're over 200 bytes: a site's name can be very long.
  const characters = [...stem].slice(0, 200);
  while (Buffer.byteLength(characters.join("") + extension) > 200) characters.pop();
  stem = characters.join("");
  const safe = stem + extension;
  let file = path.join(DOWNLOADS, safe);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(DOWNLOADS, `${stem} ${n}${extension}`);
  try {
    fs.renameSync(path.join(DOWNLOADS, guid), file);
    return file;
  } catch {
    return null;
  }
}

/// Downloads more than a week old.
function clearOldDownloads() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  let entries = [];
  try {
    entries = fs.readdirSync(DOWNLOADS, { withFileTypes: true });
  } catch {}
  for (const entry of entries) {
    const file = path.join(DOWNLOADS, entry.name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { recursive: true, force: true });
    } catch {}
  }
}

/// The browser in a build: Chrome itself, or the headless shell an earlier build had.
function browserBinary(build) {
  for (const name of ["chrome", "chrome-headless-shell"]) {
    if (fs.existsSync(path.join(build, name))) return name;
  }
  return null;
}

/// What a Chromium that was stopped hard left of its lock somewhere else, like the machine's
/// /tmp (one from before it had a folder of its own): gone, once that Chromium is.
function removeStaleLock() {
  try {
    // "<host>-<pid>", of the Chromium that last had the profile.
    const owner = fs.readlinkSync(path.join(PROFILE, "SingletonLock"));
    const pid = Number(owner.slice(owner.lastIndexOf("-") + 1));
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        return;
      } catch (error) {
        if (error.code !== "ESRCH") return;
      }
    }
    const folder = path.dirname(fs.readlinkSync(path.join(PROFILE, "SingletonSocket")));
    if (!/^(org\.chromium\.Chromium|com\.google\.Chrome|com\.google\.chrome\.for\.testing)\.[A-Za-z0-9]+$/.test(path.basename(folder))) return;
    if (fs.lstatSync(folder).uid !== process.getuid()) return;
    fs.rmSync(folder, { recursive: true, force: true });
  } catch {}
}

/// What each editing key does on a Mac, by what clients and tools send (as on Linux: Control for ⌘,
/// Home and End for ⌘← and ⌘→). Chrome on a Mac gets these from its window's key bindings, which a
/// key sent over DevTools never reaches: without them a key sent to a field does nothing.
const MAC_MOVES = { ArrowLeft: "moveLeft", ArrowRight: "moveRight", ArrowUp: "moveUp", ArrowDown: "moveDown", Home: "moveToLeftEndOfLine", End: "moveToRightEndOfLine" };
const MAC_WORD_MOVES = { ArrowLeft: "moveWordLeft", ArrowRight: "moveWordRight", Home: "moveToBeginningOfDocument", End: "moveToEndOfDocument" };
const MAC_DELETES = { Backspace: "deleteBackward", Delete: "deleteForward" };
const MAC_WORD_DELETES = { Backspace: "deleteWordBackward", Delete: "deleteWordForward" };
const MAC_LETTERS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" };

/// A key as Chrome here takes it: on Linux as it's sent; on a Mac with ⌘ for Control, as pages there
/// expect, and what it does named.
function keyForHere(params, platform = process.platform) {
  if (platform !== "darwin") return params;
  const CONTROL = 2, META = 4, SHIFT = 8;
  const modifiers = params.modifiers ?? 0;
  const control = (modifiers & CONTROL) !== 0, shift = (modifiers & SHIFT) !== 0;
  const mac = { ...params, modifiers: control ? (modifiers & ~CONTROL) | META : modifiers };
  if (params.type === "keyUp" || params.commands?.length) return mac;
  const key = String(params.key ?? "");
  const move = (control ? MAC_WORD_MOVES : MAC_MOVES)[key];
  let command = move ? move + (shift ? "AndModifySelection" : "") : (control ? MAC_WORD_DELETES : MAC_DELETES)[key];
  if (control && !command) command = key.toLowerCase() === "z" && shift ? "redo" : shift ? undefined : MAC_LETTERS[key.toLowerCase()];
  return command ? { ...mac, commands: [command] } : mac;
}

/// Starts Chromium and waits until it answers on its pipe.
async function launchChrome(sandbox) {
  const binary = browserBinary(fs.realpathSync(CURRENT)) ?? "chrome-headless-shell";
  const args = [
    // Chrome itself, without a window: the browser sites see from people, where the headless
    // shell is one Google won't sign anyone in from ("This browser or app may not be secure").
    // Its passwords in its profile, not a desktop keyring the server doesn't have.
    ...(binary === "chrome" ? ["--headless", "--enable-unsafe-swiftshader", "--password-store=basic"] : []),
    // On a Mac, nobody's there to answer what it would ask: its passwords' key from the login
    // keychain, and looking for devices on the local network (casting, which nothing here uses).
    ...(process.platform === "darwin" ? ["--use-mock-keychain", "--disable-features=MediaRouter,DialMediaRouteProvider"] : []),
    // A page nobody's looking at keeps going at full speed, as a bot's work in it needs.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    // Not driven by WebDriver, so it doesn't say it is (navigator.webdriver).
    "--disable-blink-features=AutomationControlled",
    "--remote-debugging-pipe",
    `--user-data-dir=${PROFILE}`,
    "--window-size=1280,800",
    // A Retina screen's scale, so pictures of the page are as sharp as the Mac shows them: an
    // emulated scale alone lays the page out for it, but the live view still comes at half size.
    "--force-device-scale-factor=2",
    ...(LANGUAGES.length ? [`--lang=${LANGUAGES[0]}`, `--accept-lang=${LANGUAGES.join(",")}`] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--mute-audio",
    // A scroll moves the page at once: the Mac's trackpad and wheel already ease it, and
    // Chrome's own easing on top, drawn a few times a second on a server, made it lag behind.
    "--disable-smooth-scrolling",
    `--user-agent=${userAgent()}`,
    "about:blank",
  ];
  if (!sandbox) args.unshift("--no-sandbox");
  // The build's own folder rather than `current`, which an update moves: its path shows which
  // build a running browser uses, so the update leaves that one in place.
  const build = fs.realpathSync(CURRENT);
  const lib = path.join(build, "lib");
  // A home of its own, inside Kuvo Code's folder: what Chromium keeps there (its certificate store,
  // caches, downloads) never lands in the user's.
  const home = path.join(BROWSER, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // The build's fonts, and the machine's own if it has any, with fontconfig's cache in that home
  // (written with whole paths: a relative one lands wherever the browser happens to start).
  const fontsConfig = path.join(home, "fonts.conf");
  const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  fs.writeFileSync(fontsConfig, [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    "<fontconfig>",
    `  <dir>${xml(path.join(build, "fonts"))}</dir>`,
    '  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>',
    `  <cachedir>${xml(path.join(home, ".cache", "fontconfig"))}</cachedir>`,
    // Droid Sans after them for the scripts they don't have: Chinese, Japanese and Korean (in
    // Droid Sans Fallback), Hebrew, Thai, Devanagari, Tamil and others; Japanese in its own
    // forms on a Japanese page.
    "  <alias><family>sans-serif</family><prefer><family>Liberation Sans</family><family>DejaVu Sans</family><family>Droid Sans</family><family>Droid Sans Fallback</family></prefer></alias>",
    "  <alias><family>serif</family><prefer><family>Liberation Serif</family><family>DejaVu Sans</family><family>Droid Sans Fallback</family></prefer></alias>",
    "  <alias><family>monospace</family><prefer><family>Liberation Mono</family><family>DejaVu Sans</family><family>Droid Sans Fallback</family></prefer></alias>",
    "  <alias><family>emoji</family><prefer><family>Noto Color Emoji</family></prefer></alias>",
    '  <match><test name="lang" compare="contains"><string>ja</string></test><edit name="family" mode="prepend"><string>Droid Sans Japanese</string></edit></match>',
    "</fontconfig>",
    "",
  ].join("\n"));
  // Its temporary files in its own folder, never the machine's /tmp, where one stopped hard would
  // leave them. Unless that's too far down for its lock's socket (a path of 107 bytes at most, 103
  // on a Mac):
  // then wherever its temporary files would go otherwise.
  removeStaleLock();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
  const fits = Buffer.byteLength(path.join(TMP, "org.chromium.Chromium.XXXXXX", "SingletonSocket")) <= (process.platform === "darwin" ? 103 : 107);
  const env = {
    ...process.env,
    ...(fits ? { TMPDIR: TMP } : {}),
    HOME: home,
    // (A Mac's programs find your home by your account, and this is what they take it from instead.
    // The one thing that still lands in the real one is the system's own record of Chrome's last run,
    // in its preferences, which nothing here changes: removing the machine takes it out.)
    CFFIXED_USER_HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    // Its own libraries and fonts, never the machine's: nothing has to be installed there.
    LD_LIBRARY_PATH: [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    FONTCONFIG_FILE: fontsConfig,
    GIO_MODULE_DIR: path.join(lib, "gio-modules"),
    GSETTINGS_BACKEND: "memory",
  };
  delete env.BUN_BE_BUN;
  const log = fs.openSync(LOGFILE, "a", 0o600);
  fs.writeSync(log, `--- ${new Date().toISOString()} starting${sandbox ? "" : " without the sandbox"}\n`);
  const chrome = spawn(path.join(build, binary), args, { stdio: ["ignore", log, log, "pipe", "pipe"], env, cwd: home });
  fs.closeSync(log);
  let exited = null;
  chrome.on("exit", (code, signal) => (exited = { code, signal }));
  chrome.on("error", (error) => (exited = { code: -1, error }));
  const pipe = { input: chrome.stdio[3], output: chrome.stdio[4] };
  pipe.input.on("error", () => {});

  // Asks for its version; Chromium answers once it's up.
  const answered = new Promise((resolve) => {
    let buffer = "";
    const listen = (chunk) => {
      buffer += chunk;
      if (buffer.includes('"id":1,')) {
        pipe.output.off("data", listen);
        resolve(true);
      }
    };
    pipe.output.setEncoding("utf8");
    pipe.output.on("data", listen);
  });
  pipe.input.write(JSON.stringify({ id: 1, method: "Browser.getVersion" }) + "\0");
  const deadline = Date.now() + 30_000;
  let ready = false;
  answered.then(() => (ready = true));
  while (!ready && !exited && Date.now() < deadline) await sleep(50);
  if (ready) return { chrome, pipe };
  chrome.kill("SIGKILL");
  let output = "";
  try {
    output = fs.readFileSync(LOGFILE, "utf8");
  } catch {}
  return { output: output || (exited?.error ? String(exited.error.message) : ""), timedOut: !exited };
}

async function host() {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  fs.chmodSync(RUN, 0o700);
  if (!(await claim())) return;
  // A socket left behind by a keeper that's gone.
  if (await reachable()) {
    fs.rmSync(PIDFILE, { force: true });
    return;
  }
  fs.rmSync(SOCKET, { force: true });
  fs.mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
  fs.writeFileSync(LOGFILE, "", { mode: 0o600 });

  // Sandboxed when the machine allows it (it needs user namespaces, which some distributions turn
  // off); as root, or where Chromium says it can't be, without. Anything else gets a second try.
  const isRoot = process.getuid && process.getuid() === 0;
  let sandbox = !isRoot;
  // The pages open last time, opened again once the browser's up (after the keeper's own
  // watch on pages, so they load as the browser it says it is).
  let reopen = [];
  try {
    reopen = JSON.parse(fs.readFileSync(PAGESFILE, "utf8")).filter((url) => typeof url === "string" && /^(https?|file):/.test(url)).slice(0, 8);
  } catch {}
  fs.rmSync(PAGESFILE, { force: true });
  // What a keeper before this one left asked: it went with it.
  fs.rmSync(ASKSFILE, { force: true });
  let started = await launchChrome(sandbox);
  if (!started.chrome && sandbox && /No usable sandbox|SUID sandbox|user namespace/i.test(started.output)) sandbox = false;
  if (!started.chrome) started = await launchChrome(sandbox);
  if (!started.chrome) {
    const lines = started.output.trim().split("\n").filter((line) => !/^\s*$/.test(line)).slice(-6).join("\n");
    if (/GLIBC_[0-9.]+' not found/.test(started.output)) {
      fail("unsupported", "This machine's C library (glibc) is too old for the browser.\n\n" + lines);
    }
    fail("failed", (started.timedOut ? "The browser didn't start in time." : "The browser stopped as it started.") + (lines ? "\n\n" + lines : ""));
  }
  const { chrome, pipe } = started;

  let next = 2;
  const pending = new Map();
  const owners = new Map();
  const clients = new Set();
  let active = null;
  // The pages there are, so the one in use is always one of them.
  const targets = new Set();
  // The keeper's own session with each page and worker, which says what the browser is before
  // it loads anything; the ones clients open come after it.
  const own = new Map();
  // And with each frame of another site in a page, which Chrome runs on its own, as a target of
  // its own: held as it starts, as a page is.
  const ownFrames = new Set();
  const isOwn = (sessionId) => ownFrames.has(sessionId) || [...own.values()].includes(sessionId);
  // Each frame's target, and the page it's in, by its session.
  const frameTargets = new Map();
  const pageOf = (sessionId) => frameTargets.get(sessionId)?.page ?? [...own].find(([, each]) => each === sessionId)?.[0];
  // The page each frame of a page's own site is in (it runs in the page, no target of its own),
  // and the page that opened each page: where a download from one of them began.
  const framePages = new Map();
  const openers = new Map();
  // Sites that asked for a passkey lately (which this browser can't use), by host: an ask for
  // one says so, to tell you to choose another way to sign in.
  const passkeySites = new Map();
  const askedPasskeyLately = (host) => Date.now() - (passkeySites.get(host) ?? 0) < 10 * 60_000;
  // And the site of each page that asked, for a client that connects later (the agent's tools).
  const passkeyPages = new Map();
  // A page that's left that site, or closed: clients stop saying it.
  const passkeyCleared = (targetId) => {
    if (passkeyPages.delete(targetId)) broadcast({ method: "Kuvo.passkeyCleared", params: { targetId } });
  };
  // Downloads under way: their temporary names, and the names their sites gave them.
  const downloads = new Map();
  const browserIdentity = identity();
  let status = { working: false };
  let idle = null;
  // What agents ask the user for (a sign-in, a code, a step), by ID: who asked, and the ask. The
  // answer goes to the one who asked, and no one else.
  const asks = new Map();
  const noteAsks = () => {
    try {
      if (!asks.size) return fs.rmSync(ASKSFILE, { force: true });
      fs.writeFileSync(ASKSFILE + ".tmp", JSON.stringify({ asks: [...asks.values()].map((ask) => ask.params) }), { mode: 0o600 });
      fs.renameSync(ASKSFILE + ".tmp", ASKSFILE);
    } catch {}
  };
  const closeAsk = (id) => {
    if (asks.delete(id)) {
      broadcast({ method: "Kuvo.askClosed", params: { id } });
      noteAsks();
    }
  };

  const send = (client, message) => {
    if (!client.closed) client.socket.write((typeof message === "string" ? message : JSON.stringify(message)) + "\n");
  };
  const viewers = () => [...clients].filter((client) => client.viewer && !client.closed).length;
  const everyStatus = () => {
    const working = [...clients].filter((client) => client.status?.working && !client.closed);
    return {
      working: working.length > 0,
      tool: working[0]?.status.tool,
      pages: working.map((client) => client.status.targetId).filter(Boolean),
      // Who works where, for the Mac to name them.
      workers: working.filter((client) => client.status.targetId).map((client) => ({ targetId: client.status.targetId, session: client.status.session ?? null })),
    };
  };
  const broadcast = (message) => {
    const text = typeof message === "string" ? message : JSON.stringify(message);
    for (const client of clients) send(client, text);
  };
  const toChrome = (message) => pipe.input.write(JSON.stringify(message) + "\0");
  const internal = (method, params = {}) => {
    const id = next++;
    pending.set(id, { internal: true });
    toChrome({ id, method, params });
  };
  const setActive = (targetId, by, session) => {
    if (active === targetId) return;
    active = targetId;
    broadcast({ method: "Kuvo.activeChanged", params: { targetId, by, ...(session ? { session } : {}) } });
  };
  // Which conversation works in each page lately, so another one gets a page of its own rather
  // than taking over one in use; and when you last picked a page for a conversation.
  const claims = new Map();
  const picks = new Map();
  // Pages a Mac took over from the agents, and which client it is: their tools wait until it
  // hands them back, or goes.
  const held = new Map();
  // Which Mac took each page over, by the ID it gives: it can hand the page back from a new
  // connection while the old one is still open here (after a sleep).
  const holdMacs = new Map();
  // Pages held for a Mac whose connection dropped, with the drop they're kept from.
  const orphaned = new Map();
  const announceHeld = () => broadcast({ method: "Kuvo.held", params: { pages: [...held.keys()] } });
  // Each page's address, as the browser last said, and the page it started with.
  const addresses = new Map();
  let firstPage = null;
  // The page each client's session is attached to, to know which pages a Mac shows.
  const attachedTo = new Map();
  const shown = (targetId) => [...attachedTo].some(([sessionId, target]) => target === targetId && owners.get(sessionId)?.viewer);
  // Pages a Mac has shown: yours, kept however long agents leave them alone.
  const seen = new Set();
  // Pages only agents used, left alone for an hour, close: sessions' subagents and bots that wake
  // every hour don't pile up tabs. Never the page in use, one a Mac shows or showed, or the last one.
  // Unless the Mac's Settings › Panel keeps them (it leaves this file while it does), and not while
  // its conversation works or waits for you to go on in it (the engine's or the agents bridge's
  // sessions at work), as the Mac's panel does (Utilities.isBusy).
  setInterval(async () => {
    if (fs.existsSync(path.join(BROWSER, "keeps-agent-tabs"))) return;
    const idle = [...claims].filter(([targetId, claim]) => Date.now() - claim.at >= TAB_IDLE && targetId !== active && !shown(targetId) && !seen.has(targetId));
    if (!idle.length) return;
    const busy = new Set();
    for (const place of ["engine", "bridge"]) {
      const data = (await engine("GET", "api/session/active", undefined, place).catch(() => null))?.data;
      for (const id of Array.isArray(data) ? data : Object.keys(data ?? {})) busy.add(id);
    }
    for (const [targetId, claim] of idle) {
      if (busy.has(claim.session) || targets.size <= 1 || claims.get(targetId) !== claim) continue;
      claims.delete(targetId);
      internal("Target.closeTarget", { targetId });
    }
  }, Math.min(5 * 60_000, TAB_IDLE / 2)).unref();
  // A build an update put in `current` takes over once nobody uses this one (no agent at work or
  // between its steps lately, no page taken over or shown, nothing asked): what's open is kept,
  // and opens again when the next client starts the browser from there. Otherwise one started
  // before the update arrived would run the old build for as long as the engine does.
  const runsFrom = path.dirname(chrome.spawnfile);
  const usedLately = () => [...claims.values()].some((claim) => Date.now() - claim.at < 10 * 60_000);
  setInterval(() => {
    let installed;
    try {
      installed = fs.realpathSync(CURRENT);
    } catch {
      return;
    }
    if (installed === runsFrom || everyStatus().working || usedLately() || held.size || asks.size || viewers()) return;
    stop();
  }, 60_000).unref();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // What's open, to open again next time.
    const open = [...addresses.values()].filter((url) => /^(https?|file):/.test(url ?? ""));
    try {
      if (open.length) fs.writeFileSync(PAGESFILE, JSON.stringify(open.slice(-8)), { mode: 0o600 });
    } catch {}
    try {
      toChrome({ id: next++, method: "Browser.close" });
    } catch {}
    const deadline = Date.now() + 3000;
    while (chrome.exitCode === null && chrome.signalCode === null && Date.now() < deadline) await sleep(50);
    chrome.kill("SIGKILL");
    cleanUp();
    process.exit(0);
  };
  const cleanUp = () => {
    fs.rmSync(SOCKET, { force: true });
    fs.rmSync(ASKSFILE, { force: true });
    try {
      if (Number(fs.readFileSync(PIDFILE, "utf8")) === process.pid) fs.rmSync(PIDFILE, { force: true });
    } catch {}
  };
  const idleSoon = () => {
    clearTimeout(idle);
    idle = setTimeout(stop, IDLE);
  };

  chrome.on("exit", () => {
    for (const client of clients) client.socket.end();
    cleanUp();
    process.exit(0);
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);

  lines(pipe.output, (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (!request || request.internal) return;
      if (request.method === "Target.attachToTarget" && message.result?.sessionId) {
        owners.set(message.result.sessionId, request.client);
        request.client.sessions.add(message.result.sessionId);
        attachedTo.set(message.result.sessionId, request.targetId);
        if (request.client.viewer) seen.add(request.targetId);
      }
      message.id = request.id;
      send(request.client, message);
      return;
    }
    // Chrome gives a new document a binding only with its Runtime domain on (which sites notice):
    // each of the keeper's pages and frames gets it again as it navigates.
    if (message.method === "Page.frameNavigated" && message.sessionId && isOwn(message.sessionId)) {
      toChrome({ id: next++, method: "Runtime.addBinding", params: { name: PASSKEY_BINDING, executionContextName: PASSKEY_WORLD }, sessionId: message.sessionId });
    }
    // A page (or a frame of another site in it) asked for a passkey: its site as Chrome has it.
    if (message.method === "Runtime.bindingCalled" && message.params?.name === PASSKEY_BINDING) {
      if (!message.sessionId || !isOwn(message.sessionId)) return;
      // The page's site, as Chrome last said its address, which an ask names, even when a frame
      // of another site in it asked.
      const page = pageOf(message.sessionId);
      const host = page && hostOf(addresses.get(page) ?? "");
      // Asked again by the same page: said already.
      if (!host || passkeyPages.get(page) === host) return;
      for (const site of passkeySites.keys()) if (!askedPasskeyLately(site)) passkeySites.delete(site);
      passkeySites.set(host, Date.now());
      let changed = false;
      for (const ask of asks.values()) {
        if (ask.params.host !== host || ask.params.passkey) continue;
        ask.params.passkey = true;
        changed = true;
      }
      if (changed) noteAsks();
      passkeyPages.set(page, host);
      return broadcast({ method: "Kuvo.passkeyAsked", params: { host, targetId: page } });
    }
    if (message.method === "Target.detachedFromTarget") {
      frameTargets.delete(message.params.sessionId);
      const owner = owners.get(message.params.sessionId);
      owner?.sessions.delete(message.params.sessionId);
      owners.delete(message.params.sessionId);
      attachedTo.delete(message.params.sessionId);
    }
    // A page, or a frame of another site in one of the keeper's pages.
    const frame = message.method === "Target.attachedToTarget" && message.sessionId && isOwn(message.sessionId);
    if (message.method === "Target.attachedToTarget" && (frame || (!message.sessionId && !own.has(message.params.targetInfo.targetId)))) {
      const { sessionId, targetInfo, waitingForDebugger } = message.params;
      if (frame) {
        ownFrames.add(sessionId);
        frameTargets.set(sessionId, { targetId: targetInfo.targetId, page: pageOf(message.sessionId) });
      } else own.set(targetInfo.targetId, sessionId);
      toChrome({ id: next++, method: "Network.setUserAgentOverride", params: browserIdentity, sessionId });
      // No passkeys here yet: a page asking for one hears so at once, instead of Chrome's passkey
      // dialog, which no one sees in the live view, holding the page still (Passkeys.swift). The
      // page domain first: without it Chrome takes the script and never runs it.
      toChrome({ id: next++, method: "Page.enable", params: {}, sessionId });
      // How the script says a passkey was asked for: its listener in a world of the keeper's, and
      // the binding there (no Runtime domain needed, which sites notice).
      toChrome({ id: next++, method: "Runtime.addBinding", params: { name: PASSKEY_BINDING, executionContextName: PASSKEY_WORLD }, sessionId });
      toChrome({ id: next++, method: "Page.addScriptToEvaluateOnNewDocument", params: { source: PASSKEY_LISTENER, worldName: PASSKEY_WORLD, runImmediately: true }, sessionId });
      toChrome({ id: next++, method: "Page.addScriptToEvaluateOnNewDocument", params: { source: NO_PASSKEYS.replace("KUVO_PASSKEY_EVENT", PASSKEY_EVENT), runImmediately: true }, sessionId });
      // Its frames of other sites run on their own: the same for them (a sign-in button from
      // another site, say).
      toChrome({ id: next++, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId });
      if (waitingForDebugger) toChrome({ id: next++, method: "Runtime.runIfWaitingForDebugger", params: {}, sessionId });
      return;
    }
    if (message.method === "Target.detachedFromTarget" && (ownFrames.delete(message.params.sessionId) || [...own.values()].includes(message.params.sessionId))) return;
    if (message.method === "Page.frameAttached" && message.sessionId && isOwn(message.sessionId)) framePages.set(message.params.frameId, pageOf(message.sessionId));
    if (message.method === "Page.frameDetached" && message.sessionId && isOwn(message.sessionId)) framePages.delete(message.params.frameId);
    if (message.method === "Browser.downloadWillBegin" && !downloads.has(message.params.guid)) {
      // Whose it is: the conversation at work in the page it started in (a page's main frame's ID
      // is the page's; a frame's is its page's), now or in the last two minutes, unless you'd
      // taken the page over. One a page began as it opened (a link to a new tab) is that of the
      // page that opened it. Anyone else's (yours, a page an agent left) is nobody's.
      const pageWith = (frame) => framePages.get(frame) ?? [...frameTargets.values()].find((each) => each.targetId === frame)?.page ?? frame;
      const whose = (page) => {
        const worker = everyStatus().workers.find((each) => each.targetId === page && each.session);
        const claim = claims.get(page);
        return held.has(page) ? undefined : worker?.session ?? (claim && Date.now() - claim.at < 2 * 60_000 ? claim.session : undefined);
      };
      const page = pageWith(message.params.frameId);
      const opener = openers.get(page);
      const session = whose(page) ?? (opener && !held.has(page) ? whose(pageWith(opener)) : undefined);
      downloads.set(message.params.guid, { name: message.params.suggestedFilename || "download", session });
      broadcast({ method: "Kuvo.downloading", params: { name: downloads.get(message.params.guid).name, session } });
    }
    if (message.method === "Browser.downloadProgress" && message.params.state !== "inProgress") {
      const { name, session } = downloads.get(message.params.guid) ?? {};
      downloads.delete(message.params.guid);
      if (message.params.state === "completed" && name) {
        const file = finishDownload(message.params.guid, name);
        if (file) broadcast({ method: "Kuvo.downloaded", params: { name: path.basename(file), path: file, size: message.params.totalBytes, session } });
        else broadcast({ method: "Kuvo.downloadFailed", params: { name, session } });
        // Kept in the record of what agents made, as that conversation's (none running: not kept).
        if (file && session) engine("POST", "api/kuvo/artifacts/noted", { path: file, session, via: "download" }, "bridge").catch(() => {});
      } else if (name) {
        broadcast({ method: "Kuvo.downloadFailed", params: { name, session } });
      }
    }
    if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page") {
      targets.add(message.params.targetInfo.targetId);
      if (message.params.targetInfo.openerId) openers.set(message.params.targetInfo.targetId, message.params.targetInfo.openerId);
    }
    if ((message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") && message.params.targetInfo.type === "page") {
      addresses.set(message.params.targetInfo.targetId, message.params.targetInfo.url);
      firstPage ??= message.params.targetInfo.targetId;
      // A page that's left the site that asked for a passkey: nothing's said of it any more.
      const asked = passkeyPages.get(message.params.targetInfo.targetId);
      if (asked && hostOf(message.params.targetInfo.url) !== asked) passkeyCleared(message.params.targetInfo.targetId);
    }
    if (message.method === "Target.targetDestroyed") {
      targets.delete(message.params.targetId);
      openers.delete(message.params.targetId);
      for (const [frame, page] of framePages) if (page === message.params.targetId) framePages.delete(frame);
      addresses.delete(message.params.targetId);
      passkeyCleared(message.params.targetId);
      own.delete(message.params.targetId);
      claims.delete(message.params.targetId);
      seen.delete(message.params.targetId);
      orphaned.delete(message.params.targetId);
      holdMacs.delete(message.params.targetId);
      if (held.delete(message.params.targetId)) announceHeld();
      if (message.params.targetId === active) setActive(null, "browser");
    }
    const owner = message.sessionId ? owners.get(message.sessionId) : null;
    if (owner) send(owner, text);
    else if (!message.sessionId) broadcast(text);
  }, "\0");

  const server = net.createServer((socket) => {
    const client = { socket, sessions: new Set(), closed: false };
    // Kuvo Code's own processes first give the box's socket key; one that doesn't (a command in the
    // sandbox, or an older Kuvo Code's) hears only that it can't, and is closed. It counts as no one
    // using the browser meanwhile, and has a few seconds and a short line to give it in.
    const refuse = () => {
      if (client.keyed || client.closed) return;
      client.closed = true;
      // Closed once it has read why and closed too: what it still sends is read and dropped (a
      // socket closed with that unread is reset, and the reset can lose the words). Or soon after.
      socket.end(JSON.stringify({ method: "Kuvo.error", params: { kind: "failed", message: "This machine's browser needs a newer Kuvo Code. Update Kuvo Code on your Mac to use it." } }) + "\n");
      setTimeout(() => socket.destroy(), 5_000).unref?.();
    };
    const unkeyed = setTimeout(refuse, 10_000);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(unkeyed);
      client.closed = true;
      if (!client.keyed) return;
      clients.delete(client);
      for (const sessionId of client.sessions) {
        owners.delete(sessionId);
        internal("Target.detachFromTarget", { sessionId });
      }
      for (const [id, ask] of asks) if (ask.client === client) closeAsk(id);
      // A page a Mac took over stays taken ten minutes after its connection drops (it slept, the
      // network blinked), for it to take the page again as it comes back. (One it closes on
      // purpose hands its pages back first.)
      for (const [targetId, holder] of held) {
        if (holder !== client) continue;
        const token = Symbol();
        held.set(targetId, null);
        orphaned.set(targetId, token);
        setTimeout(() => {
          if (orphaned.get(targetId) !== token) return;
          orphaned.delete(targetId);
          held.delete(targetId);
          holdMacs.delete(targetId);
          announceHeld();
        }, 600_000).unref?.();
      }
      if (client.status?.working) broadcast({ method: "Kuvo.status", params: (status = everyStatus()) });
      if (client.viewer) broadcast({ method: "Kuvo.viewers", params: { count: viewers() } });
      if (!clients.size) idleSoon();
    });
    lines(socket, (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        if (!client.keyed) refuse();
        return;
      }
      if (client.closed) return;
      if (!client.keyed) {
        if (message.method !== "Kuvo.key" || !sameKey(message.params?.key)) return refuse();
        client.keyed = true;
        clearTimeout(unkeyed);
        clients.add(client);
        clearTimeout(idle);
        send(client, { method: "Kuvo.hello", params: { targetId: active, status, version: CONFIG.version, keeper: KEEPER, asks: [...asks.values()].map((ask) => ask.params), viewers: viewers(), held: [...held.keys()], holdMacs: Object.fromEntries(holdMacs), passkeys: Object.fromEntries(passkeyPages) } });
        return;
      }
      switch (message.method) {
        case "Kuvo.viewing":
          // A Mac showing the browser: someone who can answer asks.
          client.viewer = true;
          broadcast({ method: "Kuvo.viewers", params: { count: viewers() } });
          return message.id !== undefined && send(client, { id: message.id, result: {} });
        case "Kuvo.getActive":
          return send(client, { id: message.id, result: { targetId: active } });
        case "Kuvo.setActive": {
          // A page closed a moment ago isn't the one in use.
          const target = message.params?.targetId ?? null;
          if (target === null || targets.has(target)) {
            setActive(target, message.params?.by ?? "user", message.params?.session);
            // You picked it for that conversation: its agent goes on there.
            if (target && message.params?.by !== "agent" && message.params?.session) {
              picks.set(message.params.session, Date.now());
              claims.set(target, { session: message.params.session, at: Date.now() });
            }
          }
          return message.id !== undefined && send(client, { id: message.id, result: {} });
        }
        case "Kuvo.setStatus":
          // Each helper's: the pages agents are at work in, all together.
          client.status = message.params ?? { working: false };
          status = everyStatus();
          broadcast({ method: "Kuvo.status", params: status });
          return message.id !== undefined && send(client, { id: message.id, result: {} });
        case "Kuvo.stop":
          return stop();
        case "Kuvo.ask": {
          const params = message.params ?? {};
          // One already asked keeps its asker: its answer goes to it.
          if (!params.id || asks.has(params.id)) return;
          if (params.host && askedPasskeyLately(params.host)) params.passkey = true;
          asks.set(params.id, { client, params });
          noteAsks();
          return broadcast({ method: "Kuvo.asked", params });
        }
        case "Kuvo.answer": {
          const ask = asks.get(message.params?.id);
          if (ask) {
            send(ask.client, { method: "Kuvo.answered", params: { id: message.params.id, answer: message.params.answer } });
            closeAsk(message.params.id);
          }
          return message.id !== undefined && send(client, { id: message.id, result: {} });
        }
        case "Kuvo.cancelAsk":
          return closeAsk(message.params?.id);
        case "Kuvo.mine": {
          // The page a conversation worked in last, if it's still open, and whether you picked
          // another for it since.
          const session = message.params?.session;
          let mine = null;
          for (const [targetId, claim] of claims) if (claim.session === session && targets.has(targetId) && (!mine || claim.at > mine.at)) mine = { targetId, at: claim.at };
          return send(client, { id: message.id, result: { ...(mine ?? {}), picked: picks.get(session) ?? 0 } });
        }
        case "Kuvo.claim": {
          // A conversation's agent wants to work in a page: yes, unless another one has in the
          // last minute and a half, or has it on a Mac's screen.
          const { targetId, session } = message.params ?? {};
          // A page a Mac shows stays with its conversation however long ago it was last used.
          const claim = claims.get(targetId);
          const ok = !claim || claim.session === session || (Date.now() - claim.at > 90_000 && !shown(targetId));
          if (ok && targetId && session) claims.set(targetId, { session, at: Date.now() });
          return message.id !== undefined && send(client, { id: message.id, result: { ok } });
        }
        case "Kuvo.pointer":
          // Where the agent is about to act, for the pointer in every view of the page.
          return broadcast({ method: "Kuvo.pointer", params: message.params ?? {} });
        case "Kuvo.hold": {
          // You took a page over from the agent, or handed it back.
          const { targetId, on, mac } = message.params ?? {};
          if (targetId && on && targets.has(targetId)) {
            orphaned.delete(targetId);
            held.set(targetId, client);
            if (mac) holdMacs.set(targetId, mac); else holdMacs.delete(targetId);
          } else if (targetId && (held.get(targetId) === client || (mac && holdMacs.get(targetId) === mac) ||
            (held.get(targetId) === null && !holdMacs.has(targetId)))) {
            // Only its own hold (this connection's, or this Mac's from before, kept since its
            // connection dropped), or a kept one no Mac is known for: not another Mac's.
            orphaned.delete(targetId);
            held.delete(targetId);
            holdMacs.delete(targetId);
          }
          announceHeld();
          return message.id !== undefined && send(client, { id: message.id, result: {} });
        }
      }
      if (message.id === undefined || typeof message.method !== "string") return;
      const id = next++;
      pending.set(id, { client, id: message.id, method: message.method, targetId: message.params?.targetId });
      const forward = { id, method: message.method, params: message.method === "Input.dispatchKeyEvent" ? keyForHere(message.params ?? {}) : message.params ?? {} };
      if (message.sessionId) forward.sessionId = message.sessionId;
      toChrome(forward);
    }, "\n", (held) => !client.keyed && held > 4096 && (refuse(), true));
  });
  server.on("error", (error) => fail("failed", "The browser couldn't listen for Kuvo Code: " + error.message));
  // Its own view of the pages there, whoever else asks for it, and a session with each, held
  // before it starts.
  internal("Target.setDiscoverTargets", { discover: true });
  internal("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // Downloads go into the browser's folder, each under a temporary name until it's done.
  fs.mkdirSync(DOWNLOADS, { recursive: true, mode: 0o700 });
  clearOldDownloads();
  // And every hour while it runs, which can be for days.
  setInterval(clearOldDownloads, 3_600_000).unref?.();
  internal("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: DOWNLOADS, eventsEnabled: true });
  if (reopen.length) {
    for (const url of reopen) internal("Target.createTarget", { url, newWindow: true });
    // The blank page the browser starts with goes, once the others are there.
    setTimeout(() => {
      const url = addresses.get(firstPage);
      if (firstPage && (!url || url === "about:blank") && targets.size > 1 && !shown(firstPage)) internal("Target.closeTarget", { targetId: firstPage });
    }, 2000);
  }
  const mask = process.umask(0o077);
  server.listen(SOCKET, () => {
    process.umask(mask);
    fs.rmSync(ERRORFILE, { force: true });
    idleSoon();
  });
}

// MARK: - Talking to the keeper

/// One connection to the keeper, with requests matched to their answers.
class Connection {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.waiting = new Map();
    this.handlers = new Set();
    this.closed = false;
    lines(socket, (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.id !== undefined && this.waiting.has(message.id)) {
        const { resolve, reject, timer } = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message || "The browser refused that."));
        else resolve(message.result ?? {});
      } else if (message.method) {
        for (const handler of this.handlers) handler(message);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
      for (const { reject, timer } of this.waiting.values()) {
        clearTimeout(timer);
        reject(new Error("The browser stopped."));
      }
      this.waiting.clear();
      for (const handler of this.handlers) handler({ method: "Kuvo.closed" });
    });
  }

  static open() {
    return new Promise((resolve, reject) => {
      const socket = keeperConnection();
      socket.once("connect", () => resolve(new Connection(socket)));
      socket.once("error", reject);
    });
  }

  send(method, params = {}, sessionId, timeout = 30_000) {
    if (this.closed) return Promise.reject(new Error("The browser stopped."));
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The browser didn't answer (${method}).`));
      }, timeout);
      this.waiting.set(id, { resolve, reject, timer });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.socket.write(JSON.stringify(message) + "\n");
    });
  }

  notify(method, params = {}) {
    if (!this.closed) this.socket.write(JSON.stringify({ method, params }) + "\n");
  }
}

// MARK: - The live view

async function connect() {
  const problem = await ensure();
  if (problem) {
    process.stdout.write(JSON.stringify({ method: "Kuvo.error", params: problem }) + "\n");
    return;
  }
  const socket = keeperConnection();
  socket.on("connect", () => {
    // Pictures of a page come one at a time, each once the last is acknowledged. Here, a couple
    // ahead of the Mac: the next is made while the last is on its way, so over a slow link the
    // round trip doesn't set the frame rate, and no more than that many are ever under way.
    const ahead = 2;
    const pacing = new Map();
    const pace = (session) => pacing.get(session) ?? pacing.set(session, { underWay: 0, owed: [] }).get(session);
    const acknowledge = (session, frame) => socket.write(JSON.stringify({ id: -2, method: "Page.screencastFrameAck", params: { sessionId: frame }, sessionId: session }) + "\n");
    lines(process.stdin, (line) => {
      if (line.includes('"Page.screencastFrameAck"') || line.includes('"Page.startScreencast"') || line.includes('"Page.stopScreencast"')) {
        const message = JSON.parse(line);
        if (message.method === "Page.screencastFrameAck") {
          // The Mac has it: one fewer under way, and the picture held back can come.
          const p = pace(message.sessionId);
          p.underWay = Math.max(0, p.underWay - 1);
          const frame = p.owed.shift();
          if (frame !== undefined) acknowledge(message.sessionId, frame);
          return;
        }
        // Starting or stopping over: nothing under way.
        pacing.delete(message.sessionId);
      }
      socket.write(line + "\n");
    });
    lines(socket, (line) => {
      // The answers to the acknowledgments made here.
      if (line.startsWith('{"id":-2,')) return;
      if (line.startsWith('{"method":"Page.screencastFrame"')) {
        // Its numbers are at the end; the picture before them is long.
        const ids = line.slice(-160).match(/"sessionId":(\d+)\}\s*,\s*"sessionId":"([^"]+)"\}\s*$/);
        const [frame, session] = ids ? [Number(ids[1]), ids[2]] : (({ params, sessionId }) => [params.sessionId, sessionId])(JSON.parse(line));
        const p = pace(session);
        p.underWay += 1;
        if (p.underWay <= ahead) acknowledge(session, frame);
        else p.owed.push(frame);
      }
      process.stdout.write(line + "\n");
    });
  });
  socket.on("close", () => process.exit(0));
  socket.on("error", (error) => {
    process.stdout.write(JSON.stringify({ method: "Kuvo.error", params: { kind: "failed", message: error.message } }) + "\n");
    process.exit(1);
  });
  process.stdin.on("end", () => socket.end());
}

// MARK: - The agent's tools

class ToolError extends Error {}
// The page a call would work in is one you've taken over: it waits for you, out of the line.
class HeldError extends Error {}
// The engine gave up on the call (it was stopped, or ran out of time): it goes no further, and
// nothing answers it.
class Cancelled extends Error {}

let link = null;
let active = null;
const sessions = new Map();
// Dialogs a page opened that no tool has answered (none was at work in it), by session, and what
// the agent should hear about the ones answered.
const dialogs = new Map();
const notes = [];
const noteOnce = (note) => {
  if (!notes.includes(note)) notes.push(note);
};
// What each conversation's downloads did, until one of its calls says so (one that says nothing
// of its page, a screenshot say, leaves them for the next). Every helper hears every download, so
// only the latest conversations' and their latest news are kept.
const downloadNotes = new Map();
/// A download's news, for the conversation it's for. One that's nobody's (yours, a page no agent
/// was in) goes to no agent, except one at work that can't say whose it is.
function noteDownload(note, session = null) {
  if (!session) {
    if (busy && !caller) noteOnce(note);
    return;
  }
  const waiting = downloadNotes.get(session) ?? [];
  downloadNotes.delete(session);
  if (!waiting.includes(note)) waiting.push(note);
  downloadNotes.set(session, waiting.slice(-20));
  if (downloadNotes.size > 100) downloadNotes.delete(downloadNotes.keys().next().value);
}

/// What the agent hears ahead of a call's result: what happened on the way, and its conversation's
/// downloads.
function heard() {
  const said = notes.splice(0);
  if (caller && downloadNotes.has(caller)) {
    for (const note of downloadNotes.get(caller)) if (!said.includes(note)) said.push(note);
    downloadNotes.delete(caller);
  }
  return said.length ? said.join("\n") + "\n\n" : "";
}
let busy = false;
// The tool at work, and the page it works in.
let currentTool = null;
let workingIn = null;
// The tool at work said to accept confirmations and prompts, rather than decline them.
let acceptDialogs = false;
// The session whose tool call is under way, when the engine says.
let caller = null;
// Asks waiting for the user's answer, by ID.
const waiting = new Map();
// How many Macs show this browser now (who could answer an ask).
let viewerCount = 1;
// A file picker an upload is waiting for, by page session.
const choosers = new Map();
// Pages you took over in Kuvo Code: a tool for one waits until you hand it back.
let held = new Set();
// The site of each page whose site asked for a passkey (which this browser can't use), by page,
// for the agent's look at the page to say so.
const passkeyPages = new Map();
const heldWaiters = new Set();
// One tool call at a time in the browser, as they share its pages: the one whose turn it is, and
// the line after it. A call waiting for you (to hand its page back, or to answer) waits out of
// the line, so it holds up no one else's.
let current = null;
let line = Promise.resolve();

/// Waits for the call's turn, then makes it the one at work.
async function takeTurn(call) {
  let done;
  const turn = new Promise((resolve) => (done = resolve));
  const before = line;
  line = before.then(() => turn);
  await before;
  call.done = done;
  current = call;
  busy = true;
  acceptDialogs = call.args.accept_dialog === true;
  // The engine names the session calling, so an ask goes to the right conversation.
  caller = call.session;
  currentTool = call.name;
  workingIn = null;
  notes.unshift(...call.notes.splice(0));
  link?.notify("Kuvo.setStatus", { working: true, tool: call.name });
}

/// The call's turn ends, and the next in line goes.
function endTurn(call) {
  if (current === call) {
    unguardFiles();
    current = null;
    busy = false;
    acceptDialogs = false;
    caller = null;
    currentTool = null;
    workingIn = null;
    notes.length = 0;
    link?.notify("Kuvo.setStatus", { working: false });
  }
  call.done?.();
}

/// Waits for `until` (you) out of the line, so other calls go on meanwhile, then gets back in
/// line to go on where it left off; one the engine gave up on meanwhile goes no further.
async function outOfLine(until) {
  const call = current;
  call.notes = notes.splice(0);
  endTurn(call);
  const result = await until(call);
  if (call.cancelled) throw new Cancelled();
  await takeTurn(call);
  if (call.cancelled) throw new Cancelled();
  return result;
}

// The link being opened, so calls at once share it.
let opening = null;

async function browser() {
  if (link && !link.closed) return link;
  opening ??= openLink().finally(() => (opening = null));
  return opening;
}

async function openLink() {
  const problem = await ensure();
  if (problem) throw new ToolError(problem.message);
  link = await Connection.open();
  sessions.clear();
  fileRules.clear();
  refusedFiles.clear();
  link.handlers.add((message) => {
    switch (message.method) {
      case "Kuvo.hello":
        active = message.params.targetId;
        for (const [target, host] of Object.entries(message.params.passkeys ?? {})) passkeyPages.set(target, host);
        viewerCount = message.params.viewers ?? 1;
        held = new Set(message.params.held ?? []);
        break;
      case "Kuvo.held":
        held = new Set(message.params.pages ?? []);
        for (const resolve of heldWaiters) resolve();
        heldWaiters.clear();
        break;
      case "Kuvo.viewers":
        viewerCount = message.params.count ?? 0;
        break;
      case "Kuvo.activeChanged":
        active = message.params.targetId;
        break;
      case "Kuvo.passkeyAsked":
        if (message.params?.targetId) passkeyPages.set(message.params.targetId, message.params.host);
        break;
      case "Kuvo.passkeyCleared":
        passkeyPages.delete(message.params?.targetId);
        break;
      case "Target.detachedFromTarget":
        for (const [target, session] of sessions) if (session === message.params.sessionId) sessions.delete(target);
        fileRules.delete(message.params.sessionId);
        refusedFiles.delete(message.params.sessionId);
        break;
      case "Fetch.requestPaused":
        fileRequest(message);
        break;
      case "Page.javascriptDialogOpening":
        // In the page the tool at work is in, at once: the page (and the script that opened it)
        // waits on the answer. Any other page's waits for a tool there, or for you, as does one
        // you took over.
        if (busy && workingIn && sessions.get(workingIn) === message.sessionId && !held.has(workingIn)) answer(message.sessionId, message.params);
        else dialogs.set(message.sessionId, message.params);
        break;
      case "Kuvo.downloading":
        noteDownload(`The page started downloading ${message.params.name}.`, message.params.session);
        break;
      case "Kuvo.downloaded":
        noteDownload(`Downloaded ${message.params.name} to ${message.params.path}.`, message.params.session);
        break;
      case "Kuvo.downloadFailed":
        noteDownload(`Downloading ${message.params.name} failed.`, message.params.session);
        break;
      case "Page.fileChooserOpened":
        choosers.get(message.sessionId)?.(message.params);
        choosers.delete(message.sessionId);
        break;
      case "Page.javascriptDialogClosed":
        dialogs.delete(message.sessionId);
        break;
      case "Kuvo.answered":
        waiting.get(message.params.id)?.(message.params.answer ?? { type: "declined" });
        waiting.delete(message.params.id);
        break;
      case "Kuvo.closed":
        for (const resolve of waiting.values()) resolve({ type: "lost" });
        waiting.clear();
        break;
    }
  });
  await link.send("Target.setDiscoverTargets", { discover: true });
  active = (await link.send("Kuvo.getActive")).targetId ?? null;
  return link;
}

async function pages() {
  const { targetInfos } = await (await browser()).send("Target.getTargets");
  return targetInfos.filter((target) => target.type === "page");
}

/// The page in use: the one you or the agent last used, else the newest, else a new one. With
/// several conversations browsing, each keeps to its own page (unless you picked another since),
/// and one whose page in use is busy with another conversation gets a new one.
async function page() {
  const c = await browser();
  const open = await pages();
  const isOpen = (target) => open.some((info) => info.targetId === target);
  let target = null;
  if (caller) {
    const own = await c.send("Kuvo.mine", { session: caller });
    if (own.targetId && isOpen(own.targetId) && own.picked <= own.at) target = own.targetId;
  }
  // Its own page (or, with no conversation named, the one in use) you took over since: it waits.
  if (target ? held.has(target) : !caller && held.has(active)) throw new HeldError();
  // Any other page you took over isn't one to borrow: it gets a page of its own. Nor one on a file
  // it may not read (you opened it, say), which stays as it is.
  const fallback = open.find((info) => info.targetId === active)?.targetId ?? open.at(-1)?.targetId;
  target ??= fallback && !held.has(fallback) ? fallback : null;
  if (target && (await onOutsideFile(target, open))) {
    target = null;
    notes.push("The tab in use shows a file outside this conversation's folder, so this goes on in a new tab.");
  }
  if (target && caller && !(await c.send("Kuvo.claim", { targetId: target, session: caller })).ok) target = null;
  if (!target) {
    target = (await c.send("Target.createTarget", { url: "about:blank", newWindow: true })).targetId;
    if (caller) await c.send("Kuvo.claim", { targetId: target, session: caller });
  }
  return use(target);
}

async function use(target) {
  const c = await browser();
  // The pages a call works in, to check where they are when it's done.
  current?.pages?.add(target);
  let session = sessions.get(target);
  if (!session) {
    session = (await c.send("Target.attachToTarget", { targetId: target, flatten: true })).sessionId;
    sessions.set(target, session);
    await c.send("Page.enable", {}, session);
  }
  await guardFiles(session);
  // In front in its window: a site's new tab shares its opener's, and only the front one is drawn.
  await c.send("Target.activateTarget", { targetId: target }).catch(() => {});
  if (active !== target) {
    active = target;
    c.notify("Kuvo.setActive", { targetId: target, by: "agent", ...(caller ? { session: caller } : {}) });
  }
  // At work in this page: a Mac showing it says so.
  if (busy && workingIn !== target) {
    workingIn = target;
    c.notify("Kuvo.setStatus", { working: true, tool: currentTool, targetId: target, ...(caller ? { session: caller } : {}) });
  }
  // A dialog it left waiting, first, unless you took the page over.
  if (busy && dialogs.has(session) && !held.has(target)) answer(session, dialogs.get(session));
  return { target, session };
}

/// The agent's own world in the page: the browsing scripts run there, and the numbers they keep
/// stay there, where the page's own scripts can't read or change them. The same name gives the
/// same world (and a new document, a new one of it).
async function world(p) {
  const { frameTree } = await link.send("Page.getFrameTree", {}, p.session);
  return (await link.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "kuvo-agent" }, p.session)).executionContextId;
}

/// Runs `expression` in the page's own world, or with `inWorld` in the agent's.
async function evaluate(p, expression, timeout = 30_000, inWorld = false) {
  const contextId = inWorld ? await world(p) : undefined;
  const result = await link.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true, ...(contextId ? { contextId } : {}) }, p.session, timeout);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

// Each conversation's latest snapshot: the numbers its actions use are that snapshot's, and not
// another page's, or another conversation's in the same page.
const snapshots = new Map();

/// `args`, with the snapshot the calling conversation's numbers are from (none, if it hasn't read
/// a page yet).
function withSnapshot(args) {
  return caller ? { ...args, kuvoSnapshot: snapshots.get(caller) ?? "none" } : args;
}

/// Runs one of the browsing scripts (a function body) in the agent's world, with `args` as its
/// named arguments.
async function run(p, body, args = {}) {
  args = withSnapshot(args);
  const expression = `(async function({${Object.keys(args).join(", ")}}) {\n${body}\n})(${JSON.stringify(args)})`;
  try {
    const value = await evaluate(p, expression, 30_000, true);
    return typeof value === "string" ? value : "ok";
  } catch (error) {
    return "The page refused that: " + error.message;
  }
}

async function address(p) {
  try {
    return (await link.send("Target.getTargetInfo", { targetId: p.target })).targetInfo.url;
  } catch {
    return "";
  }
}

async function readyState(p) {
  try {
    return await evaluate(p, "document.readyState", 2000);
  } catch {
    return "loading";
  }
}

/// Waits for a navigation to start and finish, then a moment for the page to settle: until it has
/// loaded, or it's been readable for 2 s (a slow ad or tracker shouldn't hold it up), 10 s at most.
async function settle(p, expectNavigation) {
  if (expectNavigation) await sleep(250);
  const deadline = Date.now() + 10_000;
  let readable = null;
  while (Date.now() < deadline) {
    const state = await readyState(p);
    if (state === "complete") break;
    if (state === "interactive") {
      readable ??= Date.now();
      if (Date.now() - readable > 2000) break;
    } else {
      readable = null;
    }
    await sleep(150);
  }
  await sleep(expectNavigation ? 500 : 350);
}

/// A click may start a navigation a beat later, or open a page of its own: follow either.
async function settleAfterClick(p, before, pagesBefore) {
  const start = Date.now();
  while (Date.now() - start < 1000 && (await readyState(p)) !== "loading" && (await address(p)) === before) await sleep(100);
  // The page it opened (a sign-in window, say) is this conversation's to go on in: one this page
  // opened (Chrome names its opener, with noopener too), not one another conversation or you
  // opened meanwhile, nor one another conversation's agent has.
  const opened = (await pages()).find((info) => !pagesBefore.has(info.targetId) && info.openerId === p.target);
  const ours = opened && (!caller || (await (await browser()).send("Kuvo.claim", { targetId: opened.targetId, session: caller }).catch(() => ({ ok: false }))).ok);
  if (ours) {
    const next = await use(opened.targetId);
    await settle(next, true);
    return next;
  }
  await settle(p, (await readyState(p)) === "loading" || (await address(p)) !== before);
  return p;
}

const isEmpty = (url) => !url || url === "about:blank";

/// The page as text: title, address, scroll position, and its numbered elements.
async function snapshot(p) {
  p = p ?? (await page());
  if (isEmpty(await address(p))) return "The browser is empty. Use browser_navigate to open a page.";
  let result;
  try {
    // What the page set to run on a click, which only its own world sees, for the snapshot to
    // count those elements as clickable too.
    const handlers = await evaluate(p, `(function() {\n${CONFIG.scripts.handlers}\n})()`).catch(() => []);
    const id = crypto.randomUUID();
    const args = { kuvoSnapshot: id, kuvoHandlers: Array.isArray(handlers) ? handlers : [] };
    result = await evaluate(p, `(async function({kuvoSnapshot, kuvoHandlers}) {\n${CONFIG.scripts.snapshot}\n})(${JSON.stringify(args)})`, 30_000, true);
    // Its numbers are the ones this conversation's actions use, in this page only.
    if (result && caller) snapshots.set(caller, id);
  } catch {}
  if (!result) return `Couldn't read the page at ${await address(p)}.`;
  const text = result.text || "";
  const body = text.length > 18_000 ? text.slice(0, 18_000) + "\n… (cut; scroll or use browser_text for more)" : text;
  // (Its site asked: told while it's on that site.)
  const passkey = passkeyPages.has(p.target) && passkeyPages.get(p.target) === hostOf(result.url || "");
  if (passkeyPages.has(p.target) && !passkey) passkeyPages.delete(p.target);
  return [
    `Page: ${result.title || ""}`,
    `URL: ${result.url || ""}`,
    // Much more below: reading it all beats scrolling through it a screen at a time.
    `Scroll: ${result.above || 0} px above, ${result.below || 0} px below` + ((result.below || 0) > 1200 ? " (browser_text reads all of it at once)" : ""),
    ...(passkey ? [PASSKEY_NOTE] : []),
    "Interactive elements are numbered like [3]; use the number with browser_click, browser_type and browser_select.",
    "",
    body || "(no visible content)",
  ].join("\n");
}

/// What you type in an address bar: an address, or words to search for.
function destination(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (["http:", "https:", "file:", "about:"].includes(url.protocol)) return url.href;
  } catch {}
  // A file's path on this machine ("/home/me/report.html", "~/site/index.html"), as on the Mac.
  if (text.startsWith("/") || text.startsWith("~/")) return pathToFileURL(text.startsWith("~/") ? path.join(os.homedir(), text.slice(2)) : text).href;
  const looksLikeHost = !text.includes(" ") && (text.includes(".") || text.startsWith("localhost") || text.includes(":"));
  if (looksLikeHost) return (text.startsWith("localhost") || text.startsWith("127.") ? "http://" : "https://") + text;
  const search = process.env.KUVO_SEARCH || "https://www.google.com/search?q=%s";
  return search.replace("%s", encodeURIComponent(text));
}

// The sites of the integrations added on this machine, which the agent reaches through their
// tools rather than the browser: opening one, it's told so instead, the first time (asked again
// a while after, it goes, for when the user asked for the website itself). From the Mac's
// Integrations.Site, which writes what it's told.
const integrationSites = (() => {
  try {
    return JSON.parse(process.env.KUVO_INTEGRATION_SITES || "[]");
  } catch {
    return [];
  }
})();
const sentAway = new Map();

function integrationNote(address, caller) {
  const trimmed = typeof address === "string" ? address.trim() : "";
  if (!trimmed || trimmed.includes(" ")) return null;
  let url;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : "https://" + trimmed);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  const site = integrationSites.find((site) => site.hosts.some((h) => host === h || host.endsWith("." + h)) && (!site.path || url.pathname.startsWith(site.path)));
  if (!site) return null;
  const key = (caller ?? "") + "\0" + site.id;
  const when = sentAway.get(key);
  if (when && Date.now() - when < 600_000) return null;
  sentAway.set(key, Date.now());
  return site.note;
}

// What a navigation that didn't open says first: the step failed (its line doesn't read "Opened").
const notOpened = (said) => said.startsWith("Couldn't open ") || said.startsWith("Not an address or search: ");

async function navigate(p, url) {
  const target = destination(url);
  if (!target) return `Not an address or search: ${url}`;
  const result = await link.send("Page.navigate", { url: target }, p.session);
  if (result.errorText && result.errorText !== "net::ERR_ABORTED") {
    await settle(p, false);
    return `Couldn't open ${target}: ${result.errorText}\n\n` + (await snapshot(p));
  }
  await settle(p, true);
  return snapshot(p);
}

async function history(p, step) {
  const { currentIndex, entries } = await link.send("Page.getNavigationHistory", {}, p.session);
  const entry = entries[currentIndex + step];
  if (!entry) return step < 0 ? "There's no page to go back to." : "There's no page to go forward to.";
  await link.send("Page.navigateToHistoryEntry", { entryId: entry.id }, p.session);
  await settle(p, true);
  return snapshot(p);
}

/// What's in view, as a PNG at most 1280 pixels wide.
async function screenshot(p) {
  // What the user filled in stays out of the picture.
  await run(p, CONFIG.scripts.mask);
  try {
    return await capture(p);
  } finally {
    await run(p, CONFIG.scripts.unmask);
  }
}

async function capture(p) {
  const { cssVisualViewport: view } = await link.send("Page.getLayoutMetrics", {}, p.session);
  const ratio = (await evaluate(p, "window.devicePixelRatio").catch(() => 1)) || 1;
  const scale = Math.min(1, 1280 / Math.max(view.clientWidth, 1));
  const { data } = await link.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale: scale / ratio },
  }, p.session);
  return data;
}

/// A dialog the page opened (an alert, a confirmation) holds the page up until it's answered: an
/// alert is accepted, anything else declined, as the panel's browser on the Mac does, and the
/// agent hears about it with the tool's result.
function answer(sessionId, dialog) {
  dialogs.delete(sessionId);
  const accept = dialog.type === "alert" || dialog.type === "beforeunload" || acceptDialogs;
  link?.send("Page.handleJavaScriptDialog", { accept, promptText: dialog.defaultPrompt || "" }, sessionId).catch(() => {});
  const what = dialog.type === "alert" ? "an alert" : dialog.type === "confirm" ? "a confirmation" : dialog.type === "prompt" ? "a question" : "a dialog";
  notes.push(`The page showed ${what}: “${dialog.message}” (${accept ? "accepted" : "declined"}).` + (accept ? "" : " If it should go ahead, do it again with accept_dialog: true."));
}

/// Shows the pointer in the views of the page where the agent's about to act, and gives it a
/// moment to get there.
async function point(p, index, action) {
  let rect = null;
  try {
    const value = await run(p, CONFIG.scripts.find + CONFIG.scripts.rect, { index });
    rect = value && value !== "ok" ? JSON.parse(value) : null;
  } catch {}
  if (!rect) return null;
  link?.notify("Kuvo.pointer", { targetId: p.target, action, rect });
  await sleep(150);
  return rect;
}

/// Asks the user, in Kuvo Code, and waits for the answer (15 minutes at most), out of the line.
/// With no Mac connected and no phone to answer it, it waits a few minutes for one (Kuvo Code
/// opening) rather than the whole while. Meanwhile its page stays this conversation's; the engine
/// giving up on the call closes the ask.
async function askUser(params) {
  if (current.cancelled) throw new Cancelled();
  const id = crypto.randomUUID();
  const session = caller;
  // On Autopilot nothing waits for the user: it's left undone at once.
  if (session && await onAutopilot(session)) return { type: "autopilot" };
  link.notify("Kuvo.ask", { id, ...params, ...(session ? { session } : {}) });
  const started = Date.now();
  let alone = viewerCount || phoneCanAnswer() ? null : started;
  let looking = false;
  return outOfLine((call) => new Promise((resolve) => {
    const finish = (answer) => {
      clearInterval(check);
      waiting.delete(id);
      call.stops.delete(stop);
      resolve(answer);
    };
    const stop = () => {
      link?.notify("Kuvo.cancelAsk", { id });
      finish({ type: "cancelled" });
    };
    waiting.set(id, finish);
    call.stops.add(stop);
    const check = setInterval(() => {
      if (viewerCount || phoneCanAnswer()) alone = null;
      else alone ??= Date.now();
      const nobody = alone !== null && Date.now() - alone > 180_000;
      if (nobody || Date.now() - started >= 900_000) {
        link?.notify("Kuvo.cancelAsk", { id });
        return finish({ type: nobody ? "nobody" : "timedOut" });
      }
      if (session && params.targetId) link?.notify("Kuvo.claim", { targetId: params.targetId, session });
      // Autopilot turned on meanwhile: this no longer waits for the user.
      if (session && !looking) {
        looking = true;
        onAutopilot(session).catch(() => false).then((on) => {
          looking = false;
          if (!on || !waiting.has(id)) return;
          link?.notify("Kuvo.cancelAsk", { id });
          finish({ type: "autopilot" });
        });
      }
    }, 5_000);
    if (call.cancelled) stop();
  }));
}

/// Whether a phone can answer: one is paired with this machine, and its phone link runs, which
/// tells it what's asked (`ASKSFILE`) and gives the browser its answer.
function phoneCanAnswer() {
  try {
    if (!fs.existsSync(path.join(RUN, "link.needed"))) return false;
    if (!(JSON.parse(fs.readFileSync(path.join(RUN, "link.json"), "utf8")).phones?.length > 0)) return false;
    const pid = Number(fs.readFileSync(path.join(RUN, "link.pid"), "utf8"));
    return pid > 0 && Boolean(commandLine(pid)?.includes("kuvo-link"));
  } catch {
    return false;
  }
}

/// Back in the page a call waited for you in (or for the vault, `meanwhile` says), as the page in
/// use: nil if it can go on there (it's open, not taken over, on `host`, and its `fields` are still
/// the kinds they were), else what changed meanwhile.
async function backTo(p, host, fields = [], meanwhile = "while the user answered") {
  if (!(await pages()).some((info) => info.targetId === p.target)) return `The page was closed ${meanwhile}.`;
  if (held.has(p.target)) return "The user took the page over and still has it.";
  Object.assign(p, await use(p.target));
  if (host && hostOf(await address(p)) !== host) return `The page left ${host} ${meanwhile}.`;
  for (const [index, wanted] of fields) {
    const problem = index === null ? null : await checkField(p, index, wanted);
    if (problem) return `The page changed ${meanwhile}: ` + problem;
  }
  return null;
}

/// The site a page is on, as the ask names it and Passwords keeps it: its host ("http://" and it,
/// for a page that isn't private, never the https site's), or for a page from a file, that it
/// is one.
function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return "a file on this machine";
    if (parsed.protocol === "http:") return parsed.hostname ? "http://" + parsed.hostname : null;
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

/// The site the fill script checks the page is still on. It names a page from a file as one on
/// the Mac, wherever it runs.
const siteOf = (host) => (host === "a file on this machine" ? "a file on this Mac" : host);

/// Where a conversation may open files without asking: anywhere under Approve All, else its
/// folder and the temporary ones (where an agent writes a page to open). A subagent's goes by the
/// conversation that started it. Unknown, it asks. As the Mac's BrowserTools.
async function fileAccess(session) {
  let found = null;
  for (let id = session, step = 0; id && step < 6; step++) {
    found = (await findSession(id))?.data ?? null;
    id = found?.parentID ?? null;
  }
  // Ask First asks before commands; a group chat's seat refuses them all. (Approve All keeps
  // Settings' refusals, of some commands.)
  const rules = found?.permissions ?? [];
  const asks = rules.some((rule) => rule.action === "shell" && (rule.effect === "ask" || (rule.effect === "deny" && rule.resource === "*")));
  if (found && !asks) return { anywhere: true, places: [] };
  return { anywhere: false, places: [found?.location?.directory, os.tmpdir(), "/tmp"].filter(Boolean).map(realPath) };
}

function realPath(place) {
  try {
    return fs.realpathSync(place);
  } catch {
    return path.resolve(place);
  }
}

/// Where a file that may not be there yet would be: its nearest folder that is, with links
/// followed, and the rest of its path.
function realTarget(file) {
  let folder = file;
  const rest = [];
  while (!fs.existsSync(folder) && path.dirname(folder) !== folder) {
    rest.unshift(path.basename(folder));
    folder = path.dirname(folder);
  }
  return path.join(realPath(folder), ...rest);
}

/// The file `address` (a whole URL) is, when it's one outside `access`'s places, links followed
/// to where they lead; else null. One it can't tell (a host in it, say, which Chrome ignores)
/// counts as outside.
function outsideFile(address, access) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "file:" || access.anywhere) return null;
  let file;
  try {
    file = fileURLToPath(url);
  } catch {
    return url.pathname || address;
  }
  const where = realPath(file);
  return access.places.some((place) => where === place || where.startsWith(place.endsWith("/") ? place : place + "/")) ? null : file;
}

const outsideNote = (file) =>
  `Not opened: ${file} is outside this conversation's folder, and this session asks before reading files elsewhere. Ask the user first; if they agree, copy it into the folder (a command, which asks them) and open it there.`;

/// What the browser says instead of opening `address`, a file outside where the conversation may
/// read files without asking: opened, the browser read it without asking, where a command would
/// have asked.
async function fileNote(address, session) {
  const target = destination(address);
  if (!target || !target.startsWith("file:")) return null;
  const file = outsideFile(target, await fileAccess(session));
  return file ? outsideNote(file) : null;
}

/// What a page has from files outside where `session` may read files: `{ file, main }`, `main`
/// when it's the page itself, else a frame, a picture or a script in it; nil if nothing. Its
/// frames first, and only with a file among them its resources (only a page from a file can load
/// files); neither while it shows a dialog, which holds the page. Unknown, it goes by the page's
/// address. `access` is looked up once, when a page has a file in it.
async function pageFile(p, session, access) {
  if (access.value?.anywhere) return null;
  const tree = async (method) => {
    if (dialogs.has(p.session)) return null;
    return (await link.send(method, {}, p.session, 3_000).catch(() => null))?.frameTree ?? null;
  };
  const frames = await tree("Page.getFrameTree");
  const main = frames?.frame?.url ?? (await address(p));
  const addresses = [main];
  // A frame from a file, or one with a file's origin (a blank page or blob a file page opened).
  let fromFile = false;
  (function collect(node) {
    if (node?.frame?.url) addresses.push(node.frame.url);
    if (String(node?.frame?.securityOrigin ?? "").startsWith("file:")) fromFile = true;
    for (const child of node?.childFrames ?? []) collect(child);
  })(frames);
  if (!fromFile && !addresses.some((each) => each.startsWith("file:"))) return null;
  const resources = await tree("Page.getResourceTree");
  (function collect(node) {
    // What it has, not what it was refused.
    for (const resource of node?.resources ?? []) if (!resource.failed && !resource.canceled) addresses.push(resource.url);
    for (const child of node?.childFrames ?? []) collect(child);
  })(resources);
  access.value ??= await fileAccess(session);
  const itself = outsideFile(main, access.value);
  if (itself) return { file: itself, main: true };
  const file = addresses.map((each) => outsideFile(each, access.value)).find(Boolean);
  return file ? { file, main: false } : null;
}

/// What a page may load from files while a step works in it, by its session here: what the
/// step's conversation may read (see `fileAccess`). Its loads of files are paused, and those
/// outside that refused, as the page itself, a frame, a picture or a script; a page you took over
/// loads anything. Only during the step: between steps (you browsing, another conversation's
/// step) a page loads as it would, and the next step looks at what it has (`readyPage`).
const fileRules = new Map();
/// The files refused in each page during the step (by its session), for it to say so.
const refusedFiles = new Map();

async function guardFiles(session) {
  if (!current || fileRules.has(session)) return;
  current.access ??= await fileAccess(current.session);
  // Approve All: nothing to refuse.
  if (current.access.anywhere) return;
  fileRules.set(session, current.access);
  await link.send("Fetch.enable", { patterns: [{ urlPattern: "file://*" }] }, session).catch(() => {});
}

/// The step is over, or waits for you: its pages load anything again.
function unguardFiles() {
  for (const session of fileRules.keys()) link?.send("Fetch.disable", {}, session).catch(() => {});
  fileRules.clear();
  refusedFiles.clear();
}

function fileRequest(message) {
  const { requestId, request } = message.params;
  const access = fileRules.get(message.sessionId);
  const target = [...sessions].find(([, session]) => session === message.sessionId)?.[0];
  const file = access && !held.has(target) ? outsideFile(request.url, access) : null;
  if (file) {
    const refused = refusedFiles.get(message.sessionId) ?? new Set();
    if (refused.size < 20) refused.add(file);
    refusedFiles.set(message.sessionId, refused);
    link.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, message.sessionId).catch(() => {});
  } else {
    link.send("Fetch.continueRequest", { requestId }, message.sessionId).catch(() => {});
  }
}

/// Whether `target` is on a file the conversation at work may not read (one you opened, say),
/// from what `open` says of it (a page whose load of one was refused shows an error, not it).
async function onOutsideFile(target, open) {
  const url = open.find((info) => info.targetId === target)?.url ?? "";
  if (!url.startsWith("file:") || !current) return false;
  current.access ??= await fileAccess(current.session);
  if (!outsideFile(url, current.access)) return false;
  const session = sessions.get(target);
  if (!session || dialogs.has(session)) return true;
  const tree = await link.send("Page.getFrameTree", {}, session, 3_000).catch(() => null);
  return !tree || Boolean(outsideFile(tree.frameTree?.frame?.url ?? url, current.access));
}

/// The page a step goes on in: `p`, loaded again without them if it shows pictures or frames from
/// files outside the conversation's folder (from before, as its loads are only refused during a
/// step); a new tab if it's on such a file itself, which stays as it is.
async function readyPage(p, leaving = false) {
  const found = await pageFile(p, caller, { value: current?.access });
  if (!found) return p;
  if (found.main) {
    current?.pages?.delete(p.target);
    const c = await browser();
    const { targetId } = await c.send("Target.createTarget", { url: "about:blank", newWindow: true });
    if (caller) await c.send("Kuvo.claim", { targetId, session: caller });
    notes.push("The tab in use shows a file outside this conversation's folder, so this goes on in a new tab.");
    return use(targetId);
  }
  // A step that leaves the page anyway needs it as it is.
  if (leaving) return p;
  await link.send("Page.reload", {}, p.session).catch(() => {});
  await settle(p, true);
  refusedFiles.delete(p.session);
  notes.push("The page had files from outside this conversation's folder in it, so it was loaded again without them (anything typed in it is gone).");
  return p;
}

/// Nil if the field is there and takes `wanted` ("password" or "text"), else why not.
async function checkField(p, index, wanted) {
  const kind = await run(p, CONFIG.scripts.find + CONFIG.scripts.fieldKind, { index });
  if (kind === "missing") return `There's no element [${index}] on the page now. Take a fresh browser_snapshot.`;
  if (wanted === "password" && kind !== "password") return `[${index}] isn't a password field: a password only goes into one.`;
  if (wanted === "text" && kind !== "text") return `[${index}] isn't a field for a username or email.`;
  if (wanted === "code" && kind !== "text" && kind !== "password") return `[${index}] isn't a field to type a code into.`;
  return null;
}

// What's told of an ask left undone on Autopilot (LEFT_UNDONE_WORDS on the box).
const LEFT_UNDONE = "This is on Autopilot: nothing was put to the user, and nothing was chosen for you. If only the user can do it, don't do it or ask again: leave that step undone, keep it as waiting if you're at a goal (goal_progress), carry on with everything else, and list what's left for them in your final reply.";

const noAnswer = (answer, what) =>
  answer.type === "autopilot" ? LEFT_UNDONE
    : answer.type === "nobody" ? "No one has Kuvo Code open to answer now. Carry on with what you can without it, and say in your reply what you need; if you work on your own (a bot), schedule a wake-up to try again later."
    : answer.type === "timedOut" ? "The user didn't answer in time. Carry on with what you can without it, and say in your reply what you need; if you work on your own (a bot), schedule a wake-up to try again later."
    : answer.type === "lost" ? "The connection to the browser closed while the user was answering. Try again."
    : `The user didn't ${what}. Ask them in the chat how to go on.`;

const text = (value, isError = false) => ({ content: [{ type: "text", text: value }], isError });

// The tools answered by this machine's box: agents writing to each other and running their sessions.
const MAIL_TOOLS = new Set(["list_agents", "send_message", "read_conversation", "start_session", "list_sessions", "stop_session", "compact_session", "answer_ask", "list_models", "make_project", "list_projects", "propose_goal", "goal_progress", "may_spend", "finish_goal", "notify_user", "plan_limits"]);
// Agents writing to each other (list_agents, send_message, read_conversation, start_session):
// this machine's box answers them, as every box does (`POST kuvo/agent-tools`), so they're the same
// on all your computers. A call that waits for an answer holds up to eleven minutes; stopped, the
// box stops waiting, and an answer that comes later reaches the conversation as a message.
async function mail(name, args, from, cancelled = () => false) {
  const answer = await boxRoute({ method: "POST", path: "kuvo/agent-tools", body: { name, arguments: args, session: from } }, { timeout: 720_000, cancelled });
  let said = null;
  try {
    said = JSON.parse(answer?.body || "null");
  } catch {}
  if (answer?.status === 200 && typeof said?.text === "string") return text(said.text, said.isError === true);
  return text(said?.message || "Kuvo Code on this machine didn't answer. Try again in a moment.", true);
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/// The machine's engine, or (`place` "bridge") the agents bridge beside it, whose sessions are
/// the coding agents' (Claude Code, Codex…): the same paths answer on both.
async function engine(method, pathname, body, place = "engine") {
  const record = readJSON(path.join(K, "run", place === "bridge" ? "bridge.json" : "engine.json"));
  if (!record) throw new ToolError(place === "bridge" ? "The coding agents aren't running on this machine." : "This machine's engine isn't running.");
  const response = await fetch(`http://127.0.0.1:${record.port}/${pathname}`, {
    method,
    headers: { Authorization: "Basic " + Buffer.from("opencode:" + record.password).toString("base64"), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new ToolError(`This machine's engine said ${response.status}.`);
  const answer = await response.text();
  return answer ? JSON.parse(answer) : null;
}

/// A session on this machine, where it runs: the engine's, or the agents bridge's. Null when
/// neither has it.
const places = new Map();
async function findSession(id) {
  const known = places.get(id);
  for (const place of known ? [known] : ["engine", "bridge"]) {
    const data = (await engine("GET", `api/session/${encodeURIComponent(id)}`, undefined, place).catch(() => null))?.data;
    if (!data) continue;
    places.set(id, place);
    return { place, data };
  }
  return null;
}

/// Whether the conversation `id` is part of (a subagent's, the one that started it) is on Autopilot.
async function onAutopilot(id) {
  let found = await findSession(id);
  // (Through a coding agent's engine run, Auto's, to the conversation it runs for.)
  const above = (data) => data?.parentID ?? data?.metadata?.kuvo?.engineFor;
  for (let step = 0; above(found?.data) && step < 5; step++) found = await findSession(above(found.data));
  return found?.data?.metadata?.kuvo?.autopilot === true;
}

// A conversation's wake-ups (WakeUps.call on the Mac): through this machine's kuvo-wake, for the
// conversation the caller is part of (a subagent's, the one that started it; a bot's, the bot's
// folder), from the folder it works in, so a session's folder knows where that is.
const WAKE_TOOLS = new Set(["schedule_wake_up", "watch_for_change", "list_wake_ups", "cancel_wake_up"]);

async function wake(name, args, from) {
  if (!from) return text("This needs a conversation of its own.", true);
  let session = from;
  let info = null;
  // Up to the conversation it works for (a subagent's), on the engine or the agents' bridge here.
  let place = null;
  for (let step = 0; step < 5; step++) {
    const found = await findSession(session);
    if (!found) break;
    info = found.data;
    place = found.place;
    if (!found.data.parentID) break;
    session = found.data.parentID;
  }
  // A coding agent's session: its wake-ups go to the agents' bridge here.
  const viaBridge = place === "bridge" || (!info && fs.existsSync(path.join(K, "run", "bridge.json")));
  const bots = process.env.KUVO_BOTS || path.join(K, "bots");
  let target = session;
  for (const id of fs.existsSync(bots) ? fs.readdirSync(bots) : []) {
    let owned = null;
    try {
      owned = fs.readFileSync(path.join(bots, id, "session"), "utf8").trim();
    } catch {}
    if (owned === session) target = path.join(bots, id);
  }
  const given = (key) => (typeof args[key] === "string" && args[key].trim() ? args[key].trim() : null);
  let verb;
  if (name === "schedule_wake_up") {
    if (!given("when")) return text("Say when (when): +20m, +2h, +1d, or a time like 2026-10-21T09:00.", true);
    if (!given("note")) return text("Add a note for yourself (note): what to do when you wake up.", true);
    verb = ["add", given("when"), ...(given("every") ? ["--every", given("every")] : []), ...(given("summary") ? ["--summary", given("summary")] : []), given("note")];
  } else if (name === "watch_for_change") {
    if (!given("every") || !given("check") || !given("note")) return text("Give how often (every), the check (a shell command) and a note for when it changes.", true);
    // A watch runs a command whenever it's due: in Ask First, only once the user was asked, as on
    // the Mac (ToolApproval.watchWentUnasked). The engine asks for the tool in a conversation made
    // since it does; not in one from before, nor through the coding agents' bridge.
    const calling = (await findSession(from))?.data ?? info;
    const rules = Array.isArray(calling?.permissions) ? calling.permissions : [];
    const asksFirst = rules.some((rule) => rule.action === "shell" && rule.effect === "ask");
    const asked = rules.some((rule) => rule.action === "kuvo-browser_watch_for_change" && rule.effect === "ask");
    if (asksFirst && (viaBridge || !asked)) return text("This conversation asks before running commands, and a watch runs its check by itself, so the user approves it first: start it with the shell command kuvo-wake watch <every> \"<check>\" \"<what to do when it changes>\" instead, which asks them.", true);
    verb = ["watch", given("every"), given("check"), ...(given("summary") ? ["--summary", given("summary")] : []), given("note")];
  } else if (name === "list_wake_ups") {
    verb = ["list"];
  } else {
    if (!given("id")) return text("Say which one (id), from list_wake_ups.", true);
    verb = ["cancel", given("id")];
  }
  const directory = info?.location?.directory;
  const cwd = directory && fs.existsSync(directory) ? directory : path.join(K, "workspace");
  const env = { ...process.env, KUVO_BOTS: bots, KUVO_WAKES: process.env.KUVO_WAKES || path.join(K, "wakes"), KUVO_WAKE_TOOL: "1", ...(viaBridge ? { KUVO_WAKE_VIA: "bridge" } : {}) };
  delete env.OPENCODE_SESSION_ID;
  return await new Promise((resolve) => {
    const child = spawn(path.join(K, "bin", "kuvo-wake"), [target, ...verb], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const stop = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.on("error", (error) => {
      clearTimeout(stop);
      resolve(text(`Couldn't run kuvo-wake here: ${error.message}`, true));
    });
    child.on("close", (status) => {
      clearTimeout(stop);
      resolve(text(output.trim() || (status === 0 ? "Done." : "That didn't work."), status !== 0));
    });
  });
}

// A bot keeping its job (set_job): the box keeps it, in the bot's record (KuvoLink's PROTOCOL.md,
// `PATCH kuvo/bots/<id>` with `job`), asked through its script (`kuvo-link.js box route`), so what a
// job is and what a bot is told of it is the box's alone. For the bot whose conversation this is (a
// subagent's, the one that started it).
async function setJob(args, from) {
  if (!from) return text("This needs a conversation of its own.", true);
  let session = from;
  for (let step = 0; step < 5; step++) {
    const found = await findSession(session);
    if (!found?.data?.parentID) break;
    session = found.data.parentID;
  }
  const bots = process.env.KUVO_BOTS || path.join(K, "bots");
  const id = (fs.existsSync(bots) ? fs.readdirSync(bots) : []).find((name) => {
    try {
      return /^bot_[A-Za-z0-9]+$/.test(name) && fs.readFileSync(path.join(bots, name, "session"), "utf8").trim() === session;
    } catch {
      return false;
    }
  });
  if (!id) return text("Only a bot keeps a job, and this conversation isn't one.", true);
  const line = args.summary ?? args.job;
  if (args.clear !== true && (typeof line !== "string" || !line.trim() || typeof args.details !== "string"))
    return text("Provide a non-empty summary and details, or clear: true to clear your job.", true);
  const job = args.clear === true ? { line: "", details: "" } : { line, details: args.details };
  const answer = await boxRoute({ method: "PATCH", path: `kuvo/bots/${id}`, body: { job } });
  if (!answer) return text("Couldn't keep it: Kuvo Code on this machine didn't answer. Try again in a moment.", true);
  let said = null;
  try {
    said = JSON.parse(answer.body || "{}");
  } catch {}
  if (answer.status !== 200) return text(said?.message || `Couldn't keep it (${answer.status}).`, true);
  if (typeof said?.bot?.job !== "string") return text("The box returned an unreadable job response. Check the job before trying again.", true);
  const keptLine = said.bot.job;
  return text(keptLine ? `Kept. Kuvo Code shows "${keptLine}" under your name.` : "Kept: you have no job now.");
}

/// A route of this machine's box, answered once: `{status, body}`, or null when its script didn't
/// answer (in `timeout` ms). Its call `cancelled`, it's told to stop (and answers at once).
function boxRoute(request, { timeout = 30_000, cancelled = () => false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...OWN_RUNTIME, path.join(K, "bin", "kuvo-link.js"), "box", "route"], {
      cwd: K,
      env: { ...process.env, KUVO_HOME: K, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    const stop = setTimeout(() => child.kill("SIGTERM"), timeout);
    const watch = setInterval(() => {
      if (cancelled()) child.kill("SIGTERM");
    }, 500);
    child.on("error", () => {
      clearTimeout(stop);
      clearInterval(watch);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(stop);
      clearInterval(watch);
      try {
        const answer = JSON.parse(output.trim().split("\n").pop() || "null");
        resolve(answer && typeof answer.status === "number" ? answer : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/// One of the vault's or the sandbox's routes on this machine's box (PROTOCOL.md, "Vault",
/// "Sandbox"): `{status, value}`, or
/// null when its script didn't answer. Its process stops with the tool call, and waits as long as
/// the box may (one that asks you waits for you).
function vaultRoute(request, call, timeout = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...OWN_RUNTIME, path.join(K, "bin", "kuvo-link.js"), "box", "route"], {
      cwd: K,
      env: { ...process.env, KUVO_HOME: K, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    const stopNow = () => child.kill("SIGTERM");
    call?.stops.add(stopNow);
    child.stdout.on("data", (chunk) => (output += chunk));
    const stop = setTimeout(stopNow, timeout);
    const done = (answer) => {
      clearTimeout(stop);
      call?.stops.delete(stopNow);
      resolve(answer);
    };
    child.on("error", () => done(null));
    child.on("close", () => {
      try {
        const answer = JSON.parse(output.trim().split("\n").pop() || "null");
        if (!answer || typeof answer.status !== "number") return done(null);
        let value = {};
        try { value = JSON.parse(answer.body || "{}"); } catch {}
        done({ status: answer.status, value });
      } catch {
        done(null);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/// The vault's tools, as this machine's box lists them: kept once it's said.
let vaultToolList = null;
/// The browser's tools while this machine's vault isn't open to agents: no browser_fill, and no
/// vault item to name in browser_sign_in.
function closedVaultTools(tools) {
  return tools.filter((tool) => tool.name !== "browser_fill").map((tool) => {
    if (tool.name !== "browser_sign_in") return tool;
    const { item, ...properties } = tool.inputSchema?.properties ?? {};
    return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
  });
}

async function vaultTools() {
  if (vaultToolList) return vaultToolList;
  const answer = await vaultRoute({ method: "GET", path: "kuvo/vault/tools" }, null, 15_000);
  if (answer?.status === 200 && Array.isArray(answer.value?.tools)) vaultToolList = answer.value.tools;
  return vaultToolList ?? [];
}

/// The sandbox's way out (`sandbox_ask`), as this machine's box lists it while its commands run in
/// the sandbox: kept once it's listed, asked again while it isn't.
let sandboxToolList = null;
async function sandboxTools() {
  if (sandboxToolList) return sandboxToolList;
  const answer = await vaultRoute({ method: "GET", path: "kuvo/sandbox/tools" }, null, 15_000);
  if (answer?.status === 200 && Array.isArray(answer.value?.tools) && answer.value.tools.length) sandboxToolList = answer.value.tools;
  return sandboxToolList ?? [];
}

/// What the vault fills on the page `p` (at `origin`) for this conversation: `{status, value}` (200
/// with `values`; 403 refused, 404 nothing yours, 423 locked), or null without a vault to ask. The
/// box may ask you first (an item its grant says to ask about), so this waits out of the line, as
/// an ask does, with `p` staying this conversation's meanwhile: back in line, the page may have
/// changed (`backTo`).
function vaultFill(p, body) {
  if (current.cancelled) throw new Cancelled();
  const session = caller;
  const request = { method: "POST", path: "kuvo/vault/fill", body: { session, ...body } };
  return outOfLine(async (call) => {
    const keep = session ? setInterval(() => link?.notify("Kuvo.claim", { targetId: p.target, session }), 5_000) : null;
    try {
      return await vaultRoute(request, call, 16 * 60_000);
    } finally {
      clearInterval(keep);
    }
  });
}

/// While you have the page a conversation works in, its tool call waits, up to ten minutes,
/// before it joins the others (so it holds up no one else's); nil when the page is free, else the
/// page and whether you still have it. The engine giving up on the call ends the wait.
async function waitForControl(call) {
  // A new tab is a page of its own.
  if (!held.size || call.name === "browser_new_tab") return null;
  const c = await browser();
  // The conversation's own page, as page() picks it; one with none yet gets one of its own,
  // never one you took over.
  let target = active;
  if (call.session) {
    const own = await c.send("Kuvo.mine", { session: call.session });
    target = own.targetId && own.picked <= own.at ? own.targetId : null;
  }
  if (!target || !held.has(target) || !(await pages()).some((info) => info.targetId === target)) return null;
  const started = Date.now();
  while (held.has(target) && !call.cancelled && Date.now() - started < 600_000) {
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        heldWaiters.delete(done);
        call.stops.delete(done);
        resolve();
      };
      const timer = setTimeout(done, 5_000);
      heldWaiters.add(done);
      call.stops.add(done);
    });
  }
  return { target, stillHeld: held.has(target) };
}

/// What a tool says instead of its step, after waiting for you.
async function afterControl(wait) {
  if (wait.stillHeld) return text("The user took over the browser and still has it. Carry on without it for now, or try again later; if you work on your own (a bot), schedule a wake-up to come back to it.");
  // A page closed meanwhile: it goes on in another.
  const open = (await pages()).some((info) => info.targetId === wait.target);
  const p = await readyPage(open ? await use(wait.target) : await page());
  const moved = heard();
  return text("The user took over the browser while you worked, and has handed it back. The page may have changed: this is where it is now. Go on from here.\n\n" + moved + (await snapshot(p)));
}

/// A browser tool call, in its turn in the line, once you've handed back its page if you have
/// it. One the engine gives up on stops waiting, or never runs, and nothing answers it.
async function perform(call, reply) {
  for (;;) {
    const wait = await waitForControl(call).catch(() => null);
    if (call.cancelled) return;
    await takeTurn(call);
    try {
      if (call.cancelled) return;
      await browser();
      const result = wait ? await afterControl(wait) : await tool(call.name, call.args);
      // A page it worked in that's on a file it may not read (one handed back to it, say): its
      // result is kept back, and the page goes blank unless you have it.
      const access = { value: call.access };
      const open = new Set((await pages()).map((info) => info.targetId));
      const refused = [];
      for (const target of call.pages) {
        if (!open.has(target) || !sessions.has(target)) continue;
        const session = sessions.get(target);
        refused.push(...(refusedFiles.get(session) ?? []));
        refusedFiles.delete(session);
        const found = await pageFile({ target, session }, call.session, access);
        if (!found) continue;
        if (held.has(target)) return reply(text("The page shows a file outside this conversation's folder, so this step's result was held back.", true));
        if (!found.main) {
          await link.send("Page.reload", {}, session).catch(() => {});
          await settle({ target, session }, true);
          return reply(text("The page had files from outside this conversation's folder in it, which this session asks about before reading, so it was loaded again without them and this step's result was held back. Take the step again.", true));
        }
        await link.send("Page.navigate", { url: "about:blank" }, session).catch(() => {});
        return reply(text("The page went to a file outside this conversation's folder, which this session asks about before reading, so it's blank now and this step's result was held back.", true));
      }
      // Files the page tried to load from outside the folder, which weren't.
      if (refused.length) {
        const files = [...new Set(refused)];
        const note = `Not loaded: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}, outside this conversation's folder; this session asks before reading files elsewhere.`;
        return reply({ ...result, content: [{ type: "text", text: note }, ...(result.content ?? [])] });
      }
      return reply(result);
    } catch (error) {
      if (error instanceof Cancelled) return;
      // Its page, taken over while it waited in line: it waits again, out of the line.
      if (!(error instanceof HeldError)) return reply(text(error instanceof ToolError ? error.message : "The browser ran into a problem: " + error.message, true));
    } finally {
      endTurn(call);
    }
  }
}

async function tool(name, args) {
  const integer = (key) => (Number.isFinite(Number(args[key])) && args[key] !== "" && args[key] !== null ? Math.trunc(Number(args[key])) : null);
  const string = (key) => (typeof args[key] === "string" ? args[key] : null);
  const scripts = CONFIG.scripts;

  // Not the browser's: Kuvo Code shows it in its panel when this says it goes ahead (it sees
  // the call), so it's only checked here. It can't tell whether the user is looking at the
  // conversation; the Mac shows it then, or when they come back to it.
  // Drawn by Kuvo Code from the call, in the conversation.
  if (name === "show_widget") {
    const html = string("html");
    if (!html || !html.trim()) throw new ToolError("Missing html.");
    return text("Shown in the conversation, live. The user sees it now; what they click in it that calls kuvo.send comes to you as their message.");
  }

  if (name === "show_in_panel") {
    const raw = string("path");
    if (!raw) throw new ToolError("Missing path.");
    const full = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
    // A folder's path may end in "/", which resolving drops.
    if (full !== (raw.replace(/\/+$/, "") || "/")) return text(`Give the full path: ${full}`, true);
    let isFolder;
    try {
      isFolder = fs.statSync(full).isDirectory();
    } catch {
      return text(`There's nothing at ${full}.`, true);
    }
    return text(`Sent: the ${isFolder ? "folder" : "file"} ${full} opens in Kuvo Code's side panel beside this conversation, at once if the user is looking at it, or else when they come back to it.`);
  }

  // Shown by Kuvo Code from the call, in the conversation (and on a phone, which fetches it).
  if (name === "show_file") {
    const raw = string("path");
    if (!raw) throw new ToolError("Missing path.");
    // As given, which is what the conversation shows it from: a full path, nothing to expand.
    const full = raw;
    if (!path.isAbsolute(full) || full.split("/").some((part) => part === "." || part === "..")) {
      return text(raw.startsWith("~") ? `Give the file's full path: ${raw.replace(/^~(?=$|\/)/, os.homedir())}` : "Give the file's full path.", true);
    }
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return text(`There's nothing at ${full}.`, true);
    }
    if (stat.isDirectory()) return text(`${full} is a folder: show a file in it, or the folder with show_in_panel.`, true);
    return text(`Shown in the conversation: the file ${full}. The user sees it there, on their Mac and their phone.`);
  }

  // Pinned by the box's record of what was made, from the call: only checked here.
  if (name === "mark_final") {
    const full = string("path");
    if (!full || !path.isAbsolute(full) || full.split("/").some((part) => part === "." || part === "..")) return text("Give the file's full path.", true);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return text(`There's no file at ${full}.`, true);
    }
    if (!stat.isFile()) return text(`There's no file at ${full}.`, true);
    return text(`Marked final: ${full}. It's kept at the top of what you made, for the user.`);
  }

  if (name === "browser_upload") {
    const index = integer("index");
    const files = Array.isArray(args.files) ? args.files.filter((f) => typeof f === "string" && f) : [];
    if (index === null || !files.length) throw new ToolError("Missing index or files.");
    const paths = files.map((f) => path.resolve(f.replace(/^~(?=$|\/)/, os.homedir())));
    const unreadable = paths.find((f) => {
      try {
        return !fs.statSync(f).isFile();
      } catch {
        return true;
      }
    });
    if (unreadable) return text(`Can't read ${unreadable} on this machine. Give its full path.`);
    // Attached, a file goes to the site: one outside the conversation's folder only as a command
    // could read it, after asking (as on the Mac).
    const access = await fileAccess(caller);
    const outside = paths.find((f) => outsideFile(pathToFileURL(f).href, access));
    if (outside) return text(`Not attached: ${outside} is outside this conversation's folder, and this session asks before reading files elsewhere. Ask the user first; if they agree, copy it into the folder (a command, which asks them) and attach it from there.`, true);
    const p = await page();
    // The file input the element stands for, as an object to hand the files to.
    const found = await link.send("Runtime.evaluate", {
      expression: `(function({index, kuvoSnapshot}) {\n${scripts.find}\n${scripts.fileInput}\n})(${JSON.stringify(withSnapshot({ index }))})`,
      returnByValue: false,
      contextId: await world(p),
    }, p.session);
    const value = found.result;
    if (value?.type === "string" && value.value === "missing") return text(`There's no element [${index}] on the page now. Take a fresh browser_snapshot.`);
    if (value?.objectId) {
      await link.send("DOM.setFileInputFiles", { files: paths, objectId: value.objectId }, p.session);
    } else {
      // A button that opens the file picker itself: click it, and answer the picker.
      await link.send("Page.setInterceptFileChooserDialog", { enabled: true }, p.session);
      try {
        const opened = new Promise((resolve) => {
          choosers.set(p.session, resolve);
          setTimeout(() => resolve(null), 4000);
        });
        await run(p, scripts.find + scripts.click, { index });
        const chooser = await opened;
        if (!chooser) return text(`[${index}] didn't open a file picker. Give the number of the upload button or its file input.`);
        await link.send("DOM.setFileInputFiles", { files: paths, backendNodeId: chooser.backendNodeId }, p.session);
      } finally {
        choosers.delete(p.session);
        await link.send("Page.setInterceptFileChooserDialog", { enabled: false }, p.session).catch(() => {});
      }
    }
    await sleep(400);
    return text(`Attached ${paths.length === 1 ? "the file" : `${paths.length} files`}.\n\n` + (await snapshot(p)));
  }

  if (name === "browser_tabs") {
    const c = await browser();
    const open = await pages();
    // The page this conversation works in, else the browser's page in use.
    const own = caller ? (await c.send("Kuvo.mine", { session: caller })).targetId : null;
    const inUse = own && open.some((t) => t.targetId === own) ? own : active;
    // A tab on a file the conversation may not read shows as one, without its name.
    const access = open.some((t) => t.url.startsWith("file:")) && current ? (current.access ??= await fileAccess(caller)) : null;
    const describe = (t) =>
      isEmpty(t.url) ? "New tab — empty" : access && outsideFile(t.url, access) ? "A file outside this conversation's folder" : `${t.title || "(untitled)"} — ${t.url}`;
    const list = (targets) =>
      targets.length
        ? "Tabs:\n" + targets.map((t, i) => `[${i + 1}] ${describe(t)}${t.targetId === inUse ? " (in use)" : ""}`).join("\n")
        : "No tabs are open.";
    const action = string("action") || "list";
    if (action === "list") return text(list(open));
    const number = integer("tab");
    const chosen = number === null ? null : open[number - 1];
    if (!chosen) return text(`There's no tab [${number ?? 0}]. ` + list(open));
    if (held.has(chosen.targetId)) return text(`The user took tab [${number}] over and has it now. Pick another, or carry on without it.`);
    if (access && outsideFile(chosen.url, access)) return text(`Tab [${number}] shows a file outside this conversation's folder, which this session asks about before reading. Pick another, or open one with browser_new_tab.`);
    // Another conversation's agent is at work there: not this one's to take or close.
    if (caller && !(await c.send("Kuvo.claim", { targetId: chosen.targetId, session: caller })).ok) {
      return text(`Another conversation's agent is using tab [${number}]. Pick another, or open one with browser_new_tab.`);
    }
    if (action === "close") {
      await c.send("Target.closeTarget", { targetId: chosen.targetId });
      sessions.delete(chosen.targetId);
      if (active === chosen.targetId) active = null;
      return text(`Closed tab [${number}]. ` + list((await pages())));
    }
    const chosenPage = await readyPage(await use(chosen.targetId));
    const said = heard();
    return text(said + (await snapshot(chosenPage)));
  }

  if (name === "browser_navigate" || name === "browser_new_tab") {
    const url = string("url");
    const refused = url ? await fileNote(url, caller) : null;
    if (refused) return text(refused, true);
  }

  if (name === "browser_new_tab") {
    const url = string("url");
    const c = await browser();
    const { targetId } = await c.send("Target.createTarget", { url: "about:blank", newWindow: true });
    if (caller) await c.send("Kuvo.claim", { targetId, session: caller });
    const p = await use(targetId);
    const said = url ? await navigate(p, url) : await snapshot(p);
    return text(said, notOpened(said));
  }

  let p = await readyPage(await page(), ["browser_navigate", "browser_back", "browser_forward"].includes(name));
  const note = heard;
  const withNote = async (promise) => {
    const result = await promise;
    return text(note() + result);
  };

  switch (name) {
    case "browser_navigate": {
      const url = string("url");
      if (!url) return text("Missing url.", true);
      const said = await navigate(p, url);
      return text(note() + said, notOpened(said));
    }
    case "browser_snapshot":
      return withNote(snapshot(p));
    case "browser_click": {
      const index = integer("index");
      if (index === null) return text("Missing index.", true);
      await point(p, index, "click");
      const before = await address(p);
      const pagesBefore = new Set((await pages()).map((info) => info.targetId));
      const outcome = await run(p, scripts.find + scripts.click, { index });
      if (outcome !== "ok") return text(note() + outcome);
      p = await settleAfterClick(p, before, pagesBefore);
      return withNote(snapshot(p).then((page) => `Clicked [${index}].\n\n` + page));
    }
    case "browser_type": {
      const index = integer("index");
      const value = string("text");
      if (index === null || value === null) return text("Missing index or text.", true);
      const submit = args.submit === true;
      await point(p, index, "type");
      const outcome = await run(p, scripts.find + scripts.type, { index, text: value, submit, clear: args.clear !== false });
      if (outcome !== "ok") return text(note() + outcome);
      await settle(p, submit);
      return withNote(snapshot(p).then((page) => `Typed into [${index}]${submit ? " and submitted" : ""}.\n\n` + page));
    }
    case "browser_select": {
      const index = integer("index");
      const option = string("option");
      if (index === null || option === null) return text("Missing index or option.", true);
      await point(p, index, "select");
      const outcome = await run(p, scripts.find + scripts.select, { index, option });
      if (outcome !== "ok") return text(note() + outcome);
      await settle(p, false);
      return withNote(snapshot(p).then((page) => `Selected “${option}” in [${index}].\n\n` + page));
    }
    case "browser_scroll": {
      const pages = Number(args.pages) || 1;
      await run(p, "window.scrollBy({top: (down ? 1 : -1) * window.innerHeight * 0.85 * pages, behavior: 'instant'}); return 'ok';", { down: string("direction") !== "up", pages });
      await sleep(300);
      return withNote(snapshot(p));
    }
    case "browser_press": {
      const key = string("key");
      if (!key) return text("Missing key.", true);
      const outcome = await run(p, scripts.press, { key });
      if (outcome !== "ok") return text(note() + outcome);
      await settle(p, key === "Enter");
      return withNote(snapshot(p).then((page) => `Pressed ${key}.\n\n` + page));
    }
    case "browser_back":
      return withNote(history(p, -1));
    case "browser_forward":
      return withNote(history(p, 1));
    case "browser_text": {
      let value = "";
      try {
        value = (await evaluate(p, "document.body ? document.body.innerText : ''")) || "";
      } catch {}
      return withNote(Promise.resolve(value.length > 30_000 ? value.slice(0, 30_000) + "\n… (cut)" : value || "(no text)"));
    }
    case "browser_save_pdf": {
      const given = string("path");
      const file = given && path.resolve(given.replace(/^~(?=$|\/)/, os.homedir()));
      if (!given || !/^~?\//.test(given) || !file.toLowerCase().endsWith(".pdf")) return text("Give a full path ending in .pdf.", true);
      // Saved outside the conversation's folder, it would replace what's there without asking,
      // where a command would have asked (as on the Mac).
      if (outsideFile(pathToFileURL(realTarget(file)).href, await fileAccess(caller))) {
        return text(`Not saved: ${file} is outside this conversation's folder, and this session asks before writing files elsewhere. Save it in the folder; if the user wants it elsewhere, ask them first, then move it there (a command, which asks them).`, true);
      }
      if (isEmpty(await address(p))) return text("The browser is empty. Open the page first: for a document, write it as an HTML file and open it (file:///…).", true);
      try {
        // On the paper the Mac prints on, with the page's colors.
        const paper = process.env.KUVO_PAPER === "letter" ? { paperWidth: 8.5, paperHeight: 11 } : { paperWidth: 8.27, paperHeight: 11.69 };
        // What the user filled in stays out of it, as out of a screenshot (left out, since text
        // drawn clear is still in a PDF).
        await run(p, scripts.printMask);
        let data;
        try {
          ({ data } = await link.send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true, marginTop: 0.5, marginBottom: 0.5, marginLeft: 0.5, marginRight: 0.5, ...paper }, p.session, 60_000));
        } finally {
          await run(p, scripts.printUnmask);
        }
        const bytes = Buffer.from(data, "base64");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
        const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
        return withNote(Promise.resolve(`Saved the page as a ${pages ? pages + "-page " : ""}PDF at ${file}.`));
      } catch (error) {
        return text("Couldn't save the page as a PDF: " + (error.message || error), true);
      }
    }
    case "browser_screenshot": {
      try {
        return { content: [{ type: "image", data: await screenshot(p), mimeType: "image/png" }] };
      } catch {
        return text("Couldn't capture the page.", true);
      }
    }
    case "browser_sign_in": {
      const username = integer("username");
      const password = integer("password");
      const item = string("item");
      if (username === null && password === null) return text("Name the username field, the password field, or both, by number.", true);
      const url = await address(p);
      const host = hostOf(url);
      if (!host || isEmpty(url)) return text(note() + "Open the sign-in page first.");
      for (const [index, wanted] of [[password, "password"], [username, "text"]]) {
        if (index === null) continue;
        const problem = await checkField(p, index, wanted);
        if (problem) return text(note() + problem);
      }
      // From the vault, when this conversation may use one of its sign-ins here (or the one named):
      // only on that sign-in's own site. Without one, you're asked, as always.
      const vault = await vaultFill(p, { origin: url, purpose: "sign-in", ...(item ? { item } : {}) });
      if (vault?.status === 200) {
        const fields = [[username, vault.value.username, "the username", "text"], [password, vault.value.values?.password, "the password", "password"]].filter(([index, value]) => index !== null && value);
        if (!fields.length) return text(note() + `“${vault.value.item.name}” has nothing for those fields.`);
        // Other calls went on while the vault answered (it may have asked you): a sign-in only
        // goes into the fields it was asked for, on the site the vault was told.
        const changed = await backTo(p, host, fields.map(([index, , , wanted]) => [index, wanted]), "meanwhile");
        if (changed) return text(note() + changed + " Nothing was filled: take a fresh browser_snapshot, and try again if it's still needed.");
        const filled = [];
        for (const [index, value, what, wanted] of fields) {
          const outcome = await run(p, scripts.find + scripts.fill, { index, value, wanted, site: siteOf(host) });
          if (outcome !== "ok") return text(note() + outcome);
          filled.push(what);
        }
        await sleep(300);
        return withNote(snapshot(p).then((page) => `Filled ${filled.join(" and ")} for ${host} from the vault's “${vault.value.item.name}” (you can't see them). Submit the form to sign in.\n\n` + page));
      }
      if (vault && (vault.status === 403 || (item && vault.status !== 423))) return text(note() + (vault.value?.message || "The vault didn't fill that."), vault.status !== 403);
      const answer = await askUser({ kind: "signIn", host, targetId: p.target, username: username !== null, password: password !== null });
      if (answer.type !== "signIn") return text(note() + noAnswer(answer, "sign in"));
      const fields = [[username, answer.username, "the username", "text"], [password, answer.password, "the password", "password"]].filter(([index, value]) => index !== null && value);
      if (!fields.length) return text(note() + "The user didn't give a sign-in for that.");
      // The page may have changed while you answered: a sign-in only goes into the fields it
      // was asked for, on the site you were told.
      const changed = await backTo(p, host, fields.map(([index, , , wanted]) => [index, wanted]));
      if (changed) return text(note() + changed + " Nothing was filled: take a fresh browser_snapshot, and ask again if it's still needed.");
      const filled = [];
      for (const [index, value, what, wanted] of fields) {
        const outcome = await run(p, scripts.find + scripts.fill, { index, value, wanted, site: siteOf(host) });
        if (outcome !== "ok") return text(note() + outcome);
        filled.push(what);
      }
      await sleep(300);
      return withNote(snapshot(p).then((page) => `Filled ${filled.join(" and ")} for ${host} (you can't see them). Submit the form to sign in.\n\n` + page));
    }
    case "browser_fill": {
      const index = integer("index");
      const item = string("item");
      if (index === null || !item) return text("Name the field by its number and the vault item to fill it from.", true);
      const url = await address(p);
      const host = hostOf(url);
      if (!host || isEmpty(url)) return text(note() + "Open the page first.");
      const kind = await run(p, scripts.find + scripts.fieldKind, { index });
      if (kind === "missing") return text(note() + `There's no element [${index}] on the page now. Take a fresh browser_snapshot.`);
      if (kind !== "text" && kind !== "password") return text(note() + `[${index}] isn't a field to fill.`);
      const vault = await vaultFill(p, { origin: url, purpose: "field", item, ...(string("field") ? { field: string("field") } : {}), ...(string("why") ? { why: string("why") } : {}) });
      if (!vault) return text(note() + "This machine's vault can't be reached now. Try again in a moment.", true);
      if (vault.status !== 200) return text(note() + (vault.value?.message || `The vault didn't fill that (${vault.status}).`), vault.status !== 403);
      const [field, value] = Object.entries(vault.value.values ?? {})[0] ?? [];
      if (value === undefined) return text(note() + `“${vault.value.item.name}” has nothing to fill there.`);
      // A password only into a password field; anything else into either.
      const wanted = field === "password" ? "password" : "code";
      // Other calls went on while the vault answered (it may have asked you): only into the same
      // field, on the site the vault was told.
      const changed = await backTo(p, host, [[index, wanted]], "meanwhile");
      if (changed) return text(note() + changed + " Nothing was filled: take a fresh browser_snapshot, and try again if it's still needed.");
      const outcome = await run(p, scripts.find + scripts.fill, { index, value, wanted, site: siteOf(host) });
      if (outcome !== "ok") return text(note() + outcome);
      await sleep(300);
      return withNote(snapshot(p).then((page) => `Filled [${index}] with “${vault.value.item.name}”'s ${field} (you can't see it).\n\n` + page));
    }
    case "browser_ask_code": {
      const index = integer("index");
      if (index === null) return text("Missing index.", true);
      const host = hostOf(await address(p));
      if (!host) return text(note() + "Open the page that asks for the code first.");
      const problem = await checkField(p, index, "code");
      if (problem) return text(note() + problem);
      const answer = await askUser({ kind: "code", host, targetId: p.target, prompt: string("prompt") ?? "" });
      if (answer.type !== "code" || !answer.code) return text(note() + noAnswer(answer, "give a code"));
      const changed = await backTo(p, host, [[index, "code"]]);
      if (changed) return text(note() + changed + " Nothing was filled: take a fresh browser_snapshot, and ask again if it's still needed.");
      const outcome = await run(p, scripts.find + scripts.fill, { index, value: answer.code, wanted: "code", site: siteOf(host) });
      if (outcome !== "ok") return text(note() + outcome);
      await sleep(300);
      return withNote(snapshot(p).then((page) => "Filled the code (you can't see it). Submit it if the page doesn't on its own.\n\n" + page));
    }
    case "browser_ask_user": {
      const instruction = string("instruction");
      if (!instruction) return text("Missing instruction.", true);
      const answer = await askUser({ kind: "action", host: hostOf(await address(p)) ?? "the page", targetId: p.target, instruction });
      if (answer.type !== "done") return text(note() + noAnswer(answer, "do it"));
      // The page may have closed meanwhile; one you still have is only read.
      if (!(await pages()).some((info) => info.targetId === p.target)) return text(note() + "The user says it's done, and the page was closed. Take a fresh browser_snapshot to see where things are.");
      if (!held.has(p.target)) p = await use(p.target);
      await settle(p, false);
      return withNote(snapshot(p).then((page) => "The user says it's done.\n\n" + page));
    }
    case "browser_wait": {
      const wanted = string("text");
      if (wanted) {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const found = await evaluate(p, `(document.body ? document.body.innerText : '').toLowerCase().includes(${JSON.stringify(wanted.toLowerCase())})`).catch(() => false);
          if (found) return withNote(snapshot(p).then((page) => `“${wanted}” is on the page.\n\n` + page));
          await sleep(500);
        }
        return withNote(snapshot(p).then((page) => `“${wanted}” didn't show up in 30 seconds.\n\n` + page));
      }
      const seconds = Math.min(Math.max(Number(args.seconds) || 2, 0), 10);
      await sleep(seconds * 1000);
      return withNote(snapshot(p));
    }
    case "browser_hover": {
      const index = integer("index");
      if (index === null) return text("Missing index.", true);
      const rect = await point(p, index, "hover");
      if (!rect) return text(`There's no element [${index}] on the page now. Take a fresh browser_snapshot.`);
      // A real pointer over it, so the page's own hover styles show too.
      await link.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, p.session);
      await sleep(400);
      return withNote(snapshot(p).then((page) => `Hovered over [${index}].\n\n` + page));
    }
    default:
      return text(`Unknown tool ${name}.`, true);
  }
}

async function mcp() {
  const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
  // Tool calls under way, by request ID, for the engine to give up on.
  const calls = new Map();
  lines(process.stdin, (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    // The engine gave up on a call (it was stopped, or ran out of time): it stops waiting for
    // you, one still in line never runs, and nothing answers it.
    if (message.method === "notifications/cancelled") {
      const call = calls.get(message.params?.requestId);
      if (!call) return;
      call.cancelled = true;
      calls.delete(call.id);
      for (const stop of call.stops) stop();
      call.stops.clear();
      return;
    }
    if (message.id === undefined || message.id === null) return;
    let call = null;
    const reply = (result) => {
      if (call?.cancelled) return;
      if (call) calls.delete(call.id);
      write({ jsonrpc: "2.0", id: message.id, result });
    };
    const params = message.params || {};
    switch (message.method) {
      case "initialize": {
        const supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
        // What the vault's tools are for, only where this machine's box lets agents use it.
        return vaultTools().then((more) => reply({
          protocolVersion: supported.includes(params.protocolVersion) ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "kuvo-browser", title: "Kuvo Code browser", version: CONFIG.version },
          instructions: CONFIG.instructions + (more.length ? CONFIG.vaultInstructions ?? "" : ""),
        }));
      }
      case "ping":
        return reply({});
      case "tools/list":
        // With the vault's and the sandbox's, in this machine's box's own words (none from a box
        // without them). (browser_fill, and browser_sign_in's vault item, only with the vault's: none
        // while the vault isn't open to agents here, when a sign-in fills only one you let agents
        // make on their own.)
        return Promise.all([vaultTools(), sandboxTools()]).then(([more, sandbox]) => reply({ tools: [...(more.length ? CONFIG.tools : closedVaultTools(CONFIG.tools)), ...more, ...sandbox] }));
      case "tools/call": {
        // The session it's for: the engine says so with each call; an agent of the agents bridge
        // starts this for one session, named in KUVO_SESSION.
        call = { id: message.id, name: params.name || "", args: params.arguments || {}, session: params._meta?.["ai.opencode/sessionID"] ?? (process.env.KUVO_SESSION || null), cancelled: false, stops: new Set(), notes: [], pages: new Set() };
        calls.set(call.id, call);
        // Showing something in Kuvo Code's panel needs no browser, nor a turn in the line.
        // Nor does writing to another agent.
        if (WAKE_TOOLS.has(params.name)) {
          wake(params.name, params.arguments || {}, call.session).then(reply, (error) => reply(text(error instanceof ToolError ? error.message : String(error), true)));
          return;
        }
        // The vault's and the sandbox's, which this machine's box carries out (and may ask you).
        const boxTool = typeof params.name === "string" && (params.name.startsWith("vault_") ? ["kuvo/vault/tools", "This machine's vault can't be reached now. Try again in a moment."]
          : params.name.startsWith("sandbox_") ? ["kuvo/sandbox/tools", "This machine's box can't be reached now. Try again in a moment."] : null);
        if (boxTool) {
          const asked = call;
          vaultRoute({ method: "POST", path: boxTool[0], body: { name: params.name, arguments: params.arguments || {}, session: asked.session } }, asked, 16 * 60_000)
            .then((answer) => reply(answer?.status === 200 && typeof answer.value?.text === "string" ? text(answer.value.text, answer.value.isError === true) : text(answer?.value?.message || boxTool[1], true)));
          return;
        }
        if (params.name === "set_job") {
          setJob(params.arguments || {}, call.session).then(reply, (error) => reply(text(error instanceof ToolError ? error.message : String(error), true)));
          return;
        }
        if (MAIL_TOOLS.has(params.name)) {
          mail(params.name, params.arguments || {}, call.session, () => call.cancelled).then(reply, (error) => reply(text(error instanceof ToolError ? error.message : String(error), true)));
          return;
        }
        // An added integration's site: to its tools instead, with no browser needed.
        if (params.name === "browser_navigate" || params.name === "browser_new_tab") {
          const note = integrationNote(params.arguments?.url, call.session);
          if (note) return reply(text(note));
        }
        if (params.name === "show_in_panel" || params.name === "show_widget" || params.name === "show_file" || params.name === "mark_final") {
          tool(params.name, params.arguments || {}).then(reply, (error) => reply(text(error instanceof ToolError ? error.message : String(error), true)));
          return;
        }
        perform(call, reply);
        return;
      }
      default:
        return write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
    }
  });
  process.stdin.on("end", () => process.exit(0));
  // A keeper that's already running stays up while the engine does, across its restarts.
  if (await reachable()) browser().catch(() => {});
}

const mode = process.argv[2];
const modes = { host, mcp, connect };
if (!modes[mode]) {
  console.error("Usage: kuvo-browser.js host|mcp|connect");
  process.exit(2);
}
modes[mode]().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
