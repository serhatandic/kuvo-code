import Foundation
import XCTest
@testable import UsageKit

final class JSONLTailParsingTests: XCTestCase {
    func testResumeMatchesFullParseAtRandomizedSplitPoints() async throws {
        let source = Data((0..<64).map { "\($0)\n" }.joined().utf8)
        let expected = Array(0..<64)

        for split in stride(from: 0, through: source.count, by: 7) {
            let directory = try makeDirectory()
            defer { try? FileManager.default.removeItem(at: directory) }
            let fileURL = directory.appendingPathComponent("events.jsonl")
            try Data(source.prefix(split)).write(to: fileURL)

            let scanner = IncrementalJSONLScanner<Int>()
            let first = await scanner.items(
                from: [try discover(fileURL)],
                since: .distantPast,
                cacheIdentity: "split-\(split)",
                tailParser: intTailParser
            )
            XCTAssertNotNil(first)

            try append(Data(source.dropFirst(split)), to: fileURL)
            let resumed = await scanner.items(
                from: [try discover(fileURL)],
                since: .distantPast,
                cacheIdentity: "split-\(split)",
                tailParser: intTailParser
            )
            XCTAssertEqual(resumed, expected, "split \(split)")

            let fullScanner = IncrementalJSONLScanner<Int>()
            let fullParse = await fullScanner.items(
                from: [try discover(fileURL)],
                since: .distantPast,
                cacheIdentity: "full-\(split)",
                tailParser: intTailParser
            )
            XCTAssertEqual(resumed, fullParse, "full-parse comparison at split \(split)")
        }
    }

    func testStatefulFullParseMatchesStreamedCodexAcrossMultipleBatches() async throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("multi-batch.jsonl")
        var record = Data(
            #"{"type":"event_msg","timestamp":"2025-01-01T00:00:00Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1,"output_tokens":2}}}}"#.utf8
        )
        record.append(UInt8(ascii: "\n"))
        var contents = Data()
        for _ in 0..<20_000 {
            contents.append(record)
        }
        try contents.write(to: fileURL)
        XCTAssertGreaterThan(contents.count, JSONLStreamingReader.readChunkBytes * 4)
        let file = try discover(fileURL)

        let streamedStrategy = JSONLParseStrategy<CodexLogUsageScanner.Event>.streamed { discovered in
            do {
                let streamed: JSONLStreamingReader.Result<
                    CodexLogUsageScanner.Event,
                    CodexLogFileParser.ParseState
                > = try JSONLStreamingReader.read(
                    path: discovered.path,
                    initialState: CodexLogFileParser.ParseState(),
                    parse: { chunk, state in
                        var parser = CodexLogFileParser(state: state)
                        let events = parser.parse(chunk)
                        state = parser.state
                        return events
                    }
                )
                guard let events = streamed.items else {
                    return JSONLParseResult(outcome: .skipped, oversizedRecordCount: streamed.oversizedRecordCount)
                }
                return JSONLParseResult(
                    outcome: .replaced(items: events, offset: nil, state: nil, fingerprint: nil),
                    oversizedRecordCount: streamed.oversizedRecordCount
                )
            } catch {
                return JSONLParseResult(outcome: .unreadable, oversizedRecordCount: 0)
            }
        }
        let streamed = JSONLTailIO.parse(
            request: JSONLParseRequest(file: file, resume: nil),
            strategy: streamedStrategy
        )
        let tailed = JSONLTailIO.parse(
            request: JSONLParseRequest(file: file, resume: nil),
            strategy: .tail(CodexLogUsageScanner.tailParser)
        )

