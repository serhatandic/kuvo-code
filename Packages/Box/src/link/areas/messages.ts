// A client's message, as fields (PROTOCOL.md, "A message's parts"): `POST kuvo/sessions/<id>/send`
// writes what the agent reads (messages/parts.ts) and sends it to the conversation, its parts kept
// with it; `POST kuvo/messages/parts` reads the parts of messages from before, which carry none.

import { isObject, parsed } from "../../shared/json";
import { MOVING } from "../bots/here";
import { messageID } from "../engine/sessions";
import { isRefused, placeOfSessionPatiently } from "../letters/letter";
import { targetsOf } from "../letters/tools";
import { composeArguments, composeMessage, fieldsOf, partsOf, withParts } from "../messages/parts";
import type { MessageFields } from "../messages/parts";
import { frozen } from "../moves/records";
import { keptFiles } from "../server/attached";
import type { PromptFile } from "../server/attached";
import { answerHeaders, modelInput } from "../server/forward";
import { everyoneFor, listedAgents } from "../server/naming";
import { REQUEST_HEADERS } from "../server/paths";
import { answering, BUSY, sentKey, sentOnce } from "../server/sent-once";
import type { SentAnswer } from "../server/sent-once";
import type { Target } from "../../shared/records";
import type { AnswerPiece, LinkRequest, RouteContext } from "../server/context";

export const SEND_ROUTE = /^kuvo\/sessions\/([^/]+)\/send$/;
export const PARTS_ROUTE = "kuvo/messages/parts";

/** How many messages one `kuvo/messages/parts` reads. */
const PARTS_MOST = 500;

/** A message as it goes to the engine: the text the agent reads, its files, and its parts. */
export interface Composed {
  text: string;
  files: PromptFile[];
  metadata: Record<string, unknown>;
}

/** `fields` (with the `files` it carries, as the engine takes them) as the message the conversation
 * `session` at `target` gets: its files kept here as `attachedIn` keeps them, and its text written
 * for the agent (`composeMessage`), from a phone unless `request` is a Kuvo Code app's; a
 * `command`'s arguments as written with only its files' note (`composeArguments`). */
