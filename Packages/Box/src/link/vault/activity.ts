// What the vault did, kept by the box and never by an agent (PROTOCOL.md, "Vault"): every use, ask,
// answer, refusal and change, without a value, in `box/vault/activity.jsonl`, kept a year.

import fs from "node:fs";
import path from "node:path";
import { newID, oneLine } from "../../shared/text";
import type { VaultActivity } from "../../shared/routes/vault";
import { KEPT_DAYS, VAULT_FOLDER, vaultWork } from "./store";

const ACTIVITY = path.join(VAULT_FOLDER, "activity.jsonl");
const DAY = 86_400_000;

/** A line as it's kept: with who did it on a client (`by`: a phone's link key, a Mac's), which
 * stays here; a client hears only whether it was itself (`mine`). */
export type KeptActivity = Omit<VaultActivity, "mine"> & { by?: string };

/** What's noted: everything but its id and time. */
export type Noted = Omit<KeptActivity, "id" | "at">;

// When the old lines were last dropped, by this process.
let prunedAt = 0;

/** A line of activity, kept. */
export function note(what: Noted, now = Date.now()): KeptActivity {
  const entry: KeptActivity = { id: newID("a_"), at: now, ...what };
  if (entry.why) entry.why = oneLine(entry.why, 300);
  vaultWork(() => {
    fs.mkdirSync(VAULT_FOLDER, { recursive: true, mode: 0o700 });
    fs.appendFileSync(ACTIVITY, JSON.stringify(entry) + "\n", { mode: 0o600 });
    if (now - prunedAt > DAY) {
      prunedAt = now;
      prune(now);
    }
  });
  return entry;
}

// Lines older than a year, dropped.
function prune(now: number) {
  const lines = readLines();
  const kept = lines.filter(entry => now - entry.at < KEPT_DAYS * DAY);
  if (kept.length === lines.length) return;
  const temporary = ACTIVITY + ".new";
  fs.writeFileSync(temporary, kept.map(entry => JSON.stringify(entry) + "\n").join(""), { mode: 0o600 });
  fs.renameSync(temporary, ACTIVITY);
}

function readLines(): KeptActivity[] {
  let text = "";
  try { text = fs.readFileSync(ACTIVITY, "utf8"); } catch { return []; }
  const entries: KeptActivity[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

/** What a client filters by: an item, a bot or a session; older than `before`; at most `limit`. */
export interface ActivityFilter {
  item?: string;
  bot?: string;
  session?: string;
  before?: number;
  limit?: number;
}

/** The activity, newest first. */
export function readActivity({ item, bot, session, before, limit = 100 }: ActivityFilter = {}, now = Date.now()): KeptActivity[] {
  return readLines()
    .filter(entry => now - entry.at < KEPT_DAYS * DAY)
    .filter(entry => (!item || entry.item === item) && (!bot || entry.bot === bot) && (!session || entry.session === session) && (!before || entry.at < before))
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(1, Math.min(500, limit)));
}
