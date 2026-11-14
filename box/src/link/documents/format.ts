// What boxes copy between them, as it's signed and read (PROTOCOL.md, "Documents"): who a Mac's
// boxes are (its peers document), the phones each box pairs and removes (its phones document),
// and your personalities (each box's view of the library). Each origin signs its own with a key of
// its own (Ed25519: `sign` in link.json, made with this box's other keys; a Mac's comes in setup,
// over SSH), and numbers each version. Held to protocol/vectors/docs.json, as KuvoLink's Documents is.

import crypto from "node:crypto";
import { type Doc, DOC_KINDS, type DocKind, type SignedDoc } from "../../shared/documents";
import { isObject } from "../../shared/json";

const DOC_SIGNED = Buffer.from("kuvo-link doc v1\0");
// A document at most so big (its JSON), and in a mail at most so much of one; a bigger one goes in parts.
export const MOST_DOC = 512 * 1024;
export const DOC_PART = 40_000;
export const MOST_PARTS = Math.ceil(MOST_DOC * 4 / 3 / DOC_PART) + 1;
/** A signing key's public half, as documents and link.json name one: 32 bytes, base64url. */
export const SIGN = /^[A-Za-z0-9_-]{43}$/;
const ED_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const ED_SPKI = Buffer.from("302a300506032b6570032100", "hex");

export const newSigningSeed = () => crypto.randomBytes(32).toString("base64url");
const edPrivate = (seed: string) => crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, Buffer.from(seed, "base64url")]), format: "der", type: "pkcs8" });
const edPublic = (key: string) => crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(key, "base64url")]), format: "der", type: "spki" });
const signingKeys = new Map<string, string>();
// The public half of a signing key (its 32-byte seed): what documents name as their origin.
export function signingKeyOf(seed: string): string {
  let key = signingKeys.get(seed);
  if (!key) {
    key = crypto.createPublicKey(edPrivate(seed)).export({ format: "der", type: "spki" }).subarray(ED_SPKI.length).toString("base64url");
    signingKeys.set(seed, key);
  }
  return key;
}
/** This box's own signing key's public half (link.json's `sign`), or null without one. */
export const ownSign = (link: { sign?: unknown } | null | undefined): string | null => {
  try {
    return typeof link?.sign === "string" ? signingKeyOf(link.sign) : null;
  } catch {
    return null;
  }
};

/** `bytes` signed with the signing key `seed` (Ed25519), base64url: a Mac's proof to its machines'
 * vaults (vault.ts `provedMac`), as its app made them before its box moved (mac/app-keys.ts). */
export const signWith = (seed: string, bytes: Buffer): string => crypto.sign(null, bytes, edPrivate(seed)).toString("base64url");

export const shortHash = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest().subarray(0, 8).toString("base64url");
export const bodyHash = (body: unknown) => shortHash(Buffer.from(JSON.stringify(body)));
// The bytes an origin signs for one version of its document.
export const docBytes = (origin: string, kind: DocKind, n: number, body: object) => Buffer.from(JSON.stringify({ v: 1, kind, origin, n, body }));

// Version `n` of the document of `kind` that the key `seed` signs: `{d, s}`, as it's given.
export function signDoc(seed: string, kind: DocKind, n: number, body: object): SignedDoc {
  const bytes = docBytes(signingKeyOf(seed), kind, n, body);
  return { d: bytes.toString("base64url"), s: crypto.sign(null, Buffer.concat([DOC_SIGNED, bytes]), edPrivate(seed)).toString("base64url") };
}

// A document as given, checked: signed by the origin it names, of a kind there is, its version a
// whole number from 1, no bigger than a document can be. `{origin, kind, n, body, h, envelope}`
// (`h`, its bytes' hash, as digests name it), or null.
export function readDoc(envelope: unknown): Doc | null {
  if (!isObject(envelope) || typeof envelope.d !== "string" || typeof envelope.s !== "string" || envelope.d.length > Math.ceil(MOST_DOC * 4 / 3) + 4) return null;
  let bytes: Buffer, doc: unknown;
  try {
    bytes = Buffer.from(envelope.d, "base64url");
    if (bytes.length > MOST_DOC || bytes.toString("base64url") !== envelope.d) return null;
    doc = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(doc) || doc.v !== 1 || !(DOC_KINDS as readonly unknown[]).includes(doc.kind) || typeof doc.origin !== "string" || !SIGN.test(doc.origin)
    || !Number.isSafeInteger(doc.n) || (doc.n as number) < 1 || !isObject(doc.body)) return null;
  try {
    const signature = Buffer.from(envelope.s, "base64url");
    if (signature.length !== 64 || !crypto.verify(null, Buffer.concat([DOC_SIGNED, bytes]), edPublic(doc.origin), signature)) return null;
  } catch {
    return null;
  }
  return { origin: doc.origin, kind: doc.kind as DocKind, n: doc.n as number, body: doc.body, h: shortHash(bytes), envelope: { d: envelope.d, s: envelope.s } };
}

// One this box keeps (`link.docs`, checked as it came, so trusted as it reads), read again;
// remembered, as it's read often.
const heldDocs = new Map<string, Doc>();
export function held(envelope: SignedDoc | null | undefined): Doc | null {
  if (typeof envelope?.d !== "string") return null;
  let doc = heldDocs.get(envelope.d);
  if (!doc) {
    try {
      const bytes = Buffer.from(envelope.d, "base64url");
      const parsed = JSON.parse(bytes.toString("utf8"));
      doc = { origin: parsed.origin, kind: parsed.kind, n: parsed.n, body: isObject(parsed.body) ? parsed.body : {}, h: shortHash(bytes), envelope };
    } catch {
      return null;
    }
    if (heldDocs.size >= 256) heldDocs.delete(heldDocs.keys().next().value!);
    heldDocs.set(envelope.d, doc);
  }
  return doc;
}
export const docKey = (origin: string, kind: DocKind) => `${origin} ${kind}`;
