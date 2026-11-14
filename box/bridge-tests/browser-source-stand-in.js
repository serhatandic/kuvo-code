// Google's Chrome for Testing and Rocky Linux's packages, as stand-ins a test serves itself: the
// box's browser setup (box/src/link/browser) downloads from them in a test's folder
// (`KUVO_BROWSER_SOURCE`, `KUVO_BROWSER_PINS`), never from the real ones. With what a test needs to
// make them: zips, RPMs (their files as cpio, in xz), and pins naming them by their checksums.
import crypto from "node:crypto";
import http from "node:http";
import zlib from "node:zlib";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const u32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
};

/** A zip of `entries`: `{name, data?, mode?, link?, deflate?}`, as Unix's zip makes them (a folder
 * by its name's slash, a link by `link`, its target). */
export function makeZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const isFolder = entry.name.endsWith("/");
    const data = entry.link !== undefined ? Buffer.from(entry.link) : Buffer.from(entry.data ?? "");
    const mode = entry.link !== undefined ? 0o120777 : isFolder ? 0o040755 : 0o100000 | (entry.mode ?? 0o644);
    const method = entry.deflate && !isFolder && entry.link === undefined ? 8 : 0;
    const stored = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.claimedSize ?? stored.length, 18);
    local.writeUInt32LE(entry.claimedSize ?? data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(stored.length, 20);
    record.writeUInt32LE(entry.claimedSize ?? data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += 30 + name.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const varint = (value) => {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
};

/** `data` as an .xz stream: one block of LZMA2's uncompressed chunks, its check SHA-256. */
export function makeXz(data) {
  const flags = Buffer.from([0x00, 0x0a]);
  const streamHeader = Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), flags, u32(crc32(flags))]);
  const blockHeaderBody = Buffer.from([0x02, 0x00, 0x21, 0x01, 0x16, 0, 0, 0]);
  const blockHeader = Buffer.concat([blockHeaderBody, u32(crc32(blockHeaderBody))]);
  const chunks = [];
  for (let at = 0, first = true; at < data.length || first; at += 65536, first = false) {
    const piece = data.subarray(at, at + 65536);
    if (!piece.length) break;
    chunks.push(Buffer.from([first ? 0x01 : 0x02, (piece.length - 1) >> 8, (piece.length - 1) & 0xff]), piece);
  }
  chunks.push(Buffer.from([0x00]));
  const compressed = Buffer.concat(chunks);
  const unpadded = blockHeader.length + compressed.length;
  const padding = Buffer.alloc((4 - (unpadded % 4)) % 4);
  const check = crypto.createHash("sha256").update(data).digest();
  const indexBody = Buffer.concat([Buffer.from([0x00]), varint(1), varint(unpadded + check.length), varint(data.length)]);
  const index = Buffer.concat([indexBody, Buffer.alloc((4 - (indexBody.length % 4)) % 4)]);
  const indexWhole = Buffer.concat([index, u32(crc32(index))]);
  const footerBody = Buffer.concat([u32(indexWhole.length / 4 - 1), flags]);
  const footer = Buffer.concat([u32(crc32(footerBody)), footerBody, Buffer.from("YZ")]);
  return Buffer.concat([streamHeader, blockHeader, compressed, padding, check, indexWhole, footer]);
}

/** A cpio archive ("newc") of `files`: `{name, data?, mode?, link?}`. */
export function makeCpio(files) {
  const parts = [];
  const pad = (length) => Buffer.alloc((4 - (length % 4)) % 4);
  const one = (name, mode, data, ino) => {
    const nameBytes = Buffer.concat([Buffer.from(name), Buffer.from([0])]);
    const fields = [ino, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, nameBytes.length, 0];
    const header = Buffer.from("070701" + fields.map((field) => field.toString(16).padStart(8, "0")).join(""));
    parts.push(header, nameBytes, pad(header.length + nameBytes.length), data, pad(data.length));
  };
  files.forEach((file, i) => one(file.name, file.link !== undefined ? 0o120777 : 0o100000 | (file.mode ?? 0o644), Buffer.from(file.link ?? file.data ?? ""), i + 1));
  one("TRAILER!!!", 0, Buffer.alloc(0), 0);
  return Buffer.concat(parts);
}

