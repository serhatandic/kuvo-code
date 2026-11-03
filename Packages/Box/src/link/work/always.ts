// What a bot's work never decides for itself (PROTOCOL.md, "Work › What a bot doesn't decide"): payments,
// giving someone access, new accounts, messages to people, and rewriting or publishing what others
// see (force pushes, deleting branches on a remote, and overnight, while no public step is on,
// publishing and deploying). A bot never answers these for its sessions (`alwaysAsks`, checked
// before the policy, so it stays when the policy shrinks with the sandbox). Commands ask for them
// in every session of a bot's work and its own conversation (`ALWAYS_ASK_RULES`, the engine's own
// rules, after theirs so they win); in Auto its reviewer answers them, never you: it refuses them
// unless the bot's goal names that very thing, and you can approve one it held back. Deletes, git's
// settings and your sign-ins are the sandbox's to hold, as anything else a command does (Claude
// Code's auto mode and Codex's auto-review ask for none of them). Another tool (an integration's)
// the engine's rules can't name ahead, so only the bot's own answers and words hold it back.

import { readLine } from "./policy";
import type { KitRule } from "../bots/kit";
import type { ToolCallSeen } from "./answers";

/** Each kind, in the words a refusal and the user's card say it. */
export const ALWAYS = {
  payment: "a payment",
  permissions: "giving someone access",
  account: "a new account",
  message: "a message to someone",
  publish: "publishing, or rewriting what others see",
} as const;
export type AlwaysKind = keyof typeof ALWAYS;

// Programs, by what running them is (whatever their arguments).
const PROGRAMS: Record<string, AlwaysKind> = {
  useradd: "account", adduser: "account", sysadminctl: "account", dscl: "account",
  mail: "message", mailx: "message", sendmail: "message", mutt: "message", msmtp: "message", swaks: "message",
};
// Programs whose subcommand says what it is: the words after the program (git's past its own
// options), as a line.
const SUBCOMMANDS: [RegExp, RegExp, AlwaysKind][] = [
  [/^git$/, /^push\s+.*(--delete\b|--force\b|--force-with-lease\b|--mirror\b|\s-f\b|\s-d\b|\s:\S|\s\+\S)/, "publish"],
  [/^gh$/, /^(issue\s+(create|comment)|pr\s+(create|comment|review)|gist\s+create|discussion)\b/, "message"],
  [/^gh$/, /^api\b.*(\s(-X|--method)[\s=]*(POST|PATCH|PUT|DELETE)\b|\s-[fF]\s|\s--(raw-)?field\b|\s--input\b)/i, "message"],
  [/^gh$/, /^(release\s+create|repo\s+(delete|archive)|release\s+delete)\b/, "publish"],
  [/^gh$/, /^(repo\s+edit|api\s+.*collaborators|ssh-key|gpg-key)\b/, "permissions"],
  [/^kubectl$/, /^create\s+(rolebinding|clusterrolebinding|role|clusterrole)\b/, "permissions"],
  [/^aws$/, /^iam\b/, "permissions"],
  [/^gcloud$/, /^(.*iam-policy|iam\b)/, "permissions"],
  [/^stripe$/, /^((charges|payment_intents|payouts|transfers|refunds|invoices|subscriptions|checkout\s+sessions)\s+(create|pay|confirm|capture)\b|post\b)/, "payment"],
  [/^osascript$/, /Messages|Mail|send/, "message"],
];
// A request to a payment's or a message's service, as an address in the command.
const HOSTS: [RegExp, AlwaysKind][] = [
  [/:\/\/(api\.stripe\.com|api\.paypal\.com|api\.braintreegateway\.com|connect\.squareup\.com|api\.lemonsqueezy\.com|api\.paddle\.com)/i, "payment"],
  [/:\/\/(hooks\.slack\.com|slack\.com\/api\/chat\.|discord(app)?\.com\/api\/webhooks|api\.telegram\.org|api\.twilio\.com|api\.sendgrid\.com|api\.mailgun\.net|api\.postmarkapp\.com|api\.resend\.com|graph\.facebook\.com|api\.twitter\.com|api\.x\.com|gmail\.googleapis\.com)/i, "message"],
];
// A tool's name (an integration's, say), in words: what sends, pays, signs up or gives access. One
// that only reads (get, list…) is none of these.
const TOOL_WORDS: [RegExp, AlwaysKind][] = [
  [/\b(pay|payment|payments|charge|purchase|buy|checkout|refund|payout|transfer|subscribe|create order|place order)\b/, "payment"],
  [/\b(share|permission|permissions|invite|grant|revoke|collaborator|collaborators|role|roles)\b/, "permissions"],
  [/\b(sign up|signup|register|create account|create user)\b/, "account"],
  [/\b(send|reply|post|comment|message|email|mail|sms|tweet|forward|create (pull request|issue|comment|review|discussion))\b/, "message"],
  [/\b(publish|deploy|release)\b/, "publish"],
];
const READS = /^(get|list|search|read|fetch|find|query|view|describe|show|lookup|count)$/;

