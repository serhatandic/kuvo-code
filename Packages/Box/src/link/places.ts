// Where this box keeps what it has (#333): each place by name, as this box resolves it, so what
// moves a box from its app's folder to a home of its own, and the tests of a box laid out in one,
// read the same names the box goes by. A machine's, and a Mac's in a home of its own, are all in
// its home (`~/.kuvo-code`); a Mac's in its app's folder has some where its app says (`KUVO_…`),
// beside its folder.

import path from "node:path";
import { CONFIG_FILE } from "./areas/config";
import { DEFAULTS_PLUGIN, keptFolders } from "./engine/defaults";
import { ENGINE_LAYER_FILE } from "./engine/compatibility";
import { appTemporary, sandboxCaches } from "./fence/policy";
import {
  APP_FOLDER, APP_KEY_FILES, attachmentRoots, BOT_KEYS, BOTS, BOX, BOX_KEYS, CHATS, ENGINE_CONFIG, ENGINE_DATA, INTEGRATION_DATA, IS_MAC, K, KIND_FILE,
  RUN, SEARCH, SESSION_WAKES, SSH_AGENTS, UPDATES, WAKE_COMMAND,
} from "./home";
import { LIST_FILE, PHONE_LINK_FILE } from "./mac/machines";
import { VAULT_FOLDER } from "./vault/store";
import { APPS } from "./work/apps";

/** How this box is laid out: in a home of its own (a machine's, or a Mac's in `~/.kuvo-code`), or in
 * its app's folder (this Mac's, `<support>/box`). */
export type BoxLayout = "own" | "app";

/** Each place this box keeps something, as it resolves it now. */
export function boxPlaces() {
  return {
    layout: (APP_FOLDER ? "app" : "own") as BoxLayout,
    kind: IS_MAC ? "mac" : "machine",
    home: K,
    /** The app's folder around it, for a Mac's box in its app's folder; null otherwise. */
    appFolder: APP_FOLDER,
    kindFile: KIND_FILE,
    run: RUN,
    box: BOX,
    vault: VAULT_FOLDER,
    keyFiles: APP_KEY_FILES ?? BOX_KEYS,
    botKeyFiles: APP_KEY_FILES ?? BOT_KEYS,
    updates: UPDATES,
    search: SEARCH,
    apps: APPS,
    browser: path.join(K, "browser"),
    trash: path.join(K, "trash"),
    temporary: path.join(K, "t"),
    engineData: ENGINE_DATA,
    engineConfig: ENGINE_CONFIG ?? path.join(K, "config"),
    settingsFile: CONFIG_FILE,
    engineLayerFile: ENGINE_LAYER_FILE,
    defaultsPlugin: DEFAULTS_PLUGIN,
    integrations: INTEGRATION_DATA,
    bots: BOTS,
    wakes: SESSION_WAKES,
    wakeCommand: WAKE_COMMAND,
    chats: CHATS,
    attachments: attachmentRoots(),
    keptFolders: keptFolders(),
    machines: LIST_FILE,
    phoneLink: PHONE_LINK_FILE,
    appTemporary: appTemporary(),
    sandboxCaches: sandboxCaches(),
    sshAgents: SSH_AGENTS,
  };
}
