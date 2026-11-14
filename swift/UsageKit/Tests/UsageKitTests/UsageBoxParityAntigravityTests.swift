import XCTest
@testable import UsageKit

/// Both decoders and the read-only SQLite scans are held to the same synthetic protobufs and
/// expected answers. No installed Antigravity home, sign-in or language server is consulted.
final class UsageBoxParityAntigravityTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Event: Decodable {
            var modelID: String?
            var label: String?
            var inputTokens: Int
            var outputTokens: Int
            var cacheReadTokens: Int
            var timestampSeconds: Int64
        }
        struct Case: Decodable {
            var name: String
            var hex: String
            var stepHex: String?
            var expected: Event?
        }
        struct Day: Decodable {
            var date: String
            var tokens: Int
            var cost: Double
            var model: String
            var unknown: [String]?
        }
        struct Bounded: Decodable {
            struct Row: Decodable {
                var `case`: Int
                var dataBytes: Int?
                var stepBytes: Int?
            }
            var rows: [Row]
            var events: Int
            var tokens: Int
            var cost: Double
        }
        var bounded: Bounded
        var now: String
        var cases: [Case]
        var days: [Day]
    }
    private func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("box/test/fixtures/usage/antigravity-blobs.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }
    func testProtobufDecoderMatchesTheBox() throws {
        for each in try fixture().cases {
            let got = AntigravityProtoDecoder.generationEvent(
                from: try XCTUnwrap(AntigravityDbUsageScanner.bytes(fromHex: each.hex)),
                stepMetadata: each.stepHex.flatMap(AntigravityDbUsageScanner.bytes(fromHex:))
            )
            guard let expected = each.expected else { XCTAssertNil(got, each.name); continue }
            XCTAssertEqual(got?.modelID, expected.modelID, each.name)
            XCTAssertEqual(got?.label, expected.label, each.name)
            XCTAssertEqual(got?.inputTokens, expected.inputTokens, each.name)
            XCTAssertEqual(got?.outputTokens, expected.outputTokens, each.name)
            XCTAssertEqual(got?.cacheReadTokens, expected.cacheReadTokens, each.name)
            XCTAssertEqual(got?.timestampSeconds, expected.timestampSeconds, each.name)
        }
    }
    func testSQLiteTokensCostsAndUnknownModelsMatchTheBox() async throws {
        let fixture = try fixture()
        let directory = try makeAntigravityDatabaseDirectory(for: self)
        let path = try XCTUnwrap(directory.paths.first)
        let sqlite = SQLiteCLIAccessor()
        var sql = "CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB);"
        for (index, each) in fixture.cases.enumerated() {
            sql += "INSERT INTO gen_metadata VALUES (\(index),X'\(each.hex)');"
            if let step = each.stepHex { sql += "INSERT INTO steps VALUES (\(index),X'\(step)');" }
        }
        try sqlite.execute(path: path, sql: sql)
        let scanner = AntigravityDbUsageScanner(sqlite: sqlite, conversationsDirectories: { [directory.url.path] })
        let result = await scanner.scan(now: try XCTUnwrap(OpenUsageISO8601.date(from: fixture.now)), pricing: antigravityPricing)
        let scan = try XCTUnwrap(result)
        XCTAssertEqual(scan.series.daily.map(\.date), fixture.days.map(\.date))
        for (day, expected) in zip(scan.series.daily, fixture.days) {
            XCTAssertEqual(day.totalTokens, expected.tokens, expected.date)
            XCTAssertEqual(day.costUSD ?? -1, expected.cost, accuracy: 1e-9, expected.date)
            let models = try XCTUnwrap(scan.modelUsage?.daily.first { $0.date == day.date }).models
            XCTAssertEqual(models.map(\.model), [expected.model], expected.date)
            XCTAssertEqual(models.first?.costUSD ?? -1, expected.cost, accuracy: 1e-9, expected.date)
            XCTAssertEqual(scan.unknownModelsByDay[day.date]?.sorted(), expected.unknown, expected.date)
        }
    }
    func testBlobCapAndOversizedStepTimingMatchTheBox() async throws {
        let fixture = try fixture()
        let directory = try makeAntigravityDatabaseDirectory(for: self)
        let path = try XCTUnwrap(directory.paths.first)
        let sqlite = SQLiteCLIAccessor()
        var sql = "CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB);"
        for (index, row) in fixture.bounded.rows.enumerated() {
            let each = fixture.cases[row.case]
            let blob: String
            if let count = row.dataBytes {
                blob = "CAST(X'\(each.hex)' || zeroblob(\(count - each.hex.count / 2)) AS BLOB)"
            } else { blob = "X'\(each.hex)'" }
            sql += "INSERT INTO gen_metadata VALUES (\(index),\(blob));"
            if let count = row.stepBytes {
                sql += "INSERT INTO steps VALUES (\(index),zeroblob(\(count)));"
            } else if let step = each.stepHex {
                sql += "INSERT INTO steps VALUES (\(index),X'\(step)');"
            }
        }
        try sqlite.execute(path: path, sql: sql)
        let scanner = AntigravityDbUsageScanner(sqlite: sqlite, conversationsDirectories: { [directory.url.path] })
        let result = await scanner.scan(now: try XCTUnwrap(OpenUsageISO8601.date(from: fixture.now)), pricing: antigravityPricing)
        let scan = try XCTUnwrap(result)
        XCTAssertEqual(scan.series.daily.first?.totalTokens, fixture.bounded.tokens)
        XCTAssertEqual(scan.series.daily.first?.costUSD ?? -1, fixture.bounded.cost, accuracy: 1e-9)
    }

    func testEmptyAndMissingStoresMatchTheBox() async throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("box/test/fixtures/usage/antigravity-empty-cases.json")
        let cases = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        for each in cases {
            let directory = try makeAntigravityDatabaseDirectory(for: self)
            let path = try XCTUnwrap(directory.paths.first)
            let sqlite = SQLiteCLIAccessor()
            if each["database"] as? Bool == true {
                try sqlite.execute(path: path, sql: "CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB);")
            } else { try? FileManager.default.removeItem(atPath: path) }
            let scanner = AntigravityDbUsageScanner(sqlite: sqlite, conversationsDirectories: { [directory.url.path] })
            let scan = await scanner.scan(pricing: antigravityPricing)
            XCTAssertEqual(scan?.series.daily.reduce(0) { $0 + $1.totalTokens } ?? 0, each["tokens"] as? Int, each["name"] as? String ?? "")
        }
    }

}
