// What the browser takes from Rocky Linux's packages (PROTOCOL.md, "The browser on a machine"): read
// here, as a machine has no `rpm` or `cpio` to read them with. A package is its lead, its signature's
// header, its own header, then its files, as a cpio archive ("newc"), compressed (xz, or gzip).

import zlib from "node:zlib";
import { unxz } from "./xz";

const HEADER_MAGIC = Buffer.from([0x8e, 0xad, 0xe8, 0x01]);
const PAYLOAD_FORMAT = 1124;
const PAYLOAD_COMPRESSOR = 1125;

class PackageError extends Error {}
const damaged = (why: string): never => { throw new PackageError(`The package isn't one the browser can use (${why}).`); };

/** A header's string tags, by tag, and where the header ends. */
function header(data: Buffer, at: number): { strings: Map<number, string>; end: number } {
  if (at + 16 > data.length || !data.subarray(at, at + 4).equals(HEADER_MAGIC)) damaged("its header");
  const count = data.readUInt32BE(at + 8), size = data.readUInt32BE(at + 12);
  const store = at + 16 + count * 16, end = store + size;
  if (count > 100_000 || end > data.length) damaged("its header");
  const strings = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const entry = at + 16 + i * 16;
    const tag = data.readUInt32BE(entry), type = data.readUInt32BE(entry + 4), offset = data.readUInt32BE(entry + 8);
    // (STRING: one, ending in a zero byte.)
    if (type !== 6 || offset >= size) continue;
    const from = store + offset, zero = data.indexOf(0, from);
    if (zero < 0 || zero >= end) damaged("its header");
    strings.set(tag, data.toString("utf8", from, zero));
  }
  return { strings, end };
}

/** A package's files, as its cpio archive has them, decompressed. */
export function payload(data: Buffer): Buffer {
  if (data.length < 96 || data.readUInt32BE(0) !== 0xedabeedb) damaged("it isn't a package");
  const signature = header(data, 96);
  // (The signature's header is padded to a multiple of 8.)
  const main = header(data, signature.end + ((8 - (signature.end % 8)) % 8));
  const format = main.strings.get(PAYLOAD_FORMAT) ?? "cpio";
  if (format !== "cpio") damaged(`files as ${format}`);
  const compressor = main.strings.get(PAYLOAD_COMPRESSOR) ?? "gzip";
  const compressed = data.subarray(main.end);
  if (compressor === "xz") return unxz(compressed);
  if (compressor === "gzip") return zlib.gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 });
  return damaged(`files compressed with ${compressor}`);
}

export interface ArchiveEntry {
  /** Its path, as the archive names it ("./usr/lib64/libX11.so.6"). */
  name: string;
  /** Its type and permissions, as `stat` says them. */
  mode: number;
  /** A file's contents; a link's, where it points. */
  data: Buffer;
}

const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

/** Each file and link in a cpio archive ("newc"), with a file linked under more than one name given
 * its contents under each (the archive keeps them with the last). */
export function cpioEntries(archive: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const linked = new Map<string, ArchiveEntry[]>();
  let at = 0;
  const field = (index: number): number => {
    const text = archive.toString("latin1", at + 6 + index * 8, at + 14 + index * 8);
    if (!/^[0-9a-fA-F]{8}$/.test(text)) damaged("its files");
    return parseInt(text, 16);
  };
  while (true) {
    if (at + 110 > archive.length) damaged("its files end early");
    const magic = archive.toString("latin1", at, at + 6);
    if (magic !== "070701" && magic !== "070702") damaged("its files");
    const ino = field(0), mode = field(1), links = field(4), size = field(6), nameSize = field(11);
    const nameStart = at + 110;
    if (nameSize < 1 || nameStart + nameSize > archive.length) damaged("its files");
    const name = archive.toString("utf8", nameStart, nameStart + nameSize - 1);
    const dataStart = nameStart + nameSize + ((4 - ((110 + nameSize) % 4)) % 4);
    if (dataStart + size > archive.length) damaged("its files end early");
    if (name === "TRAILER!!!") break;
    const data = archive.subarray(dataStart, dataStart + size);
    const type = mode & S_IFMT;
    if (type === S_IFREG || type === S_IFLNK) {
      const entry = { name, mode, data };
      entries.push(entry);
      if (type === S_IFREG && links > 1) {
        const key = `${field(7)}:${field(8)}:${ino}`;
        const same = [...(linked.get(key) ?? []), entry];
        linked.set(key, same);
        const full = same.find(each => each.data.length > 0);
        if (full) for (const each of same) each.data = full.data;
      }
    }
    at = dataStart + size + ((4 - (size % 4)) % 4);
  }
  return entries;
}
