import AppKit
import ClientSessions
import SwiftUI
import Testing
@testable import KuvoCode

/// A goal's steps as the pane shows them. On the timeline each step's pill holds its whole name
/// from where the step starts, never past the card's edge, the line along its foot as long as its
/// time. In the list, steps that start together come under one tall mark: past three, two of them
/// and a count, which opens the rest in place, with the pointer as with VoiceOver.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct GoalStepsShownTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private func at(_ minutes: Double) -> Double { (start.timeIntervalSince1970 + minutes * 60) * 1000 }
    private func date(_ minutes: Double) -> Date { Date(timeIntervalSince1970: at(minutes) / 1000) }

    /// A short step done, one under way three minutes in, and two placed after it: real names,
    /// longer than their steps' time.
    private var started: GoalPlan {
        let steps: [GoalPlan.Step] = [
            .init(id: "s1", text: "Research three app concepts", state: .done, began: at(0), ended: at(4)),
            .init(id: "s2", text: "Set up the Xcode project with SwiftData", state: .doing, after: ["s1"], began: at(4)),
            .init(id: "s3", text: "RevenueCat paywall and the test configuration", state: .todo, after: ["s2"]),
            .init(id: "s4", text: "Submit the first build for review", state: .todo, after: ["s3"]),
        ]
        return GoalPlan(id: "goal_1", bot: "bot_pixel", name: "Pixel", session: "ses_bot", goal: "Ship Sweep.", state: .running, steps: steps,
                        ends: nil, proposed: at(0), started: at(0), ended: nil, alone: true)
    }

    @Test(arguments: [420, 700, 1000] as [CGFloat])
    func everyPillHoldsItsWholeNameWithinTheCard(width: CGFloat) {
        let timeline = GoalTimeline(started, now: date(7))
        let chart = timeline.chart()
        let x = ChartX(shown: chart.shown, width: width, kept: GoalChartView.kept(chart, width: width))
        for bar in chart.bars {
            let pill = GoalChartView.pill(bar, chart: chart, x: x, now: timeline.now)
            #expect(pill.width >= GoalChartView.nameWidth(bar), "“\(bar.step.text)” whole at \(width) pt")
            #expect(pill.start + pill.width <= width + 0.5, "“\(bar.step.text)” within the card at \(width) pt")
            // Its foot line says how long it takes, which its name doesn't stretch.
            #expect(pill.time <= pill.width + 0.5)
        }
        let done = chart.bars[0]
        let pill = GoalChartView.pill(done, chart: chart, x: x, now: timeline.now)
        #expect(abs(pill.time - (x(date(4)) - x(date(0)))) < 0.5, "a step done: its line as long as it took")
    }

    /// A late step named longer than the card has room for: its name is cut, rather than every
    /// step's time, now and the due date drawn into a sliver at the left.
    @Test func timeKeepsHalfTheCardWhenALateStepIsNamedAtLength() {
        let steps: [GoalPlan.Step] = [
            .init(id: "s1", text: "Research three app concepts", state: .done, began: at(0), ended: at(4)),
            .init(id: "s2", text: "Set up the Xcode project", state: .doing, after: ["s1"], began: at(4)),
            .init(id: "s3", text: "Submit the first build for review with the screenshots, the privacy answers and the notes for reviewers", state: .todo, after: ["s2"]),
        ]
        let plan = GoalPlan(id: "goal_1", bot: "bot_pixel", name: "Pixel", session: "ses_bot", goal: "Ship Sweep.", state: .running, steps: steps,
                            ends: nil, proposed: at(0), started: at(0), ended: nil, alone: true)
        let chart = GoalTimeline(plan, now: date(7)).chart()
        let width: CGFloat = 420
        #expect(width - GoalChartView.kept(chart, width: width) >= width / 2)
    }

    @Test func theStepUnderWayRunsUntilTheStepAfterItIsPlacedToBegin() {
        let timeline = GoalTimeline(started, now: date(7))
        let chart = timeline.chart()
        let x = ChartX(shown: chart.shown, width: 700, kept: GoalChartView.kept(chart, width: 700))
        let doing = chart.bars[1], next = chart.bars[2]
        let pill = GoalChartView.pill(doing, chart: chart, x: x, now: timeline.now)
        let following = GoalChartView.pill(next, chart: chart, x: x, now: timeline.now)
        #expect(pill.time > x(date(7)) - x(date(4)), "past now, not a stub up to it")
        #expect(abs(pill.start + pill.time - following.start) < 0.5, "it ends where the step after it begins")
    }

    // MARK: Steps that start together

    /// One step under way and `together` after it that start at once, then one after all of them.
    private func together(_ together: Int) -> GoalPlan {
        let names = ["Onboarding screens", "Settings and the privacy page", "The scan engine’s duplicate finder", "Widgets for the Home Screen",
                     "Localize into German and Turkish", "App Store screenshots", "The paywall’s test configuration", "Crash reporting"]
        let ids = (1...together).map { "t\($0)" }
        let steps = [GoalPlan.Step(id: "s0", text: "Set up the Xcode project", state: .doing, began: at(0))]
            + ids.enumerated().map { GoalPlan.Step(id: $1, text: names[$0 % names.count], state: .todo, after: ["s0"]) }
            + [GoalPlan.Step(id: "s9", text: "Submit for review", state: .todo, after: ids)]
        return GoalPlan(id: "goal_2", bot: "bot_pixel", name: "Pixel", session: "ses_bot", goal: "Ship Sweep.", state: .running, steps: steps,
                        ends: nil, proposed: at(0), started: at(0), ended: nil, alone: true)
    }

    /// The list in a window of the test's own, `width` wide.
    private final class Shown {
        let window: NSWindow
        init(_ view: some View, width: CGFloat) {
            AXElement.reading(true)
            window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: width, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: view.frame(width: width, height: 700, alignment: .topLeading))
            window.orderBack(nil)
            window.contentView?.layoutSubtreeIfNeeded()
        }

        func close() {
            window.orderOut(nil)
            window.close()
            AXElement.reading(false)
        }

        /// What VoiceOver finds in it, as it lays out now. (Read while the window lays out, which
        /// `until` can't see: each look lays it out first, and says so on the main queue's next turn,
        /// once the wait is watching, for it to look again after SwiftUI's update.)
        var elements: [AXElement] {
            window.contentView?.layoutSubtreeIfNeeded()
            DispatchQueue.main.async { TestPulse.beat() }
            return AXElement.all(in: window.contentView)
        }

        var labels: [String] { elements.compactMap(\.label) }

        /// A click on what VoiceOver calls `label`, sent through the window.
        func click(_ label: String) throws {
            let found = elements.first { $0.label == label }
            let element = try #require(found, "“\(label)” among \(labels)")
            let frame = element.frame
            let point = window.convertPoint(fromScreen: NSPoint(x: frame.midX, y: frame.midY))
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                let event = try #require(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
                window.sendEvent(event)
            }
        }
    }

    private func names(_ shown: Shown, of plan: GoalPlan) -> [String] {
        let labels = Set(shown.labels)
        return plan.steps.map(\.text).filter(labels.contains)
    }

    @Test(arguments: [420, 900] as [CGFloat])
    func pastThreeTogetherTwoShowAndACountOpensTheRestInPlace(width: CGFloat) async throws {
        let plan = together(8)
        let shown = Shown(GoalStagesView(plan: plan, timeline: GoalTimeline(plan, now: date(3))), width: width)
        defer { shown.close() }
        let together = plan.steps.filter { $0.after == ["s0"] }.map(\.text)
        let folded = names(shown, of: plan)
        #expect(folded.filter(together.contains) == Array(together.prefix(2)), "two of the eight, in order: \(shown.labels)")
        #expect(folded.contains("Submit for review"), "and the step after them, in sight under the count")
        #expect(shown.labels.contains("Show 6 more"))

        try shown.click("Show 6 more")
        try await until { names(shown, of: plan).filter(together.contains).count == 8 }
        #expect(names(shown, of: plan).filter(together.contains) == together, "all eight, in order, where they were")
        #expect(!shown.labels.contains("Show 6 more"), "the count gone once they're open")
        #expect(names(shown, of: plan).contains("Submit for review"))
    }

    @Test func threeTogetherShowWholeWithNoCount() {
        let plan = together(3)
        let shown = Shown(GoalStagesView(plan: plan, timeline: GoalTimeline(plan, now: date(3))), width: 420)
        defer { shown.close() }
        #expect(names(shown, of: plan) == plan.steps.map(\.text), "every step: the one under way in its card, all three after it and the last")
        #expect(!shown.labels.contains { $0.hasPrefix("Show ") && $0.hasSuffix(" more") })
    }

    @Test func voiceOverOpensTheRestToo() async throws {
        let plan = together(5)
        let shown = Shown(GoalStagesView(plan: plan, timeline: GoalTimeline(plan, now: date(3))), width: 420)
        defer { shown.close() }
        let count = try #require(shown.elements.first { $0.label == "Show 3 more" }, "among \(shown.labels)")
        #expect(count.press())
        try await until { !shown.labels.contains("Show 3 more") }
        #expect(names(shown, of: plan) == plan.steps.map(\.text))
    }
}

