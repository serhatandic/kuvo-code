// Values out of what the vault gives back to an agent: each value handed out, where it shows in a
// command's output, raw or in the forms output turns it into (base64, hex, URL- and JSON-escaped),
// and each line of one that has lines and each string in one that's JSON (a key file, a client's
// secrets), becomes `[vault: <item>]`.

/** A value to hide, and the item it's from. */
export interface Hidden {
  item: string;
  value: string;
}

// Too short to hide without hiding ordinary words too; a part of a longer value, longer still.
const SHORTEST = 4;
const SHORTEST_PART = 8;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole value's forms: as it is, base64 (with a newline after it too, as `echo | base64` has
 * it), hex either case, URL- and JSON-escaped. (A hiding, not a fence: a command can still send a
 * value elsewhere.) */
function encodings(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const line = Buffer.from(value + "\n", "utf8");
  const hex = bytes.toString("hex");
  return [value, bytes.toString("base64"), bytes.toString("base64").replace(/=+$/, ""), bytes.toString("base64url"), line.toString("base64"), line.toString("base64").replace(/=+$/, ""), hex, hex.toUpperCase(), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)];
}

/** The strings anywhere in a JSON value. */
function stringsIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const each of value) stringsIn(each, found);
  else if (value && typeof value === "object") for (const each of Object.values(value)) stringsIn(each, found);
  return found;
}

/** Every form of a value worth hiding: the whole, its lines, the strings in it if it's JSON. */
function formsOf(value: string): string[] {
  const forms = new Set(encodings(value).filter(form => form.length >= SHORTEST));
  const parts: string[] = [];
  if (/[\r\n]/.test(value)) parts.push(...value.split(/\r?\n/).map(line => line.trim()));
  // Hex as `xxd -p` wraps it, 60 to a line.
  const hex = Buffer.from(value, "utf8").toString("hex");
  if (hex.length > 60) parts.push(...hex.match(/.{1,60}/g)!);
  try { parts.push(...stringsIn(JSON.parse(value))); } catch {}
  for (const part of parts) {
    if (part.length < SHORTEST_PART) continue;
    forms.add(part);
    forms.add(JSON.stringify(part).slice(1, -1));
  }
  return [...forms];
}

/** `text` with every value in `hidden` (in any of its forms) replaced by its item's name: the
 * longest forms first, of every value at once, so one value inside another hides whole. */
export function maskValues(text: string, hidden: Hidden[]): string {
  const forms: { form: string; label: string }[] = [];
  for (const { item, value } of hidden) {
    if (!value || value.length < SHORTEST) continue;
    for (const form of formsOf(value)) forms.push({ form, label: `[vault: ${item}]` });
  }
  forms.sort((a, b) => b.form.length - a.form.length);
  let masked = text;
  // (The label as a function: a `$` in an item's name is only a `$`.)
  for (const { form, label } of forms) masked = masked.replace(new RegExp(escapeRegExp(form), "g"), () => label);
  return masked;
}
