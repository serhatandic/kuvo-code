import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// How much of the agent's work shows between its replies: each step, the steps summed up in a
/// line (opening to each), or barely more than how many there were.
enum StepsDetail: String, CaseIterable, Identifiable {
    case each, summary, minimal

    static let key = "transcript.steps"
    var id: String { rawValue }

    var title: String {
        switch self {
        case .each: "Each Step"
        case .summary: "Summarized"
        case .minimal: "Minimal"
        }
    }
}

/// The agent's steps between two of its replies, in a line ("Worked for 40s", or how many while it
/// works), opening to what they were ("Thought for 40s, ran 6 commands, read 3 files") and each.
/// While it works, the step under way shows under the line.
struct StepsRow: View {
    let blocks: [Message.Content]
    let isLive: Bool
    let directory: String
    @AppStorage(StepsDetail.key) private var detail = StepsDetail.summary
    @State private var isExpanded = false
    @Environment(\.autopilotCalls) private var autopilotCalls

    /// The calls Autopilot made where these steps asked: shown under their line, folded or not.
    private func decided(_ done: [Message.Content]) -> [AutopilotShown.Call] {
        guard !autopilotCalls.isEmpty else { return [] }
        return done.flatMap { block -> [AutopilotShown.Call] in
            guard case .tool(let call) = block else { return [] }
            return autopilotCalls[call.id] ?? []
        }
    }

    var body: some View {
        // The one under way, as it is; those before it in the line.
        let (done, current) = Self.split(blocks, isLive: isLive)
        VStack(alignment: .leading, spacing: 10) {
            if !done.isEmpty {
                // The line and what it opens to, with no space between them but the fold's own.
                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        withAnimation(.ui) { isExpanded.toggle() }
                    } label: {
                        HStack(spacing: 8) {
                            Text(line(done))
                                .lineLimit(1)
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.semibold))
                                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        }
                        .font(.callout)
                        .foregroundStyle(detail == .minimal ? .tertiary : .secondary)
                    }
                    .buttonStyle(TextButtonStyle(outset: true))
                    .help(isExpanded ? "Hide the steps" : "Show each step")
                    // What they were, read with how long they took.
                    .accessibilityLabel(timed(done) ? line(done) + ": " + Self.summary(of: done, decided: Set(autopilotCalls.keys)) : line(done))
                    // What it decided on Autopilot meanwhile: not folded away with the rest.
                    let decided = decided(done)
                    if !decided.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            // (Several of a list of questions say which is which.)
                            ForEach(decided) { call in DecidedLine(call: call, saysQuestion: decided.count > 1) }
                        }
                        .padding(.top, 8)
                    }
                    if isExpanded {
                        // Together, so they fold as one, the space above them too.
                        VStack(alignment: .leading, spacing: 10) {
                            // What they were, when the line says only how long they took.
                            if timed(done) {
                                Text(Self.summary(of: done, decided: Set(autopilotCalls.keys)))
                                    .font(.callout)
                                    .foregroundStyle(.tertiary)
                            }
                            ForEach(Array(done.enumerated()), id: \.offset) { _, block in step(block) }
                        }
                        .environment(\.autopilotCallsShownAbove, !decided.isEmpty)
                        .padding(.top, 10)
                        .transition(.fold)
                    }
                }
            }
            if let current { step(current) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        #if DEBUG
        // KUVO_DEMO_OPEN_STEPS: each step shows, opened.
        .onAppear { if ProcessInfo.processInfo.environment["KUVO_DEMO_OPEN_STEPS"] != nil { isExpanded = true } }
        // KUVO_DEMO_FOLDS=<seconds>: the steps open and fold a few times, that far apart.
        .task {
            guard let wait = ProcessInfo.processInfo.environment["KUVO_DEMO_FOLDS"].flatMap(Double.init) else { return }
            for _ in 0..<8 {
                // Not stopped when the task is: the conversation's rows make their views anew as
                // they're laid out, which cancels it each time (eight toggles end where they began).
                await DemoWait.pause(.asked(wait))
                withAnimation(.ui) { isExpanded.toggle() }
            }
        }
        #endif
    }

    /// "Worked for 40s" once they're done (what they were, if they don't say when they ran), how
    /// many while it works, and only how many in Minimal.
    private func line(_ done: [Message.Content]) -> String {
        if detail == .minimal || isLive { return Self.count(done) }
        return StepTime.seconds(of: done).map { "Worked for " + MessageTime.duration($0) + Self.outcomes(of: done) } ?? Self.summary(of: done, decided: Set(autopilotCalls.keys))
    }

    private func timed(_ done: [Message.Content]) -> Bool {
        !isLive && Self.saysTime(done, detail: detail)
    }

    /// The line says how long these took: the turn's end then doesn't say it again.
    static func saysTime(_ blocks: [Message.Content], detail: StepsDetail) -> Bool {
        detail == .summary && StepTime.seconds(of: blocks) != nil
    }

    @ViewBuilder private func step(_ block: Message.Content) -> some View {
        switch block {
        case .reasoning(let reasoning): ReasoningView(block: reasoning)
        case .tool(let call): ToolCallView(call: call, directory: directory)
        default: EmptyView()
        }
    }

    /// The step under way, shown by itself under the line, and those before it, which the line
    /// counts and opens to. A last step that has ended isn't under way (it's waiting for the model
    /// to go on): it counts with the rest, so the line's number is the rows it opens to.
    static func split(_ blocks: [Message.Content], isLive: Bool) -> (done: [Message.Content], current: Message.Content?) {
        guard isLive, let last = blocks.last, isUnfinished(last) else { return (blocks, nil) }
        return (Array(blocks.dropLast()), last)
    }

    /// A step still going: thinking that hasn't ended, a tool still being written or run.
    static func isUnfinished(_ block: Message.Content?) -> Bool {
        switch block {
        case .reasoning(let reasoning): reasoning.time?.completed == nil
        case .tool(let call):
            switch call.state {
            case .streaming, .running: true
            case .completed, .failed: false
            }
        default: false
        }
    }

    /// "12 steps".
    static func count(_ blocks: [Message.Content]) -> String {
        blocks.count.counting("step")
    }

    /// "Thought for 40s, ran 6 commands, read 3 files (1 failed)", or "(1 stopped)".
    static func summary(of blocks: [Message.Content], decided: Set<String> = []) -> String {
        let calls = blocks.compactMap { if case .tool(let call) = $0 { call } else { nil } }
        let thought = blocks.reduce(0.0) { total, block in
            guard case .reasoning(let text) = block, let start = text.time?.created, let end = text.time?.completed else { return total }
            return total + (end - start) / 1000
        }
        var parts: [String] = []
        if blocks.contains(where: { if case .reasoning = $0 { true } else { false } }) {
            parts.append("thought for " + MessageTime.duration(max(1, Int(thought))))
        }
        if !calls.isEmpty { parts.append(StepsSummary.summary(of: calls, capitalized: false, decided: decided)) }
        let text = parts.joined(separator: ", ") + outcomes(of: blocks)
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    /// " (1 failed)", or "(1 stopped)" for one you stopped (or that quitting cut off), as its own
    /// row says; nothing when they all went through.
    static func outcomes(of blocks: [Message.Content]) -> String {
        let ended = blocks.compactMap { if case .tool(let call) = $0, !call.isSetAsideOnAutopilot, case .failed(_, let error, _, _) = call.state { error } else { nil } }
        let stopped = ended.count(where: \.isInterruption)
        let outcomes = [(ended.count - stopped, "failed"), (stopped, "stopped")].filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
        return outcomes.isEmpty ? "" : " (" + outcomes.joined(separator: ", ") + ")"
    }
}

