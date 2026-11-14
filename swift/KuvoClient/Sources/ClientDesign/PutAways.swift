import Observation
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// What a bar's ✕ put away, for the moment it can still be brought back: its line says what went,
/// with Undo where the ✕ was, then folds away (the same on the Mac and the phone).
///
/// Some things only go once the moment passes (a goal that's over, a wake-up), so Undo just
/// keeps them; others go at once, since leaving them meanwhile would let them happen (a queued
/// message the agent would take), and Undo puts them back.
@MainActor @Observable
public final class PutAways<Item: Hashable> {
    /// How long Undo is offered: longer with VoiceOver, to get to it.
    public static var moment: Duration {
        #if os(macOS)
        let voiceOver = NSWorkspace.shared.isVoiceOverEnabled
        #else
        let voiceOver = UIAccessibility.isVoiceOverRunning
        #endif
        return voiceOver ? .seconds(20) : .seconds(5)
    }

    private struct Entry {
        let text: String
        let undo: () -> Void
        let done: () -> Void
        let lingers: Bool
        let serial: Int
    }

    private var entries: [Item: Entry] = [:]
    /// Over, but still on its way out (its computer hasn't said so yet): its line stays, without
    /// Undo, so the bar doesn't show again meanwhile.
    private var going: [Item: String] = [:]
    @ObservationIgnored private var serial = 0
    @ObservationIgnored private let wait: @Sendable (Duration) async -> Void

    /// `wait` sleeps for the moment; tests pass one that never ends, and call `expire` themselves.
    public init(wait: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }) {
        self.wait = wait
    }

    /// Whether `item` was put away: its line shows in its place.
    public func isPutAway(_ item: Item) -> Bool { entries[item] != nil || going[item] != nil }

    /// Whether Undo is still offered for it.
    public func canUndo(_ item: Item) -> Bool { entries[item] != nil }

    /// What its line says ("Goal put away").
    public func text(_ item: Item) -> String? { entries[item]?.text ?? going[item] }

    /// Put away: `undo` brings it back while the moment lasts, and `done` happens once it's over.
    /// One that `lingers` keeps its line after that, until `gone` says it went. Putting it away
    /// again starts the moment again.
    public func put(_ item: Item, text: String, lingers: Bool = false, undo: @escaping () -> Void = {}, done: @escaping () -> Void = {}) {
        serial += 1
        let mine = serial
        going[item] = nil
        entries[item] = Entry(text: text, undo: undo, done: done, lingers: lingers, serial: mine)
        // Said once, here, rather than each time its line shows again.
        AccessibilityNotification.Announcement("\(text). Undo").post()
        let moment = Self.moment
        Task { [wait] in
            await wait(moment)
            // Not one undone meanwhile, or put away again since.
            if entries[item]?.serial == mine { expire(item) }
        }
    }

    /// Undo: it comes back, and won't go.
    public func undo(_ item: Item) {
        guard let entry = entries.removeValue(forKey: item) else { return }
        entry.undo()
    }

    /// The moment is over: it goes for good.
    public func expire(_ item: Item) {
        guard let entry = entries.removeValue(forKey: item) else { return }
        if entry.lingers { going[item] = entry.text }
        entry.done()
    }

    /// It went (or couldn't go, and shows again): its line goes.
    public func gone(_ item: Item) {
        going[item] = nil
    }
}

/// What the card's ✕ can put away for a moment, with Undo, in either app.
public enum PutAway: Hashable, Sendable {
    /// A goal that's over, by when it started: one set since is another.
    case goal(started: Double)
    /// The message last removed from the queue.
    case message
    /// A wake-up canceled, or a watch stopped, by its letters.
    case wake(String)
    /// A finished review, by its id: one asked for since is another.
    case review(String)
}
