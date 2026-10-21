# Scenarios the app tests guard

The app tests follow the scenarios in `Tests/E2E/SCENARIOS.md` (what people do with Kuvo Code),
by the same IDs. The end-to-end runs try each one for real, with a model; the app tests keep each
one working on every change, on CI, without a model or the network: the app's real stores, real
git and real files, with the engine stubbed at its HTTP API. A bug an end-to-end run found and
fixed (❌→✅ there) gets a test here when it can be tried this way.

Each suite's comment says what it tries; this is where each scenario stands. Scenarios that are
about what a model answers or does (B1–B4, D1, D2, E1–E3, E5, E7, most of L1–L49) are the
end-to-end runs' alone, as are those that need a real machine over SSH (F9, L46, L47).

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
| B8 A session in a worktree, merged back | WorktreeSessionTests, GitBranchesTests | |
| B9 Plan first, then Build It | AgentAsksTests | |
| B10 Ask First: allow once, always, deny | ComposerReturnsTests, ProjectFoldersTests, PermissionCardsTests, AlwaysAllowedTests | |
| B11, L38 The agent asks questions, answered in the card | AgentAsksTests | |
| B12 Queue while it works, Stop, Resume | ComposerReturnsTests, QueueTests | |
| B13 Two sessions at once, each with its own asks | AgentAsksTests | |
| B14 Switch model mid-conversation, or elsewhere, to a coding agent too | SessionsTests, MoveToAgentsTests | |
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
| E, B15 The agent's browser | BrowserToolServerTests | |
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
| A bot's own keys for integrations stay its own | BotKeysTests | a bot on a machine (its keys' files there, over SSH) |
| F10, L39, L40 Agents writing to each other | AgentMessagesTests, AgentReferencesTests | |
| G1–G4 Group chats, meetings on a schedule | BotsTests, AgentMessagesTests, GroupChatTests | |
| H1, H2, H5 MCP servers and integrations, before and after their keys | MCPCommandTests, ChromeDevToolsUpgradeTests, IntegrationsTests | an integration's card in Settings (UI) |
| H3 An MCP server asks mid-task | AgentAsksTests | |
| H4 A skill from GitHub | SkillLibraryTests | |
| I1 Add a machine, at one or more addresses | AddMachineTests, MachineAddressesTests | choosing the address that answers (needs SSH) |
| I2 A project on a machine | MachineFoldersTests, AttachmentRoutesTests, SignInSyncTests, MachineSignOutTests | |
| I3 A machine that's away | MachineAwayTests | |
| I4 What machines share with this Mac, and what's their own | MachineSettingsTests, CustomAutoPlacesTests, SignInSyncTests | a connected machine's engine starting over with new settings (needs SSH) |
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
| Updates: only a release build updates itself | UpdatesTests; the release bundle's feed in CI ("Check the app bundle") | Sparkle's own window and install |
| Move to Applications (to update itself) | AppLocationTests | the offer, a modal alert, and a disk image's read-only copy |
| Anonymous usage stays anonymous | AnalyticsPrivacyTests | |
