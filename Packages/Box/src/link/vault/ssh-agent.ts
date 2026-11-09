// Kuvo Code's own SSH agent (D9): the sandbox hides your SSH keys from agents' commands, and a
// conversation's commands reach the keys you keep in the vault for it through this instead. It
// speaks the SSH agent protocol (draft-miller-ssh-agent) on a socket of its own, lists the keys the
// conversation may use, and signs with them: the private key never leaves the process that holds
// the vault. Keys are the vault's `key` items with a `private_key` (OpenSSH's own format, or PEM),
// unencrypted.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const FAILURE = 5;
const REQUEST_IDENTITIES = 11;
const IDENTITIES_ANSWER = 12;
const SIGN_REQUEST = 13;
const SIGN_RESPONSE = 14;
// Sign requests' flags: which hash an RSA key signs with.
const RSA_SHA2_256 = 2;
const RSA_SHA2_512 = 4;
// A message no bigger than this (OpenSSH's own limit).
const LONGEST = 256 * 1024;

/** A key the agent offers: its vault item, and what's signed with. */
export interface AgentKey {
  id: string;
  name: string;
  /** The public key as SSH writes it (`string type, …`). */
  blob: Buffer;
  type: string;
  key: crypto.KeyObject;
}

/** Where a conversation's agent gets its keys: those it may use, and whether it may sign with one now. */
export interface AgentSource {
  keys(): Promise<AgentKey[]>;
  /** Whether this key may sign now (asking the user, when its grant says to, until `signal` ends). */
  allow(key: AgentKey, signal: AbortSignal): Promise<boolean>;
}

class Reader {
  private at = 0;
  constructor(private readonly data: Buffer) {}
  get done() { return this.at >= this.data.length; }
  u32(): number {
    if (this.at + 4 > this.data.length) throw new Error("short");
    const value = this.data.readUInt32BE(this.at);
    this.at += 4;
    return value;
  }
  bytes(): Buffer {
    const length = this.u32();
    if (this.at + length > this.data.length) throw new Error("short");
    const value = this.data.subarray(this.at, this.at + length);
    this.at += length;
    return value;
  }
  text(): string { return this.bytes().toString("utf8"); }
}

