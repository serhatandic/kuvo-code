import Foundation

/// Antigravity quota widget IDs and metric labels, shared by `AntigravityProvider.widgetDescriptors`
/// and `AntigravityUsageMapper` so both sides of the exact-string label binding
/// (`WidgetDescriptor.metricLabel` == `MetricLine.label`, resolved in `WidgetDataStore.data(for:)`)
/// come from one place — label drift there is a silent "No data" failure.
///
/// The shared Gemini and non-Gemini (Claude, GPT-OSS) pools each have a rolling 5-hour window plus a
/// weekly window. Eligible accounts also report a separate Gemini 4 Argon weekly quota. The shared
/// Gemini pair is titled "Session" / "Weekly"; the non-Gemini pool keeps its "Claude" name.
/// `geminiID` keeps its historical `antigravity.geminiPro` raw value so existing users' layout state
/// (enabled/pin/order) carries over to the shared meter with zero migration.
enum AntigravityMetric {
    static let geminiID = "antigravity.geminiPro"
    static let geminiWeeklyID = "antigravity.geminiWeekly"
    static let argonWeeklyID = "antigravity.argonWeekly"
    static let claudeID = "antigravity.claude"
    static let claudeWeeklyID = "antigravity.claudeWeekly"

    static let sessionLabel = "Session"
    static let weeklyLabel = "Weekly"
    static let argonWeeklyLabel = "Argon Weekly"
    static let claudeLabel = "Claude"
    static let claudeWeeklyLabel = "Claude Weekly"
}
