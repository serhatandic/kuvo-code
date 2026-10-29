import AppKit
import ClientText
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// The composer's field. Quoting part of a reply (C4) puts you straight into writing your answer:
/// once Add to Chat has quoted what you selected, the answer under the quote has the keyboard,
/// with the caret in it, so you type without a click first. A picture pasted in (C1) is attached
/// and named where you're writing ("[Image 1]"), so you can say which one you mean; Backspace
/// takes a name away whole, and removing a picture takes its name out and the later ones down a
/// number. The conversation and the composer are the real ones, in a window of the test's own;
/// the selection is made with the pointer's events, and pastes come from a pasteboard of the
/// test's own, never your clipboard.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ComposerFieldTests {
    struct Item: Identifiable, Equatable {
        let id: String
        let text: String
    }

    struct Window: View {
        @Bindable var model: SessionModel
        let items: [Item]

        var body: some View {
            VStack(spacing: 0) {
                ConversationScroll(scroller: ConversationScroller(), change: 0, quote: { model.addQuote($0, how: "selection") }) {
                    RowStack(items: items, id: \.id, same: ==, estimate: { _ in 60 }) { item, _ in
                        ReplyView(markdown: item.text, parser: FileLinkingParser(folders: { [] }))
                    }
                }
                Composer(session: model.id, text: $model.draftText, files: $model.draftFiles, quotes: $model.draftQuotes, quoteFocus: model.quoteFocus,
                         agent: "build", approval: .approveAll, model: nil, isRunning: false, keywords: [.review],
                         onSelectAgent: { _ in }, onSelectApproval: { _ in }, onSelectModel: { _ in }, onSend: {}, onStop: {})
            }
        }
    }

    let engine = StubEngine(port: 47913)
    /// Who "&" named before: put back after.
    private let mail = AgentMail.shared.app
    private let named = AgentMail.shared.agents
    let app = AppModel()
    /// The composer's models: none until a test reads them from the engine.
    let catalog = Catalog()
    let model: SessionModel
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 720, height: 620), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    /// Tells `until` each time the keyboard moves in the window.
    private let watch: NSKeyValueObservation

    init() async throws {
        TestEnvironment.prepare()
        let items = [Item(id: "a", text: "The keeper climbed the stairs at dusk and lit the great lamp for the ships.")]
        let id = "ses_quotefocus_\(UUID().uuidString.prefix(8))"
        app.workspace.api = engine.api
        engine.list([StubEngine.session(id, title: "Quotes", directory: "/tmp/kuvo-tests-quote-focus", created: 1),
                     StubEngine.session(id + "_other", title: "Lighthouse", directory: "/tmp/kuvo-tests-quote-focus", created: 2)])
        engine.conversation(id, [])
        await app.workspace.refresh()
        model = try #require(app.workspace.model(for: id))
        // Who "&" names: this app's agents, as its box lists them.
        AgentMail.shared.app = app
        AgentMail.shared.agents = [AgentMail.Agent(session: id, name: "Quotes", kind: "session"), AgentMail.Agent(session: id + "_other", name: "Lighthouse", kind: "session")]
        let view = Window(model: model, items: items)
            .environment(app)
            .environment(app.workspace)
            .environment(catalog)
            .frame(width: 720, height: 620)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        watch = window.observe(\.firstResponder) { _, _ in TestPulse.beat() }
        window.orderBack(nil)
        try await until { !texts.isEmpty }
    }

    private func done() {
        AgentMail.shared.app = mail
        AgentMail.shared.agents = named
        Drafts.shared.remove(model.id)
        engine.stop()
        window.orderOut(nil)
        window.close()
    }

    private func all<T: NSView>(_ type: T.Type, in view: NSView?) -> [T] {
        guard let view else { return [] }
        return ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { all(type, in: $0) }
    }

    private var stack: RowStackView? { all(RowStackView.self, in: window.contentView).first }
    private var texts: [ReplyTextView] {
        // Read while the window lays out, which TestPulse can't see: each look lays it out first.
        window.contentView?.layoutSubtreeIfNeeded()
        TestPulse.beat()
        return all(ReplyTextView.self, in: stack)
    }
    private var bar: NSHostingView<SelectionActions>? { stack?.subviews.compactMap { $0 as? NSHostingView<SelectionActions> }.first }

    /// What has the keyboard: the message's field ("composer"), an answer's ("quote-answer").
    private var editing: String? {
        (window.firstResponder as? MessageTextView)?.accessibilityIdentifier()
    }

    private func point(in text: NSTextView, x: CGFloat) -> NSPoint {
        let line = text.layoutManager!.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil)
        return text.convert(NSPoint(x: x, y: line.midY), to: nil)
    }

    private func event(_ type: NSEvent.EventType, at point: NSPoint) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    }

    /// Selects part of the reply with a drag, as a hand would, and takes Add to Chat from its menu.
    private func selectAndAddToChat() throws {
        let text = try #require(texts.first)
        let from = point(in: text, x: 40), to = point(in: text, x: 220)
        for step in 1...6 {
            let t = CGFloat(step) / 6
            NSApp.postEvent(event(.leftMouseDragged, at: NSPoint(x: from.x + (to.x - from.x) * t, y: from.y)), atStart: false)
        }
        NSApp.postEvent(event(.leftMouseUp, at: to), atStart: false)
        text.mouseDown(with: event(.leftMouseDown, at: from))
        #expect(window.firstResponder === stack, "the selection has the keyboard, as it does for ⌘C")
        let addToChat = try #require(bar?.rootView.addToChat)
        addToChat()
    }

    @Test func theAnswerTakesTheKeyboardOnceQuoted() async throws {
        defer { done() }
        try await until { editing == "composer" }

        try selectAndAddToChat()
        #expect(model.draftQuotes.count == 1)
        try await until { editing == "quote-answer" }
        // The caret, ready to type, not the answer selected.
        let editor = try #require(window.firstResponder as? NSTextView)
        #expect(editor.selectedRange() == NSRange(location: (editor.string as NSString).length, length: 0))
    }

    /// The same part quoted again, after you went on writing elsewhere: its answer has the keyboard
    /// again, rather than staying where it was.
    @Test func quotingTheSamePartAgainGoesBackToItsAnswer() async throws {
        defer { done() }
        try await until { editing == "composer" }
        try selectAndAddToChat()
        try await until { editing == "quote-answer" }
        // Back to the message's own field, as a click there would.
        let field = try #require(all(MessageTextView.self, in: window.contentView).first { $0.accessibilityIdentifier() == "composer" })
        window.makeFirstResponder(field)
        try await until { editing == "composer" }

        try selectAndAddToChat()
        #expect(model.draftQuotes.count == 1, "quoted once")
        try await until { editing == "quote-answer" }
    }
}

