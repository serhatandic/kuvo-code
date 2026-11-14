import Foundation

/// One of the three quota milestones a user can be alerted about. Each maps to a single per-trigger
/// toggle in Settings and is deduped independently within a reset window.
enum PaceMilestone: String, CaseIterable, Hashable, Sendable {
    /// First time the remaining share of the quota drops under 10% for the period.
    case underTenPercent
    /// Pace verdict worsened from healthy (blue) to close-to-limit (yellow).
    case healthyToClose
    /// Pace verdict worsened from close-to-limit (yellow) to running-out (red).
    case closeToRunningOut
}

extension PaceMilestone {
    /// User-facing label for the Settings row and the notification title (they match by design).
    var settingLabel: String {
        switch self {
        case .underTenPercent: return "Almost Out"
        case .healthyToClose: return "Cutting It Close"
        case .closeToRunningOut: return "Will Run Out"
        }
    }

    /// Notification title. Same as the setting label so a tapped alert maps back to one row.
    var notificationTitle: String { settingLabel }

    /// Notification body — the plain-language verdict. The subtitle carries provider + metric, so the
    /// body stays generic and reads well for any metric (sessions, rate-limit resets, spend tiles).
    var body: String {
        switch self {
        case .underTenPercent: return "Under 10% usage remaining for this window."
        case .healthyToClose: return "Projected to finish close to your limit."
        case .closeToRunningOut: return "Projected to finish before the limit resets."
        }
    }

    /// One-sentence Settings tooltip (the (i) beside the row) explaining when this fires.
    var tooltip: String {
        switch self {
        case .underTenPercent: return "Alert when a limit drops below 10% remaining."
        case .healthyToClose: return "Alert when a limit is projected to finish with little left."
        case .closeToRunningOut: return "Alert when a limit is projected to finish before it resets."
        }
    }
}
