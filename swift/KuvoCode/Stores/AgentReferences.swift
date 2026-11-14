import ClientSessions
import ClientText
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

    /// The agents "&" offers: every bot, and the recent sessions that have a name, wherever they
    /// are (as this Mac's box names them), but not the conversation it's written in (nor its group
    /// chat's seats, which aren't listed).
    @MainActor static func candidates(excluding session: String?) -> [AgentMail.Agent] {
        AgentMail.shared.refreshSoon()
        return AgentMail.shared.directory().filter { $0.session != session }
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
        // Longer first, as folded (as every box sorts them: `namesIn` in kuvo-link.js).
        for reference in references.sorted(by: { key($0.name).count > key($1.name).count }) where !reference.name.isEmpty {
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

    /// The agents picked from the list for names in `text`, by their address: of two with one name,
    /// these are the ones its box names (`MessageParts.Sending.named`).
    @MainActor static func picked(in text: String) -> [String] {
        guard text.contains(trigger) else { return [] }
        let folded = key(text)
        return picked.compactMap { name, session in folded.contains(String(trigger) + name) ? session : nil }.sorted()
    }
}

/// A message, as its box keeps its parts (KuvoClient's `MessageParts`, PROTOCOL.md "A message's
/// parts"): your words and what went with them (the keyword it was sent with, the widget it came
/// from, the agents you named with "&", your comments on the changes, the files it named, that it
/// came from your phone), or another agent's message, for wherever it shows: its bubble, a draft,
/// the export, a title. A command shows as you typed it.
enum SentMessage {
    @MainActor static func parts(_ user: Message.User) -> MessageParts {
        if let command = CommandMessages.shared[user.id] { return MessageParts(words: command) }
        return MessageParts.of(id: user.id, text: user.text, metadata: user.metadata)
    }

    static func parts(_ item: Transcript.Pending) -> MessageParts {
        MessageParts.of(id: item.id, text: item.text, metadata: item.metadata)
    }

    /// The parts of those of `messages` from before, which keep none, read by `box` (their
    /// conversation's): before they show, so none shows the blocks written for the agent. One its
    /// box can't read shows as it was written.
    /// A message's parts before a draft or a send is made of it: kept with it, read already, or read
    /// now by `box` (a few seconds at most); nil when they can't be read, and then its text is never
    /// sent as words (it goes again as it was, or stays where it is, saying so).
    @MainActor static func ensure(id: String, text: String, metadata: JSONValue?, from box: BoxClient?) async -> MessageParts? {
        if let command = CommandMessages.shared[id] { return MessageParts(words: command) }
        if let parts = MessageParts.kept(in: metadata) ?? MessageParts.known(id, text: text) { return parts }
        guard let box else { return nil }
        _ = await AgentMail.within(3) { await MessageParts.read([(id, text)]) { body in try await box.send("POST", MessageParts.partsRoute, body: body) } }
        return MessageParts.known(id, text: text)
    }

    /// A message's parts, if they're known now (kept, read, or a command): nil for one not read yet.
    @MainActor static func knownParts(id: String, text: String, metadata: JSONValue?) -> MessageParts? {
        if let command = CommandMessages.shared[id] { return MessageParts(words: command) }
        return MessageParts.kept(in: metadata) ?? MessageParts.known(id, text: text)
    }

    /// `messages` with the parts their box read written into each, as a saved copy keeps them: a
    /// conversation shown from its copy (its computer away) draws them as it did.
    static func keepingRead(_ messages: [Message]) -> [Message] {
        messages.map { message in
            guard case .user(var user) = message, MessageParts.kept(in: user.metadata) == nil, let parts = MessageParts.known(user.id, text: user.text) else { return message }
            user.metadata = MessageParts.keeping(parts, in: user.metadata)
            return .user(user)
        }
    }

    /// `waiting`: those in the engine's queue too. At most a few seconds: a box slow to answer leaves
    /// the rest to show as written meanwhile, to be read again later.
    @MainActor static func read(_ messages: [Message], waiting: [InboxItem] = [], from box: BoxClient?) async {
        let unread = MessageParts.unread(in: messages) { CommandMessages.shared[$0] != nil } + MessageParts.unread(waiting: waiting)
        guard !unread.isEmpty, let box else { return }
        _ = await AgentMail.within(3) { await MessageParts.read(unread) { body in try await box.send("POST", MessageParts.partsRoute, body: body) } }
    }
}

extension MessageParts {
    /// Its comments on the changes, as the composer keeps them.
    var reviewComments: [ReviewComment] { comments.map(ReviewComment.init) }
    var references: [AgentReferences.Reference] { agents.map { AgentReferences.Reference(name: $0.name, session: $0.session) } }
}