/// Tool calls in words, each kind once, in the order first done: "Searched the web 4 times,
/// fetched a page".
enum StepsSummary {
    /// `decided`: the calls Autopilot decided, which asked nobody.
    static func summary(of steps: [Message.ToolCall], capitalized: Bool = true, decided: Set<String> = []) -> String {
        var order: [String] = []
        var counts: [String: Int] = [:]
        for step in steps {
            let kind = step.isSetAsideOnAutopilot ? "setAside" : decided.contains(step.id) ? "decided" : kind(of: step.name)
            if counts[kind] == nil { order.append(kind) }
            counts[kind, default: 0] += 1
        }
        let text = order.map { phrase(kind: $0, count: counts[$0] ?? 1) }.joined(separator: ", ")
        return capitalized ? text.prefix(1).uppercased() + text.dropFirst() : text
    }

    /// A step still under way, in a few words, as it happens: "Running a command", "Sleeping".
    static func doing(_ step: Message.ToolCall) -> String {
        let kind = kind(of: step.name)
        switch kind {
        case "websearch": return "Searching the web"
        case "webfetch": return "Fetching a page"
        case "read": return "Reading a file"
        case "search": return "Searching the files"
        case "shell": return "Running a command"
        case "edit": return "Editing a file"
        case "browser": return "Using the browser"
        case "subagent": return "Handing off a task"
        case "question": return "Asking you a question"
        case "show": return "Showing you something"
        case "message": return "Writing to another agent"
        case "agents": return "Looking up the other agents"
        case "conversation": return "Reading another conversation"
        case "wake": return "Scheduling a wake-up"
        case "watch": return "Starting a watch"
        case "wakes": return "Checking its wake-ups"
        case "unwake": return "Canceling a wake-up"
        case "todowrite", "todoread": return "Keeping its to-do list"
        case "skill": return "Using a skill"
        case "start_session": return "Starting a session"
        case "mark_final": return "Marking a file final"
        case "list_sessions": return "Checking its sessions"
        case "stop_session": return "Stopping a session"
        case "answer_ask": return "Answering a session"
        case "list_models": return "Looking up the models"
        case "list_projects": return "Looking up the projects"
        case "make_project": return "Making a project"
        case "set_job": return "Setting its job"
        case "propose_goal": return "Proposing a goal"
        case "goal_progress": return "Updating its goal’s progress"
        case "may_spend": return "Checking a purchase against its budget"
        case "finish_goal": return "Finishing its goal"
        case "vault_items": return "Looking up its vault items"
        case "vault_ask": return "Asking you for something from the vault"
        case "vault_run": return "Running a command with the vault’s values"
        case "sleep": return "Sleeping"
        case let kind where kind.hasPrefix("mcp:"):
            let server = String(kind.dropFirst(4))
            return "Using \(Integrations.service(server)?.title ?? server)"
        default: return "Using \(kind)"
        }
    }

