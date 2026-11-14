// Chrome for Testing comes as a zip (PROTOCOL.md, "The browser on a machine"): unpacked here, as a
// machine may have no `unzip`. Only into the folder it's given: a name that would leave it (`..`, a
// whole path), or go through a link, throws, and a link may only point inside it. Files keep their
// permissions to run, never more (no set-user-ID, nothing others can write).

import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import zlib from "node:zlib";

class ZipError extends Error {}
const refused = (why: string): never => { throw new ZipError(`The browser's download can't be unpacked (${why}).`); };

interface Entry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
  mode: number;
}

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000, S_IFREG = 0o100000;

function read(fd: number, at: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const got = fs.readSync(fd, buffer, done, length - done, at + done);
    if (got === 0) refused("it ends early");
    done += got;
  }
  return buffer;
}

/** The archive's entries, from its central directory. */
function entries(fd: number, fileSize: number): Entry[] {
  const tailSize = Math.min(fileSize, 22 + 0xffff);
  const tail = read(fd, fileSize - tailSize, tailSize);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) refused("it isn't a zip");
  let count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryAt = tail.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) {
    // Zip64: its own end record, which a locator just before this one points to.
    const locatorAt = fileSize - tailSize + end - 20;
    if (locatorAt < 0) refused("its zip64 records");
    const locator = read(fd, locatorAt, 20);
    if (locator.readUInt32LE(0) !== 0x07064b50) refused("its zip64 records");
    const record = read(fd, Number(locator.readBigUInt64LE(8)), 56);
    if (record.readUInt32LE(0) !== 0x06064b50) refused("its zip64 records");
    count = Number(record.readBigUInt64LE(32));
    directorySize = Number(record.readBigUInt64LE(40));
    directoryAt = Number(record.readBigUInt64LE(48));
  }
  if (directoryAt + directorySize > fileSize || count > 200_000) refused("its directory");
  const directory = read(fd, directoryAt, directorySize);
  const found: Entry[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) refused("its directory");
    const madeBy = directory.readUInt16LE(at + 4) >>> 8;
    const flags = directory.readUInt16LE(at + 8), method = directory.readUInt16LE(at + 10);
    let compressed = directory.readUInt32LE(at + 20), size = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28), extraLength = directory.readUInt16LE(at + 30), commentLength = directory.readUInt16LE(at + 32);
    const attributes = directory.readUInt32LE(at + 38);
    let offset = directory.readUInt32LE(at + 42);
    if (at + 46 + nameLength + extraLength + commentLength > directory.length) refused("its directory");
    const nameBytes = directory.subarray(at + 46, at + 46 + nameLength);
    const name = nameBytes.toString("utf8");
    if (flags & 1) refused("it's encrypted");
    // Zip64's sizes and offset, for those too large for their places.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extra), length = directory.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let p = extra + 4;
        const next = (): number => {
          if (p + 8 > extra + 4 + length) refused("its zip64 records");
          const value = Number(directory.readBigUInt64LE(p));
          p += 8;
          return value;
        };
        if (size === 0xffffffff) size = next();
        if (compressed === 0xffffffff) compressed = next();
        if (offset === 0xffffffff) offset = next();
      }
      extra += 4 + length;
    }
    // Unix's type and permissions where it says them (made on Unix); else a folder by its slash.
    let mode = madeBy === 3 ? attributes >>> 16 : 0;
    if (!(mode & S_IFMT)) mode = (name.endsWith("/") ? S_IFDIR | 0o755 : S_IFREG | 0o644) | (mode & 0o777);
    found.push({ name, method, compressed, size, offset, mode });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

/** An entry's path's parts, refused if it would leave the folder. */
function parts(name: string): string[] {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/")) refused(`a name, ${JSON.stringify(name)}`);
  const each = name.replace(/\/$/, "").split("/");
  if (each.some(part => !part || part === "." || part === "..")) refused(`a name, ${JSON.stringify(name)}`);
  return each;
}

