import AppKit
import ClientDesign
import ClientNews
import ClientSessions
import ClientText
import KuvoVoice
import OpenCodeKit
import SwiftTerm
import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// Where you talk to the agent: a floating glass panel with the message field,
/// the mode (Build/Plan) and model pickers, and a send button that turns into
/// Stop while the agent works.
struct Composer: View {
    /// The session it's writing to, where it stays as you go from one to another: what it was
    /// doing (a recalled message, the "@" or "/" list) is let go, and the cursor goes after the
    /// draft there.
    var session: String? = nil
    @Binding var text: String
    @Binding var files: [URL]
    /// What you're replying to, each with your answer to it under it.
    var quotes: Binding<[Drafts.Quote]> = .constant([])
    /// The quote whose answer takes the keyboard (the one just added, or quoted again).
    var quoteFocus: Drafts.QuoteFocus?
    let agent: String
    let approval: ToolApproval
    let model: ModelRef?
    /// On Auto, the model of your list at work now (its latest reply's).
    var modelInUse: ModelRef?
    let isRunning: Bool
    /// Messages are waiting their turn, so ⌘Return adds to the queue even while idle.
    var hasQueue = false
    /// Messages sent before, oldest first: ↑ and ↓ go through them, as in a shell. Read when
    /// they're used, so the composer isn't drawn again as the conversation changes.
    var history: () -> [String] = { [] }
    /// The project's folders, the primary one first, for "@" mentions of their files.
    var folders: [String] = []
    /// What "/" at the start of a message can run.
    var commands: [Command] = []
    /// The keywords "/" offers first (those this conversation's computer runs): one typed is
    /// drawn as a token, says what it will do under the field, and a picked one fills in.
    var keywords: [Keyword] = []
    /// Puts the cursor here when it changes.
    var focusRequest = 0
    /// Opens the model picker when it changes.
    var modelMenuRequest = 0
    /// While a side thread shows over it: what's sent goes there as a follow-up, which its tag
    /// says; the tag's × puts it back on the conversation.
    var sideQuestion: (() -> Void)?
    /// Its last question is still being answered: the next waits.
    var sideQuestionAnswering = false
    /// The engine it sends to can't be reached now (its machine is reconnecting): you can write,
    /// not send.
    var isOffline = false
    /// Goes up when it should let go of the keyboard (for a question that came).
    var blurRequest = 0
    /// Comments on the changes waiting to go with the next message.
    var commentCount = 0
    var onDiscardComments: () -> Void = {}
    var onSelectAgent: (String) -> Void
    var onSelectApproval: (ToolApproval) -> Void
    /// The approval as its box shows it (why it asks first for now, which can't be picked).
    var approvalShown: ApprovalShown?
    /// Opens Auto's Decisions here (nil: none to open, as for a new conversation).
    var onDecisions: (() -> Void)?
    /// Autopilot, as the Mode menu offers it (nil: not here); on, its chip shows before Mode's.
    var autopilot: AutopilotChoice?
    var onSelectAutopilot: (Bool) -> Void = { _ in }
    /// Auto's Decisions, open over the mode chip.
    var showsDecisions: Binding<Bool> = .constant(false)
    var decisions: AnyView?
    /// Full Access was picked where it isn't confirmed yet: the composer asks (`onConfirmFullAccess`).
    var confirmsFullAccess: Binding<Bool> = .constant(false)
    var onConfirmFullAccess: () -> Void = {}
    var onSelectModel: (ModelRef) -> Void
    /// A new session in a git repository: whether it gets a worktree of its own (nil hides it).
    var worktree: Bool?
    var onSelectWorktree: (Bool) -> Void = { _ in }
    /// Sessions to start with the message, each in a worktree of its own.
    var attempts = 1
    var onSelectAttempts: (Int) -> Void = { _ in }
    var onSend: () -> Void
    /// ⌘Return: after the run, and anything queued before. Where nothing can be running yet (a
    /// new session's composer), it sends.
    var onQueue: (() -> Void)?
    /// ↑ in an empty composer brings back the last waiting message; false if there's none.
    var onEditLast: () -> Bool = { false }
    var onStop: () -> Void
    /// The approval chip and the Plan chip: hidden where they're not yours to pick (a subagent's
    /// are its agent's).
    var showsMode = true
    /// The model chip: hidden where the model isn't yours to pick (a coding agent's subagent's).
    var showsModel = true
    /// A quiet line over the field: where what you write goes, when it isn't straight there (a
    /// Claude Code subagent's: through the conversation that started it).
    var note: String?
    /// The models its picker offers, when they aren't the session's (a subagent's: the engine's).
    var scope: ModelScope?
    /// Takes the keyboard as it shows; a subagent's beside the conversation leaves it there.
    var focusesOnAppear = true
    /// Back in its place after an ask had it: takes the keyboard only where nothing else you type
    /// in has it (a terminal, a page, a file you're editing keep it).
    var yieldsKeyboard = false
    /// What the empty field says, when it isn't the usual.
    var prompt: String?
    /// Its own card; off in the card it shares with the bars and the queue over it (the session's).
    var drawsSurface = true

    @Environment(Catalog.self) private var catalog
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var scheme
    @Environment(\.cardIsFocused) private var cardIsFocused
    @Environment(\.messageFont) private var messageFont
    @Environment(\.bot) private var bot
    /// Asks the field for the keyboard; nil once it has it.
    @State private var fieldFocus: MessageField.FocusRequest?
    /// The quote whose answer is to take the keyboard; nil once it has it.
    @State private var answerFocus: (id: UUID, request: MessageField.FocusRequest)?
    /// Writes a picture's name where the caret is.
    @State private var field = MessageField.Handle()
    /// How tall what you're saying is, in the field's place while you speak into it.
    @State private var voiceHeight: CGFloat = 0

    /// The models its picker offers, by where the conversation lives (see `ModelScope.at`): the
    /// same for a session, a chat and a bot's conversation.
    private var modelScope: ModelScope {
        if let scope { return scope }
        if let session {
            guard let current = workspace.session(session) else { return .engine }
            return .at(current.location.directory)
        }
        return .at(folders.first)
    }
    @Environment(\.composerFocused) private var composerFocused
    @State private var isTargeted = false
    /// The sent message showing in the field, while going through them.
    @State private var historyIndex: Int?
    /// The project's files for "@", read when one is typed.
    @State private var mentionFiles: [ProjectFiles.File] = []
    /// The folders `mentionFiles` were read in: a read for another session's project, coming in
    /// after you went to this one, isn't this one's.
    @State private var mentionFilesFolders: [String] = []
    @State private var mentionFilesRead: Date?
    @State private var mentionIndex = 0
    /// Where the "@" whose list was closed with Escape is, so it stays closed.
    @State private var dismissedMention: Int?
    @State private var commandIndex = 0
    /// The "/" list was closed with Escape; it opens again for a new message.
    @State private var dismissedCommands = false
    @State private var loopIndex = 0
    /// "/loop"'s "How often" was closed with Escape, or Custom… is open in its place.
    @State private var dismissedLoop = false
    @State private var customLoop = false
    @State private var reviewerIndex = 0
    /// The field has the keyboard: the shortcut's voice input would go here.
    @State private var fieldHasKeyboard = false
    /// Its card is kept made under another tab's: as good as gone, until its tab is back.
    @Environment(\.isKeptOutOfSight) private var isKept
    /// The "/review" list closed with Escape (its title, or "models"): another one still opens.
    @State private var dismissedReviewList: String?
    /// What the box said of this folder for "/review"'s lists: what it offers, and how much each reads.
    @State private var reviewKnown = ReviewList.Known()
    /// The model picked last there (`Model.key`), offered first next time.
    @AppStorage(Catalog.lastReviewerKey) private var lastReviewer = ""
    /// Your starred models (the model picker's), offered there after it.
    @AppStorage("favoriteModels") private var starredModels = ""
    /// "&" and the bots and sessions it names.
    @State private var agents = AgentPicker()