const u32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
const str = (value: Buffer | string) => { const data = typeof value === "string" ? Buffer.from(value) : value; return Buffer.concat([u32(data.length), data]); };
// An mpint: big-endian, as short as it can be, with a zero first when its top bit is set.
const mpint = (value: Buffer) => {
  let start = 0;
  while (start < value.length && value[start] === 0) start++;
  const trimmed = value.subarray(start);
  return str(trimmed.length && trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
};
const b64url = (data: Buffer) => data.toString("base64url");
const bigOf = (data: Buffer) => (data.length ? BigInt("0x" + data.toString("hex")) : 0n);
const bufOf = (value: bigint, size?: number) => {
  let hex = value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const data = Buffer.from(hex, "hex");
  return size && data.length < size ? Buffer.concat([Buffer.alloc(size - data.length), data]) : data;
};
const unsigned = (data: Buffer) => { let start = 0; while (start < data.length - 1 && data[start] === 0) start++; return data.subarray(start); };

const CURVES: Record<string, { jwk: string; size: number; hash: string }> = {
  nistp256: { jwk: "P-256", size: 32, hash: "sha256" },
  nistp384: { jwk: "P-384", size: 48, hash: "sha384" },
  nistp521: { jwk: "P-521", size: 66, hash: "sha512" },
};
const CURVE_OF_JWK: Record<string, string> = { "P-256": "nistp256", "P-384": "nistp384", "P-521": "nistp521" };

/** The public key, as SSH writes it, and its type. */
function publicBlob(key: crypto.KeyObject): { blob: Buffer; type: string } {
  const jwk = key.export({ format: "jwk" }) as crypto.JsonWebKey;
  if (key.asymmetricKeyType === "ed25519") {
    return { type: "ssh-ed25519", blob: Buffer.concat([str("ssh-ed25519"), str(Buffer.from(jwk.x!, "base64url"))]) };
  }
  if (key.asymmetricKeyType === "rsa") {
    return { type: "ssh-rsa", blob: Buffer.concat([str("ssh-rsa"), mpint(Buffer.from(jwk.e!, "base64url")), mpint(Buffer.from(jwk.n!, "base64url"))]) };
  }
  if (key.asymmetricKeyType === "ec" && jwk.crv && CURVE_OF_JWK[jwk.crv]) {
    const curve = CURVE_OF_JWK[jwk.crv];
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
    const type = `ecdsa-sha2-${curve}`;
    return { type, blob: Buffer.concat([str(type), str(curve), str(point)]) };
  }
  throw new Error("This kind of key isn't one SSH signs with here: use an Ed25519, RSA or ECDSA key.");
}

// OpenSSH's own format (`-----BEGIN OPENSSH PRIVATE KEY-----`), which Node doesn't read.
function openSSHKey(data: Buffer): crypto.KeyObject {
  const magic = Buffer.from("openssh-key-v1\0");
  if (!data.subarray(0, magic.length).equals(magic)) throw new Error("That isn't a private key.");
  const outer = new Reader(data.subarray(magic.length));
  const cipher = outer.text();
  outer.text(); // its key derivation
  outer.bytes(); // and that's options
  if (cipher !== "none") throw new Error("This key has a passphrase: Kuvo Code's agent uses keys without one (ssh-keygen -p takes it off a copy).");
  if (outer.u32() !== 1) throw new Error("This file holds more than one key: keep each in an item of its own.");
  outer.bytes(); // the public key
  const inner = new Reader(outer.bytes());
  if (inner.u32() !== inner.u32()) throw new Error("That isn't a private key.");
  const type = inner.text();
  if (type === "ssh-ed25519") {
    const pub = inner.bytes();
    const both = inner.bytes();
    return crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64url(both.subarray(0, 32)), x: b64url(pub) }, format: "jwk" });
  }
  if (type === "ssh-rsa") {
    const [n, e, d, qi, p, q] = [inner.bytes(), inner.bytes(), inner.bytes(), inner.bytes(), inner.bytes(), inner.bytes()].map(unsigned);
    const big = { d: bigOf(d), p: bigOf(p), q: bigOf(q) };
    return crypto.createPrivateKey({
      key: { kty: "RSA", n: b64url(n), e: b64url(e), d: b64url(d), p: b64url(p), q: b64url(q),
        dp: b64url(bufOf(big.d % (big.p - 1n))), dq: b64url(bufOf(big.d % (big.q - 1n))), qi: b64url(qi) },
      format: "jwk",
    });
  }
  const curve = /^ecdsa-sha2-(nistp\d+)$/.exec(type)?.[1];
  if (curve && CURVES[curve]) {
    inner.text(); // the curve again
    const point = inner.bytes();
    const d = unsigned(inner.bytes());
    const { jwk, size } = CURVES[curve];
    if (point[0] !== 4 || point.length !== 1 + 2 * size) throw new Error("That isn't a private key.");
    return crypto.createPrivateKey({
      key: { kty: "EC", crv: jwk, x: b64url(point.subarray(1, 1 + size)), y: b64url(point.subarray(1 + size)), d: b64url(bufOf(bigOf(d), size)) },
      format: "jwk",
    });
  }
  throw new Error("This kind of key isn't one SSH signs with here: use an Ed25519, RSA or ECDSA key.");
}

/** A private key, as `ssh-keygen` writes it (OpenSSH's own format, or PEM), ready to sign with. */
export function privateKeyOf(text: string): { key: crypto.KeyObject; blob: Buffer; type: string } {
  const trimmed = text.trim();
  const openssh = /^-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+)-----END OPENSSH PRIVATE KEY-----$/.exec(trimmed);
  let key: crypto.KeyObject;
  if (openssh) key = openSSHKey(Buffer.from(openssh[1].replace(/\s+/g, ""), "base64"));
  else {
    if (/ENCRYPTED/.test(trimmed)) throw new Error("This key has a passphrase: Kuvo Code's agent uses keys without one (ssh-keygen -p takes it off a copy).");
    try { key = crypto.createPrivateKey(trimmed); } catch { throw new Error("That isn't a private key."); }
  }
  return { key, ...publicBlob(key) };
}

/** The signature SSH expects for `data`, by this key (`flags` pick an RSA key's hash). */
export function signWith(agentKey: Pick<AgentKey, "key" | "type">, data: Buffer, flags: number): Buffer {
  const { key, type } = agentKey;
  if (type === "ssh-ed25519") return Buffer.concat([str(type), str(crypto.sign(null, data, key))]);
  if (type === "ssh-rsa") {
    // SHA-1 only when the client asks for it, as OpenSSH's own agent does (a server that takes nothing else).
    const [name, hash] = flags & RSA_SHA2_512 ? ["rsa-sha2-512", "sha512"] : flags & RSA_SHA2_256 ? ["rsa-sha2-256", "sha256"] : ["ssh-rsa", "sha1"];
    return Buffer.concat([str(name), str(crypto.sign(hash, data, key))]);
  }
  const curve = type.replace("ecdsa-sha2-", "");
  const { hash, size } = CURVES[curve];
  const both = crypto.sign(hash, data, { key, dsaEncoding: "ieee-p1363" });
  return Buffer.concat([str(type), str(Buffer.concat([mpint(both.subarray(0, size)), mpint(both.subarray(size))]))]);
}

