import AppKit
import ClientSandbox
import SwiftUI
import Testing
@testable import KuvoCode

/// The sandbox's ask to run a command outside it answers as every ask: its numbered rows (1 Allow
/// Once, 2 Always Allow <folder>, 3 Don't Allow) picked with their number keys, once the keyboard's
/// been still a moment and not with ⌘ (the user's call: "the same as everywhere else"). The real
/// card in a window of the test's own; the keys go in through the app, monitors first.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SandboxAnswerKeysTests {
    final class TestWindow: NSWindow {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    final class Answers { var sent: [SandboxAnswer] = [] }

    let window = TestWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 640, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
    let answers = Answers()

    init() throws {
        TestEnvironment.prepare()
        KeysTyped.quietAfter = .zero
        AnswerKeys.watched = 0
        let ask: [String: Any] = ["id": "sq_keys", "at": 1, "session": "ses_keys", "project": "/tmp/kuvo-tests-sandbox-keys", "command": "npm install -g pnpm",
                                  "why": "To install pnpm.", "always": ["path": "/tmp/kuvo-tests-sandbox-keys/.npm-global", "kind": "project"]]
        let asked = try JSONDecoder().decode(SandboxAsk.self, from: JSONSerialization.data(withJSONObject: ask))
        let answers = answers
        let card = SandboxAskCard(asked: asked, box: BoxClient.mac, takesKeys: true, onAnswer: { answers.sent.append($0) })
            .frame(width: 640, height: 600)
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

    /// `key`, pressed (with `modifiers`), once the card watches its keys in its window.
    private func press(_ key: String, code: UInt16, modifiers: NSEvent.ModifierFlags = []) async throws {
        try await until {
            window.contentView?.layoutSubtreeIfNeeded()
            TestPulse.beat()
            return AnswerKeys.watched > 0
        }
        let ready = TestClick()
        NSApp.postEvent(ready.marker(in: window), atStart: false)
        try await until { ready.isHandled }
        let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: ProcessInfo.processInfo.systemUptime,
                                     windowNumber: window.windowNumber, context: nil, characters: key, charactersIgnoringModifiers: key,
                                     isARepeat: false, keyCode: code)!
        NSApp.postEvent(event, atStart: false)
        let handled = TestClick()
        NSApp.postEvent(handled.marker(in: window), atStart: false)
        try await until { handled.isHandled }
    }

    @Test func oneIsAllowOnce() async throws {
        defer { done() }
        try await press("1", code: 18)
        #expect(answers.sent == [.once])
    }

    @Test func twoIsAlwaysAllowItsFolder() async throws {
        defer { done() }
        try await press("2", code: 19)
        #expect(answers.sent == [.always])
    }

    @Test func threeIsDontAllow() async throws {
        defer { done() }
        try await press("3", code: 20)
        #expect(answers.sent == [.no])
    }

    @Test func aNumberWithCommandOrTypedInAWordIsntAnAnswer() async throws {
        defer { done() }
        try await press("1", code: 18, modifiers: .command)
        KeysTyped.quietAfter = .seconds(3600)
        try await press("a", code: 0)
        try await press("1", code: 18)
        #expect(answers.sent.isEmpty)
    }
}
