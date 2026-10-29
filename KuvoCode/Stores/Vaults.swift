import ClientVault
import Foundation
import Security

/// Each computer's vault, as the Mac app shows and changes it (KuvoLink's PROTOCOL.md, "Vault"):
/// what its box says, by box (`BoxClient.mac`, or a machine's id). A machine's is reached with its
/// unlock key, which this Mac keeps in the Keychain (`VaultKeys`) and gets, the first time, by
/// proving to the machine it's the Mac that set it up.
@MainActor
@Observable
final class Vaults {
    static let shared = Vaults()

    /// One computer's vault, as last read.
    struct Shown: Equatable {
        var vault: Vault?
        var asks: [VaultAsk] = []
        var activity: [VaultActivity] = []
        /// Why it couldn't be read just now.
        var failure: String?
    }

    private(set) var shown: [String: Shown] = [:]
    /// Reaches a box (`AppModel.box`), set as the app starts.
    @ObservationIgnored var client: (String) -> BoxClient? = { _ in nil }
    /// The Mac's proof for a machine it set up (`PhoneLink.vaultProof`).
    @ObservationIgnored var proof: (String) -> [String: Any]? = { _ in nil }
    /// Goes up with each read of a box, and as it's forgotten: a read that comes back after a
    /// later one, or after the box was forgotten, is dropped.
    @ObservationIgnored private var reads: [String: Int] = [:]

    subscript(box: String) -> Shown { shown[box] ?? Shown() }

    // MARK: Asking a box

    private func headers(for box: String) async throws -> [String: String] {
        guard box != BoxClient.mac else { return [:] }
        if let key = VaultKeys.key(for: box) { return ["x-kuvo-vault-key": key] }
        return ["x-kuvo-vault-key": try await keyFromMachine(box)]
    }

    /// The machine's unlock key, which it gives (making its vault, the first time) to the Mac that
    /// set it up; kept once it's given.
    private func keyFromMachine(_ box: String) async throws -> String {
        guard let proof = proof(box), let client = client(box) else { throw BoxRefusal(status: 503, message: "This Mac can't reach that machine's vault now. Try again in a moment.") }
        let (status, data) = try await client.send("POST", VaultRoutes.key, body: try JSONSerialization.data(withJSONObject: proof))
        guard status == 200, let key = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["key"] as? String else { throw BoxRefusal(status: status, data: data) }
        VaultKeys.keep(key, for: box)
        return key
    }

