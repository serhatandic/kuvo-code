# #693 piece 0: the unattended spikes, results

Status: measured 2026-11-14, against `693-own-box-browser.md` (§7's piece 0 row, and each "piece 0
checks"). These are the four spikes that needed no macOS prompt, sign-in or outside service. What's
left for when the user is at the Mac is at the end (§7). Nothing here is product code.

**Where it ran:**
- This Mac: Apple silicon, macOS (Darwin 27.2).
- The engine the box runs on: `~/.kuvo-code/engine/2.2.5/opencode`, Bun 1.4.4 with `BUN_BE_BUN=1`.
  `scripts/build-box.sh` looks for an engine the same way, in the app's folders.
- Chrome for Testing 155.0.8059.79, mac-arm64, from `mac.json`, set up by the box's own
  `installBrowser()` (§1).
- The keeper: this worktree's `KuvoCode/Resources/kuvo-browser.js` (`KEEPER = 50`, at `04cd65e35`),
  with its `CONFIG` line (the tools, scripts and instructions) taken from the installed copy, since
  the app fills that line in. 46 tools.
- Every command ran under `env -i` (no `KUVO_*`), with `HOME` set to a scratch folder,
  `~/.kuvo-code/tmp/693-spike/home`. So `K` was `…/693-spike/home/.kuvo-code`, `REAL_BOX` was false
  and `IS_MAC` was false. No real box, profile or relay was used.
- The scripts are in Appendix A. The scratch folder is deleted; the logs are kept in
  `~/.kuvo-code/tmp/693-spike-log`.

## 0. Results

| Spike | Result | Numbers | For the design |
| --- | --- | --- | --- |
| `serve`: `GET kuvo/browser/view` upgraded to a WebSocket under the engine's Bun | **Works.** `node:http`'s `upgrade` fires on the box's own `serveBox()`, and the handshake and frames work both ways. Backpressure works too: `write()` returns false and `drain` comes. The fallback, a streamed GET plus POSTs, works as well. | Open 3 ms; an input's round trip 0.3 ms; 200 frames of 150 KB, locally, at about 1.3 GB/s. A stalled client holds about 2.1 MB before writes stop. | Keep the WebSocket; no fallback is needed. **Change:** the upgrade checks the password and path itself, because `serveBox`'s request handler never sees an upgrade. The box has no `ws` package, so the RFC 6455 framing is ours to write (§2). |
| The `Cookies` database while Chrome runs | **Works.** It can be read with sqlite `mode=ro`, `immutable=1`, a copy, or `bun:sqlite` read-only. The profile's lock doesn't stop any of them. Names, hosts and expiry are plain text; values are encrypted. | A new cookie reaches the file **about 30 s** after it's set. Session cookies are in the file while Chrome runs, and gone after it restarts. | As designed: `Storage.getCookies` while Chrome runs, the file otherwise. **Change:** read with `bun:sqlite` read-only (the box already does for the engine's database), skip `is_persistent = 0` rows, and expect a lag of up to 30 s if the file is read while Chrome runs (§3). |
| Memory of one `mcp` per agent | **Small.** Each one is its own Bun, so the cost grows in a straight line. | One: 26 MB RSS at start, 33 MB after browsing; 13–16 MB physical footprint. Five: 165 MB RSS, 80 MB footprint. Chrome's tabs for the same five agents: about **+530 MB RSS**. | One `mcp` per agent is fine. The real cost is a Chrome tab per agent, kept for an hour (`TAB_IDLE`). §7's "One `mcp` process per agent" risk becomes "a tab per agent for an hour" (§4). |
| Frame bytes at phone settings, locally | Uncapped, a busy page streams **60 fps** whatever the size. A phone at 1× and quality 50 is **37–40 KB a frame, one relay message**. At 2× it's 109–237 KB, three to five messages. | Busy page: phone 1× q50 at 2.9 MiB/s and 60 messages/s; phone 2× q60 at 8.5 MiB/s and 180 messages/s. Video-like page: up to 18.5 MiB/s and 300 messages/s. Scrolling: about 21 fps. Still page: nothing. | The relay's 4003 counts **messages, not bytes**: 500/s for the box's whole connection. Its 2 MB hold stops **all** of the box's traffic behind one slow phone. **Change:** cap the frame rate, keep a phone's frames to one message, and keep at most two frames in flight per viewer (§5). |
| Found along the way | **Chrome for Testing for Mac is ad-hoc signed, not Google-signed.** And any Chrome start writes the **Preferences key** in the real home, even with `CFFIXED_USER_HOME`. | `codesign`: `Signature=adhoc`, no Team ID; `spctl` rejects it. The download carries no quarantine flag. The key holds the bundle path of the last Chrome started. | **Changes:** §2's Gatekeeper row is wrong. And piece 7's real-Chrome tests on a Mac would write the user's Preferences key (§6). |

