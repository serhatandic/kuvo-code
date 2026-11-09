// xz, as Rocky Linux's packages compress what's in them: decoded here, as a machine may have no `xz`
// (PROTOCOL.md, "The browser on a machine"). Only what that needs: one stream of blocks, each LZMA2
// with no other filter, its check (CRC32, CRC64 or SHA-256) verified. Anything else throws.

import crypto from "node:crypto";

const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const LZMA2 = 0x21;

class XzError extends Error {}
const corrupt = (why: string): never => { throw new XzError(`The package's contents are damaged (${why}).`); };

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32, as xz and zip have it. */
export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// CRC64 (ECMA-182, reflected), in two 32-bit halves.
const CRC64_TABLE = (() => {
  const low = new Uint32Array(256), high = new Uint32Array(256);
  const polyLow = 0xd7870f42, polyHigh = 0xc96c5795;
  for (let n = 0; n < 256; n++) {
    let l = n, h = 0;
    for (let k = 0; k < 8; k++) {
      const carry = l & 1;
      l = ((l >>> 1) | ((h & 1) << 31)) >>> 0;
      h = h >>> 1;
      if (carry) { l = (l ^ polyLow) >>> 0; h = (h ^ polyHigh) >>> 0; }
    }
    low[n] = l;
    high[n] = h;
  }
  return { low, high };
})();

function crc64(data: Uint8Array, start: number, end: number): Buffer {
  let l = 0xffffffff, h = 0xffffffff;
  for (let i = start; i < end; i++) {
    const index = (l ^ data[i]) & 0xff;
    l = (((l >>> 8) | ((h & 0xff) << 24)) ^ CRC64_TABLE.low[index]) >>> 0;
    h = ((h >>> 8) ^ CRC64_TABLE.high[index]) >>> 0;
  }
  const out = Buffer.alloc(8);
  out.writeUInt32LE((l ^ 0xffffffff) >>> 0, 0);
  out.writeUInt32LE((h ^ 0xffffffff) >>> 0, 4);
  return out;
}

/** What the decoded bytes go into, growing as they come: also the dictionary matches copy from. */
class Output {
  buffer: Uint8Array;
  length = 0;
  constructor(size: number) {
    this.buffer = new Uint8Array(Math.max(size, 1024));
  }
  room(more: number, most: number): void {
    const needed = this.length + more;
    if (needed > most) corrupt("it's larger than it can be");
    if (needed <= this.buffer.length) return;
    const grown = new Uint8Array(Math.min(most, Math.max(needed, this.buffer.length * 2)));
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }
}

class RangeDecoder {
  range = 0;
  code = 0;
  constructor(private input: Uint8Array, public at: number, private end: number) {
    if (end - at < 5 || input[at] !== 0) corrupt("a range coder's start");
    this.range = 0xffffffff;
    this.code = ((input[at + 1] << 24) | (input[at + 2] << 16) | (input[at + 3] << 8) | input[at + 4]) >>> 0;
    this.at += 5;
    if (this.code === this.range) corrupt("a range coder's start");
  }
  private next(): number {
    if (this.at >= this.end) corrupt("it ends early");
    return this.input[this.at++];
  }
  private normalize(): void {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.next()) >>> 0;
    }
  }
  bit(probs: Uint16Array, index: number): number {
    const p = probs[index];
    const bound = (this.range >>> 11) * p;
    if (this.code < bound) {
      this.range = bound;
      probs[index] = p + ((2048 - p) >>> 5);
      this.normalize();
      return 0;
    }
    this.range -= bound;
    this.code -= bound;
    probs[index] = p - (p >>> 5);
    this.normalize();
    return 1;
  }
  direct(count: number): number {
    let result = 0;
    for (let i = 0; i < count; i++) {
      this.range = this.range >>> 1;
      let bit = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        bit = 1;
      }
      result = result * 2 + bit;
      this.normalize();
    }
    return result;
  }
  tree(probs: Uint16Array, base: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) + this.bit(probs, base + m);
    return m - (1 << bits);
  }
  reverse(probs: Uint16Array, base: number, bits: number): number {
    let m = 1, symbol = 0;
    for (let i = 0; i < bits; i++) {
      const bit = this.bit(probs, base + m);
      m = (m << 1) + bit;
      symbol |= bit << i;
    }
    return symbol;
  }
}

const STATES = 12;
const POS_STATES_MAX = 16;
const LEN_PROBS = 2 + POS_STATES_MAX * 8 * 2 + 256;

/** LZMA's state between the chunks of an LZMA2 block: its probabilities, state and last distances. */
class Lzma {
  lc = 0;
  lp = 0;
  pb = 0;
  literal = new Uint16Array(0);
  isMatch = new Uint16Array(STATES * POS_STATES_MAX);
  isRep = new Uint16Array(STATES);
  isRepG0 = new Uint16Array(STATES);
  isRepG1 = new Uint16Array(STATES);
  isRepG2 = new Uint16Array(STATES);
  isRep0Long = new Uint16Array(STATES * POS_STATES_MAX);
  posSlot = new Uint16Array(4 * 64);
  posDecoders = new Uint16Array(115);
  align = new Uint16Array(16);
  length = new Uint16Array(LEN_PROBS);
  repLength = new Uint16Array(LEN_PROBS);
  state = 0;
  reps = [0, 0, 0, 0];