const message = (type: number, ...parts: Buffer[]) => {
  const body = Buffer.concat([Buffer.from([type]), ...parts]);
  return Buffer.concat([u32(body.length), body]);
};

async function answer(request: Buffer, source: AgentSource, signal: AbortSignal): Promise<Buffer> {
  const type = request[0];
  const body = new Reader(request.subarray(1));
  try {
    if (type === REQUEST_IDENTITIES) {
      const keys = await source.keys();
      return message(IDENTITIES_ANSWER, u32(keys.length), ...keys.flatMap(key => [str(key.blob), str(key.name)]));
    }
    if (type === SIGN_REQUEST) {
      const blob = body.bytes();
      const data = body.bytes();
      const flags = body.done ? 0 : body.u32();
      const key = (await source.keys()).find(each => each.blob.equals(blob));
      if (!key || !(await source.allow(key, signal))) return message(FAILURE);
      return message(SIGN_RESPONSE, str(signWith(key, data, flags)));
    }
  } catch {}
  // Adding, removing or locking keys, extensions, and anything else: not this agent's.
  return message(FAILURE);
}

// A socket's path is at most this long, in bytes (with its ending zero, 104 on macOS, 108 on Linux).
const LONGEST_PATH = process.platform === "darwin" ? 103 : 107;
// Requests a connection may have waiting: one at a time is how SSH asks.
const WAITING = 4;

/**
 * The agent on `socket` (`0600`, in a folder only its conversation can reach), for one conversation's
 * keys. Each connection's requests are answered in turn, and a connection with more waiting, or a
 * malformed or oversized request, is ended. Closing it ends its connections too, and with them any
 * ask still waiting for the user. A socket it can't open is `error` on the server, never thrown.
 */
export function serveAgent(socket: string, source: AgentSource): net.Server {
  const open = new Set<net.Socket>();
  const server = net.createServer(connection => {
    open.add(connection);
    const gone = new AbortController();
    let held = Buffer.alloc(0);
    let waiting = 0;
    let working = Promise.resolve();
    connection.on("error", () => {});
    connection.on("close", () => { open.delete(connection); gone.abort(); });
    connection.on("data", chunk => {
      held = Buffer.concat([held, chunk]);
      while (held.length >= 4) {
        const length = held.readUInt32BE(0);
        if (length === 0 || length > LONGEST || waiting >= WAITING) return void connection.destroy();
        if (held.length < 4 + length) break;
        const request = held.subarray(4, 4 + length);
        held = held.subarray(4 + length);
        waiting++;
        working = working
          .then(async () => {
            const reply = await answer(request, source, gone.signal);
            if (!connection.destroyed) connection.write(reply);
          })
          .catch(() => { connection.destroy(); })
          .finally(() => { waiting--; });
      }
    });
  });
  server.maxConnections = 16;
  server.on("error", () => {});
  const close = server.close.bind(server);
  server.close = (done?: (error?: Error) => void) => {
    for (const connection of open) connection.destroy();
    // (Closing removes the file it was bound as, which is now at its own name.)
    try { fs.rmSync(socket, { force: true }); } catch {}
    return close(done);
  };
  if (Buffer.byteLength(socket) > LONGEST_PATH) {
    queueMicrotask(() => server.emit("error", new Error(`An SSH agent's socket can't be this long: ${socket}`)));
    return server;
  }
  try { fs.rmSync(socket, { force: true }); } catch {}
  // Bound under a hidden name beside it, then moved to its own: macOS never tells a folder's watch
  // of a socket bound in it, only of a rename, so what waits for this agent hears of it.
  const bound = path.join(path.dirname(socket), `.${crypto.randomBytes(6).toString("base64url")}`);
  // Yours alone from the moment its file is there (it's bound as listen is called).
  const old = process.umask(0o177);
  try {
    server.listen(bound);
  } finally {
    process.umask(old);
  }
  // (Not bound, the server says why in `error`.)
  try { fs.renameSync(bound, socket); } catch {}
  server.unref();
  return server;
}
