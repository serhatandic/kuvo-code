// The ask rules a box before 0.9.189 put into bots' conversations and their work, whatever their
// approval: payments, access, accounts, messages, force pushes and remote deletes, overnight
// publishing and deploying, and (before 0.9.185) deletes, git's settings and sign-ins. A bot in a
// mode now does what any conversation in that mode does, and only what you set in Edit Bot holds
// it back: these are taken out of a conversation's rules as the box makes them again, never left
// behind as if they were its own (PROTOCOL.md, "Work").

import type { KitRule } from "../bots/kit";

const same = (a: KitRule, b: KitRule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect;

// Programs asked whatever their arguments.
const PROGRAMS = [
  "useradd", "adduser", "sysadminctl", "dscl",
  "mail", "mailx", "sendmail", "mutt", "msmtp", "swaks",
];

// Overnight, while no goal's public step was on.
const PUBLISH_ASK_RULES: KitRule[] = [
  "git push*", "npm publish*", "pnpm publish*", "yarn publish*", "yarn npm publish*", "bun publish*", "cargo publish*", "gem push*", "twine upload*", "poetry publish*", "swift package-registry publish*",
  "vercel*", "npx vercel*", "netlify deploy*", "npx netlify*", "wrangler deploy*", "wrangler publish*", "wrangler pages deploy*", "npx wrangler*", "firebase deploy*", "fly deploy*", "flyctl deploy*",
  "railway up*", "render deploy*", "serverless deploy*", "sls deploy*", "docker push*", "podman push*", "kubectl apply*", "helm upgrade*", "helm install*", "terraform apply*", "tofu apply*", "pulumi up*",
  "eas submit*", "eas build*--auto-submit*", "fastlane*", "xcrun altool*", "gh release*", "gh pr merge*", "gh workflow run*",
].map(resource => ({ action: "shell", resource, effect: "ask" as const }));

// Payments, access, accounts, messages, force pushes and remote deletes.
const ALWAYS_ASK_RULES: KitRule[] = [
  ...PROGRAMS.flatMap(program => [program, `${program} *`, `*/${program} *`].map(resource => ({ action: "shell", resource, effect: "ask" as const }))),
  ...[
    "git push *--force*", "git push * -f*", "git push * +*", "git push *--delete*", "git push * -d *", "git push * :*", "git push *--mirror*",
    "gh issue create*", "gh issue comment*", "gh pr create*", "gh pr comment*", "gh pr review*", "gh gist create*", "gh release create*", "gh repo delete*", "gh repo edit*",
    "gh api *-X *", "gh api *--method*", "gh api * -f *", "gh api * -F *", "gh api *--field*",
    "stripe *", "npx stripe *", "bunx stripe *",
    "*://api.stripe.com*", "*://api.paypal.com*", "*://hooks.slack.com*", "*://slack.com/api/chat.*", "*://discord.com/api/webhooks*", "*://discordapp.com/api/webhooks*", "*://api.telegram.org*", "*://api.twilio.com*", "*://api.sendgrid.com*", "*://api.mailgun.net*", "*://api.resend.com*", "*://gmail.googleapis.com*",
  ].map(resource => ({ action: "shell", resource, effect: "ask" as const })),
];

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

const FORMER: KitRule[] = [...ALWAYS_ASK_RULES, ...PUBLISH_ASK_RULES, ...FORMER_ASK_RULES];

/** `rules` without what a box before put in them for a bot, in their own order: but for what `kept`
 * (Settings › Permissions) has itself. */
export const withoutFormerAsks = (rules: readonly KitRule[], kept: readonly KitRule[] = []): KitRule[] =>
  rules.filter(rule => !FORMER.some(each => same(each, rule)) || kept.some(each => same(each, rule)));

/** Whether `rules` still carry any of it, other than what `kept` (Settings › Permissions) has too. */
export const hasFormerAsks = (rules: readonly KitRule[], kept: readonly KitRule[] = []): boolean =>
  rules.some(rule => FORMER.some(each => same(each, rule)) && !kept.some(each => same(each, rule)));
