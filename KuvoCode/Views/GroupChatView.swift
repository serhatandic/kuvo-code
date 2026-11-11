import ClientDesign
import ClientText
import ClientVault
import OpenCodeKit
import SwiftUI

/// A group chat: what you and its bots said, the one talking now, and where you write. The
/// bots answer one at a time; you can write any time, and the one talking hears it at once.
struct GroupChatView: View {
    let group: BotGroup
    /// Goes up to open the find bar (⌘F).
    var findRequest = 0
    /// Goes up to put the cursor in its composer.
    var focusRequest = 0
    @Environment(GroupChats.self) private var groups
    @Environment(Bots.self) private var bots
    @Environment(AppModel.self) private var app
    @Environment(\.isKeptOutOfSight) private var isKept
    @State private var scroller = ConversationScroller()
    /// Goes up to have the composer take the keyboard.
    @State private var composerFocus = 0
    /// The quote whose answer takes the keyboard: the one just added, or quoted again.
    @State private var quoteFocus: Drafts.QuoteFocus?
    /// Find in the chat (⌘F).
    @State private var find = ConversationFind()
    /// The chat's height, and what's over its end, and the "&" list in it, as shown: the list has
    /// what the conversation leaves (`ComposerListRoom`).
    @State private var height: CGFloat = .infinity
    @State private var stackHeight: CGFloat = 0
    @State private var listShown: CGFloat = 0

    private var members: [Bot] { group.members.compactMap { bots.bot($0) } }
    private var draftKey: String { BotGroups.tabKey(group.id) }
    /// The computer it lives on, as its box is named.
    private var box: String { groups.machine(of: group.id) ?? BoxClient.mac }
    /// Where its bots take their seats: where it lives, and each one's own computer.
    private var seatBoxes: [String] { Array(Set([box] + members.map(\.box))).sorted() }
    /// What those seats ask of the vault now, to animate its cards by.
    private var seatAsks: [String] { seatBoxes.flatMap { Vaults.shared[$0].asks.filter { $0.group == group.id }.map(\.id) } }

    /// What a bot made, drawn after its words rather than listed among its steps. A widget it
    /// couldn't make is a step that says so, as in a session.
    static func isDrawn(_ call: Message.ToolCall) -> Bool {
        (WidgetCard.isWidget(call) && !call.state.isFailure) || MadePictureRow.isMade(call)
    }

