// Writes docs.json: signed documents (PROTOCOL.md, "Documents") that the bridge and KuvoLink must
// both take, and ones both must turn away. Ed25519 signs the same way every time from a seed, so the
// file comes out the same on every run. Run with `node make-docs-vectors.mjs` in this folder.
import crypto from "node:crypto";
import fs from "node:fs";

const PREFIX = Buffer.from("kuvo-link doc v1\0");
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const seedOf = name => crypto.createHash("sha256").update(`kuvo docs ${name}`).digest();
const privateOf = seed => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
const publicOf = seed => crypto.createPublicKey(privateOf(seed)).export({ format: "der", type: "spki" }).subarray(SPKI.length).toString("base64url");
const b64 = bytes => Buffer.from(bytes).toString("base64url");
const short = bytes => crypto.createHash("sha256").update(bytes).digest().subarray(0, 8).toString("base64url");

const mac = seedOf("mac"), machine = seedOf("machine");
const json = value => Buffer.from(JSON.stringify(value));
const sign = (seed, bytes) => b64(crypto.sign(null, Buffer.concat([PREFIX, bytes]), privateOf(seed)));
const doc = (seed, kind, n, body, origin = publicOf(seed)) => json({ v: 1, kind, origin, n, body });
const envelope = (seed, bytes) => ({ d: b64(bytes), s: sign(seed, bytes) });

const peersBody = {
  boxes: [
    { key: b64(crypto.createHash("sha256").update("mac x25519").digest()), sign: publicOf(mac), address: b64(Buffer.alloc(16, 1)), name: "MacBook", kind: "mac" },
    { key: b64(crypto.createHash("sha256").update("machine x25519").digest()), sign: publicOf(machine), address: b64(Buffer.alloc(16, 2)), name: "lokum", kind: "machine", id: "lokum.invalid" },
  ],
  moved: [],
  left: [],
};
const phonesBody = { phones: [{ key: b64(Buffer.alloc(32, 7)), name: "iPhone ✦", pairing: "abc" }], removed: [{ key: b64(Buffer.alloc(32, 9)), pairing: "old" }] };
const personalitiesBody = { personalities: [{ id: "custom.calm", name: "Calm", description: "Calm and brief.", symbol: "person.crop.circle", updated: 1760000000000 }], removed: [] };

const taken = [
  { name: "a Mac's peers", seed: mac, kind: "peers", n: 1, body: peersBody },
  { name: "a machine's phones, with a removal and words that aren't ASCII", seed: machine, kind: "phones", n: 7, body: phonesBody },
  { name: "a view of your personalities, at a high version", seed: machine, kind: "personalities", n: 9007199254740991, body: personalitiesBody },
].map(({ name, seed, kind, n, body }) => {
  const bytes = doc(seed, kind, n, body);
  return { name, envelope: envelope(seed, bytes), origin: publicOf(seed), kind, n, h: short(bytes) };
});

const good = doc(mac, "peers", 2, peersBody);
const changed = doc(mac, "peers", 2, { ...peersBody, boxes: [...peersBody.boxes, { ...peersBody.boxes[1], key: b64(Buffer.alloc(32, 3)), name: "stranger" }] });
const refused = [
  { name: "words changed after signing", envelope: { d: b64(changed), s: sign(mac, good) } },
  { name: "signed by another key than the origin it names", envelope: envelope(machine, doc(mac, "peers", 2, peersBody)) },
  { name: "the signature cut short", envelope: { d: b64(good), s: sign(mac, good).slice(0, 80) } },
  { name: "signed without the prefix", envelope: { d: b64(good), s: b64(crypto.sign(null, good, privateOf(mac))) } },
  { name: "version 0", envelope: envelope(mac, doc(mac, "peers", 0, peersBody)) },
  { name: "a version that isn't a whole number", envelope: envelope(mac, doc(mac, "peers", 1.5, peersBody)) },
  { name: "a version past what counts exactly", envelope: envelope(mac, doc(mac, "peers", 9007199254740992, peersBody)) },
  { name: "a kind there isn't", envelope: envelope(mac, doc(mac, "agents", 1, peersBody)) },
  { name: "another format's", envelope: envelope(mac, json({ v: 2, kind: "peers", origin: publicOf(mac), n: 1, body: peersBody })) },
  { name: "a body that isn't an object", envelope: envelope(mac, json({ v: 1, kind: "peers", origin: publicOf(mac), n: 1, body: [] })) },
  { name: "the bytes in base64 with padding", envelope: (() => { const e = envelope(mac, json({ v: 1, kind: "peers", origin: publicOf(mac), n: 1, body: { a: 1 } })); return { d: Buffer.from(e.d, "base64url").toString("base64"), s: e.s }; })() },
  { name: "not JSON", envelope: envelope(mac, Buffer.from("peers, version 1")) },
];

// A document bigger than one mail, and its parts as a box sends them: 40,000 of its `d` at a time.
const big = { personalities: Array.from({ length: 20 }, (_, i) => ({ id: `custom.p${i}`, name: `P${i}`, description: "Words. ".repeat(280).trim(), symbol: "person.crop.circle", updated: 1760000000000 + i })), removed: [] };
const bigEnvelope = envelope(machine, doc(machine, "personalities", 3, big));
const whole = crypto.createHash("sha256").update(bigEnvelope.d).digest("base64url");
const of = Math.ceil(bigEnvelope.d.length / 40_000);
const parts = Array.from({ length: of }, (_, i) => ({ whole, i, of, d: bigEnvelope.d.slice(i * 40_000, (i + 1) * 40_000), s: bigEnvelope.s }));

fs.writeFileSync("docs.json", JSON.stringify({
  about: "Signed documents (PROTOCOL.md, \"Documents\"): Ed25519 over \"kuvo-link doc v1\\0\" and the document's bytes, {v: 1, kind, origin, n, body}, given as {d, s} in base64url without padding. `taken` must verify, giving its origin, kind, version and h (the first 8 bytes of the bytes' SHA-256); `refused` must not. `parts`: a document too big for one mail, in the parts a box sends it in (40,000 characters of `d` each, `whole` the SHA-256 of all of `d`), which put together must verify.",
  taken,
  refused,
  parts: { origin: publicOf(machine), kind: "personalities", n: 3, parts },
}, null, 1) + "\n");
