// What always comes to you (PROTOCOL.md, "Work › What always comes to you"), whatever the mode, an
// Always or a goal's switches: payments, permanent deletes, permission changes, new accounts,
// messages to people, credentials, and git's settings. A bot never answers these for its sessions
// (`alwaysAsks`, checked before the policy, so it stays when the policy shrinks with the sandbox).
// Commands and edits ask for them in every session of a bot's work and its own conversation, even
// on Approve All (`ALWAYS_ASK_RULES`, the engine's own rules, after theirs so they win); another
// tool (an integration's) the engine's rules can't name ahead, so on Approve All only the bot's
// own answers and words hold it back.

import { gitConfigSets, readLine } from "./policy";
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
  rm: "delete", rmdir: "delete", unlink: "delete", shred: "delete", srm: "delete", truncate: "delete", dd: "delete", mkfs: "delete", wipefs: "delete",
  chmod: "permissions", chown: "permissions", chgrp: "permissions", chflags: "permissions", setfacl: "permissions", chattr: "permissions", sudo: "permissions", su: "permissions", doas: "permissions", visudo: "permissions", pkexec: "permissions",
  useradd: "account", adduser: "account", sysadminctl: "account", dscl: "account",
  mail: "message", mailx: "message", sendmail: "message", mutt: "message", msmtp: "message", swaks: "message",
  "ssh-keygen": "credentials", "ssh-add": "credentials", security: "credentials", op: "credentials", bw: "credentials", gpg: "credentials", keyring: "credentials", "git-credential": "credentials",
};
// Programs whose subcommand says what it is: the words after the program (git's past its own
// options), as a line.
const SUBCOMMANDS: [RegExp, RegExp, AlwaysKind][] = [
  // (`git config` itself, by gitConfigSets.)
  [/^git$/, /^(config\s+--one-off\b|remote\s+(add|set-url|remove|rm)\b|credential\b)/, "gitConfig"],
  [/^git$/, /^(clean\s+(?!.*(-n|--dry-run)\b)|reset\s+.*--hard|branch\s+.*-D\b|push\s+.*(--delete\b|--force\b|--force-with-lease\b|\s-f\b|\s-d\b|\s:\S|\s\+\S)|stash\s+(drop|clear)\b|reflog\s+expire\b|gc\s+.*--prune)/, "delete"],
  [/^gh$/, /^(issue\s+(create|comment)|pr\s+(create|comment|review)|gist\s+create|discussion|release\s+create)\b/, "message"],
  [/^gh$/, /^api\b.*(\s(-X|--method)[\s=]*(POST|PATCH|PUT|DELETE)\b|\s-[fF]\s|\s--(raw-)?field\b|\s--input\b)/i, "message"],
  [/^gh$/, /^(repo\s+(delete|archive)|release\s+delete|run\s+delete|cache\s+delete|variable\s+delete)\b/, "delete"],
  [/^gh$/, /^(repo\s+edit|api\s+.*collaborators|ssh-key|gpg-key)\b/, "permissions"],
  [/^gh$/, /^(auth\s+(token|refresh|login|setup-git)|secret\b)/, "credentials"],
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
  [/^find$/, /(\s|^)-delete\b|-exec(dir)?\s+rm\b/, "delete"],
  [/^osascript$/, /Messages|Mail|send/, "message"],
];
// A request to a payment's or a message's service, as an address in the command.
const HOSTS: [RegExp, AlwaysKind][] = [
  [/:\/\/(api\.stripe\.com|api\.paypal\.com|api\.braintreegateway\.com|connect\.squareup\.com|api\.lemonsqueezy\.com|api\.paddle\.com)/i, "payment"],
  [/:\/\/(hooks\.slack\.com|slack\.com\/api\/chat\.|discord(app)?\.com\/api\/webhooks|api\.telegram\.org|api\.twilio\.com|api\.sendgrid\.com|api\.mailgun\.net|api\.postmarkapp\.com|api\.resend\.com|graph\.facebook\.com|api\.twitter\.com|api\.x\.com|gmail\.googleapis\.com)/i, "message"],
];
// Where your keys and sign-ins are kept: any command naming one reaches them.
const SECRET_PLACES = /(^|[\s"'=/~@])(\.ssh(\/|\s|$)|\.aws\/credentials|\.netrc\b|\.npmrc\b|\.pypirc\b|\.docker\/config\.json|\.git-credentials\b|\.kube\/config\b|id_(rsa|ed25519|ecdsa)\b|\.env(\s|$|["'])|\.env\.(?!example\b)[A-Za-z0-9_-]+)/;
// A tool's name (an integration's, say), in words: what sends, pays, deletes, signs up or reads
// a secret. One that only reads (get, list…) is none of these, unless it reads a secret.
const TOOL_WORDS: [RegExp, AlwaysKind][] = [
  [/\b(pay|payment|payments|charge|purchase|buy|checkout|refund|payout|transfer|subscribe|create order|place order)\b/, "payment"],
  [/\b(delete|remove|destroy|purge|trash|drop|erase|wipe)\b/, "delete"],
  [/\b(share|permission|permissions|invite|grant|revoke|collaborator|collaborators|role|roles)\b/, "permissions"],
  [/\b(sign up|signup|register|create account|create user)\b/, "account"],
  [/\b(send|reply|post|comment|message|email|mail|sms|tweet|forward|publish|create (pull request|issue|comment|review|discussion))\b/, "message"],
];
const SECRET_WORDS = /\b(password|passwords|secret|secrets|token|tokens|credential|credentials|api key|apikey|otp|totp|keychain)\b/;
const READS = /^(get|list|search|read|fetch|find|query|view|describe|show|lookup|count)$/;
// Files whose change is one of these: git's settings, and where keys and sign-ins are kept.
const FILES: [RegExp, AlwaysKind][] = [
  [/(^|\/)(\.gitconfig|\.gitmodules|\.git\/config)$/i, "gitConfig"],
  [/(^|\/)(\.ssh\/|\.aws\/credentials$|\.netrc$|\.npmrc$|\.pypirc$|\.git-credentials$|\.docker\/config\.json$|\.kube\/config$|\.env$|\.env\.(?!example$)[^/]+$)/i, "credentials"],
];
const fileKind = (file: string): AlwaysKind | null => FILES.find(([pattern]) => pattern.test(file))?.[1] ?? null;

const programOf = (word: string) => word.split("/").pop() ?? word;
// The words that start a part, past what only runs it (`env A=1`, `nice`, `npx`...).
function commandWords(words: string[]): string[] {
  let at = 0;
  while (at < words.length) {
    const word = programOf(words[at]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]) || ["env", "nice", "time", "command", "exec", "nohup", "xargs", "builtin", "npx", "bunx", "stdbuf"].includes(word)) at++;
    else if (word === "timeout") at += /^\d/.test(words[at + 1] ?? "") ? 2 : 1;
    else if ((word === "pnpm" || word === "yarn") && words[at + 1] === "dlx") at += 2;
    else break;
  }
  return words.slice(at);
}
// git's words past its own options (`-C repo`, `--git-dir=…`), save `-c`, which sets its settings
// for the one command.
function gitRest(words: string[]): string[] {
  let at = 0;
  while (at < words.length) {
    const word = words[at];
    if (word === "-c" || word.startsWith("--config-env")) return ["config", "--one-off"];
    if (word === "-C" || word === "--git-dir" || word === "--work-tree" || word === "--namespace") at += 2;
    else if (/^--(git-dir|work-tree|namespace|exec-path)=/.test(word) || word === "--no-pager" || word === "--bare" || word === "-p" || word === "-P") at++;
    else break;
  }
  return words.slice(at);
}