    var body: some View {
        let messages = groups.messages(in: group.id)
        let speaker = groups.speaker(in: group.id).flatMap { bots.bot($0) }
        // Where it lives can't be reached now: what needs it (undo, the work, Keep Going) waits.
        let reachable = groups.reach(group.id) == .ready
        // What you select, to reply to (over the composer) or copy.
        ConversationScroll(scroller: scroller, spacing: 18, change: [messages.last?.id, speaker?.id, String(messages.count)], quote: { text in
            addQuote(text, how: "selection")
        }) {
            // Laid out by a stack of their own, as a session's rows are (see `RowStack`).
            RowStack(items: messages, id: \.id, spacing: 18, same: ==, estimate: { 70 + CGFloat($0.text.count / 95) * 24 },
                     text: { FindText.shown(markdown: $0.text, folders: []) }) { message, _ in
                GroupMessageRow(message: message, author: message.author.flatMap { bots.bot($0) }, members: members,
                                reply: { reply(to: message) }, undo: { undo(from: message) },
                                startWork: reachable && message.tasks?.contains { $0.state == .proposed } == true ? { groups.startWork(message.id, in: group.id) } : nil,
                                stopped: message.tasks?.contains { $0.state == .working } == true ? groups.stopped(in: group.id) : [],
                                isOffline: !reachable)
                    .equatable()
                    .environment(\.findHighlight, find.highlight(for: message.id))
            }
            if let speaker {
                TypingRow(bot: speaker, activity: groups.activity(in: group.id))
                    .id("typing")
                    .transition(.opacity)
            }
        }
        .conversationFind(find, scroller: scroller, version: [messages.last?.id, String(messages.count)]) {
            groups.messages(in: group.id).map { ConversationFind.Row(id: $0.id, parts: Self.findParts($0)) }
        }
        .onChange(of: findRequest) { find.open() }
        .onChange(of: focusRequest) { composerFocus += 1 }
        // What a bot's widget writes back goes to the group, as yours.
        .environment(\.answerAgent) { text in groups.send(text, to: group.id) }
        .overlay {
            if messages.isEmpty && speaker == nil {
                GroupIntro(group: group, members: members)
            }
        }
        .conversationBar {
            VStack(spacing: 10) {
                // Its move waiting for a computer that went quiet: that says it all, with nothing to
                // connect, since the two computers move it between themselves.
                let waiting = app.moves.underWay[group.id].flatMap { $0.waitingFor == nil ? nil : $0 }
                if let waiting {
                    MoveWaitingCard(going: waiting)
                        .modifier(ComposerSurface())
                        .transition(.opacity.combined(with: .offset(y: 6)))
                }
                // Where it lives can't be reached now: as last seen, and what you write waits.
                switch groups.reach(group.id) {
                case .away(let machine):
                    if waiting == nil, let engine = app.machines.engine(machine) {
                        MachineOfflineBar(engine: engine)
                            .modifier(ComposerSurface())
                            .transition(.opacity.combined(with: .offset(y: 6)))
                    }
                case .starting, .stopped:
                    MacGroupsBar()
                        .modifier(ComposerSurface())
                        .transition(.opacity.combined(with: .offset(y: 6)))
                case .ready:
                    EmptyView()
                }
                // Once the wrap-up after the limit is done: Keep Going does nothing before.
                if reachable && groups.isPaused(group.id) && !groups.isDiscussing(group.id) {
                    PausedBar { groups.keepGoing(group.id) }
                        .transition(.opacity.combined(with: .offset(y: 6)))
                }
                // What its bots' seats ask of their computers' vaults: no one opens a seat, so here.
                ForEach(seatBoxes, id: \.self) { VaultAskCards(group: group.id, box: $0) }
                GroupComposer(
                    text: Binding(get: { Drafts.shared[draftKey].text }, set: { Drafts.shared[draftKey].text = $0 }),
                    quotes: Binding(get: { Drafts.shared[draftKey].quotes }, set: { Drafts.shared[draftKey].quotes = $0 }),
                    quoteFocus: quoteFocus,
                    placeholder: "Message \(group.name)…",
                    members: members,
                    machine: groups.machine(of: group.id),
                    isTalking: groups.isDiscussing(group.id),
                    focusRequest: composerFocus,
                    send: send,
                    stop: { groups.stop(group.id) },
                    listRoom: ComposerListRoom.height(room: height - BottomStack.conversationRoom, card: stackHeight, list: listShown, bars: 0, barsKept: 0),
                    listHeight: $listShown
                )
            }
            .animation(.ui, value: groups.isPaused(group.id))
            .animation(.ui, value: groups.reach(group.id))
            .animation(.ui, value: app.moves.underWay[group.id]?.waitingFor)
            .animation(.ui, value: seatAsks)
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, 16)
            .readableColumn()
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { stackHeight = $0 }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        // Seen only while you're here, as a session is: what's said while you're in another app
        // waits for you (its notifications too), and counts as seen when you come back.
        // Its seats' asks of those vaults, followed while it's open (VaultAskCards).
        .task(id: seatBoxes) {
            await withTaskGroup(of: Void.self) { following in
                for each in seatBoxes { following.addTask { await Vaults.shared.follow(each) } }
            }
        }
        // Not while it's kept out of sight under another conversation (one opened from it).
        .onAppear { if NSApp.isActive, !isKept { groups.markViewed(group.id) } }
        .onChange(of: messages.count) { if NSApp.isActive, !isKept { groups.markViewed(group.id) } }
        .onChange(of: isKept) { if NSApp.isActive, !isKept { groups.markViewed(group.id) } }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in if !isKept { groups.markViewed(group.id) } }
        // What's opened from it comes back to it.
        .environment(\.conversationTab, .group(group.id))
        // Its pictures, which each of them (and the composer's, after them) opens among.
        .environment(\.conversationPictures, ConversationPictureSet(group: group.id, groups: groups, bots: bots))
    }

    /// The words Find looks in, as the message shows them: yours, or a bot's reply.
    private static func findParts(_ message: GroupMessage) -> [ConversationFind.Part] {
        switch message.kind {
        case .meeting, .note: []
        default: message.author == nil ? UserBubble.findParts(WidgetAnswer.split(message.text).text).map(ConversationFind.Part.plain) : [.markdown(message.text)]
        }
    }

    /// Replies to a bot's message: all of it quoted in the composer, naming the bot so it's the
    /// one to answer.
    private func reply(to message: GroupMessage) {
        addQuote(message.text, how: "message")
        // Named, so it's the one to answer.
        if let name = message.author.flatMap({ bots.bot($0)?.name }), !Drafts.shared[draftKey].text.contains("&" + name) {
            let draft = Drafts.shared[draftKey].text.trimmingCharacters(in: .whitespacesAndNewlines)
            Drafts.shared[draftKey].text = "&\(name) " + draft
        }
    }

    /// A quote to answer, after those there are, as in a session; its answer takes the keyboard.
    private func addQuote(_ text: String, how: String) {
        let count = Drafts.shared[draftKey].quotes.count
        guard let id = Drafts.shared.addQuote(text, to: draftKey) else { return }
        quoteFocus = Drafts.QuoteFocus(id)
        if Drafts.shared[draftKey].quotes.count > count { Analytics.shared.track("message_replied", ["group": true, "how": how]) }
    }

    /// Takes the chat back to before your message, which comes back to the composer, ahead of
    /// anything already there.
    private func undo(from message: GroupMessage) {
        Task {
            guard let taken = await groups.undo(from: message.id, in: group.id) else { return }
            let (quotes, text) = Quoting.draft(of: WidgetAnswer.split(taken).text)
            let draft = Drafts.shared[draftKey].text
            Drafts.shared[draftKey].text = [text, draft].filter { !$0.isEmpty }.joined(separator: "\n\n")
            Drafts.shared[draftKey].quotes = quotes + Drafts.shared[draftKey].quotes
            composerFocus += 1
        }
    }

    private func send() {
        let draft = Drafts.shared[draftKey]
        let message = Quoting.message(quotes: draft.quotes, text: draft.text)
        // A quote you didn't answer goes only with words of yours.
        guard !Quoting.words(of: message).isEmpty else { return }
        // Where it lives can't be reached now, or it's moving: it waits in the composer.
        guard groups.send(message, to: group.id) else { return NSSound.beep() }
        Drafts.shared[draftKey].text = ""
        Drafts.shared[draftKey].quotes = []
        scroller.toEnd()
    }
}