    private var canSend: Bool {
        if isOffline { return false }
        if isShell { return SessionModel.shellCommand(in: text) != nil }
        if asksSide, sideQuestionAnswering { return false }
        let answered = quotes.wrappedValue.contains { !$0.response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        // Review comments wait for a message to the agent: alone, they don't make a side question.
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || answered || !files.isEmpty || (commentCount > 0 && !asksSide)
    }

    /// "!" first: the message is a command to run in the project's folder, not words for the agent.
    private var isShell: Bool { text.hasPrefix("!") }
    /// What's sent goes to the side thread: its tag shows (a command runs as typed instead).
    private var asksSide: Bool { sideQuestion != nil && !SessionModel.runsAsTyped(text, commands: commands, keywords: keywords) }
    private var currentModel: Model? { catalog.model(model) ?? catalog.defaultModel }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let commandMatches {
                SlashList(items: commandMatches, selected: min(commandIndex, commandMatches.count - 1), project: folders.first.flatMap { Workspace.isChat($0) ? nil : workspace.projectName($0) }) { pick($0) }
            } else if customLoop, typedKeyword?.keyword == .loop {
                CustomLoopRow(use: { pickLoop(.preset($0)) }, cancel: {
                    customLoop = false
                    focusAtEnd()
                })
            } else if let loopChoices {
                LoopList(choices: loopChoices, selected: min(loopIndex, loopChoices.count - 1)) { pickLoop($0) }
            } else if let reviewerChoices {
                ReviewerList(choices: reviewerChoices, selected: min(reviewerIndex, reviewerChoices.count - 1)) { pickReviewer($0) }
            } else if let reviewList {
                ReviewChoiceList(list: reviewList, selected: min(reviewerIndex, reviewList.rows.count - 1)) { pickReview($0) }
            } else if let mention {
                MentionList(files: mention.matches, selected: min(mentionIndex, max(mention.matches.count - 1, 0))) { insertMention($0) }
            } else if let named = agents.matches(in: text, excluding: session) {
                AgentReferenceList(agents: named, selected: min(agents.selected, named.count - 1)) { agents.insert($0, into: $text) }
            }
            if let sideQuestion, asksSide {
                SideQuestionTag(close: sideQuestion)
                    .transition(.opacity)
            }
            if commentCount > 0 {
                Menu {
                    Button("Discard Comments", role: .destructive, action: onDiscardComments)
                } label: {
                    Text(commentCount.counting("comment"))
                        .font(.system(size: 12, weight: .medium))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(FilledButtonStyle(shape: .capsule, rest: 0.06))
                .fixedSize()
                .help("Your comments on the changes go with this message.")
            }
            if !files.isEmpty {
                AttachmentStrip(files: files) { file in
                    ComposerAttachment(url: file, route: Attachments.route(file, for: currentModel, onMachine: RemoteFolder.machine(of: folders.first ?? "") != nil),
                                       number: imageFiles.firstIndex(of: file).map { $0 + 1 }, pictures: imageFiles) { detach(file) }
                }
            }

            // Each quote with your answer to it, in the order they go.
            if !quotes.wrappedValue.isEmpty {
                QuoteList(quotes: quotes, focus: answerFocus, blur: blurRequest, font: messageFont.field, images: imageFiles.count,
                          onKey: answerKey, onFocus: { id, focused in
                              if focused, answerFocus?.id == id { answerFocus = nil }
                              fieldFocused(focused)
                          }, onPaste: pasteAttachments)
            }
            if let note {
                Text(note)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ZStack(alignment: .topLeading) {
                MessageField(
                    text: $text,
                    placeholder: placeholder,
                    font: isShell ? .monospacedSystemFont(ofSize: messageFont.size - 0.5, weight: .regular) : messageFont.field,
                    focus: fieldFocus,
                    blur: blurRequest,
                    marks: !isShell,
                    images: imageFiles.count,
                    token: token,
                    example: example,
                    onKey: key,
                    onFocus: { focused in
                        if focused { fieldFocus = nil }
                        fieldFocused(focused)
                    },
                    onPaste: pasteAttachments,
                    handle: field,
                    isEditable: !isDictating
                )
                // Editing a recalled message makes it a new one; the arrows move the cursor again.
                .onChange(of: text) { _, new in
                    if let index = historyIndex {
                        let history = history()
                        if !history.indices.contains(index) || new != history[index] { historyIndex = nil }
                    }
                    mentionTyped(in: new)
                    agents.textChanged(new)
                    if SlashCommands.query(in: new) == nil {
                        commandIndex = 0
                        if new.isEmpty { dismissedCommands = false }
                    } else if let query = SlashCommands.query(in: new), let commandMatches {
                        // As you type, the one named exactly what you typed, else the first.
                        commandIndex = SlashItem.chosen(query, in: commandMatches)
                    }
                    // Not /review any more: its lists can open again.
                    if !new.hasPrefix(Keyword.review.typed) {
                        reviewerIndex = 0
                        dismissedReviewList = nil
                    }
                    if !new.hasPrefix(Keyword.loop.typed) {
                        loopIndex = 0
                        dismissedLoop = false
                        customLoop = false
                    } else if customLoop, LoopCommand(String(new.dropFirst(Keyword.loop.typed.count))).schedule != nil {
                        // Typed in the field meanwhile: Custom… has nothing left to ask.
                        customLoop = false
                    }
                }
                .onChange(of: session) { agents.reset() }
                // Each time "/review" is written: what its lists offer here, and how much each reads.
                .task(id: reviewListSession) { await loadReviewKnown() }
                // Another of its lists: from its first row again.
                .onChange(of: reviewList?.title) { reviewerIndex = 0 }
                // Listening ("In the Composer"): what's written, then what you're saying, as it comes,
                // in the field's place (it stays, unseen, as it was).
                .opacity(listening == nil ? 1 : 0)
                .accessibilityHidden(listening != nil)
                if let voice = listening {
                    // A long draft shows its end, where the words come. As tall as the words, as
                    // the field is as you type: a line at least, then scrolling, the newest in
                    // view, past the field's own limit.
                    let line = NSLayoutManager().defaultLineHeight(for: messageFont.field)
                    ScrollView {
                        VoiceWords(transcript: voice.transcript, font: Font(messageFont.field), placeholder: text.isEmpty && voice.phase == .listening ? "Listening…" : "",
                                   before: text.count > 300 ? "…" + text.suffix(300) : text)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .fixedSize(horizontal: false, vertical: true)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { voiceHeight = $0 }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .defaultScrollAnchor(.bottom, for: .sizeChanges)
                    .frame(height: ceil(min(max(voiceHeight, line), line * 12)))
                }
            }
            if let keywordProblem { KeywordProblem(text: keywordProblem) }

            // Decisions and Full Access's confirmation open over the chips' row, which stays while
            // the mode chip makes way (a shell command, the voice).
            ZStack(alignment: .leading) {
                if let voice = listening {
                    // The chips make way for the voice: how long, how loud, Cancel and Done.
                    VoiceComposerRow(voice: voice, cancel: { app.dictation.cancel(); focusAtEnd() }, done: { app.dictation.finish() }, openSettings: { Self.openPrivacySettings(for: voice.phase) })
                        .transition(.opacity)
                } else {
                    HStack(spacing: 4) {
                        if isShell {
                            ShellModeLabel(folder: folders.first)
                                .transition(.opacity)
                        } else {
                            Group {
                                Button(action: chooseFiles) {
                                    Image(systemName: "paperclip")
                                        .font(.system(size: 14, weight: .medium))
                                        .frame(width: 30, height: 28)
                                        .hoverHighlight(in: Capsule(), mutesInk: true)
                                }
                                .buttonStyle(.plain)
                                .clickablePointer()
                                .accessibilityLabel("Attach Files")
                                .help("Attach Files… You can also drop files here, or paste them.")
                                // Set on the engine: not while it's out of reach.
                                if showsMode && !agent.isEmpty && agent != "build" {
                                    AgentChip(agent: agent) { onSelectAgent("build") }
                                        .disabled(isOffline)
                                        .transition(.opacity)
                                }
                                if showsMode && autopilot?.on == true {
                                    AutopilotChip { onSelectAutopilot(false) }
                                        .disabled(isOffline)
                                        .transition(.opacity)
                                }
                                if showsMode {
                                    ModeChip(approval: approval, shown: approvalShown, onDecisions: onDecisions, autopilot: autopilot, onSelectAutopilot: onSelectAutopilot, onSelectApproval: onSelectApproval)
                                        .disabled(isOffline)
                                        // Gives way first, down to its icon, before the model's
                                        // name does (the spacer comes after it).
                                        .layoutPriority(-1)
                                }
                                if showsModel {
                                    ModelChip(selection: model, onSelect: onSelectModel, scope: modelScope, inUse: modelInUse, openRequest: modelMenuRequest)
                                        .disabled(isOffline)
                                }
                                if let worktree {
                                    WorkplaceChip(worktree: worktree, attempts: attempts, onSelect: onSelectWorktree, onSelectAttempts: onSelectAttempts)
                                }
                            }
                            .transition(.opacity)
                        }
                        Spacer(minLength: 0)
                            .layoutPriority(-2)
                        if !isShell { voiceButton }
                        actionButton
                    }
                    .animation(.easeOut(duration: 0.15), value: isShell)
                    // The pills are flat, so their text lines up with the message field above;
                    // their hover fill reaches past it.
                    .padding(.leading, -8)
                }
            }
            .popover(isPresented: showsDecisions, attachmentAnchor: .point(UnitPoint(x: 0.12, y: 0)), arrowEdge: .top) { decisions }
            .modifier(FullAccessConfirmation(isPresented: confirmsFullAccess, computer: folders.first.flatMap(RemoteFolder.machine(of:)), confirm: onConfirmFullAccess))
        }
        .animation(.ui, value: listening != nil)
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 7)
        .modifier(ComposerSurface(isOn: drawsSurface))
        .overlay {
            // Listening here: the card's edge in the accent.
            if listening != nil {
                RoundedRectangle(cornerRadius: drawsSurface ? Metrics.composerRadius : 12)
                    .strokeBorder(.tint, lineWidth: 1.5)
                    .padding(drawsSurface ? 0 : 4)
                    .allowsHitTesting(false)
            }
        }
        .overlay {
            if isTargeted {
                // Its own card's edge; inside the card it shares, a ring of its own in it.
                RoundedRectangle(cornerRadius: drawsSurface ? Metrics.composerRadius : 12)
                    .strokeBorder(.tint, lineWidth: 2)
                    .padding(drawsSurface ? 0 : 4)
            }
        }
        // Files dropped anywhere on it are attached, on its text too (which would take them as
        // their paths).
        .overlay {
            FileDropArea(isTargeted: { isTargeted = $0 }, drop: attachAndName)
        }
        .onChange(of: focusRequest) { focusAtEnd() }
        // A quote just added: its answer takes the keyboard.
        .onChange(of: quoteFocus) { _, focus in answerFocus = focus.map { (id: $0.id, request: MessageField.FocusRequest()) } }
        // Gone (another kind of tab, Settings over it): what it was listening for stops, rather
        // than going on unseen, and the shortcut has nowhere here to start.
        .onDisappear { stopListening() }
        // Kept made under another tab's card, it's as good as gone (its fields let go of the
        // keyboard themselves); back, it has the keyboard, as it would made anew.
        .onChange(of: isKept) { _, kept in
            if kept { stopListening() } else if focusesOnAppear { focusAtEnd() }
        }
        .onChange(of: session) { old, _ in
            // Listening for the session it showed: that stops, rather than going on unseen, and
            // what was said so far goes into that session's draft; and the shortcut is this one's
            // now, where you type.
            let left = old ?? "new:" + (folders.first ?? "")
            if app.dictation.isListening(for: left) {
                if app.dictation.voice?.phase == .listening || app.dictation.voice?.keepsWords == true { app.dictation.finish() } else { app.dictation.cancel() }
            }
            app.dictation.withdraw(left)
            if fieldHasKeyboard { offerVoice() }
            historyIndex = nil
            mentionFiles = []
            mentionFilesRead = nil
            mentionIndex = 0
            dismissedMention = nil
            commandIndex = 0
            dismissedCommands = false
            loopIndex = 0
            dismissedLoop = false
            customLoop = false
            reviewerIndex = 0
            dismissedReviewList = nil
            isTargeted = false
            // The keyboard goes to this session's message, not a quote it was answering before.
            answerFocus = nil
            // Undoing typing here brings back nothing from the session it was writing to before.
            field.forgetUndo()
            focusAtEnd()
        }
        .onAppear {
            if focusesOnAppear && (!yieldsKeyboard || keyboardIsFree) { focusAtEnd() }
            #if DEBUG
            // KUVO_DEMO_COMPOSER_FILES: comma-separated paths to show as attached.
            if files.isEmpty, let list = ProcessInfo.processInfo.environment["KUVO_DEMO_COMPOSER_FILES"] {
                files = list.split(separator: ",").map { URL(filePath: String($0)) }
            }
            #endif
        }
    }

    /// What it was listening for stops, and the voice shortcut has nowhere here to start.
    private func stopListening() {
        if isDictating { app.dictation.cancel() }
        app.dictation.withdraw(voiceOwner)
    }

    /// Nothing you type in has the keyboard in its window (active or not): the window, a list or
    /// a button does, or the ask's own line, which goes with it.
    private var keyboardIsFree: Bool {
        guard let window = field.window ?? NSApp.keyWindow else { return false }
        let responder = window.firstResponder
        if let text = responder as? NSTextView, text.isFieldEditor {
            // (A line it's gone from, or one in the ask's place.)
            guard let line = text.delegate as? NSView else { return true }
            return line.window == nil || AskArea.holds(line)
        }
        if let text = responder as? NSTextView { return !text.isEditable }
        return !(responder is WKWebView || responder is TerminalView)
    }

    /// Puts the cursor in the field, after what's there.
    private func focusAtEnd() {
        fieldFocus = MessageField.FocusRequest()
    }

    /// The field or an answer took the keyboard, or let it go: where you type is where you work,
    /// so the window's commands follow.
    private func fieldFocused(_ focused: Bool) {
        fieldHasKeyboard = focused
        if focused {
            composerFocused?()
            offerVoice()
        } else {
            app.dictation.withdraw(voiceOwner)
        }
    }

    /// The shortcut's voice input goes where you type: here.
    private func offerVoice() {
        let text = $text
        app.dictation.offer(voiceOwner, words: voiceWords) { [focusAtEnd] words in
            text.wrappedValue = VoiceStyle.adding(words, to: text.wrappedValue)
            focusAtEnd()
        }
    }

    /// An input method is composing in the field that has the keyboard (Japanese, Chinese,
    /// Korean…): Return picks its candidate, Escape cancels it and the arrows move through its
    /// list, rather than sending, stopping the agent or going back through messages. For every
    /// composer.
    static var isComposing: Bool {
        (NSApp.keyWindow?.firstResponder as? NSTextView)?.hasMarkedText() == true
    }

    /// The field's keys: the "&", "/" and "@" lists' first while one is open; then Return sends
    /// (Shift- or Option-Return starts a new line, ⌘Return queues), Escape stops, and ↑ and ↓ go
    /// through what was sent before.
    private func key(_ key: MessageField.Key) -> Bool {
        // Listening (here, or in the voice field): Return is Done, Escape is Cancel, and nothing
        // else goes to the field.
        if isDictating {
            switch key.name {
            case .return: app.dictation.finish()
            case .escape:
                app.dictation.cancel()
                focusAtEnd()
            default: break
            }
            return true
        }
        if agents.key(key, text: $text, excluding: session) { return true }
        if let loopChoices, loopKey(key, loopChoices) { return true }
        if let reviewerChoices, reviewerKey(key, reviewerChoices) { return true }
        if let reviewList, reviewListKey(key, reviewList) { return true }
        switch key.name {
        case .return:
            if let commandMatches, key.modifiers.isEmpty {
                pick(commandMatches[min(commandIndex, commandMatches.count - 1)])
                return true
            }
            if let mention, key.modifiers.isEmpty, !mention.matches.isEmpty {
                insertMention(mention.matches[min(mentionIndex, mention.matches.count - 1)])
                return true
            }
            return answerKey(key)
        case .tab:
            if let commandMatches {
                switch commandMatches[min(commandIndex, commandMatches.count - 1)] {
                case .keyword(let keyword): text = keyword.typed + " "
                case .command(let command): text = "/" + command.name + " "
                }
                return true
            }
            guard let mention, !mention.matches.isEmpty else { return false }
            insertMention(mention.matches[min(mentionIndex, mention.matches.count - 1)])
            return true
        case .escape:
            // Closes the "/" or "@" list first; otherwise stops the agent, as ⌘. does.
            if commandMatches != nil {
                dismissedCommands = true
                return true
            }
            if let start = Mentions.query(in: text)?.start, mention != nil {
                dismissedMention = text.distance(from: text.startIndex, to: start)
                return true
            }
            return answerKey(key)
        case .up:
            if let commandMatches {
                commandIndex = max(0, min(commandIndex, commandMatches.count - 1) - 1)
                return true
            }
            if let mention, !mention.matches.isEmpty {
                mentionIndex = max(0, min(mentionIndex, mention.matches.count - 1) - 1)
                return true
            }
            // A waiting message comes back first; then what was sent before.
            if text.isEmpty, files.isEmpty, historyIndex == nil, onEditLast() { return true }
            return recall(-1)
        case .down:
            if let commandMatches {
                commandIndex = min(commandMatches.count - 1, commandIndex + 1)
                return true
            }
            if let mention, !mention.matches.isEmpty {
                mentionIndex = min(mention.matches.count - 1, mentionIndex + 1)
                return true
            }
            return recall(1)
        }
    }

    /// An answer's keys, and the field's with no list open: Return sends (Shift- or Option-Return
    /// starts a new line, ⌘Return queues); Escape closes an open Find bar, then stops the agent.
    private func answerKey(_ key: MessageField.Key) -> Bool {
        if isDictating { return self.key(key) }
        switch key.name {
        case .return:
            if key.modifiers.contains(.shift) || key.modifiers.contains(.option) { return false }
            if key.modifiers.contains(.command) { queue() } else { send() }
            return true
        case .escape:
            if ConversationFind.closeOpen() { return true }
            guard isRunning else { return false }
            onStop()
            return true
        default:
            return false
        }
    }

    private var placeholder: String {
        if let prompt { return prompt }
        if sideQuestion != nil { return "Ask a follow-up…" }
        // ⌘↩ to queue instead is in the send button's help.
        if isRunning { return "Add to the task…" }
        if let bot { return bot.job.isEmpty ? "Tell \(bot.name) its job…" : "Message \(bot.name)…" }
        // The mode is named beside it, so it isn't said again here.
        return "Ask anything…"
    }

    /// Where what's said goes: this composer's session, or a new session's draft.
    private var voiceOwner: String { session ?? "new:" + (folders.first ?? "") }

    /// The words voice input listens for here: the conversation's project's names, as its
    /// computer's box gives them (none yet for a new session's draft).
    private var voiceWords: Dictation.Words {
        guard let session, let directory = workspace.session(session)?.location.directory,
              let api = workspace.agents(forFolder: directory)?.api else { return { [] } }
        return { (try? await api.voiceWords(for: session)) ?? [] }
    }

    /// Listening for this composer, here or in the voice field.
    private var isDictating: Bool { app.dictation.isListening(for: voiceOwner) }

    /// Listening here, in the composer ("In the Composer"); the voice field shows itself.
    private var listening: VoiceInput? {
        guard app.dictation.isListening(for: voiceOwner), app.dictation.style == .composer else { return nil }
        return app.dictation.voice
    }

    /// Talk instead of typing: what you say goes after what's written, and nothing is sent.
    private var voiceButton: some View {
        MicButton(owner: voiceOwner, start: startVoice)
    }

    private func startVoice() {
        // The keyboard here: Return finishes, Escape cancels, nothing else types.
        focusAtEnd()
        let text = $text
        app.dictation.start(for: voiceOwner, words: voiceWords) { [focusAtEnd] words in
            text.wrappedValue = VoiceStyle.adding(words, to: text.wrappedValue)
            focusAtEnd()
        }
    }

    /// Privacy & Security, on what wasn't allowed: the microphone, or speech recognition.
    static func openPrivacySettings(for phase: VoiceInput.Phase) {
        let pane = phase == .failed(.speechDenied) ? "Privacy_SpeechRecognition" : "Privacy_Microphone"
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?" + pane)!)
    }

    private var actionButton: some View {
        SendStopButton(
            stops: isRunning, canSend: canSend,
            sendHelp: isOffline ? "Send once the connection is back" : asksSide && sideQuestionAnswering ? "Send once the side question is answered" : isShell ? "Run the Command (Return)" : isRunning ? "Send: the agent reads it at its next step (Return). ⌘Return queues it for after this run." : "Send (Return)",
            stopHelp: "Stop (⌘.)", send: send, stop: onStop
        ) {
            Button("Send", action: send)
            Button("Queue for After This Run", action: queue)
                .disabled(!isRunning && !hasQueue)
        }
    }

    private func send() {
        guard canSend else {
            if isOffline, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { Analytics.shared.firstMessageBlocked("engine_offline") }
            return
        }
        // A keyword used: its "New" goes.
        if let (keyword, _) = Keyword.parse(text) { app.newMarks.use("keyword/" + keyword.rawValue) }
        onSend()
    }

    private func queue() {
        guard let onQueue else { return send() }
        guard canSend else { return }
        onQueue()
    }

    /// The keywords and commands matching the "/" that starts the message, while its list is
    /// open. Not while going through sent messages: ↑ and ↓ keep doing that.
    private var commandMatches: [SlashItem]? {
        guard !dismissedCommands, historyIndex == nil, let query = SlashCommands.query(in: text) else { return nil }
        let matches = SlashItem.matches(query, keywords: keywords, commands: commands).prefix(12)
        return matches.isEmpty ? nil : Array(matches)
    }

    /// Picked from the list: a keyword fills in, so what it does is read before Return runs it;
    /// a command runs, as if "/name" had been typed and sent.
    private func pick(_ item: SlashItem) {
        commandIndex = 0
        switch item {
        case .keyword(let keyword):
            text = keyword.typed + " "
            app.newMarks.use("keyword/" + keyword.rawValue)
            focusAtEnd()
        case .command(let command):
            text = "/" + command.name
            send()
        }
    }

    /// The keyword the message starts with, one offered here, and what follows it: "/goal all
    /// tests pass" is (.goal, " all tests pass"). Not in a "!" command.
    private var typedKeyword: (keyword: Keyword, rest: String)? {
        guard text.hasPrefix("/") else { return nil }
        let name = text.dropFirst().prefix { !$0.isWhitespace }
        guard let keyword = Keyword(rawValue: name.lowercased()), keywords.contains(keyword) else { return nil }
        return (keyword, String(text.dropFirst(1 + name.count)))
    }

    /// The keyword drawn as a token: /loop's with its schedule once it reads one.
    private var token: MessageField.Token? {
        guard let (keyword, rest) = typedKeyword else { return nil }
        let schedule = keyword == .loop ? LoopCommand(rest).scheduleLength : keyword == .review ? reviewCommand(rest).readerLength : 0
        return MessageField.Token(length: keyword.typed.utf16.count + schedule, symbol: keyword.symbol)
    }

    /// In grey after the keyword until something follows it: what to write ("/loop"'s once it
    /// has a schedule).
    private var example: String? {
        guard let (keyword, rest) = typedKeyword, rest.first?.isWhitespace == true else { return nil }
        if keyword == .loop {
            let command = LoopCommand(rest)
            return command.schedule != nil && command.message.isEmpty ? keyword.argument : nil
        }
        if keyword == .review {
            let command = reviewCommand(rest)
            guard command.asking == nil, command.searching == nil, command.focus.isEmpty else { return nil }
            // After Something else…'s "for ": your words; after the rest, anything more.
            if rest.lowercased().hasSuffix("for ") { return "what to look at" }
            return command.readerLength > 0 ? "anything else to look at (or nothing)" : nil
        }
        return rest.allSatisfy(\.isWhitespace) ? keyword.argument : nil
    }

    /// Under the field while a keyword is typed: only what's wrong with it (a /loop whose "how
    /// often" can't be read); keywords explain nothing there.
    private var keywordProblem: String? {
        guard let (keyword, rest) = typedKeyword, commandMatches == nil, keyword == .loop, loopChoices == nil, !customLoop,
              LoopCommand(rest).schedule == nil else { return nil }
        return "Can’t tell how often from that. Start with one like “every 30 min” or “weekdays at 9”."
    }

    /// "/review"'s reading of what follows it, against this conversation's models.
    private func reviewCommand(_ rest: String) -> ReviewCommand {
        ReviewCommand(rest, readers: isAgentConversation ? [] : catalog.reviewReaders, preferring: Catalog.lastReviewer)
    }

    /// A coding agent's conversation: its own agent reads a review, no other model.
    private var isAgentConversation: Bool {
        if let session, let known = workspace.session(session) { return OutsideAgents.isAgentSession(known) }
        return currentModel.map { OutsideAgents.runsInBridge($0.providerID) } ?? false
    }

    /// The models "with" can name: after "with ", the one picked last, your starred ones, then the
    /// others; then those whose names have what's typed (and longer ones a name starts).
    private var reviewerChoices: [ReviewerChoice]? {
        guard dismissedReviewList != "models", !isAgentConversation, historyIndex == nil, let (keyword, rest) = typedKeyword, keyword == .review,
              rest.first?.isWhitespace == true else { return nil }
        let readers = catalog.reviewReaders
        let command = reviewCommand(rest)
        if let reader = command.reader {
            // A name that starts longer ones ("GPT-5" of "GPT-5 Mini"), while it's being typed.
            let longer = command.focus.isEmpty ? ReviewCommand.longer(than: rest, readers: readers) : []
            return longer.isEmpty ? nil : ([reader] + longer.filter { $0 != reader }).prefix(6).map { .reader($0, note: $0.provider) }
        }
        guard let searching = command.searching else { return nil }
        guard searching.isEmpty else {
            let matches = ReviewCommand.search(searching, in: readers).prefix(6)
            return matches.isEmpty ? nil : matches.map { .reader($0, note: $0.provider) }
        }
        // Nothing typed after "with" yet: the one picked last, your starred ones, then the others.
        let own = currentModel?.key
        let key = { (reader: ReviewCommand.Reader) in reader.ref.providerID + "/" + reader.ref.id }
        let last = readers.first { key($0) == lastReviewer && key($0) != own }
        let starred = starredModels.split(separator: ",").map(String.init).compactMap { starred in
            readers.first { key($0) == starred && starred != own && starred != lastReviewer }
        }
        let others = readers.filter { reader in key(reader) != own && reader != last && !starred.contains(reader) }
        let choices = ((last.map { [ReviewerChoice.reader($0, note: "picked last time")] } ?? []) + starred.map { .reader($0, note: $0.provider) } + others.map { .reader($0, note: $0.provider) })
            .prefix(6).map { $0 }
        // (Only the conversation's own on offer: nothing to list.)
        return choices.isEmpty ? nil : choices
    }

    /// "/review "'s What to review, a commit or a folder for it, or Look for, as what's typed asks.
    private var reviewList: ReviewList? {
        guard historyIndex == nil, let (keyword, rest) = typedKeyword, keyword == .review,
              rest.first?.isWhitespace == true, let asking = reviewCommand(rest).asking,
              let list = ReviewList.make(asking, known: reviewKnown), list.title != dismissedReviewList else { return nil }
        return list
    }

    /// The conversation's whose lists are asked about, while "/review" is typed.
    private var reviewListSession: String? {
        guard typedKeyword?.keyword == .review else { return nil }
        return session
    }

    /// Asks the conversation's box what its lists offer, and how much each reads, each time
    /// "/review" is written.
    private func loadReviewKnown() async {
        reviewKnown = ReviewList.Known()
        guard let session = reviewListSession, let directory = workspace.session(session)?.location.directory,
              let api = workspace.agents(forFolder: directory)?.api else { return }
        await ReviewList.Known.load(session: session, api: api) { reviewKnown = $0 }
    }

    /// Picked from a "/review" list: its words written after what's there, for the next one; or,
    /// from Look for, the review starts (Tab only writes them).
    private func pickReview(_ row: ReviewList.Row, starts: Bool = true) {
        reviewerIndex = 0
        guard let (_, rest) = typedKeyword else { return }
        let head = Keyword.review.typed + reviewCommand(rest).head
        switch row.pick {
        case .write(let words):
            text = head + words
            focusAtEnd()
        case .start(let words) where !starts:
            text = head + words + (words.isEmpty ? "" : " ")
            dismissedReviewList = "Look for"
            focusAtEnd()
        case .start(let words):
            text = (head + words).trimmingCharacters(in: .whitespaces)
            send()
        case .ownWords:
            // Something else…: what to review, in your own words, after what's there.
            text = head
            dismissedReviewList = "What to review"
            focusAtEnd()
        }
    }

    /// A "/review" list's keys while it's open: ↑ ↓ choose, Return and Tab pick, Escape closes it.
    private func reviewListKey(_ key: MessageField.Key, _ list: ReviewList) -> Bool {
        switch key.name {
        case .return, .tab:
            guard key.modifiers.isEmpty else { return false }
            pickReview(list.rows[min(reviewerIndex, list.rows.count - 1)], starts: key.name == .return)
        case .escape: dismissedReviewList = list.title
        case .up: reviewerIndex = max(0, min(reviewerIndex, list.rows.count - 1) - 1)
        case .down: reviewerIndex = min(list.rows.count - 1, reviewerIndex + 1)
        }
        return true
    }

    /// Picked from the models after "with": its name written there, the lists going on after it.
    private func pickReviewer(_ choice: ReviewerChoice) {
        reviewerIndex = 0
        guard case .reader(let reader, _) = choice, let (_, rest) = typedKeyword else { return }
        lastReviewer = reader.ref.providerID + "/" + reader.ref.id
        text = Keyword.review.typed + reviewCommand(rest).head + ReviewCommand.phrase(reader) + " "
        focusAtEnd()
    }

    /// The models' keys while they're listed: ↑ ↓ choose, Return and Tab pick, Escape closes it.
    private func reviewerKey(_ key: MessageField.Key, _ choices: [ReviewerChoice]) -> Bool {
        guard !choices.isEmpty else { return false }
        switch key.name {
        case .return, .tab:
            guard key.modifiers.isEmpty else { return false }
            pickReviewer(choices[min(reviewerIndex, choices.count - 1)])
        case .escape: dismissedReviewList = "models"
        case .up: reviewerIndex = max(0, min(reviewerIndex, choices.count - 1) - 1)
        case .down: reviewerIndex = min(choices.count - 1, reviewerIndex + 1)
        }
        return true
    }

    /// "/loop "'s "How often", until one is picked or typed.
    private var loopChoices: [LoopChoice]? {
        guard !dismissedLoop, !customLoop, historyIndex == nil, let (keyword, rest) = typedKeyword, keyword == .loop,
              rest.first?.isWhitespace == true, LoopCommand(rest).schedule == nil else { return nil }
        return LoopChoice.matches(rest)
    }

    /// Picked from "How often": its words written after "/loop ", or Custom…'s row in its place.
    private func pickLoop(_ choice: LoopChoice) {
        loopIndex = 0
        switch choice {
        case .preset(let schedule):
            customLoop = false
            text = Keyword.loop.typed + " " + schedule.phrase + " "
            focusAtEnd()
        case .custom:
            customLoop = true
        }
    }

    /// "How often"'s keys while it's open: ↑ ↓ choose, Return and Tab pick, Escape closes it.
    private func loopKey(_ key: MessageField.Key, _ choices: [LoopChoice]) -> Bool {
        switch key.name {
        case .return, .tab:
            guard key.modifiers.isEmpty else { return false }
            pickLoop(choices[min(loopIndex, choices.count - 1)])
        case .escape: dismissedLoop = true
        case .up: loopIndex = max(0, min(loopIndex, choices.count - 1) - 1)
        case .down: loopIndex = min(choices.count - 1, loopIndex + 1)
        }
        return true
    }

    /// The "@" being typed and the files it matches, while its list is open.
    private var mention: (query: String, matches: [ProjectFiles.File])? {
        guard !folders.isEmpty, !isShell, let (query, start) = Mentions.query(in: text),
              text.distance(from: text.startIndex, to: start) != dismissedMention else { return nil }
        let matches = Mentions.matches(query, in: mentionFilesFolders == folders ? mentionFiles : [])
        return matches.isEmpty ? nil : (query, matches)
    }

    /// Reads the project's files on the first "@", and again when the list is a while old.
    private func mentionTyped(in text: String) {
        guard !folders.isEmpty, Mentions.query(in: text) != nil else {
            mentionIndex = 0
            dismissedMention = nil
            return
        }
        guard mentionFilesRead.map({ Date().timeIntervalSince($0) > 30 }) ?? true else { return }
        mentionFilesRead = Date()
        let folders = folders
        let roots = folders.map(RemoteFolder.url)
        Task {
            let files = await Task.detached { ProjectFiles.mentionable(roots) }.value
            mentionFiles = files
            mentionFilesFolders = folders
        }
    }

    private func insertMention(_ file: ProjectFiles.File) {
        text = Mentions.insert(file, into: text)
        mentionIndex = 0
    }

    /// ↑ from an empty field, or from a recalled message left as it was, goes back a message;
    /// ↓ comes forward, and past the newest clears the field again.
    private func recall(_ step: Int) -> Bool {
        let history = history()
        guard !history.isEmpty else { return false }
        guard let index = historyIndex else {
            guard step < 0, text.isEmpty, files.isEmpty else { return false }
            historyIndex = history.count - 1
            text = history[history.count - 1]
            return true
        }
        let next = index + step
        if next < 0 { return true }
        if next >= history.count {
            historyIndex = nil
            text = ""
            return true
        }
        historyIndex = next
        text = history[next]
        return true
    }

    /// Adds files to the message, and gives the names of the pictures among them ("[Image 2]"),
    /// to write where you're writing.
    private func attach(_ urls: [URL]) -> [String] {
        var names: [String] = []
        for url in urls where !files.contains(url) {
            files.append(url)
            if AttachmentItem.local(url).isImage { names.append(ImageReferences.name(imageFiles.count)) }
        }
        return names
    }

    /// Files dropped on the composer or chosen: attached, the pictures' names written in the message.
    private func attachAndName(_ urls: [URL]) {
        let names = attach(urls)
        if !names.isEmpty, !isShell { field.write(names.joined(separator: " "), into: $text) }
    }

    /// Takes a file off the message, and a picture's name with it.
    private func detach(_ url: URL) {
        ImageReferences.detach(url, files: &files, text: &text, quotes: &quotes.wrappedValue) { AttachmentItem.local($0).isImage }
    }

    /// The pictures attached, in order: the first is "[Image 1]".
    private var imageFiles: [URL] { files.filter { AttachmentItem.local($0).isImage } }

    /// ⌘V in the field or an answer: files and pictures on the pasteboard are attached, and the
    /// pictures' names written there (not in a "!" command, which is the shell's).
    private func pasteAttachments(from board: NSPasteboard) -> [String]? {
        guard let urls = Self.pastedFiles(from: board) else { return nil }
        let names = attach(urls)
        return isShell ? [] : names
    }

    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Attach"
        panel.message = "Choose files or folders to attach."
        guard panel.runModal() == .OK else { return }
        attachAndName(panel.urls)
    }
}

