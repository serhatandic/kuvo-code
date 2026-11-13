import XCTest
@testable import UsageKit

/// The box reads Cursor's plan and usage events as this package does (Kuvo Code's #631 piece D1,
/// PROTOCOL.md "Plan limits" and "Usage history"): both sides are held to the same synthetic
/// fixtures and expected answers in `Packages/Box/test/fixtures/usage` (the box's
/// `usage-cursor.test.ts` reads them too), so neither can drift while both exist. And while the host
/// covers Cursor, its card reads nothing of Cursor and shows the host's.
@MainActor
final class UsageBoxParityCursorTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("Box/test/fixtures/usage")

    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: Self.fixtures.appendingPathComponent(name))
    }

    private func json(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: fixture(name)) as? [String: Any])
    }

    // MARK: Parity

    /// A line as the expected file keeps it.
    private func shaped(_ line: MetricLine) -> [String: Any] {
        switch line {
        case .progress(let label, let used, let limit, let format, let resetsAt, let periodDurationMs, _):
            let kind: String
            switch format {
            case .percent: kind = "percent"
            case .dollars: kind = "dollars"
            case .count(let suffix): kind = "count:\(suffix)"
            }
            return ["label": label, "used": used, "limit": limit, "format": kind,
                    "resetsAt": resetsAt.map { $0.timeIntervalSince1970 * 1000 } as Any? ?? NSNull(),
                    "periodMs": periodDurationMs.map(Double.init) as Any? ?? NSNull()]
        case .values(let label, let values, _, _, _, _):
            return ["label": label, "dollars": values.first?.number ?? -1]
        default:
            return ["label": line.label, "other": true]
        }
    }

    private func assertLines(_ got: [MetricLine], _ want: Any?, _ name: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let expected = try XCTUnwrap(want as? [[String: Any]], name, file: file, line: line)
        XCTAssertEqual(got.map(\.label), expected.map { $0["label"] as? String }, name, file: file, line: line)
        for (mine, theirs) in zip(got.map(shaped), expected) {
            for (key, value) in theirs {
                if let number = value as? Double {
                    XCTAssertEqual(try XCTUnwrap(mine[key] as? Double, "\(name) \(key)", file: file, line: line), number, accuracy: 1e-6, "\(name) \(key)", file: file, line: line)
                } else if value is NSNull {
                    XCTAssertTrue(mine[key] is NSNull, "\(name) \(key): \(String(describing: mine[key]))", file: file, line: line)
                } else {
                    XCTAssertEqual(mine[key] as? String, value as? String, "\(name) \(key)", file: file, line: line)
                }
            }
        }
    }

    private func assertMapped(_ run: () throws -> CursorMappedUsage, _ want: [String: Any], _ name: String) throws {
        do {
            let mapped = try run()
            XCTAssertNil(want["error"], name)
            XCTAssertEqual(mapped.plan, want["plan"] as? String, name)
            try assertLines(mapped.lines, want["lines"], name)
        } catch {
            XCTAssertEqual((error as? LocalizedError)?.errorDescription, want["error"] as? String, name)
        }
    }

    /// Cursor's plan, mapped as the box's `cursor-plan.ts` does: the primary usage with its pools,
    /// credits and on-demand, team seats, request-based plans, usage-summary, Grok Bot's week, the
    /// fallbacks and the plan's name.
    func testCursorsPlanMapsAsTheBoxDoes() throws {
        let cases = try XCTUnwrap(try json("cursor-plan-cases.json")["cases"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 15)
        for each in cases {
            let name = try XCTUnwrap(each["name"] as? String)
            let args = try XCTUnwrap(each["args"] as? [String: Any])
            let want = try XCTUnwrap(each["expected"] as? [String: Any])
            switch each["fn"] as? String {
            case "mapUsage":
                try assertMapped({
                    try CursorUsageMapper.mapUsage(usage: try XCTUnwrap(args["usage"] as? [String: Any]), planName: args["planName"] as? String,
                                                   creditGrants: args["creditGrants"] as? [String: Any], stripeBalanceCents: try XCTUnwrap(args["stripeBalanceCents"] as? Double))
                }, want, name)
            case "mapRequestBasedUsage":
                try assertMapped({
                    try CursorUsageMapper.mapRequestBasedUsage(args["usage"] as? [String: Any], planName: args["planName"] as? String, unavailableMessage: try XCTUnwrap(args["unavailable"] as? String))
                }, want, name)
            case "mapSummary":
                try assertMapped({
                    try CursorUsageSummaryMapper.map(summary: args["summary"] as? [String: Any], requestUsage: args["requestUsage"] as? [String: Any],
                                                     planName: args["planName"] as? String, unavailableMessage: try XCTUnwrap(args["unavailable"] as? String))
                }, want, name)
            case "grokBot":
                let line = CursorUsageMapper.mapGrokBotUsage(try XCTUnwrap(args["usage"] as? [String: Any]))
                if want["line"] is NSNull { XCTAssertNil(line, name) } else { try assertLines([try XCTUnwrap(line, name)], [want["line"] as Any], name) }
            case "fallback":
                let decision = CursorUsageMapper.shouldUseRequestBasedFallback(usage: try XCTUnwrap(args["usage"] as? [String: Any]), planName: args["planName"] as? String,
                                                                               planInfoUnavailable: try XCTUnwrap(args["planInfoUnavailable"] as? Bool))
                XCTAssertEqual(decision.shouldFallback ? decision.message : nil, want["message"] as? String, name)
            case "appendMissingOnDemand":
                var lines: [MetricLine] = []
                CursorUsageSummaryMapper.appendMissingOnDemand(from: try XCTUnwrap(args["summary"] as? [String: Any]), to: &lines)
                try assertLines(lines, want["lines"], name)
            case "planNames":
                let pairs = try XCTUnwrap(args["pairs"] as? [[Any]])
                let names = try XCTUnwrap(want["names"] as? [[String: Any]])
                for (pair, expected) in zip(pairs, names) {
                    let plan = pair[0] as? String
                    let membership = pair[1] as? String
                    XCTAssertEqual(CursorUsageMapper.routingPlanName(planInfoName: plan, membershipType: membership), expected["routing"] as? String, name)
                    XCTAssertEqual(CursorUsageMapper.resolvedPlanName(planInfoName: plan, membershipType: membership), expected["resolved"] as? String, name)
                    XCTAssertEqual(CursorUsageMapper.resolvedPlanLabel(planInfoName: plan, membershipType: membership), expected["label"] as? String, name)
                    XCTAssertEqual(CursorUsageMapper.preferredMembership(local: membership, summary: plan), expected["preferred"] as? String, name)
                }
            default:
                XCTFail("unknown case \(name)")
            }
        }
    }

    /// Cursor's usage events, parsed, priced without long-context rates, and grouped by family as
    /// the box's `cursor-history.ts` does (by the UTC day: the rows are put at each day's noon).
    func testCursorsUsageEventsCountAndPriceAsTheBoxDoes() throws {
        let expected = try json("cursor-events-expected.json")
        let pages = try XCTUnwrap(try json("cursor-events.json")["pages"] as? [Any])
        let wantPages = try XCTUnwrap(expected["pages"] as? [[String: Int]])
        var days: [String: CursorUsageDay] = [:]
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        for (page, want) in zip(pages, wantPages) {
            let parsed = try CursorUsageEvents.parsePage(try JSONSerialization.data(withJSONObject: page))
            XCTAssertEqual([parsed.events.count, parsed.rejectedEventCount, parsed.totalCount], [want["events"], want["rejected"], want["total"]])
            for event in parsed.events {
                days[DailyUsageAccumulator.dayKey(from: event.date, calendar: utc), default: CursorUsageDay(models: [:], isComplete: true)].add(event.tokens, for: event.model)
            }
        }
        let pricing = ModelPricing(
            supplement: try PricingSupplement.decode(from: fixture("pricing-cursor-supplement.json")),
            primary: try PricingCatalogCodecs.catalogFromCompact(fixture("pricing-cursor-litellm.json")),
            secondary: try PricingCatalogCodecs.catalogFromCompact(fixture("pricing-cursor-models-dev.json"))
        )
        let formatter = ISO8601DateFormatter()
        let rows = try days.flatMap { day, usage in
            try usage.models.map { model, tokens in
                CursorUsageRow(date: try XCTUnwrap(formatter.date(from: "\(day)T12:00:00Z")), model: model, tokens: tokens,
                               imputedCostDollars: pricing.estimatedCostDollars(model: model, tokens: tokens, applyLongContextRates: false))
            }
        }
        var lines: [MetricLine] = []
        let history = CursorUsageMapper.appendSpendLines(rows: rows, now: try XCTUnwrap(formatter.date(from: try XCTUnwrap(expected["now"] as? String))), pricing: pricing, to: &lines)

        let wantDays = try XCTUnwrap(expected["days"] as? [[String: Any]])
        XCTAssertEqual(history.series.daily.map(\.date), wantDays.map { $0["date"] as? String })
        for (day, want) in zip(history.series.daily, wantDays) {
            XCTAssertEqual(day.totalTokens, want["tokens"] as? Int, day.date)
            // (UsageKit's day is to the cent; the box keeps the dollars as they are, and a client rounds.)
            XCTAssertEqual(day.costUSD ?? -1, ((try XCTUnwrap(want["cost"] as? Double)) * 100).rounded() / 100, accuracy: 1e-9, day.date)
            let wantModels = try XCTUnwrap(want["models"] as? [[String: Any]])
            let families = Dictionary(grouping: wantModels) { $0["family"] as? String ?? "" }
            let mine = try XCTUnwrap(history.modelUsage?.daily.first { $0.date == day.date }).models
            XCTAssertEqual(Set(mine.map(\.model)), Set(families.keys), day.date)
            for entry in mine {
                let members = try XCTUnwrap(families[entry.model])
                XCTAssertEqual(entry.totalTokens, members.reduce(0) { $0 + ($1["tokens"] as? Int ?? 0) }, entry.model)
                XCTAssertEqual(entry.costUSD ?? -1, members.reduce(0) { $0 + ($1["cost"] as? Double ?? 0) }, accuracy: 1e-9, entry.model)
                let variants = (entry.variants ?? [ModelUsageVariant(model: entry.model, totalTokens: entry.totalTokens, costUSD: entry.costUSD)]).sorted { $0.model < $1.model }
                XCTAssertEqual(variants.map(\.model), members.map { $0["model"] as? String ?? "" }.sorted(), entry.model)
            }
            XCTAssertEqual(history.unknownModelsByDay[day.date].map { $0.sorted() }, want["unknown"] as? [String], day.date)
        }
    }

    // MARK: The card while the host covers Cursor

    private func values(_ lines: [MetricLine], _ label: String) -> [MetricValue]? {
        guard case .values(_, let values, _, _, _, _) = lines.first(where: { $0.label == label }) else { return nil }
        return values
    }

    /// While the host covers Cursor the card reads nothing of Cursor (no sign-in, no request): its
    /// limits are this Mac's own Cursor login's row's, credits included, and its spend the host's
    /// days, by family; until the host answers, none.
    func testWhileTheHostCoversCursorTheCardShowsItsAndReadsNothing() async throws {
        let history = HostHistory.shared
        let limits = HostLimits.shared
        defer {
            history.update(days: [:], covered: [])
            history.setAway(false)
            limits.update(rows: [], covered: [])
        }
        let now = try XCTUnwrap(OpenUsageISO8601.date(from: "2026-11-12T12:00:00Z"))
        let http = RoutingHTTPClient { _ in HTTPResponse(statusCode: 500, headers: [:], body: Data()) }
        let provider = CursorProvider(authStore: cursorAgentStore(), usageClient: CursorUsageClient(http: http), now: { now }, pricing: { ModelPricing.empty },
                                      usageHistoryStore: CursorUsageHistoryStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("cursor-hosted-\(UUID().uuidString)")))
        let row = HostLimitRow(id: "cursor#aaaaaaaaaaaaaaaa", providerID: "cursor", name: "Cursor", plan: "Pro",
                               meters: [.init(title: "Total usage", fraction: 0.25, resetsAt: now.addingTimeInterval(86_400), periodMinutes: 43_200),
                                        .init(title: "On-demand", fraction: 0.2, count: (used: 10, limit: 50, unit: "usd"))],
                               balance: .init(left: 18, unit: "usd"), readAt: now, isOwnLogin: true)
        limits.update(rows: [row], covered: ["cursor"])
        history.update(days: [:], covered: ["cursor"], answered: false)
        let pending = await provider.refresh()
        XCTAssertNil(pending.usageHistory, "nothing yet: what the card showed stays")
        XCTAssertNil(pending.errorCategory)

        let date = DailyUsageAccumulator.dayKey(from: now)
        history.update(days: ["cursor": [HostHistoryDay(date: date, models: [
            .init(name: "gpt-6-high-fast", tokens: 1000, cost: 0.5, family: "gpt-6"),
            .init(name: "gpt-6", tokens: 100, cost: 0.25),
        ], unknown: ["mystery"])]], covered: ["cursor"])
        let snapshot = await provider.refresh()
        XCTAssertTrue(http.requests.isEmpty, "Cursor isn't asked here")
        let usage = try XCTUnwrap(snapshot.usageHistory)
        XCTAssertEqual(usage.series.daily.map(\.totalTokens), [1100])
        let models = try XCTUnwrap(usage.modelUsage?.daily.first?.models)
        XCTAssertEqual(models.map(\.model), ["gpt-6"], "its variants under one family")
        XCTAssertEqual(models.first?.variants?.map(\.model).sorted(), ["gpt-6", "gpt-6-high-fast"])
        XCTAssertEqual(usage.unknownModelsByDay[date], ["mystery"])
        XCTAssertEqual(values(snapshot.lines, "Today")?.first?.number ?? -1, 0.75, accuracy: 1e-9)

        // Drawn with the host's limits: its meters and its credits.
        let drawn = try XCTUnwrap(limits.applied(to: ["cursor": snapshot], now: now)["cursor"])
        XCTAssertEqual(drawn.plan, "Pro")
        guard case .progress(_, let used, _, _, _, _, _) = drawn.lines.first(where: { $0.label == "Total usage" }) else { return XCTFail("no total") }
        XCTAssertEqual(used, 25, accuracy: 1e-9)
        XCTAssertEqual(values(drawn.lines, "Credits")?.first?.number, 18)
        let present = await provider.hasLocalCredentials()
        XCTAssertTrue(present)
    }
}
