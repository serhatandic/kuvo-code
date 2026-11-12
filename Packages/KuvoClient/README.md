# KuvoClient

What Kuvo Code's two clients share: the Mac app (this repository) and Kuvo Code for iPhone, which
builds against this checkout as a local package, as it does OpenCodeKit, KuvoLink and Textual.
Written once, tested once, so the two can't drift.

## ClientText

The rules for what a message says, the same in both apps. Foundation only: no views, no app state.

- `ImageReferences`: a picture's name in a message ("[Image 1]"), finding them, taking one out.
- `WebLinks`: the web addresses written in a message.
- `SiteAddresses`: the site a web link is on (its main domain), whether an address is a public
  one, and the icons a page declares.
- `TypedEchoes`: a message field's own typing handed back to it late by a busy app, told apart from
  a change by the app, so no key is lost.
- `OutsideFolders`: a folder or file an agent asks to work in outside its project, as people know
  it ("~/notes", not the engine's "/Users/me/notes/*"), and as VoiceOver reads it ("Home, notes").
- `WorkItemRefs`: `#243` in a message naming a Work Queue item (not in code, a link or a web
  address, nor another's number like "PR #12"), and the `kuvo-item://243` link its chip carries.
- `SearchMatches`: where a search's words are in the snippet a result shows, as the box matched
  them, and the snippet with them in bold.
- `PermissionAnswer`: a permission's answers, numbered as both apps list them (1 Allow Once,
  2 Always Allow…, 3 Don't Allow, 4 Tell It What to Do Instead…), with `AlwaysWords` for 2.
- `Quote` and `Quoting`: replying to parts of a message, each `Quote` with your answer under it,
  written into the message as Markdown and read back (an undo, a send that didn't go) as the same
  quotes and answers, so a reply written on one app shows its quotes on the other. A box reads them
  the same way (`box-vectors.json`, ClientSessionsTests' BoxVectorsTests).

## ClientAccounts

"Bring your subscriptions": what a computer has that Kuvo Code can use, as its box answers
`kuvo/accounts/found` (`Found`), and the rows offered from it, each with the one thing it needs
(`Offers`). Only the Mac's first launch offers them now: a computer is set up on the Mac before a
phone pairs with it, so the phone, which had a sheet of its own for this, doesn't use them.
`AccountNames` is what both apps call each provider's accounts in a word ("Claude", "Copilot"),
the same in the usage panel and the work bar. `EngineProviders` is which of the engine's
integrations Accounts lists as providers: no web search services, and not the engine's own
"Claude Agent" (Claude comes through Claude Code, with the coding agents) unless it was added.
`PlanSignIns` is what a conversation on the engine's own OpenAI or xAI model says when the engine
can't run it: a ChatGPT or SuperGrok plan signs in through Codex or Grok, so it needs a key, or a
model under that agent. Only for a box without `sessions.models` (the old-box path): a box that has
it says so itself (`SessionModelState`).

## ClientSessions

What a client shows of a computer's sessions, the same in both apps. Rules only, on OpenCodeKit's
`Session`: no views, no app state.

- `HiddenSessions`: what's kept out of sight (a group chat's seat, the engine's run for a coding
  agents' session).
- `SessionChat`: whether a session is a chat, as its box marks it (`kuvo.chat`, naming the chats
  folder it's in; PROTOCOL.md, "Chats"); one without the mark by its folder, the old-box path.
- `ReadState`: which sub-sessions are new (finished since you were last in them, or in the session
  at the top of their chain), what reading a session reads with it (its finished sub-sessions, all
  the way down), and a read elsewhere taken when it's later.
- `UnsearchedReason`: why a computer's conversations weren't searched, in the words both apps show.
- `WorkQueue` and its types (`WorkQueueView`, `WorkItem`, `WorkItemDetail`, `WorkRef`…): the Work
  Queue as the box states it, and what the panel shows of it: In progress first, then each
  category; the open count ("24 items"), "Updated 8m ago", whose an item is, what's being done.
- `ReviewList`: "/review"'s lists over the message field (What to review, a commit or a folder for
  it, Look for), their rows and sizes from what the box measured, and loading those.
- `BoxNote` and `ReplyChanges`: what the box and the engine write to an agent in its conversation,
  as both apps show it, with no pills. A lead's sessions' news is a message from each session
  (`BoxNote.shown`, `SessionNews`: finished, failed, asks or stopped by you; one still working shows nothing).
  What changed since the reply before (the model or its effort, the mode, a summary, the project's
  folders, a goal started) is a word in the next reply's footer (`ReplyChanges`). Notes written for
  the model show nothing.
- `ShellRead`: the end of what a background command printed, as Output shows it, and whether it
  has ended (its engine let go of it) or just can't be read now.
- `AskPlace`: which of the asks waiting takes the composer's place, and "2 of 3" over it: the one
  in view stays while others come, and once it's answered the next after it shows.
- `SlashCommands`: "/" starting a message: the command name being typed, the commands it matches
  (names starting with it first), and a message that runs one ("/review main"), else as written.
- `CommandMessages`: which messages a command made, with the command as you wrote it, shown in
  place of the long prompt it sent; the latest 500, kept where each app says (its settings).
- `GoalChart.labeledDays`, `.labeledHours`: which days and hours along a goal's timeline get a
  label, clear of each other, counted from Today; each app gives the room its own labels take.
- `MachinePieces`: which version a machine's link, coding agents and engine each run, as its box
  says (`kuvo/info`'s `pieces`), and the line under the machine while one runs an older version
  than its files (a new bridge waits for a quiet moment, or holds new messages for the turns under
  way).
- `ConversationPictures`: every picture of a conversation, in order, across its messages (yours,
  and those an agent made, showed or took of a page to show you), each by an id that stays: what a
  picture opens among, to go to the one before or after it, in both apps' viewers.
- `Reach`: when a computer counts as not connected (#443): never for a link that's only slow or
  down for a moment; only once it's been down through the grace and a check since got no answer.
  And which failures are only the link's (`isTransient`), read again rather than said.
- `WorkWords`: what a bot's work says, as its box tells it (`kuvo/work`): the bar's line, and each
  session's row (`about`: its model, the account it runs on and its project, then shorter for a
  narrow row, the account going first).
- `ComposerSend`: what a composer's Send and Return do with what's written: it goes; or, with no
  model chosen (the chip says "Choose a Model"), Send is off and Return opens the model picker,
  the message kept; a "!" command, and showing, pausing or taking away a goal, go without one.
- `SessionModelState`: what a session's box says of its model (`kuvo/sessions/models`): the model
  it runs on, whether it can, and what's missing (a model, a sign-in, a key, its agent installed,
  or the model gone). What the model button names (`namesModel`, else "Choose a Model"), what a
  message refused on it says (`refusal`), and what a sign-in card's Sign In does (`signInHelp`).

## ClientVault

A computer's vault as its box answers `kuvo/vault` (KuvoLink's PROTOCOL.md, "Vault"): its items
without their values, who may use which (`Vault.how`, a bot's own `items(of:)`), the sign-ins for a
page's site, what agents ask for (`VaultAsk`, a card's title), the activity as one sentence each
(`VaultActivity.sentence`), and the routes' paths. Rules and shapes only: no views, no app state.

## ClientSandbox

The sandbox a computer's agents' commands run in, as its box answers `kuvo/sandbox` (KuvoLink's
PROTOCOL.md, "Sandbox"): whether it's on and why not (a word a newer box adds reads as none), what
agents ask to run outside it (`SandboxAsk`, and what Always would keep), a project's Also
Allowed (`SandboxRule`), and the routes' paths. Shapes only: no views, no app state.

## ClientChanges

A project's changes as both apps' Changes show them, from git's diff (a box's `kuvo/git/changes`,
the Mac's own git). Foundation only.

- `DiffParser`: git's diff read into files (`PatchFile`) and their lines (`DiffLine`), with each
  line's numbers, renames, names git quotes, a file that changed kind as one, and the new files git
  doesn't know listed to be read.
- `DiffFolding`: the long unchanged stretches folded around each change, opened one at a time.

## ClientDesign

The look both apps draw with, the same on each: SwiftUI, no app state (except the site-icon cache,
`SiteIcons`, in a folder each app hands it). It's taking the place of the phone's copies of the
Mac's design files, a piece at a time.

- `MachineWords`: a machine's words in both apps: the step its first connection is on ("Copying
  the engine"), and what Remove's dialog says Uninstall would stop it for (your other Macs, your
  phones), or that only the Mac that runs it can uninstall it.
- `ProgressRing`: how far a wait has come where there's room only for a mark (a machine's engine
  being copied there), the working ring's size.
- `MoveWords`: Move to Computer's words in both apps: what a moving row says ("Moving to lab…
  12 of 30 MB", sizes as `ProgressLine` says them) and the question asked before a move.
- `Surface`: the window's materials (canvas, card fills, lit rims, accent glass, recessed wells),
  and the `accent` and `cardIsFocused` they read.
- `Metrics`, `Animation.ui`, `.fold`, `readableColumn()`: the shared sizes, the app's spring, how
  folds open and close, and the readable column; `formattedCost` and `compactTokens` for a run's
  cost and tokens.
- `WorkItemChip`, `WorkItemDot`, `WorkItemMark`: a Work Queue item's chip in a message (its mark,
  `#243` and its title) and its mark in a category's color, a ring in progress, a check when done.
