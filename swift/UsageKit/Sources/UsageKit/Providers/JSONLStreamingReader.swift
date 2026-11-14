import Foundation

/// Reads local provider logs in bounded batches without ever materializing an entire rollout.
/// Complete records stay together, so existing provider parsers can keep accepting JSONL `Data`.
enum JSONLStreamingReader {
    static let readChunkBytes = 64 * 1024
    static let maximumRecordBytes = 1024 * 1024

    struct Result<Item: Sendable, State: Sendable>: Sendable {
        var items: [Item]?
        var state: State
        var oversizedRecordCount: Int
        var parsedOffset: Int
        var endsAtLineBoundary: Bool
    }

    static func read<Item: Sendable, State: Sendable>(
        path: String,
        startingAt: Int = 0,
        upTo: Int? = nil,
        initialState: State,
        parse: @Sendable (Data, inout State) -> [Item]?
    ) throws -> Result<Item, State> {
        precondition(startingAt >= 0)
        if let upTo {
            precondition(upTo >= startingAt)
        }
        let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
        defer { try? handle.close() }
        if startingAt > 0 {
            try handle.seek(toOffset: UInt64(startingAt))
        }

        var state = initialState
        var items: [Item] = []
        var pendingRecord = Data()
        var batch = Data()
        var oversizedRecordCount = 0
        var discardingOversizedRecord = false
        var readAnyBytes = false
        var streamOffset = startingAt
        var parsedOffset = startingAt
        var endsAtLineBoundary = true

        func flushBatch() throws -> Bool {
            guard !batch.isEmpty else { return true }
            try Task.checkCancellation()
            guard let parsed = parse(batch, &state) else { return false }
            items.append(contentsOf: parsed)
            batch.removeAll(keepingCapacity: batch.count <= readChunkBytes)
            return true
        }

        func finishRecord(terminated: Bool) throws -> Bool {
            guard !discardingOversizedRecord else {
                discardingOversizedRecord = false
                return true
            }

            let recordBytes = pendingRecord.count + (terminated ? 1 : 0)
            if !batch.isEmpty, batch.count + recordBytes > readChunkBytes {
                guard try flushBatch() else { return false }
            }

            batch.append(pendingRecord)
            if terminated { batch.append(UInt8(ascii: "\n")) }
            pendingRecord.removeAll(keepingCapacity: pendingRecord.count <= readChunkBytes)

            if batch.count >= readChunkBytes {
                return try flushBatch()
            }
            return true
        }

        while true {
            try Task.checkCancellation()
            let readCount = upTo.map { min(readChunkBytes, max(0, $0 - streamOffset)) } ?? readChunkBytes
            guard readCount > 0,
                  let chunk = try handle.read(upToCount: readCount),
                  !chunk.isEmpty
            else { break }
            readAnyBytes = true

            var offset = chunk.startIndex
            while offset < chunk.endIndex {
                let newline = chunk[offset..<chunk.endIndex].firstIndex(of: UInt8(ascii: "\n"))
                let end = newline ?? chunk.endIndex
                let fragment = chunk[offset..<end]
                let fragmentCount = fragment.count

                if !discardingOversizedRecord {
                    if fragment.count > maximumRecordBytes - pendingRecord.count {
                        oversizedRecordCount += 1
                        discardingOversizedRecord = true
                        pendingRecord.removeAll(keepingCapacity: false)
                    } else {
                        pendingRecord.append(contentsOf: fragment)
                    }
                }

                if let newline {
                    guard try finishRecord(terminated: true) else {
                        return Result(
                            items: nil,
                            state: state,
                            oversizedRecordCount: oversizedRecordCount,
                            parsedOffset: parsedOffset,
                            endsAtLineBoundary: false
                        )
                    }
                    streamOffset += fragmentCount + 1
                    parsedOffset = streamOffset
                    endsAtLineBoundary = true
                    offset = chunk.index(after: newline)
                } else {
                    streamOffset += fragmentCount
                    endsAtLineBoundary = fragmentCount == 0
                        ? endsAtLineBoundary
                        : false
                    offset = chunk.endIndex
                }
            }
        }

        if !discardingOversizedRecord, !pendingRecord.isEmpty {
            endsAtLineBoundary = false
            guard try finishRecord(terminated: false) else {
                return Result(
                    items: nil,
                    state: state,
                    oversizedRecordCount: oversizedRecordCount,
                    parsedOffset: parsedOffset,
                    endsAtLineBoundary: false
                )
            }
        }
        if discardingOversizedRecord {
            endsAtLineBoundary = false
        }
        guard try flushBatch() else {
            return Result(
                items: nil,
                state: state,
                oversizedRecordCount: oversizedRecordCount,
                parsedOffset: parsedOffset,
                endsAtLineBoundary: false
            )
        }

        if !readAnyBytes {
            guard let parsed = parse(Data(), &state) else {
                return Result(
                    items: nil,
                    state: state,
                    oversizedRecordCount: oversizedRecordCount,
                    parsedOffset: parsedOffset,
                    endsAtLineBoundary: endsAtLineBoundary
                )
            }
            items.append(contentsOf: parsed)
        }

        return Result(
            items: items,
            state: state,
            oversizedRecordCount: oversizedRecordCount,
            parsedOffset: parsedOffset,
            endsAtLineBoundary: endsAtLineBoundary
        )
    }
}

struct JSONLStatelessParserState: Sendable {}
