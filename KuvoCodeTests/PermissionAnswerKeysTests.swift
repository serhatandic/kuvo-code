import AppKit
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A permission's answers are numbered (1 Allow Once, 2 Always Allow…, 3 Don't Allow, 4 Tell It
/// What to Do Instead…), and their number keys pick them once the keyboard has been still a
/// moment (#376). The real card in a window of the test's own; the keys go in through the app,
/// monitors first, as a key press does.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PermissionAnswerKeysTests {
    final class TestWindow: NSWindow {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    final class Replies { var sent: [(PermissionRequest.Decision, String?)] = [] }

    let window = TestWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 600, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
    let replies = Replies()

    init() throws {
        TestEnvironment.prepare()
        // The keyboard still from the start: its keys answer at once.
        KeysTyped.quietAfter = .zero
        let ask: [String: Any] = ["id": "per_keys", "sessionID": "ses_keys", "action": "shell", "resources": ["npm test"], "save": ["npm test *"]]
        let request = try JSONDecoder().decode(PermissionRequest.self, from: JSONSerialization.data(withJSONObject: ask))
        let replies = replies
        let card = PermissionCard(request: request, directory: "/tmp/kuvo-tests-keys") { decision, words in replies.sent.append((decision, words)) }
            .frame(width: 600, height: 500)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: card)
        window.orderBack(nil)
    }

    private func done() {
        KeysTyped.quietAfter = .milliseconds(600)
        window.orderOut(nil)
        window.close()
        window.contentView = nil
    }

    /// `key`, pressed (with `modifiers`): queued, as a hand's would be, where the app's monitors see
    /// it first; then the card laid out again.
    private func press(_ key: String, code: UInt16, modifiers: NSEvent.ModifierFlags = []) async throws {
        try await until {
            window.contentView?.layoutSubtreeIfNeeded()
            TestPulse.beat()
            return window.contentView?.subviews.isEmpty == false
        }
        let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: ProcessInfo.processInfo.systemUptime,
                                     windowNumber: window.windowNumber, context: nil, characters: key, charactersIgnoringModifiers: key,
                                     isARepeat: false, keyCode: code)!
        NSApp.postEvent(event, atStart: false)
        let handled = TestClick()
        NSApp.postEvent(handled.marker(in: window), atStart: false)
        try await until { handled.isHandled }
    }

    @Test func twoIsAlwaysAllow() async throws {
        defer { done() }
        try await press("2", code: 19)
        #expect(replies.sent.first?.0 == .always)
        #expect(replies.sent.first?.1 == nil)
    }

    @Test func threeIsDontAllow() async throws {
        defer { done() }
        try await press("3", code: 20)
        #expect(replies.sent.first?.0 == .reject)
    }

    @Test func oneIsAllowOnce() async throws {
        defer { done() }
        try await press("1", code: 18)
        #expect(replies.sent.first?.0 == .once)
    }

    /// ⌘2 is the app's, not the card's.
    @Test func aNumberWithCommandIsntAnAnswer() async throws {
        defer { done() }
        try await press("2", code: 19, modifiers: .command)
        #expect(replies.sent.isEmpty)
    }

    /// While the keyboard hasn't been still a moment (you were typing as it came), a number does
    /// nothing: it was meant for what you were typing.
    @Test func aNumberWhileTypingIsntAnAnswer() async throws {
        defer { done() }
        KeysTyped.quietAfter = .seconds(3600)
        // A letter, then a number, as in a word being typed.
        try await press("a", code: 0)
        try await press("2", code: 19)
        #expect(replies.sent.isEmpty)
    }
}