/// A meeting you scheduled, come due: its topic, which the bots then talk through.
private struct MeetingRow: View {
    let topic: String
    let at: Date

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "calendar")
                .foregroundStyle(.tint)
                .frame(width: 16)
            Text("\(Text("Meeting").fontWeight(.semibold).foregroundStyle(.primary))  \(Text(topic).foregroundStyle(.secondary))")
                .lineLimit(3)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            Text(at, format: .dateTime.hour().minute())
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .recessedWell(RoundedRectangle(cornerRadius: 10))
        .help("A meeting you scheduled for this chat")
    }
}

/// One message: yours in a bubble on the right, a bot's beside its face, Kuvo Code's own
/// quietly in the middle.
/// Equal when what it shows is (its actions are the chat's own), so a new message draws only
/// itself.
private struct GroupMessageRow: View, Equatable {
    static func == (lhs: GroupMessageRow, rhs: GroupMessageRow) -> Bool {
        lhs.message == rhs.message && lhs.author == rhs.author && lhs.members == rhs.members && (lhs.reply == nil) == (rhs.reply == nil)
            && (lhs.startWork == nil) == (rhs.startWork == nil) && lhs.stopped == rhs.stopped && lhs.isOffline == rhs.isOffline
    }

    let message: GroupMessage
    let author: Bot?
    /// The chat's bots, for their mentions.
    let members: [Bot]
    /// Quotes this bot's message (or the part you selected) in the composer.
    var reply: (() -> Void)?
    /// Takes the chat back to before this message of yours.
    let undo: () -> Void
    /// On a wrap-up whose work waits for you: hands each part to its bot.
    var startWork: (() -> Void)?
    /// The bots whose part waits on their conversation, stopped by you.
    var stopped: Set<String> = []
    /// Where the chat lives can't be reached now: undoing waits.
    var isOffline = false
    @State private var hovering = false
    @State private var confirmsUndo = false
    @Environment(\.answerAgent) private var answerAgent
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here

