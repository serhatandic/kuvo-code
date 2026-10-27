import ClientDesign
import ClientText
import OpenCodeKit
import SwiftUI
import UniformTypeIdentifiers

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
    /// The mode and approval chip: hidden where they're not yours to pick (a subagent's are its
    /// agent's).
    var showsMode = true
    /// The models its picker offers, when they aren't the session's (a subagent's: the engine's).
    var scope: ModelScope?
    /// Takes the keyboard as it shows; a subagent's beside the conversation leaves it there.
    var focusesOnAppear = true
    /// What the empty field says, when it isn't the usual.
    var prompt: String?
    /// Its own card; off in the card it shares with the bars and the queue over it (the session's).
    var drawsSurface = true

    @Environment(Catalog.self) private var catalog
    @Environment(Workspace.self) private var workspace
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
    /// "/review"'s "Who reads it" was closed with Escape, or answered with the conversation's own.
    @State private var dismissedReviewer = false
    /// The model picked last there (`Model.key`), offered first next time.
    @AppStorage(Catalog.lastReviewerKey) private var lastReviewer = ""
    /// Your starred models (the model picker's), offered there after it.
    @AppStorage("favoriteModels") private var starredModels = ""
    /// "&" and the bots and sessions it names.
    @State private var agents = AgentPicker()

    private var canSend: Bool {
        if isOffline { return false }
        if isShell { return SessionModel.shellCommand(in: text) != nil }
        let answered = quotes.wrappedValue.contains { !$0.response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || answered || !files.isEmpty || commentCount > 0
    }

    /// "!" first: the message is a command to run in the project's folder, not words for the agent.
    private var isShell: Bool { text.hasPrefix("!") }
    private var currentModel: Model? { catalog.model(model) ?? catalog.defaultModel }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let commandMatches {
                SlashList(items: commandMatches, selected: min(commandIndex, commandMatches.count - 1), project: folders.first.flatMap { Workspace.isChat($0) ? nil : workspace.projectName($0) }) { pick($0) }
                    .preference(key: ComposerListShown.self, value: true)
            } else if customLoop, typedKeyword?.keyword == .loop {
                CustomLoopRow(use: { pickLoop(.preset($0)) }, cancel: {
                    customLoop = false
                    focusAtEnd()
                })
                .preference(key: ComposerListShown.self, value: true)
            } else if let loopChoices {
                LoopList(choices: loopChoices, selected: min(loopIndex, loopChoices.count - 1)) { pickLoop($0) }
                    .preference(key: ComposerListShown.self, value: true)
            } else if let reviewerChoices {
                ReviewerList(choices: reviewerChoices, selected: min(reviewerIndex, reviewerChoices.count - 1)) { pickReviewer($0) }
                    .preference(key: ComposerListShown.self, value: true)
            } else if let mention {
                MentionList(files: mention.matches, selected: min(mentionIndex, max(mention.matches.count - 1, 0))) { insertMention($0) }
                    .preference(key: ComposerListShown.self, value: true)
            } else if let named = agents.matches(in: text, excluding: session) {
                AgentReferenceList(agents: named, selected: min(agents.selected, named.count - 1)) { agents.insert($0, into: $text) }
                    .preference(key: ComposerListShown.self, value: true)
            }
            if commentCount > 0 {
                Menu {
                    Button("Discard Comments", role: .destructive, action: onDiscardComments)
                } label: {
                    Label(commentCount.counting("comment"), systemImage: "text.bubble")
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
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(files, id: \.self) { file in
                            ComposerAttachment(url: file, route: Attachments.route(file, for: currentModel),
                                               number: imageFiles.firstIndex(of: file).map { $0 + 1 }) { detach(file) }
                        }
                    }
                    // Room for each chip's remove button, which sits on its corner, and for
                    // the hairline around each chip.
                    .padding(.top, 6)
                    .padding(.trailing, 6)
                    .padding(.leading, 1)
                    .padding(.bottom, 1)
                }
                .scrollIndicators(.hidden)
            }

            // Each quote with your answer to it, in the order they go.
            if !quotes.wrappedValue.isEmpty {
                QuoteList(quotes: quotes, focus: answerFocus, blur: blurRequest, font: messageFont.field, images: imageFiles.count,
                          onKey: answerKey, onFocus: { id, focused in
                              if focused, answerFocus?.id == id { answerFocus = nil }
                              fieldFocused(focused)
                          }, onPaste: pasteAttachments)
            }
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
                handle: field
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
                }
                // Not /review any more, or "with" written after it: "Who reads it" can open again.
                if !new.hasPrefix(Keyword.review.typed) || new.lowercased().hasPrefix(Keyword.review.typed + " with") {
                    reviewerIndex = 0
                    dismissedReviewer = false
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
            if keywordHint != nil {
                // Read again each minute: /loop's says when it first sends.
                TimelineView(.everyMinute) { _ in
                    if let keywordHint { KeywordHint(text: keywordHint.text, isProblem: keywordHint.isProblem) }
                }
            }

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
                        .help("Attach Files… You can also drop files here, or paste them.")
                        // Set on the engine: not while it's out of reach.
                        if showsMode {
                            ModeChip(agent: agent, approval: approval, onSelectAgent: onSelectAgent, onSelectApproval: onSelectApproval)
                                .disabled(isOffline)
                        }
                        ModelChip(selection: model, onSelect: onSelectModel, scope: modelScope, inUse: modelInUse)
                            .disabled(isOffline)
                        if let worktree {
                            WorkplaceChip(worktree: worktree, attempts: attempts, onSelect: onSelectWorktree, onSelectAttempts: onSelectAttempts)
                        }
                    }
                    .transition(.opacity)
                }
                Spacer(minLength: 0)
                actionButton
            }
            .animation(.easeOut(duration: 0.15), value: isShell)
            // The pills are flat, so their text lines up with the message field above;
            // their hover fill reaches past it.
            .padding(.leading, -8)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 7)
        .modifier(ComposerSurface(isOn: drawsSurface))
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
        .onChange(of: session) {
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
            dismissedReviewer = false
            isTargeted = false
            // The keyboard goes to this session's message, not a quote it was answering before.
            answerFocus = nil
            // Undoing typing here brings back nothing from the session it was writing to before.
            field.forgetUndo()
            focusAtEnd()
        }
        .onAppear {
            if focusesOnAppear { focusAtEnd() }
            #if DEBUG
            // KUVO_DEMO_COMPOSER_FILES: comma-separated paths to show as attached.
            if files.isEmpty, let list = ProcessInfo.processInfo.environment["KUVO_DEMO_COMPOSER_FILES"] {
                files = list.split(separator: ",").map { URL(filePath: String($0)) }
            }
            #endif
        }
    }

    /// Puts the cursor in the field, after what's there.
    private func focusAtEnd() {
        fieldFocus = MessageField.FocusRequest()
    }

    /// The field or an answer took the keyboard, or let it go: where you type is where you work,
    /// so the window's commands follow.
    private func fieldFocused(_ focused: Bool) {
        if focused { composerFocused?() }
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
        if agents.key(key, text: $text, excluding: session) { return true }
        if let loopChoices, loopKey(key, loopChoices) { return true }
        if let reviewerChoices, reviewerKey(key, reviewerChoices) { return true }
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
        if isRunning { return "Add to the task, or ⌘↩ to queue a follow-up…" }
        if let bot { return bot.job.isEmpty ? "Tell \(bot.name) its job…" : "Message \(bot.name)…" }
        if folders.first.map(Workspace.isChat) == true { return "Ask anything…" }
        return agent == "plan" ? "Ask the agent to plan something…" : "Ask the agent to build, fix or explain something…"
    }

    private var actionButton: some View {
        SendStopButton(
            stops: isRunning, canSend: canSend,
            sendHelp: isOffline ? "Send once the connection is back" : isShell ? "Run the Command (Return)" : isRunning ? "Send: the agent reads it at its next step (Return). ⌘Return queues it for after this run." : "Send (Return)",
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
        return MessageField.Token(length: keyword.typed.utf16.count + schedule, symbol: keyword.symbol, orange: keyword.isPlan)
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
            return command.reader != nil && command.focus.isEmpty ? "what to look at (or nothing)" : nil
        }
        return rest.allSatisfy(\.isWhitespace) ? keyword.argument : nil
    }

    /// Under the field while a keyword is typed: what it will do. /loop's reads its schedule back
    /// (or says it can't), /review's names who reads the changes.
    private var keywordHint: (text: String, isProblem: Bool)? {
        guard let (keyword, rest) = typedKeyword, commandMatches == nil else { return nil }
        switch keyword {
        case .loop:
            let command = LoopCommand(rest)
            guard let schedule = command.schedule else {
                if loopChoices != nil || customLoop { return ("Pick how often, then write what to do each time.", false) }
                return ("Can’t tell how often from that. Start with one like “every 30 min” or “weekdays at 9”.", true)
            }
            let place = folders.first.flatMap(RemoteFolder.machine(of:)).map { "on \($0), with this Mac closed too" } ?? "on this Mac, also with the window closed"
            // A wake-up sends words: what's attached goes with the first message, or stays.
            let attached = files.isEmpty ? "" : schedule.keepsTimeOfDay ? " · attachments stay here" : " · attachments go with the first one only"
            return ("\(schedule.title) · \(schedule.firstPhrase(now: .now)) · \(place)\(attached)", false)
        case .review:
            if reviewerChoices != nil { return ("Pick who reads the changes, then add what to look at if you like.", false) }
            let command = reviewCommand(rest)
            if let searching = command.searching {
                return (searching.isEmpty ? "Write a model’s name after “with”." : "Finish the model’s name, or pick it from the list.", false)
            }
            let reader = command.reader?.name ?? currentModel?.name ?? "The conversation’s model"
            let looking = command.focus.isEmpty ? "" : ", looking especially at what you wrote"
            return ("\(reader) reads the changes not committed yet with fresh eyes, without this conversation\(looking), and lists what it finds.", false)
        default:
            return (keyword.hint, false)
        }
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

    /// "/review "'s "Who reads it": before anything follows it, the conversation's own model, the
    /// one picked last, your starred ones and Other Model…; after "with ", the models whose names
    /// have what's typed.
    private var reviewerChoices: [ReviewerChoice]? {
        guard !dismissedReviewer, !isAgentConversation, historyIndex == nil, let (keyword, rest) = typedKeyword, keyword == .review,
              rest.first?.isWhitespace == true else { return nil }
        let readers = catalog.reviewReaders
        let command = reviewCommand(rest)
        if let reader = command.reader {
            // A name that starts longer ones ("GPT-5" of "GPT-5 Mini"), while it's being typed.
            let longer = command.focus.isEmpty ? ReviewCommand.longer(than: rest, readers: readers) : []
            return longer.isEmpty ? nil : ([reader] + longer.filter { $0 != reader }).prefix(6).map { .reader($0, note: $0.provider) }
        }
        if let searching = command.searching {
            let matches = ReviewCommand.search(searching, in: readers).prefix(6)
            return matches.isEmpty ? nil : matches.map { .reader($0, note: $0.provider) }
        }
        guard rest.allSatisfy(\.isWhitespace) else { return nil }
        let own = currentModel?.key
        let last = readers.first { $0.ref.providerID + "/" + $0.ref.id == lastReviewer && $0.ref.providerID + "/" + $0.ref.id != own }
        let starred = starredModels.split(separator: ",").map(String.init).compactMap { key in
            readers.first { $0.ref.providerID + "/" + $0.ref.id == key && key != own && key != lastReviewer }
        }
        return [.same(currentModel?.name)] + (last.map { [.reader($0, note: "picked last time")] } ?? [])
            + starred.prefix(last == nil ? 3 : 2).map { .reader($0, note: $0.provider) } + [.other]
    }

    /// Picked from "Who reads it": its name written after "/review with ", or "with " to look
    /// for one; the conversation's own model starts it, as Return did before there was a list.
    private func pickReviewer(_ choice: ReviewerChoice) {
        reviewerIndex = 0
        switch choice {
        case .same:
            dismissedReviewer = true
            text = Keyword.review.typed
            onSend()
            return
        case .reader(let reader, _):
            lastReviewer = reader.ref.providerID + "/" + reader.ref.id
            text = Keyword.review.typed + " " + ReviewCommand.phrase(reader) + " "
        case .other:
            text = Keyword.review.typed + " with "
        }
        focusAtEnd()
    }

    /// "Who reads it"'s keys while it's open: ↑ ↓ choose, Return and Tab pick, Escape closes it.
    private func reviewerKey(_ key: MessageField.Key, _ choices: [ReviewerChoice]) -> Bool {
        switch key.name {
        case .return, .tab:
            guard key.modifiers.isEmpty else { return false }
            pickReviewer(choices[min(reviewerIndex, choices.count - 1)])
        case .escape: dismissedReviewer = true
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
/// A list open over a composer ("/", "@" or "&"): the conversation's edge under the composer
/// isn't blurred meanwhile, as, made as tall as the list, it showed as a block across the card.
struct ComposerListShown: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

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
            Image(systemName: "terminal")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.tint)
            Text("Shell")
                .fontWeight(.medium)
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
