import AppKit
import Foundation
import UsageKit

/// Kuvo Code's first launch: the bots get it ready (the engine's download and start), you bring
/// over the subscriptions this computer already has, and you allow screen access for agents. Each
/// step can be skipped; where you are is kept, so quitting partway (Screen Recording asks you to
/// quit and reopen) opens on the same step again. Shown once, and never to a copy that's run before.
@Observable
final class Onboarding {
    enum Step: String, CaseIterable {
        /// The bots, while the engine downloads and starts.
        case loader
        case subscriptions
        case screenAccess
        case done
    }

    private(set) var step: Step

    /// What this computer has that Kuvo Code can use, as its box lists it (`kuvo/accounts/found`).
    private(set) var found: Found?
    /// Counts the looks: only the latest one's answer counts.
    @ObservationIgnored private var looks = 0
    /// Why the list couldn't be read, in words.
    private(set) var lookFailure: String?
    /// opencode keys brought over just now, by id, and ones on their way.
    private(set) var used: Set<String> = []
    private(set) var using: Set<String> = []
    private(set) var useFailure: String?

    /// The usage panel in the menu bar: off until it's turned on here (or by a click on it).
    private(set) var usage = Usage.off(nil)

    let screen: ScreenAccess
    private let usagePanel: UsagePanel

    static let stepKey = "onboarding.step"
    private let defaults: UserDefaults

    /// `launchedBefore`: this copy has run before (an update, not a first launch).
    init(defaults: UserDefaults = .standard, launchedBefore: Bool, screen: ScreenAccess = ScreenAccess(), usage: UsagePanel = .menuBar) {
        self.defaults = defaults
        self.screen = screen
        usagePanel = usage
        if let saved = defaults.string(forKey: Self.stepKey).flatMap(Step.init(rawValue:)) {
            step = saved
        } else {
            step = launchedBefore ? .done : .loader
        }
        #if DEBUG
        // KUVO_DEMO_ONBOARDING=<step>: shows the first launch from that step (`loader` while the
        // engine starts, `subscriptions`, `screenAccess`), for a look at it in a demo copy.
        if let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_ONBOARDING"], let shown = Step(rawValue: demo) { step = shown }
        #endif
        // Kept from the start, so a quit during the loader opens on it again.
        defaults.set(step.rawValue, forKey: Self.stepKey)
        // Opened again on screen access (Screen Recording asks you to quit and reopen): followed
        // again, and done once both are allowed.
        if step == .screenAccess { arrive(at: .screenAccess) }
    }

    var isActive: Bool { step != .done }

    /// On to the next step (or the one after, when there's nothing to do in it).
    func advance() {
        screen.refresh()
        guard let index = Step.allCases.firstIndex(of: step), index + 1 < Step.allCases.count else { return }
        var next = Step.allCases[index + 1]
        // Screen access already allowed (a copy you've run, a Mac set up before): nothing to ask.
        if next == .screenAccess, screen.allAllowed { next = .done }
        move(to: next)
    }

    /// Leaves the first launch for the workspace.
    func finish() { move(to: .done) }

    private func move(to next: Step) {
        step = next
        defaults.set(next.rawValue, forKey: Self.stepKey)
        Analytics.shared.onboardingStep(next == .screenAccess ? "screen_access" : next.rawValue)
        arrive(at: next)
    }

    /// What a step follows while it shows: screen access, the permissions.
    private func arrive(at step: Step) {
        guard step == .screenAccess else { return screen.stopWatching() }
        screen.watch { [weak self] in self?.screenChanged() }
        screenChanged()
    }

    /// The engine's ready: from the loader, on to the subscriptions.
    func engineReady() {
        if step == .loader { advance() }
    }

    // MARK: Subscriptions

    /// Reads the list from this computer's box. Again after a sign-in or an install changes it.
    func look(in box: BoxClient) async {
        looks += 1
        let look = looks
        do {
            let answer = try await box.value(Found.self, "GET", "kuvo/accounts/found")
            guard look == looks else { return }
            found = answer
            lookFailure = nil
        } catch {
            // Given up for a newer look (the box came up meanwhile): not a failure.
            guard look == looks, !Task.isCancelled else { return }
            if found == nil { lookFailure = error.localizedDescription }
        }
    }

    /// Brings an opencode key over into the engine. True once it's there.
    @discardableResult
    func use(_ item: Found.Opencode, in box: BoxClient) async -> Bool {
        guard !using.contains(item.id) else { return false }
        using.insert(item.id)
        defer { using.remove(item.id) }
        struct Body: Encodable { var id: String }
        do {
            let (status, data) = try await box.send("POST", "kuvo/accounts/found/use", body: JSONEncoder().encode(Body(id: item.id)))
            if (200..<300).contains(status) {
                used.insert(item.id)
                useFailure = nil
                return true
            }
            useFailure = BoxRefusal(status: status, data: data).message
        } catch {
            useFailure = error.localizedDescription
        }
        return false
    }

    /// Whether the usage panel's row shows: while it waits to be turned on, and once it's on.
    var offersUsage: Bool {
        if case .off = usage { usagePanel.isWaiting() } else { true }
    }

    /// Turns the usage panel on, for the plans whose sign-ins are on this Mac (macOS may ask to let
    /// Kuvo Code read each one).
    func turnOnUsage() async {
        guard case .off = usage else { return }
        usage = .turningOn
        guard let result = await usagePanel.turnOn() else {
            usage = .off("The usage panel is still starting. Try again in a moment.")
            return
        }
        usage = .on(following: result.following, failure: result.failure)
    }

