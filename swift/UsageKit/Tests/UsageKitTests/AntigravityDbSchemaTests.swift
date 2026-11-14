import XCTest
@testable import UsageKit

/// Scanner behavior against real SQLite databases and real conversation-store layouts: schema
/// variations, WAL-mode reads, and how stores are discovered under `~/.gemini`.
final class AntigravityDbSchemaTests: XCTestCase {
    private let now = antigravityNow
    private let pricing = antigravityPricing

    private func makeDatabaseDirectory() throws -> (url: URL, path: String) {
        let fixture = try makeAntigravityDatabaseDirectory(for: self)
        return (fixture.url, fixture.paths[0])
    }

    func testDiscoversAntigravityConversationStoresUnderGeminiHome() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        for path in ["antigravity-cli/conversations", "antigravity-ide", "tmp/conversations", "antigravity/conversations"] {
            try FileManager.default.createDirectory(
                at: home.appendingPathComponent(path), withIntermediateDirectories: true
            )
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }

        XCTAssertEqual(
            try AntigravityDbUsageScanner.conversationsDirectories(underGeminiHome: home.path),
            [
                home.path + "/antigravity/conversations",
                home.path + "/antigravity-cli/conversations",
                home.path + "/antigravity-ide/conversations",
            ]
        )
        XCTAssertEqual(
            try AntigravityDbUsageScanner.conversationsDirectories(underGeminiHome: "/nonexistent-\(UUID().uuidString)"),
            []
        )
    }

    /// A `~/.gemini` that cannot be listed is a real problem, not "no Antigravity usage".
    func testUnlistableGeminiHomeIsReportedInsteadOfReadAsNoUsage() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data().write(to: home)
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }

        XCTAssertThrowsError(try AntigravityDbUsageScanner.conversationsDirectories(underGeminiHome: home.path))

        let recorder = Counter()
        let scanner = AntigravityDbUsageScanner(
            sqlite: AntigravityFakeSQLite(),
            conversationsDirectories: { try AntigravityDbUsageScanner.conversationsDirectories(underGeminiHome: home.path) },
            readFailureWarning: { _ in _ = recorder.next() }
        )

        let failedScan = await scanner.scan(now: now, pricing: pricing)
        XCTAssertNil(failedScan)
        XCTAssertEqual(recorder.next(), 1)
    }

    /// A store whose `conversations` directory cannot be read is a real problem, not "no usage":
    /// it must reach the read-failure reporter instead of being dropped as a missing store.
    func testUnreadableConversationStoreIsReportedInsteadOfReadAsNoUsage() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(
            at: home.appendingPathComponent("antigravity-ide"), withIntermediateDirectories: true
        )
        try Data().write(to: home.appendingPathComponent("antigravity-ide/conversations"))
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }

        let recorder = Counter()
        let scanner = AntigravityDbUsageScanner(
            sqlite: AntigravityFakeSQLite(),
            conversationsDirectories: { try AntigravityDbUsageScanner.conversationsDirectories(underGeminiHome: home.path) },
            readFailureWarning: { _ in _ = recorder.next() }
        )

        let failedScan = await scanner.scan(now: now, pricing: pricing)
        XCTAssertNil(failedScan)
        XCTAssertEqual(recorder.next(), 1)
    }

    /// Two stores that resolve to the same directory must not count their conversations twice.
    func testSymlinkedDuplicateStoresAreScannedOnce() async throws {
        let fixture = try makeDatabaseDirectory()
        let link = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: fixture.url)
        addTeardownBlock { try? FileManager.default.removeItem(at: link) }

        let timestamp = UInt64(now.timeIntervalSince1970) - 3_600
        let blob = antigravityGenerationBlob(model: "gemini-3.6-flash", input: 10, output: 5, timestamp: timestamp)
        let sqlite = AntigravityFakeSQLite(rowsByPath: [
            fixture.path: [.init(index: 0, blob: blob)],
            link.appendingPathComponent("conversation.db").path: [.init(index: 0, blob: blob)],
        ])
        let scanner = AntigravityDbUsageScanner(
            sqlite: sqlite,
            conversationsDirectories: { [fixture.url.path, link.path] }
        )

        let result = await scanner.scan(now: now, pricing: pricing)
        XCTAssertEqual(try XCTUnwrap(result).series.daily.first?.totalTokens, 15)
    }

    /// Reads a real SQLite database through `sqlite3`, so the `steps` correlation and the
    /// missing-`steps` fallback run against the actual schema.
    func testEventsWithoutAnyTimestampAreNotAttributedToDatabaseModificationDay() async throws {
        let fixture = try makeDatabaseDirectory()
        let path = fixture.path
        let sqlite = SQLiteCLIAccessor()
        let dated = UInt64(now.timeIntervalSince1970) - 3_600
        let datedHex = antigravityHex(antigravityGenerationBlob(model: "gemini-3.6-flash", input: 10, output: 5, timestamp: dated))
        let undatedHex = antigravityHex(antigravityGenerationBlob(model: "gemini-3.6-flash", input: 1_000, output: 500, timestamp: nil))
        try sqlite.execute(path: path, sql: """
            CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
            CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);
            INSERT INTO gen_metadata (idx, data) VALUES (0, X'\(datedHex)'), (1, X'\(undatedHex)');
            """)
        let expectedDay = DailyUsageAccumulator.dayKey(from: Date(timeIntervalSince1970: TimeInterval(dated)))

        try FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: path)
        let firstScan = await AntigravityDbUsageScanner(
            sqlite: sqlite, conversationsDirectories: { [fixture.url.path] }
        ).scan(now: now, pricing: pricing)
        let first = try XCTUnwrap(firstScan)

        let later = now.addingTimeInterval(86_400)
        try FileManager.default.setAttributes([.modificationDate: later], ofItemAtPath: path)
        let secondScan = await AntigravityDbUsageScanner(
            sqlite: sqlite, conversationsDirectories: { [fixture.url.path] }
        ).scan(now: later, pricing: pricing)
        let second = try XCTUnwrap(secondScan)

        XCTAssertEqual(first.series.daily.map(\.date), [expectedDay])
        XCTAssertEqual(first.series.daily.first?.totalTokens, 15)
        XCTAssertEqual(second.series.daily, first.series.daily)

        // The same rows without a `steps` table use the legacy query and still skip the undated event.
        try sqlite.execute(path: path, sql: "DROP TABLE steps")
        let legacyScan = await AntigravityDbUsageScanner(
            sqlite: sqlite, conversationsDirectories: { [fixture.url.path] }
        ).scan(now: later, pricing: pricing)
        let legacy = try XCTUnwrap(legacyScan)
        XCTAssertEqual(legacy.series.daily, first.series.daily)
    }

    /// An older store can carry a `steps` table without a `metadata` column. Probing the column keeps
    /// the data query off `metadata` instead of failing every read with "no such column".
    func testStepsTableWithoutMetadataColumnStillReadsGenerations() async throws {
        let fixture = try makeDatabaseDirectory()
        let sqlite = SQLiteCLIAccessor()
        let dated = UInt64(now.timeIntervalSince1970) - 3_600
        let datedHex = antigravityHex(antigravityGenerationBlob(model: "gemini-3.6-flash", input: 10, output: 5, timestamp: dated))
        try sqlite.execute(path: fixture.path, sql: """
            CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
            CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type TEXT);
            INSERT INTO gen_metadata (idx, data) VALUES (0, X'\(datedHex)');
            """)

        let scan = await AntigravityDbUsageScanner(
            sqlite: sqlite, conversationsDirectories: { [fixture.url.path] }
        ).scan(now: now, pricing: pricing)
        XCTAssertEqual(try XCTUnwrap(scan).series.daily.first?.totalTokens, 15)
    }

    /// A store that gains step timestamps later is re-probed, and the rows dropped for having no
    /// timestamp are read again — without waiting for a restart.
    func testDatabaseThatGainsStepTimestampsIsReReadWithoutRestart() async throws {
        let fixture = try makeDatabaseDirectory()
        let sqlite = SQLiteCLIAccessor()
        let timestamp = UInt64(now.timeIntervalSince1970) - 3_600
        let undatedHex = antigravityHex(antigravityGenerationBlob(model: "gemini-3.6-flash", input: 10, output: 5, timestamp: nil))
        try sqlite.execute(path: fixture.path, sql: """
            CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
            INSERT INTO gen_metadata (idx, data) VALUES (0, X'\(undatedHex)');
            """)
        let scanner = AntigravityDbUsageScanner(sqlite: sqlite, conversationsDirectories: { [fixture.url.path] })

        let undatedScan = await scanner.scan(now: now, pricing: pricing)
        XCTAssertNil(undatedScan)

        let stepHex = antigravityHex(antigravityStepMetadata(timestamp: timestamp))
        try sqlite.execute(path: fixture.path, sql: """
            CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);
            INSERT INTO steps (idx, metadata) VALUES (0, X'\(stepHex)');
            """)

        let scan = await scanner.scan(now: now, pricing: pricing)
        XCTAssertEqual(try XCTUnwrap(scan).series.daily.first?.totalTokens, 15)
    }

    /// WAL-mode databases are what Antigravity actually writes; the read-only open falls back to a
    /// `query_only` connection when the `-shm` sidecar cannot be opened read-only.
    func testReadsAWALModeDatabase() async throws {
        let fixture = try makeDatabaseDirectory()
        let sqlite = SQLiteCLIAccessor()
        let dated = UInt64(now.timeIntervalSince1970) - 3_600
        let datedHex = antigravityHex(antigravityGenerationBlob(model: "gemini-3.6-flash", input: 10, output: 5, timestamp: dated))
        let stepHex = antigravityHex(antigravityStepMetadata(timestamp: dated))
        try sqlite.execute(path: fixture.path, sql: """
            PRAGMA journal_mode = WAL;
            CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
            CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);
            INSERT INTO gen_metadata (idx, data) VALUES (0, X'\(datedHex)');
            INSERT INTO steps (idx, metadata) VALUES (0, X'\(stepHex)');
            """)
        XCTAssertEqual(try sqlite.queryValue(path: fixture.path, sql: "PRAGMA journal_mode"), "wal")

        let scan = await AntigravityDbUsageScanner(
            sqlite: sqlite, conversationsDirectories: { [fixture.url.path] }
        ).scan(now: now, pricing: pricing)
        XCTAssertEqual(try XCTUnwrap(scan).series.daily.first?.totalTokens, 15)
    }
}
