# Kuvo Link

How Kuvo Code on a phone reaches the agents on a Mac or a machine, from anywhere,
through a relay that can't read what passes through it.

- **Hosts** serve an engine: the Mac app, and a bridge on each machine (`kuvo-link.js`,
  run by the engine's own runtime). A host connects out to the relay; it never listens.
- **The phone** connects out to the relay too, and opens an encrypted session with each
  host it's paired with.
- **The relay** matches connections by address and passes bytes along. It keeps no
  content. It also sends Apple push notifications, whose content it can't read either.

Everything below is implemented twice, in Swift (`Sources/KuvoLink`, for the Mac app and
the phone) and in JavaScript (`Sources/KuvoLink/Resources/kuvo-link.js`, for machines). `Vectors/` holds the
test vectors both run against.

## Keys and addresses

Each device (a phone, a Mac, a machine) has:

- a **static key**, an X25519 key pair, which identifies it to the devices it's paired with;
- a **relay secret**, 32 random bytes, which it shows only to the relay.

Its **address** is the first 16 bytes of `SHA-256("kuvo-link address v1" || secret)`. The
relay checks a connection's secret against the address it claims, so it needs no accounts
or storage, and only the device itself can receive what's sent to its address.

In text (links, JSON) keys, secrets, addresses and tokens are base64url without padding.

## The relay

One WebSocket per device, binary messages, first byte the kind:

| Kind | From | Bytes | Meaning |
| --- | --- | --- | --- |
| `0x01` hello | device | `secret(32)` | Must come first. A second connection with the same address replaces the first (closed with 4002). |
| `0x01` welcome | relay | `address(16)` | The secret was fine; this is your address. |
| `0x02` send | device | `to(16) payload` | Pass `payload` to the device at `to`. |
| `0x02` deliver | relay | `from(16) payload` | Something sent to you. |
| `0x03` unreachable | relay | `to(16)` | Nothing is connected at `to`; what you sent is dropped. |
| `0x04` register | phone | JSON | `{"token", "environment": "sandbox"\|"production", "topic", "senders": [address]}`: send pushes to this APNs token, only from these addresses. Kept for 90 days; the phone sends it again whenever it connects. |
| `0x05` push | host | `to(16) payload` | Push `payload` (a mail frame, below) to `to`'s phone. |
| `0x06` pushed | relay | `to(16) status(1)` | 0 sent, 1 no phone registered, 2 not one of its senders, 3 Apple refused. |

`payload` is at most 65,600 bytes. The relay closes a connection that sends anything else
(4000), a wrong secret (4001), far too much too fast (4003), or one too many from the same
IP address (4005). A device a little too fast, or sending faster than the one it sends to
takes in, is held back: the relay stops reading from it for a moment.

An APNs push carries `{"aps": {"alert": {"title": "Kuvo Code", "body": "New activity"},
"mutable-content": 1}, "f": "<sender's address>", "k": "<payload, base64>"}`. The phone's
notification extension decrypts `k` with the key of the host at `f`, and replaces the text,
the category (for its buttons) and the thread.

## Link frames

What one device sends another, inside the relay's `payload`:

```
kind(1) session(4) body
```

`session` is a random number the phone picks for each session, so frames from an older one
can't be confused with a newer one.

| Kind | Body |
| --- | --- |
| `0x01` | Handshake message 1, phone to host |
| `0x02` | Handshake message 2, host to phone |
| `0x03` | A transport message: one encrypted message (below) |
| `0x04` | Close: no body. Either side stops the session. |
| `0x05` | Mail: one message, encrypted for a device that may not be connected (`session` is 0) |

## Sessions

Sessions use **Noise_IK_25519_AESGCM_SHA256** ([the Noise protocol](https://noiseprotocol.org/noise.html)),
with the prologue `kuvo-link v1`. The phone starts, knowing the host's static key from
pairing; the host learns the phone's from the first message and checks it.

The first message's payload is JSON:

```json
{"v": 1, "name": "My iPhone", "app": "0.1.0", "pair": "<token>"}
```

`pair` is there only while pairing. The host answers if the phone's key is one it has
paired, or if `pair` is the token it's showing; otherwise it sends a close. Its answer's
payload:

```json
{"v": 1, "kind": "mac", "name": "My MacBook", "app": "0.4.0", "engine": "2.0.30"}
```

`kind` is `mac` or `machine`. Each side checks `v` and closes the session on a version it
doesn't know.

Transport messages then go both ways, in order (the relay keeps the order of one
connection). Any message that doesn't decrypt ends the session.

## Mail

Pushes and other messages for a device that may not be connected use
**Noise_K_25519_AESGCM_SHA256** (both static keys known), with the prologue
`kuvo-link mail v1`: one handshake message carrying the payload. A host's push carries a
notification, below.

A host mails another host the same way, with a relay `send` of a mail frame (`kind` 5, session
0): what your computers share goes as signed documents ("Documents"), and peers mail each other
their agents and letters ("Peers").

### Documents

What your computers share is three kinds of document: who a Mac's boxes are (`peers`), the phones
each box pairs and removes (`phones`), and each box's view of your personalities
(`personalities`). Each origin signs its own; any box passes a copy on; no clock decides anything.

- **Keys**: each box and Mac has a signing key (Ed25519) beside its static key: a Mac in its
  Keychain (`sign`), a machine in `run/link.json` (`sign`, the 32-byte seed), made with its other
  keys. A document's origin is that key's public half. Trust comes from SSH: setup gives the
  machine the Mac's (`macSign`) and its answer gives the Mac the machine's (`sign`). A Mac's peers
  document names each box with both its keys, so boxes learn each other's from a document they
  already verify. A box made anew (its folder gone) is a new origin; the Mac's next setup names it.
- **Format**: `{"d": <bytes>, "s": <signature>}`, base64url without padding. The bytes are JSON,
  `{"v": 1, "kind", "origin", "n", "body"}`, as the origin wrote them, and the signature is over
  `"kuvo-link doc v1\0"` and the bytes. A box checks the signature before it reads them, and keeps
  and passes on the bytes as they are, so no one needs a canonical JSON. `n` is the version, a
  whole number from 1 to 2^53−1, one more with each change. A document is at most 512 KB of
  bytes. Held to `Vectors/docs.json` (KuvoLink's `Documents`, the bridge's `readDoc`).
- **Taken**: a box takes a document that verifies, from an origin it takes that kind from, newer
  than the one it has; at the same version, the one whose bytes' hash sorts first, so every box
  keeps the same one. One of its own further on than it knew (it lost count), by a document or a
  digest, moves its count past it, up to 2^52 (one claiming more isn't taken). It takes `peers` only from its own Macs (those in `macSigns`, given in setup); `phones` and
  `personalities` from those Macs, from its peers and from itself. Documents from an origin it no
  longer takes them from go.
- **`peers`**, one per Mac: `{boxes: [{key, sign, address, name, kind: "mac"|"machine", id?}],
  moved: [{session, key}], left: [key]}`: the Mac itself and each of its machines whose bridge
  signs, the same document for all of them. A box's peers are every box its Macs' documents name,
  itself left out ("Peers"). `left` names the machines that Mac removed (never one it still has,
  under another name): a box that finds itself there and no longer among `boxes` stops counting
  that Mac, as `leave` does. The Mac mails it to a machine as it removes it, once.
- **`phones`**, one per box: `{phones: [{key, name, address?, pairing}], removed: [{key,
  pairing}]}`: the phones paired there, and every removal it knows of ("Paired phones"). A box
  lets in its own and its Macs' phones, less every pairing removed in any phones document it
  takes, which it notes as its own removal too. A Mac with the phone link off signs none.
- **`personalities`**, each box's view: the library (`{personalities, removed}`, "Personalities").
  A box meets a view it takes with its own, and signs its own again if it changed; views aren't
  passed on (each box's own already has what it took). Its own goes past 512 KB never: a change
  that would take it there is refused.
- **Exchange**, inside mail, as `"docs"`: `{give: [{d, s}]}`; `{part: {whole, i, of, d, s}}` for a
  document too big for one mail (40,000 characters of `d` each, `whole` the SHA-256 of all of
  `d`); `{have: [[origin, kind, n, h]], reply?}`, a digest of what the sender has (`h`, the first 8
  bytes of the bytes' SHA-256, base64url). A box sends its digest to each peer as it connects to the
  relay, and with its agents every ten minutes (so one that missed what it was given gets it then).
  To a digest, a box gives what the sender lacks or has older (of what that box would take), and,
  unless it's a `reply`, answers with its own digest, marked `reply`, when the sender has something
  newer. A document it took goes on to its other peers that would take it (not back where it came
  from, nor to its origin); one of its own that changed, to all of them. Over SSH, setup carries the
  Mac's documents (`docs`, its own and those it has of its machines) and its answer the machine's.
  A box doesn't give documents to a Mac that gave it no signing key.
- **Later**: each box's agents (`{"agents"}`, "Peers") are a list of its own too, still sent as
  they change and every ten minutes; they could become a fourth kind.

### Peers

Your computers talk to each other over the relay, Mac or not. A Mac connects to
the relay when the phone link is on or it has at least one machine; a Mac on its own makes no
connection.

- **Who**: each of a box's Macs' peers documents ("Documents") names its boxes: that Mac, and its
  machines whose bridge signs (`id`, the machine's name on that Mac). A box's peers are every box
  they name, itself left out, whoever passed the document on. Only a Mac says who a box's peers
  are. Its bridge runs while it has peers or phones. Setup also gives the machine's `id`, and the
  peers document carries `moved`: conversations being moved, by the key of the computer each lives
  on now (the one it left may still list it until it's let go).
- **Mail**: a box opens mail from its Macs and its peers, and drops the rest. Every mail has `at`
  (milliseconds). A sealed mail frame is at most 65,600 bytes, and one larger isn't sent: letters'
  words and lists are cut to fit.
- **Agents**: `{"agents": {"at", "list": [{session, name, kind: "bot"|"session", id?, project?,
  about?, machine?}], "features"?}}`: a bot's `id` (`bot_…`, as group chats name their members),
  and `features` as the box's `kuvo/info` names them. A box sends its bots and its 40 latest
  sessions (its engine's and its coding agents') when they change and every ten minutes. Each box
  keeps the newest list from each peer. The relay keeps nothing, so a box that has just connected adds `"ask": "agents"` to
  what it sends first (its agents; a Mac's digest), and whoever gets it tells that box its agents
  again within a minute.
  - A machine's bridge writes `run/agents.json` (what `list_agents` reads there) from its own
    agents and its peers', relay or not.
  - A moved session is the computer's a Mac says it lives on. A session listed by more than one
    peer is the Mac's when a Mac lists it, and otherwise nobody's.
  - A Mac also lists the agents of its machines whose bridge doesn't talk to peers, each with its
    `machine`, and takes their letters on over SSH.
  - A Mac connected over SSH writes its list to `run/mac-agents.json` (`{key, at, list}`), which
    the bridge takes when it's newer than the Mac's mail.
- **Personalities**: each box's view is a document ("Documents"); a box meets a peer's with its
  own, and its bots whose personality changed are told what they are now.
- **Letters**: `{"letter": {id, from, to, text, wait, at, answers?}}` goes to the box that listed
  `to`.
  - **Checks**: the receiver drops a letter older than a day. It delivers each `id` once (ids
    remembered two days, noted once delivered), at most 20 in ten minutes from a box, and only
    to a conversation an agent could be. A subagent's, a group chat's seat or one put away doesn't
    take letters. One it can't look up now (its engine starting) is answered `retry`.
  - **Sender**: it names the sender as the sending box named that agent, when that box alone
    lists `from` and it isn't one of the receiver's own conversations. Otherwise the letter is from
    "an agent on <box>", with no address to answer.
  - **`delivered`**: it answers `{"delivered": {id, ok, why?, retry?, answer?}}`. `retry`: not
    now (an engine restarting, too many lately), so the sender tries again. `answer: false`: there,
    but no answer will come (its sender couldn't be verified, or its machine is away).
  - **`wait`**: the receiver watches for an answer for ten minutes and sends it back as a letter
    of its own, with `answers` naming the first. If a tool still waits for it, it goes to that
    tool; otherwise it reaches the sender's conversation as a message.
  - **Sender side**: a sender takes `delivered` only from the box it sent to, and an answer for a
    waiting tool only from that box. Until `delivered` comes, it sends again each minute, for two
    days, and a letter whose agent no box lists now waits. Before a letter goes, its sender is
    told of to that box, if it wasn't.
- **On a machine**: `send_message` leaves a letter for a peer's agent in
  `run/outbox/sending/<id>.json`, which the bridge sends, and others in `run/outbox` for the Mac
  to collect over SSH.
  - A subagent writes as its conversation.
  - A waiting tool reads `run/replies/<id>.json` (`{text}`, `{failed}` or `{note}`), and touches
    `<id>.alive` as it looks. An answer that comes once it isn't is delivered as a message.
  - After eleven minutes, or its turn stopped, the tool leaves `<id>.gaveup`, and its letter goes on
    without waiting.
  - With no relay for five minutes, letters not yet sent move to `run/outbox` for the Mac, marked
    `handed`. Once the relay is back, those the Mac hasn't connected to take since come back.
  - The Mac takes each letter in `run/outbox` by renaming it `.mac-<name>` before it reads it,
    and puts back the ones it couldn't deliver, so a letter goes one way only.
- **Group chats**: a chat lives on one box (its host) and runs there. A member that lives on
  another box (its home, a peer whose `features` say `groups.seats`) takes its turn there, in a
  seat of the home's own, and does its part of the work and remembers the chat in its own
  conversation there. Only words go between them, as `{"seat": <mail>}` (with `"seatID"` for one
  that mustn't be lost), or `{"seatPart": {whole, i, of, d, s}}` for a mail too big for one (as a
  document's parts, `s` the `seatID`, or empty). The coding agents' bridge on each box writes and
  reads the mail (`Agents/src/groups/peer.ts`), and the box's link carries it.
  - **`turn`** (host → home): `{id, chat: {id, name, purpose?, members: [{id, name, job}]}, bot,
    seat?, agentsSeat?, kind: "turn"|"wrapUp"|"guest"|"split", text, fresh?, chatSize?}`: what the
    bot hears, composed by the host (`fresh`, the whole chat, for a seat its home has to make
    anew). The home builds the seat's instructions and rules from its own bot, checks its model's
    sign-in, and runs it. It takes each `id` once (remembered a day), and answers one asked again
    with how it's going.
  - **`state`** (home → host): `{id, state}`, `state` one of `{phase: "taken"}` (at once),
    `{phase: "seated", seat, agents, replaced?}`, `{phase: "started"}` (its words are with its
    seat), `{phase: "activity", activity}` (at most every 1.5 s, the latest), `{phase: "steered",
    message}`. **`result`** (home → host): `{id, result}`, `{ok: true, text, steps, outgrown?}` or
    `{ok: false, why}`. A host takes them only from the box it asked. Unheard of after 15 s, it
    asks again once; after 45 s, the chat says the bot's computer can't be reached now.
  - **`steer`** `{id, text, message}` and **`stop`** `{id}` (host → home), for a message you write
    while it talks, and for Stop, Undo or a move.
  - Not to be lost (sent as letters are, until `delivered`; never through a Mac): **`drop`**
    `{seat, agents}` (host → home: a seat gone), **`work`** `{work: {task, wrapUp, chat, bot,
    text, started}}` (host → home: a part, to the bot's own conversation, followed there across
    restarts), **`report`** `{task, wrapUp, chat, result}` (home → host, taken only from the box
    that bot lives on), and **`memory`** `{memory: {chat, bot, forget?, name?, with?, recap?,
    transcript?, time?}}` (host → home: kept beside the home's own chats in the bot's one memory
    instruction, the transcript in `groups/<host key's first 8 characters>-<chat>.md` in its
    folder).
  - A bot whose home changed (it moved) loses its seat where it was (`drop`), and its next turn
    makes one where it is now, given the whole chat. A host offers in its chats the bots of the
    peers that take seats (`kuvo/groups/joinable`), and its chats list them as members with
    `computer`, the peer's name.
- `kuvo-link.js leave <mac>`: run when that Mac removes the machine. It stops counting that Mac,
  forgets its documents, the peers only it named and what they told it, and leaves other Macs'
  alone. A Mac that can't reach the machine names it in its peers document's `left`, and mails it
  that document once; one that never gets it lets that Mac go after 30 days ("Paired phones").

### Updates

A box's files say which Kuvo Code put them there: `~/.kuvo-code/bin/box-version`. It holds that
app's version, written by a Mac after it sets the box up, or by the box when it updates itself.
- **Older or unmarked box**: a Mac installs its own engine, bridge, helpers, agents bridge and
  keeper, then writes its version. Marking it, it also keeps copies of the box's tools
  (`kuvo-agents.js`, `kuvo-browser.js`, `kuvo-wake`, `kuvo-npx`) in `bin/.own`, only those that
  carry its own first or last line (`// kuvo-browser <hash>`, `// kuvo-agents <hash>`). Its engine
  launches note `"box": <version>`.
- **Newer box**: a Mac leaves everything as it is.
  - Every script that would write one of its files reads what it was given and stops.
  - It connects to the engine running there, and doesn't start it over for its own settings.
  - If that engine isn't running, the box's keeper starts the one it has.
  - A script's runtime `$E` is the Mac's engine version when it's there, else the newest there,
    by version.
- **Setup**: a Mac that does this says so with `"tolerates": 1`. The bridge keeps it per Mac
  (`tolerant`), and drops it with that Mac.
- **Setup** also sends the Mac's ID (`macID`, as its engine launches name it). The bridge keeps
  `tolerantIDs[macID]`, set again at each setup, and notes in `run/launchers.json` which Mac
  started the engine (from `run/engine.json`'s `notes.mac`).

A Mac with Kuvo Code 0.7 or before still connects, and puts its own files there as it always
did: the box keeps working as itself ("For released Macs").

**A box updating itself** takes only what a key pinned in `kuvo-link.js` (`UPDATE_KEYS`) signed;
`scripts/set-box-key.sh` makes that key.
- **What a release is**: `boxes.json` from `https://github.com/serhatandic/kuvo-code/releases/latest/download/`,
  `{manifest, signature, key}`. The manifest is `{kuvo: "box/1", version, released, engine,
  linux: {x86_64|aarch64: {url, integrity}}, pack: {url, sha256, size}}`. The signature is
  Ed25519 over `"kuvo-box v1\n"` and the manifest's bytes, by a pinned key
  (`scripts/sign-box.mjs`). The pack holds `box.json` (each file's SHA-256) and the files, laid
  out as `~/.kuvo-code`.
- **When**: the night's window, 02:00 to 05:00 in `KUVO_TZ`, once a night, always (there's no
  switch: a machine keeps up with the Macs and phones that use it), for a release at least three
  days old. Or now (Update Now), whatever its age.
- **Never**:
  - in another folder than `~/.kuvo-code`;
  - while its engine is stopped on purpose (`run/stopped`), or its version (`bin/box-version`)
    isn't known;
  - to a version that isn't newer;
  - while a conversation works there or a browser ask waits;
  - while a Mac that started the engine in the last 30 days isn't in `tolerantIDs` as `true`;
  - while a Mac with Kuvo Code 0.7 or before connected in the last 30 days, since the box was last
    marked ("For released Macs").
  - When the newest release has no `boxes.json`, it's "current", not a failure.
- **How**:
  1. It checks the pack's SHA-256, each file's, and the engine's npm `integrity`.
  2. It tries the new engine (`--version`), the new bridge with it (`selftest`), and the new
     keeper (`sh -n`).
  3. With another engine version, it first checks there's room to keep the engine's data. It keeps
     each file it replaces in `updates/rollback`, writes `restore.sh` and `run/update-trial`, and
     only then stops the engine. It goes on only once the engine has stopped; if it can't stop it,
     nothing has changed, and it starts the engine again. With another engine version, it keeps
     the engine's data (`opencode.db` with its `-wal` and `-shm`) whole or not at all
     (`data.partial`, renamed once copied).
     - `restore.sh` checks each step and keeps what was kept until it's all back.
     - It moves the database back (same disk, no room needed), without the new engine's journal,
       and only once it was kept.
  4. It swaps file by file: `bin/box-version` first, `bin/.kuvo-boot` last, with copies of the
     release's tools in `bin/.own` (kept for a rollback as the rest is). Then it starts again.
     One update runs at a time, by its process (`run/.updating/pid`, the link's). While it runs,
     `setup` doesn't restart the bridge, and the keeper doesn't run `restore.sh`.
  5. Once the engine answers as the new version (and the coding agents' bridge, if it ran), the
     old bridge goes and the keeper starts the new one. The new bridge confirms the update after
     the relay's welcome or three minutes: what was kept, and other engines, go.
  6. If the new version doesn't come up, `restore.sh` puts back what was there. The keeper runs
     it too when `run/update-trial` is twenty minutes old, five minutes apart (`run/update-restore`).
     After six failed tries it gives up and starts what's there. Without a bridge to start again
     (no phones, no peers), `kuvo-link.js update` confirms it itself.
  7. It notes what it installed (`updates/installed.json`). Each night it checks the files against
     that note. A Mac notes `run/mac-installing` while it puts its files in place, and marking the
     box clears it. Drift seen on two checks, and not while a Mac is installing, means a Mac with an
     older Kuvo Code put its own files back. The box then keeps its version mark, so no other such
     Mac takes it further back, says why, and doesn't update itself for 30 days.
  - What the new engine did during a trial that's rolled back is lost with it.
  - The coding agents' own data (`agents`) isn't kept for a rollback.
- **State**: `run/update.json` holds `{latest, checked, last: {at, result, message?, from?, to?},
  running?, trial?, night?}`.
- `kuvo/update`:
  - `GET` answers `{setUp, version, engine, latest, last, updating, blocked}`.
    `updating` is the step under way (`checking`, `downloading`, `downloading the engine`,
    `checking it`, `installing`, `starting`) or null. `blocked` is why it can't update, or null.
  - `POST {now: true}` starts one: 202 with the status, or 409 `{message}` when it's not set up,
    is blocked, or is updating already. Other methods answer 405: there's nothing to turn off.
  - A Mac does the same over SSH with `kuvo-link.js box update-status` and `update-now`.
- `kuvo-link.js update [--now]` updates from a shell. Only in a test's folder, it also takes
  `--url <boxes.json> --key <public key>`.

## Notifications

What the Mac shows as a notification goes to each paired phone too, as the relay's `push`
with a mail frame, sealed with the sender's static key for the phone's. Its payload, JSON:

```json
{"t": "notify", "title": "Fixer", "subtitle": "kuvo-ai", "body": "Wants to run a command: npm test",
 "category": "permission", "thread": "ses_…", "data": {"session": "ses_…", "request": "per_…"}}
```

| Field | Meaning |
| --- | --- |
| `title` | Who's telling: a bot's name, a session's title, a group chat's name. |
| `subtitle` | Optional: the project, or who in a group chat. |
| `body` | What the Mac shows: the request, the question, the last words of a reply. |
| `category` | What it's about, below. |
| `thread` | What it's grouped under: the session's id, or the group chat's. |
| `data` | Where it opens: `session` or `group`; `request` for a permission or a form, with `requestSession` when the session asking isn't the one shown (a subagent's), and `answerable: "0"` when its notification mustn't answer it from buttons (it can't show all it covers, or some of its text shows as dots); `ask` for a browser ask. |

| Category | When |
| --- | --- |
| `permission` | An agent asks to do something. `request` is the permission. |
| `question` | An agent asks a question, or for a form filled in. `request` is the form. |
| `ask` | An agent browsing asks for a sign-in, a code or a step. `ask` is it. |
| `finished` | A run finished. |
| `failed` | A run stopped with an error. |
| `report` | A bot's run finished: a wake-up's or a watch's news. |
| `message` | Something in a group chat. |

A phone should ignore a category it doesn't know, and show the notification plainly.

The payload stays under 2,500 bytes, so the push fits the 4 KB Apple takes: a body that
doesn't fit is cut, ending in "…". Keys are sorted, as both sides write them.

Who sends it: each box, for what happens on it, so each notice comes once.

- **The Mac**, for its own sessions, its group chats and browser asks, never a machine's. Like a
  machine, it holds each a little while a client is in use there ("kuvo/attention", below).
- **A machine's bridge**, for that machine's sessions (permissions, questions, runs finished
  or failed, bots' news), what agents ask for as they browse there (category `ask`), and its
  coding agents' sessions and the group chats that live there (a meeting held, a bot done with
  its part: category `message`, `data.group`), each as the Mac words it, whether a Mac is
  connected to it or not, and without a group chat's seats, as the Mac does. An ask goes once
  it's still asked a couple of seconds later, so one a connected Mac answers at once with a saved
  password doesn't. An engine run a coding agent's session started (Auto on an engine model)
  tells its news as that session's, once. A Mac connected to the machine shows the machine's
  news in its own notifications, and doesn't send them to your phones.

### kuvo/attention

While you're using a client, each box it's connected to holds your phones' notices a little, so
your phone doesn't buzz for what you're already looking at, were shown, or answer at once.

- **A client in use says so**, for a lease it renews: `POST kuvo/attention` with `{"for":
  <seconds>, "sessions": [<id>, …], "shown": [{"session": <id>, "ask"?: bool, "request"?: <id>},
  …]}`. `for` is how long it's in use from now (the box's clock, so the two clocks needn't agree),
  cut to 60; `0` says it isn't any more. `sessions`, optional, are the conversations on its screen:
  sessions by id, group chats by theirs. `shown`, optional, are notices it just showed you itself:
  each one's conversation, whether it asked you something (`permission`, `question`, `ask`; false
  if left out) or was news, and for what's asked, the request or ask it's about (`data.request`,
  else `data.ask`). The answer is `{"for": <seconds granted>}`; 400 `{message}` for a `for` that
  isn't a number of seconds from 0 up, `sessions` that aren't strings, or `shown` that isn't that;
  405 for another method. `GET kuvo/attention` answers `{"inUse": bool, "held": <count>}`. Each
  client has one lease, a phone by its key; a newer word replaces its last.
- **A Mac** says it for you: in use while it's awake, its screen awake and unlocked, there's been
  input in the last two minutes, and Kuvo Code can show you things there (its window in front, or
  its notifications on), and not while another account is in front. It renews every 15 seconds
  for 45, with the conversations on screen while its window's in front and there's been input
  since its last word, and says it isn't at once as the Mac or its screen sleeps, the screen locks
  or another account comes in front, and at its next word once you've gone idle, or as it quits.
  With its notifications on, each notice it shows you while in use (a notification, unless its
  style in System Settings is None; or, with its window in front, its sidebar and tabs) it says at
  once in `shown`, to the box whose news it was alone: its own, or a machine's. With its
  notifications off it says none. Its own box hears it in the app; each of its machines whose
  bridge talks to peers by mail, `{"attention": {for, sessions, shown?}, "at"}`, taken only from a
  Mac that set the machine up, and only when its `at` isn't older than that Mac's last (mail can
  come out of order). A Mac without the phone link on says nothing.
- **The box**, while any client's lease is current, holds each new notice: 30 seconds for what's
  asked of you (`permission`, `question`, `ask`), 60 for news (the rest). When its hold ends it
  goes, unless meanwhile it was answered (the permission or form replied to, or cancelled; the ask
  no longer asked) or seen. Seen is a client in use saying its conversation (`data.session`, else
  `data.group`, else `thread`) is on its screen, in a word that came after the notice; or that it
  showed it: one `shown` stands for one notice, the one its `request` names, else the oldest of
  that conversation and kind, while it's held or up to 10 seconds before it comes (each box hears
  the engine on its own, so either can come first). Seen news is let go; something seen that's
  asked of you waits until it's answered, or goes once no client is in use. When the last lease
  ends (it ran out, or its client said `0`), what's held goes at once. With no lease, a notice goes
  at once. Holds and leases are timed on a clock a change of the date or time can't move.
- So a client that vanishes (a Mac's lid closed before it could say so) holds nothing back longer
  than a hold or its lease, whichever ends first, and a conversation it last showed doesn't count
  as seen. One a box couldn't hand to the relay (no connection just now) is tried again every few
  seconds, for ten minutes. A machine's bridge keeps what it holds in `run/held-notices.json`
  (with when each was made, by the date), so the next one sends it if it stops first. The Mac's own
  notifications are the same either way.
- A phone needn't say it's in use: it leaves out what's on its screen itself, and its own lease
  would hold its own notices.

## Messages in a session

Each transport message decrypts to:

```
headLength(2) head(JSON) body
```

and is at most 65,519 bytes, so longer bodies go in pieces. The phone asks, the host answers,
like HTTP:

| Head | Meaning |
| --- | --- |
| `{"t": "req", "id": 7, "m": "GET", "p": "api/session?limit=50", "h": {}, "end": true}` | A request. `id` counts up from 1 for each session. `end: false` means `data` pieces follow. |
| `{"t": "res", "id": 7, "s": 200, "h": {"content-type": "…"}, "end": false}` | The response's status and headers, with the first piece of its body. |
| `{"t": "data", "id": 7, "end": false}` | More body. Event streams (`api/event`) go on until cancelled. |
| `{"t": "cancel", "id": 7}` | Either side stops request 7. |
| `{"t": "ping"}`, `{"t": "pong"}` | Is the other end still there? The relay's own pings only reach the relay. The phone pings before sending on a session that's been quiet (a host started again since closes the session, and the phone opens a new one before anything's lost), and while a request waits with nothing from the host (no answer ends the session). Answer at once. |

`h` holds `x-opencode-directory` and `content-type`; the host adds the engine's password
itself. Which route answers is told by its path before any `?`: a query string never changes it,
and a method is read in any case. Both are held to the same route scenarios (`Vectors/routes`). A
host serves:

- `api/…`: passed to its engine, all of its API. A paired phone is yours, with the reach the app
  has on that computer: sessions, files, terminals and commands, accounts and their keys, the
  engine's settings, MCP servers. The host writes the path one way only, and sends exactly that:
  each part between slashes, and each name and value in the query (where `+` is a space), is
  percent-decoded once and encoded again the same way (RFC 3986's characters as they are, any
  other as `%XX`), and empty parts are left out, so `api//session/%73es_1/` is sent as
  `api/session/ses_1` and `%252e` stays `%252e`. Only a path that isn't what it seems is refused
  (403): a fragment or a space at either end, an escape that doesn't decode, a part with a
  backslash or a control character, a part between slashes that holds a slash (`%2F`) or is `.`
  or `..`, or a query name or value with a `..` between its slashes (only the ASCII in a part
  counts for the dots, so a joiner or mark hides neither; `[...slug]` is a name). The commands
  the engine runs for agents: `GET api/shell` (those running in the folder `x-opencode-directory` names),
  `GET api/shell/<id>` and `GET api/shell/<id>/output?cursor=&limit=`; their `shell.created`,
  `shell.exited` and `shell.deleted` come with `api/event`.
  A subagent's session (`metadata.sessionID` of the `subagent` step that started it) is a session
  like any other, which is how the phone watches and talks to one, as the Mac's subagent tab does:
  read its messages, prompt it (`steer` while it works: it reads it at its next step; once it's
  done, it carries on), `POST api/session/<id>/interrupt` to stop it (the agent waiting on it
  hears it was cancelled, and carries on), and choose its model. Choose it without interrupting:
  an interrupt, even with `resume`, ends that agent's wait, and it gives up on the subagent.
- `POST kuvo/shell/<id>/stop` (`{"session": "ses_…"}`, which may be left out): stops a command an
  agent left running, as Stop over the Mac's composer does: SIGTERM to its process group, so the
  engine sees it end and tells the agent, with what it printed; only if that can't be sent, the
  engine's own remove (which deletes the output, and the agent hears the command wasn't found).
  Answers `200 {"stopped": "signal"}` or `200 {"stopped": "removed"}`, or `404 {}` when no such
  command runs. A machine's bridge does it there, with the Mac closed too.
- `kuvo/info`: what the host is and runs: `kind` (`mac` or `machine`), `name`, `engine` (its
  version), a Mac's `app` and a machine's `bridge` version (to show, never to compare: check
  `features`), `features` (below), whether its coding agents' bridge is up (`agents`), and
  `started`, when the engine running now came up, in seconds since 1970 (null while none runs): a
  restart changes it, so a phone tells the new engine from the old. Both name the folder of chats
  (`chats`: conversations of no project, made if it isn't there yet, so a phone can start the first
  one there through the engine, as for a project). A machine's bridge also says whether its engine
  is `running`, and whether it's `stopped` on purpose (it stays down until it's started, from a Mac
  or a phone); a Mac also names `integrations`, each integration's name by its MCP server's
  (`{"microsoft-365": "Outlook and Microsoft 365", …}`), for a card when one asks something.
- `kuvo/agents/api/…`: the coding agents you already have (Claude Code, Codex, Cursor, Grok,
  Antigravity), through the agents bridge beside the host's engine, which answers the same paths
  as the engine for them: sessions, messages, prompts, permissions, questions, events
  (`kuvo/agents/api/event`) and models (`kuvo/agents/api/model`, only signed-in agents'). Its
  sessions carry `metadata.kuvoAgent` and run where that bridge does; a new session with one of
  their models (providers `claude-code`, `codex-cli`, `cursor`, `grok-cli`, `antigravity`) is
  made there, never on the engine. A Mac answers for its own; a machine's bridge for the
  machine's, with the Mac closed too: each machine signs in to them on its own, and has its
  own Custom Auto lists. `kuvo/info` has `agents: true` while the bridge is up; otherwise these
  answer 503. All of its API, but for the two routes only the app wires things with:
  `api/kuvo/engine` (where the engine is) and `api/kuvo/groups` (group chats' own steps, which a
  phone takes through `kuvo/groups`). The same on both (`Vectors/link.json`, `agentRoutes`).
  - Accounts: besides each agent's own sign-in, ones you added, each its own provider
    `<agent's provider>@<id>` (`claude-code@1f2e3d4c`), named `Claude Code · Work` in
    `kuvo/agents/api/integration` (`metadata.accountID`, `metadata.accountLabel`). Their models
    and sessions are theirs. `kuvo/agents/api/kuvo/accounts`: `POST {agent, label}` (agent:
    `claude`, `codex`, `cursor`, `grok`, `antigravity`) → `{data: {providerID}}`, then sign in as
    any; `PATCH …/accounts/<provider> {label}`; `DELETE …/accounts/<provider>`.
    `metadata.signInEnded` true: its maker ended the sign-in; mark the account (the Mac says
    "Sign-in ended") and offer to sign in again.
  - Installing and updating an agent's program (Claude Code, Codex, Grok), on the computer the
    bridge is on: `metadata.installed` false, with `metadata.install` the maker's installer
    command; `POST kuvo/agents/api/integration/<provider>/install` runs it (a few minutes at most)
    → `{data: {installed, version?, message?}}` (`message`: why not, in the installer's words).
    `metadata.outdated` with `version` and `latestVersion`, and `metadata.updates` true when the
    installer that owns it can update it (`updateCommand`, as typed): `POST …/<provider>/update` →
    `{data: {updated, version?, message?}}`. Either one done, `integration.updated` and
    `model.updated` follow. One program serves every account with it, so update one per
    computer; Update All updates each outdated one on every computer.
  - Signing in to an agent: `POST kuvo/agents/api/integration/<provider>/connect/oauth {methodID,
    remote}` → `{data: {attemptID, url, instructions, mode, acceptsCode?, userCode?, time}}`; `GET
    …/connect/oauth/<attempt>` → its status (`pending`, with `url`, `instructions`, `userCode` and
    `message` as they come, for an agent downloaded first, Antigravity;
    `complete`; `failed` with `message`; `expired`); `POST …/connect/oauth/<attempt>/complete
    {code}` for one with `acceptsCode`; `DELETE …/connect/oauth/<attempt>` to give up. A key:
    `POST …/connect/key {key}`. With `remote: true` the page is for another device (the phone),
    so it doesn't come back to the computer's `localhost`: Claude Code's ends on a code to paste
    back (`acceptsCode`), Codex's and Grok's are device codes (`userCode`, shown beside the page,
    to copy), Cursor's finishes by itself, and Antigravity's Google page comes back to
    `http://127.0.0.1:<port>/?…` on the computer: open it in a web view, stop where it's sent
    there, and hand that address to the computer with `kuvo/sign-in/return` (below); the attempt
    then goes on to `complete`. An agent whose sign-in can do that has `metadata.remoteSignIn` true
    in `…/integration` (all five now); for one that hasn't, `remote: true` answers 400: sign in on
    the computer it runs on.
    Signed in, an account's Custom Auto limit goes, as when you sign in there.
  - Custom Auto: a session's model `{providerID: "auto", id: <list ID>}` runs down that list,
    going on with the next model at a usage limit or an error. `kuvo/agents/api/kuvo/auto`: `GET`
    and `PUT {lists}` → `{data: {entries, lists: [{id, name, entries: [{providerID, modelID,
    variant?}]}], limits: [{key, until, scope, known}]}}` (the first list's ID is `auto`;
    `entries` is the first list's; `key` is a provider for an account's limit, `provider/model`
    for a model's; `until` in ms); `DELETE …/auto/limits` tries them all again. The event
    `kuvo.auto.updated` says the lists or their limits changed. An account with a `provider`
    limit whose `until` hasn't come is at its usage limit: mark it (the Mac says "Usage limit ·
    Resets in …").
  - A session with the agents may switch to any model (`…/session/<id>/model`), the engine's
    too: it runs those through an engine session of its own, which carries
    `metadata.kuvo.engineFor` and is never shown (hide it in the engine's session list).
    `…/session/<id>/fork {before}` makes a new session from a message.
- Plan accounts (Copilot, OpenCode, GitLab, Poe, a provider's API key), on a Mac and a machine,
  as Settings › Accounts has them: the phone sees, reads and signs in to them as the app does.
  Each computer keeps its own: a new
  machine starts with a copy of its Mac's keys and of a sign-in that stays the same (Copilot's),
  once, and from then on what's changed on the machine (its Accounts page, or a phone there) is
  the machine's. A sign-in that renews itself (ChatGPT's, GitLab's) is never copied: each machine
  signs in itself.
  - `GET api/integration` and `GET api/integration/<id>`: each plan, its ways to sign in
    (`methods`) and what it's signed in as (`connections`: label and status).
  - A key: `POST api/integration/<id>/connect/key {key, answer?}`.
  - A sign-in page: `POST api/integration/<id>/connect/oauth {methodID, answer?}` → the attempt
    (its URL, `mode`, and `acceptsCode`); `GET …/connect/oauth/<attempt>` for its status; `POST
    …/connect/oauth/<attempt>/complete {code}` for one that ends on a code; `DELETE
    …/connect/oauth/<attempt>` to give up. A page that sends the browser back to `localhost` on
    the computer (GitLab's, Poe's, ChatGPT's) finishes there with `kuvo/sign-in/return` (below).
    Device codes (Copilot, OpenCode Console, SuperGrok) and keys work from anywhere.
  - Its sign-ins: `GET api/credential` (with what each is signed in with), or `GET
    kuvo/accounts/credentials` → `{credentials: [{id, integrationID, label, active}]}`, the list
    alone; `POST api/credential/<id>/activate` uses one; `DELETE api/credential/<id>` removes one.
  - On a Mac only: `GET kuvo/accounts/ended` → `{providers: [id]}`, the plans whose sign-in in use
    ended (the service refused it; the Mac says "Sign-in ended"); `POST
    kuvo/accounts/<provider>/forget` is Disconnect, as Settings › Accounts does it: its sign-ins
    and keys on the Mac, and the copies on your machines.
  What a phone may ask an engine for is the same on both (`Vectors/link.json`, `routes`).
- On a Mac, `kuvo/hosts`: the machines this phone may reach directly, with their addresses
  and static keys, so pairing once with the Mac reaches them all; each with `machine`, its id
  (as a bot's `machine`), and `anotherMac`: its engine is another Mac's, which gives it its
  settings, so this Mac's (`kuvo/config`) don't reach it (as it was when it last connected).
  `removed`: this Mac removed it (it runs on there), and `DELETE kuvo/hosts/<id>` forgets it for
  your phones (`200 {}`; `404` for none; `409 {"message"}` for one this Mac still has).
- `POST kuvo/sessions/<id>/agents` with `{"model": {providerID, id, variant?}}`: a
  conversation the engine runs (on the Mac or a machine it reaches) carried on with the coding
  agents on that model (one of theirs, or Custom Auto's `auto`), as picking it in the
  conversation does: a session of theirs with the whole conversation, what was waiting and its
  draft; the engine's goes to Archived, and a bot's conversation becomes the new one. `200
  {"session"}`, the new one, to open (read through `kuvo/agents/api/…`). Errors are
  `{"message"}`: 400 for a model that isn't theirs; 404 for no such conversation; 409 for one
  with them already, or while it moves; 422 for a model it can't use where it is (signed out);
  503 while the coding agents aren't running there; 502 when the move failed. Nothing opens on
  the Mac. A machine's bridge does the same for its own, with the Mac closed: a phone asks the
  computer the conversation lives on. There the session's wake-ups and watches go
  with it, the engine's is marked `kuvo.carriedTo` (the new one's id) as it's archived, and once
  started it goes to its end, whatever becomes of the request. Changing a machine's bot's model there to
  one of the agents' (`PATCH kuvo/bots/<id>`) carries its conversation on with them too; the Mac
  takes in its new conversation as it next connects.
- `POST kuvo/sign-in/return` with `{"url"}`: where a sign-in's page sent the browser back to the
  computer (`http://127.0.0.1:<port>/…?code=…`: a plan's that finishes there, an MCP server's at
  `127.0.0.1:19876`, a coding agent's), which a phone can't load. The computer loads it, as the
  browser would have: only its own address (127.0.0.1, localhost or [::1], over http, at a port,
  with a query; a fragment is left off), and no further than it answers (a redirect isn't
  followed). `200 {"status"}` with the status it got: 2xx or 3xx, it took it; `400 {"message"}`
  for an address that isn't one; `502 {"message"}` when nothing there answered (start the
  sign-in again). Send it to the computer the sign-in is on: a Mac for its own, a machine's
  bridge for the machine's, the engine's and the coding agents'. The same check on
  both (`Vectors/link.json`, `signInReturns`).
- `kuvo/config`: the computer's own engine settings as Settings has them, the whole document
  (the same that its `opencode.json` holds). Each computer keeps its own ("Settings per box"):
  change a machine's on the machine's bridge, never through the Mac. `PATCH kuvo/config` with `{"changes":
  [{"path": ["mcp", "servers", "linear", "disabled"], "value": true}, …]}` changes some, as
  Settings does (a `null` value removes the key, and a level that isn't there is made; a path
  goes through objects only, so a list is sent whole, at its own path: 400 otherwise), and
  answers with the whole document; the computer's engine takes it at once, and on a Mac a change
  to the rules reaches open sessions. A key a value names where another computer keeps its keys
  (`{file:<its folder>/KUVO_KEY_…}`, from Also Apply) is written as this computer names its own,
  so send it as the other computer has it. A change can say what it read at its path (`"was"`, `null` for
  nothing): changed since, nothing is changed and it answers `409 {"message"}`, so read again.
  `409 {"message"}` too while the file can't be read (it has comments, say): it's changed by
  hand then. Settings › Permissions keeps its choices and rules under `permissions` (a list of
  `{action, resource, effect}`, effect `allow`, `ask` or `deny`) and its blocks under `policies`.
  A machine's bridge answers `kuvo/config` and `kuvo/mcp/catalog` for the machine's own, and
  `409 {"message"}` until a Mac has made its settings its own ("Settings per box").
- On a Mac, `kuvo/mcp/catalog`: Settings › MCP Servers' popular servers, `{"servers": [{id,
  title, summary, access, added, integration, macOnly}]}` (a machine's bridge for the machine,
  without `macOnly` ones): `access` is `signIn`, `open` or `local`; `integration` when Integrations added it (it's kept there, with its sign-in: don't turn
  it off or remove it); `macOnly` for one that uses the Mac's own apps (Chrome DevTools), which
  never reaches your machines, so leave it out of a machine's list. `POST kuvo/mcp/catalog/<id>`
  adds one as its Add button does and answers with the settings, as `kuvo/config`; turn one off
  or remove it through `kuvo/config` (`mcp.servers.<name>`). The rest is the engine's: each
  server's status from `GET api/mcp`, connecting again with `POST
  api/experimental/mcp/<name>/connect`, a server's sign-in through `api/integration/<id>/connect/…`
  (its page comes back to `127.0.0.1:19876`: `kuvo/sign-in/return`), and the approvals saved for
  a project with `GET api/permission/saved?projectID=` and `DELETE api/permission/saved/<id>`.
- `kuvo/keys`: the computer's own integrations' keys (`KUVO_KEY_<INTEGRATION>_<NAME>`, as its
  settings name them; a bot's own aren't among them). `GET kuvo/keys` lists them, `{"keys":
  [name]}`; `GET kuvo/keys/<name>` answers `{"value"}` (404 for none, 400 for a name that
  isn't a shared key's), `PUT` with `{"value"}` sets one and `DELETE` removes it. On a Mac they're
  in its Keychain; on a machine in `~/.kuvo-code/box/keys` (`409 {"message"}` until its settings
  are its own).
  The engine reads one as it next reads its settings, so set the key before adding what names it
  (`kuvo/config`). An integration added on a machine names its keys
  `{file:~/.kuvo-code/box/keys/<name>}` there; on a Mac, `{file:<its keys' folder>/<name>}`.
  "Also Apply to…" on a phone is the same changes (`kuvo/config`) and keys made on each computer
  you pick: a list gets what was added and loses what was taken out, keeping the other's own.
- Integrations, as Settings › Integrations has them, each computer its own (a Mac for its own,
  keys in its Keychain; a machine's bridge for the machine's, keys in
  `~/.kuvo-code/box/keys`, from the catalog its Mac leaves in `bin/integrations.json`, with the
  Mac closed too; `409 {"message"}` until its settings are its own).
  - `GET kuvo/integrations` → `{"integrations": [{id, title, summary, kind, symbol, site, how,
    way, keys?, help?, redirect?, by?, macOnly?, added, keysSaved?, health?, signIn?, siteSignedIn?}],
    "problem"?}`, by kind in the page's order (`kind` is its title: "Mail and Calendar", "Chat",
    "Social", "Code and Work"). `way`: `official` (connect, then sign in), `token` (its maker's
    server, with a token you bring), `app` (your app's client ID and secret, made with `redirect`,
    then sign in), `package` (an open-source server, `by`, with the keys you bring; `macOnly` for
    one that uses the Mac's own apps, which a machine's catalog leaves out) or `browser`
    (the agent uses its site in the computer's browser: not added here; `siteSignedIn` says
    whether it's signed in there, on a Mac). `keys`: `[{name, label, prompt}]`, `keysSaved`
    whether the computer has them. `how` is the tag the page shows. Added: `health` is
    `connected`, `starting`, `waitsForCode` (on a Mac: Outlook, until its first use's code), `needsSignIn`,
    `failed` or `disabled` (turned off in MCP Servers, its settings' `disabled`: it won't start
    until it's turned on, so there's nothing to wait for; a Mac's Settings says "Off", with Turn
    On), and `signIn` is the
    engine's integration to sign in with, through
    `api/integration/<signIn>/connect/oauth` as any (its page returns to `127.0.0.1:19876`:
    `kuvo/sign-in/return`). `problem`: the settings file can't be changed.
  - `POST kuvo/integrations/<id>` with `{"keys"?: {"<name>": "<value>"}}` adds it, as Connect
    (or Add Key…) does: with the keys given, or those the computer has; one added already is
    written again (the engine reads its keys again), and with new keys its server connects again a
    moment later. `200 {"integration"}`, as listed; `400 {"message"}` without the keys it needs;
    `404` for none; `409 {"message"}` for one used on its site, or a settings file that can't be
    changed; on a Mac, `500 {"message"}` when the Keychain wouldn't keep its keys.
  - `DELETE kuvo/integrations/<id>` removes it, as Remove… does: its keys, its sign-in, what its
    server kept, and bots' own keys for it there (each computer keeps its bots' keys itself: "Bots'
    own keys"). `200 {}`, `404` for one not added, `409 {"message"}` for a settings file that can't
    be changed. A Mac's Remove… for a machine is the machine's own, through `box route`.
- Bots' own keys, as Edit Bot shows and changes them: a key a bot has of its own for an
  integration you bring a key for, used only in its conversation, kept on the computer the bot
  lives on (a Mac's bots' in its Keychain; a machine's in `~/.kuvo-code/box/bot-keys`, with the
  Mac closed too). Each computer answers for its own bots; a Mac asked about a machine's
  bot answers `409 {"message"}`. A bot that works in a project uses that project's keys, and
  answers `409 {"message"}`.
  - `GET kuvo/bots/<id>/keys` → `{"keys": [{integration, own, shared, title, symbol, keys, help?}]}`:
    each integration a bot can have a key of its own for (those you bring a key for, `token` and
    `package` ones with keys), whether it has its own, whether the computer has a shared one, and,
    as `kuvo/integrations` has them, its name, symbol, the keys it takes (`[{name, label,
    prompt}]`) and where to get them.
  - `kuvo/bots/<id>/keys/<integration>`: `GET` → `{"keys": {"<name>": "<value>"}}`, its own (`404`
    for none); `PUT {"keys": {"<name>": "<value>"}}` gives it its own, all of them (`400
    {"message"}` without), and its folder's settings name the integration's server with them, which
    connects again a moment later in its folder: `200 {integration, own, shared}`; `DELETE` takes
    them away (`404` for none). `409 {"message"}`, with nothing changed, when its folder's settings
    aren't plain JSON.
  - `DELETE kuvo/bots/<id>/keys` takes away every one, as it moves off the computer.
  - Moving a bot (Move to Computer), its keys go with it: read where it lived, given where it
    goes, then taken away where it was.
- Skills, as Settings › Skills has them, each computer its own (a Mac for its folder, a machine's
  bridge for its `~/.kuvo-code/config/opencode/skills`, with the Mac closed too). Its
  engine lists them (`api/skill`) and finds a change within a moment.
  - `GET kuvo/skills` → `{"folder", "github": {"<name>": {repository, path}}}`: the folder as its
    engine names skills' paths in it, and which skills came from GitHub (the rest you added).
  - `kuvo/skills/<name>` (its folder's name): `GET` → `{"text"}`, its SKILL.md; `PUT {"text",
    "new"?}` writes it (`new`: a new one, named as Settings names one, lowercase a to z, digits and
    hyphens, and `409 {"message"}` when the name is taken, by a folder there or a skill the engine
    lists from elsewhere; without it, `404` for none, and `409 {"message"}` for one from GitHub,
    which stays as it came, as in Settings); `DELETE` puts its folder away (the Mac's Trash, or
    `~/.kuvo-code/trash/skills`, kept 30 days from then). `400 {"message"}` for a name that isn't
    a folder's. A 404 or 405 answers `{}`.
  - GitHub's collections, which the computer reaches, never the phone: `GET kuvo/skill-library`
    → `{"repositories": [{id, owner, name, title, summary}]}`, the well-known ones; `GET
    kuvo/skill-library/<owner>/<name>` (any repository on GitHub) → `{"repository", "skills":
    [{name, path, files}], "partial"}` (`partial`: GitHub cut a very big one's list short); `GET
    kuvo/skill-library/<owner>/<name>/about?path=<path>` → `{name?, description?}` from a skill's
    SKILL.md, asked for as each one shows (a big collection has hundreds); `POST
    kuvo/skill-library/install {"repository": "owner/name", "path"}` → `{"name"}`, installed
    under its folder's name. Errors are `{"message"}`: 404 for a repository or skill there isn't,
    409 for a name that's taken, 503 while GitHub is limiting requests, 502 when it couldn't be
    reached.
- On a Mac, Settings › Machines: the machines it runs sessions on (a machine's bridge doesn't
  answer these).
  - `GET kuvo/machines` → `{"machines": [{id, name, otherAddresses, connection, status, failure?,
    action?}], "hosts", "folded"?}`, in the page's order. `connection` is `notConnected`,
    `connecting`, `reconnecting`, `installing`, `connected`, `failed` or `stopped`; `status` says
    it in the page's words, `failure` why it couldn't connect. `action` is the one button the
    page shows for it now: `disconnect`, `start` (its engine was stopped by a Mac with an older
    Kuvo Code), `connect` or `connectNow` (it's trying again by itself). `hosts`: the hosts in the
    Mac's `~/.ssh/config` not added yet, as Add a Machine suggests them. `folded` `{address,
    machine}`: the address last found to be a machine already here, to say so. `GET
    kuvo/machines/events` follows the same, a line each time it changes (NDJSON).
  - `POST kuvo/machines {"destination"}` adds one as Add a Machine does (a Host from the Mac's
    `~/.ssh/config`, or `user@host`): checked over SSH first, which can take a while, and stopped
    if the request goes. `200 {"machine", "known"}`: `known` when it was one already here (at that
    address, or another reaching the same computer, which keeps it as one of its addresses).
    `400 {"message"}` for a destination that can't name one (a port or a path in it), `502
    {"message"}` when it couldn't be reached or can't run the engine.
  - `POST kuvo/machines/<id>/connect`, `/disconnect` or `/start`: the button's action, only when
    it's the one `action` names (`connect` for both `connect` and `connectNow`); `200
    {"machine"}`, `409 {"message"}` otherwise. Disconnect leaves it running there. `DELETE
    kuvo/machines/<id>` removes it as Remove… does: off this Mac, running on there with its
    sessions, bots, sign-ins and keys, and still in `kuvo/hosts`: `200 {}`. `POST
    kuvo/machines/<id>/uninstall` does as Uninstall from <machine> does: also stops its engine
    there and deletes the sign-ins and keys it keeps, and it leaves `kuvo/hosts`: `200 {}`.
  - `DELETE kuvo/machines/<id>/addresses/<address>` stops using one of its other addresses (`404`
    for its name, or one it doesn't have); `POST kuvo/machines/<id>/same-as {"other"}` makes it one
    of `other`'s addresses, as Same Computer As does: `200 {"machine"}`, the other; `404` when
    `other` isn't another of the Mac's machines; `409 {"message"}` when the two told Kuvo Code
    different names and stay two machines.
- Settings › Worktrees: the git worktrees sessions run in, each computer its own (a Mac for its
  own; a machine's bridge for the machine's, kept in `~/.kuvo-code/box/worktrees.json`, with the
  Mac closed too). A Mac makes and removes a machine's through the machine's routes (`box route`),
  and reads them from it. Each computer names its own worktrees' branches after their session once
  that has a title: a machine whether a Mac is connected or not, and a Mac never a machine's.
  - `GET kuvo/worktrees` → `{"worktrees": [{path, folder, project, projectName, branch, base?,
    sessions, working, uncommitted?, ahead?, size?}]}`: `path` is the worktree's folder, `folder`
    where its session runs (the project's place in its repository), `project` its project's,
    `sessions` how many run there and `working` whether an agent is at work in one.
    What git says, left out when it can't say (a folder deleted by hand): `uncommitted`, changes
    not committed, which go when it's removed; `ahead`, commits `base` doesn't have, whose branch
    stays when it's removed. `size` in bytes. Where new ones go is `kuvo/config`'s
    `worktree.directory`. On a machine, `?records=1` → `{"worktrees": [{project, root, folder,
    branch, base?, made?, prefix?}]}`, as it keeps them (without asking git), any whose session
    has a title by now named first; `made`, the branch one made there started on, and `prefix`,
    what its name starts with.
  - `POST kuvo/worktrees/remove {"path", "discard"?}` removes it as Remove… does: its folder and
    anything in it not committed (`"discard": false`: one with changes stays, `409`); its branch
    stays unless it's merged (`"forget": true`: it goes anyway, for one made for a session that
    never started, on a Mac and a machine; `409` when a session has it after all). `200 {}`; `404` for none; `409 {"message"}` while an agent works
    there; `502 {"message"}` when the engine couldn't remove it. `404 {"message"}` for one it
    doesn't have (removed already): a Mac takes it as gone.
  - For a new session's worktree, as the composer's Worktree makes one: `POST kuvo/worktrees
    {"project", "branchPrefix"?}` makes one of the project's repository on a branch of its own →
    `{project, root, folder, branch, base?}` (a machine's also `made`, `prefix`; a Mac uses its
    own prefix, from Settings › Git); make the session in `folder`, and the computer tells it it
    works in a worktree. `400` for a
    project that isn't a folder there, `409 {"message"}` when it isn't in a git repository, `503`
    while the engine isn't running. On a machine, `POST kuvo/worktrees/record {project, root,
    folder?, branch, base?}` keeps one a Mac made there before machines kept their own ("For
    released Macs"; `404` when it isn't there any more).
- On a Mac, `kuvo/mac`: Settings › General's While Agents Work. `GET` → `{openAtLogin, keepsAwake,
  awakeNow}`: whether Kuvo Code opens at login, in the background; whether it keeps the Mac awake
  while agents work; and whether it's doing so now. `PATCH` with either setting answers the same;
  `409 {"message"}` when macOS didn't change Open at Login, and then nothing changed.
- On a Mac, `GET kuvo/claude-code[?machine=<id>]`: what Settings › Agents and Settings › Commands
  offer to bring over from Claude Code (the Mac's `~/.claude/agents` and `~/.claude/commands`) to
  that computer (the Mac without `machine`; `404` for a machine that isn't one of its own):
  `{"agents": [{name, description, path, settings, imported}], "commands": [...]}`. An agent's
  `name` is the one it's shown by; a command's is the one it comes over as, `<name>-claude` when
  that computer has one by its name already (the engine's own, a plugin's or an MCP server's, as
  its page reads them while it's connected). Import is writing `settings` at `path`
  (`["agents", "<id>"]` or `["commands", "<name>"]`) through that computer's `kuvo/config`;
  `imported` says whether its settings have it there.
- `POST kuvo/engine/restart`: the computer's engine starts over, as Settings › Engine's Restart
  does on a Mac; what's running in it stops. It answers `202 {}` first. On a Mac the link goes
  down with the engine, and the Mac is back once it answers again (`kuvo/info`). A machine's
  bridge stays up, starts its engine over as it was last started (with its coding agents'
  bridge), and a Mac connected to it goes on with the new one; one never started from a Mac
  answers `409 {"message"}`.
- `POST kuvo/engine/start` (a machine's bridge): for an engine a Mac with Kuvo Code 0.7 or
  before stopped (its Stop; `kuvo/info` says `stopped`), which stays down, through restarts of the
  machine too, until Start; meanwhile the link answers and the routes that need the engine answer
  503. Start answers `202 {}` and the engine is up once `kuvo/info` says `running`; it answers
  `409 {"message"}` on a machine never started from a Mac, as restart does. There's no stop: a
  machine's engine keeps running.
- `kuvo/bots`: bots by their session, with their `id` (`bot_…`, as group chats name their
  members), their name, look and job, whether their wake-ups are paused, the next one (`wakes`,
  left out when none waits), how many things each watches, `machine` (the machine it lives on,
  left out for the Mac), and `agents`: its conversation is with the coding agents, so it's read
  and written through `kuvo/agents/api/…` (a group chat's members carry the same flag).
  `personality` (its id) and `model` (`{providerID, id, variant}`) are the ones Edit Bot shows,
  left out when it has none. A Mac lists all of yours, wherever they live. A machine's bridge
  lists the bots that live on that machine, as their folders are now, with the Mac closed too:
  their name, look and job as the Mac last wrote them there (`bot.json`, which the Mac writes
  when they change and each time it connects, and the bridge when a phone changes them; one it
  hasn't written yet isn't listed). The bridge also reads a bot's job from its memory as each of
  its runs ends, as a Mac does for its own, and tells its conversation when it changed, whether a
  Mac is connected or not. `?memory=1` adds `memoryJob`, the job as its memory has it now:
  `{line, section}` (both `""` for a memory without one; left out when its memory can't be read),
  which a Mac takes for its copy of the machine's bots. For a machine's bot, its machine's list is
  the newer while it answers.
- On a Mac, making a bot as New Bot does. `GET kuvo/bots/templates` is what New Bot offers:
  `{"templates": [{id, name, job, instructions, look, personality, wantsProject}],
  "personalities": [{id, name, description, custom}], "looks": {colors, shapes, faces},
  "startingModel": {"mac": {providerID, id, variant} | null, "<machine id>": … | null},
  "projects": [{directory, name, machine}]}`. A template's `personality` and a project's
  `machine` (null for the Mac) are left out when there's none. `startingModel`'s keys are the
  places a bot can live (the Mac and each machine), each with the model New Bot starts with
  there. `POST kuvo/bots` with `{name, look?, personality?, model?, machine?, project?,
  template?}` makes one: `personality` by id (`preset.*`, or `custom.*` for one you made);
  without `look` or `personality`, the template's, or a random look; without `model`, that
  place's starting model; a `project` on a machine makes it there (`machine` is then ignored).
  It answers `201 {"bot": <as kuvo/bots lists one>, "firstMessage"}`: from a template, the bot
  waits, and `firstMessage` is its job for your composer, to edit and send; otherwise it's null
  and the bot writes first. Errors are `{"message"}`: 400 for a missing name or an unknown
  template, personality, machine or project; 409 while its machine isn't connected; 422 for a
  model that can't run there (its account isn't signed in there); 503 when it couldn't be made.
- `PATCH kuvo/bots/<id>` with any of `{name, look, personality, model}` changes a bot as Edit Bot
  does (`personality: null` for the model's own way, `model` as `{providerID, id, variant?}`):
  `200 {"bot": <as kuvo/bots lists one>}`, after a coding agent's model for a bot on the engine
  has moved its conversation to them (its `session` is the new one, `agents` true; if the move
  can't happen yet, its machine away, the model is kept and it moves once it can). Errors are `{"message"}`: 400 for an empty name, or a
  look or personality there isn't; 422 for a model it can't use where it lives (the one it has is
  always kept); 404 for no such bot; 409 while it moves; 503 when it couldn't be changed (a
  machine's engine is stopped). `DELETE kuvo/bots/<id>` deletes it as Delete Bot… does, its
  conversation, wake-ups and folder (to the Trash, or to `~/.kuvo-code/trash` on a machine):
  `200 {}`, 404, or 409 `{"message"}` while it moves. A Mac answers both for every bot it lists:
  a machine's bot is changed at once and its conversation told once the machine is connected, as
  from Edit Bot, while deleting one answers 409 `{"message"}` until it's connected. A machine's
  bridge answers both for its own bots, with the Mac closed too: a change reaches
  the bot's conversation as the Mac words it, except that only a Mac carries a conversation on the
  engine over to the coding agents (422 for a coding agent's model there); a deleted bot leaves
  the group chats there too, and is noted in `~/.kuvo-code/bots/deleted.json`. The Mac takes both
  in the next time it connects. Send them to the Mac while it answers.
- On a Mac, `POST kuvo/groups` with `{name, members, purpose?, meeting?}` (members by bot `id`,
  at least two) makes a group chat on the Mac, as New Group Chat does: `201 {"group": <as
  kuvo/groups lists one>}`, 400 `{"message"}` without a name or two bots, 404 `{"message"}` for
  a bot that isn't there. Moving it to a machine is the Mac's Move to Computer.
  `meeting` is `{next, every?, topic?}`: `next` in seconds since 1970, `every` as kuvo-wake writes
  it (`1d`, `weekdays`, `1w`…; null or left out for once). The computer the chat lives on sets it
  up as Edit Group Chat does (`BotGroup.Meeting.planned`, held to the agents bridge's
  `planMeeting` by `Agents/test/groups-vectors.json`), on your clock, to the minute: a repeating one whose time
  has passed comes at its next round, weekdays skip the weekend, a time of day (and a week's day)
  is kept from then on, and an empty topic gets the default. 400 `{"message"}` for a one-off whose
  time has passed or a repeat there isn't. The chat lists it as `meeting: {next, every, topic,
  at, weekday}`.
- `PATCH kuvo/groups/<id>` with any of `{name, purpose, members, meeting}` changes the chat as
  Edit Group Chat does (an empty `purpose` is none, `meeting: null` none): `200 {"group"}`, 400
  `{"message"}` for what can't be (no name, fewer than two bots, a bot that doesn't live where
  the chat does, a meeting as above), 404 for no such chat or bot, 409 while it moves. A Mac
  answers it for every chat it lists, a machine's bridge for those that live there;
  `kuvo/groups/events` says what changed at once.
- `DELETE kuvo/groups/<id>` deletes the chat as Delete Group Chat… does: its messages and seats
  go, and its bots forget it. `200 {}`, for one that's gone already too; 409 `{"message"}` while it
  moves; 503 `{"message"}` when its machine, or the coding agents' bridge there, can't be reached.
  A Mac answers it for every chat it lists, a machine's bridge for those that live there;
  `kuvo/groups/events` leaves it out from then on.
- A machine's bridge answers the same three, with the Mac closed too: what New Bot
  offers there (`startingModel` has one key, the machine's name as its bots' `machine` has it,
  and `projects` are its own); a bot made there, with its folder, conversation and instructions,
  listed at once (`machine` is ignored); a group chat of its own bots, which lives and runs there.
  What New Bot needs comes from the Mac, which gives it to the machine each time it connects, or
  from the box's own release (`bin/bot-kit.json`) where that's newer (it updated
  itself since) or no Mac gave it one, with what's the machine's own filled in (its name, and the
  time zone a Mac gave it, or else its own); one with neither answers `409 {"message"}`. The Mac takes in the bots a machine made
  the next time it connects (its group chats it follows there already).
- `kuvo/named`: who you can name with `&` in a message, as the Mac's composer offers them:
  `{"agents": [{session, name, kind, machine, project, about}]}`, every bot (`kind: "bot"`,
  `about` its job) then the latest sessions with a title (`kind: "session"`, `project` its
  project's name, `"Chats"` for a chat); `machine` is null for the computer asked, else where it
  lives: a machine's id, or, asked of a machine, a Mac's name for that Mac's own. A machine's
  bridge answers it too, with the Mac closed: its own, then those its other computers told it of
  (`Peers`). Insert
  `&` and the name, and send the message as it is: the Mac adds to a prompt it passes on
  (`api/…` and `kuvo/agents/api/…`) a block naming each agent the text names, which the
  agent reads, so a machine's bridge, with the Mac closed, sends it without. Show a message
  without it: it ends the text, from a line `<named-agents>` (then a heading line, then
  `- &<name> (<session>): <what it is>` lines) to a line `</named-agents>`, before the
  `<review-comments>` and `<attached-files>` blocks. Show each `&<name>` it lists in bold
  (a bot's in its color), opening that session.
- A prompt a phone sends (`POST api/session/<id>/prompt`, and `kuvo/agents/api/…` alike) gets a
  block at the end of its text that tells the agent it's from the phone: a line `<from-phone>`,
  the words in `FromPhone.swift`, and a line `</from-phone>`. The Mac adds it, and a machine's
  bridge in the same words with the Mac closed; send the text without it. Show a
  message without it (everything from a line `<from-phone>` to the line `</from-phone>`), as
  sent from the phone. It tells the agent to keep replies short and to show files with
  `show_file`.
- An agent shows a file in the conversation with `show_file`, one of Kuvo Code's tools (on the
  Mac and machines, for the engine and the coding agents): a tool call named
  `kuvo-browser_show_file` with input `{"path": "<full path on the computer it runs on>",
  "caption"?}`, which fails when the path isn't a file. Show a completed one in the
  conversation's flow, as `generate_image`'s: a picture (by its extension) large, any other
  file as a row that opens it, its caption under it; get its bytes with `kuvo/file` from the
  computer the session runs on.
- `kuvo/wakes/<session>`: a session's (or chat's) wake-ups and watches, which its
  agent sets with `kuvo-wake`, as the bar over the Mac's composer shows them: `{"wakes": [{id,
  due, note, every}], "watches": [{letters, every, check, note}], "paused"}` (`due` in seconds
  since 1970, `every` like `1d` or null; paused while it's archived: archive it as the Mac does,
  `PATCH api/session/<id>` with `{"metadata": {"kuvo.archived": true}}` (`false` brings it back),
  and its wake-ups wait, or come back, when the flag changes (it can go with every change to its
  metadata); a Mac sees to it, and a machine's bridge does with the Mac closed too;
  a pause of your own stays through both). `POST kuvo/wakes/<session>` with `{"due", "every"?,
  "note"}` adds one, as the bar over the Mac's composer does (`due` at least a minute away;
  `every` 30m, 2h, 1d, 1w or weekdays, at least 5m), with the computer's own clock and weekends;
  `400 {"message"}` for what can't be one, `409` with 50 waiting. `POST
  kuvo/wakes/<session>/pause` with `{"paused": true}` holds them (a pause of your own), `false`
  lets them go. Both answer the list as it is then. `POST
  kuvo/wakes/<session>/cancel` with `{"wake": "<id>"}` or `{"watch": "<letters>"}` cancels one;
  `POST kuvo/wakes/<session>/now` with `{"wake": "<id>"}` sends it now (one that repeats still
  comes back at its time). Both answer `200 {}`, `404 {}` when there's no such one, `409
  {"message"}` while its conversation is on its way to another computer, or `503 {"message"}`
  when it couldn't go. A Mac answers for its sessions and its machines'; a machine's bridge for
  its own sessions and bots, with the Mac closed too (a session that keeps none answers an empty
  list). A wake-up reaches the conversation as a
  message starting with `[Wake-up] `. `GET kuvo/wakes` lists every session with a wake-up or a
  watch at once, for the marks beside them in a list: `{"sessions": [{session, next, watching}]}`
  (`next`, the soonest, in seconds since 1970, left out when it has none). Bots' come with
  `kuvo/bots`. A Mac lists its sessions' and those it has read of its machines'; a machine's
  bridge its own.
- On a Mac, `kuvo/asks`: what agents ask you for while they browse, on the Mac or a machine: a
  sign-in (the fields the page has, and the accounts Passwords keeps for the site, never
  their passwords), a one-time code, or a step only you can do. `kuvo/asks/events` is the same
  list as a response that doesn't end: a line of JSON now, and another each time it changes.
  `POST kuvo/asks/<id>` answers one: `{"answer": "signIn", "username", "password", "save"}`
  (or `"saved": "<account>"`, which the Mac fills in from Passwords itself), `{"answer":
  "code", "code"}`, `{"answer": "done"}` or `{"answer": "declined"}`. What's typed goes into
  the page, never to the agent.
- A machine's bridge answers the same three for what's asked in that machine's
  browser, with the Mac closed too: `saved` is empty and `offersToSave` false (saved passwords
  are the Mac's), and a `saved` answer gets `400 {"message"}`. A Mac connected to the machine
  lists the same asks, by the same `id`: the first answer counts, and the ask goes from both.
  The browser keeps them in `~/.kuvo-code/run/browser-asks.json` for the bridge, and waits the
  whole 15 minutes for an answer while the bridge runs, rather than a few for a Mac.
- On a Mac, `kuvo/groups`: your group chats, with their bots (face, name, session), who's
  talking, whether one is under way or paused, and the last thing said; `kuvo/groups/events`
  streams that list as it changes, and `kuvo/groups/<id>/events` one chat's latest messages,
  the same way. `POST kuvo/groups/<id>` writes to it (`{"text"}`); `…/stop`, `…/keep-going`
  and `…/viewed` do what they say; `…/undo` (`{"message"}`) takes a message of yours back and
  answers with what was taken. A wrap-up can carry `tasks`, who does what: each with `id`, `bot`,
  `task`, `state` (`proposed`, `waiting`, `working`, `done` or `failed`), `started`/`finished`,
  and `after` (the bots whose parts come first; it waits for them);
  `…/start` (`{"message"}`, the wrap-up) hands each proposed part to its bot's own conversation.
  While a bot talks, one chat's events carry `activity`, what it's doing, its last step:
  `{"kind": "tool", "call"}` (a tool call as a message's `steps` hold them, without its output),
  `{"kind": "thinking", "text"}` (the line its thinking is on) or `{"kind": "writing"}`. Show
  them under who's talking, so a long turn doesn't look stuck. A line of one chat's events whose
  messages are as they were leaves `messages` out (only who's talking or what they're doing
  changed): keep the ones you have. The first line always has them.
  A bot's message with `report` (a task's id) is it reporting back on its part. Times are
  seconds since 1970.
  A Mac lists all of yours: its own, and those that live on your machines (whose bots all live
  there), which it follows from there; each with `machine`, the machine it lives on (by id, as a
  bot's `machine`; none for the Mac), and `moving` while it's on its way to another computer
  (one chat's events say it too): what you'd write waits until it's there, and `POST
  kuvo/groups/<id>` and `…/undo` answer 409 meanwhile, as they do while its machine is away.
  A machine's bridge answers the same routes, in the same shapes, for the chats that
  live on it, with the Mac closed too: the coding agents' bridge there runs them, and answers
  them itself (at `api/kuvo/link/groups…`, which the link passes on as it answers, a followed one
  line by line), with every rule of what can be made or changed (503 while it isn't up or isn't
  answering: ask again; 404 only when none run there). One moving between computers isn't listed
  where it's going until it's there. Moving one is on the Mac (Move to Computer), not the phone.
  `kuvo/groups/joinable` says who can be in a group chat made there: `{"bots": [<as a chat's
  members list them>]}`, every bot that lives there, the first made first, then the bots of your
  other computers that take a chat's turns ("Peers", group chats), each with `computer` (its
  computer's name). Offer exactly those in New Group Chat and Edit Group Chat for that computer
  (`features`: `groups.joinable`). A chat's members list a bot of another computer the same way,
  with `id`, `name`, `session` and `computer`.
- `kuvo/file?uri=<file:// URI>`: a file on that computer that an agent's reply or tool names
  (a picture it made, a file it shows you), by its `file://` address, percent-encoded as a query
  value: `200` with its bytes and `content-type` (from its extension; `application/octet-stream`
  when unknown), `404 {"message"}` for one that isn't there or isn't a file, `413 {"message"}`
  over 25 MB, `400 {"message"}` for an address that isn't `file://`. A Mac answers for its own
  files; a machine's bridge for the machine's, with the Mac closed too.
- On a Mac, `kuvo/usage`: the menu bar's usage panel as its Bars view lists it (each provider's
  name, plan, brand color, mark as a PNG to tint, notice, whether it's outdated, and its lines as
  UsageKit writes them), whether a refresh is under way and when the last one ended;
  `kuvo/usage/events` streams it as it changes, and `POST kuvo/usage/refresh` refreshes it all.
  A Mac without the usage panel answers 404. Times are seconds since 1970.

### Features

`kuvo/info`'s `features` names the routes the box has, so a client checks a name, never a version
(`app`, `bridge`), before it shows what needs a route. A route it names can still refuse for now,
with a message to show: `503` while the engine or the coding agents' bridge is down, and on a
machine `409` for `config`, `keys`, `mcp.catalog` and `integrations` until a Mac has made its
settings its own. A name comes with what it names and never changes meaning; one the client
doesn't know, it ignores. Both boxes are held to their lists by
the route scenarios (`Vectors/routes/routing.json`).

| Name | What it answers |
| --- | --- |
| `accounts.credentials` | `kuvo/accounts/credentials` |
| `agents` | `kuvo/agents/api/…`: the coding agents (`agents` in `kuvo/info` says whether their bridge is up now) |
| `asks` | `kuvo/asks`, `…/events`, and answering one |
| `attention` | `kuvo/attention` |
| `bots` | `kuvo/bots` |
| `bots.make` | `kuvo/bots/templates` and `POST kuvo/bots` |
| `bots.edit` | `PATCH` and `DELETE kuvo/bots/<id>` |
| `bots.keys` | `kuvo/bots/<id>/keys…` |
| `config` | `kuvo/config` |
| `keys` | `kuvo/keys…` |
| `mcp.catalog` | `kuvo/mcp/catalog…` |
| `engine.restart` | `POST kuvo/engine/restart` |
| `file` | `kuvo/file` |
| `groups` | `kuvo/groups`, `…/events`, one chat's events, and writing, stopping, keep going, viewed, undo and start |
| `groups.make` | `POST kuvo/groups` |
| `groups.edit` | `PATCH kuvo/groups/<id>` |
| `groups.delete` | `DELETE kuvo/groups/<id>` |
| `integrations` | `kuvo/integrations…` |
| `named` | `kuvo/named` |
| `personalities` | `kuvo/personalities…` |
| `phones` | `kuvo/phones` and `POST kuvo/phones/remove` |
| `phones.pair` | `kuvo/phones/pair` |
| `sessions.agents` | `POST kuvo/sessions/<id>/agents` |
| `shell.stop` | `POST kuvo/shell/<id>/stop` |
| `sign-in.return` | `POST kuvo/sign-in/return` |
| `skills` | `kuvo/skills…` and `kuvo/skill-library…` |
| `wakes` | `kuvo/wakes`, a session's, and cancelling one or sending it now |
| `wakes.edit` | adding one (`POST kuvo/wakes/<session>`) and pausing them |
| `worktrees` | `kuvo/worktrees…` |
| `engine.start` | a machine only: `POST kuvo/engine/start` |
| `groups.joinable` | a machine only, for now: `kuvo/groups/joinable` |
| `groups.seats` | a machine only, for now: its bots take turns in chats on other computers ("Peers", group chats) |
| `update` | a machine only: `kuvo/update` |
| `accounts.ended` | a Mac only: `kuvo/accounts/ended` and `POST kuvo/accounts/<provider>/forget` |
| `claude-code` | a Mac only: `kuvo/claude-code` |
| `hosts` | a Mac only: `kuvo/hosts…` |
| `mac` | a Mac only: `kuvo/mac` |
| `machines` | a Mac only: `kuvo/machines…` |
| `usage` | a Mac only, while it has the usage panel: `kuvo/usage…` |

The engine's own routes (`api/…`), sockets and `kuvo/info` itself are always there.

### Sockets

A request with `h.upgrade = "websocket"` opens a WebSocket on the host's engine; today only a
terminal's (`api/pty/<id>/connect`). Its body is empty. The host answers `res` with `s: 101`
once the engine's socket is open, or another status and `end: true` if it won't open. Then
each `data` message for that `id`, either way, is one message on the socket: text, or binary
if `h.type = "binary"`. Text from the engine too long for one message goes in several;
binary that long doesn't go. The phone closes it with `cancel` (or `data` with `end: true`);
when the engine closes it, the host sends `data` with `end: true`.

## Pairing

A host shows a link, as a QR code:

```
kuvo-link://pair?v=1&relay=<relay URL>&host=<address>&key=<static key>&token=<16 bytes>&name=<name>
```

The phone opens a session with `pair` set to the token. The host checks it (and on a Mac
asks you to confirm), then keeps the phone's static key. A token works for 10 minutes and
once.

On a machine the bridge keeps its state in `~/.kuvo-code/run/link.json` (mode 600):

```json
{"relay": "wss://…", "secret": "…", "key": "<static private key>", "sign": "<signing key's seed>", "mac": "<the last Mac's static key>",
 "macs": ["<each Mac that set it up>"], "macSigns": {"<Mac>": "<its signing key>"}, "macSeen": {"<Mac>": <when it came, here>},
 "docs": {"<origin> <kind>": {"d": "…", "s": "…"}}, "own": {"<kind>": {"n", "h", "b"}}, "views": {"<origin>": {"n", "h"}},
 "phones": [{"key": "…", "name": "…", "added": 1760000000, "from": "mac", "mac": "<the Mac that listed it>", "address": "…", "pairing": "…"}],
 "removed": [{"key": "…", "pairing": "…"}]}
```

`phones` is what its documents say ("Paired phones"): those its Macs list (`"from": "mac"`),
and those paired with the machine itself (`"pair"`). `address` is the phone's on the relay, where its notifications go: the Mac passes on
what it knows, and the bridge notes it each time the phone comes in. The machine's keys stay when no phones are left, so pairing again gives the same
address. The bridge reads the file every 30 seconds: a phone taken off loses its sessions,
and with no phones and no pairing waiting the bridge stops. The bridge notes when a phone last
used the machine (`run/link.seen`).

### Settings per box

Each computer keeps its own engine settings and keys; nothing copies them between computers but
you. A machine's are in `~/.kuvo-code/box` (`opencode.json`, and `keys/` for integrations' keys,
which its settings name as `{file:~/.kuvo-code/box/keys/…}`), which its engine reads
(`OPENCODE_CONFIG`) and reloads as they change; no older Kuvo Code writes there. A Mac makes them
the machine's own the first time it connects: what the machine runs with then (the settings an
older Mac's start left, "For released Macs") goes in its box, or, on a machine with none, the
Mac's. From then on a Mac's start sends none of its own, and a machine's settings are changed through its
bridge's script, the same way from a Mac (`kuvo-link.js box read | change | key`, over SSH) and
from a phone (`kuvo/config`), one change at a time under `run/.config.lock`. A Mac reaches any of
a machine's routes that answer once (never a stream) the same way: `kuvo-link.js box route` takes
`{method, path, body?}` on stdin and prints `{status, body}`, answered as a phone's request is.

### Personalities

The personalities you make are one library on every computer: each keeps its copy (a Mac in
its data folder, a machine in `~/.kuvo-code/bots/personalities.json`), and
copies meet box to box (each box's view is a document, "Documents") and as a Mac connects to a
machine or changes one (`kuvo-link.js box personalities`, over SSH). Per personality a removal wins
over any change, and stays noted (`removed`, counted past its last change, or the time it was
removed if that's later; the 500 highest kept), so no copy brings it back; otherwise
the change counted highest: `updated` is when one was made (milliseconds since 1970), and each
change counts on from the one before it, whatever any clock says; at the same count, the words
that sort last. A count past 2^52 isn't taken. Held to `Vectors/personalities.json` (KuvoLink's
`PersonalityLibraries`, the bridge's `mergePersonalities`). Kuvo Code's own presets (`preset.…`)
aren't in it. A change that would take the library past what a document holds is refused, `400
{"message"}`, on a Mac as on a machine.

- `GET kuvo/personalities`: `{"personalities": [{id, name, description, symbol, updated}]}`, the
  ones you made, on the computer asked.
- `POST kuvo/personalities` with `{name, description}` makes one (`custom.<uuid>`) and answers
  with it; 400 without both.
- `PATCH kuvo/personalities/<id>` with `{name?, description?}` changes one and answers with it;
  `DELETE` removes it. 404 for one that isn't there, or a preset.

A change on one computer reaches the others it reaches by mail at once, and the rest as they
connect. A bot made on a machine can have one there at once: its
`kuvo/bots/templates` lists them, told as the Mac words them (the kit's `personalityWords`).

### Paired phones

Each computer keeps the phones paired with it, and the ones removed, by the pairing they came in
with (`pairing`, made where the phone paired, new each time). The same rules on a Mac and a
machine's bridge, held to `Vectors/link.json` (`phoneBooks`):

- A pairing adds a phone, with a pairing nothing removed (what removed its others still keeps
  them out).
- A phone paired with it, or a Mac (one that set it up, `macs`), removes phones, at most 16 at a
  time, each a phone's key (32 bytes); a removal never names a Mac. What's removed stays removed,
  its pairing noted (the last 256 kept): the phone can't come in or change anything, and no list
  brings it back. Only a pairing of its own, with a new `pairing`, lets the phone in again, though
  its key is one the computer has.
- A removal of an older pairing than the one there leaves that one.
- Each box's phones document ("Documents") lists the phones paired there, and every removal it
  knows of. A machine lets in the phones its Macs' documents list that nothing removed, beside its
  own; a phone a Mac's document no longer lists goes off, not for good, and another Mac's phones
  stay. A removal in any phones document a box takes is noted there too, so one removed anywhere
  is removed everywhere, reached or not. One from before Macs were named (no `mac`) stays until a
  Mac signs its phones. A Mac the machine hasn't heard from in 30 days (setup or any mail), by its
  own clock, no longer counts, and its phones go; it counts again once it sets the machine up.

On both, for a paired phone:

- `kuvo/phones`: `{"phones": [{key, name, added, pairing, you}]}`, `added` in seconds since 1970,
  `you` the one asking.
- `POST kuvo/phones/remove` with `{"phones": [{key, pairing}]}` (`pairing` left out: the one
  there): removes them there, itself too, and their sessions end, once the answer's on its way.
  `200 {}`, or `400 {"message"}` when it names a Mac, nothing, too many or something that isn't a
  phone's key, or the one asking isn't paired there. A removal goes to each computer the phone pairs with, Mac
  and machines (`kuvo/hosts`); each also passes on the removals it has in its phones document.
- `POST kuvo/phones/pair`: a link for another phone to pair with, as Settings › Phone shows one
  (as a QR code): `{"link": "kuvo-link://pair?…", "ends"}`, good once, until `ends` (seconds
  since 1970). On a Mac it's the phones' own, apart from the one Settings › Phone shows, so
  neither ends the other; a new one takes the place of one a phone asked for before. `DELETE
  kuvo/phones/pair` ends it, as Done does (`200 {}`, with or without one). `409 {"message"}`
  while the phone link is off. A machine's bridge answers it too, with the Mac closed: the phone
  it pairs is the machine's own (as `kuvo-link.js pair` pairs one), and `409` when the machine has
  no relay.

A machine keeps itself running: its keeper (`bin/kuvo-start keep`, `run/box.pid`) starts its
engine again when it ends, unless it was stopped on purpose (`run/stopped`), and keeps the bridge
running while it has something to answer: a phone paired, a pairing waiting, or peers
(`run/link.needed`, which the bridge writes). The bridge stays up while the engine is down, and
starts the keeper when it isn't running. A Mac quitting or disconnecting leaves all of it running.

## For released Macs

A machine is set up and upgraded by whichever Mac connects, so a box with this bridge meets Macs
that run any released Kuvo Code: 0.5.x, 0.6.x and 0.7.0 to 0.7.2 (whose bridges, 0.4.1 to 0.9.4,
a Mac put on a machine only with the phone link on, which it never was for users), and
0.8.0-beta.1 (bridge 0.9.23, which it puts on every machine, for peers). What a box does for
them, and only for them, is here; the rest of this file is the protocol as it is. Nothing below is
for phones: the phone link has never been on in a release, so no phone needs an earlier shape of
anything.

**Kuvo Code 0.5 to 0.7.2.** It can go once 0.8.0 has been out three months and no Mac with 0.7 or
before connects (the box notes one: `run/attached`).
- **Its files**: such a Mac doesn't know box versions, and puts its own engine, bridge, helpers,
  agents bridge and keeper over the box's as it connects, touching `run/attached`. Once that's
  newer than `bin/box-version`, the keeper puts each tool in `bin/.own` back where it differs,
  but not while a Mac installs (`run/mac-installing`, an hour at most) or the box updates itself.
  A tool there that doesn't carry the box's own first or last line is such a Mac's, and gives way
  to the copy. Marking a box, a Mac puts its `kuvo-npx` there only with its own engine version
  there, which it runs.
- **Its keeper**: such a Mac's `kuvo-start` only starts the engine after a restart, and its
  `kuvo-launch` knows neither Stop nor the box's settings. The keeper keeps a copy of both
  (`bin/.kuvo-start-keeper`, `bin/.kuvo-launch-keeper`), runs its starts from them, and puts them
  back whenever the `kuvo-start` there has no `keep)` case (checked each round), leaving
  `.kuvo-boot` as that Mac wrote it. The bridge starts the keeper from the copy then too. The
  keeper stops the watchdogs such a Mac's start brings. On a machine without the keeper's script,
  a Mac starts the agents bridge and the engine as that Mac did.
- **Its engine**: such a Mac has Stop, which leaves `run/stopped` and the engine down until
  `POST kuvo/engine/start` (`kuvo/info` says `stopped`; Settings › Machines offers Start). It
  doesn't know a stopped engine, so it starts one over `run/stopped`; running, it isn't stopped
  any longer: the keeper takes `run/stopped` away, under the start lock. An engine without
  `notes.box` is such a Mac's, with that Mac's settings (and perhaps without the agents bridge):
  a Mac that marks boxes starts it over once nothing runs, so the box's settings apply again.
  Until then a Mac reading its group chats takes a 404 from that agents bridge as none.
- **Its visits hold updates back**: `run/attached` from before the box was last marked doesn't
  count (most likely the same Mac before it updated). A Mac marking the box after such a visit
  notes it first (`run/older-mac`, with the visit's time), so the mark doesn't hide it. The box
  doesn't update itself for 30 days after one ("an older Mac" in `run/launchers.json`), nor
  while a Mac that started its engine in the last 30 days hasn't said it `tolerates` newer boxes,
  nor for 30 days after drift (its files put back over an update's).
- **Its settings**: its start leaves its settings in the global file and `keys/settings.json`,
  with keys in `keys/`. The first Mac with boxes makes them the box's own (`kuvo-link.js box
  adopt`): those go in `box`, key paths as the box names them, what they were made from kept in
  `box/adopted-from`, and the launch's settings lines taken out, so no start writes them back.
  Until then a machine's bridge answers `kuvo/config`, `kuvo/keys`, `kuvo/mcp/catalog` and
  `kuvo/integrations` with `409 {"message"}`.
- **Leaving the engine running**: such a Mac stops a machine's engine as it quits unless
  something waits there (a wake-up, a group chat at work), or, from 0.7.0, a phone used the
  machine in the last week (`run/link.seen`, which the bridge touches as a phone asks).
- **Its worktrees**: it kept a machine's worktrees itself. A Mac that has such records gives them
  to the machine with `POST kuvo/worktrees/record`.
- **Its agents bridge** installed the agents' programs in `~/.kuvo-code/agents/runtime` on a
  machine, carried the Mac's sign-ins over (`<file>.from-mac`), and kept its downloads in its cache
  (`cache/install`): the agents bridge takes those away as it starts.
- **Updates**: the newest release on GitHub (0.7.2) has no `boxes.json`, which a box takes as
  "current", not a failure, until a release that has one is the newest.

**Kuvo Code 0.8.0-beta.1.** It can go once 0.8.0 is out (a beta copy is offered the release).
- It signs no documents: its setup and mail give its peers as a list (`peers`, with `peersAt` or
  the mail's `at`), without `macSign`. A box keeps that Mac's newest by its own `at` (`legacy` in
  link.json, compared only with that Mac's earlier ones) and counts it as that Mac's peers
  document, but never passes it on, nor gives that Mac documents. Once that Mac gives a signing key
  in setup, its documents take the list's place. Lists a 0.9.23 bridge passed on (`vouched`) and
  the personalities it sent (`{"personalities"}`) count for nothing.
- It meets a machine's personalities over SSH every minute (`kuvo-link.js box personalities`,
  the library in, the met library out), which still works; the bridge tells your other computers
  what changed. It still lets the newest change win over a removal, so a personality removed
  elsewhere that it changes afterwards stays on that Mac alone, until it updates.
- It notes it's connected in `run/connected/<its id>` each minute: the bridge clears `run/connected`
  (and `run/present`, which a 0.7 Mac with the phone link on wrote) as it starts. Nothing reads
  them.
- It asks a machine to rename a worktree's branch (`POST kuvo/worktrees/rename`, through `box
  route`), which the box names itself now: it's refused, and that Mac reads the machine's records
  again.
