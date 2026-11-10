import ClientDesign
import ClientSandbox
import SwiftUI

/// A command the sandbox stopped, which its agent asks to run outside it: who asks, what the
/// sandbox stopped (on a Mac, what it tried and where; on Linux, the error the command got), the
/// command, the agent's reason; its answers numbered: Allow Once, Always Allow <place> (where the
/// box names the one place to let the project's, the bot's own or every chat's commands write,
/// still in the sandbox) and Don't Allow.
struct SandboxAskCard: View {
    let asked: SandboxAsk
    let box: String
    var takesKeys = false
    /// Off in the composer's place, whose card it's in.
    var drawsSurface = true

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
                card.modifier(ComposerSurface(isOn: drawsSurface))
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

            // Its answers numbered, as every ask's (the permission card's). No number key or
            // Return runs it outside the sandbox: that's a click you mean. Esc says no.
            VStack(spacing: 2) {
                ForEach(Array(answers.enumerated()), id: \.element.answer) { index, row in
                    ChoiceRow(number: index + 1, label: row.words) { answer(row.answer) }
                        .help(row.hint)
                        .accessibilityLabel(row.spoken)
                }
            }
            .padding(.horizontal, -ChoiceRow.inset)
            .background(escape)
            .disabled(Sandboxes.shared.answering.contains(asked.id))
        }
        .padding(16)
    }

    /// Allow Once, Always Allow <place> where its box names one, and Don't Allow.
    private var answers: [(answer: SandboxAnswer, words: Text, spoken: String, hint: String)] {
        var rows: [(answer: SandboxAnswer, words: Text, spoken: String, hint: String)] = [(.once, Text("Allow Once"), "Allow once: run it outside the sandbox", "Runs it outside the sandbox this once")]
        if let path = asked.alwaysPath {
            // A chat's is every chat's: said on the row.
            rows.append((.always, Text("Always Allow \(Text(path).monospaced())\(asked.alwaysScope.map { " " + $0 } ?? "")"), asked.alwaysTitle ?? "Always Allow", asked.alwaysHint ?? ""))
        }
        rows.append((.no, Text("Don’t Allow"), "Don’t Allow", "It goes on without running it"))
        return rows
    }

    /// Esc: Don't Allow.
    private var escape: some View {
        Button("") { answer(.no) }
            .keyboardShortcut(takesKeys ? .cancelAction : nil)
            .frame(width: 0, height: 0)
            .opacity(0)
            .accessibilityHidden(true)
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
    /// The answer on its way, for the spinner's words.
    @State private var sent: Bool?

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
                        .accessibilityLabel(sent == false ? "Leaving the agents as they are" : "Restarting the agents")
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
        sent = restart
        Task {
            do {
                try await Sandboxes.shared.answerRestart(restart, on: box)
            } catch {
                if let trouble = Sandboxes.shared.restartFailures[box] { AccessibilityNotification.Announcement(trouble).post() }
            }
        }
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
