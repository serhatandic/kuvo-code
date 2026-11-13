#if os(macOS)
import CryptoKit
import Foundation
import os

/// The host interface a Mac's box in a home of its own asks its helper for (KuvoLink's PROTOCOL.md,
/// "Host interface" and "This Mac's box: its helper"), as it asked the app's keeper before: its keys
/// in your Keychain (its integrations', its vault's values, its link's), opening Kuvo Code for its
/// agents' browser, and moving what it let go of to the Finder's Trash. The same calls, proofs and
/// answers as the keeper's (`HostProof`); what only the open app answers (the panel's sites, a
/// phone's ask of the Mac's own routes) says the app isn't open.
///
/// Its items are its own, named by its bundle ID (`<helper ID>.integrations`, …), the copies the
/// app's keeper made of the app's as the box moved (`KeychainMove`). It makes the link's keys and
/// the vault's file key the first time a box asks, never again once the box has had one
/// (`box/keychain.json`, and the move's journal): one that's gone (anything you run can take an item
/// away) is said to be missing, never quietly replaced, which would make this Mac another box to
/// every phone, machine and peer.
@MainActor
public final class BoxHelperHost {
    let home: URL
    let keychain: HostKeychain
    /// Its items' prefix: its own bundle ID.
    let prefix: String
    /// The app's bundle ID (`/app/open` opens only Kuvo Code).
    let app: String
    private let password = HostProof.secret()
    /// Given to the box alone, on `serve`'s stdin (`BoxHelper`), for its vault's calls.
    public let vaultSecret = HostProof.secret()
    private lazy var vaultProofs = VaultCallProofs(secret: vaultSecret)
    private lazy var server = LoopbackServer { [weak self] request in await self?.respond(to: request) ?? HTTPResponse(status: 503) }
    /// What opens the app (`open`; a test's stand-in).
    var opener = "/usr/bin/open"

    public init(home: URL, keychain: HostKeychain, prefix: String, app: String) {
        self.home = home
        self.keychain = keychain
        self.prefix = prefix
        self.app = app
    }

    var run: URL { home.appending(path: "run") }
    /// Where it tells the box it answers, and its password (only you can read it).
    public var file: URL { run.appending(path: "host.json") }
    public var port: UInt16? { server.port }

    /// Starts answering, and tells the box where (`run/host.json`): what it was told before goes
    /// first, so a start that fails leaves it nothing to follow.
    public func start() async throws {
        if server.port == nil { try? FileManager.default.removeItem(at: file) }
        let port = try await server.start()
        try PrivateFile.write(try JSONSerialization.data(withJSONObject: ["url": "http://127.0.0.1:\(port)", "password": password]), to: file)
    }

