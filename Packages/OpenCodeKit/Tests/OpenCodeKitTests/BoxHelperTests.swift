import CryptoKit
import Foundation
import Security
import Testing
@testable import OpenCodeKit

/// Kuvo Code Box, the helper a Mac's box runs under in a home of its own (#333 piece 4), as it's
/// built (`scripts/build-box-helper.sh`, signed ad hoc under the tests' own bundle IDs,
/// `run.kuvo.code.trial4` and `.box`) and run, in folders of the test's own:
/// - the Keychain's move: the app's items copied for the helper alone, taken away again when the
///   move goes back, the originals gone only once the copies are there, and back again;
/// - the helper keeping a box: its keeper and server started under it with the vault's secrets on
///   stdin, its host interface, keys it never makes again, the box turned off, a second one, and a
///   bundle changed since it was signed;
/// - opening it from the app.
///
/// Every Keychain call goes to a keychain file the test makes (`security create-keychain`, never
/// added to your search list) and deletes; nothing reads your login keychain, and nothing here can
/// ask you anything (`HostKeychain.neverAsk`). The box's keeper (`kuvo-start`) and `open` are
/// stand-ins; launchd is never asked.
@Suite(.serialized, AccountUntouched()) struct BoxHelperTests {
    static let app = "run.kuvo.code.trial4"
    static let helperID = "run.kuvo.code.trial4.box"
    let folder: URL
    /// The test's HOME, and the box's home in it.
    let home: URL
    var box: URL { home.appending(path: RemoteEngineInstaller.root) }
    var run: URL { box.appending(path: "run") }
    let keychainFile: URL
    let keychain: HostKeychain
    /// The app the test makes, with the helper built into it.
    let appBundle: URL
    var helperInApp: URL { BoxHelperBundle.bundled(in: appBundle) }

    init() throws {
        HostKeychain.neverAsk()
        folder = FileManager.default.temporaryDirectory.appending(path: "kuvo-trial4-helper-\(UUID().uuidString)").resolvingSymlinksInPath()
        home = folder.appending(path: "home")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        keychainFile = folder.appending(path: "trial4.keychain-db")
        let made = try Self.ran("/usr/bin/security", ["create-keychain", "-p", "trial4", keychainFile.path])
        guard made.status == 0 else { throw CocoaError(.fileWriteUnknown, userInfo: [NSLocalizedDescriptionKey: "security create-keychain: \(made.errors)"]) }
        keychain = HostKeychain(testFile: keychainFile.path, password: "trial4")
        appBundle = folder.appending(path: "Kuvo Code.app")
        try Self.makeApp(appBundle, helper: try Self.builtHelper())
        try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true)
    }

    private func cleanUp(_ started: [Kept] = []) {
        for kept in started where kept.ended.value == nil {
            kept.process.terminate()
            until { kept.ended.value != nil }
        }
        // What a helper started (the stand-ins), by their numbers.
        for record in ["box.pid", "serve.pid"] {
            let file = record == "box.pid" ? run.appending(path: record) : home.appending(path: record)
            if let pid = Int32(text(file).trimmingCharacters(in: .whitespacesAndNewlines)), pid > 1 { kill(pid, SIGKILL) }
        }
        _ = try? Self.ran("/usr/bin/security", ["delete-keychain", keychainFile.path])
        try? FileManager.default.removeItem(at: folder)
    }

    // MARK: Making it

    /// The repository, from this file's place.
    static var repository: URL {
        URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    /// `KuvoCodeBox`, built beside this test's bundle.
    static func builtHelper() throws -> URL {
        var folder = Bundle.module.bundleURL.deletingLastPathComponent()
        while folder.path != "/" {
            let program = folder.appending(path: "KuvoCodeBox")
            if FileManager.default.isExecutableFile(atPath: program.path) { return program }
            folder = folder.deletingLastPathComponent()
        }
        throw CocoaError(.fileNoSuchFile)
    }

    /// A Kuvo Code of the test's own (its bundle ID `app`, signed ad hoc), with the helper built
    /// into it by the release's own script.
    static func makeApp(_ app: URL, helper: URL) throws {
        let contents = app.appending(path: "Contents")
        try FileManager.default.createDirectory(at: contents.appending(path: "MacOS"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: contents.appending(path: "Resources"), withIntermediateDirectories: true)
        let info: [String: Any] = [
            "CFBundleIdentifier": Self.app, "CFBundleName": "Kuvo Code", "CFBundleExecutable": "Kuvo Code", "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "0.0.4", "CFBundleVersion": "4", "LSMinimumSystemVersion": "26.0",
            "NSCalendarsFullAccessUsageDescription": "The agent reads your calendar when you've turned it on.",
        ]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appending(path: "Info.plist"))
        try Data("icon".utf8).write(to: contents.appending(path: "Resources/AppIcon.icns"))
        try FileManager.default.copyItem(at: helper, to: contents.appending(path: "MacOS/Kuvo Code"))
        let built = try ran(repository.appending(path: "scripts/build-box-helper.sh").path, [app.path], environment: ["HELPER_EXECUTABLE": helper.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"])
        guard built.status == 0 else { throw CocoaError(.fileWriteUnknown, userInfo: [NSLocalizedDescriptionKey: "build-box-helper.sh: \(built.errors)"]) }
        let signed = try ran("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", Self.app, app.path])
        guard signed.status == 0 else { throw CocoaError(.fileWriteUnknown, userInfo: [NSLocalizedDescriptionKey: "codesign: \(signed.errors)"]) }
    }

    struct Ran {
        var status: Int32
        var output: String
        var errors: String
    }

    @discardableResult
    static func ran(_ program: String, _ arguments: [String], environment: [String: String]? = nil) throws -> Ran {
        let process = Process()
        process.executableURL = URL(filePath: program)
        process.arguments = arguments
        if let environment { process.environment = environment }
        let output = Pipe(), errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        process.standardInput = FileHandle.nullDevice
        // (Its end told by its handler: `waitUntilExit` can wait for good in an async test.)
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        try process.run()
        let out = output.fileHandleForReading.readDataToEndOfFile(), err = errors.fileHandleForReading.readDataToEndOfFile()
        done.wait()
        return Ran(status: process.terminationStatus, output: String(decoding: out, as: UTF8.self), errors: String(decoding: err, as: UTF8.self))
    }

    /// The helper's own arguments for this test: its box, and the test's keychain.
    private var own: [String] { ["--home", box.path, "--test-keychain", keychainFile.path, "--test-keychain-password", "trial4"] }

    /// One run of the helper `bundle` (the app's, unless said), as the app's keeper or the move
    /// runs it, to its end.
    private func helper(_ arguments: [String], bundle: URL? = nil) throws -> Ran {
        try Self.ran(BoxHelperBundle.executable(of: bundle ?? helperInApp).path, arguments + own, environment: ["HOME": home.path, "PATH": "/usr/bin:/bin"])
    }

    private var move: KeychainMove { KeychainMove(keychain: keychain, home: box, app: Self.app, helper: Self.helperID) }

    private func text(_ file: URL) -> String { (try? String(contentsOf: file, encoding: .utf8)) ?? "" }

    private func write(_ file: URL, _ text: String, executable: Bool = false) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
        if executable { try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path) }
    }

    /// `condition`, looked at until it holds (a minute at most, for a slow machine).
    private func until(_ condition: () -> Bool) {
        let end = Date().addingTimeInterval(60)
        while !condition(), Date() < end { usleep(20_000) }
    }

    // MARK: The Keychain's move

    /// What the app keeps today, as it makes them: its link's keys, an integration's key, a vault
    /// item and the vault's file key, each trusting the app (here, this test's process).
    static let linkKey = Curve25519.KeyAgreement.PrivateKey().rawRepresentation
    static let relaySecret = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    static let signingKey = Curve25519.Signing.PrivateKey().rawRepresentation

    private func addOriginals() {
        for (account, value) in [("key", Self.linkKey), ("secret", Self.relaySecret), ("sign", Self.signingKey)] {
            #expect(keychain.add("\(Self.app).phone-link", account, value, label: "Kuvo Code phone link") == errSecSuccess)
        }
        let items: [(String, String, String)] = [
            ("integrations", "KUVO_KEY_GITHUB_TOKEN", "ghp_trial4"), ("vault", "v_abcdefghij", #"{"password":"hunter2"}"#),
            ("vault", "files", #"{"key":"filekey","generations":{}}"#),
        ]
        for (service, account, value) in items {
            #expect(keychain.add("\(Self.app).\(service)", account, Data(value.utf8), label: "Kuvo Code \(service)") == errSecSuccess)
        }
    }

    private func isRefused(_ read: HostKeychain.Read) -> Bool {
        if case .refused = read { return true }
        return false
    }

    @Test func theAppsItemsAreCopiedForTheHelperAloneAndTheOriginalsStay() throws {
        defer { cleanUp() }
        addOriginals()
        #expect(try move.copy(trusting: helperInApp) == 6)
        let journal = try #require(try move.journal())
        #expect(journal.state == .copied)
        #expect(Set(journal.items.map(\.name)) == ["phone-link/key", "phone-link/secret", "phone-link/sign", "integrations/KUVO_KEY_GITHUB_TOKEN", "vault/v_abcdefghij", "vault/files"])
        // The helper reads every one, in a run of its own (the move's check).
        let check = try helper(["keys", "check"])
        #expect(check.status == 0, "\(check.errors)")
        #expect(check.output.contains(#""unreadable":[]"#))
        // The app can't: macOS would ask (it may still list them, which reads no secret).
        #expect(isRefused(keychain.read("\(Self.helperID).integrations", "KUVO_KEY_GITHUB_TOKEN")))
        #expect(keychain.items("\(Self.helperID).integrations")?.map(\.account) == ["KUVO_KEY_GITHUB_TOKEN"])
        // The app's own, as they were.
        #expect(keychain.read("\(Self.app).integrations", "KUVO_KEY_GITHUB_TOKEN") == .found(Data("ghp_trial4".utf8)))
        // The copy in the box's bin, signed as the app's is, reads them too.
        let installed = BoxHelperBundle.installed(in: box)
        try FileManager.default.createDirectory(at: installed.deletingLastPathComponent(), withIntermediateDirectories: true)
        #expect(try Self.ran("/usr/bin/ditto", [helperInApp.path, installed.path]).status == 0)
        #expect(try helper(["keys", "check"], bundle: installed).status == 0)
        // Asked again before its copies were taken away (a move that went back, its `uncopy` not
        // run): refused, never taken for the app's keys as they are now.
        #expect(throws: KeychainMove.Failure.self) { try move.copy(trusting: helperInApp) }
    }

    @Test func itemsAlreadyUnderTheHelpersNamesAreNeverTakenForCopies() throws {
        defer { cleanUp() }
        addOriginals()
        // Left by an earlier box (removed, or set aside), with an older value.
        #expect(keychain.add("\(Self.helperID).integrations", "KUVO_KEY_GITHUB_TOKEN", Data("ghp_old".utf8), label: nil, trusting: [helperInApp]) == errSecSuccess)
        #expect(throws: KeychainMove.Failure.leftovers("integrations/KUVO_KEY_GITHUB_TOKEN")) { try move.copy(trusting: helperInApp) }
        #expect(try move.journal() == nil, "nothing journaled, nothing made")
        #expect(keychain.items("\(Self.helperID).phone-link") == [])
    }

    @Test func aMoveThatWentBackTakesTheCopiesAwayAndLeavesTheOriginals() throws {
        defer { cleanUp() }
        addOriginals()
        try move.copy(trusting: helperInApp)
        // The app can't take them away itself: only a program an item names may.
        #expect(keychain.delete("\(Self.helperID).phone-link", "key") != errSecSuccess)
        let uncopied = try helper(["keys", "uncopy"])
        #expect(uncopied.status == 0, "\(uncopied.errors)")
        for service in KeychainMove.services {
            #expect(keychain.items("\(Self.helperID).\(service)") == [], "no copy left in \(service)")
        }
        #expect(keychain.read("\(Self.app).phone-link", "key") == .found(Self.linkKey))
        #expect(keychain.items("\(Self.app).vault")?.count == 2)
        #expect(try move.journal() == nil)
    }

    @Test func aMoveStoppedPartWayTakesAwayWhatItMadeAndOnlyThat() throws {
        defer { cleanUp() }
        addOriginals()
        // As if it stopped after its journal and one copy: the journal lists every one it would make.
        try move.copy(trusting: helperInApp)
        var journal = try #require(try move.journal())
        journal.state = .copying
        try move.write(journal)
        #expect(throws: KeychainMove.Failure.self) { try move.deleteOriginals() }
        #expect(keychain.exists("\(Self.app).phone-link", "key") == true, "the originals stay while the copies may not all be there")
        // Never taken up again as it was (its copies may be older than the app's keys are now): its
        // copies taken away first, then copied afresh.
        #expect(throws: KeychainMove.Failure.self) { try move.copy(trusting: helperInApp) }
        #expect(try helper(["keys", "uncopy"]).status == 0)
        #expect(try move.copy(trusting: helperInApp) == 6)
        #expect(try helper(["keys", "uncopy"]).status == 0)
        #expect(keychain.items("\(Self.helperID).phone-link") == [])
        #expect(keychain.exists("\(Self.app).phone-link", "key") == true)
    }

    @Test func aCopyWhoseOriginalIsGoneIsNeverTakenAway() throws {
        defer { cleanUp() }
        addOriginals()
        try move.copy(trusting: helperInApp)
        // The originals' deletion cut off after its first (the journal says so before it begins).
        var journal = try #require(try move.journal())
        journal.state = .settling
        try move.write(journal)
        #expect(keychain.delete("\(Self.app).phone-link", "key") == errSecSuccess)
        #expect(try helper(["keys", "uncopy"]).status != 0, "a move past the point of going back keeps its copies")
        // And had the journal still said `copied`: the copy whose original is gone stays.
        journal.state = .copied
        try move.write(journal)
        #expect(try helper(["keys", "uncopy"]).status != 0)
        #expect(keychain.exists("\(Self.helperID).phone-link", "key") == true, "the box's only link key")
        // The deletion finishes forward.
        journal.state = .settling
        try move.write(journal)
        try move.deleteOriginals()
        #expect(try move.journal()?.state == .settled)
        #expect(keychain.items("\(Self.app).integrations") == [])
    }

    @Test func theOriginalsGoOnlyOnceTheMoveIsDoneAndTheirCopiesAreThere() throws {
        defer { cleanUp() }
        addOriginals()
        try move.copy(trusting: helperInApp)
        // A copy that went missing (anything can take one it's trusted by away): the originals stay.
        #expect(try helper(["keys", "uncopy"]).status == 0)
        try move.copy(trusting: helperInApp)
        try move.deleteOriginals()
        for service in KeychainMove.services {
            #expect(keychain.items("\(Self.app).\(service)") == [], "no original left in \(service)")
        }
        #expect(try move.journal()?.state == .settled)
        #expect(try helper(["keys", "check"]).status == 0, "the helper's are the box's now")
        // Settled already: done.
        try move.deleteOriginals()
    }

    @Test func movingBackRemakesTheAppsItemsFromTheHelpersAndTakesItsOwnAway() throws {
        defer { cleanUp() }
        addOriginals()
        try move.copy(trusting: helperInApp)
        // Before the app's own are gone, it changes nothing.
        let early = try helper(["keys", "back", "--app", appBundle.path])
        #expect(early.status != 0)
        #expect(early.errors.contains("still in your Keychain"))
        #expect(keychain.items("\(Self.helperID).phone-link")?.count == 3)
        try move.deleteOriginals()
        // A key saved since the move, the helper's own now.
        #expect(keychain.add("\(Self.helperID).integrations", "KUVO_KEY_SLACK_TOKEN", Data("xoxb".utf8), label: "Kuvo Code integration key", trusting: [helperInApp]) == errSecSuccess)
        let back = try helper(["keys", "back", "--app", appBundle.path])
        #expect(back.status == 0, "\(back.errors)")
        for service in KeychainMove.services {
            #expect(keychain.items("\(Self.helperID).\(service)") == [], "no copy left in \(service)")
        }
        #expect(keychain.items("\(Self.app).integrations")?.map(\.account) == ["KUVO_KEY_GITHUB_TOKEN", "KUVO_KEY_SLACK_TOKEN"])
        #expect(keychain.items("\(Self.app).phone-link")?.count == 3)
        #expect(try move.journal() == nil)
        // Each made trusting the app, as the app reads them.
        let lists = try Self.ran("/usr/bin/security", ["dump-keychain", "-a", keychainFile.path]).output
        #expect(lists.contains(appBundle.path))
        // Only Kuvo Code itself is trusted with them.
        let refused = try helper(["keys", "back", "--app", helperInApp.path])
        #expect(refused.status != 0)
    }

    // MARK: Keeping a box

    /// The box's keeper and its `serve`, as stand-ins that note what they're given: the keeper its
    /// process and parent, then waits (TERM ends it); `serve` its first line on stdin, then waits for
    /// stdin to close. Each gives up by itself after two minutes.
    private func standIns() throws {
        try write(box.appending(path: "box/kind"), "mac\n")
        let script = """
        #!/bin/sh
        K="$HOME/\(RemoteEngineInstaller.root)"
        R="$K/run"
        case "$1" in
        keep)
          echo $$ >"$R/box.pid"
          echo "$PPID" >"$HOME/keep.parent"
          trap 'echo term >>"$HOME/keep.log"; exit 0' TERM
          i=0; while [ $i -lt 1200 ] && [ ! -f "$HOME/keep.end" ]; do /bin/sleep 0.1; i=$((i + 1)); done
          echo ended >>"$HOME/keep.log"
          ;;
        serve)
          echo $$ >"$HOME/serve.pid"
          trap 'echo signalled >>"$HOME/serve.log"; exit 1' TERM
          IFS= read -r line; printf '%s\\n' "$line" >"$HOME/serve.stdin"
          cat >/dev/null
          echo closed >>"$HOME/serve.log"
          ;;
        esac
        """
        try write(box.appending(path: "bin/kuvo-start"), script, executable: true)
    }

    /// A process's end, for an async test (where `waitUntilExit` can wait for good): its status.
    final class Ended: @unchecked Sendable {
        private let lock = NSLock()
        private var status: Int32?
        func note(_ status: Int32) { lock.withLock { self.status = status } }
        var value: Int32? { lock.withLock { status } }
    }

    struct Kept {
        let process: Process
        let ended: Ended
        var isRunning: Bool { ended.value == nil }
    }

    private func keeping() throws -> Kept {
        let process = Process()
        let ended = Ended()
        process.terminationHandler = { ended.note($0.terminationStatus) }
        process.executableURL = BoxHelperBundle.executable(of: helperInApp)
        process.arguments = ["keep"] + own
        process.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return Kept(process: process, ended: ended)
    }

    private func json(_ file: URL) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]) ?? [:]
    }

    private func post(_ host: [String: Any], _ path: String, _ body: [String: Any], authorized: Bool = true, vault: String? = nil, at: String? = nil) async throws -> (status: Int, json: [String: Any]) {
        var request = URLRequest(url: try #require(URL(string: "\(host["url"] as? String ?? "")\(path)")))
        request.httpMethod = "POST"
        let data = try JSONSerialization.data(withJSONObject: body)
        request.httpBody = data
        if authorized { request.setValue("Bearer \(host["password"] as? String ?? "")", forHTTPHeaderField: "authorization") }
        if let vault {
            let at = at ?? String(Int(Date().timeIntervalSince1970 * 1000))
            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            let signed = Data("kuvo-host-vault-call\u{0}\(path.dropFirst())\u{0}\(hash)\u{0}\(at)".utf8)
            let auth = HMAC<SHA256>.authenticationCode(for: signed, using: SymmetricKey(data: Data(vault.utf8))).map { String(format: "%02x", $0) }.joined()
            request.setValue(auth, forHTTPHeaderField: "x-kuvo-vault-auth")
            request.setValue(at, forHTTPHeaderField: "x-kuvo-vault-at")
        }
        let (answer, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, (try? JSONSerialization.jsonObject(with: answer) as? [String: Any]) ?? [:])
    }

    @Test func itRunsTheBoxsKeeperAndServerUnderItWithTheVaultsSecretsOnStdin() async throws {
        try standIns()
        let helper = try keeping()
        defer { cleanUp([helper]) }
        let hostFile = run.appending(path: "host.json"), stdin = home.appending(path: "serve.stdin")
        until { FileManager.default.fileExists(atPath: hostFile.path) && !text(stdin).isEmpty && !text(home.appending(path: "keep.parent")).isEmpty }
        // Its keeper, its own child, in a session of its own (as kuvo-start starts one).
        let keeper = try #require(Int32(text(run.appending(path: "box.pid")).trimmingCharacters(in: .whitespacesAndNewlines)))
        #expect(text(home.appending(path: "keep.parent")).trimmingCharacters(in: .whitespacesAndNewlines) == "\(helper.process.processIdentifier)")
        #expect(getsid(keeper) == keeper)
        // Its server, given its password and the vault's secrets on stdin (a box that never had a
        // vault key gets one made).
        let given = try #require(try JSONSerialization.jsonObject(with: Data(text(stdin).utf8)) as? [String: String])
        #expect(given["password"]?.count == 64)
        let vaultSecret = try #require(given["hostVaultSecret"])
        #expect(vaultSecret.count == 64)
        #expect(given["vaultFileKey"]?.isEmpty == false)
        // Where its host interface answers, only for you to read.
        let host = json(hostFile)
        #expect((try FileManager.default.attributesOfItem(atPath: hostFile.path)[.posixPermissions] as? Int) == 0o600)
        let port = try #require(URL(string: host["url"] as? String ?? "")?.port)
        // It proves it's what wrote host.json, as the box asks first.
        let nonce = String(repeating: "n", count: 32)
        let hello = try await post(host, "/hello", ["nonce": nonce, "vault": true], authorized: false)
        #expect(hello.json["proof"] as? String == HostProof.proof(of: nonce, at: "127.0.0.1:\(port)", password: host["password"] as? String ?? ""))
        #expect(hello.json["vaultProof"] as? String == HostProof.proof(of: nonce, at: "127.0.0.1:\(port)", password: vaultSecret, tag: "kuvo-host-vault"))
        // Nothing without its password, and only Kuvo Code's own keys.
        #expect(try await post(host, "/keys/names", [:], authorized: false).status == 401)
        #expect(try await post(host, "/keys/get", ["name": "HOME"]).status == 400)
        // A key saved, read, listed and taken away, in its own items.
        let name = "KUVO_KEY_GITHUB_TOKEN__BOT_HOSTED"
        #expect(try await post(host, "/keys/set", ["name": name, "value": "ghp_helper"]).status == 200)
        #expect(keychain.items("\(Self.helperID).integrations")?.map(\.account) == [name])
        #expect(try await post(host, "/keys/get", ["name": name]).json["value"] as? String == "ghp_helper")
        #expect(try await post(host, "/keys/names", ["suffix": "__BOT_HOSTED"]).json["names"] as? [String] == [name])
        #expect(try await post(host, "/keys/delete", ["name": name]).status == 200)
        #expect(try await post(host, "/keys/get", ["name": name]).status == 404)
        // The vault's values, only with the box's proof, each proof once.
        let at = String(Int(Date().timeIntervalSince1970 * 1000))
        #expect(try await post(host, "/vault/set", ["id": "v_abcdefghij", "values": ["password": "hunter2"]]).status == 403)
        #expect(try await post(host, "/vault/set", ["id": "v_abcdefghij", "values": ["password": "hunter2"]], vault: vaultSecret, at: at).status == 200)
        #expect(try await post(host, "/vault/set", ["id": "v_abcdefghij", "values": ["password": "hunter2"]], vault: vaultSecret, at: at).status == 403, "a proof works once")
        #expect(try await post(host, "/vault/get", ["id": "v_abcdefghij"], vault: vaultSecret).json["values"] as? [String: String] == ["password": "hunter2"])
        // This Mac's link keys, made the first time, the same after.
        let identity = try await post(host, "/link/identity", [:])
        #expect(identity.status == 200)
        #expect(Set(identity.json.keys) == ["key", "secret", "sign"])
        #expect(try await post(host, "/link/identity", [:]).json as? [String: String] == identity.json as? [String: String])
        // Noted as this box's, never to be made again.
        #expect(Set(json(box.appending(path: "box/keychain.json"))["has"] as? [String] ?? []) == ["phone-link/key", "phone-link/secret", "phone-link/sign", "vault/files"])
        // What only the open app answers.
        #expect(try await post(host, "/link/route", ["method": "GET", "path": "x"]).status == 503)

        // launchd stopping it: its server's stdin closed, its keeper told, its record gone, and it ends cleanly.
        kill(helper.process.processIdentifier, SIGTERM)
        until { !helper.isRunning }
        #expect(helper.ended.value == 0)
        until { text(home.appending(path: "serve.log")) == "closed\n" && text(home.appending(path: "keep.log")) == "term\n" }
        #expect(text(home.appending(path: "serve.log")) == "closed\n", "serve: \(text(home.appending(path: "serve.log"))) stdin: \(text(stdin))")
        #expect(text(home.appending(path: "keep.log")) == "term\n")
        #expect(!FileManager.default.fileExists(atPath: hostFile.path))
    }

    @Test func keysTheBoxHadAreNeverMadeAgain() async throws {
        try standIns()
        // This box had its link's keys and its vault's key; they're gone from the Keychain now.
        try write(box.appending(path: "box/keychain.json"), #"{"has":["phone-link/key","phone-link/secret","phone-link/sign","vault/files"]}"#)
        let helper = try keeping()
        defer { cleanUp([helper]) }
        let hostFile = run.appending(path: "host.json"), stdin = home.appending(path: "serve.stdin")
        until { FileManager.default.fileExists(atPath: hostFile.path) && !text(stdin).isEmpty }
        let given = try #require(try JSONSerialization.jsonObject(with: Data(text(stdin).utf8)) as? [String: String])
        #expect(given["vaultFileKey"] == nil, "no new vault key: the box's files stay signed with the one it had")
        let identity = try await post(json(hostFile), "/link/identity", [:])
        #expect(identity.status == 503)
        #expect((identity.json["message"] as? String)?.contains("missing from your Keychain") == true)
        #expect(keychain.items("\(Self.helperID).phone-link") == [], "none made in their place")
        #expect(keychain.items("\(Self.helperID).vault") == [])
    }

    @Test func afterTheMoveTheHelperReadsAndChangesTheKeysTheAppHad() async throws {
        try standIns()
        addOriginals()
        try move.copy(trusting: helperInApp)
        try move.deleteOriginals()
        let helper = try keeping()
        defer { cleanUp([helper]) }
        let hostFile = run.appending(path: "host.json"), stdin = home.appending(path: "serve.stdin")
        until { FileManager.default.fileExists(atPath: hostFile.path) && !text(stdin).isEmpty }
        let host = json(hostFile)
        let vaultSecret = try #require((try JSONSerialization.jsonObject(with: Data(text(stdin).utf8)) as? [String: String])?["hostVaultSecret"])
        // The vault's file key the app kept, given to the box as it was.
        #expect(text(stdin).contains(#""vaultFileKey":"filekey""#))
        // Its copies, read and changed through the helper (their list names it alone).
        #expect(try await post(host, "/keys/get", ["name": "KUVO_KEY_GITHUB_TOKEN"]).json["value"] as? String == "ghp_trial4")
        #expect(try await post(host, "/keys/set", ["name": "KUVO_KEY_GITHUB_TOKEN", "value": "ghp_rotated"]).status == 200)
        #expect(try await post(host, "/keys/get", ["name": "KUVO_KEY_GITHUB_TOKEN"]).json["value"] as? String == "ghp_rotated")
        #expect(try await post(host, "/vault/get", ["id": "v_abcdefghij"], vault: vaultSecret).json["values"] as? [String: String] == ["password": "hunter2"])
        #expect(try await post(host, "/vault/set", ["id": "v_abcdefghij", "values": ["password": "rotated"]], vault: vaultSecret).status == 200)
        #expect(try await post(host, "/vault/get", ["id": "v_abcdefghij"], vault: vaultSecret).json["values"] as? [String: String] == ["password": "rotated"])
        #expect(try await post(host, "/vault/generations", ["file": "items", "generation": 3], vault: vaultSecret).json["generations"] as? [String: Int] == ["items": 3])
        // Its link keys, as the app had them: the same box to every phone and computer.
        #expect(try await post(host, "/link/identity", [:]).json as? [String: String] == [
            "key": Self.linkKey.base64URLText, "secret": Self.relaySecret.base64URLText, "sign": Self.signingKey.base64URLText,
        ])
        // What the box let go of, from its trash only, to the Finder's Trash (a test's own folder
        // elsewhere stays where it is).
        let outside = folder.appending(path: "outside")
        try write(outside.appending(path: "x"), "x")
        #expect(try await post(host, "/trash", ["path": outside.path]).status == 200)
        #expect(FileManager.default.fileExists(atPath: outside.path))
    }

    @Test func itStartsNoBoxWhileAMoveIsUnfinished() throws {
        try standIns()
        defer { cleanUp() }
        // The move's journal, part way.
        try write(box.appending(path: "updates/rehome/journal.json"), #"{"v":1,"step":"clone"}"#)
        #expect(try helper(["keep"]).status == 0)
        #expect(text(run.appending(path: "helper-trouble")).contains("is moving"))
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "box.pid").path))
        // Done, but its keys copied for a move that went back (the old box may run with them).
        try write(box.appending(path: "updates/rehome/journal.json"), #"{"v":1,"step":"done"}"#)
        addOriginals()
        try move.copy(trusting: helperInApp)
        #expect(try helper(["keep"]).status == 0)
        #expect(text(run.appending(path: "helper-trouble")).contains("didn’t finish"))
        #expect(!FileManager.default.fileExists(atPath: home.appending(path: "serve.stdin").path))
    }

    @Test func itStartsNoKeeperThatNamesAnotherBox() throws {
        try standIns()
        defer { cleanUp() }
        let script = text(box.appending(path: "bin/kuvo-start")).replacingOccurrences(of: "K=\"$HOME/\(RemoteEngineInstaller.root)\"", with: "K=\"$HOME/.kuvo-code-elsewhere\"")
        try write(box.appending(path: "bin/kuvo-start"), script, executable: true)
        #expect(try helper(["keep"]).status == 0)
        #expect(text(run.appending(path: "helper-trouble")).contains("isn’t its own"))
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "box.pid").path))
    }

    @Test func aBoxTurnedOffTakesItsHelperWithIt() throws {
        try standIns()
        let helper = try keeping()
        defer { cleanUp([helper]) }
        until { !text(home.appending(path: "serve.stdin")).isEmpty && !text(run.appending(path: "box.pid")).isEmpty }
        // `kuvo-start off`: marked off, then its keeper ended.
        try write(run.appending(path: "off"), "")
        try write(home.appending(path: "keep.end"), "")
        until { !helper.isRunning }
        #expect(helper.ended.value == 0)
        #expect(text(home.appending(path: "serve.log")) == "closed\n")
        #expect(text(home.appending(path: "keep.log")) == "ended\n", "started once, never again")
    }

    @Test func aSecondHelperForTheSameBoxGoesAtOnce() throws {
        try standIns()
        let first = try keeping()
        defer { cleanUp([first]) }
        until { FileManager.default.fileExists(atPath: run.appending(path: "host.json").path) }
        let second = try helper(["keep"])
        #expect(second.status == 0)
        #expect(first.isRunning)
    }

    @Test func aHelperChangedSinceItWasSignedStartsNothing() throws {
        try standIns()
        try write(helperInApp.appending(path: "Contents/Resources/extra"), "changed")
        let ran = try helper(["keep"])
        defer { cleanUp() }
        #expect(ran.status == 0, "cleanly, so launchd doesn't start it again and again")
        #expect(text(run.appending(path: "helper-trouble")).contains("was changed since it was installed"))
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "box.pid").path))
        #expect(!FileManager.default.fileExists(atPath: home.appending(path: "serve.stdin").path))
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "host.json").path))
    }

    // MARK: Its bundle, and opening it

    @Test func itsBundleIsKuvoCodeBoxSignedWithTheAppsIconAndWhatMacOSAsks() throws {
        defer { cleanUp() }
        let info = try #require(NSDictionary(contentsOf: helperInApp.appending(path: "Contents/Info.plist")) as? [String: Any])
        #expect(info["CFBundleIdentifier"] as? String == Self.helperID)
        #expect(info["CFBundleName"] as? String == "Kuvo Code Box")
        #expect(info["CFBundleExecutable"] as? String == "Kuvo Code Box")
        #expect(info["LSUIElement"] as? Bool == true)
        #expect(info["CFBundleShortVersionString"] as? String == "0.0.4")
        #expect(info["NSCalendarsFullAccessUsageDescription"] as? String == "The agent reads your calendar when you've turned it on.")
        #expect(text(helperInApp.appending(path: "Contents/Resources/AppIcon.icns")) == "icon")
        let signature = try Self.ran("/usr/bin/codesign", ["-d", "--verbose=2", "--entitlements", "-", helperInApp.path])
        #expect(signature.errors.contains("Identifier=\(Self.helperID)"))
        #expect(signature.errors.contains("runtime"), "the hardened runtime, as notarizing asks")
        #expect(signature.output.contains("com.apple.security.personal-information.calendars"))
        #expect(BoxHelperBundle.isGenuine(helperInApp, identifier: Self.helperID, signer: .adHoc, adHocMatch: true))
        #expect(!BoxHelperBundle.isGenuine(helperInApp, identifier: Self.helperID, signer: .adHoc), "ad hoc, only what's proved this very build")
        #expect(!BoxHelperBundle.isGenuine(helperInApp, identifier: Self.helperID, signer: nil), "nothing when who signed this can't be told")
        #expect(!BoxHelperBundle.isGenuine(helperInApp, identifier: "run.kuvo.code.trial4.other", signer: .adHoc, adHocMatch: true))
        #expect(!BoxHelperBundle.isGenuine(helperInApp, identifier: Self.helperID, signer: .team("ABCDE12345")), "another team's isn't")
    }

    @Test func theAppOpensTheHelperInstalledInTheBoxAsItsOwnProgram() async throws {
        defer { cleanUp() }
        let opener = folder.appending(path: "open")
        try write(opener, "#!/bin/sh\nprintf '%s\\n' \"$@\" >\"\(folder.path)/opened\"\n", executable: true)
        // Not installed yet: said, nothing opened.
        await #expect(throws: BoxHelperBundle.Refused.self) { try await BoxHelperBundle.open(home: box, app: Self.app, opener: opener.path, signer: .adHoc, carrier: appBundle) }
        #expect(BoxHelperBundle.trouble(installedIn: box, app: Self.app, signer: .adHoc, carrier: appBundle)?.contains("isn’t in this Mac’s box") == true)
        let installed = BoxHelperBundle.installed(in: box)
        try FileManager.default.createDirectory(at: installed.deletingLastPathComponent(), withIntermediateDirectories: true)
        #expect(try Self.ran("/usr/bin/ditto", [helperInApp.path, installed.path]).status == 0)
        #expect(BoxHelperBundle.trouble(installedIn: box, app: Self.app, signer: .adHoc, carrier: appBundle) == nil)
        try await BoxHelperBundle.open(home: box, app: Self.app, opener: opener.path, signer: .adHoc, carrier: appBundle)
        #expect(text(folder.appending(path: "opened")).split(separator: "\n") == ["-g", "-j", "-n", Substring(installed.path), "--args", "keep", "--home", Substring(box.path)])
        // Changed since it was signed: not opened.
        try FileManager.default.removeItem(at: folder.appending(path: "opened"))
        try write(installed.appending(path: "Contents/Resources/extra"), "changed")
        #expect(BoxHelperBundle.trouble(installedIn: box, app: Self.app, signer: .adHoc, carrier: appBundle)?.contains("was changed") == true)
        await #expect(throws: BoxHelperBundle.Refused.self) { try await BoxHelperBundle.open(home: box, app: Self.app, opener: opener.path, signer: .adHoc, carrier: appBundle) }
        #expect(!FileManager.default.fileExists(atPath: folder.appending(path: "opened").path))
    }
}
