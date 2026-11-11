import AppKit
import ClientDesign
import ClientSandbox
import ClientSessions
import ClientText
import OpenCodeKit
import SwiftUI

/// One tool call: a single line saying what the agent did, which opens to show
/// the details (a diff for edits, output for commands) inline under it, joined to its icon
/// by a thin line, like a tree.
struct ToolCallView: View {
    let call: Message.ToolCall
    let directory: String
    /// What your opening it is kept by, as its view may not last (see `CardFolds`).
    var foldKey: String? = nil
    @Environment(AppModel.self) private var app
    /// Open by itself rather than by you: a subagent at work.
    @State private var opened = false
    @Environment(\.scrollAnchor) private var scrollAnchor

    private var key: String { foldKey ?? call.id }
    private var isExpanded: Bool { CardFolds.shared.isOpen(key, otherwise: opened) }

    /// The icon's column, and the gap after it: the details line up with the title.
    private static let iconWidth: CGFloat = 16
    private static let iconGap: CGFloat = 8

    /// The file a read, write or edit was about, where it is on disk.
    private var file: URL? {
        guard ["read", "write", "edit"].contains(call.name), let path = string("path") else { return nil }
        return RemoteFolder.fileURL(path, in: directory)
    }

    var body: some View {
        // Something the agent made: drawn, not described. A widget that failed is a step (the
        // card shows one so, through this view).
        if let decided = autopilotCalls[call.id], !autopilotCallsShownAbove {
            // A question Autopilot went ahead on: the call it made, where it was asked.
            VStack(alignment: .leading, spacing: 6) {
                ForEach(decided) { each in DecidedLine(call: each, saysQuestion: decided.count > 1) }
            }
        } else if WidgetCard.isWidget(call), !call.state.isFailure {
            WidgetCard(call: call, send: answerAgent)
        } else if MadePictureRow.isMade(call) {
            MadePictureRow(call: call, directory: directory)
        } else {
            step
        }
    }

    @Environment(\.answerAgent) private var answerAgent
    @Environment(\.workAnswers) private var workAnswers
    @Environment(\.autopilotCalls) private var autopilotCalls
    @Environment(\.autopilotCallsShownAbove) private var autopilotCallsShownAbove
    @Environment(\.sandboxStopped) private var heardStopped
    /// What its box asks, where it's given rather than heard (a summary outside the transcript).
    private(set) var givenStopped: Set<String>?
    private var sandboxStopped: Set<String>? { givenStopped ?? heardStopped }
    @Environment(\.askReviews) private var askReviews
    @Environment(\.sandboxReleased) private var heardReleased
    private(set) var givenReleased: Set<String>?
    private var sandboxReleased: Set<String> { givenReleased ?? heardReleased }

