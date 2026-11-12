// What every group chat on this computer goes by, worked out by its box from what it keeps (PROTOCOL.md,
// "Messages in a session", what a group chat goes by): what each personality tells a bot (Kuvo Code's own in its words, yours in
// its library), who sets what about a bot, Ask First (this computer's default approval), and what
// its Settings › Permissions hold back. Given to the coding agents' bridge that runs them, as it
// starts and as any of it changes, with no client connected. Your clock (time zone, how you write
// dates) is a client's to say: a machine can't know it.

import type { Target } from "../../shared/records";
import { readMacKit, readWords } from "../bots/kit";
import { holdsBack, permissionsHere } from "../bots/tell";
import type { KitRule } from "../bots/kit";
import { botPersonalities } from "../personalities/library";
import { bridgeTarget } from "../engine/client";
import { defaultApproval } from "../work/approval";

/** What the box gives the bridge (`PUT api/kuvo/groups/settings/box`). */
export interface GroupSettings {
  personalities: Record<string, string>;
  identityNote: string;
  askFirst: boolean;
  denies: KitRule[];
}

/** This computer's, as it keeps them now; null until it has Kuvo Code's words for bots. */
export function groupSettingsHere(): GroupSettings | null {
  const words = readWords();
  if (!words) return null;
  const told = (name: string, description: string) => words.personalityWords.replaceAll("⟦name⟧", () => name).replaceAll("⟦description⟧", () => description);
  const mac = readMacKit();
  const kit = {
    personalityWords: words.personalityWords,
    personalities: [
      ...words.personalities.map(each => ({ id: each.id, name: each.name, description: each.description, custom: false, instruction: told(each.name, each.description) })),
      // (Ones you made that a Mac's kit lists and the library hasn't had yet.)
      ...(Array.isArray(mac?.personalities) ? mac.personalities.filter(each => each?.custom) : []),
    ],
  };
  const personalities: Record<string, string> = {};
  for (const each of botPersonalities(kit)) personalities[each.id] ??= each.instruction;
  const approval = defaultApproval();
  return {
    personalities,
    identityNote: words.identityNote,
    askFirst: approval === "askFirst" || approval === "acceptEdits",
    denies: (permissionsHere() ?? []).filter(holdsBack),
  };
}

/** Gives `bridge` this computer's group chats' settings: true once it took them. */
export async function giveGroupSettings(bridge: Target, settings: GroupSettings, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/api/kuvo/groups/settings/box`, {
      method: "PUT",
      headers: { authorization: `Basic ${Buffer.from(`opencode:${bridge.password}`).toString("base64")}`, "content-type": "application/json" },
      body: JSON.stringify(settings),
      signal,
    });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

/** Kept so as the box runs: each round, the settings as they are now, given to the bridge running
 * now when they changed, or once as the box starts. `every`: what runs
 * its round (a test's runs each by hand). */
export function keepGroupSettings(bridge: () => Target | null = bridgeTarget, every: (round: () => Promise<void>) => void = round => { setInterval(round, 5_000).unref?.(); }): void {
  let given: string | null = null;
  let going = false;
  every(async () => {
    if (going) return;
    going = true;
    try {
      const target = bridge();
      const settings = target ? groupSettingsHere() : null;
      if (!target || !settings) return;
      // (The bridge keeps what it was given, through its restarts.)
      const now = `${target.port} ${JSON.stringify(settings)}`;
      if (now !== given && await giveGroupSettings(target, settings, AbortSignal.timeout(10_000))) given = now;
    } catch {} finally {
      going = false;
    }
  });
}