  properties(byte: number): void {
    if (byte > 224) corrupt("its properties");
    this.lc = byte % 9;
    const rest = Math.floor(byte / 9);
    this.lp = rest % 5;
    this.pb = Math.floor(rest / 5);
    if (this.lc + this.lp > 4) corrupt("its properties");
    this.literal = new Uint16Array(0x300 << (this.lc + this.lp));
  }

  reset(): void {
    for (const probs of [this.literal, this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long, this.posSlot, this.posDecoders, this.align, this.length, this.repLength]) probs.fill(1024);
    this.state = 0;
    this.reps = [0, 0, 0, 0];
  }

  private len(rc: RangeDecoder, probs: Uint16Array, posState: number): number {
    if (rc.bit(probs, 0) === 0) return rc.tree(probs, 2 + (posState << 3), 3);
    if (rc.bit(probs, 1) === 0) return 8 + rc.tree(probs, 2 + POS_STATES_MAX * 8 + (posState << 3), 3);
    return 16 + rc.tree(probs, 2 + POS_STATES_MAX * 8 * 2, 8);
  }

  private distance(rc: RangeDecoder, len: number): number {
    const slot = rc.tree(this.posSlot, Math.min(len, 3) << 6, 6);
    if (slot < 4) return slot;
    const direct = (slot >>> 1) - 1;
    let distance = (2 | (slot & 1)) * 2 ** direct;
    if (slot < 14) return distance + rc.reverse(this.posDecoders, distance - slot, direct);
    distance += rc.direct(direct - 4) * 16;
    return distance + rc.reverse(this.align, 0, 4);
  }

