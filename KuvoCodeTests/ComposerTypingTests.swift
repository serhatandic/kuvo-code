import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Typing into a composer keeps every key, also while the app is busy: SwiftUI can hand the field
/// the draft as it was a key or two ago, after the field has gone on (the phone's composer lost
/// keys that way, "Friday  Monday?"). That's the field's own typing coming back late, not a
/// change, and it stays as typed; a real change from the app (sending, a draft brought back)
/// still applies. The real field and its coordinator, given what SwiftUI would give them.
@MainActor
@Suite struct ComposerTypingTests {
    final class Draft { var text = "" }

    @Test func keysTypedWhileTheDraftCatchesUpAreKept() {
        let draft = Draft()
        let font = NSFont.systemFont(ofSize: 13)
        func field(showing shown: String? = nil) -> MessageField {
            MessageField(text: Binding(get: { shown ?? draft.text }, set: { draft.text = $0 }), placeholder: "Message", font: font)
        }
        let coordinator = field().makeCoordinator()
        let view = MessageTextView()
        view.delegate = coordinator
        field().update(view, coordinator: coordinator)

        func type(_ key: String) {
            view.insertText(key, replacementRange: view.selectedRange())
            if draft.text != view.string { coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: view)) }
        }
        for key in ["F", "r", "i"] { type(key) }
        #expect(view.string == "Fri")

        // Busy: SwiftUI updates the field with the draft as it was two keys ago.
        field(showing: "Fr").update(view, coordinator: coordinator)
        #expect(view.string == "Fri", "the last key stays")
        type("d")
        #expect(view.string == "Frid")
        #expect(draft.text == "Frid")

        // A typo fixed while busy: each key's draft comes back late, in order, the one before
        // the fix too; none of them puts the deleted letter back or takes the next key away.
        field().update(view, coordinator: coordinator)
        draft.text = ""
        field().update(view, coordinator: coordinator)
        for key in ["a", "b"] { type(key) }
        view.deleteBackward(nil)
        if draft.text != view.string { coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: view)) }
        #expect(view.string == "a")
        for late in ["a", "ab"] { field(showing: late).update(view, coordinator: coordinator) }
        type("c")
        field(showing: "a").update(view, coordinator: coordinator)
        #expect(view.string == "ac", "the deleted letter stays deleted and the next key stays")

        // Caught up, then a real change from the app (the message sent): it applies.
        field(showing: "ac").update(view, coordinator: coordinator)
        draft.text = ""
        field().update(view, coordinator: coordinator)
        #expect(view.string == "")
    }
}
