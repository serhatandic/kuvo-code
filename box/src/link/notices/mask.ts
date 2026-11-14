// What a notice shows (KuvoLink's SecretMask: the same rules, held to Vectors/masking.json).
// What looks like a secret (a key, a token, a password) as dots, everything else as written, so a
// notice on a phone's lock screen never shows one and still says what happened.

const SHOWN_LENGTH = 4000;
const HASH_NAMES = "commit|sha|sha1|sha256|sha512|md5|rev|revision|hash|ref|head|onto|checksum|digest|etag|integrity|fingerprint|cache[ _.-]?key|public[ _.-]?key|object|oid|tree|parent|blob|base|id|uuid|tag|build|version|release";
// Either case, letter by letter (a part of a pattern that takes either, where the rest doesn't).
const eitherCase = (word: string) => [...word].map(letter => /[a-z]/i.test(letter) ? `[${letter.toLowerCase()}${letter.toUpperCase()}]` : letter).join("");

const trimmedName = (prefix: string) => prefix.replace(/[\s:=>"'\]\\_-]+$/, "");

export function isSecretName(prefix: string): boolean {
  const name = trimmedName(prefix);
  const word = name.split(/[\s([{,;"'=/]+/).filter(Boolean).at(-1) ?? "";
  if (/secret|private|pass|pwd|token|credential/i.test(word)) return true;
  return /key$/i.test(name) && !/(cache|public)[ _.-]?key$/i.test(name);
}

export function namesHash(prefix: string): boolean {
  if (prefix.endsWith(":")) {
    const before = prefix.slice(0, -1);
    const token = before.split(/\s+/).filter(Boolean).at(-1);
    if (token && /[/.]/.test(token) && before.length && !/\s/.test(before.at(-1)!)) return true;
  }
  return !isSecretName(prefix) && new RegExp(`(?:${HASH_NAMES})s?$`, "i").test(trimmedName(prefix));
}

const HEX_AFTER_NAME = /(?<=[A-Za-z0-9_])(?:\\?["'])?\]?[ \t]*(?::=|=>|[:=])[ \t]*(?:\\?["'])?([0-9a-fA-F]{32,})(?![0-9A-Za-z])/dg;

export function maskedHexValues(text: string): string {
  let result = text;
  for (const match of [...text.matchAll(HEX_AFTER_NAME)].reverse()) {
    const [start, end] = match.indices![1]!;
    const prefix = text.slice(Math.max(0, start - 32), start);
    if (namesHash(prefix)) continue;
    result = result.slice(0, start) + "•••" + result.slice(end);
  }
  return result;
}

const HEX_PART = /(?<![0-9A-Za-z])[0-9a-f]{32,}(?![0-9A-Za-z])/g;

export function markingHashes(run: string, before: string): string {
  let result = run;
  for (const hit of [...run.matchAll(HEX_PART)].reverse()) {
    const prefix = (before + run.slice(0, hit.index)).slice(-32);
    const isCommit = hit[0].length === 40 || hit[0].length === 64;
    let isHash;
    if (isCommit && (!prefix.length || /[\s/+"'([]/.test(prefix.at(-1)!))) isHash = true;
    else if (isCommit && prefix.endsWith("-")) isHash = !isSecretName(prefix);
    else isHash = namesHash(prefix);
    if (isHash) result = result.slice(0, hit.index) + "h" + result.slice(hit.index + hit[0].length);
  }
  return result;
}

const WORDS = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g;

// `text` cut to what a notice shows, between words, so a key isn't cut short of looking like one.
function cutShown(text: string) {
  const start = [...text].slice(0, SHOWN_LENGTH);
  let end = start.length;
  for (let index = start.length - 1; index >= Math.max(0, start.length - 100); index--) {
    if (!/[\p{L}\p{N}_\-+/=]/u.test(start[index]!)) {
      end = index;
      break;
    }
  }
  return start.slice(0, end).join("") + "…";
}

export function maskedNamed(text: string): string {
  // (A possessive `?+` written as a lookahead captured and matched again: what's there is taken.)
  const named = /((?:api[_-]?key|secret(?:[_-]?access[_-]?key)?|password|passwd|authorization)["']?\s*[:=]\s*["']?(?=((?:bearer\s+|basic\s+|token\s+(?:token=)?["']?)?))\2|bearer\s+|(?<![\w-])--(?=\w)[\w-]{0,60}?(?:password|passwd|secret)[=\s]+(?!-))[^\s"'&;]{3,}/gi;
  text = text.replace(named, "$1•••");
  const flag = /((?<![\w-])--(?=\w)[\w-]{0,60}?(?<!(?:sort|foreign|partition|group|cache|order|index|range|lookup|hash)[-_])(?<!hot|turn|mon)(?:token|key)[=\s]+(?!-))(?![0-9][^\s"'&;]{0,7}(?:[\s"'&;]|$))[^\s"'&;]{3,}/gi;
  text = text.replace(flag, "$1•••");
  text = maskedHexValues(text);
  const token = /(token["']?\s*[:=]\s*["']?(?=((?:bearer\s+|basic\s+)?))\2)(?![0-9]+(?:[\s"'&;,}]|$))[^\s"'&;]{3,}/gi;
  text = text.replace(token, "$1•••");
  text = text.replace(/(:\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1•••@");
  text = text.replace(/(:\/\/)[^\s/:@]{20,}@/g, "$1•••@");
  text = text.replace(/(\bcurl\b[^\n]*?\s(?:-u|--user)\s+[^\s:]+:)\S+/g, "$1•••");
  text = text.replace(/(secret[_-]?access[_-]?key\s+)\S+/gi, "$1•••");
  text = text.replace(/(hooks\.slack\.com\/services\/)[^\s"'<>]+/g, "$1•••");
  const mysql = new RegExp(`(\\b(?:${["mysql", "mariadb", "mysqldump", "mysqladmin"].map(eitherCase).join("|")})\\b[^\\n]*?\\s-p)\\S+`, "g");
  text = text.replace(mysql, "$1•••");
  return text;
}

const KEY_STARTS = /^(sk-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|ghp_|gho_|ghs_|github_pat_|xox[abpe]-|AKIA|AIza|glpat-|dop_v1_|sbp_|pul-|npm_|hf_|gsk_|xai-|pplx-|r8_|lin_api_|ntn_|shp(at|ss|ca)_)/;
const IS_HASH = /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export function masked(text: string): string {
  text = maskedNamed([...text].length > SHOWN_LENGTH ? cutShown(text) : text);
  let result = "";
  let at = 0;
  for (const match of text.matchAll(/[A-Za-z0-9_\-+/=]{20,}/g)) {
    const run = match[0];
    const location = match.index;
    if (run.length < 24) {
      if (!/^(AKIA|ASIA)[0-9A-Z]{16}$/.test(run)) continue;
      result += text.slice(at, location) + "•••";
      at = location + run.length;
      continue;
    }
    const prefixed = run.split("/").some(part => KEY_STARTS.test(part));
    const isHash = IS_HASH.test(run);
    const before = text.slice(Math.max(0, location - 32), Math.max(0, location - 32) + Math.min(32, location));
    const plain = markingHashes(run, before)
      .replace(/(?<![0-9A-Fa-f])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Fa-f])/g, "u")
      .replace(/\/var\/folders\/[^/]+\/[^/]+/g, "/var/folders/t/t");
    const wordy = plain.split(/[/\-_.]/).filter(part => part.length).every(part => {
      if (part.length < 12) return true;
      if (/^[0-9]*[a-fA-F][0-9a-fA-F]*$/.test(part)) return part.length < 20;
      return part.length / Math.max(1, (part.match(WORDS) ?? []).length) >= 3.5;
    });
    const mixed = /[A-Za-z]/.test(run) && /\d/.test(run);
    if (!((prefixed && mixed) || (mixed && !isHash && !wordy))) continue;
    result += text.slice(at, location) + "•••";
    at = location + run.length;
  }
  return result + text.slice(at);
}

// Whether a notice shows all of `text`: one that hides some of it doesn't answer from its buttons,
// as you'd answer what you can't see.
export const showsAll = (text: string): boolean => [...text].length <= SHOWN_LENGTH && masked(text) === text;
