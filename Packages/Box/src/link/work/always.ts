// What always comes to you (PROTOCOL.md, "Work › What always comes to you"), whatever the mode, an
// Always or a night's switches: payments, permanent deletes, permission changes, new accounts,
// messages to people, credentials, and git's settings. A bot never answers these for its sessions
// (`alwaysAsks`, checked before the policy, so it stays when the policy shrinks with the sandbox),
// and every session of a bot's work asks for them even on Approve All (`ALWAYS_ASK_RULES`, the
// engine's own rules, last so they win).

import { readLine } from "./policy";
import type { KitRule } from "../bots/kit";
import type { ToolCallSeen } from "./answers";

/** Each kind, in the words a refusal and the user's card say it. */
export const ALWAYS = {
  payment: "a payment",
  delete: "a permanent delete",
  permissions: "a change to who may do what",
  account: "a new account",
  message: "a message to someone",
  credentials: "your passwords, keys or sign-ins",
  gitConfig: "a change to git's settings",
} as const;
export type AlwaysKind = keyof typeof ALWAYS;

// Programs, by what running them is (whatever their arguments).
const PROGRAMS: Record<string, AlwaysKind> = {
  rm: "delete", rmdir: "delete", unlink: "delete", shred: "delete", srm: "delete", truncate: "delete", dd: "delete", mkfs: "delete", wipefs: "delete", diskutil: "delete",
  chmod: "permissions", chown: "permissions", chgrp: "permissions", chflags: "permissions", setfacl: "permissions", chattr: "permissions", sudo: "permissions", su: "permissions", doas: "permissions", visudo: "permissions", pkexec: "permissions",
  useradd: "account", adduser: "account", sysadminctl: "account", dscl: "account",
  mail: "message", mailx: "message", sendmail: "message", mutt: "message", msmtp: "message", swaks: "message",
  "ssh-keygen": "credentials", "ssh-add": "credentials", security: "credentials", op: "credentials", pass: "credentials", bw: "credentials", gpg: "credentials", keyring: "credentials", "git-credential": "credentials",
};
// Programs whose subcommand says what it is: the words after the program, as a line.
const SUBCOMMANDS: [RegExp, RegExp, AlwaysKind][] = [
  [/^git$/, /^(-c\b|config\b|remote\s+(add|set-url|remove|rm)\b|credential\b)/, "gitConfig"],
  [/^git$/, /^(clean\b|reset\s+.*--hard|branch\s+.*-D\b|push\s+.*(--delete\b|--force\b|-f\b|\s:)|stash\s+(drop|clear)\b|reflog\s+expire\b|gc\s+.*--prune)/, "delete"],
  [/^gh$/, /^(issue\s+(create|comment)|pr\s+(create|comment|review)|gist\s+create|discussion|api\s+.*(-X|--method)\s*(POST|PATCH|PUT|DELETE))\b/i, "message"],
  [/^gh$/, /^(repo\s+(delete|archive)|release\s+delete|run\s+delete|cache\s+delete|secret\s+delete|variable\s+delete)\b/, "delete"],
  [/^gh$/, /^(repo\s+edit|api\s+.*collaborators|ssh-key|gpg-key)\b/, "permissions"],
  [/^gh$/, /^auth\s+(token|refresh|login|setup-git)\b/, "credentials"],
  [/^(docker|podman)$/, /^((container\s+)?rm|rmi|(volume|network|image|container|system|builder)\s+(rm|prune))\b/, "delete"],
  [/^kubectl$/, /^delete\b/, "delete"],
  [/^kubectl$/, /^create\s+(rolebinding|clusterrolebinding|role|clusterrole|secret)\b/, "permissions"],
  [/^terraform$|^tofu$|^pulumi$/, /^destroy\b/, "delete"],
  [/^aws$/, /^(s3\s+(rm|rb)|.*\s(delete|terminate)-)/, "delete"],
  [/^aws$/, /^(iam|sts)\b/, "permissions"],
  [/^aws$/, /^(configure|secretsmanager\s+get|ssm\s+get-parameter)/, "credentials"],
  [/^gcloud$/, /^(.*\s(delete)\b)/, "delete"],
  [/^gcloud$/, /^(.*iam-policy|iam\b|auth\s+print)/, "permissions"],
  [/^stripe$/, /^((charges|payment_intents|payouts|transfers|refunds|invoices|subscriptions|checkout\s+sessions)\s+(create|pay|confirm|capture)\b|post\b)/, "payment"],
  [/^npm$|^pnpm$|^yarn$/, /^(adduser|login|token|owner|access)\b/, "credentials"],
  [/^find$/, /(\s|^)-delete\b|-exec\s+rm\b/, "delete"],
  [/^osascript$/, /Messages|Mail|send/, "message"],
  [/^(cat|less|more|head|tail|cp|base64|xxd|strings|grep|rg)$/, /(^|\s|\/)(\.ssh\/|\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json|\.git-credentials|\.kube\/config|id_(rsa|ed25519|ecdsa)|\.env\b)/, "credentials"],
];
// Hosts a request to is a payment or a message, whatever program makes it.
const HOSTS: [RegExp, AlwaysKind][] = [
  [/api\.stripe\.com|api\.paypal\.com|api\.braintreegateway|squareup\.com\/v2\/payments|api\.lemonsqueezy\.com|api\.paddle\.com/i, "payment"],
  [/hooks\.slack\.com|slack\.com\/api\/chat\.|discord(app)?\.com\/api\/webhooks|api\.telegram\.org|api\.twilio\.com|api\.sendgrid\.com|api\.mailgun\.net|api\.postmarkapp\.com|api\.resend\.com|graph\.facebook\.com|api\.twitter\.com|api\.x\.com|gmail\.googleapis\.com/i, "message"],
];
// A tool's name (an integration's, say), by its words: what sends, pays, deletes, signs up or reads
// a secret.
const TOOL_WORDS: [RegExp, AlwaysKind][] = [
  [/(^|[_\-.])(pay|payment|payments|charge|purchase|buy|checkout|order|refund|payout|transfer|invoice_send|subscribe)([_\-.]|$)/i, "payment"],
  [/(^|[_\-.])(delete|remove|destroy|purge|trash|drop|erase|wipe)([_\-.]|$)/i, "delete"],
  [/(^|[_\-.])(share|permission|permissions|invite|grant|revoke|collaborator|role|access)([_\-.]|$)/i, "permissions"],
  [/(^|[_\-.])(sign_?up|register|create_?(account|user))([_\-.]|$)/i, "account"],
  [/(^|[_\-.])(send|reply|post|comment|message|email|mail|sms|tweet|publish_post|forward|chat_post|post_message)([_\-.]|$)/i, "message"],
  [/(^|[_\-.])(password|passwords|secret|secrets|token|tokens|credential|credentials|api_?key|otp|totp|keychain)([_\-.]|$)/i, "credentials"],
];
// Files whose change is one of these: git's settings, and where keys and sign-ins are kept.
const FILES: [RegExp, AlwaysKind][] = [
  [/(^|\/)(\.gitconfig|\.gitmodules|\.git\/config|\.git\/info\/attributes|\.gitattributes)$/i, "gitConfig"],
  [/(^|\/)(\.ssh\/|\.aws\/credentials|\.netrc$|\.npmrc$|\.pypirc$|\.git-credentials$|\.docker\/config\.json$|\.kube\/config$|\.env$|\.env\.(?!example$)[^/]+$)/i, "credentials"],
];

