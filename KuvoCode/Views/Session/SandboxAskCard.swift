import ClientDesign
import ClientSandbox
import SwiftUI

/// What a conversation's agents ask to run outside its computer's sandbox, over its composer: one
/// card each, oldest first, as the app follows each box's asks (`Sandboxes.follow`).
struct SandboxAskCards: View {
    let session: String
    let box: String
    @Environment(\.takesCardKeys) private var takesKeys

    var body: some View {
        ForEach(Array(Sandboxes.shared.asks(for: session, on: box).enumerated()), id: \.element.id) { index, asked in
            SandboxAskCard(asked: asked, box: box, takesKeys: takesKeys && index == 0)
        }
    }
}

/// A command the sandbox stopped, which its agent asks to run outside it: who asks, what the
/// sandbox stopped (on a Mac, what it tried and where; on Linux, the error the command got), the
/// command, the agent's reason; Don't Allow, Always for This (where the box names the one place
/// to let the project's commands write, still in the sandbox) and Allow Once.
struct SandboxAskCard: View {
    let asked: SandboxAsk
    let box: String
    var takesKeys = false

    var body: some View {
        // A bot's run with you away: how long it's been waiting, over the card once it's a minute.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 6) {
                if let waiting = asked.waiting(now: context.date.timeIntervalSince1970 * 1000) {
                    Label(waiting, systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 4)
                }
                card.modifier(ComposerSurface())
            }
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.shield.fill")
                    .font(.title3)
                    .foregroundStyle(.orange)
                    .frame(width: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(asked.title)
                        .font(.headline)
                    Text(asked.subtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
            }

            // The command and what was stopped, sunk in like a code block; a long one scrolls.
            AllowedWell(maxHeight: 200) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("$ " + asked.command)
                        .transcriptCodeFont()
                        .textSelection(.enabled)
                        .accessibilityLabel("Command: \(asked.command)")
                    ForEach(Array((asked.stopped ?? []).enumerated()), id: \.offset) { _, stop in
                        StoppedRow(tag: stop.label, text: stop.detail)
                    }
                    if asked.stopped?.isEmpty ?? true, let error = asked.error {
                        StoppedRow(tag: "Error", text: error)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .recessedWell(RoundedRectangle(cornerRadius: 10))

            Text("\(Text(asked.asker + ":").foregroundStyle(.secondary)) “\(asked.why)”")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)

            // Why the last answer didn't go through: the card stays, to try again.
            if let trouble = Sandboxes.shared.failures[asked.id] {
                Text(trouble)
                    .font(.callout)
                    .foregroundStyle(.red)
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    dontAllow
                    Spacer()
                    always(whole: true)
                    allowOnce
                }
                // A narrow window: the answers stacked, the one that leaves the sandbox least last.
                VStack(alignment: .trailing, spacing: 8) {
                    HStack(spacing: 8) {
                        dontAllow
                        Spacer()
                        allowOnce
                    }
                    always(whole: false)
                }
            }
            .buttonStyle(.glass)
            .controlSize(.large)
            .disabled(Sandboxes.shared.answering.contains(asked.id))
        }
        .padding(16)
    }

    private var dontAllow: some View {
        Button("Don’t Allow", role: .cancel) { answer(.no) }
            .keyboardShortcut(takesKeys ? .cancelAction : nil)
    }

    /// Its path whole in one row with the others; where that doesn't fit, on a row of its own,
    /// cut in the middle when even that is too narrow.
    @ViewBuilder private func always(whole: Bool) -> some View {
        if let path = asked.alwaysPath {
            Button { answer(.always) } label: {
                Text("Always for \(Text(path).monospaced())")
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .fixedSize(horizontal: whole, vertical: false)
            }
            .help(asked.alwaysMeaning ?? "")
            .accessibilityLabel(asked.alwaysMeaning ?? "Always for This")
        }
    }

    // (No Return for it: running outside the sandbox is a click you mean.)
    private var allowOnce: some View {
        Button("Allow Once") { answer(.once) }
            .buttonStyle(.glassProminent)
            .accessibilityLabel("Allow once: run it outside the sandbox")
    }

    private func answer(_ answer: SandboxAnswer) {
        Task { try? await Sandboxes.shared.answer(asked, answer, on: box) }
    }
}

/// The box's one ask, the first time its sandbox is on, to restart the agents that started before
/// it and still run outside it (`Sandboxes.asksToRestart`): a plain card in each of that computer's
/// conversations, until it's answered here or on another device. Restart Agents, or Not Now.
struct SandboxRestartCard: View {
    let box: String

    var body: some View {
        if Sandboxes.shared.asksToRestart(on: box) {
            card.modifier(ComposerSurface())
        }
    }

    private var answering: Bool { Sandboxes.shared.answeringRestart(on: box) }

    private var card: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "arrow.clockwise")
                    .font(.title3)
                    .foregroundStyle(.tint)
                    .frame(width: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(SandboxRestart.title)
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                    Text(SandboxRestart.detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .fixedSize(horizontal: false, vertical: true)
            }

            // Why the answer didn't go through: the card stays, to try again.
            if let trouble = Sandboxes.shared.restartFailures[box] {
                Text(trouble)
                    .font(.callout)
                    .foregroundStyle(.red)
            }

            HStack(spacing: 8) {
                Button(SandboxRestart.notNow, role: .cancel) { answer(false) }
                    .help("They finish as they are, outside the sandbox")
                Spacer()
                if answering {
                    Spinner()
                        .accessibilityLabel("Restarting the agents")
                }
                Button(SandboxRestart.restart) { answer(true) }
                    .buttonStyle(.glassProminent)
                    .help("Each restarts in the sandbox once it finishes what it’s doing")
            }
            .buttonStyle(.glass)
            .controlSize(.large)
            .disabled(answering)
        }
        .padding(16)
    }

    private func answer(_ restart: Bool) {
        Task { try? await Sandboxes.shared.answerRestart(restart, on: box) }
    }
}

/// One thing the sandbox stopped: its tag ("Write", "Error") and where, or in words.
private struct StoppedRow: View {
    let tag: String
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(tag)
                .font(.caption.weight(.medium))
                .foregroundStyle(.orange)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.orange.opacity(0.15), in: .rect(cornerRadius: 5))
            Text(text)
                .transcriptCodeFont()
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Stopped: \(tag), \(text)")
    }
}
