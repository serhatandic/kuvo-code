import Foundation
import KuvoLink
import OpenCodeKit
import os

/// Agents writing to each other. Any session or bot, on this Mac or a machine, can ask who else
/// there is (list_agents), send one of them a message (send_message) and read its conversation
/// (read_conversation). The message reaches that conversation as input that says who sent it, as
/// a wake-up says what it is, and the agent there takes it up; with `wait`, the sender gets its
/// answer back. Machines get the list of everyone, and leave messages for this Mac or other
/// machines in an outbox it empties. You name one in a message with "&" (`AgentReferences`).
@MainActor
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
    }

    weak var app: AppModel?

    /// A message waiting for its agent's machine to be back, kept until then (across launches).
    struct Waiting: Codable, Equatable {
        var from: String?
        var name: String
        var to: String
        var machine: String
        var text: String
    }

    private static var waitingFile: URL { AppInfo.supportDirectory.appending(path: "agent-messages.json") }
    private var waiting: [Waiting] = JSONFile.read([Waiting].self, from: AgentMail.waitingFile) ?? []

    /// What each machine whose link talks to your other computers said its agents are, the newest
    /// (by mail, `mailed`), kept across launches: one away now is listed as it last said.
    fileprivate var announced: [String: Announced] = JSONFile.read([String: Announced].self, from: AgentMail.announcedFile) ?? [:]
    /// Letters this Mac sent by mail, until each is there (kept across launches).
    fileprivate var mailing: [Mailing] = JSONFile.read([Mailing].self, from: AgentMail.mailingFile) ?? []
    fileprivate var tried: [String: Date] = [:]
    /// Conversations waiting for a letter's answer, by letter, with the machine it went to.
    fileprivate var answers: [String: (machine: String, waiting: CheckedContinuation<Answer, Never>)] = [:]
    /// What each machine was last told of this Mac's agents, and when, and which went (the first
    /// of them, when not all fit in a mail).
    fileprivate var announcedTo: [String: (data: Data, at: Date, told: Set<String>)] = [:]
    /// Letters from machines being delivered now: one that comes again meanwhile waits for that one.
    fileprivate var delivering: Set<String> = []

    /// Delivers what waited for `engine`'s machine, now it's back, straight to its engine (its
    /// session needn't be among the latest the list names). Each leaves the list once it's there:
    /// one that doesn't get there (the machine went again) waits for the next time, unless its
    /// session is gone. It was counted against its sender's messages when it was sent.
    func deliverWaiting(to engine: MachineEngine) async {
        let machine = engine.machine.id
        for letter in waiting where letter.machine == machine {
            guard engine.api != nil else { return }
            // Where its session is: known, or its engine's, else its coding agents' (their bridge
            // there); gone only when both say so.
            let known = app?.workspace.session(letter.to).flatMap { app?.workspace.api(for: $0) }
            let places = known.map { [$0] } ?? [engine.api, engine.agents.api].compactMap(\.self)
            var gone = !places.isEmpty
            var sent = false
            for api in places where !sent {
                do {
                    // Moving to another computer: it waits here for the next time.
                    guard try await Deliveries.send(Self.compose(from: letter.name, session: letter.from ?? "unknown", text: letter.text, waits: false),
                                                    to: letter.to, delivery: .steer, later: true, on: api) else {
                        gone = false
                        break
                    }
                    sent = true
                    Analytics.shared.track("agent_message_sent", ["waits": false, "bot": app?.bots.bot(forSession: letter.to) != nil])
                } catch {
                    log.error("A message for \(machine, privacy: .public) didn't go: \(error.localizedDescription, privacy: .public)")
                    if (error as? ServerError)?.status != 404 { gone = false }
                }
            }
            // Not there yet (its bridge starting, the connection dropped): next time. While its
            // coding agents' bridge can't be reached, it can't say a session of theirs is gone.
            if !sent && (!gone || engine.hasAgentsBridge && engine.agents.api == nil && known == nil) { continue }
            if let index = waiting.firstIndex(of: letter) { waiting.remove(at: index) }
            save()
        }
    }

    /// A machine found to be another one here, at another address (`Machines.fold`): what
    /// waited for it waits for the other, and goes when that's connected.
    func fold(_ machine: String, into other: String) {
        forgetAnnounced(machine)
        guard waiting.contains(where: { $0.machine == machine }) else { return }
        for index in waiting.indices where waiting[index].machine == machine { waiting[index].machine = other }
        save()
    }

    private func save() {
        if waiting.isEmpty {
            try? FileManager.default.removeItem(at: Self.waitingFile)
        } else {
            JSONFile.write(waiting, to: Self.waitingFile)
        }
    }

    /// Messages sent lately, by the conversation that sent them, to keep two agents from
    /// writing back and forth for ever.
    private var sent: [String: [Date]] = [:]
    private let log = Logger(subsystem: "run.kuvo.code", category: "agents")

    // MARK: The message

    private static let opening = "[Message from "

    /// What the receiving agent reads: who it's from and how to answer, then the message.
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

    /// Every bot, and the sessions of the last while: not a sub-agent's, a group chat's seat,
    /// nor one put away.
    func directory() -> [Agent] {
        guard let app else { return [] }
        let workspace = app.workspace
        var agents = app.bots.list.map { bot in
            Agent(session: bot.sessionID, name: bot.name, kind: "bot", machine: bot.machine, project: nil, about: bot.job)
        }
        let bots = Set(agents.map(\.session))
        let recent = workspace.sessions
            .filter { $0.parentID == nil && !Workspace.isArchived($0) && !bots.contains($0.id) && !workspace.seats.contains($0.id) }
            .sorted { $0.time.updated > $1.time.updated }
            .prefix(40)
        for session in recent {
            let directory = session.location.directory
            agents.append(Agent(session: session.id, name: session.title ?? "New session", kind: "session",
                                machine: RemoteFolder.machine(of: directory), project: workspace.projectName(directory)))
        }
        // Machines this Mac isn't connected to now: their agents as they last said (by mail), not
        // one another lists too (one of them could be claiming the other's).
        var listed = Set(agents.map(\.session))
        for (machine, told) in announced.sorted(by: { $0.key < $1.key }) where app.machines.engine(machine)?.isReady != true {
            for agent in told.list where !listed.contains(agent.session) && !listedElsewhere(agent.session, than: machine) {
                listed.insert(agent.session)
                agents.append(Agent(session: agent.session, name: agent.name, kind: agent.kind, machine: machine, project: agent.project, about: agent.about))
            }
        }
        return agents
    }

    /// Whether `agent` is on a machine this Mac isn't connected to now (its sessions can't be
    /// reached through it, only by mail).
    private func isAway(_ agent: Agent) -> Bool {
        agent.machine.map { app?.machines.engine($0)?.isReady != true } ?? false
    }

    /// A conversation known here by its address that the list doesn't name (older than the latest
    /// it names): one an agent could be, not a subagent's, a group chat's seat, nor one put away.
    private func addressed(_ wanted: String) -> Agent? {
        guard wanted.hasPrefix("ses_"), let app, let session = app.workspace.session(wanted), session.parentID == nil,
              !Workspace.isArchived(session), !app.workspace.seats.contains(wanted) else { return nil }
        let directory = session.location.directory
        return Agent(session: wanted, name: session.title ?? "New session", kind: app.bots.bot(forSession: wanted) == nil ? "session" : "bot",
                     machine: RemoteFolder.machine(of: directory), project: app.workspace.projectName(directory))
    }

    /// The agent a conversation is, by its session.
    private func agent(_ session: String?) -> Agent? {
        directory().first { $0.session == session }
    }

    /// The list, for an agent to read.
    static func describe(_ agents: [Agent], caller: String?, here machine: String?) -> String {
        let others = agents.filter { $0.session != caller }
        guard !others.isEmpty else { return "No other agents yet." }
        let lines = others.map { agent in
            var line = "- \(agent.name) (\(what(agent, here: machine))) address: \(agent.session)"
            if let about = agent.about, !about.isEmpty { line += ": \(about)" }
            return line
        }
        return "Agents you can write to with send_message, or whose conversation you can read with read_conversation (by name or address):\n" + lines.joined(separator: "\n")
    }

    /// What an agent is, for one `here` (nil: this Mac) to read: "bot, on the Mac",
    /// "session, on lokum, in api".
    static func what(_ agent: Agent, here machine: String?) -> String {
        let place = switch agent.machine {
        case machine: machine == nil ? "on the Mac" : "here"
        case nil: "on the Mac"
        case let other?: "on \(other)"
        }
        return "\(agent.kind), \(place)" + (agent.project.map { ", in \($0)" } ?? "")
    }

    // MARK: Sending

    /// The tools' calls from this Mac's conversations.
    func call(_ name: String, arguments: [String: Any], caller: String?) async -> (text: String, isError: Bool) {
        // A subagent writes, reads and starts sessions as its conversation: its name, its
        // folder, its approval, where answers go.
        let caller = caller.map { app?.workspace.root(of: $0) ?? $0 }
        // A bot's seat in a group chat only talks and looks things up, whatever agent it runs on:
        // the work happens in each bot's own conversation, handed out after the wrap-up.
        if let caller, app?.workspace.seats.contains(caller) == true, name == "send_message" || name == "start_session" {
            return ("Not from a group chat: talk it through here; the work is handed out after the wrap-up.", true)
        }
        switch name {
        case "list_agents":
            return (Self.describe(directory(), caller: caller, here: nil), false)
        case "read_conversation":
            guard let of = (arguments["of"] as? String)?.trimmingCharacters(in: .whitespaces), !of.isEmpty else { return ("Say whose conversation to read (of).", true) }
            let query = (arguments["query"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return await read(of, query: query?.isEmpty == false ? query : nil, caller: caller)
        case "send_message":
            guard let to = arguments["to"] as? String, !to.trimmingCharacters(in: .whitespaces).isEmpty else { return ("Say who to write to (to).", true) }
            guard let text = arguments["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return ("Say what to write (text).", true) }
            let sender = agent(caller)
            return await send(from: caller, name: sender?.name ?? "another agent", to: to, text: text, waits: (arguments["wait"] as? NSNumber)?.boolValue ?? false)
        case "start_session":
            return await start(arguments, caller: caller)
        default:
            return ("Unknown tool \(name).", true)
        }
    }

    /// Delivers `text` from the conversation `caller` (named `name`) to the agent `to` (a name or
    /// an address), wherever it runs; with `waits`, waits for its answer and returns it.
    func send(from caller: String?, name: String, to: String, text: String, waits: Bool) async -> (text: String, isError: Bool) {
        switch await deliver(from: caller, name: name, to: to, text: text, waits: waits) {
        case .done(let text): (text, false)
        case .unknown(let text), .refused(let text), .limited(let text), .failed(let text): (text, true)
        }
    }

    /// How a message went: there (or waiting for its machine), to no agent this Mac knows (one
    /// another Mac does may take it), not one to send (too many), or not there now, and worth
    /// sending again.
    private enum Outcome {
        /// `limited`: too many lately; it can go in a while.
        case done(String), unknown(String), refused(String), limited(String), failed(String)

        var text: String {
            switch self {
            case .done(let text), .unknown(let text), .refused(let text), .limited(let text), .failed(let text): text
            }
        }
    }

    /// Who a message or a read is for: the agent, or why there's none to take.
    private enum Lookup {
        case found(Agent), missing(Outcome)
    }

    /// The agent `wanted` names (its address, or its name, with or without the "&" you name it
    /// with), or why there's none to take.
    private func find(_ wanted: String, caller: String?) -> Lookup {
        let agents = directory()
        var wanted = wanted.trimmingCharacters(in: .whitespaces)
        if wanted.hasPrefix(String(AgentReferences.trigger)), !agents.contains(where: { $0.name == wanted }) { wanted.removeFirst() }
        let matches = agents.filter { $0.session == wanted } .nilIfEmpty
            ?? addressed(wanted).map { [$0] }
            ?? agents.filter { $0.name.compare(wanted, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }
        guard let target = matches.first else {
            // Part of a name ("Release" for "Release notes"): those it could be.
            let close = agents.filter { $0.name.range(of: wanted, options: [.caseInsensitive, .diacriticInsensitive]) != nil }.prefix(8)
            let hint = close.isEmpty ? "Use list_agents to see who there is." : "Did you mean one of these?\n" + Self.describe(Array(close), caller: caller, here: nil)
            return .missing(.unknown("There's no agent called \(wanted). " + hint))
        }
        guard matches.count == 1 else {
            return .missing(.refused("More than one agent is called \(wanted): use one's address.\n" + Self.describe(matches, caller: caller, here: nil)))
        }
        return .found(target)
    }

    /// `limitKey`: what the few-at-a-time limit counts by, when not the caller (a machine's
    /// letters, whose sender anything there could claim).
    /// `prompted`: once it's in the conversation (before any answer); `answered`: its answer (nil
    /// for none), when waiting for one. `mailed`: it came by mail, and isn't mailed on.
    private func deliver(from caller: String?, name: String, to: String, text: String, waits: Bool, limitKey: String? = nil, mailed: Bool = false,
                         prompted: (() -> Void)? = nil, answered: ((String?) -> Void)? = nil) async -> Outcome {
        var target: Agent
        switch find(to, caller: caller) {
        case .found(let found): target = found
        case .missing(let outcome): return outcome
        }
        guard target.session != caller else { return .refused("That's you.") }
        // Moving to another computer: once it's over, to it where it lives then.
        do {
            try await Deliveries.settled(target.session)
        } catch {
            return .failed("\(target.name) is moving to another computer. Try again in a minute.")
        }
        switch find(to, caller: caller) {
        case .found(let found): target = found
        case .missing(let outcome): return outcome
        }
        // A few at a time: two agents shouldn't keep writing to each other unattended. Counted as
        // it starts, before anything's awaited, so messages sent at once count each other; taken
        // back if it doesn't go, so one tried again isn't counted twice.
        let key = limitKey ?? caller ?? "outside"
        let lately = (sent[key] ?? []).filter { $0.timeIntervalSinceNow > -600 }
        guard lately.count < 20 else {
            return .limited("You've sent a lot of messages in the last few minutes. Wait a while, or ask the user how to go on.")
        }
        let counted = Date.now
        sent[key] = lately + [counted]
        // Its machine isn't connected to this Mac, but its link talks to your other computers:
        // by mail, through the relay.
        let away = isAway(target)
        if !mailed, away, let app, let machine = target.machine, app.phoneLink.reachesByMail(machine) {
            return await mailLetter(from: caller, to: target, machine: machine, text: text, waits: waits)
        }
        guard let app, !away, let api = app.workspace.api(forSession: target.session) else {
            // Its machine is away: it goes when it's back.
            guard let machine = target.machine else {
                sent[key]?.removeAll { $0 == counted }
                return .failed("\(target.name) can't be reached now. Try again later.")
            }
            waiting.append(Waiting(from: caller, name: name, to: target.session, machine: machine, text: text))
            save()
            return .done("\(target.name)'s machine (\(machine)) is away: the message goes to it as soon as it's back\(waits ? ", and its answer comes to you as a message" : "").")
        }
        let id = Identifier.message()
        // What it had said already, so its answer is what comes after. Unknown (it couldn't be
        // read), there's no telling its answer from those: it comes as a message instead.
        let known = waits ? await Self.replies(in: target.session, api: api) : []
        let waits = waits && known != nil
        do {
            try await Deliveries.send(Self.compose(from: name, session: caller ?? "unknown", text: text, waits: waits), to: target.session, id: id, delivery: .steer, on: api)
        } catch {
            sent[key]?.removeAll { $0 == counted }
            return .failed("It didn't reach \(target.name): \(error.localizedDescription)")
        }
        Analytics.shared.track("agent_message_sent", ["waits": waits, "bot": target.kind == "bot"])
        prompted?()
        guard waits else { return .done("Sent to \(target.name). Its answer, if it writes one, comes to you as a message.") }
        let reply = await reply(in: target.session, to: id, known: known ?? [], api: api)
        answered?(reply)
        if let reply { return .done("\(target.name) answered:\n\n" + reply) }
        return .done("\(target.name) hasn't answered yet. It may still write back with send_message.")
    }

    // MARK: Reading another's conversation

    /// About how much of a conversation goes back at once, in characters.
    private static let readLimit = 24_000

    /// The conversation of the agent `wanted` (a name or an address), as you'd read it: what the
    /// user and others wrote, its replies and a line for each step, as the export words them. A
    /// long one gives its start and its latest part; with `query`, the parts that mention it.
    func read(_ wanted: String, query: String?, caller: String?) async -> (text: String, isError: Bool) {
        let target: Agent
        switch find(wanted, caller: caller) {
        case .found(let found): target = found
        case .missing(let outcome): return (outcome.text, true)
        }
        guard target.session != caller else { return ("That's this conversation: you have it already.", true) }
        guard let app, !isAway(target), let api = app.workspace.api(forSession: target.session) else {
            return ("\(target.name)'s conversation can't be read now" + (target.machine.map { ": its machine (\($0)) isn't connected" } ?? "") + ". Try again later, or write to it with send_message.", true)
        }
        let session: Session
        let messages: [Message]
        do {
            if let known = app.workspace.session(target.session) { session = known } else { session = try await api.session(target.session) }
            messages = try await ConversationExport.messages(of: session, api: api)
        } catch {
            return ("Couldn't read \(target.name)'s conversation: \(error.localizedDescription)", true)
        }
        Analytics.shared.track("agent_conversation_read", ["bot": target.kind == "bot", "query": query != nil])
        let markdown = ConversationExport.markdown(title: target.name, messages: messages, directory: session.location.directory,
                                                   you: "User", agent: target.name)
        let intro = "\(target.name)'s conversation (\(Self.what(target, here: nil)), address \(target.session)), oldest first. What's under **User** is the user's; under **\(target.name)**, its agent's.\n\n"
        return (intro + Self.excerpt(markdown, query: query, limit: Self.readLimit), false)
    }

    /// As much of `text` as `limit` allows: all of it; with `query`, the paragraphs around each
    /// mention of it; else its first part (how it began) and its latest. What's left out is marked.
    nonisolated static func excerpt(_ text: String, query: String?, limit: Int) -> String {
        let paragraphs = text.components(separatedBy: "\n\n")
        if let query {
            let hits = paragraphs.indices.filter { paragraphs[$0].range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
            guard !hits.isEmpty else { return "Nothing in it mentions \"\(query)\". Read it without query for its latest part." }
            // Each with the paragraph before and after it (who's speaking, and what came next),
            // the latest first as room runs out.
            var shown = Set<Int>()
            var used = 0
            for hit in hits.reversed() {
                let around = (max(0, hit - 1)...min(paragraphs.count - 1, hit + 1)).filter { !shown.contains($0) }
                let size = around.reduce(0) { $0 + paragraphs[$1].count + 2 }
                if used + size > limit, !shown.isEmpty { break }
                shown.formUnion(around)
                used += size
            }
            var parts: [String] = []
            var last: Int?
            for index in shown.sorted() {
                if let last, index > last + 1 { parts.append("[…]") }
                parts.append(String(paragraphs[index].prefix(limit)))
                last = index
            }
            let found = hits.count == 1 ? "1 place mentions" : "\(hits.count) places mention"
            return "\(found) \"\(query)\"" + (shown.count < paragraphs.count ? " (the rest left out as […])" : "") + ":\n\n" + parts.joined(separator: "\n\n")
        }
        guard text.count > limit else { return text }
        // How it began: the title and the first message.
        var head = paragraphs.prefix(3).joined(separator: "\n\n")
        if head.count > limit / 4 { head = String(head.prefix(limit / 4)) + "…" }
        var tail: [String] = []
        var used = head.count
        for paragraph in paragraphs.dropFirst(3).reversed() {
            if used + paragraph.count + 2 > limit {
                if tail.isEmpty { tail.append("…" + String(paragraph.suffix(limit - used))) }
                break
            }
            tail.insert(paragraph, at: 0)
            used += paragraph.count + 2
        }
        return head + "\n\n[… the middle is left out; read it with query, to find a part …]\n\n" + tail.joined(separator: "\n\n")
    }

    // MARK: Starting another

    /// Sessions an agent started lately, by the conversation that started them.
    private var started: [String: [Date]] = [:]

    /// A new session from the conversation `caller`: an agent of its own, in the caller's folder
    /// (or the one given), on the caller's model, with the caller's approval (yours by default for
    /// one from outside a session), so Ask First isn't got around. It gets `task` as a
    /// message from the caller, so it knows who to report to, and its metadata says who started it,
    /// for the window to show it beside them.
    func start(_ arguments: [String: Any], caller: String?) async -> (text: String, isError: Bool) {
        guard let app else { return ("Kuvo Code isn't ready yet.", true) }
        guard let task = (arguments["task"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !task.isEmpty else {
            return ("Say what it's to do (task).", true)
        }
        let workspace = app.workspace
        let parent = caller.flatMap { workspace.session($0) }
        // A bot's own folder is its own: a session it starts there would be listed nowhere, so
        // it's a chat.
        var folder = parent.map { Workspace.isBotFolder($0.location.directory) ? Workspace.chatsFolder : $0.location.directory }
        if let given = (arguments["folder"] as? String)?.trimmingCharacters(in: .whitespaces), !given.isEmpty {
            let path = (given as NSString).expandingTildeInPath
            var isFolder: ObjCBool = false
            guard path.hasPrefix("/"), FileManager.default.fileExists(atPath: path, isDirectory: &isFolder), isFolder.boolValue else {
                return ("\(given) isn't a folder on this Mac. Give a full path to one.", true)
            }
            folder = Workspace.isBotFolder(path) ? Workspace.chatsFolder : path
        }
        guard let folder else { return ("Give the folder it works in (folder), as a full path.", true) }
        // A few at a time: an agent shouldn't fill the window with sessions unattended.
        let key = caller ?? "outside"
        let lately = (started[key] ?? []).filter { $0.timeIntervalSinceNow > -600 }
        guard lately.count < 6 else {
            return ("You've started several sessions in the last few minutes. Write to those (send_message), or ask the user before starting more.", true)
        }
        started[key] = lately + [.now]
        let approval = parent.map { ToolApproval(rules: $0.permissions) } ?? UserDefaults.standard.string(forKey: ToolApproval.key).flatMap(ToolApproval.init) ?? .approveAll
        let session: Session
        do {
            session = try await workspace.createSession(in: folder, model: parent?.model, agent: nil, approval: approval)
        } catch {
            return ("Couldn't start a session in \(folder): \(error.localizedDescription)", true)
        }
        guard let api = workspace.api(forSession: session.id) else { return ("Couldn't reach the new session.", true) }
        let title = (arguments["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let title, !title.isEmpty { try? await api.renameSession(session.id, title: title) }
        let beside = (arguments["beside"] as? NSNumber)?.boolValue ?? true
        try? await api.setMetadata(session: session.id, .object(["kuvo": .object(["startedBy": .string(caller ?? ""), "beside": .bool(beside)])]))
        let waits = (arguments["wait"] as? NSNumber)?.boolValue ?? false
        let id = Identifier.message()
        do {
            try await Deliveries.send(Self.compose(from: agent(caller)?.name ?? "another agent", session: caller ?? "unknown", text: task, waits: waits), to: session.id, id: id, delivery: .steer, on: api)
        } catch {
            return ("Started a session (\(session.id)), but the task didn't reach it: \(error.localizedDescription)", true)
        }
        Analytics.shared.track("agent_started_session", ["waits": waits, "beside": beside])
        let name = title.flatMap { $0.isEmpty ? nil : "\"\($0)\"" } ?? "a new session"
        let place = Workspace.isChat(folder) ? "" : " in \(workspace.projectName(folder))"
        let shown = beside ? ", beside this conversation" : ", in a tab"
        guard waits else {
            return ("Started \(name)\(place)\(shown) (address \(session.id)). It's on it now. Write to it with send_message; it can write back to you the same way.", false)
        }
        // A new session: anything it says is its answer.
        if let reply = await reply(in: session.id, to: id, known: [], api: api) {
            return ("Started \(name)\(place) (address \(session.id)). It answered:\n\n" + reply, false)
        }
        return ("Started \(name)\(place) (address \(session.id)). It hasn't answered yet; it may still write back with send_message.", false)
    }

    /// The replies `session` has given so far, to tell its answer to a message sent now from them;
    /// nil when they can't be read (tried a few times, as the engine may be reconnecting).
    private static func replies(in session: String, api: OpenCodeAPI) async -> Set<String>? {
        for attempt in 0..<3 {
            if attempt > 0 { try? await Task.sleep(for: .seconds(1)) }
            guard let messages = try? await api.messages(session: session, limit: 20).data else { continue }
            return Set(messages.compactMap { if case .assistant(let assistant) = $0 { assistant.id } else { nil } })
        }
        return nil
    }

    /// The answer in `session` to the message `id` sent to it: its words once it's done, ten
    /// minutes at most, or until the caller stops. What it says after `id` once that's there
    /// (not what a turn already under way said, nor while it still waits to go in); what isn't
    /// among the replies `known` from before when it's further back than the latest. (Not by
    /// comparing IDs' order, nor where they come in the list: a machine's are made from its own
    /// clock.)
    private func reply(in session: String, to id: String, known: Set<String>, api: OpenCodeAPI) async -> String? {
        let began = Date.now
        var started = false
        while Date.now.timeIntervalSince(began) < 600, !Task.isCancelled {
            guard (try? await Task.sleep(for: .seconds(2))) != nil else { return nil }
            if app?.workspace.running.contains(session) == true {
                started = true
                continue
            }
            // Done; or not seen at work (a quick one, between looks): its words after ours.
            guard started || Date.now.timeIntervalSince(began) > 6 else { continue }
            guard let messages = try? await api.messages(session: session, limit: 20).data else { continue }
            let after: ArraySlice<Message>
            if let ours = messages.firstIndex(where: { $0.id == id }) {
                after = messages[(ours + 1)...]
            } else if messages.count >= 20, messages.allSatisfy({ if case .assistant(let step) = $0 { !known.contains(step.id) } else { true } }) {
                // A long answer: ours is further back.
                after = messages[...]
            } else {
                // Still waiting to go in, after the turn it found under way.
                started = false
                continue
            }
            let words = after.compactMap { message -> String? in
                guard case .assistant(let assistant) = message, !known.contains(assistant.id) else { return nil }
                let text = assistant.content.compactMap { if case .text(let part) = $0 { part.text } else { nil } }.joined(separator: "\n")
                return text.isEmpty ? nil : text
            }
            if !words.isEmpty { return String(words.joined(separator: "\n\n").prefix(8000)) }
            if started { return nil }
        }
        return nil
    }

    // MARK: Machines

    /// The list as a machine's agents read it (`run/agents.json` there): which machine it is,
    /// and everyone.
    struct Directory: Codable {
        var machine: String
        var agents: [Agent]
    }

    /// Puts the list of everyone on `engine`'s machine, for its agents, when it's changed. (One
    /// whose link talks to your other computers makes its own, from what each tells it.)
    func share(with engine: MachineEngine) async {
        let machine = engine.machine.id
        // Sorted: JSONEncoder writes a struct's keys in another order almost every time, and an
        // unchanged list would go again each minute.
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        // One whose link talks to your other computers makes its list itself: this Mac's agents,
        // as it mails them, for when the relay can't be reached (`run/mac-agents.json`).
        if app?.phoneLink.talksToPeers(machine) == true {
            guard let key = app?.phoneLink.macKey, let list = try? encoder.encode(announcedList()), shared[machine] != list,
                  let told = try? JSONSerialization.jsonObject(with: list),
                  let data = try? JSONSerialization.data(withJSONObject: ["key": key, "at": Self.now, "list": told] as [String: Any]) else { return }
            let file = "\"$HOME/\(RemoteEngineInstaller.root)/run/mac-agents.json\""
            let script = "umask 077; mkdir -p \"$HOME/\(RemoteEngineInstaller.root)/run\" && printf %s '\(data.base64EncodedString())' | base64 -d >\(file).new && mv -f \(file).new \(file)"
            if await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value != nil { shared[machine] = list }
            return
        }
        guard let data = try? encoder.encode(Directory(machine: machine, agents: directory())), shared[machine] != data else { return }
        let encoded = data.base64EncodedString()
        let file = "\"$HOME/\(RemoteEngineInstaller.root)/run/agents.json\""
        let script = "umask 077; mkdir -p \"$HOME/\(RemoteEngineInstaller.root)/run\" && printf %s '\(encoded)' | base64 -d >\(file).new && mv -f \(file).new \(file)"
        if await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value != nil { shared[machine] = data }
    }

    /// What each machine was last given.
    private var shared: [String: Data] = [:]

    /// Delivers what `engine`'s machine's agents left for agents elsewhere. Each letter's file
    /// there goes once it's delivered, or can't ever be; one that can't go now (the engine it's
    /// for is starting over, or the machine sent many lately), or whose reading was cut off, goes
    /// next time. One for an agent this Mac doesn't know waits two days, for another Mac connected
    /// to the machine that may, and so does one held back that long.
    func collect(from engine: MachineEngine) async {
        // One at a time for a machine, or two would deliver the same letters; one asked for
        // meanwhile runs once after.
        let machine = engine.machine.id
        guard collecting.insert(machine).inserted else {
            collectAgain.insert(machine)
            return
        }
        defer { collecting.remove(machine) }
        repeat {
            collectAgain.remove(machine)
            await collectOnce(from: engine)
        } while collectAgain.contains(machine)
    }

    /// Machines whose letters are being collected, and those to collect again after.
    private var collecting: Set<String> = []
    private var collectAgain: Set<String> = []

    private func collectOnce(from engine: MachineEngine) async {
        let machine = engine.machine.id
        let folder = "\"$HOME/\(RemoteEngineInstaller.root)/run/outbox\""
        // Each taken first (renamed `.mac-<this Mac>-…`, so neither a machine's link that takes
        // back what it left for a Mac nor another Mac delivers it too), then as its file's name,
        // when it was written and its letter (on one line, as it's written), between tabs.
        let mine = ".mac-\(MachineEngine.macID)-"
        let script = "cd \(folder) 2>/dev/null || exit 0; for f in *.json; do [ -f \"$f\" ] && mv -f \"$f\" \"\(mine)$f\"; done; for f in \(mine)*.json; do [ -f \"$f\" ] || continue; printf '%s\\t%s\\t' \"$f\" \"$(stat -c %Y \"$f\" 2>/dev/null || echo 0)\"; tr -d '\\n' <\"$f\"; printf '\\n'; done"
        guard let output = await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value else { return }
        struct Letter: Decodable { var from: String?; var name: String?; var to: String; var text: String; var wait: Bool?; var via: String? }
        var done: [String] = [], taken: [String] = []
        for line in String(decoding: output, as: UTF8.self).split(separator: "\n") {
            let fields = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
            guard fields.count == 3 else { continue }
            let file = String(fields[0])
            taken.append(file)
            let written = Date(timeIntervalSince1970: Double(fields[1]) ?? 0)
            guard let letter = try? JSONDecoder().decode(Letter.self, from: Data(fields[2].utf8)) else {
                log.error("A message from \(machine, privacy: .public) couldn't be read")
                done.append(file)
                continue
            }
            // The machine's link's to send, by mail: not this Mac's.
            if letter.via == "link" { continue }
            // Anything on the machine can write a letter, so who it's from is taken only from an
            // agent that is there; else it's "an agent on" it. Counted by the machine.
            let sender = letter.from.flatMap { from in directory().first { $0.session == from && $0.machine == machine } }
            switch await deliver(from: sender?.session, name: sender?.name ?? "an agent on \(machine)", to: letter.to, text: letter.text, waits: false, limitKey: "machine:" + machine) {
            case .done:
                done.append(file)
            case .unknown(let why), .limited(let why):
                guard written.timeIntervalSinceNow < -2 * 86_400 else { continue }
                log.error("A message from \(machine, privacy: .public) didn't go: \(why, privacy: .public)")
                done.append(file)
            case .refused(let why):
                log.error("A message from \(machine, privacy: .public) didn't go: \(why, privacy: .public)")
                done.append(file)
            case .failed(let why):
                log.error("A message from \(machine, privacy: .public) didn't go yet: \(why, privacy: .public)")
            }
        }
        // Those that didn't go back where they were, for next time (or another Mac, or the link).
        let back = taken.filter { !done.contains($0) && $0.hasPrefix(mine) }
            .map { "mv -f -- \(SSHConnection.quoted($0)) \(SSHConnection.quoted(String($0.dropFirst(mine.count))))" }
        let removed = done.isEmpty ? [] : ["rm -f -- " + done.map(SSHConnection.quoted).joined(separator: " ")]
        guard !(back + removed).isEmpty else { return }
        let tidy = (["cd \(folder) || exit 0"] + removed + back).joined(separator: "; ")
        _ = await Task.detached(operation: { RemoteShell.run(tidy, on: machine) }).value
    }
}

// MARK: - Your other computers, by mail (PROTOCOL.md, "Peers")

extension AgentMail {
    /// An agent as a machine tells it (its own, by mail): no `machine`, which is the one that told.
    struct Told: Codable {
        var session: String
        var name: String
        var kind: String
        var project: String?
        var about: String?
        /// For the agents this Mac speaks for (on machines whose link doesn't talk to other
        /// computers yet): where each is.
        var machine: String?
    }

    /// A letter this Mac sent by mail, until its machine says it has it: one of its agents', or an
    /// answer to a letter from that machine (`answers`).
    struct Mailing: Codable, Equatable {
        var id: String
        var from: String?
        var to: String
        var toName: String
        var machine: String
        var text: String
        var wait: Bool
        var at: Double
        var answers: String?
    }

    static let mailingFile = AppInfo.supportDirectory.appending(path: "agent-letters.json")
    static let announcedFile = AppInfo.supportDirectory.appending(path: "agents-elsewhere.json")
    static let seenFile = AppInfo.supportDirectory.appending(path: "agent-letters-seen.json")

    struct Announced: Codable {
        var at: Double
        var list: [Told]
    }

    private static let letterLife: Double = 86_400_000
    private static let letterMemory: Double = 2 * 86_400_000

    fileprivate static var now: Double { (Date.now.timeIntervalSince1970 * 1000).rounded() }

    static func isLetterID(_ id: String) -> Bool {
        id.range(of: #"\A[A-Za-z0-9_-]{6,80}\z"#, options: .regularExpression) != nil
    }

    /// A machine's mail, through the relay: its agents, a letter for one here (an answer to one of
    /// this Mac's, perhaps), or how one this Mac sent went.
    func mailed(_ payload: [String: Any], from machine: String) async {
        if let agents = payload["agents"] as? [String: Any] { takeAgents(agents, from: machine) }
        // It's just connected, and may have missed what this Mac told it: told again next minute.
        if payload["ask"] as? String == "agents" { announcedTo[machine] = nil }
        // How a letter went: only from the machine it went to.
        if let delivered = payload["delivered"] as? [String: Any], let id = delivered["id"] as? String, mailing.contains(where: { $0.id == id && $0.machine == machine }) {
            letterWent(id, ok: delivered["ok"] as? Bool == true, why: delivered["why"] as? String, retry: delivered["retry"] as? Bool == true,
                       answer: delivered["answer"] as? Bool)
        }
        if let letter = payload["letter"] as? [String: Any] { await takeLetter(letter, from: machine) }
    }

    private func takeAgents(_ given: [String: Any], from machine: String) {
        guard let at = given["at"] as? Double, at > (announced[machine]?.at ?? 0), let list = given["list"] as? [[String: Any]],
              let data = try? JSONSerialization.data(withJSONObject: list), let told = try? JSONDecoder().decode([Told].self, from: data) else { return }
        let fits = told.filter { $0.session.hasPrefix("ses_") && ($0.kind == "bot" || $0.kind == "session") }.prefix(120)
        announced[machine] = Announced(at: at, list: fits.map { Told(session: $0.session, name: String($0.name.prefix(200)), kind: $0.kind, project: $0.project, about: $0.about, machine: nil) })
        JSONFile.write(announced, to: Self.announcedFile)
    }

    /// A machine removed (or found to be another one here): what it said goes.
    func forgetAnnounced(_ machine: String) {
        guard announced.removeValue(forKey: machine) != nil else { return }
        JSONFile.write(announced, to: Self.announcedFile)
    }

    /// A machine removed: what it said goes, and messages for it, waiting for it or by mail, don't
    /// (a conversation waiting for an answer hears so).
    func machineRemoved(_ machine: String) {
        forgetAnnounced(machine)
        announcedTo[machine] = nil
        if waiting.contains(where: { $0.machine == machine }) {
            waiting.removeAll { $0.machine == machine }
            save()
        }
        for letter in mailing where letter.machine == machine {
            letterWent(letter.id, ok: false, why: "Its machine was removed.", retry: false, answer: nil)
        }
    }

    /// Whether `session` is listed by a machine other than `machine`, or is this Mac's own: then
    /// `machine` listing it too proves nothing (it could be claiming another's).
    func listedElsewhere(_ session: String, than machine: String) -> Bool {
        // Moved from there: what it still says of it is stale until it's let go.
        if let left = app?.workspace.movedAway[session], left == machine { return true }
        return announced.contains { $0.key != machine && $0.value.list.contains { $0.session == session } }
            || app?.workspace.session(session).map { RemoteFolder.machine(of: $0.location.directory) != machine } == true
            || app?.bots.bot(forSession: session).map { $0.machine != machine } == true
    }

    /// Who a machine's letter is from: one of its own agents, as it told them (and no other
    /// computer lists it), or one this Mac knows is there; nil for anyone else there.
    private func sender(_ from: String?, on machine: String) -> (session: String, name: String)? {
        guard let from else { return nil }
        if let told = announced[machine]?.list.first(where: { $0.session == from }) {
            return listedElsewhere(from, than: machine) ? nil : (from, told.name)
        }
        return directory().first { $0.session == from && $0.machine == machine }.map { ($0.session, $0.name) }
    }

    /// The agents this Mac tells your machines of: its own, and those of machines it speaks for
    /// (whose link doesn't talk to other computers yet). A letter by mail goes only to one of them.
    func announcedList() -> [Told] {
        guard let app else { return [] }
        return directory().filter { agent in agent.machine.map { !app.phoneLink.talksToPeers($0) && announced[$0] == nil } ?? true }
            .prefix(120)
            .map { Told(session: $0.session, name: String($0.name.prefix(200)), kind: $0.kind, project: $0.project.map { String($0.prefix(200)) },
                        about: $0.about.map { String($0.prefix(500)) }, machine: $0.machine) }
    }

    /// A letter from a machine, for an agent here: delivered once, said to be there (or why not,
    /// and whether to try again), and with `wait`, answered by a letter back. Who it's from is
    /// that machine's own agent, by the name it gave it; otherwise "an agent on" it, with no
    /// address to answer. An answer to a letter of this Mac's goes to the conversation waiting for
    /// it, or as a message to the one that sent it.
    private func takeLetter(_ letter: [String: Any], from machine: String) async {
        guard let id = letter["id"] as? String, Self.isLetterID(id) else { return }
        let say: ([String: Any]) -> Void = { [weak self] message in
            Task { _ = await self?.app?.phoneLink.mail(message.merging(["at": Self.now]) { $1 }, to: machine) }
        }
        let no: (String, Bool) -> Void = { why, again in
            say(["delivered": ["id": id, "ok": false, "why": why].merging(again ? ["retry": true] : [:]) { $1 }])
        }
        guard let at = letter["at"] as? Double, abs(Self.now - at) < Self.letterLife else { return no("It's too old to deliver.", false) }
        guard let to = letter["to"] as? String, let text = letter["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return no("That isn't a letter.", false)
        }
        guard !delivering.contains(id) else { return }
        guard !seenAlready(id) else { return say(["delivered": ["id": id, "ok": true]]) }
        let sender = sender(letter["from"] as? String, on: machine)
        // An answer a conversation here waits for: to it.
        if let answered = letter["answers"] as? String, let waiting = answers[answered], waiting.machine == machine {
            answers.removeValue(forKey: answered)
            waiting.waiting.resume(returning: .text(Self.prefix(text, bytes: 32_000)))
            noteSeen(id)
            return say(["delivered": ["id": id, "ok": true]])
        }
        // To a conversation here an agent could be: this Mac's, or one of a machine this Mac speaks
        // for (not a subagent's, a group chat's seat, nor one put away). Not known while this
        // Mac's sessions load: it comes again.
        guard let app else { return }
        guard to.hasPrefix("ses_") else { return no("That isn't a letter.", false) }
        guard let session = app.workspace.session(to) else { return no(app.workspace.isLoaded ? "There's no such conversation here." : "Its computer is just starting.", !app.workspace.isLoaded) }
        guard session.parentID == nil, !Workspace.isArchived(session), !app.workspace.seats.contains(to) else {
            return no("That conversation doesn't take messages.", false)
        }
        // On a machine that talks to your other computers itself now: its own list reaches them
        // soon, and the letter goes there then.
        if let machine = RemoteFolder.machine(of: session.location.directory), app.phoneLink.talksToPeers(machine) {
            return no("Its computer takes its own letters now.", true)
        }
        delivering.insert(id)
        defer { delivering.remove(id) }
        let wantsAnswer = letter["wait"] as? Bool == true
        let noAnswer = "Its answer can't come back to you: it doesn't know who you are."
        var acknowledged = false
        let outcome = await deliver(from: sender?.session, name: sender?.name ?? "an agent on \(machine)", to: to, text: String(text.prefix(32_000)),
                                    waits: wantsAnswer && sender != nil, limitKey: "machine:" + machine, mailed: true, prompted: { [weak self] in
            acknowledged = true
            self?.noteSeen(id)
            say(["delivered": ["id": id, "ok": true].merging(wantsAnswer && sender == nil ? ["answer": false, "why": noAnswer] : [:]) { $1 }])
        }, answered: { [weak self] answer in
            guard let answer, let sender else { return }
            self?.answer(from: to, to: sender.session, text: answer, answers: id, on: machine)
        })
        switch outcome {
        case .done(let said):
            // Waiting for its machine to be back (one this Mac speaks for): there, but no answer
            // to wait for now.
            guard !acknowledged else { break }
            noteSeen(id)
            say(["delivered": ["id": id, "ok": true].merging(wantsAnswer ? ["answer": false, "why": said] : [:]) { $1 }])
        case .limited(let why), .failed(let why):
            no(why, true)
        case .unknown(let why), .refused(let why):
            no(why, false)
        }
    }

    /// Whether letter `id` came already (two days' worth remembered).
    private func seenAlready(_ id: String) -> Bool {
        let now = Self.now
        return (JSONFile.read([String: Double].self, from: Self.seenFile) ?? [:]).contains { $0.key == id && now - $0.value < Self.letterMemory }
    }

    /// Letter `id` delivered: one that comes again is said to be there, not delivered twice.
    private func noteSeen(_ id: String) {
        let now = Self.now
        var seen = (JSONFile.read([String: Double].self, from: Self.seenFile) ?? [:]).filter { now - $0.value < Self.letterMemory }
        seen[id] = now
        JSONFile.write(seen, to: Self.seenFile)
    }

    // MARK: Letters this Mac sends by mail

    private static func letterID() -> String {
        "mac" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    /// A letter for an agent on a machine this Mac isn't connected to, whose link talks to your
    /// other computers: sent now, and each minute until it's there; with `waits`, its answer (an
    /// answer that comes after the wait reaches the conversation as a message).
    private func mailLetter(from caller: String?, to target: Agent, machine: String, text: String, waits: Bool) async -> Outcome {
        // Without a conversation to answer, there's no waiting for an answer.
        let letter = Mailing(id: Self.letterID(), from: caller, to: target.session, toName: target.name, machine: machine, text: String(text.prefix(32_000)),
                             wait: waits && caller != nil, at: Self.now)
        mailing.append(letter)
        saveMailing()
        Analytics.shared.track("agent_message_sent", ["waits": letter.wait, "bot": target.kind == "bot", "mailed": true])
        // Its sender, told of to that machine first (one made a moment ago, say), so it's taken
        // for one of this Mac's agents.
        if let caller, !toldOf(caller, to: machine) {
            announcedTo[machine] = nil
            await announce()
        }
        guard letter.wait else {
            await send(letter)
            return .done("On its way to \(target.name) on \(machine). Its answer, if it writes one, comes to you as a message.")
        }
        let answer = await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                answers[letter.id] = (machine, continuation)
                Task { [weak self] in await self?.send(letter) }
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(660))
                    self?.gaveUp(letter.id)
                }
            }
        } onCancel: {
            // Its turn stopped: an answer that comes later reaches the conversation as a message.
            Task { @MainActor [weak self] in self?.gaveUp(letter.id) }
        }
        switch answer {
        case .text(let reply?): return .done("\(target.name) answered:\n\n" + reply)
        case .failed(let why): return .failed("It didn't reach \(target.name): \(why)")
        case .note(let note): return .done(note)
        case .text(nil): return .done("\(target.name) hasn't answered yet. It may still write back with send_message.")
        }
    }

    enum Answer { case text(String?), failed(String), note(String) }

    /// This Mac's answer to a machine's letter, from the agent it was for: sent as a letter of its
    /// own, until it's there.
    private func answer(from session: String, to: String, text: String, answers: String, on machine: String) {
        let letter = Mailing(id: Self.letterID(), from: session, to: to, toName: "", machine: machine, text: String(text.prefix(8000)), wait: false, at: Self.now, answers: answers)
        mailing.append(letter)
        saveMailing()
        Task { await send(letter) }
    }

    /// No more waiting for letter `id`'s answer: it goes on without waiting, and an answer that
    /// comes later reaches its conversation as a message.
    private func gaveUp(_ id: String) {
        guard let waiting = answers.removeValue(forKey: id)?.waiting else { return }
        waiting.resume(returning: .text(nil))
        if let index = mailing.firstIndex(where: { $0.id == id }) {
            mailing[index].wait = false
            saveMailing()
        }
    }

    /// Mails it, its words cut to fit what the relay takes (UTF-8, and escaped as JSON, they can
    /// be several times as many bytes as characters), as a machine's bridge does (`letterMail`).
    private func send(_ letter: Mailing) async {
        guard let app else { return }
        tried[letter.id] = .now
        for most in [24_000, 6000, 2000] {
            var sent: [String: Any] = ["id": letter.id, "from": letter.from as Any? ?? NSNull(), "to": letter.to, "text": Self.prefix(letter.text, bytes: most),
                                       "wait": letter.wait, "at": letter.at]
            if let answers = letter.answers { sent["answers"] = answers }
            switch await app.phoneLink.mail(["letter": sent, "at": Self.now], to: letter.machine) {
            case .sent, .offline: return
            case .tooBig: continue
            }
        }
        letterWent(letter.id, ok: false, why: "It's too long to send.", retry: false, answer: nil)
    }

    /// As much of `text` as fits in `bytes` of UTF-8, whole characters.
    static func prefix(_ text: String, bytes: Int) -> String {
        var count = 0
        var end = text.startIndex
        for index in text.indices {
            count += text[index].utf8.count
            if count > bytes { break }
            end = text.index(after: index)
        }
        return String(text[..<end])
    }

    /// How a letter went, from its machine: there (with `wait`, its answer to come, unless
    /// `answer` is false); not now (`retry`: it goes again, for two days); or not at all.
    private func letterWent(_ id: String, ok: Bool, why: String?, retry: Bool, answer: Bool?) {
        guard let index = mailing.firstIndex(where: { $0.id == id }) else { return }
        if !ok, retry, Self.now - mailing[index].at < Self.letterMemory { return }
        let letter = mailing.remove(at: index)
        saveMailing()
        tried[id] = nil
        if !ok {
            log.error("A message for \(letter.machine, privacy: .public) didn't go: \(why ?? "", privacy: .public)")
            answers.removeValue(forKey: id)?.waiting.resume(returning: .failed(why ?? "It wasn't delivered."))
        } else if answer == false {
            answers.removeValue(forKey: id)?.waiting.resume(returning: .note(why ?? "\(letter.toName) got your message, but its answer can't come back to you here."))
        }
    }

    private func saveMailing() {
        if mailing.isEmpty { try? FileManager.default.removeItem(at: Self.mailingFile) } else { JSONFile.write(mailing, to: Self.mailingFile) }
    }

    /// Each minute: letters not there yet, again (two days at most), and this Mac's agents told to
    /// your machines whose link talks to other computers, as they change (and every ten minutes).
    func tick() async {
        guard let app else { return }
        let now = Self.now
        tried = tried.filter { entry in mailing.contains { $0.id == entry.key } }
        for letter in mailing {
            if now - letter.at > Self.letterMemory {
                letterWent(letter.id, ok: false, why: "Its machine couldn't be reached.", retry: false, answer: nil)
                continue
            }
            guard app.phoneLink.reachesByMail(letter.machine), Date.now.timeIntervalSince(tried[letter.id] ?? .distantPast) >= 55 else { continue }
            await send(letter)
        }
        await announce()
    }

    /// Whether `machine` was last told `session` is one of this Mac's agents.
    private func toldOf(_ session: String, to machine: String) -> Bool {
        announcedTo[machine]?.told.contains(session) == true
    }

    /// This Mac's agents, as your machines whose link talks to other computers hear them
    /// (`announcedList`).
    private func announce() async {
        guard let app else { return }
        let list = announcedList()
        guard let data = try? JSONEncoder().encode(list) else { return }
        let now = Date.now
        for machine in app.machines.list.map(\.id) where app.phoneLink.reachesByMail(machine) {
            if let last = announcedTo[machine], last.data == data, now.timeIntervalSince(last.at) < 600 { continue }
            // As many as fit in one mail: the first (bots, then the latest sessions) first.
            for count in [list.count, list.count / 2, list.count / 4] where count > 0 || list.isEmpty {
                guard let encoded = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(Array(list.prefix(count)))) else { break }
                // With this Mac's digest of documents, so a machine that missed one gets it now.
                var payload: [String: Any] = ["agents": ["at": Self.now, "list": encoded], "at": Self.now]
                if let have = app.phoneLink.documentsDigest() { payload["docs"] = ["have": have] }
                let mailed = await app.phoneLink.mail(payload, to: machine)
                if mailed == .sent { announcedTo[machine] = (data, now, Set(list.prefix(count).map(\.session))) }
                if mailed != .tooBig { break }
            }
        }
    }
}

private extension Array {
    var nilIfEmpty: Self? { isEmpty ? nil : self }
}
