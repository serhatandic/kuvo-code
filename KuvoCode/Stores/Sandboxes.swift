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
    /// Asks being answered here, which a second click leaves alone and a read meanwhile doesn't
    /// bring back.
    private(set) var answering: Set<String> = []
    /// Reaches a box (`AppModel.box`), set as the app starts.
    @ObservationIgnored var client: (String) -> BoxClient? = { _ in nil }
    /// Asks answered here: closed on their box, so a list it sent before the answer doesn't bring
    /// them back.
    @ObservationIgnored private var answered: Set<String> = []

    /// A conversation's open asks, on its box.
    func asks(for session: String, on box: String) -> [SandboxAsk] {
        #if DEBUG
        if let demo = Self.demo { return demo.map { var ask = $0; ask.session = session; return ask }.filter { !answering.contains($0.id) } }
        #endif
        return (asks[box] ?? []).filter { $0.session == session && !answering.contains($0.id) }
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
            case "write": return SandboxAsk(id: id, at: now, botName: "Scout", project: home + "/kuvo-ai", command: "./scripts/install-hooks.sh",
                                            why: "Installing the repo’s hooks, as the README asks.", stopped: [SandboxStop(kind: .write, path: home + "/.zshrc")],
                                            always: .init(path: home + "/.zshrc"))
            case "waiting": return SandboxAsk(id: id, at: now - 12 * 60_000, botName: "Scout", project: home + "/kuvo-ai", command: "./scripts/install-hooks.sh",
                                              why: "Installing the repo’s hooks, as the README asks.", stopped: [SandboxStop(kind: .write, path: home + "/.zshrc")],
                                              always: .init(path: home + "/.zshrc"))
            case "linux": return SandboxAsk(id: id, at: now, botName: "Scout", project: "/home/me/kuvo-ai", command: "./scripts/install-hooks.sh",
                                            why: "Installing the repo’s hooks, as the README asks.", error: "/home/me/.zshrc: Permission denied", machine: "lokum")
            case "long": return SandboxAsk(id: id, at: now, sessionName: "Release the beta", project: home + "/kuvo-ai",
                                           command: "bundle exec fastlane ios beta --env production skip_waiting_for_build_processing:true changelog:\"Fixes the composer, the sidebar and the usage panel\" && ./scripts/notify-team.sh --channel releases",
                                           why: "Fastlane keeps its logs and the build’s metadata in its own folder in your Library, which the sandbox doesn’t let commands write.",
                                           stopped: [SandboxStop(kind: .write, path: home + "/Library/Logs/fastlane/gym/KuvoCodeMobile-KuvoCodeMobile.log"), SandboxStop(kind: .connect, path: "api.appstoreconnect.apple.com:443")],
                                           always: .init(path: home + "/Library/Logs/fastlane"))
            case "app": return SandboxAsk(id: id, at: now, botName: "Pixel", project: home + "/kuvo-ai", command: "open -a Simulator",
                                          why: "To see the new screen on the simulator.", stopped: [SandboxStop(kind: .app)])
            default: return nil
            }
        }
    }
    #endif

    /// The commands a conversation's open asks are about, which their rows mark stopped.
    func stoppedCommands(for session: String, on box: String) -> Set<String> {
        Set(asks(for: session, on: box).map(\.command))
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

    /// Follows `box`'s asks from now on, until the task following it ends (this Mac's box stopping,
    /// a machine disconnecting or removed): this Mac's box tells each change as it's made; a
    /// machine's, reached over SSH, answers once, so it's read again every ten seconds. A box from
    /// before the sandbox's asks stops it.
    func follow(_ box: String) async {
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
        asks[box] = nil
        changed()
    }

    /// What `box` asks now, in place of what it asked before: each new one told once, and each
    /// gone (answered here or on a phone, or no longer asked) taken off Notification Center.
    func take(_ listed: [SandboxAsk], from box: String) {
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
        }
        changed()
    }

    private func changed() {
        onChange?(Set(asks.values.joined().compactMap(\.session)))
    }

    // Here only: the box tells your phones itself (PROTOCOL.md, "Sandbox").
    private func tell(_ ask: SandboxAsk) {
        Notifier.shared.notify(session: ask.session ?? "", title: ask.title, body: ask.command, ask: ask.id)
    }

    /// Forgets what's shown of `box` (the machine removed from this Mac).
    func forget(_ box: String) {
        for gone in asks[box] ?? [] { Notifier.shared.clear(request: gone.id) }
        asks[box] = nil
        changed()
    }

    /// Your answer: once, always (where the ask names a place) or no. One that's no longer open
    /// (answered elsewhere, or the agent stopped waiting) is gone, not an error.
    func answer(_ asked: SandboxAsk, _ answer: SandboxAnswer, on box: String) async throws {
        guard answering.insert(asked.id).inserted else { return }
        defer { answering.remove(asked.id) }
        do {
            _ = try await ask(Nothing.self, "POST", SandboxRoutes.ask(asked.id), body: ["answer": answer.rawValue], on: box)
        } catch let refusal as BoxRefusal where refusal.status == 404 {
        }
        answered.insert(asked.id)
        take((asks[box] ?? []).filter { $0.id != asked.id }, from: box)
    }
}
