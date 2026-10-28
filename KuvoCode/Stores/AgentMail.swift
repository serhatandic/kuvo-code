import ClientDesign
import Foundation
import KuvoLink
import OpenCodeKit
import os

/// Agents writing to each other. Any session or bot, on this Mac or a machine, can ask who else
/// there is (list_agents), send one of them a message (send_message) and read its conversation
/// (read_conversation). The message reaches that conversation as input that says who sent it, as
/// a wake-up says what it is, and the agent there takes it up; with `wait`, the sender gets its
/// answer back. Machines get the list of everyone, and leave messages for this Mac or other
/// machines in an outbox it empties. Your other computers that this Mac meets at the relay are
/// reached through this Mac's box, which tells them who this Mac's agents are, sends this Mac's
/// letters and takes theirs (PROTOCOL.md, "Peers"). You name one in a message with "&"
/// (`AgentReferences`).
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
        /// A bot's id (`bot_…`, as group chats name their members) and how it looks, so a chat on
        /// another computer can have it and show it.
        var id: String? = nil
        var look: BotLook? = nil
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

    /// What each machine whose link talks to your other computers said its agents are, as this
    /// Mac's box has it (`refreshElsewhere`): one away now is listed as it last said.
    fileprivate var announced: [String: Announced] = [:]

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
            Agent(session: bot.sessionID, name: bot.name, kind: "bot", machine: bot.machine, project: nil, about: bot.job, id: bot.id, look: bot.look)
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
                agents.append(Agent(session: agent.session, name: agent.name, kind: agent.kind, machine: machine, project: agent.project, about: agent.about, id: agent.id, look: agent.look))
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
        // Who's on your other computers, as this Mac's box has heard just now.
        if ["list_agents", "send_message", "read_conversation"].contains(name) { await refreshElsewhere() }
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
    enum Outcome: Equatable {
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
    private func deliver(from caller: String?, name: String, to: String, text: String, waits: Bool, limitKey: String? = nil) async -> Outcome {
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
        // by mail, through the relay, as this Mac's box sends it.
        let away = isAway(target)
        if away, let app, let machine = target.machine, app.phoneLink.reachesByMail(machine), let peer = app.phoneLink.key(of: machine) {
            let outcome = await mailLetter(from: caller, to: target, machine: machine, peer: peer, text: text, waits: waits)
            if case .failed = outcome { sent[key]?.removeAll { $0 == counted } }
            return outcome
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
        guard waits else { return .done("Sent to \(target.name). Its answer, if it writes one, comes to you as a message.") }
        let reply = await reply(in: target.session, to: id, known: known ?? [], api: api)
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
    /// for the sidebar to list it under them (it opens nothing by itself).
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
        try? await api.setMetadata(session: session.id, .object(["kuvo": .object(["startedBy": .string(caller ?? "")])]))
        let waits = (arguments["wait"] as? NSNumber)?.boolValue ?? false
        let id = Identifier.message()
        do {
            try await Deliveries.send(Self.compose(from: agent(caller)?.name ?? "another agent", session: caller ?? "unknown", text: task, waits: waits), to: session.id, id: id, delivery: .steer, on: api)
        } catch {
            return ("Started a session (\(session.id)), but the task didn't reach it: \(error.localizedDescription)", true)
        }
        Analytics.shared.track("agent_started_session", ["waits": waits])
        let name = title.flatMap { $0.isEmpty ? nil : "\"\($0)\"" } ?? "a new session"
        let place = Workspace.isChat(folder) ? "" : " in \(workspace.projectName(folder))"
        guard waits else {
            return ("Started \(name)\(place) (address \(session.id)). It's on it now. Write to it with send_message; it can write back to you the same way.", false)
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

    /// Where this Mac's box keeps the list of everyone, as a machine's keeps `run/agents.json`
    /// there: what its group chats name with & (`KUVO_AGENTS_FILE`).
    static var boxDirectoryFile: URL { BoxProcess.run.appending(path: "agents.json") }

    /// This Mac's box's list of everyone, made again from this Mac's conversations as they are now
    /// (one made a moment ago, say), before a group chat names someone with &.
    func refreshBoxDirectory() async {
        guard let client = app?.box(BoxClient.mac) else { return }
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
        /// A bot's id and look (PROTOCOL.md, "Peers": agents).
        var id: String? = nil
        var look: BotLook? = nil

        init(session: String, name: String, kind: String, project: String?, about: String?, machine: String?, id: String? = nil, look: BotLook? = nil) {
            self.session = session
            self.name = name
            self.kind = kind
            self.project = project
            self.about = about
            self.machine = machine
            self.id = id
            self.look = look
        }

        private enum Key: String, CodingKey { case session, name, kind, project, about, machine, id, look }

        /// A look this app doesn't draw (a newer computer's) is none, rather than the whole list unread.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            self.init(session: try c.decode(String.self, forKey: .session), name: try c.decode(String.self, forKey: .name), kind: try c.decode(String.self, forKey: .kind),
                      project: try c.decodeIfPresent(String.self, forKey: .project), about: try c.decodeIfPresent(String.self, forKey: .about),
                      machine: try c.decodeIfPresent(String.self, forKey: .machine), id: try? c.decodeIfPresent(String.self, forKey: .id),
                      look: try? c.decodeIfPresent(BotLook.self, forKey: .look))
        }
    }

    /// The time, in milliseconds, as your other computers count it.
    fileprivate static var now: Double { (Date.now.timeIntervalSince1970 * 1000).rounded() }

    struct Announced: Codable {
        var at: Double
        var list: [Told]
    }

    /// What your other computers told this Mac's box their agents are (`kuvo/link/agents`), by
    /// machine: each one this Mac set up, as its box answers.
    func refreshElsewhere() async {
        guard let client = app?.box(BoxClient.mac) else { return }
        // (Not waited for long: as it was a minute ago otherwise.)
        guard let data = await Self.within(3, { try? await client.send("GET", "kuvo/link/agents") }), data.status == 200 else { return }
        takeElsewhere(answer: data.body)
    }

    /// Those, from this Mac's box's answer (`kuvo/link/agents`).
    func takeElsewhere(answer: Data) {
        struct Peer: Decodable { var id: String?; var at: Double; var list: [Told] }
        struct Given: Decodable { var peers: [Peer] }
        guard let given = try? JSONDecoder().decode(Given.self, from: answer) else { return }
        takeElsewhere(given.peers.map { ($0.id, Announced(at: $0.at, list: $0.list)) })
    }

    /// Those, kept by machine (one the box names that isn't one of this Mac's machines, left out).
    func takeElsewhere(_ peers: [(machine: String?, told: Announced)]) {
        guard let app else { return }
        let machines = Set(app.machines.list.map(\.id))
        var kept: [String: Announced] = [:]
        for (machine, told) in peers {
            guard let machine, machines.contains(machine), told.at > 0 else { continue }
            let list = told.list.filter { $0.session.hasPrefix("ses_") && ($0.kind == "bot" || $0.kind == "session") }.prefix(120)
            kept[machine] = Announced(at: told.at, list: list.map { Told(session: $0.session, name: String($0.name.prefix(200)), kind: $0.kind, project: $0.project,
                                                                        about: $0.about, machine: nil, id: $0.kind == "bot" ? $0.id : nil, look: $0.kind == "bot" ? $0.look : nil) })
        }
        announced = kept
    }

    /// A machine removed (or found to be another one here): what it said goes.
    func forgetAnnounced(_ machine: String) {
        announced.removeValue(forKey: machine)
    }

    /// A machine removed: what it said goes, and messages waiting for it don't.
    func machineRemoved(_ machine: String) {
        forgetAnnounced(machine)
        if waiting.contains(where: { $0.machine == machine }) {
            waiting.removeAll { $0.machine == machine }
            save()
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

    /// Whether a group chat on `chat`'s computer (nil: this Mac) can name `agent`: its own, and the
    /// agents of computers it meets at the relay. One on a machine that doesn't meet them there
    /// has the list this Mac gives it over SSH, everyone.
    func reachable(_ agent: Agent, fromChatOn chat: String?) -> Bool {
        guard let link = app?.phoneLink else { return true }
        if let chat, !link.talksToPeers(chat) { return true }
        guard let machine = agent.machine, machine != chat else { return true }
        return link.talksToPeers(machine)
    }

    /// The agents this Mac tells your machines of over SSH, for when the relay can't be reached
    /// (`share`): its own, and those of machines it speaks for (whose link doesn't talk to other
    /// computers yet).
    func announcedList() -> [Told] {
        guard let app else { return [] }
        return directory().filter { agent in agent.machine.map { !app.phoneLink.talksToPeers($0) && announced[$0] == nil } ?? true }
            .prefix(120)
            .map { Told(session: $0.session, name: String($0.name.prefix(200)), kind: $0.kind, project: $0.project.map { String($0.prefix(200)) },
                        about: $0.about.map { String($0.prefix(500)) }, machine: $0.machine, id: $0.id, look: $0.look) }
    }

    /// A letter for an agent on a machine this Mac isn't connected to, whose link talks to your
    /// other computers (`peer`, its key): left with this Mac's box, which sends it now, and each
    /// minute until it's there; with `waits`, its answer (one that comes after the wait reaches the
    /// conversation as a message).
    private func mailLetter(from caller: String?, to target: Agent, machine: String, peer: String, text: String, waits: Bool) async -> Outcome {
        guard let app else { return .failed("\(target.name) can't be reached now. Try again later.") }
        struct Letter: Encodable { var peer: String; var from: String?; var to: String; var text: String; var wait: Bool }
        // Without a conversation to answer, there's no waiting for an answer.
        let wait = waits && caller != nil
        guard let body = try? JSONEncoder().encode(Letter(peer: peer, from: caller, to: target.session, text: String(text.prefix(32_000)), wait: wait)) else {
            return .failed("It didn't reach \(target.name).")
        }
        let request = LinkRequest(method: "POST", path: "kuvo/link/letters", headers: ["content-type": "application/json"], body: body)
        let outcome = await Self.mailed(app.box(BoxClient.mac).transport.send(request), to: target.name, on: machine, waits: wait)
        if case .failed = outcome {} else { Analytics.shared.track("agent_message_sent", ["waits": wait, "bot": target.kind == "bot", "mailed": true]) }
        return outcome
    }

    /// What this Mac's box answered a letter (`kuvo/link/letters`): it's kept (a line with its id),
    /// then, when it's waited for, how it went (a line with its answer, or why not). An answer cut
    /// off once it was kept (the box started again, say) still went: its answer comes as a message.
    static func mailed(_ parts: AsyncThrowingStream<LinkResponsePart, Error>, to name: String, on machine: String, waits: Bool) async -> Outcome {
        let onItsWay = "On its way to \(name) on \(machine). Its answer, if it writes one, comes to you as a message."
        var status = 0
        var buffer = Data()
        var said: [[String: Any]] = []
        let take = { (line: Data) in if let json = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] { said.append(json) } }
        do {
            for try await part in parts {
                switch part {
                case .head(let code, _): status = code
                case .body(let data):
                    buffer += data
                    while let end = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                        take(buffer[buffer.startIndex..<end])
                        buffer.removeSubrange(buffer.startIndex...end)
                    }
                }
            }
            if !buffer.isEmpty { take(buffer) }
        } catch {
            guard (200..<300).contains(status), said.contains(where: { $0["id"] is String }) else { return .failed("It didn't reach \(name): \(error.localizedDescription)") }
            return .done(onItsWay)
        }
        guard (200..<300).contains(status), let answer = said.last else {
            return .failed("It didn't reach \(name)" + ((said.last?["message"] as? String).map { ": \($0)" } ?? "."))
        }
        if let failed = answer["failed"] as? String { return .failed("It didn't reach \(name): \(failed)") }
        if let note = answer["note"] as? String { return .done(note) }
        guard waits else { return .done(onItsWay) }
        if let reply = answer["text"] as? String { return .done("\(name) answered:\n\n" + reply) }
        return .done("\(name) hasn't answered yet. It may still write back with send_message.")
    }

    /// Each minute: who your other computers' agents are, as this Mac's box has them now.
    func tick() async {
        await refreshElsewhere()
    }

    // COMPAT(beta.1 mac-letters): `agent-letters.json` and `agent-letters-seen.json`, handed to the box. Goes 3 months after 0.8.0.
    // MARK: What an earlier Kuvo Code kept

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

    /// Its letters on their way, and the letters it delivered (so one sent again isn't twice),
    /// to this Mac's box (`client`), which sends and takes them now: before it meets your other
    /// computers (`PhoneLink.follow`). Its files go once the box has them. What it was told of
    /// your other computers' agents just goes: they tell the box again.
    func handOver(to client: BoxClient) async {
        guard let app else { return }
        try? FileManager.default.removeItem(at: Self.announcedFile)
        let mailing = JSONFile.read([Mailing].self, from: Self.mailingFile) ?? []
        let seen = JSONFile.read([String: Double].self, from: Self.seenFile) ?? [:]
        guard [Self.mailingFile, Self.seenFile].contains(where: { FileManager.default.fileExists(atPath: $0.path) }) else { return }
        struct Letter: Encodable { var id: String; var from: String?; var to: String; var text: String; var peer: String; var at: Double; var answers: String? }
        struct Taken: Encodable { var letters: [Letter]; var seen: [String: Double] }
        // To a machine set up for your other computers still; any other's has nowhere to go.
        let letters = mailing.compactMap { letter in
            app.phoneLink.key(of: letter.machine).map { Letter(id: letter.id, from: letter.from, to: letter.to, text: letter.text, peer: $0, at: letter.at, answers: letter.answers) }
        }
        guard let (status, _) = try? await client.send("POST", "kuvo/link/letters/take", body: try? JSONEncoder().encode(Taken(letters: letters, seen: seen))),
              status == 200 else { return }
        try? FileManager.default.removeItem(at: Self.mailingFile)
        try? FileManager.default.removeItem(at: Self.seenFile)
    }
}

private extension Array {
    var nilIfEmpty: Self? { isEmpty ? nil : self }
}
