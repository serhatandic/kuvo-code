import Foundation

/// A resumable parser for append-only JSONL files. The scanner passes the parser only complete
/// records and stores the opaque state returned after each successful scan.
struct JSONLTailParser<Item: Codable & Sendable>: Sendable {
    let read: @Sendable (
        _ path: String,
        _ start: Int,
        _ upTo: Int?,
        _ state: Data?
    ) throws -> JSONLStreamingReader.Result<Item, Data?>?

    static func stateful<State: Codable & Sendable>(
        initial: State,
        parse: @escaping @Sendable (Data, inout State) -> [Item]?
    ) -> Self {
        Self(read: { path, start, upTo, encodedState in
            var initialState = initial
            if let encodedState {
                guard let decoded = try? JSONDecoder().decode(State.self, from: encodedState) else {
                    return nil
                }
                initialState = decoded
            }
            let result: JSONLStreamingReader.Result<Item, State> = try JSONLStreamingReader.read(
                path: path,
                startingAt: start,
                upTo: upTo,
                initialState: initialState,
                parse: parse
            )
            let state = try JSONEncoder().encode(result.state)
            return JSONLStreamingReader.Result(
                items: result.items,
                state: state,
                oversizedRecordCount: result.oversizedRecordCount,
                parsedOffset: result.parsedOffset,
                endsAtLineBoundary: result.endsAtLineBoundary
            )
        })
    }

    static func stateless(
        _ parse: @escaping @Sendable (Data) -> [Item]?
    ) -> Self {
        Self(read: { path, start, upTo, _ in
            let result: JSONLStreamingReader.Result<Item, JSONLStatelessParserState> =
                try JSONLStreamingReader.read(
                    path: path,
                    startingAt: start,
                    upTo: upTo,
                    initialState: JSONLStatelessParserState(),
                    parse: { chunk, _ in parse(chunk) }
                )
            return JSONLStreamingReader.Result(
                items: result.items,
                state: nil,
                oversizedRecordCount: result.oversizedRecordCount,
                parsedOffset: result.parsedOffset,
                endsAtLineBoundary: result.endsAtLineBoundary
            )
        })
    }
}

enum JSONLParseStrategy<Item: Codable & Sendable>: Sendable {
    /// Existing parsers still use the bounded streaming reader, without a resumable state.
    case streamed(@Sendable (JSONLScanning.DiscoveredFile) -> JSONLParseResult<Item>)
    /// Append-aware parsers may resume from a cached byte offset and opaque state.
    case tail(JSONLTailParser<Item>)
}

struct JSONLParseRequest: Sendable {
    var file: JSONLScanning.DiscoveredFile
    var resume: JSONLResumeHint?
}

struct JSONLResumeHint: Sendable {
    var offset: Int
    var state: Data?
    var fingerprint: Int64
}

enum JSONLParseOutcome<Item: Codable & Sendable>: Sendable {
    case replaced(items: [Item], offset: Int?, state: Data?, fingerprint: Int64?)
    case appended(newItems: [Item], offset: Int, state: Data?, fingerprint: Int64)
    case skipped
    case unreadable
}

struct JSONLParseResult<Item: Codable & Sendable>: Sendable {
    var outcome: JSONLParseOutcome<Item>
    var oversizedRecordCount: Int
}

enum JSONLTailIO {
    static let fingerprintWindow = 4096

    static func parse<Item>(
        request: JSONLParseRequest,
        strategy: JSONLParseStrategy<Item>
    ) -> JSONLParseResult<Item> {
        switch strategy {
        case .streamed(let parse):
            return parse(request.file)
        case .tail(let parser):
            if let resume = request.resume,
               let result = tailParse(file: request.file, resume: resume, parser: parser)
            {
                return result
            }
            return fullParse(file: request.file, parser: parser)
        }
    }

    private static func fullParse<Item>(
        file: JSONLScanning.DiscoveredFile,
        parser: JSONLTailParser<Item>
    ) -> JSONLParseResult<Item> {
        do {
            guard let streamed = try parser.read(file.path, 0, nil, nil) else {
                return JSONLParseResult(outcome: .unreadable, oversizedRecordCount: 0)
            }
            guard let items = streamed.items else {
                return JSONLParseResult(outcome: .skipped, oversizedRecordCount: streamed.oversizedRecordCount)
            }
            guard streamed.endsAtLineBoundary, streamed.parsedOffset == file.size,
                  let fingerprint = fingerprint(path: file.path, endingAt: file.size)
            else {
                return JSONLParseResult(
                    outcome: .replaced(items: items, offset: nil, state: nil, fingerprint: nil),
                    oversizedRecordCount: streamed.oversizedRecordCount
                )
            }
            return JSONLParseResult(
                outcome: .replaced(
                    items: items,
                    offset: streamed.parsedOffset,
                    state: streamed.state,
                    fingerprint: fingerprint
                ),
                oversizedRecordCount: streamed.oversizedRecordCount
            )
        } catch {
            return JSONLParseResult(outcome: .unreadable, oversizedRecordCount: 0)
        }
    }

    private static func tailParse<Item>(
        file: JSONLScanning.DiscoveredFile,
        resume: JSONLResumeHint,
        parser: JSONLTailParser<Item>
    ) -> JSONLParseResult<Item>? {
        guard file.size > resume.offset,
              resume.offset >= 0,
              resume.offset <= file.size,
              let handle = FileHandle(forReadingAtPath: file.path)
        else { return nil }
        defer { try? handle.close() }

        let windowStart = max(0, resume.offset - fingerprintWindow)
        let prefixLength = resume.offset - windowStart
        guard (try? handle.seek(toOffset: UInt64(windowStart))) != nil,
              let prefix = read(from: handle, count: prefixLength),
              fingerprint(of: prefix) == resume.fingerprint
        else { return nil }

        do {
            guard let streamed = try parser.read(file.path, resume.offset, file.size, resume.state) else {
                return nil
            }
            guard let items = streamed.items,
                  streamed.endsAtLineBoundary,
                  streamed.parsedOffset == file.size,
                  streamed.parsedOffset > resume.offset,
                  let fingerprint = fingerprint(path: file.path, endingAt: streamed.parsedOffset)
            else { return nil }
            return JSONLParseResult(
                outcome: .appended(
                    newItems: items,
                    offset: streamed.parsedOffset,
                    state: streamed.state,
                    fingerprint: fingerprint
                ),
                oversizedRecordCount: streamed.oversizedRecordCount
            )
        } catch {
            return nil
        }
    }

    static func fingerprint(of bytes: Data) -> Int64 {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in bytes {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return Int64(bitPattern: hash)
    }

    private static func fingerprint(path: String, endingAt offset: Int) -> Int64? {
        let start = max(0, offset - fingerprintWindow)
        guard let handle = FileHandle(forReadingAtPath: path),
              (try? handle.seek(toOffset: UInt64(start))) != nil
        else { return nil }
        defer { try? handle.close() }
        guard let bytes = read(from: handle, count: offset - start) else { return nil }
        return fingerprint(of: bytes)
    }

    private static func read(from handle: FileHandle, count: Int) -> Data? {
        var result = Data(capacity: count)
        while result.count < count {
            guard let chunk = try? handle.read(upToCount: count - result.count) else { return nil }
            guard !chunk.isEmpty else { break }
            result.append(chunk)
        }
        return result.count == count ? result : nil
    }
}
