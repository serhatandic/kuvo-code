import Foundation
import KuvoLink
import OpenCodeKit
import os

/// A group chat: you and some of your bots, talking something through. Each bot takes part from
/// a seat of its own, a session where it lives with its job and memory, hidden from the lists.
/// Kuvo Code passes the floor around one bot at a time, so no two ever talk at once.
struct BotGroup: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    /// What it's for, in a few words: "Plan each week's release". Nil or empty for nothing in particular.
    var purpose: String?
    /// Its bots, in order; the first leads.
    var members: [String]
    /// Each member's seat: its session for this chat, made at its first turn.
    var seats: [String: String] = [:]
    /// The last message each member's seat has been given.
    var heard: [String: String] = [:]
    /// Seats that run with the coding agents (their bot's model is one of theirs, or Auto).
    var agentSeats: Set<String>?
    var created: Date
    /// When you last looked at it.
    var viewed: Date?
    /// Bots that heard messages you since took back, with the start of the first of them: they're
    /// told to set it aside at their next turn.
    var retracted: [String: String]?
    /// When it meets on its own, like a standup every weekday at 9; nil for a chat that only
    /// talks when you write.
    var meeting: Meeting?

    var lead: String? { members.first }

    /// A meeting you scheduled: at `next`, its topic goes to the chat and the bots talk it through.
    struct Meeting: Codable, Hashable {
        var next: Date
        /// How often it comes back, as kuvo-wake writes it (1d, weekdays…); nil for once.
        var every: String?
        var topic: String
        /// The time of day one that repeats by days keeps, in minutes, from its first time, so
        /// daylight saving or a new time zone doesn't move it for good.
        var at: Int?
        /// The day of the week a weekly one keeps, likewise (1 is Sunday).
        var weekday: Int?

        var repeats: Wakes.Repeat? { every.flatMap(Wakes.Repeat.init) }

        /// What a meeting's topic is when you give it none.
        static let defaultTopic = "Our regular meeting: where things stand, and what's next."

        /// A meeting as you set it up (Edit Group Chat, or a phone): at `time`, repeating `every`
        /// (nil for once), about `topic`. Its next time is after now: a repeating one's next
        /// round, if `time` has passed; on weekdays, a weekday. With its time and repeat as
        /// `before` had them, it keeps the time of day (and a week's day) it had, whatever
        /// daylight saving or a new time zone did to its next time; a time picked anew is the one
        /// it keeps from then on. Nil for a one-off whose time has passed.
        static func planned(at time: Date, every: Wakes.Repeat?, topic: String, before: Meeting?, now: Date = .now, calendar: Calendar = .current) -> Meeting? {
            // To the minute, as a machine's chats plan it.
            let time = Date(timeIntervalSince1970: (time.timeIntervalSince1970 / 60).rounded(.down) * 60)
            let kept = before.flatMap { $0.next == time && $0.repeats == every ? $0 : nil }
            let at = every?.keepsTimeOfDay == true ? kept?.at ?? Wakes.minutes(of: time, calendar: calendar) : nil
            let weekday = every?.keepsWeekday == true ? kept?.weekday ?? calendar.component(.weekday, from: time) : nil
            var next = time
            if next <= now, let every { next = every.next(after: next, now: now, at: at, weekday: weekday, calendar: calendar) }
            while every == .weekdays, Wakes.isWeekend(next, calendar: calendar), let day = calendar.date(byAdding: .day, value: 1, to: next) { next = day }
            guard next > now else { return nil }
            let topic = topic.trimmingCharacters(in: .whitespacesAndNewlines)
            return Meeting(next: next, every: every?.text, topic: topic.isEmpty ? defaultTopic : topic, at: at, weekday: weekday)
        }
    }
}

/// What a bot is doing on its turn, as its seat shows it: the chat shows its last step under
/// who's talking, so a long turn doesn't look stuck. A machine's chats send it as they run.
enum GroupActivity: Codable, Hashable {
    /// A tool it called (without what it gave back).
    case step(Message.ToolCall)
    /// Its thinking, the line it's on.
    case thinking(String)
    /// Its reply, being written.
    case writing

    private enum Key: String, CodingKey { case kind, call, text }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "tool": self = .step(try c.decode(Message.ToolCall.self, forKey: .call))
        case "thinking": self = .thinking(try c.decodeIfPresent(String.self, forKey: .text) ?? "")
        default: self = .writing
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case .step(let call):
            try c.encode("tool", forKey: .kind)
            try c.encode(call, forKey: .call)
        case .thinking(let text):
            try c.encode("thinking", forKey: .kind)
            try c.encode(text, forKey: .text)
        case .writing:
            try c.encode("writing", forKey: .kind)
        }
    }

    /// The last step in a seat's `messages` (oldest first), since `promptID` (or, not among them
    /// yet, since `sent`); none before its first.
    static func latest(in messages: [Message], after promptID: String, since sent: Date) -> [GroupActivity] {
        let start = messages.firstIndex { $0.id == promptID }.map { $0 + 1 }
        let since = sent.timeIntervalSince1970 * 1000 - 2000
        var found: [GroupActivity] = []
        for (index, message) in messages.enumerated() where start.map({ index >= $0 }) ?? (message.created >= since) {
            guard case .assistant(let answer) = message else { continue }
            for block in answer.content {
                switch block {
                case .tool(let call): found.append(.step(bare(call)))
                case .reasoning(let text): if let line = thought(text.text) { found.append(.thinking(line)) }
                case .text(let text):
                    if !text.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, found.last != .writing { found.append(.writing) }
                default: break
                }
            }
        }
        return Array(found.suffix(1))
    }

    /// Thinking under way, in a line: the latest it's written, without Markdown's stars.
    static func thought(_ text: String) -> String? {
        let lines = text.split(whereSeparator: \.isNewline).map { $0.replacingOccurrences(of: "**", with: "").trimmingCharacters(in: .whitespaces) }
        guard let line = lines.last(where: { !$0.isEmpty }) else { return nil }
        return line.count > 100 ? String(line.prefix(99)) + "…" : line
    }

    private static func bare(_ call: Message.ToolCall) -> Message.ToolCall {
        var call = call
        switch call.state {
        case .completed(let input, _, let metadata): call.state = .completed(input: input, output: [], metadata: metadata)
        case .failed(let input, let error, _, let metadata): call.state = .failed(input: input, error: error, output: nil, metadata: metadata)
        case .streaming, .running: break
        }
        return call
    }
}

struct GroupMessage: Codable, Identifiable, Hashable {
    var id: String
    /// The bot that wrote it; nil for you.
    var author: String?
    var text: String
    var time: Date
    var kind: Kind = .message
    /// What the bot did on its turn before it wrote this: its searches, reads and commands.
    var steps: [Message.ToolCall]?
    /// On a wrap-up: the work it split up, who does what. Each bot does its part in its own
    /// conversation, once you say go (or straight away, if you already had).
    var tasks: [GroupTask]?
    /// On a bot's message: the part of the work it's reporting back on, from its own conversation.
    var report: String?

    enum Kind: String, Codable {
        /// Said in the chat.
        case message
        /// The lead's sum-up at the end of a discussion.
        case wrapUp
        /// From Kuvo Code: a bot that couldn't take part.
        case note
        /// A meeting you scheduled, come due: its topic.
        case meeting
    }
}

/// A part of the work a chat split up: who does it, what it is, and how it's going.
struct GroupTask: Codable, Hashable, Identifiable {
    var id: String
    /// The bot doing it.
    var bot: String
    var task: String
    var state: State = .proposed
    /// Its message in the bot's own conversation, once it went there.
    var prompt: String?
    var started: Date?
    var finished: Date?
    /// The bots whose parts come first: it starts once theirs are done, with what they reported.
    var after: [String]?

    enum State: String, Codable {
        /// In the wrap-up, waiting for you to say go.
        case proposed
        /// Started, but waiting for the parts it comes after.
        case waiting
        /// In the bot's own conversation, under way.
        case working
        /// The bot reported back.
        case done
        /// It couldn't be done: the bot's machine away, an error.
        case failed
    }
}

/// A part of a chat's work, as it reaches the bot's own conversation: which chat it's from and
/// what the part is, then what was decided and how to report back (for the bot, not shown).
enum GroupWork {
    private static let opening = "[Work from "
    private static let divider = "\n\n---\n"

    /// `from`: whose words `wrapUp` is ("Pixel's wrap-up"); `before`: the parts that came first,
    /// each bot's name with its report.
    static func compose(_ task: GroupTask, chat: BotGroup, wrapUp: GroupMessage, from: String, before: [(name: String, report: String)] = []) -> String {
        var text = opening + chat.name + " · " + chat.id + "]\n\n" + task.task + divider
            + "The user agreed to this in the group chat \"\(chat.name)\", and this part is yours. What was decided (\(from)):\n\n"
            + wrapUp.text
        if !before.isEmpty {
            text += "\n\nThe parts before yours are done. What they reported:\n" + before.map { "\n**\($0.name)**: \($0.report)" }.joined(separator: "\n")
        }
        return text + "\n\nDo your part here, with all your tools, as you would any task from the user. When it's done, end with a few lines on what you did and anything left over. That last message of yours goes to the chat as your report on its own, so don't send it anywhere; the others' parts start from it."
    }

    /// One bot's part, as the lead listed it: what it does, and whose parts come first.
    struct Part: Equatable {
        var name: String
        var task: String
        var after: [String] = []
    }

