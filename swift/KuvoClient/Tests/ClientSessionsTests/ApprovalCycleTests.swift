import ClientSessions
import Testing

/// ⇧Tab in an empty composer goes to the next mode (#6), as Claude Code's Shift+Tab does: in the
/// Mode menu's order, round again after the last, passing over what can't be picked now.
struct ApprovalCycleTests {
    private func cycle(from first: String, presses: Int, canPick: (String) -> Bool = { _ in true }) -> [String] {
        var current = first
        return (0..<presses).compactMap { _ in
            guard let next = ApprovalCycle.next(after: current, canPick: canPick) else { return nil }
            current = next
            return next
        }
    }

    @Test func goesThroughTheMenusModesInOrderAndRoundAgain() {
        #expect(cycle(from: "askFirst", presses: 5) == ["acceptEdits", "auto", "fullAccess", "askFirst", "acceptEdits"])
    }

    /// Full Access not confirmed on its computer: as Claude Code leaves Bypass Permissions out of
    /// its cycle, Auto goes back to Ask First, and nothing asks.
    @Test func passesOverWhatCantBePickedNow() {
        #expect(cycle(from: "acceptEdits", presses: 3) { $0 != "fullAccess" } == ["auto", "askFirst", "acceptEdits"])
        // In Full Access, where it can't be picked again, it still goes on from there.
        #expect(ApprovalCycle.next(after: "fullAccess") { $0 != "fullAccess" } == "askFirst")
    }

    @Test func nothingElseToPickIsNothing() {
        #expect(ApprovalCycle.next(after: "auto") { $0 == "auto" } == nil)
    }

    /// One it doesn't know reads as Auto, as the menu names it.
    @Test func anUnknownModeGoesOnFromAuto() {
        #expect(ApprovalCycle.next(after: "approveAll") { _ in true } == "fullAccess")
    }
}
