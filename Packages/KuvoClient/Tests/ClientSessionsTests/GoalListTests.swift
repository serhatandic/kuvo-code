import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// A bot's goal as both apps show it over its composer: a short name on the bar, how far along it
/// is or, paused, why in a word; opened, its steps as rows top to bottom in the plan's order (the
/// done ones folded, each step's state in a few words that fit whole, and no phases, even an old
/// goal's), and when it's likely done and due under them.
struct GoalListTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private let utc = TimeZone(identifier: "UTC")!
    private let english = Locale(identifier: "en_US")

    private func plan(_ steps: [GoalPlan.Step], title: String? = "Landing page", goal: String = "Build Driftwood's landing page and take orders on it", ends: Date? = nil, state: GoalPlan.State = .running) -> GoalPlan {
        GoalPlan(id: "goal_1", bot: "bot_pixel", name: "Pixel", session: "ses_bot", goal: goal, title: title, state: state, steps: steps,
                 ends: ends.map { $0.timeIntervalSince1970 * 1000 }, proposed: start.timeIntervalSince1970 * 1000, started: start.timeIntervalSince1970 * 1000, alone: true)
    }

    private func at(_ hours: Double) -> Double { (start.timeIntervalSince1970 + hours * 3600) * 1000 }

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

    @Test func theBarsLineSaysHowFarAlongAndPausedWhyNeverTheSteps() {
        let now = start.addingTimeInterval(3 * 86400 + 3600)
        #expect(GoalPlanWords.line(plan(landing), now: now) == "2 of 7 · 3 days")
        #expect(GoalPlanWords.line(plan(landing), now: start.addingTimeInterval(2 * 3600 + 5 * 60)) == "2 of 7 · 2 h 5 min")
        #expect(GoalPlanWords.line(plan(landing), pausedBy: .some(.you), now: now) == "Paused · You")
        #expect(GoalPlanWords.line(plan(landing), pausedBy: .some(.error), now: now) == "Paused · Error")
        #expect(GoalPlanWords.line(plan(landing), pausedBy: .some(nil), now: now) == "Paused")
        #expect(GoalPlanWords.line(plan(landing, state: .stopped), now: now) == "Stopped · 2 of 7")
        // A paused goal that's over says it's over.
        #expect(GoalPlanWords.line(plan(landing, state: .stopped), pausedBy: .some(.you), now: now) == "Stopped · 2 of 7")
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

    @Test func aStoppedGoalsUnfinishedStepsAreNotDoneNeverStillUnderWay() {
        let goal = plan(landing, state: .stopped)
        let now = start.addingTimeInterval(7 * 3600)
        let site = goal.steps[2], domain = goal.steps[3], theme = goal.steps[0]
        #expect(GoalPlanWords.shownState(of: site, in: goal) == .skipped)
        let said = GoalPlanWords.state(of: domain, in: goal, now: now)
        #expect(said.text == "Not done" && said.tone == .quiet, "no orange Needs you under a goal that’s over")
        #expect(GoalPlanWords.shownState(of: theme, in: goal) == .done, "what was done stays done")
        #expect(GoalPlanWords.spokenState(of: site, in: goal, now: now) == "not done")
        // Running, the same steps say where they are.
        #expect(GoalPlanWords.shownState(of: site, in: plan(landing)) == .doing)
    }

    @Test func voiceOverReadsWhereAStepIsOnce() {
        let goal = plan(landing)
        let now = start.addingTimeInterval(7 * 3600)
        #expect(GoalPlanWords.spokenState(of: goal.steps[2], in: goal, now: now) == "5 of 8 pages")
        #expect(GoalPlanWords.spokenState(of: goal.steps[3], in: goal, now: now) == "waiting for you")
        #expect(GoalPlanWords.spokenState(of: goal.steps[4], in: goal, now: now) == "not started, after Buy the domain")
        #expect(GoalPlanWords.spokenState(of: goal.steps[0], in: goal, now: now) == "done")
    }

    @Test func aStepAfterOneWithALongNameSaysHowManyNotTheName() {
        let steps: [GoalPlan.Step] = [
            .init(id: "w1", text: "Summarise the week’s commits, releases and open questions (1 of 9)", state: .doing, began: at(0)),
            .init(id: "w2", text: "Summarise the week’s commits, releases and open questions (2 of 9)", state: .todo, after: ["w1"]),
        ]
        let goal = plan(steps)
        #expect(GoalPlanWords.state(of: steps[1], in: goal).text == "After 1 step")
    }

    @Test func aDeadlineThatPassedSaysItWasDueNotAWeekdayToCome() {
        // Friday 15 January 2027; it was due Tuesday the 12th.
        let goal = plan([.init(id: "s1", text: "Build the site", state: .doing, began: at(0))], ends: start.addingTimeInterval(-3 * 86400))
        let timeline = GoalTimeline(goal, now: start.addingTimeInterval(7 * 3600))
        #expect(GoalPlanWords.finish(timeline, timeZone: utc, locale: english) == "Was due Tue, Jan 12")
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

    /// In the bot's own conversation, what it asks there is its question card, so it isn't a row of
    /// what's waiting as well; a session's ask, and what the bot kept for you, still are.
    @Test func theBotsOwnQuestionIsntARowInItsConversationAsItsCardShowsIt() {
        let waiting: [GoalPlan.Waiting] = [
            .init(id: "w1", kind: .you, text: "Apple Developer Program membership", at: at(0)),
            .init(id: "ask:ses_bot:frm_1", kind: .ask, text: "Pixel asks: Go with LeafCheck, or change it?", session: "ses_bot", at: at(1)),
            .init(id: "ask:ses_site:per_1", kind: .ask, text: "Build the site: Run npm install outside the sandbox", session: "ses_site", at: at(2)),
        ]
        let shown = GoalPlan(id: "goal_1", bot: "bot_pixel", name: "Pixel", session: "ses_bot", goal: "Launch LeafCheck", state: .running, steps: landing,
                             proposed: at(0), started: at(0), waiting: waiting, alone: true)
        #expect(shown.waitingInItsConversation.map(\.id) == ["w1", "ask:ses_site:per_1"])
        #expect(shown.waiting.count == 3, "elsewhere, all three")
    }
}

/// A goal's calls, as a box sends them and a client answers one.
@Suite struct GoalCallsTests {
    @Test func aGoalsCallsDecodeAndYourChoiceOnOneGoesAsItsBoxReadsIt() throws {
        let json = #"{"id":"g","bot":"b","name":"Ada","session":"s","goal":"Ship","state":"running","steps":[],"proposed":1,"mode":"autopilot","decided":[{"id":"ask:s:frm","text":"Which roast?","choice":"Warm","why":"best reviewed","options":["Warm","Dark"],"session":"s","at":2,"yours":{"choice":"Dark","at":3}}]}"#
        let plan = try JSONDecoder().decode(GoalPlan.self, from: Data(json.utf8))
        let call = try #require(plan.decided.first)
        #expect(call.choice == "Warm")
        #expect(call.options == ["Warm", "Dark"])
        #expect(call.yours?.choice == "Dark")

        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(GoalPlanAnswer.decided(call.id, choice: "Warm"))) as? [String: Any]
        #expect(sent?["action"] as? String == "decided")
        #expect(sent?["decided"] as? String == "ask:s:frm")
        #expect(sent?["choice"] as? String == "Warm")
    }

    @Test func aBoxFromBeforeItsCallsHasNone() throws {
        let json = #"{"id":"g","bot":"b","name":"Ada","session":"s","goal":"Ship","state":"running","steps":[],"proposed":1}"#
        #expect(try JSONDecoder().decode(GoalPlan.self, from: Data(json.utf8)).decided.isEmpty)
    }
}
