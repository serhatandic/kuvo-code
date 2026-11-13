import ClientDesign
import CryptoKit
import Foundation
import KuvoLink
import OpenCodeKit
import Security
import Testing
@testable import KuvoCode

/// This Mac's box, moved into a home of its own (#333 piece 6a, `movesOwnBox`): its keys are its
/// helper's copies then, which the app never reads, and never makes anew (a key made by the app would
/// be another Mac to every phone and machine), not even while a move of it is under way. What the
/// app did with them, its box does for it, asked as Kuvo Code on this Mac over the box's own server;
/// and what the app kept beside the box for it (your machines' list) goes in the box's home. The box
/// is a stand-in answering where `run/serve.json` says, as its server does (its own side: the
/// bridge's own-home-mac-keys.test.js); the Keychain is the tests' own, in memory.
@MainActor
@Suite(.serialized) struct OwnBoxKeysTests {
    let home = AppInfo.testRoot.appending(path: "own-box-keys-\(UUID().uuidString)")
    let service = "run.kuvo.code.tests.phone-link.\(UUID().uuidString)"
    let file = AppInfo.testRoot.appending(path: "phone-link-\(UUID().uuidString).json")

    init() {
        TestEnvironment.prepare()
        AppModel.hereHome = home
    }

    /// The box's home, as the app finds it.
    private var box: URL { get throws { try #require(OwnBoxHome.folder) } }

    private func write(_ text: String, at path: String) throws {
        let file = try box.appending(path: path)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
    }

    /// This Mac's box moved there: it says so (`box/kind`), and the app has the move turned on.
    private func moved() throws {
        try write("mac\n", at: "box/kind")
        AppModel.movesOwnBox = true
    }

    private func done() {
        AppModel.movesOwnBox = false
        AppModel.hereHome = AppModel.defaultHereHome
        Keychain.lockForTests(service, false)
        Keychain.delete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service])
        try? FileManager.default.removeItem(at: home)
        try? FileManager.default.removeItem(at: file)
    }

