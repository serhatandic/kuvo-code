import OpenCodeKit

/// How long the agent's steps between two of its replies took, for their line ("Worked for 40s"):
/// from the first one's start to the last one's end, gaps between them included, as you waited.
public enum StepTime {
    /// In whole seconds, at least one; nil when the steps don't say when they ran.
    public static func seconds(of blocks: [Message.Content]) -> Int? {
        var start: Milliseconds?
        var end: Milliseconds?
        for block in blocks {
            let began: Milliseconds?
            let ended: Milliseconds?
            switch block {
            case .reasoning(let text): (began, ended) = (text.time?.created, text.time?.completed)
            case .tool(let call): (began, ended) = (call.time?.created ?? call.time?.ran, call.time?.completed)
            default: continue
            }
            if let began { start = min(start ?? began, began) }
            if let ended { end = max(end ?? ended, ended) }
        }
        guard let start, let end, end >= start else { return nil }
        return max(1, Int((end - start) / 1000))
    }
}