    /// Under the pointer; KUVO_DEMO_SHOW_HOVER shows every message's buttons, for screenshots.
    private var isHovering: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.environment["KUVO_DEMO_SHOW_HOVER"] != nil { return true }
        #endif
        return hovering
    }

    var body: some View {
        if message.kind == .meeting {
            MeetingRow(topic: message.text, at: message.time)
        } else if message.kind == .note {
            Label(message.text, systemImage: "info.circle")
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
        } else if message.author == nil {
            let (text, widget) = WidgetAnswer.split(message.text)
            YourMessage(text: text, references: MessageMentions.agents(namedIn: text).map(\.reference), widget: widget,
                        sent: message.time, undo: undo,
                        undoNote: "The chat goes back to before this message, and the message comes back to the composer. The bots are told to set aside what was taken back.",
                        isOffline: isOffline)
        } else {
            HStack(alignment: .top, spacing: 10) {
                if let author {
                    // Still: the bot moves in its row, or where it's typing. A click opens its
                    // conversation, as its name does.
                    Button { app.open(.session(author.sessionID), from: here) } label: {
                        BotAvatar(look: author.look, size: 28, noticed: isHovering, animates: false)
                    }
                    .buttonStyle(.plain)
                    .clickablePointer()
                    .help("Open \(author.name)’s Conversation")
                    // Its name beside it opens the same, and says so.
                    .accessibilityHidden(true)
                } else {
                    Image(systemName: "person.crop.circle.badge.questionmark")
                        .font(.system(size: 22))
                        .foregroundStyle(.tertiary)
                        .frame(width: 28, height: 28)
                }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        if let author {
                            Button(author.name) { app.open(.session(author.sessionID), from: here) }
                                .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                                .font(.callout.weight(.semibold))
                                .help("Open \(author.name)’s Conversation")
                        } else {
                            Text("A bot that left")
                                .font(.callout.weight(.semibold))
                        }
                        if message.kind == .wrapUp {
                            Label("Wrap-Up", systemImage: "checklist")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 2)
                                .recessedWell(Capsule())
                        } else if message.report != nil {
                            Label("Report", systemImage: "checkmark.circle")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 2)
                                .recessedWell(Capsule())
                                .help("What \(author?.name ?? "the bot") did on its part, in its own conversation")
                        }
                        Text(SentTime.short(message.time))
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .help(SentTime.full(message.time))
                        // Shown under the pointer, always laid out.
                        HStack(spacing: 0) {
                            CopyButton(text: message.text, help: "Copy")
                            if let reply {
                                MessageActionButton(symbol: "arrowshape.turn.up.left", help: "Reply: quotes the part you selected (or the whole message), naming \(author?.name ?? "the bot")", action: reply)
                            }
                        }
                        .opacity(isHovering ? 1 : 0)
                        .animation(.easeOut(duration: 0.12), value: isHovering)
                    }
                    .frame(height: 20)
                    // As a session shows them, at the detail you chose for steps; what it made, after
                    // its words.
                    let steps = (message.steps ?? []).filter { !GroupChatView.isDrawn($0) }
                    if !steps.isEmpty {
                        StepsRow(scope: message.id, blocks: steps.map(Message.Content.tool), keys: steps.map(\.id), isLive: false, directory: author?.directory ?? "")
                            .padding(.bottom, 2)
                    }
                    MarkdownText(text: message.text, agents: MarkdownText.agents(namedIn: message.text))
                    // Pictures one after another in one row, to look through together.
                    let drawn = (message.steps ?? []).filter(GroupChatView.isDrawn)
                    let pictures = MadePictureRow.groups(in: drawn.map(Message.Content.tool))
                    let grouped = Set(pictures.flatMap { start, calls in start..<(start + calls.count) })
                    ForEach(Array(drawn.enumerated()), id: \.element.id) { index, call in
                        if let calls = pictures[index] {
                            ShownPictures(calls: calls, directory: author?.directory)
                                .padding(.top, 6)
                        } else if !grouped.contains(index) {
                            Group {
                                if MadePictureRow.isMade(call) { MadePictureRow(call: call, directory: author?.directory) } else { WidgetCard(call: call, send: answerAgent) }
                            }
                            .padding(.top, 6)
                        }
                    }
                    if let tasks = message.tasks, !tasks.isEmpty {
                        WorkList(tasks: tasks, members: members, stopped: stopped, start: startWork)
                    }
                }
            }
            .contentShape(.rect)
            .onHover { hovering = $0 }
            .heldContextMenu {
                HeldRow.button("Copy") { copy() }
                if let reply { HeldRow.button("Reply", action: reply) }
                if message.report != nil, let author {
                    HeldRow.button("Open \(author.name)’s Conversation") { app.open(.session(author.sessionID), from: here) }
                }
            }
        }
    }

    private func copy() {
        Clipboard.copy(message.text)
    }
}

