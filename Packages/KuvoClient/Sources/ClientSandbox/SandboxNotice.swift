import Foundation

// MARK: Settings › Permissions' words

/// How both apps show a computer's sandbox atop its Permissions page: when it's on, one quiet line;
/// when it needs you, an orange row with what happened and the one button that fixes it.
public struct SandboxNotice: Equatable, Sendable {
    public enum Look: Sendable {
        /// On: a small green shield and the line, in secondary ink.
        case on
        /// Being checked: a small loader and the line.
        case checking
        /// Commands run outside the sandbox, or not at all, and it needs you: orange.
        case needsYou
    }

    /// What a button does. `route` ones are the box's (`SandboxState.route`); the others the
    /// client's own.
    public enum Action: Equatable, Sendable {
        /// Checks it again (`kuvo/sandbox/check`), which also puts back what was changed.
        case check
        /// Starts the computer's engine over; `asking` first when what agents are doing stops.
        case restartEngine(asking: Bool)
        /// The docs on what a machine needs.
        case help
        /// macOS's Software Update.
        case softwareUpdate
        /// Report a Problem, about the check that keeps failing.
        case report
    }

    public struct Button: Equatable, Sendable {
        public var title: String
        public var action: Action

        public init(title: String, action: Action) {
            self.title = title
            self.action = action
        }
    }

    public var look: Look
    /// The row's title; none for a one-line state.
    public var title: String?
    public var detail: String
    public var buttons: [Button]
}

extension SandboxState {
    /// Its line or row, as the box says it is now.
    public var notice: SandboxNotice {
        if on, gaps?.contains(.services) == true {
            // On, but not all of it: systemd can run what a command asks outside it.
            let fix = needs == "util-linux" ? "has util-linux" : "allows user namespaces"
            return SandboxNotice(look: .needsYou, title: "Commands can still reach your login’s services",
                                 detail: "They run in the sandbox, but this machine doesn’t let it keep them from services like systemd. Until it \(fix), agents don’t use your vault here and goals don’t run on their own.",
                                 buttons: [.init(title: "How to Check…", action: .help)])
        }
        if on { return SandboxNotice(look: .on, title: nil, detail: "Agents’ commands run in a sandbox: they can’t read your keys or sign-ins.", buttons: []) }
        let check = SandboxNotice.Button(title: "Try Again", action: .check)
        switch reason {
        case .checking:
            return SandboxNotice(look: .checking, title: nil, detail: "Checking the sandbox…", buttons: [])
        case .checkFailed:
            let again = (failures ?? 1) > 1
            return SandboxNotice(look: .needsYou, title: again ? "The sandbox’s check failed again" : "The sandbox’s check failed",
                                 detail: "\(again ? "It" : "Its check") found that \(found), so commands run outside the sandbox for now.",
                                 buttons: again ? [check, .init(title: "Report a Problem…", action: .report)] : [check])
        case .plugin:
            return SandboxNotice(look: .needsYou, title: "Kuvo Code’s part in the engine was changed",
                                 detail: "It’s missing or not as Kuvo Code left it, so commands run outside the sandbox.", buttons: [.init(title: "Fix It", action: .check)])
        case .waiting:
            return SandboxNotice(look: .needsYou, title: "The sandbox starts when the engine restarts", detail: "Until then, commands run outside it.",
                                 buttons: [.init(title: "Restart Engine…", action: .restartEngine(asking: true))])
        case .engineDown:
            return SandboxNotice(look: .needsYou, title: "The engine isn’t running", detail: "No commands run until it starts again, in the sandbox.",
                                 buttons: [.init(title: "Restart Engine", action: .restartEngine(asking: false))])
        case .engineMissing:
            return SandboxNotice(look: .needsYou, title: "The engine isn’t installed yet", detail: "Commands run in the sandbox once it is.",
                                 buttons: [.init(title: "Check Again", action: .check)])
        case .kernel:
            return SandboxNotice(look: .needsYou, title: "\(release.map { "Linux \($0)" } ?? "This Linux") can’t sandbox commands",
                                 detail: "Commands run outside the sandbox here. It needs \(needs ?? "Linux 5.13") or later, with Landlock on.",
                                 buttons: [.init(title: "How to Check…", action: .help)])
        case .namespaces:
            // A box that doesn't run without a namespace for each command (none does now: `gaps`).
            let fix = needs == "util-linux" ? "has util-linux" : "allows user namespaces"
            return SandboxNotice(look: .needsYou, title: "This machine can’t sandbox commands",
                                 detail: "Commands run outside the sandbox here until it \(fix), so the sandbox can keep them from services like systemd.",
                                 buttons: [.init(title: "How to Check…", action: .help)])
        case .macos:
            return SandboxNotice(look: .needsYou, title: "This version of macOS can’t sandbox commands", detail: "Commands run outside the sandbox here.",
                                 buttons: [.init(title: "Software Update…", action: .softwareUpdate)])
        case nil:
            // A newer box's reason: its own words, and the button for the route it names, where a
            // client knows it.
            let button: SandboxNotice.Button? = switch route {
            case let route? where route.hasSuffix(SandboxRoutes.check): check
            case let route? where route.hasSuffix("kuvo/engine/restart"): .init(title: "Restart Engine…", action: .restartEngine(asking: true))
            default: nil
            }
            return SandboxNotice(look: .needsYou, title: "Commands run outside the sandbox", detail: why ?? "The sandbox isn’t on.", buttons: button.map { [$0] } ?? [])
        }
    }

    /// What the failed check found, in words.
    private var found: String {
        switch check {
        case .readsOwn: "a command could still read Kuvo Code’s files"
        case .writesOwn: "a command could write in Kuvo Code’s own folder"
        case .services: "a command could still reach your login’s services"
        case .folder: "a command couldn’t work in its own folder"
        case .tempFiles: "a command couldn’t write its temporary files"
        case .setup: "it couldn’t be set up"
        case .didntRun, nil: "its test command didn’t run"
        }
    }

    /// The Linux release in the box's words ("Linux 5.10 can't…").
    private var release: String? {
        guard let why, let range = why.range(of: #"Linux [0-9][0-9.]*"#, options: .regularExpression) else { return nil }
        return String(why[range].dropFirst("Linux ".count))
    }
}
