import Foundation
import OpenCodeKit

/// What changed in a conversation since the reply before, as both apps say it: no pill in the
/// conversation, but a word or two in the next reply's footer, beside its time and tokens
/// ("18:52 · Claude Sonnet 5.5 · 999 tokens"), only when it changed since that reply. The model or
/// its effort (the new one), the mode, the conversation summarized, the project's folders, a goal
/// started. Nothing else a note says shows: the engine's, the box's and the bridge's notes are words
/// for the model (a background command ending, work moved to the background, a reply carried on),
/// which the steps already show; and someone telling the agent something is a message from them
/// (`BoxNote.news`). Fed the conversation's messages in order, as its rows are made.
public struct ReplyChanges: Hashable, Sendable {
    /// The model the conversation was on as of the last reply, and one switched to since, with
    /// how it's said.
    private var model: ModelRef?
    private var switchedModel: ModelRef?
    private var modelWords: String?
    /// The same for the mode ("build", "plan").
    private var mode: String?
    private var switchedMode: String?
    /// The rest, in the order they happened, each once.
    private var others: [String] = []

    public init() {}

    /// The model switched to `model` (from `previous`, the first time), said as `words`: its name
    /// as the model menu has it, and its effort ("Claude Sonnet 5.5 High").
    public mutating func switched(to model: ModelRef, from previous: ModelRef?, words: String) {
        if self.model == nil { self.model = previous }
        switchedModel = model
        modelWords = words
    }

    /// The mode switched to `agent` ("plan", "build").
    public mutating func switched(toMode agent: String, from previous: String?) {
        if mode == nil { mode = previous }
        switchedMode = agent
    }

    /// The conversation summarized, as its compaction's `status` says ("running" is under way:
    /// nothing yet).
    public mutating func summarized(_ status: String) {
        switch status {
        case "running": break
        case "failed": add("couldn’t summarize")
        default: add("summarized")
        }
    }

    /// A note from the engine, the box or the bridge: a change it tells of, if any. It shows
    /// nothing in the conversation either way.
    public mutating func note(_ notice: Message.Notice) {
        let sources = notice.instructionSources
        if !sources.isEmpty {
            if sources.allSatisfy({ $0.contains("kuvo.project-folders") }) { add("folders updated") }
            return
        }
        // Plan mode's rules, for a session that starts in it (a switch says so itself).
        if notice.text.hasPrefix("<system-reminder>"), notice.text.contains("Plan mode"),
           notice.text.range(of: "no longer in Plan mode", options: .caseInsensitive) == nil, switchedMode == nil, mode != "plan" {
            switchedMode = "plan"
        }
    }

    /// A word of the box's to the agent other than its sessions' news: a goal started or taken up
    /// again is a change; the rest (your answer told late, a reminder) is for the agent.
    public mutating func note(_ box: BoxNote) {
        guard box.from == "Goal" else { return }
        switch box.line {
        case "Goal started": add("goal started")
        case "Goal resumed": add("goal resumed")
        default: break
        }
    }

    /// The words for a reply that just ended: what changed since the one before. From then on,
    /// nothing has.
    public mutating func replied() -> [String] {
        var words: [String] = []
        if let switchedMode, switchedMode != mode { words.append(switchedMode.prefix(1).uppercased() + switchedMode.dropFirst() + " mode") }
        if let switchedModel, switchedModel != model, let modelWords { words.append(modelWords) }
        words += others
        if let switchedModel { model = switchedModel }
        if let switchedMode { mode = switchedMode }
        switchedModel = nil
        switchedMode = nil
        modelWords = nil
        others = []
        return words
    }

    private mutating func add(_ word: String) {
        if !others.contains(word) { others.append(word) }
    }
}
