import ClientAccounts
import Foundation
import OpenCodeKit
import UsageKit
import os

private let log = Logger(subsystem: "run.kuvo.code", category: "usage")

/// What your accounts used, by the day, as this Mac's box states it (`api/kuvo/usage`, PROTOCOL.md
/// "Usage history"): every account Kuvo Code runs on any of your computers, read from their logs by
/// the boxes, priced and added up there, in this Mac's time zone. The menu bar's usage panel shows
/// them in place of reading the logs here (`HostHistory`) for the services the box says it covers.
/// This only asks the box and hands the days over; the box works them out.
@MainActor
final class BoxUsageHistory {
    private var api: OpenCodeAPI?
    private var reading: Task<Void, Never>?
    /// Each answer, counted: one asked before another came back isn't kept over it.
    private var asked = 0
    private var answered = 0
    /// The services this Mac's box covers, as it last said: kept between launches, so the panel
    /// doesn't read the logs here itself while the box starts.
    private var services = Set(UserDefaults.standard.stringArray(forKey: BoxUsageHistory.servicesKey) ?? [])
    private static let servicesKey = "usage.boxHistoryServices"
    private var zoneObserver: NSObjectProtocol?

    init() {
        HostHistory.shared.refresh = { [weak self] in self?.refresh() }
        HostHistory.shared.setCodexFallback = { [weak self] model in await self?.setCodexFallback(model) ?? .unreachable }
        HostHistory.shared.update(days: HostHistory.shared.days, covered: services, answered: false)
        // Another time zone: other days.
        zoneObserver = NotificationCenter.default.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.read() }
        }
    }

    /// This Mac's box's bridge is up (again).
    func connected(api: OpenCodeAPI?) {
        guard let api else { return }
        self.api = api
        fallback?.cancel()
        fallback = nil
        read()
    }

    /// Its bridge said it changed.
    func handle(_ event: ServerEvent) {
        guard event.type == BoxUsage.event else { return }
        read()
    }

    /// Its bridge stopped: what it said stays, as of when it said it, until it's back (it keeps the
    /// same); one that doesn't come back is let go (`read`'s last try).
    func stopped() {
        reading?.cancel()
        reading = nil
        api = nil
        HostHistory.shared.setAway(true)
        // Not back in two minutes: the panel reads the logs here again meanwhile.
        fallback?.cancel()
        fallback = Task { [weak self] in
            try? await Task.sleep(for: .seconds(120))
            guard !Task.isCancelled, let self, self.api == nil else { return }
            self.cover([], days: [:])
        }
    }

    private var fallback: Task<Void, Never>?
    /// This Mac's earlier Codex fallback model is on its way to the box (once).
    private var broughtFallback = false

    /// Has the box read its logs now (the panel's Refresh), and your other computers theirs.
    func refresh() {
        read(BoxUsage.bridgeRefreshPath, method: "POST")
    }

    /// Has the box price Codex's logs with another fallback model (nil: none); what came of it.
    func setCodexFallback(_ model: String?) async -> HostHistory.CodexFallbackOutcome {
        guard let api else { return .unreachable }
        asked += 1
        let number = asked
        do {
            let body = JSONValue.object(["codex": .object(["fallback": model.map(JSONValue.string) ?? .null])])
            let usage = try await api.client.send(try api.client.request("PUT", BoxUsage.bridgePricingPath, query: ["zone": TimeZone.current.identifier], body: body), as: DataEnvelope<BoxUsage>.self, patience: .seconds(60)).data
            keep(usage, number: number)
            return .applied
        } catch let error as ServerError where error.status == 400 {
            // (Not one of the models it can price with now.)
            log.info("usage pricing refused: \(String(describing: error), privacy: .public)")
            return .refused
        } catch {
            log.info("usage pricing: \(String(describing: error), privacy: .public)")
            return .unreachable
        }
    }

    private func read(_ path: String = BoxUsage.bridgePath, method: String = "GET", tries: Int = 3) {
        guard let api else { return }
        reading?.cancel()
        asked += 1
        let number = asked
        let zone = TimeZone.current.identifier
        reading = Task { [weak self] in
            do {
                let usage = try await api.client.send(try api.client.request(method, path, query: ["zone": zone]), as: DataEnvelope<BoxUsage>.self, patience: .seconds(60)).data
                guard !Task.isCancelled, let self else { return }
                self.keep(usage, number: number)
            } catch let error as ServerError where error.status == 404 {
                // A box from before it stated them: the panel reads the logs here, as it did.
                guard !Task.isCancelled, let self else { return }
                self.cover([], days: [:])
            } catch {
                // One that's starting: asked again in a while, a few times.
                if tries > 1, !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(30))
                    guard !Task.isCancelled, let self, self.api != nil else { return }
                    self.read(path, method: method, tries: tries - 1)
                    return
                }
                // Still no answer: the panel reads the logs here again, as it did, until the box answers.
                guard !Task.isCancelled, let self else { return }
                log.info("usage history: \(String(describing: error), privacy: .public)")
                self.cover([], days: [:])
            }
        }
    }

    private func keep(_ usage: BoxUsage, number: Int) {
        guard number > answered else { return }
        answered = number
        cover(Set(usage.services), days: Self.days(usage))
        let fallback = usage.services.contains("codex") ? usage.codexFallback : nil
        HostHistory.shared.update(codexFallback: fallback.map { .init(model: $0.model, choices: $0.choices, chosen: $0.chosen) })
        // The fallback model this Mac chose before its box priced Codex (the panel kept it here),
        // taken to its box once, while the box has none chosen (none counts as chosen). Goes with
        // the panel's own Codex pricing (#631 piece H), once every Mac's box has taken it.
        if let fallback, !fallback.chosen, !broughtFallback, let mine = HostHistory.localCodexFallback, fallback.choices.contains(mine) {
            broughtFallback = true
            Task { [weak self] in
                guard let self else { return }
                // (Not answered: tried again with the next answer. Refused: not one it can take, left.)
                if await self.setCodexFallback(mine) == .unreachable { self.broughtFallback = false }
            }
        }
    }

    private func cover(_ services: Set<String>, days: [String: [HostHistoryDay]]) {
        if services != self.services {
            self.services = services
            UserDefaults.standard.set(services.sorted(), forKey: Self.servicesKey)
        }
        HostHistory.shared.update(days: days, covered: services)
        if !services.contains("codex") { HostHistory.shared.update(codexFallback: nil) }
    }

    /// Each service's days, every account added up, as the panel's providers of the same names take them.
    static func days(_ usage: BoxUsage) -> [String: [HostHistoryDay]] {
        usage.totals.mapValues { days in
            days.map { day in
                HostHistoryDay(date: day.date, models: day.models.map { .init(name: $0.model, tokens: $0.tokens, cost: $0.cost) }, unknown: day.unknown, fallback: day.fallback)
            }
        }
    }
}
