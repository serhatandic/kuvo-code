import ClientAccounts
import Foundation
import OpenCodeKit
import UsageKit
import os

private let log = Logger(subsystem: "run.kuvo.code", category: "usage")

/// Each box's plan limits, as its agents bridge states them (`api/kuvo/limits`, PROTOCOL.md "Plan
/// limits"): this Mac's and each machine's, one row per account signed in to Kuvo Code there, drawn
/// by the menu bar's usage panel in place of its own rows for the services this Mac's box reads
/// (`HostLimits`). The box reads them; this only follows what it says and names the rows.
@MainActor
final class BoxPlanLimits {
    /// What each box said last, by machine ("" for this Mac's).
    private var boxes: [String: BoxLimits] = [:]
    /// Where each box's bridge is, to ask it again.
    private var apis: [String: OpenCodeAPI] = [:]
    private var reads: [String: Task<Void, Never>] = [:]
    /// The services this Mac's box reads, as it last said: kept between launches, so the panel's own
    /// rows (yours, outside Kuvo Code) don't show while the box starts.
    private var services = Set(UserDefaults.standard.stringArray(forKey: BoxPlanLimits.servicesKey) ?? [])
    private static let servicesKey = "usage.boxServices"

    init() {
        HostLimits.shared.refresh = { [weak self] in self?.refreshAll() }
        publish()
    }

    /// A box's bridge is up (again): what it has is read.
    func connected(_ machine: String?, api: OpenCodeAPI?) {
        let key = machine ?? ""
        guard let api else { return }
        apis[key] = api
        read(key)
    }

    /// Its bridge said they changed.
    func handle(_ event: ServerEvent, machine: String?) {
        guard event.type == BoxLimits.event else { return }
        read(machine ?? "")
    }

    /// Its bridge stopped, or the machine went: its rows go.
    func stopped(_ machine: String?) {
        let key = machine ?? ""
        reads[key]?.cancel()
        reads[key] = nil
        apis[key] = nil
        guard boxes.removeValue(forKey: key) != nil else { return }
        publish()
    }

    private func read(_ key: String) {
        guard let api = apis[key] else { return }
        reads[key]?.cancel()
        reads[key] = Task { [weak self] in
            do {
                let limits = try await api.client.send(try api.client.request("GET", BoxLimits.bridgePath), as: DataEnvelope<BoxLimits>.self).data
                guard !Task.isCancelled, let self else { return }
                self.boxes[key] = limits
                self.publish()
            } catch {
                // A box from before it read them (404), or one that's starting: none from it yet.
                if !Task.isCancelled { log.info("plan limits of \(key.isEmpty ? "this Mac" : key, privacy: .public): \(String(describing: error), privacy: .public)") }
            }
        }
    }

    /// Asks every box to read them again now (a bar's Refresh): each reads what its makers allow.
    func refreshAll() {
        for (key, api) in apis {
            Task { [weak self] in
                let limits = try? await api.client.send(try api.client.request("POST", BoxLimits.bridgeRefreshPath), as: DataEnvelope<BoxLimits>.self, patience: .seconds(60)).data
                guard let self, let limits, self.apis[key] != nil else { return }
                self.boxes[key] = limits
                self.publish()
            }
        }
    }

    private func publish() {
        if let mine = boxes[""] {
            let said = Set(mine.services)
            if said != services {
                services = said
                UserDefaults.standard.set(said.sorted(), forKey: Self.servicesKey)
            }
        }
        let now = Date.now
        // This Mac's first, then each machine's by name.
        let keys = boxes.keys.sorted { a, b in a.isEmpty != b.isEmpty ? a.isEmpty : a.localizedStandardCompare(b) == .orderedAscending }
        let rows = keys.flatMap { key in
            (boxes[key]?.accounts ?? []).map { Self.row($0, machine: key.isEmpty ? nil : key, now: now) }
        }
        HostLimits.shared.update(rows: rows, covered: services)
    }

    /// One account as the panel draws it: "Claude · Work", and on a machine its name after.
    static func row(_ account: LimitsAccount, machine: String?, now: Date) -> HostLimitRow {
        HostLimitRow(
            id: "\(machine ?? "mac")/\(account.provider)",
            providerID: account.service,
            name: machine.map { "\(account.title) · \($0)" } ?? account.title,
            plan: account.plan,
            meters: account.windows(at: now).map { window in
                HostLimitRow.Meter(
                    title: window.title, fraction: window.used, resetsAt: window.resetsAt, periodMinutes: window.minutes,
                    count: window.amount.map { (used: $0.used, limit: $0.limit, unit: $0.unit) }
                )
            },
            balance: account.balance.map { HostLimitRow.Balance(left: $0.left, unit: $0.unit) },
            notice: account.problem?.message,
            readAt: account.readAt(now: now)
        )
    }
}