/// A composer's round button, a session's or a group chat's: Send, or Stop while it works and
/// nothing's written, the one turning into the other. `menu`, on a right-click of Send.
struct SendStopButton<Menu: View>: View {
    let stops: Bool
    let canSend: Bool
    let sendHelp: String
    let stopHelp: String
    let send: () -> Void
    let stop: () -> Void
    @ViewBuilder var menu: Menu
    @Namespace private var glass

    var body: some View {
        GlassEffectContainer {
            if stops && !canSend {
                Button(action: stop) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12, weight: .bold))
                }
                .buttonStyle(ActionButtonStyle(isAccent: false))
                .glassEffect(.regular, in: .circle)
                .glassEffectID("action", in: glass)
                .help(stopHelp)
                .accessibilityLabel("Stop")
                .accessibilityIdentifier("stop")
            } else {
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .bold))
                }
                .buttonStyle(ActionButtonStyle())
                .glassEffect(.regular, in: .circle)
                .disabled(!canSend)
                .glassEffectID("action", in: glass)
                .help(sendHelp)
                .accessibilityLabel("Send")
                .accessibilityIdentifier("send")
                .contextMenu { menu }
            }
        }
        .animation(.ui, value: stops && !canSend)
        .animation(.easeOut(duration: 0.15), value: canSend)
    }
}