/** An RPM of `files`, as Rocky Linux's: its files as cpio, in xz (or `payload`, as it is). */
export function makeRpm(files, { payload } = {}) {
  const lead = Buffer.alloc(96);
  lead.writeUInt32BE(0xedabeedb, 0);
  lead[4] = 3;
  lead.writeUInt16BE(5, 78);
  const emptyHeader = Buffer.concat([Buffer.from([0x8e, 0xad, 0xe8, 0x01, 0, 0, 0, 0]), Buffer.alloc(8)]);
  const store = Buffer.from("cpio\0xz\0");
  const entry = (tag, offset) => {
    const b = Buffer.alloc(16);
    b.writeUInt32BE(tag, 0);
    b.writeUInt32BE(6, 4);
    b.writeUInt32BE(offset, 8);
    b.writeUInt32BE(1, 12);
    return b;
  };
  const counts = Buffer.alloc(8);
  counts.writeUInt32BE(2, 0);
  counts.writeUInt32BE(store.length, 4);
  const main = Buffer.concat([Buffer.from([0x8e, 0xad, 0xe8, 0x01, 0, 0, 0, 0]), counts, entry(1124, 0), entry(1125, 5), store]);
  return Buffer.concat([lead, emptyHeader, main, payload ?? makeXz(makeCpio(files))]);
}

/** Pins for `{linux?, darwin?}`: each `{version, x86_64: zip, aarch64: zip, packages?: {kind: [{name, rpm}]}}`,
 * named and checked as the real ones are. */
export function makePins(systems) {
  const pins = {};
  for (const [system, given] of Object.entries(systems)) {
    const platform = system === "linux" ? { x86_64: "linux64/chrome-linux64.zip", aarch64: "linux-arm64/chrome-linux-arm64.zip" } : { x86_64: "mac-x64/chrome-mac-x64.zip", aarch64: "mac-arm64/chrome-mac-arm64.zip" };
    const chromium = { version: given.version };
    for (const kind of ["x86_64", "aarch64"]) {
      chromium[kind] = { url: `https://storage.googleapis.com/chrome-for-testing-public/${given.version}/${platform[kind]}`, sha256: sha256(given[kind]), size: given[kind].length };
    }
    pins[system] = { chromium };
    if (given.packages) {
      pins[system].packages = {};
      for (const [kind, list] of Object.entries(given.packages)) {
        pins[system].packages[kind] = list.map(({ name, rpm, repo = "BaseOS" }) => ({ name, version: "1-1.el8", repo, path: `Packages/${name[0]}/${name}-1-1.el8.${kind}.rpm`, sha256: sha256(rpm), size: rpm.length }));
      }
    }
  }
  return pins;
}

/** Each file a set of pins names, by its address, from what they were made of. */
export function served(systems) {
  const pins = makePins(systems);
  const files = new Map();
  for (const [system, given] of Object.entries(systems)) {
    for (const kind of ["x86_64", "aarch64"]) files.set(pins[system].chromium[kind].url, given[kind]);
    for (const [kind, list] of Object.entries(given.packages ?? {})) {
      list.forEach(({ rpm }, i) => files.set(`https://dl.rockylinux.org/pub/rocky/8/${pins[system].packages[kind][i].repo}/${kind}/os/${pins[system].packages[kind][i].path}`, rpm));
    }
  }
  return { pins, files };
}

/** Serves `files` (a Map of real addresses to bytes) at `<host>/<path>`, as `KUVO_BROWSER_SOURCE`
 * names it. `asked` lists what was asked for; `answer(address)` may answer otherwise first
 * (`{status, body, slow}`: half the body, the rest `slow` ms later). */
export async function startSource(files, answer = () => null) {
  const asked = [];
  const server = http.createServer((request, response) => {
    const address = `https://${request.url.slice(1)}`;
    asked.push(address);
    const instead = answer(address);
    if (instead?.slow) {
      // Half now, the rest `slow` ms later.
      const body = Buffer.from(instead.body ?? "");
      response.writeHead(instead.status, { "content-length": body.length });
      response.write(body.subarray(0, body.length >> 1));
      const timer = setTimeout(() => response.end(body.subarray(body.length >> 1)), instead.slow);
      response.on("close", () => clearTimeout(timer));
      return;
    }
    if (instead) {
      response.writeHead(instead.status, instead.headers ?? {});
      return response.end(instead.body ?? "");
    }
    const data = files.get(address);
    if (!data) {
      response.writeHead(404);
      return response.end();
    }
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
    response.end(data);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, close: () => new Promise((resolve) => server.close(resolve)) };
}
