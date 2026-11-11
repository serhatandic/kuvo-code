import AppKit
import ClientSessions
import SwiftUI
import Testing
@testable import KuvoCode

/// ⇧Tab in an empty composer goes to the next mode (#6), as Claude Code's Shift+Tab does: in the
/// Mode menu's order, round again after the last, as picking it from the menu would. Full Access
/// is passed over until it's confirmed on the conversation's computer (as Claude Code passes over
/// Bypass Permissions until it's allowed), so ⇧Tab never asks. With words in the field, ⇧Tab
/// keeps its meaning. The real composer and field, in a window of the test's own; the keys go in
/// through the window, as AppKit routes them.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ComposerModeKeysTests {
    /// The conversation's mode, which the menu's pick sets, and whether Full Access is confirmed
    /// on its computer (nil: its box not read yet).
    @Observable final class Mode {
        var approval = ToolApproval.askFirst
        var fullAccess: Bool?
        var picks: [ToolApproval] = []
        var text = ""
        var confirmsFullAccess = false
    }

    struct Host: View {
        @Bindable var mode: Mode

        private var shown: ApprovalShown? {
            mode.fullAccess.map { (confirmed: Bool) -> ApprovalShown in
                let off = ApprovalShown.Why(reason: "fullAccessOff", why: "Confirm it once on this computer first.")
                return ApprovalShown(approval: mode.approval, effective: mode.approval,
                                     options: ToolApproval.allCases.map { .init(approval: $0, unavailable: $0 == .fullAccess && !confirmed ? off : nil) })
            }
        }

        var body: some View {
            Composer(session: "ses_modekeys", text: $mode.text, files: .constant([]), quotes: .constant([]), quoteFocus: nil,
                     agent: "build", approval: mode.approval, model: nil, isRunning: false, keywords: [],
                     onSelectAgent: { _ in },
                     onSelectApproval: { picked in
                         mode.picks.append(picked)
                         mode.approval = picked
                     },
                     approvalShown: shown, confirmsFullAccess: $mode.confirmsFullAccess,
                     onSelectModel: { _ in }, onSend: {}, onStop: {},
                     // The empty field names the mode, so a test sees when the composer has the new one.
                     prompt: mode.approval.title)
        }
    }

    let app = AppModel()
    let mode = Mode()
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 700, height: 240), styleMask: [.titled], backing: .buffered, defer: false)

    init() {
        TestEnvironment.prepare()
        let view = Host(mode: mode)
            .environment(\.messageFont, MessageFont())
            .environment(app)
            .environment(app.workspace)
            .environment(app.catalog)
            .frame(width: 700, height: 240, alignment: .bottom)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.orderBack(nil)
    }

    private func done() {
        window.orderOut(nil)
        window.close()
        window.contentView = nil
    }

    private func all(in view: NSView?) -> [MessageTextView] {
        guard let view else { return [] }
        return ((view as? MessageTextView).map { [$0] } ?? []) + view.subviews.flatMap { all(in: $0) }
    }

    /// The composer's field with the keyboard, showing the mode it has now.
    private func field() async throws -> MessageTextView {
        var found: MessageTextView?
        try await until {
            window.contentView?.layoutSubtreeIfNeeded()
            TestPulse.beat()
            found = all(in: window.contentView).first { $0.accessibilityIdentifier() == "composer" }
            if let found, window.firstResponder !== found { window.makeFirstResponder(found) }
            return found.map { window.firstResponder === $0 && $0.placeholder == mode.approval.title } ?? false
        }
        return try #require(found)
    }

    /// ⇧Tab, pressed in the field: through the window, as AppKit sends it the key.
    private func shiftTab() async throws {
        let field = try await field()
        let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.shift], timestamp: 0, windowNumber: window.windowNumber,
                                                  context: nil, characters: "\u{19}", charactersIgnoringModifiers: "\u{19}", isARepeat: false, keyCode: 48))
        #expect(window.firstResponder === field)
        window.sendEvent(event)
    }

    @Test func shiftTabGoesThroughTheModesInTheMenusOrder() async throws {
        defer { done() }
        #expect(ToolApproval.allCases.map(\.rawValue) == ApprovalCycle.order, "the menu's order is the one ⇧Tab goes in")
        mode.fullAccess = true
        for _ in 1...5 { try await shiftTab() }
        #expect(mode.picks == [.acceptEdits, .auto, .fullAccess, .askFirst, .acceptEdits])
        #expect(mode.text.isEmpty, "no tab typed")
    }

    /// Full Access not confirmed on its computer, or not known to be yet: passed over, and nothing
    /// asks to confirm it.
    @Test(arguments: [false, nil] as [Bool?]) func fullAccessNotConfirmedIsPassedOver(_ confirmed: Bool?) async throws {
        defer { done() }
        mode.fullAccess = confirmed
        for _ in 1...4 { try await shiftTab() }
        #expect(mode.picks == [.acceptEdits, .auto, .askFirst, .acceptEdits])
        #expect(!mode.confirmsFullAccess)
    }

    /// Words in the field: ⇧Tab goes back to the control before, as in any field, and the mode stays.
    @Test func withWordsShiftTabLeavesTheModeAlone() async throws {
        defer { done() }
        mode.fullAccess = true
        let field = try await field()
        field.insertText("Fix the build", replacementRange: field.selectedRange())
        try await until { mode.text == "Fix the build" }
        try await shiftTab()
        #expect(mode.picks.isEmpty)
        #expect(mode.approval == .askFirst)
        #expect(mode.text == "Fix the build", "no tab typed")
    }
}
