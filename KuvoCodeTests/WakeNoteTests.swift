import AppKit
import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A wake-up in a conversation: "Woke up", a short summary of its note (the one its agent gave, or
/// the note's first sentence) and the time, on a card. A click opens it to the note its agent read,
/// whole, taking the card's room (not a narrow column before the time), and folds it again; a
/// short note shows whole on its row.
@MainActor
@Suite(.serialized) struct WakeNoteTests {
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 500, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
    static let note = "Check the harbor log. " + String(repeating: "Read the tide tables, and write down what changed. ", count: 4)
    /// The card's own, so what's opened isn't another test's.
    let id = "msg_" + UUID().uuidString.prefix(8)
    @MainActor @Observable final class Probe { var isOn = false }
    struct ProbeView: View {
        let probe: Probe
        var body: some View { Color.clear.frame(width: probe.isOn ? 2 : 1, height: 1) }
    }
    let probe = Probe()

    /// A fold started just now has finished (see `StepsStayOpenTests`).
    private func settled() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            withAnimation(.ui) { probe.isOn.toggle() } completion: { done.resume() }
        }
    }

    init() {
        TestEnvironment.prepare()
        window.isReleasedWhenClosed = false
        AXElement.reading(true)
    }

    private func show(_ text: String, summary: String? = nil, finding: String? = nil) {
        let metadata: JSONValue? = summary.map { .object(["kuvo": .object(["wake": .object(["summary": .string($0)])])]) }
        let wake = WakeMessage.of(text: Wakes.marker + text, metadata: metadata)!
        window.contentView = NSHostingView(rootView: WakeRow(id: id, wake: wake, at: 0).frame(width: 500).background(ProbeView(probe: probe))
            .environment(\.findHighlight, finding.map { FindHighlight(query: $0, current: 0) }))
        window.orderBack(nil)
    }

    private func done() {
        window.orderOut(nil)
        window.close()
        window.contentView = nil
        AXElement.reading(false)
    }

    private func all(in view: NSView?) -> [SelectableTextView] {
        guard let view else { return [] }
        return ((view as? SelectableTextView).map { [$0] } ?? []) + view.subviews.flatMap { all(in: $0) }
    }

    /// What VoiceOver reads in the window, as it lays out now.
    private var labels: [String] {
        window.contentView?.layoutSubtreeIfNeeded()
        return AXElement.all(in: window.contentView).compactMap(\.label)
    }

    /// The note, once it's laid out in the window.
    private func laidOutNote() async -> SelectableTextView? {
        for _ in 0..<400 {
            window.contentView?.layoutSubtreeIfNeeded()
            if let words = all(in: window.contentView).first(where: { $0.string.contains("tide tables") }), words.frame.width > 0 { return words }
            await Task.yield()
        }
        return nil
    }

    /// A click on the card's "Woke up", through the window, as AppKit routes it.
    private func clickTheCard() throws {
        window.contentView?.layoutSubtreeIfNeeded()
        let found = try #require(AXElement.all(in: window.contentView).first { $0.label?.contains("Woke up") == true }, "“Woke up” among \(labels)")
        let point = window.convertPoint(fromScreen: NSPoint(x: found.frame.midX, y: found.frame.midY))
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try #require(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
    }

    @Test func aLongNoteShowsItsSummaryAndOpensToTheWholeNote() async throws {
        defer { done() }
        show(Self.note, summary: "Check the harbor log")
        #expect(labels.contains { $0.contains("Check the harbor log") }, "\(labels)")
        #expect(!labels.contains { $0.contains("tide tables") }, "folded, the note's rest isn't there: \(labels)")

        try clickTheCard()
        let words = try #require(await laidOutNote(), "opened, the note shows")
        #expect(words.string == Self.note, "the note whole")
        // The card, less its leading room for the icon.
        #expect(words.frame.width > 350, "the note wraps at \(words.frame.width) points of a 500-point card")

        // Again soon after, as VoiceOver presses it: SwiftUI can leave out a click that closely
        // follows another, as no one clicks.
        let card = try #require(AXElement.all(in: window.contentView).first { $0.label?.contains("Woke up") == true })
        #expect(card.press())
        await settled()
        window.contentView?.layoutSubtreeIfNeeded()
        #expect(!all(in: window.contentView).contains { $0.string.contains("tide tables") }, "folded again")
    }

    /// One from before summaries: its first sentence.
    @Test func withoutASummaryItsFirstSentence() async throws {
        defer { done() }
        show(Self.note)
        #expect(labels.contains { $0.contains("Check the harbor log.") }, "\(labels)")
        #expect(!labels.contains { $0.contains("tide tables") }, "\(labels)")
    }

    /// One sentence that two lines may not hold: its card folds, and opens to all of it.
    @Test func aLongSentenceFoldsAndOpens() async throws {
        defer { done() }
        show("Check the harbor log for the tide tables of the whole week and tell the user what changed since Monday")
        try clickTheCard()
        let words = try #require(await laidOutNote(), "opened, the note shows")
        #expect(words.string.hasSuffix("since Monday"))
    }

    /// Finding in the conversation: a wake-up shows open, so what's found is in sight.
    @Test func findingShowsItOpen() async throws {
        defer { done() }
        show(Self.note, summary: "Check the harbor log", finding: "tide")
        let words = try #require(await laidOutNote(), "the note shows while finding")
        #expect(words.string == Self.note)
    }

    @Test func aShortNoteShowsWhole() async throws {
        defer { done() }
        show("Water the plants.")
        for _ in 0..<400 where all(in: window.contentView).first?.frame.width ?? 0 == 0 {
            window.contentView?.layoutSubtreeIfNeeded()
            await Task.yield()
        }
        #expect(all(in: window.contentView).first?.string == "Woke up  Water the plants.")
    }
}
