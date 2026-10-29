import ClientSessions
import Foundation
import Testing

/// A goal under way, laid out in time as both apps draw it: one view for any length, its axis in
/// hours, days or weeks by the goal's span; steps at the same time side by side; a likely end only
/// where the bot measured how far along a step is, and a finish line only where every step left can
/// say; the deadline you set.
struct GoalTimelineTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func plan(_ steps: [GoalPlan.Step], ends: Date? = nil) -> GoalPlan {
        GoalPlan(id: "goal_1", bot: "bot_pixel", name: "Pixel", session: "ses_bot", goal: "Launch Driftwood.", state: .running, steps: steps,
                 ends: ends.map { $0.timeIntervalSince1970 * 1000 }, proposed: start.timeIntervalSince1970 * 1000, started: start.timeIntervalSince1970 * 1000, alone: true)
    }

    private func at(_ hours: Double) -> Double { (start.timeIntervalSince1970 + hours * 3600) * 1000 }

    @Test func aFewHoursCountsInHoursAndAMonthInWeeks() {
        let hours = GoalTimeline(plan([.init(id: "s1", text: "Site", state: .doing, began: at(0))]), now: start.addingTimeInterval(2 * 3600))
        #expect(hours.unit == .hour)
        #expect(!hours.ticks().isEmpty && hours.ticks().count <= 12)
        let week = GoalTimeline(plan([.init(id: "s1", text: "Site", state: .doing, began: at(0))], ends: start.addingTimeInterval(9 * 86400)), now: start.addingTimeInterval(86400))
        #expect(week.unit == .day)
        let month = GoalTimeline(plan([.init(id: "s1", text: "Site", state: .doing, began: at(0))], ends: start.addingTimeInterval(40 * 86400)), now: start.addingTimeInterval(86400))
        #expect(month.unit == .week)
        #expect(month.ticks().count <= 12, "a handful of lines, whatever the span")
    }

    @Test func stepsAtTheSameTimeGoSideBySideAndOnesAfterReuseAColumn() {
        let timeline = GoalTimeline(plan([
            .init(id: "s1", text: "Site", state: .done, began: at(0), ended: at(1)),
            .init(id: "s2", text: "Domain", state: .doing, began: at(0.5)),
            .init(id: "s3", text: "DNS", state: .doing, began: at(1.5)),
            .init(id: "s4", text: "Deploy", state: .todo),
        ]), now: start.addingTimeInterval(2 * 3600))
        let column = Dictionary(uniqueKeysWithValues: timeline.lanes.map { ($0.id, $0.column) })
        #expect(column["s1"] == 0 && column["s2"] == 1 && column["s3"] == 0, "DNS takes the column Site left")
        #expect(timeline.columns == 2)
        #expect(timeline.lanes.first { $0.id == "s4" }?.from == nil, "not begun: no span yet")
    }

    @Test func aLikelyEndAndTheFinishLineOnlyWhereItWasMeasured() {
        let now = start.addingTimeInterval(2 * 3600)
        let measured = GoalTimeline(plan([.init(id: "s1", text: "Site", state: .doing, progress: 0.5, began: at(0))]), now: now)
        #expect(measured.lanes[0].likelyEnd == start.addingTimeInterval(4 * 3600), "half done in two hours: likely done in four")
        #expect(measured.finish == start.addingTimeInterval(4 * 3600))
        let unmeasured = GoalTimeline(plan([.init(id: "s1", text: "Site", state: .doing, progress: 0.5, began: at(0)), .init(id: "s2", text: "DNS", state: .doing, began: at(1))]), now: now)
        #expect(unmeasured.finish == nil, "a step that can't say leaves the finish unknown")
        #expect(unmeasured.lanes[1].likelyEnd == nil)
    }
}