  /** Decodes into `out` up to `end`, the chunk's last byte, from `start`, where the dictionary began. */
  decode(rc: RangeDecoder, out: Output, end: number, start: number): void {
    const buffer = out.buffer;
    const pbMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1;
    let at = out.length, state = this.state;
    let [rep0, rep1, rep2, rep3] = this.reps;
    while (at < end) {
      const pos = at - start;
      const posState = pos & pbMask;
      if (rc.bit(this.isMatch, (state << 4) + posState) === 0) {
        const previous = pos > 0 ? buffer[at - 1] : 0;
        const base = 0x300 * (((pos & lpMask) << this.lc) + (previous >>> (8 - this.lc)));
        let symbol = 1;
        if (state >= 7) {
          if (rep0 >= pos) corrupt("a distance");
          let match = buffer[at - rep0 - 1];
          do {
            const matchBit = (match >>> 7) & 1;
            match <<= 1;
            const bit = rc.bit(this.literal, base + ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) | bit;
            if (matchBit !== bit) break;
          } while (symbol < 0x100);
        }
        while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(this.literal, base + symbol);
        buffer[at++] = symbol - 0x100;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let len: number;
      if (rc.bit(this.isRep, state) !== 0) {
        if (pos === 0) corrupt("a distance");
        if (rc.bit(this.isRepG0, state) === 0) {
          if (rc.bit(this.isRep0Long, (state << 4) + posState) === 0) {
            if (rep0 >= pos) corrupt("a distance");
            state = state < 7 ? 9 : 11;
            buffer[at] = buffer[at - rep0 - 1];
            at++;
            continue;
          }
        } else {
          let distance: number;
          if (rc.bit(this.isRepG1, state) === 0) {
            distance = rep1;
          } else {
            if (rc.bit(this.isRepG2, state) === 0) {
              distance = rep2;
            } else {
              distance = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = distance;
        }
        len = this.len(rc, this.repLength, posState);
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        len = this.len(rc, this.length, posState);
        state = state < 7 ? 7 : 10;
        rep0 = this.distance(rc, len);
        if (rep0 === 0xffffffff) corrupt("an end marker in LZMA2");
      }
      len += 2;
      if (rep0 >= pos) corrupt("a distance");
      if (at + len > end) corrupt("a match past its chunk");
      for (let i = 0; i < len; i++, at++) buffer[at] = buffer[at - rep0 - 1];
    }
    out.length = at;
    this.state = state;
    this.reps = [rep0, rep1, rep2, rep3];
  }
}

/** xz's variable-length integer at `at`: its value and the bytes after it. */
function varint(input: Uint8Array, at: number, end: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 9; i++) {
    if (at >= end) corrupt("a block's header");
    const byte = input[at++];
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) {
      if (byte === 0 && i > 0) corrupt("a block's header");
      return [value, at];
    }
  }
  return corrupt("a block's header");
}

const CHECK_SIZES: Record<number, number> = { 0: 0, 1: 4, 4: 8, 10: 32 };

/** What an .xz stream holds, at most `most` bytes of it. */
export function unxz(input: Uint8Array, most = 512 * 1024 * 1024): Buffer {
  if (input.length < 24 || MAGIC.some((byte, i) => input[i] !== byte)) corrupt("it isn't xz");
  if (input[6] !== 0 || (input[7] & 0xf0) !== 0) corrupt("its flags");
  const view = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (crc32(input, 6, 8) !== view.readUInt32LE(8)) corrupt("its header");
  const check = input[7];
  const checkSize = CHECK_SIZES[check];
  if (checkSize === undefined) corrupt("a check it doesn't know");
  const out = new Output(Math.min(most, input.length * 4));
  let at = 12;
  while (true) {
    if (at >= input.length) corrupt("it ends early");
    // The index follows the last block.
    if (input[at] === 0) break;
    const blockStart = at, headerSize = (input[at] + 1) * 4;
    if (at + headerSize > input.length) corrupt("it ends early");
    if (crc32(input, at, at + headerSize - 4) !== view.readUInt32LE(at + headerSize - 4)) corrupt("a block's header");
    const flags = input[at + 1];
    if (flags & 0x3c) corrupt("a block's header");
    if ((flags & 3) !== 0) corrupt("a filter it doesn't know");
    let p = at + 2;
    const headerEnd = at + headerSize - 4;
    let packed: number | null = null, unpacked: number | null = null;
    if (flags & 0x40) [packed, p] = varint(input, p, headerEnd);
    if (flags & 0x80) [unpacked, p] = varint(input, p, headerEnd);
    let filter: number, size: number;
    [filter, p] = varint(input, p, headerEnd);
    [size, p] = varint(input, p, headerEnd);
    if (filter !== LZMA2 || size !== 1 || p >= headerEnd) corrupt("a filter it doesn't know");
    if (input[p] > 40) corrupt("its dictionary's size");
    p++;
    for (; p < headerEnd; p++) if (input[p] !== 0) corrupt("a block's header");
    at += headerSize;

    const dataStart = at, outStart = out.length;
    const lzma = new Lzma();
    let start = out.length, haveDictionary = false, haveProperties = false, needState = true;
    while (true) {
      if (at >= input.length) corrupt("it ends early");
      const control = input[at++];
      if (control === 0) break;
      if (control === 1 || control === 2) {
        if (at + 2 > input.length) corrupt("it ends early");
        if (control === 1) {
          start = out.length;
          haveDictionary = true;
          // (The next LZMA chunk starts over: new properties, and its state.)
          haveProperties = false;
          needState = true;
        } else if (!haveDictionary) corrupt("a chunk before its dictionary");
        const size = ((input[at] << 8) | input[at + 1]) + 1;
        at += 2;
        if (at + size > input.length) corrupt("it ends early");
        out.room(size, most);
        out.buffer.set(input.subarray(at, at + size), out.length);
        out.length += size;
        at += size;
        continue;
      }
      if (control < 0x80) corrupt("a chunk it doesn't know");
      if (at + 4 > input.length) corrupt("it ends early");
      const size = ((control & 0x1f) << 16) + ((input[at] << 8) | input[at + 1]) + 1;
      const compressed = ((input[at + 2] << 8) | input[at + 3]) + 1;
      at += 4;
      const reset = (control >>> 5) & 3;
      if (reset === 3) {
        start = out.length;
        haveDictionary = true;
      } else if (!haveDictionary) corrupt("a chunk before its dictionary");
      if (reset >= 2) {
        if (at >= input.length) corrupt("it ends early");
        lzma.properties(input[at++]);
        haveProperties = true;
      } else if (!haveProperties) corrupt("a chunk before its properties");
      if (reset >= 1) {
        lzma.reset();
        needState = false;
      } else if (needState) corrupt("a chunk before its state");
      if (at + compressed > input.length) corrupt("it ends early");
      out.room(size, most);
      const rc = new RangeDecoder(input, at, at + compressed);
      lzma.decode(rc, out, out.length + size, start);
      if (rc.at !== at + compressed) corrupt("a chunk's size");
      at += compressed;
    }
    if (packed !== null && at - dataStart !== packed) corrupt("a block's size");
    if (unpacked !== null && out.length - outStart !== unpacked) corrupt("a block's size");
    while ((at - blockStart) % 4) {
      if (input[at++] !== 0) corrupt("a block's padding");
    }
    if (at + checkSize > input.length) corrupt("it ends early");
    const given = view.subarray(at, at + checkSize);
    const content = out.buffer;
    if (check === 1 && crc32(content, outStart, out.length) !== given.readUInt32LE(0)) corrupt("its check");
    if (check === 4 && !crc64(content, outStart, out.length).equals(given)) corrupt("its check");
    if (check === 10 && !crypto.createHash("sha256").update(content.subarray(outStart, out.length)).digest().equals(given)) corrupt("its check");
    at += checkSize;
  }
  return Buffer.from(out.buffer.buffer, out.buffer.byteOffset, out.length);
}