        guard case .replaced(let streamedEvents, _, _, _) = streamed.outcome,
              case .replaced(let tailedEvents, _, _, _) = tailed.outcome
        else {
            return XCTFail("Expected both parsers to replace the full file parse")
        }
        XCTAssertEqual(tailedEvents, streamedEvents)
        XCTAssertEqual(tailedEvents.count, 20_000)
    }

    func testIncompleteAppendedLineIsRecoveredOnTheNextRefresh() async throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("events.jsonl")
        try Data("1\n".utf8).write(to: fileURL)
        let scanner = IncrementalJSONLScanner<Int>()

        let initialResult = await scanner.items(
            from: [try discover(fileURL)],
            since: .distantPast,
            cacheIdentity: "partial",
            tailParser: intTailParser
        )
        XCTAssertEqual(initialResult, [1])

        try append(Data("2".utf8), to: fileURL)
        let partialResult = await scanner.items(
            from: [try discover(fileURL)],
            since: .distantPast,
            cacheIdentity: "partial",
            tailParser: intTailParser
        )
        XCTAssertEqual(partialResult, [1, 2])

        try append(Data("\n".utf8), to: fileURL)
        let completedResult = await scanner.items(
            from: [try discover(fileURL)],
            since: .distantPast,
            cacheIdentity: "partial",
            tailParser: intTailParser
        )
        XCTAssertEqual(completedResult, [1, 2])
    }

    func testRewrittenPrefixFailsFingerprintAndFallsBackToFullParse() async throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("events.jsonl")
        try Data("1\n2\n".utf8).write(to: fileURL)
        let scanner = IncrementalJSONLScanner<Int>()
        _ = await scanner.items(
            from: [try discover(fileURL)],
            since: .distantPast,
            cacheIdentity: "rewrite",
            tailParser: intTailParser
        )

        try Data("9\n2\n3\n".utf8).write(to: fileURL)
        let result = await scanner.items(
            from: [try discover(fileURL)],
            since: .distantPast,
            cacheIdentity: "rewrite",
            tailParser: intTailParser
        )
        XCTAssertEqual(result, [9, 2, 3])
    }

    func testResumeStatePersistsAcrossScannerInstances() async throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let cacheDirectory = directory.appendingPathComponent("cache", isDirectory: true)
        let fileURL = directory.appendingPathComponent("events.jsonl")
        try Data("1\n".utf8).write(to: fileURL)
        let persistence = JSONLScanCachePersistence(
            namespace: "tail-test",
            schemaVersion: 1,
            directory: cacheDirectory,
            writeDebounce: .milliseconds(1)
        )
        let recorder = StateRecorder()
        let firstScanner = IncrementalJSONLScanner<Int>(persistence: persistence)
        _ = await firstScanner.items(
            from: [try discover(fileURL)],
            since: .distantPast,
            cacheIdentity: "persistent-tail",
            tailParser: makeIntTailParser(stateRecorder: recorder)
        )
        await firstScanner.waitForPendingWritesForTesting()

        try append(Data("2\n".utf8), to: fileURL)
        let secondScanner = IncrementalJSONLScanner<Int>(persistence: persistence)
        let result = await secondScanner.items(
            from: [try discover(fileURL)],
            since: .distantPast,
            cacheIdentity: "persistent-tail",
            tailParser: makeIntTailParser(stateRecorder: recorder)
        )
        XCTAssertEqual(result, [1, 2])
        XCTAssertTrue(recorder.states.contains { $0 > 0 })
    }

    func testCodexParseStateRoundTrip() throws {
        let baselineLine = Data(
            #"{"type":"event_msg","timestamp":"2025-01-01T00:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":1,"output_tokens":2,"reasoning_output_tokens":0,"total_tokens":12}}}}"#.utf8
        )
        var parser = CodexLogFileParser()
        _ = parser.parse(baselineLine)
        var state = parser.state
        state.currentModel = "gpt-5.1"
        state.currentTierIsFast = true
        state.sawSessionMeta = true
        let encoded = try JSONEncoder().encode(state)
        let decoded = try JSONDecoder().decode(CodexLogFileParser.ParseState.self, from: encoded)
        XCTAssertEqual(decoded, state)
        XCTAssertNotNil(decoded.previousTotals)

        let gatedState = CodexLogFileParser.ParseState(replayGate: .untilStartedAt(123.5))
        let encodedGate = try JSONEncoder().encode(gatedState)
        XCTAssertEqual(
            try JSONDecoder().decode(CodexLogFileParser.ParseState.self, from: encodedGate),
            gatedState
        )

        var resumedParser = CodexLogFileParser(state: decoded)
        let appendedLine = Data(
            #"{"type":"event_msg","timestamp":"2025-01-01T00:01:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":20,"cached_input_tokens":4,"output_tokens":4,"reasoning_output_tokens":2,"total_tokens":26}}}}"#.utf8
        )
        let events = resumedParser.parse(appendedLine)
        XCTAssertEqual(events.first?.input, 10)
        XCTAssertEqual(events.first?.model, "gpt-5.1")
        XCTAssertEqual(events.first?.isFast, true)
    }

    private var intTailParser: JSONLTailParser<Int> {
        makeIntTailParser()
    }

    private func makeIntTailParser(stateRecorder: StateRecorder? = nil) -> JSONLTailParser<Int> {
        JSONLTailParser<Int>.stateful(initial: IntState(count: 0)) { chunk, state in
            stateRecorder?.record(state.count)
            let values = chunk.split(separator: UInt8(ascii: "\n")).compactMap {
                Int(String(decoding: $0, as: UTF8.self))
            }
            state.count += values.count
            return values
        }
    }

    private final class StateRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var recordedStates: [Int] = []

        var states: [Int] {
            lock.withLock { recordedStates }
        }

        func record(_ state: Int) {
            lock.withLock { recordedStates.append(state) }
        }
    }

    private struct IntState: Codable, Sendable {
        var count: Int
    }

    private func makeDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("OpenUsageJSONLTail-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func append(_ data: Data, to url: URL) throws {
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
    }

    private func discover(_ url: URL) throws -> JSONLScanning.DiscoveredFile {
        let values = try FileManager.default.attributesOfItem(atPath: url.path)
        return JSONLScanning.DiscoveredFile(
            path: url.path,
            size: try XCTUnwrap((values[.size] as? NSNumber)?.intValue),
            mtime: try XCTUnwrap(values[.modificationDate] as? Date)
        )
    }
}