extension ComposerFieldTests {
    private var field: MessageTextView? {
        all(MessageTextView.self, in: window.contentView).first { $0.accessibilityIdentifier() == "composer" }
    }

    /// A picture, as a screenshot copied to the clipboard is, on a pasteboard of the test's own.
    private func copiedPicture() -> NSPasteboard {
        let board = NSPasteboard(name: .init("kuvo-tests-\(UUID().uuidString)"))
        board.clearContents()
        let image = NSImage(size: NSSize(width: 8, height: 8), flipped: false) { rect in
            NSColor.systemTeal.setFill()
            rect.fill()
            return true
        }
        board.writeObjects([image])
        return board
    }

    /// Typed as a hand would, where the caret is.
    private func type(_ words: String, in field: MessageTextView) {
        field.insertText(words, replacementRange: field.selectedRange())
    }

    @Test func aPastedPictureIsNamedWhereYouWrite() async throws {
        defer {
            for file in model.draftFiles { try? FileManager.default.removeItem(at: file) }
            done()
        }
        try await until { editing == "composer" }
        let field = try #require(field)
        type("Compare", in: field)
        #expect(field.readSelection(from: copiedPicture()))
        type("with", in: field)
        #expect(field.readSelection(from: copiedPicture()))
        type("please", in: field)
        #expect(model.draftFiles.count == 2, "both attached")
        #expect(model.draftText == "Compare [Image 1] with [Image 2] please")

        // Removing the first picture (its chip's ×) takes its name out, and the second is the
        // first now.
        ImageReferences.detach(model.draftFiles[0], files: &model.draftFiles, text: &model.draftText, quotes: &model.draftQuotes) { AttachmentItem.local($0).isImage }
        #expect(model.draftFiles.count == 1)
        #expect(model.draftText == "Compare with [Image 1] please")
        try await until { field.string == model.draftText }

        // Backspace right after a name takes all of it; the picture stays, its chip removes it.
        field.setSelectedRange(NSRange(location: ("Compare with [Image 1]" as NSString).length, length: 0))
        field.deleteBackward(nil)
        #expect(model.draftText == "Compare with  please")
        #expect(model.draftFiles.count == 1)
    }

