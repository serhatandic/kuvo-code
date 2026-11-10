import ClientText
import Foundation
import OpenCodeKit

/// A note in a conversation, as both apps show it: one the engine, the box or the coding agents'
/// bridge wrote for the agent (a `synthetic` or `system` message), or the box's own word to it
/// (`BoxNote`, all but its sessions' news, which are messages from them). Never the words written
/// for the model: a pill for a change of state (the model switched, the mode, the conversation
/// summarized), or else a short line of what happened, whose details open under it.
public struct TranscriptNote: Hashable, Sendable {
    public enum Look: Hashable, Sendable {
        /// A change of state, in a pill in the middle: a few words, one line.
        case pill
        /// What happened, in a line at the conversation's edge, opening to `detail` and `command`.
        case line
    }

    public let look: Look
    /// The SF Symbol it's known by (its words say what it is, so a pill draws none).
    public let symbol: String
    public let text: String
    /// What a line opens to, in this order: what happened, in full (Markdown), the command it's
    /// about as it ran, and the end of what that printed.
    public let detail: String?
    public let command: String?
    public let output: String?

    public init(_ look: Look, symbol: String, text: String, detail: String? = nil, command: String? = nil, output: String? = nil) {
        self.look = look
        self.symbol = symbol
        self.text = text
        let given = { (words: String?) in words.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 } }
        let detail = given(detail)
        self.detail = detail == text ? nil : detail
        self.command = given(command)
        self.output = given(output)
    }

    /// Whether a line has more than its words to open to.
    public var opens: Bool { detail != nil || command != nil || output != nil }

    /// The pill a session that starts in Plan mode shows.
    static let planMode = TranscriptNote(.pill, symbol: "list.bullet.clipboard", text: "Plan mode: it explores and plans, without changing files")

    /// What a note from the engine, the box or the bridge shows, or nil for one that shows nothing
    /// (guidance the engine or Kuvo Code adds, the engine's word to the model). `previous`: the
    /// note just before it, so Plan mode's rules don't say the mode twice.
    public static func of(_ notice: Message.Notice, after previous: TranscriptNote? = nil) -> TranscriptNote? {
        let sources = notice.instructionSources
        if !sources.isEmpty {
            if sources.allSatisfy({ $0.contains("kuvo.project-folders") }) { return TranscriptNote(.pill, symbol: "folder", text: "Project folders updated") }
            // The engine's own guidance (for the browser tools, its date), or what Kuvo Code adds
            // for a worktree, a bot or Autopilot: nothing you set.
            if sources.allSatisfy({ $0.hasPrefix("core/") || $0.contains("kuvo.") }) { return nil }
            // Instructions of yours, changed.
            return TranscriptNote(.pill, symbol: "doc.text", text: "Instructions updated")
        }
        switch notice.metadata?["source"]?.string {
        case "shell": return backgroundEnd(notice)
        case "subagent": return subagentEnd(notice)
        case "agent":
            // Its agent carrying on by itself (Claude Code, as what it started ends), or what it
            // left running lost as its process ended: the bridge's words for you.
            return TranscriptNote(.line, symbol: "arrow.turn.down.right", text: firstLine(notice.description ?? notice.text), detail: notice.text)
        default: break
        }
        if notice.text.hasPrefix(movedPrefix) { return moved(notice) }
        if notice.text.hasPrefix("<system-reminder>") {
            // The engine's word to the model, not to you. Plan mode's rules say the mode, for a
            // session that starts in it (a switch says so itself); not the one that says it's left
            // ("You are NO LONGER in Plan mode", after Build It).
            guard notice.text.contains("Plan mode"), notice.text.range(of: "no longer in Plan mode", options: .caseInsensitive) == nil else { return nil }
            return previous?.symbol == planMode.symbol ? nil : planMode
        }
        if notice.text.hasPrefix(Goal.marker) {
            // The box keeping the agent at its goal: given it, or told what's left.
            let words = String(notice.text.dropFirst(Goal.marker.count))
            return TranscriptNote(.line, symbol: "scope", text: firstLine(notice.description ?? words), detail: words)
        }
        if notice.text.hasPrefix("[Handoff] ") {
            // A conversation that carries on from another: what it is from now on.
            return TranscriptNote(.pill, symbol: "arrow.turn.down.right", text: firstLine(notice.description ?? "Carried on from another conversation"))
        }
        if let words = notice.carriedOn {
            // The engine asking the model to go on after a reply was cut off or ran out of room.
            return TranscriptNote(.line, symbol: "arrow.turn.down.right", text: words)
        }
        // Anything else: its description, or its first line, opening to the rest. (Auto moving
        // between agents, "Back on Claude Code: its limit has reset.", your message passed on to a
        // subagent.)
        let text = (notice.description ?? notice.text).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return TranscriptNote(.line, symbol: "info.circle", text: firstLine(text), detail: notice.text)
    }

    /// How a box note other than its sessions' news shows: a goal's change of state as a pill, the
    /// rest (a goal's reminder, your answer or pick told late) as a line.
    public static func of(_ note: BoxNote) -> TranscriptNote {
        let reminder = note.from == "Goal" && note.line == "Reminded to carry on"
        guard note.from == "Goal", !reminder else {
            return TranscriptNote(.line, symbol: note.symbol, text: firstLine(note.line), detail: note.line)
        }
        return TranscriptNote(.pill, symbol: note.symbol, text: note.line)
    }

    // MARK: Commands and subagents in the background

    /// The engine's note that what an agent waited on was moved to the background (its Ctrl+B). In
    /// Kuvo Code only the box asks for that: a message came for the agent while it waited on a
    /// command or a subagent (yours, another agent's, its sessions' news), and it moves that work on
    /// so the agent reads the message now (`steering`, PROTOCOL.md "A message while a command runs").
    /// The engine's words still say the user asked, which no one did.
    static let movedPrefix = "User requested that active blocking work be moved to the background."

    private static func moved(_ notice: Message.Notice) -> TranscriptNote {
        // "Backgrounded work:\n- shell: <command>\n- subagent: <what>"
        let items: [(kind: String, what: String)] = notice.text.split(separator: "\n").compactMap { line in
            guard line.hasPrefix("- "), let colon = line.firstIndex(of: ":") else { return nil }
            return (String(line.dropFirst(2)[..<colon]).trimmingCharacters(in: .whitespaces), String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces))
        }
        let commands = items.filter { $0.kind == "shell" }.map(\.what)
        let what: String = switch (items.count, items.first?.kind) {
        case (1, "shell"?): CommandWords.short(commands[0])
        case (1, "subagent"?): "a subagent"
        case (0, _): "what it waited on"
        default: commands.count == items.count ? "\(items.count) commands" : "\(items.count) tasks"
        }
        let detail = "Kuvo Code moved this to the background so the agent could read a message that came in while it waited. It keeps running, and the agent is told when it ends."
            + (items.contains { $0.kind != "shell" } ? "\n\n" + items.filter { $0.kind != "shell" }.map { "\($0.kind.prefix(1).uppercased() + $0.kind.dropFirst()): \($0.what)" }.joined(separator: "\n") : "")
        return TranscriptNote(.line, symbol: "arrow.down.right.circle", text: "Moved \(what) to the background for a new message", detail: detail, command: commands.joined(separator: "\n"))
    }

    /// A command left running in the background ended, which wakes the agent: how it went, and what
    /// it ran in a few words (its description, when its agent gave one), opening to the command and
    /// the end of what it printed.
    private static func backgroundEnd(_ notice: Message.Notice) -> TranscriptNote {
        let metadata = notice.metadata
        // The engine's: the command in its description, and in the text, what it printed between
        // `<shell …>` and `</shell>`. The bridge's: the command in its description, its agent's
        // description of it in `title`.
        var command = notice.description ?? ""
        var printed = notice.text
        if printed.hasPrefix("<shell ") {
            let lines = printed.split(separator: "\n", omittingEmptySubsequences: false)
            if command.isEmpty, let ran = BoxNote.firstMatch(#"command="((?:[^"\\]|\\.)*)""#, in: String(lines[0]))?.first { command = ran }
            printed = lines.dropFirst().filter { $0 != "</shell>" }.joined(separator: "\n")
        } else if metadata?["kuvo"]?["lostWork"] == nil {
            // "A command left running in the background finished.": said by the line already.
            printed = ""
        }
        let about = metadata?["title"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        let what = about?.isEmpty == false ? about! : CommandWords.short(command)
        let exit = metadata?["exit"]?.number.flatMap { Int(exactly: $0) }
        let outcome = switch (metadata?["state"]?.string, exit) {
        case _ where metadata?["signal"]?.string != nil: "Background run stopped"
        case ("completed", 0?), ("completed", nil): "Background run finished"
        case (_, let code?) where code != 0: "Background run failed (exit \(code))"
        default: "Background run stopped"
        }
        return TranscriptNote(.line, symbol: "terminal", text: what.isEmpty ? outcome : "\(outcome): \(what)", command: command, output: tail(printed))
    }

    /// A subagent sent off in the background ended, which wakes the agent: what it was for, opening
    /// to what it reported.
    private static func subagentEnd(_ notice: Message.Notice) -> TranscriptNote {
        var report = notice.text
        var about = notice.description
        if report.hasPrefix("<subagent ") {
            let lines = report.split(separator: "\n", omittingEmptySubsequences: false)
            if about == nil { about = BoxNote.firstMatch(#"description="([^"]*)""#, in: String(lines[0]))?.first }
            report = lines.dropFirst().filter { $0 != "</subagent>" }.joined(separator: "\n")
        }
        let outcome = switch notice.metadata?["state"]?.string {
        case "completed"?, nil: "Subagent finished"
        case "error"?, "failed"?: "Subagent failed"
        default: "Subagent stopped"
        }
        let what = about.map(firstLine) ?? ""
        return TranscriptNote(.line, symbol: "person.2", text: what.isEmpty ? outcome : "\(outcome): \(what)", detail: report)
    }

    // MARK: Words

    /// The first line that says something, cut to a line's length.
    static func firstLine(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(String.init) ?? ""
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.count > 120 ? String(trimmed.prefix(119)) + "…" : trimmed
    }

    /// The end of what a command printed: its last lines.
    private static func tail(_ printed: String) -> String {
        let lines = printed.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count > 40 else { return lines.joined(separator: "\n") }
        return "…\n" + lines.suffix(40).joined(separator: "\n")
    }
}
