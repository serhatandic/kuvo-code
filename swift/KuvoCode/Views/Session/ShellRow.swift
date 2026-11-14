import ClientDesign
import OpenCodeKit
import SwiftUI

/// A command you ran with "!": a line like the agent's own steps, saying it was you, with what it
/// printed open under it.
struct ShellRow: View {
    let shell: Message.Shell
    @Environment(\.findHighlight) private var highlight
    @State private var isExpanded = true

    private static let iconWidth: CGFloat = 16
    private static let iconGap: CGFloat = 8

    /// What it printed, as shown (and as Find reads it).
    static func output(of shell: Message.Shell) -> String {
        shell.output?.output.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private var output: String { Self.output(of: shell) }

    /// Find's marks for the command, then for what it printed.
    private var marks: [FindHighlight]? {
        highlight?.spread(over: [shell.command, output])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if output.isEmpty {
                header.foregroundStyle(.secondary)
            } else {
                Button {
                    withAnimation(.ui) { isExpanded.toggle() }
                } label: {
                    header
                }
                .buttonStyle(TextButtonStyle(outset: true))
            }
            if isExpanded, !output.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    OutputBlock(text: output, command: shell.command)
                        .environment(\.findHighlight, marks?[1])
                    if shell.output?.truncated == true {
                        Text("Only the end is kept; it printed more.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.leading, Self.iconWidth + Self.iconGap)
                .padding(.top, 8)
                .overlay(alignment: .topLeading) {
                    // The line down from the icon, beside what it opened.
                    Capsule()
                        .fill(.separator)
                        .frame(width: 1)
                        .padding(.top, 3)
                        .padding(.leading, (Self.iconWidth - 1) / 2)
                }
                .transition(.fold)
            }
        }
        // Find on a place in what it printed: open to show it.
        .onChange(of: marks?[1].current) { if marks?[1].current != nil { isExpanded = true } }
        .heldContextMenu {
            HeldRow.button("Copy Command") { copy(shell.command) }
            if !output.isEmpty { HeldRow.button("Copy Output") { copy(output) } }
        }
    }

    private var header: some View {
        HStack(spacing: Self.iconGap) {
            StepActivity(symbol: "terminal", running: shell.isRunning, size: Self.iconWidth)
            Text(AttributedString((shell.isRunning ? "Running " : "You ran ") + "`") + FindText.marked(AttributedString(shell.command), marks?[0]) + AttributedString("`"))
                .lineLimit(1)
                .truncationMode(.middle)
            // Counting while it runs; once done, how long it took.
            StepActivity.Elapsed(since: shell.time.created.date, running: shell.isRunning, until: shell.time.completed?.date)
            if let exit = shell.exit, exit != 0 {
                Text("exit \(exit)")
                    .foregroundStyle(.red)
            } else if ["timeout", "killed"].contains(shell.status) {
                Text(shell.status == "timeout" ? "timed out" : "stopped")
                    .foregroundStyle(.red)
            }
            if !output.isEmpty {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            Spacer(minLength: 0)
        }
        .font(.callout)
        .contentShape(.rect)
    }

    private func copy(_ text: String) {
        Clipboard.copy(text)
    }
}
