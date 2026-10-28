// A bot answering what its sessions ask (answer_ask, PROTOCOL.md "Work"): a permission it may allow
// only where it could go ahead itself (its own rules allow it), never what always comes to you
// (pushing, publishing, deploying, deleting outside the project), and saying no is always its to
// do. Each answer is kept on the session (`kuvo.answers`), for every client to show it on the ask
// ("Allowed by Pixel") and in the bot's work. A question it answers in words.

import { isObject } from "../../shared/json";
import { call } from "../engine/client";
import { describePermission } from "../notices/news";
import { noteSession } from "./tree";
import type { Target } from "../../shared/records";
import type { WorkAnswer } from "../../shared/routes/work";
import type { KitRule } from "../bots/kit";

/** What always comes to you, whatever a bot may do: commands that push, publish, release, deploy,
 * or delete outside the project. A bot can say no to them, never yes. */
const ALWAYS_YOURS: { pattern: RegExp; why: string }[] = [
  { pattern: /\bgit\s+(?:\S+\s+)*push\b/, why: "pushing" },
  { pattern: /\bgh\s+(?:repo\s+(?:create|delete|edit|rename|archive)|release\s+(?:create|upload|delete|edit)|pr\s+merge|secret\s+set)\b/, why: "changing what's on GitHub" },
  { pattern: /\b(?:npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\bpod\s+trunk\s+push\b|\bgem\s+push\b|\btwine\s+upload\b|\bdocker\s+push\b/, why: "publishing" },
  { pattern: /\bfastlane\s+(?:deliver|pilot|upload_to_app_store|upload_to_testflight|release|supply)\b|\beas\s+submit\b|\bxcrun\s+altool\b|\bxcrun\s+notarytool\s+submit\b/, why: "sending to a store" },
  { pattern: /\b(?:vercel|netlify)\b[^\n]*(?:--prod|\bdeploy\b)|\bwrangler\s+(?:deploy|publish|pages\s+deploy)\b|\bfirebase\s+deploy\b|\bflyctl?\s+deploy\b|\bheroku\s+(?:releases|deploy)\b|\bterraform\s+(?:apply|destroy)\b|\bkubectl\s+(?:apply|delete|rollout)\b|\bpulumi\s+(?:up|destroy)\b/, why: "deploying" },
  { pattern: /\brm\s+(?:-\w*[rR]\w*\s+)+(?:\/|~|\$HOME)/, why: "deleting outside the project" },
];

/** Why a permission always comes to you, or null for one a bot may allow. */
export function alwaysYours(resources: readonly string[]): string | null {
  for (const resource of resources) for (const { pattern, why } of ALWAYS_YOURS) if (pattern.test(resource)) return why;
  return null;
}

// A rule's resource as the engine matches it: `*` any text, `?` one character.
const matches = (pattern: string, resource: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, ".")}$`).test(resource);

/** What the rules `rules` say for `action` on `resource`: the last that matches wins, and none
 * matching lets it through, as the engine has it. */
export function ruleFor(rules: readonly KitRule[], action: string, resource: string): KitRule["effect"] {
  let effect: KitRule["effect"] = "allow";
  for (const rule of rules) if ((rule.action === action || rule.action === "*") && matches(rule.resource, resource)) effect = rule.effect;
  return effect;
}

/** Whether a conversation with `rules` could do all of what's asked without asking itself. */
export const withinLevel = (rules: readonly KitRule[], action: string, resources: readonly string[]) =>
  (resources.length ? resources : ["*"]).every(resource => ruleFor(rules, action, resource) === "allow");

/** A permission a session asks, as the engine lists it. */
export interface PendingPermission {
  id: string;
  action: string;
  resources: string[];
  call?: string;
}

/** A question a session asks, as the engine lists it: its one field's key. */
export interface PendingQuestion {
  id: string;
  key: string | null;
  text: string;
}

/** The ask `ask` in `session`, as it's asked now; null when it isn't (answered, or it moved on). */
export async function pendingAsk(target: Target, session: string, ask: string): Promise<{ permission: PendingPermission } | { question: PendingQuestion } | null> {
  const at = `/api/session/${encodeURIComponent(session)}`;
  const permissions = await call(target, "GET", `${at}/permission`).catch(() => null);
  const permission = Array.isArray(permissions) ? permissions.find(each => isObject(each) && each.id === ask) : null;
  if (permission) {
    const resources = Array.isArray(permission.resources) ? permission.resources.filter((each: unknown): each is string => typeof each === "string") : [];
    const source = isObject(permission.source) ? permission.source : null;
    return { permission: { id: ask, action: String(permission.action ?? ""), resources, ...(typeof source?.id === "string" ? { call: source.id } : {}) } };
  }
  const forms = await call(target, "GET", `${at}/form`).catch(() => null);
  const form = Array.isArray(forms) ? forms.find(each => isObject(each) && each.id === ask) : null;
  if (!form) return null;
  const fields = (Array.isArray(form.fields) ? form.fields : []).filter((field: unknown) => isObject(field) && !field.hidden && !(Array.isArray(field.when) && field.when.length));
  const one = fields.length === 1 && fields[0].type === "string" ? fields[0] : null;
  return { question: { id: ask, key: typeof one?.key === "string" ? one.key : null, text: String(one?.description || one?.title || form.title || "a question") } };
}

/** The answers kept on a session, at most this many (the latest). */
const KEPT = 40;

/** An answer kept on its session, for every client to show. */
export async function keepAnswer(target: Target, session: string, answer: Omit<WorkAnswer, "session">): Promise<void> {
  await noteSession(target, session, kuvo => {
    const before = Array.isArray(kuvo.answers) ? kuvo.answers : [];
    return { ...kuvo, answers: [...before, answer].slice(-KEPT) };
  });
}

/** What a permission asks, in words, as the session's card and the bot's work say it. */
export const permissionWords = (permission: PendingPermission) => describePermission({ action: permission.action, resources: permission.resources });

/** A session's answers as kept on it. */
export function answersOn(metadata: unknown): WorkAnswer[] {
  const answers = isObject(metadata) && isObject(metadata.kuvo) ? metadata.kuvo.answers : null;
  return Array.isArray(answers) ? answers.filter((each): each is WorkAnswer => isObject(each) && typeof each.ask === "string" && typeof each.decision === "string") : [];
}
