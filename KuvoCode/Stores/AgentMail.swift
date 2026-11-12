import CryptoKit
import Foundation
import KuvoLink
import OpenCodeKit
import os

/// Agents writing to each other. Any session or bot, on this Mac or a machine, can ask who else
/// there is (list_agents), send one of them a message (send_message), read its conversation
/// (read_conversation) and start a session (start_session). Every box answers these tools itself,
/// the same on all your computers (PROTOCOL.md, "Agents' tools"): this Mac's conversations' calls
/// go to this Mac's box, which reaches agents on your other computers by mail. Here: who there is,
/// as the box says, for "&" (`AgentReferences`) and the transcript, and how a message from another
/// agent reads.
@MainActor @Observable
final class AgentMail {
    static let shared = AgentMail()

    struct Agent: Codable, Hashable {
        var session: String
        var name: String
        /// "bot" or "session".
        var kind: String
        /// Where it runs: nil for this Mac.
        var machine: String?
        var project: String?
        /// A bot's job.
        var about: String?

        init(session: String, name: String, kind: String, machine: String? = nil, project: String? = nil, about: String? = nil) {
            self.session = session
            self.name = name
            self.kind = kind
            self.machine = machine
            self.project = project
            self.about = about
        }
    }

    @ObservationIgnored weak var app: AppModel?
    /// This Mac's box, as the app reaches it (a test's own).
    @ObservationIgnored var box: () -> BoxClient? = { nil }

    /// Everyone, as this Mac's box last said (`kuvo/named`): its bots and named sessions, then
    /// those of your other computers.
    var agents: [Agent] = []
    @ObservationIgnored private var asked = Date.distantPast
    @ObservationIgnored private let log = Logger(subsystem: "run.kuvo.code", category: "agents")

    // MARK: The message

    private static let opening = "[Message from "

    /// What the receiving agent reads: who it's from and how to answer, then the message (as every
    /// box words it).
    static func compose(from name: String, session: String, text: String, waits: Bool) -> String {
        let answer = waits ? "They're waiting for your reply: just answer, in your words."
            : session == "unknown" ? "It can't be answered: who sent it isn't known." : "To answer, use send_message to \(session)."
        return opening + name + " · " + session + "] (\(answer))\n\n" + text
    }

    /// A message from another agent: who sent it, and what it says. Its first line is
    /// "[Message from <name> · <session>] (…)", read from the end, as a name can hold anything.
    static func parse(_ message: String) -> (name: String, session: String, text: String)? {
        guard message.hasPrefix(opening) else { return nil }
        let first = message.prefix { $0 != "\n" }
        guard let dot = first.range(of: " · ", options: .backwards) else { return nil }
        let after = first[dot.upperBound...]
        guard let close = after.firstIndex(of: "]") else { return nil }
        let session = after[..<close]
        guard session.hasPrefix("ses_") || session == "unknown", !session.contains(" ") else { return nil }
        // No name ("[Message from · ses_1]"): the " · " is the opening's own space, before where a
        // name would start.
        let nameStart = first.index(first.startIndex, offsetBy: opening.count)
        guard dot.lowerBound >= nameStart else { return nil }
        let name = first[nameStart..<dot.lowerBound]
        let rest = message[first.endIndex...]
        let text = rest.range(of: "\n\n").map { String(rest[$0.upperBound...]) } ?? String(rest.drop { $0 == "\n" })
        return (String(name), String(session), text)
    }

    // MARK: Who there is

    /// Everyone, as this Mac's box last said.
    func directory() -> [Agent] { agents }

    /// The agent a step names, as the agent wrote it: its address, or its name, with or without
    /// the "&" the user names it with. One the list leaves out (untitled, older than the latest it
    /// names) is as this Mac has it.
    func agent(named wanted: String) -> Agent? {
        let wanted = wanted.hasPrefix("&") ? String(wanted.dropFirst()) : wanted
        return agents.first { $0.session == wanted || $0.name.caseInsensitiveCompare(wanted) == .orderedSame }
            ?? app?.workspace.session(wanted).map { Agent(session: $0.id, name: $0.title.flatMap { $0.isEmpty ? nil : $0 } ?? "New session", kind: "session") }
    }

    /// Whom a step is about, in words: the agent's name, or what the agent wrote when it named
    /// one that isn't known here; an address nobody here has never shows (it says nothing).
    func name(of wanted: String?) -> String {
        guard let wanted else { return "another agent" }
        if let agent = agent(named: wanted) { return agent.name }
        let plain = wanted.hasPrefix("&") ? String(wanted.dropFirst()) : wanted
        return plain.hasPrefix("ses_") ? "another agent" : plain
    }

    /// Who there is now, as this Mac's box says (not waited for long, `within` seconds: as it was a
    /// minute ago otherwise).
    func refresh(within seconds: Double = 3) async {
        asked = .now
        guard let client = box() else { return }
        struct Named: Decodable { var agents: [Agent] }
        guard let answer = await Self.within(seconds, { try? await client.send("GET", "kuvo/named") }), answer.status == 200,
              let named = try? JSONDecoder().decode(Named.self, from: answer.body) else { return }
        if named.agents != agents { agents = named.agents }
    }

