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
        HostHistory.shared.update(days: HostHistory.shared.days, covered: services)
        // Another time zone: other days.
        zoneObserver = NotificationCenter.default.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.read() }
        }
    }

    /// This Mac's box's bridge is up (again).
    func connected(api: OpenCodeAPI?) {
        guard let api else { return }
        self.api = api
        read()
    }

    /// Its bridge said it changed.
    func handle(_ event: ServerEvent) {
        guard event.type == BoxUsage.event else { return }
        read()
    }

    /// Its bridge stopped: what it said stays until it's back (it keeps the same).
    func stopped() {
        reading?.cancel()
        reading = nil
        api = nil
    }

    /// Has the box read its logs now (the panel's Refresh), and your other computers theirs.
    func refresh() {
        read(BoxUsage.bridgeRefreshPath, method: "POST")
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
                if !Task.isCancelled { log.info("usage history: \(String(describing: error), privacy: .public)") }
            }
        }
    }

    private func keep(_ usage: BoxUsage, number: Int) {
        guard number > answered else { return }
        answered = number
        cover(Set(usage.services), days: Self.days(usage))
    }

    private func cover(_ services: Set<String>, days: [String: [HostHistoryDay]]) {
        if services != self.services {
            self.services = services
            UserDefaults.standard.set(services.sorted(), forKey: Self.servicesKey)
        }
        HostHistory.shared.update(days: days, covered: services)
    }

    /// Each service's days, every account added up, as the panel's providers of the same names take them.
    static func days(_ usage: BoxUsage) -> [String: [HostHistoryDay]] {
        usage.totals.mapValues { days in
            days.map { day in
                HostHistoryDay(date: day.date, models: day.models.map { .init(name: $0.model, tokens: $0.tokens, cost: $0.cost) }, unknown: day.unknown)
            }
        }
    }
}