No macOS prompt was seen. I couldn't see the screen, so this is what I checked instead: no
`SecurityAgent` (the Keychain's prompt) or other new prompt process started; Chrome started and
answered every call; and nothing waited. The only system notification process running had started
on Nov 9.

## 1. Setting up Chrome for Testing with the box's own code

The box's own `installBrowser({ now: true })` ran in a test folder (Appendix A, `install.ts`).

- **The download.** A test folder downloads only with `KUVO_BROWSER_SOURCE` (`install.ts:76-83`).
  So the one `KUVO_*` set anywhere was that variable. It pointed at a local pass-through
  (`proxy.ts`) that fetches the real `https://storage.googleapis.com/chrome-for-testing-public/…`
  pinned in `mac.json`. The pin's size and SHA-256 checks ran as they do on a machine.
- **The command:**
  ```sh
  ./clean.sh BUN_BE_BUN=1 KUVO_BROWSER_SOURCE=http://127.0.0.1:$PORT \
    ~/.kuvo-code/engine/2.2.5/opencode install.ts
  ```
- **The result:** `{"outcome":"installed","seconds":24.7,"status":{"state":"ready","chromium":"155.0.8059.79"}}`.
  The build is 362 MB unpacked, as `browser/155.0.8059.79-mac-6783d9ac` with `current` linking to
  it.
- **The signature:**
  - `xattr -lr` on the app shows **no `com.apple.quarantine`**.
  - `codesign -dvvv`: `flags=0x20002(adhoc,linker-signed)`, `Signature=adhoc`,
    `TeamIdentifier=not set`.
  - `spctl -a -vv`: "code has no resources but signature indicates they must be present", a
    rejection.
- **The keeper's start:** `kuvo-browser.js host` was started from `browser/`, as `startKeeper` does,
  with the engine's Bun, `--config=/dev/null --no-env-file`. It started Chrome with the machines'
  flags, `--use-mock-keychain` among them (`kuvo-browser.js:514`), and `CFFIXED_USER_HOME`.
- **What the log said:** only Chrome's headless `CVDisplayLinkCreateWithCGDisplay failed` lines,
  which are harmless.
- **Idle Chrome** with `about:blank` and the test pages closed: 15 processes, about 0.8 GB RSS.

## 2. Spike 1: `serve` with a WebSocket under the engine's Bun

**What ran** (`serve-ws.ts`):
- The box's real `serveBox(password, handle)` (`server/serve.ts`), with a stand-in `handle` for
  `GET kuvo/browser/view` (streamed newline JSON) and `POST kuvo/browser/input`.
- An `upgrade` listener added to the server it returns.
- The handshake and frames written by hand, from RFC 6455.
- The client was Bun's own `WebSocket`, with `Authorization` as a header (as URLSession can send).

```sh
./clean.sh BUN_BE_BUN=1 ~/.kuvo-code/engine/2.2.5/opencode --config=/dev/null --no-env-file serve-ws.ts <worktree>
./clean.sh BUN_BE_BUN=1 ~/.kuvo-code/engine/2.2.5/opencode --config=/dev/null --no-env-file serve-drain.ts
```

**Results:**
- **The upgrade with the password:** it opened in 3 ms. A `Kuvo.input` came back in 0.31 ms. 200
  frames of 150 KB each (about one Mac frame as a text line) arrived whole, at about 1.3 GB/s,
  locally.
- **Without the password:** the listener answered 401, and the client got an error event.
  `upgradesSeen: 2`: **both upgrades reached the `upgrade` listener, never `serveBox`'s request
  handler and its password check.**
- **Ordinary routes on the same server afterwards:** 200 with the password, 401 without. The
  upgrade listener doesn't disturb `serveBox`.
- **The fallback**, a streamed GET plus 20 POSTs: the first byte came in 12 ms, all 200 frames
  arrived (about 1.3 GB/s), and a POST's median was 0.14 ms (0.44 ms at most).
- **Backpressure** (`serve-drain.ts`): a raw client finished the handshake, then stopped reading.
  - The server's `write()` on the upgraded socket returned false after about 2.1 MB, with 195 KB in
    Bun's own buffer and the rest in the kernel.
  - `drain` came each time the client took more.
  - Once the client read again, all 195 MB arrived. So a view server can tell a slow client and
    drop frames for it.

**What it means:**
- `node:http` upgrades work under the engine's Bun 1.4.4, so the design's first choice holds and no
  fallback is needed. The fallback works too, if a client can't open a socket.
- **Design change, §3.2's `serve` row:**
  - The `upgrade` listener must do `serveBox`'s checks itself: the `serve.json` password with
    `timingSafeEqual`, and `canonicalPath` on the URL. Otherwise the socket is open to anything on
    127.0.0.1.
  - A test should say that an upgrade without the password is refused.
- **Design change, new:** the box has no `ws` package (`Packages/Box/package.json`), and the box
  bundles with no dependencies. So piece 3 writes a small RFC 6455 server of its own, with tests:
  - masked client frames;
  - continuation frames (the spike handled none);
  - ping and pong;
  - close;
  - 16-bit and 64-bit lengths;
  - `drain` for dropping frames.

  Bun's own `Bun.serve` WebSocket isn't an option, because `serve` is `node:http`.
- **For the Swift client (piece 6):** `URLSessionWebSocketTask.maximumMessageSize` is 1 MB by
  default. A sharp 2× frame is under that today (§5), but piece 6 sets it explicitly.

## 3. Spike 2: the `Cookies` database while Chrome runs

**What ran** (`cookies.ts`, `bun-sqlite.ts`):
- Through the keeper's own `connect`, as the Mac's `MachineBrowser` does: `Target.createTarget`,
  `attachToTarget {flatten}`, then `Page.navigate` to a local page (`site.ts`, `/cookies`).
- That page sets five cookies: a day (`Max-Age`), a year (`HttpOnly`), a session cookie, a dated
  one (`Expires`, `SameSite=Lax`), and one from script.
- The script then polled `profile/Default/Cookies` once a second with `immutable=1` until the
  cookies appeared.
- Then it read the file five ways while Chrome held it.

```sh
./clean.sh BUN_BE_BUN=1 ~/.kuvo-code/engine/2.2.5/opencode --config=/dev/null --no-env-file cookies.ts http://127.0.0.1:$SITE/cookies
./clean.sh BUN_BE_BUN=1 ~/.kuvo-code/engine/2.2.5/opencode --config=/dev/null --no-env-file bun-sqlite.ts
```

**Results:**
- **`Storage.getCookies`** had all five at once, with their domains and expiry; the session cookie
  showed `session: true`.
- **On disk:** the file is `Cookies` with a rollback journal (`Cookies-journal`), not WAL. **The
  cookies reached the file 30.3 s after the page set them**, which is Chrome's flush delay.
- **Read while Chrome ran, every way worked:**
  - `/usr/bin/sqlite3` with a plain open, `file:…?mode=ro` and `file:…?immutable=1`;
  - a copy, with its journal;
  - `bun:sqlite` with `{ readonly: true }` and with `immutable=1`.
- **The columns:** `host_key`, `name`, `expires_utc` (microseconds since 1601), `has_expires` and
  `is_persistent` are plain. `value` is empty; `encrypted_value` is 51 bytes, encrypted with the
  mock keychain's fixed key.
- **Who holds it:** `lsof` shows Chrome's network service with the file open read/write (`au`),
  with no exclusive lock that keeps readers out on macOS.
- **After Chrome restarted,** the file had 4 rows: the session cookie was gone, as expected.

**What it means:**
- §4.5 holds: while Chrome runs use `Storage.getCookies`, which is current; otherwise read the file.
- **Design change, §4.5 and piece 2:**
  - Read with `bun:sqlite` read-only (`mode=ro`), as `agents/usage/engine-db.ts` does for the
    engine's database. A Linux machine may not have the `sqlite3` command.
  - Not `immutable=1`: it ignores the journal, so a read during Chrome's write can see half of it.
  - On `SQLITE_BUSY`, try again shortly.
  - Count only rows with `is_persistent = 1`, or with `expires_utc` in the future.
  - Convert `expires_utc` from 1601-based microseconds.
  - If the file has to be read while Chrome runs (for example, the keeper is between restarts),
    expect a sign-in from the last 30 s to be missing.
- The privacy line in §6.1 ("cookies are effectively plain text there") stays true: the values are
  encrypted, but with a key that's fixed and public.

## 4. Spike 3: memory of one `mcp` per agent

**What ran** (`mcp.ts`): N `kuvo-browser.js mcp` processes, started as `agents/kuvotools.ts:56-60`'s
stdio program would start them. Each ran on the engine's Bun with `KUVO_SESSION` set to its own
session.
- Each sent `initialize` and `tools/list` (46 tools), then a `browser_navigate` to a local page,
  then a `browser_snapshot`.
- Measured with `ps -o rss` and `/usr/bin/footprint` (physical footprint, which counts shared pages
  once).

```sh
./clean.sh BUN_BE_BUN=1 ~/.kuvo-code/engine/2.2.5/opencode --config=/dev/null --no-env-file mcp.ts 1 http://127.0.0.1:$SITE/static
./clean.sh BUN_BE_BUN=1 ~/.kuvo-code/engine/2.2.5/opencode --config=/dev/null --no-env-file mcp.ts 5 http://127.0.0.1:$SITE/long
```

| When | One `mcp`: RSS / footprint | Five: RSS / footprint in all |
| --- | --- | --- |
| started | 26 / 13 MB | 130 / 66 MB |
| after `initialize` and `tools/list` | 30 / 15 MB | 150 / 75 MB |
| after one `browser_navigate` each | 32 / 16 MB | 160 / 80 MB |
| after a `browser_snapshot` each | 33 / 16 MB | 165 / 80 MB |

**Chrome and the keeper, as one process group:**
- 814 MB RSS before;
- 848 MB with one agent's tab;
- **1,379 MB with six agents' tabs**, which is about 100 MB RSS for each agent's tab;
- 727 MB physical footprint at that point, across 15 processes.

**What it means:**
- An `mcp` per agent costs about 16 MB (33 MB RSS), so five agents cost 80 MB. Every one runs its
  own Bun, so it grows in a straight line, and it's small. **There's no need for a shared tool
  server.**
- The real per-agent cost is the agent's own Chrome tab, about 100 MB, kept for `TAB_IDLE` (an hour,
  `kuvo-browser.js:59`) after the agent leaves it.
