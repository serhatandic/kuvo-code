// What the box's routes are given and answer with (server/router.ts): a request, as a phone sends
// it through the relay (relay/host.ts) or this Mac's app over HTTP (server/serve.ts), and an answer,
// its head then its body in pieces, as it comes.

import type { BridgeRecord, EngineRecord } from "../../shared/records";
import type { NoticeHold } from "../notices/hold";
import type { LinkState } from "../state";

/** A request to the box: its method, its path (with any query), its headers and body. */
export interface LinkRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
  /** From this Mac's own app (`x-kuvo-from: app`), not a phone. */
  fromApp?: boolean;
}

/** Who asks: a phone, by its static key and where it is on the relay; nothing for this Mac's app. */
export interface Asker {
  key?: Buffer;
  name?: string;
  address?: Buffer;
}

/** A piece of an answer: its head (status and headers) first, then its body, in pieces. */
export type AnswerPiece = { head: { status: number; headers: Record<string, string> } } | { body: Buffer };
/** An answer, as it comes. */
export type Answer = AsyncIterable<AnswerPiece> | Iterable<AnswerPiece>;

/** What an area's answer helper gives its route to send as JSON (`json(status, value)`): the
 * status, and the value as the body. */
export interface JSONAnswer<Value = unknown> {
  status: number;
  value: Value;
}

/** What each route's answer gets from the handler, for the request it answers. */
export interface RouteContext {
  request: LinkRequest;
  phone: Asker | undefined;
  signal: AbortSignal | undefined;
  /** The request's path without its query: which route answers is by it alone. */
  route: string;
  readEngine: () => EngineRecord;
  readBridge: () => BridgeRecord;
  /** The coding agents' bridge while it runs, else null. */
  bridge: () => BridgeRecord | null;
  /** What `kuvo/info` adds about this box: its name, at least. */
  info: { name?: string; [more: string]: unknown };
  /** Told the link as it is once a removal's answer is on its way. */
  phonesChanged: (link: LinkState) => void;
  /** The running bridge's notices held while you're at a computer; none in `box route`. */
  hold: NoticeHold | null;
  json: (status: number, value: unknown) => AnswerPiece[];
  text: (status: number, words: string) => AnswerPiece[];
}