extension SendStopButton where Menu == EmptyView {
    init(stops: Bool, canSend: Bool, sendHelp: String, stopHelp: String, send: @escaping () -> Void, stop: @escaping () -> Void) {
        self.init(stops: stops, canSend: canSend, sendHelp: sendHelp, stopHelp: stopHelp, send: send, stop: stop) { EmptyView() }
    }
}

/// The composer's round button, on glass: Send in accent glass while there's something to
/// send, so the main action stands apart from the flat pills beside it; with nothing to send,
/// plain glass and a faint arrow. Stop stays neutral. Under the pointer its fill deepens; it
/// never grows or moves.
/// The composer's box. Quiet, so the message draws the eye and not the box: a step off the card,
/// opaque since messages scroll under it, a lit top edge, no outline, and only a tiny lift.
struct ComposerSurface: ViewModifier {
    /// Off for content in a card that has it already.
    var isOn = true
    @Environment(\.colorScheme) private var scheme
    @Environment(\.cardIsFocused) private var cardIsFocused

    func body(content: Content) -> some View {
        if isOn { surfaced(content) } else { content }
    }

    private func surfaced(_ content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: Metrics.composerRadius)
                    .fill(Surface.cardFill(scheme, focused: cardIsFocused))
                    .overlay(RoundedRectangle(cornerRadius: Metrics.composerRadius).fill(scheme == .dark ? Color.white.opacity(0.035) : Surface.slate.opacity(0.02)))
                    .shadow(color: scheme == .dark ? .black.opacity(0.25) : .black.opacity(0.07), radius: scheme == .dark ? 3 : 8, y: scheme == .dark ? 1 : 2)
            }
            .specularRim(RoundedRectangle(cornerRadius: Metrics.composerRadius))
            // On a white card, a crisper edge than the rim's hairline, so it floats instead of
            // reading as a flat gray patch.
            .overlay {
                if scheme == .light {
                    RoundedRectangle(cornerRadius: Metrics.composerRadius)
                        .strokeBorder(.black.opacity(0.1), lineWidth: 1)
                        .allowsHitTesting(false)
                }
            }
    }
}

