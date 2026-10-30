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

    /// Removed: the side panel's terminals on it stop (they'd only be SSH sessions to a machine
    /// that's gone from the sidebar), wherever they are; a terminal here goes on.
    @Test func removedItsTerminalsInThePanelStop() async throws {
        defer { done() }
        let id = Self.name()
        _ = add(id, at: machine)
        let panel = app.utilities
        defer { panel.closeAll() }
        let shell = ["SHELL": "/bin/sh"]
        panel.inView = .init(session: "ses_there", place: id)
        panel.newTerminal(in: RemoteFolder.folder("/home/me", on: id), environment: shell)
        panel.inView = .init(session: "ses_here")
        panel.newTerminal(in: FileManager.default.temporaryDirectory.path, environment: shell)

        app.removeMachine(id)
        #expect(panel.tabs.filter { $0.kind == .terminal }.map(\.owner) == ["ses_here"])
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
        #expect(clock.waits == [60, 600], "its wake-ups each minute, its sign-ins every ten")
        await app.reconnectNow(engine)?.value
        try await until { clock.waits == [60, 600] }
        #expect(clock.waits == [60, 600], "one set of syncs, not two")
        // A minute on: one round, then waiting for the next one, still one set.
        clock.pass(60)
        try await until { clock.waits == [60, 600] }
        #expect(clock.waits == [60, 600])
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

    /// A group chat there talking when you disconnect: it shows as last seen, nothing talking (no Stop that can't reach it), as when the connection is lost.
    @Test func disconnectedItsGroupChatsStopShowingTalk() async throws {
        defer { done() }
        let id = Self.name()
        let engine = add(id, at: machine)
        await app.connect(engine).value
        let group: [String: Any] = ["id": "grp_conn000001", "name": "Crew", "members": ["bot_pal"], "seats": [:], "heard": [:], "created": "2026-10-21T09:00:00Z"]
        app.boxGroups.handle(try machine.event("kuvo.group.updated", ["id": "grp_conn000001", "group": group, "status": "active",
                                                                      "state": ["speaking": "bot_pal", "discussing": true, "paused": false]]), machine: id)
        #expect(app.chats.speaking["grp_conn000001"] == "bot_pal")
        app.disconnect(engine)
        #expect(app.chats.speaking["grp_conn000001"] == nil)
        #expect(!app.chats.discussing.contains("grp_conn000001"))
    }

    /// A session's wake-up there, canceled from a phone (straight to the machine) while it's
    /// connected: its mark goes from the sidebar at the next look, not at the next launch.
    @Test func aMachinesWakeUpCanceledThereLeavesTheSidebar() async throws {
        defer { done() }
        let id = Self.name()
        let engine = add(id, at: machine)
        await app.connect(engine).value
        let session = try #require(sessions(on: id).first)
        // Its box answers each route with this: the list of sessions with wake-ups, and the
        // session's own (each read takes what it knows of it).
        let answer = WakesThere()
        SSHConnection.standIn = { [ssh] address, script in
            ssh.note(script, to: address)
            if script.contains(" box route") { return answer.routed }
            return script.contains("timezone") ? "" : nil
        }
        let due = Wakes.name(due: .now.addingTimeInterval(7200), every: nil)
        answer.set(["sessions": [["session": session.id, "next": 1, "watching": false]], "wakes": [["id": due, "note": "Check the deploy"]], "watches": [], "paused": false])
        await app.wakeUps.share(with: engine)
        #expect(app.wakeUps.wakes[session.id]?.map(\.note) == ["Check the deploy"])

        answer.set(["sessions": [], "wakes": [], "watches": [], "paused": false])
        await app.wakeUps.share(with: engine)
        #expect(app.wakeUps.wakes[session.id]?.isEmpty != false)
    }

    /// A machine's sessions with wake-ups, looked at each minute while it's connected: one call
    /// there for all of them, not one more for each session.
    @Test func aMachinesWakeUpsAreReadInOneCall() async throws {
        defer { done() }
        let id = Self.name()
        let engine = add(id, at: machine)
        await app.connect(engine).value
        let session = try #require(sessions(on: id).first)
        let answer = WakesThere()
        SSHConnection.standIn = { [ssh] address, script in
            ssh.note(script, to: address)
            if script.contains(" box route") { return answer.routed }
            return script.contains("timezone") ? "" : nil
        }
        await app.wakeUps.share(with: engine)
        let due = Wakes.name(due: .now.addingTimeInterval(7200), every: nil)
        answer.set(["sessions": [["session": session.id, "next": 1, "watching": false,
                                  "wakes": [["id": due, "due": 1, "note": "Check the deploy"]], "watches": [], "paused": false]]])
        let before = ssh.scripts(to: id).count

        await app.wakeUps.share(with: engine)

        #expect(app.wakeUps.wakes[session.id]?.map(\.note) == ["Check the deploy"])
        #expect(ssh.scripts(to: id).dropFirst(before).filter { $0.contains(" box route") }.count == 1)
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
            for key in ["phoneLink", "phoneLink.relay"] { UserDefaults.standard.removeObject(forKey: key) }
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

    /// A chat on a machine moved into one of its projects that has other folders works in them
    /// there: its rules and what its agent is told name the machine's own paths, never this Mac's
    /// names for them (`ssh://…`), which nothing on the machine matches.
    @Test func aChatMovedIntoAMachinesProjectWorksInItsOtherFoldersThere() async throws {
        defer { done() }
        let id = Self.name()
        let prefix = RemoteFolder.prefix(for: id)
        machine.list([StubEngine.session("ses_mchat", title: "Question", directory: "/home/tests/.kuvo-code/chats")])
        await app.connect(add(id, at: machine)).value
        try await until { app.workspace.session("ses_mchat") != nil }
        app.workspace.saveProject(prefix + "/home/tests/app", settings: Workspace.ProjectSettings(folders: [prefix + "/home/tests/shared"]))
        machine.on("GET", "/api/session/ses_mchat", json: ["data": StubEngine.session("ses_mchat", title: "Question", directory: "/home/tests/app")])
        machine.on("POST", "/api/session/ses_mchat/move", json: [:])
        machine.on("PATCH", "/api/session/ses_mchat", json: ["data": [:]])
        machine.on("PUT", "/api/experimental/session/ses_mchat/instructions/entries/*", json: [:])
        try await app.workspace.move("ses_mchat", toProject: prefix + "/home/tests/app")

        let rules = try #require(machine.requests("PATCH", "/api/session/ses_mchat").last?.body["permissions"] as? [[String: Any]])
        #expect(rules.contains { $0["action"] as? String == "external_directory" && $0["resource"] as? String == "/home/tests/shared/*" })
        #expect(!rules.contains { ($0["resource"] as? String)?.contains("ssh://") == true })
        let told = try #require(machine.requests("PUT", "/api/experimental/session/ses_mchat/instructions/entries/\(ProjectFolders.instructionKey)").last?.body["value"] as? String)
        #expect(told.contains("/home/tests/shared") && !told.contains("ssh://"))
    }

    /// A machine uninstalled while it's still being set up for your phones and other computers
    /// stays gone: the setup finishing after doesn't name it to them again.
    @Test func aMachineUninstalledWhileItsSetUpForYourPhonesStaysGone() async throws {
        defer { done() }
        UserDefaults.standard.set(true, forKey: "phoneLink")
        UserDefaults.standard.set("ws://127.0.0.1:9", forKey: "phoneLink.relay")
        defer {
            for key in ["phoneLink", "phoneLink.relay"] { UserDefaults.standard.removeObject(forKey: key) }
            try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: "phone-link.json"))
            _ = Keychain.delete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: PhoneLink.keychainService])
        }
        let box = try await SettingsBox(port: 47_964, alongside: true)
        defer { box.stop() }
        let id = Self.name()
        let engine = add(id, at: machine)
        let link = app.phoneLink
        let client = box.client
        link.box = { client }
        link.hasMachines = { true }
        box.box.host.phoneLink = link
        link.start(endpoint: ServerEndpoint(url: URL(string: box.engine.url)!, password: "test"))
        defer { link.stop() }
        try await until { if case .failed(let reason) = link.status { reason.contains("relay") } else { false } }
        // Its setup answers once let through, as a slow machine does.
        let held = Gate(), reached = Gate()
        SSHConnection.standIn = { [ssh] address, script in
            ssh.note(script, to: address)
            guard script.contains(" setup") else { return "" }
            reached.open()
            held.wait()
            return #"{"address":"\#(Data(repeating: 7, count: 16).base64URL)","key":"\#(LinkKey().publicBytes.base64URL)","peers":true,"docs":[]}"#
        }
        let connecting = Task { await app.connect(engine).value }
        try await until { reached.isOpen }
        app.removeMachine(id, uninstall: true)
        held.open()
        await connecting.value
        #expect(link.machineHosts[id] == nil, "named to your phones and other computers again")
    }

    /// Disconnected, it stays so when this Mac's engine starts again (after a restart, or a
    /// change to your accounts), until you connect it.
    @Test func disconnectedItStaysSoWhenThisMacsEngineStartsAgain() async throws {
        defer { done() }
        let id = Self.name()
        let engine = add(id, at: machine)
        await app.connect(engine).value
        app.disconnect(engine)
        #expect(!engine.isReady)

        // What this Mac's engine starting again begins for machines.
        for start in app.startMachines() { await start.value }
        #expect(!engine.isReady, "it didn't connect by itself")

        await app.connect(engine).value
        #expect(engine.isReady, "Connect connects it")
    }

    /// Unreachable when it's first connected (the app opened before the network was up): it's
    /// tried again by itself, as a dropped connection is, and connects once it answers.
    @Test func unreachableAtFirstItsTriedAgainByItself() async throws {
        defer { done() }
        let id = Self.name()
        let engine = add(id, at: machine)
        let api = reachable.apis[id]
        reachable.apis[id] = nil
        await app.connect(engine).value
        guard case .failed = engine.state else { Issue.record("it reached a machine that doesn't answer"); return }

        try await until { clock.waits == [3] }
        #expect(clock.waits == [3], "it's tried again in a moment")
        reachable.apis[id] = api
        clock.pass(3)
        try await until { engine.isReady }
        #expect(engine.isReady)
    }

    /// A machine that answers but can't run the engine (an unsupported system; its key refused, a
    /// changed host key) says why at once, with Try Again, rather than "Reconnecting…" for half an
    /// hour while trying again won't change it.
    @Test func aMachineThatCantBeSetUpSaysWhyRatherThanTryingAgain() async throws {
        defer { done() }
        let id = Self.name()
        let engine = add(id, at: machine)
        // Over SSH for real (as far as the stand-in goes), where it answers as nothing the engine
        // runs on.
        MachineEngine.standIn = nil
        SSHConnection.standIn = { [ssh] address, script in
            ssh.note(script, to: address)
            return ""
        }
        await app.connect(engine).value
        guard case .failed(let reason) = engine.state else { Issue.record("it connected"); return }
        #expect(reason.contains("Linux"), "it says what it runs on")
        #expect(!engine.isRetrying, "not tried again: it shows why, with Try Again")
        #expect(clock.waits == [])
    }

    /// One that couldn't be set up for a reason that won't pass by itself is still tried once more
    /// when the Mac wakes: a key in an agent (1Password, Secretive, a YubiKey) is refused while
    /// it's locked, and works once it's unlocked.
    @Test func aMachineThatCouldntBeSetUpIsTriedAgainWhenTheMacWakes() async throws {
        defer { done() }
        let id = Self.name()
        let engine = add(id, at: machine)
        MachineEngine.standIn = nil
        SSHConnection.standIn = { [ssh] address, script in
            ssh.note(script, to: address)
            return ""
        }
        await app.connect(engine).value
        #expect(!engine.isRetrying)

        app.wakeMachines()
        #expect(engine.isRetrying, "tried again")
        try await until { clock.waits == [3] }
        clock.pass(3)
        // Still the same: it says why again, with Try Again, rather than trying on.
        try await until { !engine.isRetrying }
        guard case .failed = engine.state else { Issue.record("it connected"); return }
        #expect(clock.waits == [])
    }

    /// Uninstalled, its sign-outs went but its engine wouldn't stop (the connection dropped just
    /// then): what's tried there next stops it, rather than only tidying away how it starts again,
    /// which would leave it running with nothing to ever stop it.
    @Test func uninstalledWhenItsEngineWouldntStopItsStoppedNextTime() async throws {
        defer { done() }
        let id = Self.name()
        let engine = add(id, at: machine)
        await app.connect(engine).value
        #expect(engine.isReady)
        // The sign-outs go; then it's away: the stop, and what's tried after, don't reach it.
        let stop = String(RemoteServer.stopCommand.dropFirst(2).dropLast(2))
        let removal = Machines.removalMark
        SSHConnection.standIn = { [ssh] address, script in
            ssh.note(script, to: address)
            return script == stop || script.hasPrefix(removal) ? nil : ""
        }
        app.removeMachine(id, uninstall: true)
        await app.machines.waitForRemoval(of: id)
        // How it starts again isn't tidied away before it's stopped: what's tried there first, and
        // waits for it, stops it.
        try await until { ssh.scripts(to: id).contains { $0.hasPrefix(removal) } }
        let tried = ssh.scripts(to: id).filter { $0.hasPrefix(removal) }
        #expect(tried.first?.contains(RemoteServer.stopCommand) == true, "what waits for it stops its engine first")
    }

    /// A new session in a machine's project that has other folders works in them there from its
    /// start: its rules and what its agent is told name the machine's own paths.
    @Test func aNewSessionInAMachinesProjectWorksInItsOtherFoldersThere() async throws {
        defer { done() }
        let id = Self.name()
        let prefix = RemoteFolder.prefix(for: id)
        await app.connect(add(id, at: machine)).value
        app.workspace.saveProject(prefix + "/home/tests/app", settings: Workspace.ProjectSettings(folders: [prefix + "/home/tests/shared"]))
        machine.on("POST", "/api/session", json: ["data": StubEngine.session("ses_mnew", title: "New", directory: "/home/tests/app")])
        machine.on("PUT", "/api/experimental/session/ses_mnew/instructions/entries/*", json: [:])
        _ = try await app.workspace.createSession(in: prefix + "/home/tests/app", model: nil, agent: nil)

        let rules = try #require(machine.requests("POST", "/api/session").last?.body["permissions"] as? [[String: Any]])
        #expect(rules.contains { $0["action"] as? String == "external_directory" && $0["resource"] as? String == "/home/tests/shared/*" })
        #expect(!rules.contains { ($0["resource"] as? String)?.contains("ssh://") == true })
        let told = try #require(machine.requests("PUT", "/api/experimental/session/ses_mnew/instructions/entries/\(ProjectFolders.instructionKey)").last?.body["value"] as? String)
        #expect(told.contains("/home/tests/shared") && !told.contains("ssh://"))
    }

    /// A machine's session carried on with a coding agent there, in a project with other folders:
    /// its agent is told the machine's own paths for them.
    @Test func aMachinesSessionCarriedOnWithACodingAgentWorksInItsOtherFoldersThere() async throws {
        defer { done() }
        let id = Self.name()
        let prefix = RemoteFolder.prefix(for: id)
        let bridge = StubEngine(port: 47943, alongside: true)
        defer { bridge.stop() }
        let session = StubEngine.session("ses_mcarry", title: "Release", directory: "/home/tests/app")
        machine.list([session])
        machine.on("GET", "/api/session/ses_mcarry", json: ["data": session])
        machine.conversation("ses_mcarry", [["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Ship it"]])
        machine.on("GET", "/api/session/ses_mcarry/inbox", json: ["data": []])
        machine.on("PATCH", "/api/session/ses_mcarry", json: [:])
        bridge.on("POST", "/api/session/import", json: ["data": StubEngine.session("ses_mcarried", title: "Release", directory: "/home/tests/app")])
        bridge.on("PUT", "/api/experimental/session/ses_mcarried/instructions/entries/*", json: [:])
        let engine = add(id, at: machine)
        engine.agents.connect(bridge.api.client.endpoint, folderPrefix: prefix)
        defer { engine.agents.disconnect() }
        await app.connect(engine).value
        try await until { app.workspace.session("ses_mcarry") != nil }
        app.workspace.saveProject(prefix + "/home/tests/app", settings: Workspace.ProjectSettings(folders: [prefix + "/home/tests/shared"]))
        _ = try await app.workspace.carryToAgents("ses_mcarry", model: ModelRef(id: "sonnet", providerID: "claude-code"))

        let told = try #require(bridge.requests("PUT", "/api/experimental/session/ses_mcarried/instructions/entries/\(ProjectFolders.instructionKey)").last?.body["value"] as? String)
        #expect(told.contains("/home/tests/shared") && !told.contains("ssh://"))
    }

    /// A machine's session waiting on you keeps counting while the machine is away and this Mac's
    /// own engine is read again (the Mac waking up): it isn't dropped, to be told again as news once
    /// the machine is back.
    @Test func whatAMachinesSessionAsksStaysWhileTheMachineIsAway() async throws {
        defer { done() }
        let id = Self.name()
        let asked: [String: Any] = ["id": "per_push", "sessionID": "ses_masks", "action": "shell", "resources": ["git push"]]
        machine.list([StubEngine.session("ses_masks", title: "Release", directory: "/home/tests/project")], running: ["ses_masks"])
        machine.on("GET", "/api/session/ses_masks/permission", json: ["data": [asked]])
        machine.on("GET", "/api/session/ses_masks/form", json: ["data": []])
        await app.connect(add(id, at: machine)).value
        try await until { app.workspace.waitingCount == 1 }
        app.workspace.forget(id)
        await app.workspace.resync()
        #expect(app.workspace.waitingCount == 1)
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

/// What a machine's box answers its routes, as `kuvo-link.js box route` prints it.
nonisolated final class WakesThere: @unchecked Sendable {
    private let lock = NSLock()
    private var body = "{}"

    func set(_ json: [String: Any]) {
        let text = String(decoding: try! JSONSerialization.data(withJSONObject: json), as: UTF8.self)
        lock.withLock { body = text }
    }

    var routed: String {
        lock.withLock { String(decoding: try! JSONSerialization.data(withJSONObject: ["status": 200, "body": body]), as: UTF8.self) }
    }
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
