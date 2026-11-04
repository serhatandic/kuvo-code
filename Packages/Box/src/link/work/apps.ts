// The apps a goal's steps are done in, on this box's own computer (PROTOCOL.md, "Work › Goals"):
// a bot names one ("Xcode"), and the box finds it installed here and keeps its icon, for clients
// to draw as the step's mark (`GET kuvo/work/apps/icon?app=<id>`). An app that isn't here has no
// id, so no mark.
//
// macOS: an `.app` in the Applications folders (the system's, yours, and their Utilities) by its
// name, else Spotlight's by its display name; its icon as the system draws it (an asset catalog's
// too), at 64 px, through AppKit (`osascript -l JavaScript`), its id its bundle's. Linux: a desktop
// entry by its `Name=` (any language's), read through `XDG_DATA_HOME` and `XDG_DATA_DIRS` (and
// flatpak's and snap's exported entries), its icon a PNG, by path or from the `hicolor` theme or
// `pixmaps`, its id the entry's. An app whose icon is SVG alone has no mark: clients draw PNGs.
//
// Each name is looked for once and the answer kept (`apps/found.json`, the icons beside it as
// `<id>.png`), in the box's own folder; a name not found is looked for again a day on.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { locked, textOf, writePrivate } from "../files";
import { homeFolder, K, ownDataHome } from "../home";

/** Where the box keeps the apps it found and their icons. */
export const APPS = path.join(K, "apps");
const FOUND_FILE = path.join(APPS, "found.json");
const LOCK = path.join(APPS, ".found.lock");
/** How long a name not found is taken as not here, before it's looked for again. */
const MISSED_FOR = 86_400_000;
/** The icon's size, in pixels: about what a client draws it at, on a screen of twice the points. */
const SIZE = 64;

/** An app's id here, as its icon is named: its bundle's on a Mac, its desktop entry's on Linux. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export const isAppID = (id: unknown): id is string => typeof id === "string" && ID.test(id) && !id.includes("..");

/** The PNG of app `id`'s icon, kept here; null for none. */
export function appIcon(id: unknown): string | null {
  if (!isAppID(id)) return null;
  const file = path.join(APPS, `${id}.png`);
  return fs.existsSync(file) ? file : null;
}

// What's kept of each name looked for (lowercased): the app found, by its id and its own name, or
// none, and when.
interface Found {
  id?: string;
  name?: string;
  at: number;
}
const keyOf = (name: string) => name.trim().toLowerCase();
function readFound(): Record<string, Found> {
  try {
    const kept = JSON.parse(textOf(FOUND_FILE) ?? "");
    return kept && typeof kept === "object" && !Array.isArray(kept) ? kept : {};
  } catch {
    return {};
  }
}

/** An app's name as a bot gives it ("Xcode", or {name}): a short line, never a path. */
export function appNameGiven(value: unknown): string | null {
  const given = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).name : value;
  if (typeof given !== "string") return null;
  const name = given.replace(/\s+/g, " ").trim().slice(0, 80);
  return name && !/[/\\\u0000-\u001f]/.test(name) ? name : null;
}

/** The app named `name`, as it was found here: its own name and id, with its icon kept; the name
 * as given, with no id, when it isn't here (or hasn't been looked for: `findApps` first). */
export function appNamed(name: string): { name: string; id?: string } {
  const found = readFound()[keyOf(name)];
  return found?.id && appIcon(found.id) ? { name: found.name || name, id: found.id } : { name };
}

/** Each of `names` looked for here, but those found already (their icon still kept) or not found
 * within a day. */
export async function findApps(names: string[], now = Date.now()): Promise<void> {
  const kept = readFound();
  const wanted = [...new Map(names.map(name => [keyOf(name), name])).entries()].filter(([key]) => {
    const found = kept[key];
    return !found || (found.id ? !appIcon(found.id) : now - found.at >= MISSED_FOR);
  });
  for (const [key, name] of wanted) {
    const found = await findApp(name).catch(() => null);
    fs.mkdirSync(APPS, { recursive: true, mode: 0o700 });
    locked(LOCK, () => {
      const all = readFound();
      all[key] = found ? { id: found.id, name: found.name, at: now } : { at: now };
      writePrivate(FOUND_FILE, JSON.stringify(all, null, 1));
    });
  }
}

/** The app named `name` on this computer, its icon kept as `<id>.png`; null for none. */
function findApp(name: string): Promise<{ id: string; name: string } | null> {
  if (process.platform === "darwin") return findOnMac(name);
  const found = findOnLinux(name);
  if (!found) return Promise.resolve(null);
  try {
    keepIcon(found.id, temporary => fs.copyFileSync(found.icon, temporary));
  } catch {
    return Promise.resolve(null);
  }
  return Promise.resolve({ id: found.id, name: found.name });
}

