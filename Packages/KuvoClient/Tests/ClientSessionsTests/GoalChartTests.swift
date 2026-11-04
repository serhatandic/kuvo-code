import ClientSessions
import Foundation
import Testing

/// A goal's timeline view, as both apps draw it: one row per step with its bar where it ran, what's
/// left placed after what it waits for at the pace so far until it has times of its own, the due
/// date on the axis or past its edge, and the list until a step begins.
struct GoalChartTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func plan(_ steps: [GoalPlan.Step], ends: Date? = nil, state: GoalPlan.State = .running, ended: Date? = nil) -> GoalPlan {
        GoalPlan(id: "goal_1", bot: "bot_pixel", name: "Pixel", session: "ses_bot", goal: "Ship Sweep.", state: state, steps: steps,
                 ends: ends.map { $0.timeIntervalSince1970 * 1000 }, proposed: start.timeIntervalSince1970 * 1000, started: start.timeIntervalSince1970 * 1000,
                 ended: ended.map { $0.timeIntervalSince1970 * 1000 }, alone: true)
    }

    private func at(_ hours: Double) -> Double { (start.timeIntervalSince1970 + hours * 3600) * 1000 }
    private func hours(_ hours: Double) -> Date { start.addingTimeInterval(hours * 3600) }

    /// Sweep, three steps in: two done, the paywall under way beside the dashboard's wait.
    private var sweep: [GoalPlan.Step] {
        [.init(id: "s1", text: "Set up the Xcode project", state: .done, phase: "Build", began: at(0), ended: at(0.6)),
         .init(id: "s2", text: "Photo scan engine", state: .done, phase: "Build", after: ["s1"], began: at(0.6), ended: at(1.8)),
         .init(id: "s3", text: "Storage dashboard", state: .todo, phase: "Build", after: ["s2"]),
         .init(id: "s4", text: "RevenueCat paywall", state: .doing, progress: 0.5, note: "2 of 4 screens", phase: "Build", after: ["s1"], began: at(0.7)),
         .init(id: "s5", text: "Icon and polish", state: .todo, phase: "Build", after: ["s3", "s4"]),
         .init(id: "s6", text: "Test on a device", state: .todo, phase: "Ship", after: ["s5"])]
    }

    @Test func eachStepRunsWhereItRanAndWhatsLeftFollowsWhatItWaitsFor() throws {
        let now = hours(2.2)
        let chart = GoalTimeline(plan(sweep), now: now).chart()
        let bar = { (id: String) in try #require(chart.bars.first { $0.id == id }) }
        #expect(try bar("s1").kind == .done && bar("s1").from == hours(0) && bar("s1").to == hours(0.6))
        #expect(try bar("s4").kind == .doing && bar("s4").to == now, "under way, up to now")
        #expect(try !bar("s1").isPlaced && !bar("s4").isPlaced)
        let dashboard = try bar("s3"), polish = try bar("s5"), device = try bar("s6")
        let paywallsEnd = try #require(chart.lanes.first { $0.id == "s4" }?.likelyEnd)
        let (dashboardFrom, dashboardTo) = (try #require(dashboard.from), try #require(dashboard.to))
        let (polishFrom, polishTo) = (try #require(polish.from), try #require(polish.to))
        let (deviceFrom, deviceTo) = (try #require(device.from), try #require(device.to))
        #expect(dashboard.isPlaced && dashboard.kind == .planned)
        #expect(dashboardFrom >= now, "a step not begun starts no earlier than now")
        #expect(polishFrom >= dashboardTo, "after the step it waits for")
        #expect(polishFrom >= paywallsEnd, "and after the paywall's likely end")
        #expect(deviceFrom >= polishTo)
        // The pace so far: the two steps done took 36 and 72 minutes.
        #expect(dashboardTo.timeIntervalSince(dashboardFrom) == 0.9 * 3600)
        #expect(chart.placesAny, "so it says they're placed until they have times")
        #expect(chart.shown.contains(now) && chart.shown.end >= deviceTo, "every step on the axis")
    }

    /// The start card's plan in a line: the steps in the order they start, those that start
    /// together side by side.
    @Test func thePlanInALineJoinsTheStepsThatStartTogether() {
        let steps = sweep.map { GoalPlan.Step(id: $0.id, text: $0.text, state: .todo, phase: $0.phase, after: $0.after) }
        #expect(GoalPlanWords.flow(plan(steps), now: hours(0.1)) == "Set up the Xcode project → Photo scan engine · RevenueCat paywall → Storage dashboard → Icon and polish → Test on a device")
        let free = ["Research", "Draft", "Publish"].enumerated().map { GoalPlan.Step(id: "s\($0.offset)", text: $0.element, state: .todo) }
        #expect(GoalPlanWords.flow(plan(free), now: hours(0.1)) == "Research · Draft · Publish", "steps that wait for nothing start together, as the list shows them")
    }

    @Test func beforeItStartsTheStepsGoInOrderUpToTheDueDate() throws {
        let now = hours(0.1)
        let due = start.addingTimeInterval(3 * 86400)
        let steps = sweep.map { GoalPlan.Step(id: $0.id, text: $0.text, state: .todo, phase: $0.phase, after: $0.after) }
        let chart = GoalTimeline(plan(steps, ends: due), now: now).chart()
        #expect(!chart.hasBegun)
        let froms = try chart.bars.map { try #require($0.from) }
        #expect(froms[0] == now, "the first from now")
        #expect(froms[2] > froms[1] && froms[1] > froms[0], "each after the step it waits for")
        #expect(froms[3] == froms[1], "the paywall waits only for the project, beside the scan engine")
        #expect(try #require(chart.bars.last?.to) <= due, "the plan fills the time up to the due date, no further")
        #expect(chart.due == due && !chart.isDuePastEdge, "the due date is on the axis")
        #expect(chart.shown.end > due)
    }

    @Test func aDueDateDaysPastTheWorkSitsAtTheEdge() {
        let now = hours(2.2)
        let chart = GoalTimeline(plan(sweep, ends: start.addingTimeInterval(4 * 86400)), now: now).chart()
        #expect(chart.isDuePastEdge && chart.due == nil, "four days out, past hours of work: at the edge")
        #expect(chart.shown.duration < 36 * 3600, "the axis keeps to the hours the work takes")
        let soon = GoalTimeline(plan(sweep, ends: hours(9)), now: now).chart()
        #expect(soon.due == hours(9) && !soon.isDuePastEdge, "due tonight: on the axis")
    }

    @Test func aStepUnderWayWithNoneDoneStillLeavesTheRestBeforeTheDueDate() throws {
        let now = hours(0.1)
        let due = start.addingTimeInterval(3 * 86400)
        let steps: [GoalPlan.Step] = [
            .init(id: "s1", text: "Set up the Xcode project", state: .doing, began: at(0)),
            .init(id: "s2", text: "Photo scan engine", state: .todo, after: ["s1"]),
            .init(id: "s3", text: "Storage dashboard", state: .todo, after: ["s2"])]
        let chart = GoalTimeline(plan(steps, ends: due), now: now).chart()
        #expect(try #require(chart.bars.last?.to) <= due, "on its first day, the goal doesn't look late already")
        #expect(chart.due == due)
    }

    @Test func stepsMarkedDoneInOneGoDontSetThePace() throws {
        // The bot marked two steps done straight from todo: they began as they ended.
        let steps: [GoalPlan.Step] = [
            .init(id: "s1", text: "Set up the Xcode project", state: .done, began: at(0), ended: at(1)),
            .init(id: "s2", text: "App icon", state: .done, after: ["s1"], began: at(1), ended: at(1)),
            .init(id: "s3", text: "Launch screen", state: .done, after: ["s1"], began: at(1), ended: at(1)),
            .init(id: "s4", text: "Storage dashboard", state: .todo, after: ["s2", "s3"])]
        let chart = GoalTimeline(plan(steps), now: hours(1.2)).chart()
        let dashboard = try #require(chart.bars.first { $0.id == "s4" })
        let (from, to) = (try #require(dashboard.from), try #require(dashboard.to))
        #expect(to.timeIntervalSince(from) == 3600, "the pace of the one step that really took time, not a minute")
    }

    @Test func aStepWaitingOnItselfOrInACircleStillGetsPlaced() {
        let steps: [GoalPlan.Step] = [
            .init(id: "s1", text: "One", state: .todo, after: ["s2"]),
            .init(id: "s2", text: "Two", state: .todo, after: ["s1"]),
            .init(id: "s3", text: "Three", state: .todo, after: ["s3"])]
        let chart = GoalTimeline(plan(steps), now: hours(0.1)).chart()
        #expect(chart.bars.allSatisfy { $0.from != nil && $0.to != nil })
    }

    @Test func aStepSaysWhatItWaitsFor() {
        let chart = GoalTimeline(plan(sweep), now: hours(2.2)).chart()
        #expect(chart.waitsFor("s5") == ["s3", "s4"])
        #expect(chart.waitsFor("s1").isEmpty)
    }

    @Test func aGoalThatsOverPlacesNothingAndAStepItLeftHasNoTime() {
        var steps = sweep
        steps[4] = .init(id: "s5", text: "Icon and polish", state: .skipped, phase: "Build")
        let chart = GoalTimeline(plan(steps, state: .stopped, ended: hours(2.5)), now: hours(9)).chart()
        #expect(!chart.placesAny)
        #expect(chart.bars.first { $0.id == "s5" }?.from == nil, "set aside, it's never drawn as if it ran")
        #expect(chart.bars.first { $0.id == "s4" }?.to == hours(2.5), "left under way, it stops where the goal did")
    }

    @Test func aGoalOpensOnTheListUntilAStepBegins() {
        let waiting = sweep.map { GoalPlan.Step(id: $0.id, text: $0.text, state: .todo, after: $0.after) }
        #expect(!GoalPlanWords.opensOnTimeline(plan(waiting)))
        #expect(GoalPlanWords.opensOnTimeline(plan(sweep)))
    }

    @Test func theListsLineSaysWhenItsDueAndTheTimelinesLeavesItToTheAxis() throws {
        let utc = try #require(TimeZone(identifier: "UTC"))
        let locale = Locale(identifier: "en_GB")
        let goal = plan(sweep, ends: Date(timeIntervalSince1970: 1_800_316_800))
        let list = GoalPlanWords.line(goal, due: true, now: hours(2.2), timeZone: utc, locale: locale)
        #expect(list.hasPrefix("2 of 6") && list.hasSuffix("due Tue 19 Jan"))
        #expect(!GoalPlanWords.line(goal, now: hours(2.2), timeZone: utc, locale: locale).contains("due"))
        let late = GoalPlanWords.line(goal, due: true, now: Date(timeIntervalSince1970: 1_800_400_000), timeZone: utc, locale: locale)
        #expect(late.hasSuffix("was due Tue 19 Jan"), "past it, it says so")
    }

    @Test func aStepAfterOneSetAsideStartsWhenItCanNotAStepLater() throws {
        let steps: [GoalPlan.Step] = [
            .init(id: "s1", text: "Logo", state: .skipped),
            .init(id: "s2", text: "Site", state: .todo, after: ["s1"])]
        let chart = GoalTimeline(plan(steps), now: hours(1)).chart()
        #expect(try #require(chart.bars.first { $0.id == "s2" }).from == hours(1), "nothing to wait for: it can start now")
        #expect(chart.bars.first { $0.id == "s1" }?.kind == .skipped, "set aside, never drawn as planned")
    }
}