    /// What the screen offers, from what was found.
    var offers: Offers { Offers(found: found, used: used) }

    // MARK: Screen access

    private func screenChanged() {
        // Both allowed: on into the workspace, by itself.
        if step == .screenAccess, screen.allAllowed { finish() }
    }
}

/// What a computer has that Kuvo Code can use, as its box answers `kuvo/accounts/found`.
struct Found: Decodable, Equatable {
    var agents: [Agent]
    var opencode: [Opencode]
    var shell: [Shell]

    struct Agent: Decodable, Equatable {
        var id: String
        var name: String
        var installed: Bool
        var signedIn: Bool
        var label: String?
    }

    struct Opencode: Decodable, Equatable, Identifiable {
        var id: String
        var integrationID: String
        var name: String
        var kind: Kind
        var connected: Bool

        enum Kind: String, Decodable { case key, signIn }
    }

    struct Shell: Decodable, Equatable {
        var integrationID: String
        var name: String
        var variable: String
    }
}

/// The rows of "Bring your subscriptions", from what was found: each with the one thing it needs.
struct Offers: Equatable {
    struct Row: Equatable, Identifiable {
        enum Action: Equatable {
            /// Works as it is.
            case ready
            /// An opencode key brought over.
            case added
            /// Sign in to it here (an agent signed out, a sign-in that can't be copied).
            case signIn(integrationID: String)
            /// Copy this opencode key in.
            case use(Found.Opencode)
            /// Run its maker's installer.
            case install(integrationID: String)
        }

        var id: String
        /// The engine's or the agents bridge's integration, for its logo.
        var integrationID: String
        var name: String
        var detail: String
        var action: Action
    }

    var agents: [Row] = []
    var opencode: [Row] = []
    var shell: [Row] = []

    /// What a computer with nothing to bring over is offered: the common subscriptions, with the one
    /// thing each needs on it.
    var suggestions: [Row] = []

    init(found: Found?, used: Set<String> = []) {
        guard let found else { return }
        // Installed agents: ready when signed in, a sign-in otherwise. One that isn't installed
        // isn't something you have (Settings › Accounts still offers it), and neither is one that
        // comes with Kuvo Code (Cursor's, Antigravity's) until you're signed in to it.
        agents = found.agents.filter { $0.installed && ($0.signedIn || Self.ownPrograms.contains($0.id)) }.map { agent in
            Row(id: agent.id, integrationID: agent.id, name: agent.name,
                detail: agent.signedIn ? (agent.label.map { "Signed in as \($0)" } ?? "Signed in") : "Installed, not signed in",
                action: agent.signedIn ? .ready : .signIn(integrationID: agent.id))
        }
        opencode = found.opencode.map { item in
            let action: Row.Action = item.connected ? .ready : used.contains(item.id) ? .added : item.kind == .key ? .use(item) : .signIn(integrationID: item.integrationID)
            let detail = item.kind == .key ? "API key" : item.connected ? "Signed in" : "Sign in again to use it here"
            return Row(id: item.id, integrationID: item.integrationID, name: item.name, detail: detail, action: action)
        }
        // A provider already used from the shell isn't offered twice.
        let fromOpencode = Set(found.opencode.map(\.integrationID))
        shell = found.shell.filter { !fromOpencode.contains($0.integrationID) }.map { key in
            Row(id: "shell:" + key.variable, integrationID: key.integrationID, name: key.name, detail: "From \(key.variable) in your shell", action: .ready)
        }
        // Nothing that works yet: the agents and opencode's sign-ins you have to sign in to again,
        // and the common subscriptions.
        if !hasSomething {
            let yours = agents + opencode
            suggestions = yours + Self.common(found.agents).filter { row in !yours.contains { $0.integrationID == row.integrationID } }
        }
    }

    /// The agents whose programs are your own, installed by their makers' installers.
    static let ownPrograms: Set = ["claude-code", "codex-cli", "grok-cli"]

    /// Something works already, or can be brought over with one tap.
    var hasSomething: Bool {
        (agents + opencode + shell).contains { row in
            switch row.action {
            case .ready, .added, .use: true
            case .signIn, .install: false
            }
        }
    }

    /// Claude Code, Codex and GitHub Copilot, each with what it needs here.
    private static func common(_ agents: [Found.Agent]) -> [Row] {
        func agent(_ id: String, _ name: String, _ plan: String) -> Row {
            let known = agents.first { $0.id == id }
            return Row(id: id, integrationID: id, name: name, detail: plan, action: known?.installed == true ? .signIn(integrationID: id) : .install(integrationID: id))
        }
        return [
            agent("claude-code", "Claude Code", "Claude Pro or Max"),
            agent("codex-cli", "Codex", "ChatGPT Plus or Pro"),
            Row(id: "github-copilot", integrationID: "github-copilot", name: "GitHub Copilot", detail: "A Copilot plan", action: .signIn(integrationID: "github-copilot")),
        ]
    }
}

extension Onboarding {
    enum Usage: Equatable {
        /// Not turned on, with why it couldn't be just now.
        case off(String?)
        case turningOn
        /// On, following these plans; `failure`: why one couldn't be read.
        case on(following: [String], failure: String?)
    }

    /// The usage panel, as the first launch turns it on: UsageKit's in the menu bar, or a test's.
    struct UsagePanel {
        var isWaiting: () -> Bool
        var turnOn: @MainActor () async -> UsageMenuBar.FirstLaunchResult?

        static let menuBar = UsagePanel(
            isWaiting: { UsageMenuBar.shared.isWaitingForFirstLaunch },
            turnOn: { await UsageMenuBar.shared.turnOnFirstLaunch() })
    }
}
