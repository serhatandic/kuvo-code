import XCTest
@testable import UsageKit

/// The box reads Claude's logs and prices models as this package does (Kuvo Code's #631: usage moves
/// to the box, PROTOCOL.md "Usage history"). Both sides are held to the same synthetic fixtures and
/// expected answers, in `Packages/Box/test/fixtures/usage` (the box's `usage.test.ts` reads them too),
/// so neither can drift while both exist; and the host's days, handed over (`HostHistory`), draw as
/// this Mac's own scan would have.
final class UsageBoxParityTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("Box/test/fixtures/usage")

    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: Self.fixtures.appendingPathComponent(name))
    }

    private func json(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: fixture(name)) as? [String: Any])
    }

    func testClaudeLogsCountAndPriceAsTheBoxDoes() throws {
        let expected = try json("claude-expected.json")
        let pricing = ModelPricing(
            supplement: try PricingSupplement.decode(from: fixture("pricing-supplement.json")),
            primary: try PricingCatalogCodecs.catalogFromCompact(fixture("pricing-litellm.json")),
            secondary: try PricingCatalogCodecs.catalogFromCompact(fixture("pricing-models-dev.json"))
        )
        let files = try XCTUnwrap(expected["files"] as? [String])
        let entries = try files.flatMap { ClaudeLogUsageScanner.parseFile(try fixture($0)) }
        let since = try XCTUnwrap(OpenUsageISO8601.date(from: try XCTUnwrap(expected["since"] as? String)))
        let scan = ClaudeLogUsageScanner.aggregate(entries: ClaudeLogUsageScanner.dedup(entries), since: since, pricing: pricing)

        let days = try XCTUnwrap(expected["days"] as? [[String: Any]])
        XCTAssertEqual(scan.series.daily.map(\.date), days.map { $0["date"] as? String })
        for (day, want) in zip(scan.series.daily, days) {
            XCTAssertEqual(day.totalTokens, want["tokens"] as? Int, day.date)
            XCTAssertEqual(day.costUSD ?? -1, try XCTUnwrap(want["cost"] as? Double), accuracy: 1e-9, day.date)
            let models = try XCTUnwrap(want["models"] as? [[String: Any]])
            let mine = (scan.modelUsage?.daily.first { $0.date == day.date }?.models ?? []).sorted { $0.model < $1.model }
            XCTAssertEqual(mine.map(\.model), models.map { $0["model"] as? String }, day.date)
            XCTAssertEqual(mine.map(\.totalTokens), models.map { $0["tokens"] as? Int }, day.date)
            for (model, wanted) in zip(mine, models) {
                XCTAssertEqual(model.costUSD ?? -1, try XCTUnwrap(wanted["cost"] as? Double), accuracy: 1e-9, model.model)
            }
        }
        let unknown = try XCTUnwrap(expected["unknown"] as? [String: [String]])
        XCTAssertEqual(scan.unknownModelsByDay.mapValues { $0.sorted() }, unknown)
    }

    func testBundledPricesResolveAsTheBoxResolvesThem() throws {
        let expected = try json("pricing-expected.json")
        func bundled(_ name: String) throws -> Data {
            try Data(contentsOf: try XCTUnwrap(Bundle.openUsageResources.url(forResource: name, withExtension: "json")))
        }
        let pricing = ModelPricing(
            supplement: try PricingSupplement.decode(from: bundled("pricing_supplement")),
            primary: try PricingCatalogCodecs.catalogFromCompact(bundled("pricing_litellm_snapshot")),
            secondary: try PricingCatalogCodecs.catalogFromCompact(bundled("pricing_models_dev_snapshot"))
        )
        for (model, want) in expected {
            let found = pricing.resolve(model: model)
            guard let want = want as? [String: Any] else {
                XCTAssertNil(found, model)
                continue
            }
            let rates = try XCTUnwrap(found, model)
            func check(_ value: Double?, _ key: String) {
                if let wanted = want[key] as? Double {
                    XCTAssertEqual(value ?? -1, wanted, accuracy: 1e-12, "\(model) \(key)")
                } else {
                    XCTAssertNil(value, "\(model) \(key)")
                }
            }
            check(rates.inputPerMillion, "input")
            check(rates.outputPerMillion, "output")
            check(rates.cacheWritePerMillion, "cacheWrite")
            check(rates.cacheReadPerMillion, "cacheRead")
            check(rates.inputAbove200kPerMillion, "inputAbove")
            check(rates.outputAbove200kPerMillion, "outputAbove")
            check(rates.cacheWriteAbove200kPerMillion, "cacheWriteAbove")
            check(rates.cacheReadAbove200kPerMillion, "cacheReadAbove")
            check(rates.fastMultiplier, "fast")
        }
    }

    /// The box's days, handed over, make the scan the spend tiles draw: the same days, totals,
    /// models and unknown ones as this Mac's own scan of the same logs.
    @MainActor
    func testTheHostsDaysDrawAsTheScanWould() throws {
        let expected = try json("claude-expected.json")
        let days = try XCTUnwrap(expected["days"] as? [[String: Any]])
        let unknown = try XCTUnwrap(expected["unknown"] as? [String: [String]])
        let dates = Set(days.compactMap { $0["date"] as? String }).union(unknown.keys).sorted(by: >)
        let handed = try dates.map { date in
            let day = days.first { $0["date"] as? String == date }
            let models = try (day?["models"] as? [[String: Any]] ?? []).map { model in
                HostHistoryDay.Model(name: try XCTUnwrap(model["model"] as? String), tokens: try XCTUnwrap(model["tokens"] as? Int), cost: try XCTUnwrap(model["cost"] as? Double))
            }
            return HostHistoryDay(date: date, models: models, unknown: unknown[date] ?? [])
        }
        let scan = HostHistory.scan(handed)
        XCTAssertEqual(scan.series.daily.map(\.date), days.map { $0["date"] as? String })
        XCTAssertEqual(scan.series.daily.map(\.totalTokens), days.map { $0["tokens"] as? Int })
        for (day, want) in zip(scan.series.daily, days) {
            XCTAssertEqual(day.costUSD ?? -1, try XCTUnwrap(want["cost"] as? Double), accuracy: 1e-9)
        }
        XCTAssertEqual(scan.unknownModelsByDay.mapValues { $0.sorted() }, unknown)
    }

    /// While the host covers Claude, no Claude card reads the logs here: the main card shows the
    /// host's days once it has answered (until then, what it showed stays), the cards of your other
    /// logins none (their use is in the host's); a provider it doesn't cover reads its own.
    @MainActor
    func testWhileTheHostCoversClaudeNoCardReadsTheLogsAndOnlyTheMainOneShowsItsDays() {
        let history = HostHistory.shared
        defer { history.update(days: [:], covered: []) }
        let day = HostHistoryDay(date: "2026-11-12", models: [.init(name: "claude-opus-4-5", tokens: 10, cost: 0.5)])
        history.update(days: ["claude": [day]], covered: ["claude"], answered: false)
        XCTAssertNotNil(history.scan(for: "claude"))
        XCTAssertNil(history.scan(for: "claude")!, "nothing yet: what the card showed stays")
        history.update(days: ["claude": [day]], covered: ["claude"])
        XCTAssertEqual(history.scan(for: "claude")??.series.daily.map(\.totalTokens), [10])
        XCTAssertEqual(history.scan(for: "claude@1a2b3c4d")??.series.daily, [], "another login's card: none, what it had before gone")
        XCTAssertNil(history.scan(for: "codex"), "not covered: it reads its own")
        // Covered, with nothing in the window: an empty history, not the last one kept.
        history.update(days: [:], covered: ["claude"])
        XCTAssertEqual(history.scan(for: "claude")??.series.daily, [])
    }

    /// While both price, the box ships this package's snapshots as they are.
    func testTheBoxShipsTheseSnapshots() throws {
        let box = Self.fixtures.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("src/agents/usage/pricing")
        for name in ["pricing_litellm_snapshot", "pricing_models_dev_snapshot", "pricing_supplement"] {
            let mine = try Data(contentsOf: try XCTUnwrap(Bundle.openUsageResources.url(forResource: name, withExtension: "json")))
            XCTAssertEqual(try Data(contentsOf: box.appendingPathComponent("\(name).json")), mine, name)
        }
    }
}