- **Design change, §7's risks:** "One `mcp` process per agent" becomes "a Chrome tab per agent,
  about 100 MB, for an hour after it's used". On a laptop, a shorter `TAB_IDLE` could be a browser
  setting (§5.1 already moves `TAB_IDLE` into `kuvo/browser/settings`).
  - **Decision for the user:** whether this Mac's default should be shorter than a machine's hour.
    *Recommend:* keep the hour, which matches the WebKit panel's `agentTabIdle`, and revisit after
    the rehearsals.

## 5. Spike 4: frame bytes at the phone's settings, locally

**The settings.** No phone live view exists yet, so the code has no phone settings to read. The
Mac's are in `MachineBrowser.applyViewport` (`MachineBrowser.swift:836-843`):
- the panel's size in points with `deviceScaleFactor` 2;
- `Page.startScreencast {format: jpeg, quality: 75, maxWidth/maxHeight: the size in points}`, so
  1× while the page moves, then a sharp 2× picture once it stops.

The phone candidates use the same pattern, at an iPhone portrait panel of **393 × 660 pt**. 393 pt
is the width of today's 6.1" iPhones; 660 pt is the screen less its bars and the toolbar, an
assumption. One more case: a 1280 × 800 page, as an agent sizes it, scaled down for a phone.

**What ran** (`frames.ts`):
- Through `kuvo-browser.js connect`, with each frame acknowledged as it came (locally, so as fast as
  Chrome makes them; `connect` keeps two ahead).
- 8 s per case after the page settled.
- Four local pages (`site.ts`):
  - `static`;
  - `anim`, a busy page: a sliding bar, a spinner and a ticking clock;
  - `long`, scrolled with 20 wheel events a second, as a trackpad does;
  - `noise`, every pixel new every frame, the worst case, like a video.
- What's counted:
  - "Line": the frame as the keeper's newline JSON (base64 JPEG and its numbers), which is what goes
    over a transport.
  - "Messages/s": each line cut into the relay's text pieces of 65,457 bytes (65,519 less a head).

```sh
./clean.sh BUN_BE_BUN=1 ~/.kuvo-code/engine/2.2.5/opencode --config=/dev/null --no-env-file frames.ts \
  http://127.0.0.1:$SITE/<page> <width> <height> <scale> <maxWidth> <maxHeight> <quality> 8 <none|scroll>
```

| Page | Settings | View → frame size | fps | JPEG, KB (median) | Line, KB | MiB/s | Relay messages/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| anim | Mac panel (today's `MachineBrowser`) | 800x600@2 → 800x600 | 60 | 54.1 | 72.3 | 4.2 | 120 |
| anim | phone 1×, q75 | 393x660@3 → 393x660 | 60 | 49.7 | 66.5 | 3.9 | 120 |
| anim | **phone 1×, q50** | 393x660@3 → 393x660 | 60 | 36.8 | 49.3 | 2.9 | 60 |
| anim | phone 2×, q60 | 393x660@3 → 786x1320 | 60 | 108.7 | 145.1 | 8.5 | 180 |
| anim | phone 3×, q50 | 393x660@3 → 1179x1980 | 60 | 97.9 | 130.8 | 7.7 | 180 |
| anim | agent's 1280×800 page for a phone, q60 | 1280x800@2 → 786x492 | 60 | 41.0 | 55.0 | 3.2 | 60 |
| long (scrolling) | Mac panel | 800x600@2 → 800x600 | 21.6 | 72.3 | 96.6 | 2.0 | 43.2 |
| long | phone 1×, q75 | 393x660@3 → 393x660 | 21.1 | 54.2 | 72.6 | 1.5 | 41.5 |
| long | **phone 1×, q50** | 393x660@3 → 393x660 | 21.1 | 39.8 | 53.4 | 1.1 | 21.1 |
| long | phone 2×, q60 | 393x660@3 → 786x1320 | 20.5 | 116.3 | 155.3 | 3.1 | 61.5 |
| long | phone 3×, q50 | 393x660@3 → 1179x1980 | 20.9 | 104.7 | 139.9 | 2.9 | 56.5 |
| long | agent's page for a phone, q60 | 1280x800@2 → 786x492 | 21.5 | 42.2 | 56.5 | 1.3 | 26.9 |
| noise | Mac panel | 800x600@2 → 800x600 | 60 | 147.9 | 197.4 | 11.6 | 240 |
| noise | phone 1×, q75 | 393x660@3 → 393x660 | 60.1 | 69.4 | 92.8 | 5.5 | 120.2 |
| noise | **phone 1×, q50** | 393x660@3 → 393x660 | 60 | 39.2 | 52.6 | 3.1 | 60 |
| noise | phone 2×, q60 | 393x660@3 → 786x1320 | 60 | 236.8 | 316.0 | 18.5 | 300 |
| noise | phone 3×, q50 | 393x660@3 → 1179x1980 | 60 | 200.4 | 267.4 | 15.7 | 300 |
| noise | agent's page for a phone, q60 | 1280x800@2 → 786x492 | 60 | 72.3 | 96.6 | 5.7 | 120 |

`static` sent **no frames** after the first, in every case: a still page costs nothing.

**The relay's limits, from its code** (`kuvo-code-ios/relay/src/relay.ts`, last changed in
`59da20b`; `server.ts` sets none of these, so they are the deployed defaults):
- **The payload** is at most 65,600 bytes, or the relay closes with 4000. The box keeps its pieces to
  65,519 (`link/relay/frames.ts:10`).
- **4003 is a count of messages, not bytes:**
  - a token bucket for each device, refilled at **500 messages a second**, holding 1,000;
  - below 1 token, the relay stops reading from the device (`holdBack`);
  - it closes with 4003 only if messages it has already read take the bucket below **−500**.
  - So a device has to keep sending well over 500 a second for seconds while its messages are still
    read. A sender that TCP slows down won't get there.
