# Scenarios the app tests guard

The app tests follow the scenarios in `Tests/E2E/SCENARIOS.md` (what people do with Kuvo Code),
by the same IDs. The end-to-end runs try each one for real, with a model; the app tests keep each
one working on every change, on CI, without a model or the network: the app's real stores, real
git and real files, with the engine stubbed at its HTTP API. A bug an end-to-end run found and
fixed (❌→✅ there) gets a test here when it can be tried this way.

Each suite's comment says what it tries; this is where each scenario stands. Scenarios that are
about what a model answers or does (B1–B4, D1, D2, E1–E3, E5, E7, most of L1–L49) are the
end-to-end runs' alone, as are those that need a real machine over SSH (L47; F9 and L46 in part,
below: what runs on the machine is tried here with its scripts, a stand-in engine and stand-ins
for Linux's tools).

| Scenario | Suites | Not guarded yet |
| --- | --- | --- |
| A1, J2 A model ready, or the one you picked when it can't run | StartingModelTests, ProviderCompatibilityTests | |
| A2, A3 First launch with no account, then connecting one | StartingModelTests (the model a session starts on, free ones without an account) | the welcome card and the Accounts sheet (UI; tests that drive the window would take over your keyboard and mouse, so the end-to-end runs try them) |
| A5 Theme, accent and text size everywhere | | all on screen (UI; the end-to-end runs) |
| A4 Bring over an opencode setup, or Claude Code's agents and commands | OpencodeImportTests, ClaudeCodeImportTests | |
| A6 Quit with work running, open again | DraftsTests, StoredFilesTests, QueueTests, LastSeenTests | |
| B5 Review the changes, comment on a line, send the comments | SessionEditsTests, SentMessageTests, DraftsTests | |
| B6 Undo a turn, then change your mind | ComposerReturnsTests, AttachmentsTests, UndoRedoTests | |
| B7 Commit with a message, push, make a branch | ChangesCommitTests, ChangesDiscardTests, ChangesStagingTests, ChangesFileNamesTests | |
| B8 A session in a worktree, merged back; a machine's worktrees kept by the machine | WorktreeSessionTests, GitBranchesTests, the bridge's worktrees.test.js | making one on a machine from the Mac (by hand, on a test machine) |
| B9 Plan first, then Build It | AgentAsksTests | |
| B10 Ask First: allow once, always, deny | ComposerReturnsTests, ProjectFoldersTests, PermissionCardsTests, AlwaysAllowedTests | |
| B11, L38 The agent asks questions, answered in the card or skipped | AgentAsksTests | |
| B12 Queue while it works, Stop, Resume | ComposerReturnsTests, QueueTests | |
| B13 Two sessions at once, each with its own asks | AgentAsksTests | |
| B14 Switch model mid-conversation, or elsewhere, to a coding agent too | SessionsTests, MoveToAgentsTests | |
| The coding agents (Claude Code, Codex, Cursor, Grok, Antigravity): a turn's replies and steps, Stop, permissions in each mode (Ask First, Approve All, Plan, your Blocks), its usage and how full its context is | Agents/test: claude, codex, cursor and acp tests, each with a stand-in for the agent's program | the agents' own programs and accounts (the end-to-end runs) |
| B16 Find in a long conversation | ConversationFindTests | |
| B19 A subagent at work, in the background too | SubagentsAtWorkTests | |
| B17 A folder that isn't a git repository | SessionEditsTests | |
| B18 Rename, archive, restore, delete, search | SidebarListsTests, SessionsTests, SessionTitlesTests, SessionSearchTests, SessionLifecycleTests | |
| B20 Commands, skills, and ! commands | SlashCommandsTests, SkillLibraryTests, ShellCommandsTests | |
| C1–C3 Attach pictures, PDFs, files | AttachmentRoutesTests, AttachmentsTests, SentFilesTests | |
| C4 Quote part of a reply and answer it | QuotingTests | |
| C5, C6 Files in the panel; the agent shows one; agents' tabs tidied | FileLinksTests, PanelTabsTests, ProjectFilesTests, BrowserHistoryTests, AgentTabsTests | |
| D3 A reply with a widget shows as one | | how a reply's steps become rows is the transcript view's own (no seam outside it); the bridge naming coding agents' show_widget is in Agents/test |
| D4 A chat moved into a project | SessionLifecycleTests | |
| E, B15, L36 The agent's browser; a screenshot you ask to see, in the conversation | BrowserToolServerTests | |
| E2, L31 It fills in a form | BrowserFormTests | |
| E3, E7, L22 It uploads a file to a site | BrowserUploadTests | a machine's browser's upload (its Chrome, on the machine) |
| L25 The page saved as a PDF to share | PagePDFTests | |
| E4, L21 A file downloaded in the browser, to work with | BrowserDownloadsTests | a machine's browser's downloads (its keeper, on the machine) |
| L32, L35, L48 Pages that don't sit still: a new window or a sign-in popup, a long table or one that loads as you scroll, a site that's down | BrowserPagesTests | a cookie banner (what a model makes of it) |
| E6, L37 Browse yourself in the panel: the address field, a page's dialogs | PageDialogsTests, BrowserHistoryTests, AgentTabsTests | tabs, Back and the new tab page (UI) |
| E5, L33, L34, K6 Sign-ins, codes, passwords | BrowserAsksTests, MachineSignOutTests, PasskeysTests | a machine's Chrome refusing passkeys (checked by hand in Chromium; no Chrome in the tests) |
| F1, L44 Make a bot from scratch or a template; its job, as it grows, under its name | BotCreationTests, BotTemplatesTests | the template's tiles in New Bot (UI) |
| F2, F6 A bot's job, told or edited | BotsTests | |
| F3–F5, L15–L19, L26, L43 Wake-ups and watches | WakeUpsTests, StepSummariesTests; OpenCodeKit's WakesTests (a watch wakes only on a change, keeping its last value) | |
| F7 Export and import a bot | AgentMessagesTests | |
| F8 Delete a bot | BotDeletionTests, GroupChatTests | |
| A bot's own keys for integrations stay its own, where it lives | BotKeysTests (and keys this Mac kept for a machine's bot going to it), PhoneBotsTests; the bridge's bot-keys tests (a machine's bots', with the Mac closed or through `box route`); OpenCodeKit's RemoteEngineTests (a start from the Mac leaves them) | the hand-over over real SSH (by hand, with the demo copy) |
| F10, L39, L40 Agents writing to each other | AgentMessagesTests, AgentReferencesTests | |
| G1–G4 Group chats, meetings on a schedule | BotsTests, AgentMessagesTests, GroupChatTests | |
| H1, H2, H5 MCP servers and integrations, before and after their keys | MCPCommandTests, ChromeDevToolsUpgradeTests, IntegrationsTests | an integration's card in Settings (UI) |
| H3 An MCP server asks mid-task | AgentAsksTests | |
| H4 A skill from GitHub | SkillLibraryTests | |
| I1 Add a machine, at one or more addresses | AddMachineTests, MachineAddressesTests | choosing the address that answers (needs SSH) |
| I2 A project on a machine | MachineFoldersTests, AttachmentRoutesTests, SignInSyncTests, MachineSignOutTests | |
| I3 A machine that's away | MachineAwayTests | |
| I4 What machines share with this Mac, and what's their own; Also Apply to… | MachineSettingsTests, BoxSettingsTests, AlsoApplyTests, CustomAutoPlacesTests, SignInSyncTests | a connected machine's engine starting over with new settings (needs SSH) |
| F9, L46 A bot on a machine works and wakes while the Mac's app is closed; the machine restarting brings its engine back | OpenCodeKit's MachineWakeUpsTests (kuvo-wake, each minute: a due one reaches its bot once, one the engine couldn't take is tried again) and RebootTests (kuvo-start from the crontab, the watchdog: what keeps the engine up, a day without the app stops it); the bridge's bots tests (Packages/KuvoLink/Tests/Bridge) | the real crontab and restart (the end-to-end runs) |
| Group chats on a machine, run there with the Mac closed | MachineGroupTests; Agents' groups and groups-runner tests (the coding agents' bridge runs them); the bridge's groups tests | |
| Move to Computer: a bot, a chat or a group chat goes whole and carries on there; one cut short is taken back or finished | MoveTests, MachineGroupTests | over real SSH (the end-to-end runs) |
| A conversation or bot on a model whose account you signed out of says so, rather than going unanswered, on the Mac and a machine | ComposerReturnsTests, GroupChatTests; Agents' groups-runner, sessions and bridge tests | |
| The phone link: what a phone reads and does on the Mac (its prompts, marked as from the phone; group chats, wake-ups, the agent's cards, settings, accounts, files, new bots and group chats) and on a machine with the Mac closed | PhoneSettingsTests, PhoneAccountsTests, PhoneFilesTests, PhoneBotsTests, PhoneAwareTests, PhoneSkillsTests, PhoneIntegrationsTests, PhoneMachinesTests, PhoneMacSettingsTests, PhoneMovesToAgentsTests, GroupChatTests, WakeUpsTests, PhoneBotWakesTests, BrowserAsksTests, MachineGroupTests, WorktreeSessionTests (Settings › Worktrees), ClaudeCodeImportTests (From Claude Code); KuvoLink's LinkTests (pairing, removing a phone, the Mac starting again or its relay connection coming back) and EngineRoutesTests, and the bridge's tests | which machines a phone may reach (`kuvo/hosts`: bridges installed over SSH), the usage panel's route, the relay over the network (LiveLinkTests, by hand) |
| A sign-in that finishes on another device: its page opened on the phone, its return loaded on the Mac or the machine | PhoneSettingsTests, PhoneAccountsTests; the bridge's tests; Agents' bridge tests (a coding agent's sign-in for another device) | the providers' own pages |
| An agent shows you a file in the conversation (show_file), on the Mac and a phone | PhoneAwareTests (the tool's checks), PhoneFilesTests (the phone fetching it) | how it shows (UI) |
| J1 The network goes away mid-reply | NetworkDropTests | |
| J3 The engine stops; the app brings it back | EngineRestartTests | |
| J4 A huge file, a binary file in the changes; a command that prints a lot | ChangesDiscardTests, ChangesBinaryTests, CommandOutputTests | how much output the engine keeps (its own) |
| K1 Settings keep what you change; its tabs | EngineSettingsFileTests, SettingsTabsTests | |
| L42 Web search works from the start (the engine has no search chosen; every search failed) | EngineSettingsFileTests | |
| K3, L41 Notifications, and answering from one | NotificationMaskingTests, NotificationRepliesTests | macOS showing them (Notification Center) |
| ⌘K: find a session in any project, a file in this one, or an action | CommandPaletteTests | its window and keys (UI) |
| K2 Menu commands and shortcuts | | menus and keys (UI; the end-to-end runs check each against Settings › Keyboard Shortcuts) |
| K4 The menu bar's usage panel: which accounts count there | UsageAccountsTests, UsageKit's own tests | the panel asking the providers' services (UsageKit's own tests, against a fake of each) |
| K5 Storage: what takes room | StorageReportTests | |
| L50 Quit mid-job, open again | InterruptedRunTests | |
| The panel's terminal | TerminalColorsTests | |
| The context ring: how full, of what the model takes | ContextRingTests | the coding agents' windows, as each says (Agents/test) |
| Export a conversation | ConversationExportTests | |
| Your things after an update: backed up first, then brought up to date once (bots' descriptions in their folders); a list that won't read set aside | CalibrationTests | the window's Updating screen (UI); a machine's bots' descriptions (written over SSH as it connects) |
| Updates: only a release build updates itself | UpdatesTests; the release bundle's feed in CI ("Check the app bundle") | Sparkle's own window and install |
| Move to Applications (to update itself) | AppLocationTests | the offer, a modal alert, and a disk image's read-only copy |
| Anonymous usage stays anonymous | AnalyticsPrivacyTests | |
