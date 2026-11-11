// An outside source's item as the Work Queue names it (PROTOCOL.md, "The Work Queue", Issues and
// pull requests): a GitHub issue or pull request by its stored ref, `gh:owner/repo#12`, or by its
// page. Only github.com for now: GitHub Enterprise's stay plain text until they have a key of their
// own. (Nothing here reads GitHub: `github.ts` does.)

/** An issue or a pull request on GitHub, by where it is. */
export interface IssueAt {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

export const GITHUB_HOST = "github.com";
// (An enterprise-managed user's owner name has a "_" in it: "ada_kuvo".)
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})";
const REPO = "[A-Za-z0-9_.-]{1,100}";
const STORED = new RegExp(`^gh:(${OWNER})/(${REPO})#(\\d{1,10})$`);
const PAGE = new RegExp(`^https?://(?:www\\.)?github\\.com/(${OWNER})/(${REPO})/(?:issues|pull)/(\\d{1,10})(?:[/?#][^\\s]*)?$`, "i");

/** What `given` names on GitHub: `gh:owner/repo#12`, or the issue's or pull request's page; null
 * for anything else. */
export function issueAt(given: unknown): IssueAt | null {
  if (typeof given !== "string") return null;
  const text = given.trim();
  const found = text.match(STORED) ?? text.match(PAGE);
  if (!found) return null;
  const [, owner, repo, digits] = found as unknown as [string, string, string, string];
  const number = Number(digits);
  // (A number past GitHub's own couldn't be read, and would spoil the query it's in.)
  if (repo === "." || repo === ".." || !(number >= 1 && number <= 2 ** 31 - 1)) return null;
  return { host: GITHUB_HOST, owner, repo, number };
}

/** The stored ref: `gh:owner/repo#12`. */
export const refText = (at: IssueAt): string => `gh:${at.owner}/${at.repo}#${at.number}`;

/** Its page on GitHub (an issue's address takes a pull request there too). */
export const pageOf = (at: IssueAt): string => `https://${at.host}/${at.owner}/${at.repo}/issues/${at.number}`;

/** What says it's the same one, whatever the case it was written in. */
export const sourceKey = (at: IssueAt): string => `${at.host}/${at.owner}/${at.repo}#${at.number}`.toLowerCase();

/** The key of an item's source: its GitHub one, or its kind and ref (another source's, a newer
 * box's). */
export const sourceKeyOf = (source: { kind: string; ref: string }): string => {
  const at = issueAt(source.ref);
  return at ? sourceKey(at) : `${source.kind}:${source.ref}`.toLowerCase();
};
