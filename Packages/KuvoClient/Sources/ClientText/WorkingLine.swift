import Foundation

/// The line under a conversation at work, in both apps: "Working… 12s"; once the model has said
/// nothing for a while, that it waits for it (a provider that never answers can make that last many
/// minutes); and while the conversation is being summarized, that, timed from when it began.
/// Times are in milliseconds, as the engine's are.
public enum WorkingLine {
    /// What it says at `now`, and since when its time counts. `since`: the turn's start; `quiet`:
    /// since when nothing has come back from the model; `summarizing`: since when the summary under
    /// way began, if one is.
    public static func words(since: Double?, quiet: Double?, summarizing: Double?, now: Date) -> (words: String, since: Double?) {
        if let summarizing { return ("Summarizing the conversation…", summarizing) }
        if let quiet, now.timeIntervalSince1970 - quiet / 1000 >= 20 { return ("Waiting for the model to answer…", quiet) }
        return ("Working…", since)
    }

    /// The seconds to show since `since`, once there are a couple.
    public static func seconds(since: Double?, now: Date) -> Int? {
        guard let since else { return nil }
        let seconds = Int(now.timeIntervalSince1970 - since / 1000)
        return seconds >= 2 ? seconds : nil
    }
}