extension View {
    /// What's over a conversation's end (the composer and the cards over it): the conversation
    /// scrolls on under it, out of sight there in the card's own color, and fades out just above
    /// it (`ConversationEndFade`, which `ConversationScroll` draws under its scroll-to-end button).
    /// An inset rather than a bar: a bar gets AppKit's scroll edge effect, which replays the
    /// window's background, not the card's, and drew a lighter band with a line across the card.
    func conversationBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        scrollEdgeEffectHidden(true, for: .bottom)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                bar()
                    .frame(maxWidth: .infinity)
                    .background { ConversationEndFade.Fill() }
            }
    }
}

/// The conversation fading out into the card's color above what's over its end, eased so no
/// edge shows, over the room under the last message (so nothing is faded at the end).
struct ConversationEndFade: View {
    static let height: CGFloat = 32

    var body: some View {
        Fill()
            .mask { LinearGradient(stops: Surface.easedFade(.black), startPoint: .top, endPoint: .bottom) }
            .frame(height: Self.height)
    }

    /// The card's color, under what's over the conversation's end.
    struct Fill: View {
        @Environment(\.colorScheme) private var scheme
        @Environment(\.cardIsFocused) private var cardIsFocused

        var body: some View {
            Surface.cardFill(scheme, focused: cardIsFocused)
                .animation(.ui, value: cardIsFocused)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}

/// The round send (or stop) button.
struct ActionButtonStyle: ButtonStyle {
    var isAccent = true