const programOf = (word: string) => word.split("/").pop() ?? word;
// The words that start a part, past what only runs it (`env A=1`, `nice`, `npx`...).
function commandWords(words: string[]): string[] {
  let at = 0;
  while (at < words.length) {
    const word = programOf(words[at]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]) || ["env", "nice", "time", "command", "exec", "nohup", "xargs", "builtin", "npx", "bunx", "stdbuf", "sudo", "doas"].includes(word)) at++;
    else if (word === "timeout") at += /^\d/.test(words[at + 1] ?? "") ? 2 : 1;
    else if ((word === "pnpm" || word === "yarn") && words[at + 1] === "dlx") at += 2;
    else break;
  }
  return words.slice(at);
}
// git's words past its own options (`-C repo`, `--git-dir=…`, `-c name=value`).
function gitRest(words: string[]): string[] {
  let at = 0;
  while (at < words.length) {
    const word = words[at];
    if (word === "-C" || word === "-c" || word === "--git-dir" || word === "--work-tree" || word === "--namespace" || word === "--config-env") at += 2;
    else if (/^--(git-dir|work-tree|namespace|exec-path|config-env)=/.test(word) || word === "--no-pager" || word === "--bare" || word === "-p" || word === "-P") at++;
    else break;
  }
  return words.slice(at);
}

/** What a command line is, of what a bot never decides; null when it's none of them. A line it
 * can't read is looked at as text: a program named anywhere in it counts. `publishing`: overnight,
 * while no public step is on, publishing and deploying of any kind count too (`PUBLISH_ASK_RULES`). */