    /// Who there is, asked again when it's been a few seconds (as "&" opens its list): a session
    /// started a moment ago is there as you name it.
    func refreshSoon() {
        guard Date.now.timeIntervalSince(asked) > 5 else { return }
        asked = .now
        Task { await refresh() }
    }

    /// Each minute.
    func tick() async {
        await refresh()
    }

    /// What an agent is, for one `here` (nil: this Mac) to read: "bot, on the Mac",
    /// "session, on devbox, in api".
    static func what(_ agent: Agent, here machine: String?) -> String {
        let place = switch agent.machine {
        case machine: machine == nil ? "on the Mac" : "here"
        case nil: "on the Mac"
        case let other?: "on \(other)"
        }
        return "\(agent.kind), \(place)" + (agent.project.map { ", in \($0)" } ?? "")
    }

    // MARK: The tools

    /// A tool's call from one of this Mac's conversations (`caller`; nil from outside one): this
    /// Mac's box answers it (`kuvo/agent-tools`). Stopped (its turn ended), the box stops waiting
    /// for an answer, which then reaches the conversation as a message.
    func call(_ name: String, arguments: [String: Any], caller: String?, inView: Bool? = nil) async -> (text: String, isError: Bool) {
        guard let client = box() else { return ("Kuvo Code isn't ready yet.", true) }
        var body: [String: Any] = ["name": name, "arguments": arguments]
        if let caller { body["session"] = caller }
        if let inView { body["inView"] = inView }
        guard JSONSerialization.isValidJSONObject(body), let data = try? JSONSerialization.data(withJSONObject: body) else {
            return ("Those arguments couldn't be read.", true)
        }
        struct Said: Decodable { var text: String?; var isError: Bool?; var message: String? }
        let answer: (status: Int, body: Data)
        do {
            answer = try await client.send("POST", "kuvo/agent-tools", body: data)
        } catch {
            log.error("An agent's \(name, privacy: .public) didn't reach this Mac's box: \(error.localizedDescription, privacy: .public)")
            return ("Kuvo Code’s background service on this Mac didn’t answer. Try again in a moment.", true)
        }
        let said = try? JSONDecoder().decode(Said.self, from: answer.body)
        guard answer.status == 200, let text = said?.text else {
            // An older box, still running a session's work after an update (the keeper makes way
            // once it's over), doesn't answer Kuvo Code's own tools yet: said plainly.
            if answer.status == 400, Self.ownTools.contains(name), await !boxAnswersOwnTools(client) { return (Self.updating, true) }
            return (said?.message ?? "Kuvo Code’s background service on this Mac didn’t answer. Try again in a moment.", true)
        }
        let failed = said?.isError ?? false
        if !failed { track(name, arguments, caller: caller) }
        // A session started: there as you name it.
        if !failed, name == "start_session" { Task { await refresh() } }
        return (text, failed)
    }

    // COMPAT(agent-tools.own): an older box still running after an update. Goes once no supported update starts from a box without `agent-tools.own`.
    /// The tools every box answers since it says `agent-tools.own` (PROTOCOL.md, "Agents' tools").
    static let ownTools: Set<String> = ["schedule_wake_up", "watch_for_change", "list_wake_ups", "cancel_wake_up", "set_job", "show_in_panel", "show_file", "mark_final", "show_widget"]
    /// What an agent hears from one of them while an older box runs on after an update.
    static let updating = "Kuvo Code on this Mac is finishing an update, and its background service can't do this until the work that's running ends. Try again later; if you work on your own, say what's left in your reply."

    /// Whether this Mac's box says it answers them.
    private func boxAnswersOwnTools(_ client: BoxClient) async -> Bool {
        struct Info: Decodable { var features: [String]? }
        guard let info = try? await client.value(Info.self, "GET", "kuvo/info") else { return true }
        return info.features?.contains("agent-tools.own") == true
    }

    private func track(_ name: String, _ arguments: [String: Any], caller: String?) {
        let waits = (arguments["wait"] as? NSNumber)?.boolValue ?? false
        switch name {
        case "send_message": Analytics.shared.track("agent_message_sent", ["waits": waits])
        case "read_conversation": Analytics.shared.track("agent_conversation_read", ["query": (arguments["query"] as? String)?.isEmpty == false])
        case "start_session": Analytics.shared.track("agent_started_session", ["waits": waits])
        case "schedule_wake_up", "watch_for_change":
            let isBot = caller.flatMap { caller in app?.bots.bot(forSession: app?.workspace.root(of: caller) ?? caller) } != nil
            let repeats = name == "watch_for_change" || (arguments["every"] as? String)?.isEmpty == false
            Analytics.shared.track(isBot ? "bot_wake_added" : "session_wake_added", ["repeats": repeats, "by": "agent"])
        default: break
        }
    }

