import XCTest
@testable import UsageKit

let antigravityNow = OpenUsageISO8601.date(from: "2026-07-27T12:00:00.000Z")!

/// One priced Gemini model, so scanner tests that do not exercise alias rules stay independent of
/// the bundled supplement.
let antigravityPricing = ModelPricing(
    supplement: PricingSupplement(),
    primary: PricingCatalog(entries: [
        "gemini-3.6-flash": ModelRates(
            inputPerMillion: 1,
            outputPerMillion: 4,
            cacheWritePerMillion: 1,
            cacheReadPerMillion: 0.25
        )
    ]),
    secondary: PricingCatalog()
)

/// A temporary conversations directory holding empty database files, removed when `testCase` tears
/// down. An empty file is a valid empty SQLite database, so real-`sqlite3` tests can create their
/// own schema in it.
func makeAntigravityDatabaseDirectory(
    for testCase: XCTestCase,
    fileNames: [String] = ["conversation.db"]
) throws -> (url: URL, paths: [String]) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    let paths = try fileNames.map { name -> String in
        let url = directory.appendingPathComponent(name)
        try Data().write(to: url)
        return url.path
    }
    testCase.addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return (directory, paths)
}

/// Synthetic protobuf fixtures follow FelixIsaac's original regression coverage in openusage#1058.
func antigravityVarint(_ value: UInt64) -> [UInt8] {
    var remaining = value
    var encoded: [UInt8] = []
    repeat {
        var byte = UInt8(remaining & 0x7f)
        remaining >>= 7
        if remaining != 0 { byte |= 0x80 }
        encoded.append(byte)
    } while remaining != 0
    return encoded
}

func antigravityVarintField(_ number: UInt32, _ value: UInt64) -> [UInt8] {
    antigravityVarint(UInt64(number) << 3) + antigravityVarint(value)
}

func antigravityBytesField(_ number: UInt32, _ bytes: [UInt8]) -> [UInt8] {
    antigravityVarint(UInt64(number) << 3 | 2) + antigravityVarint(UInt64(bytes.count)) + bytes
}

func antigravityHex(_ bytes: [UInt8]) -> String {
    bytes.map { String(format: "%02x", $0) }.joined()
}

/// `steps.metadata`: field 1 is a Timestamp message whose field 1 is seconds.
func antigravityStepMetadata(timestamp: UInt64) -> [UInt8] {
    antigravityBytesField(1, antigravityVarintField(1, timestamp))
}

func antigravityGenerationBlob(
    model: String?,
    input: UInt64,
    output: UInt64,
    cacheRead: UInt64 = 0,
    systemPrompt: UInt64 = 0,
    label: String? = nil,
    timestamp: UInt64?
) -> [UInt8] {
    let usage = antigravityVarintField(1, systemPrompt)
        + antigravityVarintField(2, input)
        + antigravityVarintField(3, output)
        + antigravityVarintField(5, cacheRead)

    var event: [UInt8] = []
    if let model {
        event += antigravityBytesField(19, Array(model.utf8))
    }
    event += antigravityBytesField(4, usage)
    if let label {
        event += antigravityBytesField(21, Array(label.utf8))
    }

    if let timestamp {
        let wallClock = antigravityVarintField(1, timestamp)
        event += antigravityBytesField(9, antigravityBytesField(4, wallClock))
    }
    return antigravityBytesField(1, event)
}

struct AntigravityFixtureRow: Sendable {
    var index: Int
    var blob: [UInt8]?
}

final class AntigravityFakeSQLite: SQLiteAccessing, @unchecked Sendable {
    private let lock = NSLock()
    private var rowsByPath: [String: [AntigravityFixtureRow]]
    private var cursors: [Int] = []
    let failingPaths: Set<String>
    let cancellingPath: String?

    init(rowsByPath: [String: [AntigravityFixtureRow]] = [:], failingPaths: Set<String> = [], cancellingPath: String? = nil) {
        self.rowsByPath = rowsByPath
        self.failingPaths = failingPaths
        self.cancellingPath = cancellingPath
    }

    func queryValue(path: String, sql: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }

        if failingPaths.contains(path) {
            throw SQLiteError.queryFailed("database locked")
        }
        if path == cancellingPath { withUnsafeCurrentTask { $0?.cancel() } }
        if sql == AntigravityDbUsageScanner.stepMetadataProbeSQL { return nil }
        let marker = "WHERE idx > "
        guard let markerRange = sql.range(of: marker),
              let cursor = Int(sql[markerRange.upperBound...].split(whereSeparator: \.isWhitespace).first ?? "")
        else {
            throw SQLiteError.queryFailed("missing batch cursor")
        }
        cursors.append(cursor)

        let rows: [[String: Any]] = rowsByPath[path, default: []]
            .filter { $0.index > cursor }
            .sorted { $0.index < $1.index }
            .prefix(AntigravityDbUsageScanner.batchSize)
            .map { row in
                let value: Any = row.blob.map(antigravityHex) ?? NSNull()
                return ["index": row.index, "hex": value]
            }

        let json = try JSONSerialization.data(withJSONObject: rows)
        return String(decoding: json, as: UTF8.self)
    }

    func append(_ row: AntigravityFixtureRow, to path: String) {
        lock.withLock { rowsByPath[path, default: []].append(row) }
    }

    var queriedCursors: [Int] {
        lock.withLock { cursors }
    }

    func execute(path: String, sql: String) throws {}
}
