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
new kind goes only after welcome. A device never sends `0x07`. The relay handles a connection's
sends in the order they come, and what it sends back for them comes in that same order, as one
stream: each `unreachable`, and each `deliver` of a send to the connection's own address. Boxes
rely on it to tell a start the relay dropped from one that got there ("Starts", Sender side), so a
relay that answers sends to your own address ahead of `unreachable`s for sends before them could
have a start that got there said not to have started.

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

**When a client says a computer isn't connected** (#443, `Reach` in KuvoClient). A computer under
a heavy load answers late and drops its link now and then, and is still there. Its event feed
down, a client says nothing for 10 s (at most that what's on screen is being read again); then it
checks (`kuvo/info`, or the engine's `api/info` through a tunnel) and only a check with no answer
within 30 s (or one that finds no engine there) makes it "isn't connected". A check that answers
keeps it in reach, checked again 10 s later while the feed stays down. A request isn't given up on
while the computer is there (the phone's waits up to 10 minutes with nothing back; the link's own
checks fail what's on a session that's gone), and a read that fails because the link went is read
again, not shown as a failure.

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
  digest, moves its count past it, up to 2^52 (one claiming more isn't taken). It takes `peers`
  only from its setup's main computer, and while it follows no setup (kept until every box knows setups) from
  its own Macs (those in `macSigns`, given in setup), never at a lower epoch of the setup it keeps
  ("Your setup"); `phones` and
  `personalities` from those Macs, from its peers and from itself. Documents from an origin it no
  longer takes them from go.
- **`peers`**, one per Mac: `{boxes: [{key, sign, address, name, kind: "mac"|"machine", id?}],
  moved: [{session, key}], left: [key], setup?: {id, epoch, primary}}`: the Mac itself and each of
  its machines whose bridge signs, the same document for all of them, and the setup it leads
  ("Your setup"; older boxes read only `boxes`, `moved` and `left`). A box's peers are every box its Macs' documents name,
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
  from, nor to its origin); one of its own that changed, to all of them. A box that would take it
  is one its setup's document names (with its origin, for `phones` and `personalities`), or, in no
  setup, one a Mac's document names. Over SSH, setup carries the
  Mac's documents (`docs`, its own and those it has of its machines) and its answer the machine's.
  A box doesn't give documents to a Mac that gave it no signing key.
- **Later**: each box's agents (`{"agents"}`, "Peers") are a list of its own too, still sent as
  they change and every ten minutes; they could become a fourth kind.

### Your setup

All of your computers that know each other are one **setup**, with one **main computer**: a Mac
with the app, whose box signs who's in it. Every other computer is a **member**. (Built so far: the
setup, who's main, what boxes take and number by it, and pairing and adding only from the main
computer. Changing the main computer and joining two setups come later: #183.)

- **The setup** has an id (`set_` and 16 random bytes, base64url) and an epoch (a whole number, one
  more with each change of main computer, never lower on any box). Its main computer's peers
  document names it: `setup: {id, epoch, primary}`, `primary` the main computer's static key, which
  the document names among its `boxes` as a Mac signing with the document's key ("Documents").
- **Kept** in `run/link.json` as `setup: {id, epoch, primary, sign, role: "primary"|"member",
  aside?, conflict?}` (`sign`, the main computer's signing key). `aside`: kept only so a lower
  epoch of it is never taken, and followed for nothing else (its main computer stopped naming it,
  or this box is a shared machine).
- **Who leads one**: this Mac's box, once it numbers on its own (the Work Queue's first computer,
  "Numbers") and each of its machines has said no other Mac shares it (`shared: false` in what it
  tells of its Work Queue; one that hasn't said, an older box, holds it back, and nothing changes
  meanwhile; once it leads, a machine just added that hasn't said yet doesn't stop it, only one
  saying `shared: true` does; a machine that never told this Mac how it numbers, or one the Work
  Queue counts as gone, not heard for days, holds it back from neither, so one stale machine never
  keeps a Mac out of a setup); and a box no Mac set up, once it numbers on its own (one paired with
  a phone by itself, on Linux say; one its Mac let go waits for that Mac first, as "Numbers" says,
  days). It's made once, at epoch 1, and looked at once a minute and as a machine's word on how it
  numbers changes: a Mac that stops leading (a machine of it is shared now, or it numbers through
  another Mac) sets it aside and its document names it no more; leading again, it names the same
  one. A Mac whose keys were made anew (its static key, or its signing key alone) makes a new setup:
  the one it led with its old keys is no longer its own, and its machines take the new one from it.
  Setting a machine up again, it names its static keys before (`replaces` in `kuvo/link/setup` and
  setup's input), which the machine lets go as `leave` does, so it's never two Macs to it. (Leading follows its machines' word, as the Work Queue's numbers already do
  without a setup. Known gap until setups can be joined (#183's phase 7, with which leading holds
  against a member's word alone): a machine's word, `shared: true` or an earlier Mac named, sets
  the setup aside, so a stolen member key can make a leading Mac step aside. Members still refuse
  pairing and adding while it's aside ("Only the main computer adds and pairs").)
- **What a box takes it from**: a machine follows the setup its Mac leads, from that Mac's
  document. Then it takes `peers` only from the main computer's signing key (as that Mac's setup
  over SSH last gave it, the trust root), never at a lower epoch of the setup (whoever signed it),
  and its peers are the boxes that document names. A Mac that names itself the main computer of the
  same setup at the same epoch isn't taken: the box keeps the one it has and notes `conflict:
  {primary, epoch}` (gone with that epoch). A machine with no Mac leads its own; set up by a Mac, it
  gives that up (a setup of no other computer joins its Mac's). A box drops its setup when that Mac
  stops counting there (it removed the box, or wasn't heard from in 30 days), as it drops that
  Mac's documents. A box that follows no setup (kept until every box knows setups) takes `peers`
  from its own Macs, as before. The card (below) is a hint for what looks from outside, never
  trusted for any of this.
- **Shared machines**: a machine more than one Mac set up, unless the setup's document names each
  of them as one of its Macs, follows no setup, and tells its peers it's shared (the Work Queue's
  `told`, `shared: true`), so none of those Macs leads one. Macs that share a machine, and the
  machines numbering with them, number as before, from the first Mac you set up ("Numbers"),
  until they're joined in one setup.
- **`GET kuvo/setup`** (and `kuvo/setup/events`, a line now and one at each change), on every box,
  for every client: `{setup, epoch, primary: {key, name, kind}, you: {key, role}, computers: [{key,
  name, kind, role, app}], conflict?, startsFromOthers: {value, default}, heldBy: [key]}`. Facts only, the same on
  every box of one setup: `kind` is `mac` for a Mac with the app (`app`), `machine` otherwise; in no
  setup, `setup`, `epoch`, `primary` and `you.role` are null and `computers` is empty.
  `startsFromOthers` is the #181 switch (not built yet): `value` as you set it (`link.json`'s
  `startsFromOthers`, `on` or `off`), or null, and `default`, what it is then: off on the main
  computer (and on a Mac in no setup), on everywhere else, so it follows the role. `heldBy`: on a
  Mac, the machines whose word holds it back from leading now (not said yet, or `shared: true`;
  "Who leads one"), by key; empty elsewhere. Only the machines' word: a Mac that numbers through an
  earlier Mac doesn't lead either, with none of them named. Once it leads, a machine not heard from
  for days stays gone until it's heard from again (so a Mac back from a long sleep doesn't step
  aside while the relay hasn't looked again).
- **Only the main computer adds and pairs** (`setup.mainOnly`). A member (a box whose setup names
  another computer as main, kept aside too: a shared machine, or its main computer not naming it
  now) answers, with `primary` the main computer's static key and words naming it for a client to
  show as they are:
  - `POST kuvo/phones/pair`: `409 {"message": "Pair new phones from <main>.", primary}`, and
    `kuvo-link.js pair` prints those words and stops (exit 3), with no pairing made, saying too
    how to let a main computer that's gone for good go there (`kuvo-link.js leave <its key>`, as
    removing the computer from it would; then it pairs by itself), until a takeover can be made; a
    pairing link made before the box became a member pairs no one;
  - adding, changing or removing computers, `kuvo/machines…` and `kuvo/hosts/…` but `GET`, and
    `kuvo/link/peers` from an app or `box route` there: `409 {"message": "Add and remove
    computers from <main>.", primary}`, so only the main computer's app says who's in the setup;
  - `GET kuvo/hosts`, as a Mac answers it: the machines the setup's document names (itself too),
    each `{kind: "machine", name, address, key, relay, machine, anotherMac: false, removed:
    false}` (`machine`, the id the main computer's app knows it by), by name; `503 {"message"}`
    before it holds that document (or while it has no relay). Not the main computer's Mac: a phone pairs with it.

  The main computer (a box you run alone is its own setup's) and a box in no setup (one whose Mac
  is older, a shared machine whose Macs never led one) pair and add as before; with the main computer's app closed, adding says to open it (`kuvo/machines`, above).
  Existing pairings stay. Pairing removes no one.
- **The card**: `run/setup-card.json`, beside link.json, nothing secret in it, for what looks at a
  computer from outside its box (the app as it opens, a Mac adding it over SSH): `{setup, epoch,
  role, primary: {key, name, heard}, self: {key, name, kind}, app, computers, items, heldBy, macs}`
  (`macs`, the Macs that set this box up, `[{key, name}]`; none on a Mac). `heard`: when
  the main computer was last heard from, as this box counts it (ms, its own time off left out, as
  for its Macs' 30 days; null on the main computer itself); `computers`, how
  many the setup has; `items`, the Work Queue items here. Written as the box looks at its setup, as
  documents change it, and by `setup` and `leave` (`kuvo/setup/events` follows those too).
- **Older boxes** read only `boxes`, `moved` and `left`, and keep taking `peers` from their Macs:
  nothing changes for them. A box that knows setups names `setup` in `features`.
- **Already in a setup?** What's on a computer is judged by a box, as one verdict, which clients
  only draw. Each box found there says what it is by its card, or, an older box with none, by a few
  fields of its link.json (its Macs, when each was last heard from, their names, whether it has
  phones; never its keys). What's found is a hint, never trusted: a lie changes a warning at most.
  Per box: `self` (the judging box itself), `ours` (in its setup, or one it or its computers set
  up, a shared machine too, unless it's in another setup now; or in a setup the judging box led
  before it made its setup anew, its card naming it main), `elsewhere` (a member of another
  setup, however long its main computer has been unheard of, or a machine only other Macs set up),
  `main` (another setup's main computer, or a Mac whose app runs it in no setup), `older` (no card,
  and a Mac set it up, it has phones, or it's Kuvo Code's own box on a Mac; or a card from before
  cards named Macs, with no link.json fields beside it: it needs an update before it can say),
  `free` (nothing, or no Mac set it up and it leads nothing). For the computer: `self` if any is;
  `free` if none is anyone's; the one box's verdict; `ours` if all are; else `two` (boxes of more
  than one setup on one computer).
  - **`POST kuvo/setup/judge {probe}`**: what a Mac adding a computer over SSH found there, as its
    probe printed it (`RemoteEngineInstaller.foundProbe`, only `sed`): for `~/.kuvo-code` and each
    `~/Library/Application Support/run.kuvo.code*/box` a box ran in (only when adding to the real
    `~/.kuvo-code`; a `~/.kuvo-code` box its Mac removed, with no `bin/kuvo-start` or with
    `run/off`, left out), `box machine|app <folder from home>`, then `card <json>`, and for link.json
    `link mac|macs <key>`, `link seen <key> <ms>`, `link name <key> <json string>`, `link phones
    none|some`; then `app <folder from home>` for each Kuvo Code app's folder there
    (`run.kuvo.code*`), whether or not a box of its own ran in it (other lines are left alone;
    `mac`, the last Mac to set it up, is named first whatever its line's place). Answers `{verdict,
    joins, boxes: [{folder, app, verdict, key, name, kind, setup, role, primary: {key, name,
    heard}, macs, computers, items}]}` (`primary` of an older box: the last Mac that set it up;
    `computers` and `items` null where its card doesn't say), judged against this box (itself, its
    setup, its peers and Macs); 400 with no `probe`, or one over 200,000 characters. `joins`:
    adding it joins its setup with nothing to ask, as another setup's main computer with no Kuvo
    Code app there (no box's card says `app`, no `app` line: a Mac's app would open as a window from
    then on, which you choose) whose setup is empty (its card says no other computer and no work
    items: one that doesn't say is asked; a lie skips a question at most); else the verdict's own
    question.
  - **`POST kuvo/setup/attached`**: Kuvo Code on this computer attached to this box in place (the
    app, once the box runs, by the box's own `bin/kuvo-link.js box route` with its own engine, as a
    Mac reaches a machine's box over SSH), from then on said on its card (`app: true`,
    `run/app-attached.json`), so a Mac adding this computer asks before a join. Any `box route`
    caller may say it (the app here, a Mac over SSH, this box's own agents), and the app beside its
    own box; 403 from a phone or the relay. It can't be undone, and can only make a join ask first.
    Answers `{}`.
  - **`kuvo-link.js here <root>`**: Kuvo Code on a Mac (the app, and its keeper), before it starts
    a box, with `KUVO_HOME` its own box's folder (in its app folder) and `root` the machines'
    folder (`.kuvo-code`, or a test's); without either (or with them the same) it stops, exit 2.
    Prints `{verdict, use: "own"|"attach", opens: "main"|"window", runs, box, own}`, `box` and
    `own` as `boxes` above. `runs`, for the box in `~/<root>`: `gone` where its Mac removed it
    (`kuvo-start off` leaves `run/off`, which only a Mac's start there takes away, and then its way
    to start, `bin/kuvo-start`, goes with its keys, leaving its link.json and card: no
    `bin/kuvo-start`, or `run/off`, whatever still runs), else `running` (its keeper,
    `run/box.pid`, runs `kuvo-start` now) or `stopped`; null with none there. A `gone` box is no
    box: as with none (`box` null), and the probe leaves it out too. `opens`: `window` where the box it uses is a member
    of a setup another computer is main of (a Mac mini another Mac set up, one that can't say yet,
    the old main computer after a handover, a Mac that joined: never main by itself, only by Make
    This Mac the Main One), else `main`. An app whose own box ran (its folder has `run/`
    `setup-card.json`, `link.json`, `serve.json` or `keeper.json`, or its own engine kept your
    sessions: an `opencode*.db` in `KUVO_ENGINE_DATA`, the engine's data folder the app gives its
    box, as a version from before its box had a folder, or one that quit cleanly, leaves no record
    there; never the folder alone, which the app writes in with no box) keeps using it (`ours`,
    `free`, or `two` beside another setup's `~/.kuvo-code`); one with none uses the `~/.kuvo-code`
    box that's there, in place (`attach`: never a second box on one computer), with that box's
    verdict; with neither, its own. It writes nothing, and makes no folder. The app attached to a
    box that's `stopped` starts it again in place (by launchd, through its Mac's launch agent
    `run.kuvo.code.machine` where it's there, else its own `kuvo-start`), and says one that won't
    start so, to try again, rather than waiting on it.

### Peers

Your computers talk to each other over the relay, Mac or not. A Mac connects to
the relay when the phone link is on or it has at least one machine; a Mac on its own makes no
connection.

- **Who**: each of a box's Macs' peers documents ("Documents") names its boxes: that Mac, and its
  machines whose bridge signs (`id`, the machine's name on that Mac). A box's peers are every box
  they name, itself left out, whoever passed the document on; in a setup, every box its main
  computer's document names ("Your setup"). Only a Mac says who a box's peers are. Its bridge runs while it has peers or phones. Setup also gives the machine's `id`.
- **Mail**: a box opens mail from its Macs and its peers, and drops the rest. Every mail has `at`
  (milliseconds). A sealed mail frame is at most 65,600 bytes, and one larger isn't sent: letters'
  words and lists are cut to fit.
- **Agents**: `{"agents": {"at", "list": [{session, name, kind: "bot"|"session", id?, project?,
  about?, machine?, look?}], "features"?}}`: a bot's `id` (`bot_…`, as group chats name their
  members) and `look` (`{color, shape, face}`, as `kuvo/bots` has it: a colour, shape or face the
  apps don't draw is kept as the plain look's, `graphite`, `round`, `calm`), and `features` as the box's
  `kuvo/info` names them (the box that takes them keeps the first 300 names), and `boxes`
  (`[{key, address, kind, name}]`, 64 at most), the sender's other peers, which the receiver takes
  plan limits from and tells its own to where they aren't its peers too ("Plan limits", "Across your
  computers"; nothing else). A box sends its bots and its 40 latest
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
- **Letters**: `{"letter": {id, from, to, text, wait, at, answers?, read?, note?, made?}}` goes to the box that
  listed `to`.
  - **Checks**: the receiver drops a letter older than a day. It delivers each `id` once (ids
    remembered two days, a `note`'s 30, noted once delivered), at most 20 in ten minutes from a box (one answered
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
    time; after that it's refused as for no conversation (bridge 0.9.123). The same goes while its
    engine isn't there to ask, as when it's starting (bridge 0.9.203).
  - **Sender**: it names the sender as the sending box named that agent, when that box alone
    lists `from` and it isn't one of the receiver's own conversations. One that moved from the
    receiver to the sending box, once the receiver has asked that box to switch to its copy
    (`switching`, `finishing`), is that box's though its original on the receiver is still being let
    go: by that
    box's name for it, or before it lists it, by the name it moved with. Otherwise the letter is from
    "an agent on <box>", with no address to answer.
  - **`delivered`**: it answers `{"delivered": {id, ok, why?, retry?, answer?, lives?}}`. `retry`: not
    now (an engine restarting, too many lately), so the sender tries again. `answer: false`: there,
    but no answer will come (its sender couldn't be verified, or its machine is away).
  - **`wait`**: the receiver watches for an answer for ten minutes and sends it back as a letter
    of its own, with `answers` naming the first. The answer is what the agent wrote after the
    letter, up to the next message someone else gave it once it had answered. If a tool still waits for it, it goes to that
    tool; otherwise it reaches the sender's conversation as a message.
  - **Sender side**: a sender takes `delivered` only from the box it sent to, and an answer for a
    waiting tool only from that box; an answer from it stands for `delivered` should that be lost. Until `delivered` comes, it sends again each minute, for two
    days, oldest first, and a letter whose agent no box lists now waits. One sent without `wait`, or
    whose tool no longer waits (on a Mac, its conversation's gone; on a machine, it gave up or hasn't
    noted it waits in ten seconds), that won't be delivered (refused by the box it went to, its two days over, too long to send, or
    refused where it moved to) is told to its sender once, as the sending box's own word: a `note`
    from "Your other computers", queued, whose `line` names the conversation as it's listed and its
    computer (never its address), with why as that computer said it, or for its two days over, in
    the sending box's words. The letter's taken out of sending first (`<id>.failed`, which the next
    round finishes should that be cut short), so it never goes again; the notice is a letter of its
    own, its id made from the letter's, so no word on the letter acts on it. One for a conversation that
    moved (`moved`) goes where it lives now, whichever box it was left for; one that moved to the
    sending box itself is delivered there, as a tool's there is (its answer to the tool waiting,
    relay or not). Before a
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
  - **`note`** `{from, words, delivery, line?, about?}` (bridge 0.9.166): the letter is the sending box's
    own word, not an agent's, for one of its conversations that lives on another computer now, however
    long ago it left (its sessions' news, an answer you gave late, an answer its tool never took;
    "Work", `run/work/homes.json`). Only a box
    leaves one; an agent's letter never has it. The receiver checks and counts it as any letter,
    then delivers `text` as the sender would have delivered it there: `delivery` `queue` or
    `steer`, shown from `from` with `words`, and with `line`, marked as the box's note
    (`metadata.kuvo.note {from, line}`, "Messages in a session"). It has no `from` conversation and
    is never answered. To one archived there it answers `retry`, as the sender would have kept it
    until it's brought back. One whose `note` isn't whole is a letter as any. A box from before 0.9.166
    doesn't read `note`: it delivers the letter as any other, steered, from "an agent on <box>"
    that can't be answered, with `text` after its own heading. Its `words` and `line` are cut to fit
    as `text` is. `about`: the sessions on the sending box it speaks of, up to 100, which the
    receiver notes live there.
    - **It's kept until its conversation has it** (bridge 0.9.203): it's sealed anew at each send
      (`at`, the time of this send, with `made` beside it for when it was left), sent again each
      minute, for 30 days from `made`, and its `id` remembered as long, so a lost receipt can't
      deliver it twice. A plain letter keeps the `at` it was left with, and still fails at a day. To a
      box from before this, it's delivered as any note, and that box remembers its `id` two days,
      so a receipt lost for longer shows it twice.
    - The receiver answers `retry` rather than ending it for an `at` over a day off (a replay, or a
      clock that's wrong) and for a conversation it can't find while the coding agents' bridge isn't
      running, however long that lasts. For one that lives elsewhere, as far as it knows, it answers
      `{id, ok: false, retry: true, lives: <key>}`: the sender, taking that only from the box it
      sent it to, sends it there next (and to this box itself, if that's the key). A box that
      answers plain `retry` has its peers' `moved` to go by, and an older box that no longer knows
      where it went says there's no such conversation, which ends it. "There's no such conversation"
      from a box that could ask both its engine and its bridge, and knows of no home, ends it; a box
      that can't ask both now (its engine starting, say) answers `retry`, as it does any letter for one.
    - A computer you removed (`left` in a peers document, or this Mac's own record) ends it. One just
      missing from a list isn't that: it waits, for its 30 days.
    - Past two minutes without one for a conversation there, only that conversation's oldest goes
      each minute, until one's delivered or ended (`retry` doesn't count) or it's found to live
      elsewhere. A box's notes are counted apart from its letters, 20 in ten minutes each.
- **Calls** (bridge 0.9.204, to a peer whose `features` say `work.elsewhere`): `{"call": {id, from,
  tool, args, as, made, at}}` runs one of a lead's work tools ("Work") on the box its sessions are
  on, as that box's own tool runs it: `list_sessions`, `stop_session`, `compact_session` or
  `answer_ask`, nothing else. `id` is `cal_…`; `from` the lead's conversation; `args` the tool's
  (with `session`); `as` `{name, bot?: {bot, name}, rules, free}` who's calling, filled in by the
  lead's box from its own record, never from the agent's words: its name, the bot it is, the rules
  its conversation goes by there (that box's Settings › Permissions, then its own; more than 300 go as
  one rule that asks about everything, so an allow can't go past one left out) and whether its
  own commands run free of the sandbox (Full Access, or no sandbox there). `made` is when it was left,
  `at` when this mail of it was sealed (each send, as for a note). A new top-level key, so a box from
  before this ignores it.
  - **Checks**: a call `at` over a day off is answered `retry` (a replay, or a clock that's off). Each
    `id` runs once (remembered 30 days, noted once answered); one running now that comes again is
    dropped (a list's remembered two days, as a letter's). Calls aren't counted as messages. `from` may not be a conversation on the receiving
    box (refused); while it moves between computers, or while this box knows it to live on another
    box than the one calling (that word may be stale), it's answered `retry`, but from the box it's
    moving to once this box has asked that box to switch to its copy (`switching`, `finishing`):
    a copy is held until it's switched to, so a call from it there is from it as it runs there,
    taken at once while its original here is still let go; otherwise the receiver
    notes `from` lives on the box that called. So a lead that moved twice (A to B to C) while A was
    away more than two days, never hearing of the second move, keeps getting `retry` from A until
    A hears where it went: its list says A isn't answering meanwhile, and a kept stop is let go and
    told (`[Not done]`) at 30 days. A session it doesn't have is refused (`retry` while
    its coding agents' bridge isn't running). The tool itself then checks the session is under
    `from` (`kuvo.startedBy`, up its line), as for one here: so sessions the user started are out of
    reach. An allow goes only as far as `as` says the lead could go itself and as far as the receiving
    box's own rules (its engine defaults and its Settings › Permissions, Ask and Don't Allow alike)
    would let a conversation go ahead without asking, each judged on its own (moving never loosens
    anything: a rule of this box that allows doesn't undo one of the lead's that asks, nor the other
    way round); `free` is the lead's, the sandbox it's judged by the session's own, there. Never
    for a session in Ask First ("Work", Answering asks), which this box knows. An allow `made` over a day ago isn't
    given, and says so. A stop or a compact kept over 31 days is refused as too old.
  - **The answer** is a letter back (`{to: from, answers: <call id>, refused?}`) whose `id` is the
    call's with `-a` after it, so a call that comes again is answered by one that's already been
    seen: it reaches its lead once. `refused: true` when the tool couldn't do it (its `isError`). A
    list's answer is `{"rows": [WorkSession & {askID?, lastReply?, replyBeforeStop?, context?}]}` as JSON in `text`
    (`replyBeforeStop: true`: `lastReply` is from its turn that ended before it was stopped at rest),
    as many as fit, with `read: {}`: it's only for the tool waiting, and dropped if none does. Any
    other's is a `note` (`from` the answering box's name, `words` the tool's own words, `about` the
    session) kept until it's there, as notes are; `text` is `[On <box>] <words>`. A tool waiting
    takes `words`; when none does any more, the lead gets `text` as the box's own word.
  - **Sender side**: a call goes in `run/outbox/sending/<id>.json` (`{call: {tool, args, as}, from,
    to: "", peer, at, wait, quiet?}`), to `peer` only, each minute until that box answers. A
    list is only kept while its tool waits; an allow a day; a stop, a compact or a refusal 30 days.
    One let go for that is told to its lead (`[Not done] …`), and so is a kept one that box refuses
    for good (`ok: false` without `retry`), unless it was sent to every box in case one had it
    (`quiet`). One whose lead has moved on to another computer since ends, and its lead is told
    there to ask again from where it lives. While its box isn't answering (`run/peer-reach.json`), only its oldest call goes,
    once a minute; once that box's mail comes again, all of them go at once.
  - **Who isn't answering** (`run/peer-reach.json`, `{<key>: since}`): a box notes a peer from the
    moment the relay says nothing's connected at its address (`unreachable`, after something was
    sent there), until any mail from it comes. A file, so a machine's tools, answered by a process of
    their own, read it too. A dead connection can take the relay about a minute to notice.
- **Starts** (to a peer whose `features` say `work.elsewhere.start`): calls that
  start work, or read what there is to start it with: `start_session`, `list_models` and
  `list_projects` ("Work", Across your computers). The receiving box takes them only while you let
  your other computers start work there (`kuvo/approval`'s `otherComputers`: off on the Mac with the
  app until you say, on for a machine), else `ok: false` with why ("<box> doesn't take work from
  your other computers. Ask the user to allow it in Settings › Permissions on <box>."). Stops,
  answers, compacts and lists aren't held by it: they reach only work a lead already has there.
  Nor are moves (Move to Computer) or a group chat's seats: it's about starts alone, for now.
  - **`as.start`** (a start's, filled in by the lead's box from its own record): `{approval, held,
    agent: "plan"|null, model, autopilot, works: {bot, name}|null, own, depth, line, limits, homes}`:
    the lead's approval as it comes to there now (never the one kept, nor what the agent asked), its
    Don't Allows there (`held`, 300 at most; anything but a Don't Allow isn't a call), whether it
    plans, its model, whether it's on Autopilot, the bot its work is for (`own`: the lead is that
    bot), the new session's depth and line (the lead's own line, then the lead), the limits you set
    for that bot, and where each in the line lives as the lead's box knows it (kept only for those
    the receiver knows nothing of, on boxes it knows, and only once the start is made). A line that
    doesn't end with `from` isn't a call.
  - **What the receiver does**: its own `start_session`, as for a conversation of its own, from
    the lead: in the folder named (a project there, a folder there, or a chat: a folder of the
    lead's means nothing there), on the lead's model where there's an account for it there, else
    the engine's default, said so; never past the lead's approval nor past what that box gives (Full
    Access only where confirmed there, Auto only where its sandbox runs: the lead's answer says
    why), and kept as no more than that box gives as it's made (Full Access, where it isn't
    confirmed there, is kept as Auto, so the session never rises to it later); with the receiving
    box's Settings › Permissions and the lead's `held` after them, kept as `kuvo.held` so they hold
    however its rules are made again (and carried with it onto the coding agents, with `lead`,
    `line` and `call`). Its switch is looked at again just before the session is made. It's marked `kuvo.startedBy` (the
    lead), `by`, `depth`, `wake` (a bot's own: finished and asks; `wait` across computers becomes
    hearing it finish), `line` (when it says more than `startedBy`), `limits` (where the bot isn't),
    `call` (the call's id), and `lead: {box, key, name}` (the lead's computer, as the receiver names
    it, and the lead's name, for clients' "Started from"). Its task comes as a message from "<lead>
    on <box>", told as one here is: whether its last reply is heard as its report, and whether to
    review its work (`review`, carried with the call). The lead is noted to live on the box that called ("Homes"), so news of the session
    goes there. A start's call `made` over a day off is refused.
  - **Once**: each start is kept in `run/calls/<id>.json` as it goes (the worktree made for it,
    what it's to be made with, whether on the engine or the coding agents' bridge but never where
    either is nor its password, then that it's made, marked, told its task, and its answer), so one
    that comes again is answered as it was, and one cut short by the box going down is finished
    from the step it got to at a later round, once its engine answers, wherever it is now (a
    session marked with its `kuvo.call` is found rather than made again, and while that can't be
    asked it waits; a worktree made for it is used, not a second; a task already there isn't sent
    again), its lead told by the call's answer. One a day old isn't
    finished any more, nor one whose box has stopped taking starts or was removed since: the lead
    hears how far it got (made but not given its task, or that it may have been made where its
    engine can't be asked), and a worktree made for one that wasn't made goes. Kept 30 days.
  - **The answer** is a note, as for a stop, so a start whose tool stopped waiting reaches its lead
    as a message; `list_models` and `list_projects` answer as a list does (`read: {}`), in the
    receiving box's name.
  - **Sender side**: a start, or a read of what's there, is never kept for a box that isn't
    answering: the tool says at once it may be asleep, off or offline and nothing was started (so
    too when the relay says it isn't there before the call ever went to it, or drops the call
    itself). The relay says `unreachable` only of something sent, in order: so the first time the
    call goes, a fence goes right before it to the box's own address (`kuvo-fence:<tag>`), and
    once that's back, every `unreachable` for what went before has come. One for that box after
    it, while the call is still the last thing this connection sent there, is the call's own: it
    never got there (the link process, which hears the relay, leaves `<id>.dropped` beside the
    call in the outbox for the tool). Once this box sends anything else there, or its relay
    connection ends, or the call goes again, that can't be told. A call its tool took out of the
    outbox meanwhile doesn't go. Any other start or read
    that went and isn't answered, in time (45 seconds for a start, 20 for a read) or before the
    relay says that box isn't there, may have got there (a box keeps a start, then says `delivered
    {ok: true}`, before it makes anything, but that word can be lost), and so may one it said it
    had: it's taken out of the outbox, so it's never started late or twice, and the
    tool says it couldn't confirm, to check `list_sessions` before trying again. The lead's box notes where the session lives ("Homes") and that the lead
    started work there (`run/work/started-elsewhere.json`, `{<lead>: {<key>: at}}`, 30 days), so
    its `list_sessions` asks there before that computer's first rows come.
  - **`stop_work`** (`{before}`): a bot's Stop All, on each computer that takes starts: every session
    under the bot's conversation there that's working, waiting on an answer or on a timer, made
    before `before` (moved onto the receiver's clock by how far the call's `at` is from its own), stops. Kept for a box that's away until it's back (30 days, `quiet`), and
    answered with no note (it would wake the bot it stopped).
- **Rows** (bridge 0.9.204): `{"rows": {id, at, leads: {<lead>: [WorkSession & {askID?}]}}}` tells a
  peer (one whose `features` say `work.elsewhere`) the sessions on the sending box whose lead lives
  there now ("Work", rows from elsewhere), unasked, so it has them before this box sleeps. `id`
  (`rws_…`) is the same while they are; `at` is when they're as of. The receiver keeps the newest
  from each box, with the sessions they name noted as living there ("Homes"), and answers
  `{"delivered": {id, ok: true}}`; none at all (`leads: {}`) clears what it kept. A box tells one
  computer once in 15 seconds at most, however busy (four a minute), again each minute only while
  unanswered, nothing while nothing changed, and nothing while that computer isn't answering
  (`run/peer-reach.json`): what changed goes once its mail comes again. Rows older than what a box
  kept are receipted and not kept. What's kept of a computer you removed goes. Rows aren't letters: they don't count against a
  box's letters or notes.
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
  - A machine's link watches `run/outbox/sending` (the system's own watch on macOS and Linux), so
    what a tool leaves goes at once, not at the next round (bridge 0.9.204). A watch that dies is
    made again at the next round, which also sends what one missed. What a box answers
    itself (a call's answer) goes as it's left, on a Mac and on a machine.
  - Letters an older Kuvo Code left in `run/outbox` for a Mac to collect over SSH are taken on by
    the link as its own (not one a Mac renamed `.mac-<name>` to deliver).
- **Moves**: `{"move": {op, id, …}}` carries a move between two boxes (`kuvo/moves`), and
  `{"moving": {"moves": [Move]}}` (bridge 0.9.169) tells every peer what moves on the sending box now, as its own
  `kuvo/moves` shows it (`Move`, without `place`; 20 moves and 50 conversations each at most), at
  its look every three seconds: when a move began, went a stage on or ended (how much of its copy
  went isn't news), each minute while any are under way, and at the next look after a peer asks for
  agents. One its relay connection didn't take (closing, or not welcomed yet) goes at the next look.
  A box that has nothing moving says nothing, and once its last move ends it says `moves: []` once.
  Each box keeps the latest word from each peer, whatever the peer's clock says
  (`run/moves/elsewhere.json`), lists it in its `kuvo/moves` as `elsewhere`, and forgets a peer's
  word three minutes after it last came (that peer went away mid-move), at its next look, with a
  `kuvo/moves/events` line so a client stops showing it. A box from before 0.9.169 ignores
  `moving`.
- **Plan limits** (#210): `{"limits": {at, accounts, ask?, refresh?}}`, what a box's coding agents'
  bridge read of its accounts' limits ("Plan limits", "Across your computers"). The bridge hands it
  to its link on its mail (as group chats' below, `kind: "limits"`), which sends it now, whole,
  to that peer, and keeps it nowhere; the receiving link gives it to its bridge (`POST
  /api/kuvo/peers/mail`), or lets it go when the bridge isn't there (it comes again in ten
  minutes). The link tells its bridge which key and name are this box's own (`self` in `PUT
  /api/kuvo/peers`). A box from before this ignores it.
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
  - **`held`** `{task, wrapUp, chat, stopped}` (home → host, sent now and lost when the host is
    away): whether a part waits on its bot's conversation there, its queue paused (stopped by you,
    or held after a run that failed). Said as it changes, then again each minute while it waits
    (and once after), and again when the host gives the part again. The host takes it only from
    the box the part was given to, and says it in the chat's `stopped` while the part is `working`.
    A host older than this turns it down, and shows the part working.
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
  agent and this box's agents bridge isn't running, or that computer's box is from before
  `moves.agents`, is in a group chat that lives here with its bots, is working on a goal (a bot's, or a
  chat's own `/goal` working or paused; it stays on this box), has a command or subagent running, has
  a link that wouldn't work there (absolute, climbing out of its folder on its way, or, followed
  through any link before it, ending outside it or nowhere) or anything but files, folders and such
  relative links within it (the box it goes to takes none; looked for again as it's packed), is moving already; that computer's box is
  from before moves, as the `features` its agents' mail last gave say; a group chat's bots don't all
  live on that machine, as its agents' mail says, none of them here) and `note`, the same in a few
  words for beside the computer's name in a menu. `404 {message}` when it isn't here. A group chat
  can go to any Mac (its bots stay where they are); the machine it goes to checks again. For a bot
  or chat, `stays?: {sessions?, asks?, goals?, agent?}` says what of it stays on this box as it moves
  (each left out when none, `stays` too): how many sessions it started (they stay, and it reaches
  them from where it goes), its unanswered asks (`work/asks`) and the goals it proposed and you
  haven't started (they're here again if it comes back), and `agent: true` when its coding agent's
  own copy of its conversation is kept here as the way back (removed a week after it first runs
  there): Claude Code's and Codex's go with it. `startsOver: "<agent>"` instead, for one whose
  coding agent can't take its own conversation along (Cursor, Grok, Antigravity): that agent starts
  a new conversation there, handed what was said so far. Clients put it in Move's question (`MoveWords.question`, its `stays`), with the words
  that each computer's vault, integrations and browser sign-ins stay with it.
- `POST kuvo/moves {kind, id, to}` (`to`: the box's key, as `places` gives it) answers once the move
  ends: `200 {move}` (it lives there now); `409 {message}` refused or taken back, as it was (still in
  a turn after a minute's wait, working on a goal,
  messages still on their way, kept getting messages while it moved, too big, refused there);
  `503 {message}` the other computer didn't answer; `404 {message}` it isn't here, or that isn't one
  of your computers. A client that goes doesn't stop it. `note` beside `move` (feature
  `moves.check`), when there is one, says what it does differently there, in words to show (it uses
  another account of its coding agent, the one signed in there).
- `GET kuvo/moves` → `200 {moves: [Move], away: [session]}`, and `GET kuvo/moves/events`, the same
  as a line now and each time it changes. `Move = {id, kind, thing, name, from, to, role, stage,
  sessions, place?, sent?, size?, waiting?}`: `from` and `to` are boxes' keys; `role`, whether this box is
  where it was (`from`) or where it's going (`to`); `stage`: `holding`, `copying`, `switching`,
  `finishing`; `sessions`, its conversations, root first; `place`, the other computer's name, as
  your computers call it (when this box knows it); `sent` and `size`, bytes, while its copy is on
  its way, for a client to show how far it is (a move taken back isn't listed, on either box,
  while its copy is let go of). `waiting: true` (bridge 0.9.178) while the other computer has said
  nothing of the move for a minute and a half (its engine away, or the computer off): on the box it
  leaves, as it waits on a step; on the box it's going to, while its copy's parts don't come, or,
  set up, the switch. It
  carries on where it was once that computer is back, and clients say it waits for it (still taken
  back after 10 minutes before the switch, as above). `away`: conversations this box's engine lists that don't live here (a copy not
  switched to yet or being let go of, an original still going): clients leave them out.
  `moved: [{session, key, at}]` (bridge 0.9.208), left out when there are none: the conversations
  that moved away from this box in the last two days (`run/moves/moved.json`), each with the box it
  went to from here (`key`) and when (`at`, ms); one moved back here since isn't in it. A client
  takes no event from this box about them, and leaves them out of this box's conversations, rows it
  still has from before the move included (a coding agent's as well as the engine's), once it has
  them where they're listed now, an open conversation going on there: it's the box's word, not the
  client's guess from lists read at different times. Until it lists one elsewhere, the row it has
  stays its only one, as it was (a conversation in view isn't closed partway through its move), and so
  does `away`'s: a list read then keeps it, and so does the box it leaves letting it go
  (`session.deleted`) while it moves; once it's listed elsewhere too, that box's row alone goes,
  never the other's. `key` is only where it went from this box: one
  that moved on since is in that box's own `moved`, and listed where it lives. A box from before
  0.9.208 doesn't say it.
  `elsewhere: [{box, moves: [Move]}]` (bridge 0.9.169), left out when there are none: the moves your other
  computers said they have under way between them (`box`, its key; "Peers", `moving`), so a client
  that follows one box sees a move between two others too. One to or from this box isn't in it
  (it's this box's own, in `moves` once it hears of it); one between two peers is in each of
  theirs, so a client takes each `id` once.
- While it moves, nothing reaches it: a prompt to one of its conversations through the link answers
  `409 {message}`, as does a change to its queue (`…/queue/…`; reading it still works, and a Stop
  works while the box it leaves waits for its turn to end), a letter `retry`, its wake-ups and watches are held (`paused` says `moving`), and
  changing or deleting the bot answers `409`, and what its sessions or an ask's late answer would
  tell it waits until it's there. A client shows it as moving.

With a coding agent (feature `moves.agents`): a bot or chat whose conversations are on the agents
bridge moves too, with each agent's own conversation (Claude Code's conversation file, what's
beside it, and its memory) as well as the bridge's record. The agents bridge does the agent's part
(`POST api/kuvo/carry/{pack, digest, keep, place, undo, remove}`, on each box for its own agents):
`pack {root, into, conversation?}` writes what goes into the bundle's `carry` folder, with a
manifest of every file and its SHA-256, and says its `digest`; `place` puts it in place on the box
it goes to (paths and the conversation's folder made right for this box, the memory beside one
already there kept, a file with the same name but other words kept beside it as
`moved-<sha8>-<name>`; with `chat`, each session's chat mark set to it, or taken off for null, as it's
placed: "Chats"; a bridge from before ignores it, and the chat goes by its folder), noting each step so `undo` takes it all back; `digest {root}` says the same
hash again. A bot's memory goes in its own folder (`<bot>/memory`, Claude Code's
`autoMemoryDirectory`) from there on. An agent that keeps nothing to carry, or one whose files
can't be found, goes with the bridge's record, and its next turn starts from what that holds.
`conversation: false` leaves the agent's own conversation out, for a box that doesn't carry it.
A conversation on one of its agent's aliases (Claude Code's `default`, which stands for whichever
model it recommends on that computer's account, Opus on one and Sonnet on another) goes on the
model the alias stands for where it leaves, as that agent lists it there (`carry.json`'s
`sessions[].model`; bridge 0.9.208), when the agent that takes it on the box it goes to lists that
model too; and a bot whose own model named the same as its conversation takes it too: it runs, and
shows, the same model there. One whose agent hasn't said what the alias stands for, or that the
other box's agent doesn't have, keeps the alias (never a guess).

Between the boxes, each `{"move": {op, id, …}}` (`id`: `mov_…`), each step sent again each minute
until it's answered:

0. To a box whose `features` say `moves.check`, before anything's held: `check {kind, name, lane?,
   model?}` (`model`, `{providerID, id}`, the one it talks with) → `checked {ok, message?, note?}`.
   The box it goes to says, at once and keeping nothing, whether it can run it: its engine or agents
   bridge running; on the engine, the model's account signed in there; with a coding agent, that
   agent installed and signed in there (Custom Auto picks there itself). Its own account of the
   agent not there but another one signed in: `ok`, with a `note` saying which it uses. `ok: false`
   takes it back (409, `message` as it's said); no answer in 45 seconds, 503. While it's asked,
   nothing's held: it isn't in what's moving for prompts and letters, and its wake-ups go on.

1. The box it leaves holds it, waits until its conversations are settled (no turn running, nothing
   in their inbox but what a Stop held there; a minute at most), and packs one file: `move.json` (its conversations as the
   engine exports them, root first; a bot's own keys; a group chat as its bridge held it, `POST
   api/kuvo/groups/<id>/hold`; `queues`, by conversation, each one paused or with something
   waiting on the box ("The queue"), bridge 0.9.137: `{paused, held, waiting: [{shown, message}]}`,
   what waits as it's shown and whole, in the order it would go: what waits on the box, and for one
   paused, what its engine held, carried as one waiting on the box (anything there but a message,
   and it waits as for a turn); each file a message brings as a `data:` link with what's in it, read
   on this box, or left out, and shown without it) and its folder (a bot's; a chat's wake-ups'),
   tar, gzip; at most 1 GB, its files counted first (more, and it's refused before any of it is
   packed). Getting it ready for 30 minutes (its engine or group chats stuck) takes
   it back (409, as it was). Either box waits for one answer of its engine or group chats two
   minutes at most (a conversation's export, ten), and takes one that doesn't come for a failure.
2. `offer {kind, thing, name, size, hash, wasPaused, pausedAs?, from, members?, lane?}` → `ready`, or
   `refused {message}`: its engine, its agents bridge (`lane`) or group chats aren't running, too big, a group chat's bots
   (`members`) don't all live on that machine, one by that ID lives there already, or a move of it
   is under way (only the computer whose move it is can offer it again). A first offer unanswered
   for 30 seconds: the other computer isn't there (503). While it moves, its folder's `paused` says
   `moving`; what it said before (your own pause) is `pausedAs`, put back where it lives after.
3. `part {hash, i, of, d}` (30,000 bytes each, base64url), 16 on their way at once, each answered
   `got {i}`; one unanswered for 20 seconds goes again. The box it goes to notes each part as it
   comes (beside the bundle), so one it gets after starting again counts those before.
4. Once all are there and its SHA-256 matches, the box it goes to puts it in place, held, in the
   move's turn (a step about it that comes meanwhile waits), saying `working` now and each minute
   until it's done: the folder where it keeps them (only files, folders and relative links within it: a
   link out of it or anything else in it or for it, or a `move.json` that isn't a file of its own, and it's refused), `paused` saying `moving`,
   a chat's `directory` its chats folder; each conversation imported under its own ID (noted first;
   they must be one conversation and its subagents', rooted at the chat or at the conversation a
   bot's folder names, none of them on this box already); their `queues` kept paused in place of
   any there (what waits, whole, in its order; a file only as a `data:` link); a bot's keys given
   (one this box can't keep, and it's `failed`, so the bot stays where it was with it); a group chat put there
   held (`PUT api/kuvo/groups/<id>`, `status: "held"`); with a coding agent, on the agents bridge
   (`carry/place`). → `arrived {hash, digest?}` (`digest`, what's in place, with a coding agent), or `failed {message}`,
   what it set up gone again; the message says only what's wrong with what came, never what this box
   found. Setting it up for 30 minutes (its engine stuck) is given up on the same way, and so is one
   it was setting up as it stopped (as it starts again). The box it leaves, every part answered and
   no word yet, asks `arrive {hash}` each minute, answered at once as it is: `arrived`, `working`
   while it's being set up, else `failed` (one it doesn't have, never all there, being let go of,
   or cut short by a restart), each with the `hash` it was asked about. An `arrived` or `failed`
   for a bundle other than the one sent last is ignored.
5. The box it leaves settles and reads it again, its queues too. Anything new, and it all goes again
   (from 1, three tries; then 409, `busy`). With a coding agent, a `digest` that isn't what it sent
   takes it back (409), and so does one that changed here since it was packed (it goes again).
6. It notes the switch, and sends `switch` → `switched`: the box it went to lets its wake-ups go (as
   they were), starts a group chat (`activate`), tells a bot what it is (as
   `kuvo/bots/<id>/arrived` does), and lets a queue that wasn't paused go on (one you stopped
   stays stopped, with what waits for it, until Resume there).
7. Then the box it left lets the original go: its conversation saved in its folder (or
   `moved-<id>` in the box's folder) as `conversation.json`, its conversations deleted with their
   queues (what waited for them on this box went with them), a bot's own
   keys removed (ones that can't be now, its Keychain out of reach, noted in `left.json` and tried
   again each hour until they're gone, never while it's moving back), the folder to Kuvo Code's trash (on a Mac, on to the Finder's Trash), a group chat
   released. It says for two days where those conversations live now ("Peers", `moved`). With a
   coding agent, the bridge's record is kept in the folder (`conversation/`), and each agent's own
   files stay where they were, kept as the way back: nothing here runs or reaches them. At the switch
   the box it went to adds a note to what the agent is told, saying where it came from, where
   its folder's paths are now, and that the sessions it started stay there.

What a move left on the box it came from (`run/moves/left.json`: its folder in the box's trash, and
where each agent kept its files) is removed by that box a week after the conversation first ran
where it went. It asks the box it went to each hour, `ran? {session}` → `ran {at}`, answered only
for a move that came there and was switched to: when the first reply since was (nothing while there
is none), or now when the conversation is gone from there. Only that box's word counts. Nothing is
removed without it, nor while a move of it is under way (coming back, or taken back as it does). Moved
back before then, what's here is the one: the older copy in the trash goes, and its entry with it.
The sessions it started aren't part of it: they stay on the computer they're on, and nothing here
touches them, nor a memory folder one of them still uses.

Each move's steps are taken one at a time on each box, in the order they come. The box it goes to
sets a copy up once, whatever parts come again, and lets go of what it set up if setting it up
fails. It keeps how each move that came to it ended, a dropped one for a week and a switched one
for a year: a `switch` is answered `switched`
only for a copy it has whole or switched to already, and `dropped` for any other (one it let go
of, never set up, or doesn't know), and the box it left then goes on with its original, as it was.
Before the switch, anything that goes wrong takes it back: the box it leaves sends `drop` →
`dropped` (the copy there goes: its conversations, keys and folder, a group chat released) and
goes on as it was. `dropped` comes as soon as the copy there is marked to go, so the box it left
never waits on it: it's never switched to from then on, and what its engine or group chats can't
let go of now (down) is kept held there (nothing reaches it), and let go of again each minute (after a week, each
hour, said once in the log; never forgotten while any of it's here); offered again meanwhile, it's
`refused`, saying an earlier copy couldn't be let go of yet. A group chat that
can't go on again as it's taken back (its group chats down) is started each minute until it does,
and as a box starts, a group chat held there that no move under way holds goes on. After it, only forward. Each box keeps its moves in `run/moves/<id>.json` (and
the bundle beside it), so a move cut short by a restart carries on: one that switched finishes, one
that didn't is taken back. Letting the original go after `switched` is tried again each minute
until it's done (its engine was down); its engine, up, refusing to give its conversation to keep ten
times, it goes on here as well, said in the move's 409 (two copies, never none). Before the switch, the other computer quiet about it for
ten minutes (from when a step was first sent, whatever goes again) takes it back (503); a `drop` never answered is given up after a day (the copy there
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

Every box answers Kuvo Code's own agent tools itself, the same on every computer (bridge 0.9.100;
wake-ups, `set_job` and the show tools where a box says `agent-tools.own`, "Features"; an older one
answers 400 for them): writing to
each other and starting sessions, and the rest listed under the route. The tool servers (this Mac's app and its keeper, a machine's
`kuvo-browser.js`) only pass a call on, and draw nothing from it but what it shows; a machine's
through `kuvo-link.js box route`, a process of its own, which a `SIGTERM` stops waiting. Only the
browser's tools (`browser_…`), which work in a client's own browser, aren't the box's.

- **`POST kuvo/agent-tools`** `{name, arguments, session, inView?}` → `{text, isError}`: `name` is
  `list_agents`, `send_message`, `read_conversation`, `start_session`, the Work tools ("Work"),
  `plan_limits`, or one of those below; `arguments` the tool's, `session` the
  conversation calling (as the engine names it; null outside one). The answer is the tool's own
  words. One that waits for an answer holds the request up to eleven minutes; the request going
  stops the wait, and an answer that comes later reaches the conversation as a
  message (one moving to or from another computer once it's there; one that lives on another now,
  there, as a letter with `note`, "Peers"). 400 for another `name`.
  - A subagent, and a coding agent's engine run (`kuvo.engineFor`), act as their conversation: its
    name, folder, model, approval, and where answers go. A group chat's seat may only list and read.
  - `notify_user` (`{text}`): tells you something on purpose, on your phones and in your clients'
    notifications (`kuvo/notices`), as one sentence of `text` (its first, Markdown taken off, cut at
    a word to 160 characters), titled as the conversation's news is. It's how an agent working on
    its own reaches you, as its replies then don't ("Notifications"). Kept in
    `run/notices/told.json` with `by: "agent"`, for the box's process that tells your phones to
    send. Refused (`isError`) from a group chat's seat, with no text, where nothing would tell your
    phones (a machine whose bridge isn't running), within two minutes of the conversation's last,
    past three in an hour or twelve in a day, past ten in an hour from all the box's agents
    together, and for the same sentence again within a day; looked at and kept under one lock, so
    calls at once can't both pass.
  - A conversation's wake-ups and watches (`schedule_wake_up` `{when, note, every?, summary?}`,
    `watch_for_change` `{every, check, note, summary?}`, `list_wake_ups`, `cancel_wake_up` `{id}`):
    through the box's own `kuvo-wake` (`KUVO_WAKE_COMMAND`), with what it says as the answer, for
    the conversation the caller is part of: a bot's in its folder, a session's in its wake-ups
    folder (`kuvo/wakes/<session>`), made with its first one as `POST kuvo/wakes/<session>` makes
    it (its folder, `via` for a coding agent's, held while it's archived). Run in the folder the conversation works in. Refused
    from a group chat's seat (a chat meets on a schedule), for a conversation the box doesn't have,
    while it's moving (`kuvo/moves`), and a watch in a conversation that asks before every command
    unless the engine asked you about the watch's tool first (its rules name
    `kuvo-browser_watch_for_change`; never through the coding agents' bridge, which doesn't): then
    the agent's told to start it with `kuvo-wake watch`, a command, which asks you.
  - `set_job` `{summary | job, details}` or `{clear: true}`: the bot whose conversation this is
    keeps it, as `PATCH kuvo/bots/<id>` with `job` changes it. Refused for a conversation that
    isn't a bot's.
  - The show tools say whether what they name is there to show; clients show it from the call once
    it goes ahead. `show_file` `{path, caption?}` and `mark_final` `{path, note?}`: a file at a
    full path, as given (no `~`, `.` or `..`). `show_widget` `{html, title?}`: some HTML.
    `show_in_panel` `{path}`: a file or folder by its full path (a relative one is refused, naming
    it in full from the conversation's folder); its answer starts `Shown: `, `Kept for later: ` or
    `Sent: `, then `the folder ` or `the file `, by `inView`: whether the user is looking at the
    conversation now, which only the client passing the call on can say (true, false, or left out
    where it can't tell).
  - Who there is: the box's own agents and its peers' (as `run/agents.json` has them), and any
    conversation here named by its address. An agent is named by its address or its name (any case
    or accents, with or without `&`).
  - An agent here gets the message straight from the box; one on another computer by a letter
    ("Peers"). Without a conversation to answer, or off the relay, a letter isn't waited for.
    `read_conversation` reads one here, or asks a peer with `letters-read` for it by letter.
  - A letter (not a note, nor an answer) to a conversation the receiving box doesn't list to its
    peers (its bots and latest 40) is delivered only when it's under the letter's `from`: a lead
    following up a session it started, by address; anyone else's is refused (bridge 0.9.204). One
    that moved to the receiving box in the last two days takes it as one listed, from the moment it's
    switched to there, older than the latest 40 or not. A
    conversation here named by its address still takes a message from any conversation here.
  - An address the lists don't name (older than the latest 40) is found on the computer that told
    this one of it as one of a lead's sessions ("Work", rows from elsewhere), or where it's known
    to live now ("Homes"), as well as here (bridge 0.9.204). `read_conversation` also reads a session
    put away that's under the caller, here or there; any other put away, a subagent's or a seat
    stays unread. A read for a box that isn't answering (`run/peer-reach.json`) is refused at once,
    and so is one waiting when the relay says so: a read isn't kept.
- **`POST kuvo/sessions`** `{task, title?, folder? | project? | chat?, worktree?, model?, effort?,
  mode?, approval?, wake?, review? = true, startedBy?, wait? = false}` →
  `{session, title, folder, project, answer?, got?}` (`project` null for a chat; `answer` with
  `wait`, its first answer in ten minutes, else null; `got` (bridge 0.9.180), the approval it runs with now where
  that's less than asked: Auto that asks first without the sandbox, say). `start_session` is this route, from the
  calling conversation.
  - From a conversation (`startedBy`, its root found as above): in its folder unless `folder` names
    another (a bot's own folder is its chats), on its model and in its mode (Plan stays Plan) unless `model`, `effort` or `mode` names another, on the engine or coding agents' bridge
    it runs on, with its approval made again with this box's Settings › Permissions (Ask First isn't
    got around), its metadata `kuvo: {startedBy}` (it opens nothing by itself: clients list it under that
    conversation), and the task as a message from it.
  - From a client (no `startedBy`): in `folder`, in Auto unless `approval` says (which asks first
    where the sandbox doesn't run, "Approval"), with Settings › Permissions, the task as the user's
    own first message.
  - Either way its project's other folders are allowed to it and named in its instructions, one in
    a worktree is told so, one filed under another folder than its own (a worktree, a project's
    other folder) carries that project from the first (`kuvo.filed`, "Projects"), and a folder
    that's no project yet, nor one of a project's, becomes one.
  - 400 `{message}` (no task, not a folder here), 403 (a group chat's seat), 404 (`startedBy`
    isn't a conversation here), 409 `{message, reason}` (Full Access from a client where it can't
    be had: `fullAccessOff`), 429 (too many lately), 502 `{message, session?}` (not made, or
    made but its task didn't reach it), 503 (no engine).
  - Where and how, each optional (bridge 0.9.106, "Work"): `project` (a project's name or folder
    here) or `chat: true` instead of `folder`; `project` with `folder`, a folder in that project or
    in one of its git worktrees wherever that is (one its repository lists that names it back),
    where the session works, its answer's `project` the project's (400 for a folder that's neither,
    or with `worktree: true` too: never dropped, as before #422); `worktree: true`, a worktree of its project on a
    branch of its own; `model` (`"provider/model"` or `{providerID, id}`, one there's an account for
    here, on the engine or the coding agents' bridge as it runs) and `effort` (one of its variants);
    `mode` `build` or `plan`; `approval` (Approval, below: `askFirst`, `acceptEdits`, `auto` or
    `fullAccess`; from a client, this computer's default where it doesn't say, and what it says is
    the last one picked here; an older client's `ask` is Ask First and `approveAll`, its default,
    this computer's default: since bridge 0.9.185 never Full Access unless you picked it last), never above the
    starter's (a starter that asks first starts one that does too, and the tool tells its agent what
    it got where that's less than asked; one started by a conversation from before, with no
    approval kept, is made as its starter reads and keeps none either, but a bot's work, which is
    kept with its own); `wake` (`finished`, `asks`, `both`, `none`), what the
    starter hears of it (a conversation here, once the new session is marked so; the tool says
    which). `computer` other than this one: 400, for now.
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
  it). A session still at work by then (the coding agents' bridge keeping the files a run changed)
  is looked at again once the bridge says it's free: `session.idle` `{sessionID}`, which it sends
  whenever a turn, an Undo or a Redo leaves the session idle (the engine sends none). A run the
  engine ended itself (`superseded`, `inactivity`) goes on the same way, and so do the latest
  sessions' queues when a box starts again (or its stream comes back) beside the same engine, for
  a run that ended while it couldn't hear (one that was stopped or failed, as its newest message says:
  the run's end, `idle` with an `outcome` other than `succeeded`, or an answer ending in an error,
  is held and paused instead); one at work then is settled so once it's free.
- **Pauses**: Stop, from any client (the box's `stop`, or an interrupt a client sent the engine
  itself: with no run started again a moment later, as Send Now's resume does at once; while the
  bridge's session still says it's at work, looked at again once it's free, and Resume pressed
  meanwhile goes on then); a run that failed (Resume pressed while the bridge still keeps its files
  goes on once it's free, too); and a queue found with nothing running (or, the bridge's, at work
  until it's free) once the engine started anew (each engine process looked over once, as
  `run/queues-scanned.json` keeps, so a box that starts again beside it doesn't). Each holds what was for the next step in the queue, ahead of what was
  queued, the latest first: only what's still waiting once it's moved there. A message you write
  to go now (`steer`) unpauses it; another agent's letter, a wake-up or a note doesn't. A Resume or
  Send Now just after an interrupt wins over the look at it. The box's `stop` pauses it whether anything waits or not (a bot's
  `stop_session` on its own work only when something does, as a failed run); once paused, it stays
  so until Resume, Send Now or a message of yours to go now, though nothing is left waiting.
- **What arrives waits** (bridge 0.9.128, `queue.waits`): the engine would run everything waiting
  with the first thing to reach a stopped conversation, so while its queue is paused, what the box
  sends it on its own waits on the box instead: another agent's letter (from here or another
  computer; a sender waiting for the answer hears the conversation is stopped, and the answer comes
  as a message), an answer to a letter, a wake-up sent now, a bot's work news, an ask's late answer
  and a goal's notes. A scheduled wake-up that comes due waits there too, as a `Wake-up` (`kuvo-wake
  fire` reads `run/queues.json` and hands it over with `box route`, `queue/add`; one that repeats is
  kept once); a watch waits in its folder. So does a group chat's part for a bot's own
  conversation, from the chat (by its name; the coding agents' bridge keeps it in the same files,
  and the part goes on working until the bot reports, or fails once it's taken away). Each goes once the queue goes on, after what the engine holds, one at a time
  as runs end; kept in `run/queues.json` (`waiting`) and, whole, in `run/waiting/<message id>.json`,
  across a restart (one Undo put back goes where it was, below). Send Now sends one at once; `DELETE …/queue/<item>` takes one away.
- `GET kuvo/sessions/<id>/queue` → `{paused, held: [id…], waiting?: [{id, from?, text, files?,
  at}]}`: `waiting`, left out when nothing waits on the box, first come first: who it's from (an
  agent's name, `Wake-up`, `Its sessions`, `Your answer`, `Goal`, a group chat's name; none for one of yours), what it
  says, the names of its files, when it came (ms). `GET kuvo/sessions/queues/events` follows them
  all (ndjson: `{"queues": {<session>: {paused, held, waiting?}}}` now and at each change; a session
  neither paused nor holding anything is left out).
- `POST kuvo/sessions/<id>/stop`: held and paused, then the run stopped. `POST …/queue/hold` (`{items?}`):
  held and paused without stopping (before an undo, or a move); `items`, messages a client held
  as they went to the engine, go first, in that order. `POST …/queue/resume`: unpaused, and the
  next one goes now. `POST …/queue/<item>/now` (Send Now): unpaused, the item steered (one waiting
  on the box sent), and a run under way stopped to go on with it; 404 when it isn't waiting.
  `POST …/queue/add` (`{id?, text, files?, delivery?, from?, words?, before?}`, a prompt's body): a client's
  own message for the queue (every one sent after this run, and Undo), its files kept on the box
  as a message's are (a phone's also naming its agents and saying it's from the phone, as its
  prompt would), shown as `words` (as you wrote it, without what the client added for the agent),
  else as its text; while it's paused it waits on the box (`from` names who it was from, for one put
  back), else it goes to the engine as asked (`queue` by default); its answer says which,
  `waits: true|false`. `DELETE …/queue/<item>`: one waiting on the box taken away, its answer
  carrying it as it was, `removed: {id, text, files?, delivery, from?, words, before?}` (`words`, as
  it was shown; `before`, what came after it, left out when it was last); 404 if it isn't. Undo
  adds it back with `…/queue/add` and `kept: true` (its body as it was kept, its files not kept
  again, shown with its `words`). **Undo puts it back where it was** (bridge 0.9.137): `…/queue/add`
  takes `before`, what came after it as the client showed it (for one the engine held, which the
  client took away in the engine; `removed` carries it for one that waited on the box), and while
  the queue is paused it waits just ahead of that one: in what waits on the box, or in `held` (so
  `held` can name one waiting on the box, and holds what the engine had ahead of it too, in the
  same order); with no `before`, or one that isn't waiting any more, last. The order it all goes
  in, and clients show: `held` in its order (in the engine or on the box), then the engine's for
  the next step, then its queue, then the rest of what waits on the box. Each answers the queue as it is
  now; 404 for no such session here, 503 with no engine (none recorded, or nothing listening where
  it's recorded), 502 when the engine refused. 504
  (`{message, busy: true}`) when the engine runs but didn't answer in time (a busy computer: it's
  asked twice, 10 s then 20 s, before that; #443): it isn't down, nothing was done, and
  a client says so in those words (#443). `queue/add` waits up to two minutes for the engine to
  take the message. A run that
  fails pauses the queue again while anything waits on the box; a conversation deleted takes its
  queue and what waited for it with it.
- Clients show what's held and whether it's paused from these; the in-flight record of a message
  still on its way (and that Stop held it) stays with the client that sends it, which waits for its
  request before it asks the box to stop, and for its hold before it asks the box to resume.
- A box without `queue` in its features (its update didn't get through): each client carries that
  box's queues itself, as clients did before.

### A session at a glance

What a session's row and its card show beyond the session itself (`sessions.glance`): a row gains
one mark, its pull request's (else its branch's), only on a session with a branch of its own or a
pull request; its card (hover on a Mac, a long press on a phone) says the state and how long ago,
the branch, the model, effort and account, and the pull request with its checks and size.

- `GET kuvo/sessions/glance?sessions=<id>,<id>…` (at most 200) → `{"sessions": {<id>: {branch?,
  additions?, deletions?, pull?: {number, url, state?, additions?, deletions?, checks?: {passed,
  failed, pending}}, account?: {name, label?}, asked?}}}`. A session the box doesn't have is left
  out (only when every place said it has none: `503 {"message"}` while one isn't answering, rather
  than say it's gone); `400 {"message"}` for none named, `503` with neither the engine nor the coding
  agents' bridge running. `GET kuvo/sessions/glance/events?sessions=…` sends the same now (ndjson),
  and again when it changes: an ask coming or answered and a pull request linked (a moment after, so
  a few at once are one line), and once a minute for the rest; nothing while a place isn't
  answering, so what it said last stands. A
  client follows it for the rows on its screen only, and opens it again as they change; through
  `box route` it answers its first line, and a client asks again a minute later.
- `branch`: the session's own, a worktree's of the box's (`box/worktrees.json`), else its pull
  request's head branch; left out for one in its project's own checkout, whose row stays as it is.
  `additions` and `deletions`, without a pull request: the lines its branch changed since it left
  its base, uncommitted changes too (`kuvo/git/changes/count`'s `branch` scope).
- `pull`: the pull request it made, else, in a worktree, its branch's latest on origin's GitHub
  repository (open, merged or closed) from origin's repository itself (not a fork's branch of the
  same name) and made since the worktree was (not an earlier branch's of the same name). It made it
  when Create Pull Request named it (`kuvo/git/pull-request` with `session`), or when its own `gh pr
  create` (or one of its subagents') printed it, which the box catches as the call ends: a command
  that starts with it (or after `&&`, `;`, `|`), the last pull request it printed, and only on the
  host of the session folder's origin. Kept in `box/pulls.json` (the latest 500), so two sessions in
  one folder never show each other's. `state`: `open`, `draft`, `merged` or `closed`, with
  `additions`, `deletions` and `checks` the pull request's, as GitHub last said; all left out until
  GitHub's been read, or when it can't be (only `number` and `url`). `checks` counts the last commit's check runs and statuses: skipped and neutral ones as
  passed; failed, errors, cancelled, timed out, stale and those needing action as failed; the rest
  pending. Left out for none.
- GitHub is read with GitHub's own `gh` on the box and its sign-in (Kuvo Code keeps no key of
  GitHub's for it): one GraphQL query for every pull request asked for at once, only while a client
  asks, and each only as often as it can change: once a minute while its checks run, every five
  minutes while it's open otherwise (or a worktree's branch has none yet), every half hour once it's
  merged or closed. Kept in `run/glance/github.json` (two hours), which one process at a time
  writes, so a box asks GitHub once however many processes and clients ask it. A box without `gh`,
  or signed out, reads nothing for five minutes, then tries again.
- `account`: the account it runs on, as `kuvo/work` says one ("Work"); none on Custom Auto.
- `asked`: while it waits on you, when the oldest ask still open came (ms), its subagents' too: a
  permission or a question (not one Auto's reviewer took up), or what the box asks you for it (a
  command outside the sandbox, the vault), as the box's long-running process heard it
  (`run/glance/asks.json`). An ask is let go as it's answered, as its run ends or it's deleted, and
  with all of its place's (engine, bridge) once that place is heard again after it couldn't be. An
  ask made while the box couldn't hear it has none, and a client says how long since the session
  last changed instead.
- What a client draws from it (which mark, which lines on the card) is the clients' to decide
  alike; a box without `sessions.glance` gives no marks beyond the worktree's branch, as before.

### A session's model

What a conversation's model button names, and whether its model can run (`sessions.models`): the
box decides it from what its engine and coding agents list, so every client shows the same.

- `GET kuvo/sessions/models?sessions=<id>,<id>…` (at most 200) → `{"sessions": {<id>: {model,
  name?, runs, missing?, account?: {id, name, label?}, plan?: {name, agent, provider}}}}`. `400
  {"message"}` for none named, `405` for anything but `GET`, `503` with neither the engine nor the
  coding agents' bridge running, or while one that might have a session isn't answering.
- `model`: the model it runs on, `{providerID, id, variant?}` as the session names it: its own,
  else (a session of the engine's with none) the engine's default; `null` when the engine says it
  has none (`api/model/default` answers `data: null`). `name`:
  as its provider lists it, or its coding agent (Claude Code's `default` by the model it stands
  for now), or a Custom Auto list's name; left out for one gone from the list.
- `runs`: it can run here now. Else `missing` says what it needs:
  - `model`: none to run on: choose one.
  - `signIn`: a sign-in to `account` (an engine provider's, or a coding agent's account, `label`
    the name you gave one you added).
  - `key`: a key for `account`, where the only way Accounts offers to sign in to it is a key. The
    engine's OpenAI and xAI are offered only a key, as their ChatGPT and SuperGrok plans sign in
    through Codex and Grok: those come with `plan` (`{name: "SuperGrok", agent: "Grok", provider:
    "grok-cli"}`), where its models are.
  - `install`: `account`'s coding agent installed on this box.
  - `gone`: the model is no longer in its provider's list (`account`, while its account is still
    there), its account signed in: retired, or a coding agent's it no longer lists. It can't run:
    choose another. Also a coding agent's account you removed, and a Custom Auto list emptied (one
    deleted runs on your first list, as the bridge runs it).
- The engine's lists (its providers, models, accounts and default) are read in the session's
  folder, where a project's own settings may add to them.
- An engine provider counts as signed in when the engine says it's ready (`api/provider`), it has
  a connection, or nothing to sign in to (a local one's); OpenCode Zen's free models need no
  account, and its others need its account or a key (the engine lists it ready for its free ones,
  and lists its others only then). A model missing from a provider signed in is `gone` only while
  the engine lists others of that provider. A coding
  agent's model runs while its account is installed, signed in, and its agent lists it (by its own
  id or one it's known by), one it keeps out of its picker too (Codex's hidden ones, from the
  bridge's `api/model?hidden=1`): only one absent from its list is `gone`, and only where its
  account says its list is every model it runs (`metadata.modelsComplete` in the bridge's
  `api/integration`: not while Claude Code lists its usual ones, nor for a Codex that listed none
  it hides, nor from a bridge before it). Custom Auto runs while its list has models: it
  picks among them each turn, so whether one entry's account is signed in isn't said.
- Left out, as not known yet: a session the box doesn't have; one whose place didn't answer just
  now; an engine's session while the engine lists no provider ready or no models for its folder
  (one it hasn't loaded yet answers so at first), or, for one with no model of its own, while it
  didn't answer for its default; a coding agent's model while that account, signed in, lists no
  models, or only its usual ones (`provisional: true` on the bridge's `api/model`, Claude Code's
  until it says which your account has), or one missing from a list its account doesn't say is
  whole; and a model of a provider the engine doesn't know at all. A client decides such a one as
  it would from a box without `sessions.models`.
- What the engine and the bridge list is read once for every session asked about, and used again
  for ten seconds, or until the box hears either say accounts, models, settings or Custom Auto's
  lists changed (`integration.updated`, `model.updated`, `provider.updated`, `config.updated`,
  `global.disposed`, `kuvo.auto.updated`), or hears them again after it couldn't; what one of them
  couldn't wholly say (its default, Custom Auto's lists) isn't kept.
- A client asks again as what it's drawn from changes: the session opens, its model changes, or its
  box's accounts, models, default model or Custom Auto lists do (as it reads them again on
  `integration.updated`, `model.updated`, `provider.updated`, `config.updated`,
  `kuvo.auto.updated`), and once a model it picked is set. What the box said is of the model it
  names: a client draws it only while that's still the session's (another just picked is drawn as
  without the box's word until the box is asked again).
- Clients draw it alike from ClientSessions' `SessionModelState`: the model button names the model
  while it runs or its account needs something, and says "Choose a Model" for `gone` and `model`;
  Send follows `ComposerSend` with that, so it waits for a model for those two, and for the others
  a message is refused with what to do (a sign-in, a key, an install, where), kept in the field;
  a failed turn's card, for the model the conversation is on, names its button by what it does
  (Add Key, Install, Sign In, or Sign In Again for a sign-in that ended). How a signed-out engine
  provider is signed in to is held to `Vectors/plan-sign-ins.json` in the box and KuvoClient's
  `PlanSignIns` and `Integration.offeredSignInMethods`, which both apps' Accounts offer from. A
  box without `sessions.models` leaves the clients deciding from its accounts and models as they
  did before.

### Work

A bot runs sessions as you would (bridge 0.9.106): it starts them in your projects on the model,
effort, mode and approval it picks, hears when they finish or ask, answers what they ask within
what it may do itself, and stops them. Every box does this alike, with no client connected; every
client shows it from the same routes.

- **Marked as its work**: a session a bot starts, and every one under it, has metadata
  `kuvo: {startedBy, by: {bot, name}, depth, wake?}`: the bot it works for, how deep it is
  (1 for one the bot started), and what its starter hears of it (a bot: both, or only its asks
  when it waited for the answer). A finish heard while its starter waits for its answer
  (`send_message` with `wait`, on the session's box or by a letter from another) waits for that wait
  to end, and is told unless the wait ended with that same reply, which came to it in the tool; a
  failure is told at once. (Each wait is a file in `run/work/awaited` on the session's box, kept by
  whichever process waits there, the tool's or the one answering a letter, with its reply's id for
  a minute after.) Only its starter's wait counts: a turn someone else asked for is told as usual.
  What a starter hears is gathered a few seconds and sent as one
  message (an ask to be read at its next step), kept in `run/work/wakes.json` until it's sent (for a
  conversation the engine doesn't know while the coding agents' bridge isn't running, 30 days at most,
  since it may be the bridge's; an answer given late, below, is kept a week; for an archived one, until
  it's brought back, as its own wake-ups wait, a week at most; for one moving to or from another
  computer, until it's there; for one that lives on another computer now, it goes to it
  there as a letter with `note`, "Peers", delivered there as it would have been here). Clients mark rows by `kuvo.by`.
  One whose answer was lost (the engine slow to answer) may have arrived: it goes again alone under
  the same message `id` (`wakes.json`'s `tried`), which a conversation takes once, and what came
  meanwhile after it (one message at a time to each conversation). A finish is told once however many ways it's heard of at once (its run's end,
  what it left running ending, the box catching up as its engine's stream connects again), even when
  its reply can't be read in time: `told.json` keeps when the session last changed as it was told
  (`upto`, by its engine's clock, and `unread` when its reply couldn't be read), and a look that saw
  nothing newer tells nothing.
  - **Homes** (`run/work/homes.json`, bridge 0.9.203): `{<session>: {key, at}}`, the box each
    conversation that left lives on, by the newest word: this box's record of its moves, its peers'
    `moved`, a box's `lives`, and a note's `about`. Unlike `moved` it doesn't forget at two days: a
    home goes 30 days after its `at`, once no session here says it was started by that conversation
    (looked at hourly, and only with the engine and the coding agents' bridge both there to ask). A
    conversation this box has always wins over a home, and a computer you removed is no one's home.
    A note's `about` counts as of its `made`.
  Its task ends with the session's half of the playbook: review your work with reviewer subagents,
  fix what they find, and end with a short report; with `review: false` (a small task its bot
  says needs no review, #554), only the report, without the reviewers. A session whose starter hears it finish is told
  that report, its last reply, reaches them then, so it doesn't send it again with `send_message`
  (that's for asking something or saying how it goes); its task's first line says so too.
- **Tools** (`POST kuvo/agent-tools`, any conversation, for the sessions under it):
  `list_sessions` (each with where it stands: working, asking and what, with the ask's id,
  finished, failed, stopped; its model, the tokens in its context now, or that it was just
  summarized, the tokens it used in total, and last reply's first lines: for one stopped or
  failed, only what it said in that turn, never an earlier turn's reply; one stopped at rest,
  after its last turn ended, is stopped, its reply said to be from that turn, before the stop;
  `kuvo/work` gives that row none), `stop_session`
  (`{session, archive?}`; only one of its own), `compact_session` (`{session}`; only one of its
  own, by `POST api/session/<id>/compact` where it runs), `answer_ask` (`{session, ask, decision: allow|deny,
  reason}`, or `{session, ask, answer, reason}` for a question), `list_models` (the models there's
  an account for here, `provider/model`, with their efforts; none its provider is retiring).
  - **Across your computers** (bridge 0.9.204): a lead reaches the sessions under it on another
    computer (a bot that moved, say) by a call ("Peers", `call`). `stop_session`, `compact_session`
    and `answer_ask` for a session that isn't here go to the computer that told of it, or where it's
    known to live, or to each that takes calls when nothing says (kept for those not answering, in
    case it's there). `list_sessions` lists those here, then asks each computer that told this one of
    the caller's sessions, under its name: live, or, when it isn't answering or doesn't answer in 20
    seconds, what it last told, "as of" then, and that it isn't answering. A stop, a compact or an
    answer for a computer that isn't answering is kept and done when it's back (an allow for a day),
    and the tool says so; how it went comes to the lead as a message.
  - **Starting work there**: `start_session`, `list_models` and `list_projects` take
    `computer`, another of your computers by the name `list_agents` shows (a Mac also as "the
    Mac" when there's one; this box's own name, "here" or none: here). Two of one name are refused,
    asking which. A start there is checked on the lead's box first as a start here is (a group
    chat's seat, the lead's mode, a folder named there, the limits you set for its bot counting its
    sessions here and those other computers last told of, the net against a runaway), and refused
    while its bot has a goal running (goals don't reach other computers yet), then goes as a call
    ("Peers", Starts). Its answer is `[On <box>] …`, as the session's box words it. A session's
    `kuvo.line` (the conversations above it, up to 20) lets a lead list and stop what a session it
    started on another computer started on a third: `under` goes up a session's starters here and
    its line, and rows go to every lead up a session's line that lives elsewhere.
  - **Rows from elsewhere** (`run/work/elsewhere/<key>.json`, `{at, heard, leads: {<lead>: [row]}}`):
    what each computer told of the sessions of leads that live here. A box works out its own each
    time its work or moves change, and each minute: every session here whose line leads up to a
    conversation that lives on another computer now ("Homes"), at most 40 for each lead, not those
    put away. It tells each such computer, again each minute until it says it has them
    (`run/work/pushed.json`, `{<key>: {id, done, sent}}`), and once more with none when there are
    none left. A lead's computer can't have rows of a move whose old box was closed before it told
    (within one round of seeing the move): it has them once that box is back. `list_sessions` asks
    only computers that told of the lead's sessions, so a lead with none elsewhere waits on no one.
- **Models that can't answer** (`work/unanswering.ts`, `run/work/unanswering.json`, bridge
  0.9.198): when a session a conversation started fails at its account (the engine's
  `provider.quota` or `provider.budget-limit`: out of funds or at a plan's spend, which holds back
  that provider's models that cost something, its free ones spending none; `provider.free-limit`,
  its free usage spent, its free ones; `provider.auth`, signed out, all of them), or at a model's
  own limit (`provider.rate-limit`, `provider.model-budget-limit`, or an untyped error whose words say a limit,
  not that it's overloaded or at capacity), that model. Its starter's `[Session failed]` line says
  so in the engine's words; `list_models` leaves them out, naming them at its end; an agent's
  `start_session` on one still starts it, and says why it may fail and the model the agent runs on,
  when that one can answer (yours from a client says nothing: you may have topped it up). A
  `start_session` that waits ends as soon as the new session stops, with its error (an error
  result), rather than waiting for a reply that won't come. A hold lasts until the reset the error
  names, counted from when it failed, else half an hour (a rate limit, three minutes), or until a
  session on it answers (a free one says nothing of its account's funds, nor a paid one of its free
  usage), or until that account's
  key or sign-in changes (the engine's `credential.switched` or `credential.removed`, and
  `integration.updated` or `provider.updated`, for the account they name, or every account when
  they name none). `read_conversation` shows a turn's error where it stopped. Clients mark them in
  their model pickers from `GET kuvo/work/unanswering` (feature `work.unanswering`) →
  `{held: [{provider, model?, only?: "paid"|"free", models?, why, since, until}]}`: `model` left out
  for an account's models (`only` its paid or free ones, then `models` the ids that covers, as its
  engine prices them, when it could say), `why` in the engine's words, times in ms.
- **Answering asks** (`work/policy.ts`, bridge 0.9.189): a bot answers its sessions' asks as far
  as its own conversation could go ahead without asking, as any conversation in its mode would.
  It's judged by the tool call itself (its whole input, found by the ask's `source`, which has a
  command's `cd` and the folder it runs in; what the ask lists where the call can't be found), and
  by what the ask lists, part by part,
  by the engine's rules for the bot's own conversation (the engine's defaults, Settings ›
  Permissions, what you set in Edit Bot, then the conversation's own): each part of a command line,
  and a file the call names outside the session's folders (where it really is, a link in it
  followed, a path not from `/` from the session's folder) as working outside the project
  (`external_directory`).
  - Where its own conversation's commands run in the sandbox ("Sandbox"), it allows a command only
    where the session's run there too: the engine's while it's `on`; a coding agent's when the
    agents bridge marks its ask `sandboxed`, its program having started in it, and while it's still
    set up. In Full Access, or with no sandbox here, anywhere its rules allow.
  - **A session in Ask First always asks the user** (bridge 0.9.205), whatever the bot's mode: a
    bot in Full Access or Auto can't allow what it asks. Read from the session's approval as it
    stands now ("Approval", `effective`: an Auto that can't be had here is Ask First), on the engine
    and on the coding agents' bridge, by the box that has the session, so it holds across computers
    too. Its answer is the same refusal ("You can't allow that"): the ask stays on the session for
    the user. A bot may still deny, and still answer a question in words (that's no permission).
    Accept Edits, Auto and Full Access sessions are judged as above; a subagent's ask is its
    session's.
  - Everything else goes to the user. It may always deny, with its reason passed on. A command a
    bot allows still can't get out of the sandbox: only you can let one out (`sandbox_ask`,
    "Asks"), and no tool answers that.
  - Before bridge 0.9.189 a bot allowed much less than its own conversation could: a few reads and
    plain edits until the sandbox, and in it nothing that acted beyond this computer.
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
  depth, model?, mode?, account?, state, asks?, started, tokens, cost?, lastReply?}], answered: [answer with
  its session], today: {started, working, tokens, cost?}, limits}`: its sessions the latest first,
  archived ones left out. 400 without `bot`, 404 for no such bot here, 503 with no engine. Each
  `state` is as of the read; `lastReply` is what it said last, and for one `stopped` or `failed`
  only what it said in that turn, never an earlier turn's reply (one stopped at rest has none). `today.working` stays, since clients until 0.7.2 need it to read the
  report, but no client shows it (see At work).
  `account` (bridge 0.9.209) is `{name, label?}`, the account it runs on as Settings › Accounts
  lists it where it runs (`api/integration` there, as last checked, never `fresh`): `name` its
  provider's ("Claude Code", "GitHub Copilot", "Anthropic"); `label` the name you gave a coding
  agent's account you added ("Work"; its own sign-in has none, and the engine's sign-ins have no
  names of yours). Left out on Custom Auto (it picks one each turn) and where the engine or bridge
  can't say within a few seconds. Clients show it on a row as `ClientSessions`' `WorkWords.account`
  does: the provider's short name, as the usage panel names it (`ClientAccounts`' `AccountNames`:
  "Claude" for Claude Code, "Codex", "Copilot"), else `name`, then `label` ("Claude · Athas"); in
  a row too short for it the account goes whole before the project does, and the session's title
  always keeps its room.
- **`GET kuvo/work/events`** (ndjson): `{"changed": {<bot>: <ms>}}` now and at each change to a
  bot's work (a session started, stopped, finished or asking, an ask answered, its limits); a
  client reads that bot's work again when its time moves. Kept in `run/work/changes.json`.
- **`GET kuvo/work/oversight`** → `{marks: [{id, bot, session, kind, at}]}`, and
  **`GET kuvo/work/oversight/events`** (ndjson, the same now and at each new mark): what bots just
  did, from their own conversations, to their own sessions (`kuvo.by`), the oldest first. `kind`
  is one of:
  - `started`: started it with `start_session`;
  - `told`: wrote to it with `send_message`;
  - `read`: read it with `read_conversation`;
  - `answered`: answered what it asked;
  - `stopped`: stopped it;
  - `finished`: it finished well, marked once it's really done (see Background work). A failed or
    stopped one isn't marked.

  Nothing is marked for a session that isn't the bot's own, or for what one of its sessions does to
  another (its session that started one, say).

  Clients show the bot looking after its sessions with these marks. The first line is what was there already; each new `id` after it plays once. Only the latest minute is kept, at most 50, in `run/work/oversight.json`. A box from before it answers 404.
- **At work** (KuvoClient's `AtWork`): whether a bot is at work and how many of its sessions are
  isn't sent as an answer. Each client works it out the same way, from facts its box states, for a
  bot's row, face, tab and header and the bar over its composer:
  - a session is *working* when its engine (or the coding agents' bridge) runs a turn of it
    (`session.status`, `/api/session/active`) or Background work lists it, and *at work* when it's
    working or waiting on an answer (a permission or question, its own or a subagent's);
  - the sessions a bot oversees are those marked `kuvo.by` with its id (the box marks those its
    sessions start too, so no client follows `startedBy`), and not archived (`time.archived`, `kuvo.archived`, or `kuvo: {archived: true}`). A
    subagent isn't one: it keeps the session it works for at work, through Background work;
  - a bot is at work through them (its face and row) while one is working, unless its wake-ups are
    paused (it sleeps; its bar still lists them). One only waiting on you shows that on its own row;
  - the bar takes `kuvo/work`'s sessions as the client knows them now: one asking, asking; one
    working, working; one the report had at work that no longer is, done. So it counts what the row
    counts without reading the report again.

  A box from before Background work lists nothing there, and its report doesn't count it either:
  both say a session waiting on a command it left running isn't at work.
- **Background work** (`work/background.ts`): what still runs for a session once its own turn is
  over. One fact, worked out on the box, that clients show and never work out themselves.
  - **`GET kuvo/work/background`** → `{sessions: {<session>: {commands, subagents, tasks, since}}}`,
    and **`GET kuvo/work/background/events`** (ndjson, the same now and at each change). Counts, and
    `since` in ms; a session with nothing running isn't listed. `commands`: commands it left running.
    `subagents`: subagents at work under it, a review's parts and other hidden runs left out.
    `tasks`: anything else its agent keeps going. A client shows a session at work when its own turn
    runs or it's listed here. Kept in `run/work/background.json`, per place (engine, bridge).
  - **Counting at work**: `kuvo/work`'s `state` and `today.working`, a bot's limits,
    `list_sessions` and every client's At work all go by the same fact. One running 6 hours (a dev server) stops counting, though
    it may still run, and a client's list of commands still shows it. A goal's Mac stays awake for it
    too, but it holds off a goal's nudge only for 30 minutes, and never hides a turn that failed at a
    limit.
  - **Telling a lead**: `[Session finished]` waits while any of it runs, however long (a build queued
    for hours), and looks again 10 seconds after it ends, since the end wakes its agent. Nothing is
    sent meanwhile (a lead's `list_sessions` shows the session at work). A service doesn't hold it:
    a command listening on a TCP port (a dev server, a preview), found by its process group (the
    engine's commands, whose `pid` leads one: `lsof` on macOS, `/proc` on Linux; the coding agents'
    don't say, so theirs always hold it). When only services are left it's told at once, ending
    `(Still serving: \`npm run dev\` on :5173.)`; a command that starts listening after its turn ended
    is found a minute on. An end that wasn't heard (an event lost on a busy box) is found within 10
    minutes, and anything else that never ends is told as it stops counting at its 6 hours. A
    finish never says "Still running in the background". `background.json` gives such a command
    `ports`. Boxes before #553
    told one still running at 30 minutes anyway, saying what still ran ("Still running in the
    background: …"), and boxes before #420 told that as `[Session still working]`; clients still
    read both: those words are left out of a finish's card, and “still working” shows nothing. A turn someone asked for doesn't wait on what
    was running before they asked (a dev server): it's told at once as `[Session finished]`. After
    that a turn someone asked for is always told. A
    turn following the box's own word (what a session it started did, a limit that reset) is too, as
    what comes of it may be the result. A turn that began on its own (what it
    left running ended, its own wake-up) is told only if it has something to say: 200 characters or
    more, and not the same again. The exception is what follows a finish told before the work was
    over, told however short, unless its own wake-up began it. The same failure again in a turn
    that began on its own is told once. Oversight's `finished` mark goes with the telling.
  - **Stopping**: `stop_session`, Stop on a session someone started, and `stop-all` end its turn,
    what it left running, and its wake-ups and watches, and mark it in `run/work/stopped.json`.
    `stop-all` takes those waiting on a timer of their own too, and holds what waits only where a
    turn stopped. Stopped by its lead (`stop_session`), its lead hears nothing of it. Stopped by the
    user (Stop on its row, `POST kuvo/sessions/<id>/stop`, `stop-all`, a goal's Stop), its lead,
    if it follows its finishes and was still waiting on it (a turn, what it left running, its finish
    held, a wake-up of its own or a question of its), hears that once, so it never waits on a
    session that won't finish: `[Session stopped] "<title>" in <place> (address <id>) was stopped by
    the user. …`, without what it was holding; clients show it as “<title>” stopped by you.
    A second Stop says nothing more. `stop-all` (and a goal's Stop) drops what its bot was still to
    hear, then sends one such line for each session it stopped, one message to each lead not stopped
    itself; the bot's own queue is paused first, so its lines wait there (with its wake-ups) for your
    next message or Resume rather than setting it going. A goal whose end came stops its sessions
    without telling.
    Until it's set going again, nothing it does is told. What's written to it decides,
    read at `session.inbox.delivered` (the turn starts before the message is in its conversation):
    what it left running ending or its agent carrying on by itself (a `synthetic` with
    `metadata.source` `shell`, `subagent` or `agent`), or the box's own word (what a session it
    started did), is interrupted at once; anything else written since the stop, a message, your
    choice on an Autopilot call, a goal or a wake-up, sets it going and clears the mark, as Resume
    and Send Now do. On Autopilot a turn goes on through a question that goes ahead, which starts no
    turn of its own and tells no one: its lead hears what it ends with, as ever. An archived session is
    interrupted the same way, and never told of. Stop in your own conversation or in a bot's own ends
    the turn only, and keeps its background commands and wake-ups. So does a goal's Pause, for each
    of its sessions, since it goes on from where it was.
  - **The box restarting**: what it was holding is in `run/work/told.json` (`waiting`, with `asked`,
    when the question its turn answered was asked) and looked at again as it starts: told once if
    it's over, held if it still runs (told as it ends), let go of if it's gone. The
    engine's connection dropping clears that place's list until it's looked at again: its commands
    go with its engine. A client keeps what a box said while its stream drops for a moment, and drops
    it once the box can't be reached.
  - **Which agents can say**: the engine's own agents say all of it (`GET api/shell` one folder at
    a time, `shell.created`, `shell.exited`, and child sessions in `/api/session/active`). Only
    folders with something at work are asked, because asking starts a folder's tools. Claude Code:
    commands, subagents and tasks. Codex: subagents, and commands it left running in background
    terminals as tasks (listed again every 30 seconds while any runs: Codex doesn't say when one
    ends, and isn't woken by it, as in its own CLI). Grok: what it keeps going in the background
    (its commands and subagents) as tasks. Antigravity: subagents, which is how its own timers run.
    Cursor: subagents only within a turn. What an agent can't report doesn't count: the session
    shows as not at work, and its lead is told at the end of its turn, so nothing hangs on it.
  - **Kept going, and lost**: a session's agent process is kept while what it left running goes
    (it isn't closed 15 minutes after its last turn), since that work goes with it. For the agents
    that are woken as such work ends (Claude Code, Grok), when it ends unfinished with their process
    instead, the bridge wakes the session itself, with a `synthetic` note saying what stopped (and
    the end of what it printed, or the file it went to, when known): `metadata` `{source: "shell",
    state: "error", signal: "SIGTERM", kuvo: {lostWork: <when>, work}}` (`source: "agent"` when none
    of it was a command), `description` the command. That's when the process ends by itself between
    turns (killed from outside, or crashed); and as the bridge stops, when the note waits in the
    session's queue (`kuvo.restarted`) and wakes it once the bridge is back, if that's within 10
    minutes (a restart or an update; after a quit for longer, it waits for the session's next message
    instead). While an undo is staged it waits: Redo sends it, and your next message (which makes the
    undo final, starting the agent over) is followed by one note for all of it. When the agent starts
    again for your next message (an update, its settings changed), that message says so instead (a
    command, as typed, is followed by the note). A move to another computer is refused while such
    work runs, as before.
  - **The bridge's side**: `GET api/session/background` → `{data: {<session>: {commands: [{id,
    command, started}], subagents: [{id, since}], tasks: [{id, since}]}}}`, `DELETE
    api/session/<id>/background` ends them all, and the event `session.background.updated` says to
    look again.
- **`POST kuvo/bots/<id>/stop-all`** → `{stopped}`: every session of its work that's working,
  stopped (held and paused, as the queue's Stop), and the bot's own turn too, with what it was
  still to hear of them dropped. 404 for no such bot here, 503 with no engine.
- **A box starting again** (its link): what its followed sessions did while it was down (finished,
  failed, also a turn that failed before it replied, asked; not one that was stopped) is told to
  their starters once, by what `run/work/told.json` says was told (the reply, and a failed turn by
  its end): the engine's and the coding agents' bridge's each as it's
  found, from when the box last heard of that one, and only once it could list them all (one slow or
  not there yet is looked at again a minute on; a session it couldn't read doesn't hold back the
  others, and is looked at again a few times, then as the box starts the next time, on a few starts at most). A finish that was waiting for its starter's wait
  to end (`told.json`'s `held`) is looked at whenever it finished. An answer to an ask given after its tool stopped waiting
  goes to its conversation if it hadn't.

**Projects** (bridge 0.9.107, feature `work.projects`): a bot makes new projects on its box, in a
folder you pick once per box, after asking you.
- **Where they go**: `GET|PATCH kuvo/work/settings` → `{projectsFolder: string|null, suggested?}`,
  kept in `box/work.json`. None until you pick one; `suggested` is `~/Developer` or `~/Projects`
  when there's one. PATCH `{projectsFolder}` takes a full path (`~` is fine) to a folder that's
  there, or null; 400 otherwise. The box makes projects only there, and never deletes one.
- **Tools**: `make_project` (`{name, git?, clone?, folder?}`: a folder named after it, lowercase with
  dashes, a new git repository there unless `git: false`, or a repository cloned from an https or
  ssh address; either way it has a commit at once (bridge 0.9.198: an empty `Initial commit` in a
  new one, or in a clone with none, by whoever your git settings say commits there, else by
  `Kuvo Code <kuvo-code@localhost>`), so each of its sessions can start in a worktree; `folder`, bridge 0.9.191, is where you said it goes, a full path (`~` is fine; the
  folders on the way there are made too), which needs no projects folder picked), `list_projects` (each project here:
  its folder, whether it's git, who made it).
  A folder that's there with files in it, a project there already, or an address git can't clone
  is refused without asking.
- **Asking you first**: `make_project` asks unless you said Always to that bot for that kind, or
  it's a project in the goal you started (by its name, or by the folder named for it there), and a
  projects folder is picked (or a folder named for it). An ask for one with a folder named has that
  as its `folder`, and no `suggested`. The ask is kept in `run/work/asks.json` until you answer; the
  tool waits up to ten minutes, then says it stays asked, and the conversation gets
  `[The user answered] …` as a message when you do (for a conversation the engine doesn't know
  while the coding agents' bridge isn't running, or one moving to or from another computer, tried
  again every few minutes, a week at most; to one that lives on another computer now, as a letter there
  with `note`, "Peers").
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

**No built-in limits on a bot** (bridge 0.9.189): a bot's conversation and its work run as any
conversation in their mode does, and only what you set in Edit Bot (its rules, its limits, what
you said Always to) holds them back. In Auto, Auto's reviewer judges them as it judges any
conversation's ("Auto's reviewer"), by what you asked and the bot's goal. A box before 0.9.189 put
ask rules in a bot's conversation and its work whatever their mode (payments, messages, force
pushes and remote deletes, new accounts, publishing and deploying overnight; before 0.9.185 also
deletes, git's settings, `sudo` and sign-ins), and refused them in `answer_ask`. It takes those
rules out of a conversation as it makes its rules again (`work/former-asks.ts`), keeping one
Settings › Permissions has itself.

**Goals** (bridge 0.9.122, feature `work.goals`, `work/goals.ts`): you give a bot a goal of any
length, a couple of hours or a month, and it takes it end to end. It's the conversation's own goal
("Goals", below: the agents bridge keeps the bot at it turn after turn), with a plan kept here
beside it.
- **Tools** (a bot's conversation only): `propose_goal` (`{goal, title?, steps: [text | {text, detail?,
  site?, app?, after?: [step number]}],
  checks?: [{text, ok?, detail?, url?, button?}], spend?: [{what, cap, currency?, per?:
  day|week|month|goal}], projects?: [name | full path], ends?, digest?:
  day|week|milestones|none}`) puts the card up, replacing one it proposed before (refused while one
  runs; `digest` is a day's for a plan in phases or of more than 12 steps unless it says; a spend line
  is only what the bot spends itself, so one whose `what` a check that needs you names (two words or
  more of it, in a row) at its cap's price is yours to pay, like a membership, and isn't kept, the
  reply telling the bot);
  `goal_progress` (`{steps: [{step, state?: todo|doing|done|waiting|paused|skipped, progress?: 0–1,
  note?, until?, app?}]}`, `until` a time like `2026-11-02T09:00` that a step can only start at (null
  takes it away; taken up, it goes; `app: null` takes the step's away), `add?: [text | {text, detail?, site?, app?, after?}]`, `waiting?: {kind: you|judgment|outside, text,
  detail?, url?, app?, step?}` (`step`, the step it holds up by number: it goes once the bot takes
  that step up or ends it, marking it doing, done or skipped), `resolved?: [id or words]` (what waited and is dealt with), `spent?: [{what,
  amount}]` (one on no spend line is kept as waiting, kind `outside`), `watching?: [text]`,
  `decided?: {text, choice, why?, options?: [text]}` (a call the bot made on its own, bridge
  0.9.199)}; all checked before any is kept; it says whether you're here, and how the goal runs); `may_spend` (`{what,
  amount}`: whether it fits the line's cap in its period now); `finish_goal` (`{report, watching?}`).
  `start_session` takes `step` (its number or id), and that step's track lists the session.
- **Asked for**: `POST kuvo/work/goals/ask` `{session, goal}` (`/goal` in a bot's chat, from a
  client) has the bot plan it and propose it at once → `{text}`; 400 for a conversation that isn't
  a bot's. It goes as your message: your words, then a `<sent-with>` block (below) with the goal's
  own heading (`SentWithKeyword.goalHeading`, which tells the bot to plan it) and `/goal`, so it
  reads as you typed it, then (bridge 0.9.191) lines on how to plan it as a lead whose sessions do
  the work, which clients leave out with the block. One a box sent before 0.9.143 is `[Goal] <words>` then a note in
  parentheses; `SentWithKeyword.split` reads it the same way.
- **Only you start it**: `POST kuvo/work/goals/<id>` from a client, `{action: start, mode?, wake?, digest?, ends?, spend?: [{cap?, per?}] (by line)}`, `{action: decline}` or `{action:
  stop}` (and `{action: projects}`, below) → `{goal}` (`ends: null` starts it with no end, taking away the one the bot proposed; left
  out, the bot's stands); while it runs, `{action: change, …the same but start's}` (a cap raised past what's
  spent lets what spends go on; the bot is told `[Goal changed] …` once a limit is given, or the
  mode is another than it was), `{action: clear, waiting:
  <id>}` (what waited, put away) and `{action: decided, decided: <id>, choice}` ("Interactive or
  Autopilot", below). An end written without a zone (`2026-11-30T18:00`) is in yours
  (`KUVO_TZ`, else the computer's). Never a tool, an agent's message or another computer's mail. 400 for one in the
  wrong state or a card from more than a day ago; 404 for none; 409 for starting one (or asking
  for one) while its bot moves to another computer (a goal stays on the box it started on, and a
  bot working on one doesn't move: `kuvo/moves`), when the bot isn't told anything of its goal
  either. Starting tells the bot `[Goal
  started] …` (what it may spend, the projects it may make, the end,
  and, bridge 0.9.191, how to work through it: make its projects with `make_project`, hand each step
  to a session with `start_session`, follow them up, and write none of the work itself unless you
  said to) and
  sets the conversation's goal with `long: true` (no brief of its own: this is it); declining tells
  it `[Not now] …`; stopping stops its work as `stop-all` does, and takes the conversation's goal
  away. The box's watch keeps the two as one: it sets the conversation's goal again where its bridge
  lost it, takes it away once the plan has ended, and shows the bot's own pause at a model's limit
  as the plan's (`paused` with `session` the bot's conversation).
- **`GET kuvo/work/goals`** and **`GET kuvo/work/goals/events`** (ndjson, now and at each change) →
  `{goals: [{id, bot, name, session, goal, title?, state: proposed|running|done|stopped|declined, steps:
  [{id, text, state, progress?, note?, detail?, phase?, site?, app?: {name, id?}, after?, sessions?, resumes?, until?,
  began?, ended?}], checks: [{id, text,
  detail?, state: ok|needs|failed, by: bot|box, site?, action?: {kind: open|projectsFolder, label, url?}}], spend:
  [{what, cap, currency, per, spent, until?}], public: [] (nothing is held back for a switch: what it publishes, deploys or
  sends goes as its conversation's mode allows; before bridge 0.9.197 each public step waited as a
  draft until you switched it on), projects, wake, digest,
  ends?, proposed, started?, ended?, waiting: [{id, kind: you|judgment|outside|ask, text, detail?,
  url?, site?, app?: {name, id?}, session?, step?, at}], paused: [{why, until?, session?}], waited, watching, next?, lastDigest?: {at, text},
  report?, mode: interactive|autopilot, decided: [{id, text, choice, why?, options?, multiple?, session?, at,
  yours?: {choice, at}}], alone, folders?: [{project, folder: path|null, shown: path|null, there?}]}]}` (`next`: when it goes on next, while nothing of it is at work and nothing can be
  before a time: the bot's soonest wake-up, or the steps it put off; clients say "Next: Mon 09:00"): each bot's latest, while it's proposed or running, or ended within a day. Kept
  in `run/work/goals.json`; `kuvo/work/events` moves too. While it's proposed, the box's own checks
  come first: `alone` (failed where this box can't work on it alone yet), `power` (a Mac on battery),
  `projectsFolder` (needs, when the plan makes a project without a folder named for it, and none is
  picked). `progress` is given only
  where the bot counted it, always with what it counted in `note` ("3 of 8 pages"), which is what
  the apps show; a step without it is in progress, not some share of it. `detail` is a step's one
  line on what's in it (wrapping words are said as one line, at most 120 characters; bridge 0.9.193), which the
  apps show on the card of the step under way; old goals have none. `site` (a step done at a site
  in the browser, a check or what waits: `stripe.com`, from its page's address or as the bot names
  it) is where it's done, and its mark is that site's own icon, which each client loads from the
  site itself; a step done on the computer has none, so no mark. `phase` is still kept from older
  bots, and the apps don't show it.
- **Interactive or Autopilot** (bridge 0.9.199, feature `autopilot`): how the bot runs it,
  `mode`, set as you start it (`interactive` unless you say) and changed while it runs (`{action:
  change, mode}`); a goal kept from before runs Interactive. It never changes what the goal's
  conversations may do (their own modes, Auto or Full Access), nor what it may spend (the plan's
  lines). The bot is told how to run it in `[Goal started] …`, and again in `[Goal changed] The user
  switched the goal to …` (a box note, `Now Autopilot`), and each `goal_progress` says it:
  - **Interactive**: it asks you the calls that are yours (taste and brand, options its research
    leaves close, a change of scope), gathered into one with its recommendation, keeping them as
    waiting (kind `judgment`) while other steps can go on; it decides the rest itself, and never
    asks you to approve its work;
  - **Autopilot**: it decides whatever its research settles, keeps each call with `goal_progress`
    `decided`, and goes on; it takes the plan's steps all the way, publishing, submitting, posting
    and sending included (your Start approved them); it stops only at what only you can do (paying
    on your own account, signing in, making an account, handing over a key), kept as waiting while
    it carries on with the rest. A question the bot asks with the question tool (`metadata.kind:
    question`) that marks a choice `(Recommended)` in each field it needs (one of a list; any of a
    multiselect) goes ahead on it on the box's next look instead of waiting for you: the bot's own
    at once, its sessions' once the bot has had its couple of minutes; the box answers the form
    with it (`POST …/form/<id>/reply`) and keeps it in `decided` (with `session`, the choice's
    description as `why`, and the choices there were as `options`). A question with none, and any
    permission, waits for you as on Interactive; nothing is answered while you have the goal
    paused.
  - `decided` lists the calls it made on its own, the newest 60. `{action: decided, decided: <id>,
    choice}` is your choice on one (`yours`): the same as the bot's confirms it, and the bot isn't
    told; another tells it `[Decision changed] For "<call>" the user picked "<yours>", not "<its>" …`
    (a box note, `You picked <yours>`), to go that way from there. 404 for a call it doesn't have,
    400 without a choice or once the goal isn't running.
- **Apps** (bridge 0.9.196, feature `work.goals.apps`, `work/apps.ts`): a step, or what waits, done
  in an app on the computer names it (`app`, "Xcode"). The box looks for it on its own computer as
  the tool is called, once the call has passed its own checks (a call that's refused has nothing
  looked for), at most 20 names a call, once per name: a name found is looked for again a week on
  (an app updated or uninstalled), one not found a day on, and a name not found is forgotten after
  a month. A Mac's in its Applications folders (the system's, yours, their Utilities) by name, else
  Spotlight's by display name, only in `/Applications`, `/System/Applications`, `~/Applications`
  and `/System/Library/CoreServices` (apps inside them too, like Xcode's Instruments; never one in
  Downloads, Documents, iCloud Drive or a build's products), its icon drawn by AppKit at 64 px
  (asset catalogs' too); Linux's by a desktop entry's `Name=` (any language's) through
  `XDG_DATA_HOME` and `XDG_DATA_DIRS`, and flatpak's and snap's exported entries, its icon a PNG of
  1 MB at most by path or from `hicolor` (the smallest of at least 64 px, else the largest) or
  `pixmaps`. Found, `app` is `{name, id}`, the app's own name and its id: its bundle's or desktop
  entry's, or `app-<hash>` for one whose own can't name a file. **`GET
  kuvo/work/apps/icon?app=<id>`** gives its icon (`image/png`; 404 for none, 400 for an id that
  isn't one, 405 for a method other than GET). Not found, or with an icon that's SVG alone, it has
  no `id`, and clients show no mark. A step can have both `site` and `app`; clients show the
  site's. `goal_progress` takes `app` away with `null` or `""`. Kept in the box's `apps` folder
  (`found.json`, `<id>.png`; an icon no name has any more is taken away).
- **Folders** (bridge 0.9.196): while it's proposed, `folders` says where Start makes each project
  the plan names, worked out as `make_project` will: the folder named for it, or the projects folder
  and its name (`folder` null, and `shown`, while none is picked); `shown` is the same with `~` for
  the box's home; `there` is true when something with files is there already. It's only shown: it
  never holds Start back. A plan can't name a repository to clone yet, so there's no `clone`.
- **Its projects, set on the card** (bridge 0.9.196, feature `work.goals.projects`): while it's
  proposed, `POST kuvo/work/goals/<id>` `{action: projects, projects: [name | path]}` replaces the
  plan's projects, in order: one to five, each a name or a full path (`~/…` or `/…`, not `~` or
  `/` itself), of 200 characters at most, in one line (spaces and newlines in a row are one space)
  (a project renamed, or moved to a folder of its own) → `{goal}`, its `folders` and checks worked
  out again. Each has to be one `make_project` can make: a name (or a path's last folder) with
  letters or numbers a folder's name can take (not "日本語" or "🚀"), and no two the same folder
  ("Tide Pool" and "tide-pool", or a name and its folder's path); `propose_goal` refuses the bot's
  own the same way, in the same words. The bot isn't told then: it hears them as the goal starts,
  or as it proposes the plan again. A plan proposed again with the projects the bot proposed before
  keeps yours (its answer names them); one with other projects replaces yours (its answer says what
  yours were). 400 for a list that won't do (`message` says why), or once it's running or ended;
  404 for none.
- **Alone, or with you there**: a goal goes on alone only where the box's commands run in the
  sandbox (`sandboxOn`: `kuvo/sandbox`'s `on`, and for a bot on a coding agent its `agents` too; a
  test box says yes with `KUVO_TEST_SANDBOX_ON=1`, never the real app's, `run.kuvo.code/box`, whose
  app takes it out). Elsewhere it runs all the same, with what its sessions ask waiting for you.
  Clients don't show the `alone` check: they read `kuvo/sandbox` and say why it can't yet, with
  what fixes it (Restart Agents where an agent started before the sandbox still runs).
- **The goal's own work**: the sessions the bot started since the goal did (a minute's slack); what it
  started before isn't the goal's.
- **Carrying on**: once nothing of the goal has been at work (the bot or its sessions) for 10
  minutes, then 30, an hour, two, four, eight and twelve, the bot is told `[Goal] Nothing of the goal
  is at work now…` (a box note), unless all that's left waits for you, a limit or a time: a wake-up
  the bot set (bridge 0.9.144; one that comes back, a daily check, only once nothing can be done
  now), or steps it put off (`until`, seconds or ms or an ISO time) or paused itself. The wait then
  starts over at that time, so it's told only if what came then started nothing; a wait taken away
  leaves none ahead. Told once, it isn't told again until the plan changes (a step's state,
  progress, time or sessions, or what waits), a time it waited for comes and goes, or its turn
  failed, so a bot that answers and changes nothing is never looped. Anything at work, or a
  `goal_progress`, starts the wait over.
- **Present or away**: you're here while a client is in use (`kuvo/attention`); the box keeps it in
  `run/work/here.json` for the tools. Whether you're here or not, unattended rules hold:
  - what its sessions ask that the bot hasn't answered in a couple of minutes, and what the bot
    asks itself, is listed as `waiting` (kind `ask`, its text `<who> asks: <question>`, or `<who>: <the
    permission>`) and waits for you, however long: it never stalls the rest and is never said no
    to; it leaves the list as soon as it's answered or skipped (the engine's `form.replied`,
    `form.cancelled` or `permission.replied`), and clients are told the work changed; a client
    leaves the bot's own question out of the bar in the bot's own conversation, where it's the
    question card (`GoalPlan.waitingInItsConversation`) (on Autopilot, a question that recommends
    a choice goes ahead on it instead: "Interactive or Autopilot");
  - a session the bot starts for a goal is told you may not be watching: what it asks can wait,
    so it carries on with what doesn't depend on it (before bridge 0.9.189 it was also told not to
    publish, deploy, send or pay, and publishing and deploying asked in the bot's conversation and
    its work while no public step was switched on);
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
  linux: {x86_64|aarch64: {url, integrity}}, darwin: {x86_64|aarch64: {url, integrity}},
  pack: {url, sha256, size}}`: a box takes the engine for its own system and kind. The signature is
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

#### A new version while it works

A Mac that connects puts its own files on a machine (above) while the box works: its sessions may
run day and night, so a piece waiting for "nothing runs" might never take them. Each piece takes a
new version without cutting a turn:

- **The coding agents' bridge** (`bin/kuvo-agents.js`) reads which build it runs as it starts: the
  last `// Built from Packages/Box/src/agents <hash>` line in its bundle (`scripts/build-agents.sh`
  writes it; a Mac's own `// kuvo-agents <hash>` line may follow it). It looks at the bundle in its
  place when the file changes, when a turn ends, and every 10 seconds. It makes way for another
  build there only:
  - while the box isn't updating itself (`run/.updating`, held by a link process that still runs);
  - while it runs on the engine its keeper starts (the version folder of its runtime,
    `engine/<version>/opencode`, is `bin/kuvo-start`'s `V` while that one is there, else the
    newest there): a bundle a Mac brought with a newer engine it didn't start, as sessions were at
    work, waits for that engine, which starts it (`waits: "engine"`);
  - once the bundle has answered a check on this engine (`<engine> kuvo-agents.js selftest`, which
    prints `ok <build>` and exits): one that doesn't waits for a restart (`waits: "restart"`);
  - once it has run eleven minutes, and while what keeps it running will start the new one: the
    engine's launch (`RemoteServer.agentsScript`) starts it again five seconds after it ends, and
    gives up after five runs in a row; a launch since October 2026 starts that count again after a
    run of ten minutes (its loop says `-ge 600`), one from before never does, so there it goes
    only while it has started fewer than three times (one `"url"` line each in `run/agents.log`; a
    start that ended before it said where it listens has none, so two are spare; a log it can't
    read counts as full). Its parent is that loop (`kuvo-agents`, `-lt 5` in its command line,
    read once a minute at most); started by anything else it doesn't go; where the command line
    can't be read, it counts as one from before. Otherwise it waits for a restart
    (`waits: "restart"`), holding nothing. Each renewal is one of those runs. A check that couldn't
    run (it couldn't start, a signal ended it, a minute went by) is tried again at the next look.

  It goes:
  - **At the first quiet moment**: nothing has run for half a minute: no turn (a subagent's, a
    message being handed to one or on its way to a subagent, the files kept after one, a session
    being deleted), no `!` command of yours, no discussion in a group chat here (a chat talking, a
    bot's answer being read), no request coming in (counted until its answer begins: a download's
    body, or the event feed, isn't waited for), nothing an agent
    left running in the background, no side question being answered, review being read, handoff
    being written, goal being checked, or sign-in waiting for you; a turn ending, or a request that
    can start something (any but `GET` and `HEAD`) coming in, starts the half minute again. Reads
    don't: the link asks the bridge whether it answers (`GET api/info`) every half minute, and
    clients read what they show; each is waited for while it's answered. Then it holds new turns, and a
    second later, if it's still quiet, it stops as it always does (what it has is kept) and exits,
    and its launch starts the new bundle. If that second wasn't quiet, it lets go and looks again.
  - **When there isn't one**: after an hour, in the night's window (02:00 to 05:00 in `KUVO_TZ`),
    or after a day whatever the hour, it holds new turns: a message (or a summary, a note) that
    would start a turn stays in its session's line (`inbox`, kept with the session, marked `held`,
    and switched to `delivery: "steer"` so it goes first). Turns under way go on to their end,
    steering into them too; a group chat's seat (`metadata.kuvo.seat`) isn't held, so a discussion
    under way goes on to its end (a new one, a message of yours to a chat meanwhile, starts too, and
    is waited for, within the half hour below), and so does a turn an agent starts on its own (a command it left
    running ended). Then it goes, whatever else is under way (what agents left running in the
    background, a side question, review, handoff or sign-in): each ends as it does at any restart,
    and says so. Half an hour after it began holding, still not gone (a turn waiting on you
    overnight, an update of the box that never finished), it lets go: what it held starts, and an
    hour later, that night still or the next, it holds again.
  - The new bridge, once it's up, starts what was held, each once (`held` cleared as it's woken).
  - Its own build put back in place meanwhile, it lets go of what it held and goes on.
  - A group chat held on another computer whose discussion this bridge's bot is in isn't known
    here: going between that bot's turns, and back after more than 45 seconds, that computer goes
    on without it for that discussion.
  - Only on a machine, whose bridge its launch keeps. This Mac's own bridge comes in its app: the
    app's keeper starts the whole box again from a newer app once nothing runs on it.
- **The link** (`kuvo-link.js run`) has no turns: `setup`, which a Mac runs as it connects, starts
  a newer one over the one running, as before.
- **The engine** isn't ours to hold turns in. A Mac starts a newer one only when it connects and
  nothing runs there (otherwise it keeps the one at work, and puts nothing in its place).
- `bridge.json`, on a machine, says `{pid, port, password, build, renewal}`: `build` as above,
  and `renewal` `{since, holding, waits}` while another build is in its place (`since` in ms;
  `waits` is `quiet`, `holding`, `engine` or `restart`, as above), else null.
- `kuvo/info`'s `pieces` (a machine's) says which version each runs against the one in place:
  `{link, agents, engine}`, each `{running, current, behind}`.
  - `link`: `running` is `run/link.version` while the link runs (null otherwise), `current` the
    version of the link answering, `behind` when they differ. Through the running link (a phone)
    that's its own version; a Mac asks with a process of its own (`kuvo-link.js box route`), from
    the files in place.
  - `agents`: `running` is the build its bridge says (null while none runs, or one from before
    builds were said runs), `current` the build of `bin/kuvo-agents.js`. `behind` while one runs
    that isn't that build; for one that doesn't say, while the bundle is newer than its
    `bridge.json`. `renewal` is its `bridge.json`'s `{since, holding}` while it's behind, else
    null. `waits`, while it's behind (else null), is what it waits for: its `bridge.json`'s, or
    `restart` for one that doesn't say its build (from before bridges made way by themselves),
    which takes the new one when the engine next starts.
  - `engine`: `running` is the running engine's version (null when none runs), `current` the one
    its keeper starts (`bin/kuvo-start`'s `V`, while that one is there, else the newest there).
    `behind` while that one is newer.
  - A client shows a line while one is `behind` (`MachinePieces`, in KuvoClient, its words for
    the coding agents by `waits`), and says nothing otherwise. A Mac's own `kuvo/info` has no `pieces`.

### The browser on a machine

The browser agents use on a machine (`kuvo-browser.js`, its keeper and tools) is Chrome for
Testing, run headless from `~/.kuvo-code/browser/current`. The box sets it up itself, with or
without a Mac: no Mac sends it. On Linux and macOS, x86-64 and ARM64; a Mac's own box
(`KUVO_BOX=mac`) has none (its agents browse in its app's panel).

- **What**: the build this `kuvo-link.js` pins (`src/link/browser/linux.json` and `mac.json`,
  written by `scripts/browser-runtime.py`): Chrome for Testing's zip for the machine's system and
  processor, each with its size and SHA-256; on Linux also the Rocky Linux 8 packages that hold the
  libraries and fonts Chrome needs, which servers often lack. A newer pin comes with a Kuvo Code
  update (the signed release brings `kuvo-link.js`).
- **From**: only `https://storage.googleapis.com/chrome-for-testing-public/` (Google's Chrome for
  Testing) and `https://dl.rockylinux.org/pub/rocky/8/`, then `…/vault/rocky/8.10/` for a package
  moved there. HTTPS, no redirects, the address exactly as pinned.
- **Checked**: each download's size (it stops past it) and SHA-256 before anything of it is
  unpacked; one that doesn't match is deleted and the setup fails, saying so. Nothing downloaded is
  run while setting up. The box unpacks the zip and packages itself (no `unzip`, `xz` or `rpm`
  needed): nothing outside the build's folder, no link that leads out of it (checked again once
  the build is put together), no set-user-ID. Of
  the packages it takes only `usr/lib64/*.so*` (links only to a name beside them), fonts and
  licenses, by their own names.
- **Where**: `browser/.box-staging-<pid>-<random>` while it works (downloads and all, removed
  whatever happens, and by the next setup if one was cut off), then `browser/<build>` with
  `chromium-version` and `kuvo-version` (the box's version), and `current` moved to it in one step.
  A build a browser still runs from stays until nothing does; `browser/profile` (sign-ins) always
  stays. It needs about 1 GB free to set up.
- **When**: as the box's keeper starts (a newer pin is set up then), and each minute while there's
  no browser or the last setup didn't go well, once `run/browser.next` (seconds since 1970, which
  the box writes) says it may; when the browser's needed (`kuvo-browser.js`: the
  live view and the tools wait for it, a tool up to four minutes); when a client asks (`POST
  kuvo/browser`); and again when the browser doesn't start because its build isn't whole
  (`--repair`: after one that went well, not again for six hours for the same build, unless asked
  `now`; one that failed waits as any failure does). One setup at a time
  (`run/.browser-installing`, taken over in one step when its process is gone). An older build
  keeps working while a newer one is set up.
- **Failures**: no network, a source that answers otherwise or too slowly, a checksum, no room. The
  first failure stops every download still going; then it notes why and tries again by itself
  after 1, 5, 15, then 60 minutes. What only an update fixes (a build Google or Rocky no longer
  has, a system or processor it has none for) it doesn't try again by itself. Only a client asking
  `now` (you, with Try Again) has it try at once; the tools and the live view wait as it says.
- **State**: `run/browser-install.json`, `{state, progress?, message?, at, failures?, retryAt?, id?,
  repairedAt?, repairedId?}`. A setup asked for says `checking` at once, before its process starts.
- `kuvo/browser` (a machine's; feature `browser`):
  - `GET` answers `{state, chromium, installed, progress, message, retryAt}`: `state` is `missing`
    (none, and none being set up), `checking`, `downloading` (`progress`, 0 to 1), `installing`,
    `ready` or `failed` (`message`; `retryAt` when it tries again, ms, or null). `chromium` is the
    pinned version, `installed` the one in use.
  - `POST {now?, repair?}` sets it up unless the pinned build's in use (or `repair`), or it waits
    after a failure (unless `now`): 202 with the status.
  - A Mac asks over SSH with `box route`. From a shell: `kuvo-link.js browser install [--now]
    [--repair]` (the setup itself, as the keeper runs it), `browser start [--now] [--repair]` (in
    a process of its own, as `POST`; `kuvo-browser.js` uses it) and `browser status`.
- **The live view** (`kuvo-browser.js connect`) says `Kuvo.installing {state, progress}` while it
  waits for the setup, then `Kuvo.hello`; a setup that failed is `Kuvo.error` with `kind: "missing"`
  and why (an older Mac then puts the browser there itself, as it did). A tool that waited says
  why, or to try again in a minute.
- Only in a test's folder: `KUVO_BROWSER_SOURCE` (an address serving `<host>/<path>`),
  `KUVO_BROWSER_PINS` and `KUVO_BROWSER_SYSTEM`; a test's folder without them downloads nothing.
- An older Mac (before this) still sends its own build over SSH when the machine has none or an
  older one. The box leaves a build of the same Chromium or a newer one in place, and that Mac
  leaves the box's (marked by a newer Kuvo Code) as it is.

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
| `data` | Where it opens: `session` or `group`; `request` for a permission or a form, with `requestSession` when the session asking isn't the one shown (a subagent's), and `answerable: "0"` when its notification mustn't answer it from buttons (it can't show all it covers, or some of its text shows as dots), `alwaysTitle`, its Always button as it says what it saves ("Always Allow Edits", "Always Allow git push", "Always Allow ~/notes"), and `always: "0"` for a permission whose Always would save a wider rule than it shows (`git push *` for `git push origin main`), which a phone that can't name it gives Allow Once and Don't Allow only; `ask` for a browser ask; `quiet: "1"` for one that shows without lighting the screen or a sound (what a goal needs of you, its digest), and `wake: "1"` for what a goal needs of you where you asked to be woken. |

| Category | When |
| --- | --- |
| `permission` | An agent asks to do something. `request` is the permission. |
| `question` | An agent asks a question, or for a form filled in. `request` is the form. |
| `ask` | An agent browsing asks for a sign-in, a code or a step. `ask` is it. |
| `finished` | A run finished with a reply to you, or a conversation sent you something on purpose (`notify_user`). |
| `failed` | A run stopped with an error. |
| `report` | A bot's news: its reply to you, what it sent you on purpose (`notify_user`), a goal's digest (`quiet`) or its report. |
| `blocked` | A bot's goal needs you (`quiet`, or `wake` where you asked to be woken). |
| `message` | Something in a group chat. |

**Handed over, and how it went.** A push counts as handed over only once the box's relay
connection takes it: one closing as it's handed over is held and tried again, as when the relay
isn't there (`kuvo/attention`, below). The relay answers each push with `pushed` (above). Each box
keeps the last answer for each of its phones in `run/notices/pushed.json`, by the phone's key:
`{"<key>": {"at", "outcome": "sent"|"noPhone"|"notAllowed"|"refused"|"unknown", "sent"?}}`, `at` and `sent`
(when one last went through) in ms since 1970. So a phone that hears nothing can be told from one
that was sent nothing: `noPhone` is no registration at its address (it registers again as it
connects), `notAllowed` a registration that doesn't name this box among its senders, `refused`
Apple's no, `unknown` an answer the box doesn't know. No route reads it yet (bridge 0.9.210).

A phone should ignore a category it doesn't know, and show the notification plainly.

What's news, each box decides alike (`notices/news.ts`), for your phones and its clients
(`kuvo/notices`):

- **A reply to you** is: a run that ends after your own message (or your answer, approval or
  pick, which the box passes on), and, in a conversation of yours (not a bot's, nor one an agent
  started), one after what it left running or started coming back (a command, a subagent, its
  sessions' news). Read from the session's latest turn, back to its start however long it is:
  any word of yours in it makes it yours. One whose start can't be reached counts as yours only in
  a conversation of yours.
- **A question, a permission or a failure** always is; a failure with its reason on one line
  ("Stopped with an error: …").
- **What an agent sends on purpose** (`notify_user`, "Agents' tools") always is.
- **Nothing else**: not a run of the session's own accord (its wake-up or watch, `[Wake-up]` or
  `metadata.kuvo.wake`; a goal's word to its bot), nor one answering another agent (a letter,
  `[Message from …]`, as a session an agent started gets its task). Those still leave the
  conversation unread, as a muted chat does.

The body is one sentence: a reply's first (past headings, code and lists; a line that leads into
a list with its first item), its Markdown taken off, cut at a word to 160 characters; a question's
own words; a group chat's last word the same way.

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
  go if it isn't asked any more; so is a session's permission when its run ends (the engine lets
  what a stopped run asked go without a word). A box keeps what it holds in `run/held-notices.json` (with when
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

### kuvo/notices

What a box told lately, for clients to show as their own notifications, so what's news and how
it's said is the box's alone (a client shows the asks it has cards for, permissions, questions and
a browser's, itself).

- **`GET kuvo/notices`** → `{"telling": bool, "notices": [{"id", "at", "notice", "by"?}, …]}`: each
  notice the box made in the last ten minutes, oldest first, as `Notice` (above, before it's masked
  and cut), `at` in ms since 1970, `by: "agent"` for one an agent sent (`notify_user`). `telling`:
  whether the box tells its news now (this Mac's box always; a machine's while a bridge that does
  runs, as it marks in `run/notices/teller` with its pid; one from before doesn't).
  405 for another method.
- **`GET kuvo/notices/events`**: the same, a line now and one each time it changes (NDJSON).
- **A client** shows each notice of the categories that are news (`finished`, `failed`, `report`,
  `message`) once, by its `id`, and none of what was listed the first time it read a box (news from
  before it was there). Where a box says `telling: false`, or answers 404 (one from before), the
  client words its own as it did before. The Mac does so, each notification counted as shown
  (`kuvo/attention`); a phone needn't, as each box pushes it its notices.
- The box keeps them in `run/notices/told.json`: the news ten minutes, what agents sent a day.

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
| `{"t": "ping"}`, `{"t": "pong"}` | Is the other end still there? The relay's own pings only reach the relay. The phone pings while a request waits with nothing from the host, once its own frames have gone out: a host whose connection died without closing takes frames until the relay notices, and never answers. No answer ends the session, after 15 s (a host under a heavy load can take that long to read its connection, and is still there) and a second more for each 64 KB the phone sent that no host has answered yet (by answering a request sent after it, or a ping): frames the phone's connection says it sent may still be in the system's buffers, on a slow network or at the relay, ahead of the ping. So a host whose connection died is found out that much later after a big body (a 10 MB one: about 2.5 minutes). A host that started again or left is told by the relay (`gone`), so a quiet session isn't checked. Answer at once. |

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
  **An agent's work is read for you** (READ_RULE, `work/tree.ts`): a session another conversation
  started and leads (`metadata.kuvo.startedBy`, not a subagent's, and its starter hears when it
  finishes: a bot's work, `kuvo.by`, or `kuvo.wake` naming `finished`) is that conversation's work.
  So as each of its turns ends, its box reads it (`POST …/view`, as above), unless what ended since
  it was last read holds news for you, as its notifications are: a turn that answers you
  (NOTIFY_RULE: you wrote in it, or answered what it asked you), a turn that failed, or a
  `notify_user` its agent sent; and never while it asks you something (a permission or a question,
  its subagents' too), which still waits on you. As the box finds its engine or coding agents'
  bridge, it does the same for those left unread meanwhile. No client decides it: each follows
  `session.viewed`, so such a session shows nothing new on any client (its row, its project, its
  computer) unless it has news for you, and its lead's row is where its work shows.
  **Mark All as Read** is the box's too: `POST kuvo/sessions/read` reads every conversation on the
  box left unread (on the engine and the coding agents' bridge, subagents' too, archived ones
  left as they are) up to where each ended, as `POST …/view` does one, and every group chat with
  something new up to now; it answers `{"read"}`, how many. Each client hears of each as above
  (`session.viewed`, `kuvo/groups/events`). What waits on your answer isn't read away: an ask
  still waits on you. A client that marks all read on every computer (the phone's Inbox) asks
  each box once.
- **A message while a command runs**: yours is read at once. A message sent to steer
  (`delivery: "steer"`) waits for the agent's next step, and an agent waiting on a command or a
  subagent it started in the foreground takes none until that ends. So for your own message, each
  box, following its engine, moves what the agent waits on to the background once it has run for
  3 seconds (`POST api/session/<id>/background`, the engine's Ctrl+B), and again every 3 seconds
  while the message still waits behind it: the agent reads the message now, and is told when the
  command ends (bridge 0.9.67). Yours: a `user` item whose text doesn't open as the box's own do
  (`[Message from `, `[Work from `, `[Session `, `[Wake-up]`…) and that carries no `kuvo.note`,
  as the queue tells them (`writtenByYou`). Another agent's letter (`send_message`, the task of a
  session an agent started) and the box's news and notes (a session that asks or finished, what
  you approved that Auto's reviewer held back) never move it, sent now from the queue either:
  they're read as the command ends, as any message sent to steer is, so a lead's word doesn't cut
  short the tests its session waits on. (Boxes before #431 moved it for those too.) A message
  queued for after the turn, a wake-up (queued too) or the engine's own notes wait as before. The
  coding agents' sessions don't do this.
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
  `features`; after bridge 0.9.211, `bridge` is a hash of the link as built, which changes with
  every change, rather than a number), `features` (below), whether its coding agents' bridge is up (`agents`), and
  `started`, when the engine running now came up, in seconds since 1970 (null while none runs): a
  restart changes it, so a phone tells the new engine from the old. Both name the folder of chats
  (`chats`: conversations of no project, made if it isn't there yet, so a phone can start the first
  one there through the engine, as for a project; new chats' sessions are marked chats, "Chats"). A machine's bridge also says whether its engine
  is `running`, and whether it's `stopped` on purpose (it stays down until it's started, from a Mac
  or a phone), and `home`, the Mac that started its engine (`{"mac", "name"?}`, its name where
  its start noted one). It also says who uses it, for an uninstall to name whom it would stop it
  for: `macs`, the Macs that set it up (`[{key, name?, seen}]`: each one's key, its name where its
  setup gave one, `macName`, and when it was last heard from, in ms, moved on by the time the
  machine was off since), and `phones`, how many phones
  reach it. A machine's also says which version each of its pieces runs (`pieces`: "Updates", "A
  new version while it works"). A Mac also names `integrations`, each integration's name by its MCP
  server's (`{"microsoft-365": "Outlook and Microsoft 365", …}`), for a card when one asks something.
  A Mac's is its box's (from #191 step 2; its app answered it before), the same with the app closed:
  its `name` and `app` as the app last said them (kept, "The relay, on this Mac's box"), its
  `engine` the version running, or the one the app brings while none runs, its integrations from
  the catalog the app leaves it (`bin/integrations.json`), and its `features` the box's own list.
- `kuvo/agents/api/…`: the coding agents you already have (Claude Code, Codex, Cursor, Grok,
  Antigravity), through the agents bridge beside the host's engine, which answers the same paths
  as the engine for them: sessions, messages, prompts, permissions, questions, events
  (`kuvo/agents/api/event`) and models (`kuvo/agents/api/model`, only signed-in agents'; with
  `?hidden=1`, also those an agent still runs but keeps out of its own picker, Codex's hidden ones,
  each `hidden: true`, which pickers don't offer). Its
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
    "Sign-in ended") and offer to sign in again. `metadata.unchecked` true: the agent couldn't
    say just now whether it's signed in (its check failed or took too long, on a busy computer);
    the account and its models are as it last said, and its connection's message says so when
    nothing was known yet. Only the agent's own word that it's signed out is a sign-out.
  - Installing and updating an agent's program (Claude Code, Codex, Grok), on the computer the
    bridge is on: `metadata.installed` false, with `metadata.install` the maker's installer
    command; `POST kuvo/agents/api/integration/<provider>/install` runs it (a few minutes at most)
    → `{data: {installed, version?, message?}}` (`message`: why not, in the installer's words).
    `metadata.outdated` with `version` and `latestVersion`, and `metadata.updates` true when the
    installer that owns it can update it (`updateCommand`, as typed). The box keeps each program's
    update, the same on every account with it (one program serves them all), for every client:
    `metadata.programUpdate` is `{state: "updating", at}`, `{state: "updated" | "current",
    version, at}` (updated to it, or already the newest when asked) or `{state: "failed",
    message, version?, at}` (why, in the installer's words), none otherwise; `at` (ms) tells one
    outcome from the next. What an update brought is kept an hour, why one failed until it's
    seen; either goes with the next update, once the version moves past it (updated in a
    terminal), or once a client says it was seen: `DELETE …/kuvo/updates/<provider>?at=<at>`
    (that outcome only; for every client). `metadata.updateAll` true, on the agent's own
    sign-in only (once a program): Update All updates it (behind, its installer can update it,
    not updating). `POST kuvo/agents/api/kuvo/updates` is Update All, each program the box
    picks, once; `POST …/kuvo/updates/<provider>` updates that account's program; both answer as
    they start, `{data: {updating: [<agent>]}}` (`metadata.agent`), with `integration.updated`
    for each account with the program as it starts and as it ends (and `model.updated` once it
    updated). A client draws them, says an outcome once and then that it was seen. Update All on
    the phone asks each computer. (An older client's `POST …/integration/<provider>/update` runs
    the same update and answers once it's done, `{data: {updated, version?, message?}}`; a box
    from before these has no `updateAll`, and a client asks it that way.) Installing done,
    `integration.updated` and `model.updated` follow, and how an update went before is gone.
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
    for a model's; `until` in ms; each entry names its model by the model's own id, so one saved
    under another id it's known by, such as Claude Code's `default`, comes as the model that
    stands for now, as its agent listed it (as saved until it has), and a second entry for the
    same model at the same effort is left out; a list `PUT` back as it came keeps each entry under
    the id it was saved by, so one saved as `default` goes on following it, and runs go down the
    lists as `GET` gives them);
    `DELETE …/auto/limits` tries them all again. The event
    `kuvo.auto.updated` says the lists or their limits changed. An account with a `provider`
    limit whose `until` hasn't come is at its usage limit: mark it (the Mac says "Usage limit ·
    Resets in …").
  - A session with the agents may switch to any model (`…/session/<id>/model`), the engine's
    too: it runs those through an engine session of its own, which carries
    `metadata.kuvo.engineFor` and is never shown (hide it in the engine's session list).
    `…/session/<id>/fork {before}` makes a new session from a message.
  - `POST …/session/<id>/compact` summarizes a conversation, on the engine as on the agents (the
    command `/compact`, and a lead's `compact_session`). On the agents: `{"data": {"state":
    "compacting"}}`, or `"waiting"` while a turn runs (held to its end, first in the queue, as an
    inbox item of type `compaction`, and dropped with a notice if the turn doesn't succeed; asked
    twice is once). On the engine it waits for the next step; Stop and a failed run take it from the
    inbox, and it's never held or paused for. 400 `{"message"}` is a sentence to show: nothing to summarize yet, a subagent's,
    an agent that can't be asked (Cursor, Antigravity), or on the agents an undo staged. On the
    engine an undo staged is made final by it, as by a message. It shows as the engine's own does, a
    `compaction` message with `reason: "manual"` and `session.compaction.started`, `.ended` or
    `.failed`, then `idle`. It adds no reply, and what's there stays. Its `status` says how it went:
    the engine's `idle` and run end say `succeeded` even for one that failed.
    Only one that ran at rest is a turn of its own (an `idle` before it, `Packages/Box/src/shared/summaries.ts`):
    taken at a step of a run on the engine, the `idle` after it ends that run, told as any run's.
    A turn of its own that went through is no news: it stays read if it was, with no notification and
    no `[Session finished]` to a lead, who still reads how the work before it went. One that failed
    says why, tells a lead `[Session not summarized]` and pauses nothing.
  - A summary the agent makes by itself as the conversation fills up shows the same way with
    `reason: "auto"`, as the engine's own does: a `compaction` message partway through the turn
    (what you send meanwhile comes after it), `running` from `session.compaction.started` until
    `.ended` or `.failed`. Claude Code, Codex and Grok say when one begins; Cursor and Antigravity
    only that one happened, which shows as a finished row. One that's stopped, or whose agent or
    bridge quits, ends `failed`. While the last `compaction` since the last `idle` is `running`, a
    client says the conversation is being summarized, on its row and on the line under it
    ("Summarizing the conversation…", with the time since it began), rather than that it waits for
    the model.
- Plan accounts (Copilot, OpenCode, GitLab, Poe, a provider's API key), on a Mac and a machine,
  as Settings › Accounts has them: the phone sees, reads and signs in to them as the app does.
  Each computer keeps its own: a new
  machine starts with a copy of its Mac's keys and of a sign-in that stays the same (Copilot's),
  once, and from then on what's changed on the machine (its Accounts page, or a phone there) is
  the machine's. A sign-in that renews itself (ChatGPT's, GitLab's) is never copied: each machine
  signs in itself.
  - `GET api/integration` and `GET api/integration/<id>`: each plan, its ways to sign in
    (`methods`) and what it's signed in as (`connections`: label and status). Accounts lists
    them less MCP servers', web search services' and, unless it's signed in already, the engine's
    `claude-agent` (Claude comes through the coding agents): `ClientAccounts`' `EngineProviders`.
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
    `box route` too, says the same; `503 {message}` while its engine can't say which sign-in each
    plan uses, so a client keeps what it last read); `POST kuvo/accounts/<provider>/forget` is Disconnect, as
    Settings › Accounts does it: that box's sign-ins and keys for that plan (`404` for one that
    isn't a plan there, an integration's server among them; from bridge 0.9.150, `502 {message}`
    when the engine wouldn't remove one, which stays, its plan still said to have ended, and `503
    {message}` when the engine can't list them; one already gone, removed meanwhile, is removed). Every box from bridge 0.9.61
    (`accounts.ended`); a Mac before answered them itself.
  - `POST kuvo/accounts/<provider>/refresh` is Refresh Models: the engine's lists of models made
    afresh without a restart, and what providers need from it learned again from them and applied
    ("Settings per box"), at once. opencode reads an account's models (GitHub Copilot's, with the
    models your plan has) as it opens a folder, and again only when the account in use changes, so
    the box closes each folder the engine has open (`DELETE api/debug/location`), which it opens
    afresh as it's next used: at once where nothing's going on, and once its work is done where
    something is (a run, a question or a permission waiting on you, a terminal, a running command),
    which closing would cut: those are kept in `run/models-due.json` for that engine and closed as
    its events say their work ended (a run's end, a terminal's or a command's, a question
    answered). It answers `200 {waiting: [folder]}`, the folders still to get them; the engine's
    own folder, whose list the model pickers read, is among them only while something goes on
    there, and a client says the rest get them once their work is done. Each folder is looked at
    again just before it's closed, so a run started meanwhile keeps it open. Those left are closed
    as the box follows its engine's events (on a machine, while its bridge runs; otherwise by the
    next refresh, which looks at every open folder). Clients' pickers follow the engine's
    `model.updated`. It helps only the providers whose lists opencode reads from your account as a
    folder opens, and again only when the account in use changes: `GET kuvo/accounts/refreshable`
    → `{providers: [id]}` (GitHub Copilot, GitLab Duo, Modal, DigitalOcean, OpenCode), which a
    client offers it for, on the account in use. The rest come from models.dev's catalog, which
    the engine reads again by itself: `409 {message}` for those. `404 {message}` for one the engine
    doesn't have; `503 {message}` while it can't be asked, or when it has no way to close a folder,
    which only a restart does then. Every box with `accounts.refresh`.
  - `GET kuvo/accounts/found` → `{agents, opencode, shell, connected}`: what the computer already has, for
    the first launch's Bring your subscriptions. `agents`: the coding agents' programs (`{id, name,
    installed, signedIn, label?}`, `label` who it's signed in as). `opencode`: an opencode used
    apart from Kuvo Code (its `auth.json`), each `{id, integrationID, name, kind, connected}`: a
    `key` can come over, a `signIn` is done again here (both apps renewing one refresh token would
    sign each other out), and `connected` says the engine has a working one for it already (a key in the shell aside). `shell`: keys in
    the shell the engine uses (`{integrationID, name, variable}`). `connected` (from bridge 0.9.91):
    the engine's providers signed in and working, by integration (an expired sign-in or a key in the
    shell aside). `unread` (from bridge 0.9.150): the parts whose server isn't running or
    didn't answer just now, `engine` and `agents`; theirs are empty for now, not signed out, so a
    client keeps what it last read of them. Names
    only, never a key. `POST
    kuvo/accounts/found/use {id}` copies an opencode key in as the plan's sign-in in use (`200 {}`;
    `404` for one that isn't there, `409` for a sign-in, `503` with the engine down, `502` when it
    refused; each with `message`). Every box from bridge 0.9.79 (`accounts.found`).
  What a phone may ask an engine for is the same on both (`Vectors/link.json`, `routes`).
- On a Mac (and on a member of a setup, from its document: "Your setup"), `kuvo/hosts`: the machines this phone may reach directly, with their addresses
  and static keys, so pairing once with the Mac reaches them all; each with `machine`, its id
  (as a bot's `machine`), and `anotherMac`: its engine is another Mac's, which gives it its
  settings, so this Mac's (`kuvo/config`) don't reach it (as it was when it last connected).
  `removed`: this Mac removed it (it runs on there), and `DELETE kuvo/hosts/<id>` forgets it for
  your phones (`200 {}`; `404` for none; `409 {"message"}` for one this Mac still has). With the app
  closed the box answers it from what the app keeps (`phone-link.json`, `machines.json`), and `DELETE`
  answers `503` as Machines' changes do. A phone takes this list for all your machines and forgets
  the rest, so where those can't be told, the box answers `503 {"message"}` rather than a short list.
- `POST kuvo/sessions/<id>/agents` with `{"model": {providerID, id, variant?}}`: a
  conversation this box's engine runs carried on with its coding agents on that model (one of
  theirs, or Custom Auto's `auto`), as picking it in the conversation does: a session of theirs
  with the whole conversation (without what an undo not yet kept took back) and what was waiting;
  the engine's goes to Archived, and a bot's conversation becomes the new one. Every box answers it
  for its own conversations, a Mac's with its app closed too, and every client asks the box the
  conversation lives on (the Mac's model picker as a phone's; a client carries the draft itself).
  `200 {"session"}`, the new one, to open (read through `kuvo/agents/api/…`). Errors are
  `{"message"}`: 400 for a model that isn't theirs; 404 for no such conversation; 409 for one
  with them already, or while it moves; 422 for a model it can't use where it is (not installed, or
  signed out: the box checks its bridge's integration, `metadata.installed` and `connections`);
  503 while the engine or the coding agents aren't running there; 502 when the move failed. Nothing
  opens on the Mac. The session's wake-ups and watches go with it, the engine's is marked
  `kuvo.carriedTo` (the new one's id) as it's archived, the new one `kuvo.carriedFrom` (the old
  one's id, under `kuvo` in its metadata) and its approval and Autopilot, and it's told its
  worktree (`kuvo.worktree`) and its project's other folders (`kuvo.project-folders`; one in a
  worktree too). One carry at a time for each conversation, whichever of the box's processes runs
  it (a phone's in the long-running one, a client's `box route` in its own): a mark in
  `run/carrying/<id>` holds it, and another answers 409 meanwhile. It's all or nothing (bridge
  0.9.209): once started it goes to its end, whatever becomes of the request, and until the
  engine's is marked (a bot's, its record names the new one) anything that fails deletes the new
  one again (and any the bridge made from it without saying so: its sessions marked `carriedFrom`
  this one, made since), and a run it stopped goes on as before (its queue resumed, unless it was
  paused already), so the conversation stays as it was, with what waited, and can be tried again;
  a failed move never leaves a copy. Only when the engine stops answering as it's marked, so
  whether it took it can't be told, the new one stays, and the 502 says to look before trying
  again. A client with it open follows `kuvo.carriedTo` as it's archived, whoever moved it: the
  new one takes its place there, with its draft. A session archived so takes its queue on the box
  with it, once (paused, stopped by you, it stays so in the new one, with what waited on the box). One brought back keeps the mark and its own queue, archived again too (the
  box keeps the carries it made in `run/queues-carried.json`). Changing a bot's model to one of the
  agents' (`PATCH kuvo/bots/<id>`) carries its conversation on with them the same way; a Mac takes
  in a machine's bot's new conversation as it next connects.
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
  `default_agent` the one new sessions start in, and the model subagents use under
  `subagent_model` (`provider/model`, a coding agent's account's too; none: the conversation's),
  which the engine doesn't read: the box puts it on the engine's subagents and yours without a
  model of their own, in its own settings file beside yours (see "Settings per box"), as each
  change is made, whenever the settings are read, and as a run starts once the file was changed
  by hand; and the coding agents' bridge gives your
  subagents and that model to each agent with subagents of its own, one it runs (Claude Code's
  `agents` and `CLAUDE_CODE_SUBAGENT_MODEL`, Codex's roles and `agents.default_subagent_model`,
  Cursor's `agents`, a plugin of Grok's with an agent each, Antigravity's custom agents; a model
  of one of that agent's accounts, never its maker's API models in the engine), on a
  Mac from where its box's `KUVO_ENGINE_CONFIG` says, on a machine from `box/opencode.json`;
  Settings › Commands, `commands.<name>`; Settings › MCP Servers, `mcp.servers.<name>`; Settings ›
  Git (`git.words`), which the engine doesn't read either: `branch_prefix` (what a worktree's branch
  starts with; `""` for nothing, none: `kuvo/`), `commit_instructions` and
  `pull_request_instructions` (added to what a model is asked, see `kuvo/git/commit-diff` and
  `kuvo/git/pull-request/draft`). A
  machine's box answers `409 {"message"}` until a Mac has made its settings its own ("Settings
  per box").
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
  - Brought up to date by the box and only the box, from the catalogs it has, with no client
    there: a package's pinned version, Code Mode off unless it says otherwise, keys named where the
    computer reads them, Chrome DevTools on a Mac as it's offered now (a newer version or your options
    stay), and Code Mode off on every other MCP server that doesn't say, but for Kuvo Code's own. A
    package whose maker now runs its own server is replaced by that server, staying off if you turned
    it off and with the Code Mode you chose, its key and bots' own keys for it taken away first.
    That one waits where a key can't be taken away now (this Mac's app not answering), and while an
    update is on trial, as a key can't come back with the version before: the box does it once the
    update is confirmed, or at its next start.
  - When: a machine's before each start of its engine (`engine-config`, from its start script), as a
    Mac connects (`box adopt`, after the Mac puts its catalogs there), as its bridge starts, and as an
    update's confirmed. This Mac's as its box starts, before it says where it is, so before its engine
    starts; a key to take away comes after that, and the engine takes the change as it runs. There's
    no write once they're up to date.
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
  answer these). The app reaches them over SSH, so how a connection stands and what's done with one
  are the open app's to say, and it answers these as long as it's there:
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
  - The list isn't only the app's: it's `machines.json` in this Mac's box's folder, which the app
    alone writes and the box only reads (bridge 0.9.201). With the app closed, stuck (no answer
    within seconds) or answering anything else, the box answers from it, so a phone needs nothing
    different:
    - `GET kuvo/machines` lists them with `connection` `notConnected`, no `action`, no `failure`, and
      `hosts` empty. `status` says what the box can tell by itself, and that the app isn't open:
      "Running · Kuvo Code isn’t open on Studio" for a machine whose box was heard from in the last
      half hour by this Mac's clock (its agents' mail, "Peers", every ten minutes), "Not heard from
      lately · …" for one that wasn't, and only "Kuvo Code isn’t open on Studio" for one this box
      doesn't meet (another Mac's). `503 {"message"}` when the list can't be told, which isn't none:
      it's there and won't read, or it isn't there while the app keeps bridges for machines (it
      couldn't be written, and stays in the app's settings). Removing the last one leaves `[]`.
    - `GET kuvo/machines/events` is one stream over both: the app's lines while it's there, the box's
      while it isn't, looking for the app again every ten seconds. It ends if the list stops reading,
      and the next try answers `503`, as a read does.
    - Anything else (adding one, its button, removing or uninstalling it, its addresses, same-as,
      Make This Mac Its Home) answers `503 {"message": "Kuvo Code isn’t open on Studio. Open it there,
      then try again."}` as soon as the box hears the app isn't open. An app that's open and stuck
      isn't answered for here, as a change can't be said not to have happened: it waits for the app,
      or for the phone to stop waiting.
- Settings › Worktrees: the git worktrees sessions run in, each box its own, kept and named by its
  box (a Mac's by its own box from bridge 0.9.35; before, by the app), with the Mac closed too.
  A Mac's app reaches every box's the same way, its own included, and follows its own as they
  change. Each box names a worktree's branch after its session once that has a title (in Latin
  letters: "Исправить вход" is `ispravit-vhod`), as it hears of the title (one a session was made
  with too), as a machine's follows its engine again (a title given meanwhile; a Mac's own box,
  as its app reads them), and when its records are read, and tells every session working there.
  A branch a remote has (pushed, tracked or not) keeps its name.
  - `GET kuvo/worktrees` → `{"worktrees": [{path, folder, project, projectName, branch, base?,
    sessions, working, uncommitted?, ahead?, size?}]}`: `path` is the worktree's folder, `folder`
    where its session runs (the project's place in its repository), `project` its project's,
    `sessions` how many run there and `working` whether an agent is at work in one, as its engine
    says. What git says, left out when it can't say (a folder deleted by hand): `uncommitted`,
    changes not committed, which go when it's removed; `ahead`, commits `base` doesn't have, whose
    branch stays when it's removed. `size` in bytes. Where new ones go is `kuvo/config`'s
    `worktree.directory`. `?records=1` → `{"worktrees": [{project, root, folder, branch, base?,
    made?, prefix?, used?, restored?}], "restorable"?}`, as it keeps them (without asking git), any whose session has a title by
    now named first; `made`, the branch one made there started on, and `prefix`, what its name
    starts with; `used`, a session has run there.
  - `GET kuvo/worktrees/events`: `application/x-ndjson`, `{worktrees}` as `?records=1` has them,
    now and again each time they change (`worktrees.events` in `features`: a box that has it keeps and names its worktrees itself, a Mac's included).
  - `POST kuvo/worktrees/remove {"path", "discard"?}` removes it as Remove… does: its folder and
    anything in it not committed (`"discard": false`: one with changes stays, `409`); its branch
    stays unless it's merged (`"forget": true`: it goes anyway, for one made for a session that
    never started; `409` when a session has it after all). `200 {}`; `409 {"message"}` while an
    agent works there; `502 {"message"}` when the engine couldn't remove it; `404 {"message"}` for
    one it doesn't have (removed already): a client takes it as gone.
  - A worktree goes with its last session, as in Codex (bridge 0.9.176; a box from before
    keeps every worktree until Remove…, and has no `restorable`): once a session has run in it, the box
    removes it when every session there is archived or deleted and no agent works there (as it
    hears of each, and as it follows its engine again). It counts every session of its engine and
    the coding agents' bridge, and tidies nothing while the bridge is down. Archived sessions left:
    what isn't committed (ignored files aside) is saved first, as a commit under
    `refs/kuvo/worktrees/<folder name>-<commit>`, and its branch stays. None left: it goes as
    Remove… does.
    Its lists and the events carry `restorable`: `[{project, root, folder, branch, base?,
    restorable, saved, ahead?}]`, one for each removed this way whose sessions are archived;
    `saved` whether changes were saved, `restorable` whether it can come back (its branch, its
    saved changes or the commit it was at are still there). An entry and its saved changes go once
    no session is left there. A client shows one on an open (unarchived) session working in
    `folder`.
  - `POST kuvo/worktrees/restore {"folder"}` (bridge 0.9.176) brings one back where it was, on its branch (made
    again from where it was if it's gone), with its saved changes as changes not committed, and
    tells each session there → `200 {project, root, folder, branch, base?}`, kept again (marked
    `restored`: git made it, so git removes it), and not removed again until a session there is
    open;
    `404 {"message"}` for one it can't bring back any more; `409 {"message"}` when its project or
    its branch is gone, something else is in its folder, its branch is open in another folder,
    or its saved changes clash with newer work on its branch (it stays removed, nothing left half
    made).
  - For a new session's worktree, as the composer's Worktree makes one: `POST kuvo/worktrees
    {"project"}` makes one of the project's repository on a branch of its own, named with the
    computer's branch prefix (Settings › Git, `branch_prefix` in `kuvo/config`, as git takes it in a
    name; none set: `kuvo/`) →
    `{project, root, folder, branch, base?, made, prefix}` (an older Mac sends its own, "For
    released Macs"); make the session in `folder`. `400`
    for a project that isn't a folder there, `409 {"message"}` when it isn't in a git repository,
    `503` while the engine isn't running. A repository with no commits yet gets an empty first one
    (bridge 0.9.198; what's staged stays staged), as a project the box makes does. `POST kuvo/worktrees/record {project, root, folder?,
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
  - `POST kuvo/git/changes/count {"directory", "scope"?, "base"?}` (`git.changes.count`, bridge
    0.9.211): how much `kuvo/git/changes` would show, without the diff, for a count (the phone's
    ••• says how many files changed) → `{"repository": false}`, or `{"repository": true, root,
    against, files, additions, deletions, untracked, uncommitted}`. `root`, `against` and
    `uncommitted` as `kuvo/git/changes` has them; `files`, each changed file once, as a client
    lists them from `patch` and `untracked` (a rename by its new path, a file that changed kind or
    a conflicted one as one, but no conflicted one in `staged`, as `patch` names it only); `untracked`, how many of them are new files git doesn't know (none
    for `staged`); `additions` and `deletions`, git's count of lines in the files it knows (a
    binary file has none; new files aren't read). `500 {"message"}` when git couldn't say. A box without
    it (no `git.changes.count`): read `kuvo/git/changes` and count.
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
    tracked) → `200 {}`, or `422 {"message"}` with git's words. A push that didn't go through
    after the commit landed says so too, `422 {"message", "committed": true, "pushed": false}`
    (bridge 0.9.143): a client offers Push then, never the commit again. `author`: `GIT_AUTHOR_NAME`, `…_EMAIL`, `GIT_COMMITTER_NAME`,
    `…_EMAIL` from your shell, the only settings taken along. `POST kuvo/git/commit-diff
    {"directory", "prompt"?}` → `{"diff", "staged", "prompt"?}`: what a commit would take, cut short, for writing its
    message; with `"prompt": true` (`git.words`), what a model is asked to write it from, in the
    box's words with your instructions on that computer (Settings › Git, below), the same for every
    client, which sends it to a model as it is.
  - `POST kuvo/git/push {"directory"}` (`git.push`, bridge 0.9.143) pushes what the folder has
    checked out (a new branch pushed and tracked) → `200 {}`, or `422 {"message"}` with git's words.
  - `POST kuvo/git/merge {"directory", "into", "author"?}` (`git.merge`, bridge 0.9.143): Merge
    into…, what's committed on a worktree's branch (`directory`, a folder in one of the box's
    worktrees) merged into `into` (its `base` in `kuvo/worktrees`), in the project's folder, which
    must have `into` checked out → `200 {}`. `author` as for a commit, for a merge commit. `409
    {"message"}` when it can't go: not a worktree's folder, the project's folder on another branch
    or in the middle of a merge of yours (left as it is), changes not committed, or nothing `into`
    doesn't have; and for a merge that would conflict, `409 {"message", "conflicts": [path]}`, the
    merge taken back and nothing merged. `422 {"message"}` with git's words when it stopped for
    another reason (taken back too).
  - `POST kuvo/git/pull-request {"directory", "title"?, "body"?, "session"?}` (`git.pull-request`, bridge
    0.9.143): Create Pull Request. With `session`, the session it's made from (the one in view),
    the pull request it makes is that session's ("A session at a glance"). Its base is the worktree's, from the box's worktrees, else
    origin's main branch, else `main` or `master`. `409 {"message"}` from the base itself, with changes not committed, or
    with nothing the base doesn't have. The branch is pushed to `origin` (and tracked); on GitHub,
    made a pull request on origin's repository with GitHub's `gh` when it's there and signed in →
    `{"url"}` (also for one already open for the branch); otherwise → `{"compareURL"}`, the GitHub
    or GitLab page that opens one, with the title and description filled in; `{}` for another
    host (pushed, to open one there). Without a title, `gh` takes the title and description from
    the commits. `422 {"message"}` for a push that didn't go through.
  - `POST kuvo/git/pull-request/draft {"directory", "summary"?, "prompt"?}` (`git.pull-request.draft`, bridge
    0.9.179): Create Pull
    Request's confirmation, which a client shows before it creates one; nothing is pushed →
    `{"branch", "base"?, "title", "body", "summary"?, "prompt"?, "host", "creates", "gh"?}`. `base` as
    Create's (the worktree's, else origin's main branch, else `main` or `master`); `title` and
    `body` from the commits (one commit's own subject and body, else the branch's name and the
    commits listed), for the client to show and change; `summary` with `"summary": true`, the
    commits, files and diff cut short, for a model to write them from; `prompt` with `"prompt": true`
    (`git.words`), what a model is asked to write them from (the summary in the box's words, with
    your instructions on that computer), its first line the title and the rest the description. `host`: `github`, `gitlab`
    or `other`. `creates` true: Create makes it on the box with `gh`, there and signed in. Else
    Create opens the host's page (`compareURL`), and on GitHub `gh` says why: `signed-out` or
    `missing`, for the client to say so; on another host Create only pushes. `409 {"message"}` as
    Create would refuse.
  - Branch backups (`git.backups`, bridge 0.9.182). As each agent's run starts and ends (the
    engine's and the coding agents', in any approval), the box keeps the branches and stashes of
    the repository the conversation works in, where something changed since the last time: what
    each branch pointed at, the branch checked out, each worktree's checkout on no branch, the
    stashes (older ones too) and the remotes' addresses (without a sign-in in them), with their
    commits in a store of its own (`box/branch-backups`), so a hard reset, a deleted branch, a
    dropped stash or `rm -rf .git` can be taken back. Tags and other refs aren't kept. The newest
    100 are kept, none older than 30 days but the newest. No setting of the repository's runs a
    program as it's taken or taken back, and taking one back never goes through git's transports.
    `GET kuvo/git/backups?folder=<folder>` → `{"repository", "exists", "backups": [{id, at, head,
    branches, stashes, gone, moved, stashesGone}]}`, newest first: `repository`, the repository's
    top folder (a linked worktree's are its repository's; null where none was backed up), found
    from a folder above too once its `.git` is gone (`exists` false); `head`, the branch checked
    out then ("" for none); `gone` and `moved`, its branches deleted since and those elsewhere now;
    `stashesGone`, its stashes no longer on the list. `POST kuvo/git/backups/restore {"folder",
    "id"}` takes one back, never moving a branch you have: one gone comes back under its name, one
    elsewhere beside it as `<branch>-restored-<yyyymmdd-hhmm>` (the backup's time, UTC; `-2`
    and on where that's taken, or a branch of yours would clash with it, as `feature` with
    `feature/x`), a checkout on no branch as `detached-restored-…`, and stashes no longer there
    on top of the list, in their order; a repository whose `.git` is gone is made again in its
    top folder (as SHA-256 or shallow as it was), around the files as they are (none changed: the
    index from the branch checked out then), with its remotes → `{"remade", "branches": [{name,
    as}], "stashes", "missed"?}` (`name` "" for a checkout on no branch; `missed`, what didn't
    come back, in words). The branches come back all together or not at all. `400` without a
    folder that's there or an `id`, `404` for none here, `409` for a `.git` that can't be read,
    `500 {"message"}` with git's words (a repository made again is taken away again then).
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
- On a Mac, `kuvo/mac`: Settings › General's While Agents Work. `GET` → `{backgroundWork,
  backgroundWorkFailure?, keepsAwake, awakeNow, openAtLogin}`. `backgroundWork` is as Settings
  shows it: `on`, `notRunning` (on, but its keeper didn't start this time, so the work stops when
  Kuvo Code quits), `needsApproval` (waiting for your OK in Login Items & Extensions on the Mac) or
  `off` (also a demo or test copy, which runs its work itself); `backgroundWorkFailure`, why macOS
  didn't allow it, when it said. `keepsAwake`: whether it keeps the Mac awake while agents work;
  `awakeNow`: whether it's doing so now. `openAtLogin` is for phones from before background work,
  which replaced it: true while background work is on. `PATCH` with any of `backgroundWork`,
  `keepsAwake` or `openAtLogin` answers the same. `backgroundWork: true` turns it on as Settings'
  Turn On does: on, or `needsApproval` when macOS waits for your OK in Login Items (the answer
  says which); `409 {"message"}` when macOS didn't allow it (or a demo or test copy, which never
  registers), and then nothing changed. `false` answers `400 {"message"}` while it's registered:
  it's turned off in Login Items & Extensions, on the Mac. `openAtLogin` means the same as
  `backgroundWork` (it never adds Open at Login's own login item again, so the two don't both open
  Kuvo Code); `false` also takes away that item, if it's still there.
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
  name, machine}]}`. `startingModel` has one key: `mac` on a Mac, the machine's name on a machine;
  it's the model the box's Mac named (picked last there) while the box can use it (its account
  signed in there, and not one being retired), else the engine's default, else the first it can.
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
  your time zone, its projects, the model a new bot starts on, and the personalities you made,
  until the box's library has them), or else the machine's own; this Mac's from its app, as its
  box starts and as your personalities change. Without its
  words, or on a Mac without its kit, New Bot and changes to a bot there answer `409 {"message"}`.
  A new bot's rules are the box's own: its default approval ("Approval") and Settings › Permissions
  (an older Mac's kit has `rules` from its own last pick, which aren't read). The model a new bot
  starts on comes from a Mac for now; it's to become each box's own setting.
- What every group chat on a computer goes by is its box's own, worked out with no client there:
  what each personality tells a bot (Kuvo Code's own in its words, yours in its library), who sets
  what about a bot (the words' `identityNote`), Ask First (its default approval is Ask First or
  Accept Edits: a seat fetches no pages) and what its Settings › Permissions hold back. Its link
  gives them to the coding agents' bridge that runs the chats (`PUT api/kuvo/groups/box-settings`
  there), as it starts and within five seconds of any of them changing, never while its Settings ›
  Permissions can't be read or have a rule that isn't one (its chats keep what they have); the bridge keeps them through its
  restarts. Your clock (time zone, and how you write dates, for meetings and a chat's recap) is a
  client's to say, as a machine can't know it: `PUT api/kuvo/groups/clock {"timeZone", "locale"}`
  on the bridge (a Mac to each computer's it reaches, as it connects and as either changes);
  without one, the computer's own. Each has a path of its own, which a bridge from before turns
  away (`404`) rather than taking it for all of them. An older Mac sends all of them to `PUT
  api/kuvo/groups/settings`: only its clock is taken.
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
- A message a keyword sends (/plan's words, /loop's when it sends now, a bot's /goal) carries the
  keyword as typed, right after its words and before every other block: a line `<sent-with>`, a
  heading in `SentWithKeyword.swift`, the keyword on one line (`/plan`, `/loop every hour`,
  `/goal`), and a line `</sent-with>`. The client sending it writes it (the box, for a bot's
  /goal). Show the keyword in front of the message's words, drawn as the composer draws it (its
  mark for the "/", the rest in bold, in the accent; Plan's in orange). Taken back (Undo, a failed
  send, editing a queued one), it's the words alone, so sending them again sets no second loop.
- A message the box writes to an agent in its conversation (a goal starting, changed, at its
  end, declined or carrying on after a limit reset; its sessions' news to the bot that started
  them; your answer told late) is a user message to the engine, marked in its `metadata`:
  `{"kuvo": {"note": {"from": "Goal" | "Its sessions" | "Your answer", "line": "Goal started"}}}`
  (bridge 0.9.143), on the message and on its inbox item while it waits, in the engine's and the
  coding agents' bridge's conversations alike (a prompt's `metadata` is kept with it). Its text is for the
  agent: show `line` in its place, as a line of what happened, never as your bubble, and leave it
  out of Find, a copy, an export, search and the ↑ history. Those a box sent before it marked
  them open with `[Goal started] The user approved the plan.`, `[Not now] The user didn't start
  this goal.`, `[Goal changed] The user changed the goal's limits.`, `[Goal's end] The end the
  user set has come.`, `[Goal] Nothing of the goal is at work now.`, `[Limit reset] <why> has
  reset. Carry on`, `[Session finished|still working|failed|asks] "<title>"` and `[The user answered] `: read
  them the same way
  (`BoxNote` in KuvoClient's ClientSessions does both). A transcript shows no pill for any of them
  (the user, 11-10). Its sessions' news (`from` `Its sessions`) shows as a message from each
  session, in the design of a message from another agent, opening it: its text has one part per
  session, a blank line between them, each opening `[Session <kind>] "<title>" <place> (address
  <session>)`, then for `finished` `, after <time>:` and its reply on the lines after (`(It ended
  without a reply.)` for none); for `failed`, `stopped: <why>.` or `stopped with an error[: <why>].`
  and words for the lead; for `asks`, `asks to <what> (ask <id>).` or `asks: <question> (ask <id>).`
  and words for the lead; for `stopped`, `was stopped by the user.` and words for the lead (show
  "You stopped it.", with “<title>” stopped by you). Show what it said, never the words for the
  lead. `still working` shows nothing, old ones included. A goal started or resumed is a word in the next reply's footer; the
  rest show nothing. The same goes for the engine's and the bridge's notes (`synthetic`, `system`):
  they're for the model and show nothing, but what changed (the model or its effort, the mode, a
  summary, the project's folders) is said in a word beside the next reply's time (`ReplyChanges`).
  The agents bridge's own notes for the user ("Your PreToolUse hook failed…", "Codex asks for
  verification to go on…", "… Going on with Codex.") carry `metadata.kuvo.notice: true`, and show
  as a quiet line (`Message.Notice.isForYou`); those from before it marked them show nothing. A
  `Your answer` note `You approved: <what>` (what you approved after Auto's reviewer held it back)
  shows as "Allowed by you" on the first step after it that does `<what>` (`WorkAnswer.yours`), and
  nowhere if none does.
- A prompt a phone sends (`POST api/session/<id>/prompt`, and `kuvo/agents/api/…` alike) gets a
  block at the end of its text that tells the agent it's from the phone: a line `<from-phone>`,
  the words in `FromPhone.swift`, and a line `</from-phone>`. Every box adds it, in the same
  words (this Mac's box since bridge 0.9.64; the app did before); send the text without it. Show a
  message without it (everything from a line `<from-phone>` to the line `</from-phone>`), as
  sent from the phone. It tells the agent to keep replies short and to show files with
  `show_file`.
- A message whose request arrived whole (`POST api/session/<id>/prompt`, and
  `kuvo/agents/api/…` alike) goes on to its conversation even if the phone that sent it ends its
  session or cancels meanwhile: its files are kept on the box by then. So one a client counted as
  failed may have arrived: sent again under the same `id` (as the share sheet does), it's taken
  once; under a new one, it's a second message. A command (`…/command`, which has no `id`) still
  stops with the session that sent it.
- An agent shows a file in the conversation with `show_file`, one of Kuvo Code's tools (on the
  Mac and machines, for the engine and the coding agents): a tool call named
  `kuvo-browser_show_file` with input `{"path": "<full path on the computer it runs on>",
  "caption"?}`, which fails when the path isn't a file. Show a completed one in the
  conversation's flow, as `generate_image`'s: a picture (by its extension) large, any other
  file as a row that opens it, its caption under it; get its bytes with `kuvo/file` from the
  computer the session runs on.
- A picture opened from a conversation (yours, or one an agent made, showed or took of a page to
  show you) opens among every picture of the conversation, in order, across its messages
  (KuvoClient's `ConversationPictures`): your messages' files that are pictures and those they
  sent as paths (the note of attached files names them), then each completed `generate_image`,
  `kuvo-browser_show_file` of a picture and `kuvo-browser_browser_screenshot` with `"show": true`,
  in the order of their messages and steps, up to an undo waiting to be kept; a group chat's, its
  bots' messages' steps alike. Not a step's own screenshots, nor pictures in a reply's words. A
  picture in the composer opens after them. Each is known by an id that stays: `<message>#<n>` for
  a message's nth file, `<message>@<path>` for one sent as a path, `<step>-<n>` for a step's nth
  output, `<step>-shown` for a file shown.
- `kuvo/wakes/<session>`: a session's (or chat's) wake-ups and watches, which its
  agent sets with `kuvo-wake`, as the bar over the Mac's composer shows them: `{"wakes": [{id,
  due, note, every}], "watches": [{letters, every, check, note}], "paused"}` (`due` in seconds
  since 1970, `every` like `1d`, left out for one that doesn't repeat; paused while it's archived: archive it as the Mac does,
  `PATCH api/session/<id>` with `{"metadata": {"kuvo.archived": true}}` (`false` brings it back),
  and its wake-ups wait, or come back, when the flag changes (it can go with every change to its
  metadata); a Mac sees to it, and a machine's bridge does with the Mac closed too; a session's
  first wake-up or watch made while it's archived, by a client or by its agent's `kuvo-wake` on any
  box, is held from the start, and any its box finds archived when they're due is held then; a pause of your own stays through both). Archived while it waits on you (a permission or a question, its subagents' too), either way or by the box's Remove Project, its box stops its run (and those subagents'), as a bot's Stop and Archive does: the asks go with it. `POST kuvo/wakes/<session>` with `{"due", "every"?,
  "note"}` adds one, as the bar over the Mac's composer does (`due` at least a minute away;
  `every` 30m, 2h, 1d, 1w or weekdays, at least 5m), with the computer's own clock and weekends;
  `400 {"message"}` for what can't be one, `409` with 50 waiting. `POST
  kuvo/wakes/<session>/pause` with `{"paused": true}` holds them (a pause of your own), `false`
  lets them go (not archiving's hold: they still wait until it's back, bridge 0.9.121); with `{"archived": true}` they're held as archiving holds them (a client that
  archived it on the engine directly says so, and its box stops it if it waits on you; with
  `"stop": false`, only held: a first wake-up made for one archived before), `false` lets go of only that hold. Both answer the
  list as it is then. `POST
  kuvo/wakes/<session>/cancel` with `{"wake": "<id>"}` or `{"watch": "<letters>"}` cancels one;
  `POST kuvo/wakes/<session>/now` with `{"wake": "<id>"}` sends it now (one that repeats still
  comes back at its time). Both answer `200 {}`, `404 {}` when there's no such one, `409
  {"message"}` while its conversation is on its way to another computer, or `503 {"message"}`
  when it couldn't go. Each box answers for its own sessions and bots, a Mac's and a machine's
  alike, with the Mac closed too: ask the box a conversation lives on (one that keeps none answers
  an empty list). A wake-up reaches the conversation as a
  message starting with `[Wake-up] `, its note whole (a watch's: its note, then what its check
  printed). When its agent gave it a summary (the tools' `summary`, `kuvo-wake … --summary`), the
  message carries it in `metadata.kuvo.wake.summary`, one line, and so does one that waits on the
  box (`queue/add` keeps that mark, and only that, from its `metadata`). A client's card shows the
  summary, at most two lines, and opens to the note; without one (one from before, or none given),
  the note's first sentence: its first line, Markdown's `*` and `` ` `` and leading `#`, `>` and
  `-` taken out, up to the first `.`, `!`, `?` or `…` with a space or the line's end after it
  (KuvoClient's `WakeMessage`). `GET kuvo/wakes` lists every session with a wake-up or a
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
  `POST kuvo/asks/<id>` answers one: `{"answer": "signIn", "username", "password", "save"?,
  "agents"?}` (or `"saved": "<account>"`, which the Mac fills in from its vault itself),
  `{"answer": "code", "code"}`, `{"answer": "done"}` or `{"answer": "declined"}`. What's typed
  goes into the page, never to the agent. A sign-in is kept as the Mac's own card keeps it, over
  https only (a site that's `http://…` or a file has `offersToSave` false, and `save` and `agents`
  are left out): `save` keeps what's typed in the vault (a saved account's password typed anew is
  kept too), and `agents: true` is Let agents sign in here on their own, for the account answered
  with (bridge 0.9.143; a client asks for Face ID or Touch ID first when it's a saved account's).
  The answer comes once it's kept: `200 {}`, or `200 {"message"}` when the vault didn't take it
  (the page has the sign-in all the same). A `saved` account that's gone, or whose password can't
  be read, gets `422 {"message"}` and the ask stays, for the password to be typed instead. An ask has `"passkey": true` once its site asked for a passkey
  (then, or in the ten minutes before): the browsers can't use passkeys yet, so a client tells
  you to sign in another way.
- A machine's bridge answers the same three for what's asked in that machine's
  browser, with the Mac closed too: `saved` is empty and `offersToSave` false (saved passwords
  are the Mac's), and a `saved` answer gets `400 {"message"}`. A Mac connected to the machine
  lists the same asks, by the same `id`: the first answer counts, and the ask goes from both.
  The Mac's copy names the machine's box too, `box`: its link address, as `kuvo/hosts` gives it
  (left out while the Mac doesn't know it, and on a box's own list, whose asks are all its own).
  The machine's own list is the one that counts: a client that follows that box shows the
  machine's copy, and leaves out one the Mac lists (a Mac that went to sleep never says it's
  over) that the box, followed now, doesn't. An answer goes where the copy shown came from; when
  that computer can't take it (unreachable, or `503` with Kuvo Code closed on a Mac), it goes to
  the other one listing the same ask: the box a Mac's copy names, unless that box doesn't serve
  `kuvo/asks` (a bridge from before it, whose `404` would read as answered), or a Mac whose list
  has it. A `404` from a box that serves `kuvo/asks` means it's answered or no longer asked.
  The browser keeps them in `~/.kuvo-code/run/browser-asks.json` for the bridge, and waits the
  whole 15 minutes for an answer while the bridge runs, rather than a few for a Mac.
- `kuvo/groups`: the group chats that live on the computer asked, with their bots (face, name, session), who's
  talking, whether one is under way or paused, and the last thing said; `kuvo/groups/events`
  streams that list as it changes, and `kuvo/groups/<id>/events` one chat's latest messages,
  the same way. `POST kuvo/groups/<id>` writes to it (`{"text"}`; 400 `{"message"}` for `/compact`, which a chat of several has no one conversation for); `…/stop`, `…/keep-going`
  and `…/viewed` do what they say; `…/undo` (`{"message"}`) takes a message of yours back and
  answers with what was taken. A wrap-up can carry `tasks`, who does what: each with `id`, `bot`,
  `task`, `state` (`proposed`, `waiting`, `working`, `done` or `failed`), `started`/`finished`,
  and `after` (the bots whose parts come first; it waits for them);
  `…/start` (`{"message"}`, the wrap-up) hands each proposed part to its bot's own conversation.
  One chat's `stopped` lists the bots whose `working` part waits on their own conversation, its
  queue paused (stopped by you, or held after a run that failed; left out for none): show "Waiting: Ada's conversation is stopped" on the part,
  with Resume, which resumes that conversation on the bot's computer (`POST
  kuvo/sessions/<its session>/queue/resume`), and the part goes on.
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
- On a Mac, `kuvo/usage`: the menu bar's usage panel as its Bars view lists it, for what the box
  doesn't state yet (a plan's limits are every box's own, in "Plan limits"). A provider whose
  place the boxes' rows take there says so (`covers`, its service), with its limit lines left out:
  one this Mac's box states rows for (`services`, with an account listed), and Claude, whose bar
  has no limits of its own, wherever any of the Mac's computers states a Claude account. Its
  spend shows under the first of those rows. A client lists these in their order, the box's rows
  in the place of each that `covers`: each provider's name, plan, brand color, mark as a PNG
  to tint, notice, whether it's outdated, and its lines as UsageKit writes them; whether a refresh is under way and when the last one ended;
  `kuvo/usage/events` streams it as it changes, and `POST kuvo/usage/refresh` refreshes it all.
  While the usage panel isn't up, `kuvo/usage` and the refresh answer 404; the stream answers 200
  with an empty line and stays open, saying nothing more until it's up. Lines that JSON can't carry are left out. Times are
  seconds since 1970.

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
- `POST …/goals/<session>/pause` holds it: no other turn starts, and the box, told of it
  (`kuvo.goal.updated`, `pausedBy: "you"`, `note: "You paused it."`; one paused as you stopped a
  turn holds nothing more), stops the turn under way, keeping what was said, and holds the
  conversation as Stop does (its queue paused: what reaches it meanwhile waits on the box); for a
  bot's goal, its sessions at work stop too, and nothing of it goes on, not even at a limit's reset
  (bridge 0.9.143), nor a session one of its sessions starts (`start_session` answers 403; the bot's own
  conversation still starts one in a turn answering what you wrote there, not a letter or a wake-up). The box keeps the hold through a restart and, finding the bridge again, reads
  each goal it holds for: one resumed meanwhile goes on, one taken away leaves its conversation
  paused for Resume. `…/resume` lets it go: the conversation's queue on this box goes on, its last
  turn is checked (however it ended), and it carries on unless that met it; a bot is told to carry
  on from its plan (a box note, "Goal resumed"). Resume on the queue alone lets the conversation
  go but leaves the goal paused. Both `{data: goal}`, 404 when it has none,
  409 for one that's over (set it again instead).
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

### Plan limits

Each box reads the limits of your plans (a 5-hour window, a week, a model's own week, a month's
requests) and credits, for each account it runs that's signed in to Kuvo Code: every coding agent's
accounts (its own sign-in and those you added) and the engine's sign-ins. It reads them with the
sign-in Kuvo Code runs each with, never another login on the computer (your Claude Code in Terminal
on a Mac, whose box runs Claude with a sign-in of its own; the Cursor app's), and never renews one:
the agent or the engine that owns it does. (On a Mac, Codex's and Grok's own sign-ins are the ones
in `~/.codex` and `~/.grok`, as their sessions run with them; on a machine, Kuvo Code's own.) The coding agents' bridge reads them, a machine's with the Mac closed too, and keeps
the last reading in its folder (`limits.json`), through a restart. A client reaches them as
`kuvo/agents/api/kuvo/limits…` (the Mac app at `api/kuvo/limits…` on the bridge itself), while
`kuvo/info` has `agents: true` (503 otherwise), where `features` has `limits`.

- `GET kuvo/agents/api/kuvo/limits` → `{data: {accounts: [account], services, rows: [row]}}`.
  `accounts`: this box's own (one a peer's reading stood for a read of here, with that reading's
  windows, plan and credits where they're newer than its own, for clients from before `rows`);
  `rows`: every account across your computers (below, "Across your computers"), what a client
  lists. `services`: what
  this box reads the limits of (`claude`, `codex`, `grok`, `cursor`, `antigravity`, `copilot`,
  `openrouter`, `zai`, `ollama`, `opencode`), whether or not one is signed in now: a client shows
  those from here, and anything else from where it had them before. An account is listed once it's
  been read (or a turn told of it, or a peer's reading stood for a read here); one with no plan
  limits to read (signed out, an API key) isn't.
  Each `account`:
  - `provider` (`claude-code`, `claude-code@1f2e3d4c` for one you added, the engine's
    `github-copilot`…), `service` (its mark and color, as above), and for a coding agent's,
    `agent` (`claude`…) and `account` (`default` for its own sign-in, else the ID of one you
    added); `label`, what you called one you added ("Work"); `plan`, in its maker's words ("Max
    20x", "Pro"), when known.
  - `identity`: the account at its maker, 16 hex characters, the same from every box signed in to
    it (and from a coding agent's sign-in and the engine's to the same account), so a client
    lists it once. A hash of its maker's own ID for it, never the ID, an email or a secret:
    Claude's account and organization (on Linux as Claude Code keeps them beside its sign-in; on a
    Mac, whose token doesn't say who it's for, as Anthropic says in the signed policy record Claude
    Code fetches with that token and keeps in its settings folder, once it has run with it there),
    ChatGPT's account and workspace member, xAI's user, GitHub's login (from Copilot's
    answer), and an API key for OpenRouter, Z.ai and OpenCode Go. Absent where it isn't known, and
    from a box from before it: list that row as its box's own. Where it changes (signed in
    as another account there), the box drops what it kept of the one before, and the row says so
    (`problem`, `failed`) until the new one is read; Codex is read only through a Codex signed in
    as it is now.
  - `windows`: each `{id, used, resetsAt?, minutes?, model?, name?, amount?, read, source}`. `id` is its
    maker's name for it (`five_hour`, `seven_day`, `seven_day_sonnet`, Codex's `primary`); `used`,
    how much of it is gone, 0 to 1; `minutes`, how long it is (300, 10080) when said; `model`, the
    model it's for ("Sonnet", "Fable"), absent for the whole plan's; `name`, its maker's name for
    what it counts where that's neither ("Premium requests", "Web searches"); `amount`, `{used, limit,
    unit}` (`requests`, `usd`, `credits`) where the limit is a count or an amount; `read`, when
    this was read; `source`, `usage` (read from its maker) or `turn` (what a turn heard on the way,
    Claude Code's and Codex's rate-limit events, which keep a window current between reads). A
    window whose `resetsAt` has passed has started over since: show it as not read yet, not as
    used.
  - `balance` `{left, limit?, unit}`: credits left to spend, where the account has them.
  - `checked`, when its maker last answered (with its limits or a problem; absent for an account
    only its turns tell of); `next`, when it's read again (absent for one that's never read).
  - `problem` `{kind, message, until?}` when the last read didn't work, with `windows` as last
    read (each with its `read`): `rate-limited` (its maker turned the read away; `until`, when it's
    read again), `expired` (its sign-in lapsed or was turned away: its agent renews it the next
    time it runs), `unreadable` (the sign-in can run the agent but not read its plan's limits) or
    `failed`. Show `message` as it is.
- `POST kuvo/agents/api/kuvo/limits/refresh` reads now each account read over a minute ago, as
  often as its maker allows and never inside a hold (nor one a peer read within its time between
  reads), then asks a computer that reads it for each account this box doesn't read itself (one
  only on another computer, or one only its turns tell of here, a Mac's Claude) to do the same for
  it, and
  answers as `GET` with what's read within a couple of seconds; what comes later comes as
  `kuvo.limits.updated`.
- The bridge's events (`kuvo/agents/api/event`) carry `kuvo.limits.updated` `{accounts, rows}`
  each time either changes (a peer's word included).
- **Across your computers** (#210): every box is equal, none is a hub, and each works with any
  other off.
  - **Who**: a box's limits peers are its peers ("Peers") and the boxes they say they know
    (`agents.boxes`, 16 from each peer at most) that it doesn't: so two Macs that share a machine,
    which aren't each other's peers, and each Mac's other machines, share their limits through no
    one. It takes only `limits`
    from those (any other mail from them is dropped, as from anyone else), and they go when no peer
    names them any more. A box two hops away (known only to a box only a peer knows) isn't one.
  - Each box's bridge tells each limits peer what it read of its own accounts, through its link:
    `{"limits": {at, accounts, ask?, refresh?}}`, `accounts` as its `GET` lists them, but its own
    numbers only (each account's hashed `identity`, its windows with when each was read, `checked`,
    `next`, its plan, credits and problem; never a sign-in, a token or an ID), as many as fit in 28
    KB; `at`, the sender's clock. It's sent at once after a read, at most once a minute for what
    turns hear, again every ten minutes though nothing changed (the relay keeps nothing), and at once
    to a peer it hasn't told since its bridge started, or since its link started carrying its mail
    again (what went meanwhile was lost), with `ask: true` (tell me yours). A box answers `ask`,
    and a peer back after being away, with its own (no `ask`), at most once a minute for each peer,
    whatever it told that peer lately.
    A box from before this ignores it, and sends none. A sealed mail that doesn't fit isn't sent.
  - The receiver keeps the last from each peer (`limits-peers.json` in the bridge's folder, through
    a restart), its times moved onto its own clock where the sender's `at` is a minute or more off
    (`resetsAt`, its maker's, as it is), and a `service` it doesn't know (a newer box's) as its name
    (lowercase letters, digits and dashes, 40 at most). A computer you removed goes, with what it
    said.
  - **One read per account**: before asking a maker, a box looks for a peer's reading of the same
    account (`service` and `identity`) that its maker answered without a problem within the
    account's time between reads (15 minutes for Claude's, 10 for the rest). Then it doesn't ask,
    lists the account as its own still (with no numbers of its own, if it never read it), and looks
    again past that peer's next read and two minutes more: a peer that's off, or turned away, is
    taken over then. Computers that read at the same moment settle on one by the next round (the
    one that read last is fresh to the other). Holds and the one-a-minute spacing stay each box's
    own (Anthropic's limit is per computer): a 429 on one holds that one alone, and a reading with a
    problem never stands for a read. An account a box can't say who it is is always read there;
    one whose sign-in doesn't say who it is (GitHub Copilot's: its maker's answer does) counts as
    who it was last read as only while the lasting part of its sign-in (a refresh token or a key,
    not a renewed token) is as it was then: signed in again, what was kept of it goes (`problem`,
    `failed`, as above) and it's read soon.
  - `refresh: [row id]`: a refresh asked of the sender (above) for accounts it doesn't read
    itself; the receiver refreshes those of its own as it would its own refresh.
  - **`rows`**: one row per account across this box and its peers, this box's first, then each
    peer's by name. Rows of one `service` with one `identity` are one row, from any box; a row
    without one is its box's own. Two windows are one limit when they have the same `model`
    (ignoring case), `name` and `minutes` (by `id` where a window has none of the three): a coding
    agent and the engine name a model's own limit differently. Each is the one read last (`read`)
    among them. The newest reading is the one checked last (`checked`, else its newest window's
    `read`): the plan and the credits are its, where it has them, else the next newest's; `checked`
    is the latest and `next` the earliest; a `problem` shows only when every box has one, the
    newest's. A row is as an account, named as the coding agent's where one is among them (else
    the engine's sign-in's), with the first `label` among them, and adds `id` (`<service>#<identity>`,
    or `<box key>/<provider>` for one that can't say who it is: the same on every box), `boxes`
    (each computer it's on, `{key, name, provider, agent?, account?, label?, checked?, here?,
    away?}`: `here`, the box that answered; `away`, a peer not heard from for 25 minutes, whose
    word stays as it was) and `away: true` when every computer it's on is away: its numbers are as
    of their `read`, never live, however recent. A row a box can't say who it is (no `identity`) is
    never merged by its numbers: two accounts can read alike (a personal plan and a team's, each
    at 12%).
- Listing them (KuvoClient's `UsageListing.listing`, as the Mac and the phone do): one box's `rows`
  as they are, merging nothing (the Mac: its own box's; the phone: the box of the first Mac whose
  usage panel answers, else the first that answers, that panel placing the rows), refreshed
  through that box alone, while they have every row each other box the client reaches says is
  signed in there (`here`), with that box among the row's `boxes` and not `away`. A row whose computers are all away shows "As of" its reading's time.
  Naming, a view: a row's name is its account's ("Claude", "Codex", "ChatGPT", "Claude · Work");
  where two rows would have one name: a row whose sign-in on the answering box is the engine's
  takes the service's name ("ChatGPT"); rows not on the answering box add the names of the boxes
  they're from ("Claude · hetzner, lokum"), as does one beside a bar the Mac panel shows of its
  own of that name (a provider's card that reads your own login's limits, when this Mac's box has
  no row of it: Codex's, say; Claude's card has none, so the accounts take its place, `covers`);
  rows still alike add their other boxes' names. Otherwise (a computer the client reaches answers
  without `rows`, a box from before them, or one whose own rows the first box doesn't have from it
  as it hears it now, not `away`: just added, or the relay down), the client merges each box's
  `accounts` itself, by the rules for `rows` above, and refreshes each ("For released Macs",
  `limits-merge`).
- What's read: Claude Code's accounts, on Linux from Anthropic with Claude Code's own sign-in in
  Kuvo Code's folder; on a Mac only from what its turns hear (Claude Code's rate-limit events, every
  window from each response's headers), as the token Kuvo Code signs in with there can only run
  Claude, so an account shows once it has had a turn. Codex's, through its app-server: once as the
  box starts, then only while Codex runs there anyway, with its turns' events between. Grok's pool,
  with the sign-in in its home; of the engine's, ChatGPT's (`openai`, signed in: Codex's windows),
  SuperGrok's (`xai`, signed in), GitHub Copilot's (the month's premium requests), OpenRouter's (a
  key's cap and the credits left), Z.ai's coding plan and OpenCode Go's. Not yet: Cursor's and
  Antigravity's (the usage panel still shows them on a Mac), nor Ollama's, which ollama.com tells
  only the Ollama app's own signing key.
- How often: Claude's each 15 minutes, the rest each 10. Anthropic limits these reads for the whole
  computer, not a sign-in, and holds a reader off longer each time it asks too soon: Claude's
  accounts are read one a minute (counted before the request goes, through a restart too), and a
  429 holds every one of them on the box for as long as its `Retry-After` says (an hour with no
  word, doubling with each 429 of any of them, up to six), through a restart. An API key a maker
  turns away is tried again later, with longer waits; a sign-in that lapsed isn't asked again
  until it changes. A read is kept
  as asked before it's answered, so a restart meanwhile never asks again; a sign-in that lapsed or
  can't read its limits isn't asked again until it changes.
- Agents read them with the tool `plan_limits` (read only): each account's windows, how much is
  used, when each resets and as of when, and why one couldn't be read just now.
- Times are ms since 1970.

### The Work Queue

Each conversation keeps its work items in a Work Queue of its own, on the box it lives on, the
same on a Mac's box and a machine's, with no client there too: a session's, a bot's (its
conversation's), or a group chat's (`grp_…`, the queue its seats write to). Together they're one
list across your computers: each item lives once, in its owner's queue on its owner's box, and
every box shows every other's ("Across your computers"). It replaces the
hand-kept backlog file: agents write items through tools, every agent kind alike; clients show
them, and you reorder them, move them between categories, delete them and bring them back, never
change what they say. Kept in `run/work-queue/` (`queues/<owner>.json`, files kept with items in
`files/<item>/`, `categories.json`, `numbers.json`); a deleted item stays 30 days. Where
`features` has `work-queue`. Times are milliseconds since 1970.

**An item**: `id` (`wqi_…`, never shown), `number` (its `#n`; missing while it waits for one,
shown as new), `wanted` (a number an import asked for, until it's granted; beside `number`, its own
number asked back), `owner` (`ses_…` or
`grp_…`), `title`, `category`, `order` (its place in its category, among every owner's items on
the box), `inProgress`, `progress` (`{value?: 0…1, note?}`: how far, and what's being done now),
`sessions` (`[{session, title, working}]`: the sessions working on it, and which are at work now),
`noteCount`, `lastNote`, `fileCount`, `linkCount`, `handedBy` (the first owner that handed it on),
`source` (an outside source's item: `{kind, ref, url?, host?, id?, name?}`, named by `ref` and
never numbered; one that had a number keeps it, never shown again: "Issues and pull requests"),
`seen` and `keptIn` (what GitHub says of it, below), `handing` (`{to, name}`: on its
way to a conversation on another computer, unchanged until it's there), `computer` (`{key, name,
kind: mac|machine, id?}`: the computer it's on, when that isn't the box asked, as that one last told
it; `id`, a machine's name on this Mac, for a client to reach it), `created` and `updated` (`{at,
by}`: `by` is `{user: true}`, `{session, name}`, or another shape kept as it came, such as an outside
tracker's `{source, name?}`: a client shows its `name`, never takes it for you), `doneAt`, `removed`
(`{at, by}`, deleted). Whole, it has `body` (Markdown), `notes` (`[{at, by, text}]`), `events`
(below), `files` (`[{name, size, type, at}]`), `links` (`[{url, title?, kind?, ref?}]`) and
`handed` (`[{from, to, at}]`, the last 20).

**What happened to it** (`events`, for its feed): `[{at, by, kind, from?, to?, top?}]`, oldest
first, the last 50, kept with the item and going with it wherever it goes (a hand-off to another
computer, a move), as its notes do. `by` is who did it, as for `created` (`{source: "kuvo", name:
"Kuvo Code"}` for what the box did itself). A box keeps an event by its `at`, its `kind` (up to 40
characters) and its `by`, each of a size an event has; what else it says is
kept as it came, for a client to read (a newer box's `top: false` or `from: null` too).

- `started`: a session's agent said it's working on it (`working: true`), unless it's at it already:
  linked, with its own last word `started` since the item was last `done`. A session linked some other way (`sessions`, a
  hand-off) says `started` the first time it says it's working; one linked before this box kept
  events, or whose `started` went past the last 50, says it once more then. (A delete keeps no
  event: a session linked again to an item brought back, that had said `started` before its
  delete, says no new `started`.)
- `stopped`: its link went while its own last word was `started`: it said it stopped (`working:
  false`), or it was unlinked (`unlink`, or its oldest link dropped as it linked a fourth item), by
  the same `by` as that `started` but where it said so itself. One that never said it started says
  no `stopped`. Done and a delete unlink everyone and say no `stopped`: they say it. A session that
  starts again within 2 minutes of its `stopped`, with nothing between (no other event, note or
  hand-off), never stopped: the `stopped` goes.
- `moved`: you or an agent moved it to another category, or to another place in its own (`from` and
  `to`, category ids, the same for a reorder; `top` when it went to the top). Its place is among
  every owner's items in that category on the box, as the All view lists them, so a move past
  another queue's item is one; a move that leaves it where it was isn't. One's reorders in one
  category within 10 minutes of each other, with nothing between (no other event, note or
  hand-off), are one `moved`. (Neither fold reaches back in time: an event from a computer whose
  clock was ahead is never folded into.) An item whose category the box doesn't keep (brought back after its
  category was removed, or come by a hand-off or a move) goes to Next, a `moved` by the box. An
  item added isn't moved, wherever it's put (`top`, `before`, `after`).
- `done`: moved to Done (a move out of Done is `moved`).

A hand-off is in `handed`, not here. A newer box may keep other kinds: a box keeps them as they
came, a client leaves them out. An item from before this has none (`[]`), and keeps what happens
from then on. A client puts `notes` and `events` (with `created`, `handed`, `doneAt` where no `done`
was kept at it or since, and `removed`) in one feed, oldest first. At one moment: `created`; the
box's events up to its last `started` at that moment, in its order (a move and the work it
started); notes; hand-offs; its other events, in its order; `doneAt`; `removed`. A category an
event names that the view doesn't (a custom one removed since) is "another category".

**In progress** isn't a category: an item is in progress while a session linked to it is at work
(its turn running, or what it left running), unless it's Done or deleted. A session is linked to
3 items at most (linking a fourth drops its oldest link); Done or a delete unlinks everyone.

**Categories**: one set for every queue: `next`, `later`, `parked`, `done` (built in), and custom
ones (`cat_…`), between Later and Parked: `{id, name, builtIn}`. Each box takes the custom ones of
the primary it numbers from as it tells them, and of an item handed to it; a view also lists a
custom one only another computer has (before Parked), for its items there.

**Who sees what**: an owner's view is its own items, those of the sessions it oversees (started by
it, or by those, put away ones too), and those it handed on, each living once in its owner's queue,
on any of your computers: those on another, as it last told them (its `rows` say which sessions
there are under the owner, "Work"). A session's view also shows the items linked to it that are
someone else's (what it's working on, a lead's item say), unless they're deleted. That's seeing
only: its agent's tools still change, show and list only what's in its view without those, as
before (a linked item is its owner's to change). A client shows them first, as "Working on"
(`item.owner` isn't the view's `owner`, and the item's `sessions` include it).

- `GET kuvo/work-queue?owner=<ses_…|grp_…>` → `{owner, categories, items, owners, removed,
  computers}`: `items` in the categories' order, then this box's first and each other computer's
  after, by its name (each computer keeps its own order), then each one's order; `owners` (`[{owner, kind:
  bot|session|group, title, bot?: {id, name}, startedBy?}]`) names each owner in the view;
  `removed`, what's deleted in it here, newest first; `computers` (`[{key, name, kind, id?, at,
  away?}]`), each other computer that told of its queue, as of when, and since when it hasn't
  answered (`away`, as `run/peer-reach.json` says): its items show as it told them, but none of
  them in progress, nor any of their sessions at work, as nothing there can be seen at work now (an
  item's `refs` and page say the same). `owner=all` is every queue on the box
  and on every other computer that told of its own (the panel's All). An item on another computer
  has `computer`. `kuvo/work-queue/events?owner=` is the same as NDJSON: a line now and one each
  time it changes (a change here or by another process, another computer telling of its queue, or a
  linked session starting or stopping work).
- `GET kuvo/work-queue/items/<id or number>` → `{item}`, whole (an issue's `gh:` ref names it too,
  but its "/" can't go in a path through every client: a client asks by the `id` its chip has). `…/files/<name>` → its bytes. An
  item on another computer answers as that one told it, with `computer` and an empty `body`,
  `notes`, `events`, `files`, `links` and `handed`: a client reads it whole, and its files, from that computer
  (a machine by `computer.id`; a Mac, its own box).
- `GET kuvo/work-queue/refs?refs=243,12`, or `POST kuvo/work-queue/refs {refs: [...],
  conversation?}` (a list, so a ref with a comma in it, an outside one later, goes whole;
  `conversation` is taken and not used yet: it's for "issue #12" in a project bound to a tracker,
  later) →
  `{refs: {"243": {id, number?, source?, seen?, title, category, inProgress, owner?, removed?,
  computer?} | null}}`: what each ref names (`#243`, `243`, an id, or an issue or pull request in a
  queue: `gh:owner/repo#12` or its page, and a linked item's old `#n`), by the ref as it was asked, for a chip; one on another computer as
  it last told it, with `computer`; null for one no computer told this box of. A client reads each
  on its own (one it can't read is as null, the others still chips), and keeps what it learns by
  the ref as asked, not by a number.
- `GET kuvo/work-queue/categories` → `{categories}`.

**What you do** (a paired phone, this Mac's app, or Kuvo Code on another computer through `box
route` with its Mac's proof for that request alone, `x-kuvo-vault-proof` as the vault takes it; anything
else, a command on that computer included, gets 403). An item on another computer is changed
there: here, each of these answers 409 `{message, computer}`, and a client sends it to that
computer instead. One on its way to another computer (`handing`) is refused (400) until it's there,
but for `DELETE`, which calls its hand-off off (a note says so) and deletes it.
`POST kuvo/work-queue/items/<item>/move` `{category?, before?,
after?, top?}` (a category by its id or name; `before`/`after` an item in the same category);
`DELETE kuvo/work-queue/items/<item>` and `POST …/restore`; `POST kuvo/work-queue/categories`
`{add, after?}`, `{rename, to}` or `{remove}` (a custom one, once nothing is in it; on a box that
numbers from another, that one's custom categories come back as it says, "Across your computers");
`POST
kuvo/work-queue/import` `{owner, files: [paths]}` (Markdown files on the box: each list line
starting with `#N` is an item, in the category of the nearest heading above it that names one
(Done, Shelved/Parked, Later/Ideas), else Next, Done with `[x]`; a line `NOW:`/`LATER:`/… with
refs sets theirs; the first line naming a number gives its title, every line naming it its body)
→ `{added, byCategory, waiting, skipped, said}`. An item keeps its own number wherever no other item
has it, here or on another of your computers (as each told this box), and it isn't one this box
gave an item that's gone from it (`numbers.json`, `used`: moved away, or deleted); one waiting for
its number (an import's still under way) holds it as its own. An import skips a number here already under the
same title, or waiting for it; under another title, the item is imported with a new number
(`importedAs`) and a note, and `said` names each one renumbered and its number now, as it does
those the primary refuses at once (on the primary itself; elsewhere a note says so when its answer
comes). An item an import renumbered, imported again under the same number and title, isn't made
twice: it asks for its own number back (claimed as an import's are, as `restores` too, keeping
the one it has, and `wanted` meanwhile), where no other item has it (one on its way back to its own
number lets it go); granted, every such item moves at once (two can trade), with a note, and
`importedAs` goes. One whose number another item has waits (`backGranted`, never asked again) while
that one asks for its own, and moves once it has; else, or refused, it stays as it is, with a note
(`stays`: an import doesn't ask again). So importing the same backlog again repairs an import that
went wrong, and once it has, changes nothing. Each change
answers `{item}`; a category removed only once nothing, deleted items included, is in it.

**Tools**: `GET kuvo/work-queue/tools` → `{tools, instructions}` (MCP definitions, and what the
tool servers add to what they tell agents); `POST kuvo/work-queue/tools {name, arguments, session}`
→ `{text, isError}`, run only while the session named is making that call (as the vault's). The
tool servers (this Mac's app, a machine's `kuvo-browser.js`) list them and pass on every `queue_…`
call. `queue_list` (its own and its view's items, then those on your other computers, as each last
told them), `queue_show` (one on another computer as it told it, saying it lives there),
`queue_add`, `queue_update`, `queue_hand` (into a session's queue, linked to it: one on this box at
once; one on another computer that takes the Work Queue's mail, by address or a bot's name, by mail,
"Across your computers"), `queue_remove` (`undo` brings back an agent's delete; only you
bring back yours; one on its way to another computer has its hand-off called off), `queue_categories` (list, or add one), `queue_import` (items an agent read from
an old backlog, with their numbers). `item` is a number (`#243` or `243`), the id of one that has
none yet (the tool says it), or the issue or pull request an item is (`gh:owner/repo#12`, or its
page); `queue_add` with `issue` adds one, `queue_update` with `issue` makes an item that issue
("Issues and pull requests"); one on another computer is changed there, and a change from here is
refused saying so. A caller's queue is its conversation's (a subagent's is its
conversation's; a seat's, its group chat's, while the chat lives on this box: a seat of one that
lives elsewhere is refused); it changes what's in its view (by a number two computers gave twice,
the one in its view). Files an agent keeps with an item come only from its conversation's folder,
its project's folders or a temporary folder (links followed, nothing hidden, no other name by a
hard link, nothing of Kuvo Code's but its own folder), 25 MB each; they're read before the change
and kept with it, all or none.

**References in messages** (for chips, the same in every client: KuvoClient's `WorkItemRefs`):
`#243` names item 243 when the `#` is at the start or after a space or one of `([{"'/,–-`, with 1
to 6 digits and then no letter, digit or underscore; not inside a code span or block, a Markdown
link or a web address, and not after "PR", "MR", "pull request", "issue" or "step" (someone
else's numbers; outside sources get a prefix, `gh:owner/repo#12`). `gh:owner/repo#12` (`owner` a
GitHub owner, `repo` a repository name, the number 1 to 10 digits; then no letter, digit or
underscore; not in code, a link or an address either) names the item that is that issue or pull
request. Bare numbers resolve only through the conversation's queue view (its own items, those
of sessions it started, and items linked to it), never the all-items view or another conversation's
cached refs.
Numbers 1–10 stay plain when immediately preceded or followed by "ranked", "rank", "number",
"result", "results", "spot", "place", "position", "priority" or "seller", or followed by
"on" or "in" and another word, or "Google result(s)" (case-insensitive, allowing whitespace
between words). "The", "to" and "at" alone do not
block references: "to #243" and "the #1 reason" can name visible items. Code, links and the other
exclusions above still apply. With no conversation owner, bare numbers stay plain and cause no
requests; explicit `gh:` refs keep their computer-wide lookup and chips. Clients follow the
conversation's queue for numeric chips; only explicit `gh:` refs need
the computer-wide `refs` lookup. A client draws an eligible known reference as a chip (its category's color, a ring in progress, a check when done, `#243` and the
title on one line; for an issue or a pull request, GitHub's mark and `source.name` in place of
`#243`, the title struck through when `seen.state` is `not_planned` or `closed`), leaving one it
doesn't know as written; the message's words never change. A chip opens the item.

**Issues and pull requests** (GitHub's, on github.com): an item can be an issue or a pull request
there, read with the box's own `gh` and its sign-in (Kuvo Code keeps no key of GitHub's for it), and
never written to: nothing here changes anything on GitHub.

- In: an agent adds one (`queue_add` with `issue`: `gh:owner/repo#12` or its page), or makes an item
  of its own one (`queue_update` with `issue`): it's that issue from then on, named by it (`source`:
  `kind` `github` or `github-pr`, `ref` `gh:owner/repo#12`, `url`, `host`, `id` GitHub's own), its
  number kept and never shown again (the old `#n` still names it), its title and description
  GitHub's (what an item said before is kept as a note; a bare `#n` in an issue's description is
  that repository's, so a client chips only its `gh:` refs). Its ref is GitHub's own name for it,
  after a rename too. One item for each issue (by its name or GitHub's id): a second is refused,
  naming the first. `gh` reads it once as it's added or linked (with its description; under the same
  lock and back-off as every read); one it can't read (not there, signed out, no such issue it may
  see) is refused in words, and nothing is added. An agent reads its description fenced off as
  outside text, never instructions.
- Read only for what a client shows: a view (and its events), an item, and `refs` read the issues
  and pull requests in them where that's due (one GraphQL query for all, 200 at most, those asked
  longest ago first; one process at a time; again after a minute while it's open, half an hour once
  it's closed, five minutes when it couldn't be found; a host `gh` couldn't read isn't asked for five
  minutes). One another computer told of is read here only once what it told is five minutes old
  (`seen.checked`): that computer reads what it shows. A view's or refs' answer waits
  3 s at most for it; the events stream doesn't wait, and its next line has it; a request answered
  once (`box route`) never waits: a read that's due goes on in a process of its own (`kuvo-link.js
  box github-read`), kept for the next ask. One found missing where it was is read again by GitHub's
  id (moved, or a discussion now). Agents' tools never read GitHub: they say what was last read.
- Kept beside the queues, `run/work-queue/seen.json` (`{reads: {"<host>/<owner>/<repo>#<n>": {at,
  value, checked?, gone?}}, hosts}`), never in them: a read changes no item and no `updated`. `at`
  is since when GitHub has said what it says (a read that finds the same moves only `checked`, so
  nothing shown or told changes with it). One found missing later (gone, or no longer visible to
  that sign-in: GitHub says the same of both) keeps what was last read, `gone`. The same reader
  (`link/github/graphql.ts`) reads sessions' pull requests for "A session at a glance".
- Each summary takes it in: `title` GitHub's; `source.name`, what a client shows in place of `#n`
  (`repo#12`, `owner/repo#12` when another owner's repository read here has that name); `seen`
  (`{state, at, gone?}`: `open`, `draft`, `completed`, `not_planned` (a duplicate too), `merged` or
  `closed` (a pull request closed unmerged), and since when; a newer box may say more); and, while it's
  `completed`, `not_planned`, `merged` or `closed`, `category` `done` (never in progress then), its
  own category in `keptIn`, and `doneAt` when GitHub closed it. Reopened, it's back in its own
  category; `struck` (closed without being done: its title drawn struck through) and `closesOn`
  (`github`: Done is GitHub's, never a place to move it to), for clients to draw by. What another
  computer tells carries the same, so a client draws it there without `gh`; its times are taken as
  no later than when it told them. Where this box read it too, the word asked of GitHub later
  (`checked`, else `at`) is shown, this box's on a tie, and one found gone only when the other is
  too.
- Done is GitHub's: moving one into Done, or out of it while it's closed (you or an agent), is
  refused in words (400); its title and description aren't changed here either.

**Numbers**: one `#n` per item, unique across your computers, handed out by the primary: your
setup's main computer ("Your setup"), the box itself when it's that; one a box can't write to yet
(its document not here, or naming no address) is waited for, never passed over. A box that
follows no setup (Macs that share a machine, and the machines numbering with them, or a box beside
an older one; kept until every box knows setups and those Macs are joined in one) takes the first
computer you set up. Each box works it out the same way from what it knows: of itself, its peers and
the primaries they say they number from ("Across your computers", `told`), a Mac comes before a
machine (a machine is always set up from a Mac), then the one set up first (`since`: when that box
was set up, the earliest it can tell: its folder's making where the system keeps that, or its oldest
item; one that hasn't said is never earlier), then by key. A box keeps the primary it numbers from
(`numbers.json`, `primary`) while that one is still one of your computers and none set up earlier is
known: it moves only to an earlier one, never back, and one whose primary was removed or forgotten
finds the next. A primary no peer names any more (the one this box reaches it through stopped
saying it) is waited for: once three days go by unheard (`numbers.json`, `lost`), or at once once the
peer it was reached through (`through`) is removed, or once that peer names another primary (it
found this one gone, or one set up earlier), the box finds the next. A peer that hasn't answered for
three days and was still found away in the last hour (`run/peer-reach.json`, and
`run/peer-reach-checked.json`, when the relay last found it not there: not one that was away when
this box itself went off the relay; a Mac put away, or set up again with new keys, that its machines
still list a while) isn't one to number from; a box that reached it through that peer follows that
peer to its next. Heard from again, it's the earliest again, and boxes move back to it, which moves
past what was numbered meanwhile (`top`). A machine set up from a
Mac never numbers on its own; while it knows of no Mac that
can be reached yet, items wait. The primary numbers its own
items from its counter; another box numbers from blocks of 50 the primary gave it, and asks for the
next when 15 or fewer are left, by mail, on its rounds: `{workQueue: {ask: {id, count, claims?,
restores?, own?, top?}}}`, sent again every 30 s until answered with `{workQueue: {give: {id, from, to, granted}}}`.
`top` is the highest number the asking box used, holds or handed out: the primary moves its counter
past it (a box that numbered on its own before, or a primary that lost its file), and past any number
its peers tell it they use. A box that stops numbering on its own asks its new primary at once. A
primary that isn't one of the asking box's peers (an earlier Mac known only through a machine both
set up) is asked through the peer that named it: `{workQueue: {ask, to: <primary key>}}` to that
peer, which passes it on as `{ask, for: <asking box's key>}` if it's its own primary, and the block
back as `{give}`; one hop only, and a box takes a block only from its primary or the peer it asks
through. The primary keeps what it gave for each ask, so an
ask sent again gets the same answer, and notes the box it gave each block (`given`, `by`). `claims`
are numbers an import wants to keep (six digits at most, what a chip reads): the primary grants
those at or above its counter and within 10,000 of it, those it granted that box before, and, for
an ask that says `own` (a box that never claims a number it gave an item, `used`), those in a block
it gave that box (its own: a box drops its leases at or below its claims, and takes a block only for
the ask under way, so a block given for an ask an import replaced is never used), and moves its
counter past them. Until those an older primary kept without whom they went to are gone from
`given`, such a block counts for `restores` (numbers asked back for items an import renumbered)
only where every other computer the primary knows told it, and of no number as high as the block's
first (its `top` or its items), and the asking box told of one as high as its last: a box that
never tells the primary (one reaching it only through a peer) could hold one unseen. An imported item waits without a number until then; an answer decides only the claims
its ask carried (one claimed later waits for its own), and one refused gets the next number, with a
note. An item made with no number left waits too, and takes one, oldest first, when a block comes; one left
waiting with nothing under way (a crash midway, a move), or still asking for its own number back, is
claimed or numbered again within a minute.
A queue file that can't be read is never written over: the change is refused and the file set aside
(`queues/aside/`); fields a newer box keeps in an item are kept as they are, and so is a queue of a
kind of owner this box doesn't know (`queues/<kind>_….json`, a newer box's): never read, shown,
numbered, set aside or written over but by a move of an owner of that name, which carries it when
every item in it reads as one here (else it's left as it is, where it is).

**Moves**: a move carries its conversations' queues (a group chat's, its own) and their files
(`move.json`'s `workQueue`, the files in the bundle's `work-queue/<item>/`), put in place under the
same owners and numbers, each item checked as this box's own are (a category it can't keep is
Next); once it's over, the box it left forgets them. While it's under way nothing changes those
queues (a tool's change, a hand-off into one, or yours: refused, with words to try again once
it's there), so nothing is left behind. A conversation carried on as another takes its queue. An
item on its way to another computer (`handing`) goes with the move and is sent from where it lands.

**Across your computers** (bridge 0.9.211, to a peer whose agents' mail `features` say
`work-queue.elsewhere`; mail as "Peers" says, under the top-level `workQueue`):

- **Told**: each box tells every such peer its Work Queue, unasked, so the others have it while it
  sleeps: `{workQueue: {told: {id, at, kind, since, top, primary?: {key, kind, since?}, shared?,
  items, owners, categories}}}`. `items` are its items as a view gives them (not deleted ones; the
  100 latest Done; 1,500 at most), each with `handedFrom` (who handed it on), an issue's or pull
  request's with `seen` and `keptIn` as this box last read it (`seen.checked`, when it last asked
  GitHub); `owners` names their
  owners; `categories` its custom ones; `kind`, `since` and `top` how it numbers, `primary` the
  one it numbers from (itself when it's the primary), and `shared`, whether it's a machine Macs
  share outside one setup ("Your setup"; an older box says neither). `id` (`wqt_…`) is the same while all that is.
  It's worked out again when a queue changes and each minute (who's at work changes it), and goes
  to one computer once in 15 s at most, again each minute (sooner after a change you made from a
  client, at the next round 15 s on) until that computer answers `{workQueue: {had: id}}`, nothing
  while it's the same and had, and nothing while that computer isn't answering
  (`run/peer-reach.json`; it goes once its mail comes again, and again in full to one that asks for
  agents as it connects). The receiver keeps the newest from each peer
  (`run/work-queue/peers/<key>.json`; one older than what it has by less than ten minutes, mail
  come late, is neither kept nor had; one older by more is its clock set back, and kept), cleaned as
  it takes it, and only from a box that's one of its peers; what's kept of a computer you removed
  goes. An item two computers tell of (one handed between them, the first not told again yet) shows
  once, as the one that changed it last says; one deleted here that another tells of is that
  computer's (a hand-off called off after it got there), unless it told of it on its way here. The primary's custom categories are those of every box
  that numbers from it (one reached through a peer: as that peer tells them): added, renamed and
  removed as it tells them (one still in use on a box stays there until it's empty); those only a
  box has itself stay, after them (past 30 in all, its unused ones go; never one in use).
- **Parts**: Work Queue mail too big for one goes as `{workQueue: {part: {whole, i, of, d, s}}}`,
  as a document's parts go ("Peers"): `d` pieces of 40,000 characters of the base64url of the
  whole's JSON (`{told: …}`, `{hand: …}`), `whole` the SHA-256 of all of it (base64url), `s` empty,
  at least 2 and at most 200 parts. The receiver puts them together once the last is here (four
  under way from each box at most), checks `whole`, and takes it as if it came in one.
- **Hand-offs**: `queue_hand` to a conversation on another computer leaves the item where it is,
  unchanged (`handing`: changes to it are refused meanwhile), and sends `{workQueue: {hand: {id, to,
  from, by, at, item, files, categories?}}}` (`id` `wqh_…`; `item` the item whole, as kept; `files`
  `[{name, data}]`, base64, 4 MB at most in all, one with more refused at once; `categories` the
  custom one it's in) to the box `to` lives on now, again each minute until it answers
  `{workQueue: {handed: {id, ok, why?, retry?}}}`, from that box only. Had (`ok`), the item and its
  files go from the sender; refused for good, it's back as it was with a note saying why; `retry`, it
  goes again; given back with a note at once when you removed the box it goes to, three days after
  that box stopped being one of its peers (`handing.missing`: a computer can be missing from the
  list a while) and `to` isn't on another, and after 30 days otherwise, whether this box is on the
  relay or not; deleted, it's called off (a copy that got there already is that computer's, shows as
  its, and the one deleted here isn't brought back beside it). The receiver takes each `id` once
  (remembered 30
  days, and an item it has already is had, but one deleted here, which the live one replaces), only
  from one of its peers, into the queue of `to`'s
  root conversation (a subagent's, its conversation's; a group chat's seat refused), linked to it,
  noted as handed from `from`, in a category it can keep (else Next), with its number as it was (one
  with none takes one there at once); it
  answers `retry` while `to` moves between computers or it can't look it up (its engine starting, or
  the coding agents' bridge not running), and while the item is still on its way from it to
  another computer itself (handed back before its receipt came), and refuses one for a conversation it doesn't have, or a
  queue that's full. So the item lives once, and stays in the hander's view on every computer
  (`handedBy`, `handedFrom`).

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
the route scenario `Vectors/routes/features.json`, which `scripts/route-shapes.sh` writes from the
box's lists (`FEATURES` in `Packages/Box/src/shared/features.ts`, `MAC_FEATURES` and
`MACHINE_FEATURES` in `shared/routes/mac.ts`). A Mac's list is its box's (`macFeatures`, from #191
step 2; the app gave it before): every box's but a machine's own, and the Mac's own, the same
with its app closed, when what needs the app answers `503 {"message"}`.
A note of when a name came in names the bridge's version up to 0.9.211; after that, the bridge's
version is a hash, and a name is its own mark.

One row a name, in order, so branches that each add one merge cleanly.

| Name | What it answers |
| --- | --- |
| `accounts.credentials` | `kuvo/accounts/credentials` |
| `accounts.ended` | `kuvo/accounts/ended` and `POST kuvo/accounts/<provider>/forget` (a machine from 0.9.61) |
| `accounts.found` | `kuvo/accounts/found`, `…/found/use` |
| `accounts.refresh` | `GET kuvo/accounts/refreshable` and `POST kuvo/accounts/<provider>/refresh` (Refresh Models) |
| `agent-tools` | `POST kuvo/agent-tools`: the agents' tools, answered by the box (bridge 0.9.100) |
| `agent-tools.own` | `POST kuvo/agent-tools` answers the wake-up tools, `set_job` and the show tools too ("Agents' tools") |
| `agents` | `kuvo/agents/api/…`: the coding agents (`agents` in `kuvo/info` says whether their bridge is up now) |
| `approval` | `kuvo/approval` and `kuvo/sessions/<id>/approval` ("Approval", bridge 0.9.180) |
| `approval.default` | A new conversation's approval where its client doesn't say: Auto the first time on a computer, then the last one picked there (`kuvo/approval`'s `default`, bridge 0.9.185); one a client made with `kuvo.approval` alone gets that ("Approval") |
| `approval.fullAccess` | Full Access as it is since bridge 0.9.184: its commands run outside the sandbox, nothing asks or is reviewed, `kuvo/approval`'s `fullAccess` is whether you confirmed it on this computer (asked the first time it's picked), and Tell Auto is gone ("Approval") |
| `approval.held` | Auto never leaves a call waiting on you (bridge 0.9.185): what its reviewer refuses or can't judge is held back, and `POST kuvo/sessions/<id>/decisions` `{approve: id}` approves one once; a sandbox ask in Auto never comes to you, so it has no `review` ("Auto's reviewer") |
| `approval.otherComputers` | `kuvo/approval`'s `otherComputers`, and `PATCH {otherComputers}` ("Approval") |
| `approval.reviewer` | Auto's reviewer: `kuvo/sessions/<id>/decisions` and a sandbox ask's `review` ("Approval", "Auto's reviewer", bridge 0.9.181) |
| `approval.seen` | `seen` in `kuvo/sessions/<id>/decisions`, and `POST` `{seen: true}` as you open them: what's held back since is news on every client ("Auto's reviewer", bridge 0.9.187) |
| `approval.stopped` | In Auto, a command the sandbox stops goes to Auto's reviewer by itself, with no `sandbox_ask`: allowed, it runs outside the sandbox and the agent gets that output; each lands in Decisions ("Asks", "Stopped commands", bridge 0.9.190) |
| `asks` | `kuvo/asks`, `…/events`, and answering one |
| `attention` | `kuvo/attention` |
| `autopilot` | `kuvo/sessions/<id>/autopilot`, `autopilot` in `POST kuvo/sessions`: a conversation on Autopilot, its questions with a recommendation going ahead ("Autopilot"; bridge 0.9.200); a goal's `mode` and `decided`, `mode` on start and change, `{action: decided}` ("Work", Goals, Interactive or Autopilot) |
| `bots` | `kuvo/bots` |
| `bots.edit` | `PATCH` and `DELETE kuvo/bots/<id>` |
| `bots.events` | `kuvo/bots/events` |
| `bots.job` | a bot's job as its box's record: `jobDetails` in `kuvo/bots`, `job` in `PATCH kuvo/bots/<id>` |
| `bots.keys` | `kuvo/bots/<id>/keys…` |
| `bots.make` | `kuvo/bots/templates` and `POST kuvo/bots` |
| `branch` | `kuvo/agents/api/kuvo/branch/<session>`: Branch from here, marked |
| `browser` | a machine only: `kuvo/browser`, its browser set up by the box itself ("The browser on a machine") |
| `btw` | `kuvo/agents/api/kuvo/btw…`: side questions ("Side questions, handoffs and reviews") |
| `btw.threads` | a side question's `thread`, follow-ups and a thread's removal (bridge 0.9.98) |
| `claude-code` | a Mac only: `kuvo/claude-code` |
| `config` | `kuvo/config` |
| `config.apply` | `POST kuvo/config/apply` |
| `engine.restart` | `POST kuvo/engine/restart` |
| `engine.start` | a machine only: `POST kuvo/engine/start` |
| `file` | `kuvo/file` |
| `folders` | `kuvo/folders` |
| `folders.files` | `kuvo/folders?files=1`: a folder's files too, and `reason` on a refusal |
| `git` | `kuvo/git/…`: Changes (bridge 0.9.94) |
| `git.backups` | `kuvo/git/backups…`: branch backups, and taking one back (bridge 0.9.182) |
| `git.changes.count` | `POST kuvo/git/changes/count`: how much changed, without the diff (bridge 0.9.211) |
| `git.merge` | `POST kuvo/git/merge`: Merge into… (bridge 0.9.143) |
| `git.pull-request` | `POST kuvo/git/pull-request`: Create Pull Request (bridge 0.9.143) |
| `git.pull-request.draft` | `POST kuvo/git/pull-request/draft`: Create Pull Request's confirmation (bridge 0.9.179) |
| `git.push` | `POST kuvo/git/push`, and a commit's `committed` when only its push failed (bridge 0.9.143) |
| `git.words` | Settings › Git in `kuvo/config` (each computer's own), `prompt` from `kuvo/git/commit-diff` and `kuvo/git/pull-request/draft`, and `POST kuvo/git/settings/move` |
| `goals` | `kuvo/agents/api/kuvo/goals…`: goals ("Goals") |
| `groups` | `kuvo/groups`, `…/events`, one chat's events, and writing, stopping, keep going, viewed, undo and start |
| `groups.delete` | `DELETE kuvo/groups/<id>` |
| `groups.edit` | `PATCH kuvo/groups/<id>` |
| `groups.joinable` | `kuvo/groups/joinable` |
| `groups.make` | `POST kuvo/groups` |
| `groups.seats` | its bots take turns in chats on other computers ("Peers", group chats) |
| `handoff` | `kuvo/agents/api/kuvo/handoff…`: handoffs |
| `hosts` | a Mac: `kuvo/hosts…` (with its app closed its box still lists them, and `DELETE` says the app must be open); a member of a setup answers it too, with `setup.mainOnly` |
| `integrations` | `kuvo/integrations…` |
| `keys` | `kuvo/keys…` |
| `letters-read` | (in a peer's agents' mail) it takes a letter with `read` (bridge 0.9.100) |
| `limits` | `kuvo/agents/api/kuvo/limits…` and `plan_limits`: each account's plan limits ("Plan limits") |
| `mac` | a Mac only: `kuvo/mac` |
| `machines` | a Mac only: `kuvo/machines…` (with its app closed its box still lists them, and the rest says the app must be open) |
| `mcp.catalog` | `kuvo/mcp/catalog…` |
| `moves` | `kuvo/moves`, `…/places`, `…/events`: Move to Computer, done by the boxes (bridge 0.9.108) |
| `named` | `kuvo/named` |
| `personalities` | `kuvo/personalities…` |
| `personalities.events` | `kuvo/personalities/events` |
| `phones` | `kuvo/phones` and `POST kuvo/phones/remove` |
| `phones.pair` | `kuvo/phones/pair` |
| `pieces` | a machine only: `kuvo/info`'s `pieces`, which version its link, coding agents' bridge and engine run ("Updates", "A new version while it works") |
| `plugins.search` | `kuvo/plugins/search` |
| `programs` | `kuvo/programs` |
| `providers.models` | `POST kuvo/providers/models` |
| `queue` | `kuvo/sessions/<id>/queue…`, `…/stop` and `kuvo/sessions/queues/events`: the box carries the queue (bridge 0.9.100) |
| `queue.waits` | A Stop holds the conversation: what arrives waits on the box (`waiting`), `…/queue/add` and `DELETE …/queue/<item>` (bridge 0.9.128) |
| `reviews` | `kuvo/agents/api/kuvo/reviews…`: reviews with fresh eyes |
| `reviews.parts` | a review's `parts`, each on the engine read in a `session` a client can open (bridge 0.9.102) |
| `reviews.scopes` | a review's `scope`, `measure`, `choices` and `stop` (bridge 0.9.97); without it a box reads the changes not committed yet whatever the scope |
| `sandbox` | `kuvo/sandbox` ("Sandbox", bridge 0.9.118) |
| `sandbox.asks` | `kuvo/sandbox/asks…`, `kuvo/sandbox/allowed…` and `kuvo/sandbox/tools` ("Sandbox", "Asks", bridge 0.9.118) |
| `sandbox.check` | `reason`, `action` and the rest in `kuvo/sandbox`, and `POST kuvo/sandbox/check` |
| `sandbox.reviews.settled` | `settled` on `kuvo/sandbox/asks`: each ask Auto's reviewer was checking or left for you that was answered or went since, so no client takes it for one that waits, heard or not ("Sandbox") |
| `sandbox.reviews.whole` | `reviews` on `kuvo/sandbox/asks` lists every ask to work outside a conversation's folder, so a client shows one only once it's listed `yours` ("Sandbox") |
| `search` | `kuvo/search` |
| `sessions.agents` | `POST kuvo/sessions/<id>/agents` |
| `sessions.chat` | A chat made, moved or with its metadata written since carries `kuvo.chat` in its metadata, naming the chats folder it's in; older ones go by their folder ("Chats") |
| `sessions.glance` | `kuvo/sessions/glance`, `…/events`, and `session` in `POST kuvo/git/pull-request` ("A session at a glance") |
| `sessions.models` | `GET kuvo/sessions/models` ("A session's model") |
| `sessions.start` | `POST kuvo/sessions`: a session started with a task (bridge 0.9.100) |
| `setup` | `kuvo/setup`, `…/events`: your setup and its main computer ("Your setup") |
| `setup.mainOnly` | a member refuses pairing and adding with `409 {message, primary}`, and answers `GET kuvo/hosts` from its setup ("Your setup", Only the main computer adds and pairs) |
| `shell.stop` | `POST kuvo/shell/<id>/stop` |
| `sign-in.return` | `POST kuvo/sign-in/return` |
| `skills` | `kuvo/skills…` and `kuvo/skill-library…` |
| `skills.trash` | `kuvo/skill-trash…`: Recently Deleted, and restoring from it |
| `update` | a machine only: `kuvo/update` |
| `usage` | a Mac only for now: `kuvo/usage…`, from its app while it's open (`404` without the usage panel, `503` with the app closed), spend and what the box doesn't state of a plan yet (a machine's box can't do this yet, on Linux or a Mac). Before #191 step 2 a Mac named it only while its usage panel was there |
| `wakes` | `kuvo/wakes`, a session's, and cancelling one or sending it now |
| `wakes.edit` | adding one (`POST kuvo/wakes/<session>`) and pausing them |
| `wakes.events` | `kuvo/wakes/events`, and making a watch (`POST kuvo/wakes/<session>/watch`) |
| `work` | a bot's work ("Work"): `kuvo/work`, `…/events`, `kuvo/bots/<id>/stop-all`, `start_session`'s and `kuvo/sessions`' new fields, the work tools, `limits` in `kuvo/bots` (bridge 0.9.106) |
| `work-queue` | `kuvo/work-queue…` and the `queue_…` tools ("The Work Queue") |
| `work-queue.elsewhere` | (in a peer's agents' mail) it tells and takes the Work Queue across your computers: `told`, `had`, `part`, `hand`, `handed`, and numbers' asks through a peer ("The Work Queue", Across your computers); also `POST kuvo/work-queue/refs`, `computer` and `computers` in its views, and 409 for an item elsewhere |
| `work.elsewhere` | (in a peer's agents' mail) it takes a lead's `call` and tells `rows` ("Peers"; bridge 0.9.204) |
| `work.elsewhere.start` | (in a peer's agents' mail) it takes starts, reads of its models and projects, and a bot's `stop_work` from your other computers, while its switch lets them ("Peers", Starts) |
| `work.goals` | a bot's goal ("Work", Goals): `kuvo/work/goals…`, and its tools (bridge 0.9.122) |
| `work.goals.apps` | `app` on a goal's steps and what waits, and `GET kuvo/work/apps/icon` ("Work", Goals, Apps; bridge 0.9.196) |
| `work.goals.projects` | `{action: projects}` on a proposed goal ("Work", Goals, Its projects; bridge 0.9.196) |
| `work.projects` | a bot's projects ("Work", Projects): `make_project`, `list_projects`, `kuvo/work/asks`, `…/events`, `POST kuvo/work/asks/<id>`, `kuvo/work/settings`, `POST kuvo/projects/new`, `madeBy` on projects, `allowed` in `kuvo/bots` (bridge 0.9.107) |
| `work.unanswering` | `GET kuvo/work/unanswering`: models that can't answer now ("Work", Models that can't answer; bridge 0.9.198) |
| `worktrees` | `kuvo/worktrees…` |
| `worktrees.where` | `kuvo/worktrees/where` |

Here "a Mac" is the box the app runs (`KUVO_BOX=mac`), and "a machine" any box in `~/.kuvo-code`,
on Linux or on a Mac.

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
 "macs": ["<each Mac that set it up>"], "macSigns": {"<Mac>": "<its signing key>"}, "macSeen": {"<Mac>": <when it came, here, moved on by time off since>}, "macNames": {"<Mac>": "<its name>"},
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
time for `application/x-ndjson`), and goes when its stdin closes. A route that holds a request
before its answer's head (an ask waiting for you, a sandbox tool, a vault wait) sends an interim
`102 Processing` every 20 seconds to an HTTP/1.1 client, which clients ignore but which keeps
their wait for the head alive (URLSession's request timeout). It never reaches a phone: the app
forwards a phone's request to the box with URLSession, which takes it in and gives on only the
answer. It finds the engine and the
coding agents' bridge as on a machine, by `run/engine.json` and `run/bridge.json`, which the keeper
writes (only you can read them) as they start and removes as they stop.

#### The keeper

This Mac's box keeps running whether or not the app is open, as a machine's does with its Mac
closed: its keeper is Kuvo Code's own executable run with `--box`, which launchd starts from the
launch agent in the app (`Contents/Library/LaunchAgents/<bundle id>.box.plist`, registered with
`SMAppService` the first time the app opens), at each login and again if it stops by itself. It has
no window. It runs the engine, the box and the coding agents' bridge, starts each again when it
stops (at once, up to three times in five minutes), and tries each again when it couldn't start or
keeps stopping (after 15 s, 30 s, 1, 2 and 5 minutes, then every 10 minutes for good, as a machine's
keeper waits, starting over once it ran for ten minutes; not when another try can't help: a program
that isn't there). Once among those waits, it isn't started again at once until it has run for ten
minutes. Past those waits, a try that took too long while macOS was asking you something waits an hour
instead, and goes as soon as that question is seen to be answered: it closed after staying open once
the try had ended, or a server it held came up. It records each in the box's
`run` folder,
as a machine's keeper does, so a client finds them there:

- `run/keeper.json`: `{"pid", "version", "build", "url", "password", "started"}` (milliseconds).
  `run/keeper.lock` is held while it runs: one at a time.
- `run/engine.json` and `run/bridge.json`, as on a machine; `run/engine-stopped` (its reason) when
  the engine stopped and isn't started again until asked, or until its next try, and beside it
  `run/engine-output`, what the engine wrote last (when it wrote anything), which the app shows under
  the reason, and while it waits for that try, `run/engine.retry` (when, in seconds since 1970, as on
  a machine); `run/agents-stopped` (`{"why", "retrying"}`) while the bridge is down, not while it's
  starting or stopped on purpose; `run/.system-asking` while macOS asks you something.
- `run/serve.json`: `{"pid", "port", "password"}`, where the box answers.
- `bin/kuvo-start`: as a machine's (`kuvo-start restart`), here calling the keeper
  (`--box-control`).

It answers on `127.0.0.1` at `url`, to `Authorization: Bearer <password>`: `GET status` (`pid`,
`version`, `build`, `started`, `engine {state: starting | downloading | ready | failed, progress?,
reason?}`, `busy`, `updating`, `awake`, and `box`/`agents` `{failure}` when either stopped for
good), and `POST` `restart-engine`, `restart-agents`, `restart-box`, `stop` (Stop Background Work:
it stops everything and itself, and launchd leaves it stopped until the app opens or you log in
again), `update` (an app of another version opened: it goes the first moment nothing is under way
on the engine or with the coding agents, however long what runs takes, since a running session is
never stopped for an update; launchd starts the installed app's; it answers `{updating}`, false
when the app at its place is still its own version, as when the app asking is another copy), and
`app {tools?, host?}`
(below). It also makes way by itself once another version is installed in its place.

While a session works on the engine or with the coding agents, the keeper keeps the Mac from
sleeping on its own (Settings › General's Keep this Mac awake, the app's own setting, read as it
changes), whether or not the app is open; `awake` says whether it does now, with the setting as it
is then.

The app is a client: it reads those records (again as the `run` folder changes) and connects to
the engine, the box and the bridge as they say, starting the keeper with launchd when there's none.
While macOS doesn't let the keeper run (switched off in Login Items & Extensions), the app runs the
same three itself, and they stop when it quits. A newer app finding an older keeper asks it to
make way (`update`) and follows it meanwhile, saying the update waits for what's running (when
the keeper answers that it makes way); it
downloads no engine of its own then, so the one the older keeper runs stays, and connects to the
new keeper's once its records appear. The app keeps the Mac awake itself only while it runs the box
itself; following the keeper, `kuvo/mac`'s `awakeNow` is the keeper's `awake`.

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
this Mac are starting" or "aren't answering" when it can't; from 0.9.202, while the bridge is down,
what `kuvo/groups…`, `kuvo/artifacts…` and `kuvo/agents/…` answer with their 503 is "This Mac's coding
agents aren't running." with why (`run/agents-stopped`), and that Restart on the Mac starts them unless
they're being tried again. The box carries its group chats' mail (`seat`, "Peers")
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
    key, relay secret and signing key, from the Keychain, never asking you to unlock it; `503` while
    the link isn't wanted or the Keychain won't give them (read again a minute later while it was
    locked);
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

What a phone asks, it answers itself, as a machine's bridge does, with the app open or closed:
everything but the Mac's own routes, below (from #191 step 2, `kuvo/info` among them). Before, it
answered only the areas that had moved onto it (a list of them, which the app kept a copy of), and
handed the app the rest: its phones (`kuvo/phones…`), `kuvo/file`, `kuvo/sign-in/return`,
`kuvo/accounts/credentials`, `kuvo/shell/<id>/stop`, the engine's API and the coding agents'
(`api/…`, `kuvo/agents/…`, telling who a message names with `&`; bridge 0.9.64), `kuvo/named`
and `kuvo/groups…` (bridge 0.9.65), and a session's Autopilot (`kuvo/sessions/<id>/autopilot…`)
and move to the coding agents (`kuvo/sessions/<id>/agents`, bridge 0.9.209) were among them. While its
engine starts, or starts again, the engine's routes answer `503 {"message": "This Mac's engine is starting. Try again in a
moment."}` (a machine's say "This machine's"). From 0.9.66, once the app has given up on it (no try
can help; the app's `run/engine-stopped`, why, until it starts or stops it again),
they say "This Mac's engine isn't running." with why, and that Try Again on the Mac starts it (or
from 0.9.201, while it waits for its next try, `run/engine.retry`, that it's trying again); and a
machine's, while its keeper's next start is more than half a minute away (`run/engine.retry`, when,
in seconds since 1970), "This machine's engine keeps stopping. It's started again in about N
minutes." The Mac's own routes (`MAC_APP_ROUTES`, the one list of them: `kuvo/machines…`,
`kuvo/hosts…`, `kuvo/usage…`, `kuvo/asks…`, `kuvo/mac`, `kuvo/claude-code`, `kuvo/engine/…`), it
hands the app (`link/route`), as it comes, whether its app or its keeper runs the box (the keeper's
host passes on the app's answer as it came, `x-kuvo-answer` with it), `503 {"message"}` at once when
the app isn't answering (of its machines and hosts it says what it can itself then: "Machines").
The app answers those alone, and hands its box everything else it's asked, its own requests
too (`BoxClient`), so a route a box gains needs no list. Mail your
machines send it, it takes itself, as a machine's bridge does ("Peers"): their documents (from
0.9.62), and their agents, letters and group chats' mail (from 0.9.63).
What it asks the app goes through the app's `hello` proof first (the host interface, above), and
the link's keys (`link/identity`) are never asked of a host that hasn't given it. When the app's
host interface starts again (it failed, or Try Again), what the link has open through it ends: a
phone's followed `link/route` streams end (the phone follows again), and a request in the gap is a
`503`. While the keeper runs the box, the record in `run/host.json` is the keeper's alone: the app's
own host interface failing or starting again leaves it, and the app tells the keeper where it
answers now.

For the app only (anyone else gets `403`):

- `PUT kuvo/link/config {"phones", "machines", "relay", "name", "app"}`: whether the
  phone link is on, whether there are machines to meet, the relay (`ws:` or `wss:`), and the Mac's
  name and version as phones are told them. The link is up while the phone link's on with a phone
  paired or a pairing waiting, or there are machines. Its keys are asked for before this answers,
  so a pairing link can be made right after. Answers the link's state. The app says it again each
  time the box starts, and the box keeps what it last said (from #191 step 2; it kept none before) in
  `box/run/mac-link.json` (`0600`): the phone link on or off, the relay, the name and version,
  never its keys nor whether there are machines. A box that starts before the app says it (the
  keeper's, at login with Background Work on, the app closed) takes it from there, with whether
  there are machines from the app's list of them (`box/machines.json`, one that won't read
  counting), so this Mac is back on the relay for your phones and machines before the app opens:
  the phone link turned off stays off, and machines you've removed don't bring it back. Its keys
  come through the keeper's host interface then, which never asks you to unlock your Keychain
  for them (while it's locked, they're refused at once, never with a prompt that would hold up
  the keeper) and reads them again a minute later while it was locked. The app also says it again when the phone link is turned on or
  off while it's open. An older app also sent `features`, what it answered: the box says that
  itself now (`kuvo/info`, its agents' mail), and leaves it.
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

Its routes are answered there for every client: a phone's through this Mac's link, and the Mac
app's own, which reach every box's routes the same way (`BoxClient`: this Mac's through the app's
`PhoneLink`, which hands all but its own routes on, a machine's through `kuvo-link.js box route`
over SSH). What only the app answers is described below.

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
  `worktrees` (bridge 0.9.207), `{"<folder>": "<project>"}`: the project each of the box's worktrees
  belongs to, by the folder its sessions run in (and its top folder), for those it keeps, those it
  removed that can come back and those removed before; and each project's git worktrees made
  elsewhere (`git worktree add /tmp/try`; as its repository lists them and they name it back, by
  their real paths, looked for again every 15 seconds or so, off the box's thread; not one that's a
  project of its own; #422). A client files a session whose folder is
  here under that project, never as a project of its own; the events line changes with them. A box
  from before doesn't say: a client goes by `kuvo/worktrees` then.
  Each project's other folders are here too, under it (not one that's a project of its own, nor a
  removed project's), and a worktree of one of them is its too, so a session started there shows
  under the project (#311).
  A session filed under another folder than its own carries it in its metadata from when it's made,
  `kuvo.filed` `{folder, project}` (as the box names them): one a box's `kuvo/sessions` starts in a
  worktree, in a project's other folder or a folder in one, or in the folder its starter is filed
  from; and one a client makes in a worktree it just made with `POST kuvo/worktrees` (it gives it
  itself). A client may hear of the session from its engine before this list names a new worktree,
  and the list never names a subfolder: one whose folder the list doesn't name, still running in the
  folder its `kuvo.filed` names, is filed under that project (#311).
- `PUT kuvo/projects?directory=<folder>` with any of `{name, folders, run, terminal, removed}`
  adds the project or changes what's given (an empty string is none), and brings a removed one
  back unless `removed` is true (a client's copy of one it removed, with its settings):
  `200 {project}`; 400 for a folder that isn't a whole path. The folder is kept as it's named,
  as its sessions run there (a link isn't followed), and whether it's there now or not (a drive
  that's away).
- `DELETE kuvo/projects?directory=<folder>` is Remove Project: every session of it, its worktrees' and
  other folders' too, and those filed under it from elsewhere (`kuvo.filed`) (removed worktrees included, and the folders an optional body `{folders}` names: those a client
  shows under it that the box doesn't know, worktrees removed before it kept them), archived on
  the engine and the coding agents' bridge, older ones included, then it's marked `removed`.
  `200 {archived}`; `409 {message, archived, kept}` when some couldn't be archived (it stays
  listed); `503 {"message"}` while its engine doesn't answer, the coding agents' bridge running
  or not (nothing is archived).
- `GET kuvo/projects/events`: `application/x-ndjson`, the list now, then again each time it
  changes.

#### Chats

A chat is a conversation of no project: one in the box's chats folder (`kuvo/info`'s `chats`). A
chat's session can carry a mark in its metadata, `kuvo.chat`, naming the folder it's a chat in (as
the session names it: `sessions.chat`, #571), so a client draws it as a chat from the session
itself, wherever it reads it (the engine's or the coding agents' bridge's list, a session read
again as its event comes, `kuvo/search`'s `info`, a session a move brought), not from its folder. A
mark naming another folder than the session's own is no mark: one moved out of the chats while no
box could take its mark off is never kept a chat by it.

The engine (2.2.5) and the coding agents' bridge make a session the newest for any write, its
metadata alone too, so a mark is written only as a session is made, moved or has its metadata
written (each of which made it the newest already), never on a session from before:

- a client gives a chat it makes its mark from the first (`SessionChat.mark`), as a box's
  `kuvo/sessions` does for one it starts;
- the box marks one made without it (by a client from before, or the engine: a chat's subagent), one
  moved (`session.moved`: a chat moved into a project loses it) and one whose metadata a client
  wrote whole without it (`session.metadata.updated`), as their events come;
- a move sets it as it is here as conversations come in ("kuvo/moves"): before they're imported,
  or, with a coding agent, as its bridge places them (`carry/place`'s `chat`) (kept among the chats,
  naming this box's folder; taken off in a bot's folder).

Nothing else writes it: a chat from before the mark that's only written to (a message, a new
title), or one changed while the box wasn't hearing its engine, stays without it. The box decides it
from its own chats folder (the same folder through a link counts too). Their APIs write metadata
whole, with nothing to say "only if it's unchanged": the box reads a session just before it writes
the mark, in its turn, and writes only when it's wrong (see "Session notes" for what can still be
lost). A client keeps the mark as it keeps the rest of
the metadata when it writes it back. A session without the mark (a chat from before, or on a box
from before `sessions.chat`, which marks nothing) goes by its folder, as before (the folder its
box's `kuvo/info` names, kept for when that isn't answered). What both apps read is `SessionChat`
(`Packages/KuvoClient`, ClientSessions).

#### Session notes

A session's metadata (its notes: `kuvo.*` and the rest) is written whole: the engine (2.2.5) and
the coding agents' bridge keep what a `PATCH api/session/<id>` sends as its `metadata` in place of
what was there (`{}` empties it; a key left out goes; a PATCH without `metadata`, a title or its
rules alone, leaves it as it is), with nothing to say "only if it's unchanged". So every writer
reads it, changes what it owns and sends it all back (the bridge keeps its own `kuvoAgent` and
`kuvo.messages` whatever is sent).

The box's own writers (#581: the chat mark, a new conversation's approval and any change to it,
Autopilot, an agent's answers, archiving by a tool or a project's removal, a carry to the coding
agents, the marks of a session it starts and of a bot it makes, a bot's rules repaired) each take
their turn on the session: in their process, and across the box's processes on that computer and
its coding agents' bridge by a lock folder per session in the box's `run/notes` (named for the
session's ID, so the engine's and the bridge's sessions alike). Each reads the session as it is
then, changes only its own keys on it, and writes it straight away. The bridge's writers through
the API (a branch's mark, a handoff's, a group chat seat's) take the same turn. A client's
`PATCH api/session/<id>` that comes through the box (a phone's, another computer's) waits for it
too, so the box doesn't write over it with what it read before (but see below).

A turn's read and its write are each cut short at half a minute, so none lasts more than a minute;
a lock folder older than that (65 seconds) was left by a process cut off: another process takes it
over then, and the box clears those as it starts. Another process waits for a turn's folder that
long at most, then goes ahead without it. While a box from before #581 runs beside a newer one (an
update taking over), the newer one waits for that box's one lock (`run/work/.notes.lock`, held for
its answers and archiving) as it would have, without taking it.

What can still be lost, as long as the engine has no "only if unchanged", is a write that lands
between a writer's read and its write (a few milliseconds), when it's

- a client's that doesn't come through the box: the Mac's app writes a session's metadata whole
  straight to its own engine (archiving or pinning it, say), taking no turn (an iPhone's, and the
  Mac's to another computer, come through that computer's box and wait for the turn, but are whole
  too: below);
- one that doesn't wait as long as a turn can last: a client's PATCH through the box gives up its
  turn after half a minute, its write still on its way, and a process that waited 65 seconds for a
  turn's folder goes ahead without it;
- a session's rules (`permissions`) written alone, outside a turn (a group chat seat's, the
  bridge's for an engine run of its own), against the box's approval writes, which send them whole;
- or a client's whole write made from what it read before the box wrote: the box's change is lost
  (the chat mark is put back as that write's `session.metadata.updated` comes; the box's other
  notes aren't).

A client writes back what it read with only its own change, as late as it can.

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
settings file of the box's own beside yours in its engine's settings folder (`opencode/opencode.jsonc`
under the engine's `XDG_CONFIG_HOME`: a machine's `~/.kuvo-code/config`, this Mac's
`KUVO_ENGINE_CONFIG`), never in your settings. opencode reads it with `opencode.json` and reads it
again as it changes, so what the box learns applies to the engine running now, with no restart: a
conversation going on uses it from its next message. (opencode 2.2.5 reads `OPENCODE_CONFIG_CONTENT`
only as it starts, `POST api/location/reload` stops every terminal and command and drops the
questions waiting on you, `PATCH api/experimental/config` takes only `shell`, and a machine's
`OPENCODE_CONFIG` is your settings.) The file's first line starts `// Kept by Kuvo Code`; one there
without it (yours) is never changed, and the box doesn't apply what it learned then (its log says
so once). A Kuvo Code from before this file never reads or removes it: after a downgrade, delete it
if you sign out of Copilot. An engine started before a box kept it there has the old layer in
`OPENCODE_CONFIG_CONTENT` until its next start. Today it's
GitHub Copilot's Claude models named with
`{"compatibility": {"supportsThinkingBlockBinding": false}}` (anomalyco/opencode#55160), only
while the box has a Copilot account: named in an engine's settings with none, Copilot counts as set
up there and its newest model becomes the engine's default, which fails every message left to it.
The model your subagents use (`subagent_model`, `kuvo/config`) is in it too, as `agents.<id>.model`
for the engine's subagents (`general`, `explore`) and your subagents (`mode` `subagent` or `all`,
not turned off) that have no model of their own: read after your settings, it would go over one
that has. None for a coding agent's model, which the engine can't run. With nothing to name,
there's no file.
The box learns them from its own engine: `GET /api/integration/github-copilot` (an account when its
`connections` aren't empty; an answer it can't read leaves what it learned, and it asks again with
the engine's next event: one just started answers 404 for a moment), then `GET /api/model`
(Copilot's models whose id starts `claude-` and that have a `family`; an account whose models
haven't come yet leaves what it learned), as it finds the engine; at once as the engine says an
account was added, removed, signed in to again or switched to (`credential.updated`,
`credential.switched`, `integration.updated`) and as its models change (`model.updated`: an account's come a moment after
its sign-in); every ten minutes at most besides while it's at work; and as a provider's models are
refreshed (`kuvo/accounts/<provider>/refresh`). On a machine, that's while its bridge runs (it has
peers or phones). It keeps what it learned in `run/compatibility.json` too. Whatever starts the
engine asks the box first: `kuvo-link.js engine-config` prints the `OPENCODE_CONFIG_CONTENT` it's
run with (the sandbox's note added, nothing of the providers', which would hold an old list over the
file until a restart), having brought a machine's integrations up to date (see
`kuvo/integrations`) and, where it's told the engine's settings folder (a machine's start scripts
export its `XDG_CONFIG_HOME`), the file to what the box learned (one an older box learned before it
kept it there). This Mac's app runs it as it starts its engine, after its box, which keeps the file
as it starts; a machine's start scripts do, so an engine started after a restart with no Mac there
reads it too. A box too old to know it starts its engine as before. A Mac sends none.

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
  {<bot on this computer, or a conversation that isn't a bot's>: why}, store: "keychain" | "encrypted", keptDays,
  agents, agentsWaiting?, tampered?, generations: {items, grants, paused}}` (`agents`: whether agents may use it
  on this box, below; `agentsWaiting`: its sandbox is on, and they may once the coding agents
  started before it came on have finished, which clients say as “Locked for now: some agents started before the sandbox was on. The vault opens when they finish.”); an item is `{id, kind: "login" |
  "key" | "file" | "note", name, sites, username?, fields, fileName?, readable?, signInOnly?,
  created, changed, used?}` (`sites`: hosts, a site's own and those under it; `fields`: the names of the values it
  holds, a sign-in's `password`, a file's `file` (base64), a note's `text`, a key's own); a grant
  is `{item, who: {bot} | {project: <folder>} | {everyone: true}, how: "own" | "ask", at}`; a bot's
  only while the bot is on this computer (one deleted or moved away can't use it, and isn't shown).
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
  `{id, at, what, item?, itemName?, kind?, bot?, botName?, session?, sessionName?, client?, mine?,
  site?, program?, how?, why?}`, never a value. `what` is one of `used`, `asked`, `allowed`, `declined`,
  `refused`, `added`, `changed`, `removed`, `granted`, `ungranted`, `paused`, `resumed`, `shown`.
  `client` names the client you did it from (`Mac`, or a phone's name, which phones may share);
  `mine: true` marks what the client asking did itself, by who it is: a phone by the key it paired
  with, a Mac by its proof's key (this Mac's app, and a Mac with the unlock key, as one Mac). A
  client says only what happened for its own lines and who and where for the rest. The box keeps
  who did each; no client hears another's key. A line an older box kept without who did it has no
  `client`, so no client reads it as its own; a client says what happened without saying who.
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

A call is a bot's when its conversation (or the one a subagent works for) is the bot's own, its seat
in a group chat (`kuvo.seat`), or a session it started for its work, or one of those started in
turn (`kuvo.by`): it uses the bot's grants, an Always gives the item to the bot, and the bot's pause
holds it.

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
  vault (a conversation's that isn't a bot's, by its root session), telling your phones
  (`category: "message"`, `data: {session}`, or a seat's `{group}`).

Every use first checks Pause, then the grant: `own` goes ahead, `ask` (or no grant, for an item
named) asks you and waits. An item you give through `vault_ask` "always" is granted on its own
(to the bot, or the conversation's project, never a home folder); "once", its next use within
half an hour goes ahead. A command's copies (`run/vault-run/`) go when it ends, when the box ends,
and as a box starts.

### Working outside the project

Settings › Permissions shows "Work outside the project: Ask" as the default, and every box keeps
to it, sandbox or not: opencode 2.2.5's agents allow `external_directory` on their own, so each box
writes the engine a plugin, `kuvo-defaults.js` in its settings' `opencode/plugins` (as it starts,
and back each minute if it's gone or changed), that gives the engine's agents
`{external_directory, "*", ask}`. The engine sets up plugins before it adds the rules in your
settings, and the last rule that matches wins, so your settings' rules (Settings › Permissions,
a project's, a conversation's) still decide. An agent that refuses everything keeps refusing.
Agents you add in Settings › Agents come from your settings, after the plugin, so they don't get it:
they work outside without asking unless a rule of yours says otherwise.

What Kuvo Code and the engine keep for an agent stays open after that ask, for the agent to open:
the box's `attachments` (and this Mac's app's `Attachments`; both keep a session's files in a folder
named after it, `attachments/<session>/…` (bridge 0.9.177), which goes as the box hears the session's deleted, or for
one deleted while it wasn't listening, once its engine and bridge both say it's gone, unless a
conversation marked `kuvo.branchedFrom`, `handoffFrom`, `carriedFrom` or `startedBy` (or one of its
own, back along such marks) still names its files; nothing goes while the bridge isn't running or
either can't be read, nor a session being moved, moved away, or a copy here let go of as its move
was taken back (`run/moves/ended.json` names its conversations for a week); a session deleted while
the box wasn't listening leaves the Mac app's folder as it is; this Mac's box is told the app's folder in `KUVO_MAC_ATTACHMENTS`, and the app lets a
machine's session's go itself), the agent's browser's downloads on a
machine (this Mac's panel browser saves to `~/Downloads`, which asks), the engine's long outputs
saved whole (`tool-output`), the repositories it reads (`repos`) and Plan's plans (`~/.opencode/plan`),
and the folders of the skills the engine finds (learned again when they change, `skill.updated`;
never `/` or a folder holding your home folder).

The agents bridge takes the same ask as one of the engine's defaults, for when the engine can't
say its agent's rules. From engine 2.2.7, a folder the engine has just opened or is reading again
lists its agents, integrations and skills at once with what it has so far, before its plugins are
set up (then says `agent.updated`, `integration.updated`), while `api/provider` still waits for
them. So the box asks for the providers first and reads those lists after, with the folder's
`x-opencode-directory` where it has one; an integration list with nothing in it is not read yet,
never "nothing signed in". An agent list in which no agent has the plugin's rules (its ask, then
`<data>/tool-output/*` allowed) has the bridge add the ask to each agent that would otherwise work
outside the project, where the plugin puts it: after the rule that lets it out (the engine's own
`* allow`), before your rules about folders outside, which still win; an agent your own rule lets
outside (`external_directory` allowed) is left as it is. A list read while the engine was too slow
to say its plugins are set up is used for that message only, and read again for the next. It doesn't take a coding agent off running on its own (`approvesAll`), so
Codex, Cursor, Grok and Antigravity keep their modes. Where the bridge sees a tool call (Claude
Code's every one, and what the others ask about), one whose files are outside the project asks
first (a command's line isn't read for them), weighed by their folders as the engine weighs its own
(`<folder>/*`: a rule for a folder's files holds for the folder itself, and "Always" allows that
folder, not the one above it). An
agent's own files are never outside (`ownsPath`), though your rules for what it does with them still
hold: Claude Code's plans, each project's memory, what it saved of a long output
(`projects/<project>/<session>/tool-results`), and its background commands' output in /tmp's
`claude-<uid>` when the sandbox runs it.

### Approval

How much a conversation's agent does on its own is kept on the box, with the conversation
(`approval` in `features`, bridge 0.9.180): every client shows the same one, and none guesses it from the engine's
rules. Plan mode stays the conversation's agent (`plan`), beside it.

- `askFirst`: edits, commands and the rest wait for your OK. `acceptEdits`: edits in its folders go
  ahead, commands still wait. `auto`: what runs inside the sandbox's walls goes ahead, what's beyond
  them asks (the engine's own file tools, which the sandbox doesn't hold, ask outside its folders
  as Settings › Permissions says); only where the whole sandbox runs (for a conversation on the
  coding agents, with their programs in it too). `fullAccess` (bridge 0.9.184): no walls and
  nothing asks, so an agent keeps working while you're away. Its commands (and a coding agent's
  own program in it) run as yours, outside the sandbox, with your SSH agent; no reviewer, no hard
  lines; its file tools go outside its folders too. Only once you confirmed it on this computer (a
  client asks you the first time you pick it), for a bot's conversation and its work as for any
  other (before bridge 0.9.188 bots had Auto at most). A bot's conversation from before there were
  approvals starts with this computer's default, as a new one (before bridge 0.9.189, Auto).
- Where one can't be had now, it fails closed: a conversation set to Auto asks first while the
  sandbox isn't running, and one set to Full Access comes down to Auto while it isn't confirmed on
  this computer. It stays set to what you picked, and comes back to it once it can.
- The sandbox's launcher tells conversations apart by the engine's `OPENCODE_SESSION_ID` in the
  command's environment: the box keeps an empty file for each session in Full Access here now
  (`run/fence/full/<session>`, a subagent's too) as a run starts, as a conversation is made or its
  approval or rules change, and as it follows its engine again (those at work then); a deleted
  session's goes; a subagent's file names its conversation, and goes when that conversation's
  approval changes. No command in the sandbox can write there, and one in it that runs the launcher
  again stays in it. Your own `!` commands carry no conversation, and run in the sandbox.
- In Auto and Full Access, which never hold the agent for you, its rules let it read `.env` files
  (the engine's own defaults ask first), before Settings' rules, so a Don't Allow there still holds.
- What the box writes is the engine's rules for it, made again with Settings › Permissions as they
  are (a Don't Allow there holds in every one, Accept Edits included) and its own folders kept (a
  folder Settings has a rule for is Settings' to say, bridge 0.9.187), a
  bot's as any other's (bridge 0.9.189, "Work › No built-in limits on a bot"). The coding agents' bridge sets each agent
  from the same rules. Kept in its metadata as `kuvo.approval` (what you picked) and `kuvo.applied`
  (what its rules were made for); rules a client changed on its own since (asks put back, say) are
  read as they are, and never made again. A conversation with none (`stored` false): asking before
  commands is Ask First. Nothing asking (Approve All) is, for one made before this box first kept
  approvals for new conversations (`since` in `box/approval.json`), Full Access, as it ran, whether
  or not you confirmed it here, its rules left as they are until one is picked; for one a client made
  since (a client from before, whose default was Approve All) with no tool held back as a whole,
  this computer's default, never Full Access unless that's the last one you picked (bridge
  0.9.185). One the box made itself (below), a subagent's, or one holding a whole tool back (a group
  chat's seat), never comes to Full Access unkept: Auto (a subagent's, read without its
  conversation, Ask First).
- A new conversation a client makes (feature `approval.default`): with `kuvo.approval` alone in the
  metadata it's made with, that one; with none, this computer's default: Auto the first time, then
  the last one you picked here (a conversation's `PUT`, or a start that says, a bot's too since
  bridge 0.9.189; never a subagent's), or Auto once Full Access, picked last, is switched off here (until you pick it again).
  Your Don't Allows on whole tools don't change that; one kept with an approval before, whose rules
  an older client changed since, is what its rules say, never the default again. The box keeps it
  with the conversation and makes its rules for it as it hears the conversation was made, and looks
  again at the newest each round for one it missed. One the box makes itself (a bot's, one an agent
  started, a group chat's seat, a handoff's, one moved to the coding agents, a reviewer's part, an
  engine's copy of a coding agent's conversation) is marked in the metadata it's made with, and
  keeps its own (a handoff's and a moved one's, the one they carry on from; an engine's copy runs
  as the coding agent's conversation it's for, reviewed and in Full Access as that one is). The coding agents'
  bridge keeps the metadata a conversation is made with, too. But a bot's and its
  work's, which the box keeps with the one their rules say (Ask First, or Auto that asks first
  without the sandbox), as it starts and as a bot is made or comes here, until you pick another
  (Full Access too).
- `GET kuvo/sessions/<id>/approval`: `{approval, effective, stored, held?, plan, options}`: what
  you picked, what it comes to here now (`held` `{reason, why}`, the last step down, when that's
  less), whether it's in Plan mode, and each one (`options`: `{approval, held?, unavailable?}`):
  `held` where it can be picked and asks first for now (Auto without the sandbox), `unavailable`
  where it can't be picked. `reason`: `sandbox` (Auto without the whole sandbox), `fullAccessOff`
  (and `bot` from a box before 0.9.188). Only a read: its rules come to what it shows within the box's round. 404 `{message}` for a
  conversation that isn't here, 503 with no engine or bridge.
- `PUT kuvo/sessions/<id>/approval` `{approval}`: sets it, on the engine's conversation or the
  coding agents'; 200 as `GET` answers (Auto without the sandbox is kept, `held`), 400 for one that
  isn't one of them, 409 `{message, reason}` for Full Access where it can't be picked
  (`fullAccessOff`), 502 where the engine didn't take it.
- `GET kuvo/approval`: this computer's `{fullAccess, default, auto: {engine, agents}, otherComputers?}`
  (`otherComputers`: whether your other computers may start work here, "Peers",
  Starts; `PATCH {otherComputers}` sets it alone): whether you
  confirmed Full Access here (`box/approval.json`), the one a new conversation starts with
  (`default`: what a client's composer shows), and whether Auto runs for each (`{held?}`, as
  above). A client asks you the first time Full Access is picked on a computer (the composer's mode
  menu: it isn't a setting), then sends `PATCH kuvo/approval` `{fullAccess: true}` before `PUT`ting
  the conversation's; 400 without a boolean `fullAccess` or `otherComputers`. A change brings what had it or was held
  from it to what it can be at once.
- A client's ⇧Tab in an empty composer goes to the next mode in the menu's order (`askFirst`,
  `acceptEdits`, `auto`, `fullAccess`, then round again), as picking it would: KuvoClient's
  `ApprovalCycle`. It passes over an option the box says is `unavailable` (so Full Access until
  it's confirmed here, which only the menu asks), as Claude Code's Shift+Tab passes over Bypass
  Permissions until it's allowed.
- The box looks every 2 seconds at what each comes to, and makes the rules of those kept with Auto
  or Full Access again when the sandbox starts or stops, the switch changes, or the engine or the
  bridge starts again, each read again just before it's written. As Settings › Permissions change
  (bridge 0.9.187: `PATCH kuvo/config`, `POST kuvo/config/apply`, which answer once they're made
  or after a few seconds while the rest goes on, or the file by hand, within a round, and as the box
  starts, for a change made while it was down), every conversation kept with an approval gets its
  rules made again with them, so no client has to.

#### Auto's reviewer

In a conversation that's in Auto here now (`approval.reviewer` in `features`, bridge 0.9.181; as
below since 0.9.185, `approval.held`), what its agent wants beyond the sandbox's walls is judged on
the box: a command it asks to run outside the sandbox (`sandbox_ask`), a file the agent's own tools
want to change outside its folder (the engine's or the bridge's `external_directory` ask, by the
file the tool call names (`~` your home, one not from `/` from its folder), where it lands: through its links, one to a name that isn't there yet too,
which a write makes and a read takes a look-alike beside, and shown so to the model; where no tool
call names one, as when Codex asks for room of its own, by
each path the ask names, judged as a write (`~` as your home, one not from `/` from its folder; a
folder that holds Kuvo Code's own is refused by code, bridge 0.9.187), and where it names none, by
what it asked, which the model judges; bridge 0.9.186). The flow comes first: it allows what the
work calls for, refuses only real damage and what you didn't ask for, and **never leaves a call
waiting on you**: a refusal goes back to the agent with the reason, and it carries on another way.
A conversation in Full Access is never reviewed (its command just runs, `Ran outside the sandbox ·
Full Access`); one in Ask First or Accept Edits asks you as before, and so does what your own
Settings › Permissions ask. Where the engine (or the bridge) doesn't answer for a moment, a
conversation is taken as the box last found it; one it never found then has its `sandbox_ask` held
back (`why: "failed"`, code's lines still refused), never left waiting on you (bridge 0.9.186), but
one the box marked as in Full Access, which runs (bridge 0.9.187).

What's a conversation's own is never reviewed by its agent's own file tools, as its folder isn't (the sandbox's walls for its commands are as they were), by where each file really is against where each of those folders was found (a worktree as it's found, the conversation's own folders as the box first saw the conversation, kept in `box/found-folders.json` across restarts: one traded for a link since takes nothing with it), and never what's walled from it wherever it is (Kuvo Code's own but the conversation's own in them, what runs later or at login, your secrets and your own settings, all of `~/Library` (the parts the sandbox opens to commands too: its caches, logs, Xcode's `Developer`) but iCloud Drive's own (`Mobile Documents/com~apple~CloudDocs`, not other apps' folders beside it; an exception matched as the disk matches names, never wider) and what's the conversation's own in Kuvo Code's folders there, a repository's `.git/worktrees`; on a Mac by any case Unicode has, as its disk folds names), each judged as anywhere. Every resource the engine asks about (named from `/`, `…/*` a folder), the file it says it asks about, every path argument of the call (however deep, to a point) and a patch tool's headers (read as the engine reads them) must be reached plainly so: from where the folder was found, no link below it, no `..`, no control or separator character, `\` or character a disk may skip as it compares names (a joiner, a direction mark), each name below the folder the same composed and folded by case (the folder's own path the box found itself), a file with no other name; and only for a tool known to write (the engine's write, edit and patch; Claude Code's Write, Edit, MultiEdit and NotebookEdit; Codex's changes), to read, or to run a command (by its folders), never one whose call can't be read. It's checked as the ask comes: the engine's write follows links as it writes, so a command that puts one in place between the answer and the write isn't caught here (the sandbox's plugin gives a file tool's path in the conversation's folder as where it really leads, as it runs). Its own: its folder, its project's other
folders, the files sent with it, its commands' temporary folder, a bot's own and its projects, and,
for one at work in a project's main folder, the project's linked git worktrees wherever they are
(`git worktree add /tmp/try`: each its repository's `.git/worktrees` lists, that folder and the
entry where they're named, whose own `.git` names it back; what runs later there, and Kuvo Code's
own, still judged; never one in Kuvo Code's own folders, another session's, nor one where an agent in Auto
couldn't start a session: your home or a folder holding it, a whole personal folder, your secrets,
what runs at login). A conversation in a linked worktree has only that one: the project's main
folder and its other worktrees stay the reviewer's.

- Code first, only for what's never allowed, refused and the model never asked, and never held back
  for you: Kuvo Code's own folders (read or written, a script run from them), and wrecking your
  home (deleting it, moving it away or locking you out of it: `rm -r`, `mv`, `chmod -R`, `find
  -delete`, `rsync --delete` and the like, past `sudo`, `xargs` and the rest, of your home, a folder
  that holds it, or everything in it). A command is read as a shell runs it (quotes, redirects,
  `cd`, a shell's `-c` script); one it can't read plainly (`$…`, a group, a here-document) is
  refused where its text names one of those. The agent's own tools reading a file outside its
  folder go ahead with no review, but your secrets (a private key in `~/.ssh` by any name, what the
  sandbox keeps as secrets), which the model judges.
- Code holds back, too, what changes your own settings for every project, unless what you said
  (or the bot's goal) names it (`why: "unasked"`, with what the agent does instead): your global git
  settings (`git config --global` or `--system` setting a value, `--file ~/.gitconfig`,
  `~/.gitconfig`, `~/.config/git/config`, `gh auth setup-git`), your SSH keys (a key, `config` or
  `authorized_keys` written in `~/.ssh`, `ssh-keygen` making a key there), and your sign-ins' files
  (`~/.aws/credentials`, `~/.netrc`, `~/.npmrc`, `~/.docker/config.json`, `~/.kube/config`, gh's,
  gcloud's, the coding agents' and opencode's sign-ins, keychains and the like; `npm config set` but the project's, `aws configure`, `gh auth
  login`, `docker login`), past `sudo -u`, quotes and `$HOME` in a line read by its words. Reading a
  setting, making `~/.ssh` and trusting a host in `known_hosts` aren't changing them. Words that only
  sound like it ("the login page", "a global handler") don't name it. Named, the model judges it,
  told what it changes.
- Everything else is the model's: your secrets (routine use allowed, printing, archiving or sending
  them off refused), Docker and its like (bringing a container up to test, reading its logs:
  allowed; one given `/`, your home, your secrets or the runtime's socket: refused), what writes
  elsewhere in your home, deletes, and the rest. Payments, messages to people, new accounts, giving
  access, force pushing or deleting remote branches, publishing publicly and production deploys are
  refused unless what you said (or the bot's goal) plainly asks for that very thing. What would run
  at login or on a schedule (writing your shells' start-up files, `LaunchAgents`, systemd's and
  autostart's folders; `crontab` (from a pipe too), `at`, `launchctl load`/`bootstrap`, `systemctl
  enable`, timers by `systemd-run`, `brew services start`, `pm2 startup`, a container that restarts
  always, login items by `defaults` or `osascript`) is found by code, on macOS and Linux, and the
  model is told so: allowed only where what you said plainly asks for that kind of thing.
- The model is the conversation's own maker's small one: the provider's (Haiku, Flash, mini…) for
  the engine's conversations, through `/api/experimental/generate`; the agent's for the coding
  agents' (Claude Code's Haiku, Codex's Luna), through the bridge's
  `POST /api/session/<id>/generate` `{prompt, model}` (a model of that session's maker only); the
  conversation's own model where the maker has no small one. It's counted on that account. It's
  shown only what you wrote in the conversation (never what the box, another agent or a wake-up put
  there), and for a bot's, its goal too, with the plan you approved by starting it; where it works as
  its own (its folder, then its project's other folders and worktrees); for a session another agent
  started, the task it was started with (its first message, the letter from `kuvo.startedBy`), as
  that agent's words, never taken for yours; the action (for a
  file, the tool and its arguments); and what a command runs, read whole first: a script by its
  path, `bash x.sh`, `python x.py`, and the project's build files its program runs (`package.json`
  for npm, pnpm, yarn and bun, a Makefile, a justfile, `conftest.py`, `build.rs`, Gradle's, a
  Rakefile, a Taskfile). One too long to read whole that's the project's own (in the
  conversation's own folders, tracked in its git) is read in part, told as that: its start, and its
  changes not yet committed, whole (a test file was never all a command runs: the modules it
  imports aren't read either); one whose changes are too long too, or isn't the project's, is held
  back (`unread`). Each piece is in tags of that prompt's own, so none can pass for the
  rules. Never the agent's own words, its `why`, nor what its tools printed.
- A script from the web (`curl … | sh`, `bash -c "$(curl …)"`, `eval "$(curl …)"`, `wget -qO- … |
  sh`, `<(curl …)`) is
  fetched once, as the review starts, into Kuvo Code's folder (`run/fetched/`, emptied as the box
  starts), read whole (up to a limit, whatever length the server says), and judged by the model;
  every fetch of it in the command is rewritten to read that copy (`cat '<copy>'`), so what runs is
  exactly what was reviewed, never a second fetch. The copy is deleted once the command ran, or
  won't. A line it can't pin so (one that downloads a script, by `-o`, `>` or `tee`, or fetches and
  unpacks or clones, then runs a script by name; one that fetches inside another shell's `-c` line;
  or fills the address in itself) is held back with how to do it instead, and so is an ask the
  engine runs itself (in a bot's work), which can't be pinned. Never fetched from this computer's or
  its network's own addresses (`localhost`, private, link-local and loopback ones, `.local`
  names), by a name that leads there or a redirect on the way: held back (`unread`).
- It allows (the command runs outside the sandbox, `Ran outside the sandbox · Allowed by Auto's
  reviewer: <reason>`; the engine's ask is answered once), or refuses with a reason the agent
  hears (the engine's ask is rejected with it): `Auto's reviewer refused: …` for a code line,
  `Auto's reviewer held this back: …` for the rest, telling the agent you can approve it. What it
  can't judge is held back the same way, never allowed: a local script it runs that can't be read
  whole (`why: "unread"`), one from the web it couldn't fetch or pin (`unread`, `unpinned`), an
  answer that isn't one JSON object with a known decision (`unreadable`), no model (`noModel`), or a
  model that fails or doesn't answer within a minute, or a review that fails on the box's side
  (`failed`: no quota, offline). A model that answers `ask` refuses (`reviewer`).
- Once the model allows a change the agent's own file tool makes (never a folder a command goes
  to, nor room asked for), a change its file tool makes in the same place goes ahead again without
  the model for the rest of the conversation (#422: the same kind of action in the same place gets
  the same answer), and isn't kept as a decision. The place is the repository the file is in (its
  working folder), or else the file's folder, worked out again for each change, which must be that
  very place (a folder in a place that isn't a repository, or a repository inside one, is another);
  none where that holds the conversation's own folder or another repository, where an agent in
  Auto couldn't start a session (above), what runs later outside the sandbox (the folders on PATH,
  tools' settings, `~/Library`), or Kuvo Code's own. Never for a change to your own settings, your
  secrets, what runs at login, what runs later (the same), or git's hooks and settings and the
  agents' (on a Mac by any case, as are your settings and what runs at login), each judged on its
  own. A place new to the conversation is a decision of its own (`Change <place>`, "Auto allowed
  edits in <place> for this session.", with `place`), which any client can take back (`revoke`,
  below); one past the last 50 is taken back by itself, and every one as the conversation leaves
  Auto; a review under way as they're taken back stores none.
- Three refusals in a row, or twenty in a conversation, pause Auto there: its run is stopped, and
  what it wants next is held back (`why: "paused"`) until you let it go on or approve one. Those for
  want of a model (`noModel`, `failed`, `unreadable`) don't count; the model's allow starts the
  count in a row over (code's own allows, a place's among them, don't: an agent can't reset it with
  what it may do anyway). A review that can't be had at all
  (a full disk) is refused with why (`failed`), never asked.
- `GET kuvo/sessions/<id>/decisions` → `{decisions, paused?, seen?}`: the conversation's decisions, the
  latest last (the last 200), each `{id, at, action, kind, decision, reason, by, why?, held?,
  approved?, used?, place?, revoked?}`: `kind` `command`, `file` or `tool`; `decision` `allowed` or `refused`; `by`
  `code`, `model` or `you` (one you approved, run again); for a refusal, `why` (above), and `held`
  where you can approve it (then `approved`, when you did, and `used`, when it ran again). Code's
  own allows (a read outside its folder) aren't kept. Decisions from before bridge 0.9.185 may say
  `asked`, or `why: "always"` with which kind in `always`. `paused`: since when Auto is paused
  there. `seen`: when you last looked at them on any client; one held back with an `at` after it
  is news, which a client shows over its composer (bridge 0.9.187).
- `POST kuvo/sessions/<id>/decisions` `{revoke: <id>}` takes back a place (a decision with
  `place`): each change there is judged again; the decision gets `revoked`, when. 404 for one that
  isn't a place, or is taken back already.
- `POST kuvo/sessions/<id>/decisions` `{approve: <id>}` approves one held back, from any client:
  allowed once, the next time the agent does it the same way (a command in the same folder running
  the same scripts as read then: one changed since is judged again; the same file with the same
  tool arguments; the same tool and arguments), without the model; the conversation is told at once (a
  steered message: `[The user approved what Auto's reviewer held back] <action>`, shown as "You
  approved: …"), and a paused conversation goes on, its counts started over. 404 for one that isn't
  held back (approved already, a code line, gone). `{resume: true}` lets a paused conversation go
  on, its counts started over. `{seen: true}`, as you open them on a client, marks what's held back
  by now as seen there and on every other client (`approval.seen`). 400 without any of these, 500
  where it couldn't be kept. Kept in the box's folder
  (`box/reviews/<session>.json`), for any client, and deleted with the session.

### Autopilot

Whether a conversation's agent decides for itself or asks you (`autopilot` in `features`, bridge
0.9.200): a conversation, a chat or a bot's conversation and the sessions it starts. It's beside
the conversation's approval, never part of it: approval says what may run without asking, Autopilot
what may be decided without asking. Every conversation is Interactive until it's turned on.

- `GET kuvo/sessions/<id>/autopilot`: `{autopilot, decided}`, the calls it made, the latest last
  (each `{id, text, choice, why?, options?, multiple?, session?, call?, at, yours?}`: the question's
  form (`<form>/<field>` where a form asks several, each a call of its own), what it asked, the choice
  it went with and why, the choices it had (`multiple`: it takes several, joined with ", "), the session that asked where it's
  a subagent's, the tool call that asked it (the form's `metadata.tool.id`, where it has one: a
  client shows the call at that step; a subagent's at the subagent, and one with no step here under
  the conversation), and your choice since). 404 where there's no such
  conversation. The agents bridge's questions carry `metadata.tool.id` too, as the engine's do, and
  what isn't its agent's question keeps its kind there (an MCP server's form, `mcp-elicitation`).
- `PUT kuvo/sessions/<id>/autopilot` `{autopilot: bool}`: on or off; the answer as `GET`'s. It's
  kept with the conversation (`metadata.kuvo.autopilot`, false once off), and its agent is told how
  to work in its instructions (`kuvo.autopilot`), taken out again when it's turned off: decide what
  its own research settles; what only you can do (paying, signing in, making an account, handing
  over a key, anything destructive that can't be undone) never gets asked: it leaves that step undone,
  carries on and lists what's left in its final reply. It marks the choice it recommends in anything
  else it asks.
  Its agent is told before it's marked on, and it's marked off before its agent is told: 502 where
  the engine didn't take it, and the conversation stays as it was. Turned on, what it asks already
  goes ahead or comes back declined then.
- On Autopilot, a question the conversation's agent or one of its subagents asks with the question
  tool that marks a choice `(Recommended)` in each field it needs goes ahead on that choice at
  once: the box answers the form (`POST …/form/<id>/reply`) and keeps it in `decided`; your phones
  aren't told of it, and a session that started it isn't woken for it. Nothing waits for you: one
  that marks none, asks for a secret (a field with `format: "password"`) or isn't the question tool's
  (an MCP server's form) comes back declined (`DELETE …/form/<id>?message=`), with nothing chosen or
  filled in and words telling its agent to leave that step undone and go on; a coding agent hears those
  words (Claude Code as why it was denied, Codex and Grok as its answer, an engine model as the engine's
  decline), except Antigravity, which can only hear it was cancelled, though its step keeps the words. One that's still asked once the box has looked (the engine didn't take it, or you
  have its goal paused) waits for you, and they're told. What its conversations asked while the box
  couldn't hear (it started again, or its engine did) is dealt with as it catches up. What an MCP
  server asks in a folder, filed under no session (`global`), is declined only where it holds nothing
  but conversations on Autopilot (a tool of that server at work in them, and in no other there). So
  is a sign-in, a code or a step the browser would ask you for, or anything the vault would: each comes
  back at once, left undone, and a project it would ask you about stays asked while it carries on.
  What it was already waiting on when Autopilot is turned on stops waiting the same way, within a few
  seconds. A coding agent's engine run (Auto's, `kuvo.engineFor`) counts as the conversation it runs for.
  The vault's activity keeps a use left undone as `refused`, `how: "autopilot"`, and an SSH command of
  yours (by its folder, not an agent's) isn't left undone, even in a bot's folder. A sign-in the vault
  lets it use on its own still goes ahead. Its permissions are its approval's, and wait as ever. A step
  turned down this way is a failed `question` tool with those words, which clients show as set aside;
  Grok's completes under its own name, with the words as its answer, and Codex's `requestUserInput` is
  no step at all, so neither shows it. Codex asking again and again, turned down each time, ends its
  turn on the third; a question of its for a secret is answered with nothing, not the words.
- `POST kuvo/sessions/<id>/autopilot/asked` `{form}`: whether a question asked in the conversation
  or by one of its subagents waits on you: `{waiting: bool}`. A client that hears a question asked in
  a conversation on Autopilot asks this before it counts or notifies, and goes by the answer: it
  doesn't read the question's marks. The box deals with it first, whichever comes first, so the answer
  needs no waiting. False once it's gone; true for what your paused goal or the engine leaves asked, or
  what the engine won't list. A client that gets no answer (the box is unreachable, or from before
  this) treats it as waiting, like any question.
- `POST kuvo/sessions/<id>/autopilot` `{decided: <its id>, choice}`: your choice on a call it
  made, kept as `yours`. The one it goes by now (your last, else its own) confirms it quietly;
  another tells the conversation `[Decision changed] For "…" the user picked "…", not "…" as you
  decided. …` (`… the user now picked "…", not "…".` after a choice of yours; a box note, `You picked
  …`). The agent's words are quoted on one line, so they can't pass for the box's. 404 where there's no such call, 502 where the engine didn't take it (your choice isn't kept: make it again).
- A session a conversation starts (`start_session`) takes its Autopilot, and a client can start one
  on it with `autopilot: true` in `POST kuvo/sessions`.
- A bot's goal and its bot's conversation are one setting: a goal started or switched to a `mode`
  ("Work", Goals, Interactive or Autopilot) puts the conversation and the sessions at the goal on
  it (what the switch can't reach, the box's next look does), and the conversation turned on or off
  here switches its running goal (the bot told as for `{action: change, mode}`). One of those
  sessions turned on or off by itself stays so until the goal's next switch. When the goal ends
  (stopped, finished, or its end come), they go back to Interactive, unless the conversation was on
  Autopilot before it started. A call
  made in its conversation, or its work's, shows in the goal's `decided` too
  (`ask:<conversation>:<form>`), as one call: your choice on it, on the goal
  (`{action: decided, decided, choice}`) or here, shows on both and tells the conversation that
  asked. While you have the goal paused, nothing goes ahead.
- It goes with a conversation: carried on with the coding agents (a model of theirs picked) or moved
  to another computer, it stays on Autopilot there, its agent told, and its calls come along
  (`run/work/decided.json`; `decided` in a move's bundle).
- On the coding agents, Claude Code's, Codex's and Grok's questions go ahead the same way; Cursor
  can't ask, so Autopilot changes nothing there but what its agent is told. Codex's own question
  tool (`request_user_input_async`) doesn't wait, so its turn goes on or ends while its form is up:
  the form goes up as it's asked, on Autopilot and off, and stays up after its turn ends; its answer
  goes into the turn under way (`turn/steer`), which ends a sleep the model is in, or starts its next
  turn.

### Sandbox

Each box runs its agents' commands in a sandbox (`sandbox` in `features` and its asks, `sandbox.asks`, bridge 0.9.118) wherever
it can, with no switch: the way out is per command (the card that asks you about one it refused).
On, each command the engine runs (an agent's shell tool, and yours with `!`) reads everything but
what's below, and in your home folder adds and changes files (`homeWrites`) but never deletes or
moves one there (on macOS, Seatbelt's `file-write-unlink`, which a move takes too, is left out; on
Linux, Landlock's `REMOVE_FILE`, `REMOVE_DIR` and `REFER`, so nothing's linked in either), and never
writes what runs later outside the sandbox: your shell's start-up files and plugins (`.zshrc`,
`.bashrc`, `.profile`, `.config/fish`, `.oh-my-zsh`, zsh's completion dumps…), the folders on your
PATH (any in your home, whatever it's named) and version managers' (`.local/bin`, `bin`, `.nvm`, `.pyenv`, `.asdf`, mise's…), Python's user
site, what direnv and mise trust, SSH's `config` and `authorized_keys`, git's settings and templates,
the coding agents' and editors' settings, hooks and extensions (`.claude`, `.claude.json`, `.codex`,
`.cursor`, `.gemini`, `.grok`, opencode's, `.vscode`, `.config/nvim`…), tools' settings that name
programs or package sources (`.bunfig.toml`, `.docker/cli-plugins`, `.config/gh`, `.config/pip`,
`.gemrc`, `.gnupg`…); on Linux systemd's, autostart's and environment.d's folders and the desktop's
start-up files; on macOS `~/Library` but its `Caches`, `Developer`, `Logs`, iCloud Drive and
provisioning profiles (`homeKept`, `homeOpen`), and the window and key tools' settings (Hammerspoon, Karabiner, skhd,
yabai, AeroSpace, SketchyBar). Your personal folders (`personal`: on macOS Desktop, Documents,
Downloads, Pictures, Movies, Music and iCloud Drive; on Linux those `~/.config/user-dirs.dirs` names)
only take new files on macOS (no `file-write-data`, `-unlink`, `-mode` or `-flags`: a file's own
first open still writes it), and are only read on Linux, where Landlock can't tell a new file from
one that's there. The conversation's folder, its repository and Also Allowed are written whole
where they're inside a personal folder, what runs later or `~/Library` (a project in Documents,
`~/.config/nvim`), and around them where they hold some (a conversation in your home itself
writes none of those). An agent in Auto (`start_session`, or `POST kuvo/sessions` with
`startedBy`) never starts one where its commands could do real damage (bridge 0.9.184): your home
or a folder that holds it, a whole personal folder (`~/Documents`; a project in one is fine), what
runs as you log in, your secrets or Kuvo Code's folders, or a folder that holds any of them
(`~/.config`, `~/Library`); 403 with why. Its own conversation's folder and your projects are
always its; one in Full Access starts one anywhere, and you do too. It starts where the folder
really is as it's checked.
Its repository is only ever a folder named as one (`.git`, `….git`), else its folder alone: a
command could make what looks like one anywhere it adds files, then a folder whose `.git` names it.
Tools' caches inside what's kept (pnpm's store in its folder on your PATH on macOS) are still
written, and on macOS clone and remove repositories of their own (Xcode's packages, cargo's). On macOS no command writes preferences through cfprefsd either (`defaults
write`: Seatbelt's `user-preference-write`), which reach launchd's and login items'. On macOS no
folder that holds what's kept (your home, `~/.ssh`) is closed off by its mode or flags either. On
Linux, nothing is made or removed right in a folder that holds what's kept (your home, `~/.config`,
`~/.local` and the like), only in the folders there: Landlock grants each thing that's there. Besides, each command
writes and deletes freely in its conversation's folder, that folder's git repository (a real one: a `.git` that's
a link, or names a folder that isn't a repository or a worktree the repository doesn't name back,
counts for nothing; never its hooks or config, its submodules' or its worktrees' (on Linux, as
below; on macOS by their names, so not where a `hooks` that's a link leads, nor a repository its
`commondir` already names, #422), nor, on macOS, the engine's settings in the folder: `.opencode/`, `opencode.json`, nor the coding agents' settings
files, whose hooks and servers they run as they start there, nor, on macOS, any other project's in
your home: `.claude/settings.json` and
`settings.local.json`, `.mcp.json`, `.codex/config.toml`, `.cursor/hooks.json` and `mcp.json`,
`.gemini/settings.json`, `.grok/settings.json`, and the scripts in `.claude/hooks` and
`.cursor/hooks`; a folder moved or linked into place is checked only by its own name, so the folders
that hold those, `.git`, a submodule's or a worktree's repository in it (`.git/modules` and
`.git/worktrees` themselves, and every folder below `modules`, a worktree's own `modules` too, but
for the folders below a submodule's own `objects`, `refs`, `logs`, `lfs` and `rr-cache`, which git
keeps as it fetches; so in the sandbox a submodule gets none of those it hasn't already, nor what a
rebase, `git am` or a cherry-pick of several keep in it, nor a nested submodule set up: those run
outside it, with `sandbox_ask`) and the
agents' `.claude`, `.codex`, `.cursor`, `.gemini` and `.grok`, can't be made, moved or removed, only written in, and
neither can the conversation's folder itself and its repository's, so neither is traded for a link to
another bot's), its conversation's own temporary
folder (`TMPDIR`; on Linux it can be emptied but not removed, as in the command's namespace it's mounted in place, `HIDE` in fence/landlock.ts), its conversation's wake-ups' inbox (below), its bot's memory (`MEMORY.md` in the folder of the bot
whose conversation it is; for its seat in a group chat, the bot the agents bridge names
(`KUVO_FENCE_BOT`, from the seat's `kuvo.seat.bot`), or, run by the engine, the bot whose own folder
(not a link) it works in: that file alone, and only while it has no other name (a hard link), read
and written in place (its times set too), never made, moved or removed; on macOS, beside it, the new files
Claude Code saves it through (`MEMORY.md.tmp.<pid>.<random hex>`, as of 2.1.319: it saves a file whole
in one first, and writes it in place when the rename onto it is refused), by that name alone, made,
written and removed, never a symlink or folder (a hard link only of a file it writes anyway), never
moved onto it (Linux refuses making them with EACCES, which sends Claude Code
straight to writing in place); a coding agent's conversation named to the
launcher as the engine names its own, `OPENCODE_SESSION_ID`), the system's temporary folders, devices and tools'
caches, but not what in them runs later outside the sandbox (installed programs like
`~/.cargo/bin` and `~/.bun/bin`, tools' settings and start-up scripts, what your shell profile
sources from them (`~/.cargo/env`, `~/.deno/env`, `~/.bun/_bun`), npx's packages, the caches of
pre-commit, pnpm, uv and corepack in `~/.cache` and your own `XDG_CACHE_HOME`, and what zsh loads
from there as a terminal starts (p10k's instant prompt and state, by your account's name, and on
macOS any `p10k-` file, as p10k moves each into place; gitstatus, oh-my-zsh's and prezto's
completions, a `zsh` folder of your own, antidote, zsh4humans, oh-my-posh), pnpm's and antidote's in
`~/Library/Caches`, on macOS mise's trusted configs in `~/.local/state` (not on Linux, where keeping
them would stop commands making new folders there), and on macOS bunx's packages in your temporary folder; on macOS no folder that
holds those, your secrets or Kuvo Code's own is moved, removed or cloned whole, which would leave
what's in it under another name, nor one that isn't there yet made a link, though it can be made as
a folder, so moved into place). Its npm, pnpm (11 and
later), uv and corepack use caches of Kuvo Code's own instead (`npm_config_cache`,
`pnpm_config_cache_dir`, `UV_CACHE_DIR` and `UV_TOOL_DIR`, `COREPACK_HOME`: `cache/sandbox-…`,
on this Mac in the app's `Library/Caches` folder), with pnpm's global virtual store off
(`pnpm_config_enable_global_virtual_store=false`: with it, `pnpm dlx` runs a package from the copies
in your pnpm store, which your own pnpm runs later; so in a project you set to use it, the sandbox's
`pnpm install` stops, as pnpm won't change a project's store without asking in a terminal, and
leaves it as it is: the agent asks with `sandbox_ask`), and on Linux uv copies what it installs
(`UV_LINK_MODE=copy`). What it can't close yet, on Linux: a file linked to one it may write, as pnpm's
store and Bun's cache link theirs into a project's `node_modules` and pnpm's into its `dlx` cache, and
as your own uv links its cache's into a project's `.venv`; bunx's packages in `/tmp`; and a new
folder at the top of `~/.cache`, which it can't make (Landlock's right to make one would reach the
folders it only reads); other projects' hooks, git settings and agents' settings in your home, which
it writes as it writes the files beside them; the engine's and the coding agents' settings in the
conversation's folder; and, in the repositories it works in on Linux (below): a repository in the
folder but its own, one there already (a vendored one, a submodule whose `.git` is a folder in it)
or one a command makes (in a folder with no repository, `git init` and a hook in one command; in a
repository, one it then adds to the index as a submodule, whose settings a plain `git status`
outside runs); a worktree kept inside the project (`.claude/worktrees/x`) but the conversation's
own, whose `.git` file a command can lead to such a repository; a submodule's folder in the project
moved away and another put in its place whose `.git` leads to one (the `.git` file itself is
read-only, the folder holding it isn't: a mount there would be a border, as below), and a
submodule's `.git` a command leads there when its submodule has no repository in `.git/modules`; the
repositories inside an Also Allowed folder, at any depth, but the one at its top (each would take
its own keeping, on every command); the conversation's folder moved away from a folder above it
that a command writes (an Also Allowed one, `/tmp`) and another, with a repository of its own, put
in its place (a mount there would keep files from being moved or linked across it, tools' caches'
links into the project among them); a `.git` in the folder that's a link; a rebase it left stopped,
whose `exec` lines run as you go on with it (as on a Mac); and the race below (#617). Before Linux
6.2 (Landlock 3), truncating a file it only reads by its path (`truncate`), which Landlock checks
only from then.
On Linux, where Landlock grants a folder whole, git's own files in the repositories a command writes
are kept by its namespace instead (`fence/landlock.ts`, `KEEP_GIT`, #429). Before the command
starts, in its conversation's repository, the `.git` folder up from its folder, each repository Also
Allowed holds, and their submodules' repositories:
- the repository's folder, `worktrees` and `modules` are mounted on themselves, so none is moved,
  removed or replaced;
- its `config`, `config.worktree`, `commondir`, `gitdir` and `hooks` are read-only (where one of
  them but `gitdir` isn't there as it's kept, the repository's folder is, as below);
- `worktrees`, and every folder in `modules` but each submodule's repository, are read-only, as are
  each worktree's own `commondir`, `gitdir`, `config.worktree` and `modules` (the worktrees' folders
  themselves are written as git works in them and tidies their reflogs);
- each submodule's `.git` file in the project (not the folder it's in), and, once those are kept,
  the `.git` file that leads the conversation's worktree to its repository, still leading there,
  are read-only.

A folder is mounted from within it, a file by its path (which a link swapped in at that moment
could lead elsewhere), and each made read-only by its path; then all are checked in the namespace's
mount table: each the top mount at its path, of what's there, not covered by a folder mounted since
above it, and read-only where it should be; and every mount made since git's files began to be
kept is one of those. A
repository that changes as the command starts (git outside the sandbox writing it, or a command
still running), or a mount that isn't so, runs nothing (126, to run again). This is done before
what the namespace hides is hidden, so no mount there can uncover it.

The command doesn't run (126, saying why and to ask the user) where one of those is a link (a
command could trade it for its own, and where it leads isn't kept), where a `commondir` leads git
anywhere but the repository itself (or, a worktree's, its repository), or where one can't be kept.
So with a `.git/hooks` that's a link to a folder in the project, each command in that repository,
or in a project that holds it (Also Allowed, or as a submodule), runs only once allowed outside the
sandbox (`sandbox_ask`: you, or in Auto its reviewer). `core.hooksPath` is untouched: the hooks it
names are files in the project, which commands write as any other, on a Mac too. Each is made read-only in two steps, a bind and then its remount, which
libmount makes with the flags a mount from outside the namespace keeps locked (`nosuid`, `nodev`):
in one step, util-linux before 2.39 drops them and Linux refuses it (checked with util-linux 2.36.1,
2.38.1 and 2.41.5 on `/dev/shm`). Where a folder still can't be made read-only in a command's
namespace, the box says so (`gaps`: `git`), and commands in a repository don't run; the namespace,
and all else it hides, stays.

Mounts keep only what's there, and a name git reads that isn't there yet can't be told from the
files git makes beside it (`index.lock` beside `commondir`). So the launcher first leaves in each of
those repositories what it lacks of them: `.git/commondir` holding `./` (git and libgit2 take the
repository's own folder as its common one, as with none), empty `.git/hooks`, `.git/modules` and
`.git/worktrees`, an empty `.git/config.worktree` (read only once `extensions.worktreeConfig` is on,
as `git sparse-checkout` turns it on), and an empty `config.worktree` and `modules` in each
worktree's own folder. These are the files Kuvo Code leaves in a repository's `.git` on Linux
(docs/footprint.md). git reads them as before, but for what it prints: with a `commondir` there,
`git rev-parse --git-common-dir` and `--git-path` (`hooks`, `info/…`) at the repository's top print
absolute paths rather than ones under `.git` (`--git-dir` still prints `.git`), so a script that
compares the two as strings to tell a linked worktree takes the repository for one. It never changes
one that's there, and makes them as you, in the folder as it is (never through a link put there), so
never in a folder you made read-only. A repository that lacks one of them (it can't give one, or one,
`config` included, isn't there as it's kept) is checked as every other,
then its folder is read-only to commands (they can't make it writable either), but for its
worktrees' own folders and its submodules' repositories, each kept as above; the command runs. Where
the launcher couldn't make one, the command is told so once in what it prints (again once it can
and then can't); a repository with no `.git/config` is read-only the same way and nothing says so.

Still open on Linux: what a namespace keeps is what was there as the command started (#617). git
outside the sandbox writes `.git/config` anew (`git config`, a push that sets its upstream, a branch
that tracks one, `git submodule sync`) by putting a new file in its place, which Linux lets through
and then no longer keeps in the namespaces of commands still running. So a sandboxed process still
running then (a server left running, or a coding agent run whole in the sandbox, which keeps one
namespace for its session) can win that race and write the new file. What the box runs by itself
never runs what that file names (Git, below); git you run yourself, and what you ask the box for
(Commit in Changes), would. A submodule's folder in the project can also be moved away and another
put in its place whose `.git` leads to a repository of the command's own, and a new repository can
be made in the project and added as a submodule (both in the list above). Without a namespace of its
own (`gaps`: `services`), none of this holds.

It can't read
Kuvo Code's own folders (on a machine `~/.kuvo-code`; on this Mac the app's folders under `Library`,
any `run.kuvo.code…` copy's, its temporary folder and `/tmp/kuvo-ssh-<uid>`) but its `bin`, nor your
secrets (cloud, package and git tokens, browsers' and password managers' data, the coding agents'
sign-ins and opencode's, wherever your `XDG_DATA_HOME` puts it, private SSH keys: every file in
`~/.ssh` but its config, known hosts and public keys; gh's `hosts.yml` when it holds the token). A
coding agent run whole in it keeps its own sign-in in its first home (Codex's `auth.json` in
`~/.codex`), read and written as the rest of its state, and so do the commands it runs itself, which
share its sandbox; never your own in another home of it (your Codex's, for an account you added). A bot's or a chat's command gets its own folder back, and not its neighbours'. Its
environment has none of the engine's `OPENCODE_…` (but `OPENCODE_SESSION_ID`), no `KUVO_…` password,
secret, token or key, and no `SSH_AUTH_SOCK` but its own SSH agent's (below); on macOS it can't
reach your SSH and GPG agents' sockets either, which sign with the keys it can't read: the
system's (where launchd keeps it), one your shell started (in `~/.ssh/agent`, or `/tmp` and your
temporary folder, whose agents' folders and sockets it can't move to give them another name, nor
remove a folder of its own named as theirs are, `ssh-…`; its own sockets there, like ssh's shared
connections, it uses and removes), the
box's own `SSH_AUTH_SOCK`, gpg-agent's, 1Password's, Secretive's, Bitwarden's and yubikey-agent's,
by their usual places and those your ssh settings name, in the files they include and the system's
`/etc/ssh/ssh_config` too, with `~`, `%d` and `${…}` read (`IdentityAgent`, and `ControlPath`'s shared
connections: a folder of their own whole, or by the names they can have where they share one, each
`%` token any part of a name, like `~/.cache/ssh-%C` or `/tmp/%r@%h:%p`; on macOS no socket in the
folders the box lists is removed, nor a folder in them moved, and where they share one only their
sockets are kept, so the other files there are the command's, written by any means; a `GNUPGHOME`
elsewhere isn't known); nor, on both systems, Docker's and the like (Docker Desktop, OrbStack,
Colima, Lima, Rancher Desktop, Podman, LXD, Incus, libvirt), which run anything as the whole
computer; nor the servers that run what they're sent: terminals' (Rex's, iTerm2's and WezTerm's on
macOS, WezTerm's on Linux), zellij's, Neovim's and Emacs' (on macOS their folders in your temporary
folder aren't moved either), watchman's on macOS, and Tailscale's on Linux. So `ssh`, and git over SSH, use only the vault's keys there, and signing a commit with
your GPG key doesn't work; nor does an X11
program, whose display (XQuartz's) is in launchd's folder too. Nor can it reach your tmux's server
(`/private/tmp/tmux-<uid>`), which types into your terminals: its `TMUX_TMPDIR` is its temporary
folder, so a tmux a command starts is its conversation's own, there for its next commands, on both
systems. Linux's Landlock can't refuse a socket, so there each command runs in a namespace of its
own (util-linux's `unshare`, as an unprivileged user namespace) where your session's folder
(`/run/user/<uid>`: systemd's, which runs whatever it's asked outside the sandbox, your bus and
keyring, your SSH and GPG agents), your tmux's, screen's and shell-started SSH agents' folders, the X
server's, Neovim's and Emacs' servers', and VS Code's and Cursor's sockets in `/tmp` are empty or refuse, as do the other apps'
sockets the box lists (gpg-agent's in `~/.gnupg`, OpenSSH's `~/.ssh/agent`, 1Password's,
Bitwarden's, Grok's shared leader's, the box's own `SSH_AUTH_SOCK`); it runs as you, with your groups,
and `XDG_RUNTIME_DIR` and a `DBUS_SESSION_BUS_ADDRESS` in that folder are unset. They're hidden as
the command starts: one made later in `/tmp` (tmux started, or an `ssh -A` login, after a command a
conversation left running) isn't. A machine that doesn't allow that (user namespaces off, or
restricted by AppArmor, as Ubuntu 24.04 and later do, or without `unshare`) runs the sandbox without
it: commands there can still reach those services (systemd can start anything outside the sandbox),
so its state says so (`gaps`, below), the vault stays closed to agents, goals don't go on alone and
a bot doesn't answer its sessions' asks for commands there. Abstract sockets are kept inside the sandbox from Linux 6.12 (Landlock 6);
before, an X server's abstract one, or a bus `dbus-launch` started (`unix:abstract=`), stays
reachable. On both systems, the launcher sets each command up with the system's own programs
(`/usr/bin`, `/bin` and their `sbin`), never ones a command put on your PATH; the command has your
PATH.
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
engine's own file tools (`read`, `write`, `edit`, `patch`, `glob`, `grep`) run outside the sandbox and
tell a place outside the folder by the path as written, so the plugin gives them a path in the folder
(or the top folder the engine counts as the project's) that a link leads out of as where it really
is, taking the path as the engine does (`~`, the spaces a patch's lines are trimmed of), and the
engine's rules for a folder outside the project apply to it (a link a command made to your keys
asks, as your keys' own path would). `read` given a file that isn't there reads the one plain file
beside it whose name is the same but for how it's written (composed accents, no-break spaces, curly
quotes; never a link, engine 2.2.5), without asking about it again. So where a link beside it has a
name that looks the same (by a wider rule, `fence/lookalike.ts`: compatibility-composed, any space,
any apostrophe-like mark, any case), in the folder or out of it, the plugin refuses the read rather
than send it where the link leads, and a read it would send through a link out of the folder to a
file that isn't there beside one whose name looks the same; and Auto's reviewer judges a read by each file beside
the file it names (as the engine takes it: `~` your home, one not from `/` from the conversation's
folder), and beside where that lands, whose name looks the same too, as by that name. And it refuses
`session_move` (the engine's, or code mode's `opencode_session_move`) of another conversation, or to
a folder outside the conversation's own and its repository's worktrees: commands would write
wherever it moved. A command's folder is where it really was as the engine opened it (for a
move, as the move was checked): one traded since for a link (by another conversation's command, in a
folder it writes) runs no command (exit `126`). (A link swapped in between the plugin's look and a
file tool's own isn't caught: only the engine could, as it opens the file. Nor is a folder traded
before the engine opens it again: after a restart, or once the engine has let it go after an idle
hour; nor one a coding agent starts in, which the agents bridge takes as it is then.) The box first runs a command through it and checks that it can't read or write what's hidden; only then
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

- `GET kuvo/sandbox` → `{on, why?, able, agents, outside?, restart?, …}`. `on`: every command the engine runs here
  goes through the sandbox, checked (the engine loaded this box's plugin). `why`, when it isn't, in
  words for Settings: why this computer can't (`able: false`: no Landlock, no engine
  yet), a failed check, `Its plugin for the engine was changed or removed.`, `The engine isn't
  running.`, `Waiting for the engine to load it.`. `agents`: the coding agents' own
  programs (Claude Code, Codex, Cursor, Grok and Antigravity, whose commands don't go through the
  engine) run in it too: each starts its next turn in it once it's set up and checked here, and
  `agents` is true once no agent process the bridge started before it was on still runs (the
  agents bridge notes it, `{pid, on}`, in `run/fence/agents`, for the sandbox as it is: `on` is the
  token each setup writes in `run/fence/on`, with `outside: true` while one still runs; with no
  bridge running, it's true). `outside`: one still runs outside it (`agents` is false then; while
  it's false without `outside`, the bridge hasn't noted it yet). No agent starts outside it as the
  box starts: the box writes `run/fence/decided` (`{pid}`, its own) once its first setup has put
  the sandbox on or found it can't be here, and removes it as it stops; the agents bridge waits for
  that (the pid running the box's `kuvo-link`, by its command line on Linux, so not one a stopped
  box left) before it listens, a while at most, so one started before the box (as a machine's
  launch may) starts none outside it. This Mac's keeper starts its bridge once its box is up. A
  bridge with no sandbox folder, started with `KUVO_SANDBOX=off`, or on a machine whose box neither
  runs (`run/link.pid`) nor is wanted (`run/link.needed`), doesn't wait. `restart`: the box asks you, once, to restart those: true the first
  time it's on with one still running (never if it was on with all inside it first), until you
  answer with `POST kuvo/sandbox/restart` `{restart}`, which answers the state anew (400 without
  a true or false; 503 when the agents bridge doesn't answer, and it stays asked). True has the
  bridge (`POST /api/kuvo/sandbox/restart`) close each agent's process started before the sandbox
  was on once its conversation is between turns and nothing it left going (commands, subagents)
  still runs, the rest as they get there; each starts again in the sandbox with its next turn, going on with its
  conversation. False leaves them to finish as they are. `kuvo/sandbox/asks` carries it too, so a
  client following the asks hears it as it comes and goes. Clients show it as a card in the
  computer's conversations: "Restart agents in the sandbox?". It counts the
  agents' own processes, from their start: a command one of them started outside the sandbox that
  outlives it isn't followed, as with the engine's. Each runs whole in it, and so does all it
  starts: its commands, and its hooks and MCP servers, yours and a project's. Claude Code through
  `run/fence/shell/run` (the SDK's own start of it, `spawnClaudeCodeProcess`), in the conversation's
  folder, its own sandbox off; of its settings folder (`~/.claude`, or an added account's) it writes,
  on a Mac, only what's named as its state (its conversations, their files, todos and plans, shell
  snapshots, history, caches and logs, its sign-in, an added account's `.claude.json`), and in
  those never settings (`settings*.json`, `hooks`, `.mcp.json`); never your `~/.claude.json` (it
  goes on without saving to it), nor its own updates (`DISABLE_AUTOUPDATER`; Update does them,
  outside); Kuvo Code's tools through the relay, and files you attach as copies, as for Codex.
  Codex runs whole in the sandbox
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
  Every agent also gets the computer's MCP servers, sandbox on or off: those the engine has for the
  conversation's folder (`GET /api/config` with it, read in the engine's order, so a bot's folder's
  own keys, from Edit Bot › Keys, win over this computer's), but those turned off. They reach them
  through the same relay, at `/mcp/<name>` with the session's key: the agent is told only that
  address (Claude Code over its pipe, Codex in its thread's settings, Cursor in its agent's, an ACP
  agent in `mcpServers` when it takes HTTP), never a server's command, address or keys. A URL's
  server the bridge reaches with its headers, and with your sign-in to it when you signed in
  (`/api/credential`); one about to run out, or turned down, it has the engine renew (connecting
  the server again) and tries once more. A command's server it starts for each connection (found on
  the PATH), with its keys in its environment and the engine's caches, in the conversation's
  folder; while the sandbox is on, in it, as the conversation's commands are, but with its
  integration's own folder (`KUVO_INTEGRATIONS/<one>`, where it keeps a sign-in) its to write, the
  engine's program to read (Bun, for `kuvo-npx` without Node), and Bun's cache in the sandbox's npm
  cache. One no connection has used for an hour stops. What a server asks the agent (`roots/list`,
  `elicitation/create`, `sampling/createMessage`) is answered -32601 at once, not passed on; its
  stderr goes nowhere, as it can hold its keys. Another set of servers (one added or taken away)
  starts Codex's thread, Cursor's agent and an ACP agent again and is told to Claude Code; a key you
  changed reaches the relay alone, from the agent's next turn.
  While it's on, `gaps` lists what it can't keep commands from on this computer: `services`, the
  services your login runs, and git's own files in the repositories they write (a Linux machine
  whose commands can't have a namespace of their own;
  `needs`: `"user namespaces"`, or `"util-linux"` without `unshare`); `git`, git's own files in the
  repositories they write (a Linux machine where a folder can't be made read-only in a command's
  namespace, tried in the box's own folder as it's checked: commands in a repository there don't
  run, 126, rather than run with those open to them). A client says so beside it (`services`;
  the apps don't show `git` yet).
  When it isn't on, also `reason`, a word for a client to map rather than reading `why`, with what
  you can do (`action`) and the box's route that does it (`route`, where there is one):

  | `reason` | when | `action` | `route` |
  | --- | --- | --- | --- |
  | `kernel` | Linux without Landlock; `needs`: `"Linux 5.13"` | `help` | |
  | `namespaces` | Linux that doesn't let commands have a namespace of their own, from a box that doesn't run without one (none does now: `gaps`); `needs`: `"user namespaces"`, or `"util-linux"` without `unshare` | `help` | |
  | `macos` | this macOS has no sandbox | `softwareUpdate` | |
  | `engineMissing` | a machine without its engine yet | `retry` | `POST kuvo/sandbox/check` |
  | `checking` | not checked yet, or its check didn't finish in time (a busy computer: never taken for a failed one). Commands still run in it then, and nothing counts on it (Auto asks first, the vault stays shut) until a check passes; tried again each minute. Five in a row that don't finish count as failed (`checkFailed`, `didntRun`) | `retry` | `POST kuvo/sandbox/check` |
  | `checkFailed` | its check failed; `check`: `folder`, `tempFiles`, `readsOwn`, `writesOwn`, `services` (on Linux, a command could reach your session's services), `didntRun` or `setup`. Commands stay in it, with nothing counting on it, until every conversation's rules here, subagents' too, ask first (Auto held), the engine's and, where it runs, the coding agents' bridge's; only then is it taken away and they run outside it. (A bridge that isn't running isn't waited for, nor a record it left: while the sandbox isn't on, or one of its agents runs outside it, a conversation there whose rules were made for Auto asks before its commands. One that runs and doesn't answer keeps it held, tried again less often while it doesn't.) Auto's reviewer lets nothing out once Auto can't be had, even one it allowed meanwhile. Watches' checks, which can't ask, wait for it to be back (`run/fence/ready` stays). On Linux, a namespace in effect that a try says commands can't have is kept while the check goes through it, and dropped (`gaps`: `services`) only if that fails, the same way | `retry` | `POST kuvo/sandbox/check` |
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
most 600). In a conversation in Auto, Auto's reviewer answers it first ("Auto's reviewer"), and in
one in Full Access nobody's asked (its commands run outside the sandbox already: one that still
asks runs at once, `Ran outside the sandbox · Full Access`). Otherwise every client is asked; on
Allow Once or Always for This, **the box runs that one command itself**, outside the sandbox: with your login shell (`-lc`), in the conversation's folder (the
engine's record of it, never the command's), with the box's environment but without the passwords
and secrets of Kuvo Code's own processes, and hands back what it printed (the last 64 KB) and how it ended. The
agent's text starts `Ran outside the sandbox · Allowed once` or `· Always for this: …` (with the
folder its commands now write in); on Don't Allow,
`The user said no: …`, and nothing runs. An ask nobody answers in 15 minutes runs nothing either, and
the text starts `Nobody answered in time` (a client shows it as no answer, not as your no). The agent
never lets a command out itself, and no tool answers an ask (a bot neither): only a client, Auto's
reviewer or Full Access. A bot's
seat in a group chat runs no commands, so it has nothing to ask: its rules deny the tool, and the box
refuses one from a seat, asking nobody.

**Stopped commands** (`approval.stopped`, bridge 0.9.190). In Auto the agent needn't ask: the box's
plugin in the engine looks at what each call of the shell tool printed as it ends, and where it
failed with what the sandbox prints (`Operation not permitted`, `Permission denied` but SSH's own,
`Read-only file system`, `EPERM`, `EACCES`; on Linux also `No such file or directory`, for the
secrets hidden from commands), tells the box's long-running process over `run/vault.sock`:
`POST kuvo/sandbox/stopped` `{session, input, output}` (the call's own arguments, and the last 4 KB
it printed). Only while that conversation is making that very call, only in Auto, and only where
the sandbox stopped it (on macOS `Operation not permitted`, which a file's own permissions or a
database don't answer; on Linux, Landlock's answers, or a hidden secret named as missing), Auto's
reviewer judges the command as it judges a `sandbox_ask` (by what you said, a bot's goal), also
seeing what it printed and, on macOS, what its log says the sandbox refused it (read for a few
seconds), as running it again outside does that too (a write to where things run at login counts as setting one up; one to Kuvo Code's folders is
never allowed). It lands in Decisions either way. Allowed, the box runs it again outside the
sandbox, as an Allow Once, in the folder the agent ran it in, within what the call has left of its
16 minutes, and stops it if the call is stopped meanwhile; the agent gets `{text, exit}` instead of
what the sandbox let it print: `The sandbox stopped it · Ran again outside the sandbox · Allowed by
Auto's reviewer: <reason>` and its output. Refused, `{text}`: the refusal's words, added after what
it printed, and the call ends as it did. Anywhere else the answer is `{}`, and the call is left as
it was. Nobody is asked.

On macOS `top` runs outside the sandbox as it is (it's setuid, which the sandbox can't start, and
shows no program's environment); `ps` stays refused in it, as it would show every program's
environment: in Auto it goes to the reviewer as any stopped command.

The tool is the box's, so an agent has it on every box (`sandbox.asks`): this Mac's tool server
(the app's, and the keeper's with the app closed) and a machine's (`kuvo-browser.js mcp`, through
`box route`) list what `GET kuvo/sandbox/tools` gives (only
while the sandbox is `on`) and pass a call to `POST kuvo/sandbox/tools` `{session, name, arguments}`
→ `{text, isError}`, which, as the vault's, the box carries out only while that conversation is
making that call. The asks, the tool and the answers live in the box's long-running process, as the
vault does (`run/vault.sock`); another passes them on.

- `GET kuvo/sandbox/asks` → `{asks: [ask], restart?, reviews?, settled?}`, oldest first, with `restart: true` while
  the box asks you to restart its agents (the state's `restart`); `kuvo/sandbox/asks/events`, NDJSON,
  the same at once and on every change. `reviews` (bridge 0.9.192): what Auto's reviewer did with
  the engine's asks to work outside a conversation's folder (`permission.asked`, action
  `external_directory`), the latest 200, each `{id, session, call?, state, at}`: `id` the
  permission's, `call` the tool call that asked (its step), `state` `checking`, `allowed`, `heldBack`
  (refused, the agent told why, listed in Auto's Decisions), `refused`, or `yours` (not the
  reviewer's: not in Auto, no folder, or it couldn't judge). Its own project, and a bot's (its
  folder, a project it made, its goal's), go ahead as `allowed` with no review. A client shows no
  card, notification or "needs you" for such an ask while it's checked or once it's decided, only a
  quiet mark on its step. A box with `sandbox.reviews.whole` lists every such ask from the moment it
  hears it (`checking` at once), takes up those already waiting as it starts again, and lists one it
  can't take up as `yours`: a client shows such an ask only once it's listed `yours`, and waits for
  nothing of its own. An answered ask (or one gone with its run) leaves the list unless the reviewer
  decided it, whose entry stays for its step's mark. While a client doesn't hear the box's asks
  (its link down or starting again, the stream cut), what it last listed of an ask stands, and one
  it never listed is yours, as nothing would list it. From a box without that word, a client takes
  one not listed as yours at once.
  `settled` (`sandbox.reviews.settled`): each ask the reviewer was checking or had left for you
  that's over without its word, the latest 200, each `{id, session, call?, state, at}`, `state`
  `answered` (by you, on any client, or by its engine: `permission.replied`) or `gone` (its run
  ended, its session was deleted, or its engine let it go while the box wasn't listening: an
  engine started again, a run that ended unheard). The box keeps them per ask and session, from
  `checking` to `yours` to `answered` or `gone`: as it hears an engine or the bridge again it reads
  each session whose ask it still lists as checked or yours there, and one no longer asked is
  `gone`; one it was about to check and finds no longer asked is `gone` too, never `yours`. A
  client never takes an ask listed in `settled` for one that waits, heard or not, so none is left
  with an ask that's over (a session's row saying it asks). Such a client holds nothing of its own
  for an ask the box takes up but one it heard asked that the box hasn't listed yet (it lists each
  as it hears it), which is yours, and told, should the box go quiet first, as above. It tells you
  of one (a notification) once it's listed `yours`,
  reading it from its engine then (one its engine no longer asks isn't told; where its engine
  can't be read, it's told without its words), and lets go of one listed in `settled`. The
  reviewer's own answer isn't listed `answered`: the ask goes from `checking` to what it decided. The box's
  process started again lists what still waits as it takes it up again (`checking` at once) and
  none from before. From a box without `settled`, a client keeps what it heard asked until the box
  lists it, as before. An ask: `{id, at, session?, sessionName?, bot?, botName?,
  project, command, why, stopped?, error?, always?, machine?, owner?, review?}`. `session` is the conversation's root
  (a bot's sub-agent asks as its bot's conversation). `stopped`, on macOS: what the sandbox refused
  that command, from the system's log, each `{kind, path?}` (`kind`: `write`, `read`, `connect`,
  `job`, `app` or `other`; `path`, the file, folder or address). macOS logs it a while after (on a
  busy Mac, seconds), so an ask can go up without it and get it, with `always`, in a later line of
  the events (the box reads the log again for about a minute); a client shows the ask as it is now. `always`: what Always for This would
  keep besides running it, `{kind: "write", path}`, the one place the sandbox stopped it writing,
  when that's all it stopped and it's one that may be given (below); without it, the command can
  only be allowed once. A command itself is never let out for good: what it runs (its scripts, its
  project's settings, `package.json`, a `Makefile`) is what the sandbox writes, so the same command
  asks again each time. `machine`: the machine's name, on a machine. `owner`: whose its folder is,
  which Always gives the place to (Also Allowed, below; bridge 0.9.139): a client names a bot's own
  folder by the bot ("outside Scout's folder") and the chats as Chats, whose Always is every chat's. `review`: from a box
  before 0.9.185, in a conversation in Auto, why its reviewer brought it to you, `{reason, why}`;
  since then a conversation in Auto never asks ("Approval", "Auto's reviewer").
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
process (another passes the routes on). A rule: `{id, project, kind: "write", path, at, by?, owner?,
gone?}` (`project`, `path`: real paths; `by`: `Mac` or the phone's name).

A bot's own folder (its folder's `workspace`) and the chats' folder are projects here too: a
bot's own conversation, and every chat (they share one folder), have their own rules. Since bridge
0.9.139 each rule says whose it is, `owner`, `{kind: "project" | "bot" | "chats", id?, name}` (a
project by its folder's name, a bot by its `id` and the name it has now, the chats as `Chats`), and
`gone: true` when its project's folder isn't there any more (a project deleted or moved), so a
client still lists it to be removed. A bot's rules go once it's no longer here (deleted, or moved
to another computer): the long-running process drops them as it next answers Also Allowed. Adding
for a bot or the chats makes its folder if there isn't one yet. A client lists them all at once, grouped by whose.

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

- `GET kuvo/sandbox/allowed[?project=<folder>]` → `{allowed: [rule]}`, that project's; without
  one, every rule here and `owners`: whom else a folder can be added for, each bot here working in
  its own folder (not a project) by name, then the chats.
- `POST kuvo/sandbox/allowed[?all]` `{project, kind: "write", path}`, or `{owner: {kind: "bot", id} |
  {kind: "chats"}, kind: "write", path}` for a bot's own folder or the chats' → `{allowed}`, that
  project's, or with `?all` everything as `GET` answers it; `400` with `message` for one that can't
  be given (and for a bot that works in a project: its rules are that project's). The same rule
  again is the one there.
- `DELETE kuvo/sandbox/allowed/<id>[?all]` → `{allowed}`, that project's, or with `?all` everything;
  `404` for one that isn't there.

A box before 0.9.139 sends no `owner`, `gone` or `owners` and answers `?all` as without it: a client
lists its rules by their projects' folders, adds for projects only, and reads them all again after
an add.

### Git

A repository's own settings (its `.git/config` and what that includes) never start a program when
the box runs git there (bridge 0.9.183), since whatever could write in the folder (a download, a command the sandbox
let out) could have named one. The fence keeps a sandboxed command from writing them on macOS, and on
Linux where commands have a namespace of their own (above); this holds on every box, for a
repository written by anything.

- Every git the box runs in a repository gets `-c core.fsmonitor=false -c core.pager=cat -c
  log.showSignature=false`, and its diffs (`diff`, `log`, `show`, `stash show`) `--no-ext-diff`.
  (An empty `diff.external` would break them, so it isn't set.)
- What the box does by itself (Changes' reads, Undo's snapshots, branch backups and taking one
  back, reviews' scopes, voice and artifacts' reads of what a turn changed, naming a worktree's
  branch) also gets `-c safe.bareRepository=explicit -c core.hooksPath=/dev/null -c
  commit.gpgSign=false -c tag.gpgSign=false -c credential.helper=`. Unless the command only reads
  names and objects, the box first reads, with `git config --show-scope --get-regexp`, the hooks
  any settings name (`hook.<name>.command`, which git 2.54 runs) and the filters and diff
  converters the repository's own settings name (the `local` and `worktree` scopes and what they
  include; `~/.gitconfig`'s and the system's are yours), and switches them off: a hook by
  `hook.<name>.enabled=false`, a filter's `clean`, `smudge` and `process` emptied and `required`
  false, and `--no-textconv` on a diff, `blame` or `grep` when one names a converter. git-lfs's and
  git-crypt's stay on when the program they name is the one PATH finds, or Changes would show every
  file they keep as changed. A command that can't be told not to convert (`cat-file --textconv`,
  `format-patch`, `range-diff`) isn't run, nor any where a name can't be written after `-c` (an
  `=` in it), or the read fails; Changes then says the repository names a program it won't run.
  git before 2.26 can't say the scope, so every filter or converter counts as the repository's
  there.
- What you ask git for yourself (Stage, Commit, Push, Pull and the rest in Changes, a worktree made,
  switched, removed with what wasn't committed in it, or brought back, a project cloned) gets only
  the first set: the repository's hooks, filters and sign-ins run as in your terminal, so husky,
  LFS and git-crypt work, and what's kept of a removed worktree is stored as your `git add` would.
- Neither runs (but what only reads names and objects, which starts nothing) where the repository's
  `commondir` leads git anywhere but where it should (#429), or where git finds a bare repository
  by sitting in a folder that has a `.git` of its own (what its own files make of it once that
  `.git` is broken: `HEAD`, `objects`, `refs` and settings beside it; not by
  `safe.bareRepository`, which would reach your hooks' own git too). Where it should is: none, or the repository's own folder
  (`./`, as the sandbox leaves it on Linux), or, in a linked worktree's own folder
  (`.git/worktrees/<name>`), the repository it's one of. One leading elsewhere would have git read
  another repository's settings and run its hooks; Changes then says so, as for a program it won't
  run. (git is asked where the repository is, `rev-parse --absolute-git-dir`, and the file read only
  as a small regular one.)
- The engine's own git (its `vcs` routes and the session's diff) has fsmonitor off and no external
  diff by itself, and keeps its snapshots outside the repository; a filter or converter the repository
  names still runs in its status and diffs. Submodules' own settings aren't read: the
  settings above reach their git too, but not their filters' names.

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
  Mac signs its phones. A Mac the machine hasn't heard from in 30 days (setup or any mail) of its
  box running (noted every few minutes in `run/online`; time off doesn't count, and a clock set
  wrong and then right moves no Mac on) no longer counts, and its phones go; it counts again once
  it sets the machine up.

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
  no relay. On a member of a setup, `409 {"message", primary}`: only its main computer pairs
  ("Your setup", `setup.mainOnly`).

A machine keeps itself running: its keeper (`bin/kuvo-start keep`, `run/box.pid`) starts its
engine again when it ends, unless it was stopped on purpose (`run/stopped`), and keeps the bridge
running while it has something to answer: a phone paired, a pairing waiting, or peers
(`run/link.needed`, which the bridge writes). The bridge stays up while the engine is down, and
starts the keeper when it isn't running. A Mac quitting or disconnecting leaves all of it running.

**A server that hangs while running** (from 0.9.201, on this Mac and on machines alike:
`src/shared/hang.ts`). The coding agents' bridge watches the engine, and the link watches the
coding agents' bridge. Every 30 seconds each asks its server something over a plain connection (any
answer counts, an error too). Only all of this, at every look for ten minutes without a break, counts
as hung: it takes the connection and says nothing within 20 seconds; connections on this computer
work (the watch answers itself); all its threads are asleep (none running, on a disk or paused), it
used under 2% of a CPU since the last look, and nothing it started is running or used over 5% of one;
its command line is that server's; and nothing's stopped, starting or updating it on purpose, nor is
macOS asking you something (`run/stopped`, `run/.launching`, `run/.updating`, `run/.system-asking`). A
look that comes late (the computer slept, was paused, or was starved) starts the count again. A hung
server is told to stop (SIGTERM), then made to ten seconds later (SIGKILL), and whoever keeps it starts
it again as after any crash; what it started goes on, as after any crash. At most three in six hours
(`run/hung-engine.json`, `run/hung-bridge.json`, when each was ended, in milliseconds; one it can't
write or read counts as too many), then it's left for a Restart.

What it can't see: a server spinning at full CPU (from outside, that's long work), or one whose event
loop runs while its work is stuck (it answers). From outside, a call that sleeps for good looks like
one that would still return: one taking over ten minutes (a network folder that stalled) counts as
hung. Nothing watches the link, nor the coding agents' bridge on a machine with nothing for its link to
answer (where it doesn't run), nor the engine while the bridge is down.

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
- **A box's news**: a box from before `kuvo/notices` (the bridges of 0.7.x and 0.8.0-beta.1
  Macs) doesn't tell its news, so a Mac words the finished-run and group-chat notices for it
  itself. The same wording also covers a machine whose bridge isn't running (`telling: false`,
  "Notices"), which stays until a box tells its news without its bridge: removing it before then
  loses those notices.
  <!-- compat: 0.7 box-notices -->
- **Plan limits from before `rows`** (#210): a client from before them (a released Mac, a phone)
  reads each box's own `accounts` and merges them itself. A box that let a peer's reading stand
  for a read of an account lists it there with that reading's numbers (`accounts`, "Plan limits"),
  so such a client doesn't show it stale or empty.
  <!-- compat: 0.7 limits-own-numbers -->
- **Boxes from before `rows`**: a client asks each box it reaches and merges their `accounts`
  itself while one of them answers without `rows` ("Plan limits", "Listing them"). The same merge
  covers a computer the first box doesn't hear from now (the relay down); removing the fallback
  needs an answer for that first.
  <!-- compat: 0.7 limits-merge -->
- **Updating an agent's program**: such a Mac asks `POST kuvo/agents/api/integration/<provider>/update`
  and waits for its answer, `{data: {updated, version?, message?}}`, so the agents bridge still
  answers that once the update is done (the same update every client sees, "Installing and
  updating an agent's program"). The other way round, a Mac or phone of this version meeting a box
  from before `kuvo/updates` (a 404, the bridges of 0.7.x and 0.8.0-beta.1 Macs) asks it each
  program that way, picking what's behind from `metadata.outdated` and `metadata.updates` on the
  own sign-in.
  <!-- compat: 0.7 update-answer -->

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
- Settings › Git (`git.branchPrefix`, `git.commitInstructions`, `git.pullRequestInstructions` in its
  preferences), which each computer keeps its own now (`kuvo/config`, "Changes"): given to each box
  once (`POST kuvo/git/settings/move {branchPrefix?, commitInstructions?, pullRequestInstructions?}`
  → `{"moved"}`, `409 {"message"}` while a machine's settings aren't its own yet, `500
  {"message"}` when they couldn't be written), which keeps
  each where it has none of its own yet, the first time a Mac offers any (a branch prefix, or
  instructions that aren't empty: `box/git.json`'s `moved`), so a later one, or one after you
  cleared it there, changes nothing; `moved` says whether it took any now. The Mac offers them as
  each box starts or connects, and keeps them in its preferences for a computer you add later.
  <!-- compat: 0.7 mac-git-settings -->
- The branch prefix a box kept before in `box/git.json` (`branchPrefix`, the one a client last
  made a worktree with): taken into its settings' `branch_prefix` once, where they have none, as a
  machine's box starts or its settings become its own (`box adopt`), or after a Mac's Settings › Git
  is moved there (the Mac's own prefix first), then removed from `box/git.json`. <!-- compat: 0.7 box-branch-prefix -->

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
- It sends its own branch prefix with each worktree (`POST kuvo/worktrees {"project",
  "branchPrefix"}`): used as given. (A box from before kept the last one given in `box/git.json`
  for a client that sent none: no longer read.)
  <!-- compat: beta.1 worktree-prefix -->
- Its keeper's box, still running after an update until the work under way ends, answers 400 for
  Kuvo Code's own tools that every box answers since `agent-tools.own` ("Agents' tools"): the newer
  app runs those calls with its own `kuvo-link.js box route`, once each, meanwhile.
  <!-- compat: beta.1 agent-tools-own -->
