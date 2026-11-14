import Foundation

enum JSONLScanParseWorker {
    /// Read + parse a bounded number of changed files in parallel. Results are keyed back to the
    /// input order; requests not reached before cancellation remain skipped.
    static func parseFiles<Item: Codable & Sendable>(
        _ requests: [JSONLParseRequest],
        maxConcurrentParses: Int,
        permitPool: JSONLParsePermitPool,
        strategy: JSONLParseStrategy<Item>
    ) async -> [
        (file: JSONLScanning.DiscoveredFile, outcome: JSONLParseOutcome<Item>, oversizedRecordCount: Int)
    ] {
        await withTaskGroup(
            of: (Int, JSONLParseResult<Item>).self,
            returning: [
                (
                    file: JSONLScanning.DiscoveredFile,
                    outcome: JSONLParseOutcome<Item>,
                    oversizedRecordCount: Int
                )
            ].self
        ) { group in
            func addTask(at index: Int) {
                let request = requests[index]
                group.addTask {
                    guard await permitPool.acquire() else {
                        return (index, JSONLParseResult(outcome: .skipped, oversizedRecordCount: 0))
                    }
                    let result: JSONLParseResult<Item>
                    if Task.isCancelled || !FileManager.default.fileExists(atPath: request.file.path) {
                        result = JSONLParseResult(outcome: .skipped, oversizedRecordCount: 0)
                    } else {
                        result = autoreleasepool {
                            JSONLTailIO.parse(request: request, strategy: strategy)
                        }
                    }
                    await permitPool.release()
                    return (index, result)
                }
            }

            var nextIndex = 0
            let initialCount = min(maxConcurrentParses, requests.count)
            for index in 0..<initialCount where !Task.isCancelled {
                addTask(at: index)
                nextIndex += 1
            }

            var results = requests.map {
                (
                    file: $0.file,
                    outcome: JSONLParseOutcome<Item>.skipped,
                    oversizedRecordCount: 0
                )
            }
            for await (index, result) in group {
                if Task.isCancelled {
                    group.cancelAll()
                    break
                }
                results[index] = (
                    requests[index].file,
                    result.outcome,
                    result.oversizedRecordCount
                )
                if nextIndex < requests.count {
                    addTask(at: nextIndex)
                    nextIndex += 1
                }
            }
            return results
        }
    }
}
