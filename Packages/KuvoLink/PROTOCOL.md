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
the phone) and in the box's TypeScript (`Packages/Box/src`, built to
`Sources/KuvoLink/Resources/kuvo-link.js`, which every box runs). `Vectors/` holds the test vectors
both run against.

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
| `0x07` gone | relay | `address(16) reason(1)` | The device at `address`, which you sent something to on its current connection, has a new connection (0, replaced) or none (1, left; any other reason reads as left). Whatever sessions you had with it are over. |

Known kinds keep their lengths, and a device skips a kind it doesn't know once it's welcomed, so a
new kind goes only after welcome. A device never sends `0x07`.

**Gone.** The relay keeps, for each connection, the devices that sent it something on that connection
(at most 1,024) and the connections it sent to (at most 256); past either, nothing more is recorded.
A connection's own sends to its address (a bridge checking its connection) and sends that come back
unreachable record nothing. When a connection stops being the one at its address (a hello with the
same address replaces it, or it closes), each device it recorded hears `gone` once, and both lists
are cleared: a device is recorded again only by sending again. `gone` isn't queued or repeated: a
device that wasn't connected misses it, and needs no repeat, because losing its own relay connection
ends all its sessions anyway. What a replaced connection still sends as it closes is dropped, so no
frame from the old connection follows a `gone`. The relay sends every `gone` for a hello before it
reads anything from the new connection, so a device hears `gone` before anything the new connection
sends. A device ends its sessions with that address: a phone's streams fail (replaced is "closed",
left is "offline"), and a handshake still on its way starts over under a new session number, since it
may have reached the new connection. A host drops that phone's sessions, as on `unreachable`. A
connection that dies without closing stays listed until the relay's pings notice, up to about a
minute, which is why a phone still checks on a request that goes unanswered (below).

**A host never forgets a session while its relay connection stays up.** It ends one only with the
phone told (a close), or by the phone's own doing (a close, a new handshake from the same phone, the
phone unreachable or gone). A host's sessions end with its relay connection, which the relay tells
the phones about. Phones count on this, and don't check a quiet session before sending on it: a frame
that comes on a session the host doesn't have is answered with a close all the same.

**Deploy order.** The relay that sends `gone` goes out first, before any phone build with this
KuvoLink ships. Behind a relay from before it, such a phone still works but isn't told: a stream that
only listens doesn't end when its host starts again, and the first request after a host restart fails
once with "closed" (the host closes the session it doesn't know), the next one opening a new session.
Older phones keep checking quiet sessions, and skip `gone`.

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
- **This Mac's box** keeps the Mac's side (bridge 0.9.62): it signs the Mac's documents with the
  Mac's signing key (from the app, in memory only), takes its machines' and passes them on, and
  mails them on its relay connection, as a machine's bridge does; its peers are the machines its
  app set up (`kuvo/link/peers`, "This Mac's box: the relay"). It takes `peers` only of its own (a
  copy it lost count of), and `phones` and `personalities` from its machines and itself.
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
  are. Its bridge runs while it has peers or phones. Setup also gives the machine's `id`.
- **Mail**: a box opens mail from its Macs and its peers, and drops the rest. Every mail has `at`
  (milliseconds). A sealed mail frame is at most 65,600 bytes, and one larger isn't sent: letters'
  words and lists are cut to fit.
- **Agents**: `{"agents": {"at", "list": [{session, name, kind: "bot"|"session", id?, project?,
  about?, machine?, look?}], "features"?}}`: a bot's `id` (`bot_…`, as group chats name their
  members) and `look` (`{color, shape, face}`, as `kuvo/bots` has it: a colour, shape or face the
  apps don't draw is kept as the plain look's, `graphite`, `round`, `calm`), and `features` as the box's
  `kuvo/info` names them. A box sends its bots and its 40 latest
  sessions (its engine's and its coding agents') when they change and every ten minutes. Each box
  keeps the newest list from each peer. The relay keeps nothing, so a box that has just connected adds `"ask": "agents"` to
  what it sends first (its agents; a Mac's digest), and whoever gets it tells that box its agents
  again at once (within a minute before bridge 0.9.63), once in ten seconds at most for each.
  - A machine's bridge writes `run/agents.json` (what `list_agents` reads there) from its own
    agents and its peers', relay or not, keeping its own as last written while it can't say now
    (its engine starting).
  - This Mac's box does all of this for the Mac, as a machine's bridge does (bridge 0.9.63; the
    app did before): its own agents are its bots and its engine's and coding agents' sessions, its
    `features` as its app gives them (`kuvo/link/config`), and it writes `box/run/agents.json`
    (what its group chats name with `&`).
  - Each box leaves out what doesn't live there (`kuvo/moves`' `away`), and its mail says what it
    moved away in the last two days: `agents.moved: [{session, key, at}]`, `key` the box each lives
    on now. A moved session is the box's that the box that moved it names (the newest word in the
    last two days, this box's own too, a peer's only while it's a peer and never of this box's own
    conversations); then the one a Mac's peers document says (`moved`, for 0.8.0-beta.1). A session
    listed by more than one peer is the Mac's when a Mac lists it, and otherwise nobody's.
  - A Mac connected over SSH writes its list to `run/mac-agents.json` (`{key, at, list}`), which
    the bridge takes when it's newer than the Mac's mail. That list also names the agents of its
    machines whose bridge doesn't talk to peers, each with its `machine`, whose letters the Mac
    takes on over SSH (by mail, before bridge 0.9.63, too).
- **Personalities**: each box's view is a document ("Documents"); a box meets a peer's with its
  own, and its bots whose personality changed are told what they are now.
