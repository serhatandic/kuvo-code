// Noise: IK for sessions, K for mail, with X25519, AES-GCM and SHA-256 (PROTOCOL.md, "Sessions"
// and "Mail"), held to protocol/vectors/noise.json as the Swift side is.

import crypto from "node:crypto";
import { dh, EMPTY, newKey, publicOf } from "./keys";

const sha256 = (data: Buffer) => crypto.createHash("sha256").update(data).digest();
const hmac = (key: Buffer, data: Buffer) => crypto.createHmac("sha256", key).update(data).digest();
function hkdf(chainingKey: Buffer, input: Buffer): [Buffer, Buffer] {
  const temp = hmac(chainingKey, input);
  const first = hmac(temp, Buffer.from([1]));
  return [first, hmac(temp, Buffer.concat([first, Buffer.from([2])]))];
}

/** One direction's key and count; without a key (before the first mixKey) it passes bytes as they are. */
export class CipherState {
  declare key: Buffer | undefined;
  declare n: bigint;

  constructor(key?: Buffer) {
    this.key = key;
    this.n = 0n;
  }

  nonce() {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(this.n, 4);
    return nonce;
  }

  encrypt(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.key) return plaintext;
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, this.nonce());
    cipher.setAAD(ad);
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    this.n += 1n;
    return sealed;
  }

  decrypt(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.key) return ciphertext;
    if (ciphertext.length < 16) throw new Error("decrypt");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, this.nonce());
    decipher.setAAD(ad);
    decipher.setAuthTag(ciphertext.subarray(-16));
    let plaintext;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    } catch {
      throw new Error("decrypt");
    }
    this.n += 1n;
    return plaintext;
  }
}

class SymmetricState {
  declare h: Buffer;
  declare ck: Buffer;
  declare cipher: CipherState;

  constructor(name: string, prologue: Buffer) {
    const bytes = Buffer.from(name);
    this.h = bytes.length <= 32 ? Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]) : sha256(bytes);
    this.ck = this.h;
    this.cipher = new CipherState();
    this.mixHash(prologue);
  }

  mixKey(input: Buffer) {
    const [chainingKey, key] = hkdf(this.ck, input);
    this.ck = chainingKey;
    this.cipher = new CipherState(key);
  }

  mixHash(data: Buffer) {
    this.h = sha256(Buffer.concat([this.h, data]));
  }

  encryptAndHash(plaintext: Buffer) {
    const ciphertext = this.cipher.encrypt(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Buffer) {
    const plaintext = this.cipher.decrypt(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.ck, EMPTY);
    return [new CipherState(first), new CipherState(second)];
  }
}

const IK = "Noise_IK_25519_AESGCM_SHA256";
const ONE_WAY = "Noise_K_25519_AESGCM_SHA256";
export const PROLOGUE = Buffer.from("kuvo-link v1");
export const MAIL_PROLOGUE = Buffer.from("kuvo-link mail v1");

/** A session's two directions, once its handshake is done. */
export interface Transport {
  hash: Buffer;
  seal: (plaintext: Buffer) => Buffer;
  open: (ciphertext: Buffer) => Buffer;
}

const transport = (sending: CipherState, receiving: CipherState, hash: Buffer): Transport => ({
  hash,
  seal: plaintext => sending.encrypt(EMPTY, plaintext),
  open: ciphertext => receiving.decrypt(EMPTY, ciphertext),
});

// The side that starts (the phone), knowing the other's static key. Here for tests.
export class IKInitiator {
  declare s: Buffer;
  declare rs: Buffer;
  declare e: Buffer;
  declare state: SymmetricState;

  constructor(s: Buffer, rs: Buffer, prologue: Buffer, e = newKey()) {
    Object.assign(this, { s, rs, e, state: new SymmetricState(IK, prologue) });
    this.state.mixHash(rs);
  }

  writeMessage1(payload: Buffer) {
    const state = this.state;
    const ephemeral = publicOf(this.e);
    state.mixHash(ephemeral);
    state.mixKey(dh(this.e, this.rs));
    const s = state.encryptAndHash(publicOf(this.s));
    state.mixKey(dh(this.s, this.rs));
    return Buffer.concat([ephemeral, s, state.encryptAndHash(payload)]);
  }

  readMessage2(message: Buffer) {
    if (message.length < 48) throw new Error("malformed");
    const state = this.state;
    const re = message.subarray(0, 32);
    state.mixHash(re);
    state.mixKey(dh(this.e, re));
    state.mixKey(dh(this.s, re));
    const payload = state.decryptAndHash(message.subarray(32));
    const [first, second] = state.split();
    return { payload, transport: transport(first, second, state.h) };
  }
}

// The side that answers (this machine), learning the phone's static key.
export class IKResponder {
  declare s: Buffer;
  declare e: Buffer;
  declare state: SymmetricState;
  /** The phone's ephemeral and static keys, once its first message is read. */
  declare re: Buffer;
  declare rs: Buffer;

  constructor(s: Buffer, prologue: Buffer, e = newKey()) {
    Object.assign(this, { s, e, state: new SymmetricState(IK, prologue) });
    this.state.mixHash(publicOf(s));
  }

  readMessage1(message: Buffer) {
    if (message.length < 96) throw new Error("malformed");
    const state = this.state;
    this.re = message.subarray(0, 32);
    state.mixHash(this.re);
    state.mixKey(dh(this.s, this.re));
    this.rs = state.decryptAndHash(message.subarray(32, 80));
    state.mixKey(dh(this.s, this.rs));
    return state.decryptAndHash(message.subarray(80));
  }

  writeMessage2(payload: Buffer) {
    const state = this.state;
    const ephemeral = publicOf(this.e);
    state.mixHash(ephemeral);
    state.mixKey(dh(this.e, this.re));
    state.mixKey(dh(this.e, this.rs));
    const message = Buffer.concat([ephemeral, state.encryptAndHash(payload)]);
    const [first, second] = state.split();
    return { message, transport: transport(second, first, state.h) };
  }
}

// One message to a device that knows the sender, for pushes.
export function sealOneWay(payload: Buffer, s: Buffer, rs: Buffer, prologue = MAIL_PROLOGUE, e = newKey()) {
  const state = new SymmetricState(ONE_WAY, prologue);
  state.mixHash(publicOf(s));
  state.mixHash(rs);
  const ephemeral = publicOf(e);
  state.mixHash(ephemeral);
  state.mixKey(dh(e, rs));
  state.mixKey(dh(s, rs));
  return { message: Buffer.concat([ephemeral, state.encryptAndHash(payload)]), following: state.split()[0] };
}

export function openOneWay(message: Buffer, s: Buffer, rs: Buffer, prologue = MAIL_PROLOGUE) {
  if (message.length < 48) throw new Error("malformed");
  const state = new SymmetricState(ONE_WAY, prologue);
  state.mixHash(rs);
  state.mixHash(publicOf(s));
  const re = message.subarray(0, 32);
  state.mixHash(re);
  state.mixKey(dh(s, re));
  state.mixKey(dh(s, rs));
  return { payload: state.decryptAndHash(message.subarray(32)), following: state.split()[0] };
}
