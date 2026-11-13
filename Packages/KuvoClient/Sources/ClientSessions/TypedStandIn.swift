import Foundation
import OpenCodeKit

/// `kuvo/sessions/<id>/typed` as a pretend computer answers it: the phone's sample Mac, and the
/// computers the apps' tests stand in for, where the box itself can't run (on an iPhone). Never a
/// client's way to read what was typed: a client asks its box (`Typed`). It decides as the box does
/// (Packages/Box/src/link/typed/decide.ts, areas/typed.ts) and is held to the box's own cases,
/// `Vectors/typed.json`'s `decide` (KuvoClient's TypedVectorsTests), so what a stand-in answers is
/// what a box would.
public enum TypedStandIn {
    /// What the pretend computer knows of the conversation and the composer as the text is sent.
    public struct Facts {
        public var keywords: [Keyword]
        /// The engine's commands in the conversation's folder, as it lists them.
        public var commands: [Command]
        public var files: Bool
        public var side: Bool
        public var refusal: String?
        public var readers: [ReviewCommand.Reader]
        public var reviewer: ModelRef?
        public var subagent: Bool
        public var hasGoal: Bool
        public var botChat: Bool
        /// Its agents bridge runs.
        public var bridge: Bool
        public var now: Date
        /// Its clock (its time zone).
        public var calendar: Calendar

        public init(keywords: [Keyword], commands: [Command] = [], files: Bool = false, side: Bool = false, refusal: String? = nil, readers: [ReviewCommand.Reader] = [],
                    reviewer: ModelRef? = nil, subagent: Bool = false, hasGoal: Bool = false, botChat: Bool = false, bridge: Bool, now: Date = .now, calendar: Calendar = .current) {
            self.keywords = keywords
            self.commands = commands
            self.files = files
            self.side = side
            self.refusal = refusal
            self.readers = readers
            self.reviewer = reviewer
            self.subagent = subagent
            self.hasGoal = hasGoal
            self.botChat = botChat
            self.bridge = bridge
            self.now = now
            self.calendar = calendar
        }
    }

    /// A decision, as the box's `decide` gives it (JSON): what the box does (`box`, and what goes
    /// back if that fails, `failed`), what the client does, what goes back.
    public typealias Decision = [String: Any]

    static let subagentGoal = "A subagent’s conversation can’t have a goal of its own. Set it in the conversation it works for."
    public static let goalsNotRunning = "Goals run in the agents bridge beside the engine on this conversation’s computer, and it isn’t running now. Try again in a moment."
    public static let keywordUnavailable = "This runs in the agents bridge beside the engine on this conversation’s computer, and it isn’t running now. Try again in a moment."
    static let loopNoSchedule = "Can’t tell how often from that. Start with one like “every 30 min” or “weekdays at 9”, or pick one from the list after /loop."
    static let loopNoMessage = "Write what to do each time after how often, like “/loop every morning at 9 sum up the new issues”."
    static let reviewPick = "Pick who reads it from the list, or write a model’s name after “with”."
    static let reviewFinish = "Finish the model’s name, or pick it from the list."

    /// The keywords a conversation offers: none in a subagent's; goals, side questions, handoffs
    /// and reviews while its agents bridge runs; the rest always.
    public static func keywords(subagent: Bool, bridge: Bool) -> [Keyword] {
        guard !subagent else { return [] }
        return Keyword.allCases.filter { [.goal, .review, .btw, .handoff].contains($0) ? bridge : true }
    }

    /// What `GET` answers: the keywords, worded, and the commands "/" lists.
    public static func offers(keywords: [Keyword], commands: [Command]) -> [String: Any] {
        ["keywords": keywords.map { ["name": $0.rawValue, "title": $0.title, "summary": $0.summary, "argument": $0.argument as Any? ?? NSNull()] },
         "commands": Keyword.commands(commands, keywords: keywords).map { command -> [String: Any] in
             var said: [String: Any] = ["name": command.name]
             if let description = command.description { said["description"] = description }
             return said
         }]
    }

    /// What goes back for a keyword that couldn't be done (`writtenBack`).
    public static func writtenBack(_ written: String) -> [String: Any] {
        guard let (_, rest) = Keyword.parse(written) else { return ["text": written] }
        let goal = GoalCommand(written)
        let isSet = if case .set = goal { true } else { false }
        return ["text": written, "beside": goal == nil || isSet ? rest : ""]
    }

    static func shellCommand(_ text: String) -> String? {
        guard text.hasPrefix("!") else { return nil }
        let command = text.dropFirst().trimmingCharacters(in: .whitespacesAndNewlines)
        return command.isEmpty ? nil : command
    }

    static func typedKeyword(_ text: String, _ keywords: [Keyword]) -> (keyword: Keyword, rest: String)? {
        guard let (keyword, rest) = Keyword.parse(text), keyword != .goal, keywords.contains(keyword) else { return nil }
        return (keyword, rest)
    }

    static func needsModel(_ text: String) -> Bool {
        if shellCommand(text) != nil { return false }
        guard let goal = GoalCommand(text) else { return true }
        return goal.needsModel
    }

