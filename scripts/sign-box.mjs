// Signs a box release, for machines to update themselves with (protocol/PROTOCOL.md,
// "Updates"), and prints boxes.json: the manifest and its signature, in one file, so the two
// can't come from different releases.
//   KUVO_BOX_SIGNING_KEY=<PEM> node scripts/sign-box.mjs <version> <pack> <pack's URL> <box.json>
// The key is Ed25519 (openssl genpkey -algorithm ed25519). Machines take a manifest only when its
// key is one pinned in kuvo-link.js (UPDATE_KEYS), and the signature covers "kuvo-box v1\n" and
// the manifest's bytes, so nothing else signed with the key passes for one.
import crypto from "node:crypto";
import fs from "node:fs";

const [version, pack, url, boxFile] = process.argv.slice(2);
if (!version || !pack || !url || !boxFile || !process.env.KUVO_BOX_SIGNING_KEY) {
  console.error("Usage: KUVO_BOX_SIGNING_KEY=<PEM> node scripts/sign-box.mjs <version> <pack> <pack's URL> <box.json>");
  process.exit(2);
}
const key = crypto.createPrivateKey(process.env.KUVO_BOX_SIGNING_KEY);
if (key.asymmetricKeyType !== "ed25519") {
  console.error("KUVO_BOX_SIGNING_KEY isn't an Ed25519 key.");
  process.exit(1);
}
const box = JSON.parse(fs.readFileSync(boxFile, "utf8"));
if (box.version !== version) {
  console.error(`The box's files are ${box.version}'s, not ${version}'s.`);
  process.exit(1);
}
const data = fs.readFileSync(pack);
const manifest = Buffer.from(JSON.stringify({
  kuvo: "box/1",
  version,
  released: new Date().toISOString(),
  engine: box.engine,
  linux: box.linux,
  darwin: box.darwin,
  pack: { url, sha256: crypto.createHash("sha256").update(data).digest("hex"), size: data.length },
}));
const signature = crypto.sign(null, Buffer.concat([Buffer.from("kuvo-box v1\n"), manifest]), key);
const publicKey = crypto.createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
process.stdout.write(JSON.stringify({ manifest: manifest.toString("base64"), signature: signature.toString("base64"), key: publicKey }) + "\n");
