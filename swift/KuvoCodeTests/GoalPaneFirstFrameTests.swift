import AppKit
import ClientSessions
import SwiftUI
import Testing
@testable import KuvoCode

/// A goal's pane lays out as it stays from its first frame: the list in the arrangement its width
/// asks for, its rows drawn, and the goal's words with Show More where two lines cut them. Each is
/// laid out once, as the first frame is, with nothing measured before it.
@MainActor
struct GoalPaneFirstFrameTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private func at(_ hours: Double) -> Double { (start.timeIntervalSince1970 + hours * 3600) * 1000 }

    /// Sweep with three done and two under way together, three ahead.
    private var sweep: GoalPlan {
        let steps: [GoalPlan.Step] = [
            .init(id: "s1", text: "Set up the Xcode project", state: .done, began: at(0), ended: at(0.6)),
            .init(id: "s2", text: "Photo scan engine", state: .done, after: ["s1"], began: at(0.6), ended: at(1.8)),
            .init(id: "s3", text: "Storage dashboard", state: .done, after: ["s2"], began: at(1.8), ended: at(2.4)),
            .init(id: "s4", text: "RevenueCat paywall", state: .doing, progress: 0.5, note: "2 of 4 screens", detail: "SDK, paywall, test config", after: ["s1"], began: at(2.4)),
            .init(id: "s5", text: "Icon and polish", state: .doing, detail: "Icon, launch, empty states", after: ["s3"], began: at(2.4)),
            .init(id: "s6", text: "Test on a device", state: .todo, after: ["s4", "s5"]),
            .init(id: "s7", text: "App Store kit", state: .todo, after: ["s6"]),
            .init(id: "s8", text: "Submit for review", state: .todo, after: ["s7"]),
        ]
        return GoalPlan(id: "goal_1", bot: "bot_pixel", name: "Pixel", session: "ses_bot", goal: "Ship Sweep.", state: .running, steps: steps,
                        ends: nil, proposed: at(0), started: at(0), ended: nil, alone: true)
    }

    /// Its size in the first layout pass of a fresh window's view: what the first frame is laid out
    /// from, before anything has been placed (so before any geometry it reads comes back to it).
    private func drawn(_ view: some View, width: CGFloat) throws -> CGSize {
        let host = NSHostingController(rootView: view.frame(width: width).fixedSize(horizontal: false, vertical: true))
        return host.sizeThatFits(in: CGSize(width: width, height: 10_000))
    }

    private func list(width: CGFloat) throws -> CGSize {
        try drawn(GoalStagesView(plan: sweep, timeline: GoalTimeline(sweep, now: Date(timeIntervalSince1970: at(2.6) / 1000))), width: width)
    }

    @Test func theListIsDrawnInItsArrangementFromTheFirstFrame() throws {
        let narrow = try list(width: 420), wide = try list(width: 900)
        // Wide, the columns side by side are as tall as the two cards; narrow, what's done, the
        // cards and the rows ahead come one under the other.
        #expect(wide.height >= 2 * 60, "the cards drawn beside the rows: \(wide.height) pt")
        #expect(narrow.height > wide.height + 3 * GoalStagesView.rowHeight, "top to bottom in a narrow pane: \(narrow.height) against \(wide.height) pt")
    }

    /// Pixel's goal with one step under way and `ahead` steps after it, one after another.
    private func chain(ahead: Int) -> GoalPlan {
        let steps = [GoalPlan.Step(id: "s0", text: "Set up the Xcode project", state: .doing, began: at(0))]
            + (1...ahead).map { GoalPlan.Step(id: "s\($0)", text: "Step \($0)", state: .todo, after: ["s\($0 - 1)"]) }
        return GoalPlan(id: "goal_2", bot: "bot_pixel", name: "Pixel", session: "ses_bot", goal: "Ship Sweep.", state: .running, steps: steps,
                        ends: nil, proposed: at(0), started: at(0), ended: nil, alone: true)
    }

    @Test func manyStepsAheadScrollPastTenRowsEndingOnAWholeRow() throws {
        let height = { (ahead: Int) throws -> CGFloat in
            let plan = chain(ahead: ahead)
            return try drawn(GoalStagesView(plan: plan, timeline: GoalTimeline(plan, now: Date(timeIntervalSince1970: at(1) / 1000))), width: 420).height
        }
        let ten = try height(10)
        #expect(try height(5) < ten, "fewer rows, a shorter list")
        #expect(try height(11) == ten, "past ten rows, the rest scroll")
        #expect(try height(30) == ten)
    }

    @Test func showMoreIsThereFromTheFirstFrameWhereTwoLinesCutTheWords() throws {
        let short = try drawn(GoalText(text: "Ship Sweep."), width: 300)
        let twoLines = try drawn(GoalText(text: "Ship Sweep, a photo cleaner for iPhone: a scan engine that finds duplicates and blurry shots."), width: 300)
        let long = try drawn(GoalText(text: String(repeating: "Ship Sweep, a photo cleaner for iPhone with no backend. ", count: 6)), width: 300)
        #expect(twoLines.height > short.height, "two lines, whole")
        #expect(long.height > twoLines.height + 8, "two lines of it, and Show More under them: \(long.height) against \(twoLines.height) pt")
    }

    @Test func wordsTwoLinesHoldGetNoShowMoreWhateverIsInThem() throws {
        for words in ["Ship Sweep, a photo cleaner for iPhone: a scan engine that finds duplicates and blurry shots.",
                      "Ship **Sweep** 🧹📸 with `RevenueCat` for payments, and a scan that finds duplicates.",
                      "スイープを出荷する。写真の重複とぼやけた写真を見つけるアプリです。"] {
            let whole = try drawn(Text(GoalText.markdown(words)).font(.system(size: 12.5)).fixedSize(horizontal: false, vertical: true), width: 300)
            let shown = try drawn(GoalText(text: words), width: 300)
            #expect(whole.height > 20, "two lines at 300 pt: \(words)")
            #expect(abs(shown.height - whole.height) < 1, "the words whole, no Show More under them: \(words), \(shown.height) against \(whole.height) pt")
        }
    }
}
