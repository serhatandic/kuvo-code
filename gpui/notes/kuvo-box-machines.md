# Following a machine as it changes (phase 2)

`kuvo_box` reaches a machine's box over SSH through `kuvo-link.js box route`, which answers each
request once. So today a machine's session list is read again every half minute, and an open
conversation every five seconds: its words come in chunks, not as they're written. Phase 1 keeps
that. This note is how phase 2 makes a machine stream, as this Mac's own box does.

## What the Mac app does

- It starts a machine's engine itself, so it knows the engine's port and password. It holds an SSH
  tunnel to it (`-L <local>:127.0.0.1:<engine port>`, `RemoteEngine.swift`), and follows
  `api/event` through it.
- It reads the box's routes with `box route`. When the engine says a session was made, moved,
  changed or deleted (`session.created`, `session.moved`, `session.metadata.updated`,
  `session.deleted`), it reads the session list again a moment later (`Workspace.listChanged`). It
  also reads it every half minute, as PROTOCOL.md says ("Session lists").

## Options

1. **The engine's tunnel, as the Mac does.** The client reads the engine's port and password from
   `run/engine.json` over SSH, opens a tunnel, and follows `api/event` there: words stream, and a
   session event reads the list again. Lists and everything else stay on `box route`.
   - Costs: the client handles the engine's password, and two kinds of transport per machine. A
     coding agent's conversation needs a second tunnel, to the agents bridge.
2. **The box's kept server** (`box.serve`, "Kept for clients"). The client asks for it once with
   `box route` (`POST kuvo/box/serve {needed: true}`), reads where it answers from `run/serve.json`
   (`{pid, port, password, kept: true}`), and opens one tunnel to it. Then every route streams
   through the box, as on this Mac: the list's `…/events`, `api/event`, and
   `kuvo/agents/api/event`. `LocalServer` already speaks it; only the way to the port is new.
   - Who it is to the box: Kuvo Code, taken as `box route` is. That's `x-kuvo-from: mac`
     (`box.serve.mac`, which already means "taken as `box route` takes it"); never `app`, which a
     box trusts with its app's registration. Without the header, the box reads every message as a
     phone's (`<from-phone>`, `phone: true` in its parts). So it needs a box listing both
     `box.serve` and `box.serve.mac`; one without them stays on `box route`.
   - Costs: PROTOCOL.md describes `box.serve.mac` for Kuvo Code on the box's own computer. That a
     client may reach it through an SSH tunnel from another computer (the same user, over the same
     SSH that `box route` uses) wants a line there, which is the box's to write.

**Recommendation: 2.** One tunnel, and no engine password in the client. The box keeps deciding,
and a machine is reached the same way as this Mac. It needs the PROTOCOL.md line first, and the
user's or the lead's agreement.

## How it would be built

- A transport `SshTunnel`, made from an `SshBox`:
  - It holds an `ssh -N` with `ExitOnForwardFailure=yes` and `StreamLocalBindUnlink=yes` (else a
    socket a crash left makes every later start fail), forwarding a Unix socket
    (`-L <socket>:127.0.0.1:<port>`). A socket rather than a local port: there's no race for a free
    port, and only this user can open it. Its path must stay under macOS's 104 bytes, so it goes
    in the same short folder as SSH's shared connections (`/tmp/kuvo-ssh-<uid>`, checked to be
    this user's alone), not the app's long temporary folder.
  - It speaks HTTP over that socket, with `LocalServer`'s client (already written for a closable
    stream), saying `x-kuvo-from: mac`.
  - Like `LocalServer::recorded`, it reads `run/serve.json` again when a request fails to
    connect: the box's server moves after an update.
  - `streams()` is true while the tunnel is up. When the tunnel or the server is down, it falls
    back to `box route` for that request.
- `BoxClient::machine` uses the tunnel where the box lists `box.serve` and `box.serve.mac`, and `box route` where it
  doesn't. The follows don't change: they already stream when the transport does, and poll when
  it doesn't.
- Tests use a stand-in `ssh` that opens the forward with a local Unix socket to the stand-in box,
  and the existing stand-in box. No real machine is involved.
- Its footprint: the socket goes in `/tmp/kuvo-ssh-<uid>` (footprint.md's one exception, which
  this joins) and is removed when the tunnel ends.
  The `ssh -N` process is this client's own, and is stopped by its PID only.