    public static func decide(_ text: String, _ facts: Facts) -> Decision {
        if let refusal = facts.refusal, !refusal.trimmingCharacters(in: .whitespaces).isEmpty, needsModel(text) { return ["restore": ["text": text], "error": refusal] }
        let commands = Keyword.commands(facts.commands, keywords: facts.keywords)
        let runsAsTyped = shellCommand(text) != nil || SlashCommands.parse(text, commands: commands) != nil || GoalCommand(text) != nil || typedKeyword(text, facts.keywords) != nil
        if facts.side, !runsAsTyped { return ["sideThread": true] }
        if let goal = GoalCommand(text) { return decideGoal(text, goal, facts) }
        if let (keyword, rest) = typedKeyword(text, facts.keywords) {
            var decision = decideKeyword(keyword, rest, text, facts)
            decision["keyword"] = keyword.rawValue
            return decision
        }
        if let split = SlashCommands.split(text), split.name == Keyword.quickReview, commands.contains(where: { $0.name == Keyword.quickReview }) {
            return ["command": ["name": "review", "arguments": split.arguments]]
        }
        if let shell = shellCommand(text) { return ["shell": shell] }
        if let run = SlashCommands.parse(text, commands: commands) { return ["command": ["name": run.name, "arguments": run.arguments]] }
        return ["send": ["text": text, "quoted": true]]
    }

    static func decideGoal(_ written: String, _ goal: GoalCommand, _ facts: Facts) -> Decision {
        let command: [String: Any]
        switch goal {
        case .show: return facts.hasGoal ? ["showGoal": true] : ["showGoal": true, "restore": ["text": "/goal "]]
        case .set(let words):
            if facts.botChat { return ["box": ["do": "askBot", "words": words], "failed": writtenBack(written)] }
            command = ["kind": "set", "words": words]
        case .pause: command = ["kind": "pause"]
        case .resume: command = ["kind": "resume"]
        case .clear: command = ["kind": "clear"]
        }
        if facts.subagent { return ["restore": writtenBack(written), "error": subagentGoal] }
        if !facts.bridge { return ["restore": writtenBack(written), "error": goalsNotRunning] }
        return ["box": ["do": "goal", "command": command], "failed": writtenBack(written)]
    }

    static func decideKeyword(_ keyword: Keyword, _ rest: String, _ written: String, _ facts: Facts) -> Decision {
        switch keyword {
        case .goal:
            return [:]
        case .plan:
            if rest.isEmpty, !facts.files { return ["plan": "toggle"] }
            return rest.isEmpty ? ["plan": "on"] : ["plan": "on", "send": ["text": rest, "typed": "/plan"]]
        case .autopilot:
            if rest.isEmpty, !facts.files { return ["toggleAutopilot": true] }
            var decision: Decision = ["box": ["do": "autopilot"], "failed": writtenBack(written)]
            if !rest.isEmpty { decision["send"] = ["text": rest, "typed": "/autopilot"] }
            return decision
        case .compact:
            return ["compact": true]
        case .loop:
            let loop = LoopCommand(rest)
            guard let schedule = loop.schedule else { return ["restore": writtenBack(written), "error": loopNoSchedule] }
            guard !loop.message.isEmpty else { return ["restore": writtenBack(written), "error": loopNoMessage] }
            let due = Int(schedule.firstWake(now: facts.now, calendar: facts.calendar).timeIntervalSince1970.rounded(.down))
            var decision: Decision = ["box": ["do": "wake", "due": due, "every": schedule.every.text, "note": loop.message], "failed": writtenBack(written)]
            if !schedule.keepsTimeOfDay { decision["send"] = ["text": loop.message, "typed": "/loop " + loop.scheduleText, "steer": true] }
            return decision
        case .btw:
            if rest.isEmpty { return ["restore": ["text": "/btw "]] }
            if !facts.bridge { return ["restore": writtenBack(written), "error": keywordUnavailable] }
            return ["box": ["do": "btw", "question": rest], "failed": writtenBack(written)]
        case .handoff:
            if !facts.bridge { return ["restore": writtenBack(written), "error": keywordUnavailable] }
            return ["box": ["do": "handoff", "next": rest.isEmpty ? NSNull() as Any : rest], "failed": writtenBack(written)]
        case .review:
            let review = ReviewCommand(rest, readers: facts.readers, preferring: facts.reviewer)
            if let searching = review.searching { return ["restore": writtenBack(written), "error": searching.isEmpty ? reviewPick : reviewFinish] }
            if let unfinished = ReviewList.unfinished(review) { return ["restore": writtenBack(written), "error": unfinished] }
            if !facts.bridge { return ["restore": writtenBack(written), "error": keywordUnavailable] }
            let scope: Any = review.scopeAsked.flatMap { $0 == .uncommitted ? nil : encoded($0) } ?? NSNull()
            let model: Any = review.reader.map { ["providerID": $0.ref.providerID, "id": $0.ref.id] } ?? NSNull()
            return ["box": ["do": "review", "model": model, "focus": review.focusAsked as Any? ?? NSNull(), "scope": scope], "failed": writtenBack(written)]
        }
    }

    static func encoded(_ scope: ReviewScope) -> Any? {
        guard let data = try? JSONEncoder().encode(scope) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    /// The answer, as the box gives it once its step is done (`done`: what it did), or failed
    /// (`failure`: why, and whether its agents bridge wasn't there to do it).
    public static func answer(_ decision: Decision, written: String, done: [String: Any] = [:], failure: (message: String, unavailable: Bool)? = nil) -> [String: Any] {
        if let failure {
            var answer: [String: Any] = failure.unavailable ? ["restore": writtenBack(written), "error": keywordUnavailable]
                : ["restore": decision["failed"] ?? ["text": written], "error": failure.message]
            if let keyword = decision["keyword"] { answer["keyword"] = keyword }
            return answer
        }
        var answer = decision
        answer["box"] = nil
        answer["failed"] = nil
        return answer.merging(done) { _, did in did }
    }
}