- `Spinner`: the app's loader, played by Core Animation on each platform's own view.
- `ChoiceRowLabel`: a numbered choice (a question's, a permission's answer): its number in a small
  square, its words and what it means; each app puts it in its own button.
- `ComposerRow`: the row under a composer's field, its words' font and its icons' (the paperclip,
  the mode's, the chips' chevrons and ✕, the mic, Send and Stop): one size and weight, the words',
  on their baseline.
- `ComposerListRoom`: how tall a list over a composer's field ("/", "@", "&") can be before it
  scrolls inside: the card's room less the field and its chips and what the bars keep at least.
- `FirstLineListItemStyle` (`.firstLine`): a list item's marker on its first line's middle.
- `ShimmerText`: words that shimmer while something's under way, played by Core Animation.
- `BotAvatar`, `BotLook`, `BotMood`, `GroupAvatar`, `MachineBadge`: the bots' looks, still and
  moving (`BotMotion`, played by Core Animation on each platform's own view).
- `DiffStat` and `Color.additions`/`deletions`: "+12 −3" in the system's green and red.
- `MathText`, `MathBlockView`, `InlineMath`, `MathMarkdownParser`: formulas in replies and files,
  at the size of the text they're in (handed in, as each app sets its own).
- `CodeLanguage` and `CodeLine`: a code block's language name, and how wide a line of it is set.
- `FolderIcon`: a project's folder, open or closed.
- `SiteIcons`: the icons of the sites replies link to, from the sites themselves (their declared
  icon, else /favicon.ico; no cookies, public addresses only), kept in the folder the app hands it
  within a cap, with the globe for a site with none worth showing. Each app reads the pictures
  itself (`usable`, `picture`: the Mac draws SVG and keeps them at twice their size, the phone at
  three times), as `PlatformImage` (NSImage or UIImage); `isColorlessGlyph` is the shared rule for
  an icon that would vanish on a dark or a light card.
- `Flow`: views in rows that wrap when the room runs out, against the leading or trailing edge
  (a sent message's pictures, chips in a row).
- `TitleWithTail`: a row's title with a short note at its end ("from Mini"); the title always
  wins, and the note goes where the row can't hold it and about twelve characters of the title.
- `FileKind`: what kind a file is by its name (code, text, data, a picture…) and its symbol, where an
  app shows a file without its own icon.
- `BrandMark`, `BrandMarkView`: the marks of providers, coding agents, integrations and MCP servers,
  bundled (no network), monochrome templates in the ink around them; a service with no mark gets a
  plain symbol of what it is, and anything unknown a server, never a letter.
- `Color(hex:)`: a color written as 0xRRGGBB, and `PlatformColor` (NSColor or UIColor).
- `CodeColors`: the colors of code everywhere (diffs, files, replies), and Textual's theme of them.
- `TerminalColors`: a command's output colored as a terminal shows it.
- `BarFolds`: which bar in the card over a conversation's composer is open once the card is full
  (three bars or more): the newest change, none while a card asks, one at a time.
- `FollowsEnd`: a list that follows its newest as it comes (a side thread's answers), until you
  scroll up away from the end.
- `PutAways`: what a bar's ✕ put away, with Undo in its place for a few seconds: what goes only
  once the moment passes (a goal, a wake-up), and what goes at once and comes back with Undo.
- `SessionGlance`, `SessionGlanceCard`, `PullMark`, `ChecksMark`: a session's row and card at a
  glance, as its box says (`kuvo/sessions/glance`): the one mark a row gains (its pull request's,
  red all over while a check fails, else its branch's), and the card its row opens (hover on the
  Mac, a long press on the phone) with its state and age, branch, model and pull request.

## What belongs here

Only what both apps call, with a small public surface: rules and formatting both clients follow,
tested here. Not:

- text views (each app's composer field, reply renderers), where AppKit and UIKit differ;
- anything bound to an app's state, stores or settings (drafts), unless each app hands it in:
  where it keeps what it keeps (`CommandMessages`' settings, `SiteIcons`' folder, each app's own
  `shared`), so a package run never reaches an app's real data;
- what only one app uses.

A change here is a change to both apps: run this package's tests (`swift test`), the Mac app's
(`scripts/test-app.sh`) and the phone's.