/// Who does what, under a wrap-up: each part with its bot and how it's going (a click opens the
/// bot's conversation, where it works on it), and, while they wait for you, Start the Work.
private struct WorkList: View {
    let tasks: [GroupTask]
    let members: [Bot]
    /// The bots whose part waits on their conversation, stopped by you.
    var stopped: Set<String> = []
    let start: (() -> Void)?
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(tasks) { task in
                let bot = members.first { $0.id == task.bot } ?? app.bots.bot(task.bot)
                let opens = bot != nil && task.state != .proposed
                Button {
                    if let bot, opens { app.open(.session(bot.sessionID), from: here) }
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        if let bot {
                            BotAvatar(look: bot.look, size: 20, animates: false)
                        } else {
                            Image(systemName: "person.crop.circle.badge.questionmark")
                                .foregroundStyle(.tertiary)
                                .frame(width: 20, height: 20)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(bot?.name ?? "A bot that left")
                                .font(.callout.weight(.semibold))
                            Text(Self.inline(task.task))
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .lineLimit(5)
                                .multilineTextAlignment(.leading)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        WorkState(state: task.state, after: (task.after ?? []).map { id in members.first { $0.id == id }?.name ?? app.bots.bot(id)?.name ?? "another bot" },
                                  needsYou: task.state == .working && bot.map { Self.waits(on: $0, in: app.workspace) } == true,
                                  stopped: task.state == .working && stopped.contains(task.bot))
                        if opens {
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                                .padding(.top, 3)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .contentShape(.rect)
                    .hoverHighlight(in: RoundedRectangle(cornerRadius: 8), mutesInk: true)
                }
                .buttonStyle(.plain)
                .clickablePointer()
                .disabled(!opens)
                .help(opens ? "Open \(bot?.name ?? "the bot")’s conversation, where it works on this" : "")
                if task.state == .working, stopped.contains(task.bot), let bot {
                    StoppedLine(bot: bot)
                }
            }
            if let start {
                HStack {
                    Text("Each bot does its part in its own conversation, and reports back here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button("Start the Work", systemImage: "play.fill", action: start)
                        .buttonStyle(.glass)
                        .help("Hand each bot its part")
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
        }
        .padding(4)
        .recessedWell(RoundedRectangle(cornerRadius: 12))
        .padding(.top, 6)
    }

    /// Whether the bot is waiting on you in its conversation: a permission, a question, a sign-in.
    private static func waits(on bot: Bot, in workspace: Workspace) -> Bool {
        workspace.needsAttention(bot.sessionID)
    }

    /// Its words as the lead wrote them: code, bold and links shown, on its own lines.
    private static func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

/// Under a part whose bot's conversation you stopped: it waits there, and Resume lets it go on.
private struct StoppedLine: View {
    let bot: Bot
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("Waiting: \(bot.name)’s conversation is stopped")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Resume", action: resume)
                .buttonStyle(TextButtonStyle())
                .help("Resume \(bot.name)’s conversation: it goes on with this part")
                .accessibilityLabel("Resume \(bot.name)’s Conversation")
        }
        .font(.caption.weight(.medium))
        // Under the part's words, past its bot's face.
        .padding(.leading, 40)
        .padding(.trailing, 10)
        .padding(.bottom, 8)
    }

    /// Its conversation's queue picked up again, where it lives; one this Mac can't reach now, or
    /// whose computer didn't answer, is opened instead, where it says why.
    private func resume() {
        let (app, session) = (app, bot.sessionID)
        guard let model = app.workspace.model(for: session), model.canReach else { return app.open(.session(session), from: here) }
        Task { if await !model.resumeQueue().value { app.open(.session(session), from: here) } }
    }
}

/// How a part of the work is going.
private struct WorkState: View {
    let state: GroupTask.State
    /// The bots whose parts come first.
    var after: [String] = []
    /// Under way, and waiting on you in the bot's conversation.
    var needsYou = false
    /// Under way, and waiting on the bot's conversation, stopped by you.
    var stopped = false

    var body: some View {
        Group {
            switch state {
            case .proposed:
                if !after.isEmpty {
                    Text("After \(ListFormatter.localizedString(byJoining: after))")
                        .foregroundStyle(.tertiary)
                }
            case .waiting:
                Label("After \(ListFormatter.localizedString(byJoining: after))", systemImage: "clock")
                    .foregroundStyle(.secondary)
                    .help("Starts once their parts are done, with what they report")
            case .working where stopped:
                Label("Stopped", systemImage: "pause.circle")
                    .foregroundStyle(.secondary)
                    .help("Waits until you resume the bot’s conversation")
            case .working where needsYou:
                Label("Needs You", systemImage: "hand.raised.fill")
                    .foregroundStyle(.orange)
                    .help("It's waiting on you in its conversation: click to answer")
            case .working:
                HStack(spacing: 5) {
                    Spinner(size: 10)
                        .accessibilityHidden(true)
                    Text("Working")
                }
                .foregroundStyle(.secondary)
            case .done:
                Label("Done", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            case .failed:
                Label("Didn’t Finish", systemImage: "exclamationmark.circle")
                    .foregroundStyle(.orange)
            case .other:
                EmptyView()
            }
        }
        .font(.caption.weight(.medium))
        .padding(.top, 3)
    }
}

/// The bot talking now, at work. Its face opens its conversation.
private struct TypingRow: View {
    let bot: Bot
    /// What it's doing, its last step: so a long turn doesn't look stuck.
    var activity: [GroupActivity] = []
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 10) {
                Button { app.open(.session(bot.sessionID), from: here) } label: {
                    BotAvatar(look: bot.look, size: 28, mood: .working)
                }
                .buttonStyle(.plain)
                .clickablePointer()
                .help("Open \(bot.name)’s Conversation")
                .accessibilityLabel("Open \(bot.name)’s Conversation")
                ShimmerText(text: "\(bot.name) is thinking…")
                    .font(.callout)
            }
            ForEach(Array(activity.enumerated()), id: \.offset) { _, step in
                Text(InlineCode.attributed(Self.line(step, in: bot.directory), size: NSFont.preferredFont(forTextStyle: .caption1).pointSize))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    // Its next step takes the line at once: faded across, the two lay over each other.
                    .contentTransition(.identity)
                    // Under its name.
                    .padding(.leading, 38)
                    .transition(.opacity)
            }
        }
        .animation(.ui, value: activity)
    }

