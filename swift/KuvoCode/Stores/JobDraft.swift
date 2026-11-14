import Foundation

/// A bot's job as Edit Bot changes it: what you typed, beside the job the bot keeps. Until you change
/// it, it follows what the bot keeps (the bot keeps its job as you talk to it, Edit Bot open or
/// not); once you have, yours stays, and a job the bot keeps meanwhile shows beside it
/// (`keptMeanwhile`), for you to take instead (`useKept`) or leave to Save, which keeps yours.
struct JobDraft: Equatable {
    struct Job: Equatable {
        var line: String
        var details: String
    }

    var line: String
    var details: String
    /// What the bot kept as you started, or as you last took it.
    private(set) var base: Job
    /// What the bot kept since, while you'd changed yours.
    private(set) var keptMeanwhile: Job?

    init(line: String, details: String) {
        self.line = line
        self.details = details
        base = Job(line: line, details: details)
    }

    private var typed: Job { Job(line: line, details: details) }

    /// The bot keeps `kept` now.
    mutating func botKept(_ kept: Job) {
        if kept == typed {
            base = kept
            keptMeanwhile = nil
        } else if typed == base {
            line = kept.line
            details = kept.details
            base = kept
            keptMeanwhile = nil
        } else if kept != base {
            keptMeanwhile = kept
        } else {
            keptMeanwhile = nil
        }
    }

    /// The bot's own job in place of yours.
    mutating func useKept() {
        guard let kept = keptMeanwhile else { return }
        line = kept.line
        details = kept.details
        base = kept
        keptMeanwhile = nil
    }
}
