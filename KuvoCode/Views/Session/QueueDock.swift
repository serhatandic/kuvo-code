import OpenCodeKit
import SwiftUI

/// Messages waiting for the agent, in a card tucked behind the composer's top edge: those for its
/// next step, then the queue, in the order it gets them. Each can steer in now, go in at once,
/// come back to the composer for editing, or be removed. A long queue scrolls.
struct QueueDock: View {
    let model: SessionModel
    @Environment(\.colorScheme) private var scheme
    @Environment(\.cardIsFocused) private var cardIsFocused

    private static let rowHeight: CGFloat = 34
    private static let visibleRows = 5
    /// How far the composer comes over the card's foot.
    static let overlap: CGFloat = 14
    private static let shape = UnevenRoundedRectangle(topLeadingRadius: Metrics.composerRadius, topTrailingRadius: Metrics.composerRadius)

    var body: some View {
        let items = model.waiting
        let isPaused = model.isQueuePaused && !model.isRunning
        VStack(alignment: .leading, spacing: 0) {
            if isPaused {
                HStack(spacing: 6) {
                    Image(systemName: "pause.circle")
                        .foregroundStyle(.secondary)
                    Text("Paused")
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button("Resume", systemImage: "play.fill", action: model.resumeQueue)
                        .buttonStyle(TextButtonStyle())
                        .help("Send the waiting messages, one after another")
                }
                .font(.system(size: 12, weight: .medium))
                .padding(.leading, 12)
                .padding(.trailing, 6)
                .frame(height: 28)
            }
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
            .animation(.ui, value: items.map(\.id))
        }
        .padding(.horizontal, 6)
        .padding(.top, 4)
        .padding(.bottom, Self.overlap + 2)
        .background(Surface.cardFill(scheme, focused: cardIsFocused), in: Self.shape)
        .overlay(Self.shape.fill(scheme == .dark ? Color.white.opacity(0.02) : Surface.slate.opacity(0.025)).allowsHitTesting(false))
        .specularRim(Self.shape)
        // A step in from the composer's sides, so it reads as behind it.
        .padding(.horizontal, 16)
    }
}

private struct QueueRow: View {
    let item: Transcript.Pending
    let isRunning: Bool
    let model: SessionModel

    private var isQueued: Bool { item.delivery == .queue }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: isQueued ? "text.line.last.and.arrowtriangle.forward" : "arrow.turn.down.right")
                .font(.system(size: 13))
                .foregroundStyle(.tertiary)
                .frame(width: 18)
                .help(isQueued ? "Sent after the current run, in this order" : "The agent gets this at its next step")
            if let picture = item.files.first(where: { AttachmentItem.local($0).isImage }) {
                QueuePicture(url: picture)
            }
            MessageMentions.text(styledSummary, size: 14.5)
                .font(.system(size: 13.5))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            if item.isLocal {
                Spinner(size: 10)
                    .padding(.trailing, 8)
                    .help("Sending…")
            } else {
                if isQueued {
                    Button {
                        isRunning ? model.steer(item) : model.sendNow(item)
                    } label: {
                        Label(isRunning ? "Steer" : "Send", systemImage: isRunning ? "arrow.turn.down.right" : "arrow.up")
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
                        Label("Send Now", systemImage: "arrow.up")
                    }
                    .buttonStyle(TextButtonStyle())
                    .font(.system(size: 13))
                    .help("Send Now: stops the agent's current step and gives it this")
                }
                Button("Remove", systemImage: "trash") { model.cancelPending(item) }
                    .buttonStyle(CardActionStyle())
                    .help("Remove")
                Menu {
                    if isRunning && isQueued {
                        Button("Send Now") { model.sendNow(item) }
                    }
                    Button("Edit") { model.edit(item) }
                    Divider()
                    Button("Remove", role: .destructive) { model.cancelPending(item) }
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
                .help(isRunning && isQueued ? "Send Now (stops the current step), Edit, Remove" : "Edit, Remove")
            }
        }
        .padding(.leading, 6)
        .contentShape(.rect)
        .onTapGesture(count: 2) { model.edit(item) }
        .contextMenu {
            if isQueued, isRunning { Button("Steer") { model.steer(item) } }
            Button("Send Now") { model.sendNow(item) }
            Button("Edit") { model.edit(item) }
            Divider()
            Button("Remove", role: .destructive) { model.cancelPending(item) }
        }
        .disabled(item.isLocal)
    }

    /// The summary, with the agents and files it names standing out, as in its bubble.
    private var styledSummary: AttributedString {
        let summary = summary
        var styled = AttributedString(summary)
        let references = SentMessage.split(item.text).references
        let folders = [model.session.location.directory]
        MessageMentions.apply(to: &styled, agents: MessageMentions.agents(references), folders: folders, links: false)
        return styled
    }

    /// The message's first line, or what's attached when there's no text.
    private var summary: String {
        let (text, comments, paths) = UserBubble.split(item.text)
        if let line = text.split(separator: "\n").first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) {
            return String(line)
        }
        let names = item.files.map(\.lastPathComponent) + Attachments.paths(paths, besides: item.files).map { ($0 as NSString).lastPathComponent }
        if !names.isEmpty { return names.joined(separator: ", ") }
        return comments.isEmpty ? "" : comments.count.counting("comment")
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
