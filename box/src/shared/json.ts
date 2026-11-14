// JSON with its keys sorted, as the Swift side writes it, so the same value is the same bytes on
// every side (link frames' heads, a notice's payload, a setting compared with what was read).

export function sortedJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter(k => object[k] !== undefined).map(k => `${JSON.stringify(k)}:${sortedJSON(object[k])}`).join(",")}}`;
  }
  // As JSON.stringify writes it (`undefined` for what JSON has no word for), as it always has.
  return JSON.stringify(value) as string;
}

/** A JSON object (not an array, not null): what a record read from a file or a peer has to be. */
export const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A request's body as JSON: `{}` for none, undefined for what isn't JSON. Whatever the client sent,
 *  so nothing about it is known until it's checked. */
export const parsed = (body: Uint8Array | string | null | undefined): unknown => {
  try {
    return JSON.parse(Buffer.from(body ?? "").toString() || "{}");
  } catch {
    return undefined;
  }
};

/** A value's fields `K` as read before they're checked: each whatever came (unknown until checked,
 *  and missing from JSON that isn't an object). */
export type Fields<K extends string> = { [Field in K]?: unknown };

/** A request's body as a route reads it: its fields `K`, or null or undefined when the JSON was
 *  `null` or wasn't JSON. */
export type Body<K extends string> = Fields<K> | null | undefined;

/** Whether two values are the same JSON (nothing counting as null). */
export const sameJSON = (a: unknown, b: unknown) => sortedJSON(a ?? null) === sortedJSON(b ?? null);