const programOf = (word: string) => word.split("/").pop() ?? word;
// The words that start a part, past what only runs it (`env A=1`, `nice`, `time`, `command`...).
function commandWords(words: string[]): string[] {
  let at = 0;
  while (at < words.length) {
    const word = programOf(words[at]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]) || ["env", "nice", "time", "command", "exec", "nohup", "xargs", "builtin"].includes(word)) at++;
    else break;
  }
  return words.slice(at);
}

/** What a command line is, of what always comes to you; null when it's none of them. A line it
 * can't read is looked at as text: a program named anywhere in it counts. */
export function commandAlways(line: string): AlwaysKind | null {
  for (const [host, kind] of HOSTS) if (host.test(line)) return kind;
  const read = readLine(line);
  const parts = "unreadable" in read ? line.split(/[;&|\n()`$]+/).map(text => text.trim().split(/\s+/).filter(Boolean)) : read.parts.map(part => part.words);
  for (const raw of parts) {
    const words = commandWords(raw);
    if (!words.length) continue;
    const program = programOf(words[0]);
    if (PROGRAMS[program]) return PROGRAMS[program];
    const rest = words.slice(1).join(" ");
    for (const [name, sub, kind] of SUBCOMMANDS) if (name.test(program) && sub.test(rest)) return kind;
    // A shell or interpreter running a line of its own: that line, too.
    if (["sh", "bash", "zsh", "dash", "fish"].includes(program)) {
      const inner = words.indexOf("-c");
      if (inner > 0 && words[inner + 1]) {
        const kind = commandAlways(words[inner + 1]);
        if (kind) return kind;
      }
    }
  }
  if ("unreadable" in read) {
    // Can't be read as plain programs: any of them named anywhere counts.
    for (const word of line.split(/[^A-Za-z0-9_.\-/]+/)) if (PROGRAMS[programOf(word)]) return PROGRAMS[programOf(word)];
  }
  return null;
}

/** What an ask is (`action` on `resources`, by the tool call `seen`), of what always comes to you;
 * null when it's none of them. Whatever a bot or a mode may allow, these go to the user. */
export function alwaysAsks(action: string, resources: readonly string[], seen: ToolCallSeen | null): AlwaysKind | null {
  if (action === "shell" || action === "bash") {
    const command = typeof seen?.input.command === "string" ? seen.input.command : null;
    for (const line of [...(command ? [command] : []), ...resources.filter(each => each !== "*")]) {
      const kind = commandAlways(line);
      if (kind) return kind;
    }
    return null;
  }
  if (["edit", "write", "patch", "multiedit", "read"].includes(action)) {
    const named = seen ? [seen.input.filePath, seen.input.path, seen.input.file].filter((each): each is string => typeof each === "string") : [];
    for (const file of [...resources, ...named]) for (const [pattern, kind] of FILES) if (pattern.test(file)) return action === "read" && kind === "gitConfig" ? null : kind;
    return null;
  }
  // Another tool (an integration's, say): by its name, and the tool the call was.
  for (const name of [action, seen?.tool ?? ""]) for (const [pattern, kind] of TOOL_WORDS) if (name && pattern.test(name)) return kind;
  return null;
}

/** `rules` with what always comes to you asked whatever their approval: after what they allow and
 * ask, so they win over an allow, and before what they hold back, which goes last (Don't Allow
 * stays Don't Allow), as Settings' are kept. For every session of a bot's work, and the bot's own
 * conversation. */
export function withAlwaysAsk(rules: readonly KitRule[]): KitRule[] {
  const always = (rule: KitRule) => ALWAYS_ASK_RULES.some(each => each.action === rule.action && each.resource === rule.resource && each.effect === rule.effect);
  const holdsBack = (rule: KitRule) => rule.effect !== "allow" && rule.effect !== "ask";
  const kept = rules.filter(rule => !always(rule));
  return [...kept.filter(rule => !holdsBack(rule)), ...ALWAYS_ASK_RULES, ...kept.filter(holdsBack)];
}

/** Whether `rules` ask for all of what always comes to you, as `withAlwaysAsk` leaves them. */
export const asksAlways = (rules: unknown): boolean => Array.isArray(rules) && JSON.stringify(withAlwaysAsk(rules as KitRule[])) === JSON.stringify(rules);

/** The engine's rules that make a session ask for these whatever its approval. */
export const ALWAYS_ASK_RULES: KitRule[] = [
  ...Object.keys(PROGRAMS).flatMap(program => [`${program}`, `${program} *`, `*/${program} *`, `sudo ${program} *`]),
  "git config*", "git -c *", "git remote add*", "git remote set-url*", "git clean*", "git reset --hard*", "git push --force*", "git push -f*", "git push --delete*", "git branch -D*",
  "gh issue create*", "gh issue comment*", "gh pr create*", "gh pr comment*", "gh pr review*", "gh gist create*", "gh repo delete*", "gh repo edit*", "gh auth *",
  "gh api *-X POST*", "gh api *--method POST*", "gh api *-X DELETE*", "gh api *--method DELETE*",
  "stripe *", "find * -delete*", "find * -exec rm*",
  // A request to a payment's or a message's service, whatever makes it.
  "*api.stripe.com*", "*api.paypal.com*", "*hooks.slack.com*", "*slack.com/api/chat.*", "*discord.com/api/webhooks*", "*discordapp.com/api/webhooks*", "*api.telegram.org*", "*api.twilio.com*", "*api.sendgrid.com*", "*api.mailgun.net*", "*api.resend.com*", "*gmail.googleapis.com*",
].map(resource => ({ action: "shell", resource, effect: "ask" as const }));