    /// Who does what in a lead's list of `&Name: task` lines, or `&Name (after &Other): task` for
    /// a part that waits for another (bullets and bold allowed): one part for each name, several
    /// lines for one going together as a list; and whether its GO or WAIT line said to go ahead.
    /// Lines for anyone not in `names` are left out.
    static func parts(in text: String, names: [String]) -> (parts: [Part], go: Bool) {
        var parts: [Part] = []
        var lines: [String: [String]] = [:]
        var go = false
        // The longest name first, so "Sam" doesn't take "Samantha"'s line.
        let byLength = names.sorted { $0.count > $1.count }
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.replacingOccurrences(of: "**", with: "")
                .replacingOccurrences(of: #"^[\s>*•·-]*(\d+[.)]\s*)?"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            if line.range(of: #"^\W*GO\W*$"#, options: .regularExpression) != nil { go = true; continue }
            if line.range(of: #"^\W*WAIT\W*$"#, options: .regularExpression) != nil { go = false; continue }
            for name in byLength {
                // "&", or "@" as a lead may still write it.
                let pattern = "^[@&]?" + NSRegularExpression.escapedPattern(for: name) + #"\s*(?:\(\s*(?:after|once)\s+([^)]*)\))?\s*[:—–-]\s*"#
                guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
                      let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
                      let whole = Range(match.range, in: line) else { continue }
                let task = line[whole.upperBound...].trimmingCharacters(in: .whitespaces)
                if task.isEmpty { break }
                let waitsFor = Range(match.range(at: 1), in: line).map { String(line[$0]) } ?? ""
                let after = byLength.filter { other in
                    other != name && waitsFor.range(of: #"(^|[^\p{L}\p{N}])[@&]?"# + NSRegularExpression.escapedPattern(for: other) + #"($|[^\p{L}\p{N}])"#,
                                                    options: [.regularExpression, .caseInsensitive]) != nil
                }
                if let index = parts.firstIndex(where: { $0.name == name }) {
                    parts[index].after += after.filter { !parts[index].after.contains($0) }
                } else {
                    parts.append(Part(name: name, task: "", after: after))
                }
                lines[name, default: []].append(task)
                break
            }
        }
        for index in parts.indices {
            let all = lines[parts[index].name] ?? []
            parts[index].task = all.count == 1 ? all[0] : all.map { "- " + $0 }.joined(separator: "\n")
        }
        return (parts, go)
    }

    /// The chat a message came from and the part it hands over. Its first line is
    /// "[Work from <name> · <chat>]", read from the end, as a name can hold anything.
    static func parse(_ text: String) -> (chat: String, id: String, task: String)? {
        guard text.hasPrefix(opening) else { return nil }
        let first = text.prefix { $0 != "\n" }
        guard first.hasSuffix("]"), let dot = first.range(of: " · ", options: .backwards), dot.lowerBound > first.index(first.startIndex, offsetBy: opening.count) else { return nil }
        let name = String(first[first.index(first.startIndex, offsetBy: opening.count)..<dot.lowerBound])
        let id = String(first[dot.upperBound..<first.index(before: first.endIndex)])
        var task = String(text.dropFirst(first.count))
        if let cut = task.range(of: divider) { task = String(task[..<cut.lowerBound]) }
        return (name, id, task.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

/// Your group chats, in `groups.json`, their messages in `groups/<id>.json`, and the discussions
/// under way.
///
/// A discussion starts with each message of yours. The lead speaks first, unless you named
/// someone with &; then whoever the last message named, then the others in turn. A bot with
/// nothing new to add passes. It ends when everyone else has passed, or at a limit of turns
/// (Keep Going carries on), and the lead sums up one that went back and forth, listing who does
/// what. A message you send while a bot is talking goes to that bot straight away, and to the
/// others at their turns. Once you say go, each bot takes its part to its own conversation, does
/// it there with all its tools, and reports back to the chat. Afterwards each bot remembers the
/// chat in its own conversation, as you'd remember a meeting.
@Observable
final class BotGroups {
    private(set) var list: [BotGroup] = []
    /// Each chat's messages.
    private var logs: [String: [GroupMessage]] = [:]
    /// Whose turn it is, in each chat that's talking.
    private(set) var speaking: [String: String] = [:]
    /// What the bot talking is doing, by chat (see `GroupActivity`).
    private(set) var activity: [String: [GroupActivity]] = [:]
    /// The chat each conversation at work now talks in (a member's seat, a guest's), for its stream.
    @ObservationIgnored private var talkingIn: [String: String] = [:]
    /// Each seat's context at its first turn since the app started: its growth past that is
    /// what makes it start over (`outgrew`).
    @ObservationIgnored private var seatBase: [String: Int] = [:]
    /// What a seat at work has thought so far in its step, from the engine's stream: its messages
    /// have its thinking only once the step ends.
    @ObservationIgnored private var thinking: [String: String] = [:]
    /// When a chat's line last came from the stream: a look at the seat's messages, which can be
    /// a step behind, doesn't take it back for a moment.
    @ObservationIgnored private var streamedAt: [String: Date] = [:]
    /// Chats talking something through right now.
    private(set) var discussing: Set<String> = []
    /// Chats that stopped at their limit of turns with more to say.
    private(set) var paused: Set<String> = []
    @ObservationIgnored weak var app: AppModel?
    @ObservationIgnored private var discussions: [String: Task<Void, Never>] = [:]
    /// Which run of each chat's discussion is the current one, so a stopped one ending late
    /// leaves the next alone.
    @ObservationIgnored private var runs: [String: UUID] = [:]
    /// Goes up with each message of yours, so a discussion under way starts its count again.
    @ObservationIgnored private var asked: [String: Int] = [:]
    /// The lead handing out the work, in each chat where it is.
    @ObservationIgnored private var splitting: [String: String] = [:]
    /// Meetings due that wait for their bots' machines to connect, since when.
    @ObservationIgnored private var waitingForMachines: [String: Date] = [:]
    /// Chats talking over a meeting that came due, and its message: you hear how it went when it
    /// ends.
    @ObservationIgnored private var meetingsUnderWay: [String: String] = [:]
    @ObservationIgnored private var meeting: Task<Void, Never>?
    /// Requests from seats already turned down.
    @ObservationIgnored private var declined: Set<String> = []
    /// Seats whose rules were brought up to date since launch.
    @ObservationIgnored private var seatsChecked: Set<String> = []
    @ObservationIgnored private var syncs: [String: Task<Void, Never>] = [:]
    /// Bots being deleted, leaving their chats: they don't remember them (their folder, on a
    /// machine already gone, isn't made again for a chat's transcript).
    @ObservationIgnored private var leaving: Set<String> = []
    private let log = Logger(subsystem: "run.kuvo.code", category: "groups")

    /// The key of a seat's instructions, and of the chats a bot's own conversation remembers.
    static let seatKey = "kuvo.seat"
    static let memoryKey = "kuvo.groups"
    private static var file: URL { AppInfo.supportDirectory.appending(path: "groups.json") }
    private static var folder: URL { AppInfo.supportDirectory.appending(path: "groups") }

    init() {
        list = Self.load()
        for group in list { logs[group.id] = Self.loadLog(group.id) }
    }

    func group(_ id: String?) -> BotGroup? {
        id.flatMap { id in list.first { $0.id == id } }
    }

    /// Every seat, so they stay out of the lists.
    var seatIDs: Set<String> { Set(list.flatMap(\.seats.values)) }
    /// Those that run with the coding agents.
    var agentSeatIDs: Set<String> { Set(list.flatMap { $0.agentSeats ?? [] }) }

    /// What a bot's seat in a chat runs on: the coding agents' bridge for one on a model of theirs
    /// (or Auto), else the bot's engine. One not made yet: where its model puts it.
    private func seatAPI(of bot: Bot, in group: BotGroup?) -> OpenCodeAPI? {
        guard let app else { return nil }
        let onAgents = if let seat = group?.seats[bot.id] {
            group?.agentSeats?.contains(seat) == true
        } else {
            OutsideAgents.runsWithAgents(talkingModel(of: bot), machine: bot.machine)
        }
        return onAgents ? app.workspace.agents(forFolder: bot.directory)?.api : app.workspace.api(forFolder: bot.directory)
    }

    /// The chat a seat is in.
    func group(seat: String) -> BotGroup? {
        list.first { $0.seats.values.contains(seat) }
    }

    func messages(in id: String) -> [GroupMessage] {
        logs[id] ?? []
    }

    /// A message from a bot since you last looked.
    func isUnread(_ group: BotGroup) -> Bool {
        guard let last = messages(in: group.id).last(where: { $0.author != nil && $0.kind != .note }) else { return false }
        return last.time > (group.viewed ?? .distantPast)
    }

    func markViewed(_ id: String) {
        // Its meeting's notification, once you're in it.
        Notifier.shared.clear(session: Self.tabKey(id))
        guard let index = list.firstIndex(where: { $0.id == id }), isUnread(list[index]) else { return }
        list[index].viewed = .now
        save()
    }

    // MARK: Tabs

    static func tabKey(_ id: String) -> String { TabKey.group(id).text }

    static func groupID(fromTab key: String) -> String? {
        TabKey(key).groupID
    }

    // MARK: Making, changing, deleting

    func create(name: String, purpose: String? = nil, members: [String], meeting: BotGroup.Meeting? = nil) -> BotGroup {
        let id = "grp_" + String((0..<10).map { _ in "abcdefghijklmnopqrstuvwxyz0123456789".randomElement()! })
        let group = BotGroup(id: id, name: name, purpose: purpose, members: members, created: .now, viewed: .now, meeting: meeting)
        list.append(group)
        logs[id] = []
        save()
        Analytics.shared.track("group_created", ["members": members.count])
        return group
    }

    /// Saves a new name, members or lead. Bots that left lose their seat and stop remembering
    /// the chat; everyone's seat learns who's there now.
    func update(_ edited: BotGroup) async {
        guard let index = list.firstIndex(where: { $0.id == edited.id }) else { return }
        let old = list[index]
        // What you edited, over the chat as it is now, saved before anything is awaited: what
        // changes meanwhile (what each bot heard, seats made, a meeting moved on) isn't put back
        // as it was.
        var group = old
        group.name = edited.name
        group.purpose = edited.purpose
        group.members = edited.members
        group.meeting = edited.meeting
        var leaving: [(bot: String, seat: String)] = []
        for bot in old.members where !group.members.contains(bot) {
            if let seat = group.seats.removeValue(forKey: bot) { leaving.append((bot, seat)) }
            group.heard[bot] = nil
            // What it was told to set aside goes too: back in the chat later, it hasn't heard it.
            group.retracted?[bot] = nil
        }
        list[index] = group
        save()
        // Where each seat is, by the chat as it was (it's gone from the chat now).
        for (bot, seat) in leaving { await deleteSeat(seat, of: bot, in: old) }
        await refreshSeats(of: list.first { $0.id == group.id } ?? group)
        // One that left forgets the chat (its transcript goes from its folder); the rest remember.
        for bot in Set(old.members + group.members) {
            if group.members.contains(bot) { await remember(bot) } else { await remember(bot, changed: group.id, forgetting: group.id) }
        }
    }

    /// Deletes a chat: its messages, and its seats where the bots live (as it is now: a copy from an
    /// editor can be missing a seat made since).
    func delete(_ group: BotGroup) async {
        let group = list.first { $0.id == group.id } ?? group
        stop(group.id)
        list.removeAll { $0.id == group.id }
        logs[group.id] = nil
        save()
        try? FileManager.default.removeItem(at: Self.folder.appending(path: "\(group.id).json"))
        for (bot, seat) in group.seats { await deleteSeat(seat, of: bot, in: group) }
        for bot in group.members { await remember(bot, changed: group.id, forgetting: group.id) }
        Analytics.shared.track("group_deleted")
    }

    /// A bot that's being deleted leaves its chats.
    func remove(_ bot: Bot) async {
        leaving.insert(bot.id)
        defer { leaving.remove(bot.id) }
        // Each chat as it is when its turn comes: updating one awaits the engine.
        for id in list.filter({ $0.members.contains(bot.id) }).map(\.id) {
            guard var group = list.first(where: { $0.id == id }) else { continue }
            group.members.removeAll { $0 == bot.id }
            await update(group)
        }
    }

    /// A bot moving to another computer (`Moves`), as it still is where it was: its seats there go,
    /// and each chat makes it a new one where it lives now at its next turn, which hears the whole
    /// chat (as a new model's does).
    func botMoving(_ bot: Bot) async {
        for group in list {
            guard let seat = group.seats[bot.id] else { continue }
            await deleteSeat(seat, of: bot.id, in: group)
            guard let index = list.firstIndex(where: { $0.id == group.id }) else { continue }
            list[index].seats[bot.id] = nil
            list[index].heard[bot.id] = nil
            save()
        }
    }

    /// A bot's new name or job: the seats around it hear who they're talking with.
    func botChanged(_ bot: Bot) async {
        for group in list where group.members.contains(bot.id) {
            await refreshSeats(of: group)
        }
        await remember(bot.id)
    }

    /// The agent a seat on `model` runs as, when not the usual: Cursor can't stop to ask, so its
    /// rules can't hold it back: it plans instead of changing anything.
    private static func seatAgent(for model: ModelRef?, onAgents: Bool) -> String? {
        onAgents && OutsideAgents.base(model?.providerID ?? "") == "cursor" ? "plan" : nil
    }

    /// The model a bot talks on in a chat: the one picked for it in Edit Bot while that can run
    /// where it lives; otherwise (its account signed out of, which takes its models away, so Edit
    /// Bot shows none) what its own conversation is on now.
    func talkingModel(of bot: Bot) -> ModelRef? {
        let conversation = app?.workspace.session(bot.sessionID)?.model
        guard let picked = bot.model else { return conversation }
        let catalog = bot.machine.flatMap { app?.machines.engine($0)?.catalog } ?? app?.catalog
        return catalog?.isUnavailable(picked) == true ? (conversation ?? picked) : picked
    }

    /// A bot's new default model, for its seats.
    func modelChanged(of bot: Bot) async {
        guard let model = talkingModel(of: bot) else { return }
        for group in list where group.seats[bot.id] != nil { await follow(model, bot: bot, in: group) }
    }

    /// A bot's seat in `group`, on `model`: switched, or, where it can't run there (the engine,
    /// the agents), gone, for a new one at its next turn, which hears the whole chat.
    private func follow(_ model: ModelRef, bot: Bot, in group: BotGroup) async {
        let onAgents = OutsideAgents.runsWithAgents(model, machine: bot.machine)
        guard let seat = group.seats[bot.id] else { return }
        if group.agentSeats?.contains(seat) == true || !onAgents {
            if let api = seatAPI(of: bot, in: group) {
                try? await api.selectModel(session: seat, model: model)
                // Cursor plans in a seat (it can't stop to ask); others take part as seats do.
                if group.agentSeats?.contains(seat) == true {
                    try? await api.selectAgent(session: seat, agent: Self.seatAgent(for: model, onAgents: onAgents) ?? "build")
                }
            }
        } else {
            await deleteSeat(seat, of: bot.id, in: group)
            guard let index = list.firstIndex(where: { $0.id == group.id }) else { return }
            list[index].seats[bot.id] = nil
            list[index].heard[bot.id] = nil
            save()
        }
    }

    // MARK: Moving

    /// A chat moving to one of your machines (`Moves`): it stops here and goes as it is, its seats
    /// left where they are (its bots live there). `toTrash`: its file goes to the Trash (it moved);
    /// else it's let go (a copy that didn't get to start). Its bots remember the chats left here.
    @discardableResult
    func release(_ id: String, toTrash: Bool) async -> Bool {
        guard let group = group(id) else { return false }
        stop(id)
        list.removeAll { $0.id == id }
        logs[id] = nil
        save()
        let file = Self.folder.appending(path: "\(id).json")
        if toTrash, FileManager.default.fileExists(atPath: file.path) { try? FileManager.default.moveToTrash(file) } else { try? FileManager.default.removeItem(at: file) }
        for bot in group.members { await remember(bot) }
        return true
    }

    /// A chat come from one of your machines (`Moves`), with its messages: it talks here from now on.
    func adopt(_ group: BotGroup, messages: [GroupMessage]) {
        list.removeAll { $0.id == group.id }
        list.append(group)
        logs[group.id] = messages
        save()
        saveLog(group.id)
        app?.workspace.seats.formUnion(group.seats.values)
        if let agentSeats = group.agentSeats { app?.workspace.runsOnAgents(agentSeats) }
        rememberSoon(group.id)
    }

    // MARK: Talking

    /// A seat at work, thinking or writing (from the engine's stream): its latest thought, in a
    /// line under its name, a few times a second at most.
    func streamed(_ event: ServerEvent) {
        guard let seat = event.sessionID, let id = talkingIn[seat], speaking[id] != nil else { return }
        var now: [GroupActivity]?
        switch event.type {
        case "session.reasoning.started":
            thinking[seat] = ""
        case "session.reasoning.delta":
            guard let delta = try? event.payload(as: EventPayload.Delta.self) else { return }
            thinking[seat, default: ""] += delta.delta
            if let text = thinking[seat], text.count > 2000 { thinking[seat] = String(text.suffix(1000)) }
            now = GroupActivity.thought(thinking[seat] ?? "").map { [.thinking($0)] }
        default:
            now = [.writing]
        }
        guard let now, activity[id] != now else { return }
        // Its kind changing (thinking, then writing) shows at once; the same thought growing, now and then.
        let sameKind = activity[id]?.first.map { if case .thinking = $0 { true } else { false } } == now.first.map { if case .thinking = $0 { true } else { false } }
        if sameKind, Date.now.timeIntervalSince(streamedAt[id] ?? .distantPast) < 0.3 { return }
        activity[id] = now
        streamedAt[id] = .now
    }

    /// Your message to the chat. It starts a discussion, or joins the one under way: the bot
    /// talking gets it straight away, the rest at their turns.
    func send(_ text: String, to id: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Moving to one of your machines (`Moves`): nothing more happens here.
        guard !text.isEmpty, group(id) != nil, !Moves.isFrozen(id) else { return }
        let message = append(GroupMessage(id: Self.newID(), author: nil, text: text, time: .now), to: id)
        asked[id, default: 0] += 1
        paused.remove(id)
        Analytics.shared.track("group_message", ["discussing": discussing.contains(id)])
        if let speaker = speaking[id] {
            Task { await steer(speaker, in: id, with: message) }
        }
        if discussions[id] == nil { start(id) }
    }

    // MARK: Meetings

    /// Holds this Mac's chats' meetings as they come due, while the app runs; one missed while it
    /// wasn't running goes as soon as it is, once.
    func startMeetings() {
        guard meeting == nil else { return }
        meeting = Task { [weak self] in
            // Machines' bots connect a moment after launch: one missed meanwhile waits for them.
            try? await Task.sleep(for: .seconds(10))
            while !Task.isCancelled {
                self?.meetDue()
                let next = self?.list.compactMap { $0.meeting?.next }.min().map { $0.timeIntervalSinceNow } ?? 20
                try? await Task.sleep(for: .seconds(min(20, max(0.5, next))))
            }
        }
    }

    /// Holds the meetings that have come due: once each, then the next time of one that repeats,
    /// or none for a one-off.
    func meetDue() {
        for group in list where !Moves.isFrozen(group.id) {
            guard var meeting = group.meeting, meeting.next <= .now, let index = list.firstIndex(where: { $0.id == group.id }) else { continue }
            // Its bots on machines still connecting (after launch, or a wake): it waits for them,
            // two minutes at most, rather than meeting without them.
            let connecting = group.members.compactMap { app?.bots.bot($0)?.machine }.contains { app?.machines.engine($0).map { !$0.isReady } ?? false }
            if connecting {
                let since = waitingForMachines[group.id] ?? .now
                waitingForMachines[group.id] = since
                if since.timeIntervalSinceNow > -120 { continue }
            }
            waitingForMachines[group.id] = nil
            let missed = meeting.next.timeIntervalSinceNow < -300
            meet(group.id, about: meeting.topic)
            if let every = meeting.repeats {
                if every.keepsTimeOfDay, meeting.at == nil { meeting.at = Wakes.minutes(of: meeting.next) }
                if every.keepsWeekday, meeting.weekday == nil { meeting.weekday = Calendar.current.component(.weekday, from: meeting.next) }
                let at = every.keepsTimeOfDay ? meeting.at : nil, weekday = every.keepsWeekday ? meeting.weekday : nil
                meeting.next = every.next(after: meeting.next, now: .now, at: at, weekday: weekday)
                // A missed one held now isn't followed by the next a few hours later (yesterday's,
                // held at 8:55, and today's at 9:00): that one's skipped.
                if missed, every.keepsTimeOfDay, meeting.next.timeIntervalSinceNow < 3 * 3600 {
                    meeting.next = every.next(after: meeting.next, now: meeting.next, at: at, weekday: weekday)
                }
                list[index].meeting = meeting
            } else {
                list[index].meeting = nil
            }
            save()
        }
    }

    /// A meeting come due: its topic to the chat, and the bots talk it through.
    func meet(_ id: String, about topic: String) {
        guard group(id) != nil else { return }
        let message = append(GroupMessage(id: Self.newID(), author: nil, text: topic, time: .now, kind: .meeting), to: id)
        asked[id, default: 0] += 1
        paused.remove(id)
        meetingsUnderWay[id] = message.id
        Analytics.shared.track("group_met")
        if let speaker = speaking[id] {
            Task { await steer(speaker, in: id, with: message) }
        }
        if discussions[id] == nil { start(id) }
    }

    /// A meeting's talk ended: how it went (the lead's sum-up, or the last word), in a notification
    /// while you're elsewhere, which you can answer from.
    private func meetingEnded(_ id: String) {
        guard let start = meetingsUnderWay.removeValue(forKey: id), let group = group(id) else { return }
        // What was said since it began; no one could take part, it says so.
        let since = messages(in: id).drop { $0.id != start }.dropFirst()
        guard let last = since.last(where: { $0.author != nil && $0.kind != .note }) else {
            Notifier.shared.notify(session: Self.tabKey(id), title: group.name, body: "The meeting came, but no one could take part.",
                                       push: .init(.message, group: id))
            return
        }
        let who = app?.bots.bot(last.author)?.name
        Notifier.shared.notify(session: Self.tabKey(id), title: group.name, subtitle: who.map { last.kind == .wrapUp ? "\($0)’s wrap-up" : $0 },
                               body: ReplyPreview.line(last.text), replies: true, push: .init(.message, group: id))
    }

    /// Takes the chat back to before one of your messages: it and everything said after it leave
    /// the chat, the discussion stops, and bots that heard any of it are told at their next turn
    /// to set it aside. Returns the message's words, for the composer.
    @discardableResult
    func undo(from messageID: String, in id: String) -> String? {
        guard !Moves.isFrozen(id), let index = list.firstIndex(where: { $0.id == id }), var messages = logs[id],
              let cut = messages.firstIndex(where: { $0.id == messageID }) else { return nil }
        stop(id)
        let taken = messages[cut...]
        let text = messages[cut].text
        messages.removeSubrange(cut...)
        logs[id] = messages
        saveLog(id)
        var group = list[index]
        var retracted = group.retracted ?? [:]
        for bot in group.members {
            guard let heard = group.heard[bot], taken.contains(where: { $0.id == heard }) else { continue }
            group.heard[bot] = messages.last?.id
            if retracted[bot] == nil { retracted[bot] = String(text.prefix(120)) }
        }
        group.retracted = retracted.isEmpty ? nil : retracted
        list[index] = group
        save()
        rememberSoon(id)
        Analytics.shared.track("group_undo")
        return text
    }

    /// Stops the discussion; the bot talking stops mid-sentence (a meeting with it).
    func stop(_ id: String) {
        meetingsUnderWay[id] = nil
        discussions.removeValue(forKey: id)?.cancel()
        runs[id] = nil
        paused.remove(id)
        activity[id] = nil
        // What its seats still stream as they stop shows under nobody.
        talkingIn = talkingIn.filter { $0.value != id }
        // The bot talking, or the lead handing out the work.
        for speaker in [speaking.removeValue(forKey: id), splitting.removeValue(forKey: id)].compactMap({ $0 }) {
            guard let bot = app?.bots.bot(speaker), let seat = group(id)?.seats[speaker] else { continue }
            let api = seatAPI(of: bot, in: group(id))
            Task { try? await api?.interrupt(session: seat) }
        }
        discussing.remove(id)
    }

    /// After the limit of turns: more of the same.
    func keepGoing(_ id: String) {
        guard discussions[id] == nil, !Moves.isFrozen(id) else { return }
        paused.remove(id)
        asked[id, default: 0] += 1
        start(id)
    }

    private func start(_ id: String) {
        let run = UUID()
        runs[id] = run
        discussing.insert(id)
        discussions[id] = Task { [weak self] in
            // A message of yours that came as it was ending (during the wrap-up) starts another.
            var epoch: Int
            repeat {
                epoch = await self?.discuss(id) ?? 0
            } while !Task.isCancelled && self.map { $0.asked[id, default: 0] != epoch } == true
            guard let self, self.runs[id] == run else { return }
            self.runs[id] = nil
            self.discussions[id] = nil
            self.discussing.remove(id)
            self.speaking[id] = nil
            self.meetingEnded(id)
        }
    }

    /// How many turns a discussion gets for each message of yours.
    private static func limit(members: Int) -> Int {
        min(16, max(4, members * 3))
    }

    private enum Outcome { case said, passed, absent }

    /// Talks it through, until there's nothing left to add or it reaches its limit; then the
    /// wrap-up. Returns the count of your messages it went by.
    private func discuss(_ id: String) async -> Int {
        var epoch = asked[id, default: 0]
        var turns = 0
        /// Bots that passed since the last thing said.
        var quiet: Set<String> = []
        /// Bots that couldn't take part (not connected, an error): left out until you write again.
        var absent: Set<String> = []
        /// Bots' messages since yours.
        var said = 0
        /// Guests that answered (or tried), each by the message that named it and its id.
        var guested: Set<String> = []
        /// Where the discussion began: from that message on, each one's guests are asked, even
        /// one that came while a bot was talking and isn't the latest any more.
        let begun = max(0, messages(in: id).lastIndex { $0.kind != .note } ?? 0)
        while !Task.isCancelled {
            guard let group = group(id), let app else { return epoch }
            if asked[id, default: 0] != epoch {
                epoch = asked[id, default: 0]
                turns = 0
                quiet = []
                absent = []
                said = 0
            }
            let members = group.members.filter { app.bots.bot($0) != nil && !absent.contains($0) }
            // A bot outside the chat that a message since the discussion began names with "&"
            // answers it first, as a guest, once.
            let all = messages(in: id)
            let bots = app.bots.list.map { (id: $0.id, name: $0.name) }
            let named = all.indices.dropFirst(min(begun, all.count)).lazy
                .filter { all[$0].kind != .note }
                .compactMap { index in
                    Self.guests(in: Array(all[...index]), members: group.members, among: bots)
                        .first { !guested.contains(all[index].id + "/" + $0) }
                        .map { (message: all[index], guest: $0) }
                }
                .first
            if let (message, guest) = named {
                guested.insert(message.id + "/" + guest)
                if turns >= Self.limit(members: group.members.count) {
                    paused.insert(id)
                    break
                }
                let outcome = await turn(of: guest, in: id, namedIn: message)
                guard !Task.isCancelled else { return epoch }
                turns += 1
                if outcome == .said {
                    quiet = []
                    said += 1
                }
                continue
            }
            // Nobody with more to say: it's over, at the limit or not.
            guard let speaker = nextSpeaker(in: group, members: members, quiet: quiet) else { break }
            if turns >= Self.limit(members: group.members.count) {
                paused.insert(id)
                break
            }
            let outcome = await turn(of: speaker, in: id)
            guard !Task.isCancelled else { return epoch }
            turns += 1
            switch outcome {
            case .said:
                quiet = []
                said += 1
            case .passed:
                quiet.insert(speaker)
            case .absent:
                absent.insert(speaker)
            }
        }
        // The lead sums up a discussion that went back and forth, or a meeting where more than one
        // spoke, unless you've written since.
        guard !Task.isCancelled, said > 0, asked[id, default: 0] == epoch, let group = group(id),
              let lead = group.lead, app?.bots.bot(lead) != nil else { return epoch }
        if said >= (meetingsUnderWay[id] != nil ? 2 : 3), group.members.count >= 2 {
            let before = messages(in: id).last?.id
            _ = await turn(of: lead, in: id, wrapUp: true)
            // Who does what, from the lead, unless you've written since.
            if let wrapUp = messages(in: id).last, wrapUp.id != before, wrapUp.kind == .wrapUp, !Task.isCancelled, asked[id, default: 0] == epoch {
                await splitWork(of: wrapUp.id, in: id, lead: lead)
            }
        } else if let last = messages(in: id).last, last.author != nil, last.kind == .message, last.report == nil {
            // A short exchange, with no wrap-up: the work, if there is any, under its last word.
            await splitWork(of: last.id, in: id, lead: lead)
        }
        return epoch
    }

    /// Who talks next: someone the last message named with &, after one of yours the lead,
    /// otherwise the next in line after whoever spoke last. Nobody twice in a row, and nobody
    /// who passed since the last thing said. Nil once there's nobody left with something to add.
    private func nextSpeaker(in group: BotGroup, members: [String], quiet: Set<String>) -> String? {
        let names = Dictionary(group.members.compactMap { id in app?.bots.bot(id).map { (id, $0.name) } }) { first, _ in first }
        return Self.nextSpeaker(in: group, messages: messages(in: group.id), members: members, quiet: quiet, names: names)
    }

    /// The rule `nextSpeaker` follows, by each bot's name (what a chat on a machine follows too).
    static func nextSpeaker(in group: BotGroup, messages all: [GroupMessage], members: [String], quiet: Set<String>, names: [String: String]) -> String? {
        let last = all.last { $0.kind != .note }
        // Who spoke last waits a turn, unless something of yours came that it hasn't heard: one
        // you wrote as its turn was ending (or before its run began) didn't reach it then.
        func missedYou(_ bot: String) -> Bool {
            let heard = group.heard[bot].flatMap { id in all.lastIndex { $0.id == id } } ?? -1
            return all[(heard + 1)...].contains { $0.author == nil && $0.kind == .message }
        }
        let candidates = members.filter { ($0 != last?.author || missedYou($0)) && !quiet.contains($0) }
        guard !candidates.isEmpty else { return nil }
        // Its own words: a quote it replies to names whoever that message did.
        if let last, let named = mentions(in: Quoting.words(of: last.text), among: candidates.compactMap { id in names[id].map { (id, $0) } }).first {
            return named
        }
        guard let author = last?.author, let index = group.members.firstIndex(of: author) else {
            return candidates.first
        }
        let order = group.members[(index + 1)...] + group.members[..<index]
        return order.first { candidates.contains($0) }
    }

    /// The bots a message names with &, in the order it names them: each by its ID and name.
    static func mentions(in text: String, among bots: [(id: String, name: String)]) -> [String] {
        bots.compactMap { bot -> (String, String.Index)? in
            // The whole name: "&Sam" isn't Samantha.
            var from = text.startIndex
            while let found = text.range(of: "&" + bot.name, options: [.caseInsensitive, .diacriticInsensitive], range: from..<text.endIndex) {
                if found.upperBound == text.endIndex || !(text[found.upperBound].isLetter || text[found.upperBound].isNumber) { return (bot.id, found.lowerBound) }
                from = found.upperBound
            }
            return nil
        }
        .sorted { $0.1 < $1.1 }
        .map(\.0)
    }

    /// One bot's turn: what it hasn't heard yet goes to its seat (the whole chat, to a seat new to
    /// it), and its answer to the chat. A `guest` (a bot outside the chat that a message there
    /// named) answers in a conversation of its own for the turn, given the whole chat, which goes
    /// once it has.
    /// `namedIn`: a guest's turn, asked in by that message.
    private func turn(of botID: String, in id: String, wrapUp: Bool = false, namedIn: GroupMessage? = nil) async -> Outcome {
        let guest = namedIn != nil
        guard let app, var bot = app.bots.bot(botID) else { return .absent }
        speaking[id] = botID
        defer {
            if speaking[id] == botID {
                speaking[id] = nil
                activity[id] = nil
            }
        }
        // Moving to another computer: its turn once it's there (one whose move was cut short sits
        // it out until that's finished).
        if app.moves.isMoving(botID) { note("\(bot.name) is moving to another computer; it takes its turn once that’s done.", in: id) }
        do {
            try await Deliveries.settled(botID)
        } catch is CancellationError {
            return .absent
        } catch {
            note("\(bot.name) is moving to another computer, so it sat this out.", in: id)
            return .absent
        }
        guard let now = app.bots.bot(botID) else { return .absent }
        bot = now
        if let machine = bot.machine, app.machines.engine(machine)?.isReady != true {
            note("\(bot.name) is on \(machine), which isn’t connected, so it sat this out.", in: id)
            return .absent
        }
        // Its model can't run where it lives (its account signed out of): said, rather than
        // sent to an engine that drops it without a word.
        let catalog = bot.machine.flatMap { app.machines.engine($0)?.catalog } ?? app.catalog
        let model = talkingModel(of: bot)
        let place = bot.machine.map { machine in app.machines.list.first { $0.id == machine }?.name ?? machine }
        if let model, catalog.needsSignIn(model) {
            note("\(bot.name) couldn’t answer: \(catalog.unavailable(model, on: place))", in: id)
            return .absent
        }
        // A seat made on another model (picked since, in its conversation or Edit Bot): on this one.
        if !guest, let model, let group = group(id), let seat = group.seats[bot.id], let api = seatAPI(of: bot, in: group),
           let current = try? await api.session(seat).model, !current.sameModel(as: model) {
            await follow(model, bot: bot, in: group)
        }
        guard let api = seatAPI(of: bot, in: group(id)) else {
            note("\(bot.name) couldn’t answer: \(app.workspace.agents(forFolder: bot.directory)?.api == nil && OutsideAgents.runsWithAgents(model, machine: bot.machine) ? "the coding agents aren’t running" : "the engine isn’t running").", in: id)
            return .absent
        }
        var scratch: String?
        defer { if let scratch { dropLater(scratch, api: api) } }
        do {
            guard let group = group(id) else { return .absent }
            let seat: String, isNew: Bool
            if guest {
                seat = try await scratchSession(for: bot, in: group, api: api, title: "\(bot.name) asked into \(group.name)")
                scratch = seat
                isNew = true
            } else {
                (seat, isNew) = try await self.seat(of: bot, in: id, api: api)
            }
            guard let group = self.group(id) else { return .absent }
            let all = messages(in: id)
            let start = group.heard[botID].flatMap { heard in all.firstIndex { $0.id == heard } }.map { $0 + 1 } ?? 0
            let unheard = all[start...].filter { $0.author != botID && $0.kind != .note }
            let promptID = Identifier.message()
            let ended = app.workspace.endedRuns[seat, default: 0]
            let prompt = guest
                ? Self.guestText(bot: botID, name: bot.name, in: group, all: all, asker: namedIn?.author) { self.name(of: $0) }
                : isNew ? seatStartText(for: bot, in: group, all: all, wrapUp: wrapUp) : turnText(for: bot, in: group, unheard: Array(unheard), wrapUp: wrapUp)
            try await Deliveries.send(prompt, to: seat, id: promptID, delivery: .queue, on: api)
            if !guest, let last = all.last { setHeard(last.id, by: botID, in: id) }
            if !guest, let index = list.firstIndex(where: { $0.id == id }), list[index].retracted?[botID] != nil {
                list[index].retracted?[botID] = nil
                if list[index].retracted?.isEmpty == true { list[index].retracted = nil }
                save()
            }
            let sent = Date.now
            talkingIn[seat] = id
            defer {
                talkingIn[seat] = nil
                thinking[seat] = nil
            }
            try await waitForRun(of: seat, after: ended, since: sent, api: api, seen: { [weak self] messages in
                guard let self else { return }
                let now = GroupActivity.latest(in: messages, after: promptID, since: sent)
                guard self.speaking[id] == botID, !now.isEmpty, self.activity[id] ?? [] != now,
                      Date.now.timeIntervalSince(self.streamedAt[id] ?? .distantPast) > 3 else { return }
                self.activity[id] = now
            })
            let (said, error, steps, size) = try await reply(in: seat, after: promptID, since: sent, api: api)
            // Grown well past the chat it's in (pages it read, drafts, long answers): it starts
            // over at its next turn, in a new seat given the whole chat, and this one goes. Grown
            // from its first turn here, so what every turn carries (its instructions and tools)
            // doesn't count.
            if !guest, let size {
                let base = seatBase[seat] ?? size
                seatBase[seat] = base
                if size - base > Self.seatBudget, Self.outgrew(size - base, chat: Self.chatText(bot: botID, in: group, all: messages(in: id)) { self.name(of: $0) }) {
                    seatBase[seat] = nil
                    await startOver(botID, in: id)
                }
            }
            let text = said
            if text.isEmpty {
                if let error {
                    note("\(bot.name) couldn’t answer: \(catalog.plain(error, for: model, on: place))", in: id)
                    return .absent
                }
                return .passed
            }
            if !wrapUp, Self.isPass(text) { return .passed }
            append(GroupMessage(id: Self.newID(), author: botID, text: Self.ampersands(in: text, names: app.bots.list.map(\.name)), time: .now, kind: wrapUp ? .wrapUp : .message,
                                steps: steps.isEmpty ? nil : steps.map(Self.trimmed)), to: id)
            return .said
        } catch is CancellationError {
            return .absent
        } catch {
            guard !Task.isCancelled else { return .absent }
            log.error("\(bot.id, privacy: .public)'s turn in \(id, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            note("\(bot.name) couldn’t answer: \(catalog.plain(error.localizedDescription, for: model, on: place))", in: id)
            return .absent
        }
    }

    /// Your message, to the bot talking now: it hears it at its next step.
    private func steer(_ botID: String, in id: String, with message: GroupMessage) async {
        // Only into a run: one that hasn't started yet gets it with the rest at its turn.
        guard let bot = app?.bots.bot(botID), let seat = group(id)?.seats[botID], app?.workspace.running.contains(seat) == true,
              let api = seatAPI(of: bot, in: group(id)) else { return }
        // The chat's own bots are there already: only others named with "&" are described.
        let text = AgentReferences.text("The user, just now: \(message.text)", excludingAll: memberSessions(of: group(id)), here: bot.machine)
        if (try? await Deliveries.send(text, to: seat, delivery: .steer, on: api)) == true {
            setHeard(message.id, by: botID, in: id)
        }
    }

    private enum Failure: LocalizedError {
        case tookTooLong
        var errorDescription: String? { "It took too long, so it was stopped." }
    }

    /// Until the seat's run ends. Questions and requests for permission are turned down on the
    /// way, since nobody's there to answer them. `seen` hears its latest messages now and then,
    /// for what it's doing.
    private func waitForRun(of seat: String, after ended: Int, since sent: Date, api: OpenCodeAPI,
                            stops: (() -> Bool)? = nil, seen: (([Message]) -> Void)? = nil) async throws {
        var checked = Date.now
        var looked = Date.now
        while app?.workspace.endedRuns[seat, default: 0] == ended {
            try await Task.sleep(for: .milliseconds(300))
            // Not worth waiting for any more (you wrote, while the work list was asked): stopped.
            if stops?() == true {
                try? await api.interrupt(session: seat)
                throw CancellationError()
            }
            if let seen, Date.now.timeIntervalSince(looked) > 1.5 {
                looked = .now
                if let messages = try? await api.messages(session: seat, limit: 12).data { seen(messages) }
            }
            if app?.workspace.asking.values.contains(seat) == true { await decline(in: seat, api: api) }
            // The engine's word, now and then, in case an event went missing in a reconnect.
            if Date.now.timeIntervalSince(checked) > 8 {
                checked = .now
                if let active = try? await api.activeSessions(), !active.contains(seat) { return }
            }
            if Date.now.timeIntervalSince(sent) > 600 {
                try? await api.interrupt(session: seat)
                throw Failure.tookTooLong
            }
        }
    }

    private func decline(in seat: String, api: OpenCodeAPI) async {
        for request in (try? await api.permissions(session: seat)) ?? [] where declined.insert(request.id).inserted {
            try? await api.reply(session: seat, permission: request.id, decision: .reject, message: "Nobody can approve this in a group chat. Carry on without it, or say who should do it.")
        }
        for form in (try? await api.forms(session: seat)) ?? [] where declined.insert(form.id).inserted {
            try? await api.dismiss(session: seat, form: form.id, message: "Ask the group in your reply instead.")
        }
        // What an MCP server asked while the seat ran its tool, filed under its folder.
        for (form, session) in app?.workspace.asking ?? [:] where session == seat {
            guard let folder = app?.workspace.sharedForms[form], declined.insert(form).inserted else { continue }
            try? await api.dismiss(session: FormRequest.anySession, form: form, directory: folder)
        }
    }

    /// What the seat said since `promptID`, for the chat: its last words before each message it
    /// was given (yours, steered in while it talked, start a new part), so nothing it said to
    /// the group is lost, and none of the asides between its steps go in. An error, if that's
    /// all it has.
    /// What the seat said since `promptID`, for the chat, and how much it sent the model at its
    /// last step (its whole context, in tokens).
    private func reply(in seat: String, after promptID: String, since sent: Date, api: OpenCodeAPI) async throws -> (text: String, error: String?, steps: [Message.ToolCall], size: Int?) {
        let messages = try await api.messages(session: seat, limit: 60).data
        let start = messages.firstIndex { $0.id == promptID }.map { $0 + 1 }
        let since = sent.timeIntervalSince1970 * 1000 - 2000
        let (text, error, steps) = Self.said(in: messages.enumerated().filter { index, message in start.map { index >= $0 } ?? (message.created >= since) }.map(\.element))
        let size = messages.reversed().lazy.compactMap { message -> TokenUsage? in
            if case .assistant(let answer) = message { answer.tokens } else { nil }
        }.first.map { $0.input + $0.cache.read + $0.cache.write }
        return (text, error, steps, size)
    }

    /// The seat's context, in tokens, beyond which it starts over, unless the chat itself is most
    /// of it.
    static let seatBudget = 30_000

    /// Whether a seat that sent `size` tokens has outgrown the chat (`chat`, as a new seat reads
    /// it): past the budget, and over twice the chat's own size, so a long chat on its own never
    /// starts over at every turn. Tokens counted roughly, four characters each.
    static func outgrew(_ size: Int, chat: String) -> Bool {
        size > seatBudget && size > 2 * (chat.utf8.count / 4)
    }

    /// What `messages` say, as `reply` reads them.
    static func said(in messages: [Message]) -> (text: String, error: String?, steps: [Message.ToolCall]) {
        var parts: [String] = []
        var part = ""
        var error: String?
        var steps: [Message.ToolCall] = []
        for message in messages {
            switch message {
            case .user:
                if !part.isEmpty { parts.append(part) }
                part = ""
            case .assistant(let answer):
                for case .tool(let call) in answer.content { steps.append(call) }
                let words = answer.content.compactMap { block -> String? in
                    if case .text(let text) = block { text.text } else { nil }
                }
                .joined(separator: "\n\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
                if !words.isEmpty { part = words }
                error = answer.error?.message
            default:
                break
            }
        }
        if !part.isEmpty { parts.append(part) }
        // A part that's only a pass, beside one that says something, is left out.
        let said = parts.filter { !Self.isPass($0) }
        return ((said.isEmpty ? parts.suffix(1) : said).joined(separator: "\n\n"), error, steps)
    }

    /// A step as it's kept with the chat: what it printed, cut short, so the log stays small.
    private static func trimmed(_ call: Message.ToolCall) -> Message.ToolCall {
        func cut(_ output: [Message.ToolOutput]) -> [Message.ToolOutput] {
            output.map { item in
                if case .text(let text) = item, text.count > 4000 { return .text(String(text.prefix(4000)) + "…") }
                return item
            }
        }
        var call = call
        switch call.state {
        case .completed(let input, let output, let metadata): call.state = .completed(input: input, output: cut(output), metadata: metadata)
        case .failed(let input, let error, let output, let metadata): call.state = .failed(input: input, error: error, output: output.map(cut), metadata: metadata)
        case .streaming, .running: break
        }
        return call
    }

    /// "PASS", "Pass.", "[pass] nothing to add": a bot with nothing to say. Not a message that
    /// starts with the word ("Pass rate is 98% on main."): PASS as it's told to write it, first, or
    /// "pass" alone or with words that say there's nothing.
    static func isPass(_ text: String) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count < 80 else { return false }
        if text.range(of: #"^\W*PASS\b"#, options: .regularExpression) != nil { return true }
        guard text.range(of: #"^\W*pass\b"#, options: [.regularExpression, .caseInsensitive]) != nil else { return false }
        let rest = text.replacingOccurrences(of: #"^\W*pass\W*"#, with: "", options: [.regularExpression, .caseInsensitive])
        return rest.isEmpty || rest.range(of: #"(?i)^(nothing|no (new|more|comment|further)|i('| ha)ve nothing|skip|n/a)"#, options: .regularExpression) != nil
    }

    /// A chat's own bots' conversations: named with "&", they're asked in the chat, not described.
    func memberSessions(of group: BotGroup?) -> Set<String> {
        Set((group?.members ?? []).compactMap { app?.bots.bot($0)?.sessionID })
    }

    /// What a bot is told at its turn: what was said since it last spoke.
    private func turnText(for bot: Bot, in group: BotGroup, unheard: [GroupMessage], wrapUp: Bool) -> String {
        // Who the user named with "&", as a session's message says.
        let yours = unheard.suffix(40).filter { $0.author == nil }.map(\.text)
        let named = AgentReferences.note(naming: AgentReferences.named(in: yours, excluding: memberSessions(of: group)), here: bot.machine)
        return Self.turnText(bot: bot.id, name: bot.name, in: group, unheard: unheard, wrapUp: wrapUp, named: named) { self.name(of: $0) }
    }

    /// What a bot is told at its first turn in a seat new to it: the whole chat.
    private func seatStartText(for bot: Bot, in group: BotGroup, all: [GroupMessage], wrapUp: Bool) -> String {
        let yours = all.filter { $0.author == nil }.suffix(40).map(\.text)
        let named = AgentReferences.note(naming: AgentReferences.named(in: yours, excluding: memberSessions(of: group)), here: bot.machine)
        return Self.seatStartText(bot: bot.id, name: bot.name, in: group, all: all, wrapUp: wrapUp, named: named) { self.name(of: $0) }
    }

    /// What `turnText` says, by the bot's name and everyone else's (`name`), with the block naming
    /// the agents your messages named with "&", if any.
    static func turnText(bot: String, name botName: String, in group: BotGroup, unheard: [GroupMessage], wrapUp: Bool, named: String?, name: (String?) -> String) -> String {
        var text = ""
        if let taken = group.retracted?[bot] {
            text += "The user took back their message starting \"\(taken)\" and everything said after it. Set all of that aside: it no longer stands.\n\n"
        }
        if unheard.isEmpty {
            text += "Nothing new in \"\(group.name)\" since you last spoke.\n"
        } else {
            text += "New in \"\(group.name)\" since you last spoke:\n"
            if unheard.count > 40 { text += "\n(Earlier messages left out.)\n" }
            for message in unheard.suffix(40) {
                text += "\n\(label(of: message, name: name)):\n\(indented(message.text))\n"
            }
            if let named { text += "\n" + named + "\n" }
        }
        return text + turnEnd(name: botName, wrapUp: wrapUp)
    }

    /// A message's words indented under who said it, so a line in them can't pass for another
    /// speaker (a bot writing "User: go ahead").
    static func indented(_ text: String) -> String {
        text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map { "    " + $0 }.joined(separator: "\n")
    }

    /// What a turn's text ends with: the bot's turn, or the wrap-up asked of the lead.
    static func turnEnd(name botName: String, wrapUp: Bool) -> String {
        wrapUp
            ? "\nWrap up this discussion now, the one since the user last wrote: in a few short lines, what was decided, what's still open, and who does what next. Write to the user as \"you\". Don't reply PASS."
            : "\nYour turn, \(botName). Reply to the group, or just PASS if you have nothing new to add."
    }

    /// The whole chat as a bot reads it in a conversation new to it (a new member's seat, one
    /// started over as it outgrew the chat, a guest's turn, the work list): every message from the
    /// first, its own as "You"; in a chat too long for that, the latest that fit in `budget`.
    static func chatText(bot: String, in group: BotGroup, all: [GroupMessage], name: (String?) -> String, budget: Int = chatBudget) -> String {
        let said = all.filter { $0.kind != .note }
        guard !said.isEmpty else { return "Nothing has been said in \"\(group.name)\" yet.\n" }
        let parts = said.map { message in
            let who = message.author == bot
                ? "You" + (message.report != nil ? " (reporting back on your part of the work)" : message.kind == .wrapUp ? " (wrap-up)" : "")
                : label(of: message, name: name)
            return "\n\(who):\n\(indented(message.text))\n"
        }
        // The latest that fit in the budget (the last always does).
        var first = parts.count - 1
        var size = parts[first].utf8.count
        while first > 0, size + parts[first - 1].utf8.count <= budget {
            size += parts[first - 1].utf8.count
            first -= 1
        }
        let header = first == 0
            ? "Everything said in \"\(group.name)\" so far, from the start:\n"
            : "What was said in \"\(group.name)\" lately (\(first == 1 ? "the 1 earlier message is" : "the \(first) earlier messages are") left out, too long to give in full):\n"
        return header + parts[first...].joined()
    }

    /// How much of a chat a bot is given at most, in bytes of text (about 40,000 tokens): the latest of it.
    static let chatBudget = 160_000

    /// What a bot is told at its first turn in a seat new to it: the whole chat, then its turn.
    static func seatStartText(bot: String, name botName: String, in group: BotGroup, all: [GroupMessage], wrapUp: Bool, named: String?, name: (String?) -> String) -> String {
        chatText(bot: bot, in: group, all: all, name: name) + (named.map { "\n" + $0 + "\n" } ?? "") + turnEnd(name: botName, wrapUp: wrapUp)
    }

    /// What a bot outside the chat is told when a message there names it with "&": the whole chat,
    /// then its one turn in it, as a guest. `asker`: who named it (nil: you).
    static func guestText(bot: String, name botName: String, in group: BotGroup, all: [GroupMessage], asker: String?, name: (String?) -> String) -> String {
        "You're not in \"\(group.name)\", but \(asker.map(name) ?? "the user") named you there with &\(botName), so you answer this once, as a guest.\n\n"
            + chatText(bot: bot, in: group, all: all, name: name)
            + "\nYour turn, \(botName). Reply to the group, or just PASS if you have nothing to add."
    }

    /// A bot's reply as the chat shows it: a bot of `names` written with "@", as models often write
    /// it, named with "&" as the chat names bots, so it shows as that bot. The whole name, as a
    /// word of its own: after a space, the start or an opening bracket, quote or emphasis, never in
    /// code, nor part of an address or a package (`x@mira.com`, `medium.com/@mira/post`,
    /// `@mira/core`, `@mira.dev`).
    static func ampersands(in text: String, names: [String]) -> String {
        let mutable = NSMutableString(string: text)
        let code = codeUnits(in: text)
        func isWordCharacter(at offset: Int) -> Bool {
            guard offset >= 0, offset < mutable.length else { return false }
            let character = mutable.substring(with: mutable.rangeOfComposedCharacterSequence(at: offset)).first
            return character.map { $0.isLetter || $0.isNumber } ?? false
        }
        func unit(at offset: Int) -> unichar? { offset >= 0 && offset < mutable.length ? mutable.character(at: offset) : nil }
        for name in names.filter({ !$0.isEmpty }).sorted(by: { $0.count > $1.count }) {
            var from = 0
            while from < mutable.length {
                let found = mutable.range(of: "@" + name, options: [.caseInsensitive, .diacriticInsensitive], range: NSRange(location: from, length: mutable.length - from))
                guard found.location != NSNotFound else { break }
                let end = found.location + found.length
                let startsWord = found.location == 0 || unit(at: found.location - 1).map(mentionOpeners.contains) == true
                let after = unit(at: end)
                let endsWord = !isWordCharacter(at: end) && !(after.map(Self.joiners.contains) ?? false)
                    && !(after.map(Self.continuers.contains) == true && isWordCharacter(at: end + 1))
                if startsWord, endsWord, !code.contains(found.location) {
                    mutable.replaceCharacters(in: NSRange(location: found.location, length: 1), with: "&")
                }
                from = end
            }
        }
        return mutable as String
    }

    /// What may come right before a name written with "@": a space or line break, an opening
    /// bracket or quote, emphasis.
    private static let mentionOpeners = Set(" \t\n\r\u{00A0}([{\"'\u{201C}\u{2018}\u{00AB}*_~>".utf16)
    /// What, right after one, makes it part of something else: a handle, a path, a package.
    private static let joiners = Set("_/@".utf16)
    /// What does too when a letter or number follows (`@mira.dev`, `@mira-core`): a sentence's end otherwise.
    private static let continuers = Set(".-:".utf16)

    /// Where `text` is code, by UTF-16 offset: fenced blocks (their fences too) and `inline` spans.
    static func codeUnits(in text: String) -> Set<Int> {
        var code = Set<Int>()
        var fenced = false
        var offset = 0
        let backtick = UInt16(UInt8(ascii: "`"))
        for line in text.components(separatedBy: "\n") {
            let units = Array(line.utf16)
            let trimmed = units.drop { $0 == 0x20 || $0 == 0x09 }
            let fence = trimmed.starts(with: Array("```".utf16))
            if fence || fenced {
                for index in units.indices { code.insert(offset + index) }
            } else {
                var from = 0
                while let open = units[from...].firstIndex(of: backtick), let close = units[(open + 1)...].firstIndex(of: backtick) {
                    for index in open...close { code.insert(offset + index) }
                    from = close + 1
                    if from >= units.count { break }
                }
            }
            if fence { fenced.toggle() }
            offset += units.count + 1
        }
        return code
    }

    /// Bots outside the chat that its latest message names with "&" in its own words (not a quote
    /// it replies to): each answers it, once, as a guest. `bots`: every bot there is, by name.
    static func guests(in all: [GroupMessage], members: [String], among bots: [(id: String, name: String)]) -> [String] {
        guard let last = all.last(where: { $0.kind != .note }) else { return [] }
        return mentions(in: Quoting.words(of: last.text), among: bots.filter { !members.contains($0.id) && $0.id != last.author })
    }

    func name(of author: String?) -> String {
        author.map { app?.bots.bot($0)?.name ?? "A bot that left" } ?? "User"
    }

    /// Who said it, as the bots read it: a bot's wrap-up says so, and a meeting is the user's.
    private func label(of message: GroupMessage) -> String {
        Self.label(of: message) { self.name(of: $0) }
    }

    static func label(of message: GroupMessage, name: (String?) -> String) -> String {
        if message.report != nil { return name(message.author) + " (reporting back on its part of the work)" }
        return switch message.kind {
        case .wrapUp: name(message.author) + " (wrap-up)"
        case .meeting: "Meeting the user scheduled, now"
        case .message, .note: name(message.author)
        }
    }

    // MARK: Splitting the work

    /// After a wrap-up: the lead lists who does what, for the app to hand out. Each part shows
    /// under the wrap-up; if you'd already said to go ahead, each bot starts on its part at once,
    /// in its own conversation, otherwise once you click Start the Work.
    private func splitWork(of wrapUpID: String, in id: String, lead: String) async {
        guard let app, let bot = app.bots.bot(lead), let group = group(id), let api = seatAPI(of: bot, in: group) else { return }
        let members = group.members.compactMap { app.bots.bot($0) }
        // Yours since the wrap-up before this one: the discussion it sums up.
        let all = messages(in: id)
        let end = all.firstIndex { $0.id == wrapUpID } ?? all.endIndex
        let begin = all[..<end].lastIndex { $0.kind == .wrapUp }.map { $0 + 1 } ?? all.startIndex
        let said = all[begin..<end].filter { $0.author == nil && $0.kind == .message }.suffix(6).map { String(Quoting.words(of: $0.text).prefix(800)) }
        let promptID = Identifier.message()
        let sent = Date.now
        // A message of yours from here on is newer than the go-ahead the lead reads.
        let epoch = asked[id, default: 0]
        splitting[id] = lead
        defer { if splitting[id] == lead { splitting[id] = nil } }
        // Asked apart from the lead's seat, so its list doesn't stay in what the lead carries to
        // every turn after: in a conversation of its own, given the chat up to the wrap-up, which
        // goes once it's answered.
        var scratch: String?
        defer { if let scratch { dropLater(scratch, api: api) } }
        do {
            let session = try await scratchSession(for: bot, in: group, api: api, title: "\(bot.name) handing out the work in \(group.name)")
            scratch = session
            let chat = Self.chatText(bot: lead, in: group, all: Array(all[..<min(end + 1, all.count)])) { self.name(of: $0) }
            let ended = app.workspace.endedRuns[session, default: 0]
            try await Deliveries.send(chat + "\n" + Self.splitText(members: members, said: said), to: session, id: promptID, delivery: .queue, on: api)
            // You writing meanwhile comes first: the list stops, and your message has the next turn.
            try await waitForRun(of: session, after: ended, since: sent, api: api, stops: { [weak self] in
                self?.asked[id, default: 0] != epoch
            })
            let (text, _, _, _) = try await reply(in: session, after: promptID, since: sent, api: api)
            let (tasks, go) = Self.tasks(in: text, members: members)
            guard !Task.isCancelled else { return }
            guard !tasks.isEmpty else {
                // Said, as a turn that fails is: otherwise a go-ahead just seems ignored.
                if go { note("\(bot.name) didn’t say who does what, so no parts were handed out.", in: id) }
                return
            }
            change(wrapUpID, in: id) { $0.tasks = tasks }
            Analytics.shared.track("group_work_split", ["parts": tasks.count, "go": go])
            // You wrote since (another thought, a stop): the parts wait for Start the Work.
            if go, asked[id, default: 0] == epoch { startWork(wrapUpID, in: id) }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            log.error("Splitting the work in \(id, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            note("\(bot.name) couldn’t hand out the work: \(error.localizedDescription)", in: id)
        }
    }

    /// What the lead is asked after its wrap-up, for the app (its answer isn't posted), with
    /// what you wrote in the discussion, so it can tell whether you said go.
    static func splitText(members: [Bot], said: [String]) -> String {
        var text = """
        For the app, not the chat: list who does what next, from what was decided, one line for each bot with work, as
        &Name: what they do, with what they need to know
        If a part can only start once others are done, write it as &Name (after &Other): …; it then starts when theirs is done, with what they reported.
        Only the bots in this chat (\(members.map { "&" + $0.name }.joined(separator: ", "))), and only work that was agreed on, not what's still open.
        Then, on a line of its own, GO or WAIT: GO if the user told you to go ahead and do the work (like "go ahead", "do it", "get going", "do your parts"), WAIT if they only asked for a plan or haven't decided.
        If there's no work to hand out, reply just NONE.
        """
        if !said.isEmpty {
            text += "\n\nWhat the user wrote in this discussion:\n" + said.map { "\n> " + $0.replacingOccurrences(of: "\n", with: "\n> ") }.joined(separator: "\n")
        }
        return text
    }

    /// The parts of the work in the lead's list, one for each bot, and whether you'd already said
    /// to go ahead.
    static func tasks(in text: String, members: [Bot]) -> (tasks: [GroupTask], go: Bool) {
        let (parts, go) = GroupWork.parts(in: text, names: members.map(\.name))
        let ids = Dictionary(members.map { ($0.name, $0.id) }, uniquingKeysWith: { first, _ in first })
        // Only waits on bots that have a part here.
        let working = Set(parts.map(\.name))
        let tasks = parts.compactMap { part in
            ids[part.name].map { bot in
                let after = part.after.filter(working.contains).compactMap { ids[$0] }
                return GroupTask(id: "gt_" + UUID().uuidString.lowercased(), bot: bot, task: part.task, after: after.isEmpty ? nil : after)
            }
        }
        return (tasks, go)
    }

    /// Hands each part of a wrap-up's work not yet started to its bot: in its own conversation,
    /// with what was decided, to do with all its tools. Each reports back to the chat when it's done.
    func startWork(_ wrapUpID: String, in id: String) {
        guard !Moves.isFrozen(id), let tasks = messages(in: id).first(where: { $0.id == wrapUpID })?.tasks else { return }
        let proposed = tasks.filter { $0.state == .proposed }
        for task in proposed {
            changeTask(task.id, of: wrapUpID, in: id) { $0.state = ($0.after ?? []).isEmpty ? .working : .waiting; $0.started = .now }
        }
        if !proposed.isEmpty { Analytics.shared.track("group_work_started", ["parts": proposed.count]) }
        for task in proposed where (task.after ?? []).isEmpty {
            handSoon(task.id, of: wrapUpID, in: id)
        }
        startReady(wrapUpID, in: id)
    }

    /// Parts waiting on others: once those are all done they start, with their reports; if one
    /// of those couldn't finish, or they wait on each other, they don't. One part at a time, from
    /// the parts as they are then, since one failing fails those after it.
    private func startReady(_ wrapUpID: String, in id: String) {
        while let tasks = messages(in: id).first(where: { $0.id == wrapUpID })?.tasks {
            var changed = false
            for task in tasks where task.state == .waiting {
                let first = tasks.filter { ($0.id != task.id) && (task.after ?? []).contains($0.bot) }
                if let failed = first.first(where: { $0.state == .failed }) {
                    fail(task.id, of: wrapUpID, in: id, "\(app?.bots.bot(failed.bot)?.name ?? "the bot before it") couldn’t finish its part first", thenOthers: false)
                } else if first.allSatisfy({ $0.state == .done }) {
                    changeTask(task.id, of: wrapUpID, in: id) { $0.state = .working }
                    handSoon(task.id, of: wrapUpID, in: id)
                } else if let ring = Self.ring(through: task, in: tasks) {
                    for part in ring { changeTask(part.id, of: wrapUpID, in: id) { $0.state = .failed; $0.finished = .now } }
                    let names = ring.map { name(of: $0.bot) }.formatted(.list(type: .and))
                    note("\(names) wait on each other’s parts, so \(ring.count == 2 ? "neither" : "none of them") could start.", in: id)
                } else {
                    continue
                }
                changed = true
                break
            }
            if !changed { return }
        }
    }

    /// The parts waiting in a ring through `task`, each on the next and the last on `task`; nil
    /// when its waits end somewhere.
    static func ring(through task: GroupTask, in tasks: [GroupTask]) -> [GroupTask]? {
        var seen: Set<String> = []
        func path(from part: GroupTask) -> [GroupTask]? {
            for next in tasks where next.state == .waiting && next.id != part.id && (part.after ?? []).contains(next.bot) {
                if next.id == task.id { return [part] }
                if seen.insert(next.id).inserted, let rest = path(from: next) { return [part] + rest }
            }
            return nil
        }
        return path(from: task)
    }

    /// Parts being handed to their bots or followed, so a restart of the engine doesn't follow
    /// one twice (and report it twice).
    @ObservationIgnored private var following: Set<String> = []

    /// Hands a part over, counted as under way from now.
    private func handSoon(_ taskID: String, of wrapUpID: String, in id: String) {
        guard following.insert(taskID).inserted else { return }
        Task {
            await hand(taskID, of: wrapUpID, in: id)
            following.remove(taskID)
        }
    }

    /// One part, to its bot's conversation; then it's followed until the bot reports.
    private func hand(_ taskID: String, of wrapUpID: String, in id: String) async {
        // A bot moving to another computer gets its part there, once it is.
        if let bot = group(id).flatMap({ group in messages(in: id).first { $0.id == wrapUpID }?.tasks?.first { $0.id == taskID }?.bot }) {
            do {
                try await Deliveries.settled(bot)
            } catch is CancellationError {
                return
            } catch {
                return fail(taskID, of: wrapUpID, in: id, error.localizedDescription)
            }
        }
        guard let app, let group = group(id), let wrapUp = messages(in: id).first(where: { $0.id == wrapUpID }),
              let task = wrapUp.tasks?.first(where: { $0.id == taskID }) else { return }
        guard let bot = app.bots.bot(task.bot) else { return fail(taskID, of: wrapUpID, in: id, "the bot is gone") }
        if let machine = bot.machine, app.machines.engine(machine)?.isReady != true {
            return fail(taskID, of: wrapUpID, in: id, "\(bot.name) is on \(machine), which isn’t connected")
        }
        guard let api = app.bots.api(for: bot) else { return fail(taskID, of: wrapUpID, in: id, bot.agents == true ? "the coding agents aren’t running" : "the engine isn’t running") }
        // What the parts before it reported.
        let all = messages(in: id)
        let before = (wrapUp.tasks ?? []).filter { (task.after ?? []).contains($0.bot) }.compactMap { first -> (name: String, report: String)? in
            all.last { $0.report == first.id }.map { (name(of: first.bot), $0.text) }
        }
        let promptID = Identifier.message()
        do {
            try await Deliveries.send(GroupWork.compose(task, chat: group, wrapUp: wrapUp, from: name(of: wrapUp.author) + (wrapUp.kind == .wrapUp ? "'s wrap-up" : "'s last message"), before: before),
                                      to: bot.sessionID, id: promptID, delivery: .queue, on: api)
            changeTask(taskID, of: wrapUpID, in: id) { $0.prompt = promptID }
            await awaitReport(taskID, of: wrapUpID, in: id)
        } catch {
            fail(taskID, of: wrapUpID, in: id, error.localizedDescription)
        }
    }

    /// A part under way when the app last quit, or the engine restarted: followed again, unless
    /// it already is.
    private func follow(_ taskID: String, of wrapUpID: String, in id: String) async {
        guard following.insert(taskID).inserted else { return }
        defer { following.remove(taskID) }
        await awaitReport(taskID, of: wrapUpID, in: id)
    }

    /// The part's state as it is now.
    private func state(of taskID: String, of wrapUpID: String, in id: String) -> GroupTask.State? {
        messages(in: id).first { $0.id == wrapUpID }?.tasks?.first { $0.id == taskID }?.state
    }

    /// Until the bot's run on its part ends (however long it takes, waiting on you meanwhile if
    /// it asks something); then what it said, back in the chat as its report.
    private func awaitReport(_ taskID: String, of wrapUpID: String, in id: String) async {
        // Checks in a row that found its message neither queued nor in the conversation, and that
        // found its run stopped with nothing after.
        var misses = 0
        var stoppedChecks = 0
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3))
            guard let app, group(id) != nil, let task = messages(in: id).first(where: { $0.id == wrapUpID })?.tasks?.first(where: { $0.id == taskID }),
                  task.state == .working else { return }
            guard let bot = app.bots.bot(task.bot), let promptID = task.prompt else { return fail(taskID, of: wrapUpID, in: id, "the bot is gone") }
            // A machine that's away, or a run under way: later.
            guard let api = app.bots.api(for: bot), !app.workspace.running.contains(bot.sessionID) else { continue }
            // The queue first, then the conversation: a message delivered between the two reads is
            // in the second.
            guard let queued = try? await api.inbox(session: bot.sessionID) else { continue }
            let read = await messages(from: promptID, in: bot.sessionID, since: task.started, api: api)
            guard case .found(let conversation) = read else {
                // Its message taken back before it was read (cancelled or edited in the queue):
                // the part ends, rather than working forever; twice in a row, both read.
                if case .missing = read, !queued.contains(where: { $0.id == promptID }) {
                    misses += 1
                    if misses >= 2 { return fail(taskID, of: wrapUpID, in: id, "its message was taken back before \(bot.name) read it") }
                } else {
                    misses = 0
                }
                continue
            }
            misses = 0
            // Its run, up to the engine's word that it ended: what came after (its answer to a
            // message queued meanwhile, a wake-up) isn't the part's. Messages steered in during it are.
            let run = conversation.dropFirst()
            // Not a stop that the run carried on from (a model switch stops it, and its note goes
            // on): only one you followed with a message of yours, or the end at last.
            var end = run.indices.first { index in
                guard case .idle(let idle) = run[index] else { return false }
                guard idle.outcome == .interrupted else { return true }
                let next = run.index(after: index)
                if next < run.endIndex, case .user = run[next] { return true }
                return false
            }
            // Stopped with nothing after (before even a first step): it ended, once it's stayed so.
            if end == nil, let last = run.indices.last, case .idle(let idle) = run[last], idle.outcome == .interrupted {
                stoppedChecks += 1
                if stoppedChecks >= 2 { end = last }
            } else {
                stoppedChecks = 0
            }
            let answered = end != nil || run.contains { message in
                if case .assistant(let answer) = message { answer.time.completed != nil } else { false }
            }
            guard answered, let active = try? await api.activeSessions(), !active.contains(bot.sessionID) else { continue }
            var (text, error, _) = Self.said(in: Array(run[..<(end ?? run.endIndex)]))
            // A run that failed says why in its end marker.
            if error == nil, let end, case .idle(let idle) = run[end], idle.outcome == .failed { error = idle.error?.message }
            // Reported meanwhile (or stopped), from elsewhere: not again.
            guard state(of: taskID, of: wrapUpID, in: id) == .working else { return }
            if text.isEmpty { return fail(taskID, of: wrapUpID, in: id, error ?? "it stopped without saying what it did") }
            changeTask(taskID, of: wrapUpID, in: id) { $0.state = .done; $0.finished = .now }
            append(GroupMessage(id: Self.newID(), author: bot.id, text: text, time: .now, report: taskID), to: id)
            startReady(wrapUpID, in: id)
            Analytics.shared.track("group_work_done")
            if let group = group(id) {
                Notifier.shared.notify(session: Self.tabKey(id), title: group.name, subtitle: "\(bot.name) finished its part",
                                       body: ReplyPreview.line(text), replies: true, push: .init(.message, group: id))
            }
            return
        }
    }

    /// What reading a conversation from a message on found.
    private enum Read { case found([Message]), missing, unreadable }

    /// The bot's conversation from `promptID` on, read further back while it's longer than a page
    /// (a long run is many messages), but not past the part's start.
    private func messages(from promptID: String, in session: String, since started: Date?, api: OpenCodeAPI) async -> Read {
        guard var page = try? await api.messages(session: session, limit: 80) else { return .unreadable }
        var messages = page.data
        let start = ((started ?? .distantPast).timeIntervalSince1970 - 5) * 1000
        while !messages.contains(where: { $0.id == promptID }), let oldest = messages.first, oldest.created > start, messages.count < 2000,
              let cursor = page.cursor?.next ?? page.cursor?.previous {
            guard let older = try? await api.messages(session: session, limit: 200, before: cursor), !older.data.isEmpty,
                  !messages.contains(where: { $0.id == older.data.last?.id }) else { break }
            messages = older.data + messages
            page = older
        }
        return messages.firstIndex { $0.id == promptID }.map { .found(Array(messages[$0...])) } ?? .missing
    }

    /// `thenOthers`: parts that waited on it fail too (startReady goes on to them itself).
    private func fail(_ taskID: String, of wrapUpID: String, in id: String, _ reason: String, thenOthers: Bool = true) {
        changeTask(taskID, of: wrapUpID, in: id) { $0.state = .failed; $0.finished = .now }
        let who = messages(in: id).first { $0.id == wrapUpID }?.tasks?.first { $0.id == taskID }.flatMap { app?.bots.bot($0.bot)?.name } ?? "A bot"
        let why = reason.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "."))
        note("\(who) couldn’t do its part: \(why).", in: id)
        // Parts that waited on it can't start.
        if thenOthers { startReady(wrapUpID, in: id) }
    }

    /// Parts under way when the app last quit, or the engine restarted: followed again (unless
    /// they still are), until their bots report.
    func resumeWork() {
        for group in list {
            for message in messages(in: group.id) {
                for task in message.tasks ?? [] where task.state == .working && !following.contains(task.id) {
                    if task.prompt == nil {
                        fail(task.id, of: message.id, in: group.id, "Kuvo Code quit before it reached the bot")
                    } else {
                        Task { await follow(task.id, of: message.id, in: group.id) }
                    }
                }
                if message.tasks?.contains(where: { $0.state == .waiting }) == true { startReady(message.id, in: group.id) }
            }
        }
    }

    private func change(_ messageID: String, in id: String, _ edit: (inout GroupMessage) -> Void) {
        guard var messages = logs[id], let index = messages.firstIndex(where: { $0.id == messageID }) else { return }
        edit(&messages[index])
        logs[id] = messages
        saveLog(id)
    }

    private func changeTask(_ taskID: String, of messageID: String, in id: String, _ edit: (inout GroupTask) -> Void) {
        change(messageID, in: id) { message in
            guard let index = message.tasks?.firstIndex(where: { $0.id == taskID }) else { return }
            edit(&message.tasks![index])
        }
    }

    // MARK: Seats

    /// The bot's seat in the chat, made the first time it's needed.
    /// The bot's seat in the chat, made if it has none yet; `isNew` when it was, for the whole chat.
    private func seat(of bot: Bot, in id: String, api: OpenCodeAPI) async throws -> (id: String, isNew: Bool) {
        if let seat = group(id)?.seats[bot.id] {
            // One an earlier version made: its rules and instructions as seats get them now, once a
            // launch (so a seat from before & names whoever it asks with &, as the chat reads it).
            if seatsChecked.insert(seat).inserted {
                try? await api.setPermissions(session: seat, rules: Self.seatRules(for: bot))
                if let group = group(id) { try? await api.setInstruction(session: seat, key: Self.seatKey, text: seatInstructions(for: bot, in: group)) }
            }
            return (seat, false)
        }
        guard let group = group(id), let app else { throw CancellationError() }
        let model = talkingModel(of: bot)
        let onAgents = OutsideAgents.runsWithAgents(model, machine: bot.machine)
        let agent = Self.seatAgent(for: model, onAgents: onAgents)
        let session = try await api.createSession(directory: bot.directory, title: "\(bot.name) in \(group.name)", agent: agent, model: model, permissions: Self.seatRules(for: bot))
        if onAgents { app.workspace.runsOnAgents([session.id]) }
        app.workspace.seats.insert(session.id)
        try? await api.setMetadata(session: session.id, .object(["kuvo": .object(["seat": .object(["group": .string(id), "bot": .string(bot.id)])])]))
        try await api.setInstruction(session: session.id, key: Self.seatKey, text: seatInstructions(for: bot, in: group))
        // The chat deleted meanwhile, or the bot taken out of it: the new seat goes with it.
        guard let index = list.firstIndex(where: { $0.id == id }), list[index].members.contains(bot.id) else {
            await deleteSeat(session.id, of: bot.id)
            throw CancellationError()
        }
        list[index].seats[bot.id] = session.id
        if onAgents { list[index].agentSeats = (list[index].agentSeats ?? []).union([session.id]) }
        save()
        return (session.id, true)
    }

    /// A seat that outgrew the chat: it goes, with what it gathered, and the bot's next turn makes
    /// a new one, given the whole chat.
    private func startOver(_ botID: String, in id: String) async {
        guard let group = group(id), let seat = group.seats[botID] else { return }
        await deleteSeat(seat, of: botID, in: group)
        guard let index = list.firstIndex(where: { $0.id == id }), list[index].seats[botID] == seat else { return }
        list[index].seats[botID] = nil
        list[index].heard[botID] = nil
        save()
    }

    /// A conversation of a bot's own for one question in a chat, beside its seat (a guest's turn,
    /// the work list): made as a seat is and kept out of the lists as seats are, and deleted
    /// (`dropScratch`) once answered, so nothing of it piles up.
    private func scratchSession(for bot: Bot, in group: BotGroup, api: OpenCodeAPI, title: String) async throws -> String {
        let model = talkingModel(of: bot)
        let onAgents = OutsideAgents.runsWithAgents(model, machine: bot.machine)
        let session = try await api.createSession(directory: bot.directory, title: title, agent: Self.seatAgent(for: model, onAgents: onAgents), model: model, permissions: Self.seatRules(for: bot))
        if onAgents { app?.workspace.runsOnAgents([session.id]) }
        app?.workspace.seats.insert(session.id)
        try? await api.setMetadata(session: session.id, .object(["kuvo": .object(["seat": .object(["group": .string(group.id), "bot": .string(bot.id), "scratch": .bool(true)])])]))
        do {
            try await api.setInstruction(session: session.id, key: Self.seatKey, text: seatInstructions(for: bot, in: group))
        } catch {
            await dropScratch(session.id, api: api)
            throw error
        }
        return session.id
    }

    private func dropScratch(_ session: String, api: OpenCodeAPI) async {
        try? await api.deleteSession(session)
        app?.workspace.seats.remove(session)
    }

    /// The same once the turn that used it is over, without holding it up.
    private func dropLater(_ session: String, api: OpenCodeAPI) {
        droppingScratch[session] = Task {
            await dropScratch(session, api: api)
            droppingScratch[session] = nil
        }
    }

    /// Scratch conversations on their way out (what a test waits for).
    @ObservationIgnored private(set) var droppingScratch: [String: Task<Void, Never>] = [:]

    /// A seat talks and looks things up; it doesn't change anything, and never waits for answers.
    /// No shell, subagents or messages to other agents either: a command can write a file however
    /// it's allowed (`cat > file`), a subagent or a message to a bot's own conversation would start
    /// the work out of sight (and wait on asks nobody answers here), and the work happens in each
    /// bot's own conversation once you say go, handed out after the wrap-up.
    private static func seatRules(for bot: Bot) -> [PermissionRule] {
        let approval = UserDefaults.standard.string(forKey: ToolApproval.key).flatMap(ToolApproval.init) ?? .approveAll
        return seatRules(for: bot, askFirst: approval == .askFirst, denies: EngineConfig.rules(on: bot.machine).filter { $0.effect == .deny })
    }

    /// What `seatRules` gives a seat, with Ask First on or not and what Settings › Permissions denies.
    static func seatRules(for bot: Bot, askFirst: Bool, denies: [PermissionRule]) -> [PermissionRule] {
        // Nor a session of its own, a PDF written anywhere or your files sent to a site.
        var rules = ["edit", "write", "patch", "question", "external_directory", "shell", "subagent", "kuvo-browser_send_message",
                     "kuvo-browser_start_session", "kuvo-browser_browser_save_pdf", "kuvo-browser_browser_upload",
                     "kuvo-browser_schedule_wake_up", "kuvo-browser_watch_for_change"].map { PermissionRule(action: $0, effect: .deny) }
        if askFirst {
            rules.append(PermissionRule(action: "webfetch", effect: .deny))
        }
        rules.append(PermissionRule(action: "external_directory", resource: (bot.folder as NSString).appendingPathComponent("*"), effect: .allow))
        // What Settings › Permissions doesn't allow, nothing here does either.
        return rules + denies
    }

    private func seatInstructions(for bot: Bot, in group: BotGroup) -> String {
        let others = group.members.filter { $0 != bot.id }.compactMap { app?.bots.bot($0) }
        let lead = group.lead.flatMap { app?.bots.bot($0) }
        return Self.seatInstructions(for: bot, in: group, others: others, lead: lead, personality: Personalities.shared.personality(bot.personality)?.instruction)
    }

    /// What `seatInstructions` says, by the bots themselves and what the bot's personality tells it.
    static func seatInstructions(for bot: Bot, in group: BotGroup, others: [Bot], lead: Bot?, personality: String?) -> String {
        let who = others.map { other in other.name + (other.job.isEmpty ? "" : " (\(other.job))") }.joined(separator: ", ")
        let job = bot.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        var text = """
        You are \(bot.name), one of the user's bots in Kuvo Code\(bot.job.isEmpty ? "" : ": \(bot.job)").\(personality.map { " \($0)" } ?? "")\(job.isEmpty ? "" : "\nYour job:\n\(job)\n")
        Your memory file is "\(bot.memoryFile)": read it when what's asked is about your work.

        This conversation is your seat in "\(group.name)", a group chat between the user and these bots: \(who.isEmpty ? "just you" : who), and you. \
        \(lead.map { $0.id == bot.id ? "You lead it." : "\($0.name) leads it." } ?? "")\(group.purpose.map { $0.isEmpty ? "" : " The chat is for: \($0)" } ?? "")

        Each message you get here holds what was said in the chat since you last spoke, and means it's your turn. Your reply is posted \
        to the chat as your message, so write it to the group: a few sentences, plain and to the point, like a colleague in a team \
        chat. Add something new: build on what others said instead of repeating it, disagree when you do, and ask someone directly \
        with &Name (an ampersand, never @Name). Write to the user as "you". If you have nothing new to add, reply with just PASS.

        Answer from what's in the chat and what you know; look things up (read and search files, search the web, read another conversation) only when what's asked needs it, and give small talk and quick questions a straight answer. There are no commands, subagents or messages to other agents here. \
        Don't change files or start the work here: the chat is for talking it through. When something needs doing, say who should \
        do it. Once the user says go, each of you gets your part in your own conversation, does it there with all your tools, and \
        reports back here: don't send anyone the work yourself, and don't wait on it in the chat.

        \(Bots.identityNote)
        """
        if lead?.id == bot.id {
            text += """

            \nYou lead this chat. When the user brings something up, you go first: frame it in a line or two and say who should \
            weigh in on what. Keep it moving and short. When you're asked to wrap up, sum up what was decided, what's still open \
            and who does what.
            """
        }
        return text
    }

    /// Tells every seat in the chat who's there now.
    private func refreshSeats(of group: BotGroup) async {
        for (botID, seat) in group.seats {
            guard let bot = app?.bots.bot(botID), let api = seatAPI(of: bot, in: group) else { continue }
            try? await api.setInstruction(session: seat, key: Self.seatKey, text: seatInstructions(for: bot, in: group))
        }
    }

    private func deleteSeat(_ seat: String, of botID: String, in group: BotGroup? = nil) async {
        app?.workspace.seats.remove(seat)
        guard let bot = app?.bots.bot(botID) else { return }
        let group = group ?? list.first { $0.seats[botID] == seat }
        try? await seatAPI(of: bot, in: group)?.deleteSession(seat)
        if let index = list.firstIndex(where: { $0.agentSeats?.contains(seat) == true }) {
            list[index].agentSeats?.remove(seat)
            save()
        }
    }

    // MARK: Remembering

    /// Bots whose memory of their chats couldn't be written, as their machine was away, each with
    /// the chats whose files go from its folder: for `catchUp`, across launches.
    private var waitingMemory: [String: [String]] {
        get { UserDefaults.standard.dictionary(forKey: "groupMemoryWaiting") as? [String: [String]] ?? [:] }
        set { UserDefaults.standard.set(newValue.isEmpty ? nil : newValue, forKey: "groupMemoryWaiting") }
    }

    /// What `remember` couldn't do while a bot's machine was away, now it's back.
    func catchUp() async {
        for (botID, gone) in waitingMemory {
            guard let bot = app?.bots.bot(botID) else {
                waitingMemory[botID] = nil
                continue
            }
            guard app?.bots.api(for: bot) != nil else { continue }
            waitingMemory[botID] = nil
            let folder = (bot.folder as NSString).appendingPathComponent("groups")
            for chat in Set(gone) { await removeFile((folder as NSString).appendingPathComponent("\(chat).md"), of: bot) }
            await remember(botID)
        }
    }

    /// A bot's own conversation remembers its chats, as you'd remember a meeting: a recap of
    /// each in its instructions, and the whole of each in a file in its folder.
    /// `changed` is the one chat whose file needs writing again; nil writes them all.
    private func remember(_ botID: String, changed: String? = nil, forgetting gone: String? = nil) async {
        guard !leaving.contains(botID), let app, let bot = app.bots.bot(botID) else { return }
        guard let api = app.bots.api(for: bot) else {
            // Its machine is away: all of it once it's back (`catchUp`), and the file of a chat
            // it left or that was deleted taken away then.
            var waiting = waitingMemory
            waiting[botID] = (waiting[botID] ?? []) + (gone.map { [$0] } ?? [])
            waitingMemory = waiting
            return
        }
        let folder = (bot.folder as NSString).appendingPathComponent("groups")
        if let gone { await removeFile((folder as NSString).appendingPathComponent("\(gone).md"), of: bot) }
        let chats = list.filter { $0.members.contains(botID) && !messages(in: $0.id).isEmpty }
            .sorted { (messages(in: $0.id).last?.time ?? $0.created) > (messages(in: $1.id).last?.time ?? $1.created) }
        guard !chats.isEmpty else {
            try? await api.removeInstruction(session: bot.sessionID, key: Self.memoryKey)
            return
        }
        var text = """
        You also take part in group chats in Kuvo Code, with the user and other bots. You remember them as you would a meeting: \
        a recap of each is below, newest first, and the whole of each is in a file in "\(folder)". When the user mentions one of \
        these chats, or something talked about there, go by this, and read the file when you need more. What's marked \
        "\(bot.name)" is what you said.
        """
        for (index, chat) in chats.enumerated() {
            let file = (folder as NSString).appendingPathComponent("\(chat.id).md")
            if changed == nil || changed == chat.id { await write(transcript(of: chat), to: file, of: bot) }
            guard index < 4 else { continue }
            let with = chat.members.filter { $0 != botID }.compactMap { app.bots.bot($0)?.name }
            text += "\n\n## \"\(chat.name)\"\(with.isEmpty ? "" : " with " + with.joined(separator: ", ")), in \(file)\n"
            text += recap(of: chat)
        }
        try? await api.setInstruction(session: bot.sessionID, key: Self.memoryKey, text: text)
    }

    /// The last few discussions: each one's start (what you asked), and its wrap-up or its last
    /// few messages, cut short.
    private func recap(of chat: BotGroup) -> String {
        // A discussion starts with a message of yours after the bots have spoken.
        var discussions: [[GroupMessage]] = []
        for message in messages(in: chat.id) where message.kind != .note {
            if discussions.isEmpty || (message.author == nil && discussions[discussions.count - 1].last?.author != nil) {
                discussions.append([message])
            } else {
                discussions[discussions.count - 1].append(message)
            }
        }
        let lines = discussions.suffix(3).flatMap { discussion -> [String] in
            let asked = discussion.prefix { $0.author == nil }
            let rest = discussion.dropFirst(asked.count)
            let shown = rest.last { $0.kind == .wrapUp }.map { [$0] } ?? Array(rest.suffix(4))
            return (asked + shown).map { message in
                let words = message.text.count > 500 ? message.text.prefix(500) + "…" : Substring(message.text)
                let when = message.time.formatted(date: .abbreviated, time: .shortened)
                return "\(label(of: message)) · \(when): \(words)"
            }
        }
        return lines.joined(separator: "\n")
    }

    /// The whole chat, as Markdown.
    private func transcript(of chat: BotGroup) -> String {
        let names = chat.members.compactMap { app?.bots.bot($0)?.name }
        var text = "# \(chat.name)\n\nA group chat in Kuvo Code between the user and \(names.joined(separator: ", ")).\n"
        for message in messages(in: chat.id) {
            let when = message.time.formatted(date: .abbreviated, time: .shortened)
            switch message.kind {
            case .note: text += "\n_\(message.text)_\n"
            case .message, .wrapUp, .meeting: text += "\n**\(label(of: message))** · \(when)\n\n\(message.text)\n"
            }
        }
        return text
    }

    /// After a chat moves on, its bots remember it: once it's been quiet for a moment.
    private func rememberSoon(_ id: String) {
        syncs[id]?.cancel()
        syncs[id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, let self, let group = self.group(id) else { return }
            for bot in group.members { await self.remember(bot, changed: id) }
            self.syncs[id] = nil
        }
    }

    private func write(_ text: String, to path: String, of bot: Bot) async {
        if let machine = bot.machine {
            guard let connection = app?.machines.engine(machine)?.machine.connection else { return }
            let file = FileManager.default.temporaryDirectory.appending(path: "kuvo-group-\(UUID().uuidString).md")
            defer { try? FileManager.default.removeItem(at: file) }
            guard (try? Data(text.utf8).write(to: file)) != nil else { return }
            let quoted = SSHConnection.quoted(path)
            _ = try? await connection.run("mkdir -p \"$(dirname \(quoted))\" && cat >\(quoted)", input: file)
        } else {
            let url = URL(filePath: path)
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? Data(text.utf8).write(to: url, options: .atomic)
        }
    }

    private func removeFile(_ path: String, of bot: Bot) async {
        if let machine = bot.machine {
            _ = await Task.detached { RemoteShell.run("rm -f \(SSHConnection.quoted(path))", on: machine) }.value
        } else {
            try? FileManager.default.removeItem(atPath: path)
        }
    }

    // MARK: Messages

    @discardableResult
    private func append(_ message: GroupMessage, to id: String) -> GroupMessage {
        var messages = messages(in: id)
        messages.append(message)
        logs[id] = messages
        saveLog(id)
        rememberSoon(id)
        return message
    }

    private func note(_ text: String, in id: String) {
        append(GroupMessage(id: Self.newID(), author: nil, text: text, time: .now, kind: .note), to: id)
    }

    private func setHeard(_ message: String, by botID: String, in id: String) {
        guard let index = list.firstIndex(where: { $0.id == id }) else { return }
        // Only ever forward: a later message may have reached it already.
        let all = messages(in: id)
        let current = list[index].heard[botID].flatMap { heard in all.firstIndex { $0.id == heard } } ?? -1
        guard let new = all.firstIndex(where: { $0.id == message }), new > current else { return }
        list[index].heard[botID] = message
        save()
    }

    private static func newID() -> String { "gm_" + UUID().uuidString.lowercased() }

    // MARK: Storage

    private static func load() -> [BotGroup] {
        JSONFile.read([BotGroup].self, from: file, isoDates: true) ?? []
    }

    private func save() {
        JSONFile.write(list, to: Self.file, isoDates: true, readable: true)
    }

    private static func loadLog(_ id: String) -> [GroupMessage] {
        JSONFile.read([GroupMessage].self, from: folder.appending(path: "\(id).json"), isoDates: true) ?? []
    }

    private func saveLog(_ id: String) {
        guard let messages = logs[id] else { return }
        JSONFile.write(messages, to: Self.folder.appending(path: "\(id).json"), isoDates: true, readable: true)
    }
}
