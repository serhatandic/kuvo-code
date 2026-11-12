// This box's own keys (PROTOCOL.md, `kuvo/keys`): its integrations' keys, as its settings name them,
// read and set through its key store (this Mac's Keychain through its app, a machine's files).

import fs from "node:fs";
import path from "node:path";
import { locked, writeSecret } from "../files";
import { BOX_KEYS, CONFIG_LOCK } from "../home";
import { KeysUnavailable } from "../host-interface";
import { deleteKey, keyNames, keyWork, readKey, STORED_KEY, writeKey } from "../keys";
import type { Body } from "../../shared/json";
import type { Key, Keys } from "../../shared/routes/settings";
import type { JSONAnswer } from "../server/context";
import { KEY_NAME } from "./config";

/** What `kuvo/keys…` answers: the keys' names, one key's value, `{}` for done (or nothing to say),
 * or why not. */
export type KeysAnswer = JSONAnswer<Keys | Key | { message: string } | Record<string, never>>;

// `kuvo/keys…`: the box's integrations' keys, through its key store (`keyNames`, `readKey`…), a
// bot's own not among them; where they can't be reached now (this Mac's app not answering), `503`.
export async function answerKeys(method: string, route: string, body: Body<"value">): Promise<KeysAnswer> {
  try {
    if (route === "kuvo/keys") return method === "GET" ? { status: 200, value: { keys: (await keyNames()).filter(name => !name.includes("__")) } satisfies Keys } : { status: 405, value: {} };
    const parts = route.split("/");
    let name = "";
    try { name = parts.length === 3 ? decodeURIComponent(parts[2]) : ""; } catch {}
    if (!STORED_KEY.test(name) || name.includes("__")) return { status: 400, value: { message: "That isn't a key's name." } };
    switch (method) {
      case "GET": {
        const value = await readKey(name);
        return value == null ? { status: 404, value: {} } : { status: 200, value: { value } satisfies Key };
      }
      case "PUT": {
        const value = body?.value;
        if (typeof value !== "string" || !value) return { status: 400, value: { message: "Send {\"value\": \"…\"}." } };
        await keyWork(() => writeKey(name, value));
        return { status: 200, value: {} };
      }
      case "DELETE":
        await keyWork(() => deleteKey(name));
        return { status: 200, value: {} };
      default:
        return { status: 405, value: {} };
    }
  } catch (error) {
    if (error instanceof KeysUnavailable) return { status: 503, value: { message: error.message } };
    throw error;
  }
}

// A key of the box's own, set (`value`) or removed (null): integrations' servers read it there.
export function setBoxKey(name: string, value: string | null): { status: number; message?: string } {
  if (!KEY_NAME.test(String(name)) || String(name).includes("__")) return { status: 400, message: "That isn't a key's name." };
  return locked(CONFIG_LOCK, () => {
    if (value == null) fs.rmSync(path.join(BOX_KEYS, name), { force: true });
    else writeSecret(path.join(BOX_KEYS, name), String(value));
    return { status: 200 };
  });
}
