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

    /// A field redrawn before what holds it (a quote's answer, in the list of quotes) is handed
    /// the words from before its first key, and later the same older words twice: none of them
    /// takes the keys back ("Yes" came out "Y" on the phone).
    @Test func wordsFromBeforeTheFirstKeyAndRepeatsAreKept() {
        let draft = Draft()
        let font = NSFont.systemFont(ofSize: 13)
        func field(showing shown: String? = nil) -> MessageField {
            MessageField(text: Binding(get: { shown ?? draft.text }, set: { draft.text = $0 }), placeholder: "Your answer to this…", font: font)
        }
        let coordinator = field().makeCoordinator()
        let view = MessageTextView()
        view.delegate = coordinator
        field().update(view, coordinator: coordinator)
        func type(_ key: String) {
            view.insertText(key, replacementRange: view.selectedRange())
            if draft.text != view.string { coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: view)) }
        }

        type("Y")
        field(showing: "").update(view, coordinator: coordinator)
        #expect(view.string == "Y", "the words from before the first key don't take it back")
        type("e")
        type("s")
        field(showing: "Y").update(view, coordinator: coordinator)
        field(showing: "Y").update(view, coordinator: coordinator)
        #expect(view.string == "Yes", "the same older words twice don't take the keys since")
        #expect(draft.text == "Yes")

        // Caught up, then the message sent: the field empties.
        field().update(view, coordinator: coordinator)
        draft.text = ""
        field().update(view, coordinator: coordinator)
        #expect(view.string == "")
    }

    /// A key and Return straight after, while busy ("y" to an agent's question): the message goes
    /// and the field empties, though it had no words before the key either. And an earlier message
    /// brought back with ↑ shows, though it was typed a moment ago.
    @Test func aKeyAndReturnWhileBusySendsAndEmpties() throws {
        let draft = Draft()
        var sent: [String] = []
        let font = NSFont.systemFont(ofSize: 13)
        func field(showing shown: String? = nil) -> MessageField {
            MessageField(text: Binding(get: { shown ?? draft.text }, set: { draft.text = $0 }), placeholder: "Message", font: font, onKey: { key in
                switch key.name {
                case .return: sent.append(draft.text); draft.text = ""
                case .up: draft.text = sent.last ?? ""
                default: return false
                }
                return true
            })
        }
        let coordinator = field().makeCoordinator()
        let view = MessageTextView()
        view.delegate = coordinator
        field().update(view, coordinator: coordinator)
        func type(_ key: String) {
            view.insertText(key, replacementRange: view.selectedRange())
            if draft.text != view.string { coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: view)) }
        }
        func press(_ code: UInt16, _ characters: String) throws {
            let event = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
                                                      characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code))
            view.keyDown(with: event)
        }

        type("y")
        field(showing: "").update(view, coordinator: coordinator)
        try press(36, "\r")
        field().update(view, coordinator: coordinator)
        #expect(sent == ["y"])
        #expect(view.string == "", "the message sent leaves the field")

        // "y" typed and taken out again, then ↑: the message sent before is back in the field.
        type("y")
        view.deleteBackward(nil)
        if draft.text != view.string { coordinator.textDidChange(Notification(name: NSText.didChangeNotification, object: view)) }
        try press(126, "\u{F700}")
        field().update(view, coordinator: coordinator)
        #expect(view.string == "y", "the message brought back shows")
    }

    /// A field nothing attaches pictures to (a group chat's): ⌘V of a screenshot leaves it empty,
    /// rather than putting in a blank character that would let an empty-looking message send.
    @Test func aPictureOnlyPasteWhereNothingAttachesLeavesTheFieldEmpty() throws {
        let image = NSImage(size: NSSize(width: 8, height: 8))
        image.lockFocus(); NSColor.systemBlue.drawSwatch(in: NSRect(x: 0, y: 0, width: 8, height: 8)); image.unlockFocus()
        let png = try #require(image.tiffRepresentation.flatMap { NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) })
        let board = NSPasteboard(name: .init("kuvo-tests-\(UUID().uuidString)"))
        board.declareTypes([.png], owner: nil)
        board.setData(png, forType: .png)
        let view = MessageTextView()
        #expect(!view.readSelection(from: board))
        #expect(!view.readSelection(from: board, type: .png))
        #expect(view.string.isEmpty)
    }
}