export async function composed(fields: MessageFields, files: unknown[], session: string, target: Target, toAgents: boolean, request: LinkRequest, readEngine: () => Target, signal?: AbortSignal, metadata?: unknown, command = false): Promise<Composed> {
  const base = new URL(`http://127.0.0.1:${target.port}/`);
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` };
  const kept = await keptFiles(files, session, modelInput(base, headers, signal), toAgents);
  // A command's arguments: as written, with its files' note alone.
  if (command) return { text: composeArguments(fields.words, fields.notes, kept ?? {}), files: (kept?.files ?? files) as PromptFile[], metadata: {} };
  // (Everyone worked out again only for a message that names someone.)
  const everyone = fields.words.includes("&") ? await everyoneFor(fields.words, readEngine) : listedAgents();
  const phone = request.fromMac !== true && request.fromApp !== true;
  const text = composeMessage(fields, { excluding: session, here: everyone.machine, agents: everyone.agents }, kept ?? {}, phone);
  return { text, files: (kept?.files ?? files) as PromptFile[], metadata: withParts(metadata, partsOf(text)) };
}

/** Whether `fields` and `files` make no message: nothing written, and nothing with it. */
export const isEmpty = (fields: MessageFields, files: unknown[]): boolean =>
  !fields.words.trim() && fields.keyword === undefined && fields.widget === undefined && !fields.comments?.length && !files.length
  && !fields.notes?.included?.length && !fields.notes?.paths?.length && !fields.notes?.unsent?.length;

// `kuvo/sessions/<id>/send`: `{id, words, files?, delivery?, keyword?, widget?, comments?, named?,
// notes?}` as a message, or with `command`, that command run with `words` as its arguments (only
// its files' note goes with them); `{id, text, files?, delivery?}`, one sent before sent again as
// the agent read it (Retry), its files as they went. Answered as the engine (or the coding agents'
// bridge) answers it; a message sent again under its id goes once (`sentOnce`), whoever sent it
// going meanwhile.
export async function* sendRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, { message: "Send a message with POST." });
  let session = "";
  try { session = decodeURIComponent(match[1]!); } catch {}
  if (!session) return yield* json(404, { message: "There's no such conversation here." });
  const given = parsed(request.body);
  const again = isObject(given) && typeof given.text === "string" ? given.text : null;
  const fields = isObject(given) && again === null ? fieldsOf(given) : null;
  if (!isObject(given) || (!fields && again === null)) return yield* json(400, { message: "Send what was written (words)." });
  const files = Array.isArray(given.files) ? given.files : [];
  const command = fields && typeof given.command === "string" && given.command.trim() ? given.command.trim() : null;
  // (A command runs with nothing after its name: /init.)
  if (!command && (fields ? isEmpty(fields, files) : !again!.trim() && !files.length)) return yield* json(400, { message: "There's nothing to send." });
  if (frozen().has(session)) return yield* json(409, { message: MOVING });
  const targets = targetsOf({ readEngine, bridge });
  if (!targets.length) return yield* json(503, { message: "The engine isn't running." });
  let place: Awaited<ReturnType<typeof placeOfSessionPatiently>>;
  try {
    place = await placeOfSessionPatiently(session, targets);
  } catch (error) {
    return yield* json(503, { message: isRefused(error) ? "The engine isn't running." : BUSY });
  }
  if (!place) return yield* json(404, { message: "There's no such conversation here." });
  const target = place.target;
  const toAgents = bridge()?.port === target.port;
  const headers: Record<string, string> = { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, "content-type": "application/json" };
  const asked = Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  for (const name of REQUEST_HEADERS) if (typeof asked[name] === "string") headers[name] = asked[name] as string;
  const delivery = given.delivery === "queue" ? "queue" : given.delivery === "steer" || !command ? "steer" : undefined;
  const at = `http://127.0.0.1:${target.port}/api/session/${encodeURIComponent(session)}/${command ? "command" : "prompt"}`;
  // A message goes on even if whoever sent it goes meanwhile (as `forward` sends one); a command
  // stops with its sender: it has no id, and sent again it would run twice.
  const send = async (): Promise<SentAnswer> => {
    try {
      const message = fields
        ? await composed(fields, files, session, target, toAgents, request, readEngine, command ? signal : undefined, undefined, command !== null)
        : { text: again!, files: files as PromptFile[], metadata: withParts(undefined, partsOf(again!)) };
      const body = command
        ? { name: command, text: message.text, ...(message.files.length ? { files: message.files } : {}), ...(delivery ? { delivery } : {}) }
        : { id: typeof given.id === "string" && given.id ? given.id : messageID(), text: message.text, ...(message.files.length ? { files: message.files } : {}), delivery, metadata: message.metadata };
      const response = await fetch(at, { method: "POST", headers, body: JSON.stringify(body), signal: command ? signal : undefined });
      return { status: response.status, headers: answerHeaders(response), body: Buffer.from(await response.arrayBuffer()) };
    } catch {
      if (signal?.aborted && command) throw new Error("Stopped.");
      return { status: 503, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ message: toAgents ? "The coding agents aren't answering on this computer. Try again in a moment." : "The engine isn't answering. Try again in a moment." })) };
    }
  };
  const once = command ? null : sentKey(toAgents ? "agents" : "engine", session, request.body);
  return yield* answering(once ? await sentOnce(once, send) : await send());
}

// `kuvo/messages/parts`: `{texts}`, the texts of messages from before (which carry no parts), read
// as `{parts}`, one for each, in order.
export async function* partsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, { message: "Send the texts with POST." });
  const given = parsed(request.body);
  const texts = isObject(given) && Array.isArray(given.texts) ? given.texts : null;
  if (!texts || texts.some(text => typeof text !== "string")) return yield* json(400, { message: "Send the messages' texts (texts)." });
  if (texts.length > PARTS_MOST) return yield* json(400, { message: `Send at most ${PARTS_MOST} texts at once.` });
  return yield* json(200, { parts: (texts as string[]).map(partsOf) });
}