    @ViewBuilder private var step: some View {
        VStack(alignment: .leading, spacing: 0) {
            // A step with details opens like a button, and lights up like one; the rest are lines.
            Group {
                if hasDetails {
                    Button {
                        // Under way, it's kept in view as it grows.
                        CardFolds.shared.toggle(key, open: !isExpanded, in: scrollAnchor, holds: call.state.isFinished)
                    } label: {
                        header
                    }
                    .buttonStyle(TextButtonStyle(outset: true))
                } else if let shown = shownInPanel {
                    // What the agent showed you in the panel: a click shows it again.
                    Button {
                        app.utilities.show(shown.url, isFolder: shown.isFolder)
                    } label: {
                        header
                    }
                    .buttonStyle(TextButtonStyle(outset: true))
                    .help("Show it in the panel")
                } else if let started = startedSession {
                    // A session the agent started: a click opens it.
                    Button {
                        app.tabs.open(.session(started))
                    } label: {
                        header
                    }
                    .buttonStyle(TextButtonStyle(outset: true))
                    .help("Open this session")
                } else {
                    header.foregroundStyle(.secondary)
                }
            }
            .contextMenu {
                if let file, !file.isFileURL {
                    Button("Open in Panel") { app.utilities.show(file) }
                } else if let file, FileManager.default.fileExists(atPath: file.path) {
                    Button("Open in Panel") { app.utilities.show(file) }
                    Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([file]) }
                }
                if let file {
                    Button("Copy Path") { Clipboard.copy(file.path) }
                }
            }

            // Asked, and answered by the bot that runs this session: who, and why.
            if let answer = workAnswers[call.id] {
                WorkAnswerLine(answer: answer)
                    .padding(.leading, Self.iconWidth + Self.iconGap)
                    .padding(.top, 3)
            }

            if isExpanded, hasDetails {
                details
                    .padding(.leading, Self.iconWidth + Self.iconGap)
                    .padding(.top, 8)
                    .overlay(alignment: .topLeading) {
                        // The line down from the icon, beside what it opened.
                        Capsule()
                            .fill(.separator)
                            .frame(width: 1)
                            .padding(.top, 3)
                            .padding(.leading, (Self.iconWidth - 1) / 2)
                    }
                    .transition(.fold)
            }
        }
        .foldOpen(isExpanded)
        // Opened under way and kept in view as it grew, it stays where it is from when it ends.
        .onChange(of: call.state.isFinished) { _, finished in
            if finished, CardFolds.shared.isOpen(key, otherwise: false) { scrollAnchor?.reading?(key, true) }
        }
        // A subagent at work shows what it's doing; opened later, its steps stay folded.
        .onAppear {
            if call.name == "subagent", !call.state.isFinished { opened = true }
            #if DEBUG
            // KUVO_DEMO_OPEN_STEPS: every step shows its details, for screenshots.
            if ProcessInfo.processInfo.environment["KUVO_DEMO_OPEN_STEPS"] != nil { opened = true }
            #endif
        }
    }

    private var header: some View {
        HStack(spacing: Self.iconGap) {
            icon
                .frame(width: Self.iconWidth)
            Text(InlineCode.attributed(summary, size: NSFont.preferredFont(forTextStyle: .callout).pointSize))
                .lineLimit(1)
                .truncationMode(.middle)
            if let since = call.time?.created?.date {
                // Counting while it runs; once done, how long it took.
                StepActivity.Elapsed(since: since, running: isWorking, until: call.time?.completed?.date)
            }
            if let stat = diffStat {
                DiffStat(additions: stat.additions, deletions: stat.deletions)
            }
            if let mark = sandboxMark {
                mark
            }
            if let mark = reviewMark {
                mark
            }
            // A command run outside the sandbox: its mark says how, and only that it failed, here.
            if ranOutsideAndFailed {
                Text("Failed").foregroundStyle(.red)
            } else if case .failed(_, let error, _, _) = call.state, !(isSandboxAsk && Self.sandboxOutcome(outputText) != nil) {
                if error.isInterruption {
                    Text("Stopped")
                } else if !call.isSetAsideOnAutopilot {
                    Text(error.message)
                        .lineLimit(1)
                        .foregroundStyle(.red)
                        // The step's words first; the error, in full, when it opens.
                        .layoutPriority(-1)
                }
            }
            if hasDetails {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            Spacer(minLength: 0)
        }
        .font(.callout)
        .contentShape(.rect)
    }

    @ViewBuilder private var icon: some View {
        switch call.state {
        case .failed(_, let error, _, _) where error.isInterruption:
            Image(systemName: "stop.circle")
        case .failed where call.isSetAsideOnAutopilot:
            Image(systemName: AutopilotShown.symbol)
        case .failed:
            Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        default:
            // One view running and done, so its ring closes as the step ends. Only a subagent's
            // step can be at work in the background, and only it says so.
            if call.name == "subagent" {
                // Open, its own steps show the work: its arc holds still.
                StepActivity(symbol: symbol, running: isWorking, size: Self.iconWidth, holds: isExpanded)
                    .help(isAtWork ? "Working in the background" : "")
            } else {
                StepActivity(symbol: symbol, running: isWorking, size: Self.iconWidth)
            }
        }
    }

    /// At work: running, or a subagent it sent off still at it.
    private var isWorking: Bool { isActive || isAtWork }

    // MARK: Describing the call

    private var input: JSONValue? { call.state.input }

    private func string(_ key: String) -> String? { input?[key]?.string }

    /// A Work Queue tool's call, in words (`WorkQueueWords`): a hand-off names the session by its
    /// title where this Mac knows it.
    private func queueSummary(_ name: String) -> String {
        let item = input?["item"]?.number.flatMap { Int(exactly: $0.rounded()) }.map { "#\($0)" } ?? string("item")
        let to = string("to").map { AgentMail.shared.name(of: $0) }
        return WorkQueueWords.summary(name, item: item, title: string("title"), to: to, category: string("category"), undo: input?["undo"]?.bool == true, add: string("add"), isActive: isActive, issue: string("issue"))
    }
    private func relative(_ path: String?) -> String? {
        guard let path else { return nil }
        // A machine's engine names files as they are there, without the ssh:// prefix.
        let directory = RemoteFolder.parse(directory)?.path ?? directory
        let base = directory.hasSuffix("/") ? directory : directory + "/"
        // The project folder itself goes by its name.
        if path == directory || path == base { return (directory as NSString).lastPathComponent }
        return path.hasPrefix(base) ? String(path.dropFirst(base.count)) : (path as NSString).abbreviatingWithTildeInPath
    }

    private var isActive: Bool { !call.state.isFinished }

    /// What the call did, in words: its line in the transcript.
    static func summary(of call: Message.ToolCall, in directory: String, stopped: Set<String>? = nil, released: Set<String>? = nil) -> String {
        var view = ToolCallView(call: call, directory: directory)
        view.givenStopped = stopped
        view.givenReleased = released
        return view.summary
    }

    private var summary: String {
        let path = relative(string("path"))
        // A bot's memory file goes by what it is.
        if let raw = string("path"), Bots.isMemory(raw), ["read", "write", "edit"].contains(call.name) {
            return call.name == "read" ? (isActive ? "Reading its memory" : "Read its memory") : (isActive ? "Updating its memory" : "Updated its memory")
        }
        switch call.name {
        case "read": return (isActive ? "Reading " : "Read ") + (path ?? "a file")
        case "write": return (isActive ? "Writing " : "Wrote ") + (path ?? "a file")
        case "edit": return (isActive ? "Editing " : "Edited ") + (path ?? "a file")
        case "patch":
            let files = diffs.map { relative($0.file) ?? $0.file }
            return (isActive ? "Editing " : "Edited ") + (files.count == 1 ? files[0] : files.isEmpty ? "files" : "\(files.count) files")
        case "shell":
            if let wake = wake { return Self.summary(of: wake, isActive: isActive, failed: !exitSuffix.isEmpty) + exitSuffix }
            return (isActive ? "Running " : "Ran ") + (string("command").flatMap(InlineCode.command) ?? "a command") + exitSuffix
        case "grep": return "Searched for “\(string("pattern") ?? "")”" + (path.map { " in \($0)" } ?? "")
        case "glob": return "Found files matching \(string("pattern") ?? "")"
        case "webfetch": return (isActive ? "Fetching " : "Fetched ") + (string("url") ?? "a page")
        case "websearch": return "Searched the web for “\(string("query") ?? "")”"
        case "question" where autopilotCalls[call.id] != nil: return "Decided a question on Autopilot"
        case "question" where call.isSetAsideOnAutopilot: return "Set a question aside on Autopilot"
        case "question": return isActive ? "Asking you a question" : "Asked you a question"
        case _ where isSandboxAsk:
            let command = string("command").flatMap(InlineCode.command) ?? "a command"
            // Asking until its ask was seen open and then answered; once allowed, the command runs
            // in the same call. (One not listed yet is still asking.)
            if isActive { return (isRunningOutside ? "Running " : "Asking to run ") + command + " outside the sandbox" }
            switch Self.sandboxOutcome(outputText) {
            case "You said no", "No answer": return "Didn’t run " + command
            case let outcome? where outcome.hasPrefix("Ran outside"): return "Ran " + command
            default: return "Asked to run \(command) outside the sandbox"
            }
        case "subagent": return (string("description") ?? (isActive ? "Starting a subagent…" : "A subagent's task")) + (string("agent").map { " · \($0)" } ?? "")
        case "skill": return "Used a skill"
        case "tool_search": return (isActive ? "Looking for a tool" : "Looked for a tool") + (string("query").map { ": “\($0)”" } ?? "")
        case "execute":
            // Code Mode: the agent wrote code that calls its tools.
            let calls = call.state.metadata?["toolCalls"]?.array?.count ?? 0
            let failed = call.state.metadata?["error"]?.bool == true
            return (isActive ? "Running code" : "Ran code") + (calls > 0 ? " using \(calls) tool\(calls == 1 ? "" : "s")" : "") + (failed && !isActive ? " (it failed)" : "")
        default:
            if let browsing = browserSummary { return browsing }
            return call.name.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// The panel browser's tools (served as "kuvo-browser_browser_…"), in words.
    private var browserSummary: String? {
        guard call.name.hasPrefix("kuvo-browser_") else { return nil }
        // (A model's numbers as written: one no element or tab could have reads as none given.)
        let whole = { (key: String) in input?[key]?.number.flatMap { Int(exactly: $0.rounded()) } }
        let index = whole("index").map { "[\($0)]" } ?? "an element"
        switch call.name.dropFirst("kuvo-browser_".count) {
        case "browser_navigate": return (isActive ? "Opening " : "Opened ") + (string("url") ?? "a page")
        case "browser_new_tab": return "Opened a new tab" + (string("url").map { " at \($0)" } ?? "")
        case "browser_snapshot": return isActive ? "Reading the page" : "Read the page"
        case "browser_text": return isActive ? "Reading the page's text" : "Read the page's text"
        case "browser_click": return (isActive ? "Clicking " : "Clicked ") + index
        case "browser_type": return (isActive ? "Typing into " : "Typed into ") + index + (string("text").map { ": “\($0)”" } ?? "")
        case "browser_select": return "Chose “\(string("option") ?? "")” in \(index)"
        case "browser_scroll": return "Scrolled " + (string("direction") ?? "down")
        case "browser_press": return "Pressed " + (string("key") ?? "a key")
        case "browser_back": return "Went back"
        case "browser_forward": return "Went forward"
        case "browser_screenshot": return isActive ? "Taking a screenshot" : "Took a screenshot"
        case "browser_wait": return string("text").map { (isActive ? "Waiting for “" : "Waited for “") + $0 + "”" } ?? "Waited for the page"
        case "browser_hover": return (isActive ? "Hovering over " : "Hovered over ") + index
        case "browser_tabs":
            let tab = whole("tab").map { " [\($0)]" } ?? ""
            switch string("action") {
            case "switch": return (isActive ? "Switching to tab" : "Switched to tab") + tab
            case "close": return (isActive ? "Closing tab" : "Closed tab") + tab
            default: return isActive ? "Looking at the tabs" : "Looked at the tabs"
            }
        case "browser_upload":
            let count = input?["files"]?.array?.count ?? 1
            return (isActive ? "Attaching " : "Attached ") + (count == 1 ? "a file" : "\(count) files") + " to \(index)"
        case "browser_sign_in": return isActive ? "Waiting for your sign-in" : "Asked you to sign in"
        case "browser_ask_code": return isActive ? "Waiting for your code" : "Asked you for a code"
        case "browser_ask_user": return isActive ? "Waiting for you on the page" : "Asked you to step in"
        case "list_agents": return isActive ? "Looking up the other agents" : "Looked up the other agents"
        case "send_message":
            let to = AgentMail.shared.name(of: string("to"))
            if input?["wait"]?.bool == true { return (isActive ? "Asking " : "Asked ") + to }
            return (isActive ? "Writing to " : "Wrote to ") + to
        case "read_conversation":
            let of = AgentMail.shared.name(of: string("of"))
            let about = string("query").map { " about “\($0)”" } ?? ""
            return (isActive ? "Reading " : "Read ") + of + "’s conversation" + about
        case "show_in_panel", "show_file": return (isActive ? "Showing " : "Showed ") + (relative(string("path")) ?? "a file")
        case "show_widget":
            let made = string("title").map { "“\($0)”" } ?? "a widget"
            guard case .failed(_, let error, _, _) = call.state else { return (isActive ? "Making " : "Made ") + made }
            // Stopped with the turn, it didn't fail: the row says "Stopped" beside it.
            return (error.isInterruption ? "Making " : "Couldn’t make ") + made
        case "mark_final": return (isActive ? "Marking " : "Marked ") + (string("path").map { ($0 as NSString).lastPathComponent } ?? "a file") + " final"
        case "start_session": return (isActive ? "Starting a session" : "Started a session") + (string("title").map { ": \($0)" } ?? "")
        // Kuvo Code's wake-up tools, worded as the kuvo-wake commands they run are.
        case "schedule_wake_up":
            let wake = Wakes.Command(verb: .add, when: string("when"), note: string("note"), every: string("every").flatMap(Wakes.Repeat.init))
            return Self.summary(of: wake, isActive: isActive, failed: call.state.isFailure)
        case "watch_for_change":
            return Self.summary(of: Wakes.Command(verb: .watch, when: string("every"), note: string("note")), isActive: isActive, failed: call.state.isFailure)
        case "list_wake_ups":
            return Self.summary(of: Wakes.Command(verb: .list, when: nil, note: nil), isActive: isActive, failed: call.state.isFailure)
        case "cancel_wake_up":
            return Self.summary(of: Wakes.Command(verb: .cancel, when: nil, note: nil), isActive: isActive, failed: call.state.isFailure)
        case "browser_fill": return (isActive ? "Filling " : "Filled ") + index + " from your vault"
        case "browser_save_pdf": return isActive ? "Saving the page as a PDF" : "Saved the page as a PDF"
        // Kuvo Code's other tools, which the same server serves: what they do, not where they're from.
        case "list_sessions": return isActive ? "Checking its sessions" : "Checked its sessions"
        case "stop_session": return isActive ? "Stopping a session" : "Stopped a session"
        case "compact_session": return isActive ? "Summarizing a session" : "Summarized a session"
        case "answer_ask": return isActive ? "Answering a session" : "Answered a session"
        case "list_models": return isActive ? "Looking up the models" : "Looked up the models"
        case "list_projects": return isActive ? "Looking up the projects" : "Looked up the projects"
        case "plan_limits": return isActive ? "Reading the plan limits" : "Read the plan limits"
        case "make_project": return (isActive ? "Making " : "Made ") + (string("name").map { "the project “\($0)”" } ?? "a project")
        case "set_job": return (isActive ? "Setting its job" : "Set its job") + (string("summary").map { ": \($0)" } ?? "")
        case "propose_goal": return (isActive ? "Proposing " : "Proposed ") + (string("title").map { "the goal “\($0)”" } ?? "a goal")
        case "goal_progress": return isActive ? "Updating its goal’s progress" : "Updated its goal’s progress"
        case "may_spend": return isActive ? "Checking a purchase against its budget" : "Checked a purchase against its budget"
        case "finish_goal": return isActive ? "Finishing its goal" : "Finished its goal"
        case "notify_user": return (isActive ? "Notifying you" : "Notified you") + (string("text").map { ": \($0)" } ?? "")
        case "vault_items": return isActive ? "Looking up its vault items" : "Looked up its vault items"
        case "vault_ask": return isActive ? "Asking you for something from the vault" : "Asked you for something from the vault"
        case "vault_run": return isActive ? "Running a command with the vault’s values" : "Ran a command with the vault’s values"
        case let name where name.hasPrefix("queue_"): return queueSummary(String(name))
        case let name where name.hasPrefix("browser_"): return "Used the browser"
        // One this list doesn't know yet: by its own name, never as the browser.
        case let name: return "Used " + name.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// A bot's own wake-up command, read back.
    private var wake: Wakes.Command? {
        call.name == "shell" ? string("command").flatMap(Wakes.command(in:)) : nil
    }

    /// "Scheduled a wake-up in 2 hr: check whether CI passed"; `failed`, what it couldn't do
    /// (the command exited with an error, as one a sandbox stopped from writing does).
    static func summary(of wake: Wakes.Command, isActive: Bool, failed: Bool = false) -> String {
        if failed {
            switch wake.verb {
            case .list: return "Couldn’t check its wake-ups"
            case .cancel: return "Couldn’t cancel a wake-up"
            case .watch: return "Couldn’t start a watch" + (wake.note.map { ": \($0)" } ?? "")
            case .add: return "Couldn’t schedule a wake-up" + (wake.note.map { ": \($0)" } ?? "")
            }
        }
        switch wake.verb {
        case .list: return isActive ? "Checking its wake-ups" : "Checked its wake-ups"
        case .cancel: return isActive ? "Canceling a wake-up" : "Canceled a wake-up"
        case .watch:
            let every = wake.when.flatMap(Wakes.Repeat.init).map { " \($0.words)" } ?? ""
            return (isActive ? "Starting a watch" : "Started a watch") + every + (wake.note.map { ": \($0)" } ?? "")
        case .add:
            let when = wake.when.map(Self.when) ?? ""
            let every = wake.every.map { ", \($0.words)" } ?? ""
            return (isActive ? "Scheduling a wake-up" : "Scheduled a wake-up") + (when.isEmpty ? "" : " " + when) + every + (wake.note.map { ": \($0)" } ?? "")
        }
    }

    /// +2h as "in 2 hr", a date and time as "for Fri 9:00 AM".
    private static func when(_ text: String) -> String {
        if text.hasPrefix("+"), let unit = text.last, let count = Int(text.dropFirst().dropLast()) {
            let duration: Duration = switch unit {
            case "m": .seconds(count * 60)
            case "h": .seconds(count * 3600)
            default: .seconds(count * 86_400)
            }
            return "in " + duration.formatted(.units(allowed: [.days, .hours, .minutes], width: .abbreviated, maximumUnitCount: 2))
        }
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        for format in ["yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm"] {
            parser.dateFormat = format
            if let date = parser.date(from: text) { return "for " + date.formatted(.dateTime.weekday(.abbreviated).hour().minute()) }
        }
        return "for \(text)"
    }

    private var exitSuffix: String {
        guard case .completed(_, _, let metadata) = call.state, let exit = metadata?["exit"]?.number, exit != 0 else { return "" }
        return " (exit \(Int(exit)))"
    }

    private var symbol: String {
        switch call.name {
        case "read": "doc.text"
        case "write": "doc.badge.plus"
        case "edit", "patch": "pencil"
        case "shell": wake == nil ? "terminal" : "alarm"
        case _ where isSandboxAsk: "terminal"
        case "grep", "glob": "magnifyingglass"
        case "webfetch", "websearch": "globe"
        case "question": "questionmark.bubble"
        case "subagent": "person.2"
        case "skill": "wand.and.stars"
        case "execute": "chevron.left.forwardslash.chevron.right"
        default: browserSymbol ?? "wrench.and.screwdriver"
        }
    }

    /// The browser's steps, each by what it does.
    private var browserSymbol: String? {
        guard call.name.hasPrefix("kuvo-browser_") else { return nil }
        return switch call.name.dropFirst("kuvo-browser_".count) {
        case "browser_click", "browser_hover": "cursorarrow.rays"
        case "browser_type", "browser_press": "keyboard"
        case "browser_select": "filemenu.and.selection"
        case "browser_scroll": "arrow.up.and.down"
        case "browser_back": "chevron.backward"
        case "browser_forward": "chevron.forward"
        case "browser_screenshot": "camera.viewfinder"
        case "browser_snapshot", "browser_text": "doc.text.magnifyingglass"
        case "browser_wait": "hourglass"
        case "browser_new_tab", "browser_tabs": "square.on.square"
        case "browser_upload": "paperclip"
        case "browser_sign_in": "key"
        case "browser_ask_code": "number"
        case "browser_ask_user": "hand.raised"
        case "list_agents": "person.2"
        case "send_message": "paperplane"
        case let name where name.hasPrefix("queue_"): WorkQueueWords.symbol
        case "read_conversation": "text.bubble"
        case "schedule_wake_up": "alarm"
        case "watch_for_change": "eye"
        case "list_wake_ups": "list.bullet"
        case "cancel_wake_up": "xmark.circle"
        case "show_in_panel": "sidebar.right"
        case "show_file": "doc.richtext"
        case "show_widget": "macwindow"
        case "browser_fill", "vault_items", "vault_ask", "vault_run": "lock.shield"
        case "browser_save_pdf": "arrow.down.doc"
        case "list_sessions": "rectangle.stack"
        case "stop_session": "stop.circle"
        case "compact_session": "rectangle.compress.vertical"
        case "answer_ask": "checkmark.bubble"
        case "list_models": "cpu"
        case "list_projects": "folder"
        case "plan_limits": "gauge.with.dots.needle.50percent"
        case "make_project": "folder.badge.plus"
        case "set_job": "person.text.rectangle"
        case "propose_goal", "goal_progress", "finish_goal": "scope"
        case "may_spend": "creditcard"
        case "notify_user": "bell"
        case let name where name.hasPrefix("browser_"): "safari"
        default: nil
        }
    }

    /// The agents' `sandbox_ask` (each kind of agent names Kuvo Code's tools its own way).
    private var isSandboxAsk: Bool { call.name.hasSuffix("sandbox_ask") }

    /// How a `sandbox_ask` was answered, from what it returned: the words its mark shows.
    static func sandboxOutcome(_ output: String) -> String? {
        if output.hasPrefix("Ran outside the sandbox · Always for this") { return "Ran outside the sandbox · Always for this" }
        if output.hasPrefix("Ran outside the sandbox · Allowed once") { return "Ran outside the sandbox · Allowed once" }
        if output.hasPrefix("The user said no") { return "You said no" }
        if output.hasPrefix("Nobody answered in time") { return "No answer" }
        return nil
    }

    /// A command's quiet mark beside its row: stopped by the sandbox while its ask waits for you;
    /// run outside it, once or always, or not, once you answered.
    private var sandboxMark: Text? {
        // One that failed: an earlier run of the same command that went fine isn't marked.
        if call.name == "shell", wake == nil, isStopped, let command = string("command"), sandboxStopped?.contains(command.trimmingCharacters(in: .whitespacesAndNewlines)) == true {
            return Text("Stopped by the sandbox").foregroundStyle(.orange)
        }
        guard isSandboxAsk else { return nil }
        if isActive { return isAskOpen == true ? Text("Waiting for you").foregroundStyle(.orange) : nil }
        guard let outcome = Self.sandboxOutcome(outputText) else { return nil }
        let symbol = outcome.hasPrefix("Ran outside") ? "\(Image(systemName: "lock.open")) " : ""
        return Text("\(symbol)\(outcome)").foregroundStyle(.secondary)
    }

    /// What Auto's reviewer did with what this step asked (working outside its folder): checking,
    /// allowed, held back for you, or refused.
    private var reviewMark: Text? {
        guard let review = askReviews[call.id], let words = review.mark else { return nil }
        return Text(words).foregroundStyle(review.state == .heldBack ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
    }

    /// A command that didn't go through: it exited with an error, or failed.
    private var isStopped: Bool {
        if case .failed = call.state { return true }
        return !exitSuffix.isEmpty
    }

    /// A `sandbox_ask` whose ask is still open on its box: waiting for your answer, not running;
    /// nil before its box's asks are heard, when it may be either.
    private var isAskOpen: Bool? {
        guard let sandboxStopped else { return nil }
        return string("command").map { sandboxStopped.contains($0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? false
    }

    /// A `sandbox_ask` whose ask was seen open and has closed: allowed, and its command running.
    private var isRunningOutside: Bool {
        guard isAskOpen == false, let command = string("command") else { return false }
        return sandboxReleased.contains(command.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// A command run outside the sandbox that failed (it ended with an error, or was stopped):
    /// "Failed" beside its mark, rather than the whole of what it printed in red.
    private var ranOutsideAndFailed: Bool {
        guard isSandboxAsk, case .failed = call.state else { return false }
        return Self.sandboxOutcome(outputText)?.hasPrefix("Ran outside") == true
    }

    private var diffs: [FileDiff] {
        (try? call.state.metadata?["files"]?.decode(as: [FileDiff].self)) ?? []
    }

    private var diffStat: (additions: Int, deletions: Int)? {
        let diffs = diffs
        guard !diffs.isEmpty else { return nil }
        return (diffs.reduce(0) { $0 + $1.additions }, diffs.reduce(0) { $0 + $1.deletions })
    }

    private var outputText: String {
        // (What a question set aside on Autopilot asked: its turning down is said by its title.)
        if call.isSetAsideOnAutopilot { return call.questionsAsked }
        return switch call.state {
        case .completed(_, let output, _): output.compactMap(\.text).joined(separator: "\n")
        case .failed(_, let error, let output, _): ([error.message] + (output ?? []).compactMap(\.text)).joined(separator: "\n")
        default: ""
        }
    }

    /// What a show_in_panel step showed, and whether it's a folder.
    private var shownInPanel: (url: URL, isFolder: Bool)? {
        guard call.name == "kuvo-browser_" + BrowserTools.showInPanel, case .completed = call.state, let path = string("path"),
              let isFolder = BrowserTools.shownFolder(in: outputText) else { return nil }
        return (RemoteFolder.fileURL(path, in: directory), isFolder)
    }

    /// The session a start_session step started, once it's listed here: by the address its result
    /// gives, or while it waits for the session's first answer, the one started since it began.
    private var startedSession: String? {
        guard call.name == "kuvo-browser_start_session" else { return nil }
        let id: String? = switch call.state {
        case .completed: Branches.started(byStep: outputText)
        case .running: Branches.started(byWaiting: call, among: app.workspace.sessions)
        case .streaming, .failed: nil
        }
        return id.flatMap { app.workspace.session($0) != nil ? $0 : nil }
    }

    /// The session a subagent works in, once it has started.
    private var subagentSession: String? {
        call.name == "subagent" ? call.state.metadata?["sessionID"]?.string : nil
    }

    /// A subagent sent off in the background, its step done at once, still at work.
    private var isAtWork: Bool {
        guard let subagentSession else { return false }
        return app.workspace.running.contains(subagentSession)
    }

    private var hasDetails: Bool {
        subagentSession != nil || !diffs.isEmpty || ((call.name == "shell" || isSandboxAsk) && !outputText.isEmpty) || code != nil || (call.isSetAsideOnAutopilot ? !outputText.isEmpty : call.state.isFailure) || !pictures.isEmpty
    }

    /// Pictures the step brought back, like a screenshot of the page.
    private var pictures: [AttachmentItem] {
        guard case .completed(_, let output, _) = call.state else { return [] }
        return StepPictures.items(in: output, step: call.id)
    }

    /// The code a Code Mode step ran.
    private var code: String? {
        call.name == "execute" ? string("code") : nil
    }

    @ViewBuilder private var details: some View {
        if !pictures.isEmpty {
            StepPictures(items: pictures)
        } else if let subagentSession {
            SubagentSteps(id: subagentSession, task: string("prompt"), directory: directory)
        } else if let code {
            VStack(alignment: .leading, spacing: 8) {
                OutputBlock(text: code)
                if !outputText.isEmpty { OutputBlock(text: outputText) }
            }
        } else if !diffs.isEmpty {
            // The step names a single file already; several get a title each, and so does one
            // the patch created or deleted, since only its title says so.
            let diffs = diffs
            VStack(alignment: .leading, spacing: 10) {
                ForEach(diffs) { diff in
                    let titled = diffs.count > 1 || (diff.status != nil && diff.status != .modified)
                    DiffView(diff: diff, title: titled ? (relative(diff.file) ?? diff.file) : nil, maxLines: 80)
                }
            }
        } else {
            OutputBlock(text: outputText, command: call.name == "shell" || isSandboxAsk ? string("command") ?? "" : nil)
        }
    }
}

/// A command's output or a step's code, in a recessed well that scrolls sideways for long lines.
struct OutputBlock: View {
    let text: String
    /// The command that printed it, to color it as a terminal would; nil for code and other text.
    var command: String?
    @Environment(\.findHighlight) private var highlight
    @Environment(\.colorScheme) private var scheme
    @Environment(\.messageFont) private var messageFont
    @State private var isCut = false
    /// Whether its lines are wider than the well (it scrolls sideways).
    @State private var isWide = false
    @State private var scrollers = OutputBlock.scrollerStyle()

    var body: some View {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let marked = FindText.marked(command.map { TerminalColors.colored(text, command: $0, dark: scheme == .dark) } ?? AttributedString(text), highlight)
        let font = NSFont.monospacedSystemFont(ofSize: messageFont.size - 1.5, weight: .regular)
        ScrollView(.horizontal) {
            // As many whole lines as the well holds, however tall a script's font makes them,
            // faded at the cut (its lines never wrap: they're as the tool wrote them).
            // AppKit's text: its I-beam shows only where nothing's drawn over it.
            SelectableText(text: MessageMentions.attributed(marked, font: font).text, maxHeight: Self.height - 24, cut: { isCut = $0 })
                .fixedSize(horizontal: true, vertical: false)
                // Masked from the start when it may well be cut, so the fade coming doesn't make
                // it a new view.
                .modifier(CutFade(isOn: isCut, isMasked: text.utf8.count { $0 == 10 } + 1 >= Self.lines(font) / 2))
                .padding(12)
                // A scroll bar that's always shown takes its height from the well: room for it
                // under the last line when the lines are wider than the well.
                .padding(.bottom, scrollers == .legacy && isWide ? NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy) : 0)
        }
        // Said only as it changes, not on every width a window's resize goes through.
        .onScrollGeometryChange(for: Bool.self) { $0.contentSize.width > $0.containerSize.width + 0.5 } action: { _, wide in isWide = wide }
        .onReceive(NotificationCenter.default.publisher(for: NSScroller.preferredScrollerStyleDidChangeNotification)) { _ in
            scrollers = Self.scrollerStyle()
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .recessedWell(RoundedRectangle(cornerRadius: 10))
    }

    private static let height: CGFloat = 260
    private static let lineHeights = NSLayoutManager()

    /// How many lines of `font` the well holds, at its plain line height.
    private static func lines(_ font: NSFont) -> Int {
        Int((height - 24) / lineHeights.defaultLineHeight(for: font))
    }

    /// The scroll bars' style: always shown, or over the content only while scrolling (System
    /// Settings, or a mouse plugged in).
    static var scrollerStyle: () -> NSScroller.Style = { NSScroller.preferredScrollerStyle }
}

/// What a subagent was asked, and the steps it took and what it said, as they happen, under
/// its step or its row (which draws the line beside them).
struct SubagentSteps: View {
    let id: String
    /// What the agent asked it to do (its session's own first message adds the engine's
    /// preamble).
    let task: String?
    let directory: String
    @Environment(Workspace.self) private var workspace
    @State private var model: SessionModel?

    /// A step of its own shows it at work (a tool running, its reply being written), so no
    /// "Working…" under it says so twice.
    static func showsWork(_ model: SessionModel) -> Bool {
        guard case .assistant(let step)? = model.transcript.messages.last(where: { if case .assistant = $0 { true } else { false } }),
              step.time.completed == nil, let block = step.content.last else { return false }
        switch block {
        case .text: return true
        case .tool: return StepsRow.isUnfinished(block)
        default: return false
        }
    }

    /// What it used, as a turn shows it: "4.2K tokens · $0.01".
    static func usage(_ model: SessionModel) -> String? {
        let steps = model.transcript.messages.compactMap { if case .assistant(let step) = $0 { step } else { nil } }
        let tokens = steps.reduce(0) { $0 + ($1.tokens?.output ?? 0) + ($1.tokens?.reasoning ?? 0) }
        guard tokens > 0 else { return nil }
        let cost = steps.reduce(0) { $0 + ($1.cost ?? 0) }
        return (["\(tokens.compactTokens) tokens"] + [cost.formattedCost].compactMap { $0 }).joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let task {
                SelectableText(text: NSAttributedString(string: task, attributes: [.font: NSFont.preferredFont(forTextStyle: .callout), .foregroundColor: NSColor.secondaryLabelColor]),
                               lineLimit: 4)
            }
            if let model {
                ForEach(model.transcript.messages) { message in
                    switch message {
                    case .assistant(let assistant):
                        ForEach(Array(assistant.content.enumerated()), id: \.offset) { index, block in
                            switch block {
                            case .text(let text):
                                // One view, written or done (see `WritingText`).
                                WritingText(row: assistant.id, part: index, text: text.text, folders: { [directory] },
                                            isWriting: assistant.time.completed == nil && index == assistant.content.count - 1)
                            case .tool(let call):
                                ToolCallView(call: call, directory: directory, foldKey: id + "#" + call.id)
                            default:
                                EmptyView()
                            }
                        }
                    default:
                        EmptyView()
                    }
                }
                // Its reply being written draws its words from it.
                .environment(model.writing)
                // Between its steps, or waiting on its model: nothing above says it's at work.
                if model.isRunning, !Self.showsWork(model) {
                    HStack(spacing: 8) {
                        StepActivity(symbol: nil, running: true)
                        Text("Working…")
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                } else if let usage = Self.usage(model) {
                    Text(usage)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            } else {
                Placeholder(.rows(count: 2), label: "Loading steps", fadesOut: false)
            }
        }
        .task(id: id) {
            let model = await workspace.subagentModel(for: id, in: directory)
            if let model, !model.isLoaded { await model.load() }
            self.model = model
        }
    }
}

extension Message.ToolState {
    var isFailure: Bool {
        if case .failed = self { true } else { false }
    }
}

extension EnvironmentValues {
    /// The commands its agents ask to run outside the sandbox now, which their rows mark stopped;
    /// nil while its box's asks aren't known yet.
    @Entry var sandboxStopped: Set<String>? = nil
    /// The commands whose asks were seen open and have closed since: only those may be running.
    @Entry var sandboxReleased: Set<String> = []
    /// What Auto's reviewer did with what each step asked, by its tool call.
    @Entry var askReviews: [String: AskReview] = [:]
    /// What a bot answered for the conversation's asks, by the tool call that asked (`kuvo.answers`).
    @Entry var workAnswers: [String: WorkAnswer] = [:]
}

/// Under a step that asked: answered by the bot that runs the session, not by you ("Allowed by
/// Pixel: the plan names the haptics package"), with its face.
struct WorkAnswerLine: View {
    let answer: WorkAnswer
    @Environment(Bots.self) private var bots

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Group {
                if let bot = bots.bot(answer.by.bot) {
                    BotAvatar(look: bot.look, size: 14, animates: false)
                } else {
                    Image(systemName: answer.decision == .deny ? "xmark.circle" : "checkmark.circle")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
            .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
            Text("\(Text(answer.verdict).fontWeight(.medium))\(Text(answer.reason.isEmpty ? "" : ": " + answer.reason).foregroundStyle(.secondary))")
                .font(.system(size: 12))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .help(answer.isYours ? "\(answer.verdict) at \(answer.date.formatted(date: .omitted, time: .shortened)), after Auto's reviewer held it back"
              : "\(answer.verdict) at \(answer.date.formatted(date: .omitted, time: .shortened)), not by you: \(answer.reason)")
        .accessibilityElement(children: .combine)
    }
}