- **The byte limits are on whoever receives:**
  - when a target has more than **2 MB** waiting (`bufferedAmount`), the sender is held until it's
    under 1 MB;
  - over **8 MB**, the target's connection is cut.
- **The box is one device.** It has a single relay WebSocket (`link/relay/connection.ts:48`) for all
  its phones and peers. Its 500 messages a second, and any hold, apply to all its traffic at once.

**What it means:**
- **Message count against 4003:** at the phone's 1× q50, a frame is one message.
  - One phone watching a busy page uncapped is 60 messages/s, 12% of the box's 500.
  - At 2×, one phone is 180–300 messages/s, up to 60%; two such phones pass 500.
  - None of this would reach 4003 by itself: the relay holds the box first, and TCP slows it. But
    while the box is held, **peer mail, asks and other phones' answers wait behind the pictures**.
- **Bytes against the hold:** these rates (2.9–18.5 MiB/s) are more than a phone on cellular takes
  in.
  - If the box sends faster than a phone reads, the phone's waiting bytes at the relay reach 2 MB,
    and the relay holds the **whole box**, not just that phone's view.
  - Over 8 MB, the phone's connection is cut.
  - So the budget has to limit the bytes in flight to each viewer, not just the average rate.
- **Design change, §3.2's relay bullets and piece 3:** the byte budget becomes concrete:
  - **The phone's frames:** 1× of its panel, quality about 50, so a frame is **one relay message**.
    If a frame would be bigger, the box lowers the quality for the next one. When the page stops, a
    2× sharp picture at q60 (about 110–240 KB, 2–4 messages), as the Mac does.
  - **A frame rate cap** in `Kuvo.view`'s `maxFps`: **15 for a phone**. Busy page: about 15
    messages/s and 0.75 MiB/s. Scrolling: under 21 fps anyway.
  - **At most two frames unacknowledged per viewer**, as `connect` does (`ahead = 2`): at most about
    130 KB in flight per phone, far under the relay's 1–2 MB hold. A slow phone then gets fewer
    frames instead of building a queue.
  - **A ceiling for the whole live view:** about **100 messages/s across all relay viewers**, a fifth
    of the box's 500, so mail and asks always have room. Frames go first; the box checks
    `host.unsent()` (its socket's `bufferedAmount`, `connection.ts:74`) and skips a frame while
    anything is waiting.
  - **The Mac's local panel** (SSH or `serve`) isn't held to the relay's numbers. Its 4–12 MiB/s
    uncapped, measured here, is today's machine behaviour.
- The real relay's bytes per second to a real phone are still to be measured (§7): these numbers
  are local and leave out the phone's link.

## 6. Found along the way

### 6.1 Chrome for Testing for Mac is ad-hoc signed

§2's table says "Google signs Chrome for Testing". **It doesn't, on macOS**:
- `Signature=adhoc`, `linker-signed`, no Team ID;
- `spctl` rejects it.

It runs because the box's own download (`fetch` in `install.ts`) sets no quarantine flag, and
nothing asks Gatekeeper about a file without one.

**Design change, §2's Gatekeeper row:** "The box's own download carries no quarantine flag, so
Gatekeeper never checks it. Chrome for Testing is ad-hoc signed, so it must never get the flag":
- nothing may copy it through a path that adds the flag (a browser download, AirDrop, an archive
  opened in Finder);
- piece 5's tests check the build has no `com.apple.quarantine`.

Also, anything macOS ties to Chrome's own identity follows its code hash, which changes with every
Chrome update. Under the helper, the permissions should go to the helper (Kuvo Code Box) instead;
the later Gatekeeper and prompts spike under the helper stand-in confirms that (§7).

### 6.2 The Preferences key is written on every Chrome start, `CFFIXED_USER_HOME` or not

- The spike's Chrome wrote `~/Library/Preferences/com.google.chrome.for.testing.plist` in the
  **real** home: `{LastRunAppBundlePath = "<the build's app path>"}`.
- It did so on each of its two starts, though `HOME` and `CFFIXED_USER_HOME` were the scratch
  folder's. The preferences daemon uses the account's real home.
- This Mac's own box runs Chrome for Testing too (since Nov 11), so the key was already there with
  that build's path. After the spike I set it back to that path, with `defaults write
  com.google.chrome.for.testing LastRunAppBundlePath -string …`.

What it means:
- §2's "Outside it" is right, and question 7 stands.
- **Design change, piece 7 and §7's test rule:**
  - Any test that starts a real Chrome for Testing on a Mac writes this key in the user's real
    Preferences, whatever its own `HOME`. That breaks "tests never touch real data" and the
    footprint rule.
  - So piece 7's real-Chrome lane runs on Linux (devbox) only, or on a Mac it puts back the value it
    found when it ends, and the lane's docs say so.
  - *Recommend:* Linux only for the lane, with a stand-in Chrome on the Mac.
- `uninstall` removing the key (§2) is still right. On a Mac that's also a machine, the value is
  simply whichever Chrome started last.

## 7. Left for when the user is at the Mac

Each of these needs a prompt, a sign-in or the real relay, so none ran.

| Spike | What it needs |
| --- | --- |
| Prompts' names under a helper stand-in (Local Network, camera and microphone if a page can raise them, Keychain) | A signed helper stand-in with a test bundle ID (a copy of Kuvo Code Box's helper target, with its own ID) that starts the box's tree and Chrome. The user at the Mac to see and screenshot each prompt's wording and the name it shows. A page on the LAN (`192.168…`) for Local Network, and one that calls `getUserMedia` for the camera. Afterwards, `tccutil reset` for the test bundle ID only. **Not tried here:** a page asking for the camera could have prompted in the name of whatever launched this session. |
| Gatekeeper | The helper stand-in starting Chrome for Testing as the box sets it up (no quarantine, ad-hoc, §6.1): confirm nothing is asked. As a control, put the quarantine flag on a scratch copy and see what Gatekeeper says. This needs the user, since it may show a dialog. |
| The Preferences key | Already seen here (§6.2): Chrome writes it on each start, with `CFFIXED_USER_HOME` or not. What's left: confirm that under the helper it's the same key and nothing else lands in `~/Library` (`fs_usage` or a before-and-after listing of `~/Library`). That needs the helper, and `fs_usage` needs `sudo`, so the user. |
| Local Network grant | The helper stand-in's tree running with an `mcp`. Grant Local Network while it runs, then try a LAN page from Chrome started by an old `mcp`, then restart the tree and try again (design §2, "Local Network"). Needs the user to answer the prompt, and a LAN host to open. |
| Signing in at Google, Microsoft and Apple ID | The user's own accounts, in a scratch profile through the keeper (`browser_sign_in` and the user typing on the live view), to see whether each site refuses Chrome for Testing ("This browser or app may not be secure"). Needs the user present for passwords and two-factor; then delete the scratch profile. |
| The real relay's frame bytes | A paired test phone (or the phone simulator with a test link) watching the box's browser through the real relay. This needs piece 3's relay socket, or a throwaway relay client that sends `frames.ts`'s lines as relay messages. Measure bytes per second, the hold (`bufferedAmount` at 2 MB), the frame rate over cellular and Wi-Fi, and that peer mail still gets through with §5's caps. Needs the user's phone, a real relay and a pairing. |

## 8. Design changes, together

1. **§3.2 `serve`:** keep the WebSocket.
   - The upgrade listener checks the `serve.json` password and `canonicalPath` itself.
   - The box writes its own small RFC 6455 framing (no `ws`), with tests for continuation frames,
     ping, close and `drain`.
   - Piece 6 sets URLSession's maximum message size.
2. **§4.5 and piece 2:**
   - read `Cookies` with `bun:sqlite` read-only (`mode=ro`), not `immutable`, and try again on busy;
   - only persistent or unexpired rows;
   - `expires_utc` is 1601-based;
   - a file read while Chrome runs can lag by 30 s.
3. **§3.2's relay bullets, piece 3:** the budget in numbers:
   - phone frames at 1×, q≈50, one relay message each, with a sharp 2× once still;
   - `maxFps` 15 for phones;
   - two frames in flight per viewer;
   - about 100 messages/s for the whole live view over the relay;
   - skip frames while the box's relay socket has anything waiting.
4. **§2's Gatekeeper row:** Chrome for Testing is ad-hoc signed, not Google-signed. It must never get
   the quarantine flag, and piece 5 tests for that.
5. **§7's test rule and piece 7:** a real Chrome on a Mac writes the user's real Preferences key, so
   the real-Chrome lane runs on Linux, or puts the key back.
6. **§7's risks:** "One `mcp` per agent" becomes "a Chrome tab per agent, about 100 MB, for an hour".
   The `mcp` itself is about 16 MB.

**Decision waiting for the user:** whether this Mac's `TAB_IDLE` default should be shorter than an
hour. *Recommend:* keep the hour for now, matching the panel's `agentTabIdle`.

## 9. Footprint

- **Made, all removed:** `~/.kuvo-code/tmp/693-spike` (Chrome's 362 MB build, a 46 MB profile, the
  scripts). Only the logs are kept, in `~/.kuvo-code/tmp/693-spike-log` (under 100 KB).
- **Outside it:**
  - `~/Library/Preferences/com.google.chrome.for.testing.plist` was rewritten by each spike Chrome
    start, and put back to this Mac's own box's build path (§6.2).
  - Nothing in `/tmp`: Chrome's temporary files went to the scratch folder's `TMPDIR`, or its own
    `browser/tmp`.
- **Processes:** every process the spikes started was stopped by its PID (the keeper, the site, the
  proxy; Chrome went with its keeper). None is left (`ps` for `693-spike` is empty).

## Appendix A: the scripts

`clean.sh` runs each command with no `KUVO_*` and the scratch `HOME`. Every `.ts` ran on the
engine's Bun (`BUN_BE_BUN=1 ~/.kuvo-code/engine/2.2.5/opencode --config=/dev/null --no-env-file`),
from the scripts' own folder. `<worktree>` is this repository's checkout.

### `clean.sh`

```sh
#!/bin/sh
# Runs a command with no KUVO_* and HOME in the scratch folder.
S="$HOME/.kuvo-code/tmp/693-spike"
exec env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$S/home" TMPDIR="$S/tmp/" LANG=en_US.UTF-8 "$@"
```

### `proxy.ts`

```ts
// Serves /<host>/<path> from https://<host>/<path>: KUVO_BROWSER_SOURCE's test shape, for the real download.
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const url = new URL(req.url);
  const real = "https:/" + url.pathname;
  if (!real.startsWith("https://storage.googleapis.com/chrome-for-testing-public/")) return new Response("no", { status: 403 });
  return fetch(real, { redirect: "error" });
}});
console.log(server.port);
```

### `install.ts`

```ts
// The box's own install code, into the scratch HOME's .kuvo-code.
import { installBrowser, browserStatus } from "<worktree>/Packages/Box/src/link/browser/install.ts";
import { K, REAL_BOX, IS_MAC } from "<worktree>/Packages/Box/src/link/home.ts";
console.log(JSON.stringify({ K, REAL_BOX, IS_MAC }));
const t = Date.now();
const outcome = await installBrowser({ now: true });
console.log(JSON.stringify({ outcome, seconds: (Date.now() - t) / 1000, status: browserStatus() }));
```

### `site.ts`

```ts
// A local site for the spikes: cookies, and pages for the screencast. 127.0.0.1 only.
const para = (i: number) => `<h2>Section ${i}</h2><p>${"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris. ".repeat(4)}</p><div style="height:180px;border-radius:12px;background:linear-gradient(${i * 37}deg,hsl(${i * 47 % 360} 70% 60%),hsl(${(i * 47 + 120) % 360} 70% 40%))"></div>`;
const shell = (body: string, extra = "") => `<!doctype html><html><head><meta charset=utf-8><title>spike</title><style>body{font:16px -apple-system,Helvetica,sans-serif;margin:24px;color:#222}h1{font-size:28px}${extra}</style></head><body>${body}</body></html>`;
const pages: Record<string, () => Response> = {
  "/cookies": () => {
    const headers = new Headers({ "content-type": "text/html" });
    headers.append("set-cookie", "spike_day=1; Max-Age=86400; Path=/");
    headers.append("set-cookie", "spike_year=2; Max-Age=31536000; Path=/; HttpOnly");
    headers.append("set-cookie", "spike_session=3; Path=/");
    headers.append("set-cookie", `spike_dated=4; Expires=${new Date(Date.now() + 7 * 86400e3).toUTCString()}; Path=/; SameSite=Lax`);
    return new Response(shell("<h1>cookies set</h1><script>document.cookie='spike_js=5; max-age=3600; path=/'</script>"), { headers });
  },
  "/static": () => new Response(shell("<h1>A static page</h1>" + para(1) + para(2)), { headers: { "content-type": "text/html" } }),
  "/long": () => new Response(shell("<h1>A long page</h1>" + Array.from({ length: 60 }, (_, i) => para(i)).join("")), { headers: { "content-type": "text/html" } }),
  // A page that changes all the time, as a busy site does: a moving bar, a spinner and a ticking clock.
  "/anim": () => new Response(shell(`<h1>Busy page <span id=t></span></h1><div class=bar></div><div class=spin></div>${para(1)}${para(2)}<script>setInterval(()=>t.textContent=performance.now().toFixed(0),50)</script>`,
    `.bar{height:40px;width:30%;background:#36c;animation:slide 2s linear infinite alternate;border-radius:8px}@keyframes slide{to{margin-left:70%}}.spin{width:60px;height:60px;border:8px solid #ccc;border-top-color:#c33;border-radius:50%;animation:r 1s linear infinite;margin:20px}@keyframes r{to{transform:rotate(360deg)}}`),
    { headers: { "content-type": "text/html" } }),
  // The worst case: every pixel new every frame, as a video does.
  "/noise": () => new Response(shell(`<canvas id=c width=1600 height=1400 style="width:100%;height:100vh"></canvas><script>const x=c.getContext('2d');const d=x.createImageData(800,700);(function f(){for(let i=0;i<d.data.length;i++)d.data[i]=Math.random()*255;x.putImageData(d,0,0);x.drawImage(c,0,0,800,700,0,0,1600,1400);requestAnimationFrame(f)})()</script>`, "body{margin:0}"), { headers: { "content-type": "text/html" } }),
};
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const page = pages[new URL(req.url).pathname];
  return page ? page() : new Response("not here", { status: 404 });
}});
console.log(server.port);
```

### `frames.ts`

```ts
// Measures the live view's screencast locally, through the keeper's own `connect` (as the Mac's
// MachineBrowser does over SSH): frames, their bytes, and what they'd be as relay messages.
// args: url width height scale maxWidth maxHeight quality seconds action(none|scroll)
import { spawn } from "node:child_process";
const [url, w, h, scale, mw, mh, q, secs, action] = process.argv.slice(2);
const SCRIPT = `${process.env.HOME}/.kuvo-code/bin/kuvo-browser.js`;
const child = spawn(process.execPath, ["--config=/dev/null", "--no-env-file", SCRIPT, "connect"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, BUN_BE_BUN: "1" } });
let next = 1;
const waiting = new Map<number, (r: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((resolve) => {
  const id = next++;
  waiting.set(id, resolve);
  child.stdin.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\n");
});
const frames: { at: number; line: number; jpeg: number }[] = [];
let measuring = false;
let session = "";
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)!(message); waiting.delete(message.id); continue; }
    if (message.method === "Page.screencastFrame") {
      if (measuring) frames.push({ at: performance.now(), line: Buffer.byteLength(line) + 1, jpeg: Buffer.from(message.params.data, "base64").length });
      child.stdin.write(JSON.stringify({ id: next++, method: "Page.screencastFrameAck", params: { sessionId: message.params.sessionId }, sessionId: message.sessionId }) + "\n");
    }
  }
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const created = await send("Target.createTarget", { url: "about:blank", newWindow: true });
const target = created.result.targetId;
const attached = await send("Target.attachToTarget", { targetId: target, flatten: true });
session = attached.result.sessionId;
await send("Page.enable", {}, session);
await send("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: Number(scale), mobile: false }, session);
await send("Page.navigate", { url }, session);
await sleep(1500);
await send("Page.startScreencast", { format: "jpeg", quality: Number(q), maxWidth: Number(mw), maxHeight: Number(mh) }, session);
await sleep(500);
measuring = true;
const start = performance.now();
let scroller: ReturnType<typeof setInterval> | undefined;
if (action === "scroll") {
  // A steady scroll, as a trackpad's: 20 wheel events a second.
  scroller = setInterval(() => send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: 60 }, session), 50);
}
await sleep(Number(secs) * 1000);
measuring = false;
if (scroller) clearInterval(scroller);
const elapsed = (performance.now() - start) / 1000;
await send("Page.stopScreencast", {}, session);
await send("Target.closeTarget", { targetId: target });
child.stdin.end();
child.kill();
// What a relay message carries of a text line: 65,519 bytes less its head (~60).
const ROOM = 65_519 - 2 - 60;
const lines = frames.map(f => f.line).sort((a, b) => a - b);
const jpegs = frames.map(f => f.jpeg).sort((a, b) => a - b);
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const pct = (a: number[], p: number) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const messages = sum(frames.map(f => Math.ceil(f.line / ROOM)));
console.log(JSON.stringify({
  url: url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ""), view: `${w}x${h}@${scale}`, max: `${mw}x${mh}`, quality: Number(q), action,
  seconds: Number(elapsed.toFixed(1)), frames: frames.length, fps: Number((frames.length / elapsed).toFixed(1)),
  jpegMedianKB: Number((pct(jpegs, 0.5) / 1024).toFixed(1)), jpegP95KB: Number((pct(jpegs, 0.95) / 1024).toFixed(1)),
  lineMedianKB: Number((pct(lines, 0.5) / 1024).toFixed(1)),
  wireKBps: Number((sum(lines) / elapsed / 1024).toFixed(0)), relayMsgsPerSec: Number((messages / elapsed).toFixed(1)),
}));
process.exit(0);
```

### `cookies.ts`

```ts
// Opens the site's /cookies page through the keeper's `connect`, then watches the profile's Cookies
// file while Chrome runs: when the cookies reach it, and whether it reads (read-only, immutable, a copy).
// args: url
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
const [url] = process.argv.slice(2);
const K = `${process.env.HOME}/.kuvo-code`;
const DB = `${K}/browser/profile/Default/Cookies`;
const child = spawn(process.execPath, ["--config=/dev/null", "--no-env-file", `${K}/bin/kuvo-browser.js`, "connect"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, BUN_BE_BUN: "1" } });
let next = 1, buffer = "";
const waiting = new Map<number, (r: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((resolve) => {
  const id = next++;
  waiting.set(id, resolve);
  child.stdin.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\n");
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
  }
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sql = "select host_key, name, expires_utc, has_expires, is_persistent, length(encrypted_value) as enc, length(value) as plain from cookies where name like 'spike%' order by name";
const tryRead = (how: string, file: string) => {
  try {
    const out = execFileSync("/usr/bin/sqlite3", ["-json", file, sql], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
    return { how, ok: true, rows: out.trim() ? JSON.parse(out) : [] };
  } catch (error: any) {
    return { how, ok: false, error: String(error.stderr || error.message).trim().slice(0, 200) };
  }
};
const created = await send("Target.createTarget", { url: "about:blank", newWindow: true });
const target = created.result.targetId;
const session = (await send("Target.attachToTarget", { targetId: target, flatten: true })).result.sessionId;
await send("Page.enable", {}, session);
const navigated = Date.now();
await send("Page.navigate", { url }, session);
await sleep(1000);
// What Chrome itself says (Storage.getCookies, the box's way while it runs).
const live = await send("Storage.getCookies", {});
console.log(JSON.stringify({ step: "Storage.getCookies", cookies: live.result.cookies.filter((c: any) => c.name.startsWith("spike")).map((c: any) => ({ name: c.name, domain: c.domain, expires: c.expires, session: c.session })) }));
console.log(JSON.stringify({ step: "files", files: fs.readdirSync(`${K}/browser/profile/Default`).filter(n => n.startsWith("Cookies")) }));
// Watch the file until the cookies are there (a minute at most).
let seenAt = -1;
for (let i = 0; i < 90; i++) {
  const r = tryRead("immutable", `file:${DB}?immutable=1`);
  if (r.ok && r.rows.length) { seenAt = (Date.now() - navigated) / 1000; break; }
  await sleep(1000);
}
console.log(JSON.stringify({ step: "on disk after s", seenAt }));
console.log(JSON.stringify(tryRead("plain open (no flags), Chrome running", DB)));
console.log(JSON.stringify(tryRead("mode=ro", `file:${DB}?mode=ro`)));
console.log(JSON.stringify(tryRead("immutable=1", `file:${DB}?immutable=1`)));
const copy = `${process.env.TMPDIR}/Cookies-copy`;
for (const suffix of ["", "-journal", "-wal"]) { try { fs.copyFileSync(DB + suffix, copy + suffix); } catch {} }
console.log(JSON.stringify(tryRead("a copy", copy)));
for (const suffix of ["", "-journal", "-wal"]) fs.rmSync(copy + suffix, { force: true });
// Is it locked? (lsof shows who holds it.)
try { console.log(JSON.stringify({ step: "lsof", out: execFileSync("/usr/sbin/lsof", ["-F", "pa", DB], { encoding: "utf8" }).trim().split("\n").join(" ") })); } catch (e: any) { console.log(JSON.stringify({ step: "lsof", error: String(e.message).slice(0, 100) })); }
await send("Target.closeTarget", { targetId: target });
child.kill();
process.exit(0);
```

### `bun-sqlite.ts`

```ts
// The box's way to read SQLite (bun:sqlite, read-only, as agents/usage/engine-db.ts does), on Chrome's live Cookies.
import { Database } from "bun:sqlite";
const file = `${process.env.HOME}/.kuvo-code/browser/profile/Default/Cookies`;
for (const [how, open] of [["readonly", () => new Database(file, { readonly: true })], ["uri immutable", () => new Database(`file:${file}?immutable=1`, { readonly: true })]] as const) {
  try {
    const db = open();
    const rows = db.query("select host_key, name, expires_utc, is_persistent from cookies where name like 'spike%' order by name").all();
    db.close();
    console.log(JSON.stringify({ how, ok: true, rows: rows.length, first: rows[0] }));
  } catch (e) { console.log(JSON.stringify({ how, ok: false, error: String(e) })); }
}
```

### `mcp.ts`

```ts
// Starts N `kuvo-browser.js mcp` (one per agent, as agents/kuvotools.ts's stdio program does) and
// measures each one's memory: after starting, after initialize + tools/list, after one browser call.
// args: N url
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
const [n, url] = process.argv.slice(2);
const K = `${process.env.HOME}/.kuvo-code`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Agent = { child: ChildProcess; next: number; waiting: Map<number, (r: any) => void>; buffer: string; session: string };
const agents: Agent[] = [];
for (let i = 0; i < Number(n); i++) {
  const session = `ses_spike_${i}`;
  // As the engine starts it: the engine's own Bun (BUN_BE_BUN=1), KUVO_SESSION for the agent.
  const child = spawn(process.execPath, ["--config=/dev/null", "--no-env-file", `${K}/bin/kuvo-browser.js`, "mcp"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, BUN_BE_BUN: "1", KUVO_SESSION: session } });
  const agent: Agent = { child, next: 1, waiting: new Map(), buffer: "", session };
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    agent.buffer += chunk;
    let nl: number;
    while ((nl = agent.buffer.indexOf("\n")) >= 0) {
      const line = agent.buffer.slice(0, nl); agent.buffer = agent.buffer.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && agent.waiting.has(m.id)) { agent.waiting.get(m.id)!(m); agent.waiting.delete(m.id); }
    }
  });
  agents.push(agent);
}
const call = (a: Agent, method: string, params: any = {}) => new Promise<any>((resolve) => {
  const id = a.next++;
  a.waiting.set(id, resolve);
  a.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
// Resident memory (ps, KB) and the system's own footprint (MB) of each process.
const measure = (label: string, pids: number[]) => {
  const rss = execFileSync("/bin/ps", ["-o", "pid=,rss=", "-p", pids.join(",")], { encoding: "utf8" }).trim().split("\n").map(l => l.trim().split(/\s+/).map(Number));
  let footprints: number[] = [];
  try {
    const out = execFileSync("/usr/bin/footprint", pids.flatMap(p => ["-p", String(p)]), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    footprints = [...out.matchAll(/phys_footprint:\s*([\d.]+)\s*([KMG]B)/g)].map(m => Number(m[1]) * (m[2] === "GB" ? 1024 : m[2] === "KB" ? 1 / 1024 : 1));
  } catch {}
  const rssMB = rss.map(([, kb]) => Math.round(kb / 1024));
  console.log(JSON.stringify({ label, n: pids.length, rssMB, rssTotalMB: rssMB.reduce((s, x) => s + x, 0), footprintMB: footprints.map(x => Math.round(x)), footprintTotalMB: Math.round(footprints.reduce((s, x) => s + x, 0)) }));
};
const pids = agents.map(a => a.child.pid!);
await sleep(1500);
measure("started", pids);
await Promise.all(agents.map(async a => {
  await call(a, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "spike", version: "0" } });
  a.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await call(a, "tools/list");
  if (a === agents[0]) console.log(JSON.stringify({ tools: tools.result?.tools?.length }));
}));
await sleep(1000);
measure("after initialize + tools/list", pids);
const answers = await Promise.all(agents.map(a => call(a, "tools/call", { name: "browser_navigate", arguments: { url }, _meta: { "ai.opencode/sessionID": a.session } })));
console.log(JSON.stringify({ navigate: answers.map(r => r.error ? "error: " + JSON.stringify(r.error).slice(0, 120) : (r.result?.isError ? "tool error: " + JSON.stringify(r.result.content).slice(0, 160) : "ok")) }));
await sleep(2000);
measure("after one browser_navigate each", pids);
await Promise.all(agents.map(a => call(a, "tools/call", { name: "browser_snapshot", arguments: {}, _meta: { "ai.opencode/sessionID": a.session } })));
await sleep(2000);
measure("after a browser_snapshot each", pids);
for (const a of agents) a.child.stdin!.end();
await sleep(1000);
for (const a of agents) if (a.child.exitCode === null) a.child.kill();
process.exit(0);
```

### `serve-ws.ts`

```ts
// `serve` with a WebSocket at kuvo/browser/view: the box's own serveBox (node:http), an `upgrade`
// listener added, under the engine's Bun. Then the fallback: a streamed GET plus POSTs.
// The handshake and frames are written by hand (RFC 6455): the box has no `ws` package.
import crypto from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
const W = process.argv[2];
const { serveBox } = await import(`${W}/Packages/Box/src/link/server/serve.ts`);
const password = crypto.randomBytes(16).toString("hex");
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
const FRAME = Buffer.alloc(150_000, "A").toString(); // about one Mac frame as a text line
const COUNT = 200;
const results: Record<string, unknown> = { bun: process.versions.bun };

// A stand-in for the box's routes: GET kuvo/browser/view streams lines; POST kuvo/browser/input echoes.
async function* handle(request: any) {
  if (request.method === "GET" && request.path === "kuvo/browser/view") {
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    for (let i = 0; i < COUNT; i++) yield { body: Buffer.from(JSON.stringify({ method: "Kuvo.frame", params: { i, data: FRAME } }) + "\n") };
    return;
  }
  if (request.method === "POST" && request.path === "kuvo/browser/input") {
    yield { head: { status: 200, headers: { "content-type": "application/json" } }, body: request.body };
    return;
  }
  yield { head: { status: 404 } };
}
const server: http.Server = serveBox(password, handle as any);

// The upgrade: the same password, the same path, then frames both ways.
let upgrades = 0;
server.on("upgrade", (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
  upgrades++;
  if (request.headers.authorization !== auth) { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
  if (request.url !== "/kuvo/browser/view" || request.headers.upgrade?.toLowerCase() !== "websocket") { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  const accept = crypto.createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = (text: string, opcode = 1) => {
    const body = Buffer.from(text);
    const len = body.length;
    const header = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
    socket.write(Buffer.concat([header, body]));
  };
  let pending = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0]! & 15;
      let len = pending[1]! & 127, offset = 2;
      if (len === 126) { len = pending.readUInt16BE(2); offset = 4; } else if (len === 127) { len = Number(pending.readBigUInt64BE(2)); offset = 10; }
      const masked = (pending[1]! & 128) !== 0;
      const need = offset + (masked ? 4 : 0) + len;
      if (pending.length < need) return;
      const mask = masked ? pending.subarray(offset, offset + 4) : null;
      const data = Buffer.from(pending.subarray(offset + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]!;
      pending = pending.subarray(need);
      if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
      const message = JSON.parse(data.toString());
      if (message.method === "Kuvo.view") {
        // Frames as the keeper would send them, as fast as the socket takes them.
        for (let i = 0; i < COUNT; i++) send(JSON.stringify({ method: "Kuvo.frame", params: { i, data: FRAME } }));
      } else if (message.method === "Kuvo.input") {
        send(JSON.stringify({ method: "Kuvo.inputDone", params: message.params }));
      }
    }
  });
  socket.on("error", () => {});
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as any).port;
const base = `ws://127.0.0.1:${port}/kuvo/browser/view`;

// 1. The WebSocket, with the password as a header (Bun's WebSocket takes headers, as URLSession does).
async function viaSocket(label: string, headers: Record<string, string>) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const t0 = performance.now();
    const ws = new WebSocket(base, { headers } as any);
    let frames = 0, bytes = 0, opened = 0, inputAt = 0, inputMs = -1;
    const timer = setTimeout(() => { ws.close(); resolve({ label, error: "timed out", frames }); }, 15_000);
    ws.onopen = () => { opened = performance.now() - t0; inputAt = performance.now(); ws.send(JSON.stringify({ method: "Kuvo.input", params: { kind: "mouse", x: 1, y: 2 } })); };
    ws.onmessage = (event) => {
      const text = String(event.data);
      const message = JSON.parse(text);
      if (message.method === "Kuvo.inputDone") { inputMs = performance.now() - inputAt; ws.send(JSON.stringify({ method: "Kuvo.view", params: {} })); return; }
      frames++; bytes += text.length;
      if (frames === COUNT) {
        const seconds = (performance.now() - inputAt - inputMs) / 1000;
        clearTimeout(timer); ws.close();
        resolve({ label, ok: true, openMs: Math.round(opened), inputRoundTripMs: Number(inputMs.toFixed(2)), frames, MBps: Number((bytes / seconds / 1e6).toFixed(0)) });
      }
    };
    ws.onerror = () => { clearTimeout(timer); resolve({ label, ok: false, error: "error event", frames }); };
    ws.onclose = (e) => { if (frames < COUNT && inputMs < 0) { clearTimeout(timer); resolve({ label, ok: false, closed: e.code, frames }); } };
  });
}
results.websocket = await viaSocket("WebSocket with the password", { Authorization: auth });
results.websocketNoPassword = await viaSocket("WebSocket without it", {});
results.upgradesSeen = upgrades;

