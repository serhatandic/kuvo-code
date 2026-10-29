import ClientSessions
import Foundation
import Testing

/// A goal under way, laid out in time as both apps draw it: one view for any length, its axis in
/// hours, days or weeks by the goal's span; steps at the same time side by side; a likely end only
/// where the bot measured how far along a step is, and a finish line only where every step left can
/// say; the deadline you set.
struct GoalTimelineTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func plan(_ steps: [GoalPlan.Step], ends: Date? = nil, state: GoalPlan.State = .running, ended: Date? = nil) -> GoalPlan {
        GoalPlan(id: "goal_1", bot: "bot_pixel", name: "Pixel", session: "ses_bot", goal: "Launch Driftwood.", state: state, steps: steps,
                 ends: ends.map { $0.timeIntervalSince1970 * 1000 }, proposed: start.timeIntervalSince1970 * 1000, started: start.timeIntervalSince1970 * 1000,
                 ended: ended.map { $0.timeIntervalSince1970 * 1000 }, alone: true)
    }

    private func names(_ rows: [GoalTimeline.Row]) -> [String] {
        rows.map { row in
            switch row {
            case .phase(let name): "phase \(name)"
            case .done(let lanes): "\(lanes.count) done"
            case .later(let lanes): "\(lanes.count) later"
            case .lane(let lane): lane.step.text
            }
        }
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

    @Test func aLongGoalOpensOnTheDaysAroundNowAndAShortOneShowsWhole() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let steps: [GoalPlan.Step] = [.init(id: "s1", text: "Subscriber portal", state: .doing, began: at(0))]
        // Day 9 of a month: about ten days, from three days before today.
        let now = start.addingTimeInterval(8.6 * 86400)
        let month = GoalTimeline(plan(steps, ends: start.addingTimeInterval(30 * 86400)), now: now)
        let window = try #require(month.window(calendar: calendar))
        #expect(window.duration == 10 * 86400)
        #expect(window.start == calendar.date(byAdding: .day, value: -3, to: calendar.startOfDay(for: now)))
        #expect(window.contains(now))
        // A week: about five days around today.
        let weekNow = start.addingTimeInterval(3.6 * 86400)
        let week = GoalTimeline(plan(steps, ends: start.addingTimeInterval(7 * 86400)), now: weekNow)
        let days = try #require(week.window(calendar: calendar))
        #expect(days.duration == 5 * 86400 && days.contains(weekNow))
        // A few hours, and a couple of days, show whole.
        #expect(GoalTimeline(plan(steps), now: start.addingTimeInterval(2 * 3600)).window(calendar: calendar) == nil)
        #expect(GoalTimeline(plan(steps, ends: start.addingTimeInterval(2 * 86400)), now: start.addingTimeInterval(86400)).window(calendar: calendar) == nil)
    }

    @Test func theCardSaysThePlanInWordsAndNamesEachServiceFromItsSite() {
        let steps: [GoalPlan.Step] = [.init(id: "s1", text: "Site", state: .todo), .init(id: "s2", text: "DNS", state: .todo), .init(id: "s3", text: "Deploy", state: .todo)]
        let goal = plan(steps)
        #expect(GoalPlanWords.summary(goal) == "3 steps")
        #expect(GoalPlanWords.outline(goal).contains("Site") && GoalPlanWords.outline(goal).contains("Deploy"))
        let phased = plan([.init(id: "s1", text: "Site", state: .todo, phase: "Build"), .init(id: "s2", text: "Ads", state: .todo, phase: "Grow")])
        #expect(GoalPlanWords.summary(phased) == "2 steps in 2 phases")
        #expect(GoalPlanWords.outline(phased).contains("Build") && !GoalPlanWords.outline(phased).contains("Ads"), "a plan with phases is said by its phases")
        #expect(GoalPlanWords.service("stripe.com") == "Stripe")
        #expect(GoalPlanWords.service("dash.cloudflare.com") == "Cloudflare")
        #expect(GoalPlanWords.service("www.namecheap.com") == "Namecheap")
    }

    @Test func aGoalThatEndedIsLaidOutAtItsEndNotNow() {
        let ended = start.addingTimeInterval(3 * 3600)
        let timeline = GoalTimeline(plan([.init(id: "s1", text: "Site", state: .done, began: at(0), ended: at(2)),
                                          .init(id: "s2", text: "DNS", state: .doing, progress: 0.5, began: at(1))], state: .stopped, ended: ended),
                                    now: start.addingTimeInterval(9 * 3600))
        #expect(timeline.unit == .hour)
        #expect(timeline.end < start.addingTimeInterval(4 * 3600), "a three-hour goal opened six hours later is still three hours long")
        #expect(timeline.lanes[1].to == ended, "a step left under way stops where the goal did")
        #expect(timeline.lanes[1].likelyEnd == nil && timeline.finish == nil)
        let month = GoalTimeline(plan([.init(id: "s1", text: "Site", state: .done, began: at(0), ended: at(600))], state: .done, ended: start.addingTimeInterval(30 * 86400)),
                                 now: start.addingTimeInterval(40 * 86400))
        #expect(month.window() == nil, "a month that's over shows whole, not the days around today")
    }

    @Test func aGoalOfMoreThanAFewHoursStillCountsInHoursAndShowsWhole() {
        let timeline = GoalTimeline(plan([.init(id: "s1", text: "Site", state: .doing, began: at(0))]), now: start.addingTimeInterval(20 * 3600))
        #expect(timeline.unit == .hour)
        #expect(timeline.window() == nil)
        #expect(timeline.ticks().count <= 12, "a handful of labels, so it fits the room")
    }

    @Test func aLongGoalFoldsWhatsDoneAndWhatsLaterButNeverEverything() {
        let ends = start.addingTimeInterval(30 * 86400), now = start.addingTimeInterval(9 * 86400)
        let mixed: [GoalPlan.Step] = [
            .init(id: "d1", text: "Domain", state: .done, began: at(0), ended: at(5)),
            .init(id: "d2", text: "DNS", state: .done, began: at(5), ended: at(10)),
            .init(id: "w1", text: "Portal", state: .doing, began: at(150)),
            .init(id: "t1", text: "Post", state: .todo), .init(id: "t2", text: "Ads", state: .todo), .init(id: "t3", text: "Newsletter", state: .todo),
        ]
        let timeline = GoalTimeline(plan(mixed, ends: ends), now: now)
        #expect(names(timeline.rows()) == ["2 done", "Portal", "3 later"])
        #expect(names(timeline.rows(showsLater: true)) == ["2 done", "Portal", "3 later", "Post", "Ads", "Newsletter"], "a fold opens its steps")
        let nothingBegun = GoalTimeline(plan(mixed.filter { $0.state == .todo }, ends: ends), now: now)
        #expect(names(nothingBegun.rows()) == ["Post", "Ads", "Newsletter"], "nothing begun: its steps, not just a fold")
        let allDone = GoalTimeline(plan(mixed.filter { $0.state == .done }, ends: ends), now: now)
        #expect(names(allDone.rows()) == ["Domain", "DNS"])
    }

    @Test func aDeadlineThatPassedAndAGoalWithNoEndStillOpenAroundNow() throws {
        // Due on day 5; it's day 8.
        let now = start.addingTimeInterval(8 * 86400)
        let late = GoalTimeline(plan([.init(id: "s1", text: "Site", state: .doing, began: at(0))], ends: start.addingTimeInterval(5 * 86400)), now: now)
        let window = try #require(late.window())
        #expect(window.contains(now))
        #expect(window.start >= late.start && window.end <= late.end, "within the axis")
        #expect((0...1).contains(late.position(of: try #require(late.deadline))))
        // No end: six days in, it opens on its last days with now among them, not past the axis.
        let open = GoalTimeline(plan([.init(id: "s1", text: "Site", state: .doing, began: at(0))]), now: start.addingTimeInterval(6.5 * 86400))
        let days = try #require(open.window())
        #expect(days.contains(open.now))
        #expect(days.start >= open.start && days.end <= open.end, "the days shown are all on the axis")
    }
}