/** What a command line is, of what always comes to you; null when it's none of them. A line it
 * can't read is looked at as text: a program named anywhere in it counts. */
export function commandAlways(line: string): AlwaysKind | null {
  for (const [host, kind] of HOSTS) if (host.test(line)) return kind;
  if (SECRET_PLACES.test(line)) return "credentials";
  const read = readLine(line);
  const parts = "unreadable" in read ? line.split(/[;&|\n()`$]+/).map(text => ({ words: text.trim().split(/\s+/).filter(Boolean), writes: [] as string[] })) : read.parts;
  for (const part of parts) {
    for (const file of part.writes) {
      const kind = fileKind(file);
      if (kind) return kind;
    }
    let words = commandWords(part.words);
    if (!words.length) continue;
    // (`git-config`, `/usr/lib/git-core/git-push`: git's own commands by their programs.)
    const gitOwn = /^git-([a-z][a-z0-9-]*)$/.exec(programOf(words[0]));
    if (gitOwn) words = ["git", gitOwn[1], ...words.slice(1)];
    const program = programOf(words[0]);
    if (PROGRAMS[program]) return PROGRAMS[program];
    const given = program === "git" ? gitRest(words.slice(1)) : words.slice(1);
    if (program === "git" && given[0] === "config" && gitConfigSets(given.slice(1))) return "gitConfig";
    const rest = given.join(" ");
    for (const [name, sub, kind] of SUBCOMMANDS) if (name.test(program) && sub.test(rest)) return kind;
    // Changing a file in place (sed -i, tee, cp over it): the file's kind.
    if (["sed", "perl", "tee", "cp", "mv", "install"].includes(program)) {
      for (const word of words.slice(1)) {
        const kind = fileKind(word);
        if (kind) return kind;
      }
    }
    // A shell running a line of its own: that line, too.
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

/** A tool's name in words: `gmail_send_email`, `sendMail` and `create-pull-request` alike. */
const toolWords = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.:/]+/g, " ").toLowerCase().trim();

/** What a tool is by its name, of what always comes to you; null when it's none of them. */
export function toolAlways(name: string): AlwaysKind | null {
  const words = toolWords(name);
  if (!words) return null;
  if (SECRET_WORDS.test(words)) return "credentials";
  // One whose first verb only reads (`gmail get message`): what it reads isn't sent, paid or
  // deleted.
  const verb = words.split(" ").find(word => READS.test(word) || TOOL_WORDS.some(([pattern]) => pattern.test(word)));
  if (verb && READS.test(verb)) return null;
  for (const [pattern, kind] of TOOL_WORDS) if (pattern.test(words)) return kind;
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
    for (const file of [...resources, ...named]) {
      const kind = fileKind(file);
      if (kind && !(action === "read" && kind === "gitConfig")) return kind;
    }
    return null;
  }
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

/** `rules` with what always comes to you asked whatever their approval (and, overnight, publishing
 * and deploying: `publishing`): after their own, so they win over an allow; then their Don't Allows
 * of commands, so those stay Don't Allow. Nothing else of theirs moves (a folder's allow stays
 * where it was). Made again from what it made before, it's the same. For every session of a bot's
 * work, and the bot's own conversation. */
export function withAlwaysAsk(rules: readonly KitRule[], { publishing = false }: { publishing?: boolean } = {}): KitRule[] {
  const ours = [...ALWAYS_ASK_RULES, ...PUBLISH_ASK_RULES];
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
 * as the engine matches it), and edits of git's settings and of where keys are kept. */
export const ALWAYS_ASK_RULES: KitRule[] = [
  ...Object.keys(PROGRAMS).flatMap(program => [program, `${program} *`, `*/${program} *`].map(resource => ({ action: "shell", resource, effect: "ask" as const }))),
  ...[
    "* xargs rm*", "*-c *rm *",
    "git config *", "git -c *", "git -C *", "git --git-dir*", "git remote add*", "git remote set-url*", "git remote remove*", "git remote rm*",
    "git clean *", "git reset --hard*", "git reset * --hard*", "git push *--force*", "git push * -f*", "git push * +*", "git push *--delete*", "git push * -d *", "git push * :*", "git branch -D*", "git branch * -D*",
    "gh issue create*", "gh issue comment*", "gh pr create*", "gh pr comment*", "gh pr review*", "gh gist create*", "gh release create*", "gh repo delete*", "gh repo edit*", "gh secret *",
    "gh auth token*", "gh auth login*", "gh auth refresh*", "gh auth setup-git*", "gh api *-X *", "gh api *--method*", "gh api * -f *", "gh api * -F *", "gh api *--field*",
    "stripe *", "npx stripe *", "bunx stripe *", "find * -delete*", "find * -exec rm*",
    "*://api.stripe.com*", "*://api.paypal.com*", "*://hooks.slack.com*", "*://slack.com/api/chat.*", "*://discord.com/api/webhooks*", "*://discordapp.com/api/webhooks*", "*://api.telegram.org*", "*://api.twilio.com*", "*://api.sendgrid.com*", "*://api.mailgun.net*", "*://api.resend.com*", "*://gmail.googleapis.com*",
    "*.ssh/*", "*.aws/credentials*", "*.netrc*", "*.git-credentials*",
  ].map(resource => ({ action: "shell", resource, effect: "ask" as const })),
  // Reading git's settings is reading.
  ...["git config --get*", "git config --list*", "git config -l*", "git config --get-all*", "git config --get-regexp*", "git config get *", "git config list", "git config list -*"].map(resource => ({ action: "shell", resource, effect: "allow" as const })),
  ...["*.env", "*.env.*", "*/.ssh/*", "*/.gitconfig", "*/.gitmodules", "*/.git/config", "*/.netrc", "*/.npmrc", "*/.pypirc", "*/.git-credentials", "*/.aws/credentials", "*/.docker/config.json", "*/.kube/config"]
    .map(resource => ({ action: "edit", resource, effect: "ask" as const })),
  { action: "edit", resource: "*.env.example", effect: "allow" },
];
