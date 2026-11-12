import ClientAccounts
import Foundation
import OpenCodeKit
import UsageKit
import os

private let log = Logger(subsystem: "run.kuvo.code", category: "usage")

/// Your plans' limits, as this Mac's box lists them (`api/kuvo/limits`'s `rows`, PROTOCOL.md "Plan
/// limits"): every account signed in to Kuvo Code on any of your computers, one row each, drawn by
/// the menu bar's usage panel in place of its own rows for the services this Mac's box reads
/// (`HostLimits`). The boxes read and share them; this only follows what this Mac's box says and
/// names the rows (KuvoClient's `UsageListing.listing`, which merges each box's own, as before, only
/// while one is from before every box listed all of them, #210, or isn't heard from by this Mac's).
@MainActor
final class BoxPlanLimits {
    /// What each box said last, by machine ("" for this Mac's).
    private var boxes: [String: BoxLimits] = [:]
    /// Where each box's bridge is, to ask it again.
    private var apis: [String: OpenCodeAPI] = [:]
    private var reads: [String: Task<Void, Never>] = [:]
    /// Each box's answers, counted: one asked before another came back isn't kept over it.
    private var asked: [String: Int] = [:]
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

    private func read(_ key: String, tries: Int = 3) {
        guard let api = apis[key] else { return }
        reads[key]?.cancel()
        let number = next(key)
        reads[key] = Task { [weak self] in
            do {
                let limits = try await api.client.send(try api.client.request("GET", BoxLimits.bridgePath), as: DataEnvelope<BoxLimits>.self).data
                guard !Task.isCancelled, let self else { return }
                self.keep(limits, from: key, number: number)
            } catch let error as ServerError where error.status == 404 {
                // A box from before it read them: none from it, and this Mac's covers nothing.
                guard !Task.isCancelled, let self else { return }
                self.boxes[key] = nil
                if key.isEmpty { self.forgetServices() }
                self.publish()
            } catch {
                // One that's starting: asked again in a while, a few times.
                if tries > 1, !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(30))
                    guard !Task.isCancelled, let self, self.apis[key] != nil else { return }
                    self.read(key, tries: tries - 1)
                    return
                }
                if !Task.isCancelled { log.info("plan limits of \(key.isEmpty ? "this Mac" : key, privacy: .public): \(String(describing: error), privacy: .public)") }
            }
        }
    }

    /// Every account across your computers, one row each: this Mac's box's list, as it is, when it
    /// has every computer this Mac reaches (this Mac's first, then each machine's by name).
    // COMPAT(0.7 limits-merge): each box is still asked, so one from before rows is merged in. Goes 3 months after 0.8.0.
    private var listing: UsageListing.Listing {
        let keys = boxes.keys.sorted { a, b in a.isEmpty != b.isEmpty ? a.isEmpty : a.localizedStandardCompare(b) == .orderedAscending }
        return UsageListing.listing(keys.compactMap { key in boxes[key].map { UsageListing.Answer(key: key, name: key.isEmpty ? nil : key, limits: $0) } })
    }

    /// Asks the box whose list the panel shows to read them again now (a bar's Refresh), which
    /// reads what its makers allow and asks the computer each account is on for those it doesn't
    /// read; every box, while their lists are merged here.
    func refreshAll() {
        let lister = listing.lister
        for (key, api) in apis where lister == nil || key == lister {
            let number = next(key)
            Task { [weak self] in
                let limits = try? await api.client.send(try api.client.request("POST", BoxLimits.bridgeRefreshPath), as: DataEnvelope<BoxLimits>.self, patience: .seconds(60)).data
                guard let self, let limits, self.apis[key] != nil else { return }
                self.keep(limits, from: key, number: number)
            }
        }
    }

    private var answered: [String: Int] = [:]

    private func next(_ key: String) -> Int {
        asked[key, default: 0] += 1
        return asked[key]!
    }

    /// An answer, kept unless one asked after it came back first.
    private func keep(_ limits: BoxLimits, from key: String, number: Int) {
        guard number > answered[key, default: 0] else { return }
        answered[key] = number
        boxes[key] = limits
        publish()
    }

    private func forgetServices() {
        services = []
        UserDefaults.standard.removeObject(forKey: Self.servicesKey)
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
        let listed = listing.accounts
        let mine = boxes[""]?.accounts ?? []
        let own = Set(mine.filter { Self.isOwnLogin($0, among: mine) }.map(\.provider))
        let rows = listed.map { listed in
            Self.row(listed, own: listed.sources.contains { $0.box.isEmpty && own.contains($0.provider) }, now: now)
        }
        HostLimits.shared.update(rows: rows, covered: services)
    }

    /// The login whose numbers the panel's own card of its service takes, as the panel reads that
    /// service: the engine's sign-in where there's one (ChatGPT's for Codex, SuperGrok's for Grok,
    /// and all of Copilot's and the rest), else the agent's own sign-in (Claude's).
    static func isOwnLogin(_ account: LimitsAccount, among accounts: [LimitsAccount]) -> Bool {
        let same = accounts.filter { $0.service == account.service }
        let own = same.first { $0.agent == nil } ?? same.first { $0.account == "default" }
        return own?.provider == account.provider
    }

    /// One account's row as the panel draws it: on this Mac where any of its boxes is this Mac's.
    static func row(_ listed: UsageListing.Account, own: Bool = false, now: Date) -> HostLimitRow {
        let account = listed.account
        return HostLimitRow(
            id: listed.id,
            providerID: account.service,
            name: account.title,
            plan: account.plan,
            meters: account.windows(at: now).map { window in
                HostLimitRow.Meter(
                    title: window.title, fraction: window.used, resetsAt: window.resetsAt, periodMinutes: window.minutes,
                    count: window.amount.map { (used: $0.used, limit: $0.limit, unit: $0.unit) }
                )
            },
            balance: account.balance.map { HostLimitRow.Balance(left: $0.left, unit: $0.unit) },
            notice: account.problem?.message,
            readAt: account.readAt(now: now),
            isLocal: listed.sources.contains { $0.box.isEmpty },
            isOwnLogin: own,
            // (The panel adds it beside a bar of its own of that name.)
            place: listed.sources.contains { $0.box.isEmpty } ? nil : Self.places(listed.sources),
            isAway: account.away
        )
    }

    /// The machines a row is from, by name ("hetzner, lokum").
    static func places(_ sources: [UsageListing.Account.Source]) -> String {
        var seen = Set<String>()
        return sources.map { $0.name ?? $0.box }.filter { seen.insert($0).inserted }.joined(separator: ", ")
    }
}
