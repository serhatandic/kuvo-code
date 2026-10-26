// What your computers share as signed documents (PROTOCOL.md, "Documents"), as it's given and as
// a box keeps it.

/** The kinds there are: who a Mac's boxes are, the phones each box pairs and removes, and each box's view of your personalities. */
export const DOC_KINDS = ["peers", "phones", "personalities"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** A document as it's given and kept: its bytes (`d`) and their signature (`s`), base64url. */
export interface SignedDoc {
  d: string;
  s: string;
}

/** A document read: its origin (the signing key's public half), kind, version and body, its bytes' hash (`h`, as digests name it), and itself as given. */
export interface Doc {
  origin: string;
  kind: DocKind;
  n: number;
  body: Record<string, unknown>;
  h: string;
  envelope: SignedDoc;
}
