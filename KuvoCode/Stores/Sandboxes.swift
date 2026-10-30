import ClientSandbox
import Foundation

/// The commands each computer's agents ask to run outside its sandbox (KuvoLink's PROTOCOL.md,
/// "Sandbox"), as the Mac app shows and answers them: what its box lists, by box (`BoxClient.mac`,
/// or a machine's id).
@MainActor
@Observable
final class Sandboxes {
    static let shared = Sandboxes()

    /// Each box's open asks, oldest first.
    private(set) var asks: [String: [SandboxAsk]] = [:]
    /// Asks being answered here: their cards wait, and a second click is left alone.
    private(set) var answering: Set<String> = []
    /// Why an answer didn't go through, by ask: its card says so, to try again.
    private(set) var failures: [String: String] = [:]
    /// Boxes whose asks have been heard since they were last reached: until then, what they ask is
    /// unknown, not nothing.
    private(set) var heard: Set<String> = []
    /// Reaches a box (`AppModel.box`), set as the app starts.
    @ObservationIgnored var client: (String) -> BoxClient? = { _ in nil }
    /// Asks answered here: closed on their box, so a list it sent before the answer doesn't bring
    /// them back.
    @ObservationIgnored private var answered: Set<String> = []
    /// Each conversation's commands whose asks were seen open and then closed (answered here or
    /// elsewhere), by box and conversation: only those may be running outside the sandbox.
    private(set) var released: [String: Set<String>] = [:]

    /// A conversation's open asks, on its box.
    func asks(for session: String, on box: String) -> [SandboxAsk] {
        #if DEBUG
        if let demo = Self.demo { return demo.map { var ask = $0; ask.session = session; return ask }.filter { !answered.contains($0.id) } }
        #endif
        return (asks[box] ?? []).filter { $0.session == session }
    }

    #if DEBUG
    /// KUVO_DEMO_SANDBOX_ASK: sample asks over every conversation's composer, for a look at the
    /// card, comma-separated: `write` (a Mac's, with Always), `linux` (a machine's error), `long` (a
    /// long command and path), `app` (not a file), `waiting` (a bot's, 12 minutes on).
    static let demo: [SandboxAsk]? = ProcessInfo.processInfo.environment["KUVO_DEMO_SANDBOX_ASK"].map { kinds in
        let now = Date().timeIntervalSince1970 * 1000
        let home = NSHomeDirectory()
        return kinds.split(separator: ",").map(String.init).enumerated().compactMap { index, kind in
            let id = "demo_\(index)"
            switch kind {
            // (Always only where the box would give it: never a file it keeps closed, like ~/.zshrc.)
            case "write": return SandboxAsk(id: id, at: now, botName: "Scout", project: home + "/kuvo-ai", command: "npm run build:icons",
                                            why: "The icon tool caches its renders in its own folder.", stopped: [SandboxStop(kind: .write, path: home + "/Library/Caches/icon-gen/renders.db")],
                                            always: .init(path: home + "/Library/Caches/icon-gen"))
            case "waiting": return SandboxAsk(id: id, at: now - 12 * 60_000, botName: "Scout", project: home + "/kuvo-ai", command: "./scripts/install-hooks.sh",
                                              why: "Installing the repo’s hooks, as the README asks.", stopped: [SandboxStop(kind: .write, path: home + "/.zshrc")])
            case "linux": return SandboxAsk(id: id, at: now, botName: "Scout", project: "/home/me/kuvo-ai", command: "./scripts/install-hooks.sh",
                                            why: "Installing the repo’s hooks, as the README asks.", error: "/home/me/.zshrc: Permission denied", machine: "lokum")
            case "long": return SandboxAsk(id: id, at: now, sessionName: "Release the beta", project: home + "/kuvo-ai",
                                           command: "bundle exec fastlane ios beta --env production skip_waiting_for_build_processing:true changelog:\"Fixes the composer, the sidebar and the usage panel\" && ./scripts/notify-team.sh --channel releases",
                                           why: "Fastlane keeps its logs and the build’s metadata in its own folder in your Library, which the sandbox doesn’t let commands write.",
                                           stopped: [SandboxStop(kind: .write, path: home + "/Library/Logs/fastlane/gym/KuvoCodeMobile-KuvoCodeMobile.log")],
                                           always: .init(path: home + "/Library/Logs/fastlane"))
            case "app": return SandboxAsk(id: id, at: now, botName: "Pixel", project: home + "/kuvo-ai", command: "open -a Simulator",
                                          why: "To see the new screen on the simulator.", stopped: [SandboxStop(kind: .app)])
            default: return nil
            }
        }
    }
    #endif

