import ClientDesign
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// One computer reached at two addresses (its name on the local network and over Tailscale) is
/// one machine: whichever is added later, or found to be the same once both connect, becomes one
/// of the other's addresses. Nothing there is signed out or stopped (that machine's engine is the
/// other's), and what was kept under its name (projects, their settings, bots) is the other's.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct MachineAddressesTests {
    init() {
        TestEnvironment.prepare()
        Self.clean()
    }

    private static func clean() {
        for key in ["machines", "machines.unsaved", "machines.waiting", "machines.waitingSince", "projectFolders", "projectSettings", "worktrees"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
        try? FileManager.default.removeItem(at: Machines.file)
    }

    private func machines(_ names: String...) -> Machines {
        let machines = Machines()
        for name in names { machines.add(name) }
        return machines
    }

    @Test(arguments: [false, true])
    func theSameComputerAtTwoAddressesIsOneMachine(laterFirst: Bool) {
        defer { Self.clean() }
        let machines = machines("devbox-tailscale", "hetzner", "devbox-local")
        var folded: [(String, String)] = []
        machines.onFolded = { folded.append(($0, $1)) }
        let identity = "0123456789abcdef0123456789abcdef"
        machines.note("fedcba9876543210fedcba9876543210", of: "hetzner")
        if laterFirst {
            machines.note(identity, of: "devbox-local")
            machines.note(identity, of: "devbox-tailscale")
        } else {
            machines.note(identity, of: "devbox-tailscale")
            machines.note(identity, of: "devbox-local")
        }
        #expect(machines.list.map(\.id) == ["devbox-tailscale", "hetzner"], "the one added first stays")
        #expect(machines.list.first?.addresses == ["devbox-tailscale", "devbox-local"])
        #expect(machines.engine("devbox-local") == nil)
        #expect(folded.map(\.0) == ["devbox-local"] && folded.map(\.1) == ["devbox-tailscale"])
        #expect(machines.folded?.address == "devbox-local")
        // Nothing waits to sign it out or stop it there.
        let waiting = UserDefaults.standard.dictionary(forKey: "machines.waiting") as? [String: [String]] ?? [:]
        #expect(!waiting.values.joined().contains { $0.hasPrefix(Machines.removalMark) })

        // Kept as one after a relaunch.
        let again = Machines()
        #expect(again.list.map(\.id) == ["devbox-tailscale", "hetzner"])
        #expect(again.list.first?.otherAddresses == ["devbox-local"])
        #expect(again.list.first?.identity == identity)
    }

    /// A machine already here, added at another address: one of its addresses, not a second
    /// machine; added again, nothing changes; forgotten, the machine stays.
    @Test func anAddressAddedAndForgotten() {
        defer { Self.clean() }
        let machines = machines("devbox-tailscale")
        machines.note("0123456789abcdef0123456789abcdef", of: "devbox-tailscale")
        #expect(machines.machine(calling: "0123456789abcdef0123456789abcdef")?.id == "devbox-tailscale")
        machines.addAddress("devbox-local", to: "devbox-tailscale")
        machines.addAddress("devbox-local", to: "devbox-tailscale")
        #expect(machines.list.map(\.addresses) == [["devbox-tailscale", "devbox-local"]])
        #expect(machines.engine("devbox-tailscale")?.machine.addresses == ["devbox-tailscale", "devbox-local"])
        machines.removeAddress("devbox-local", from: "devbox-tailscale")
        #expect(machines.list.map(\.addresses) == [["devbox-tailscale"]])
    }

    /// Two different computers stay two machines.
    @Test func differentComputersStayApart() {
        defer { Self.clean() }
        let machines = machines("box", "vps")
        machines.note("0123456789abcdef0123456789abcdef", of: "box")
        machines.note("fedcba9876543210fedcba9876543210", of: "vps")
        #expect(machines.list.map(\.id) == ["box", "vps"])
        #expect(machines.list.allSatisfy { $0.otherAddresses == nil })
    }

    /// What was kept under the later name is the other's: its projects (and their other
    /// folders), and its bots, which live on the same computer.
    @Test func whatWasKeptUnderItsNameMovesOver() throws {
        defer { Self.clean() }
        let workspace = Workspace()
        let web = RemoteFolder.folder("/srv/web", on: "devbox-local")
        workspace.addFolder(web)
        workspace.addFolder(RemoteFolder.folder("/srv/api", on: "devbox-tailscale"))
        workspace.saveProject(web, settings: Workspace.ProjectSettings(name: "Website", folders: [RemoteFolder.folder("/srv/shared", on: "devbox-local")], run: "npm run dev"))

        workspace.fold("devbox-local", into: "devbox-tailscale")
        let moved = RemoteFolder.folder("/srv/web", on: "devbox-tailscale")
        #expect(workspace.folders.contains(moved))
        #expect(!workspace.folders.contains(web))
        #expect(workspace.settings[moved]?.name == "Website")
        #expect(workspace.settings[moved]?.folders == [RemoteFolder.folder("/srv/shared", on: "devbox-tailscale")])
        #expect(workspace.settings[web] == nil)
    }

    /// Both listed the same sessions (one engine, reached twice, kept apart by name): once one is
    /// the other's address they're listed once, under the other's name, and one at work stays at
    /// work. A project added under both names keeps the other's settings.
    @Test func itsSessionsStayListedOnceAtWork() async throws {
        defer {
            Self.clean()
            SessionCopies.removeSessions(of: "devbox-local")
            SessionCopies.removeSessions(of: "devbox-tailscale")
        }
        func session(on machine: String) throws -> Session {
            let json = StubEngine.session("ses_build", title: "Build", directory: RemoteFolder.folder("/srv/web", on: machine))
            return try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: json))
        }
        SessionCopies.saveSessions([try session(on: "devbox-local")], of: "devbox-local")
        SessionCopies.saveSessions([try session(on: "devbox-tailscale")], of: "devbox-tailscale")
        await SessionCopies.written()
        let workspace = Workspace()
        workspace.machines = ["devbox-local", "devbox-tailscale"]
        #expect(workspace.sessions.filter { $0.id == "ses_build" }.count == 2)
        let started = try ServerEvent(json: JSONSerialization.data(withJSONObject: [
            "id": "evt_1", "type": "session.execution.started", "created": 1, "data": ["sessionID": "ses_build"],
        ]))
        workspace.handle(started)
        #expect(workspace.running.contains("ses_build"))
        let web = RemoteFolder.folder("/srv/web", on: "devbox-tailscale")
        workspace.saveProject(RemoteFolder.folder("/srv/web", on: "devbox-local"), settings: Workspace.ProjectSettings(name: "Old name", run: "make"))
        workspace.saveProject(web, settings: Workspace.ProjectSettings(name: "Website", run: "npm run dev"))

        workspace.fold("devbox-local", into: "devbox-tailscale")
        #expect(workspace.sessions.filter { $0.id == "ses_build" }.map(\.location.directory) == [web], "listed once, under the other's name")
        #expect(workspace.running.contains("ses_build"), "still at work")
        #expect(workspace.settings[web]?.name == "Website")
        #expect(workspace.settings[web]?.run == "npm run dev")
    }

    /// The first time a computer is asked what it calls itself, by two connections at once (two
    /// addresses of it connecting together as Kuvo Code opens): both hear the same name, so they're
    /// known to be one computer. Run here with a shell, as on the machine.
    @Test func askedTwiceAtOnceItGivesOneName() async throws {
        let home = AppInfo.testRoot.appending(path: "IdentityHome-\(UUID().uuidString.prefix(6))")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        for _ in 0..<5 {
            try? FileManager.default.removeItem(at: home.appending(path: RemoteEngineInstaller.root))
            let names = await withTaskGroup(of: String.self) { group in
                for _ in 0..<8 {
                    group.addTask {
                        let shell = Process()
                        shell.executableURL = URL(filePath: "/bin/sh")
                        shell.arguments = ["-c", Machine.identityScript]
                        shell.environment = ["HOME": home.path(percentEncoded: false), "PATH": "/usr/bin:/bin"]
                        let output = Pipe()
                        shell.standardOutput = output
                        try? shell.run()
                        let data = output.fileHandleForReading.readDataToEndOfFile()
                        shell.waitUntilExit()
                        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                }
                var names = Set<String>()
                for await name in group { names.insert(name) }
                return names
            }
            #expect(names.count == 1, "one name, whoever asked first: \(names)")
            #expect(names.first?.count == 32)
            let left = try FileManager.default.contentsOfDirectory(atPath: home.appending(path: RemoteEngineInstaller.root).path(percentEncoded: false))
            #expect(left == ["machine-id"], "nothing else left there")
        }
    }

    /// You say one is the other at another address (one of them can't be reached to tell): one
    /// machine. Two that have said they're different computers stay two.
    @Test func youSayTheyreTheSameComputer() {
        defer { Self.clean() }
        let machines = machines("devbox-tailscale", "devbox-local", "vps")
        machines.note("0123456789abcdef0123456789abcdef", of: "devbox-local")
        #expect(machines.sameComputer("devbox-local", as: "devbox-tailscale"))
        #expect(machines.list.map(\.id) == ["devbox-tailscale", "vps"])
        #expect(machines.list.first?.addresses == ["devbox-tailscale", "devbox-local"])
        #expect(machines.list.first?.identity == "0123456789abcdef0123456789abcdef")
        machines.note("fedcba9876543210fedcba9876543210", of: "vps")
        #expect(!machines.sameComputer("vps", as: "devbox-tailscale"))
        #expect(machines.list.map(\.id) == ["devbox-tailscale", "vps"])
    }
}