    func makeBody(configuration: Configuration) -> some View {
        ActionButton(configuration: configuration, isAccent: isAccent)
    }

    private struct ActionButton: View {
        let configuration: ButtonStyleConfiguration
        let isAccent: Bool
        @State private var isHovering = false
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            let isLit = isAccent && isEnabled
            configuration.label
                .foregroundStyle(isLit ? AnyShapeStyle(.tint) : isEnabled ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
                .frame(width: 32, height: 32)
                .background(fill, in: .circle)
                .accentGlass(Circle(), isOn: isLit)
                .contentShape(.circle)
                .onHover { isHovering = $0 }
                .animation(.easeOut(duration: 0.12), value: isHovering)
        }

        private var fill: AnyShapeStyle {
            guard isEnabled else { return AnyShapeStyle(.clear) }
            if !isAccent {
                if configuration.isPressed { return AnyShapeStyle(Pressable.pressedFill) }
                return AnyShapeStyle(isHovering ? Pressable.hoverFill : .clear)
            }
            if configuration.isPressed { return AnyShapeStyle(.tint.opacity(0.13)) }
            return isHovering ? AnyShapeStyle(.tint.opacity(0.08)) : AnyShapeStyle(.clear)
        }
    }
}

/// The files an "@" matches, above the message field: the chosen one highlighted, any
/// one a click away.
private struct MentionList: View {
    let files: [ProjectFiles.File]
    let selected: Int
    let choose: (ProjectFiles.File) -> Void