    private func items() -> Int {
        var found: CFTypeRef?
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecMatchLimit as String: kSecMatchLimitAll, kSecReturnAttributes as String: true]
        return Keychain.copyMatching(query, &found) == errSecSuccess ? (found as? [Any])?.count ?? 0 : 0
    }

    /// The keys missing from your Keychain while they're this Mac's box's (moved, or a move of it
    /// under way or left part way, whether or not the app uses that box yet): none is made, and the
    /// link says it has none, rather than be another Mac.
    @Test func aMissingKeyIsNeverMadeWhileTheBoxHoldsThem() async throws {
        defer { done() }
        for (path, text) in [("updates/rehome/keychain.json", #"{"v":1,"state":"settled","app":"a","helper":"h","items":[]}"#),
                             ("updates/rehome/journal.json", #"{"step":"clear"}"#),
                             ("box/kind", "mac\n")] {
            try write(text, at: path)
            let link = PhoneLink(file: file, keychain: service)
            link.hasMachines = { true }
            #expect(link.macKey == nil, "\(path)")
            #expect(await link.boxIdentity() == nil, "\(path)")
            #expect(link.vaultProof(machine: "mini.local") == nil, "\(path)")
            #expect(items() == 0, "none made: \(path)")
            try FileManager.default.removeItem(at: box.appending(path: path))
        }
        // A move that finished going back leaves its journal done: the keys are the app's again.
        try write(#"{"step":"done"}"#, at: "updates/rehome/journal.json")
        let link = PhoneLink(file: file, keychain: service)
        link.hasMachines = { true }
        #expect(link.macKey != nil)
        #expect(items() == 3)
    }

    /// Once the box has moved, the app reads none of its keys (a locked Keychain would ask): this Mac's
    /// key is the one its box says, and it signs nothing itself.
    @Test func onceMovedTheAppReadsNoneOfTheBoxsKeys() async throws {
        defer { done() }
        // The keys as the app made them before the move.
        let before = PhoneLink(file: file, keychain: service)
        before.hasMachines = { true }
        #expect(await before.boxIdentity() != nil)
        #expect(items() == 3)

        try moved()
        Keychain.lockForTests(service, true)
        let link = PhoneLink(file: file, keychain: service)
        link.hasMachines = { true }
        link.boxKey = { "the-boxs-own-key" }
        #expect(link.macKey == "the-boxs-own-key")
        #expect(link.vaultProof(machine: "mini.local") == nil)
        #expect(link.vaultRequestProof(machine: "mini.local", method: "GET", path: "kuvo/vault", body: Data()) == nil)
        #expect(await link.boxIdentity() == nil)
        #expect(Keychain.promptsForTests(service) == 0, "never read")
        Keychain.lockForTests(service, false)
        #expect(items() == 3, "and none made")
    }

    /// A machine's vault takes this Mac's proof: once the box has moved, the box signs it, asked as Kuvo
    /// Code on this Mac (its server's password, `x-kuvo-from: app`); a request's proof covers that
    /// request's body. And a request to that box's own vault needs none: the app is its own client.
    @Test func aMachinesVaultProofIsTheBoxsOnceMoved() async throws {
        defer { done() }
        try moved()
        let standIn = try await StandInBox.start(at: box) { request in
            guard request.method == "POST", request.path == "/kuvo/box/proof" else { return HTTPResponse(status: 404) }
            let asked = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: String] ?? [:]
            return .json(["mac": "mac-key", "at": 1_000, "nonce": "nonce-of-its-own", "proof": "signed:" + asked.keys.sorted().map { "\($0)=\(asked[$0]!)" }.joined(separator: ",")])
        }
        defer { standIn.stop() }
        let app = AppModel()
        let proof = try #require(await app.vaultProof(machine: "mini.local"))
        #expect(proof["proof"] as? String == "signed:machine=mini.local")
        #expect(proof["mac"] as? String == "mac-key")

        let body = Data(#"{"paused":true}"#.utf8)
        let hash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        let header = try #require(await app.vaultRequestProof(machine: "mini.local", method: "post", path: "kuvo/vault/pause", body: body))
        let sent = try #require(Data(base64URL: header).flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        #expect(sent["proof"] as? String == "signed:hash=\(hash),machine=mini.local,method=POST,path=kuvo/vault/pause")
        #expect(sent["nonce"] as? String == "nonce-of-its-own")
        #expect(standIn.asked.allSatisfy { $0.fromApp }, "as Kuvo Code on this Mac")
        #expect(!BoxClient.needsVaultProof(SSHConnection.thisMac))
        #expect(items() == 0, "no key of the app's made or read")
    }

    /// Keys an earlier Kuvo Code kept for a machine's bot go to that machine as it connects: once the
    /// box has moved, from the box, which takes them away once the machine has them.
    @Test func keysKeptForAMachinesBotComeFromTheBoxOnceMoved() async throws {
        defer { done() }
        try moved()
        let app = AppModel()
        app.bots.app = app
        let look = BotLook(color: .sky, shape: .round, face: .happy)
        app.bots.take([ListedBot(id: "bot_scout00001", session: "ses_scout", name: "bot_scout00001", look: look, folder: "/home/me/.kuvo-code/bots/bot_scout00001")], from: "box")
        let service = try #require(BotKeys.services.first { Integrations.keys(of: $0.way).count == 1 })
        let name = try #require(Integrations.keys(of: service.way).first?.name)
        let variable = IntegrationKeys.variable(service.id, name, bot: "bot_scout00001")
        let standIn = try await StandInBox.start(at: box) { request in
            guard request.path == "/kuvo/box/kept-keys?bot=bot_scout00001" else { return HTTPResponse(status: 404) }
            return request.method == "GET" ? .json(["keys": [variable: "tok_scout"]]) : .json([:])
        }
        defer { standIn.stop() }

        nonisolated final class Asked: @unchecked Sendable { var puts: [(path: String, body: [String: Any]?)] = [] }
        let asked = Asked()
        await BotKeys.handOver(on: "box", app: app) { method, path, body in
            asked.puts.append((path, body))
            return (200, Data("{}".utf8))
        }
        #expect(asked.puts.map(\.path) == ["kuvo/bots/bot_scout00001/keys/\(service.id)"])
        #expect((asked.puts.first?.body?["keys"] as? [String: String]) == [name: "tok_scout"])
        let deleted = try #require(standIn.asked.first { $0.method == "DELETE" })
        #expect((try JSONSerialization.jsonObject(with: deleted.body) as? [String: [String]]) == ["names": [variable]], "gone from the box once the machine has it")
        #expect(standIn.asked.allSatisfy { $0.fromApp })
    }

    /// Your machines' list is the app's to write and the box's to read: once the box has moved, in its
    /// home, where it reads it, and nothing in the app's own folder.
    @Test func theMachinesListIsKeptInTheBoxsHomeOnceMoved() throws {
        defer { done() }
        try moved()
        let machines = Machines()
        _ = machines.add("mini.test")
        let kept = try box.appending(path: "machines.json")
        let list = try JSONSerialization.jsonObject(with: Data(contentsOf: kept)) as? [[String: Any]]
        #expect(list?.map { $0["destination"] as? String } == ["mini.test"])
        #expect(!FileManager.default.fileExists(atPath: AppInfo.supportDirectory.appending(path: "box/machines.json").path))
        #expect(Machines().list.map(\.id).contains("mini.test"), "read back from there")
        machines.remove("mini.test", uninstall: false)
    }
}

/// This Mac's box's own server, as the app reaches it once the box has moved: on this Mac, where
/// `run/serve.json` says, to its password. What it was asked, and whether as Kuvo Code on this Mac.
@MainActor
private final class StandInBox {
    struct Asked { var method: String; var path: String; var body: Data; var fromApp: Bool }
    private(set) var asked: [Asked] = []
    private var server: LoopbackServer?

    static func start(at box: URL, answer: @escaping (HTTPRequest) -> HTTPResponse) async throws -> StandInBox {
        let stand = StandInBox()
        let password = "serve-password-\(UUID().uuidString)"
        let expected = "Basic " + Data("opencode:\(password)".utf8).base64EncodedString()
        let server = LoopbackServer { [weak stand] request in
            guard request.headers["authorization"] == expected else { return HTTPResponse(status: 401) }
            stand?.asked.append(Asked(method: request.method, path: request.path, body: request.body, fromApp: request.headers["x-kuvo-from"] == "app"))
            return answer(request)
        }
        stand.server = server
        let port = try await server.start()
        let record = box.appending(path: "run/serve.json")
        try FileManager.default.createDirectory(at: record.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["pid": 1, "port": Int(port), "password": password, "kept": false]).write(to: record)
        return stand
    }

    func stop() { server?.stop() }
}
