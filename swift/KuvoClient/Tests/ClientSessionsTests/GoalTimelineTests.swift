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
        #expect(GoalPlanWords.summary(phased) == "2 steps", "an old goal's phases aren't said")
        #expect(GoalPlanWords.outline(phased) == "Site and Ads")
        #expect(GoalPlanWords.service("stripe.com") == "Stripe")
        #expect(GoalPlanWords.service("dash.cloudflare.com") == "Cloudflare")
        #expect(GoalPlanWords.service("www.namecheap.com") == "Namecheap")
    }

    /// A goal whose next step waits for a time (its bot's wake-up on Monday) says when it goes on,
    /// as the box says it, rather than that it's working.
    @Test func aGoalWaitingForATimeSaysWhenItGoesOn() throws {
        let json = #"{"id": "goal_1", "bot": "bot_1", "name": "Pixel", "session": "ses_1", "goal": "Weekly summaries", "state": "running", "steps": [], "proposed": 1, "next": 1793599200000, "alone": true}"#
        let goal = try JSONDecoder().decode(GoalPlan.self, from: Data(json.utf8))
        let istanbul = try #require(TimeZone(identifier: "Europe/Istanbul"))
        let saturday = Date(timeIntervalSince1970: 1793599200 - 2 * 86_400)
        #expect(GoalPlanWords.next(goal, now: saturday, timeZone: istanbul, locale: Locale(identifier: "en_GB")) == "Next: Mon 09:00")
        #expect(GoalPlanWords.next(goal, now: saturday.addingTimeInterval(-21 * 86_400), timeZone: istanbul, locale: Locale(identifier: "en_GB")) == "Next: Mon 2 Nov at 09:00",
                "three weeks out, with its date")
        #expect(GoalPlanWords.next(plan([])) == nil, "one that can go on now")
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

    @Test func aDeadlineThatPassedAndAGoalWithNoEndStillOpenAroundNow() throws {
        // Due on day 5; it's day 8.
        let now = start.addingTimeInterval(8 * 86400)
        let late = GoalTimeline(plan([.init(id: "s1", text: "Site", state: .doing, began: at(0))], ends: start.addingTimeInterval(5 * 86400)), now: now)
        let window = try #require(late.window())
        #expect(window.contains(now))
        #expect(window.start >= late.start && window.end <= late.end, "within the axis")
        // No end: six days in, it opens on its last days with now among them, not past the axis.
        let open = GoalTimeline(plan([.init(id: "s1", text: "Site", state: .doing, began: at(0))]), now: start.addingTimeInterval(6.5 * 86400))
        let days = try #require(open.window())
        #expect(days.contains(open.now))
        #expect(days.start >= open.start && days.end <= open.end, "the days shown are all on the axis")
    }

    @Test func aStepUnderWaySaysWhatTheBotCountedNeverABarePercentage() {
        let counted = GoalPlan.Step(id: "s1", text: "Subscriber portal", state: .doing, progress: 0.6, note: "3 of 5 screens")
        #expect(GoalPlanWords.underWay(counted) == "3 of 5 screens", "beside the lane: the count, as the bot gave it")
        #expect(GoalPlanWords.spokenState(of: counted, in: plan([counted])) == "3 of 5 screens")
        let uncounted = GoalPlan.Step(id: "s2", text: "DNS", state: .doing)
        #expect(GoalPlanWords.underWay(uncounted) == "Under way")
        #expect(GoalPlanWords.spokenState(of: uncounted, in: plan([uncounted])) == "Under way")
        // A plan kept before counts were asked for: its share, said as about so much.
        let older = GoalPlan.Step(id: "s3", text: "Press kit", state: .doing, progress: 0.5)
        #expect(GoalPlanWords.underWay(older) == "About half")
    }

    @Test func aLongPlanIsSaidInAFewNamesAndHowManyMore() {
        let steps = (1...30).map { GoalPlan.Step(id: "s\($0)", text: "Step \($0)", state: .todo) }
        let outline = GoalPlanWords.outline(plan(steps))
        #expect(outline.contains("Step 6") && !outline.contains("Step 7"))
        #expect(outline.hasSuffix("24 more"))
    }

    @Test func startingWithNoEndTakesTheBotsEndAwayAndLeavingItAloneKeepsIt() throws {
        let json = { (answer: GoalPlanAnswer) throws -> [String: Any] in
            try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(answer)) as? [String: Any])
        }
        let cleared = try json(.start(wake: false, clearsEnd: true))
        #expect(cleared.keys.contains("ends") && cleared["ends"] is NSNull, "None picked: \"ends\": null")
        let untouched = try json(.start(wake: false))
        #expect(!untouched.keys.contains("ends"), "left out: the bot's end stands")
        let picked = try json(.start(wake: false, ends: Date(timeIntervalSince1970: 1_800_000_000), clearsEnd: true))
        #expect(picked["ends"] as? Double == 1_800_000_000_000, "an end picked wins")
        #expect(try json(.change(clearsEnd: true))["ends"] is NSNull)
    }
}