// 2. The fallback: a streamed GET (newline JSON) plus a POST for input.
{
  const t0 = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/kuvo/browser/view`, { headers: { Authorization: auth } });
  const firstByte = performance.now() - t0;
  let frames = 0, bytes = 0, rest = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body as any) {
    rest += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = rest.indexOf("\n")) >= 0) { bytes += nl + 1; rest = rest.slice(nl + 1); frames++; }
  }
  const seconds = (performance.now() - t0) / 1000;
  const posts: number[] = [];
  for (let i = 0; i < 20; i++) {
    const p0 = performance.now();
    const r = await fetch(`http://127.0.0.1:${port}/kuvo/browser/input`, { method: "POST", headers: { Authorization: auth }, body: JSON.stringify({ kind: "mouse", x: i }) });
    await r.text();
    posts.push(performance.now() - p0);
  }
  posts.sort((a, b) => a - b);
  results.streamedGet = { status: response.status, firstByteMs: Math.round(firstByte), frames, MBps: Number((bytes / seconds / 1e6).toFixed(0)), postMedianMs: Number(posts[10]!.toFixed(2)), postMaxMs: Number(posts[19]!.toFixed(2)) };
}
// 3. The ordinary routes still answer on the same server, after the upgrades.
{
  const r = await fetch(`http://127.0.0.1:${port}/kuvo/browser/input`, { method: "POST", headers: { Authorization: auth }, body: "{}" });
  const wrong = await fetch(`http://127.0.0.1:${port}/kuvo/browser/input`, { method: "POST", body: "{}" });
  results.plainRoutesAfter = { withPassword: r.status, without: wrong.status };
}
console.log(JSON.stringify(results, null, 1));
server.close();
process.exit(0);
```

### `serve-drain.ts`

```ts
// Backpressure on an upgraded node:http socket under Bun: a client that stops reading; does write()
// say false, does 'drain' come once it reads again, and how much was buffered meanwhile.
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
const server = http.createServer((_q, r) => r.end());
const chunk = Buffer.alloc(100_000, 1);
const out: Record<string, unknown> = { bun: process.versions.bun };
server.on("upgrade", (request, socket) => {
  const accept = crypto.createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let written = 0, writes = 0;
  const pump = () => {
    while (writes < 2000) {
      writes++; written += chunk.length;
      if (!socket.write(chunk)) { out.falseAfterKB = Math.round(written / 1024); out.writableLengthKB = Math.round(((socket as any).writableLength ?? -1) / 1024); socket.once("drain", () => { out.drains = ((out.drains as number) ?? 0) + 1; pump(); }); out.writtenKB = Math.round(written / 1024); return; }
    }
    out.neverFalse = true;
  };
  pump();
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
const client = net.connect(port, "127.0.0.1");
await new Promise(r => client.once("connect", r));
client.write(`GET /x HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n\r\n`);
client.pause();
await new Promise(r => setTimeout(r, 1000));
out.beforeReading = { ...out };
let got = 0;
client.on("data", d => { got += d.length; });
client.resume();
await new Promise(r => setTimeout(r, 1000));
out.clientGotKB = Math.round(got / 1024);
console.log(JSON.stringify(out));
client.destroy(); server.close(); process.exit(0);
```
