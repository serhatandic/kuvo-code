import AppKit
import ClientAccounts
import Foundation
import Observation
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
@Observable
final class UsageSettingsOnBox {
    /// How many of the box's answers the panel has shown.
    private(set) var answered = 0
    @ObservationIgnored private var api: OpenCodeAPI?
    @ObservationIgnored private let host: HostSettings
    @ObservationIgnored private let defaults: UserDefaults
    /// One ask of the box at a time, in order: a change made here goes after what was asked before it.
    @ObservationIgnored private var work: Task<Void, Never>?
    /// Parts changed here the box hasn't taken yet (it wasn't answering, or the app quit first), each
    /// with the version of it the change was made from (`based`, `null` for none), and the cards and
    /// meters this panel knows: they go as it's back, before its own are read. With each part's
    /// version as the box last said it. Kept through a restart.
    @ObservationIgnored private var unsent: [String: JSONValue] = [:] { didSet { save() } }
    @ObservationIgnored private var based: [String: JSONValue] = [:] { didSet { save() } }
    @ObservationIgnored private var knows: JSONValue? { didSet { save() } }
    @ObservationIgnored private var versions: [String: String] = [:] { didSet { save() } }
    /// Each part as this Mac last sent it: a change turned away though the box holds this Mac's own
    /// last (its answer was lost) goes again, from the box's version.
    @ObservationIgnored private var sent: [String: JSONValue] = [:] { didSet { save() } }
    private static let unsentKey = "usage.settingsUnsent"

    init(host: HostSettings = .shared, defaults: UserDefaults = .standard) {
        self.host = host
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.unsentKey), let saved = try? JSONDecoder().decode(Saved.self, from: data) {
            unsent = saved.parts
            based = saved.based ?? [:]
            knows = saved.knows
            versions = saved.versions ?? [:]
            sent = saved.sent ?? [:]
        }
        host.onChange = { [weak self] parts in self?.changed(parts) }
        // (The import waits for the panel's layout.)
        host.onPanelStarted = { [weak self] in self?.then { await $0.read() } }
        // A change made just before quitting is kept, to go next time.
        quitting = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak host] _ in
            MainActor.assumeIsolated { host?.flush() }
        }
    }

    @ObservationIgnored private var quitting: NSObjectProtocol?

    private struct Saved: Codable {
        var parts: [String: JSONValue]
        var based: [String: JSONValue]?
        var knows: JSONValue?
        var versions: [String: String]?
        var sent: [String: JSONValue]?
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(Saved(parts: unsent, based: based, knows: knows, versions: versions, sent: sent)) else { return }
        defaults.set(data, forKey: Self.unsentKey)
    }

    /// This Mac's box's bridge is up (again). (Every box the update gate lets through keeps them,
    /// `usage.settings`.)
    func connected(api: OpenCodeAPI?) {
        guard let api else { return }
        self.api = api
        then { await $0.read() }
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
        // (What each was changed from: the version the box last said, before the first change of it still to go.)
        for name in given.keys where unsent[name] == nil { based[name] = versions[name].map(JSONValue.string) ?? .null }
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

    /// The parts changed here, to the box, with what each was made from and what this panel knows;
    /// what it answers shows (a part changed since on another computer, the box's).
    private func send() async {
        guard !unsent.isEmpty, let api else { return }
        let parts = unsent
        var body = parts
        body["based"] = .object(based.filter { parts[$0.key] != nil })
        if let knows { body["knows"] = knows }
        let before = sent
        sent.merge(parts) { _, now in now }
        do {
            let answer = try await api.client.send(try api.client.request("PUT", BoxUsageSettings.bridgePath, body: JSONValue.object(body)), as: DataEnvelope<BoxUsageSettings>.self).data
            // Turned away though what the box holds is this Mac's own last (its answer was lost):
            // still to go, from the box's version.
            let own = Set(answer.stale.filter { name in before[name].map { answer.settings[name] == $0 } ?? false })
            let stale = answer.stale.filter { !own.contains($0) }
            for (name, value) in parts {
                if own.contains(name) {
                    based[name] = answer.versions[name].map(JSONValue.string) ?? .null
                } else if unsent[name] == value {
                    unsent[name] = nil
                    based[name] = nil
                } else if !stale.contains(name) {
                    // Changed again while this went: the next goes from the version the box has now.
                    based[name] = answer.versions[name].map(JSONValue.string) ?? .null
                }
            }
            if !stale.isEmpty {
                log.info("usage settings changed on another computer meanwhile: \(stale.joined(separator: ", "), privacy: .public)")
                host.forget(Set(stale))
            }
            apply(answer)
            if !own.isEmpty { await send() }
        } catch let error as ServerError where ![404, 502, 503, 504].contains(error.status) {
            // Not a change it takes: the box's stay, and show again.
            log.info("usage settings refused: \(String(describing: error), privacy: .public)")
            for (name, value) in parts where unsent[name] == value {
                unsent[name] = nil
                based[name] = nil
            }
            host.forget(Set(parts.keys))
            await read()
        } catch {
            // Not answering, or a bridge from before them (404: one an older app's keeper still runs
            // while the update gate holds its box): they go again as it's back.
            log.info("usage settings: \(String(describing: error), privacy: .public)")
        }
    }

    /// The box's, shown; the first time, what this Mac kept before goes to it (once, on the box's
    /// word, when the panel has read its layout).
    private func read() async {
        guard api != nil else { return }
        if !unsent.isEmpty { await send() }
        guard let api, unsent.isEmpty else { return }
        do {
            var answer = try await api.client.send(try api.client.request("GET", BoxUsageSettings.bridgePath), as: DataEnvelope<BoxUsageSettings>.self).data
            if !answer.imported, host.canImport {
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
        if let availability = try? JSONEncoder().encode(answer.notificationAvailability) {
            UsageAlertAvailability.shared.apply(availability)
        }
        versions = answer.versions
        // What this Mac sent of a part the box now holds otherwise is no longer its own last: a
        // change turned away against it later isn't this Mac's own (another computer's came since).
        let still = sent.filter { answer.settings[$0.key] == $0.value }
        if still.count != sent.count { sent = still }
        guard let settings = try? JSONEncoder().encode(answer.settings) else { return }
        host.apply(settings, except: Set(unsent.keys))
        answered += 1
    }
}
