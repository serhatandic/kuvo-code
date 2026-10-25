import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Custom Auto's lists are each place's own (Settings › Custom Auto, the place picked at its top):
/// this Mac's coding agents keep theirs and a machine's keep its own, made from the models each
/// has. Saving one place's lists changes nothing of another's. The agents' bridges are stubbed.
@MainActor
@Suite(.serialized) struct CustomAutoPlacesTests {
    /// A bridge's Custom Auto, as it keeps it: the lists it was last given, and how often.
    nonisolated final class Bridge: @unchecked Sendable {
        private let lock = NSLock()
        private var lists: [[String: Any]]
        private(set) var saves = 0
        let url: String

        init(port: Int, name: String) {
            url = "http://127.0.0.1:\(port)"
            lists = [["id": "auto", "name": name, "entries": []]]
            StubWeb.handle(url + "/api/kuvo/auto") { [weak self] request, body in
                guard let self else { return StubWeb.Answer(status: 503) }
                return self.lock.withLock {
                    if request.httpMethod == "PUT", let sent = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["lists"] as? [[String: Any]] {
                        self.lists = sent
                        self.saves += 1
                    }
                    return StubWeb.json(["data": ["entries": [], "lists": self.lists, "limits": []]])
                }
            }
        }

        var names: [String] { lock.withLock { lists.compactMap { $0["name"] as? String } } }
        var saved: Int { lock.withLock { saves } }
        var endpoint: ServerEndpoint { ServerEndpoint(url: URL(string: url)!, password: "test") }
    }

    @Test func eachPlaceKeepsItsOwnLists() async throws {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        defer { StubWeb.stop() }
        let macBridge = Bridge(port: 47981, name: "Mac list")
        let boxBridge = Bridge(port: 47980, name: "Box list")
        let mac = OutsideAgents()
        let box = OutsideAgents(machine: "box")
        mac.connect(macBridge.endpoint, folderPrefix: "")
        box.connect(boxBridge.endpoint, folderPrefix: RemoteFolder.prefix(for: "box"))
        defer {
            mac.disconnect()
            box.disconnect()
        }
        await mac.loadAuto()
        await box.loadAuto()
        #expect(mac.auto.all.map(\.name) == ["Mac list"])
        #expect(box.auto.all.map(\.name) == ["Box list"])

        let sonnet = AutoEntry(ModelRef(id: "sonnet", providerID: "claude-code"))
        try await box.saveAuto([AutoList.Named(id: "auto", name: "Box list", entries: [sonnet]), AutoList.Named(id: "auto-fast", name: "Fast", entries: [])])
        #expect(boxBridge.names == ["Box list", "Fast"])
        #expect(macBridge.saved == 0, "a machine's lists are its own: this Mac's stay as they were")
        #expect(mac.auto.all.map(\.name) == ["Mac list"])

        try await mac.saveAuto([AutoList.Named(id: "auto", name: "Bugfixes", entries: [])])
        #expect(macBridge.names == ["Bugfixes"])
        #expect(boxBridge.saved == 1, "and this Mac's don't go to the machine")
        #expect(box.auto.all.map(\.name) == ["Box list", "Fast"])
    }
}

/// Each computer keeps its own settings (a box of its own): a mode added here, like a security
/// audit, is this Mac's. A machine with no settings yet starts with this Mac's, so it's in that
/// machine's start; one with its own keeps them, and nothing of this Mac's goes in what its engine
/// starts with.
@MainActor
@Suite(.serialized) struct MachineSettingsTests {
    @Test func aModeAddedHereIsThisMacsAndANewMachinesStart() async throws {
        TestEnvironment.prepare()
        // This Mac's box, which keeps its settings.
        let box = try await SettingsBox(port: 47_929)
        defer { box.stop() }
        let app = AppModel()
        let config = app.engineConfig
        #expect((try await app.machineSeed()).settings["agents"]?["security-audit"] == nil)

        config.set(.object(["description": .string("Audits the code for security problems"), "mode": .string("primary"),
                            "prompt": .string("Look for security problems.")]), at: ["agents", "security-audit"])
        let seed = try await app.machineSeed()
        #expect(seed.settings["agents"]?["security-audit"]?["description"]?.string == "Audits the code for security problems", "a new machine starts with it")

        // What a machine's engine starts with carries none of it.
        let launch = await app.machineLaunch(MachineEngine(machine: Machine(destination: "box")))
        #expect(!launch.environment.keys.contains { ["KUVO_SETTINGS", RemoteServer.privateSettingsVariable].contains($0) || $0.hasPrefix("KUVO_KEY_") })
        #expect(!launch.environment.values.contains { $0.contains("security-audit") })
    }
}
