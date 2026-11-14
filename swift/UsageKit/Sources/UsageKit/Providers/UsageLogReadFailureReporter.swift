import Foundation

/// Logs only when a local usage file newly becomes unreadable. Repeated refreshes stay quiet until
/// the file recovers and fails again.
actor UsageLogReadFailureReporter {
    typealias Warning = @Sendable (Int) -> Void

    private var failingPaths: Set<String> = []
    private let warning: Warning

    init(logTag: String, warning: Warning? = nil) {
        self.warning = warning ?? { count in
            let noun = count == 1 ? "file" : "files"
            AppLog.warn(logTag, "Could not read \(count) local usage log \(noun); skipped for this refresh")
        }
    }

    /// Returns the newly-failing paths so callers can log per-path detail on the same edge-triggered
    /// cadence as the summary warning (once per new failure, not once per refresh).
    @discardableResult
    func update(checkedPaths: Set<String>, failingPaths nextFailingPaths: Set<String>) -> Set<String> {
        let newlyFailing = nextFailingPaths.subtracting(failingPaths)
        // Only clear a remembered failure when that same path was checked again and no longer failed.
        // A scan may look at a different batch of files, which says nothing about older failures.
        failingPaths.subtract(checkedPaths)
        failingPaths.formUnion(nextFailingPaths)
        guard !newlyFailing.isEmpty else { return [] }
        warning(newlyFailing.count)
        return newlyFailing
    }
}
