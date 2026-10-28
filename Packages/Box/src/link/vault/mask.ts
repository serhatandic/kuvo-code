// Values out of what the vault gives back to an agent: each value handed out, where it shows in a
// command's output, raw or in the forms output turns it into (base64, hex, URL- and JSON-escaped,
// a PEM body across lines), becomes `[vault: <item>]`.

/** A value to hide, and the item it's from. */
export interface Hidden {
  item: string;
  value: string;
}

// Too short to hide without hiding ordinary words too.
const SHORTEST = 4;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The forms a value can take in output, longest first. */
function formsOf(value: string): string[] {
  const forms = new Set<string>([value]);
  const bytes = Buffer.from(value, "utf8");
  forms.add(bytes.toString("base64"));
  forms.add(bytes.toString("base64").replace(/=+$/, ""));
  forms.add(bytes.toString("base64url"));
  forms.add(bytes.toString("hex"));
  forms.add(encodeURIComponent(value));
  forms.add(JSON.stringify(value).slice(1, -1));
  // A key file's body: what's between its lines, each line of it.
  const pem = value.match(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/);
  if (pem) for (const line of pem[1].split(/\r?\n/)) if (line.trim().length >= 16) forms.add(line.trim());
  return [...forms].filter(form => form.length >= SHORTEST).sort((a, b) => b.length - a.length);
}

/** `text` with every value in `hidden` (in any of its forms) replaced by its item's name. */
export function maskValues(text: string, hidden: Hidden[]): string {
  let masked = text;
  for (const { item, value } of hidden) {
    if (!value || value.length < SHORTEST) continue;
    for (const form of formsOf(value)) masked = masked.replace(new RegExp(escapeRegExp(form), "g"), `[vault: ${item}]`);
  }
  return masked;
}
