import XCTest
@testable import UsageKit

/// The box reads Grok's transcripts and the engine's hosted spend as this package does (Kuvo Code's
/// #631 piece C, PROTOCOL.md "Usage history"): both sides are held to the same synthetic fixtures and
/// expected answers in `box/test/fixtures/usage` (the box's `usage-grok-hosted.test.ts`
/// reads them too), so neither can drift while both exist. And while the host covers OpenCode or
/// Grok, their cards show the host's days and read nothing here.
@MainActor
final class UsageBoxParityGrokOpenCodeTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("box/test/fixtures/usage")

    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: Self.fixtures.appendingPathComponent(name))
    }

    private func json(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: fixture(name)) as? [String: Any])
    }

    /// The scan's priced days and models, as the expected file keeps them.
    private func assertDays(_ scan: LogUsageScan, _ days: [[String: Any]], file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(scan.series.daily.map(\.date), days.map { $0["date"] as? String }, file: file, line: line)
        for (day, want) in zip(scan.series.daily, days) {
            XCTAssertEqual(day.totalTokens, want["tokens"] as? Int, day.date, file: file, line: line)
            XCTAssertEqual(day.costUSD ?? -1, try XCTUnwrap(want["cost"] as? Double), accuracy: 1e-9, day.date, file: file, line: line)
            let models = try XCTUnwrap(want["models"] as? [[String: Any]])
            let mine = (scan.modelUsage?.daily.first { $0.date == day.date }?.models ?? []).sorted { $0.model < $1.model }
            XCTAssertEqual(mine.map(\.model), models.map { $0["model"] as? String }, day.date, file: file, line: line)
            XCTAssertEqual(mine.map(\.totalTokens), models.map { $0["tokens"] as? Int }, day.date, file: file, line: line)
            for (model, wanted) in zip(mine, models) {
                XCTAssertEqual(model.costUSD ?? -1, try XCTUnwrap(wanted["cost"] as? Double), accuracy: 1e-9, model.model, file: file, line: line)
            }
        }
    }

    // MARK: Parity

    /// Grok's transcripts count, price and deduplicate as the box's `grok-log.ts` does: its own costs
    /// (by model, or the turn's for one model), priced where missing, clamps, a copied event once per
    /// model, unknown models, lines that aren't completed turns.
    func testGrokTranscriptsCountAndPriceAsTheBoxDoes() throws {
        let expected = try json("grok-expected.json")
        let pricing = ModelPricing(
            supplement: try PricingSupplement.decode(from: fixture("pricing-supplement.json")),
            primary: try PricingCatalogCodecs.catalogFromCompact(fixture("pricing-grok-litellm.json")),
            secondary: try PricingCatalogCodecs.catalogFromCompact(fixture("pricing-grok-models-dev.json"))
        )
        let files = try XCTUnwrap(expected["files"] as? [String])
        let entries = try files.flatMap { GrokLogUsageScanner.parseFile(try fixture($0)) }
        let since = try XCTUnwrap(OpenUsageISO8601.date(from: try XCTUnwrap(expected["since"] as? String)))
        let scan = GrokLogUsageScanner.aggregate(entries: GrokLogUsageScanner.dedup(entries), since: since, pricing: pricing)
        try assertDays(scan, try XCTUnwrap(expected["days"] as? [[String: Any]]))
        XCTAssertEqual(scan.unknownModelsByDay.mapValues { $0.sorted() }, try XCTUnwrap(expected["unknown"] as? [String: [String]]))
    }

    /// The engine's hosted spend counts as the box's `engine-hosted.ts` does: the same databases, made
    /// from the same SQL, read by each side's own query (sqlite3 here, `bun:sqlite` there).
    func testTheEnginesHostedSpendCountsAsTheBoxDoes() async throws {
        let expected = try json("opencode-hosted-expected.json")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("usage-hosted-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let sqlite = SQLiteCLIAccessor()
        let databases = try XCTUnwrap(expected["databases"] as? [String: String])
        for (name, sql) in databases {
            // (Its comments left out: sqlite3 takes the SQL as an argument, and one starting `--` as an option.)
            let statements = String(decoding: try fixture(sql), as: UTF8.self).split(separator: "\n").filter { !$0.hasPrefix("--") }.joined(separator: "\n")
            try sqlite.execute(path: folder.appendingPathComponent(name).path, sql: statements)
        }
        let paths = try OpenCodePaths.databaseFiles(in: folder.path)
        XCTAssertEqual(paths.count, 2)
        let scanner = OpenCodeUsageScanner(sqlite: sqlite, databasePaths: { paths })
        let now = try XCTUnwrap(OpenUsageISO8601.date(from: try XCTUnwrap(expected["now"] as? String)))
        let scanned = try await scanner.scan(now: now)
        let scan = try XCTUnwrap(scanned).logScan
        try assertDays(scan, try XCTUnwrap(expected["days"] as? [[String: Any]]))
        XCTAssertEqual(scan.unknownModelsByDay, [:])
    }

    // MARK: The cards while the host covers them

    private func hostDay(_ date: String, _ model: String, tokens: Int, cost: Double) -> HostHistoryDay {
        HostHistoryDay(date: date, models: [.init(name: model, tokens: tokens, cost: cost)])
    }

    private func values(_ lines: [MetricLine], _ label: String) -> [MetricValue]? {
        guard case .values(_, let values, _, _, _, _) = lines.first(where: { $0.label == label }) else { return nil }
        return values
    }

    /// While the host covers OpenCode the card reads no database: until it answers, no spend and no
    /// "not detected"; then its days, billed (not estimated); and whether there's any is the host's.
    func testWhileTheHostCoversOpenCodeTheCardShowsItsDaysAndReadsNoDatabase() async throws {
        let history = HostHistory.shared
        defer {
            history.update(days: [:], covered: [])
            history.setAway(false)
        }
        let now = try XCTUnwrap(OpenUsageISO8601.date(from: "2026-11-12T12:00:00Z"))
        let local = OpenCodeFakeSQLite(data: ["/oc/opencode.db": "[" + openCodeRow("2026-11-12T10:00:00.000Z", "9.0", 999, "glm-5.2", "opencode-go") + "]"])
        let provider = OpenCodeProvider(
            authStore: openCodeAuthStore(),
            usageClient: OpenCodeUsageClient(http: FakeHTTPClient(response: HTTPResponse(statusCode: 500, headers: [:], body: Data()))),
            usageScanner: OpenCodeUsageScanner(sqlite: local, databasePaths: { ["/oc/opencode.db"] }),
            now: { now }
        )

        history.update(days: [:], covered: ["opencode"], answered: false)
        let pending = await provider.refresh()
        XCTAssertNil(pending.usageHistory, "nothing yet: what the card showed stays")
        XCTAssertNil(pending.errorCategory)
        let meanwhile = await provider.hasLocalCredentials()
        XCTAssertTrue(meanwhile, "until the host answers, the database here says whether there's any")

        history.update(days: [:], covered: ["opencode"])
        let none = await provider.hasLocalCredentials()
        XCTAssertFalse(none, "the database here has use, but once the host answers it's the host's to say")

        let date = DailyUsageAccumulator.dayKey(from: now)
        history.update(days: ["opencode": [hostDay(date, "kimi-k3", tokens: 1100, cost: 0.75)]], covered: ["opencode"])
        let snapshot = await provider.refresh()
        let usage = try XCTUnwrap(snapshot.usageHistory)
        XCTAssertEqual(usage.series.daily.map(\.totalTokens), [1100], "the host's, not the 999 tokens in the database here")
        XCTAssertEqual(values(snapshot.lines, "Today"), [MetricValue(number: 0.75, kind: .dollars, estimated: false), MetricValue(number: 1100, kind: .count, label: "tokens")])
        guard case .chart(_, _, let note) = snapshot.lines.first(where: { $0.label == "Usage Trend" }) else {
            return XCTFail("expected a Usage Trend chart line")
        }
        XCTAssertEqual(note, "From your OpenCode usage history")
        let some = await provider.hasLocalCredentials()
        XCTAssertTrue(some)
    }

    /// While the host covers Grok the card reads no transcript: it shows the host's days.
    func testWhileTheHostCoversGrokTheCardShowsItsDaysAndReadsNoTranscripts() async throws {
        let history = HostHistory.shared
        defer {
            history.update(days: [:], covered: [])
            history.setAway(false)
        }
        let now = try XCTUnwrap(OpenUsageISO8601.date(from: "2026-11-12T12:00:00Z"))
        let home = try GrokLogFixture.makeHome(files: [
            "here/updates.jsonl": GrokLogFixture.completedTurn(timestamp: "2026-11-12T10:00:00.000Z", model: "grok-4.6-build", input: 999, costUsdTicks: 10_000_000_000)
        ])
        defer { try? FileManager.default.removeItem(at: home) }
        let files = FakeFiles([GrokAuthStore.authPath: #"{"https://auth.x.ai::client":{"key":"token","refresh_token":"refresh","expires_at":"2026-12-01T00:00:00.000Z"}}"#])
        let provider = GrokProvider(
            authStore: GrokAuthStore(files: files, now: { now }, hostSecret: { nil }),
            usageClient: GrokUsageClient(httpClient: FakeHTTPClient(response: HTTPResponse(statusCode: 200, headers: [:], body: GrokCreditsFixtures.capturedResponseBody))),
            logUsageScanner: GrokLogFixture.scanner(home: home),
            now: { now },
            pricing: { ModelPricing.empty }
        )
        let date = DailyUsageAccumulator.dayKey(from: now)
        history.update(days: [:], covered: ["grok"], answered: false)
        let pending = await provider.refresh()
        XCTAssertNil(pending.usageHistory, "nothing yet: what the card showed stays")

        history.update(days: ["grok": [hostDay(date, "grok-5", tokens: 1100, cost: 0.5)]], covered: ["grok"])
        let snapshot = await provider.refresh()
        let usage = try XCTUnwrap(snapshot.usageHistory)
        XCTAssertEqual(usage.series.daily.map(\.totalTokens), [1100], "the host's, not the 999 tokens in the transcript here")
        guard case .chart(_, _, let note) = snapshot.lines.first(where: { $0.label == "Usage Trend" }) else {
            return XCTFail("expected a Usage Trend chart line")
        }
        XCTAssertEqual(note, "From your Grok usage history (estimated)")
        XCTAssertEqual(history.scan(for: "grok@1a2b3c4d")??.series.daily, [], "another login's card: none")
    }
}