    /// Stops answering, and takes its record away (its own only).
    public func stop() {
        guard server.port != nil else { return }
        server.stop()
        if let data = try? Data(contentsOf: file), (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["password"] as? String == password {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// Told when its listener failed by itself (the helper starts it again).
    public var failed: (() -> Void)? {
        get { server.failed }
        set { server.failed = newValue }
    }

    // MARK: Keys it makes once

    /// The items it may make the first time the box asks: its link's keys and its vault's file key.
    static let made = ["phone-link/key", "phone-link/secret", "phone-link/sign", "vault/files"]

    /// Where it notes the items this box has had (`box/keychain.json`, `{"has": [...]}`).
    var record: URL { home.appending(path: "box/keychain.json") }

    /// The items this box has had: those it noted, and those the move copied for it.
    func had() -> Set<String> {
        var had = Set<String>()
        if let data = try? Data(contentsOf: record), let noted = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["has"] as? [String] {
            had.formUnion(noted)
        }
        if let journal = try? KeychainMove(keychain: keychain, home: home, app: app, helper: prefix).journal() {
            had.formUnion(journal.items.map(\.name))
        }
        return had
    }

    /// Notes that the box has `items` (found or made).
    func note(_ items: [String]) {
        let had = had()
        guard !Set(items).isSubset(of: had) else { return }
        let all = had.union(items).filter { Self.made.contains($0) }.sorted()
        try? PrivateFile.write(try JSONSerialization.data(withJSONObject: ["has": all]), to: record)
    }

    /// An item it may make, as the box first asks: found; else made where the box never had it.
    enum Kept { case found(Data), made(Data), missing, refused }

    func keep(_ service: String, _ account: String, label: String, valid: (Data) -> Bool, make: () -> Data) -> Kept {
        let name = "\(service)/\(account)"
        switch keychain.read("\(prefix).\(service)", account) {
        case .found(let data) where valid(data):
            note([name])
            return .found(data)
        case .found, .missing:
            guard !had().contains(name) else {
                Logger(subsystem: "run.kuvo.code", category: "box-helper").error("The box's \(name, privacy: .public) is missing from the Keychain: not made again")
                return .missing
            }
            let data = make()
            let status = keychain.add("\(prefix).\(service)", account, data, label: label)
            if status == errSecDuplicateItem, case .found(let kept) = keychain.read("\(prefix).\(service)", account), valid(kept) {
                note([name])
                return .found(kept)
            }
            guard status == errSecSuccess else { return .refused }
            note([name])
            return .made(data)
        case .refused:
            return .refused
        }
    }

    // MARK: The vault's files

    private struct VaultFiles: Codable {
        var key: String
        var generations: [String: Int] = [:]
        var adopt: Bool?
    }

    private func readFiles() -> (VaultFiles?, HostKeychain.Read) {
        let read = keychain.read("\(prefix).vault", "files")
        guard let data = read.data else { return (nil, read) }
        return ((try? JSONDecoder().decode(VaultFiles.self, from: data)), read)
    }

    private func keepFiles(_ files: VaultFiles) -> Bool {
        guard let data = try? JSONEncoder().encode(files) else { return false }
        return keychain.set("\(prefix).vault", "files", data, label: "Kuvo Code vault") == errSecSuccess
    }

    /// The key the box signs its vault's files with, for `serve`'s stdin: made the first time only.
    public func vaultFileKey() -> String? {
        let kept = keep("vault", "files", label: "Kuvo Code vault",
                        valid: { (try? JSONDecoder().decode(VaultFiles.self, from: $0)) != nil },
                        make: { (try? JSONEncoder().encode(VaultFiles(key: Data((0..<32).map { _ in UInt8.random(in: 0...255) }).base64URLText))) ?? Data() })
        switch kept {
        case .found(let data), .made(let data): return (try? JSONDecoder().decode(VaultFiles.self, from: data))?.key
        case .missing, .refused: return nil
        }
    }

    // MARK: Answers

    private static func said(_ status: Int, _ message: String) -> HTTPResponse {
        var answer = HTTPResponse.json(["message": message])
        answer.status = status
        return answer
    }

    private static var failed: HTTPResponse { said(503, "Your Keychain didn’t take it. Try again, or check Keychain Access.") }
    private static var locked: HTTPResponse { said(503, "This Mac’s Keychain can’t be read now. Unlock your Mac, then try again.") }

    func respond(to request: HTTPRequest) async -> HTTPResponse {
        if request.path == "/hello" {
            guard request.method == "POST" else { return HTTPResponse(status: 405, headers: ["Allow": "POST"]) }
            guard let port = server.port else { return HTTPResponse(status: 503) }
            guard let answer = HostProof.hello(request, port: port, password: password, vaultSecret: vaultSecret) else { return HTTPResponse(status: 400) }
            return .json(answer)
        }
        guard HostProof.authorized(request, password: password) else { return HTTPResponse(status: 401) }
        guard request.method == "POST" else { return HTTPResponse(status: 405, headers: ["Allow": "POST"]) }
        let given = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
        let name = given["name"] as? String
        let keys = "\(prefix).integrations"
        switch request.path {
        case "/keys/names":
            let start = given["prefix"] as? String ?? "", end = given["suffix"] as? String ?? ""
            // One the Keychain couldn't list isn't "no keys": the box would take bots' servers away.
            guard let items = keychain.items(keys) else { return Self.failed }
            return .json(["names": items.map(\.account).filter { HostProof.isKey($0) && $0.hasPrefix(start) && $0.hasSuffix(end) }.sorted()])
        case "/keys/get":
            guard let name, HostProof.isKey(name) else { return HTTPResponse(status: 400) }
            switch keychain.read(keys, name) {
            case .found(let data): return .json(["value": String(decoding: data, as: UTF8.self)])
            case .missing: return HTTPResponse(status: 404)
            case .refused: return Self.locked
            }
        case "/keys/set":
            guard let name, HostProof.isKey(name), let value = given["value"] as? String, !value.isEmpty else { return HTTPResponse(status: 400) }
            return keychain.set(keys, name, Data(value.utf8), label: "Kuvo Code integration key") == errSecSuccess ? .json([:]) : Self.failed
        case "/keys/delete":
            guard let name, HostProof.isKey(name) else { return HTTPResponse(status: 400) }
            let status = keychain.delete(keys, name)
            return status == errSecSuccess || status == errSecItemNotFound ? .json([:]) : Self.failed
        case "/vault/generations":
            guard vaultProofs.proved(request) else { return HTTPResponse(status: 403) }
            if let file = given["file"] as? String, ["items", "grants", "paused"].contains(file), let generation = given["generation"] as? Int {
                guard var files = readFiles().0 else { return Self.failed }
                let adopting = files.adopt != nil
                files.adopt = nil
                let newer = generation > files.generations[file] ?? 0
                if newer { files.generations[file] = generation }
                if newer || adopting, !keepFiles(files) { return Self.failed }
            }
            let (files, read) = readFiles()
            if let files { return .json(["generations": files.generations, "adopt": files.adopt == true]) }
            guard read == .missing else { return Self.said(503, "This Mac’s Keychain can’t be read now, so its vault waits. Unlock your Mac, then try again.") }
            return .json(["generations": [String: Int](), "adopt": false])
        case "/vault/get", "/vault/set", "/vault/delete":
            guard vaultProofs.proved(request) else { return HTTPResponse(status: 403) }
            guard let id = given["id"] as? String, HostProof.isVaultItem(id) else { return HTTPResponse(status: 400) }
            let vault = "\(prefix).vault"
            switch request.path {
            case "/vault/get":
                guard let data = keychain.read(vault, id).data, let values = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] else { return HTTPResponse(status: 404) }
                return .json(["values": values])
            case "/vault/set":
                guard let values = given["values"] as? [String: String], let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) else { return HTTPResponse(status: 400) }
                return keychain.set(vault, id, data, label: "Kuvo Code vault item") == errSecSuccess ? .json([:]) : Self.failed
            default:
                let status = keychain.delete(vault, id)
                return status == errSecSuccess || status == errSecItemNotFound ? .json([:]) : Self.failed
            }
        case "/link/identity":
            return identity()
        case "/app/open":
            guard let bundle = given["bundle"] as? String, bundle.hasPrefix("/") else { return HTTPResponse(status: 400) }
            return await openApp(URL(filePath: bundle))
        case "/trash":
            guard let path = given["path"] as? String else { return HTTPResponse(status: 400) }
            toFinderTrash(path)
            return .json([:])
        case "/sites/signed-in", "/link/route":
            // What only the open app answers: it reaches the box itself (piece 6b), not through here.
            return Self.said(503, "Kuvo Code isn’t open on this Mac.")
        default:
            return HTTPResponse(status: 404)
        }
    }

    /// This Mac's link's keys (its static key, relay secret and signing key), as your phones and
    /// machines know it: made the first time, never again (`keep`).
    func identity() -> HTTPResponse {
        var given: [String: String] = [:]
        let parts: [(account: String, valid: (Data) -> Bool, make: () -> Data)] = [
            ("key", { (try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: $0)) != nil }, { Curve25519.KeyAgreement.PrivateKey().rawRepresentation }),
            ("secret", { $0.count == 32 }, { SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) } }),
            ("sign", { (try? Curve25519.Signing.PrivateKey(rawRepresentation: $0)) != nil }, { Curve25519.Signing.PrivateKey().rawRepresentation }),
        ]
        for part in parts {
            switch keep("phone-link", part.account, label: "Kuvo Code phone link", valid: part.valid, make: part.make) {
            case .found(let data), .made(let data): given[part.account] = data.base64URLText
            case .missing:
                return Self.said(503, "This Mac’s link keys are missing from your Keychain, so its link stays off rather than be another Mac to your phones and computers. Move the box back, or see Troubleshooting.")
            case .refused:
                return Self.locked
            }
        }
        return .json(given)
    }

    /// Kuvo Code at `bundle`, opened in the background for its box's browser (the box decides when,
    /// PROTOCOL.md, `app/open`): only Kuvo Code, signed by this helper's team. 410 when it isn't
    /// there, 403 for another app, 502 with why it couldn't be opened.
    func openApp(_ bundle: URL) async -> HTTPResponse {
        guard FileManager.default.fileExists(atPath: bundle.path(percentEncoded: false)) else { return Self.said(410, "It isn’t there any more.") }
        guard BoxHelperBundle.isGenuine(bundle, identifier: app) else { return Self.said(403, "That isn’t Kuvo Code.") }
        do {
            let result = try await ChildProcess.run(opener, ["-g", "-j", "-a", bundle.path(percentEncoded: false), "--args", "--in-background"],
                                                    output: .discard, errors: .collect, limit: .seconds(20), cancellable: false)
            guard result.succeeded else {
                let said = result.errorText.trimmingCharacters(in: .whitespacesAndNewlines)
                return Self.said(502, result.timedOut ? "macOS didn’t open it in time." : said.isEmpty ? "macOS refused." : said)
            }
            return .json([:])
        } catch {
            return Self.said(502, error.localizedDescription)
        }
    }

    /// What the box let go of, from its own trash folder only (links followed on both sides, so one
    /// can't lead out of it), to the Finder's Trash.
    func toFinderTrash(_ path: String) {
        let folder = URL(filePath: path).resolvingSymlinksInPath().standardizedFileURL
        let trash = home.appending(path: "trash").resolvingSymlinksInPath().standardizedFileURL.path(percentEncoded: false)
        let inside = trash.hasSuffix("/") ? trash : trash + "/"
        guard folder.path(percentEncoded: false).hasPrefix(inside), FileManager.default.fileExists(atPath: folder.path(percentEncoded: false)) else { return }
        do {
            try FileManager.default.trashItem(at: folder, resultingItemURL: nil)
        } catch {
            Logger(subsystem: "run.kuvo.code", category: "box-helper").error("A folder stayed in the box's trash: \(error.localizedDescription, privacy: .public)")
        }
    }
}

extension Data {
    /// Base64 with URL-safe letters and no padding, as the box reads keys.
    var base64URLText: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
#endif
