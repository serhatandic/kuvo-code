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

/// The agent's steps between two of its replies, in a line ("Thought for 40s, ran 6 commands,
/// read 3 files"), opening to each. While it works, the step under way shows under the line.
struct StepsRow: View {
    let blocks: [Message.Content]
    let isLive: Bool
    let directory: String
    @AppStorage(StepsDetail.key) private var detail = StepsDetail.summary
    @State private var isExpanded = false

    var body: some View {
        // The one under way, as it is; those before it in the line.
        let current = isLive ? blocks.last : nil
        let done = isLive ? Array(blocks.dropLast()) : blocks
        VStack(alignment: .leading, spacing: 10) {
            if !done.isEmpty {
                // The line and what it opens to, with no space between them but the fold's own.
                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        withAnimation(.ui) { isExpanded.toggle() }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "list.bullet")
                                .frame(width: 16)
                            Text(detail == .minimal ? Self.count(done) : Self.summary(of: done))
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
                    if isExpanded {
                        // Together, so they fold as one, the space above them too.
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(Array(done.enumerated()), id: \.offset) { _, block in step(block) }
                        }
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

    @ViewBuilder private func step(_ block: Message.Content) -> some View {
        switch block {
        case .reasoning(let reasoning): ReasoningView(block: reasoning)
        case .tool(let call): ToolCallView(call: call, directory: directory)
        default: EmptyView()
        }
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
    static func summary(of blocks: [Message.Content]) -> String {
        let calls = blocks.compactMap { if case .tool(let call) = $0 { call } else { nil } }
        let thought = blocks.reduce(0.0) { total, block in
            guard case .reasoning(let text) = block, let start = text.time?.created, let end = text.time?.completed else { return total }
            return total + (end - start) / 1000
        }
        var parts: [String] = []
        if blocks.contains(where: { if case .reasoning = $0 { true } else { false } }) {
            parts.append("thought for " + MessageTime.duration(max(1, Int(thought))))
        }
        if !calls.isEmpty { parts.append(StepsSummary.summary(of: calls, capitalized: false)) }
        // One you stopped (or that quitting cut off) says so, as its own row does.
        let ended = calls.compactMap { if case .failed(_, let error, _, _) = $0.state { error } else { nil } }
        let stopped = ended.count(where: \.isInterruption)
        let outcomes = [(ended.count - stopped, "failed"), (stopped, "stopped")].filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
        let text = parts.joined(separator: ", ") + (outcomes.isEmpty ? "" : " (" + outcomes.joined(separator: ", ") + ")")
        return text.prefix(1).uppercased() + text.dropFirst()
    }
}

/// Tool calls in words, each kind once, in the order first done: "Searched the web 4 times,
/// fetched a page".
enum StepsSummary {
    static func summary(of steps: [Message.ToolCall], capitalized: Bool = true) -> String {
        var order: [String] = []
        var counts: [String: Int] = [:]
        for step in steps {
            let kind = kind(of: step.name)
            if counts[kind] == nil { order.append(kind) }
            counts[kind, default: 0] += 1
        }
        let text = order.map { phrase(kind: $0, count: counts[$0] ?? 1) }.joined(separator: ", ")
        return capitalized ? text.prefix(1).uppercased() + text.dropFirst() : text
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
        case let kind where kind.hasPrefix("mcp:"):
            let server = String(kind.dropFirst(4))
            let name = Integrations.service(server)?.title ?? server
            return many ? "used \(name) \(count) times" : "used \(name)"
        default: return many ? "used \(kind) \(count) times" : "used \(kind)"
        }
    }
}