    private static func kind(of name: String) -> String {
        // The browser's tools, as the engine names them ("kuvo-browser_browser_click").
        if name.hasPrefix("kuvo-browser_browser_") || name.hasPrefix("browser_") { return "browser" }
        switch name {
        case "grep", "glob", "list": return "search"
        case "bash", "shell": return "shell"
        case "edit", "write", "patch": return "edit"
        case "kuvo-browser_show_in_panel": return "show"
        case "kuvo-browser_send_message": return "message"
        case "kuvo-browser_list_agents": return "agents"
        case "kuvo-browser_read_conversation": return "conversation"
        case "kuvo-browser_schedule_wake_up": return "wake"
        case "kuvo-browser_watch_for_change": return "watch"
        case "kuvo-browser_list_wake_ups": return "wakes"
        case "kuvo-browser_cancel_wake_up": return "unwake"
        default:
            // Kuvo Code's own other tools, by their names ("start_session").
            if name.hasPrefix("kuvo-browser_") { return String(name.dropFirst("kuvo-browser_".count)) }
            // An MCP server's tool, as the engine names it ("github_create_issue"): by its server.
            if let underscore = name.firstIndex(of: "_") { return "mcp:" + name[..<underscore] }
            return name
        }
    }

    private static func phrase(kind: String, count: Int) -> String {
        let many = count > 1
        switch kind {
        case "websearch": return many ? "searched the web \(count) times" : "searched the web"
        case "webfetch": return many ? "fetched \(count) pages" : "fetched a page"
        case "read": return many ? "read \(count) files" : "read a file"
        case "search": return many ? "searched the files \(count) times" : "searched the files"
        case "shell": return many ? "ran \(count) commands" : "ran a command"
        case "edit": return many ? "edited files \(count) times" : "edited a file"
        case "browser": return many ? "used the browser (\(count) steps)" : "used the browser"
        case "subagent": return many ? "handed off \(count) tasks" : "handed off a task"
        case "question": return many ? "asked you \(count) questions" : "asked you a question"
        case "setAside": return many ? "set \(count) questions aside" : "set a question aside"
        case "decided": return many ? "decided \(count) questions" : "decided a question"
        case "show": return many ? "showed you \(count) things" : "showed you something"
        case "message": return many ? "wrote to other agents \(count) times" : "wrote to another agent"
        case "agents": return "looked up the other agents"
        case "conversation": return many ? "read \(count) other conversations" : "read another conversation"
        case "wake": return many ? "scheduled \(count) wake-ups" : "scheduled a wake-up"
        case "watch": return many ? "started \(count) watches" : "started a watch"
        case "wakes": return "checked its wake-ups"
        case "unwake": return many ? "canceled \(count) wake-ups" : "canceled a wake-up"
        case "todowrite", "todoread": return "kept its to-do list"
        case "skill": return many ? "used \(count) skills" : "used a skill"
        case "start_session": return many ? "started \(count) sessions" : "started a session"
        case "mark_final": return many ? "marked \(count) files final" : "marked a file final"
        case "list_sessions": return "checked its sessions"
        case "stop_session": return many ? "stopped \(count) sessions" : "stopped a session"
        case "answer_ask": return many ? "answered \(count) sessions" : "answered a session"
        case "list_models": return "looked up the models"
        case "list_projects": return "looked up the projects"
        case "make_project": return many ? "made \(count) projects" : "made a project"
        case "set_job": return "set its job"
        case "propose_goal": return "proposed a goal"
        case "goal_progress": return "updated its goal’s progress"
        case "may_spend": return many ? "checked \(count) purchases against its budget" : "checked a purchase against its budget"
        case "finish_goal": return "finished its goal"
        case "vault_items": return "looked up its vault items"
        case "vault_ask": return many ? "asked you for \(count) things from the vault" : "asked you for something from the vault"
        case "vault_run": return many ? "ran \(count) commands with the vault’s values" : "ran a command with the vault’s values"
        case "sleep": return many ? "slept \(count) times" : "slept"
        case let kind where kind.hasPrefix("mcp:"):
            let server = String(kind.dropFirst(4))
            let name = Integrations.service(server)?.title ?? server
            return many ? "used \(name) \(count) times" : "used \(name)"
        default: return many ? "used \(kind) \(count) times" : "used \(kind)"
        }
    }
}