    // MARK: This Mac's group chats

    /// Where this Mac's box keeps the list of everyone, as a machine's keeps `run/agents.json`
    /// there: what its group chats name with & (`KUVO_AGENTS_FILE`).
    static var boxDirectoryFile: URL { BoxProcess.run.appending(path: "agents.json") }

    /// This Mac's box's list of everyone, made again from this Mac's conversations as they are now
    /// (one made a moment ago, say), before a group chat names someone with &.
    func refreshBoxDirectory() async {
        guard let client = box() else { return }
        // (Not waited for long: the list as it was a minute ago, rather than nothing sent.)
        _ = await Self.within(3) { try? await client.send("POST", "kuvo/link/agents/refresh").status }
    }

    /// What `work` gives, or nil once `seconds` went by first (it's stopped then).
    nonisolated static func within<T: Sendable>(_ seconds: Double, _ work: @escaping @Sendable () async -> T?) async -> T? {
        await withTaskGroup(of: T?.self) { group in
            group.addTask { await work() }
            group.addTask {
                try? await Task.sleep(for: .seconds(seconds))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}

extension AgentMail {
    // COMPAT(beta.1 mac-letters): `agent-letters.json`, `agent-letters-seen.json` and `agent-messages.json`, handed to the box. Goes 3 months after 0.8.0.
    // MARK: What an earlier Kuvo Code kept

    /// A message an earlier Kuvo Code kept for an agent whose machine was away, until it was back.
    struct Waiting: Codable, Equatable {
        var from: String?
        var name: String
        var to: String
        var machine: String
        var text: String
    }

    /// A letter an earlier Kuvo Code sent by mail itself, until its machine said it had it.
    struct Mailing: Codable {
        var id: String
        var from: String?
        var to: String
        var machine: String
        var text: String
        var at: Double
        var answers: String?
    }

    static let mailingFile = AppInfo.supportDirectory.appending(path: "agent-letters.json")
    static let announcedFile = AppInfo.supportDirectory.appending(path: "agents-elsewhere.json")
    static let seenFile = AppInfo.supportDirectory.appending(path: "agent-letters-seen.json")
    static let waitingFile = AppInfo.supportDirectory.appending(path: "agent-messages.json")

    /// Its letters on their way, the messages it kept for a machine that was away, and the letters
    /// it delivered (so one sent again isn't twice), to this Mac's box (`client`), which sends and
    /// takes them now: before it meets your other computers (`PhoneLink.follow`). Its files go once
    /// the box has them; a message for a machine not set up for your other computers yet stays
    /// for a later start. What it was told of your other computers' agents just goes: they tell the
    /// box again.
    func handOver(to client: BoxClient) async {
        guard let app else { return }
        try? FileManager.default.removeItem(at: Self.announcedFile)
        let mailing = JSONFile.read([Mailing].self, from: Self.mailingFile) ?? []
        let waiting = JSONFile.read([Waiting].self, from: Self.waitingFile) ?? []
        let seen = JSONFile.read([String: Double].self, from: Self.seenFile) ?? [:]
        guard [Self.mailingFile, Self.seenFile, Self.waitingFile].contains(where: { FileManager.default.fileExists(atPath: $0.path) }) else { return }
        struct Letter: Encodable { var id: String; var from: String?; var to: String; var text: String; var peer: String; var at: Double; var answers: String? }
        struct Taken: Encodable { var letters: [Letter]; var seen: [String: Double] }
        // To a machine set up for your other computers still; any other's has nowhere to go.
        let now = (Date.now.timeIntervalSince1970 * 1000).rounded()
        let letters = mailing.compactMap { letter in
            app.phoneLink.key(of: letter.machine).map { Letter(id: letter.id, from: letter.from, to: letter.to, text: letter.text, peer: $0, at: letter.at, answers: letter.answers) }
        } + waiting.compactMap { message in
            // The same each time it's handed over, so one the box has already isn't sent twice.
            let id = "wtg_" + SHA256.hash(data: Data([message.from ?? "", message.to, message.text].joined(separator: "\u{0}").utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
            return app.phoneLink.key(of: message.machine).map { Letter(id: id, from: message.from, to: message.to, text: message.text, peer: $0, at: now) }
        }
        guard let (status, _) = try? await client.send("POST", "kuvo/link/letters/take", body: try? JSONEncoder().encode(Taken(letters: letters, seen: seen))),
              status == 200 else { return }
        for file in [Self.mailingFile, Self.seenFile] { try? FileManager.default.removeItem(at: file) }
        let left = waiting.filter { app.phoneLink.key(of: $0.machine) == nil }
        if left.isEmpty {
            try? FileManager.default.removeItem(at: Self.waitingFile)
        } else {
            log.error("\(left.count, privacy: .public) messages for agents on machines not set up for your other computers yet wait for a later start")
            JSONFile.write(left, to: Self.waitingFile)
        }
    }
}
