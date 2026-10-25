import Foundation
import OpenCodeKit

/// "&" in a composer: another conversation named in a message, a bot or a session, on this Mac or
/// a machine, in a session, a bot's conversation, a chat or a group chat alike. The message keeps
/// "&Name" as you wrote it; a block at its end tells the agent who each one is, with its address,
/// so it can read that conversation (read_conversation) or write to it (send_message). Your
/// bubble shows the names in color, and opens their conversations.
nonisolated enum AgentReferences {
    static let trigger: Character = "&"

    /// One named in a message: its name as written after the "&", and its address.
    struct Reference: Hashable, Sendable {
        var name: String
        var session: String
    }

    // MARK: Typing one

    /// What follows the last "&" that starts a word, on the last line of `text`, while it's being
    /// typed. It runs over spaces, as names have them ("&Fix login"): the list is open while a
    /// name goes on that way (see `matches`).
    static func query(in text: String) -> (query: String, start: String.Index)? {
        guard let at = text.lastIndex(of: trigger) else { return nil }
        if at > text.startIndex, !text[text.index(before: at)].isWhitespace { return nil }
        let query = text[text.index(after: at)...]
        if query.first?.isWhitespace == true || query.contains(where: \.isNewline) { return nil }
        return (String(query), at)
    }

    /// The agents "&" offers: every bot, and the recent sessions that have a name, but not the
    /// conversation it's written in (nor its group chat's seats, which aren't listed).
    @MainActor static func candidates(excluding session: String?) -> [AgentMail.Agent] {
        let workspace = AgentMail.shared.app?.workspace
        return AgentMail.shared.directory().filter { agent in
            agent.session != session && (agent.kind == "bot" || workspace?.session(agent.session)?.title?.isEmpty == false)
        }
    }

    /// The best matches first: the name itself, then names starting with it, then a word in the
    /// name starting with it, then names or projects containing it; past a space, only names
    /// that go on that way. Before anything's typed: the bots, then the latest sessions, as the
    /// list has them.
    @MainActor static func matches(_ query: String, in agents: [AgentMail.Agent], limit: Int = 8) -> [AgentMail.Agent] {
        let query = key(query)
        guard !query.isEmpty else { return Array(agents.prefix(limit)) }
        let words = query.contains(where: \.isWhitespace)
        func rank(_ agent: AgentMail.Agent) -> Int? {
            let name = key(agent.name)
            if name == query { return 0 }
            if name.hasPrefix(query) { return 1 }
            if words { return name.contains(query) ? 3 : nil }
            if name.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).contains(where: { $0.hasPrefix(query) }) { return 2 }
            if name.contains(query) { return 3 }
            if agent.project.map(key)?.contains(query) == true { return 4 }
            return nil
        }
        return agents.enumerated()
            .compactMap { index, agent in rank(agent).map { (agent, $0, index) } }
            .sorted { ($0.1, $0.2) < ($1.1, $1.2) }
            .prefix(limit)
            .map(\.0)
    }

    /// `text` with the name being typed after "&" replaced by `agent`'s and a space. Which one it
    /// was is kept, for when another has the same name.
    @MainActor static func insert(_ agent: AgentMail.Agent, into text: String) -> String {
        guard let (_, start) = query(in: text) else { return text }
        picked[key(agent.name)] = agent.session
        return String(text[..<start]) + String(trigger) + agent.name + " "
    }

    /// The agent last picked from the list for each name, by the name folded.
    @MainActor private static var picked: [String: String] = [:]

    private static func key(_ name: String) -> String {
        name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    // MARK: Finding them in a message

    /// Where each of `references` is named with "&" in `text`, last first, so replacing them leaves
    /// the earlier ones where they were. Longer names win ("&Miranda" isn't "&Mira"); the "&" must
    /// start a word, and the name must end where a word does.
    static func find(in text: String, references: [Reference]) -> [(range: Range<String.Index>, reference: Reference)] {
        guard text.contains(trigger) else { return [] }
        var found: [(range: Range<String.Index>, reference: Reference)] = []
        for reference in references.sorted(by: { $0.name.count > $1.name.count }) where !reference.name.isEmpty {
            var start = text.startIndex
            while let range = text.range(of: String(trigger) + reference.name, options: [.caseInsensitive, .diacriticInsensitive], range: start..<text.endIndex) {
                start = range.upperBound
                if range.lowerBound > text.startIndex, text[text.index(before: range.lowerBound)].isLetter || text[text.index(before: range.lowerBound)].isNumber { continue }
                if range.upperBound < text.endIndex, text[range.upperBound].isLetter || text[range.upperBound].isNumber { continue }
                if found.contains(where: { $0.range.overlaps(range) }) { continue }
                found.append((range, reference))
            }
        }
        return found.sorted { $0.range.lowerBound > $1.range.lowerBound }
    }

    /// The agents `texts` name with "&", each once, in the order they're first named; not those in
    /// `excluding` (the conversation they're written in). Of two with the same name, the one last
    /// picked from the list, else the first the list has (bots, then the latest sessions).
    /// `agents`: everyone (nil: as AgentMail lists them now).
    @MainActor static func named(in texts: [String], excluding: Set<String> = [], agents: [AgentMail.Agent]? = nil) -> [AgentMail.Agent] {
        guard texts.contains(where: { $0.contains(trigger) }) else { return [] }
        var byName: [String: AgentMail.Agent] = [:]
        for agent in agents ?? AgentMail.shared.directory() where !excluding.contains(agent.session) {
            let name = key(agent.name)
            if byName[name] == nil || picked[name] == agent.session { byName[name] = agent }
        }
        let references = byName.values.map { Reference(name: $0.name, session: $0.session) }
        var agents: [AgentMail.Agent] = []
        for text in texts {
            for (_, reference) in find(in: text, references: references).reversed() where !agents.contains(where: { $0.session == reference.session }) {
                if let agent = byName[key(reference.name)] { agents.append(agent) }
            }
        }
        return agents
    }

    // MARK: The block

    /// What the agent is told of them: who they are, and that it decides whether what's asked needs
    /// their conversation, a word with them, or neither (a name that only comes up).
    private static let heading = "Agents the user named with & in this message, by their address. Read one's conversation with read_conversation only when what the user asks needs what it knows or did, and write to it with send_message only to ask it something or hand it work; when the user only mentions one, do neither:"
    /// (What earlier messages said, still read as the block.)
    private static let earlierHeading = "Agents the user named with & in this message. Read one's conversation with read_conversation, or write to it with send_message, by its address:"
    private static let block = MessageBlock(start: "<named-agents>", end: "</named-agents>", headings: [heading, earlierHeading])

    /// `text` with the block that says who each agent it names with "&" is, as the agent in a
    /// conversation `here` (nil: on this Mac) reads it; not naming the conversation `excluding`.
    @MainActor static func text(_ text: String, excluding session: String?, here machine: String?) -> String {
        Self.text(text, excludingAll: Set([session].compactMap { $0 }), here: machine)
    }

    /// The same, leaving out each of `sessions` (a group chat's own bots, already there).
    @MainActor static func text(_ text: String, excludingAll sessions: Set<String>, here machine: String?, agents: [AgentMail.Agent]? = nil) -> String {
        let text = block.escaping(text)
        guard let note = note(naming: named(in: [text], excluding: sessions, agents: agents), here: machine) else { return text }
        return (text.isEmpty ? "" : text + "\n\n") + note
    }

    /// A message as it came (from the phone), with the block naming its agents among the others
    /// at its end, where `SentMessage.split` reads it: after its words, before its comments on the
    /// changes and its note of attached files. Every box does the same (`nameAgents` in
    /// kuvo-link.js); both read the cases in `Vectors/routes/names/agent-naming.json`.
    @MainActor static func naming(in message: String, excluding session: String?, here machine: String?, agents: [AgentMail.Agent]? = nil) -> String {
        // From a phone again: that it's from one is said afresh too.
        let message = FromPhone.split(message).text
        let (withComments, _) = Attachments.split(message)
        let (words, _) = ReviewComments.split(withComments)
        // Sent again (Retry, Edit) with the block it had: that goes, and its agents are named afresh.
        let bare = split(words).text
        // (One edited to name nobody now still loses the block it had.)
        guard bare.contains(trigger) || bare != words else { return message }
        let named = text(bare, excludingAll: Set([session].compactMap { $0 }), here: machine, agents: agents)
        guard named != words, let range = message.range(of: words) else { return message }
        return message.replacingCharacters(in: range, with: named)
    }

    /// The block for `agents`, nil for none: each with "&" and its name, its address, and what it is.
    @MainActor static func note(naming agents: [AgentMail.Agent], here machine: String?) -> String? {
        guard !agents.isEmpty else { return nil }
        let lines = agents.map { agent in
            "- \(trigger)\(agent.name) (\(agent.session)): \(AgentMail.what(agent, here: machine))" + (agent.about.map { $0.isEmpty ? "" : ": \($0)" } ?? "")
        }
        return ([block.start, heading] + lines + [block.end]).joined(separator: "\n")
    }

    /// A message's text without the block that ends it, and the agents it names.
    static func split(_ text: String) -> (text: String, references: [Reference]) {
        guard let (before, lines) = block.split(text) else { return (text, []) }
        // "- &Name (ses_…): what it is", read up to the first " (ses_", as a name can hold most else.
        let references = lines.dropFirst().compactMap { line -> Reference? in
            guard line.hasPrefix("- \(trigger)"), let open = line.range(of: " (ses_") else { return nil }
            let after = line[line.index(open.lowerBound, offsetBy: 2)...]
            guard let close = after.firstIndex(of: ")") else { return nil }
            let name = line[line.index(line.startIndex, offsetBy: 3)..<open.lowerBound]
            return name.isEmpty ? nil : Reference(name: String(name), session: String(after[..<close]))
        }
        return (before.trimmingCharacters(in: .whitespacesAndNewlines), references)
    }
}

/// A message you sent, as the app wrote it for the agent: your words, then the blocks it adds
/// (the agents you named with "&", your comments on the changes, the note of attached files, and
/// last that it came from your phone), taken apart again for wherever it shows: its bubble, a
/// draft, the export, a title.
nonisolated enum SentMessage {
    static func split(_ message: String) -> (text: String, comments: [ReviewComment], paths: [String], references: [AgentReferences.Reference]) {
        let (withComments, paths) = Attachments.split(FromPhone.split(message).text)
        let (withReferences, comments) = ReviewComments.split(withComments)
        let (text, references) = AgentReferences.split(withReferences)
        return (text, comments, paths, references)
    }

    /// The message as written: its words, without the blocks.
    static func words(of message: String) -> String {
        split(message).text
    }
}
