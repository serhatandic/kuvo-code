import AppKit
import ClientSessions
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

    /// What a test changes about the window: the text size messages are written in (Settings ›
    /// Appearance), and the conversation's model; and what the composer sent.
    @Observable final class Look {
        var size = MessageFont().size
        var model: ModelRef?
        /// What the conversation's box says of its model (`kuvo/sessions/models`).
        var said: SessionModelState?
        var sent = 0
    }

    struct Window: View {
        @Bindable var model: SessionModel
        let items: [Item]
        let look: Look

        var body: some View {
            VStack(spacing: 0) {
                ConversationScroll(scroller: ConversationScroller(), change: 0, quote: { model.addQuote($0, how: "selection") }) {
                    RowStack(items: items, id: \.id, same: ==, estimate: { _ in 60 }) { item, _ in
                        ReplyView(markdown: item.text, parser: FileLinkingParser(folders: { [] }))
                    }
                }
                Composer(session: model.id, text: $model.draftText, files: $model.draftFiles, quotes: $model.draftQuotes, quoteFocus: model.quoteFocus,
                         agent: "build", approval: .auto, model: look.model, modelState: look.said, isRunning: false, keywords: [.review],
                         onSelectAgent: { _ in }, onSelectApproval: { _ in }, onSelectModel: { look.model = $0 }, onSend: { look.sent += 1 }, onStop: {})
            }
            .environment(\.messageFont, MessageFont(size: look.size))
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
    let look = Look()
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
        let view = Window(model: model, items: items, look: look)
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

    /// Where a quote and a long answer to it are taller than the list of quotes shows.
    enum LongAnswer: CaseIterable, Sendable {
        /// The last of three quotes, the two before it answered, at the usual text size: as it
        /// was seen.
        case underOtherAnswers
        /// The only quote, at a larger text size (Settings › Appearance).
        case largerText
        /// At a larger text size, with another quote under it.
        case largerTextAboveAnotherQuote
    }

    /// A long answer to a quote, where the quote and its answer are taller than the list of
    /// quotes shows: the line you're writing stays in view as each Return starts another, at the
    /// end and in the middle, with nothing under the list's fade (#203). Scrolled back up with the
    /// trackpad to read, the list stays there as it's laid out again, until you type. The window
    /// lays itself out and draws after each key, as it does on screen.
    @Test(arguments: LongAnswer.allCases) func theLineYouWriteStaysInView(_ setup: LongAnswer) async throws {
        defer { done() }
        if setup != .underOtherAnswers { look.size = 18 }
        try await until { editing == "composer" }
        let quote = "The keeper climbed the stairs at dusk and lit the great lamp for the ships that passed the point at night, as his father had, and his father's father before him."
        let quotes: Int
        switch setup {
        case .underOtherAnswers:
            quotes = 3
            for earlier in ["The fog came in at noon.", "The ships answered with their horns."] {
                model.addQuote(earlier, how: "selection")
            }
            model.draftQuotes[0].response = "Okay, keep it."
            model.draftQuotes[1].response = "And the bell on the point?"
            model.addQuote(quote, how: "selection")
        case .largerText:
            quotes = 1
            model.addQuote(quote, how: "selection")
        case .largerTextAboveAnotherQuote:
            quotes = 2
            model.addQuote(quote, how: "selection")
            model.addQuote("The ships answered with their horns.", how: "selection")
            // Quoted again: its answer has the keyboard, the other quote under it.
            model.addQuote(quote, how: "selection")
        }
        try await until { editing == "quote-answer" && model.draftQuotes.count == quotes }
        let answer = try #require(window.firstResponder as? MessageTextView)
        try await until { answer.string.isEmpty && answer.selectedRange().location == 0 }
        let shiftReturn = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.shift], timestamp: 0, windowNumber: window.windowNumber,
                                                         context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        for line in 1...16 {
            type("Line \(line), long enough that it wraps once it has gone on for a while like this", in: answer)
            window.sendEvent(shiftReturn)
            await laidOut()
            if let hidden = hidden(caretOf: answer) { Issue.record("After line \(line), the caret's line is hidden: \(hidden)") }
        }
        // In the middle: a word added to an earlier line, the field scrolled back to it.
        let middle = (answer.string as NSString).range(of: "Line 3,")
        answer.setSelectedRange(NSRange(location: NSMaxRange(middle), length: 0))
        type(" again", in: answer)
        await laidOut()
        if let hidden = hidden(caretOf: answer) { Issue.record("In the middle, the caret's line is hidden: \(hidden)") }

        // Back to the end, then up the list to read the quotes: laid out again (the text a size
        // larger), it stays where you scrolled it.
        answer.setSelectedRange(NSRange(location: (answer.string as NSString).length, length: 0))
        type("The end.", in: answer)
        await laidOut()
        let list = try #require(answer.enclosingScrollView?.enclosingScrollView)
        try await trackpadToTop(list)
        #expect(hidden(caretOf: answer) != nil, "scrolled up, past the line being written")
        look.size += 1
        await laidOut()
        #expect(hidden(caretOf: answer) != nil, "the list stays where you scrolled it")
        type(" Really.", in: answer)
        await laidOut()
        if let hidden = hidden(caretOf: answer) { Issue.record("Typing again, the caret's line is hidden: \(hidden)") }
    }

    /// Scrolled to its top with a trackpad: the gesture's events to the scroll view itself (as
    /// `StepsStayOpenTests` sends them: the window finds nothing under events off screen), and
    /// the list moved as they move it (SwiftUI's scroll view moves on frames this window, off
    /// screen, doesn't draw).
    private func trackpadToTop(_ scroll: NSScrollView) async throws {
        for phase in [CGScrollPhase.began, .changed, .ended] {
            let event = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: phase == .changed ? 2_000 : 0, wheel2: 0, wheel3: 0))
            event.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase.rawValue))
            event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            scroll.scrollWheel(with: try #require(NSEvent(cgEvent: event)))
            if phase == .changed {
                scroll.contentView.scroll(to: .zero)
                scroll.reflectScrolledClipView(scroll.contentView)
            }
            await laidOut()
        }
    }

    /// The window as SwiftUI and AppKit lay it out and draw it, after what was typed, as the
    /// screen's next frame would. On macOS 27 a view's `viewWillDraw` comes as Core Animation
    /// commits, not from `displayIfNeeded`; the field brings the caret's line into view there, so
    /// without the flush that waited on a real frame landing between keys.
    private func laidOut() async {
        for _ in 0..<3 {
            await Task.yield()
            window.contentView?.layoutSubtreeIfNeeded()
            window.contentView?.displayIfNeeded()
            CATransaction.flush()
        }
    }

    /// What hides the line with the caret, if anything: a scroll view around it, here or further
    /// out (the list of quotes), that it's past or under the fading edge of.
    private func hidden(caretOf field: MessageTextView) -> String? {
        guard let layout = field.layoutManager, let container = field.textContainer else { return "no layout" }
        let length = (field.string as NSString).length
        let caret = field.selectedRange().location
        layout.ensureLayout(for: container)
        var line = caret >= length && !layout.extraLineFragmentRect.isEmpty
            ? layout.extraLineFragmentRect
            : layout.lineFragmentRect(forGlyphAt: layout.glyphIndexForCharacter(at: min(caret, length - 1)), effectiveRange: nil)
        line = line.offsetBy(dx: field.textContainerOrigin.x, dy: field.textContainerOrigin.y)
        var view: NSView? = field.superview
        while let clip = view {
            if let clip = clip as? NSClipView {
                var shown = clip.convert(clip.bounds, to: nil)
                // The list of quotes fades where there's more past an edge: the line stays clear of it.
                if clip.enclosingScrollView !== field.enclosingScrollView, let document = clip.documentView {
                    let fade = QuoteList.fade
                    if clip.bounds.minY > document.frame.minY + 1 { shown = shown.divided(atDistance: fade, from: clip.isFlipped ? .maxYEdge : .minYEdge).remainder }
                    if clip.bounds.maxY < document.frame.maxY - 1 { shown = shown.divided(atDistance: fade, from: clip.isFlipped ? .minYEdge : .maxYEdge).remainder }
                }
                let caretLine = field.convert(line, to: nil)
                if caretLine.minY < shown.minY - 0.5 || caretLine.maxY > shown.maxY + 0.5 {
                    return "line \(caretLine) outside \(shown) of \(Swift.type(of: clip))"
                }
            }
            view = clip.superview
        }
        return nil
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

    /// The model picker's popover, once it shows.
    private var popover: NSWindow? {
        NSApp.windows.first { $0.isVisible && String(describing: Swift.type(of: $0)).contains("Popover") }
    }

    /// A conversation on a model gone from its account, so the chip says "Choose a Model" (#338: an
    /// old chat, which sent anyway and an error came back): Send is off, and Return opens the model
    /// picker, the message kept in the field. Once a model is chosen, Return sends it.
    @Test func withNoModelChosenReturnOpensThePickerAndKeepsTheMessage() async throws {
        AXElement.reading(true)
        let shown = NotificationCenter.default.addObserver(forName: NSPopover.didShowNotification, object: nil, queue: .main) { _ in TestPulse.beat() }
        defer {
            NotificationCenter.default.removeObserver(shown)
            popover?.orderOut(nil)
            AXElement.reading(false)
            done()
        }
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
        look.model = ModelRef(id: "v3-retired", providerID: "deepseek")
        try await until { editing == "composer" }
        let field = try #require(field)
        type("Fix the build", in: field)

        var send: AXElement? {
            window.contentView?.layoutSubtreeIfNeeded()
            TestPulse.beat()
            return AXElement.all(in: window.contentView).first { $0.label == "Send" }
        }
        try await until { send?.help == "Choose a model to send it (Return opens the list)" }
        #expect(send?.object.isAccessibilityEnabled?() == false, "Send is off")
        #expect(AXElement.all(in: window.contentView).contains { ($0.label ?? "").contains("Choose a Model") }, "the chip asks for a model")

        let returnKey = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                                                       context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        field.keyDown(with: returnKey)
        try await until { popover != nil }
        #expect(look.sent == 0, "nothing sent")
        #expect(model.draftText == "Fix the build", "the message stays in the field")

        // A model chosen: Return sends it.
        popover?.orderOut(nil)
        look.model = ModelRef(id: "v4.1-flash", providerID: "deepseek")
        try await until { send?.object.isAccessibilityEnabled?() == true }
        field.keyDown(with: returnKey)
        #expect(look.sent == 1)
    }

    /// A conversation whose box says its model is gone from its provider's list (#572: a coding
    /// agent's it dropped, which this Mac's lists still named and sent, to fail): the chip asks for a
    /// model and Send waits for one, as the phone's do. Once the box says it runs, it goes.
    @Test func aModelItsBoxSaysIsGoneWaitsForAnother() async throws {
        AXElement.reading(true)
        defer {
            popover?.orderOut(nil)
            AXElement.reading(false)
            done()
        }
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
        // This Mac's lists have it; its box says it's gone.
        look.model = ModelRef(id: "v4.1-flash", providerID: "deepseek")
        look.said = try JSONDecoder().decode(SessionModelState.self, from: Data(#"{"model":{"providerID":"deepseek","id":"v4.1-flash"},"runs":false,"missing":"gone","account":{"id":"deepseek","name":"DeepSeek"}}"#.utf8))
        try await until { editing == "composer" }
        let field = try #require(field)
        type("Fix the build", in: field)

        var send: AXElement? {
            window.contentView?.layoutSubtreeIfNeeded()
            TestPulse.beat()
            return AXElement.all(in: window.contentView).first { $0.label == "Send" }
        }
        try await until { send?.help == "Choose a model to send it (Return opens the list)" }
        #expect(send?.object.isAccessibilityEnabled?() == false, "Send is off")
        #expect(AXElement.all(in: window.contentView).contains { ($0.label ?? "").contains("Choose a Model") }, "the chip asks for a model")

        // Its box says it runs: Return sends it.
        look.said = SessionModelState(model: look.model, name: "DeepSeek V4.1 Flash", runs: true)
        try await until { send?.object.isAccessibilityEnabled?() == true }
        let returnKey = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                                                       context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        field.keyDown(with: returnKey)
        #expect(look.sent == 1)
    }
}
