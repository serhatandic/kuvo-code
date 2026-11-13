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
/// computers; what this Mac kept before goes to its box once. This only carries them: what's newest
/// and who gets it is the box's. A box from before them leaves the panel's own, as before.
@MainActor
final class UsageSettingsOnBox {
    private var api: OpenCodeAPI?
    private let host: HostSettings
    /// One ask of the box at a time, in order: a change made here goes after what was asked before it.
    private var work: Task<Void, Never>?
    /// Parts changed here the box hasn't taken yet (it wasn't answering): they go as it's back, before its own are read.
    private var unsent: [String: JSONValue] = [:]

    init(host: HostSettings = .shared) {
        self.host = host
        host.onChange = { [weak self] parts in self?.changed(parts) }
    }

    /// This Mac's box's bridge is up (again).
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

    private func changed(_ parts: Data) {
        guard let given = try? JSONDecoder().decode([String: JSONValue].self, from: parts) else { return }
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

    /// The parts changed here, to the box; what it answers shows.
    private func send() async {
        guard let api, !unsent.isEmpty else { return }
        let parts = unsent
        do {
            let answer = try await api.client.send(try api.client.request("PUT", BoxUsageSettings.bridgePath, body: JSONValue.object(parts)), as: DataEnvelope<BoxUsageSettings>.self).data
            for (name, value) in parts where unsent[name] == value { unsent[name] = nil }
            apply(answer)
        } catch let error as ServerError where error.status == 400 || error.status == 404 {
            // Not a part it takes (a box from before them, or a part it can't): the box's stay.
            log.info("usage settings refused: \(String(describing: error), privacy: .public)")
            for (name, value) in parts where unsent[name] == value { unsent[name] = nil }
        } catch {
            // Not answering: they go again as it's back.
            log.info("usage settings: \(String(describing: error), privacy: .public)")
        }
    }

    /// The box's, shown; the first time, what this Mac kept before goes to it (once, on the box's word).
    private func read() async {
        if !unsent.isEmpty { await send() }
        guard let api, unsent.isEmpty else { return }
        do {
            var answer = try await api.client.send(try api.client.request("GET", BoxUsageSettings.bridgePath), as: DataEnvelope<BoxUsageSettings>.self).data
            if !answer.imported {
                let mine = try JSONDecoder().decode(JSONValue.self, from: host.current(withCodexFallback: true))
                answer = try await api.client.send(try api.client.request("POST", BoxUsageSettings.bridgeImportPath, body: mine), as: DataEnvelope<BoxUsageSettings>.self).data
                log.info("usage settings brought to this Mac's box: \(answer.took.joined(separator: ", "), privacy: .public)")
            }
            apply(answer)
        } catch let error as ServerError where error.status == 404 {
            // A box from before them: the panel keeps its own.
            return
        } catch {
            log.info("usage settings: \(String(describing: error), privacy: .public)")
        }
    }

    private func apply(_ answer: BoxUsageSettings) {
        guard let settings = try? JSONEncoder().encode(answer.settings) else { return }
        host.apply(settings)
    }
}
