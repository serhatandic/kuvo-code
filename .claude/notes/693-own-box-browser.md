# #693 This Mac's box runs its own browser: design

Status: design only, written 2026-11-14 against main at `708019fcf`, revised after one reviewer pass
(§9). Nothing here is built. Read with `333-own-box-independent.md` and `333-piece-0-results.md`
(main checkout's `.claude/notes`, untracked) and PROTOCOL.md's "The browser on a machine"
(`Packages/KuvoLink/PROTOCOL.md:2325`).

## 0. In short

- **This Mac's box sets up and runs Chrome for Testing the way every machine's box already does**
  (`Packages/Box/src/link/browser/install.ts`, pin `mac.json`), in the box's own `browser/` folder.
- **The Mac's part comes after #333's move** to `~/.kuvo-code` (question 1).
  - The box's `kuvo-browser.js` reaches its box through `K/bin/kuvo-link.js` (`kuvo-browser.js:217`,
    `:2201`, `:2329`). A box still in the app's folder runs the app's own copy (`BoxProcess.swift:76-80`)
    and has none there.
  - Pieces that help every box (#59, the view protocol, browser data, the vault on the box's browser)
    land before the move.
- **Agents on this Mac browse in it** through the box's own `kuvo-browser.js mcp`, as on a machine.
  The app doesn't need to be open, which removes #211's hidden opening and #333 piece 3's sending of
  browser tools to the app.
- **Every panel is a live view of a box's browser.**
  - The Swift app shows it with the code it already uses for machines.
  - The phone and GPUI use one view protocol: the machine one, plus a short vocabulary so a client
    needs no CDP.
  - It reaches clients over SSH stdio, the relay's socket or the box's local server.
  - The box decides each page's size, and every page's address follows the agent (#59).
- **Sign-ins, history, website data, the vault's fills, asks, screenshots and PDFs are the box's.**
  The WebKit panel and its agent leave the Swift app.
- **One box-owned switch** (`browser.own` in the box's settings, off) chooses this Mac's browser.
  - The old path stays while it's off.
  - Deleting the old path is the last box piece, after the rehearsals.
  - The app draws whichever browser the box says it uses.
- **Accepted cost:** sites signed in through the old panel need one new sign-in. Some sites may
  refuse a sign-in in Chrome for Testing; piece 0 checks the big ones first.
- **Costs not yet accepted,** each a question in §8:
  - no sound, choppier video, and no VoiceOver inside pages;
  - the panel's password key, save offers and suggestions (if the Swift pane doesn't get them);
  - saved passwords crossing computers.

## 1. Today

- **A machine's browser** (the Mini, Linux):
  - The box installs it (`install.ts`), and `kuvo-browser.js host` runs it headless
    (`KuvoCode/Resources/kuvo-browser.js:637`), with clients joining through `run/browser.sock`
    (`:28`).
  - On macOS it already has `--use-mock-keychain` (`:514`) and `CFFIXED_USER_HOME` (`:585`).
  - A Mac sees it through `kuvo-browser.js connect` over SSH (`:1252`).
  - `MachineBrowser.swift` (1,437 lines) draws it with raw CDP: its own viewport
    (`applyViewport`, `:836`), screencast, history and input (`:1088-1180`); the connection is at
    `:1210`. `MachineBrowserPane.swift` has no password key, save offer or suggestions.
- **This Mac's box has none:**
  - `install.ts:76` downloads only when `!IS_MAC`, `install.ts:214` says "browse in its app's
    panel", and `server/router.ts:103` doesn't answer `kuvo/browser` on a Mac.
  - Agents use the WebKit panel: `BrowserAgent.swift` (1,177) through `BrowserToolServer.swift`
    (622).
  - The keeper relays the tools (`KeeperTools.swift`, `KeeperBoxTools.swift`, `Keeper.swift:201`) and
    opens the app hidden when it's closed (`AppOpener.swift`, #211).
  - A Mac-kind box in a home of its own sends `browser_*` to the registered app
    (`kuvo-browser.js:2239`, `:2934`, `:2953`; `link/mac/app.ts`; PROTOCOL.md:6028-6060).
- **What the WebKit panel and the app hold:**
  - cookies and sign-ins in WebKit's store;
  - history in `S/Browser/history.json` and `Icons/` (`BrowserHistory.swift:27`);
  - saved passwords, the key fill, save offers, and "Offer to save" and the Never sites in the
    app's `UserDefaults` (`Passwords.swift:8`, `:25-31`, `:89-92`);
  - fields filled in a world of their own, `kuvo-passwords`, and marked `data-kuvo-secret` so the
    agent never reads them (`BrowserAgent.swift:1105`);
  - asks (`BrowserAsks.swift`), PDFs (`PagePrinter.swift`), passkeys (`Passkeys.swift`);
  - whether X, LinkedIn and Reddit are signed in, from WebKit cookies by a Swift cookie table
    (`SiteSignIns.swift`, `Integrations.swift:261-265`), which the box asks the app for
    (`sites/signed-in`, PROTOCOL.md:6148);
  - Settings › Browser.
- **This Mac's saved passwords sign in on machines too.**
  - The Mac's ask card lists every machine's asks, fills any of them from this Mac's vault
    (`BrowserAskCard.swift:85-87`, `:248-260`), and saves what you type there into this Mac's vault
    (`BrowserAsks.keep`).
  - A machine's own `saved` is empty (PROTOCOL.md:3886). The Mac's own box lists its machines' asks
    for phones (PROTOCOL.md:3869).
- **The browsing scripts and tool definitions are Swift**, filled into `kuvo-browser.js` by
  `MachineBrowserInstaller.helper` (`MachineBrowserInstaller.swift:52-82`). Its keeper version,
  `KEEPER = 50` (`:63`), is bumped by hand.
- **No phone or GPUI client shows a browser.** The phone has ask cards only.
- **Sockets:**
  - the relay carries sockets only to the engine (`relay/host.ts:209`, `areas/engine.ts:178`,
    PROTOCOL.md:5525), and a binary message over about 65 KB doesn't go (`:5530`);
  - the relay slows or closes (4003) a device that sends too much (`:83-87`);
  - `serve` (`server/serve.ts:39`, `node:http`) has no sockets.

## 2. Install, run and update on this Mac

**Install and update: the machine path.**
- The pin, the checks, staging, `current`, retries and `kuvo/browser` stay as they are.
- Changes:
  - `install.ts:76` and `:214` and `router.ts:103` drop their Mac gates;
  - PROTOCOL.md:2330 says every box has one;
  - `POST kuvo/browser {start: true}` is new: it starts the keeper as well as the setup
    (`install.ts:665-671` only sets up).
- **When:** at the first browser use, or at the box's start (question 6).
- **Demo copies** (`REAL_BOX` is true for any `run.kuvo.code…` folder, `home.ts:160-163`) don't
  download Google's build. They use `KUVO_BROWSER_SOURCE` if it's set, else nothing; today
  `install.ts:82` ignores it there.

**Where it lives:** `~/.kuvo-code/browser`:
- `<build>` and `current`;
- `profile`, `home`, `tmp`;
- `downloads` (a week);
- `history.json` and `icons/` (new, §4.2).

About 600 MB per build, plus one more during an update. The builds are excluded from Time Machine
(`tmutil addexclusion` on `browser/<build>`: an attribute on our own folder).

**Outside it** (question 7): macOS writes Chrome's last run to
`~/Library/Preferences/com.google.chrome.for.testing.plist`, as on Mac machines
(`docs/footprint.md:8`).
- Today the app's uninstall-from-machine script removes that key (`Machines.swift:1546`).
- It moves into the box's `kuvo-link.js uninstall` (`link/uninstall.ts`), for every Mac box.

**Who runs it:** only the box's process tree, so macOS attributes Chrome to **Kuvo Code Box**, the
helper (`333-piece-0-results.md` §1), never to a client.
- The engine's `kuvo-browser.js mcp` and `serve` may start `host` (`startKeeper`, `:295`, detached).
- **`connect` never starts it on a Mac:** it asks the box (`POST kuvo/browser {start: true}`). A
  `connect` the app runs locally would make the app responsible for Chrome and everything it
  starts.

**macOS permissions:**

| What | Who's asked | Notes |
| --- | --- | --- |
| Local Network (a `192.168…` page) | Kuvo Code Box | See below. |
| Keychain | nobody | `--use-mock-keychain`: cookies are kept with Chrome's fixed key, so they're as good as plain text on disk, behind the folder's 0700 and FileVault. |
| Camera, microphone, location, notifications | nobody, if question 8 says so | The keeper refuses them for pages (`Browser.setPermission`), so a page can't make macOS ask in Kuvo Code Box's name. Piece 0 checks whether headless Chrome would ask at all. |
| Screen Recording, Accessibility | not needed | The live view is Chrome's own screencast. |
| Gatekeeper | nobody | The box's own download carries no quarantine flag; Google signs Chrome for Testing. Piece 0 checks under the helper. |
| Files (Desktop, Documents, Downloads) | not needed | Uploads come as bytes (§3.3). Save to Downloads is the app's copy, and the app already has access. |

**Local Network:**
- Piece 0 found a grant reaches only a process tree started after it: new children of an engine
  that was already running stay blocked (3b, 3c). So after Allow, the box restarts its tree
  (engine, `mcp`, browser keeper) at the next quiet moment, as #333 §4.3 plans. Until then the
  agent hears "waiting for Local Network permission on this Mac".
- **Denied:** the agent hears "Kuvo Code Box isn't allowed on your local network: System Settings ›
  Privacy & Security › Local Network". The panel's page shows Chrome's own error.
- Piece 0 tests exactly this (§7).

## 3. The panel: a live view on every client

### 3.1 The protocol

Keep the machine protocol (newline JSON, `Kuvo.*`, the CDP relay, `kuvo-browser.js:1000-1210`), and
add a **view vocabulary** of facts, so a client draws without CDP. Feature `browser.view`.

- **Facts the keeper sends:**
  - `Kuvo.pages {pages: [{targetId, url, title, opener, session, loading, canGoBack, canGoForward,
    working, held, dialog?, passkey?}], active}` on every change. Every page's address, the agent's
    included: **this is #59**.
  - `Kuvo.frame {targetId, data, width, height, scrollX, scrollY}`, and `Kuvo.viewport {targetId,
    width, height, scale, by}`.
  - `Kuvo.cursor`, `Kuvo.dialog`, `Kuvo.offerSave` (§4.1), and `Kuvo.external {url}` for a `mailto:`
    or another app's link, which the client opens where it is.
  - Already there: `asked`/`askClosed`, `downloaded`, `installing`, `error`.
- **What a client asks:**
  - `Kuvo.view {targetId | null, width, height, scale, zoom, quality, maxFps}`;
  - `Kuvo.input {kind: mouse | wheel | key | text | compose}`: `modifiers` name the client's own
    keys, and the keeper maps Mac shortcuts (`keyForHere`, `:490`), so Control on Linux or Windows
    acts as Command;
  - `Kuvo.go {targetId, input | back | forward | reload | stop}`: the box turns typed text into an
    address or a search, with its own search engine;
  - `Kuvo.newTab`, `Kuvo.close`, `Kuvo.dialogAnswer`, `Kuvo.selection`, `Kuvo.at {x, y}`;
  - `Kuvo.upload` (§3.3);
  - already there: `Kuvo.hold`, `Kuvo.claim`, `Kuvo.viewing`.
- **The box decides each page's size:**
  - While an agent works in a page, the page keeps the agent's size, and viewers get scaled
    frames.
  - Otherwise the latest client to show it or give it input sets it.
  - Frames are made once per size and quality class (the Mac at 2× and quality 75, the phone
    lower), not once per viewer.
  - The keeper takes over `Emulation.setDeviceMetricsOverride` and `Page.start/stopScreencast` from
    raw-CDP clients (today's `MachineBrowser`, `:836-843`), applying them through the same rule, so
    the Swift app works unchanged and can't undo it.
- **The client keeps:**
  - drawing and scaling frames;
  - the address field while you type;
  - window and selection state;
  - "Show the panel when the agent browses", from `working`;
  - a tab's name (title, else the host without `www.`, else "New Tab", `MachineBrowser.Page.name`),
    which moves to KuvoClient and PROTOCOL.md.

### 3.2 Transports, one message stream each

| From | Way | |
| --- | --- | --- |
| A client to a machine over SSH | `kuvo-browser.js connect`, stdio | built |
| A client on the same computer | `serve`: `GET kuvo/browser/view`, upgraded to a WebSocket (`serve.json` password) | new; piece 0 checks `node:http` upgrades under the engine's Bun, else a streamed GET plus POSTs |
| A phone or any client through the relay | a socket at `kuvo/browser/view` (`relay/host.ts:209`): `socketAllowed` takes the path, and a second opener sends it to the keeper | new |

- The box joins `browser.sock` with the socket key (`:91`); a client never does.
- Through the relay:
  - Frames go as text messages in pieces, joined at the newline. One JPEG is often over 65 KB, and
    binary that size doesn't go.
  - The box gives the live view a byte budget well under the relay's limits, and drops frames first,
    so peer mail, asks and notices never wait behind pictures and the link is never closed (4003).
  - Piece 0 measures a phone's bytes per second against the real relay.
- Peers exchange mail only, so another box can't drive this Mac's browser.

### 3.3 Input, navigation, uploads

- Clicks, scrolling, keys, IME, paste and copy work as `MachineBrowser` does them, now in the
  keeper.
- **Files you choose** (`Page.fileChooserOpened`) come as bytes: `Kuvo.upload {targetId, files:
  [{name, data}]}`, 50 MB in all. The box writes them to `browser/tmp/uploads` and sets them, so
  phones and remote boxes work alike and Chrome needs no folder permission.
- Dropping a file onto a page isn't covered (not built for machines either).
- **Take Over and Hand Back** are `Kuvo.hold`, which already exists.

## 4. Vault, passwords, asks, screenshots, PDFs

### 4.1 Vault and saved passwords, on every box

- **Agents' fills** go through `kuvo/vault/fill` (PROTOCOL.md:6935), as on machines.
  - On a Mac it answers only the app today. It now answers `kuvo-browser.js` on `serve`, with the
    `serve.json` password.
  - `x-kuvo-from` is only a header (`serve.ts:66-70`). The real checks stay: the password, the
    conversation calling now, and one fill per call (`areas/vault.ts:161-180`). So this asks no
    less than the app's path does today.
  - The sandbox keeps agents' commands from the password file (PROTOCOL.md:7559). What runs as you
    outside the sandbox could already reach the app's path.
- **Your own fill** (the key): `POST kuvo/browser/fill {targetId, item}`.
  - The client asks for Touch ID or Face ID first.
  - The box checks, at fill time, that the item is for the site of the frame it fills.
  - The password never reaches a client; today the app reads it.
  - A paired phone can already read vault values (`areas/vault.ts:294-300`), so this widens nothing.
- **Filled fields stay hidden from the agent:**
  - The keeper fills in a world of its own (`Page.createIsolatedWorld`, `kuvo-passwords`), with
    `Runtime.addBinding` bound to that world only, so a page's scripts can't fake `offerSave`.
  - It marks every field you or the vault filled `data-kuvo-secret`, so snapshots, `browser_text`
    and screenshots mask it, as WebKit's do today.
- **Offer to save:**
  - The keeper notices a password form sent over https and holds what was typed in memory for five
    minutes. It says `Kuvo.offerSave` (no password), and `Kuvo.save {id}` keeps it in the box's
    vault.
  - "Offer to save" and the Never sites become box settings (`kuvo/browser/settings`). The app's
    `UserDefaults` values are written there once.
- **Asks' `saved` and `offersToSave`** come from the asking box's own vault on every box, and the
  box fills a `{"saved"}` answer.
- **This Mac's sign-ins for a machine's ask** are question 2. Until it's answered:
  - nothing is built on either side;
  - the Swift app keeps doing what it does today (filling a machine's ask from this Mac's vault),
    not extended, and listed as client logic left to move.

### 4.2 History

- The box keeps `browser/history.json` in `BrowserHistory`'s shape and limit (300 hosts, visits and
  recency), from every navigation, agents' included, as WebKit's did.
- It keeps icons in `browser/icons`, fetched by Chrome from the page's `<link rel=icon>`.
- `GET kuvo/browser/history` and `DELETE` (a host, or all).
- **The old history moves in once:** `history.json` and `Icons/`, read by the box from `S/Browser`.
  #333's move knows `S`; the box reads it only, never a client handing it over.
- **Built in piece 2** (PROTOCOL.md, "The browser's data"): the keeper only appends what loaded
  (and an icon Chrome fetched) to `browser/visits.jsonl`; the box folds it into `history.json`, so
  how history is kept is said once, in `link/browser/history.ts`. The one-time read runs the first
  time a Mac box's `kuvo/browser/…` is asked; piece 5 should make sure nothing asks before
  `browser.own` turns on, or the app's later history won't be taken.

### 4.3 Ask-the-user, sign-in and one-time-code tools

- Already the box's on machines (`askUser`, `:1831`; `run/browser-asks.json`; `kuvo/asks`).
- On this Mac, `kuvo/asks` leaves `MAC_APP_ROUTES` (`link/mac/relay.ts:41`), so the box answers it
  with the app closed.
- **Each box lists only its own asks.** This Mac's box stops listing its machines'. Phones that
  follow each box's own list (`LinkStore.swift:451`) see no change. An older phone that relied on
  the Mac's copy sees a machine's asks only by following that machine.
- PROTOCOL.md:3886-3900's fallbacks to the Mac's copy go.
- The box's bridge sends ask notices to phones; the app's `kuvo/attention/notice` for panel asks
  goes.
- On a Mac-kind box, `phoneCanAnswer` (`:1880`) reads the Mac's link state rather than
  `link.json`.

### 4.4 Screenshots, PDFs, downloads

- `browser_screenshot` (`:1795`, filled fields masked) and `browser_save_pdf` (`Page.printToPDF`,
  `:2707`) are the box's. `PagePrinter.swift` goes.
- Downloads go to `browser/downloads` for a week, recorded among the conversation's artifacts
  (PROTOCOL.md:6573). The bar offers **Save to Downloads** (question 5):
  - on this Mac, the app copies the file (it has Downloads access);
  - for another box, the file route `MachineBrowser.saveToMac` already uses.

### 4.5 Which sites it's signed in to, on every box

- `siteSignedIn` comes from the box's own cookies: `Storage.getCookies` while Chrome runs, else the
  profile's `Cookies` database (names, hosts and expiry are plain text). Piece 0 checks it can be
  read while Chrome holds it.
- The cookie names per site move from `Integrations.swift:261-265` into the integrations' catalog.
- This ends "a machine's box can't tell yet" (PROTOCOL.md:3106). `sites/signed-in` on the host and
  `SiteSignIns`' WebKit watch go.

## 5. What moves out of the Swift app, and what GPUI needs

### 5.1 To the box (it's logic)

- **`kuvo-browser.js`, built from the box:**
  - `BrowserAgent`'s scripts, `buildDomTree.js`, `BrowserTools`' definitions and instructions, and
    `Passkeys`' script move into `Packages/Box/src/browser/`;
  - `scripts/build-box.sh` builds it, and `pack-box.sh` takes it from there;
  - `KEEPER` becomes a hash the build writes, so parallel keeper changes merge cleanly.
- **The view logic `MachineBrowser` holds** (§3.1).
- **Browser settings** (`kuvo/browser/settings`):
  - the search engine;
  - closing agents' idle tabs (the keeper's `TAB_IDLE`, `:59`);
  - Offer to save, and the Never sites.

  "Start each panel with" and "Show the panel when the agent browses" stay the clients'.
- **Website Data:** `GET kuvo/browser/sites`, and `DELETE` for hosts or all.
- **The cookie table**, into the catalog (§4.5).
- **Bots' words:** `bot-words.json:170` ("tabs of your own in the user's browser on this Mac, signed
  in where they are") becomes the machine wording.

### 5.2 What the Swift app stops doing

- **This Mac's panel draws the box's browser** through `MachineBrowser`/`MachineBrowserPane` on a
  local connection, when the box says `own`.
  - Today it reaches only `SSHConnection`s, and `ab73823a6`'s local path is for `~/.kuvo-code`.
    After #333's move that's where this Mac's box is, so that path fits.
- **What `MachineBrowserPane` lacks**, compared with the WebKit pane: the password key, the save
  offer and the new tab page's suggestions (`BrowserSession.swift:291-314`, `NewTabPage.swift`).
  Either they're added there, using the WebKit pane's views as they are, or they're missing until
  GPUI (question 3).
- **Goes:**
  - `BrowserSession.swift`, the WebKit part of `BrowserPane`;
  - `BrowserAgent.swift` (once its scripts have moved), `BrowserToolServer.swift`,
    `PagePrinter.swift`;
  - WebKit's half of `Passkeys.swift`;
  - `SiteSignIns`' cookie watch;
  - `BrowserHistory`'s store;
  - `Passwords`' WebKit fill and save;
  - this Mac's half of `BrowserAsks`;
  - `--in-background` (`InBackground`'s menu-bar mode stays);
  - `tools` and `sites/signed-in` in `kuvo/box/app`, and `app/open` on the host.

  About 4,000 lines.
- **Goes with #333:** `KeeperTools`, `KeeperBoxTools` and `AppOpener`, when #333's piece 5 retires
  the app's keeper.
- **Goes from the box:**
  - `appBrowser`, `appCall`, `MAC_BOX` (`kuvo-browser.js:2233-2321`);
  - `openApp` and `kuvo/box/app/open` (`link/mac/app.ts`);
  - `run/app-opening.json`.
- **Settings › Browser** reads the box's routes.
- **No tab handover:** WebKit tabs aren't kept across launches (`Utilities.restoreOpen` keeps only
  which panels were open), and the switch comes with an app update, which relaunches the app.
- **One-time note** (question 4): the sites the old panel was signed in to, cookie domains only,
  read by the last app with WebKit.
- **Test classes that depend on the WebKit stack, `BrowserToolServer` or the keeper's tools**, and
  what each becomes:

| Class | Becomes |
| --- | --- |
| `BrowserPagesTests`, `BrowserFormTests`, `BrowserSignInTests`, `BrowserUploadTests`, `BrowserDownloadsTests`, `PagePDFTests`, `PageDialogsTests`, `PasskeysTests` | box tests against a real Chrome for Testing (piece 7) |
| `BrowserToolServerTests`, `KeeperOpensAppTests`, `HostOpensAppTests` | go |
| `BrowserHistoryTests` | box history tests, plus the new tab page drawing the box's list |
| `BrowserAsksTests` | this Mac's asks from the box, as for machines |
| `IntegrationsOnBoxTests` | `siteSignedIn` from the box |
| `VaultOnBoxTests`, `OwnBoxKeysTests` | the fill through the box's browser |
| `PanelOpenTests`, `AutopilotTests`, `GoalOpenTests`, `StoredFilesTests` | their browser steps against a stand-in box browser |
| `KeeperToolsTests` | its browser cases go (the rest go with #333 piece 5) |

### 5.3 What GPUI needs

- **`kuvo_box`, a `browser` module:**
  - the view stream over the three transports, with typed `Kuvo.*` messages;
  - `kuvo/browser` (status, Try Again);
  - `kuvo/browser/history`, `…/sites`, `…/settings`, `…/fill`;
  - `kuvo/asks` and its events and answers.

  Tested against the stand-in box (`gpui/README.md:63`).
- **`kuvo_ui`** (drafts first, light and dark):
  - the live view: JPEG to texture, letterbox, cursor;
  - input: mouse, wheel, keys, IME;
  - the toolbar: address, back, forward, reload or stop, tabs;
  - setup progress, ask cards, dialogs, a downloads bar, Take Over, the passkey note;
  - the password key and save offer.

## 6. Privacy, and what someone on 0.5–0.7 sees

### 6.1 Privacy page, footprint, docs

- **`kuvo-web` `code/privacy.md`:**
  - **line 25:** this Mac downloads Chrome for Testing from Google too ("never your Mac" goes);
  - **line 11:** this Mac's browser keeps cookies, sign-ins, open pages, history and site icons in
    `~/.kuvo-code/browser`, and downloads there for a week;
    - the folder is one only you can open, which the sandbox keeps from agents' commands;
    - cookies are effectively plain text there, as on machines;
  - every box keeps its own browser's history and site icons (`browser/history.json`, `icons/`) and
    settings, machines' too since piece 2: they stay on that box, and leave it only in its
    `kuvo/browser/…` answers to your own clients;
  - pictures of pages on the phone cross the relay end to end encrypted;
  - the Preferences key, if question 7 allows it.
- **`docs/footprint.md` and CLAUDE.md's "On the Mac":** the Preferences key. Once question 9's time
  has passed, WebKit's and HTTPStorages' folders are no longer written.
- **Pages to update:** `browsing.md`, `panel.md`, `privacy.md`, `uninstall.md`, `settings.md`,
  `vault.md`, `sessions.md` (ask cards), `shortcuts.md`, `troubleshooting.md`, `machines.md` and
  `architecture.md`; `CONTRIBUTING.md`'s browser section. Panel screenshots are recaptured.

### 6.2 After updating from 0.5–0.7 (or a beta)

The box updates first. #333's move happens, and then the switch (`browser.own`). There's no WebKit
fallback after it.

- **Once:**
  - the box sets up its browser (about 200 MB, "Setting up this Mac's browser… 40%" if you open the
    panel first);
  - it moves the old history and icons in;
  - settings move to the box.
- **Signed out of the panel's sites:** one new sign-in each (accepted). X, LinkedIn and Reddit
  integrations show **Sign In** again, and bots using them wait for it.
- **Kept:**
  - the vault and saved passwords, which fill as before on this Mac;
  - history, conversations and downloads.

  Open WebKit tabs aren't kept (they aren't today either).
- **0.7's internet passwords from before the vault:** `Passwords.swift:252` moves them inside the
  Swift app, the only program their Keychain lists trust.
  - The last Swift release runs it.
  - Going from 0.7 straight to the GPUI 1.0 asks once per item, and the 1.0 notes must say so.
- **Asked:** Local Network for Kuvo Code Box, the first time an agent opens an address on your
  network (after #333 that's asked for the helper anyway).
- **Different** (question 10):
  - no sound;
  - video at a few frames a second;
  - typing slightly slower;
  - VoiceOver can't read inside pages;
  - the panel's Chrome runs, and costs battery, while you watch it.
- **Possibly:** a site that refuses Chrome for Testing's sign-in (Google, for one). Piece 0 checks
  before the user is asked to accept this.
- **Untouched:** WebKit's old data until question 9's time, and the user's other browsers.

## 7. Pieces

How these are sized and run:
- Hours are wall-clock from start to merge-ready, review included, sequential.
- **Anchors** (`recount-341-333-2026-11-12.md`):
  - A1, about 2 h: box routes, both apps, a setting;
  - A3, 1 h: nine tools, three copies removed;
  - A6, 5 h, 3 rounds: security;
  - #333's "each box installs its own browser" (`32a80a8c2`): 2,190 lines, about 20 h from first
    commit to merge, two reviews;
  - #211 (`a7ff41685`), 612 lines; #333 piece 3 (`64aca428f`), 1,226 lines.
- **Tests never touch real data:** `KUVO_*` unset, a `HOME` and demo root of their own, Chrome from a
  test source or stood in, and no real box, relay or profile.
- **Each box piece runs on Linux** too (devbox test folder).
- Nothing changes for users until `browser.own` is on (piece 8).

| # | Piece | Where | Tests | Risk | h |
| --- | --- | --- | --- | --- | --- |
| 0 | **Spikes** (throwaway, test bundle ID). Each gets a written result:<br>- Chrome for Testing under a helper stand-in: prompts' names, no Keychain prompt, whether pages can raise camera prompts, Gatekeeper, the Preferences key;<br>- a Local Network grant given while the tree runs, then Chrome from an old `mcp`, then the tree restarted;<br>- signing in at Google, Microsoft and Apple ID;<br>- `serve` WebSocket under Bun;<br>- frame bytes at phone settings through the real relay, against its 4003 threshold;<br>- the `Cookies` database read while Chrome runs;<br>- memory of one `mcp` per agent (`agents/kuvotools.ts:56-60`). | box, Mac | a written result each | low | 4–6 |
| 1 | **`kuvo-browser.js` built from the box** (§5.1), with `KEEPER` hashed. Tools and instructions byte-for-byte as before. | box, build | the bridge's browser tests unchanged; the tool list compared with the old one | medium | 5–8 |
| 2 | **Browser data on every box:**<br>- history and icons;<br>- `…/sites`;<br>- `…/settings` (search, tidy, Offer to save, Never);<br>- `siteSignedIn` from cookies with the catalog's table;<br>- the one-time reads of the app's history and settings. | box | history kept, cleared, moved in once; a site's data removed signs it out; `siteSignedIn` from a cookie file with Chrome stood in | medium | 6–10 |
| 3 | **The view vocabulary and #59:**<br>- `Kuvo.pages`, `frame`, `viewport`, `view`, `input`, `go`, `upload`, `external`;<br>- the size rule, and the keeper taking over raw clients' `Emulation`/screencast calls;<br>- frames per size class;<br>- the relay socket with its byte budget, and `serve`'s;<br>- PROTOCOL.md "The browser's live view";<br>- `MachineBrowser` takes the address from `Kuvo.pages` (#59's smallest client fix). | box | Chrome stood in at the CDP pipe: an agent's navigation reaches every viewer; a phone-sized viewer doesn't resize an agent's page; frames dropped over budget; the socket opens only to a paired phone | medium | 10–16 |
| 4 | **The vault on the box's browser:**<br>- `kuvo/vault/fill` for it;<br>- `kuvo/browser/fill` with the frame's origin checked;<br>- the isolated world and binding;<br>- `data-kuvo-secret` on every fill;<br>- offer to save;<br>- `saved`/`offersToSave` from each box's vault;<br>- `kuvo/asks` per box, off `MAC_APP_ROUTES`;<br>- ask notices. | box | a fill only on the item's site and frame; a page can't fake `offerSave`; a filled field masked in a snapshot; a fill refused without the password; a phone sees this Mac's asks with the app closed | **high** (security): separate review | 8–12 |
| 5 | **A Mac-kind box runs its browser, behind `browser.own`** (needs #333's move):<br>- gates in `install.ts` and `router.ts`;<br>- `POST kuvo/browser {start}`, and `connect` asking for it;<br>- the `MAC_BOX` diversion skipped while it's on;<br>- the Local Network restart and words;<br>- permissions (question 8);<br>- the Preferences key in `uninstall`;<br>- demo copies download nothing;<br>- the Time Machine exclusion. | box | a Mac-kind demo root with a test source: with it on, it installs, `browser_navigate` runs in its own browser and never asks for the app; with it off, as today; `connect` doesn't start the keeper | medium | 6–10 |
| 6 | **The Swift app draws this Mac's box's browser** when the box says `own`, through `MachineBrowser` on the local path; plus question 3's pane additions if chosen (+3–5). | Mac | `ONLY=…` from the batch: the panel shows this Mac's box's browser in a demo root with a stand-in keeper; no WKWebView made | medium | 6–10 |
| 7 | **The WebKit tests' scenarios on the box** (SCENARIOS.md:83-88; the first row of §5.2's table), against a real Chrome for Testing kept in the test lane's own cache, on local pages. | box, scripts | the ported scenarios | medium (a new test dependency) | 10–15 |
| 8 | **Rehearsals and docs:**<br>- from 0.7.2 and beta.1 in the rehearsal account (#333 Q5);<br>- §6.1's pages, `footprint.md` and the changelog;<br>- then `browser.own` on by default. | all | the checklist | medium | 4–6 |
| 9 | **The old path goes** (§5.2: about 4,000 lines of Swift, the box's app hand-off, the tests in §5.2's table). | Mac, box | the classes rewritten or removed; the area's tests green | medium | 10–16 |
| 10 | **Phone live view** (phone session; drafts first). | phone | the phone's tests against a stand-in box | medium | 8–12 |
| 11 | **GPUI live view** (§5.3; drafts first). | gpui | `kuvo_box` against the stand-in box | medium | 10–16 |

- **Order:**
  - 0 → 1 → 2, 3, 4 (any order, every box, before #333's move);
  - then 5 → 6 → 7 → 8 → 9 once #333 has moved this Mac's box;
  - 10 and 11 after 3, alongside the rest.
- **Total:** about 90–140 h.

**Risks:**
- Your own browsing in the panel gets a machine's feel (§6.2, question 10).
- A site refusing the new browser's sign-in, which piece 0 checks.
- Relay bandwidth: the budget, measured in piece 0.
- Piece 4's trust change.
- The WebKit tests' coverage, until piece 7.
- Chrome's memory and battery on a laptop: it runs while an agent browses or a client watches, and
  stops after 10 minutes with neither (`:54`).
- `pages.json` reopens 8 pages by address only (`:658`), so which conversation each was for is lost
  across an idle stop; piece 2 adds `session`.
- One `mcp` process per agent.
- #333's move slipping holds pieces 5–9.

## 8. Questions for the user

1. **Should this Mac's switch wait for #333's move to `~/.kuvo-code`?**
   - *Recommend: yes; the pieces that help every box land before it.*
   - The box in the app's folder has no `kuvo-link.js` of its own for the browser's tool server to
     reach.
   - Not waiting means one more piece (about 3–5 h) to give it one, plus keeper changes that the
     move then throws away.
2. **Should a password saved on this Mac still be offered when an agent on one of your machines
   asks you to sign in?**
   - *Recommend: yes, filled by this Mac's box over your computers' encrypted link, as a later
     piece (about 8–12 h, high risk).*
   - Today the Mac app does it itself, which phones and GPUI can't.
   - The other way is that each computer offers only its own passwords: a sign-in saved from a
     machine's ask would then stay in this Mac's vault, out of that machine's reach.
   - Until you answer, nothing changes.
3. **This Mac's panel switches to the view machines use, which has no password key, no "save this
   password?" and no suggested sites. Add those three to it now, or go without them on the Mac
   until the new desktop app?**
   - *Recommend: add them (about 3–5 h).*
   - They reuse today's look as it is, and they'd work for machines' browsers too.
4. **After the switch, should Kuvo Code list once the sites you'll need to sign in to again?**
   - *Recommend: yes, a note on the panel's new tab page that you can dismiss, names only.*
5. **Where do files you download in the panel go?**
   - *Recommend: the browser's own folder, with Save to Downloads one click away, as for machines.*
     It works the same on every computer and the phone.
   - Today this Mac's panel saves straight to `~/Downloads`.
6. **When should a Mac download its browser (about 200 MB, 600 MB on disk)?**
   - *Recommend: the first time an agent or you open the panel's browser.* Someone who never
     browses never pays for it; the first use waits a minute or two.
   - Machines set theirs up when their box starts.
7. **May Kuvo Code leave one key in `~/Library/Preferences` (Chrome's last run, which macOS writes
   and we can't stop), removed when you uninstall?**
   - *Recommend: yes.* Mac machines have the same exception.
8. **Should pages in the agents' browser be refused the camera, microphone, location and
   notifications on every computer?**
   - *Recommend: yes.* Nothing uses them, and macOS would otherwise ask about them in Kuvo Code
     Box's name.
9. **When should the old panel's sign-ins and website data be deleted?**
   - *Recommend: 30 days after the switch, with Settings › Browser saying when.*
   - Deleting them at once is tidier but leaves nothing to look back at.
10. **The panel's browser loses sound, smooth video, VoiceOver inside pages, and a little typing
    speed (as with your machines' browsers today). Fine for now?**
    - *Recommend: yes.* Sound and a readable page for VoiceOver (from Chrome's accessibility tree)
      would be later pieces.

## 9. Review

One `reviewer` pass on the first version. It found these, and the note now handles each:

- **Blockers:**
  - *The box in the app's folder can't run the browser's tool server* (`kuvo-browser.js:217`,
    `:2201`, `:2329` need `K/bin/kuvo-link.js`). The Mac's part now follows #333's move (question
    1).
  - *This Mac's passwords do sign in on machines today.* §1 now says so, and question 2 asks;
    nothing is built either way.
  - *Removals before the Mac could show the box's browser.* There's now one box-owned switch, and
    removals are the last box piece (9).
- **Should fix:**
  - the Local Network grant needs a tree restart, and the denied state needs words;
  - the Swift pane's missing key, save offer and suggestions (question 3);
  - the size rule couldn't hold against raw-CDP clients, so the keeper now takes their calls over;
    frames per size class;
  - the relay budget, and frames over 65 KB;
  - the tab handover dropped;
  - the Never sites, the cookie table, the isolated world, masking filled fields, and the frame's
    origin;
  - VoiceOver;
  - sites refusing sign-in;
  - three decisions turned into questions (6–8);
  - each box lists only its own asks;
  - the full test-class list, and pieces 7 and 9 sized from it.
- **Minor:**
  - the uninstall key moves into the box;
  - `router.ts:103`, and `start` on `kuvo/browser`;
  - demo copies;
  - `KEEPER` hashed;
  - privacy wording;
  - the docs list and bots' words;
  - who copies to Downloads;
  - `mcp` per agent;
  - Time Machine, modifiers, `mailto:`, file drops, history icons.
- **Not checked by anyone:** the macOS behaviours left to piece 0, the relay's real threshold, and
  whether `kuvo-browser.js mcp`'s tools match `BrowserToolServer`'s one for one.
