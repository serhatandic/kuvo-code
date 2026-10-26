// X25519 keys, kept as their raw 32 bytes, and a device's address on the relay (PROTOCOL.md,
// "Keys and addresses").

import crypto from "node:crypto";

const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
export const EMPTY = Buffer.alloc(0);

const privateKey = (raw: Buffer) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: "der", type: "pkcs8" });
const publicKey = (raw: Buffer) => crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });
export const newKey = (): Buffer => crypto.generateKeyPairSync("x25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8.length);
export const publicOf = (raw: Buffer): Buffer => crypto.createPublicKey(privateKey(raw)).export({ format: "der", type: "spki" }).subarray(SPKI.length);
export const dh = (raw: Buffer, remote: Buffer): Buffer => crypto.diffieHellman({ privateKey: privateKey(raw), publicKey: publicKey(remote) });
export const addressOf = (secret: Buffer): Buffer => crypto.createHash("sha256").update("kuvo-link address v1").update(secret).digest().subarray(0, 16);