    /// A step as a session's conversation says it: "Reading notes.txt", "Searched the web for …".
    static func line(_ step: GroupActivity, in directory: String) -> String {
        switch step {
        case .step(let call): ToolCallView.summary(of: call, in: directory)
        case .thinking(let text): text
        case .writing: "Writing its reply"
        }
    }
}

/// Before anything's been said: who's here and how it goes.
private struct GroupIntro: View {
    let group: BotGroup
    let members: [Bot]

    var body: some View {
        let lead = members.first
        VStack(spacing: 12) {
            GroupAvatar(faces: members.map { GroupAvatar.Face(look: $0.look) }, size: 76)
            VStack(spacing: 4) {
                Text(group.name)
                    .font(.title2.weight(.semibold))
                Text(group.purpose.flatMap { $0.isEmpty ? nil : $0 } ?? ListFormatter.localizedString(byJoining: members.map(\.name)))
                    .foregroundStyle(.secondary)
            }
            Text("Bring them something to talk through. \(lead.map { "\($0.name) goes first, the" } ?? "The") others weigh in and answer each other, and \(lead.map { "\($0.name) sums up" } ?? "it's summed up") at the end. Write @ and a name to ask someone directly.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
        }
        .padding(.bottom, 120)
    }
}

/// A discussion that reached its limit of turns: carry on, or leave it there.
private struct PausedBar: View {
    let keepGoing: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "pause.circle")
                .foregroundStyle(.secondary)
            Text("Paused after a good few turns, so it doesn’t run on.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button("Keep Going", action: keepGoing)
                .buttonStyle(.glass)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .modifier(ComposerSurface())
    }
}

