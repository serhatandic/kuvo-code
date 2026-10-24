import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// Settings › Machines from a phone, as this Mac answers it: each machine with where its
/// connection is and the one button the page shows for it, and only that button's action taken;
/// one already here added again is that one; another address stopped being used; two said to be
/// one computer, unless they said they're two; one removed. Nothing here reaches a real machine.
@MainActor
@Suite(.serialized) struct PhoneMachinesTests {
    let app = AppModel()
    let link = PhoneLink()

    init() {
        TestEnvironment.prepare()
        Self.clean()
        app.bots.app = app
        link.bots = app.bots
    }

    private static func clean() {
        for key in ["machines", "machines.waiting", "machines.waitingSince", "projectFolders", "projectSettings", "worktrees"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    private func ask(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> (status: Int, json: [String: Any]) {
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data()
        let request = LinkRequest(method: method, path: path, headers: ["content-type": "application/json"], body: data)
        var status = 0
        var answer = Data()
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:47996/")!, password: nil, agents: nil) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): answer += chunk
            }
        }
        return (status, (try? JSONSerialization.jsonObject(with: answer) as? [String: Any]) ?? [:])
    }

    private func listed() async throws -> [[String: Any]] {
        try #require(try await ask("kuvo/machines").json["machines"] as? [[String: Any]])
    }

    @Test func aPhoneSeesAndTendsThisMacsMachines() async throws {
        defer { Self.clean() }
        for name in ["lokum", "lokum-local", "vps", "hetzner"] { app.machines.add(name) }
        app.machines.addAddress("lokum.tail", to: "lokum")

        let lokum = try #require(try await listed().first)
        #expect(lokum["id"] as? String == "lokum")
        #expect(lokum["otherAddresses"] as? [String] == ["lokum.tail"])
        #expect(lokum["connection"] as? String == "notConnected")
        #expect(lokum["status"] as? String == "Not connected")
        #expect(lokum["action"] as? String == "connect", "Connect, as the page shows")
        let notOffered = try await ask("kuvo/machines/lokum/disconnect", method: "POST")
        #expect(notOffered.status == 409)
        #expect(notOffered.json["message"] as? String == "lokum isn’t connected.")

        // Added again, at its name or another address: that one, not a second machine, and
        // nothing checked over SSH.
        let again = try await ask("kuvo/machines", method: "POST", body: ["destination": " lokum.tail "])
        #expect(again.status == 200)
        #expect(again.json["known"] as? Bool == true)
        #expect((again.json["machine"] as? [String: Any])?["id"] as? String == "lokum")
        #expect(try await ask("kuvo/machines", method: "POST", body: ["destination": "ssh://lokum:2222"]).status == 400)
        #expect(try await ask("kuvo/machines", method: "POST", body: [:]).status == 400)

        // Another address, no longer used; its name isn't one to stop using.
        #expect(try await ask("kuvo/machines/lokum/addresses/lokum.tail", method: "DELETE").status == 200)
        #expect(app.machines.list.first?.addresses == ["lokum"])
        #expect(try await ask("kuvo/machines/lokum/addresses/lokum", method: "DELETE").status == 404)

        // Said to be one computer: one of the other's addresses. Two that told Kuvo Code their
        // own names stay two.
        let same = try await ask("kuvo/machines/lokum-local/same-as", method: "POST", body: ["other": "lokum"])
        #expect(same.status == 200)
        #expect((same.json["machine"] as? [String: Any])?["otherAddresses"] as? [String] == ["lokum-local"])
        #expect(app.machines.engine("lokum-local") == nil)
        app.machines.note("0123456789abcdef0123456789abcdef", of: "vps")
        app.machines.note("fedcba9876543210fedcba9876543210", of: "hetzner")
        let two = try await ask("kuvo/machines/vps/same-as", method: "POST", body: ["other": "hetzner"])
        #expect(two.status == 409)
        #expect((two.json["message"] as? String)?.hasPrefix("vps and hetzner are two computers") == true)
        #expect(try await ask("kuvo/machines/vps/same-as", method: "POST", body: ["other": "vps"]).status == 404)

        // Removed, as Remove… does: off this Mac, left running there (nothing waits to stop it).
        #expect(try await ask("kuvo/machines/hetzner", method: "DELETE").status == 200)
        #expect(app.machines.list.map(\.id) == ["lokum", "vps"])
        #expect(try await ask("kuvo/machines/hetzner/connect", method: "POST").status == 404)
        #expect(Self.waiting("hetzner").isEmpty, "it keeps running there, with its sign-ins and keys")
        // Uninstalled: stopped there and signed out, the next time it answers (a name that never
        // answers: nothing runs on a real computer).
        app.machines.add("gone.invalid")
        #expect(try await ask("kuvo/machines/gone.invalid/uninstall", method: "POST").status == 200)
        #expect(app.machines.list.map(\.id) == ["lokum", "vps"])
        #expect(Self.waiting("gone.invalid").contains { $0.hasPrefix(Machines.removalMark) && $0.contains(Machines.agentsSignOut) })
    }

    /// A machine this Mac only removed stays for your phones, marked as removed here, until a
    /// phone forgets it; one this Mac still has is removed in Settings › Machines instead.
    @Test func aPhoneForgetsAMachineThisMacRemoved() async throws {
        defer { Self.clean() }
        let file = AppInfo.testRoot.appending(path: "PhoneHosts/\(UUID().uuidString).json")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: file) }
        let host = { (name: String) in ["name": name, "address": "AAAAAAAAAAAAAAAAAAAAAA", "key": String(repeating: "k", count: 43)] }
        try JSONSerialization.data(withJSONObject: ["phones": [], "removed": [], "machines": ["gone.invalid": host("Gone"), "box": host("Box")]]).write(to: file)
        app.machines.add("box")
        let kept = PhoneLink(file: file)
        kept.bots = app.bots
        func ask(_ path: String, method: String = "GET") async throws -> (status: Int, json: [String: Any]) {
            var status = 0
            var answer = Data()
            for try await part in PhoneLink.respond(to: LinkRequest(method: method, path: path, headers: [:], body: Data()), link: kept,
                                                    engine: URL(string: "http://127.0.0.1:47996/")!, password: nil, agents: nil) {
                switch part {
                case .head(let code, _): status = code
                case .body(let chunk): answer += chunk
                }
            }
            return (status, (try? JSONSerialization.jsonObject(with: answer) as? [String: Any]) ?? [:])
        }
        let hosts = try #require(try await ask("kuvo/hosts").json["hosts"] as? [[String: Any]])
        #expect(hosts.map { "\($0["machine"] as? String ?? "") \($0["removed"] as? Bool ?? false)" } == ["box false", "gone.invalid true"])
        // On every one, false too: a phone tells a Mac whose Remove leaves machines running by it.
        #expect(hosts.allSatisfy { $0["removed"] is Bool })
        #expect(try await ask("kuvo/hosts/box", method: "DELETE").status == 409)
        #expect(try await ask("kuvo/hosts/gone.invalid", method: "DELETE").status == 200)
        #expect((try await ask("kuvo/hosts").json["hosts"] as? [[String: Any]])?.map { $0["machine"] as? String } == ["box"])
        #expect(try await ask("kuvo/hosts/gone.invalid", method: "DELETE").status == 404)
    }

    /// What waits to run on a machine the next time it answers.
    private static func waiting(_ machine: String) -> [String] {
        (UserDefaults.standard.dictionary(forKey: "machines.waiting") as? [String: [String]])?[machine] ?? []
    }

    /// Its events: a line as the phone starts following, and another whenever what it lists
    /// changes (the stream sends a line each time what it reads changes).
    @Test func itsEventsFollowTheMachines() async throws {
        defer { Self.clean() }
        app.machines.add("box")
        let request = LinkRequest(method: "GET", path: "kuvo/machines/events", headers: [:], body: Data())
        var parts = PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:47996/")!, password: nil, agents: nil).makeAsyncIterator()
        var first: [String: Any]?
        while first == nil, let part = try await parts.next() {
            if case .body(let chunk) = part { first = try JSONSerialization.jsonObject(with: chunk) as? [String: Any] }
        }
        #expect((first?["machines"] as? [[String: Any]])?.map { $0["id"] as? String } == ["box"])

        nonisolated final class Heard: @unchecked Sendable { var changed = false }
        let heard = Heard()
        withObservationTracking { _ = link.machinesJSON() } onChange: { heard.changed = true }
        app.machines.addAddress("box.tail", to: "box")
        #expect(heard.changed, "the stream sends its next line")
        let now = try #require(link.machinesJSON().flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        #expect((now["machines"] as? [[String: Any]])?.first?["otherAddresses"] as? [String] == ["box.tail"])
    }
}