    /// Backspace right after an agent's name takes all of it; anywhere else (inside it, after the
    /// space that follows, with text selected) it's an ordinary Backspace.
    @Test func backspaceAfterANameTakesItWhole() async throws {
        defer { done() }
        try await until { editing == "composer" }
        let field = try #require(field)
        type("Ask &Quotes about it", in: field)
        let end = ("Ask &Quotes" as NSString).length
        field.setSelectedRange(NSRange(location: end + 1, length: 0))
        field.deleteBackward(nil)
        #expect(model.draftText == "Ask &Quotesabout it", "after the space: the space")
        field.setSelectedRange(NSRange(location: end - 2, length: 0))
        field.deleteBackward(nil)
        #expect(model.draftText == "Ask &Quoes" + "about it", "inside it: a letter")
        field.string = ""
        type("Ask &Quotes about it", in: field)
        field.setSelectedRange(NSRange(location: end, length: 0))
        field.deleteBackward(nil)
        #expect(model.draftText == "Ask  about it")
    }

    /// A name picked from the "&" list with Return: the next words go after it, where you were
    /// typing, not into the name.
    @Test func typingGoesOnAfterANamePickedFromTheList() async throws {
        defer { done() }
        try await until { editing == "composer" }
        let field = try #require(field)
        type("Ask &Lig", in: field)
        let returnKey = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                                                       context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        field.keyDown(with: returnKey)
        try await until { field.string == "Ask &Lighthouse " }
        type("to look", in: field)
        #expect(model.draftText == "Ask &Lighthouse to look")
    }

    /// "/review with " in a conversation whose own model is the only one on offer: there's no other
    /// model to list, so Return and ↓ do what they would without a list, rather than pick from none.
    @Test func reviewWithNoOtherModelOnOfferListsNone() async throws {
        defer { done() }
        let location = ["directory": "/"]
        let own: [String: Any] = ["id": "v4.1-flash", "modelID": "v4.1-flash", "providerID": "deepseek", "name": "DeepSeek V4.1 Flash",
                                  "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": [], "time": ["released": 1],
                                  "cost": [["input": 1, "output": 1]], "status": "active", "enabled": true, "limit": ["context": 100_000, "output": 8_000]]
        engine.on("GET", "/api/integration", json: ["location": location, "data": [["id": "deepseek", "name": "DeepSeek", "methods": [["type": "key"]],
                                                                                  "connections": [["type": "credential", "credentialID": "cred_deepseek", "method": "key"]]]]])
        engine.on("GET", "/api/model", json: ["location": location, "data": [own]])
        engine.on("GET", "/api/model/default", json: ["location": location, "data": own])
        engine.on("GET", "/api/agent", json: ["location": location, "data": []])
        engine.on("GET", "/api/command", json: ["location": location, "data": []])
        catalog.api = engine.api
        await catalog.refresh()
        #expect(catalog.reviewReaders.count == 1)
        try await until { editing == "composer" }
        let field = try #require(field)
        type("/review with ", in: field)
        let key = { (characters: String, code: UInt16) in
            NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: self.window.windowNumber,
                             context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)
        }
        field.keyDown(with: try #require(key(String(UnicodeScalar(NSDownArrowFunctionKey)!), 125)))
        field.keyDown(with: try #require(key("\r", 36)))
        #expect(field.string.hasPrefix("/review with"))
    }

    /// Words pasted come in as words, plain.
    @Test func pastedWordsAreWords() async throws {
        defer { done() }
        try await until { editing == "composer" }
        let field = try #require(field)
        let board = NSPasteboard(name: .init("kuvo-tests-\(UUID().uuidString)"))
        board.clearContents()
        board.setString("see https://example.com/a", forType: .string)
        #expect(field.readSelection(from: board))
        #expect(model.draftText == "see https://example.com/a")
        #expect(model.draftFiles.isEmpty)
    }

    /// A screenshot copied to the clipboard (⌃⇧⌘4) is only a picture, one item of `public.png`:
    /// ⌘V is offered for it, as macOS offers Paste only for what the field reads, and attaches it.
    @Test func aScreenshotOnTheClipboardIsAttached() async throws {
        defer { done() }
        try await until { editing == "composer" }
        let field = try #require(field)
        let image = NSImage(size: NSSize(width: 8, height: 8))
        image.lockFocus(); NSColor.systemBlue.drawSwatch(in: NSRect(x: 0, y: 0, width: 8, height: 8)); image.unlockFocus()
        let png = try #require(image.tiffRepresentation.flatMap { NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) })
        let board = NSPasteboard(name: .init("kuvo-tests-\(UUID().uuidString)"))
        board.declareTypes([.png], owner: nil)
        board.setData(png, forType: .png)
        #expect(field.preferredPasteboardType(from: board.types ?? [], restrictedToTypesFrom: nil) != nil, "⌘V isn't offered for a picture alone")
        #expect(field.readSelection(from: board))
        #expect(model.draftFiles.count == 1)
    }
}