/// Where you write to the group: the message, a quick way to ask one of its bots, and send
/// (or stop, while they talk).
private struct GroupComposer: View {
    @Binding var text: String
    /// What you're replying to, each with your answer to it under it, as in a session.
    @Binding var quotes: [Drafts.Quote]
    /// The quote whose answer takes the keyboard (the one just added, or quoted again).
    var quoteFocus: Drafts.QuoteFocus?
    let placeholder: String
    let members: [Bot]
    /// Where the chat lives (nil: this Mac).
    let machine: String?
    let isTalking: Bool
    /// Goes up when the composer should take the keyboard (a reply put a quote in it).
    var focusRequest = 0
    let send: () -> Void
    let stop: () -> Void
    /// How tall the "&" list can be before it scrolls inside, and how tall it is as shown, as in a
    /// session's composer (`ComposerListRoom`).
    var listRoom: CGFloat = .infinity
    var listHeight: Binding<CGFloat> = .constant(0)
    @Environment(\.messageFont) private var messageFont
    /// Asks the field for the keyboard; nil once it has it.
    @State private var fieldFocus: MessageField.FocusRequest?
    /// The quote whose answer is to take the keyboard; nil once it has it.
    @State private var answerFocus: (id: UUID, request: MessageField.FocusRequest)?
    /// "&" and the bots and sessions it names, as in a session.
    @State private var agents = AgentPicker()
    /// Who a group chat on a machine can name, as that machine's box says (`kuvo/named`).
    @State private var chatAgents: [AgentMail.Agent]?

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || quotes.contains { !$0.response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // A group chat names those its computer's box names: on a machine, its own and those of
            // your other computers it meets at the relay.
            if let named = agents.matches(in: text, excluding: nil, from: machine == nil ? nil : chatAgents ?? []) {
                let selected = min(agents.selected, named.count - 1)
                ComposerListScroll(room: listRoom, height: listHeight, chosen: ComposerListChoice(list: "agents", row: selected)) {
                    AgentReferenceList(agents: named, selected: selected) { agents.insert($0, into: $text) }
                }
            }
            if !quotes.isEmpty {
                QuoteList(quotes: $quotes, focus: answerFocus, font: messageFont.field, onKey: answerKey) { id, focused in
                    if focused, answerFocus?.id == id { answerFocus = nil }
                }
            }
            MessageField(text: $text, placeholder: placeholder, font: messageFont.field, maxLines: 10, focus: fieldFocus, onKey: key) { focused in
                if focused { fieldFocus = nil }
            }
            .onChange(of: text) { _, new in agents.textChanged(new) }
            HStack(spacing: 2) {
                // Each bot: a click asks it by name.
                ForEach(members) { bot in
                    Button {
                        mention(bot)
                    } label: {
                        BotAvatar(look: bot.look, size: 20, animates: false)
                            .frame(width: 30, height: 28)
                            .hoverHighlight(in: Capsule(), mutesInk: true)
                    }
                    .buttonStyle(.plain)
                    .clickablePointer()
                    .help("Ask \(bot.name)")
                    .accessibilityLabel("Ask \(bot.name)")
                }
                Spacer(minLength: 0)
                SendStopButton(stops: isTalking, canSend: canSend, sendHelp: "Send (Return)", stopHelp: "Stop the Discussion (Esc)", send: send, stop: stop)
            }
            .padding(.leading, -8)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 7)
        .modifier(ComposerSurface())
        .onAppear(perform: focusAtEnd)
        .onChange(of: focusRequest) { focusAtEnd() }
        .onChange(of: quoteFocus) { _, focus in answerFocus = focus.map { (id: $0.id, request: MessageField.FocusRequest()) } }
        // As an "&" starts, who its machine's box names now.
        .task(id: machine.map { $0 + (AgentReferences.query(in: text) == nil ? "" : "&") }) {
            guard let machine, AgentReferences.query(in: text) != nil || chatAgents == nil else { return }
            chatAgents = await Self.named(on: machine) ?? chatAgents
        }
    }

    /// Who a group chat on `machine` can name, as its box says: its own, there, and those of your
    /// other computers. Nil when its box can't be asked now.
    private static func named(on machine: String) async -> [AgentMail.Agent]? {
        struct Named: Decodable { var agents: [AgentMail.Agent] }
        guard let named = try? await BoxClient.machine(machine).value(Named.self, "GET", "kuvo/named") else { return nil }
        return named.agents.map { agent in
            var agent = agent
            if agent.machine == nil { agent.machine = machine }
            return agent
        }
    }

    /// The keyboard, with the cursor after what's written, as in a session.
    private func focusAtEnd() {
        fieldFocus = MessageField.FocusRequest()
    }

    /// The field's keys: the "&" list's first while it's open; then Return sends (Shift- or
    /// Option-Return starts a new line) and Escape stops the discussion.
    private func key(_ key: MessageField.Key) -> Bool {
        if agents.key(key, text: $text, excluding: nil, from: machine == nil ? nil : chatAgents ?? []) { return true }
        return answerKey(key)
    }

    /// An answer's keys, as the field's without its list.
    private func answerKey(_ key: MessageField.Key) -> Bool {
        switch key.name {
        case .return:
            if key.modifiers.contains(.shift) || key.modifiers.contains(.option) { return false }
            send()
            return true
        case .escape:
            guard isTalking else { return false }
            stop()
            return true
        default:
            return false
        }
    }

    /// "&Mira " where the message goes on.
    private func mention(_ bot: Bot) {
        if !text.isEmpty, !(text.last?.isWhitespace ?? true) { text += " " }
        text += "&\(bot.name) "
        focusAtEnd()
    }
}