    /// The commands a conversation's open asks are about, which their rows mark stopped; nil
    /// before its box's asks are heard (the app just opened, or the machine's connecting).
    func stoppedCommands(for session: String, on box: String) -> Set<String>? {
        #if DEBUG
        if Self.demo != nil { return Set(asks(for: session, on: box).map(\.command)) }
        #endif
        guard heard.contains(box) else { return nil }
        return Set(asks(for: session, on: box).map(\.command))
    }

    /// The commands a conversation's asks were seen open for and no longer are: allowed (or
    /// refused) and so, while their step goes on, running. One whose ask hasn't been listed yet
    /// isn't among them: its step still asks.
    func releasedCommands(for session: String, on box: String) -> Set<String> {
        released[Self.key(session, on: box)] ?? []
    }

    private struct Nothing: Decodable {}

    private func ask<T: Decodable>(_ type: T.Type = T.self, _ method: String, _ path: String, body: [String: Any]? = nil, on box: String) async throws -> T {
        guard let client = client(box) else { throw BoxRefusal(status: 503, message: "Kuvo Code isn't ready yet.") }
        let (status, data) = try await client.send(method, path, body: try body.map { try JSONSerialization.data(withJSONObject: $0) })
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// The conversations asking now, for their marks in the sidebar and the Dock's count.
    @ObservationIgnored var onChange: ((Set<String>) -> Void)?
    /// What's been told, so each ask is told once.
    @ObservationIgnored private var told: Set<String> = []
    /// Each box's follow now, so one that ended (a reconnect) leaves the next one's asks alone.
    @ObservationIgnored private var following: [String: UUID] = [:]

    /// Follows `box`'s asks from now on, until the task following it ends (this Mac's box stopping,
    /// a machine disconnecting or removed): this Mac's box tells each change as it's made; a
    /// machine's, reached over SSH, answers once, so it's read again every ten seconds. A box from
    /// before the sandbox's asks stops it.
    func follow(_ box: String) async {
        let me = UUID()
        following[box] = me
        while !Task.isCancelled {
            if let client = client(box) {
                do {
                    for try await line in client.follow(SandboxRoutes.asks + "/events") {
                        guard let list = try? JSONDecoder().decode(SandboxAsks.self, from: line) else { continue }
                        take(list.asks, from: box)
                    }
                } catch let refusal as BoxRefusal where [404, 405].contains(refusal.status) {
                    return
                } catch {}
            }
            try? await Task.sleep(for: .seconds(box == BoxClient.mac ? 2 : 10))
        }
        // Gone with its connection: nothing it asks can be answered from here now. What it still
        // asks keeps its notification, and isn't told again when it's back.
        guard following[box] == me else { return }
        following[box] = nil
        asks[box] = nil
        heard.remove(box)
        released = released.filter { !$0.key.hasPrefix(box + "\n") }
        changed()
    }

    /// What `box` asks now, in place of what it asked before: each new one told once, and each
    /// gone (answered here or on a phone, or no longer asked) taken off Notification Center.
    func take(_ listed: [SandboxAsk], from box: String) {
        heard.insert(box)
        let listed = listed.filter { !answered.contains($0.id) }
        let before = asks[box] ?? []
        guard listed != before else { return }
        asks[box] = listed.isEmpty ? nil : listed
        for ask in listed where !told.contains(ask.id) {
            told.insert(ask.id)
            tell(ask)
        }
        for gone in before where !listed.contains(where: { $0.id == gone.id }) {
            Notifier.shared.clear(request: gone.id)
            failures[gone.id] = nil
            if let session = gone.session { released[Self.key(session, on: box), default: []].insert(gone.command) }
        }
        changed()
    }

    private func changed() {
        onChange?(Set(asks.values.joined().compactMap(\.session)))
    }

    // Here only: the box tells your phones itself (PROTOCOL.md, "Sandbox").
    private func tell(_ ask: SandboxAsk) {
        Notifier.shared.notify(session: ask.session ?? "", title: ask.title, subtitle: ask.machine, body: ask.command + "\n“\(ask.why)”", ask: ask.id)
    }

    /// Forgets what's shown of `box` (the machine removed from this Mac).
    func forget(_ box: String) {
        for gone in asks[box] ?? [] { Notifier.shared.clear(request: gone.id) }
        asks[box] = nil
        heard.remove(box)
        changed()
    }

    /// Your answer: once, always (where the ask names a place) or no. One that's no longer open
    /// (answered elsewhere, or the agent stopped waiting) is gone, not an error.
    func answer(_ asked: SandboxAsk, _ answer: SandboxAnswer, on box: String) async throws {
        guard answering.insert(asked.id).inserted else { return }
        defer { answering.remove(asked.id) }
        failures[asked.id] = nil
        do {
            _ = try await ask(Nothing.self, "POST", SandboxRoutes.ask(asked.id), body: ["answer": answer.rawValue], on: box)
        } catch let refusal as BoxRefusal where refusal.status == 404 {
        } catch {
            failures[asked.id] = (error as? BoxRefusal)?.message ?? error.localizedDescription
            throw error
        }
        answered.insert(asked.id)
        take((asks[box] ?? []).filter { $0.id != asked.id }, from: box)
    }

    // MARK: Settings › Permissions

    /// Each box's sandbox as it last said, for its Permissions page.
    private(set) var states: [String: SandboxState] = [:]
    /// Why a box's sandbox couldn't be read the last time.
    private(set) var stateFailures: [String: String] = [:]
    /// Boxes too old to have a sandbox: their page says nothing of it.
    private(set) var without: Set<String> = []
    /// Boxes being checked again from here, which a second click leaves alone.
    private(set) var checking: Set<String> = []
    /// Each project's Also Allowed, by box and the project's folder as this Mac knows it.
    private(set) var rules: [String: [SandboxRule]] = [:]

    private static func key(_ project: String, on box: String) -> String { box + "\n" + project }

    /// A project's Also Allowed, as its box last listed it.
    func rules(for project: String, on box: String) -> [SandboxRule] {
        rules[Self.key(project, on: box)] ?? []
    }

    #if DEBUG
    /// KUVO_DEMO_SANDBOX_STATE: how every box's sandbox says it is, for a look at Settings ›
    /// Permissions: `on`, `antigravity` (on, not Antigravity's), `checking`, `checkFailed`,
    /// `failedAgain`, `plugin`, `waiting`, `engineDown`, `engineMissing`, `kernel` or `macos`.
    /// KUVO_DEMO_SANDBOX_RULES=1: every project's Also Allowed has two folders.
    static let demoState: SandboxState? = ProcessInfo.processInfo.environment["KUVO_DEMO_SANDBOX_STATE"].map { kind in
        switch kind {
        case "on": SandboxState(on: true, agents: true)
        case "antigravity": SandboxState(on: true, agents: false)
        case "checkFailed": SandboxState(on: false, reason: .checkFailed, action: .retry, route: SandboxRoutes.check, check: .readsOwn, failures: 1)
        case "failedAgain": SandboxState(on: false, reason: .checkFailed, action: .retry, route: SandboxRoutes.check, check: .writesOwn, failures: 3)
        case "kernel": SandboxState(on: false, why: "Linux 5.10 can't sandbox commands: it needs Landlock (Linux 5.13 or later, with it on).", able: false, reason: .kernel, action: .help, needs: "Linux 5.13")
        default: SandboxState(on: false, reason: SandboxState.Reason(rawValue: kind) ?? .checking)
        }
    }
    static let demoRules = ProcessInfo.processInfo.environment["KUVO_DEMO_SANDBOX_RULES"] == "1"
    #endif

    /// Reads how `box`'s sandbox is now.
    func readState(_ box: String) async {
        #if DEBUG
        if let demo = Self.demoState { states[box] = demo; return }
        #endif
        do {
            states[box] = try await ask(SandboxState.self, "GET", SandboxRoutes.state, on: box)
            stateFailures[box] = nil
            without.remove(box)
        } catch let refusal as BoxRefusal where [404, 405].contains(refusal.status) {
            without.insert(box)
            states[box] = nil
        } catch is CancellationError {
        } catch {
            stateFailures[box] = (error as? BoxRefusal)?.message ?? error.localizedDescription
        }
    }

    /// Reads it again while its page is open, as the box checks it on its own and the engine comes
    /// and goes: often while it's passing on its own (being checked, the engine coming back),
    /// rarely otherwise; not at all on a box without it.
    func watchState(_ box: String) async {
        while !Task.isCancelled {
            await readState(box)
            if without.contains(box) { return }
            // A machine's goes over SSH: less often.
            try? await Task.sleep(for: .seconds(Self.passes(states[box]) ? (box == BoxClient.mac ? 4 : 10) : 30))
        }
    }

    /// Whether how it stands changes on its own soon (not read yet counts).
    private static func passes(_ state: SandboxState?) -> Bool {
        guard let state else { return true }
        if state.on { return false }
        switch state.reason {
        case .checking, .waiting, .engineDown, .engineMissing: return true
        default: return false
        }
    }

    /// Checks it again, which also puts back Kuvo Code's part in the engine where it was changed.
    func check(_ box: String) async throws {
        guard checking.insert(box).inserted else { return }
        defer { checking.remove(box) }
        do {
            states[box] = try await ask(SandboxState.self, "POST", SandboxRoutes.check, body: [:], on: box)
            stateFailures[box] = nil
        } catch {
            // Said on its page, under the button.
            stateFailures[box] = (error as? BoxRefusal)?.message ?? error.localizedDescription
            throw error
        }
    }

    /// Reads a project's Also Allowed (its box finds where its folder really is).
    func readRules(for project: String, on box: String) async throws {
        #if DEBUG
        if Self.demoRules {
            let home = NSHomeDirectory(), at = Date().timeIntervalSince1970 * 1000
            rules[Self.key(project, on: box)] = rules[Self.key(project, on: box)] ?? [
                SandboxRule(id: "al_1", project: project, path: home + "/Library/Caches/icon-gen", at: at - 86_400_000, by: "Serhat’s iPhone"),
                SandboxRule(id: "al_2", project: project, path: home + "/Library/Logs/fastlane/gym/builds/KuvoCodeMobile/archives/2026-10-29", at: at),
            ]
            return
        }
        #endif
        rules[Self.key(project, on: box)] = try await ask(SandboxAllowed.self, "GET", SandboxRoutes.allowed(project: project), on: box).allowed
    }

    /// Lets a project's commands write in `path` too, in the sandbox; the box's words when it
    /// can't (a place it keeps closed, or too many).
    func allow(_ path: String, in project: String, on box: String) async throws {
        #if DEBUG
        if Self.demoRules { rules[Self.key(project, on: box), default: []].append(SandboxRule(id: UUID().uuidString, project: project, path: path, at: Date().timeIntervalSince1970 * 1000)); return }
        #endif
        let listed = try await ask(SandboxAllowed.self, "POST", SandboxRoutes.allowed, body: ["project": project, "kind": "write", "path": path], on: box).allowed
        rules[Self.key(project, on: box)] = listed
    }

    /// Takes a place out of its project's Also Allowed; one already gone counts.
    func remove(_ rule: SandboxRule, from project: String, on box: String) async throws {
        #if DEBUG
        if Self.demoRules { rules[Self.key(project, on: box)]?.removeAll { $0.id == rule.id }; return }
        #endif
        do {
            rules[Self.key(project, on: box)] = try await ask(SandboxAllowed.self, "DELETE", SandboxRoutes.rule(rule.id), on: box).allowed
        } catch let refusal as BoxRefusal where refusal.status == 404 {
            rules[Self.key(project, on: box)]?.removeAll { $0.id == rule.id }
        }
    }
}
