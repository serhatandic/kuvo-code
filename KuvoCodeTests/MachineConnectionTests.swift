import CryptoKit
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A machine's connection, from the moment it's up to Disconnect, Remove or a reconnect: what runs
/// for it (the steps after it connects, the syncs that keep it current) ends with it. A machine
/// removed while it connects gets nothing more and leaves the sidebar; a reconnect leaves one set
/// of syncs running, not two; Disconnect stops a round about to begin. The machines' engines are
/// stubbed (StubEngine), SSH to them answers nothing and is noted (`SSHConnection.standIn`), and
/// the time between syncs is the test's own (TestClock).
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct MachineConnectionTests {
    let app = AppModel()
    let machine: StubEngine
    let mac: FakeEngine
    let clock = TestClock()
    let ssh = SSHLog()
    let reachable = Reachable()
    let realClock = MachineClock.clock

    init() {
        TestEnvironment.prepare()
        machine = StubEngine(port: 47941)
        mac = FakeEngine(port: 47940, accounts: [])
        Self.answerAsAMachine(machine)
        app.standIn(engine: mac.api)
        SSHConnection.standIn = { [ssh] address, script in
            ssh.note(script, to: address)
            return nil
        }
        MachineEngine.standIn = { [reachable] machine in reachable.apis[machine.id] }
        MachineClock.clock = { [clock] seconds in await clock.wait(seconds) }
    }

    private func done() {
        for machine in app.machines.list { app.removeMachine(machine.id) }
        SSHConnection.standIn = nil
        MachineEngine.standIn = nil
        MachineClock.clock = realClock
        machine.stop()
    }

    /// Once it's connected, it's sent what its bots are made with (their kit: templates, your
    /// personalities, its projects), so it makes bots itself with this Mac closed.
    @Test func connectedItsSentItsBotsKit() async throws {
        defer { done() }
        let id = Self.name()
        await app.connect(add(id, at: machine)).value
        #expect(ssh.scripts(to: id).contains { $0.contains("kit.json") }, "its bots' kit went to it")
    }

    /// Removed while it copies your sign-ins, the step before it's sent your agents' list, its
    /// wake-ups' time zone and the rest: none of those go, nor anything after, and it's gone from
    /// the sidebar with its sessions.
    @Test func removedWhileItConnectsItGetsNothingMoreAndLeavesTheSidebar() async throws {
        defer { done() }
        // Its sign-ins read there, held until it's removed.
        let gate = Gate()
        let reading = Gate()
        defer { gate.open() }
        machine.on("GET", "/api/credential") { _ in
            reading.open()
            gate.wait()
            return StubWeb.json(["data": []])
        }
        let id = Self.name()
        let engine = add(id, at: machine)
        let start = app.connect(engine)
        try await until { reading.isOpen }
        #expect(reading.isOpen, "it got to copying your sign-ins")
        #expect(sessions(on: id).count == 1, "its sessions are listed as it connects")
        let sent = ssh.scripts(to: id).count
        let asked = machine.asked.count
        app.removeMachine(id)
        gate.open()
        await start.value
        #expect(Array(ssh.scripts(to: id).dropFirst(sent)) == [], "nothing went to it over SSH once it was removed")
        // The copying under way finishes (cut off halfway, it could leave a sign-in behind): only
        // its own reads, which the stand-in answers one at a time.
        #expect(machine.asked.dropFirst(asked).allSatisfy { ["GET /api/mcp", "GET /api/credential"].contains($0) }, "nor to its engine")
        #expect(app.machines.engine(id) == nil)
        #expect(!app.workspace.machines.contains(id))
        #expect(sessions(on: id).isEmpty, "its sessions left the sidebar")
        #expect(!app.workspace.projects.contains { RemoteFolder.machine(of: $0.directory) == id })
    }

    /// Connect Now while it's connected and its syncs run: one set runs after, not the old one
    /// beside the new (each minute's round goes once).
    @Test func aReconnectLeavesOneSetOfSyncsRunning() async throws {
        defer { done() }
        let id = Self.name()
        let engine = add(id, at: machine)
        await app.connect(engine).value
        try await until { clock.waits == [60, 600] }
        #expect(clock.waits == [60, 600], "its agents' mail each minute, its sign-ins every ten")
        await app.reconnectNow(engine)?.value
        try await until { clock.waits == [60, 600] }
        #expect(clock.waits == [60, 600], "one set of syncs, not two")
        // A minute on: one round, which collects what its agents left for others once.
        let sent = ssh.scripts(to: id).count
        let collected = { self.ssh.scripts(to: id).dropFirst(sent).filter { $0.contains("/run/outbox") }.count }
        clock.pass(60)
        try await until { clock.waits == [60, 600] && collected() >= 1 }
        #expect(clock.waits == [60, 600])
        #expect(collected() == 1)
    }

    /// Your personalities changed, so each connected machine's round begins a moment later:
    /// one disconnected meanwhile gets nothing; another still connected gets its round.
    @Test func disconnectStopsAPersonalitiesRoundAboutToBegin() async throws {
        defer { done() }
        let other = StubEngine(port: 47942, alongside: true)
        Self.answerAsAMachine(other)
        let one = Self.name()
        let two = Self.name()
        let first = add(one, at: machine)
        let second = add(two, at: other)
        await app.connect(first).value
        await app.connect(second).value
        try await until { clock.waits == [60, 60, 600, 600] }
        #expect(clock.waits == [60, 60, 600, 600])
        app.personalitiesChanged()
        try await until { clock.waits == [1, 1, 60, 60, 600, 600] }
        #expect(clock.waits == [1, 1, 60, 60, 600, 600], "a round for each, a moment on")
        app.disconnect(first)
        let sent = ssh.scripts(to: one).count
        let sentThere = ssh.scripts(to: two).count
        clock.pass(1)
        // The other's round, begun at the same moment: its copy of your personalities met.
        try await until { ssh.scripts(to: two).dropFirst(sentThere).contains { $0.contains("box personalities") } }
        #expect(ssh.scripts(to: two).dropFirst(sentThere).contains { $0.contains("box personalities") }, "the one still connected gets its round")
        #expect(Array(ssh.scripts(to: one).dropFirst(sent)) == [], "nothing went to the one disconnected")
    }

    /// Removed while its engine starts over (its Settings › Engine), before it connects again: it
    /// doesn't connect again, and nothing more goes there.
    @Test func removedWhileItsEngineStartsOverItDoesntConnectAgain() async throws {
        defer { done() }
        let id = Self.name()
        let engine = add(id, at: machine)
        await app.connect(engine).value
        // What starting it over sends there, held until it's removed.
        let gate = Gate()
        let sending = Gate()
        defer { gate.open() }
        SSHConnection.standIn = { [ssh] address, script in
            ssh.note(script, to: address)
            if address == id {
                sending.open()
                gate.wait()
            }
            return nil
        }
        let restart = app.restartEngine(engine)
        try await until { sending.isOpen }
        #expect(sending.isOpen, "it began starting over")
        let sent = ssh.scripts(to: id).count
        let asked = machine.asked.count
        app.removeMachine(id)
        gate.open()
        await restart.value
        #expect(!engine.isReady, "it didn't connect again")
        #expect(Array(ssh.scripts(to: id).dropFirst(sent)) == [], "nothing went to it over SSH once it was removed")
        #expect(Array(machine.asked.dropFirst(asked)) == [], "nor to its engine")
        #expect(clock.waits == [], "no syncs run for it")
    }

    // MARK: Helpers

    /// A machine's name no one can reach.
    private static func name() -> String {
        "conn-\(UUID().uuidString.prefix(8).lowercased()).invalid"
    }

    /// Answers as a machine's engine does: a session in a project there, and no integrations or
    /// sign-ins.
    private static func answerAsAMachine(_ engine: StubEngine) {
        engine.list([StubEngine.session("ses_\(UUID().uuidString.prefix(8))", directory: "/home/tests/project")])
        engine.on("GET", "/api/mcp", json: ["location": ["directory": "/"], "data": []])
        engine.on("GET", "/api/credential", json: ["data": []])
    }

    /// A machine that couldn't be set up for your phones and other computers (its SSH failed, say)
    /// says so in Settings › Machines, and stops once it's set up. This Mac's box is the real one.
    @Test func aMachineThatCouldntBeSetUpForYourPhonesSaysSoUntilItIs() async throws {
        defer { done() }
        UserDefaults.standard.set(true, forKey: "phoneLink")
        UserDefaults.standard.set("ws://127.0.0.1:9", forKey: "phoneLink.relay")
        // The app's own link keeps what it set up, and its keys, where the app keeps them: gone after.
        defer {
            for key in ["phoneLink", "phoneLink.relay", "phoneLink.written"] { UserDefaults.standard.removeObject(forKey: key) }
            try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: "phone-link.json"))
            _ = Keychain.delete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: PhoneLink.keychainService])
        }
        let box = try await SettingsBox(port: 47_967, alongside: true)
        defer { box.stop() }
        let id = Self.name()
        let engine = add(id, at: machine)
        let link = app.phoneLink
        let client = box.client
        link.box = { client }
        // It has a machine, as the app says once its engine's up.
        link.hasMachines = { true }
        box.box.host.phoneLink = link
        link.start(endpoint: ServerEndpoint(url: URL(string: box.engine.url)!, password: "test"))
        defer { link.stop() }
        // Its box up, trying the relay nobody answers.
        try await until { if case .failed(let reason) = link.status { reason.contains("relay") } else { false } }
        await app.connect(engine).value
        let why = try #require(link.setupFailed[id], "its SSH answered nothing")
        #expect(why.hasPrefix("Kuvo Code couldn’t set it up for them.") && why.hasSuffix("It tries again when it next connects."), "\(why)")
        // Set Up Again, failing the same way: said so, with what went wrong.
        await link.sync(engine, asked: true)
        let again = try #require(link.setupFailed[id])
        #expect(again.hasPrefix("Set Up Again didn’t work. ") && again.count > "Set Up Again didn’t work. ".count + 3, "\(again)")
        // It answers now: set up.
        SSHConnection.standIn = { [ssh] address, script in
            ssh.note(script, to: address)
            guard script.contains(" setup") else { return "" }
            return #"{"address":"\#(Data(repeating: 7, count: 16).base64URL)","key":"\#(LinkKey().publicBytes.base64URL)","peers":true,"sign":"\#(Documents.origin(of: Documents.SigningKey()))","docs":[]}"#
        }
        // Set Up Again while this Mac's background service isn't up: said so, not nothing.
        link.box = { nil }
        await link.sync(engine, asked: true)
        #expect(link.setupFailed[id]?.contains("background service isn’t running") == true, "\(link.setupFailed[id] ?? "")")
        link.box = { client }
        await link.sync(engine)
        #expect(link.setupFailed[id] == nil)
        // Its SSH fails again, so it says so again, until the machine is removed.
        SSHConnection.standIn = { _, _ in nil }
        await link.sync(engine)
        #expect(link.setupFailed[id] != nil)
        app.removeMachine(id)
        #expect(link.setupFailed[id] == nil)
    }

    /// `id` added, its engine `stub` once it connects.
    private func add(_ id: String, at stub: StubEngine) -> MachineEngine {
        reachable.apis[id] = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: stub.url)!, password: "test"), folderPrefix: RemoteFolder.prefix(for: id))
        let engine = app.machines.add(id)
        app.workspace.machines = Set(app.machines.list.map(\.id))
        return engine
    }

    private func sessions(on id: String) -> [Session] {
        app.workspace.sessions.filter { RemoteFolder.machine(of: $0.location.directory) == id }
    }
}

/// The engines machines' connections reach, by machine.
@MainActor
final class Reachable {
    var apis: [String: OpenCodeAPI] = [:]
}

/// What went to machines over SSH, by the address it went to.
nonisolated final class SSHLog: @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [(address: String, script: String)] = []

    func note(_ script: String, to address: String) {
        lock.withLock { sent.append((address, script)) }
        TestPulse.beat()
    }

    func scripts(to address: String) -> [String] {
        lock.withLock { sent.filter { $0.address == address }.map(\.script) }
    }
}
