import ClientDesign
import ClientSessions
import ClientText
import OpenCodeKit
import SwiftUI

/// Messages waiting for the agent, in a card tucked behind the composer's top edge: those for its
/// next step, then the queue, in the order it gets them. Each can steer in now, go in at once,
/// come back to the composer for editing, or be removed. A long queue scrolls.
struct QueueDock: View {
    let model: SessionModel
    /// In the card with the bars and the composer: no surface of its own, and more than two
    /// waiting fold to one line, "3 queued", until it's opened.
    var inCard = false
    var isOpen: Binding<Bool> = .constant(true)
    @Environment(\.colorScheme) private var scheme
    @Environment(\.cardIsFocused) private var cardIsFocused

    private static let rowHeight: CGFloat = 34
    private static let visibleRows = 5
    /// How far the composer comes over the card's foot.
    static let overlap: CGFloat = 14
    private static let shape = UnevenRoundedRectangle(topLeadingRadius: Metrics.composerRadius, topTrailingRadius: Metrics.composerRadius)

    /// Folded to its line: in the card, with more than two waiting.
    static func folds(_ count: Int) -> Bool { count > 2 }

    var body: some View {
        if inCard { list(folding: true) } else { docked }
    }

    private var docked: some View {
        list(folding: false)
            .padding(.horizontal, 6)
            .padding(.top, 4)
            .padding(.bottom, Self.overlap + 2)
            .background(Surface.cardFill(scheme, focused: cardIsFocused), in: Self.shape)
            .overlay(Self.shape.fill(scheme == .dark ? Color.white.opacity(0.02) : Surface.slate.opacity(0.025)).allowsHitTesting(false))
            .specularRim(Self.shape)
            // A step in from the composer's sides, so it reads as behind it.
            .padding(.horizontal, 16)
    }

    private func list(folding: Bool) -> some View {
        let items = model.waiting
        let isPaused = model.isQueuePaused && !model.isRunning
        let folds = folding && Self.folds(items.count)
        return VStack(alignment: .leading, spacing: 0) {
            if folds {
                // No mark: "queued" says it, and the rows' marks under it say which are steered.
                BarLine(mark: AnyView(Color.clear.frame(height: 1)),
                        title: "\(items.count) queued", detail: items.first.map { first in Text((model.sender(of: first).map { "\($0): " } ?? "") + QueueRow.summary(of: first)) },
                        showHelp: "Show the messages waiting", hideHelp: "Fold them to this line",
                        isHidden: Binding(get: { !isOpen.wrappedValue }, set: { isOpen.wrappedValue = !$0 }))
            }
            if isPaused {
                HStack(spacing: 6) {
                    Text("Paused")
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button("Resume") { model.resumeQueue() }
                        .buttonStyle(TextButtonStyle())
                        .help("Send the waiting messages, one after another")
                }
                .font(.system(size: 12, weight: .medium))
                // In the card, its words where the bars' start.
                .padding(.leading, folding ? 14 : 12)
                .padding(.trailing, folding ? 14 : 6)
                .frame(height: 28)
            }
            if !folds || isOpen.wrappedValue {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { item in
                            QueueRow(item: item, isRunning: model.isRunning, model: model)
                                .frame(height: Self.rowHeight)
                        }
                    }
                }
                .frame(height: CGFloat(min(items.count, Self.visibleRows)) * Self.rowHeight)
                .scrollBounceBehavior(.basedOnSize)
                // Its rows' words start where the bars' do.
                .padding(.horizontal, folding ? 8 : 0)
                .padding(.vertical, folding ? 3 : 0)
                .transition(.fold)
            }
            // The message last removed, for a moment.
            if let text = model.putAways.text(.message) {
                UndoLine(text: text, undo: model.putAways.canUndo(.message) ? { model.putAways.undo(.message) } : nil)
                    .padding(.horizontal, folding ? 0 : 6)
                    .transition(.fold)
            }
        }
        .animation(.ui, value: items.map(\.id))
        .animation(.ui, value: model.putAways.isPutAway(.message))
    }
}

struct QueueRow: View {
    let item: Transcript.Pending
    let isRunning: Bool
    let model: SessionModel
    @Environment(Catalog.self) private var catalog

    private var isQueued: Bool { item.delivery == .queue }
    /// Waiting on the box (it came while the queue was paused), and who from: nil for one of yours.
    private var isOnBox: Bool { model.isOnBox(item) }
    private var sender: String? { model.sender(of: item) }
    /// Yours to rewrite: not another agent's letter, a wake-up or a bot's news.
    private var canEdit: Bool { sender == nil }