// An icon kept as `<id>.png`: written by `write` beside it first, then put in place whole (and only
// if it's a PNG). Nothing's left of one that failed.
function keepIcon(id: string, write: (temporary: string) => void): void {
  fs.mkdirSync(APPS, { recursive: true, mode: 0o700 });
  const temporary = path.join(APPS, `.${id}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.png`);
  try {
    write(temporary);
    if (!isPNG(temporary)) throw new Error("Not a PNG.");
    fs.renameSync(temporary, path.join(APPS, `${id}.png`));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A PNG's width, from its header; null for a file that isn't one.
function pngWidth(file: string): number | null {
  try {
    const handle = fs.openSync(file, "r");
    try {
      const head = Buffer.alloc(24);
      if (fs.readSync(handle, head, 0, 24, 0) < 24 || !head.subarray(0, 8).equals(PNG)) return null;
      return head.readUInt32BE(16);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}
const isPNG = (file: string) => pngWidth(file) !== null;

// An id that's safe as a file's name: the app's own, or one made from where it is.
const idOf = (own: unknown, where: string) => (isAppID(own) ? own : `app-${crypto.createHash("sha256").update(where).digest("hex").slice(0, 16)}`);

const run = (command: string, args: string[], timeout: number): Promise<string | null> =>
  new Promise(resolve => execFile(command, args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout ?? ""))));

// ——— macOS ———

/** The folders a Mac's apps are in, as the Finder's Applications shows them. */
export const macFolders = (home = homeFolder()): string[] =>
  ["/Applications", "/System/Applications", path.join(home, "Applications")].flatMap(folder => [folder, path.join(folder, "Utilities")]);

// Its bundle's id and display name, and its icon (as the system draws it: an asset catalog's too)
// written as a PNG of SIZE pixels, through AppKit.
const MAC_ICON = `ObjC.import("AppKit");
function run(argv) {
  const [app, out, px] = argv;
  const size = Number(px);
  const bundle = $.NSBundle.bundleWithPath(app);
  const id = bundle.isNil() ? null : ObjC.unwrap(bundle.bundleIdentifier);
  const name = ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(app));
  const icon = $.NSWorkspace.sharedWorkspace.iconForFile(app);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  rep.setSize($.NSMakeSize(size, size));
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  return JSON.stringify({ id, name, wrote: png.writeToFileAtomically(out, true) });
}`;

async function findOnMac(name: string): Promise<{ id: string; name: string } | null> {
  const app = macApp(name) ?? (await spotlightApp(name));
  if (!app) return null;
  // (Where it really is: a link's icon has the Finder's arrow on it, as Safari's in /Applications.)
  let real = app;
  try { real = fs.realpathSync(app); } catch {}
  fs.mkdirSync(APPS, { recursive: true, mode: 0o700 });
  const temporary = path.join(APPS, `.found.${process.pid}.${crypto.randomBytes(4).toString("hex")}.png`);
  try {
    const said = await run("osascript", ["-l", "JavaScript", "-e", MAC_ICON, real, temporary, String(SIZE)], 15_000);
    const answer = said ? JSON.parse(said.trim()) : null;
    if (!answer?.wrote) return null;
    const id = idOf(answer.id, real);
    keepIcon(id, made => fs.renameSync(temporary, made));
    return { id, name: typeof answer.name === "string" && answer.name ? answer.name : name };
  } catch {
    return null;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** An app named `name` in a Mac's Applications folders, by its name (as the Finder shows it, any
 * case); null for none. */
export function macApp(name: string, folders = macFolders()): string | null {
  const wanted = `${keyOf(name)}.app`;
  for (const folder of folders) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(folder); } catch { continue; }
    const found = entries.find(entry => entry.toLowerCase() === wanted);
    if (found) return path.join(folder, found);
  }
  return null;
}

// An app Spotlight knows by its display name, elsewhere (inside another app, as Simulator is in
// Xcode): never one in the Trash or a build's products.
async function spotlightApp(name: string): Promise<string | null> {
  if (/["\\*]/.test(name)) return null;
  const said = await run("mdfind", [`kMDItemContentType == "com.apple.application-bundle" && (kMDItemDisplayName == "${name}"c || kMDItemDisplayName == "${name}.app"c)`], 10_000);
  return (said ?? "").split("\n").map(line => line.trim()).find(line => line.endsWith(".app") && !/\/\.Trash\/|\/DerivedData\/|\/Build\/Products\//.test(line)) ?? null;
}

// ——— Linux ———

/** The folders a Linux computer's desktop entries and icons are in, first first: yours
 * (`XDG_DATA_HOME`, as you have it, not the box's own), the system's (`XDG_DATA_DIRS`), and
 * flatpak's and snap's exported ones. */
export function linuxDataFolders(env: NodeJS.ProcessEnv = process.env, home = homeFolder()): string[] {
  const own = ownDataHome(env, home);
  const system = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(folder => path.isAbsolute(folder));
  const exported = [path.join(own, "flatpak", "exports", "share"), "/var/lib/flatpak/exports/share", "/var/lib/snapd/desktop"];
  return [...new Set([own, ...system, ...exported].map(folder => path.resolve(folder)))];
}

// The desktop entries in `folder` (and the folders in it), by their id: their path in it, with
// dashes for its slashes.
function desktopEntries(folder: string, prefix = "", depth = 0): [string, string][] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry): [string, string][] => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory() && depth < 3) return desktopEntries(file, `${prefix}${entry.name}-`, depth + 1);
    return entry.name.endsWith(".desktop") ? [[`${prefix}${entry.name.slice(0, -".desktop".length)}`, file]] : [];
  });
}

