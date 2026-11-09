// What goes over the relay (PROTOCOL.md, "The relay"), the link frames inside it ("Link frames"),
// and the messages inside a session ("Messages in a session").

import { sortedJSON } from "../../shared/json";
import { EMPTY } from "../crypto/keys";
import { sendingTo } from "./dropped";

export const Frame = { handshake1: 1, handshake2: 2, transport: 3, close: 4, mail: 5 } as const;
export type FrameKind = (typeof Frame)[keyof typeof Frame];
const MAX_MESSAGE = 65535 - 16;

export const relayHello = (secret: Buffer) => Buffer.concat([Buffer.from([1]), secret]);
export const relaySend = (to: Buffer, payload: Buffer) => {
  sendingTo(to);
  return Buffer.concat([Buffer.from([2]), to, payload]);
};
export const relayPush = (to: Buffer, payload: Buffer) => Buffer.concat([Buffer.from([5]), to, payload]);

/** What the relay sends a device. */
export type RelayMessage =
  | { kind: "welcome"; address: Buffer }
  | { kind: "deliver"; address: Buffer; payload: Buffer }
  | { kind: "unreachable"; address: Buffer }
  | { kind: "pushed"; address: Buffer; status: number }
  | { kind: "gone"; address: Buffer; reason: "replaced" | "left" };

// What the relay sent, or null.
export function readRelay(bytes: Buffer): RelayMessage | null {
  const kind = bytes[0];
  const address = bytes.subarray(1, 17);
  if (kind === 1 && bytes.length === 17) return { kind: "welcome", address };
  if (kind === 2 && bytes.length >= 17) return { kind: "deliver", address, payload: bytes.subarray(17) };
  if (kind === 3 && bytes.length === 17) return { kind: "unreachable", address };
  if (kind === 6 && bytes.length === 18) return { kind: "pushed", address, status: bytes[17]! };
  // A reason it doesn't know yet counts as left: the sessions are over either way.
  if (kind === 7 && bytes.length === 18) return { kind: "gone", address, reason: bytes[17] === 0 ? "replaced" : "left" };
  return null;
}

export function frame(kind: FrameKind, session: number, body: Buffer = EMPTY) {
  const header = Buffer.alloc(5);
  header[0] = kind;
  header.writeUInt32BE(session, 1);
  return Buffer.concat([header, body]);
}

export function readFrame(bytes: Buffer): { kind: FrameKind; session: number; body: Buffer } | null {
  if (bytes.length < 5 || bytes[0]! < 1 || bytes[0]! > 5) return null;
  return { kind: bytes[0] as FrameKind, session: bytes.readUInt32BE(1), body: bytes.subarray(5) };
}

/** A session message's head (`{t: "req" | "res" | "data" | "cancel" | "ping" | "pong", …}`): JSON. */
export type Head = Record<string, unknown>;

export function encodeMessage(head: Head, body: Buffer = EMPTY) {
  const json = Buffer.from(sortedJSON(head));
  const length = Buffer.alloc(2);
  length.writeUInt16BE(json.length);
  return Buffer.concat([length, json, body]);
}

/** A message as it came, its head parsed but not yet checked. */
export function decodeMessage(bytes: Buffer): { head: unknown; body: Buffer } | null {
  if (bytes.length < 2) return null;
  const length = bytes.readUInt16BE(0);
  if (bytes.length < 2 + length) return null;
  try {
    return { head: JSON.parse(bytes.subarray(2, 2 + length).toString("utf8")), body: bytes.subarray(2 + length) };
  } catch {
    return null;
  }
}

// `head` and `body` as messages that each fit: the first with `head`, the rest as `data`.
export function pieces(head: Head & { id?: unknown }, body: Buffer, end: boolean) {
  if (Buffer.byteLength(sortedJSON(head)) > 60_000) throw new Error("head too long");
  const out: [Head, Buffer][] = [];
  let current: Head = { ...head, end: false };
  let offset = 0;
  do {
    const room = MAX_MESSAGE - 2 - Buffer.byteLength(sortedJSON(current)) - 8;
    out.push([current, body.subarray(offset, offset + room)]);
    offset += room;
    current = { t: "data", id: head.id, end: false };
  } while (offset < body.length);
  out[out.length - 1]![0].end = end;
  return out.map(([h, b]) => encodeMessage(h, b));
}
