import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// A bot's goal as both apps show it over its composer: a short name on the bar, how far along it
/// is or, paused, why in a word; opened, its steps as rows top to bottom (the done ones folded,
/// phases heading theirs, each step's state in a few words that fit whole), and when it's likely
/// done and due under them.
struct GoalListTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private let utc = TimeZone(identifier: "UTC")!
    private let english = Locale(identifier: "en_US")

    private func plan(_ steps: [GoalPlan.Step], title: String? = "Landing page", goal: String = "Build Driftwood's landing page and take orders on it", ends: Date? = nil, state: GoalPlan.State = .running) -> GoalPlan {
        GoalPlan(id: "goal_1", bot: "bot_pixel", name: "Pixel", session: "ses_bot", goal: goal, title: title, state: state, steps: steps,
                 ends: ends.map { $0.timeIntervalSince1970 * 1000 }, proposed: start.timeIntervalSince1970 * 1000, started: start.timeIntervalSince1970 * 1000, alone: true)
    }

    private func at(_ hours: Double) -> Double { (start.timeIntervalSince1970 + hours * 3600) * 1000 }

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

    /// The drafts' landing page: two done, the site under way, the domain waiting for you, three to go.
    private var landing: [GoalPlan.Step] {
        [
            .init(id: "s1", text: "Pick a theme", state: .done, phase: "Build", began: at(0), ended: at(2)),
            .init(id: "s2", text: "Write the copy", state: .done, phase: "Build", began: at(1), ended: at(5)),
            .init(id: "s3", text: "Build the site", state: .doing, progress: 0.625, note: "5 of 8 pages", phase: "Build", began: at(4)),
            .init(id: "s4", text: "Buy the domain", state: .waiting, phase: "Build", began: at(6)),
            .init(id: "s5", text: "Point DNS at the host", state: .todo, phase: "Launch", after: ["s4"]),
            .init(id: "s6", text: "Deploy", state: .todo, phase: "Launch", after: ["s3", "s5"]),
            .init(id: "s7", text: "Add checkout", state: .todo, phase: "Launch"),
        ]
    }

    @Test func theBarNamesTheGoalInAFewWordsNeverItsSentence() {
        #expect(GoalPlanWords.name(plan(landing)) == "Landing page")
        // A plan kept before the bot named its goals: a short goal is its own name, a sentence isn't.
        #expect(GoalPlanWords.name(plan(landing, title: nil, goal: "Weekly summaries")) == "Weekly summaries")
        #expect(GoalPlanWords.name(plan(landing, title: nil)) == "Goal")
        #expect(GoalPlanWords.name(plan(landing, title: "  ")) == "Goal")
    }

    @Test func aPausedGoalSaysWhyInAWord() {
        #expect(GoalPlanWords.pausedBy(.you) == "You")
        #expect(GoalPlanWords.pausedBy(.limit) == "Limit")
        #expect(GoalPlanWords.pausedBy(.error) == "Error")
        #expect(GoalPlanWords.pausedBy(.stalled) == "Stalled")
    }

    @Test func theStepsAreRowsWithTheDoneOnesFoldedAndPhasesHeadingTheirs() {
        let timeline = GoalTimeline(plan(landing), now: start.addingTimeInterval(7 * 3600))
        #expect(names(timeline.list()) == ["2 done", "phase Build", "Build the site", "Buy the domain", "phase Launch", "Point DNS at the host", "Deploy", "Add checkout"])
        // Opened, the done ones show under their fold.
        #expect(names(timeline.list(showsDone: true)).prefix(3) == ["2 done", "Pick a theme", "Write the copy"])
    }

    @Test func aGoalThatsAllDoneShowsItsStepsRatherThanOneFold() {
        let done = landing.map { GoalPlan.Step(id: $0.id, text: $0.text, state: .done, phase: $0.phase, began: at(0), ended: at(8)) }
        let timeline = GoalTimeline(plan(done, state: .done), now: start.addingTimeInterval(9 * 3600))
        #expect(!names(timeline.list()).contains("7 done"))
        #expect(names(timeline.list()).filter { !$0.hasPrefix("phase") }.count == 7)
    }

    @Test func aLongPlanFoldsWhatsLaterIntoOneRowWhateverItsLength() {
        let steps = (1...20).map { (week: Int) -> GoalPlan.Step in
            let state: GoalPlan.Step.State = week <= 3 ? .done : week == 4 ? .doing : .todo
            let began: Double? = week <= 4 ? at(Double(week) * 24) : nil
            let ended: Double? = week <= 3 ? at(Double(week) * 24 + 2) : nil
            return GoalPlan.Step(id: "s\(week)", text: "Week \(week) summary", state: state, began: began, ended: ended)
        }
        let timeline = GoalTimeline(plan(steps), now: start.addingTimeInterval(4.5 * 86400))
        #expect(names(timeline.list()) == ["3 done", "Week 4 summary", "16 later"])
        #expect(names(timeline.list(showsLater: true)).count == 3 + 16)
        // A few left aren't folded away.
        let few = Array(steps.prefix(7))
        #expect(names(GoalTimeline(plan(few), now: start.addingTimeInterval(4.5 * 86400)).list()) == ["3 done", "Week 4 summary", "Week 5 summary", "Week 6 summary", "Week 7 summary"])
    }

    @Test func eachStepSaysWhereItIsInAFewWords() {
        let goal = plan(landing)
        let now = start.addingTimeInterval(7 * 3600)
        let said = Dictionary(uniqueKeysWithValues: goal.steps.map { ($0.id, GoalPlanWords.state(of: $0, in: goal, now: now, timeZone: utc, locale: english)) })
        #expect(said["s3"]?.text == "5 of 8 pages", "what the bot counted")
        #expect(said["s4"]?.text == "Needs you" && said["s4"]?.tone == .needsYou)
        #expect(said["s5"]?.text == "After Buy the domain")
        #expect(said["s6"]?.text == "After 2 steps", "never a list of names run together")
        #expect(said["s7"]?.text == nil, "nothing to wait for: nothing to say")
        let paused = GoalPlan.Step(id: "p", text: "Post the ads", state: .paused, resumes: (start.timeIntervalSince1970 + 9 * 3600) * 1000)
        #expect(GoalPlanWords.state(of: paused, in: goal, now: now, timeZone: utc, locale: english).text?.replacingOccurrences(of: "\u{202F}", with: " ") == "Until 5:00 PM")
    }

    @Test func underTheStepsItSaysWhenItsLikelyDoneAndDue() {
        // Friday 15 January 2027 at 15:00 UTC; the site, half built in two days, is likely done Sunday.
        let now = start.addingTimeInterval(7 * 3600)
        let measured: [GoalPlan.Step] = [.init(id: "s1", text: "Build the site", state: .doing, progress: 0.5, began: at(-41))]
        let goal = plan(measured, ends: start.addingTimeInterval(10 * 86400))
        let timeline = GoalTimeline(goal, now: now)
        #expect(GoalPlanWords.finish(timeline, timeZone: utc, locale: english) == "Likely done Sun · due Mon, Jan 25")
        // Nothing measured, no end: nothing to say.
        let open = GoalTimeline(plan([.init(id: "s1", text: "Build the site", state: .doing, began: at(0))]), now: now)
        #expect(GoalPlanWords.finish(open, timeZone: utc, locale: english) == nil)
    }

    @Test func aLongGoalsTracksOpenOnTodayNotItsFarEnd() throws {
        // Day 9 of a month-long goal: the tracks show the days around today, today among them.
        let steps: [GoalPlan.Step] = [.init(id: "s1", text: "Subscriber portal", state: .doing, began: at(0))]
        let now = start.addingTimeInterval(8.6 * 86400)
        let timeline = GoalTimeline(plan(steps, ends: start.addingTimeInterval(30 * 86400)), now: now)
        let shown = timeline.shown()
        #expect(shown.contains(now))
        #expect(shown.end < timeline.end, "not the goal's far end")
        #expect(shown.start > timeline.start)
        // Zoomed out, the whole goal.
        #expect(timeline.shown(whole: true) == DateInterval(start: timeline.start, end: timeline.end))
    }
}
