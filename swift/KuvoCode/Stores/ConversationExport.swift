import ClientSessions
import Foundation
import OpenCodeKit

/// A conversation as Markdown, to paste into an issue or a chat, or for another agent to read
/// (read_conversation): your messages, those other agents sent it and its wake-ups, the agent's
/// replies, and a line for each step it took, as the transcript words them. `you` and `agent` are
/// who's speaking, as whoever reads it knows them. (What a box's search reads of it is its own:
/// `kuvo/search`.)
enum ConversationExport {
    static func markdown(title: String, messages: [Message], directory: String, you: String = "You", agent: String = "Agent") -> String {
        var blocks = ["# " + title]
        var speaker: String?
        // The agent's steps, listed together until it says something.
        var steps: [String] = []
        func say(_ who: String, _ text: String) {
            if !steps.isEmpty {
                let list = steps.map { "- " + $0 }.joined(separator: "\n")
                steps = []
                say(agent, list)
            }
            if speaker != who { blocks.append("**\(who)**") }
            speaker = who
            blocks.append(text)
        }
        for message in messages {
            switch message {
            case .user(let user):
                let written = CommandMessages.shared.text(of: user)
                // Not yours: another agent's message, a wake-up, a group chat's work, what the box
                // told the agent (as the line of what happened).
                if let note = BoxNote.of(user) {
                    // Its sessions' news as the transcript shows it, a message from each (one still
                    // working, nothing); the box's other notes as a line of what happened.
                    if note.news.isEmpty, note.shown.isEmpty { say(note.from, note.line) }
                    for news in note.shown { say("From \(news.title)" + (news.status.map { " · \($0)" } ?? ""), news.body) }
                    continue
                }
                let parts = SentMessage.parts(user)
                if let mail = parts.mail {
                    say("Message from \(mail.name)", parts.words)
                    continue
                }
                if written.hasPrefix(Wakes.marker) {
                    say("Wake-up", String(written.dropFirst(Wakes.marker.count)))
                    continue
                }
                if let work = GroupWork.parse(written) {
                    say("Work from \(work.chat)", work.task)
                    continue
                }
                let text = parts.words
                var lines = parts.comments.map { "> On \($0.location): \($0.text)" }
                // Sent with a keyword: as you typed it, the keyword in front of the words.
                if !text.isEmpty { lines.append(parts.keyword.map { "\($0) \(text)" } ?? text) }
                let attached = (user.files ?? []).compactMap(\.name) + parts.paths.map { ($0 as NSString).lastPathComponent }
                if !attached.isEmpty { lines.append("Attached: " + attached.joined(separator: ", ")) }
                if !lines.isEmpty { say(you, lines.joined(separator: "\n\n")) }
            case .assistant(let assistant):
                for block in assistant.content {
                    switch block {
                    case .text(let text) where !text.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                        say(agent, text.text.trimmingCharacters(in: .whitespacesAndNewlines))
                    case .tool(let call):
                        steps.append(ToolCallView.summary(of: call, in: directory))
                    default:
                        break
                    }
                }
            case .shell(let shell):
                let output = shell.output?.output.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                say(you, "Ran `\(shell.command)`" + (output.isEmpty ? "" : "\n\n```\n\(output)\n```"))
            case .compaction(let summary):
                if summary.status == "completed" { say(agent, "_Summarized the conversation so far._") }
                else if summary.status == "failed" { say(agent, "_Couldn’t summarize the conversation._") }
            default:
                break
            }
        }
        if !steps.isEmpty { say(agent, "") }
        return blocks.filter { !$0.isEmpty }.joined(separator: "\n\n") + "\n"
    }

    /// The whole conversation, oldest first, without what an undo took back.
    static func messages(of session: Session, api: OpenCodeAPI, pageSize: Int = 200) async throws -> [Message] {
        var page = try await api.messages(session: session.id, limit: pageSize)
        var messages = page.data
        while let cursor = page.cursor?.next ?? page.cursor?.previous, !page.data.isEmpty, messages.count < 20_000 {
            let older = try await api.messages(session: session.id, limit: pageSize, before: cursor)
            guard !older.data.isEmpty, !messages.contains(where: { $0.id == older.data.last?.id }) else { break }
            messages = older.data + messages
            page = older
        }
        if let revert = session.revert, let index = messages.firstIndex(where: { $0.id == revert.messageID }) {
            messages = Array(messages[..<index])
        }
        return messages
    }
}
