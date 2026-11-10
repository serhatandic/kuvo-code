import ClientDesign
import ClientSessions
import SwiftUI

/// A note of what happened in the conversation, never the words written for the model (a command
/// left running ended, work moved to the background for a message, a subagent's report, the reply
/// cut off): one line at the conversation's edge, where the agent's steps are, opening to its
/// details. A change of state is a pill instead (KuvoClient's TranscriptNote says which).
struct NoteLine: View {
    let id: String
    let note: TranscriptNote
    /// The conversation it's in: what you opened is kept by this and the note (see `CardFolds`).
    let scope: String
    @Environment(\.scrollAnchor) private var scrollAnchor

    private var key: String { "note#" + scope + "#" + id }

    var body: some View {
        let open = note.opens && CardFolds.shared.isOpen(key, otherwise: false)
        VStack(alignment: .leading, spacing: 0) {
            if note.opens {
                Button {
                    CardFolds.shared.toggle(key, open: !open, in: scrollAnchor)
                } label: {
                    line(open: open)
                }
                .buttonStyle(TextButtonStyle(outset: true))
                .help(open ? "Hide the details" : "Show the details")
            } else {
                line(open: nil)
            }
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    if let detail = note.detail {
                        MarkdownText(text: detail)
                            .foregroundStyle(.secondary)
                    }
                    if let command = note.command {
                        // As a terminal shows it: the command, then what it printed.
                        OutputBlock(text: "$ " + command + (note.output.map { "\n" + $0 } ?? ""), command: command)
                    } else if let output = note.output {
                        OutputBlock(text: output)
                    }
                }
                .padding(.top, 8)
                .transition(.fold)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .foldOpen(open)
        .contextMenu {
            Button("Copy") { Clipboard.copy(note.text) }
            if let command = note.command { Button("Copy Command") { Clipboard.copy(command) } }
        }
    }

    /// Its words, and a chevron when it opens (`open`: nil for one that doesn't).
    private func line(open: Bool?) -> some View {
        HStack(spacing: 8) {
            Text(note.text)
                .lineLimit(1)
                .truncationMode(.tail)
            if let open {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }
}
