import ClientAccounts
import Foundation
import OpenCodeKit
import UsageKit
import os

private let log = Logger(subsystem: "run.kuvo.code", category: "usage")

/// The usage panel's settings as this Mac's box keeps them for every computer of yours
/// (`api/kuvo/usage/settings`, PROTOCOL.md "Usage settings"): which cards and meters show, their
/// order, what's pinned, the total spend card's and which notifications are on. The panel shows the
/// box's (`HostSettings`), and what's changed in it goes to the box, which shares it with your other
/// computers; what this Mac kept before goes to its box once. This only carries them: what's newest,
/// what's kept of a newer app's, and who gets it is the box's.
@MainActor
final class UsageSettingsOnBox {
    private var api: OpenCodeAPI?
    private let host: HostSettings
    private let defaults: UserDefaults
    /// Whether this Mac's box keeps them (`usage.settings` in its features), as it last said.
    private var kept = false
    /// One ask of the box at a time, in order: a change made here goes after what was asked before it.
    private var work: Task<Void, Never>?
    /// Parts changed here the box hasn't taken yet (it wasn't answering, or the app quit first), and
    /// the cards and meters this panel knows: they go as it's back, before its own are read. Kept
    /// through a restart.
    private var unsent: [String: JSONValue] = [:] {
        didSet { save() }
    }
    private var knows: JSONValue? {
        didSet { save() }
    }
    private static let unsentKey = "usage.settingsUnsent"

    init(host: HostSettings = .shared, defaults: UserDefaults = .standard) {
        self.host = host
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.unsentKey), let saved = try? JSONDecoder().decode(Saved.self, from: data) {
            unsent = saved.parts
            knows = saved.knows
        }
        host.onChange = { [weak self] parts in self?.changed(parts) }
    }

    private struct Saved: Codable {
        var parts: [String: JSONValue]
        var knows: JSONValue?
    }

    private func save() {
        guard !unsent.isEmpty, let data = try? JSONEncoder().encode(Saved(parts: unsent, knows: knows)) else {
            return defaults.removeObject(forKey: Self.unsentKey)
        }
        defaults.set(data, forKey: Self.unsentKey)
    }

    /// This Mac's box's bridge is up (again): `box`, its id (`BoxClient`), which says whether it keeps them.
    func connected(api: OpenCodeAPI?, box: String) {
        guard let api else { return }
        self.api = api
        then { step in
            step.kept = await Self.keeps(box)
            await step.read()
        }
    }

    /// Whether `box` keeps the usage settings (`usage.settings`): this app's own box does.
    private static func keeps(_ box: String) async -> Bool {
        if BoxClient.hasEveryFeature(box) { return true }
        struct Info: Decodable { var features: [String]? }
        let info = try? await BoxClient.routes(box).value(Info.self, "GET", "kuvo/info")
        return info?.features?.contains("usage.settings") ?? false
    }

    /// Its bridge said they changed (another computer's change, or one of its routes).
    func handle(_ event: ServerEvent) {
        guard event.type == BoxUsageSettings.event else { return }
        then { await $0.read() }
    }

    /// Its bridge stopped: the panel keeps what it has; a change made meanwhile goes once it's back.
    func stopped() {
        api = nil
    }

    private func changed(_ data: Data) {
        guard var given = try? JSONDecoder().decode([String: JSONValue].self, from: data) else { return }
        if let said = given.removeValue(forKey: "knows") { knows = said }
        unsent.merge(given) { _, newer in newer }
        then { await $0.send() }
    }

    private func then(_ step: @escaping @MainActor (UsageSettingsOnBox) async -> Void) {
        let before = work
        work = Task { [weak self] in
            await before?.value
            guard let self else { return }
            await step(self)
        }
    }

    /// The parts changed here, to the box, with what this panel knows; what it answers shows.
    private func send() async {
        guard let api, kept, !unsent.isEmpty else { return }
        let parts = unsent
        var body = parts
        if let knows { body["knows"] = knows }
        do {
            let answer = try await api.client.send(try api.client.request("PUT", BoxUsageSettings.bridgePath, body: JSONValue.object(body)), as: DataEnvelope<BoxUsageSettings>.self).data
            for (name, value) in parts where unsent[name] == value { unsent[name] = nil }
            apply(answer)
        } catch let error as ServerError where error.status == 400 {
            // A part it can't take: the box's stay, and show again.
            log.info("usage settings refused: \(String(describing: error), privacy: .public)")
            for (name, value) in parts where unsent[name] == value { unsent[name] = nil }
            host.forget(Set(parts.keys))
            await read()
        } catch {
            // Not answering: they go again as it's back.
            log.info("usage settings: \(String(describing: error), privacy: .public)")
        }
    }

    /// The box's, shown; the first time, what this Mac kept before goes to it (once, on the box's word).
    private func read() async {
        // COMPAT(0.7 usage-settings-box): a box from before it kept them (no `usage.settings`): the panel keeps its own, in its stores here, and shares none, as before (it goes with #679's box updates and #631 piece H). Goes 3 months after 0.8.0.
        guard kept else { return }
        if !unsent.isEmpty { await send() }
        guard let api, unsent.isEmpty else { return }
        do {
            var answer = try await api.client.send(try api.client.request("GET", BoxUsageSettings.bridgePath), as: DataEnvelope<BoxUsageSettings>.self).data
            if !answer.imported {
                let mine = try JSONDecoder().decode(JSONValue.self, from: host.toImport())
                answer = try await api.client.send(try api.client.request("POST", BoxUsageSettings.bridgeImportPath, body: mine), as: DataEnvelope<BoxUsageSettings>.self).data
                log.info("usage settings brought to this Mac's box: \(answer.took.joined(separator: ", "), privacy: .public)")
            }
            apply(answer)
        } catch {
            log.info("usage settings: \(String(describing: error), privacy: .public)")
        }
    }

    /// The box's, shown: but a part changed here and still on its way, which comes back with its answer.
    private func apply(_ answer: BoxUsageSettings) {
        guard let settings = try? JSONEncoder().encode(answer.settings) else { return }
        host.apply(settings, except: Set(unsent.keys))
    }
}