// A desktop entry's own group's keys (`[Desktop Entry]`).
function entryKeys(file: string): Map<string, string> {
  const keys = new Map<string, string>();
  let inEntry = false;
  for (const line of (textOf(file) ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inEntry = trimmed === "[Desktop Entry]";
      continue;
    }
    const at = trimmed.indexOf("=");
    if (inEntry && at > 0 && !trimmed.startsWith("#")) keys.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim());
  }
  return keys;
}

/** The app named `name` among a Linux computer's desktop entries (its `Name=`, in any language, any
 * case), with its icon as a PNG: its id, its own name and the icon's file; null for none with a PNG
 * icon. */
export function findOnLinux(name: string, env: NodeJS.ProcessEnv = process.env, home = homeFolder()): { id: string; name: string; icon: string } | null {
  const folders = linuxDataFolders(env, home);
  const wanted = keyOf(name);
  const seen = new Set<string>();
  for (const folder of folders) {
    for (const [id, file] of desktopEntries(path.join(folder, "applications"))) {
      // (An id's first entry is the one that counts: yours over the system's.)
      if (seen.has(id)) continue;
      seen.add(id);
      const keys = entryKeys(file);
      if ((keys.get("Type") ?? "Application") !== "Application" || keys.get("Hidden") === "true") continue;
      const names = [...keys].filter(([key]) => key === "Name" || /^Name\[[^\]]+\]$/.test(key)).map(([, value]) => value);
      if (!names.some(each => keyOf(each) === wanted)) continue;
      const icon = linuxIcon(keys.get("Icon") ?? "", folders, home);
      if (icon) return { id: idOf(id, file), name: keys.get("Name") || name, icon };
    }
  }
  return null;
}

// A desktop entry's icon as a PNG: its path, or its name in the hicolor theme (the smallest of at
// least SIZE pixels, else the largest) or in `pixmaps`; null for none, or one that's SVG alone.
function linuxIcon(icon: string, folders: string[], home: string): string | null {
  if (!icon) return null;
  if (path.isAbsolute(icon)) return pngWidth(icon) !== null ? icon : null;
  if (icon.includes("/")) return null;
  const named = icon.replace(/\.(png|svg|xpm)$/i, "");
  const themes = [path.join(home, ".icons", "hicolor"), ...folders.map(folder => path.join(folder, "icons", "hicolor"))];
  const sized: { file: string; width: number }[] = [];
  for (const theme of themes) {
    let sizes: string[] = [];
    try { sizes = fs.readdirSync(theme); } catch { continue; }
    for (const size of sizes) {
      const file = path.join(theme, size, "apps", `${named}.png`);
      const width = pngWidth(file);
      if (width !== null) sized.push({ file, width });
    }
  }
  for (const folder of [...folders.map(each => path.join(each, "pixmaps")), "/usr/share/pixmaps"]) {
    const file = path.join(folder, `${named}.png`);
    const width = pngWidth(file);
    if (width !== null) sized.push({ file, width });
  }
  if (!sized.length) return null;
  const big = sized.filter(each => each.width >= SIZE).sort((a, b) => a.width - b.width)[0];
  return (big ?? sized.sort((a, b) => b.width - a.width)[0]).file;
}