export function commandAlways(line: string, { publishing = false }: { publishing?: boolean } = {}): AlwaysKind | null {
  for (const [host, kind] of HOSTS) if (host.test(line)) return kind;
  const read = readLine(line);
  const parts = "unreadable" in read ? line.split(/[;&|\n()`$]+/).map(text => ({ words: text.trim().split(/\s+/).filter(Boolean), text: text.trim() })) : read.parts;
  for (const part of parts) {
    let words = commandWords(part.words);
    if (!words.length) continue;
    // (`/usr/lib/git-core/git-push`: git's own commands by their programs.)
    const gitOwn = /^git-([a-z][a-z0-9-]*)$/.exec(programOf(words[0]));
    if (gitOwn) words = ["git", gitOwn[1], ...words.slice(1)];
    const program = programOf(words[0]);
    if (PROGRAMS[program]) return PROGRAMS[program];
    const given = program === "git" ? gitRest(words.slice(1)) : words.slice(1);
    const rest = given.join(" ");
    for (const [name, sub, kind] of SUBCOMMANDS) if (name.test(program) && sub.test(rest)) return kind;
    if (publishing && PUBLISHING.some(pattern => pattern.test([program, ...given].join(" ")))) return "publish";
    // A shell running a line of its own: that line, too.
    if (["sh", "bash", "zsh", "dash", "fish"].includes(program)) {
      const inner = words.indexOf("-c");
      if (inner > 0 && words[inner + 1]) {
        const kind = commandAlways(words[inner + 1], { publishing });
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

/** A tool's name in words: `gmail_send_email`, `sendMail` and `create-pull-request` alike. */
const toolWords = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.:/]+/g, " ").toLowerCase().trim();

/** What a tool is by its name, of what a bot never decides; null when it's none of them. */
export function toolAlways(name: string): AlwaysKind | null {
  const words = toolWords(name);
  if (!words) return null;
  // One whose first verb only reads (`gmail get message`): what it reads isn't sent, paid or
  // deleted.
  const verb = words.split(" ").find(word => READS.test(word) || TOOL_WORDS.some(([pattern]) => pattern.test(word)));
  if (verb && READS.test(verb)) return null;
  for (const [pattern, kind] of TOOL_WORDS) if (pattern.test(words)) return kind;
  return null;
}

/** What an ask is (`action` on `resources`, by the tool call `seen`), of what a bot never decides;
 * null when it's none of them. Whatever a bot or a mode may allow, these go to the user, or in Auto
 * to its reviewer. (`publishing`: and overnight, publishing and deploying.) */
export function alwaysAsks(action: string, resources: readonly string[], seen: ToolCallSeen | null, { publishing = false }: { publishing?: boolean } = {}): AlwaysKind | null {
  if (action === "shell" || action === "bash") {
    const command = typeof seen?.input.command === "string" ? seen.input.command : null;
    for (const line of [...(command ? [command] : []), ...resources.filter(each => each !== "*")]) {
      const kind = commandAlways(line, { publishing });
      if (kind) return kind;
    }
    return null;
  }
  if (["edit", "write", "patch", "multiedit", "read", "external_directory"].includes(action)) return null;
  // Another tool (an integration's, say): by its name, and the tool the call was.
  for (const name of [action, seen?.tool ?? ""]) {
    const kind = toolAlways(name);
    if (kind) return kind;
  }
  return null;
}

const same = (a: KitRule, b: KitRule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect;
// A Don't Allow of commands: put after what always asks, so it stays Don't Allow.
const deniesCommands = (rule: KitRule) => rule.effect !== "allow" && rule.effect !== "ask" && (rule.action === "shell" || rule.action === "*");

/** `rules` with what a bot never decides asked whatever their approval (and, overnight, publishing
 * and deploying: `publishing`): after their own, so they win over an allow; then their Don't Allows
 * of commands, so those stay Don't Allow. Nothing else of theirs moves (a folder's allow stays
 * where it was). Made again from what it made before, it's the same. For every session of a bot's
 * work, and the bot's own conversation. */
export function withAlwaysAsk(rules: readonly KitRule[], { publishing = false }: { publishing?: boolean } = {}): KitRule[] {
  const ours = [...ALWAYS_ASK_RULES, ...PUBLISH_ASK_RULES, ...FORMER_ASK_RULES];
  const own = rules.filter(rule => !ours.some(each => same(each, rule)));
  const denied: KitRule[] = [];
  for (const rule of own) if (deniesCommands(rule) && !denied.some(each => same(each, rule))) denied.push(rule);
  return [...own.filter(rule => !deniesCommands(rule)), ...ALWAYS_ASK_RULES, ...(publishing ? PUBLISH_ASK_RULES : []), ...denied];
}

/** Whether `rules` ask before publishing, any of it. */
export const asksPublishing = (rules: unknown): boolean =>
  Array.isArray(rules) && PUBLISH_ASK_RULES.some(rule => (rules as KitRule[]).some(each => same(each, rule)));

/** Whether `rules` ask for what always comes to you (and for publishing, with `publishing`). */
export const asksAlways = (rules: unknown, { publishing = false }: { publishing?: boolean } = {}): boolean =>
  Array.isArray(rules) && [...ALWAYS_ASK_RULES, ...(publishing ? PUBLISH_ASK_RULES : [])].every(rule => (rules as KitRule[]).some(each => same(each, rule)));

/** Publishing and deploying, asked overnight while no public step is switched on: what's public
 * waits for you as a draft. */
export const PUBLISH_ASK_RULES: KitRule[] = [
  "git push*", "npm publish*", "pnpm publish*", "yarn publish*", "yarn npm publish*", "bun publish*", "cargo publish*", "gem push*", "twine upload*", "poetry publish*", "swift package-registry publish*",
  "vercel*", "npx vercel*", "netlify deploy*", "npx netlify*", "wrangler deploy*", "wrangler publish*", "wrangler pages deploy*", "npx wrangler*", "firebase deploy*", "fly deploy*", "flyctl deploy*",
  "railway up*", "render deploy*", "serverless deploy*", "sls deploy*", "docker push*", "podman push*", "kubectl apply*", "helm upgrade*", "helm install*", "terraform apply*", "tofu apply*", "pulumi up*",
  "eas submit*", "eas build*--auto-submit*", "fastlane*", "xcrun altool*", "gh release*", "gh pr merge*", "gh workflow run*",
].map(resource => ({ action: "shell", resource, effect: "ask" as const }));

/** The engine's rules that make a session ask for these whatever its approval: commands (each part
 * as the engine matches it). */
export const ALWAYS_ASK_RULES: KitRule[] = [
  ...Object.keys(PROGRAMS).flatMap(program => [program, `${program} *`, `*/${program} *`].map(resource => ({ action: "shell", resource, effect: "ask" as const }))),
  ...[
    "git push *--force*", "git push * -f*", "git push * +*", "git push *--delete*", "git push * -d *", "git push * :*", "git push *--mirror*",
    "gh issue create*", "gh issue comment*", "gh pr create*", "gh pr comment*", "gh pr review*", "gh gist create*", "gh release create*", "gh repo delete*", "gh repo edit*",
    "gh api *-X *", "gh api *--method*", "gh api * -f *", "gh api * -F *", "gh api *--field*",
    "stripe *", "npx stripe *", "bunx stripe *",
    "*://api.stripe.com*", "*://api.paypal.com*", "*://hooks.slack.com*", "*://slack.com/api/chat.*", "*://discord.com/api/webhooks*", "*://discordapp.com/api/webhooks*", "*://api.telegram.org*", "*://api.twilio.com*", "*://api.sendgrid.com*", "*://api.mailgun.net*", "*://api.resend.com*", "*://gmail.googleapis.com*",
  ].map(resource => ({ action: "shell", resource, effect: "ask" as const })),
];

/** The same as patterns, for a command's words (as the engine matches a part: `*` any run). */
const PUBLISHING: RegExp[] = PUBLISH_ASK_RULES.map(rule => new RegExp(`^${rule.resource.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));

// What a box before 0.9.185 asked a bot's sessions too (deletes, git's settings, sign-ins, and
// handing out file permissions or running as root): taken out of their rules as they're made again,
// never left behind as if they were their own.
const FORMER_PROGRAMS = ["rm", "rmdir", "unlink", "shred", "srm", "truncate", "dd", "mkfs", "wipefs", "chmod", "chown", "chgrp", "chflags", "setfacl", "chattr", "sudo", "su", "doas", "visudo", "pkexec",
  "ssh-keygen", "ssh-add", "security", "op", "bw", "gpg", "keyring", "git-credential"];
const FORMER_ASK_RULES: KitRule[] = [
  ...FORMER_PROGRAMS.flatMap(program => [program, `${program} *`, `*/${program} *`].map(resource => ({ action: "shell", resource, effect: "ask" as const }))),
  ...["* xargs rm*", "*-c *rm *", "git config *", "git -c *", "git -C *", "git --git-dir*", "git remote add*", "git remote set-url*", "git remote remove*", "git remote rm*",
    "git clean *", "git reset --hard*", "git reset * --hard*", "git branch -D*", "git branch * -D*", "gh secret *", "gh auth token*", "gh auth login*", "gh auth refresh*", "gh auth setup-git*",
    "find * -delete*", "find * -exec rm*", "*.ssh/*", "*.aws/credentials*", "*.netrc*", "*.git-credentials*"].map(resource => ({ action: "shell", resource, effect: "ask" as const })),
  ...["git config --get*", "git config --list*", "git config -l*", "git config --get-all*", "git config --get-regexp*", "git config get *", "git config list", "git config list -*"].map(resource => ({ action: "shell", resource, effect: "allow" as const })),
  ...["*.env", "*.env.*", "*/.ssh/*", "*/.gitconfig", "*/.gitmodules", "*/.git/config", "*/.netrc", "*/.npmrc", "*/.pypirc", "*/.git-credentials", "*/.aws/credentials", "*/.docker/config.json", "*/.kube/config"]
    .map(resource => ({ action: "edit", resource, effect: "ask" as const })),
  { action: "edit", resource: "*.env.example", effect: "allow" },
];
