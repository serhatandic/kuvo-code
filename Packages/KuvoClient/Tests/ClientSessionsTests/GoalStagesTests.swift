import ClientSessions
import Foundation
import Testing

/// A goal's list view, as both apps draw it: what's done, the step or steps under way as cards,
/// and what's ahead, with steps that start together on one row.
struct GoalStagesTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func plan(_ steps: [GoalPlan.Step], state: GoalPlan.State = .running, ended: Date? = nil) -> GoalPlan {
        GoalPlan(id: "goal_1", bot: "bot_pixel", name: "Pixel", session: "ses_bot", goal: "Ship Sweep.", state: state, steps: steps,
                 proposed: start.timeIntervalSince1970 * 1000, started: start.timeIntervalSince1970 * 1000,
                 ended: ended.map { $0.timeIntervalSince1970 * 1000 }, alone: true)
    }

    private func at(_ hours: Double) -> Double { (start.timeIntervalSince1970 + hours * 3600) * 1000 }
    private func hours(_ hours: Double) -> Date { start.addingTimeInterval(hours * 3600) }

    /// Sweep: the project, then the scan engine and the paywall together; the dashboard after the
    /// scan engine, the polish after the paywall, the device after both, then the listing and review.
    private func sweep(_ states: [String: GoalPlan.Step.State] = [:], began: [String: Double] = [:], ended: [String: Double] = [:]) -> [GoalPlan.Step] {
        let shape: [(String, String, [String])] = [
            ("p1", "Xcode project", []), ("p2", "Photo scan engine", ["p1"]), ("p3", "Storage dashboard", ["p2"]),
            ("p4", "RevenueCat paywall", ["p1"]), ("p5", "Icon and polish", ["p4"]), ("p6", "Test on a device", ["p3", "p5"]),
            ("p7", "Store listing", ["p6"]), ("p8", "Submit for review", ["p7"])]
        return shape.map { id, text, after in
            .init(id: id, text: text, state: states[id] ?? .todo, after: after, began: began[id].map(at), ended: ended[id].map(at))
        }
    }

    private func ids(_ lanes: [GoalTimeline.Lane]) -> [String] { lanes.map(\.id) }

    @Test func beforeItStartsTheFirstStepWaitsInTheCardAndWhatStartsTogetherSharesARow() {
        let stages = GoalTimeline(plan(sweep()), now: hours(0)).stages()
        #expect(stages.done.isEmpty)
        #expect(stages.now.map(\.id) == ["p1"] && stages.now.allSatisfy { $0.look == .ready }, "the first step, grey until it starts")
        #expect(stages.ahead.map(ids) == [["p2", "p4"], ["p3", "p5"], ["p6"], ["p7"], ["p8"]],
                "the scan engine and the paywall start together; then the dashboard and the polish")
        #expect(stages.number("p4") == 4, "steps keep their numbers in the plan")
    }

    @Test func pastThreeUnderWayTheRestAreNamedUnderTheCardsThoseWaitingForYouShownFirst() {
        let steps = sweep(["p1": .done, "p2": .doing, "p3": .doing, "p4": .doing, "p5": .waiting],
                          began: ["p1": 0, "p2": 0.6, "p3": 0.7, "p4": 0.8, "p5": 0.9], ended: ["p1": 0.6])
        let stages = GoalTimeline(plan(steps), now: hours(2)).stages()
        #expect(stages.now.count == 4)
        #expect(stages.cards.shown.map(\.id) == ["p2", "p3", "p5"], "three cards, the one waiting for you among them, in the plan's order")
        #expect(stages.cards.rest.map(\.id) == ["p4"])
        let two = GoalTimeline(plan(sweep(["p1": .done, "p2": .doing, "p4": .doing], began: ["p1": 0, "p2": 0.6, "p4": 0.6], ended: ["p1": 0.6])), now: hours(1)).stages()
        #expect(two.cards.shown.count == 2 && two.cards.rest.isEmpty, "up to three, every one a card")
    }

    @Test func twoStepsUnderWayShareTheCardsAndWhatsDoneIsInOrder() {
        let steps = sweep(["p1": .done, "p2": .done, "p4": .done, "p3": .doing, "p5": .doing],
                          began: ["p1": 0, "p2": 0.6, "p4": 0.6, "p3": 1.8, "p5": 1.5],
                          ended: ["p1": 0.6, "p2": 1.8, "p4": 1.5])
        let stages = GoalTimeline(plan(steps), now: hours(2.2)).stages()
        #expect(ids(stages.done) == ["p1", "p2", "p4"])
        #expect(stages.now.map(\.id) == ["p3", "p5"] && stages.now.allSatisfy { $0.look == .doing }, "one card over the other, in the plan's order")
        #expect(stages.ahead.map(ids) == [["p6"], ["p7"], ["p8"]])
    }

    @Test func aStepWaitingOnYouIsACardOfItsOwnBesideTheOneUnderWay() {
        let steps = sweep(["p1": .done, "p2": .doing, "p4": .waiting], began: ["p1": 0, "p2": 0.6, "p4": 0.6], ended: ["p1": 0.6])
        let stages = GoalTimeline(plan(steps), now: hours(1)).stages()
        #expect(stages.now.map(\.id) == ["p2", "p4"])
        #expect(stages.now.map(\.look) == [.doing, .waiting])
    }

    @Test func betweenStepsTheFirstThatCanStartWaitsInAGreyCard() {
        let steps = sweep(["p1": .done], began: ["p1": 0], ended: ["p1": 0.6])
        let stages = GoalTimeline(plan(steps), now: hours(0.7)).stages()
        #expect(stages.now.map(\.id) == ["p2"] && stages.now.allSatisfy { $0.look == .ready }, "the first that can start")
        #expect(stages.ahead.first.map(ids) == ["p4"], "the other that can start now is next")
    }

    @Test func aGoalThatsOverHasNoCardsAndWhatItLeftIsInOrder() {
        let steps = sweep(["p1": .done, "p2": .done, "p4": .doing], began: ["p1": 0, "p2": 0.6, "p4": 0.6], ended: ["p1": 0.6, "p2": 1.8])
        let stages = GoalTimeline(plan(steps, state: .stopped, ended: hours(2)), now: hours(3)).stages()
        #expect(stages.now.isEmpty)
        #expect(ids(stages.done) == ["p1", "p2"])
        #expect(stages.ahead.map(ids) == [["p3"], ["p4"], ["p5"], ["p6"], ["p7"], ["p8"]], "set aside, one to a row")
    }

    @Test func aStepInACircleStillShows() {
        let steps: [GoalPlan.Step] = [.init(id: "s1", text: "One", state: .todo, after: ["s2"]), .init(id: "s2", text: "Two", state: .todo, after: ["s1"])]
        let stages = GoalTimeline(plan(steps), now: hours(0)).stages()
        #expect(Set(stages.now.map(\.id) + stages.ahead.flatMap(ids)) == ["s1", "s2"])
        #expect(!stages.now.isEmpty, "something stands in the card")
    }

    @Test func aCardSaysAboutHowLongIsLeftOnlyWhereItWasMeasured() throws {
        let steps = sweep(["p1": .done, "p2": .doing, "p4": .doing], began: ["p1": 0, "p2": 1, "p4": 1], ended: ["p1": 1])
        var measured = steps
        measured[1] = .init(id: "p2", text: "Photo scan engine", state: .doing, progress: 0.5, after: ["p1"], began: at(1))
        let stages = GoalTimeline(plan(measured), now: hours(2)).stages()
        let (scan, paywall) = (try #require(stages.now.first { $0.id == "p2" }), try #require(stages.now.first { $0.id == "p4" }))
        #expect(GoalPlanWords.left(scan, now: hours(2)) == "about 1 h left", "half done in an hour")
        #expect(GoalPlanWords.left(paywall, now: hours(2)) == nil, "not measured: it doesn't guess")
        let near = GoalTimeline(plan(measured), now: hours(1.9)).stages()
        #expect(near.now.first.flatMap { GoalPlanWords.left($0, now: hours(1.9)) } == "about 55 min left")
    }

    /// The box sends a step's one line on what's in it; an older box's goal has none and still reads.
    @Test func aStepsShortDescriptionComesFromTheBoxAndOldGoalsHaveNone() throws {
        let json = #"{"id": "goal_1", "bot": "bot_1", "name": "Pixel", "session": "ses_1", "goal": "Ship Sweep", "state": "running", "proposed": 1, "alone": true, "steps": [{"id": "s1", "text": "RevenueCat paywall", "detail": "SDK, paywall and a StoreKit test config", "state": "doing"}, {"id": "s2", "text": "Icon and polish", "state": "todo"}]}"#
        let goal = try JSONDecoder().decode(GoalPlan.self, from: Data(json.utf8))
        #expect(goal.steps.map(\.detail) == ["SDK, paywall and a StoreKit test config", nil])
    }

    /// A plan given as plain steps waits on nothing, so they could all start at once: one waits in
    /// the card, the rest ahead together, never a column of grey cards.
    @Test func stepsThatCouldAllStartAtOnceWaitInOneCardWithTheRestAhead() {
        let steps = (1...9).map { GoalPlan.Step(id: "s\($0)", text: "Step \($0)", state: .todo) }
        let stages = GoalTimeline(plan(steps), now: hours(0)).stages()
        #expect(stages.now.map(\.id) == ["s1"])
        #expect(stages.ahead.map(ids) == [["s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]])
        let between = sweep(["p1": .done], began: ["p1": 0], ended: ["p1": 0.6])
        #expect(GoalTimeline(plan(between), now: hours(0.7)).stages().now.map(\.id) == ["p2"], "between steps too: the first that can start")
    }

    /// Paused, the step under way stays doing on the box: its card shows it paused, with no time left.
    @Test func aPausedGoalsCardsShowItPaused() throws {
        var steps = sweep(["p1": .done], began: ["p1": 0], ended: ["p1": 1])
        steps[1] = .init(id: "p2", text: "Photo scan engine", state: .doing, progress: 0.5, after: ["p1"], began: at(1))
        let stages = GoalTimeline(plan(steps), now: hours(2)).stages(paused: true)
        let card = try #require(stages.now.first)
        #expect(card.look == .paused)
        #expect(GoalPlanWords.left(card, now: hours(2)) == nil)
    }
}
