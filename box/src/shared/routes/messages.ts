// A client's message as fields, and the parts of messages (PROTOCOL.md, "A message's parts").

import { list, literal, number, object, type RouteShape, string, words, any } from "../shape";

const REFUSED = object({ message: string });

/** A comment on one line of the changes. */
export const REVIEW_COMMENT = object({ file: string, line: number, side: words("new", "old"), snippet: string, text: string });

/** A message's parts, as clients draw it (`metadata.kuvo.parts`, or read from one from before). */
export const MESSAGE_PARTS = object({
  words: string,
  "keyword?": string,
  "widget?": string,
  "comments?": list(REVIEW_COMMENT),
  "paths?": list(string),
  "agents?": list(object({ name: string, session: string })),
  "phone?": literal(true),
  "mail?": object({ name: string, session: string }),
});

export const MESSAGE_ROUTES: RouteShape[] = [
  // (The engine's answer, or its coding agents' bridge's, as it gave it.)
  { route: "POST kuvo/sessions/:id/send", answers: { 200: any, 400: REFUSED, 404: REFUSED, 405: REFUSED, 409: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/messages/parts", answers: { 200: object({ parts: list(MESSAGE_PARTS) }), 400: REFUSED, 405: REFUSED } },
];