- **Letters**: `{"letter": {id, from, to, text, wait, at, answers?, read?}}` goes to the box that
  listed `to`.
  - **Checks**: the receiver drops a letter older than a day. It delivers each `id` once (ids
    remembered two days, noted once delivered), at most 20 in ten minutes from a box (one answered
    `retry` isn't counted, so one tried again and again leaves room for the rest), and only
    to a conversation an agent could be. A subagent's, a group chat's seat or one put away doesn't
    take letters. One it can't look up now (its engine starting) is answered `retry`, and so is one
    for a conversation the engine doesn't have while the coding agents' bridge isn't running (it may
    be a Claude Code or Codex one; bridge 0.9.118, before which it was refused), and one
    for a conversation moving to or from another computer now, or that lives on another one now
    (`moved`): it reaches it where it lives once the move is over (bridge 0.9.63). A box knows by
    its own moves (`kuvo/moves`; bridge 0.9.108, before which this Mac's box asked its app). One
    for a conversation its engine doesn't have, while its coding agents' bridge isn't running, is
    answered `retry` too (it may be one of theirs, starting again), for half an hour from the first
    time; after that it's refused as for no conversation (bridge 0.9.123).
  - **Sender**: it names the sender as the sending box named that agent, when that box alone
    lists `from` and it isn't one of the receiver's own conversations. Otherwise the letter is from
    "an agent on <box>", with no address to answer.
  - **`delivered`**: it answers `{"delivered": {id, ok, why?, retry?, answer?}}`. `retry`: not
    now (an engine restarting, too many lately), so the sender tries again. `answer: false`: there,
    but no answer will come (its sender couldn't be verified, or its machine is away).
  - **`wait`**: the receiver watches for an answer for ten minutes and sends it back as a letter
    of its own, with `answers` naming the first. The answer is what the agent wrote after the
    letter, up to the next message someone else gave it once it had answered. If a tool still waits for it, it goes to that
    tool; otherwise it reaches the sender's conversation as a message.
  - **Sender side**: a sender takes `delivered` only from the box it sent to, and an answer for a
    waiting tool only from that box; an answer from it stands for `delivered` should that be lost. Until `delivered` comes, it sends again each minute, for two
    days, oldest first, and a letter whose agent no box lists now waits. One for a conversation that
    moved (`moved`) goes where it lives now, whichever box it was left for. Before a
    letter goes, its sender is told of to that box, if it wasn't: it waits until that's sent (or
    couldn't be), a minute at most. Its words are cut on a character's
    boundary.
  - **`read`** `{query?}` (bridge 0.9.100, to a peer whose `features` say `letters-read`): the
    letter asks for `to`'s conversation instead of saying something (`read_conversation` from
    another computer), with `wait` and a `from` to answer. The receiver checks it as any letter
    (not a subagent's, a seat, or one put away) but doesn't count it, says it's there, and sends
    back the conversation as `read_conversation` words it (or the parts that mention `query`),
    about 20,000 characters at most, as an answer that also carries `read: {}`. An answer with
    `read` that no tool waits for any more is dropped, never delivered as a message.
- **Leaving one**: an agent's `send_message` or `read_conversation` for an agent on another
  computer ("Agents' tools") leaves a letter in `run/outbox/sending/<id>.json`, which the link
  sends. Without the relay, letters wait for it: no box hands them to anyone over SSH (bridge
  0.9.100; before, a machine handed them to its Mac after five minutes).
  - On this Mac, the box answering the tool is the one on the relay: it waits for the answer in
    memory, up to eleven minutes, while the tool's request is open.
  - On a machine, the tool's call is answered by a process of its own (`box route`): it reads
    `run/replies/<id>.json` (`{text}`, `{failed}` or `{note}`), and touches `<id>.alive` as it
    looks. An answer that comes once it isn't is delivered as a message, and so is one it was given
    but never took (its turn stopped as the answer came): once the tool's gone (`<id>.gaveup`, or
    `<id>.alive` ten seconds old), once (bridge 0.9.63), kept a day while the coding agents' bridge
    isn't running for a conversation the engine doesn't know. After eleven minutes, or stopped, it leaves
    `<id>.gaveup`, and its letter goes on without waiting. The link notes `run/relay-down` while
    it's been off the relay half a minute, so a tool says so at once rather than wait.
  - Letters an older Kuvo Code left in `run/outbox` for a Mac to collect over SSH are taken on by
    the link as its own (not one a Mac renamed `.mac-<name>` to deliver).
- **Group chats**: a chat lives on one box (its host) and runs there. A member that lives on
  another box (its home, a peer whose `features` say `groups.seats`) takes its turn there, in a
  seat of the home's own, and does its part of the work and remembers the chat in its own
  conversation there. Only words go between them, as `{"seat": <mail>}` (with `"seatID"` for one
  that mustn't be lost), or `{"seatPart": {whole, i, of, d, s}}` for a mail over 48,000 bytes (as a
  document's parts, but `d` is the base64url of the mail's JSON in UTF-8, so each part fits whatever
  the words are; `s` the `seatID`, or empty). One that would take more parts than a document may
  isn't sent at all, and the link's log says so. The coding agents' bridge on each box writes and
  reads the mail (`Packages/Box/src/agents/groups/peer.ts`), and the box's link carries it. The bridge sends no
  mail over 512 KB (its JSON in UTF-8): a turn that big goes without `fresh`, then with what the bot
  hasn't heard cut to its latest messages within 160 KB (the last always), and only one that still
  doesn't fit fails, the chat saying the chat is too big to send to that computer; a part that big
  fails, said in the chat; a turn's answer leaves its steps out and a part's report is cut to 64 KB,
  said to be cut.
  - **`turn`** (host → home): `{id, chat: {id, name, purpose?, members: [{id, name, job}]}, bot,
    seat?, agentsSeat?, kind: "turn"|"wrapUp"|"guest"|"split", text, fresh?, chatSize?}`: what the
    bot hears, composed by the host (`fresh`, the whole chat, for a seat its home has to make
    anew). The home builds the seat's instructions and rules from its own bot, checks its model's
    sign-in, and runs it. It uses `seat` only when that conversation's metadata says it's this bot's
    seat in this chat (`kuvo.seat`: `bot`, `group`, as it made it), and otherwise makes the bot a
    seat of its own (`replaced`). It takes each `id` once (remembered a day, on disk with its seat,
    its message there and how it ended, that without its steps and only for 15 minutes, past when
    the host stops asking), and answers one asked again with how it's going (what it's doing, only
    the latest), or how it ended. One asked again after the home's bridge restarted goes on in the
    seat it had, following its message there rather than sending it again (and sending it, by the
    same id, only when it isn't there); a `stop` for one goes to its seat. If that seat is gone
    (deleted meanwhile), what it got that far is set aside and the turn goes in a seat made anew,
    given `fresh`; asked without it, the home answers `{phase: "anew"}` and forgets the turn, the host
    asks again at once with `fresh` (if it had it), and a home asked without it again says `anew`
    once more, then takes it as it is.
  - A home whose bot a move holds (its folder's `paused` says `moving`) answers a turn at once
    with `{ok: false, why, moving: true}`, and fails a part given to it the same way: the chat says
    the bot is moving and sat this out.
  - **`state`** (home → host): `{id, state}`, `state` one of `{phase: "taken"}` (at once),
    `{phase: "seated", seat, agents, replaced?}`, `{phase: "started"}` (its words are with its
    seat), `{phase: "activity", activity}` (at most every 1.5 s, the latest), `{phase: "steered",
    message}`, `{phase: "working"}` (every 10 s while it runs, so a long quiet step isn't asked
    again), `{phase: "anew"}` (its seat went while the home restarted: ask again with `fresh`).
    **`result`** (home → host): `{id, result}`, `{ok: true, text, steps, outgrown?}` or
    `{ok: false, why}`, with `seat`, `agents` and `replaced?` when it ended in a seat (so a host
    that missed `seated` keeps it, and one that missed `started` knows its words were heard). A
    host takes them only from the box it asked, and each only once. Each 15 s it hears nothing of a
    turn, it asks again by the same `id` (without `fresh` once it has heard `started`: no seat is
    made for it anew then); after 45 s of nothing, or past the home's own limit on a
    turn (ten minutes, and a minute more) without a result, it sends `stop` and the chat says the
    bot's computer can't be reached now.
  - **`steer`** `{id, text, message}` and **`stop`** `{id}` (host → home), for a message you write
    while it talks, and for Stop, Undo or a move. The home steers only once the turn's words are
    with its seat (`started`: the seat checked as the bot's, or made for it); one that comes before
    waits until then.
  - Not to be lost (sent as letters are, the first time as the bridge hands it over, then each
    minute until `delivered`, for two days of the link online; never through a Mac): **`drop`** `{seat, agents, bot, chat}` (host
    → home: `bot`'s seat in `chat` gone, deleted only when its metadata says it's that),
    **`work`** `{work: {task, wrapUp, chat, bot, text, started}}` (host → home: a part, to the
    bot's own conversation, followed there across restarts; taken once, and given again as the
    host starts while it waits for its report), **`report`** `{task, wrapUp, chat, result}` (home
    → host, taken only from the box the part was given to; the home remembers a part it did, with
    its report, for 30 days, and sends the report again whenever the part is given again), and **`memory`** `{memory: {chat, bot,
    at, forget?, name?, with?, recap?, transcript?, time?}}` (host → home: kept beside the home's
    own chats in the bot's one memory instruction, the transcript in `groups/<host key's first 8
    characters>-<chat>.md` in its folder). A memory carries its recap and the chat's latest
    messages, within 24 KB and 200 KB, and `at` (milliseconds, later each time): the home refuses
    one said before the newest it took for that bot and chat, or before it forgot that chat (it
    remembers that three days), so one that comes late or twice changes nothing. A newer one for
    the same bot and chat goes in place of one still waiting to go.
  - **The rule for these letters**: a letter's two days count only while its link is online (the
    relay connected, the computer awake: from one round of the outbox to the next counts five
    minutes at most), so a computer asleep or offline never gives up what it sent. A letter given up
    (no `delivered` for two days online, too big to send, or turned down) is told to its box's coding
    agents' bridge (`POST /api/kuvo/peers/gaveup {to, mail, at}`), which decides what comes of it;
    until the bridge has answered (any 2xx or 4xx; it answers 503 until its link has said who the
    peers are) the letter is kept and not sent. Nothing given up is final: while `to` is still a peer
    (one that takes seats, for what goes to a home), what still matters goes again as a new letter (a
    `work` whose part is still under way, unless it went before the bridge last started and was given
    again then; a `report` of a part still remembered; a `drop`; and a `memory`, as the chat is
    now, or that the bot forgets it); otherwise it's let go, and a `work` fails its part in the chat
    (its computer couldn't be reached for two days). A part failed that way still takes its `report`
    if it comes after all.
  - A bot whose home changed (it moved) loses its seat where it was (`drop`), and its next turn
    makes one where it is now, given the whole chat. A host offers in its chats the bots of the
    peers that take seats (`kuvo/groups/joinable`), and its chats list them as members with
    `computer`, the peer's name, and the fields any member has: `look` (as the peer listed it, a
    colour, shape or face the apps don't draw as the plain look's, or the plain one), `session` (its own conversation there, empty when the peer didn't say) and
    `directory` (empty: its folder is there).
- `kuvo-link.js leave <mac>`: run when that Mac removes the machine. It stops counting that Mac,
  forgets its documents, the peers only it named and what they told it, and leaves other Macs'
  alone. A Mac that can't reach the machine names it in its peers document's `left`, and mails it
  that document once; one that never gets it lets that Mac go after 30 days ("Paired phones").

### kuvo/moves

Move to Computer (bridge 0.9.108, feature `moves`): a bot, a chat or a group chat goes whole to
another of your computers, the boxes doing it between themselves over peer mail ("Peers", `move`).
A client asks the box it lives on once, and watches; the move goes on with no client there.

- `GET kuvo/moves/places?kind=bot|chat|group&id=…` → `200 {places: [{key, name, kind, ok, why?,
  note?}]}`: each of your other computers (its box's key, its name, `mac` or `machine`), and whether
  it can go there now, with why not in words to show (it works in a project, talks with a coding
  agent, is in a group chat that lives here with its bots, is moving already; that computer's box is
  from before moves, as the `features` its agents' mail last gave say; a group chat's bots don't all
  live on that machine, as its agents' mail says, none of them here) and `note`, the same in a few
  words for beside the computer's name in a menu. `404 {message}` when it isn't here. A group chat
  can go to any Mac (its bots stay where they are); the machine it goes to checks again.
- `POST kuvo/moves {kind, id, to}` (`to`: the box's key, as `places` gives it) answers once the move
  ends: `200 {move}` (it lives there now); `409 {message}` refused or taken back, as it was (working,
  messages still on their way, kept getting messages while it moved, too big, refused there);
  `503 {message}` the other computer didn't answer; `404 {message}` it isn't here, or that isn't one
  of your computers. A client that goes doesn't stop it.
- `GET kuvo/moves` → `200 {moves: [Move], away: [session]}`, and `GET kuvo/moves/events`, the same
  as a line now and each time it changes. `Move = {id, kind, thing, name, from, to, role, stage,
  sessions, place?, sent?, size?}`: `from` and `to` are boxes' keys; `role`, whether this box is
  where it was (`from`) or where it's going (`to`); `stage`: `holding`, `copying`, `switching`,
  `finishing`; `sessions`, its conversations, root first; `place`, the other computer's name, as
  your computers call it (when this box knows it); `sent` and `size`, bytes, while its copy is on
  its way, for a client to show how far it is. `away`: conversations this box's engine lists that don't live here (a copy not
  switched to yet, an original still going): clients leave them out.
- While it moves, nothing reaches it: a prompt to one of its conversations through the link answers
  `409 {message}`, a letter `retry`, its wake-ups and watches are held (`paused` says `moving`), and
  changing or deleting the bot answers `409`. A client shows it as moving.

Between the boxes, each `{"move": {op, id, …}}` (`id`: `mov_…`), each step sent again each minute
until it's answered:

1. The box it leaves holds it, waits until its conversations are settled (no turn running, nothing
   in their inbox; a minute at most), and packs one file: `move.json` (its conversations as the
   engine exports them, root first; a bot's own keys; a group chat as its bridge held it, `POST
   api/kuvo/groups/<id>/hold`) and its folder (a bot's; a chat's wake-ups'), tar, gzip; at most 1 GB.
2. `offer {kind, thing, name, size, hash, wasPaused, pausedAs?, from, members?}` → `ready`, or
   `refused {message}`: its engine or group chats aren't running, too big, a group chat's bots
   (`members`) don't all live on that machine, one by that ID lives there already, or a move of it
   is under way (only the computer whose move it is can offer it again). A first offer unanswered
   for 30 seconds: the other computer isn't there (503). While it moves, its folder's `paused` says
   `moving`; what it said before (your own pause) is `pausedAs`, put back where it lives after.
3. `part {hash, i, of, d}` (30,000 bytes each, base64url), 16 on their way at once, each answered
   `got {i}`; one unanswered for 20 seconds goes again. The box it goes to notes each part as it
   comes (beside the bundle), so one it gets after starting again counts those before.
4. Once all are there and its SHA-256 matches, the box it goes to puts it in place, held, in the
   move's turn (a step about it that comes meanwhile waits), saying `working` now and each minute
   until it's done: the folder where it keeps them (only files and folders: a link or anything else
   in it or for it, or a `move.json` that isn't a file of its own, and it's refused), `paused` saying `moving`,
   a chat's `directory` its chats folder; each conversation imported under its own ID (noted first;
   they must be one conversation and its subagents', rooted at the chat or at the conversation a
   bot's folder names, none of them on this box already); a bot's keys given; a group chat put there
   held (`PUT api/kuvo/groups/<id>`, `status: "held"`). → `arrived`, or `failed {message}`, what it
   set up gone again; the message says only what's wrong with what came, never what this box found.
   Setting it up for 30 minutes (its engine stuck) is given up on the same way.
5. The box it leaves settles and reads it again. Anything new, and it all goes again (from 1, three
   tries; then 409, `busy`).
6. It notes the switch, and sends `switch` → `switched`: the box it went to lets its wake-ups go (as
   they were), starts a group chat (`activate`), and tells a bot what it is (as
   `kuvo/bots/<id>/arrived` does).
7. Then the box it left lets the original go: its conversation saved in its folder (or
   `moved-<id>` in the box's folder) as `conversation.json`, its conversations deleted, a bot's own
   keys removed, the folder to Kuvo Code's trash (on a Mac, on to the Finder's Trash), a group chat
   released. It says for two days where those conversations live now ("Peers", `moved`).

Each move's steps are taken one at a time on each box, in the order they come. The box it goes to
sets a copy up once, whatever parts come again, and lets go of what it set up if setting it up
fails. It keeps how each move that came to it ended, a dropped one for a week and a switched one
for a year: a `switch` is answered `switched`
only for a copy it has whole or switched to already, and `dropped` for any other (one it let go
of, never set up, or doesn't know), and the box it left then goes on with its original, as it was.
Before the switch, anything that goes wrong takes it back: the box it leaves sends `drop` →
`dropped` (the copy there goes: its conversations, keys and folder, a group chat released) and
goes on as it was. After it, only forward. Each box keeps its moves in `run/moves/<id>.json` (and
the bundle beside it), so a move cut short by a restart carries on: one that switched finishes, one
that didn't is taken back. Letting the original go after `switched` is tried again each minute
until it's done (its engine was down); its engine, up, refusing to give its conversation to keep ten
times, it goes on here as well, said in the move's 409 (two copies, never none). Before the switch, the other computer quiet about it for
ten minutes takes it back (503); a `drop` never answered is given up after a day (the copy there
goes by itself after a week). A `switch` with no answer either way for ten minutes turns into a
`drop`, sent until it's answered: `switched` (it did switch) and the original goes, `dropped` and
it goes on here; the box it leaves never lets its original go without `switched`. A held copy no
box asks about for a week goes. One thing moves once at a time, whoever asks (a lock in
`run/moves`), and a move taken back keeps no bundle. A peer gone from your computers for five
minutes (not one left out a moment as they're read again) ends its moves: what's here goes back as
it was (a copy that came, or an original, switching or not), and only one that heard `switched`
finishes. So a peer removed after it switched but before its `switched` came leaves the original
going on here as well as the copy there: two copies, never none. As a box starts, a `moving` hold no move of its own made (a released Mac's move cut
short) is lifted.

### Agents' tools

Every box answers its agents' tools for writing to each other and starting sessions itself, the
same on every computer (bridge 0.9.100). The tool servers (this Mac's app, a machine's
`kuvo-browser.js`) only pass a call on; a machine's through `kuvo-link.js box route`, a process of
its own, which a `SIGTERM` stops waiting.

- **`POST kuvo/agent-tools`** `{name, arguments, session}` → `{text, isError}`: `name` is
  `list_agents`, `send_message`, `read_conversation` or `start_session`, `arguments` the tool's,
  `session` the conversation calling (as the engine names it; null outside one). The answer is the
  tool's own words. One that waits for an answer holds the request up to eleven minutes; the
  request going stops the wait, and an answer that comes later reaches the conversation as a
  message. 400 for another `name`.
  - A subagent, and a coding agent's engine run (`kuvo.engineFor`), act as their conversation: its
    name, folder, model, approval, and where answers go. A group chat's seat may only list and read.
  - Who there is: the box's own agents and its peers' (as `run/agents.json` has them), and any
    conversation here named by its address. An agent is named by its address or its name (any case
    or accents, with or without `&`).
  - An agent here gets the message straight from the box; one on another computer by a letter
    ("Peers"). Without a conversation to answer, or off the relay, a letter isn't waited for.
    `read_conversation` reads one here, or asks a peer with `letters-read` for it by letter.
- **`POST kuvo/sessions`** `{task, title?, folder? | project? | chat?, worktree?, model?, effort?,
  mode?, approval?, wake?, startedBy?, wait? = false}` →
  `{session, title, folder, project, answer?}` (`project` null for a chat; `answer` with
  `wait`, its first answer in ten minutes, else null). `start_session` is this route, from the
  calling conversation.
  - From a conversation (`startedBy`, its root found as above): in its folder unless `folder` names
    another (a bot's own folder is its chats), on its model and in its mode (Plan stays Plan) unless `model`, `effort` or `mode` names another, on the engine or coding agents' bridge
    it runs on, with its approval made again with this box's Settings › Permissions (Ask First isn't
    got around), its metadata `kuvo: {startedBy}` (it opens nothing by itself: clients list it under that
    conversation), and the task as a message from it.
  - From a client (no `startedBy`): in `folder`, approved as Approve All with Settings ›
    Permissions, the task as the user's own first message.
  - Either way its project's other folders are allowed to it and named in its instructions, one in
    a worktree is told so, and a folder that's no project yet becomes one.
  - 400 `{message}` (no task, not a folder here), 403 (a group chat's seat), 404 (`startedBy`
    isn't a conversation here), 429 (too many lately), 502 `{message, session?}` (not made, or
    made but its task didn't reach it), 503 (no engine).
  - Where and how, each optional (bridge 0.9.106, "Work"): `project` (a project's name or folder
    here) or `chat: true` instead of `folder`; `worktree: true`, a worktree of its project on a
    branch of its own; `model` (`"provider/model"` or `{providerID, id}`, one there's an account for
    here, on the engine or the coding agents' bridge as it runs) and `effort` (one of its variants);
    `mode` `build` or `plan`; `approval` `ask` or `approveAll`, never above the starter's (a starter
    that asks first starts one that does too); `wake` (`finished`, `asks`, `both`, `none`), what the
    starter hears of it. `computer` other than this one: 400, for now.
  - Unknown fields are ignored, so a newer client can send more to an older box.
- **Limits**: one table on the box (`letters/limits.ts`): a conversation sends 20 messages in ten
  minutes and starts 6 sessions in ten minutes at most, and letters from one peer count as one
  sender. A bot's work is its own to size: only the limits you set for it hold ("Work"), and a net
  of 40 sessions in ten minutes, counted for the bot and every session under it, stops a runaway. What each did lately is kept in `run/tool-limits.json`, so calls answered by separate
  processes count together. A tool's call from no conversation this box has counts as one sender,
  `outside` (its session asks first, and its task can't be answered); a session started by a
  client (`kuvo/sessions` without `startedBy`) isn't counted.

### The queue

What you send a session waits in the engine's inbox (bridge 0.9.100): for the agent's next step
(`steer`), or for the run to end (`queue`). The engine doesn't start the next one after every run,
so every box carries its sessions' queues itself (the engine's and the coding agents' bridge's),
the same for every client and with none connected, and keeps them in `run/queues.json`.

- **Goes on**: a run that ends well, or a message queued while nothing runs, is followed a moment
  later (1.5 s) by the next waiting message, unless the queue is paused: what Stop held, in its
  order, then one for the next step (by resuming), then the queue, first queued first (by steering
  it). A run the engine ended itself (`superseded`, `inactivity`) goes on the same way, and so do
  the latest sessions' queues when a box starts again (or its stream comes back) beside the same
  engine, for a run that ended while it couldn't hear (one that was stopped or failed, its newest
  answer ending in an error, is held and paused instead).
- **Pauses**: Stop, from any client (the box's `stop`, or an interrupt a client sent the engine
  itself: with no run started again a moment later, as Send Now's resume does at once; while the
  session still says it's at work, looked at again, a few times); a run that failed; and a queue
  found with nothing running once the engine started anew (each engine process looked over once,
  as `run/queues-scanned.json` keeps, so a box that starts again beside it doesn't). Each holds
  what was for the next step in the queue, ahead of what was queued, the latest first: only what's
  still waiting once it's moved there. A message you write to go now (`steer`) unpauses it;
  another agent's letter, a wake-up or a note doesn't. A Resume or Send Now just after an interrupt
  wins over the look at it. Once nothing waits, nothing's paused.
- `GET kuvo/sessions/<id>/queue` → `{paused, held: [inboxID…]}`; `GET kuvo/sessions/queues/events`
  follows them all (ndjson: `{"queues": {<session>: {paused, held}}}` now and at each change; a
  session neither paused nor holding anything is left out).
- `POST kuvo/sessions/<id>/stop`: held and paused, then the run stopped. `POST …/queue/hold` (`{items?}`):
  held and paused without stopping (before an undo, or a move); `items`, messages a client held
  as they went to the engine, go first, in that order. `POST …/queue/resume`: unpaused, and the
  next one goes now. `POST …/queue/<item>/now` (Send Now): unpaused, the item steered, and a run
  under way stopped to go on with it; 404 when it isn't waiting. Each answers the queue as it is
  now; 404 for no such session here, 503 with no engine, 502 when the engine refused.
- Clients show what's held and whether it's paused from these; the in-flight record of a message
  still on its way (and that Stop held it) stays with the client that sends it, which waits for its
  request before it asks the box to stop, and for its hold before it asks the box to resume.
- A box without `queue` in its features (its update didn't get through): each client carries that
  box's queues itself, as clients did before.

### Work

A bot runs sessions as you would (bridge 0.9.106): it starts them in your projects on the model,
effort, mode and approval it picks, hears when they finish or ask, answers what they ask within
what it may do itself, and stops them. Every box does this alike, with no client connected; every
client shows it from the same routes.

- **Marked as its work**: a session a bot starts, and every one under it, has metadata
  `kuvo: {startedBy, by: {bot, name}, depth, wake?}`: the bot it works for, how deep it is
  (1 for one the bot started), and what its starter hears of it (a bot: both, or only its asks
  when it waited for the answer). What a starter hears is gathered a few seconds and sent as one
  message (an ask to be read at its next step), kept in `run/work/wakes.json` until it's sent (for a
  conversation the engine doesn't know while the coding agents' bridge isn't running, a day at most,
  since it may be the bridge's; and so is an answer given late, below; for an archived one, until
  it's brought back, as its own wake-ups wait, a week at most). Clients mark rows by `kuvo.by`.
  Its task ends with the session's half of the playbook: review your work with reviewer subagents,
  fix what they find, and end with a short report.
- **Tools** (`POST kuvo/agent-tools`, any conversation, for the sessions under it):
  `list_sessions` (each with where it stands: working, asking and what, with the ask's id,
  finished, failed, stopped; its model, tokens and last reply's first lines), `stop_session`
  (`{session, archive?}`; only one of its own), `answer_ask` (`{session, ask, decision: allow|deny,
  reason}`, or `{session, ask, answer, reason}` for a question), `list_models` (the models there's
  an account for here, `provider/model`, with their efforts).
- **Answering asks, until the sandbox** (`work/policy.ts`): reading a command can't be made
  airtight, so until sessions run in the sandbox a bot answers only two kinds of ask, judged by
  the tool call itself (its whole input, found by the ask's `source`: never only what the ask
  lists, which leaves out a command's `cd` and the folder it runs in), and only where it could go
  ahead itself, part by part (the engine's rules for its own conversation allow each: the engine's
  defaults, Settings › Permissions, then the conversation's own):
  - Making or changing a source or text file inside the session's folder (its project's other
    folders too), by a tool that edits (never another tool asked as an edit), never a folder:
    only by its extension from a known list (code, styles, Markdown, data), its path
    written plainly (letters, digits, `.`, `_`, `-`, `/`), no part hidden (starting with `.`), no
    `..`, nothing reached through a link, never a name a later command runs or reads as settings
    (`package.json`, `tsconfig.json`, `opencode.json`, `*.config.*`, `build.rs`, `Package.swift`…,
    compared without case, as macOS does), never your keys and sign-ins.
  - A few commands that read: `ls`, `cat`, `head`, `tail`, `wc`, and `git status`, `diff` and `log`
    (only where the folder is its repository's own top level), each with a few options, run in the
    session's folder (a `workdir` elsewhere goes to the user); the line printable ASCII, every part
    one of those, paths written plainly as above. No redirects, patterns of files, settings before
    it, `cd`, `pushd` or `popd`, nor anything a shell expands or runs besides.
  - Everything else goes to the user: reading through the engine, building, testing, installing,
    changing files from the shell, git that changes anything, fetching, integrations' tools. It may
    always deny, with its reason passed on.
  - What it can't close, until the sandbox:
    - An edit it allowed, then a run the user allows later, runs what was edited: source reaches
      `cargo build` and `swift build`, macros, and test runs. Each ask is judged alone, so the user
      allowing a build or a test run allows the project's code as it is then.
    - A file can change between the check and the run, and a hard link looks like any file.
    - git follows the diff, textconv and LFS settings the user already has.
- **Answering asks in the sandbox** (`work/policy.ts`): where the session's commands run in the
  sandbox ("Sandbox": the engine's, while it's `on`; a coding agent's, when the agents bridge marks
  its ask `sandboxed`, its program having started in it, and while it's still set up), which holds what they write and read, a bot may allow any of its commands, wherever it
  runs, within the engine's rules as above; but never one that acts beyond this computer with your
  accounts, and whatever it can't be sure isn't (any part, past `sudo`, `env`, `npx` and the like,
  with no option but a bare flag before the program, and the program a package runner runs, `npm
  exec`, `pnpm dlx`, `bun x`, or `find -exec` does; `xargs`, a runner's `-c`, git's settings on the
  line, `-c` and `GIT_…=`, setting them (`git config` but its reads, a clone's `--config`, a
  `--template`), and naming or writing git's own files, `.git/…`, aren't): a `push`,
  `send-pack`, `send-email`, `dcommit` or `upload` anywhere among a program's words but the ones
  that only read or print them (`grep`, `echo`…; `git stash push` stays here), `docker push`,
  `--push`, a registry output, publishing (`npm publish`,
  `cargo publish`…), deploying or releasing (`vercel`, `netlify`, `firebase`, `fastlane`, `xcrun
  altool`, a program or script named for it, a package script so named: `npm run deploy`), sending
  with `curl` or `wget` anywhere but this computer, reaching another computer (`ssh`, `scp`,
  `rsync`, `sftp`), `gh` and `glab`, and `security`; nor code it can't read (`sh -c`, `eval`,
  `node -e`, `python -c`…), nor a line it can't read plainly (`$…`, a here-document). This reads
  the line, not what a script it runs does: the sandbox can't hold the network. Those, and every
  edit (which the engine
  makes itself, outside the sandbox: as above), go to the user. A command a bot allows still can't
  get out of the sandbox: only you can let one out (`sandbox_ask`, "Asks"), and no tool answers
  that.
  Each answer is kept on the session, `kuvo.answers: [{ask, call?, what, decision, reason, by:
  {bot?, name}, at}]` (the latest 40), where clients show it on the ask's tool call ("Allowed by
  Pixel") and in the bot's work.
- **Limits you set** (Edit Bot › Work; `PATCH kuvo/bots/<id>` `{work: {limits}}`, null for none;
  `limits` in `kuvo/bots`): `atOnce` (its sessions working at once), `perDay` (started since
  midnight, archived ones too), `depth`, `tokensPerDay` (of the sessions started today). None until you set one; past one, `start_session` refuses
  with words saying which. Starts asked for at once count each other: each is noted in
  `run/tool-limits.json` before the limits are looked at, and counts those before it the engine
  doesn't show as the bot's yet.
- **`GET kuvo/work?bot=<id>`** → `{bot, sessions: [{session, title, folder, project?, startedBy,
  depth, model?, mode?, state, asks?, started, tokens, cost?, lastReply?}], answered: [answer with
  its session], today: {started, working, tokens, cost?}, limits}`: its sessions the latest first,
  archived ones left out. 400 without `bot`, 404 for no such bot here, 503 with no engine.
- **`GET kuvo/work/events`** (ndjson): `{"changed": {<bot>: <ms>}}` now and at each change to a
  bot's work (a session started, stopped, finished or asking, an ask answered, its limits); a
  client reads that bot's work again when its time moves. Kept in `run/work/changes.json`.
- **`POST kuvo/bots/<id>/stop-all`** → `{stopped}`: every session of its work that's working,
  stopped (held and paused, as the queue's Stop), and the bot's own turn too, with what it was
  still to hear of them dropped. 404 for no such bot here, 503 with no engine.
- **A box starting again** (its link): what its followed sessions did while it was down (finished,
  failed, asked; not one that was stopped) is told to their starters once, by what
  `run/work/told.json` says was told, and an answer to an ask given after its tool stopped waiting
  goes to its conversation if it hadn't.

**Projects** (bridge 0.9.107, feature `work.projects`): a bot makes new projects on its box, in a
folder you pick once per box, after asking you.
- **Where they go**: `GET|PATCH kuvo/work/settings` → `{projectsFolder: string|null, suggested?}`,
  kept in `box/work.json`. None until you pick one; `suggested` is `~/Developer` or `~/Projects`
  when there's one. PATCH `{projectsFolder}` takes a full path (`~` is fine) to a folder that's
  there, or null; 400 otherwise. The box makes projects only there, and never deletes one.
- **Tools**: `make_project` (`{name, git?, clone?}`: a folder named after it, lowercase with
  dashes, a new git repository there unless `git: false`, or a repository cloned from an https or
  ssh address), `list_projects` (each project here: its folder, whether it's git, who made it).
  A folder that's there with files in it, a project there already, or an address git can't clone
  is refused without asking.
- **Asking you first**: `make_project` asks unless you said Always to that bot for that kind,
  and a projects folder is picked. The ask is kept in `run/work/asks.json` until you answer; the
  tool waits up to ten minutes, then says it stays asked, and the conversation gets
  `[The user answered] …` as a message when you do (for a conversation the engine doesn't know
  while the coding agents' bridge isn't running, tried again every few minutes, a week at most).
  - An ask goes with its bot (deleted), or after a week unanswered.
  - `GET kuvo/work/asks` and `GET kuvo/work/asks/events` (ndjson, a line now and at each change)
    → `{asks: [{id, action: makeProject|cloneProject, session, name, bot?, project, clone?,
    folderName, folder: string|null, suggested?, at}]}`: `session` and `name` are the
    conversation asking (a bot's own), `folderName` the folder it gets, `folder` where it would go
    (null with no projects folder yet). A bot's are in its `kuvo/work` too, as `asks`, with the
    projects it made, as `projects`.
  - `POST kuvo/work/asks/<id>` `{answer: allow|always|deny, folder?}` → `{answer, text, isError}`:
    what's asked is done there and then, `text` in the words its asker reads (`isError` when it
    couldn't be: the ask is answered all the same). `folder` picks the projects folder while none
    is picked (needed to allow then: 400 "Pick the folder…"), and is ignored once one is. Always keeps
    `work.allowed: [makeProject|cloneProject]` in its bot.json (`allowed` in `kuvo/bots`; `PATCH
    kuvo/bots/<id>` `{work: {allowed}}` takes it back, and `{work: {limits}}` alone leaves it). 404
    for one answered already, from another client say.
  - A machine's bridge tells your phones of each, as category `ask` with `answerable: "0"`, `data:
    {session, ask}`: it opens the conversation. A Mac tells them itself.
- **Made**: `box/projects.json` keeps it first, with `madeBy: {bot, name, at}` for a bot's. `POST
  kuvo/projects/new` `{name, git?, clone?}` → 201 `{project, text}` makes one from a client
  the same way (no `madeBy`): 403 `{needs: "projectsFolder"}` with none picked, 409 for one there,
  400 for a name or address that won't do, 502 when git fails.

**What always comes to you** (bridge 0.9.122, `work/always.ts`): payments, permanent deletes,
changes to who may do what, new accounts, messages to people, your passwords, keys and sign-ins,
and git's settings. No mode, Always, plan or goal's switch turns this off, nor the sandbox: what a
bot may allow there is within these rules.
- `answer_ask` checks it first, before the policy above, by the tool call's whole input: a
  command's programs and subcommands, git's past its own options (`rm`, `chmod`, `sudo`, `git -C x
  config`, `git push --force` or `+ref`, `gh pr create`, `gh api` that writes, `stripe … create`,
  `docker rm`…), a request to a payment's or a message's service (an address like
  `https://api.stripe.com`), anything naming where keys are kept (`.ssh`, `.env`, `.netrc`…), a
  file written in place (`sed -i`, `>>`), an edit of `.env`, `.ssh/`, `.gitconfig`, and another tool
  by its name's words, in any case (`gmail_send_email`, `sendMail`, `create_pull_request`), unless
  its first verb only reads (`get_order`) and it reads no secret. It refuses with the kind in words:
  "That's a permanent delete, which always comes to the user".
- Every session a bot starts, and the bot's own conversation, carries engine rules that ask for
  them whatever its approval: `shell` for those programs, subcommands and services, and `edit` for
  where keys are kept and git's settings, after its own rules so they win over Approve All, then
  its own Don't Allows of commands again, so those stay Don't Allow. Nothing else of its rules
  moves, and its approval reads as it was (Ask First is its own `shell *` rule). Another tool (an
  integration's) can't be named ahead in the engine's rules: on Approve All, only the bot's answers
  and words hold it back.

**Goals** (bridge 0.9.122, feature `work.goals`, `work/goals.ts`): you give a bot a goal of any
length, a couple of hours or a month, and it takes it end to end. It's the conversation's own goal
("Goals", below: the agents bridge keeps the bot at it turn after turn), with a plan kept here
beside it.
- **Tools** (a bot's conversation only): `propose_goal` (`{goal, title?, steps: [text | {text, phase?,
  site?, after?: [step number]}],
  checks?: [{text, ok?, detail?, url?, button?}], spend?: [{what, cap, currency?, per?:
  day|week|month|goal}], public?: [text], projects?: [name], ends?, digest?:
  day|week|milestones|none}`) puts the card up, replacing one it proposed before (refused while one
  runs; `digest` is a day's for a plan in phases or of more than 12 steps unless it says);
  `goal_progress` (`{steps: [{step, state?: todo|doing|done|waiting|paused|skipped, progress?: 0–1,
  note?}]}`, `add?: [text | {text, phase?, after?}]`, `waiting?: {kind: you|judgment|outside, text,
  detail?, url?}`, `resolved?: [id or words]` (what waited and is dealt with), `spent?: [{what,
  amount}]` (one on no spend line is kept as waiting, kind `outside`), `watching?: [text]}`; all
  checked before any is kept; it says whether you're here); `may_publish` (`{step}`: yes only for a public step you switched on); `may_spend` (`{what,
  amount}`: whether it fits the line's cap in its period now); `finish_goal` (`{report, watching?}`).
  `start_session` takes `step` (its number or id), and that step's track lists the session.
- **Asked for**: `POST kuvo/work/goals/ask` `{session, goal}` (`/goal` in a bot's chat, from a
  client) has the bot plan it and propose it at once (`[Goal] …`) → `{text}`; 400 for a conversation
  that isn't a bot's.
- **Only you start it**: `POST kuvo/work/goals/<id>` from a client, `{action: start, public?: {<id>:
  bool}, wake?, digest?, ends?, spend?: [{cap?, per?}] (by line)}`, `{action: decline}` or `{action:
  stop}` → `{goal}` (`ends: null` starts it with no end, taking away the one the bot proposed; left
  out, the bot's stands); while it runs, `{action: change, …the same but start's}` (a cap raised past what's
  spent lets what spends go on; the bot is told `[Goal changed] …`) and `{action: clear, waiting:
  <id>}` (what waited, put away). An end written without a zone (`2026-11-30T18:00`) is in yours
  (`KUVO_TZ`, else the computer's). Never a tool, an agent's message or another computer's mail. 400 for one in the
  wrong state or a card from more than a day ago; 404 for none. Starting tells the bot `[Goal
  started] …` (what's switched on and off, what it may spend, the projects it may make, the end) and
  sets the conversation's goal with `long: true` (no brief of its own: this is it); declining tells
  it `[Not now] …`; stopping stops its work as `stop-all` does, and takes the conversation's goal
  away. The box's watch keeps the two as one: it sets the conversation's goal again where its bridge
  lost it, takes it away once the plan has ended, and shows the bot's own pause at a model's limit
  as the plan's (`paused` with `session` the bot's conversation).
- **`GET kuvo/work/goals`** and **`GET kuvo/work/goals/events`** (ndjson, now and at each change) →
  `{goals: [{id, bot, name, session, goal, title?, state: proposed|running|done|stopped|declined, steps:
  [{id, text, state, progress?, note?, phase?, site?, after?, sessions?, resumes?,
  began?, ended?}], checks: [{id, text,
  detail?, state: ok|needs|failed, by: bot|box, site?, action?: {kind: open|projectsFolder, label, url?}}], spend:
  [{what, cap, currency, per, spent, until?}], public: [{id, text, on}], projects, wake, digest,
  ends?, proposed, started?, ended?, waiting: [{id, kind: you|judgment|outside|ask, text, detail?,
  url?, site?, session?, at}], paused: [{why, until?, session?}], waited, watching, lastDigest?: {at, text},
  report?, alone}]}`: each bot's latest, while it's proposed or running, or ended within a day. Kept
  in `run/work/goals.json`; `kuvo/work/events` moves too. While it's proposed, the box's own checks
  come first: `alone` (failed where this box can't work on it alone yet), `power` (a Mac on battery),
  `projectsFolder` (needs, when the plan makes a project and none is picked). `progress` is given only
  where the bot counted it, always with what it counted in `note` ("3 of 8 pages"), which is what
  the apps show; a step without it is in progress, not some share of it. `site` (a step,
  a check or what waits, tied to a service: `stripe.com`, from its page's address or as the bot
  names it) is for the service's own icon, which each client loads from the site itself.
- **Alone, or with you there**: a goal goes on alone only where the box's commands run in the
  sandbox (`sandboxOn`, false until it's built in; a test box says yes with `KUVO_TEST_SANDBOX_ON=1`,
  never the real app's, `run.kuvo.code/box`, whose app takes it out). Elsewhere it runs all the same,
  with what its sessions ask waiting for you. Clients never say "sandbox" on the card: the check
  reads "This Mac can't work on its own yet".
- **The goal's own work**: the sessions the bot started since the goal did (a minute's slack); what it
  started before isn't the goal's.
- **Carrying on**: once nothing of the goal has been at work (the bot or its sessions) for 10
  minutes, then 30, an hour, two, four, eight and twelve, the bot is told `[Goal] Nothing of the goal
  is at work now…`, unless all that's left waits for you or a limit. Anything at work, or a
  `goal_progress`, starts the wait over.
- **Present or away**: you're here while a client is in use (`kuvo/attention`); the box keeps it in
  `run/work/here.json` for the tools. Whether you're here or not, unattended rules hold:
  - what its sessions ask that the bot hasn't answered in a couple of minutes, and what the bot
    asks itself, is listed as `waiting` (kind `ask`) and waits for you, however long: it never
    stalls the rest and is never said no to; it leaves the list once it's answered;
  - a session the bot starts for a goal is told you may not be watching: prepare, don't publish,
    deploy, send or pay unless its task says so;
  - while no public step is switched on, publishing and deploying (`git push`, `npm publish`,
    `vercel`, `wrangler deploy`, `docker push`, `gh release`…) ask too, in the bot's conversation
    and every session of its work, whatever their approval;
  - a project the plan names is made without asking.
- **Limits pause; they never end it**:
  - a session of its work whose turn failed at a model's limit (its words: a 429, a plan's window,
    a rate limit) is paused until the reset (`resetsIn` reads when from its words, counted from when
    the turn ended; 30 minutes otherwise), the steps it works on shown `paused` with `resumes`, and
    told `[Limit reset] … Carry on where you stopped.` once it comes, a box restart in between too;
    one that's gone or put away meanwhile is let go; the time anything was paused counts once in
    `waited`;
  - the bot's own turn at a model's limit pauses the conversation's goal ("Goals", below), shown as
    the plan's pause;
  - a day's limit you set (Edit Bot › Work, sessions or tokens a day) holds new sessions until your
    midnight, and the bot is told `[Limit reset] …` then;
  - a spend line's cap reached holds what spends on it until its period starts again (`until`); the
    rest carries on;
  - an end you set (`ends`) is the only one that ends it: the bot is told `[Goal's end] …` to finish
    the step under way and report, and two hours on, the box ends it (`stopped`, with a short
    report).
- **Keep-awake**: a Mac's box holds `caffeinate -s -w <its pid>` while a goal's work is at it (the bot
  or one of its sessions running), on power, and lets go while it waits or once it's over. A machine
  doesn't sleep. On a Mac, a goal goes on while Kuvo Code runs; asleep or closed, it picks up when
  the Mac wakes or the app opens again.
- **Your phones**: what waits for you (not the asks, which notify as asks do), once, as category
  `blocked` (`title` the bot, `subtitle` "Needs you", `data: {session, quiet: "1"}`, or `wake: "1"`
  for kind `you` where you asked to be woken); a digest as often as `digest` says (daily or weekly
  from its start, or as a phase is done), as `report` with `quiet: "1"` ("Day 3: 4 of 30 steps done,
  1 waits for you, waited 2 h at limits"), kept as `lastDigest`; and the report, once, as `report`.
  A Mac's box sends them while its phone link is on; the Mac app shows its own from
  `kuvo/work/goals`.

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
- **Setup** also sends the Mac's name (`macName`), which the bridge keeps by the Mac's key
  (`macNames`), dropped with that Mac, for `kuvo/info`'s `macs`.

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
| `data` | Where it opens: `session` or `group`; `request` for a permission or a form, with `requestSession` when the session asking isn't the one shown (a subagent's), and `answerable: "0"` when its notification mustn't answer it from buttons (it can't show all it covers, or some of its text shows as dots); `ask` for a browser ask; `quiet: "1"` for one that shows without lighting the screen or a sound (what a goal needs of you, its digest), and `wake: "1"` for what a goal needs of you where you asked to be woken. |

| Category | When |
| --- | --- |
| `permission` | An agent asks to do something. `request` is the permission. |
| `question` | An agent asks a question, or for a form filled in. `request` is the form. |
| `ask` | An agent browsing asks for a sign-in, a code or a step. `ask` is it. |
| `finished` | A run finished. |
| `failed` | A run stopped with an error. |
| `report` | A bot's run finished: a wake-up's or a watch's news, a goal's digest (`quiet`) or its report. |
| `blocked` | A bot's goal needs you (`quiet`, or `wake` where you asked to be woken). |
| `message` | Something in a group chat. |

A phone should ignore a category it doesn't know, and show the notification plainly.

The payload stays under 2,500 bytes, so the push fits the 4 KB Apple takes: a body that
doesn't fit is cut, ending in "…". Keys are sorted, as both sides write them.

Who sends it: each box, for what happens on it, so each notice comes once.

- **This Mac's box**, for the Mac's own sessions and group chats, as a machine's bridge words
  them, and for what agents ask as they browse in the Mac's panel, which its app hands it
  (`kuvo/attention/notice`, below); never a machine's. Like a machine, it holds each a little
  while a client is in use there ("kuvo/attention", below), and sends none while the Mac's phone
  link is off.
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
  notifications off it says none. Its own box hears it from the app, as the client `mac`, with
  what it showed of each machine's news (`"elsewhere": {"<machine>": [shown…]}`, by the machine's
  id); and the box tells each of its machines by mail (bridge 0.9.63; the app did before),
  `{"attention": {for, sessions, shown?}, "at"}`, each with its own `shown`, taken only from a Mac
  that set the machine up, and only when its `at` isn't older than that Mac's last (mail can come
  out of order). A Mac without the phone link on says nothing.
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
  seconds, for ten minutes; this Mac's box holds what it makes before its app says whether the
  phone link's on, and sends it once it's on. A permission or question held while the box couldn't
  hear its engine (it restarted, the stream dropped) is looked up when it hears it again, and let
  go if it isn't asked any more. A box keeps what it holds in `run/held-notices.json` (with when
  each was made, by the date, whether it was seen, and whether a client was in use), so the next
  one sends it if it stops first: what was held only because the relay wasn't there goes at once;
  what was held for a client in use keeps the rest of its hold, and a seen ask keeps waiting, for
  20 seconds while its clients say again that they're in use (a Mac renews every 15), then by their
  word as before. The Mac's own notifications are the same either way.
- **This Mac's app**, alone (`403` for anyone else), hands its box what only it knows:
  `POST kuvo/attention/notice {"notice"}`, a notice (`Notice`'s JSON) for an ask from its panel's
  browser, held and sent with the box's own; and `POST kuvo/attention/answered {"id"}`, a request or
  ask answered or gone there, whose notice, held, then never goes.
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
| `{"t": "ping"}`, `{"t": "pong"}` | Is the other end still there? The relay's own pings only reach the relay. The phone pings while a request waits with nothing from the host, once its own frames have gone out: a host whose connection died without closing takes frames until the relay notices, and never answers. No answer ends the session. A host that started again or left is told by the relay (`gone`), so a quiet session isn't checked. Answer at once. |

`h` holds `x-opencode-directory` and `content-type`; the host adds the engine's password
itself. Which route answers is told by its path before any `?`: a query string never changes it,
and a method is read in any case. Both are held to the same route scenarios (`Vectors/routes`), and
every answer of a box's own routes to its route's shape (`Vectors/routes/shapes`, from
`Packages/Box/src/shared/routes`): an object has only the fields its shape names; a field that can
be null is sent as `null`, never left out; and a refusal says why as JSON (`{"message"}`, or `{}`
when there's nothing to say), never with an empty body. A `kuvo/…` route a box doesn't have
answers `404 {}`; a path that isn't what it seems, `403`. A host serves:

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
  A coding agent's subagent says how it takes messages in `metadata.kuvo.messages`:
  `{"via": "direct"}` (Codex: a prompt goes to it, into its turn or a new one), `{"via":
  "parent"}` (Claude Code: the prompt shows in the subagent at once and reaches the conversation
  that started it as a `synthetic` note, `metadata.kuvo.relayedTo`, asking its agent to pass it
  on, which that conversation shows), or `{"via": "none", "note"}` (a prompt answers `400` with
  `note` to show). Without it (an older bridge): none. Its model is its agent's (`400`).
  `ClientSessions.SubagentMessages` reads it, for both apps.
- **What's been read** is the box's, never a client's, so a conversation read on one client is
  read on all of them, a machine's with the Mac closed too. A session (a bot's too) is unread
  while `time.idle` is later than `time.viewed`. Read it with `POST api/session/<id>/view`
  (`{"idle"}`, the `time.idle` it was read at; `kuvo/agents/api/…` for a coding agent's): the box
  keeps the later of that and what it had, and tells every client of a later look with `session.viewed`
  (`{"sessionID", "idle"}`) on `api/event` (an older coding agents' bridge keeps it without
  telling). Follow it: set `time.viewed` to `idle` when it's later, and clear what was shown for
  it (a notification). A group chat is read with `POST kuvo/groups/<id>/viewed`, and its `unread`
  changes in `kuvo/groups/events` (below).
- **A message while a command runs** is read at once. A message sent to steer
  (`delivery: "steer"`: yours, or another agent's letter) waits for the agent's next step, and an
  agent waiting on a command or a subagent it started in the foreground takes none until that
  ends. So each box, following its engine, moves what the agent waits on to the background once
  it has run for 3 seconds (`POST api/session/<id>/background`, the engine's Ctrl+B), and again
  every 3 seconds while the message still waits behind it: the agent reads the message now, and
  is told when the command ends (bridge 0.9.67). A message queued for after the turn, a wake-up
  (queued too) or the engine's own notes wait as before. The coding agents' sessions don't do
  this yet.
- `POST kuvo/shell/<id>/stop` (`{"session": "ses_…"}`, which may be left out): stops a command an
  agent left running, as Stop over the Mac's composer does: SIGTERM to its process group, so the
  engine sees it end and tells the agent, with what it printed; only if that can't be sent, the
  engine's own remove (which deletes the output, and the agent hears the command wasn't found).
  Answers `200 {"stopped": "signal"}` or `200 {"stopped": "removed"}`, or `404 {}` when no such
  command runs. The engine's commands, and a coding agent's (`shl_…`, through their bridge: bridge
  0.9.64; while the engine is down too, from 0.9.66). Every box does it for its own, a machine's
  with the Mac closed too.
- `kuvo/info`: what the host is and runs: `kind` (`mac` or `machine`), `name`, `engine` (its
  version), a Mac's `app` and a machine's `bridge` version (to show, never to compare: check
  `features`), `features` (below), whether its coding agents' bridge is up (`agents`), and
  `started`, when the engine running now came up, in seconds since 1970 (null while none runs): a
  restart changes it, so a phone tells the new engine from the old. Both name the folder of chats
  (`chats`: conversations of no project, made if it isn't there yet, so a phone can start the first
  one there through the engine, as for a project). A machine's bridge also says whether its engine
  is `running`, and whether it's `stopped` on purpose (it stays down until it's started, from a Mac
  or a phone), and `home`, the Mac that started its engine (`{"mac", "name"?}`, its name where
  its start noted one). It also says who uses it, for an uninstall to name whom it would stop it
  for: `macs`, the Macs that set it up (`[{key, name?, seen}]`: each one's key, its name where its
  setup gave one, `macName`, and when it was last heard from, in ms), and `phones`, how many phones
  reach it. A Mac also names `integrations`, each integration's name by its MCP
  server's (`{"microsoft-365": "Outlook and Microsoft 365", …}`), for a card when one asks something.
- `kuvo/agents/api/…`: the coding agents you already have (Claude Code, Codex, Cursor, Grok,
  Antigravity), through the agents bridge beside the host's engine, which answers the same paths
  as the engine for them: sessions, messages, prompts, permissions, questions, events
  (`kuvo/agents/api/event`) and models (`kuvo/agents/api/model`, only signed-in agents'). Its
  sessions carry `metadata.kuvoAgent` and run where that bridge does; a new session with one of
  their models (providers `claude-code`, `codex-cli`, `cursor`, `grok-cli`, `antigravity`) is
  made there, never on the engine. A Mac answers for its own; a machine's bridge for the
  machine's, with the Mac closed too: each machine signs in to them on its own, and has its
  own Custom Auto lists. `kuvo/info` has `agents: true` while the bridge is up; otherwise these
  answer 503. All of its API, but for the routes only the box and the app wire things with:
  `api/kuvo/engine` (where the engine is), `api/kuvo/groups` (group chats' own steps, which a
  phone takes through `kuvo/groups`) and `api/kuvo/artifacts` (what its browser downloaded; the
  record is read through `kuvo/artifacts`). The same on both (`Vectors/link.json`, `agentRoutes`).
  - A permission it lists (`…/session/<id>/permission`) has `sandboxed: true` when the agent asking
    runs in the box's sandbox now (its whole program started in it), which a bot answering it reads
    ("Work"); the engine's never have it.
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
  - `GET kuvo/accounts/ended` → `{providers: [id]}`, the plans whose sign-in in use ended (a run
    on one was refused, and it couldn't be renewed; the Mac says "Sign-in ended"), until a run on
    it works again or you sign in again (kept in `run/ended-sign-ins.json`, so every part of the box,
    `box route` too, says the same); `POST kuvo/accounts/<provider>/forget` is Disconnect, as
    Settings › Accounts does it: that box's sign-ins and keys for that plan (`404` for one that
    isn't a plan there, an integration's server among them). Every box from bridge 0.9.61
    (`accounts.ended`); a Mac before answered them itself.
  - `GET kuvo/accounts/found` → `{agents, opencode, shell, connected}`: what the computer already has, for
    the first launch's Bring your subscriptions. `agents`: the coding agents' programs (`{id, name,
    installed, signedIn, label?}`, `label` who it's signed in as). `opencode`: an opencode used
    apart from Kuvo Code (its `auth.json`), each `{id, integrationID, name, kind, connected}`: a
    `key` can come over, a `signIn` is done again here (both apps renewing one refresh token would
    sign each other out), and `connected` says the engine has a working one for it already (a key in the shell aside). `shell`: keys in
    the shell the engine uses (`{integrationID, name, variable}`). `connected` (from bridge 0.9.91):
    the engine's providers signed in and working, by integration (an expired sign-in or a key in the
    shell aside). Names
    only, never a key. `POST
    kuvo/accounts/found/use {id}` copies an opencode key in as the plan's sign-in in use (`200 {}`;
    `404` for one that isn't there, `409` for a sign-in, `503` with the engine down, `502` when it
    refused; each with `message`). Every box from bridge 0.9.79 (`accounts.found`).
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
  (the same that its `opencode.json` holds). Each computer keeps its own ("Settings per box"),
  and its box answers for them, a Mac's as a machine's: change a machine's on the machine's box,
  never through the Mac. `PATCH kuvo/config` with `{"changes":
  [{"path": ["mcp", "servers", "linear", "disabled"], "value": true}, …]}` changes some, as
  Settings does (a `null` value removes the key, and a level that isn't there is made; a path
  goes through objects only, so a list is sent whole, at its own path: 400 otherwise), and
  answers with the whole document; the computer's engine takes it at once (and says
  `config.updated`, which is when the Mac app reads it again, so a change to the rules reaches
  open sessions). A key a value names where another computer keeps its keys
  (`{file:<its folder>/KUVO_KEY_…}`, from Also Apply) is written as this computer names its own,
  so send it as the other computer has it. A change can say what it read at its path (`"was"`, `null` for
  nothing): changed since, nothing is changed and it answers `409 {"message"}`, so read again.
  `409 {"message", "problem"}` too while the file can't be read (it has comments, it's a link to
  a file that isn't there, it may not be read): it's left alone then, never taken for an empty one,
  and `problem` says why alone, for a page that names the file already. A box adds what its engine
  starts with to its settings once each, noted in `box/defaults-added` (a name a line), so one you
  take out stays out: bots' memory rule (`bot-memory`, in `permissions`), and on a Mac, as its box
  starts, web search through Exa (`websearch`, for settings that are new, empty or never given it;
  `search-exa`, Exa once in place of the `random` an older version chose).
  Settings › Permissions keeps its choices and rules under `permissions` (a list of
  `{action, resource, effect}`, effect `allow`, `ask` or `deny`) and its blocks under `policies`.
  Settings › Agents keeps its agents under `agents.<id>` (the engine's own, `build`, `plan`,
  `general`, `explore`, `title`, `summary` and `compaction`, whether named there or not), with
  `default_agent` the one new sessions start in; Settings › Commands, `commands.<name>`;
  Settings › MCP Servers, `mcp.servers.<name>`. A machine's box answers `409 {"message"}` until a
  Mac has made its settings its own ("Settings per box").
- `POST kuvo/config/apply` (`config.apply` in `features`): "Also Apply to…", changes made to
  another computer's settings made to this one's too, as its own settings have room for them.
  `{"changes": [{"path": [keys…], "before": …, "after": …}], "dry"?: true}`: each as it was made
  there (`before` and `after` left out or `null` for nothing), at most 100. A list of rules (a
  path ending in `permissions` or `policies`, an agent's own too) gets what was added there and
  loses what was taken out, keeping the rest of this box's own; anything else (another list, like
  a server's command, too) is set as it is there, with its keys named as this box names its own.
  What each computer keeps its own (`shell`, and a `worktree.directory` that's a whole path)
  stays; on a machine, a server that uses a Mac's own apps (the catalog's `macOnly`) stays off;
  and a field of an agent, command, provider or MCP server this box doesn't have isn't made (nor
  `default_agent` naming an agent it doesn't have), though adding or removing a whole one is.
  Answers `200 {made: [{path, value}], leftOut: [entry path], kept: [path], macOnly: [server],
  keys: [name], applied, settings}`, in one write: `keys`, those `made` names, which a client sets
  first (`kuvo/keys`) where this box hasn't its own, so ask with `dry` first, which changes
  nothing (and takes away a key it brought that the change didn't name after all, or one brought
  for a change that wasn't made); `applied`, something was made, or every change was already so (not when all of them
  stayed). 400 for changes that aren't these; `409 {"message", "problem"}` while the file can't
  be read, as `kuvo/config`.
- `kuvo/mcp/catalog`: Settings › MCP Servers' popular servers, `{"servers": [{id,
  title, summary, access, added, integration, macOnly}]}` (a machine's box for the machine,
  without `macOnly` ones): `access` is `signIn`, `open` or `local`; `integration` when Integrations added it (it's kept there, with its sign-in: don't turn
  it off or remove it); `macOnly` for one that uses the Mac's own apps (Chrome DevTools), which
  never reaches your machines, so leave it out of a machine's list. A box reads the list from its
  `bin/mcp-catalog.json`, which a Mac writes (on a machine as it connects, and in its own box as
  it starts it), with `macOnly`, every server that uses a Mac's own apps, integrations' too. `POST kuvo/mcp/catalog/<id>`
  adds one as its Add button does and answers with the settings, as `kuvo/config`; turn one off
  or remove it through `kuvo/config` (`mcp.servers.<name>`). The rest is the engine's: each
  server's status from `GET api/mcp`, connecting again with `POST
  api/experimental/mcp/<name>/connect`, a server's sign-in through `api/integration/<id>/connect/…`
  (its page comes back to `127.0.0.1:19876`: `kuvo/sign-in/return`), and the approvals saved for
  a project with `GET api/permission/saved?projectID=` and `DELETE api/permission/saved/<id>`.
- `kuvo/keys`: the computer's own integrations' keys (`KUVO_KEY_<INTEGRATION>_<NAME>`, as its
  settings name them; a bot's own aren't among them). `GET kuvo/keys` lists them, `{"keys":
  [name]}`; `GET kuvo/keys/<name>` answers `{"value"}` (404 for none, 400 for a name that
  isn't a shared key's), `PUT` with `{"value"}` sets one and `DELETE` removes it. This Mac's box
  keeps them in its Keychain, through its app ("Host interface"; `503 {"message"}` while the app
  can't be reached); a machine's in `~/.kuvo-code/box/keys` (`409 {"message"}` until its settings
  are its own).
  The engine reads one as it next reads its settings, so set the key before adding what names it
  (`kuvo/config`). An integration added on a machine names its keys
  `{file:~/.kuvo-code/box/keys/<name>}` there; on a Mac, `{file:<its keys' folder>/<name>}`.
  "Also Apply to…", from any client, is the same changes sent to each computer you pick
  (`kuvo/config/apply`), with the keys it names brought first from where you made them.
- Integrations, as Settings › Integrations has them, each computer's box its own (this Mac's,
  keys in its Keychain through its app; a machine's, keys in `~/.kuvo-code/box/keys`, with the Mac
  closed too; `409 {"message"}` until its settings are its own), from the catalog a Mac leaves in
  the box's `bin/integrations.json` (this Mac's app in its own box's as it starts it, with the ones
  that use its own apps). Where its keys can't be reached now (this Mac's app not answering),
  `503 {"message"}`.
  - `GET kuvo/integrations` → `{"integrations": [{id, title, summary, kind, symbol, site, how,
    way, keys?, help?, redirect?, by?, macOnly?, added, keysSaved?, health?, signIn?, signInEnded?, siteSignedIn?}],
    "engineDown"?, "problem"?}`, by kind in the page's order (`kind` is its title: "Mail and Calendar", "Chat",
    "Social", "Code and Work"). `way`: `official` (connect, then sign in), `token` (its maker's
    server, with a token you bring), `app` (your app's client ID and secret, made with `redirect`,
    then sign in), `package` (an open-source server, `by`, with the keys you bring; `macOnly` for
    one that uses the Mac's own apps, which a machine's catalog leaves out) or `browser`
    (the agent uses its site in the computer's browser: not added here; `siteSignedIn` says
    whether it's signed in there, on this Mac's box, as its app reads the panel browser's cookies;
    a machine's box can't tell yet, as its browser's cookies are read only by a Mac connected to
    it, so it leaves it out). `keys`: `[{name, label, prompt}]`,
    `keysSaved` whether the computer has them (left out while its keys can't be reached). `how` is the tag the page shows. Added: `health` is
    `connected`, `starting` (also just turned on, while the engine still says it's off),
    `waitsForCode` (Outlook, until its first use's code), `needsSignIn`, `failed` or `disabled`
    (turned off in MCP Servers, its settings' `disabled`: it won't start until it's turned on, so
    there's nothing to wait for; Settings says "Off", with Turn On). While its engine isn't running
    or doesn't answer, `engineDown` is true and an added one's `health` is left out (one turned off
    still says `disabled`). `signIn` is the
    engine's integration to sign in with, through
    `api/integration/<signIn>/connect/oauth` as any (its page returns to `127.0.0.1:19876`:
    `kuvo/sign-in/return`). `signInEnded`: one that needs signing in had a sign-in, now ended or
    set aside in Accounts (Settings says Sign In Again, not Sign In). `problem`: the settings
    file can't be changed.
  - `POST kuvo/integrations/<id>` with `{"keys"?: {"<name>": "<value>"}}` adds it, as Connect
    (or Add Key…) does: with the keys given, and those not given as the computer has them (Change
    Key may send only the one you changed); one added already is written again as it is then,
    with what another client changed meanwhile (the engine reads its keys again), and with new keys its server connects again a
    moment later, in the engine's own copy and in every folder it has open (`api/debug/location`;
    over `box route`, in a process of its own, `kuvo-link.js box reconnect <id>`). `200 {"integration"}`, as listed; `400 {"message"}` without the keys it needs;
    `404` for none; `409 {"message"}` for one used on its site, a settings file that can't be
    changed, or one removed while its keys were saved; `503 {"message"}` when its keys can't be kept (this Mac's Keychain, through its app).
  - `DELETE kuvo/integrations/<id>` removes it, as Remove… does: bots' own keys for it there first
    (each computer keeps its bots' keys itself: "Bots' own keys"), then it, its sign-in, what its
    server kept and its keys. `200 {}`; for one not added, `200 {}` when keys of it were left (a
    Remove that couldn't take them away: they go now), else `404`; `409 {"message"}` for a settings
    file that can't be changed, `503 {"message"}` when its bots' keys can't be taken away (nothing
    removed) or its own can't (removed, with its key still kept, which Remove again takes). A
    Mac's Remove… is its box's, through `BoxClient` (a machine's through `box route`).
  - Not on the box yet: bringing added integrations up to date as the engine starts (a package's
    pinned version, Code Mode off, keys named where the computer reads them) is the Mac app's
    (`Integrations.upgrade`), through `kuvo/config`, for its own box and each machine as it
    connects; a machine whose Mac doesn't connect keeps them as they were.
- Bots' own keys, as Edit Bot shows and changes them: a key a bot has of its own for an
  integration you bring a key for, used only in its conversation, kept on the computer the bot
  lives on (a Mac's bots' in its Keychain, which its box reaches through the app: "Host
  interface"; a machine's in `~/.kuvo-code/box/bot-keys`, with the Mac closed too). Each computer
  answers for its own bots; a Mac asked about a machine's
  bot answers `409 {"message"}`. A bot that works in a project uses that project's keys, and
  answers `409 {"message"}`. Where a box's keys can't be reached (this Mac's app not answering),
  `503 {"message"}`. Its folder's settings name each key's file where the engine reads it: on a
  machine `{file:~/.kuvo-code/box/bot-keys/<variable>__<BOT>}`; on this Mac in the app's folder
  for them (`KUVO_KEYS`), each named by its variable.
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
  - `DELETE kuvo/bots/<id>/keys` takes away every one, as it moves off the computer, those left
    from integrations no longer there too.
  - `POST kuvo/bots/keys/refresh` writes every bot's folder's settings again as its keys and the
    box's integrations are now (bridge 0.9.46), as a client asks after it changes the box's
    catalog (`bin/integrations.json`): `200 {}`. A box also does it as it starts. (A Mac before
    0.9.46 ran `kuvo-link.js box bot-keys-refresh` over SSH, which still does the same.)
  - Moving a bot (Move to Computer), its keys go with it: read where it lived, given where it
    goes, then taken away where it was.
- Skills, as Settings › Skills has them, each computer its own, kept by its box: the folder its
  engine reads them from (a machine's `~/.kuvo-code/config/opencode/skills`, with the Mac closed
  too; this Mac's box's, the app's engine's own, where a Mac has always kept them, named to it as
  `KUVO_ENGINE_CONFIG`). Every client, the Mac app too, reaches them through these routes. Its
  engine lists them (`api/skill`) and finds a change within a moment.
  - `GET kuvo/skills` → `{"folder", "folders", "github": {"<name>": {repository, path}}}`: the
    folder as its engine names skills' paths in it, the folders in it by name (not hidden ones),
    whether its engine lists them or not, which a new skill can't take, and which skills came from
    GitHub (the rest you added).
  - `kuvo/skills/<name>` (its folder's name): `GET` → `{"text"}`, its SKILL.md; `PUT {"text",
    "new"?}` writes it (`new`: a new one, named as Settings names one, lowercase a to z, digits and
    hyphens, and `409 {"message"}` when the name is taken, by a folder there or a skill the engine
    lists from elsewhere; without it, `404` for none, and `409 {"message"}` for one from GitHub,
    which stays as it came, as in Settings); `DELETE` puts its folder away, in Recently Deleted.
    `400 {"message"}` for a name that isn't a folder's. A 404 or 405 answers `{}`.
  - Recently Deleted (`skills.trash`): each box keeps a skill it put away for 30 days, in
    `trash/skills` in its folder, as `<folder>-<seconds>`: its name says when it was put away,
    never the folder's date. It clears what's older as it starts, once a day while it runs (a
    machine's while its bridge runs), and whenever its list is read, a restore is asked for or
    another skill is put away. The box decides it all; a client shows the list and sends Restore.
    - `GET kuvo/skill-trash` → `{"entries": [{id, folder, name, description?, deleted, goes}]}`,
      newest first: `id` names the entry, `folder` the name it goes back under, `name` and
      `description` are what its SKILL.md says (`name` is the folder's when it doesn't say),
      `deleted` when it was put away and `goes` when it's cleared, in seconds since 1970.
    - `POST kuvo/skill-trash/<id>/restore` → `{"name"}`: its folder back whole, under its name.
      `409 {"message"}` when a skill has that folder's name now ("There’s a skill called pdf
      now. Delete it first to restore this one."), or the engine lists one by that name from
      elsewhere ("There’s a skill called pdf in ~/.claude/skills, so this one can’t be restored
      under that name"; the one put away, which the engine can list a moment longer, doesn't
      count): neither changes, and the entry stays. `400 {"message"}` for what isn't an entry's
      id (a path, a hidden name), `404 {}` for one that isn't there (restored, or past its 30
      days). The skills routes' messages are written to show as they are, with curly
      apostrophes.
  - GitHub's collections, which a box reaches, never a client (the Mac app browses them through
    this Mac's box, and adds a skill through the box it's for): `GET kuvo/skill-library`
    → `{"repositories": [{id, owner, name, title, summary}]}`, the well-known ones; `GET
    kuvo/skill-library/<owner>/<name>` (any repository on GitHub) → `{"repository", "skills":
    [{name, path, files, about: {name?, description?}}], "partial"}`, each with what its SKILL.md
    says it is (`partial`: GitHub cut a very big one's list short); `GET
    kuvo/skill-library/<owner>/<name>/about?path=<path>` → `{name?, description?}`, one skill's.
    A box reads SKILL.md files from GitHub a few at a time, and keeps what they say while it runs,
    so a big collection (hundreds) never holds up another request; `POST
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
  - A machine connecting has `step` (`{name, sent?, total?, fraction?}`): `name` is `checking`,
    `downloading` (the engine's package to the Mac, `fraction` of it), `copying` (it, to the
    machine over SSH: `sent` bytes of `total`), `starting` or `reading` (its sessions), for a
    client to show how far. One whose box said who else uses it has `alsoUsedBy` (`{macs: [name],
    phones}`, this Mac left out), for Remove's dialog to name whom Uninstall would stop it for.
  - A machine another Mac runs has `home` (`{"name"?}`, that Mac's name where its start noted
    one, as `kuvo/info`'s `home` says it); one this Mac runs has none. `POST kuvo/machines/<id>/home` makes this Mac its home, as Make This Mac Its Home does:
    the engine starts again there as this Mac's, with this Mac's accounts; its sessions, bots and
    settings stay. `200 {"machine"}`, or `409 {"message"}` when this Mac runs it already, its
    agents are at work, or its box was set up by a newer Kuvo Code.
  - `DELETE kuvo/machines/<id>/addresses/<address>` stops using one of its other addresses (`404`
    for its name, or one it doesn't have); `POST kuvo/machines/<id>/same-as {"other"}` makes it one
    of `other`'s addresses, as Same Computer As does: `200 {"machine"}`, the other; `404` when
    `other` isn't another of the Mac's machines; `409 {"message"}` when the two told Kuvo Code
    different names and stay two machines.
- Settings › Worktrees: the git worktrees sessions run in, each box its own, kept and named by its
  box (a Mac's by its own box from bridge 0.9.35; before, by the app), with the Mac closed too.
  A Mac's app reaches every box's the same way, its own included, and follows its own as they
  change. Each box names a worktree's branch after its session once that has a title (in Latin
  letters: "Исправить вход" is `ispravit-vhod`), when its records are read, and tells the session.
  - `GET kuvo/worktrees` → `{"worktrees": [{path, folder, project, projectName, branch, base?,
    sessions, working, uncommitted?, ahead?, size?}]}`: `path` is the worktree's folder, `folder`
    where its session runs (the project's place in its repository), `project` its project's,
    `sessions` how many run there and `working` whether an agent is at work in one, as its engine
    says. What git says, left out when it can't say (a folder deleted by hand): `uncommitted`,
    changes not committed, which go when it's removed; `ahead`, commits `base` doesn't have, whose
    branch stays when it's removed. `size` in bytes. Where new ones go is `kuvo/config`'s
    `worktree.directory`. `?records=1` → `{"worktrees": [{project, root, folder, branch, base?,
    made?, prefix?}]}`, as it keeps them (without asking git), any whose session has a title by
    now named first; `made`, the branch one made there started on, and `prefix`, what its name
    starts with.
  - `GET kuvo/worktrees/events`: `application/x-ndjson`, `{worktrees}` as `?records=1` has them,
    now and again each time they change (`worktrees.events` in `features`: a box that has it keeps and names its worktrees itself, a Mac's included).
  - `POST kuvo/worktrees/remove {"path", "discard"?}` removes it as Remove… does: its folder and
    anything in it not committed (`"discard": false`: one with changes stays, `409`); its branch
    stays unless it's merged (`"forget": true`: it goes anyway, for one made for a session that
    never started; `409` when a session has it after all). `200 {}`; `409 {"message"}` while an
    agent works there; `502 {"message"}` when the engine couldn't remove it; `404 {"message"}` for
    one it doesn't have (removed already): a client takes it as gone.
  - For a new session's worktree, as the composer's Worktree makes one: `POST kuvo/worktrees
    {"project", "branchPrefix"?}` makes one of the project's repository on a branch of its own →
    `{project, root, folder, branch, base?, made, prefix}`; make the session in `folder`. `400`
    for a project that isn't a folder there, `409 {"message"}` when it isn't in a git repository,
    `503` while the engine isn't running. `POST kuvo/worktrees/record {project, root, folder?,
    branch, base?}` keeps one a Mac kept before its box did ("For released Macs"; `404` when it
    isn't there any more).
  - `GET kuvo/worktrees/where[?directory=<value>]` (`worktrees.where`): where new worktrees go
    with `value` as `worktree.directory` (none: the engine's own), as the engine reads it, so
    Settings shows real folders before and after you choose one → `{"directory", "default", "home",
    "projects": [{project, name, folder, exists?, canMake?, inside?, ignored?}]}`, one for each of
    the box's projects in a git repository with a commit. `name`: its folder's name, with the
    folders it's in when another project has the same one ("sums — scratchpad", "api — ~").
    `default`: the engine's own folder, where each project has one of its own (`folder` is null
    until the engine runs and says which). A relative value starts at the repository's own
    checkout, not the project's folder in it; `~/` at the home folder. `canMake` (for one not there yet): it can be made; `inside`: it's in the repository's
    checkout, and `ignored` whether git ignores it there (if not, git lists each worktree as new
    files).
- Changes (`git`, bridge 0.9.94): a project's changes as the Changes panel shows and works them,
  by the box's own git in its own folders, so a machine's work with the Mac closed and from a
  phone. A client parses the diff itself. Scopes: `uncommitted` (the default), `unstaged`,
  `staged`, `branch`. `404 {"message"}` for a folder that isn't there, `400` for a scope or a
  file that makes no sense (a file is a path in the repository, never absolute or climbing out).
  - `POST kuvo/git/changes {"directory", "scope"?, "base"?}` → `{"repository": false}` outside a
    repository, else `{"repository": true, root, against, patch, untracked, hashes, uncommitted}`:
    `root` the repository's top folder; `against` what it was compared with (`HEAD`, where the
    branch left `base` for `branch`, or git's empty tree before the first commit); `patch` git's
    diff of the folder's files with each whole file as context (`a/` and `b/` prefixes, paths not
    quoted, renames found); `untracked` the new files git doesn't know (not for `staged`; a
    repository inside this one ends in `/`), and `hashes` a stamp of each (its size and when it
    last changed, opaque to a client), by path, so a client reads one again (`kuvo/file`) only when
    it changed; `uncommitted`, anything not committed yet
    (always true but for `branch`). `500 {"message"}` when git couldn't say.
  - `POST kuvo/git/stage`, `…/unstage` or `…/discard` with `{"root", "path", "oldPath"?, "status":
    "added|deleted|modified|renamed", "scope"?}` → `200 {}`, or `422 {"message"}` with what went
    wrong. `path` as `kuvo/git/changes` lists it: a repository inside this one may end in "/"
    ("web/", bridge 0.9.95). Discard follows the scope (in `unstaged` only what isn't staged, otherwise back to the
    last commit); a new file, and anything in the way of one coming back (a folder where a file
    was, a file where a folder was), goes to the Trash on a Mac and to `~/.kuvo-code/trash`
    elsewhere, never deleted for good.
  - `GET kuvo/git/show?root=<repository>&object=<HEAD:path | :path>`: a file as git keeps it (a
    picture's old side), its bytes; `404` for one git doesn't have, `413` over 25 MB.
  - `POST kuvo/git/commit {"directory", "message", "push"?, "author"?}` commits what's staged, or
    everything in the folder when nothing is, and pushes when asked (a new branch is pushed and
    tracked) → `200 {}`, or `422 {"message"}` with git's words (a failed push: committed, but the
    push didn't go through). `author`: `GIT_AUTHOR_NAME`, `…_EMAIL`, `GIT_COMMITTER_NAME`,
    `…_EMAIL` from your shell, the only settings taken along. `POST kuvo/git/commit-diff
    {"directory"}` → `{"diff", "staged"}`: what a commit would take, cut short, for writing its
    message.
- `GET kuvo/folders[?path=<folder>&hidden=1]` (`folders`): the folders in one of this box's folders,
  for a client to choose one (Settings › Worktrees' folder) as a folder panel does → `{"path",
  "home", "parent", "folders": [{name, repository?}]}`, ordered as Finder orders names, without
  hidden ones unless `hidden=1`. No `path`, or `~`: the home folder; `~/` starts there. `parent` is
  null at `/`; `repository`, a git repository's own checkout. `404 {"message"}` for no folder there,
  `403` for one it can't read, `400` for a path that isn't a full one; each refusal with `reason`,
  why as the computer says it (`Permission denied`, `No such folder`, `Not a folder`), so a client
  never shows a folder it couldn't read as empty. With `files=1` (`folders.files`), its files too,
  as a Files panel lists a folder: `files`, their names in the same order (with `hidden=1`, hidden
  ones too; `.DS_Store` left out).
  `POST kuvo/folders {"path"}` makes a new folder in one that's there, as a folder panel's New
  Folder does → `{"path"}`; `409 {"message"}` for something there already, `404` when the folder
  it's in isn't there, `403` when one can't be made there, `400` for a path that isn't a full one.
- `GET kuvo/programs?name=<program>` (`programs`): whether the box has a program an MCP server's
  command names, found on its PATH as its engine finds it (a name like `npx`, or a path, `~/`
  from the home folder) → `{"name", "path"}`, `path` null when it hasn't; `"unknown": true` (and
  `path` null) for one it can't tell from the box (`./server`, from the server's working folder;
  `$HOME/x`); `400` without a name.
- `POST kuvo/providers/models {"url", "api"?, "headers"?}` (`providers.models`): the models a provider
  of your own lists at its address (`<url>/models`), asked from the box, so `localhost` is that
  computer, as the engine reaches it → `{"reached": true, "models": [id…]}`; `{"reached": true,
  "needsKey": true}` when it asks for its key first; `{"reached": false, "message"}` when nothing
  answers or what answers isn't a list of models. `api` `anthropic` asks as Anthropic's API does;
  `headers` are sent as given, except ones naming an environment variable or a file, and only to
  that address (a redirect isn't followed: `message` says where it points). `400` for an address
  that isn't http or https.
- `GET kuvo/plugins/search?q=<text>` (`plugins.search`): npm's packages Settings › Engine offers as
  plugins, found from the box itself (its network) → `{"packages": [{name, version, description?,
  weekly?}], "missing"?}`: with no `q`, the most used opencode plugins; otherwise opencode's
  packages `q` finds, the one `q` names exactly (`name`, `@scope/name`, `name@version`) first.
  `missing`: what `q` names that npm doesn't have (a name, or a version of one), for a client to
  say so before it's added. `502 {"message"}` when npm can't be reached. Whether a plugin loaded
  is the engine's `GET api/plugin` (a failed one has no `id`; its `source.target` is the name).
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
- `kuvo/bots`: the bots that live on the computer asked (each box answers for its own, this Mac's
  as a machine's, with its app closed too), by their session, with their `id` (`bot_…`, as group
  chats name their members), name and look; their job (`job`, what it does in a few words, shown
  under its name, and `jobDetails`, all of it); whether their wake-ups are paused, the next one
  (`wakes`, left out when none waits) and how many things each watches; `machine` (a machine's
  name, as it calls itself; left out on a Mac); `agents`: its conversation is with the coding
  agents, so it's read and written through `kuvo/agents/api/…` (a group chat's members carry the
  same flag); `personality` (its id) and `model` (`{providerID, id, variant}`) as Edit Bot shows
  them, left out when it has none; and `folder`, `project` (as the box names them; left out for a
  folder of its own) and `created`. A client asks each box for its own bots; what one last said
  shows while it's away. `GET kuvo/bots/events` follows the list (`application/x-ndjson`): the
  list now, then again each time it changes (`bots.events` in `features`).
  - A bot's job is its box's record of it (`job.json` in its folder): the bot keeps it with its
    set_job tool (`{summary, details}`), and Edit Bot can change it (`PATCH` with `job`); its memory
    is its own to write as it likes. A job from before that is taken once from where it was: the
    Job section of its memory (left there as it is; its details without its line), or else what
    Edit Bot wrote before memories kept jobs.
  - A box keeps each of its bots told what it is (its instructions, from its kit's words): at once
    when it's made or changed, and otherwise when what its conversation is told now isn't what it
    would be told (new words in an update or a personality's, or words an older Mac gave it): as
    the box finds its engine or its coding agents' bridge, as the bot's next run starts, and when a
    client asks (`POST kuvo/bots/retell` → `200 {}`, as this Mac's app does after it changes the
    kit). Its own rules for its folder are put right then too.
- Making a bot as New Bot does, on the computer it's to live on. `GET kuvo/bots/templates` is
  what New Bot offers there: `{"templates": [{id, name, job, instructions, look, personality,
  wantsProject}], "personalities": [{id, name, description, custom}], "looks": {colors, shapes,
  faces}, "startingModel": {"<place>": {providerID, id, variant} | null}, "projects": [{directory,
  name, machine}]}`. `startingModel` has one key: `mac` on a Mac, the machine's name on a machine.
  A template's `personality` and a project's `machine` are left out when there's none. `POST
  kuvo/bots` with `{name, look?, personality?, model?, project?, template?, job?}` makes one:
  `personality` by id (`preset.*`, or `custom.*` for one you made); without `look` or
  `personality`, the template's, or a random look; without `model`, the box's starting model.
  It answers `201 {"bot": <as kuvo/bots lists one>, "firstMessage"}`: from a template, the bot
  waits, and `firstMessage` is its job for your composer, to edit and send; `job: {line, details}`
  (a shared bot's, from File › Import Bot…) makes it wait the same way, with that job as
  `firstMessage`; otherwise it's null and the bot writes first. A machine's box ignores
  `machine`; a Mac's answers 400 for one (a bot for a machine is made on that machine's box).
  `request` (8 to 64 of `A-Za-z0-9_-`, the client's own id for this New Bot, kept as it sends it
  again) makes a repeat safe: once a bot's being made for it, the same `request` gets the same
  answer for an hour (a client whose connection dropped before the answer came tries again with
  it); one that wasn't made is tried again. Since a bot is made whole once it's started, whatever
  becomes of the request, a client that sends none can make it twice.
  Errors are `{"message"}`: 400 for a missing name or an unknown template, personality or
  project; 409 while its box has no kit yet (below); 422 for a model that can't run there (its
  account isn't signed in there); 503 when it couldn't be made.
- `PATCH kuvo/bots/<id>` with any of `{name, look, personality, model, job}` changes a bot as Edit
  Bot does (`personality: null` for the model's own way, `model` as `{providerID, id, variant?}`,
  `job` as `{line, details}`, the whole job, which replaces the one it had: its line on one line,
  without a sentence's end; both `""` for none; 400 for one too long): `200 {"bot": <as kuvo/bots
  lists one>}` (null when it no longer lists here by then, a move begun meanwhile), after a coding agent's model for a bot on the engine has carried its conversation
  on with them (its `session` is the new one, `agents` true). Errors are `{"message"}`: 400 for an
  empty name, or a look or personality there isn't; 422 for a model it can't use where it lives
  (the one it has is always kept); 404 for no such bot; 409 while it moves; 503 when it couldn't
  be changed (the engine is stopped). `DELETE kuvo/bots/<id>` deletes it as Delete Bot… does: its
  conversation, wake-ups, keys of its own and folder (to Kuvo Code's trash folder on a machine; on
  a Mac on to the Finder's Trash, through the app: "Host interface"); it leaves the group chats
  there too. `200 {}`, 404, or 409 `{"message"}` while it moves. Keys of its own that can't be
  reached as it's deleted (this Mac's app not answering) go the next time they can be. A machine's box notes a deleted
  bot in `~/.kuvo-code/bots/deleted.json`, for a Mac of 0.8.0-beta.1 or earlier.
- `POST kuvo/bots/<id>/arrived`: a bot whose folder and conversation a client just brought to this
  box from another computer (Move to Computer: the client holds it where it was, copies its folder
  and carries its conversation over, under the same id) is made this box's: what its folder says
  of where it works, the time zone its wake-ups go by and its rules (yours, from the machine's kit;
  this Mac's own clock on a Mac), its rules here (its approval with this box's Settings ›
  Permissions, as the Mac makes them, held to `Vectors/routes/box/approval.json`; a machine whose
  settings aren't its own yet keeps the rules it runs with; and its folder here), and what it's told here, one at a time with its other
  tellings. `200 {"bot"}`; 404 for no such bot here; 409 without the box's words, and 503 when its
  conversation here didn't take it, both of which the box puts right as the bot's next run starts
  (its folder and clock are set either way). Its keys of its own go with it through
  `kuvo/bots/<id>/keys…` on both computers. (An earlier client sends `{timeZone}`, which is
  ignored.)
- What a box makes and tells its bots with: its words, the same file on every box of a version
  (`bin/bot-words.json`, KuvoLink's `Resources/bot-words.json`), which a client puts beside the
  bridge as it connects and a release brings: New Bot's templates, Kuvo Code's own personalities,
  the looks a bot can have, and what a bot is told, filled in by the box for where it runs (this
  Mac, or a machine by the name a Mac calls it, in your time zone), its job, name, folder and
  personality. A box tells its bots its own words, whichever Mac connects (a box is never older
  than one that does). And its kit (`bots/kit.json` in its bots' folder), what's that computer's
  own: a machine's from a Mac, which gives it each time it connects (the name it calls the machine,
  your time zone, its projects, the model a new bot starts on, the rules new conversations start
  with, and the personalities you made, until the box's library has them), or else the machine's
  own; this Mac's from its app, as its box starts and as your personalities change. Without its
  words, or on a Mac without its kit, New Bot and changes to a bot there answer `409 {"message"}`.
  The approval new conversations start with and the model a new bot starts on come from a Mac for
  now; they're to become each box's own settings.
- A client keeps what you change of a bot whose computer is away (its machine not connected) and
  sends it as `PATCH kuvo/bots/<id>` once it's back, a later change on top of what waited; what
  the box then answers is what shows.
- `POST kuvo/groups` with `{name, members, purpose?, meeting?}` (members by bot `id`, at least
  two, of those `kuvo/groups/joinable` names) makes a group chat on the computer asked, as New
  Group Chat does: `201 {"group": <as kuvo/groups lists one>}`, 400 `{"message"}` without a name
  or two bots, 404 `{"message"}` for a bot that can't be in it. Moving it to another computer is
  the Mac's Move to Computer.
  `meeting` is `{next, every?, topic?}`: `next` in seconds since 1970, `every` as kuvo-wake writes
  it (`1d`, `weekdays`, `1w`…; null or left out for once). The computer the chat lives on sets it
  up (the agents bridge's `planMeeting`), on your clock, to the minute: a repeating one whose time
  has passed comes at its next round, weekdays skip the weekend, a time of day (and a week's day)
  is kept from then on, and an empty topic gets the default. 400 `{"message"}` for a one-off whose
  time has passed or a repeat there isn't. The chat lists it as `meeting: {next, topic, every?, at?,
  weekday?}`. What a chat doesn't have is left out of what it answers, never null: a purpose, a
  meeting's repeat, a message's author.
- `PATCH kuvo/groups/<id>` with any of `{name, purpose, members, meeting}` changes the chat as
  Edit Group Chat does (an empty `purpose` is none, `meeting: null` none): `200 {"group"}` (null
  when it no longer lists here by then, a move begun meanwhile), 400
  `{"message"}` for what can't be (no name, fewer than two bots, a bot that doesn't live where
  the chat does, a meeting as above), 404 for no such chat or bot, 409 while it moves. Each
  computer answers it for the chats that live there; `kuvo/groups/events` says what changed at once.
- `DELETE kuvo/groups/<id>` deletes the chat as Delete Group Chat… does: its messages and seats
  go, and its bots forget it. `200 {}`, for one that's gone already too; 409 `{"message"}` while it
  moves; 503 `{"message"}` when the coding agents' bridge there can't be reached. Each computer
  answers it for the chats that live there; `kuvo/groups/events` leaves it out from then on.
- A machine's box answers New Group Chat with the Mac closed too: a group chat of its own bots,
  which lives and runs there.
- `GET kuvo/search?q=<words>&limit=<n>`: sessions whose conversation has the words, for a
  client's sidebar search: `{"results": [{session, snippet, info}]}`, the latest first (at most
  `limit`, 20 unless asked, 50 at most), `snippet` a line's worth of the words around the first
  mention, `info` the session as the engine lists it (for a client that doesn't list it: an older
  one, archived).
  Every session of the box's engine and of its coding agents' bridge (archived ones too; not a
  group chat seat's or a coding agent's turn, nor their subagents'), with no regard for case or
  accents. A subagent's words find the conversation at the top of its chain, once (its own words
  first), with `subagent`, the subagent's session as the engine lists it (from bridge 0.9.93;
  before, subagents weren't searched).
  Only what was said and worked on is searched: what you wrote (not what Kuvo Code adds to a
  message's end), other agents' messages and wake-ups, the agent's replies, what each step worked
  on, and the commands you ran with their output; not who's speaking, nor the app's words for a
  step. The box keeps each conversation's text until its session changes. 400 `{"message"}`
  without `q`; 503 `{"message"}` while its engine isn't running or doesn't answer. Clients search each box they reach (feature `search`, from bridge 0.9.87) and
  say which computers they couldn't search.
- `kuvo/named`: who you can name with `&` in a message, as the Mac's composer offers them:
  `{"agents": [{session, name, kind, machine, project, about}]}`, every bot (`kind: "bot"`,
  `about` its job) then the latest sessions with a title (`kind: "session"`, `project` its
  project's name, `"Chats"` for a chat); `machine` is null for the computer asked, else where it
  lives: a machine's id, or, asked of a machine, a Mac's name for that Mac's own. A machine's
  bridge answers it too, with the Mac closed: its own, then those its other computers told it of
  (`Peers`). While its engine can't list them (starting), its own are as it last listed them
  (from 0.9.66). Insert
  `&` and the name, and send the message as it is: every box adds to a prompt it passes on
  (`api/…` and `kuvo/agents/api/…`) a block naming each agent the text names, from everyone it
  lists then (its `run/agents.json`; worked out again meanwhile, and waited for a moment only when
  a name after `&` isn't there yet), which the agent reads
  (bridge 0.9.64; before, only the Mac did, and a machine sent it without). The Mac and the boxes
  read the same cases (`Vectors/routes/names/agent-naming.json`). A message to a group
  chat (`POST kuvo/groups/<id>`) gets its block on the computer the chat lives on, from the agents
  there are to name there (not the chat's own bots), for every client alike: send only the words,
  and a block sent is not taken. Show a message
  without it: it ends the text, from a line `<named-agents>` (then a heading line, then
  `- &<name> (<session>): <what it is>` lines) to a line `</named-agents>`, before the
  `<review-comments>` and `<attached-files>` blocks. Show each `&<name>` it lists in bold
  (a bot's in its color), opening that session.
- A message a keyword sends (/plan's words, /loop's when it sends now) carries the keyword as
  typed, right after its words and before every other block: a line `<sent-with>`, the heading in
  `SentWithKeyword.swift`, the keyword on one line (`/plan`, `/loop every hour`), and a line
  `</sent-with>`. The client sending it writes it. Show the keyword in front of the message's
  words, drawn as the composer draws it (its mark for the "/", the rest in bold, in the accent;
  Plan's in orange). Taken back (Undo, a failed send, editing a queued one), it's the words
  alone, so sending them again sets no second loop.
- A prompt a phone sends (`POST api/session/<id>/prompt`, and `kuvo/agents/api/…` alike) gets a
  block at the end of its text that tells the agent it's from the phone: a line `<from-phone>`,
  the words in `FromPhone.swift`, and a line `</from-phone>`. Every box adds it, in the same
  words (this Mac's box since bridge 0.9.64; the app did before); send the text without it. Show a
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
  lets them go (not archiving's hold: they still wait until it's back, bridge 0.9.121); with `{"archived": true}` they're held as archiving holds them (a client that
  archived it on the engine directly says so), `false` lets go of only that hold. Both answer the
  list as it is then. `POST
  kuvo/wakes/<session>/cancel` with `{"wake": "<id>"}` or `{"watch": "<letters>"}` cancels one;
  `POST kuvo/wakes/<session>/now` with `{"wake": "<id>"}` sends it now (one that repeats still
  comes back at its time). Both answer `200 {}`, `404 {}` when there's no such one, `409
  {"message"}` while its conversation is on its way to another computer, or `503 {"message"}`
  when it couldn't go. Each box answers for its own sessions and bots, a Mac's and a machine's
  alike, with the Mac closed too: ask the box a conversation lives on (one that keeps none answers
  an empty list). A wake-up reaches the conversation as a
  message starting with `[Wake-up] `. `GET kuvo/wakes` lists every session with a wake-up or a
  watch at once, for the marks beside them in a list: `{"sessions": [{session, next, watching,
  wakes, watches, paused}]}` (`next`, the soonest, in seconds since 1970, left out when it has
  none; `wakes`, `watches` and `paused` as `GET kuvo/wakes/<session>` says them, so a client reads
  them all in one call, and left out by an older box). Bots' come with `kuvo/bots`. Each box
  lists its own.
- `POST kuvo/wakes/<session>/watch` with `{"every", "check", "note"}` makes a watch, as its agent
  makes one with `kuvo-wake watch`: `every` 5m or more, 2h or 1d, `check` a shell command run on
  that computer, `note` what to do when its output changes. It answers the list as it is then;
  `400 {"message"}` in `kuvo-wake`'s own words for what can't be one (20 watches already, say),
  `404 {}` for a conversation that isn't there, `409 {"message"}` while it moves.
  `GET kuvo/wakes/events` follows every conversation's wake-ups, watches and pause on the box,
  its bots' and sessions' (`wakes.events` in `features`), as ndjson: a line now and again each
  time they change (added, fired, canceled, paused), `{"sessions": [{session, wakes: [{id, due,
  note, every}], watches: [{letters, every, check, note}], paused}]}` with notes and checks whole,
  and only conversations that have any or are paused.
- `kuvo/asks` (`GET` or `HEAD`): what agents ask you for while they browse (a box's own; a Mac's, its machines' too): a
  sign-in (the fields the page has, and the accounts Passwords keeps for the site, never
  their passwords), a one-time code, or a step only you can do. `kuvo/asks/events` is the same
  list as a response that doesn't end: a line of JSON now, and another each time it changes.
  `POST kuvo/asks/<id>` answers one: `{"answer": "signIn", "username", "password", "save"}`
  (or `"saved": "<account>"`, which the Mac fills in from Passwords itself), `{"answer":
  "code", "code"}`, `{"answer": "done"}` or `{"answer": "declined"}`. What's typed goes into
  the page, never to the agent. An ask has `"passkey": true` once its site asked for a passkey
  (then, or in the ten minutes before): the browsers can't use passkeys yet, so a client tells
  you to sign in another way.
- A machine's bridge answers the same three for what's asked in that machine's
  browser, with the Mac closed too: `saved` is empty and `offersToSave` false (saved passwords
  are the Mac's), and a `saved` answer gets `400 {"message"}`. A Mac connected to the machine
  lists the same asks, by the same `id`: the first answer counts, and the ask goes from both.
  The browser keeps them in `~/.kuvo-code/run/browser-asks.json` for the bridge, and waits the
  whole 15 minutes for an answer while the bridge runs, rather than a few for a Mac.
- `kuvo/groups`: the group chats that live on the computer asked, with their bots (face, name, session), who's
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
  Each computer lists only its own, a Mac's as a machine's: ask each for its chats. The coding
  agents' bridge there runs them, and answers them itself (at `api/kuvo/link/groups…`, which
  the link passes on as it answers, a followed one line by line; this Mac's PhoneLink as a
  machine's `kuvo-link.js`), with every rule of what can be made or changed (503 while it isn't up
  or isn't answering: ask again; 404 only when none run there). One moving between computers isn't
  listed on either while it moves (held), and `POST kuvo/groups/<id>` and `…/undo` answer 409
  meanwhile. Moving one is on the Mac (Move to Computer), not the phone.
  `kuvo/groups/joinable` says who can be in a group chat made there: `{"bots": [<as a chat's
  members list them>]}`, every bot that lives there, the first made first, then the bots of your
  other computers that take a chat's turns ("Peers", group chats), each with `computer` (its
  computer's name). Offer exactly those in New Group Chat and Edit Group Chat for that computer
  (`features`: `groups.joinable`). A chat's members list a bot of another computer the same way:
  `id`, `name`, `look`, `session` (empty when that computer didn't say), `directory` (empty: its
  folder is on that computer) and `computer`. Don't open a member's conversation from a chat that
  has `computer`: it's on that computer, not the one asked.
- `kuvo/file?uri=<file:// URI>`: a file on that computer that an agent's reply or tool names
  (a picture it made, a file it shows you, a download), by its `file://` address, percent-encoded
  as a query value. Any file there its user can read, wherever it is: only your own clients reach
  it (never a peer), and they have that computer's terminals anyway. It answers `200` with its
  bytes and `content-type` (from its extension; `application/octet-stream` when unknown), `404
  {"message"}` for one that isn't there or isn't a file, `403 {"message"}` for one it can't read,
  `413 {"message"}` over 25 MB, or over `max` when it's given (`&max=<bytes>`: all a client would
  show of it), `400 {"message"}` for an address that isn't `file://`. Each box answers for its own files, a machine's with the Mac closed too.
- On a Mac, `kuvo/usage`: the menu bar's usage panel as its Bars view lists it (each provider's
  name, plan, brand color, mark as a PNG to tint, notice, whether it's outdated, and its lines as
  UsageKit writes them), whether a refresh is under way and when the last one ended;
  `kuvo/usage/events` streams it as it changes, and `POST kuvo/usage/refresh` refreshes it all.
  A Mac without the usage panel answers 404. Times are seconds since 1970.

### Goals

A conversation's goal ("/goal all tests in test/auth pass"): its agent works toward it on its own,
turn after turn, until a check after each turn finds it met. Each box runs its own, in its agents
bridge beside the engine, for the engine's sessions and the coding agents' alike, with no client
there (a machine's with the Mac closed too). The check reads the conversation and runs nothing: on
the engine, the session's model afresh, apart from the agent (OpenCode's free models answer only in
the session's own context, so there it's asked there); with the coding agents, their one-off
answer, another agent you're signed in to answering for one that has none (Antigravity, Cursor,
Grok). With none to answer, the goal pauses and says so. A client reaches them as `kuvo/agents/api/kuvo/goals…`
(the Mac app at `api/kuvo/goals…` on the bridge itself), on the box the conversation lives on, while
`kuvo/info` has `agents: true` (503 otherwise), where `features` has `goals`.

- `GET kuvo/agents/api/kuvo/goals` → `{data: [goal]}`: every goal on the box, a met one too until
  it's put away. `GET …/goals/<session>` → `{data: goal}`, or 404 when it has none.
- `PUT …/goals/<session>` with `{"condition", "long"?}` (at most 4,000 characters; `long` for a bot's
  goal with a plan, "Work › Goals": not briefed, checked or nudged here, only kept and paused at a
  model's limit) sets it, in place of one
  it had, and starts the agent on it at once: `{data: goal}`; 400 `{message}` for no condition or
  one too long, 404 for a conversation that isn't there, 409 for a subagent's (the conversation it
  works for has the goal), 503 when it can't be reached. A turn already under way counts only if
  the agent read the goal in it.
- `POST …/goals/<session>/pause` holds it (the turn under way ends as it would, and no other
  starts; a note already on its way to the agent still is); `…/resume` lets it go: its last turn
  is checked (however it ended), and it carries on unless that met it. Both `{data: goal}`, 404 when it has none, 409 for one that's over (set it
  again instead).
- `DELETE …/goals/<session>` puts it away, over or not: `{}`, or 404.
- A goal: `{session, condition, state, note?, pausedBy?, resumesAt?, long?, started, ended?, turns,
  checking, last?}`. A goal at a model's limit carries on with a word to its agent ("the limit has
  reset"), not a check of the turn that failed; a check that meets one waits too. A `long` goal's
  turns are only kept: its plan says when to carry on. `state` is `working`, `paused` (`pausedBy`: `you`, `error` (a turn failed, said
  in `note`), `stalled` (three turns in a row doing nothing) or `limit` (a hundred turns since it was
  set or resumed; or a model's limit reached, with `resumesAt`: it carries on by itself then, a box
  restart in between too, and `note` says until when)), `met`, or `unmet` (it can't be met as asked: `note` says why). `turns`: the agent's
  turns toward it, each checked; `checking`: a check is under way; `last`: `{verdict: "met" |
  "not_met" | "impossible", reason, at}`, its reason what's left or what shows it's met. Times in
  ms since 1970.
- The bridge's events (`kuvo/agents/api/event`) carry `kuvo.goal.updated` `{sessionID, goal}` for
  each change, `goal` null once it's put away (or its conversation deleted, over or not, also while
  the box was stopped).
- In the conversation, the goal's messages to the agent are notes (`synthetic`) whose text starts
  with `[Goal] `: show their `description` ("Goal: …", "Not met yet: …") as the goal's. A turn
  you stop pauses it ("The turn was stopped."); so does one that fails. A turn cut short as the box
  stopped is checked once it's back, as any turn, and one is never checked twice. While its
  conversation is archived (`kuvo.archived` in its metadata, or the engine's own), the goal waits,
  still `working`: its last turn is checked once the conversation is brought back (bridge 0.9.121).
- "/goal" in a composer: `/goal <condition>` sets it, `/goal` alone shows it, and `/goal pause`,
  `/goal resume` and `/goal clear` (or `stop`, `off`, `reset`, `none`, `cancel`) do what they say
  (OpenCodeKit's `GoalCommand`, for every client alike).

### Side questions, handoffs and reviews

Three more keywords each box answers in its agents bridge, as it does goals ("Goals"), and its
branches, for the engine's sessions and the coding agents' alike, with no client there: `kuvo/agents/api/kuvo/…` on
the box the conversation lives on (the Mac app at `api/kuvo/…` on the bridge), while `kuvo/info` has
`agents: true` (503 otherwise), where `features` names them. Each answers `400`, `404` (no such
conversation, or nothing of it), `409` and `503` with `{message}` to show. Times are ms since 1970.
A conversation deleted takes its side questions and its review with it (`kuvo.btw.removed`
`{sessionID}`, `kuvo.review.updated` with `review: null`), also one deleted while the box was stopped.

- **Side questions** (`btw`, "/btw <question>"; threads `btw.threads`): a question about a
  conversation, answered from what it knows (on the engine, from inside its context; with the
  coding agents, the conversation goes with the question), and kept out of it: the conversation
  is told nothing. A question can be followed up, in a side thread: each follow-up is answered
  with its thread so far (the latest dozen answers), and a new "/btw" starts a thread of its own,
  afresh. Each conversation keeps its own list (the newest 100), which a client shows apart from
  the conversation (the Mac's sidebar has them under it).
  - `POST …/kuvo/btw/<session>` with `{"question", "thread"?}` (at most 4,000 characters) →
    `{data: question}`, `state` `answering`; it's answered in a moment. `thread` asks it as a
    follow-up in that thread (`404` when there's no such thread); without it, it starts one. A
    question: `{id, session, thread?, question, state: "answering" | "answered" | "failed",
    answer?, error?, asked, answered?}`; `thread` is the id of the question that started its
    thread (its own for the first; one from before threads has none: a thread of its own).
  - `GET …/kuvo/btw/<session>` → `{data: [question]}`, oldest first; `GET …/kuvo/btw` → `{data:
    [{session, count, threads, latest}]}`, every conversation that has some (`threads`: how
    many side threads its `count` questions are in).
  - `DELETE …/kuvo/btw/<session>/<id>` takes one away, `DELETE …/kuvo/btw/<session>/threads/<thread>`
    a side thread, all of it, and `DELETE …/kuvo/btw/<session>` all of them.
  - Events: `kuvo.btw.updated` `{sessionID, question}` as one is asked and answered;
    `kuvo.btw.removed` `{sessionID, id?}` (a thread's, one for each of its questions).
- **Handoffs** (`handoff`, "/handoff [what to do next]"): a conversation carried on in a fresh one.
  Its model writes a handoff note from inside it, and a new conversation in the same folder, on
  the same model, effort, agent and permissions, titled "<title> (continued)", starts on that note
  (a note whose text starts with `[Handoff] `: show its `description`, "Carried on from “…”"), and
  on `next` when given. The two are linked in their metadata (`kuvo.handoffFrom`,
  `kuvo.handoffTo`; the rest of it kept): show the link in each.
  - `POST …/kuvo/handoff/<session>` with `{"next"?}` → `{data: handoff}`, `state` `writing`: the
    note takes a while. A handoff: `{from, state: "writing" | "done" | "failed", to?, title?,
    error?}`. `409` for a subagent's, one with no model yet, one being handed off, or one whose
    agent is working (wait for its turn to end); one whose agent starts while the note is written
    fails, and makes no new conversation.
  - `GET …/kuvo/handoff/<session>` → `{data: handoff}`, its latest while the box runs.
  - Event `kuvo.handoff` `{sessionID, handoff}` as it starts and ends: open `to` once it's `done`.
- **Branches** (`branch`, "Branch from here"): a new conversation with another one's words before
  a message of yours, made by its place (the engine's own fork, or the bridge's), and marked as
  branched from it in its metadata (`kuvo.branchedFrom`; where its source came from or was handed
  off to isn't carried over, and it starts unpinned and not archived; if the mark can't be written,
  it's answered without it). Show a conversation marked `kuvo.branchedFrom` or `kuvo.handoffFrom`,
  or `kuvo.startedBy` (one an agent started with its start_session tool, on a Mac or a machine;
  it opens nowhere by itself, and the mark isn't carried over to a branch either; older ones also
  carry `kuvo.beside`, which nothing reads),
  under that one when it's in the same list, newest first, and rank it in a list of the latest by
  its newest branch; a subagent's session (one with a `parentID`) is never shown so: it shows in
  the conversation it works for. A box from before branches answers `404` "Not available for this
  agent.": fork with the engine's own route, and mark it so yourself.
  - `POST …/kuvo/branch/<session>` with `{"before"}`, the message's id → `{data: session}`, the new
    conversation, marked. `400` with no `before`, `404` for a message not in it, `409` for a
    subagent's.
- **Reviews** (`reviews`, "/review"; scopes `reviews.scopes`): what `scope` names in the conversation's folder, read by a
  model with none of the conversation's context: on the engine, its own model afresh, or `model`
  when given; with the coding agents, its own agent (another one you're signed in to when it
  can't), `model` left out. A scope:
  - `{"kind": "uncommitted"}`, the default: the changes not committed yet (the folder's own, in
    its git: tracked files' diffs, against nothing before the first commit, and new files whole;
    a big new file is named with its size, and links and files that aren't text are left out);
  - `{"kind": "branch", "base"?}`: the branch's changes since it left `base` (when left out,
    main or master, yours or origin's, whichever is newer, or origin's HEAD), with those not
    committed yet;
  - `{"kind": "commits", "from", "to"?}`: what the commits after `from`, up to `to` (HEAD when
    left out), changed, git's `from..to`; `from` as `<commit>^` starts with that commit, the
    first one too ("/review since <commit>");
  - `{"kind": "folder", "path"}` and `{"kind": "project"}`: the files themselves, of a folder in
    the project (a path inside it, never `..` or absolute: `400`) or all of it, numbered line by
    line: those git keeps or would (all but hidden ones and `node_modules` out of a repository),
    but for links, lock files, `.env` files, big files and ones that aren't text;
  - `{"kind": "described", "words"}` (bridge 0.9.101, when `choices` says `describes`): the files
    `words` describe ("the auth module and its tests", "the files I changed today"), which the
    conversation's model picks from the project's files, told what git says was worked on lately
    and today's date; then read as a folder's are. A client sends only `words` (500 characters at
    most); the box finds the files, keeps them for half an hour for the same conversation and
    words (so a review asked for after `measure` reads the same ones), and a review's `scope` has
    them as `paths` once found. Words that fit no file are `422` with what to do.

  One too big to read at once is read in parts, one after another (at most 30; more is left out,
  and its summary says how many files), each by a fresh model.
  - `POST …/kuvo/reviews/<session>` with `{"model"?: {providerID, id}, "focus"?, "scope"?}` →
    `{data: review}`, `state` `reviewing`; `409` while one is under way, `400` for a scope that
    makes no sense. `focus` is what to look at especially, as the user wrote it ("/review with
    <model> <focus>"), or `security`, `performance` or `accessibility`, which the box spells out
    for the reviewer. A review: `{id, session, state: "reviewing" | "done" | "failed", model?,
    scope?, focus?, progress?: {read, of}, stopped?: {read, of}, summary?, findings: [finding],
    error?, fix?, started, ended?}`, its findings bugs first; `scope` is left out for the changes
    not committed yet, `progress` is there while one read in parts is under way (`read` of `of`
    parts), its findings so far in `findings`, and `stopped` says where Stop ended one. A finding: `{id, title, explanation, severity: "bug" | "risk" | "nit",
    locations: [{file, line?, endLine?}]}`: what's wrong in a line, why and how to fix it (`""`
    when the title says it all), and every place it's in, none when it's about the change as a
    whole (a missing test). `fix` is what to send the agent, as your message, to fix them all.
    `parts` (`reviews.parts`, bridge 0.9.102) are what it reads, each part by a reviewer of its
    own: `[{n, of, files, state: "waiting" | "reading" | "done" | "failed" | "stopped", found,
    session?, now?}]`, `files` the part's first 200, `found` what it found. On the engine each
    part reads in a session of its own, `session`: under the conversation (`parentID`), marked
    `kuvo.reviewPart: {review, part, of}` and kept out of lists like the box's other runs, its
    agent `plan` with rules that let it read the project and nothing more. Its folder is the box's
    own (`reviewers` beside its reviews, a git repository with one empty commit), reading the
    project from outside it, so no "Always allow" saved for the project reaches it (a box that
    can't make that folder so, without git, fails the part, saying why, rather than read it
    elsewhere); `kuvo.messages` says it takes none. A client opens it as it
    opens a subagent's, to watch it read and to look at it after; it goes when the review is put
    away or another takes its place. `now` is what it's doing as it reads ("Reading src/a.ts",
    "Looking for “token”", "Thinking", "Writing what it found"), told as it changes (not kept),
    gone once it's done. Stop stops the part reading (`stopped`); those after it stay `waiting`.
    A review's only part stopped from its own session ends the review as its Stop does. Parts'
    sessions no kept review records (made as the box stopped) are deleted once the box's engine
    is there again, and one left reading is stopped.
    With the coding agents a part has no `session`. A box from before `parts` leaves it out.
  - `POST …/kuvo/reviews/<session>/measure` with `{"scope"?}` → `{data: {files, parts, leftOut,
    commits?, found?}}`: how much a review of it would read, to show before asking for a big one
    (`commits` for a branch or a range of them, `found` the first 10 files found for described
    words that it reads); `422` with what's wrong when it can't be read (not a repository, no such
    commit or folder, words that fit no file, or only files it can't read), `503` when the model
    couldn't be asked. Described words still being found are waited for, not asked again, by a
    review or another `measure` meanwhile.
  - `GET …/kuvo/reviews/<session>/choices` → `{data: {repository, branch?: {name, base, commits},
    commits: [{id, short, title, time}], folders: [{path, files}], describes?: true}}`: what "What to review"
    offers in the conversation's folder: the branch it's on with its base and how many commits
    of its own (left out on the base itself), its 30 latest commits (`time` in ms), and its
    folders by path, with how many files each has at any depth (500 at most, shallowest first).
    Out of a repository, `repository` is `false` and only the folders come. `describes` says it
    reads what you describe (`described`; a box from before leaves it out).
  - `POST …/kuvo/reviews/<session>/stop` → `{data: review}`: one under way ends where it is,
    `done`, keeping what it found so far (its summary says how far it got); `409` once it's over.
  - `POST …/kuvo/reviews/<session>/fix` with `{"findings"?: [id]}` → `{data: {text}}`: what to send
    an agent, as your message, to fix them all or those it names, wherever you send it (this
    conversation, a new one, another); `404` when the review found nothing, or none of them is
    in it any more.
  - `GET …/kuvo/reviews/<session>` → `{data: review}`, its latest; `GET …/kuvo/reviews` → every
    conversation's; `DELETE …/kuvo/reviews/<session>` puts it away (one under way is let go: its answer isn't kept).
  - Event `kuvo.review.updated` `{sessionID, review}`, `review` null once it's put away.

The same bridge also gives voice input the words to listen for in a conversation (a speech model
is prompted with them), for the engine's sessions and the coding agents' alike:
`GET …/kuvo/voice/words/<session>` → `{data: {words: [string]}}`, at most 100, most useful first
(ask when listening starts). They're the project's own names: its folder's (and its repository's),
the names said in the conversation's newest messages, its packages', the files changed lately (each
with and without its extension), then its other folders and files. Never anything of `.env`
files, nor long hex or random-looking strings. `404` for a conversation that isn't there, `409`
for one with no folder.

### Features

`kuvo/info`'s `features` names the routes the box has, so a client checks a name, never a version
(`app`, `bridge`), before it shows what needs a route. A route it names can still refuse for now,
with a message to show: `503` while the engine or the coding agents' bridge is down (or, on this
Mac, its app for its keys), and on a
machine `409` for `config`, `config.apply`, `keys`, `mcp.catalog` and `integrations` until a Mac has made its
settings its own. A name comes with what it names and never changes meaning; one the client
doesn't know, it ignores. Both boxes are held to their lists by
the route scenarios (`Vectors/routes/routing.json`).

| Name | What it answers |
| --- | --- |
| `accounts.credentials` | `kuvo/accounts/credentials` |
| `accounts.found` | `kuvo/accounts/found`, `…/found/use` |
| `agents` | `kuvo/agents/api/…`: the coding agents (`agents` in `kuvo/info` says whether their bridge is up now) |
| `asks` | `kuvo/asks`, `…/events`, and answering one |
| `attention` | `kuvo/attention` |
| `bots` | `kuvo/bots` |
| `bots.events` | `kuvo/bots/events` |
| `bots.job` | a bot's job as its box's record: `jobDetails` in `kuvo/bots`, `job` in `PATCH kuvo/bots/<id>` |
| `bots.make` | `kuvo/bots/templates` and `POST kuvo/bots` |
| `bots.edit` | `PATCH` and `DELETE kuvo/bots/<id>` |
| `bots.keys` | `kuvo/bots/<id>/keys…` |
| `config` | `kuvo/config` |
| `config.apply` | `POST kuvo/config/apply` |
| `keys` | `kuvo/keys…` |
| `mcp.catalog` | `kuvo/mcp/catalog…` |
| `engine.restart` | `POST kuvo/engine/restart` |
| `file` | `kuvo/file` |
| `folders` | `kuvo/folders` |
| `folders.files` | `kuvo/folders?files=1`: a folder's files too, and `reason` on a refusal |
| `git` | `kuvo/git/…`: Changes (bridge 0.9.94) |
| `goals` | `kuvo/agents/api/kuvo/goals…`: goals ("Goals") |
| `btw` | `kuvo/agents/api/kuvo/btw…`: side questions ("Side questions, handoffs and reviews") |
| `btw.threads` | a side question's `thread`, follow-ups and a thread's removal (bridge 0.9.98) |
| `handoff` | `kuvo/agents/api/kuvo/handoff…`: handoffs |
| `branch` | `kuvo/agents/api/kuvo/branch/<session>`: Branch from here, marked |
| `reviews` | `kuvo/agents/api/kuvo/reviews…`: reviews with fresh eyes |
| `reviews.scopes` | a review's `scope`, `measure`, `choices` and `stop` (bridge 0.9.97); without it a box reads the changes not committed yet whatever the scope |
| `reviews.parts` | a review's `parts`, each on the engine read in a `session` a client can open (bridge 0.9.102) |
| `groups` | `kuvo/groups`, `…/events`, one chat's events, and writing, stopping, keep going, viewed, undo and start |
| `groups.make` | `POST kuvo/groups` |
| `groups.edit` | `PATCH kuvo/groups/<id>` |
| `groups.delete` | `DELETE kuvo/groups/<id>` |
| `integrations` | `kuvo/integrations…` |
| `named` | `kuvo/named` |
| `moves` | `kuvo/moves`, `…/places`, `…/events`: Move to Computer, done by the boxes (bridge 0.9.108) |
| `agent-tools` | `POST kuvo/agent-tools`: the agents' tools, answered by the box (bridge 0.9.100) |
| `sessions.start` | `POST kuvo/sessions`: a session started with a task (bridge 0.9.100) |
| `letters-read` | (in a peer's agents' mail) it takes a letter with `read` (bridge 0.9.100) |
| `queue` | `kuvo/sessions/<id>/queue…`, `…/stop` and `kuvo/sessions/queues/events`: the box carries the queue (bridge 0.9.100) |
| `work` | a bot's work ("Work"): `kuvo/work`, `…/events`, `kuvo/bots/<id>/stop-all`, `start_session`'s and `kuvo/sessions`' new fields, the work tools, `limits` in `kuvo/bots` (bridge 0.9.106) |
| `work.projects` | a bot's projects ("Work", Projects): `make_project`, `list_projects`, `kuvo/work/asks`, `…/events`, `POST kuvo/work/asks/<id>`, `kuvo/work/settings`, `POST kuvo/projects/new`, `madeBy` on projects, `allowed` in `kuvo/bots` (bridge 0.9.107) |
| `search` | `kuvo/search` |
| `personalities` | `kuvo/personalities…` |
| `personalities.events` | `kuvo/personalities/events` |
| `phones` | `kuvo/phones` and `POST kuvo/phones/remove` |
| `phones.pair` | `kuvo/phones/pair` |
| `plugins.search` | `kuvo/plugins/search` |
| `programs` | `kuvo/programs` |
| `providers.models` | `POST kuvo/providers/models` |
| `sessions.agents` | `POST kuvo/sessions/<id>/agents` |
| `shell.stop` | `POST kuvo/shell/<id>/stop` |
| `sign-in.return` | `POST kuvo/sign-in/return` |
| `skills` | `kuvo/skills…` and `kuvo/skill-library…` |
| `skills.trash` | `kuvo/skill-trash…`: Recently Deleted, and restoring from it |
| `sandbox` | `kuvo/sandbox` ("Sandbox", bridge 0.9.118) |
| `sandbox.check` | `reason`, `action` and the rest in `kuvo/sandbox`, and `POST kuvo/sandbox/check` |
| `sandbox.asks` | `kuvo/sandbox/asks…`, `kuvo/sandbox/allowed…` and `kuvo/sandbox/tools` ("Sandbox", "Asks", bridge 0.9.118) |
| `wakes` | `kuvo/wakes`, a session's, and cancelling one or sending it now |
| `wakes.edit` | adding one (`POST kuvo/wakes/<session>`) and pausing them |
| `wakes.events` | `kuvo/wakes/events`, and making a watch (`POST kuvo/wakes/<session>/watch`) |
| `worktrees` | `kuvo/worktrees…` |
| `worktrees.where` | `kuvo/worktrees/where` |
| `engine.start` | a machine only: `POST kuvo/engine/start` |
| `groups.joinable` | `kuvo/groups/joinable` |
| `groups.seats` | its bots take turns in chats on other computers ("Peers", group chats) |
| `update` | a machine only: `kuvo/update` |
| `accounts.ended` | `kuvo/accounts/ended` and `POST kuvo/accounts/<provider>/forget` (a machine from 0.9.61) |
| `claude-code` | a Mac only: `kuvo/claude-code` |
| `hosts` | a Mac only for now: `kuvo/hosts…` (a machine's box can't do this yet on Linux) |
| `mac` | a Mac only: `kuvo/mac` |
| `machines` | a Mac only: `kuvo/machines…` |
| `usage` | a Mac only for now, while it has the usage panel: `kuvo/usage…` (a machine's box can't do this yet on Linux) |

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
 "macs": ["<each Mac that set it up>"], "macSigns": {"<Mac>": "<its signing key>"}, "macSeen": {"<Mac>": <when it came, here>}, "macNames": {"<Mac>": "<its name>"},
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

### This Mac's box

A Mac runs the same box a machine does: its keeper ("The keeper", below) starts `kuvo-link.js serve` (bridge 0.9.33 and
later) beside its engine, with the engine's Bun and `KUVO_HOME` in the app's own folder
(`~/Library/Application Support/run.kuvo.code/box`), never `~/.kuvo-code`, and
`KUVO_ENGINE_CONFIG`, the app's engine's settings folder (its `XDG_CONFIG_HOME`), where it keeps
the skills a Mac has always kept ("Skills"). It answers the box's
routes over HTTP on `127.0.0.1`, as the agents bridge answers the app: it says `{"url"}` on its
first line once it listens, takes only Basic `opencode:<OPENCODE_PASSWORD>`, checks a path as
the relay does (403 for one that isn't what it seems), sends a stream as it comes (a line at a
time for `application/x-ndjson`), and goes when its stdin closes. It finds the engine and the
coding agents' bridge as on a machine, by `run/engine.json` and `run/bridge.json`, which the keeper
writes (only you can read them) as they start and removes as they stop.

#### The keeper

This Mac's box keeps running whether or not the app is open, as a machine's does with its Mac
closed: its keeper is Kuvo Code's own executable run with `--box`, which launchd starts from the
launch agent in the app (`Contents/Library/LaunchAgents/<bundle id>.box.plist`, registered with
`SMAppService` the first time the app opens), at each login and again if it stops by itself. It has
no window. It runs the engine, the box and the coding agents' bridge, starts each again when it
stops (up to three times in five minutes), and records each in the box's `run` folder, as a
machine's keeper does, so a client finds them there:

- `run/keeper.json`: `{"pid", "version", "build", "url", "password", "started"}` (milliseconds).
  `run/keeper.lock` is held while it runs: one at a time.
- `run/engine.json` and `run/bridge.json`, as on a machine; `run/engine-stopped` (its reason) when
  the engine stopped and isn't started again until asked.
- `run/serve.json`: `{"pid", "port", "password"}`, where the box answers.
- `bin/kuvo-start`: as a machine's (`kuvo-start restart`), here calling the keeper
  (`--box-control`).

It answers on `127.0.0.1` at `url`, to `Authorization: Bearer <password>`: `GET status` (`pid`,
`version`, `build`, `started`, `engine {state: starting | downloading | ready | failed, progress?,
reason?}`, `busy`, `updating`, and `box`/`agents` `{failure}` when either stopped for good), and
`POST` `restart-engine`, `restart-agents`, `restart-box`, `stop` (Stop Background Work: it stops
everything and itself, and launchd leaves it stopped until the app opens or you log in again),
`update {within?}` (an app of another version opened: it goes once nothing is under way on the
engine or with the coding agents, or after `within` seconds, 30 minutes unless given, and launchd
starts the installed app's), and `app {tools?, host?}` (below).

The app is a client: it reads those records (again as the `run` folder changes) and connects to
the engine, the box and the bridge as they say, starting the keeper with launchd when there's none.
While macOS doesn't let the keeper run (switched off in Login Items & Extensions), the app runs the
same three itself, and they stop when it quits.

The engine and the agents reach Kuvo Code's own tools through the keeper's own MCP server,
whose address doesn't change as the app opens and quits: the open app says where its tools answer
(`app {tools: {url, token}}`, again whenever a new keeper starts), and each call goes there as it
is. With the app closed, the tools are listed as the app last listed them (`run/tools-list.json`),
and the keeper answers them through this Mac's box, as a machine's `kuvo-browser.js` does: the
agents' tools (`POST kuvo/agent-tools`), wake-ups (kuvo-wake), `set_job` (`PATCH kuvo/bots/<id>`),
the vault (`POST kuvo/vault/tools`), and show_file, show_widget and mark_final. Only the browser's
tools and show_in_panel need the app: a call answers `isError`, saying Kuvo Code must be open.

Its group chats run in its coding agents' bridge, as a machine's do, with folders in the app's
own: the chats in `groups` (`KUVO_GROUPS`), its bots' in `bots` (`KUVO_BOTS`), what it lets go
of in `box/trash` (`KUVO_TRASH`; the bridge says `kuvo.group.trashed {id, path}` and the app moves
it to the Finder's Trash), and who can be named with `&` in `box/run/agents.json`
(`KUVO_AGENTS_FILE`, as a machine's `run/agents.json`, which the box writes: "Peers"). `KUVO_BOX=mac` says
it's a Mac's: its bots are the Mac's own (`machine` left out), made with the words the app puts in its
`bin` and the kit it gives it in their folder (`bots/kit.json`, what's this Mac's own), with no time zone of
their own (they go by the Mac's clock). Its bots remember its
chats under `kuvo.groups` (`KUVO_GROUPS_MEMORY_KEY`). The box passes a client's `kuvo/groups…`
on to that bridge, as a machine's does (bridge 0.9.65; the app did before), saying "Group chats on
this Mac are starting" or "aren't answering" when it can't. The box carries its group chats' mail (`seat`, "Peers")
on its relay connection, as a machine's bridge does, and tells the bridge who your machines and
their bots are (bridge 0.9.63).

Its engine settings (`kuvo/config`, `kuvo/config/apply`, `kuvo/mcp/catalog`) are where the app's
engine has always read them, `opencode/config/opencode/opencode.json` in the app's folder: the
app gives the box the engine's settings folder (`KUVO_ENGINE_CONFIG`, the engine's
`XDG_CONFIG_HOME`), so nothing moves. They're its own from the start (never `409`). Its keys
(`kuvo/keys`, and those Settings › Integrations adds with, `kuvo/integrations`) stay in the Mac's
Keychain, under the service they've always had: the box asks the app for them ("Host interface")
and names them where the app writes them for the engine to read (`KUVO_KEYS`, in the app's
temporary folder), never in its own folder. What integrations' servers keep (a sign-in) is in the
app's `integrations` folder (`KUVO_INTEGRATIONS`), as the engine runs them with it. The app puts the popular servers in its
`bin/mcp-catalog.json` as it starts it, and those that use a Mac's own apps are listed and added
there.

#### Host interface

What only the app can do for this Mac's box, the box asks the app for (bridge 0.9.46): the keeper
answers it, as Kuvo Code's own executable (so the Keychain trusts it as it trusts the app), and asks
the open app for what only it can answer (what the panel's browser is signed in to, the Mac's own
routes for a phone: `app {host: {url, password}}`), answering `503 {"message"}` while it's closed. Its keys,
which the app keeps in the Keychain, and (bridge 0.9.50) what its browser is signed in to, and moving what it lets go of to the Finder's Trash. The app listens on `127.0.0.1` and, each time it
starts listening, writes where and with what password to the box's `run/host.json` (`{"url",
"password"}`, made `0600` and moved into place; bridge 0.9.60). It takes it away before each start,
when it stops, when it can't start, and as it quits; one a crash left behind stays until the next
start. The box reads it again for each call, so a host interface the app started again (it does,
whenever it fails, and with Try Again in Settings) is reached at its new address without the box
starting again, and every client's streams stay open. Before it sends anything else there, the box
makes sure it's the app, not whatever took a left-behind file's port: `hello {"nonce"}` (a random
nonce, asked without the password) → `{"proof"}`, the HMAC-SHA256 with the password, in hex, of
`kuvo-host-hello\0<nonce>\0<host>:<port>`: where the box reached it, which the app answers with its
own (`127.0.0.1:<port>`), so a proof relayed from the app at another port (by another user's
process on this Mac, which can't read the file) is wrong there. Without that proof, its keys can't be reached (`503 {"message"}`); with it, nothing is asked
again until the file changes or the app stops answering there. The box is started with `KUVO_KEYS_ON_HOST=1`: without the file, its
keys can't be reached (`503 {"message"}`), never kept in files of its own. Before 0.9.60 the app
passed `KUVO_HOST_URL` and `KUVO_HOST_PASSWORD` in the box's environment, which the box still uses
while there's no file, taking the password out of its environment as it starts so nothing it runs
has it. Each other call is a `POST` with `Authorization: Bearer <password>` and `content-type:
application/json`:

- `keys/names {"prefix"?, "suffix"?}` → `{"names"}`, the keys kept whose names begin and end so;
- `keys/get {"name"}` → `{"value"}`, or `404` for none;
- `keys/set {"name", "value"}` → `{}`;
- `keys/delete {"name"}` → `{}`, for one there wasn't too;
- `sites/signed-in {}` → `{"sites": {"<integration>": <bool>}}`, whether the panel's browser is
  signed in to the sites the agent uses there (X, LinkedIn, Reddit), as their cookies say: only
  those it can tell. The app reads the cookies again only once they've changed (or after 30
  seconds);
- `vault/get {"id"}` → `{"values"}` (`404` for none), `vault/set {"id", "values"}` → `{}`,
  `vault/delete {"id"}` → `{}`: the vault's values, by item, in the Keychain ("Vault", bridge
  0.9.100);
- `trash {"path"}` → `{}`: a folder the box put in its trash (`box/trash`, a deleted bot's), to the
  Finder's Trash (bridge 0.9.52); one anywhere else stays where it is;
- for its link (bridge 0.9.61, "The relay, on this Mac's box"):
  - `link/identity {}` → `{"key", "secret", "sign"}` (each 32 bytes, base64url): this Mac's link
    key, relay secret and signing key, from the Keychain; `503` while the link isn't wanted or the
    Keychain won't give them;
  - `link/route {"method", "path", "headers", "body", "phone"}` (`body` base64, `phone` the asking
    phone's key, base64url) → that request's answer as the app gives it: its status, its
    `content-type` and `cache-control`, `x-kuvo-answer: 1` (the app's own answer, whatever its
    status), and its body as it comes, chunked (a followed route streams). One cut off partway
    (the engine went) ends without its last chunk, so the box tells the phone it was cut off. The
    box closing the request (the phone went) stops what it asked, before any answer too. Before bridge 0.9.63, mail the box didn't take itself went to the app (`link/mailed`, 0.9.61 and 0.9.62).

Names are `KUVO_KEY_*` only (`^KUVO_KEY_[A-Z0-9_]+$`): the box never asks for another, and the app
answers no other. The app keeps the files the engine reads (`KUVO_KEYS`) in step as it
changes them. Anything else it answers is an error the box's route answers `503 {"message"}`
with. Without these, as on a machine, the box keeps its keys in files only you can read.

#### The relay, on this Mac's box

Since bridge 0.9.61 this Mac's box holds its relay connection, as a machine's bridge does (`run`),
in `serve`'s process: your phones pair with it and open their sessions there. Its keys (link key,
relay secret, signing key) stay in the Mac's Keychain: the box asks the app for them
(`link/identity`) once its link is on, keeps them in memory only, and never makes keys of its own;
without them its link stays off and says why. What it keeps of its phones is in `box/run/link.json`,
as on a machine, without the keys, the relay or its name. Nothing its link meets (the relay gone, a
frame that isn't one, the app away) stops the box's own routes.

What a phone asks, it answers itself for the areas that have moved onto it and its phones
(`kuvo/phones…`), and, as every box answers them, `kuvo/file`, `kuvo/sign-in/return`,
`kuvo/accounts/credentials`, `kuvo/shell/<id>/stop`, the engine's API and the coding agents'
(`api/…`, `kuvo/agents/…`, telling who a message names with `&`; bridge 0.9.64), and `kuvo/named`
and `kuvo/groups…` (bridge 0.9.65); the app did each before. While its engine starts, or starts
again, the engine's routes answer `503 {"message": "This Mac's engine is starting. Try again in a
moment."}` (a machine's say "This machine's"). From 0.9.66, once the app has given up on it (it kept
stopping, or couldn't start; the app's `run/engine-stopped`, why, until it starts or stops it again),
they say "This Mac's engine isn't running." with why, and that Try Again on the Mac starts it; and a
machine's, while its keeper's next start is more than half a minute away (`run/engine.retry`, when,
in seconds since 1970), "This machine's engine keeps stopping. It's started again in about N
minutes." The rest, the Mac's own routes (`kuvo/info`,
usage, machines, hosts, `kuvo/mac`, `kuvo/claude-code`, asks, the engine starting over), it hands
the app (`link/route`), as it comes, `503 {"message"}` at once when the app isn't answering. Mail your
machines send it, it takes itself, as a machine's bridge does ("Peers"): their documents (from
0.9.62), and their agents, letters and group chats' mail (from 0.9.63).
What it asks the app goes through the app's `hello` proof first (the host interface, above), and
the link's keys (`link/identity`) are never asked of a host that hasn't given it. When the app's
host interface starts again (it failed, or Try Again), what the link has open through it ends: a
phone's followed `link/route` streams end (the phone follows again), and a request in the gap is a
`503`.

For the app only (anyone else gets `403`):

- `PUT kuvo/link/config {"phones", "machines", "relay", "name", "app", "features"?}`: whether the
  phone link is on, whether there are machines to meet, the relay (`ws:` or `wss:`), the Mac's
  name and version as phones are told them, and what it answers (`kuvo/info`'s features, which its
  agents' mail carries). The link is up while the phone link's on with a phone paired or a
  pairing waiting, or there are machines. Its keys are asked for before this answers, so a pairing
  link can be made right after. The box keeps none of it: the app says it again each time the box
  starts. Answers the link's state.
- `GET kuvo/link/status` → `{"state": "off" | "connecting" | "connected" | "failed", "reason"?}`;
  `GET kuvo/link/status/events` follows it (ndjson).
- `GET kuvo/link/phones` → `{"phones", "removed", "pairing"}`: its phones whole (with where each is),
  every removal, and whether Settings › Phone's pairing link is still waiting;
  `GET kuvo/link/phones/events` follows them.
- `POST kuvo/link/letters/take {"letters": [{id, from, to, text, peer, at, answers?}], "seen": {"<id>":
  <at>}}`: the letters an older Kuvo Code sent itself and had on their way (`agent-letters.json`),
  into the box's outbox, and those it delivered, remembered so one sent again isn't twice
  (`agent-letters-seen.json`).
- `GET kuvo/link/agents` → `{"peers": [{key, id, at, list, features}]}`: the agents each of this
  Mac's machines told it of ("Peers": "Agents"), by its key and its id here.
- `POST kuvo/link/agents/refresh`: this Mac's own agents worked out again, and `box/run/agents.json`
  with them, before a group chat here names someone with `&`.
- `PUT kuvo/link/peers {"peers": [{key, sign, address, name, id}], "moved": [{session, key}]}`
  (bridge 0.9.62): your machines the app set up over SSH that sign their documents, and the
  conversations being moved, for the Mac's peers document. One no longer there is one this Mac
  removed: named in `left`, and mailed the peers document once, while the box still knows where it
  is. `400 {"message"}` for one that isn't a machine's record.
- `GET kuvo/link/setup` → `{"mac", "macSign", "docs"}`: what setting up a machine over SSH gives it
  (this Mac's key, the key its documents are signed with, and its documents, its own as they are
  now and those it keeps of its machines). `POST kuvo/link/docs {"from", "docs"}`: what the
  machine's setup answer gave of documents (`from`, its key), taken as if by mail; `404` for one
  that isn't one of this Mac's machines.
- `GET kuvo/link/documents` → `{"own", "held", "views", "left", "have"}`: this Mac's documents as the
  box keeps them, its own brought up to date first, and its digest, for looking at them (the app
  doesn't read it; the bridge's tests do).

The app's `kuvo/phones/pair` makes a pairing link of its own (Settings › Phone's), apart from one a
phone asks for, so neither ends the other; with the phone link off it's `409 {"message": "The phone
link is off on this Mac."}`. The app's `kuvo/phones/remove` removes as the Mac does (any phone,
and the removals a machine's phones document brings).

Areas move onto it one at a time. A moved area's routes are answered there for every client: a
phone's through the Mac's link, which hands them on (`PhoneLink.boxRoutes`), and the Mac app's
own, which reach every box's routes the same way (`BoxClient`: this Mac's through the link's
answer, a machine's through `kuvo-link.js box route` over SSH). Until an area moves, the Mac
answers it itself, as below.

### Projects

Each box keeps its own projects, in `box/projects.json` under its folder (`~/.kuvo-code` on a
machine; this Mac's box's own on a Mac), and any client reads and changes them there: the Mac
app's sidebar and Edit Project as a phone does. A project's folder is in the query, as the box
names it (a `/` can't be in a part of the path). A Mac answers from its box; a machine from bridge
0.9.33 (`projects` in `features`). Before, a Mac kept a machine's projects itself, and moves them
there, with the settings of those it removed, the first time the machine answers; what it changes
while a box is away goes there when it's back.

- `GET kuvo/projects`: `{projects: [{directory, name?, folders, run?, terminal?, removed?}]}`,
  newest first. `name` only when it isn't the folder's own; `folders`, the project's other folders;
  `removed`, one Remove Project took off the list, kept with its settings for when one of its
  sessions is brought back (a client shows it then, and not before).
- `PUT kuvo/projects?directory=<folder>` with any of `{name, folders, run, terminal, removed}`
  adds the project or changes what's given (an empty string is none), and brings a removed one
  back unless `removed` is true (a client's copy of one it removed, with its settings):
  `200 {project}`; 400 for a folder that isn't a whole path. The folder is kept as it's named,
  as its sessions run there (a link isn't followed), and whether it's there now or not (a drive
  that's away).
- `DELETE kuvo/projects?directory=<folder>` is Remove Project: every session of it, its worktrees'
  too, archived on the engine and the coding agents' bridge, older ones included, then it's
  marked `removed`. `200 {archived}`; `409 {message, archived, kept}` when some couldn't be
  archived (it stays listed); `503 {"message"}` without its engine.
- `GET kuvo/projects/events`: `application/x-ndjson`, the list now, then again each time it
  changes.

### Artifacts

Each box keeps a record of what its agents made: every file a conversation there wrote, edited,
made or showed, with a version for each turn that changed it (`artifacts` in `features`). The
coding agents' bridge keeps it, in `artifacts/` under the box's folder (`~/.kuvo-code/artifacts` on
a machine, `box/artifacts` in this Mac's app folder), and the box passes `kuvo/artifacts…` on to
the bridge as it answers (`503 {"message"}` while it isn't running).

- **What fills it**: the tool calls of every conversation on the engine and the bridge (their
  `metadata.files`, a write's path, the pictures a tool that makes them made), Kuvo Code's own
  tools (`show_file` and `show_in_panel` mark it shown; `mark_final` pins it), and as each turn
  ends, files it changed that no tool call named (a command's): in a git repository as `git
  status` lists them, elsewhere by a walk of the folder; a bot's folder is also watched, so your
  own edits there count (`by: {kind: "outside"}`). A conversation's bot comes from its folder, its
  `kuvo.bot` metadata or the bots' folders; a group chat seat's bot and chat from its `kuvo.seat`;
  a chat's part, given to a bot's own conversation, is the chat's too (`trigger: "group"`); a
  wake-up's turn is `trigger: "wake"`; a subagent's work counts as its parent's turn. The engine's
  conversations run for the bridge's (`kuvo.engineFor`) aren't recorded twice. What the agent's
  browser downloads is that conversation's too (`kind: "download"`, `via: ["download"]`): the box's
  own browser, or this Mac's app for the browser in its panel, tells the bridge (`POST
  /api/kuvo/artifacts/noted {path, session, via: "download"}`, with the bridge's password; not a
  client's route). A download in a page you'd taken over is yours, and isn't recorded.
- **Versions**: one per turn (more edits in that turn make it `edits` more); changes with no turn
  running, within 5 minutes of each other, are one version. A file the record first sees changed
  has a version 0 (`before: true`), what it was, worked out from the change when it fits the file
  exactly, so the first change can be shown.
- **Copies**: a copy of each version up to 25 MB, by its SHA-256, except:
  - never the bytes of what's likely a secret (`.env*`, `*.pem`, `*.key`, `id_*`, anything under
    `.ssh`, `.gnupg` or a `keys` folder) or what git ignores: `kept: false`, `reason: "secret"` or
    `"ignored"`, its hash keyed so it says nothing of what it holds, and its bytes and changes are
    never sent (`410`). A client may still save or share what git ignores as the file is now,
    from `kuvo/file`, but never what's likely a secret, nor a `reason` it doesn't know
    (KuvoLink's `ArtifactVersion.mayLeave`);
  - code that git keeps: only the change its tool calls made (`reason: "git"`, `patch`), unless
    it's pinned;
  - with the disk's free space under its floor (whichever is less of 10 GB and a tenth of the
    disk), the version a new one replaces keeps no copy (`reason: "low-disk"`).

  The newest version of each file there, and every version of memory, skills and what's pinned,
  stay; older versions of the rest stay while they take no more than the box's budget (1 GB unless
  you set it), the oldest going first (`reason: "cleared"`), each still listed.
- **Pages**: a document that two wake-ups or more rewrote is `living: true`, a page kept up to
  date, as a Shelf shows it with HTML pages.
- **Times** are seconds since 1970.

An artifact:

```json
{"id": "art_<24 hex>", "path": "/…/report.md", "name": "report.md",
 "kind": "memory|skill|image|page|document|download|code|file", "type": "text/markdown",
 "where": {"bots": ["bot_…"], "project": "/…", "sessions": ["ses_…"], "groups": ["grp_…"]},
 "pinned": {"by": "bot|you", "at": 1760000000, "note": "…"} | null, "living": true, "git": true,
 "restorable": true, "gone": 1760000000 | null, "shown": 1760000000, "updated": 1760000000,
 "versions": [Version]}
```

`git`: it's in a git repository; `restorable`: a version of it can be put back (it's in a bot's
folder or the project it was made in), so a client offers Restore only then.

A version: `{n, at, by: {kind: "agent|you|outside", session?, bot?, agent?}, turn?: {session,
message?}, group?: {id}, trigger?: "group|wake", via: ["edit", "write", "shell", "show_file",
"restore", …], status: "added|modified|deleted", edits, lines?: {added, removed}, size, hash, kept,
reason?: "secret|ignored|git|too-big|low-disk|cleared", patch?, before?, handoff?: {from: "bot_…"},
restored?: <n>}`. `turn.message` is the message that started the turn; `handoff`, another bot in
the same chat made the version before; `restored`, it put back version `n`.

- `GET kuvo/artifacts?<scope>[&kind=][&pinned=1][&limit=][&before=]`: `{artifacts: [summary],
  next}`, the scope's pinned ones first, then the latest changed; a summary has `versions` (how
  many) and `latest` (the newest version) in place of the list. The scope is exactly one of
  `session=`, `bot=`, `group=` or `project=` (400 otherwise). `next`, an opaque cursor: pass it as
  `before` for the next page; null when there are none.
- `GET kuvo/artifacts/events?<scope>`: `application/x-ndjson`, the list now (the latest 200), then
  again each time it changes.
- `GET kuvo/artifacts/timeline?<scope>[&by=<bot>][&limit=][&before=]`: `{entries: [{artifact, version}],
  next}`, every version made in the scope, newest first, each with its artifact (without its
  versions): in a group chat only what its bots made for it (on their turns, and in their own
  conversations for its parts), for a bot only what it made (and what you changed of its files),
  for a conversation only its turns'; with `by`, only what that bot made (a group chat's one bot).
  `GET kuvo/artifacts/timeline/events?<scope>` follows it, as `events` does the list.
- Over SSH (`kuvo-link.js box route`, a Mac reaching a machine's box), which answers once: a
  followed route (`…/events`) answers with its first line, what it says now, and a client reads it
  again now and then; bytes that aren't text (a picture, a PDF) come as `{"status", "bodyBase64",
  "type"}` in place of `{"status", "body"}`.
- `GET kuvo/artifacts/<id>`: the artifact with all its versions.
- `GET kuvo/artifacts/<id>/versions/<n>`: that version's bytes, with its type; `410 {"message"}`,
  saying why, when it has no copy or was a deletion.
- `GET kuvo/artifacts/<id>/versions/<n>/changes[?from=<m>]`: what changed from the version before
  (or `m`). Prose (memory, Markdown, text, a job) is `{style: "words", lines: [{kind: "same|added|
  removed", text} | {kind: "changed", runs: [{t: " |+|-", text}]} | {kind: "folded", lines}],
  added, removed, from, to}`, the newer version's lines with the words that changed marked, and
  long unchanged stretches folded to a count; code is `{style: "lines", patch, added, removed,
  from, to}` (code git keeps: its turn's patches); pictures and PDFs are `{style: "pair", from,
  to}`, shown side by side from each version's bytes; anything else `{style: "none"}`. `410` for
  what's private.
- `POST kuvo/artifacts/<id>/pin {pinned, note?}`: pinned by you, or not; the artifact. Pinning
  code git keeps keeps a copy of it as it is.
- `POST kuvo/artifacts/<id>/restore {version}`: that version written back to the file, as a
  version by you (`via: ["restore"]`, `restored`); what it replaced is kept first, with a copy, as
  a version by you (`via: ["replaced"]`), so a restore can itself be undone. Only for a file in a
  bot's folder or the project it was made in, and a version with a copy: `409 {"message"}`
  otherwise. Clients ask first, saying what's replaced.
- `GET kuvo/artifacts/storage`: `{copies, older, budget, free, floor, low}` in bytes (`low`: free
  space is under the floor); `POST kuvo/artifacts/storage {budget}` sets the budget for older
  versions (older ones past it go at once), and answers the same; `POST
  kuvo/artifacts/storage/clear {before?}`: older versions' copies cleared (those from before
  `before`, in seconds), `{cleared, …}`.

### Settings per box

Each computer keeps its own engine settings and keys; nothing copies them between computers but
you. A machine's are in `~/.kuvo-code/box` (`opencode.json`, and `keys/` for integrations' keys,
which its settings name as `{file:~/.kuvo-code/box/keys/…}`), which its engine reads
(`OPENCODE_CONFIG`) and reloads as they change; no older Kuvo Code writes there. A Mac makes them
the machine's own the first time it connects: what the machine runs with then (the settings an
older Mac's start left, "For released Macs") goes in its box, or, on a machine with none, the
Mac's. From then on a Mac's start sends none of its own, and a machine's settings are changed through its
box's routes, the same way from a Mac and from a phone (`kuvo/config`), one change at a time under
`run/.config.lock`. A Mac reaches any of a machine's routes that answer once (never a stream) over
SSH: `kuvo-link.js box route` takes `{method, path, body?}` on stdin and prints `{status, body}`,
answered as a phone's request is: once (a followed route's first line), and bytes that aren't text
as `{status, bodyBase64, type}`. (`kuvo-link.js box read | change` are the same, for Kuvo Code
0.8.0-beta.1, which uses them; `key` sets one of its keys.) This Mac's own settings are its box's too
("This Mac's box").

What some providers need from the engine until opencode handles it is each box's own too: a
settings layer its engine starts with, on top of everything else (`OPENCODE_CONFIG_CONTENT`), never
in your settings. Today that's GitHub Copilot's Claude models named with
`{"compatibility": {"supportsThinkingBlockBinding": false}}` (anomalyco/opencode#55160). The box
learns them from its own engine's `GET /api/model` (Copilot's models whose id starts `claude-` and
that have a `family`; an engine with no Copilot model leaves what it learned) as it finds the engine
and every ten minutes at most while it's at work (on a machine, while its bridge runs: it has
peers or phones), and keeps the layer in `run/compatibility.json` (Copilot's Claude models as of
October 2026 until it has learned any). Whatever starts the engine asks the box: `kuvo-link.js
engine-config` prints the `OPENCODE_CONFIG_CONTENT` it's run with, the layer merged on top. This
Mac's app runs it as it starts its engine, and a machine's start scripts do, so an engine started
after a restart with no Mac there gets it too; a box too old to know it starts its engine as
before. A Mac sends none.

A machine's engine, its coding agents and its link find programs on the PATH your login shell sets
up there (`~/.local/bin` from your profile, nvm's node from `.bashrc`), not the bare one a start over
SSH or from cron gets: `kuvo-link.js login-path` (bridge 0.9.117) prints it, read from an interactive
login shell, then a login shell only (`$SHELL`; on Linux your account's when that's cron's `/bin/sh`;
none for nushell or csh), followed by the folders of the PATH it was run with; or nothing when neither
answers in time. A machine's start scripts run it once before starting the engine, and it keeps what
it read in `run/login-path`, which the link and the coding agents' bridge go by; the bridge reads it
again only after it installs or updates an agent (a .bashrc that starts an `ssh-agent` when there's
none would leave one running with each read). This Mac's app reads its own shell's for its engine.

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
- `GET kuvo/personalities/events` (bridge 0.9.54, feature `personalities.events`): ndjson
  `{"personalities": [...]}`, the same list as `GET`, a line now and one each time the library
  changes: through these routes, a copy met (another box's document, a `take`), or another
  process writing the file (`box personalities` over SSH). Only the ones you made: presets come
  with the kit. 405 for any method but `GET`.

A box keeps the library in its bots' folder: `personalities.json` in `KUVO_BOTS` when it's set
(this Mac's box, the app's bots folder), else `~/.kuvo-code/bots`, as `{"kuvo": 1, "personalities",
"removed"}`. Two routes are the app's own, for the app beside this Mac's box, which signs the
library for your other computers until the box holds the relay connection. They answer only a
request with the header `x-kuvo-from: app` (the app's own over `serve`; the phone link never
sends it for a phone, and the relay and `box route` never carry it), and anything else, a phone's included, gets
`403 {"message": "Only Kuvo Code on this computer can do that."}`:

- `GET kuvo/personalities/document`: the library whole, `{"kuvo": 1, "personalities": [...],
  "removed": [{id, removed}]}`, what the box keeps and signs. 405 for any other method.
- `POST kuvo/personalities/take` with `{"document": {personalities, removed?}}` meets another
  computer's copy with this box's, by the rules above (each entry cleaned as the routes clean it,
  one that isn't a personality left out), and answers `200 {"changed": ["custom.…"]}`: the ids
  whose personality or removal changed here (none when it had nothing new). Their bots here are
  told what they are now, and the box's own document goes to the others, as after a change
  through the routes. `400 {"message"}` when `document` isn't an object with a `personalities`
  list (and `removed`, if there, a list). It's met whole, as a peer's copy is, even when the two
  together are past what a document holds (that library isn't given to the others until it's
  smaller again). 405 for any other method.

A change on one computer reaches the others it reaches by mail at once, and the rest as they
connect. A bot made on a machine can have one there at once: its
`kuvo/bots/templates` lists them, told as the Mac words them (the kit's `personalityWords`).

### Vault

Each box keeps a vault of its own (`vault` in `features`, bridge 0.9.100): sign-ins, keys, files
and notes that its agents use without seeing a value. An agent names an item; the box fills it into
a page (through the browser's own process), a command's environment or a temporary file. No answer
an agent can get holds a value. Each computer keeps only its own; nothing is synced or fetched from
another box.

**Where it's kept.** In `box/vault/` under the box's folder: `items.json` (each item without its
values), `grants.json`, `paused.json` and `activity.jsonl` (kept a year). The first three are
`{"v": 2, "gen", "data", "sig"}`, signed (HMAC-SHA256 of `<file name>\0<gen>\0<data as JSON>`) with
a key no agent can read: a machine's from its store key (so they can't be checked while it's
locked), this Mac's given by its app from the Keychain to the box alone, on its stdin as it starts
(below). `gen` goes up with each write. One that isn't signed with it, was changed, or is older than
the newest the box knows counts for nothing. This Mac's app keeps each file's newest `gen` in the
Keychain, in one item with the file key (host interface `vault/generations {file?, generation?}`
→ `{generations}`), which the box reads before it answers anything of the vault and tells as it
writes: a file there whose generation the app doesn't have counts as changed, and while one it told
couldn't be kept, agents' use waits; a client remembers a machine's
(the state's `generations`) and, seeing one go back, pauses every agent's use there. `paused.json`, made with the first item,
then pauses everyone, and so does its being gone. The state says `tampered`. Values:

- this Mac's are in the Keychain, through its app ("Host interface": `vault/get {"id"}` →
  `{"values"}` or `404`, `vault/set {"id", "values"}`, `vault/delete {"id"}`), never in the box's
  folder. The app gives the box a secret of the vault's (with its own password and the file key)
  on `serve`'s stdin as it starts, `{"password", "hostVaultSecret", "vaultFileKey"}`, never in its
  environment, which any of the user's processes can read (`ps -E`): the password in
  `run/host.json` is in a file an agent's command can read, and rewrite. Before a vault call the
  box asks `hello` with `"vault": true`, and goes on only if the answer's `vaultProof` is that
  secret's HMAC-SHA256 of `kuvo-host-vault\0<nonce>\0<where it reached it>`; each call carries
  `x-kuvo-vault-at` (ms) and `x-kuvo-vault-auth`, the secret's HMAC of
  `kuvo-host-vault-call\0<call>\0<sha256 of its body, hex>\0<at>`, taken within a minute and once
  (`403` otherwise);
- a machine's are in `box/vault/values/<id>`, AES-256-GCM with the store key, which is only ever
  in the memory of the process that holds the vault. `key.json` keeps the store key wrapped by the
  unlock key, and an HMAC that checks one. Only clients keep the unlock key. After the box starts
  again the vault is locked (`423 {"message"}`) until a client sends it.

**The process that holds it.** The box's long-running process (`run` on a machine, `serve` on a
Mac) holds the vault. A `box route` passes `kuvo/vault…` to it over `run/vault.sock` (`0600`, owned
by the user, which the route checks first), one request a connection: `{"hello": <nonce>, "key"}`
(`key`, the box's socket key: the text of `run/socket.key`, `0600`, made by whichever of the box's
processes needs it first; a connection without it gets nothing and is closed), answered
`{"nonce", "proof"?}` (`proof`, while the holder has the unlock key: HMAC-SHA256 with it of
`kuvo-vault-holder\0<the route's nonce>`, base64url); then a line of `{"method", "path", "headers",
"body"}` (base64) there, `{"status", "type", "body"}` back. A request with the unlock key sends, to
a holder that proves it has it, `x-kuvo-vault-auth` instead: HMAC-SHA256 with the key of
`kuvo-vault-client\0<the holder's nonce>\0<METHOD>\0<path>\0<sha256 of the base64 body, base64url>`,
for that request alone. To one whose proof is wrong, nothing (`403`); to one that gives none (a
locked one), the key itself only for `kuvo/vault/unlock`, which a client sends when you ask
(**Unlock** on a machine's Vault page), and `423` for anything else. It says `503 {"message"}` when nothing holds it. A
machine's link keeps running while it has a vault.

**Who may do what.** Clients are your phones (through the relay, by their keys), this Mac's own app
(`x-kuvo-from: app`, on the box's own password, which it was given on its stdin), and a request from
the computer itself (the Mac over SSH, `box route`) that carries the Mac's proof for that request
alone in `x-kuvo-vault-proof`: base64url JSON `{mac, at, nonce, proof}`, its signing key's signature
of `kuvo-vault-request\0<the machine's id>\0<at>\0<nonce>\0<METHOD>\0<path>\0<sha256 of the body,
hex>`, within five minutes, each nonce once (`box route` takes the body as sent, `bodyText`, for
it). The unlock key goes only to unlock (`x-kuvo-vault-key`, or `kuvo/vault/unlock`), when you ask:
what runs as you on a machine (its `bin/kuvo-link.js`, its engine) could take it on its way then. Anything else
(an agent's command) gets `403 {"message"}` from every route but the agents' own two and `unlock`.

- `POST kuvo/vault/key` → `{"key"}`, the unlock key (32 bytes, base64url), for a client to keep:
  answered to a phone, this Mac's app, or the Mac over SSH proving it set the machine up:
  `{"mac", "at", "nonce", "proof"}`, its link key, the time (ms), a nonce (16 to 64 base64url
  characters) and its signing key's (link.json's `macSigns`) Ed25519 signature of
  `kuvo-vault-key\0<the machine's id on its Macs>\0<at>\0<nonce>` (link.json's `id`), within five
  minutes, each nonce once. It makes the vault
  if there isn't one yet. `409` on this Mac (its Keychain needs no key), `423` while locked.
- `POST kuvo/vault/unlock {"key"}` → the state; `403` for a key that isn't this vault's. Before
  there's a vault, the state (`made: false`) whatever the key, so a client can tell whether to fetch
  one without making it.
- `GET kuvo/vault` → `{state, items, grants}`. `state` is `{made, locked, paused, pausedBots:
  {<bot, or a conversation that isn't a bot's>: why}, store: "keychain" | "encrypted", keptDays,
  agents, agentsWaiting?, tampered?, generations: {items, grants, paused}}` (`agents`: whether agents may use it
  on this box, below; `agentsWaiting`: its sandbox is on, and they may once the coding agents
  started before it came on have finished); an item is `{id, kind: "login" |
  "key" | "file" | "note", name, sites, username?, fields, fileName?, readable?, signInOnly?,
  created, changed, used?}` (`sites`: hosts, a site's own and those under it; `fields`: the names of the values it
  holds, a sign-in's `password`, a file's `file` (base64), a note's `text`, a key's own); a grant
  is `{item, who: {bot} | {project: <folder>} | {everyone: true}, how: "own" | "ask", at}`.
- `POST kuvo/vault/items {kind, name, sites?, username?, fileName?, readable?, signInOnly?, values}`
  → `{item, key?}`: `key` when this item made a machine's vault. A sign-in needs a site (a host, or a
  name without dots on your network); names are unique; a value has at least 4 characters, so it can
  be hidden. `signInOnly` (a sign-in) is filled in only to sign in, in the browser: never to
  `vault_run`, nor `browser_fill`. `PATCH kuvo/vault/items/<id>` with any of those (a value `null` takes it away) →
  `{item}`; `DELETE` → `{}`, with its values and grants.
- `GET kuvo/vault/items/<id>/values` → `{values}`.
- `POST kuvo/vault/grants {item, who, how}` (`how: null` takes it away) → `{grants}`;
  `GET kuvo/vault/grants` → `{grants}`.
- `POST kuvo/vault/pause {paused, bot?}` → the state: every agent's use, or one bot's (or, by its
  root session, a conversation's that isn't a bot's).
- `GET kuvo/vault/activity?item=&bot=&session=&before=&limit=` → `{entries}`, newest first:
  `{id, at, what, item?, itemName?, kind?, bot?, botName?, session?, sessionName?, client?, site?,
  program?, how?, why?}`, never a value. `what` is one of `used`, `asked`, `allowed`, `declined`,
  `refused`, `added`, `changed`, `removed`, `granted`, `ungranted`, `paused`, `resumed`, `shown`.
- `GET kuvo/vault/asks` → `{asks}`, and `GET kuvo/vault/asks/events` (`application/x-ndjson`, the
  list now and on each change): what agents wait on you for, `{id, kind: "use" | "item", at,
  session?, sessionName?, bot?, botName?, item?, itemName?, need?, why?, site?, machine?, group?}`.
  `use`: an item it may use only by asking (or has no grant for); `item`: something it needs
  (`need`). `group`: asked from a bot's seat in that group chat (`session` the seat, `bot` its
  bot), which a client shows in the chat, since no one opens a seat. The seat is on its bot's own
  computer, so a chat follows the asks of each of its members' boxes as well as its own. A seat asks
  each time, whatever it may use on its own, and is answered only once: no Always. So does a
  conversation whose root the engine can't say just then, without a `group`.
  `POST kuvo/vault/asks/<id> {answer: "once" | "always" | "no", item?}` → `{}` (`item`, for an
  `item` ask, the one you give; `always` grants it on its own, to the bot or, for another session,
  its project; for a seat's, it's once). An agent waits 15 minutes, then takes it as no. Your phones hear of one still open
  after two seconds (`category: "ask"`, `data: {session?, vaultAsk}`, or a seat's `{group, vaultAsk}`,
  which opens its group chat).

**The agents' own.** Both tool servers pass these on as they come, with the calling conversation.
Each is answered only while that conversation is making the call: its engine (or the coding agents'
bridge) has a tool call of that name running in it (`api/session/<id>/message`, a `tool` block,
`running` or `pending`; for `tools`, with the same arguments; for `fill`, `browser_sign_in` or
`browser_fill`, and one fill for each such call). Any program on the computer could name a session;
only the conversation's own call uses its grants. (On a machine its browser, and anything that runs
as you there outside the sandbox, can still reach a value a fill puts in a page.)

Agents use the vault only on a box whose agents' commands are all in the sandbox (below: its state's
`on` and `agents`; the tests open it with `KUVO_VAULT_AGENTS=1`, which a Mac's app never passes its box, and which a box
takes only in a test's own folder, never the account's own `~/.kuvo-code` or a Mac's
`run.kuvo.code…/box`). Elsewhere `GET kuvo/vault/tools` lists no tools, and a call says the vault
isn't open to agents. A fill does only what Kuvo Code did before the vault: for `browser_sign_in`
with no item, the one sign-in for the page's site the conversation may use on its own (else `404`,
and the browser asks you); an item named, or a field, is `404`. The browser tools leave out
`browser_fill`, `browser_sign_in`'s `item` and the vault's sentence in their instructions. Your
clients see and change everything as before, and the state says `agents: false` (every box that
has the vault sends `agents`; a client reads its absence as `true`, a box from before the gate).

- `POST kuvo/vault/tools {name, arguments, session}` → `{text, isError}`: `vault_items`, the items
  this conversation may use (by its bot, its project or everyone), never another's name, and a
  note you let bots read; `vault_ask {need, why, site?}`, which asks you; `vault_run {command,
  variables: {VAR: "Item" | "Item.field"}, why, timeout?}`, which runs the command with the user's
  shell in the conversation's folder, the values in its environment (a file's as the path of a
  `0600` copy in `run/vault-run/`, removed after), and gives back its output (64 KB at most) with
  each value, raw, base64, hex, URL- and JSON-escaped, or a key file's lines, and a file's bytes
  as base64 whole and wrapped at 76 and 64, and hex, shown as `[vault: <item>]`.
- `POST kuvo/vault/fill {session, origin, purpose: "sign-in" | "field", item?, field?, why?}` →
  `{item: {id, name}, username?, values}` for the browser's own process to fill (on this Mac, only
  to its app, `403` otherwise; a machine's browser runs as you, as everything you run there does,
  so there it's answered to anything on the machine, under the same grants): only on an `https`
  page (`400`), only on one of the item's sites. A sign-in without an item takes the one sign-in
  for the site the caller may use on its own (`404` for none or more, and the browser asks you as
  before). An item named for another site is refused (`403`) and pauses that bot's use of the
  vault (a conversation's that isn't a bot's, by its root session), telling your phones.

Every use first checks Pause, then the grant: `own` goes ahead, `ask` (or no grant, for an item
named) asks you and waits. An item you give through `vault_ask` "always" is granted on its own
(to the bot, or the conversation's project, never a home folder); "once", its next use within
half an hour goes ahead. A command's copies (`run/vault-run/`) go when it ends, when the box ends,
and as a box starts.

### Sandbox

Each box runs its agents' commands in a sandbox (`sandbox` in `features` and its asks, `sandbox.asks`, bridge 0.9.118) wherever
it can, with no switch: the way out is per command (the card that asks you about one it refused).
On, each command the engine runs (an agent's shell tool, and yours with `!`)
writes only in its conversation's folder, that folder's git repository (a real one: a `.git` that's
a link, or names a folder that isn't a repository or a worktree the repository doesn't name back,
counts for nothing; on macOS never its hooks or config, its submodules' or its worktrees', nor the
engine's settings in the folder: `.opencode/`, `opencode.json`, nor the coding agents' settings
files, whose hooks and servers they run as they start there: `.claude/settings.json` and
`settings.local.json`, `.mcp.json`, `.codex/config.toml`, `.cursor/hooks.json` and `mcp.json`,
`.gemini/settings.json`, `.grok/settings.json`, and the scripts in `.claude/hooks` and
`.cursor/hooks`; a folder moved or linked into place is checked only by its own name, so the folders
that hold those, `.git`, a submodule's or a worktree's repository in it and the agents' `.claude`,
`.codex`, `.cursor`, `.gemini` and `.grok`, can't be made, moved or removed, only written in), its conversation's own temporary
folder (`TMPDIR`), its conversation's wake-ups' inbox (below), the system's temporary folders, devices and tools'
caches, but not what in them runs later outside the sandbox (installed programs like
`~/.cargo/bin` and `~/.bun/bin`, tools' settings and start-up scripts, npx's packages). It can't read
Kuvo Code's own folders (on a machine `~/.kuvo-code`; on this Mac the app's folders under `Library`,
any `run.kuvo.code…` copy's, its temporary folder and `/tmp/kuvo-ssh-<uid>`) but its `bin`, nor your
secrets (cloud, package and git tokens, browsers' and password managers' data, private SSH keys:
every file in `~/.ssh` but its config, known hosts and public keys; gh's `hosts.yml` when it holds
the token). A bot's or a chat's command gets its own folder back, and not its neighbours'. Its
environment has none of the engine's `OPENCODE_…` (but `OPENCODE_SESSION_ID`), no `KUVO_…` password,
secret, token or key, and no `SSH_AUTH_SOCK` but its own SSH agent's (below).
On macOS your Keychain stays readable, as gh and git's Keychain helper read their sign-ins from it in
their own process (each item keeps its own access list, Kuvo Code's too, though one that trusts
`security` reads without asking, and the file itself can be copied), but not the system's own
keychain in its folder (`Library/Keychains/<UUID>`), which only its daemons read.
On macOS it also can't reach Kuvo Code's own servers on `127.0.0.1` (the engine's, the bridge's,
the box's, the host interface) or sockets in its folders, start launchd jobs, open apps
(LaunchServices) or send Apple Events; on Linux the servers' passwords are in files it can't read,
and its sockets (the vault's `run/vault.sock`, the browser keeper's `run/browser.sock`), which a
command can still connect to there, serve only a connection that gives the box's socket key first
(`run/socket.key`, which it can't read): the vault's in its hello, above; the keeper's as
`{"method": "Kuvo.key", "params": {"key"}}`, before it says its own hello. Any other hears nothing
from the vault, and from the keeper (within a few seconds and a short first line) only a
`Kuvo.error` saying to update Kuvo Code, which is what an older Kuvo Code on a Mac shows; then it's
closed.
The engine's plugin makes a new key as that engine first sends commands through the sandbox (before
any of them runs), so one a command read before opens nothing after. (A process a command started
while the sandbox was off, or before the engine took it in, still runs outside it.)
So neither a command nor what it starts can route a request to the vault (`box route` included),
take a sign-in's fill, or drive, stop or answer the browser.

**Wake-ups.** A command schedules its own conversation's (`kuvo-wake add` and `watch`, the
conversation as the engine names it in `OPENCODE_SESSION_ID`), never another's: it reads its
conversation's wake folder (its bot's, or its own in the box's `wakes`, which the launcher makes
with its `session` and `directory` before the command runs, and which goes a day after it was last
used if it never got a wake-up or a watch, or its conversation's archived) and writes only its
`inbox/`. The launcher names that folder to kuvo-wake in `KUVO_WAKE_FOLDER`, and kuvo-wake puts what's
asked there (wake-ups in `inbox/wakes`, watches in `inbox/watches`, cancels in `inbox/cancel`), each
written whole under a `.new-` name first and then put in place, and lists them with what's kept. The
box's round of wake-ups (`kuvo-wake fire`, each minute) takes the inbox in, unless it's empty or a
`.new-` there is under a minute old: it moves it out of the commands' reach first (a link moves as the
link), then keeps copies of only plain files (no link, no second name for a file, 64 KB at most)
under the names kuvo-wake gives them, and clears the rest; what it keeps (`wakes/`, `watches/`, a
watch's readings) no command writes. While the sandbox is on (`run/fence/on`), each watch's check
runs in the sandbox, in its conversation's folder (none when that's gone), whether at its time or by
Check Now (`kuvo-wake try`), what it prints going to a file; set up and checked (`run/fence/ready`)
but not on, or its launcher missing, checks wait. Where the box can't set it up, checks run as
commands do.

**SSH keys.** Your own keys and agent stay hidden; a command signs with the SSH keys you keep in the
vault for its conversation (a `key` item with a `private_key`, OpenSSH's own format or PEM, without
a passphrase; for its bot, its project or everyone, as the vault's grants say, asking you when one
says to) through Kuvo Code's own SSH agent, which `ssh`, git over SSH and `ssh-add` use as
`SSH_AUTH_SOCK`. While agents may use the vault, the launcher notes each conversation before its
command runs (`run/ssh-for/<session>`, or `dir-<sum>` with its folder for one of yours with none),
and the process that holds the vault opens that conversation's agent: a socket of its own, named
from the note's sum and random bytes, in `/tmp/kuvo-ssh-<uid>/agents-<sum>` on a Mac (a socket's
path is short there) and `run/ssh-agents` on a machine, which the launcher hands the command.
Each lists only the keys its conversation may use, signs inside that process (a key never reaches
the command), answers one request at a time per connection, asks you once for a key whichever of
the conversation's commands signs, and after you say no, says no for a little while without asking.
Pause, a locked vault or a key removed: none offered. They go when the box does (cleared as it starts,
too). On macOS a command reaches its own agent and no other's, nor the app's own SSH connections
beside them; on Linux, which can't refuse a socket and shows every folder's names, any
conversation's commands could reach another's agent, so there an agent offers only the keys you
keep for everyone, until it can tell which conversation a connection comes from.

**How.** The box writes, before it says where it is as it starts: `bin/kuvo-fence` (the shell the
engine runs a command with) and, on Linux, `bin/kuvo-fence.js`; the rules in `run/fence/`
(`project.sb` and `inside.sb` for macOS's `sandbox-exec`, `policy.json` for Linux's Landlock, which
the engine's own Bun sets up through `bun:ffi`, Linux 5.13 or later); and the engine's plugin,
`kuvo-sandbox.js` in its settings' `opencode/plugins`. The plugin names, for each folder the engine
opens, that folder (the engine's own, never the command's) and its repository, and sends each
command's shell through `bin/kuvo-fence`, which refuses to run one without a folder (exit `126`). The
box first runs a command through it and checks that it can't read or write what's hidden; only then
does it give the engine the plugin, and it takes it away (with what the engine noted of it, so
it's `on` again only once the engine has loaded it again) when a check fails, so commands run as
before rather than not at all. (Kuvo Code's own kill switch, for a rollout, does the same: the box
started with `KUVO_SANDBOX=off`. No client shows a reason for it.) It puts it back if it goes, and keeps
Kuvo Code's own ports in the macOS rules as they change: the engine's, the agents bridge's, the
app's (`run/host.json`) and its server for Kuvo Code's tools (`run/tools.json`, `{"port"}`, which
the agents bridge writes as the app tells it where that is, `PUT kuvo/tools`, and removes when it
says it's gone; only an agent's relay reaches it).
Agents are told: each box starts its engine with `run/fence/agents.md` among its instructions
(`engine-config`, beside what it's given), which the engine reads again as it changes. While it's
`on` (the engine has loaded the plugin) it says what commands can't do, and how builds and tools that would fail run (on a
Mac: `swift … --disable-sandbox`, xcodebuild's package flags, `pgrep` rather than `ps`); otherwise
it's empty.

- `GET kuvo/sandbox` → `{on, why?, able, agents}`. `on`: every command the engine runs here
  goes through the sandbox, checked (the engine loaded this box's plugin). `why`, when it isn't, in
  words for Settings: why this computer can't (`able: false`: no Landlock, no engine
  yet), a failed check, `Its plugin for the engine was changed or removed.`, `The engine isn't
  running.`, `Waiting for the engine to load it.`. `agents`: the coding agents' own
  programs (Claude Code, Codex, Cursor, Grok and Antigravity, whose commands don't go through the
  engine) run in it too: each starts its next turn in it once it's set up and checked here, and
  `agents` is true once no agent process the bridge started before it was on still runs (the
  agents bridge notes it, `{pid, on}`, in `run/fence/agents`, for the sandbox as it is: `on` is the
  token each setup writes in `run/fence/on`; with no bridge running, it's true). It counts the
  agents' own processes, from their start: a command one of them started outside the sandbox that
  outlives it isn't followed, as with the engine's. How each does: Claude Code runs its commands through the
  box's shell for it (`run/fence/shell/zsh` or `bash`); Codex runs whole in the sandbox
  (`run/fence/shell/run`), an app-server for each session in that session's folder (and your
  account's in its `sessions` folder), its own sandbox off, asking as it does, and Kuvo Code's tools
  through the agents bridge's relay on 127.0.0.1, a key for each session. Of its home it writes, on
  a Mac, only what's named as its state (its sign-in, its databases, its conversations, logs and
  caches), and in those never settings (`*.toml`, `.env`, `hooks.json`, `rules`); nothing else
  there (its settings, plugins, skills, helpers, shell snapshots, models' instructions, the ChatGPT
  app's state), and it can't reach the ChatGPT app's socket (`ipc`); on Linux, a machine's Codex
  home (Kuvo Code's own copy) whole. In its state a command makes only files and folders, never a
  link (your own agent would write through it, elsewhere); a link carried in inside a folder the
  bridge takes away as the agent starts and stops (the agents make none there). Its memories'
  database it opens as it starts, so a command can write it (what your Codex is told later, never
  what it runs; so can a conversation of its, when you take it up). Files you attach are copied for
  it to `run/fence/attachments`, which it only reads.
  Grok runs whole the same way, as Antigravity does: its process per
  session through `run/fence/shell/run`, its own sandbox off (`GROK_SANDBOX=off`), its memories
  off (`GROK_MEMORY=0`), never in a shared leader (`--no-leader`; on a Mac its socket in `~/.grok`
  is refused), Kuvo Code's tools through the relay; of its home, on a Mac, only what's named as its
  state (`sessions`, `logs`, `memtrace`, `debug`, `crash`, its sign-in, locks and databases), and
  in those never settings (`*.toml`, `hooks-paths`, `disabled-hooks`, `*.sh`, so a project's
  always-allowed commands too); nothing else there (its settings, hooks, status line, language
  servers, the settings xAI sends, its models' list, which names where each model's requests go,
  its program, plugins, skills or memories). In a project, `.grok`'s settings, language servers,
  hooks, plugins, agents and workflows are kept as the other agents' are.
  Cursor, whose SDK runs its tools in the process that runs it (the bridge's, otherwise), runs whole
  the same way: its SDK in a process of its own for each session (the engine's runtime run as Bun:
  `KUVO_FENCE_BUN=1`, which commands don't get), which the bridge asks over its stdin and stdout,
  Cursor's own sandbox off, stopped once it's been done 15 minutes. Your sign-in stays with the
  bridge, which hands it the key it runs with, out of its reach: of Cursor's folders it reads and
  writes only its conversations and a folder of its own for its notes, sandbox policies and computer
  use's (`cursor/in-sandbox`, never what Cursor keeps run in the bridge), and it reads its SDK.
  Antigravity runs whole too, for its sessions and its sign-in alike: its home (`GEMINI_HOME`, Kuvo
  Code's own, never yours) and its temporary folder, where it unpacks itself, written whole; its
  program and the bridge's browser catcher only read; Kuvo Code's tools through the relay. It
  writes and reads files with its own tools then: the bridge offers none (`fs` false in
  `initialize`), since it would write outside the sandbox.
  When it isn't on, also `reason`, a word for a client to map rather than reading `why`, with what
  you can do (`action`) and the box's route that does it (`route`, where there is one):

  | `reason` | when | `action` | `route` |
  | --- | --- | --- | --- |
  | `kernel` | Linux without Landlock; `needs`: `"Linux 5.13"` | `help` | |
  | `macos` | this macOS has no sandbox | `softwareUpdate` | |
  | `engineMissing` | a machine without its engine yet | `retry` | `POST kuvo/sandbox/check` |
  | `checking` | not checked yet | `retry` | `POST kuvo/sandbox/check` |
  | `checkFailed` | its check failed; `check`: `folder`, `tempFiles`, `readsOwn`, `writesOwn`, `didntRun` or `setup` | `retry` | `POST kuvo/sandbox/check` |
  | `plugin` | its plugin for the engine was changed or removed | `fix` | `POST kuvo/sandbox/check` |
  | `engineDown` | the engine isn't running | `restartEngine` | `POST kuvo/engine/restart` |
  | `waiting` | the engine hasn't loaded it yet | `restartEngine` | `POST kuvo/engine/restart` |

  `failures`, with
  `checking` and `checkFailed`: checks failed in a row (the box tries again each minute). A box
  without `sandbox.check` in its features gives none of these; without `sandbox`, it has no sandbox
  (an older Kuvo Code, to update).
- `POST kuvo/sandbox/check` → the state, after setting it up and checking it again.

#### Asks

When the sandbox stops a command a task needs, the agent asks with its tool `sandbox_ask` (`command`,
`why`, and what it printed, `error`; `timeout`, how long it may run, 300 seconds unless it says, at
most 600). Every client is asked; on Allow Once or Always for This, **the box runs that one command
itself**, outside the sandbox: with your login shell (`-lc`), in the conversation's folder (the
engine's record of it, never the command's), with the box's environment but without the passwords
and secrets of Kuvo Code's own processes, and hands back what it printed (the last 64 KB) and how it ended. The
agent's text starts `Ran outside the sandbox · Allowed once` or `· Always for this: …` (with the
folder its commands now write in); on Don't Allow,
`The user said no: …`, and nothing runs. An ask nobody answers in 15 minutes runs nothing either, and
the text starts `Nobody answered in time` (a client shows it as no answer, not as your no). The agent
never lets a command out itself, and no tool answers an ask (a bot neither): only a client. A bot's
seat in a group chat runs no commands, so it has nothing to ask: its rules deny the tool, and the box
refuses one from a seat, asking nobody.

The tool is the box's, so an agent has it on every box (`sandbox.asks`): this Mac's tool server and a
machine's (`kuvo-browser.js mcp`, through `box route`) list what `GET kuvo/sandbox/tools` gives (only
while the sandbox is `on`) and pass a call to `POST kuvo/sandbox/tools` `{session, name, arguments}`
→ `{text, isError}`, which, as the vault's, the box carries out only while that conversation is
making that call. The asks, the tool and the answers live in the box's long-running process, as the
vault does (`run/vault.sock`); another passes them on.

- `GET kuvo/sandbox/asks` → `{asks: [ask]}`, oldest first; `kuvo/sandbox/asks/events`, NDJSON, the
  same at once and on every change. An ask: `{id, at, session?, sessionName?, bot?, botName?,
  project, command, why, stopped?, error?, always?, machine?}`. `session` is the conversation's root
  (a bot's sub-agent asks as its bot's conversation). `stopped`, on macOS: what the sandbox refused
  that command, from the system's log, each `{kind, path?}` (`kind`: `write`, `read`, `connect`,
  `job`, `app` or `other`; `path`, the file, folder or address). `always`: what Always for This would
  keep besides running it, `{kind: "write", path}`, the one place the sandbox stopped it writing,
  when that's all it stopped and it's one that may be given (below); without it, the command can
  only be allowed once. A command itself is never let out for good: what it runs (its scripts, its
  project's settings, `package.json`, a `Makefile`) is what the sandbox writes, so the same command
  asks again each time. `machine`: the machine's name, on a machine.
- `POST kuvo/sandbox/asks/<id>` `{answer: "once" | "always" | "no"}` → `200`, `404` for one that
  isn't open, `400` for another answer. `always` without `always` in the ask counts as once.
- Each open ask is also a notice to your phones (as the vault's are): `<who> wants to run a command
  outside the sandbox`, the command and why, `category` `ask`, `data.sandboxAsk` its id.

On macOS the launcher tags each command's refusals in the system's log
(`kuvo-sandbox <session> <first 16 hex of the command's SHA-256>`, as `sandbox-exec`'s message), and
the box reads them for `stopped` (`log show`, the last 3 minutes). Linux's Landlock logs nothing, so
there an ask has only what the agent says (`error`) and never `always`: a folder is added to Also
Allowed by hand. Reading the log doesn't hold up the box: the ask waits on it.

#### Also Allowed

What you let a project's commands do beyond the sandbox, from Always for This or added in Settings:
a folder (or file) they write in the sandbox, at most 8 a project. Kept in the box's own
`box/sandbox-allowed.json`, which no command can write, and changed only in the box's long-running
process (another passes the routes on). A rule: `{id, project, kind: "write", path, at, by?}`
(`project`, `path`: real paths; `by`: `Mac` or the phone's name).

The launcher reads a project's as each command starts, from `run/fence/allowed/<sum>` (one path a
line; `sum`, the first 32 hex of the SHA-256 of the project's real path, as the launcher names its
temporary folder); a folder that's become a link since isn't given. Inside one, what's kept from a
project's commands is kept there too on macOS (git's hooks and config, the engine's and the coding
agents' settings: Linux's Landlock grants a folder whole, as it does the project).

What can't be given (`400`, and only allowed once): your home folder or the whole disk; a folder of
Kuvo Code's; a secret or a folder that holds one; and what runs later outside the sandbox: anything in
your home folder's hidden folders, `Library`, `bin` or `Applications`; the system's folders (`/usr`,
`/opt`, `/etc`, `/Library`, `/Applications`, `/nix`…); a folder on the box's `PATH` or one that holds
one; a repository's own folder (`.git`) or a settings folder of the engine's or an agent's; and the
places the sandbox already keeps read-only. Your home folder is your account's own, whatever `HOME`
says.

- `GET kuvo/sandbox/allowed[?project=<folder>]` → `{allowed: [rule]}`, every project's without one.
- `POST kuvo/sandbox/allowed` `{project, kind: "write", path}` → `{allowed}`, that project's; `400` with `message` for one that can't be given. The same rule again
  is the one there.
- `DELETE kuvo/sandbox/allowed/<id>` → `{allowed}`, that project's; `404` for one that isn't there.

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
  kuvo/phones/pair` ends it, as Done does (`200 {}`, with or without one); `?token=<its token>`
  ends that one alone, so one closed late never ends a newer one (bridge 0.9.61). `409 {"message"}`
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
  <!-- compat: 0.7 files -->
- **Its keeper**: such a Mac's `kuvo-start` only starts the engine after a restart, and its
  `kuvo-launch` knows neither Stop nor the box's settings. The keeper keeps a copy of both
  (`bin/.kuvo-start-keeper`, `bin/.kuvo-launch-keeper`), runs its starts from them, and puts them
  back whenever the `kuvo-start` there has no `keep)` case (checked each round), leaving
  `.kuvo-boot` as that Mac wrote it. The bridge starts the keeper from the copy then too. The
  keeper stops the watchdogs such a Mac's start brings. On a machine without the keeper's script,
  a Mac starts the agents bridge and the engine as that Mac did.
  <!-- compat: 0.7 keeper -->
- **Its engine**: such a Mac has Stop, which leaves `run/stopped` and the engine down until
  `POST kuvo/engine/start` (`kuvo/info` says `stopped`; Settings › Machines offers Start). It
  doesn't know a stopped engine, so it starts one over `run/stopped`; running, it isn't stopped
  any longer: the keeper takes `run/stopped` away, under the start lock. An engine without
  `notes.box` is such a Mac's, with that Mac's settings (and perhaps without the agents bridge):
  a Mac that marks boxes starts it over once nothing runs, so the box's settings apply again.
  Until then a Mac reading its group chats takes a 404 from that agents bridge as none.
  <!-- compat: 0.7 engine-stop -->
- **Its visits hold updates back**: `run/attached` from before the box was last marked doesn't
  count (most likely the same Mac before it updated). A Mac marking the box after such a visit
  notes it first (`run/older-mac`, with the visit's time), so the mark doesn't hide it. The box
  doesn't update itself for 30 days after one ("an older Mac" in `run/launchers.json`), nor
  while a Mac that started its engine in the last 30 days hasn't said it `tolerates` newer boxes,
  nor for 30 days after drift (its files put back over an update's).
  <!-- compat: 0.7 visits -->
- **Its settings**: its start leaves its settings in the global file and `keys/settings.json`,
  with keys in `keys/`. The first Mac with boxes makes them the box's own (`kuvo-link.js box
  adopt`): those go in `box`, key paths as the box names them, what they were made from kept in
  `box/adopted-from`, and the launch's settings lines taken out, so no start writes them back.
  Until then a machine's bridge answers `kuvo/config`, `kuvo/keys`, `kuvo/mcp/catalog` and
  `kuvo/integrations` with `409 {"message"}`.
  <!-- compat: 0.7 settings -->
- **Leaving the engine running**: such a Mac stops a machine's engine as it quits unless
  something waits there (a wake-up, a group chat at work), or, from 0.7.0, a phone used the
  machine in the last week (`run/link.seen`, which the bridge touches as a phone asks).
  <!-- compat: 0.7 leave-running -->
- **Its bots' descriptions**: it reads a machine's bots from their `bot.json`, and a bot's job from
  its `job` there, so the box writes a job's line there too, beside its record (`job.json`).
  <!-- compat: 0.7 bot-json-job -->
- **Its worktrees**: it kept a machine's worktrees itself. A Mac that has such records gives them
  to the machine with `POST kuvo/worktrees/record`.
  <!-- compat: 0.7 worktrees -->
- **Its agents bridge** installed the agents' programs in `~/.kuvo-code/agents/runtime` on a
  machine, carried the Mac's sign-ins over (`<file>.from-mac`), and kept its downloads in its cache
  (`cache/install`): the agents bridge takes those away as it starts.
  <!-- compat: 0.7 agents-runtime -->
- **Updates**: the newest release on GitHub (0.7.2) has no `boxes.json`, which a box takes as
  "current", not a failure, until a release that has one is the newest.
  <!-- compat: 0.7 no-boxes-json -->

**This Mac's own group chats, from 0.5 to 0.8.0-beta.1.** Those Macs ran their group chats in the
app (`groups.json`, each chat's messages in `groups/<id>.json`). A Mac with this version moves
them into its coding agents' bridge at launch, before the bridge starts (`GroupMigration`), and
can be cut short and run again: each chat's messages first, its record (`groups/<id>/group.json`,
written whole and renamed) last, a chat with a record left as it is, one moving as the app last
quit `held` for the move's recovery. A seat it made on a machine for a bot there (one the machine
doesn't know as a seat, with no `kuvo.seat` metadata) is taken out of the chat, so the bot's next
turn makes one there, and listed in `groups/orphan-seats.json` (by machine), which the app keeps out
of the lists and deletes on that machine's engine once it connects. What a bot whose machine was
away was still to be told goes to `groups/pending-memory.json` (the bridge tells it once that bot
is known there); every bot here gets `bot.json` and `session` in its folder. Once every chat is
there, the old files are copied to `Backups/groups-<version>-<the list's hash>` and left where they
are, and what was taken is noted (`groups/imported.json`: the list's hash and every chat's ID); one
that couldn't move is tried again at the next launch. A `groups.json` an older version writes later
(after going back to it, where its chats are as it left them) is taken in by each chat's ID, and
a chat deleted since it was taken stays deleted. It can go three months after 0.8.0 ships.
<!-- compat: 0.7 mac-group-chats -->

**What else an earlier Kuvo Code left on this Mac.** A Mac with this version takes it in once. It
can go three months after 0.8.0 ships.
- What it kept of machines' group chats (`machine-groups.json`, from 0.7.0), taken into the box's
  own, and the old file deleted. <!-- compat: 0.7 machine-group-cache -->
- Your personalities (`personalities.json`, `personalities-removed.json`), moved to the box's
  library. A copy stays there, so going back to an earlier one finds them, and what it changed
  there is taken in again as this one starts. <!-- compat: 0.7 mac-personalities -->
- Machines' bots' keys of their own, which it kept in your Keychain: each given to its machine,
  then gone from the Keychain. <!-- compat: 0.7 bot-keys-keychain -->
- The letters it sent its agents' way and those it had delivered (`agent-letters.json`,
  `agent-letters-seen.json`, 0.8.0-beta.1), and the messages it kept for a machine that was away
  (`agent-messages.json`), handed to the box's outbox (`kuvo/link/letters/take`).
  <!-- compat: beta.1 mac-letters -->
- What it learned of GitHub Copilot's Claude models (`copilotClaudeModels` in its preferences),
  which each box learns now ("Settings per box"): removed as the engine starts.
  <!-- compat: 0.7 provider-compatibility -->
- Moves it ran itself (`movesUnderWay` in its preferences), which each box runs now
  (`kuvo/moves`): forgotten. A `moving` hold one cut short left in a folder is lifted by its box
  as it starts. <!-- compat: 0.7 mac-moves-under-way -->
- On a machine: letters its tools or link left in `run/outbox` for a Mac to collect over SSH,
  sent by the link as its own. <!-- compat: beta.1 outbox -->
- On a machine: `run/mac-agents.json`, the agents a Mac wrote there over SSH, no longer read, and
  removed. <!-- compat: beta.1 mac-agents -->

**Kuvo Code 0.8.0-beta.1.** It can go once 0.8.0 is out (a beta copy is offered the release).
- It signs no documents: its setup and mail give its peers as a list (`peers`, with `peersAt` or
  the mail's `at`), without `macSign`. A box keeps that Mac's newest by its own `at` (`legacy` in
  link.json, compared only with that Mac's earlier ones) and counts it as that Mac's peers
  document, but never passes it on, nor gives that Mac documents. Once that Mac gives a signing key
  in setup, its documents take the list's place. Lists a 0.9.23 bridge passed on (`vouched`) and
  the personalities it sent (`{"personalities"}`) count for nothing.
  <!-- compat: beta.1 peers-list -->
- It meets a machine's personalities over SSH every minute (`kuvo-link.js box personalities`,
  the library in, the met library out), which still works; the bridge tells your other computers
  what changed. It still lets the newest change win over a removal, so a personality removed
  elsewhere that it changes afterwards stays on that Mac alone, until it updates.
- It notes it's connected in `run/connected/<its id>` each minute: the bridge clears `run/connected`
  (and `run/present`, which a 0.7 Mac with the phone link on wrote) as it starts. Nothing reads
  them.
  <!-- compat: beta.1 connected -->
- It lets go of a machine's bots deleted there by `~/.kuvo-code/bots/deleted.json`, which the box
  keeps ("kuvo/bots").
  <!-- compat: beta.1 deleted-bots -->
- It reads and changes a machine's settings with `kuvo-link.js box read` and `box change` over SSH
  ("Settings per box"), which `box route` does for later Macs.
  <!-- compat: beta.1 box-read-change -->
- It runs moves itself, over SSH, and its peers document's `moved` says where each conversation it
  moves lives now. A box takes that word under its own boxes' ("Peers", `moved`).
  <!-- compat: beta.1 mac-moves -->
- It asks a machine to rename a worktree's branch (`POST kuvo/worktrees/rename`, through `box
  route`), which the box names itself now: it's refused, and that Mac reads the machine's records
  again.