    var body: some View {
        VStack(spacing: 1) {
            ForEach(Array(files.enumerated()), id: \.element.id) { index, file in
                Button { choose(file) } label: {
                    HStack(spacing: 8) {
                        Image(nsImage: NSWorkspace.shared.icon(of: file.url))
                            .resizable()
                            .frame(width: 16, height: 16)
                        Text(file.isFolder ? String(file.path.dropLast()) : file.name)
                            .font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                        let folder = (file.path as NSString).deletingLastPathComponent
                        if !file.isFolder, !folder.isEmpty {
                            Text(folder)
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 28)
                }
                .buttonStyle(ListRowButtonStyle(isSelected: index == selected))
            }
        }
        .padding(.leading, -8)
        .help("↑ ↓ to choose, Return or Tab to insert, Escape to close")
    }
}

extension Composer {
    /// What ⌘V attaches rather than pastes into the message: files copied in the Finder, or a
    /// picture without text (a copied screenshot, an image copied from Preview). Nil for text.
    static func pastedFiles(from board: NSPasteboard) -> [URL]? {
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return urls
        }
        guard board.string(forType: .string) == nil, let image = NSImage(pasteboard: board) else { return nil }
        return Attachments.save(image, named: Attachments.pastedImageName).map { [$0] }
    }
}

/// In place of the composer's chips while a "!" command is typed: what it is, and where it runs.
private struct ShellModeLabel: View {
    let folder: String?