    var body: some View {
        HStack(spacing: 10) {
            Group {
                if isQueued { QueuedMark(size: 13) } else { Image(systemName: "arrow.turn.down.right").font(.system(size: 13)) }
            }
            .foregroundStyle(.tertiary)
            .frame(width: 18)
            .help(isOnBox ? "Came while it was stopped: goes once you resume, in this order" : isQueued ? "Sent after the current run, in this order" : "The agent gets this at its next step")
            if let picture = item.files.first(where: { AttachmentItem.local($0).isImage }) {
                QueuePicture(url: picture)
            }
            if let sender {
                Text(sender)
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
            }
            MessageMentions.text(Self.styledSummary(of: item, folders: [model.session.location.directory]), size: 14.5)
                .font(.system(size: 13.5))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            if item.isLocal {
                Spinner(size: 10)
                    .padding(.trailing, 8)
                    .help("Sending…")
            } else {
                if isOnBox {
                    Button {
                        model.sendNow(item)
                    } label: {
                        Text(isRunning ? "Send Now" : "Send")
                    }
                    .buttonStyle(TextButtonStyle())
                    .font(.system(size: 13))
                    .help(isRunning ? "Send Now: stops the agent's current step and gives it this" : "Send it now")
                } else if isQueued {
                    Button {
                        isRunning ? model.steer(item) : model.sendNow(item)
                    } label: {
                        Text(isRunning ? "Steer" : "Send")
                    }
                    .buttonStyle(TextButtonStyle())
                    .font(.system(size: 13))
                    .help(isRunning ? "Steer: the agent takes this at its next step, without waiting for the run to end" : "Send it now")
                } else if isRunning {
                    // Steered: said, so a long step of the agent's (one answer, no tools) doesn't
                    // make it look ignored.
                    Text("At its next step")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .fixedSize()
                        .help("The agent takes this once its current step ends (a tool call, or the answer it's writing). Send Now gives it this right away.")
                    // For its next step already: what's left is not waiting for that.
                    Button {
                        model.sendNow(item)
                    } label: {
                        Text("Send Now")
                    }
                    .buttonStyle(TextButtonStyle())
                    .font(.system(size: 13))
                    .help("Send Now: stops the agent's current step and gives it this")
                }
                Button("Remove", systemImage: "trash") { remove() }
                    .buttonStyle(CardActionStyle())
                    .help("Remove")
                // (Another's message has nothing more than Send and Remove, both shown.)
                if canEdit {
                    Menu {
                        if isRunning && isQueued && !isOnBox {
                            Button("Send Now") { model.sendNow(item) }
                        }
                        Button("Edit") { model.edit(item) }
                        Divider()
                        Button("Remove", role: .destructive) { remove() }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 13))
                            .frame(width: 26, height: 24)
                            .hoverHighlight(in: RoundedRectangle(cornerRadius: 6), mutesInk: true)
                    }
                    .menuStyle(.button)
                    .buttonStyle(.plain)
                    .clickablePointer()
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .accessibilityLabel("More")
                    .help(isRunning && isQueued && !isOnBox ? "Send Now (stops the current step), Edit, Remove" : "Edit, Remove")
                } else {
                    // Its buttons where the other rows' are.
                    Color.clear.frame(width: 26, height: 24)
                }
            }
        }
        .padding(.leading, 6)
        .contentShape(.rect)
        .onTapGesture(count: 2) { if canEdit { model.edit(item) } }
        .heldContextMenu {
            if isQueued, isRunning, !isOnBox { HeldRow.button("Steer") { model.steer(item) } }
            HeldRow.button("Send Now") { model.sendNow(item) }
            if canEdit { HeldRow.button("Edit") { model.edit(item) } }
            HeldRow.divider
            HeldRow.button("Remove", role: .destructive) { remove() }
        }
        .disabled(item.isLocal)
    }

    /// Removed at once, as the agent would take it meanwhile; Undo puts it back: where it was while
    /// it's held for Resume, else at the queue's end.
    private func remove() {
        // Held for Resume, after a Stop: it comes back the same way, ahead of what came after it.
        let paused = model.isQueuePaused && !model.isRunning
        let before = model.next(after: item)
        model.cancelPending(item)
        let item = item, model = model, catalog = catalog
        model.putAways.put(.message, text: "Message removed", undo: {
            model.requeue(item, for: catalog.model(model.session.model), paused: paused, before: before)
        })
    }

    /// The summary, with the agents and files it names standing out and the keyword it was sent
    /// with drawn in front, as in its bubble.
    static func styledSummary(of item: Transcript.Pending, folders: [String]) -> AttributedString {
        let (keyword, line) = line(of: item)
        var styled = AttributedString(line)
        let references = SentMessage.split(item.text).references
        MessageMentions.apply(to: &styled, agents: MessageMentions.agents(references), folders: folders, links: false)
        return keyword.map { MessageMentions.keyword($0, before: styled) } ?? styled
    }

    /// A message's first line, or what's attached when there's no text, after the keyword it was
    /// sent with as typed ("/goal Summarize the commits weekly").
    static func summary(of item: Transcript.Pending) -> String {
        let (keyword, line) = line(of: item)
        return [keyword, line].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    private static func line(of item: Transcript.Pending) -> (keyword: String?, line: String) {
        // What the box told the agent: what happened, in a line.
        if let note = BoxNote.of(text: item.text, metadata: item.metadata) { return (nil, note.line) }
        let keyword = SentMessage.keyword(of: item.text)
        let (text, comments, paths) = UserBubble.split(item.text)
        if let line = text.split(separator: "\n").first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) {
            return (keyword, String(line))
        }
        let names = item.files.map(\.lastPathComponent) + Attachments.paths(paths, besides: item.files).map { ($0 as NSString).lastPathComponent }
        if !names.isEmpty { return (keyword, names.joined(separator: ", ")) }
        return (keyword, comments.isEmpty ? "" : comments.count.counting("comment"))
    }
}

/// A picture attached to a waiting message, small, before its words.
private struct QueuePicture: View {
    let url: URL
    @State private var image: NSImage?

    var body: some View {
        RoundedRectangle(cornerRadius: 5)
            .fill(Color.primary.opacity(0.06))
            .overlay {
                if let image {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFill()
                }
            }
            .frame(width: 24, height: 24)
            .clipShape(.rect(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5))
            .task(id: url) { image = await AttachmentItem.local(url).loadImage() }
    }
}