/** Makes the folders on the way to `parts` (none of them a link), in `root`. */
function folderFor(root: string, given: string[]): string {
  let folder = root;
  for (const part of given) {
    folder = path.join(folder, part);
    let stat: fs.Stats | null = null;
    try { stat = fs.lstatSync(folder); } catch {}
    if (!stat) fs.mkdirSync(folder, { mode: 0o755 });
    else if (!stat.isDirectory()) refused(`a name goes through ${JSON.stringify(part)}, which isn't a folder`);
  }
  return folder;
}

/** Counts what goes through, and stops past `most`. */
function counted(most: number, seen: { bytes: number }): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen.bytes += chunk.length;
      if (seen.bytes > most) return done(new ZipError("The browser's download can't be unpacked (a file is larger than it says)."));
      done(null, chunk);
    },
  });
}

/** Unpacks the zip at `file` into `root` (a new, empty folder). */
export async function unzip(file: string, root: string): Promise<void> {
  const fd = fs.openSync(file, "r");
  try {
    const all = entries(fd, fs.fstatSync(fd).size);
    // Folders and files first, links last: nothing is written through one.
    const links: Entry[] = [];
    for (const entry of all) {
      const given = parts(entry.name);
      const type = entry.mode & S_IFMT;
      if (type === S_IFDIR) {
        folderFor(root, given);
        continue;
      }
      if (type === S_IFLNK) {
        links.push(entry);
        continue;
      }
      if (type !== S_IFREG) refused(`${JSON.stringify(entry.name)} isn't a file`);
      if (entry.method !== 0 && entry.method !== 8) refused(`${JSON.stringify(entry.name)} is compressed in a way it doesn't know`);
      const local = read(fd, entry.offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) refused("a file's header");
      const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const target = path.join(folderFor(root, given.slice(0, -1)), given[given.length - 1]);
      // Never over what's there (a name given twice, or through a link).
      const out = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      const seen = { bytes: 0 };
      try {
        const input = entry.compressed > 0 ? fs.createReadStream("", { fd, start, end: start + entry.compressed - 1, autoClose: false }) : null;
        const output = fs.createWriteStream("", { fd: out, autoClose: false });
        if (input) {
          if (entry.method === 8) await pipeline(input, zlib.createInflateRaw(), counted(entry.size, seen), output);
          else await pipeline(input, counted(entry.size, seen), output);
        }
      } finally {
        fs.closeSync(out);
      }
      if (seen.bytes !== entry.size) refused(`${JSON.stringify(entry.name)} isn't the size it says`);
      fs.chmodSync(target, (entry.mode & 0o755) | 0o600);
    }
    for (const entry of links) {
      const given = parts(entry.name);
      if (entry.method !== 0 || entry.size > 4096 || entry.compressed !== entry.size) refused(`the link ${JSON.stringify(entry.name)}`);
      const local = read(fd, entry.offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) refused("a file's header");
      const pointsTo = read(fd, entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), entry.size).toString("utf8");
      // Only to somewhere inside: relative, and never above the folder.
      if (!pointsTo || pointsTo.includes("\0") || pointsTo.startsWith("/")) refused(`the link ${JSON.stringify(entry.name)}`);
      const resolved = path.posix.normalize(path.posix.join(...given.slice(0, -1), pointsTo));
      if (resolved === ".." || resolved.startsWith("../")) refused(`the link ${JSON.stringify(entry.name)} points outside it`);
      const folder = folderFor(root, given.slice(0, -1));
      fs.symlinkSync(pointsTo, path.join(folder, given[given.length - 1]));
    }
    // And where each link leads once they're all there (one through another), inside too.
    const real = fs.realpathSync(root);
    for (const entry of links) {
      let leads = "";
      try { leads = fs.realpathSync(path.join(root, ...parts(entry.name))); } catch {}
      if (!leads.startsWith(real + path.sep)) refused(`the link ${JSON.stringify(entry.name)} points outside it`);
    }
  } finally {
    fs.closeSync(fd);
  }
}