    private var place: String {
        guard let folder else { return "in the project’s folder" }
        if let machine = RemoteFolder.machine(of: folder) { return "on \(machine)" }
        return "in \((folder as NSString).lastPathComponent)"
    }

    var body: some View {
        HStack(spacing: 6) {
            Text("Shell")
                .fontWeight(.medium)
                .foregroundStyle(.tint)
            Text("runs \(place)")
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .font(.system(size: 13))
        // Lined up with the message field, as the chips are.
        .padding(.leading, 8)
        .frame(height: 28)
        .help("Runs the command in the project’s folder, without the agent. It and its output join the conversation, and the agent sees them with your next message. Delete the ! to talk to the agent again.")
    }
}

extension EnvironmentValues {
    /// Called when the composer, or an answer to a quote in it, takes the keyboard.
    @Entry var composerFocused: (() -> Void)? = nil
}

/// "Side question ×" over the composer's field while a side thread shows: what's sent goes there.
private struct SideQuestionTag: View {
    let close: () -> Void

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: Keyword.btw.symbol)
                .font(.system(size: 10.5, weight: .semibold))
                .accessibilityHidden(true)
            Text("Side question")
                .font(.system(size: 12, weight: .medium))
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .frame(width: 16, height: 16)
                    .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .clickablePointer()
            .hoverHighlight(in: Circle())
            .help("Message the conversation instead")
            .accessibilityLabel("Message the Conversation Instead")
        }
        .foregroundStyle(.tint)
        .padding(.leading, 9)
        .padding(.trailing, 3)
        .padding(.vertical, 3)
        .background(.tint.opacity(0.12), in: .capsule)
        .help("Asks on the side: answered from the conversation, changing nothing")
    }
}

/// The files going with a message, in a row that scrolls sideways. A chip past the edge fades
/// there, rather than showing as a cut sliver, and "+3" says how many are past it: clicking it
/// brings the next one in.
private struct AttachmentStrip<Chip: View>: View {
    let files: [URL]
    @ViewBuilder let chip: (URL) -> Chip
    /// The chips not wholly in view past the trailing edge. Each says when it crosses the edge,
    /// not where it is on every frame of a scroll.
    @State private var past: Set<URL> = []
    /// More chips than fit: the count keeps its room then, so the strip doesn't widen and slide
    /// the chips over as the last one comes into view.
    @State private var overflows = false
    @State private var position = ScrollPosition(idType: URL.self)

    var body: some View {
        let next = files.first(where: past.contains)
        // The count beside the row, not over it: the chips' names never run under it.
        HStack(spacing: 6) {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(files, id: \.self) { file in
                        chip(file)
                            .onGeometryChange(for: Bool.self, of: { $0.frame(in: .scrollView).maxX > ($0.bounds(of: .scrollView)?.width ?? .infinity) + 1 }) { isPast in
                                if isPast { past.insert(file) } else { past.remove(file) }
                            }
                    }
                }
                .scrollTargetLayout()
                // Room for each chip's remove button, which sits on its corner, and for the
                // hairline around each chip.
                .padding(.top, 6)
                .padding(.trailing, 6)
                .padding(.leading, 1)
                .padding(.bottom, 1)
            }
            .scrollPosition($position)
            .scrollIndicators(.hidden)
            .onScrollGeometryChange(for: Bool.self, of: { $0.contentSize.width > $0.containerSize.width + 1 }) { _, new in overflows = new }
            .fadingScrollEdges(24, axis: .horizontal)
            if overflows {
                Button { if let next { withAnimation(.ui) { position.scrollTo(id: next, anchor: .trailing) } } } label: {
                    Text("+\(max(past.count, 1))")
                        .font(.system(size: 12, weight: .semibold))
                        .monospacedDigit()
                        .padding(.horizontal, 9)
                        .frame(height: 24)
                }
                .buttonStyle(FilledButtonStyle(shape: .capsule, rest: 0.06))
                .fixedSize()
                .padding(.top, 6)
                .help(past.count == 1 ? "One more file" : "\(past.count) more files")
                .accessibilityLabel(past.count == 1 ? "One more file" : "\(past.count) more files")
                // At the end, it fades where it is: the strip keeps its width.
                .opacity(next == nil ? 0 : 1)
                .disabled(next == nil)
                .accessibilityHidden(next == nil)
                .transition(.opacity)
            }
        }
        .animation(.ui, value: next == nil)
        .animation(.ui, value: overflows)
        .onChange(of: files) { past.formIntersection(files) }
    }
}