    /// `method path` on `box`'s vault, its answer's JSON as `T`.
    func ask<T: Decodable>(_ type: T.Type = T.self, _ method: String, _ path: String, body: [String: Any]? = nil, on box: String) async throws -> T {
        guard let client = client(box) else { throw BoxRefusal(status: 503, message: "Kuvo Code isn't ready yet.") }
        let sent = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        var (status, data) = try await client.send(method, path, body: sent, headers: try await headers(for: box))
        // A key that isn't the machine's any more (its vault made again): asked for afresh, once,
        // the old one kept until there's a new one.
        if status == 403, box != BoxClient.mac, let old = VaultKeys.key(for: box), let fresh = try? await keyFromMachine(box), fresh != old {
            (status, data) = try await client.send(method, path, body: sent, headers: ["x-kuvo-vault-key": fresh])
        }
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private struct Nothing: Decodable {}
    private struct Asks: Decodable { var asks: [VaultAsk] }
    private struct Entries: Decodable { var entries: [VaultActivity] }
    private struct Made: Decodable { var item: VaultItem; var key: String? }
    private struct Values: Decodable { var values: [String: String] }

    // MARK: Reading

    private func nextRead(_ box: String) -> Int {
        let read = (reads[box] ?? 0) + 1
        reads[box] = read
        return read
    }

    /// Reads `box`'s vault, its asks and its latest activity again.
    func refresh(_ box: String) async {
        let read = nextRead(box)
        var now = self[box]
        do {
            now.vault = try await ask(Vault.self, "GET", VaultRoutes.vault, on: box)
            now.asks = try await ask(Asks.self, "GET", VaultRoutes.asks, on: box).asks
            now.activity = try await ask(Entries.self, "GET", VaultRoutes.activity(limit: 50), on: box).entries
            now.failure = nil
        } catch {
            now.failure = error.localizedDescription
        }
        guard reads[box] == read else { return }
        shown[box] = now
    }

    /// Follows `box` while the caller's task runs (a view's): what its agents ask, read again
    /// every second on this Mac (with its vault every few, which the browser and agents' sign-ins
    /// read) and every ten on a machine, whose box answers once over SSH. A machine's only once
    /// this Mac keeps its key: following never makes a vault. A box without a vault stops it.
    func follow(_ box: String) async {
        var round = 0
        while !Task.isCancelled {
            if box == BoxClient.mac, round % 5 == 0 {
                await refresh(box)
            } else if box == BoxClient.mac || VaultKeys.key(for: box) != nil {
                // Dropped if a whole read began meanwhile, which has the asks too.
                let read = reads[box]
                do {
                    let asks = try await ask(Asks.self, "GET", VaultRoutes.asks, on: box).asks
                    if reads[box] == read, asks != self[box].asks {
                        var now = self[box]
                        now.asks = asks
                        shown[box] = now
                    }
                } catch let refusal as BoxRefusal where [403, 404, 405].contains(refusal.status) {
                    return
                } catch {}
            }
            round += 1
            try? await Task.sleep(for: .seconds(box == BoxClient.mac ? 1 : 10))
        }
    }

    /// Forgets what's shown of `box`'s vault (a read still on its way is dropped); a machine's
    /// unlock key too (the machine removed from this Mac).
    func forget(_ box: String) {
        _ = nextRead(box)
        shown[box] = nil
        if box != BoxClient.mac { VaultKeys.forget(box) }
    }

    func activity(on box: String, item: String? = nil, bot: String? = nil, limit: Int = 100) async throws -> [VaultActivity] {
        try await ask(Entries.self, "GET", VaultRoutes.activity(item: item, bot: bot, limit: limit), on: box).entries
    }

    // MARK: Changing

    @discardableResult
    func add(_ given: VaultDraft, on box: String) async throws -> VaultItem {
        let made = try await ask(Made.self, "POST", VaultRoutes.items, body: given.json, on: box)
        if let key = made.key, box != BoxClient.mac { VaultKeys.keep(key, for: box) }
        await refresh(box)
        return made.item
    }

    @discardableResult
    func change(_ item: VaultItem, to given: VaultDraft, on box: String) async throws -> VaultItem {
        let changed = try await ask(Made.self, "PATCH", VaultRoutes.item(item.id), body: given.json, on: box)
        await refresh(box)
        return changed.item
    }

    func remove(_ item: VaultItem, on box: String) async throws {
        _ = try await ask(Nothing.self, "DELETE", VaultRoutes.item(item.id), on: box)
        await refresh(box)
    }

    /// Its values, for you to see or copy (after Touch ID, which the page asks).
    func values(of item: VaultItem, on box: String) async throws -> [String: String] {
        try await ask(Values.self, "GET", VaultRoutes.values(item.id), on: box).values
    }

    /// Sets how `who` may use `item` (`nil` takes it away).
    func grant(_ item: VaultItem, to who: VaultGrant.Who, how: VaultGrant.How?, on box: String) async throws {
        var whom: [String: Any] = [:]
        if let bot = who.bot { whom["bot"] = bot }
        if let project = who.project { whom["project"] = project }
        if who.everyone == true { whom["everyone"] = true }
        _ = try await ask(Nothing.self, "POST", VaultRoutes.grants, body: ["item": item.id, "who": whom, "how": how?.rawValue ?? NSNull()], on: box)
        await refresh(box)
    }

    /// Pauses (or lets go again) every agent's use, or one bot's.
    func pause(_ paused: Bool, bot: String? = nil, on box: String) async throws {
        var body: [String: Any] = ["paused": paused]
        if let bot { body["bot"] = bot }
        _ = try await ask(Nothing.self, "POST", VaultRoutes.pause, body: body, on: box)
        await refresh(box)
    }

    /// Your answer to what an agent asks.
    func answer(_ asked: VaultAsk, _ answer: String, item: VaultItem? = nil, on box: String) async throws {
        var body: [String: Any] = ["answer": answer]
        if let item { body["item"] = item.id }
        _ = try await ask(Nothing.self, "POST", VaultRoutes.ask(asked.id), body: body, on: box)
        var now = self[box]
        now.asks.removeAll { $0.id == asked.id }
        shown[box] = now
        Task { await refresh(box) }
    }
}

/// The unlock keys of your machines' vaults, which only your clients keep: in the Keychain, by
/// machine. A demo or test copy keeps its own.
nonisolated enum VaultKeys {
    private static var service: String { (Bundle.main.bundleIdentifier ?? "run.kuvo.code") + ".vault-keys" }

    private static func query(_ machine: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: machine]
    }

    static func key(for machine: String) -> String? {
        var item = query(machine)
        item[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard Keychain.copyMatching(item, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func keep(_ key: String, for machine: String) {
        let data = Data(key.utf8)
        if Keychain.update(query(machine), [kSecValueData as String: data]) == errSecSuccess { return }
        var item = query(machine)
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "Kuvo Code vault key"
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        Keychain.add(item)
    }

    static func forget(_ machine: String) {
        Keychain.delete(query(machine))
    }
}