/// One of what VoiceOver finds in a window, read the way it reads them (SwiftUI's own aren't
/// typed as `NSAccessibilityProtocol`, so each is asked as AppKit asks it).
struct AXElement {
    let object: AnyObject

    var label: String? { object.accessibilityLabel?() ?? nil }
    var help: String? { object.accessibilityHelp?() ?? nil }
    var frame: NSRect { object.accessibilityFrame?() ?? .zero }
    /// Whether VoiceOver says it's selected (a row's check mark).
    var isSelected: Bool { object.isAccessibilitySelected?() ?? false }
    func press() -> Bool { object.accessibilityPerformPress?() ?? false }
    var children: [AXElement] { ((object.accessibilityChildren?() ?? nil) ?? []).map { AXElement(object: $0 as AnyObject) } }

    /// SwiftUI builds what VoiceOver reads only while something reads it: switched on as VoiceOver
    /// does, by asking the app for its enhanced interface, and back off once the test is done.
    @MainActor static func reading(_ on: Bool) {
        _ = (NSApp as AnyObject).perform(Selector(("accessibilitySetValue:forAttribute:")), with: NSNumber(value: on), with: "AXEnhancedUserInterface")
    }

    @MainActor static func all(in view: NSView?) -> [AXElement] {
        guard let view else { return [] }
        func all(_ element: AXElement) -> [AXElement] { [element] + element.children.flatMap(all) }
        return all(AXElement(object: view))
    }
}
