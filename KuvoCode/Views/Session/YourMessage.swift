import ClientText
import OpenCodeKit
import AppKit
import SwiftUI

/// A message you sent, in a session or a group chat: its bubble, and under the pointer when it
/// went and what you can do with it (Copy, Undo From Here, and New Session From Here in a
/// session), which a right-click offers too.
extension EnvironmentValues {
    /// Messages here can be undone, with the changes made since (see `YourMessage`).
    @Entry var undoesChanges = true
}

struct YourMessage: View {
    let text: String
    /// Words with styling of their own (a group chat's mentions).
    var style: ((String) -> AttributedString?)?
    /// The bots and sessions it names with "&", each opening its conversation, and the project's
    /// folders for the files it names with "@": they stand out (see `MessageMentions`).
    var references: [AgentReferences.Reference] = []
    var folders: [String] = []
    var attachments: [AttachmentItem] = []
    var comments: [ReviewComment] = []
    /// The title of the widget it was sent from (`WidgetAnswer`).
    var widget: String?
    /// The keyword it was sent with, as typed (`SentWithKeyword`), drawn in front of its words.
    var keyword: String?
    let sent: Date
    /// Sent from your iPhone.
    var fromPhone = false
    /// A new session from here, in a session.
    var fork: (() -> Void)?
    let undo: () -> Void
    /// What undoing does, in its confirmation.
    let undoNote: String
    /// Its engine out of reach: what needs it waits.
    var isOffline = false
    /// Undo From Here takes the conversation and its files back: not in a session with a coding
    /// agent, which changes files itself.
    @Environment(\.undoesChanges) private var undoesChanges
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here
    @State private var hovering = false
    @State private var confirmsUndo = false

    /// Under the pointer; KUVO_DEMO_SHOW_HOVER shows every message's buttons, for screenshots.
    private var isHovering: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.environment["KUVO_DEMO_SHOW_HOVER"] != nil { return true }
        #endif
        return hovering
    }

    /// What VoiceOver reads for it: the widget it came from, its comments on the changes, what it
    /// says, and what's attached.
    private var spoken: String {
        let parts = (widget.map { ["From \(WidgetAnswer.name($0))"] } ?? [])
            + comments.map { "Comment on \($0.location): \($0.text)" }
            + [keyword.map { $0 + " " + text } ?? text].filter { !$0.isEmpty }
            + (attachments.isEmpty ? [] : [attachments.count == 1 ? "1 attachment" : "\(attachments.count) attachments"])
        return "You: " + parts.joined(separator: ". ")
    }

    /// What undoing from a message does in a session in `directory`. The engine keeps snapshots
    /// of files only in a git repository, so outside one the files stay as they are.
    static func undoNote(in directory: String) -> String {
        isInRepository(directory)
            ? "The conversation goes back to before this message, and so do the files the agent changed since. The message comes back to the composer. You can redo it all until you send something."
            : "The conversation goes back to before this message. The files the agent changed since stay as they are: they can be put back only in a git repository. The message comes back to the composer. You can redo it until you send something."
    }

    /// Whether `directory` is in a git repository, by a `.git` in it or a folder above. One on a
    /// machine counts as one: it isn't looked at from here.
    private static func isInRepository(_ directory: String) -> Bool {
        guard !RemoteFolder.isRemote(directory) else { return true }
        var url = URL(filePath: directory).standardizedFileURL
        while true {
            if FileManager.default.fileExists(atPath: url.appending(path: ".git").path(percentEncoded: false)) { return true }
            let parent = url.deletingLastPathComponent()
            if parent.path == url.path { return false }
            url = parent
        }
    }

    /// The named agents whose conversations are here to open, each once.
    private var openable: [AgentReferences.Reference] {
        var seen = Set<String>()
        return references.filter { app.workspace.session($0.session) != nil && seen.insert($0.session).inserted }
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            UserBubble(text: text, style: style, references: references, folders: folders, attachments: attachments, comments: comments, widget: widget, keyword: keyword)
            // Always laid out, shown under the pointer: nothing moves when they appear.
            HStack(spacing: 0) {
                Text(MessageTime.sentAt(sent) + (fromPhone ? " · from iPhone" : ""))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .help(SentTime.full(sent))
                    .padding(.trailing, 6)
                if !text.isEmpty {
                    CopyButton(text: text, help: "Copy")
                }
                if let fork {
                    MessageActionButton(symbol: "arrow.triangle.branch", help: "New Session From Here", action: fork)
                        .disabled(isOffline)
                }
                if undoesChanges {
                    MessageActionButton(symbol: "arrow.uturn.backward", help: "Undo From Here…") { confirmsUndo = true }
                        .disabled(isOffline)
                }
            }
            .opacity(isHovering ? 1 : 0)
            .animation(.easeOut(duration: 0.12), value: isHovering)
        }
        .contentShape(.rect)
        .onHover { hovering = $0 }
        .heldContextMenu {
            HeldRow.button("Copy", disabled: text.isEmpty) {
                Clipboard.copy(text)
            }
            for reference in openable {
                HeldRow.button("Open \(reference.name)") { app.open(.session(reference.session), from: here) }
            }
            HeldRow.divider
            if let fork {
                HeldRow.button("New Session From Here", disabled: isOffline, action: fork)
            }
            if undoesChanges {
                HeldRow.button("Undo From Here…", disabled: isOffline) { confirmsUndo = true }
            }
        }
        // With VoiceOver: the message, read as one, with what shows under the pointer and in its
        // menu as its actions.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(spoken)
        .accessibilityValue(SentTime.full(sent))
        .accessibilityActions {
            if !text.isEmpty { Button("Copy") { Clipboard.copy(text) } }
            ForEach(openable, id: \.session) { reference in
                Button("Open \(reference.name)") { app.open(.session(reference.session), from: here) }
            }
            if let fork, !isOffline { Button("New Session From Here", action: fork) }
            if !isOffline, undoesChanges { Button("Undo From Here…") { confirmsUndo = true } }
        }
        .closesWhenKept($confirmsUndo)
        .alert("Undo from this message?", isPresented: $confirmsUndo) {
            Button("Undo", action: undo)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(undoNote)
        }
    }
}
