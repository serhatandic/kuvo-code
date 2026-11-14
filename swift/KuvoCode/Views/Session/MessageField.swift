import AppKit
import ClientDesign
import ClientSessions
import ClientText
import SwiftUI

/// Where a message is written: a composer's field (a session's, a bot's, a chat's or a group
/// chat's) and the answers to quotes in it. What the message names looks as it will once sent:
/// the agents named with "&" (a bot's face in place of its "&" and its name in bold in its color;
/// a session's mark and its name in bold), the pictures it carries ("[Image 1]": a picture's mark
/// and its name in bold) and web addresses, in the replies' link color. Only how it's drawn
/// changes: the text stays as typed. It takes the keyboard when asked, wherever the keyboard is
/// (the conversation's selection, another field), with the caret after what's written.
///
/// SwiftUI's TextField can't style part of its text, nor be sure to get the keyboard when it's
/// asked for in the same moment it's made, so this is a text view of its own, as the phone's
/// composer is (kuvo-code-ios's MentionField).
struct MessageField: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    var font: NSFont
    /// Lines it grows to before it scrolls.
    var maxLines = 12
    /// Takes the keyboard when it's made with one, and each time it changes to another.
    var focus: FocusRequest?
    /// Lets go of the keyboard each time it changes.
    var blur = 0
    /// What it names stands out; not in a "!" command, whose "&" is the shell's.
    var marks = true
    /// How many pictures are attached: "[Image n]" up to that stands out.
    var images = 0
    /// The keyword the message starts with ("/goal"), drawn as a token: its mark in place of the
    /// "/", the rest in bold, in the accent. The text stays as typed.
    var token: Token?
    /// What the Work Queue items it names are (`#243`): each drawn with its mark, in its color.
    var refs: [String: WorkRef] = [:]
    /// In grey after what's written (a keyword's example, "what to do each time"), until more is.
    var example: String?

    /// A keyword at the start: how much of the text it is, in UTF-16 (/loop's takes in its
    /// schedule, "/loop every morning at 9"), and its mark.
    struct Token: Equatable {
        var length: Int
        var symbol: String
    }
    /// A key, before the field has it: true when it's taken.
    var onKey: (Key) -> Bool = { _ in false }
    /// It took the keyboard (true) or let it go.
    var onFocus: (Bool) -> Void = { _ in }
    /// ⌘V: nil for words to paste; else what's on the pasteboard was taken as attachments, and
    /// these words (their names) go where the caret is.
    var onPaste: (NSPasteboard) -> [String]? = { _ in nil }
    /// For its owner to write where the caret is.
    var handle: Handle?
    var identifier = "composer"
    /// False while voice input listens in its place: keys still come to `onKey`, and nothing
    /// typed changes what's written.
    var isEditable = true
    /// What VoiceOver calls it.
    var label = "Message"
    /// Room kept between the line being written and the edges of what scrolls around the field
    /// (a list of quotes), where that fades.
    var edgeRoom: CGFloat = 0

    /// A request for the keyboard: each one made is another.
    struct FocusRequest: Equatable {
        private let id = UUID()
    }

    /// A key the owner may take before the field: Return (Shift and Option start a new line unless
    /// taken), Tab, Escape, ↑ and ↓, with the modifiers held.
    struct Key: Equatable {
        enum Name { case `return`, tab, escape, up, down }
        let name: Name
        let modifiers: NSEvent.ModifierFlags

        init(_ name: Name, _ modifiers: NSEvent.ModifierFlags = []) {
            self.name = name
            self.modifiers = modifiers
        }

        init?(_ event: NSEvent) {
            let name: Name
            switch event.keyCode {
            case 36, 76: name = .return
            case 48: name = .tab
            case 53: name = .escape
            case 126: name = .up
            case 125: name = .down
            default: return nil
            }
            self.init(name, event.modifierFlags.intersection([.shift, .option, .command, .control]))
        }
    }

    /// Writes into the field from outside it, where its caret is.
    @MainActor final class Handle {
        fileprivate weak var view: MessageTextView?

        /// `words` where the caret is (see `MessageTextView.write`); at the end, if the field
        /// isn't there.
        func write(_ words: String, into text: Binding<String>) {
            guard let view else {
                text.wrappedValue += MessageTextView.spaced(words, after: text.wrappedValue.last)
                return
            }
            view.write(words)
        }

        /// Undo brings back nothing from before (another conversation's draft).
        func forgetUndo() { view?.forgetUndo() }

        /// The window it's in, active or not.
        var window: NSWindow? { view?.window }
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = FieldScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = false
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.verticalScrollElasticity = .none

        let view = MessageTextView()
        view.delegate = context.coordinator
        view.isRichText = false
        view.importsGraphics = false
        view.allowsUndo = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.setAccessibilityIdentifier(identifier)
        view.setAccessibilityLabel(label)
        scroll.documentView = view
        handle?.view = view
        view.keep(outOfSight: context.environment.isKeptOutOfSight, in: scroll)
        context.coordinator.focus = focus
        context.coordinator.blur = blur
        update(view, coordinator: context.coordinator)
        if focus != nil { view.takeKeyboard() }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? MessageTextView else { return }
        handle?.view = view
        view.keep(outOfSight: context.environment.isKeptOutOfSight, in: scroll)
        if view.isEditable != isEditable { view.isEditable = isEditable }
        update(view, coordinator: context.coordinator)
        if focus != context.coordinator.focus {
            context.coordinator.focus = focus
            if focus != nil { view.takeKeyboard() }
        }
        if blur != context.coordinator.blur {
            context.coordinator.blur = blur
            if let window = view.window, window.firstResponder === view { window.makeFirstResponder(nil) }
        }
    }

    /// The field as the app has it now (`coordinator`'s field). For the tests too, which hand it
    /// what SwiftUI would.
    func update(_ view: MessageTextView, coordinator: Coordinator) {
        coordinator.parent = self
        // A key the app takes can change the words itself (Return sends, ↑ brings one back): those
        // apply when handed, even if the field had them a moment ago.
        view.onKey = { [onKey, weak view, weak coordinator] key in
            guard onKey(key) else { return false }
            if let view, let coordinator, coordinator.parent.text != view.string {
                coordinator.echoes.changing(to: coordinator.parent.text)
            }
            return true
        }
        view.onFocus = onFocus
        view.onPaste = onPaste
        view.edgeRoom = edgeRoom
        if view.placeholder != placeholder { view.placeholder = placeholder }
        if view.example != example { view.example = example }
        var changed = false
        if view.font != font {
            view.font = font
            changed = true
        }
        // A change from the app (a message sent, a draft brought back), not the field's own typing.
        if !coordinator.echoes.isEcho(text), view.string != text, !view.hasMarkedText() {
            view.replace(with: text)
            changed = true
        }
        // A command is typed as is: no curly quotes, long dashes or corrections.
        let plain = text.hasPrefix("!")
        let checker = NSSpellChecker.self
        view.isAutomaticQuoteSubstitutionEnabled = !plain && checker.isAutomaticQuoteSubstitutionEnabled
        view.isAutomaticDashSubstitutionEnabled = !plain && checker.isAutomaticDashSubstitutionEnabled
        view.isAutomaticTextReplacementEnabled = !plain && checker.isAutomaticTextReplacementEnabled
        view.isAutomaticSpellingCorrectionEnabled = !plain && checker.isAutomaticSpellingCorrectionEnabled
        if coordinator.styled != Styled(marks: marks, images: images, token: token, refs: refs) || changed {
            coordinator.styled = Styled(marks: marks, images: images, token: token, refs: refs)
            view.restyle(marks: marks, images: images, token: token, refs: refs)
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
        guard let view = scroll.documentView as? MessageTextView else { return nil }
        let width = proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? max(scroll.frame.width, 100)
        let line = view.lineHeight
        let fitting = view.height(forWidth: width)
        let most = line * CGFloat(maxLines)
        scroll.hasVerticalScroller = fitting > most + 0.5
        return CGSize(width: width, height: ceil(min(max(fitting, line), most)))
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    struct Styled: Equatable {
        var marks: Bool
        var images: Int
        var token: Token?
        var refs: [String: WorkRef] = [:]
    }

    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MessageField
        var focus: FocusRequest?
        var blur = 0
        var styled: Styled?
        /// The field's own typing, so it's told apart when SwiftUI hands it back late.
        var echoes = TypedEchoes()

        init(parent: MessageField) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? MessageTextView else { return }
            if parent.text != view.string {
                echoes.told(view.string)
                parent.text = view.string
            }
            // The keyword as it was until its owner reads the new text: one that's no longer whole
            // goes back to plain text.
            let token = parent.token.flatMap { view.string.utf16.count >= $0.length && view.string.hasPrefix("/") ? $0 : nil }
            view.restyle(marks: parent.marks, images: parent.images, token: token, refs: parent.refs)
            view.followCaret()
        }

        // The caret moved with the keys (the arrows, ⌘↓): its line comes into view in the list
        // of quotes too, as in the field.
        func textViewDidChangeSelection(_ notification: Notification) {
            guard let view = notification.object as? MessageTextView, NSApp.currentEvent?.type == .keyDown else { return }
            view.followCaret()
        }
    }
}

/// The field's scroll view: the wheel goes on to what's around it (the conversation, a list of
/// quotes) while the field has nothing to scroll. SwiftUI sizes the field to its text only after
/// the text changed, and what scrolls around it (a list of quotes, which measures what it holds
/// before it takes its own height) after that: the line being written comes into view again once
/// they're laid out at their new sizes (`MessageTextView.revealCaret`).
final class FieldScrollView: NSScrollView {
    nonisolated(unsafe) private var around: [NSObjectProtocol] = []

    deinit { around.forEach(NotificationCenter.default.removeObserver) }

    override func scrollWheel(with event: NSEvent) {
        // Scrolling to read what's written: the caret is left where it is until you type again.
        (documentView as? MessageTextView)?.followsCaret = false
        let overflow = (documentView?.frame.height ?? 0) - contentView.bounds.height
        if overflow > 0.5 { super.scrollWheel(with: event) } else { nextResponder?.scrollWheel(with: event) }
    }

    override func setFrameSize(_ size: NSSize) {
        let resized = size != frame.size
        super.setFrameSize(size)
        if resized { revealCaret() }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        around.forEach(NotificationCenter.default.removeObserver)
        around = []
        guard window != nil, let outer = enclosingScrollView else { return }
        let center = NotificationCenter.default
        // What scrolls around it, and what that holds, laid out at another size.
        around = [outer.contentView, outer.documentView].compactMap { $0 }.map { view in
            view.postsFrameChangedNotifications = true
            return center.addObserver(forName: NSView.frameDidChangeNotification, object: view, queue: nil) { [weak self] _ in
                MainActor.assumeIsolated { self?.revealCaret() }
            }
        }
        // Scrolled by hand, with the trackpad or a scroller, here or in what's around it: the
        // caret is left where it is until you type again.
        around += [self, outer].map { scroll in
            center.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: scroll, queue: nil) { [weak self] _ in
                MainActor.assumeIsolated { (self?.documentView as? MessageTextView)?.followsCaret = false }
            }
        }
    }

    private func revealCaret() {
        (documentView as? MessageTextView)?.revealCaret()
    }
}

/// The text view under `MessageField`.
final class MessageTextView: PointerAwareTextView {
    var onKey: (MessageField.Key) -> Bool = { _ in false }
    var onFocus: (Bool) -> Void = { _ in }
    var onPaste: (NSPasteboard) -> [String]? = { _ in nil }
    var placeholder = "" {
        didSet {
            setAccessibilityPlaceholderValue(placeholder)
            needsDisplay = true
        }
    }
    var example: String? {
        didSet { needsDisplay = true }
    }
    /// Asked for the keyboard before it was in a window.
    private var wantsKeyboard = false
    /// Kept made under another tab's card: it takes no keyboard, asked for it or tabbed to,
    /// until it's back in view.
    private(set) var isOutOfSight = false
    override var acceptsFirstResponder: Bool { !isOutOfSight && super.acceptsFirstResponder }

    /// Hidden, for VoiceOver too, while its card is kept under another; with the keyboard let go
    /// of first, which AppKit would otherwise hand to the next field along.
    func keep(outOfSight: Bool, in scroll: NSScrollView) {
        guard outOfSight != isOutOfSight else { return }
        isOutOfSight = outOfSight
        if outOfSight, let window, window.firstResponder === self { window.makeFirstResponder(nil) }
        scroll.isHidden = outOfSight
    }
    /// What's drawn in place of a mark's first character: a bot's face, a conversation's or a
    /// picture's mark.
    private var faces = TextFaces()

    /// Written in since it was last scrolled by hand: the line with the caret is kept in view.
    var followsCaret = false
    /// See `MessageField.edgeRoom`.
    var edgeRoom: CGFloat = 0

    /// The line with the caret is to be shown before the field is next drawn.
    private var revealsCaret = false

    /// After a change to the text: the line with the caret in view, now and as the field grows to
    /// fit it. Now too, not only before it's drawn: a field scrolled wholly out of the list's view
    /// isn't drawn.
    func followCaret() {
        followsCaret = true
        showCaret()
        revealCaret()
    }

    /// The line with the caret in view once SwiftUI is done laying out the field and what's around
    /// it, before they're drawn: a list of quotes scrolled while SwiftUI lays it out goes back to
    /// where SwiftUI had it.
    func revealCaret() {
        guard followsCaret else { return }
        revealsCaret = true
        needsDisplay = true
    }

    override func viewWillDraw() {
        if revealsCaret {
            revealsCaret = false
            showCaret()
        }
        super.viewWillDraw()
    }

    /// The line with the caret in view: in the field, and in what scrolls around it (the list of
    /// quotes), which the field's own scrolling doesn't reach, with `edgeRoom` to spare there.
    func showCaret() {
        guard window?.firstResponder === self, let scroll = enclosingScrollView else { return }
        scrollRangeToVisible(selectedRange())
        guard let line = caretLine else { return }
        scroll.scrollToVisible(convert(line, to: scroll).insetBy(dx: 0, dy: -edgeRoom))
    }

    /// The line the caret is on, where it's laid out.
    private var caretLine: NSRect? {
        guard let layoutManager, let textContainer else { return nil }
        let length = (string as NSString).length
        let caret = selectedRange().location
        layoutManager.ensureLayout(for: textContainer)
        // After a last new line, the empty line it starts.
        let line = caret >= length && !layoutManager.extraLineFragmentRect.isEmpty
            ? layoutManager.extraLineFragmentRect
            : length == 0 ? NSRect(x: 0, y: 0, width: bounds.width, height: lineHeight)
            : layoutManager.lineFragmentRect(forGlyphAt: layoutManager.glyphIndexForCharacter(at: min(caret, length - 1)), effectiveRange: nil)
        return line.offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
    }

    var lineHeight: CGFloat {
        layoutManager?.defaultLineHeight(for: font ?? .systemFont(ofSize: NSFont.systemFontSize)) ?? 17
    }

    /// How tall its text is at `width`.
    func height(forWidth width: CGFloat) -> CGFloat {
        guard let layoutManager, let textContainer else { return lineHeight }
        if abs(textContainer.size.width - width) > 0.5 {
            textContainer.size = NSSize(width: width, height: .greatestFiniteMagnitude)
        }
        layoutManager.ensureLayout(for: textContainer)
        return layoutManager.usedRect(for: textContainer).height
    }

    /// The keyboard, with the caret after the text (not all of it selected, which typing would
    /// replace). Once SwiftUI is done updating: it's asked for while SwiftUI updates the field,
    /// and taking it tells the owner (`onFocus`), whose state mustn't change then.
    func takeKeyboard() {
        wantsKeyboard = true
        DispatchQueue.main.async { [weak self] in
            guard let self, wantsKeyboard, let window else { return }
            wantsKeyboard = false
            guard !isOutOfSight else { return }
            if window.firstResponder !== self { window.makeFirstResponder(self) }
            setSelectedRange(NSRange(location: (string as NSString).length, length: 0))
            scrollRangeToVisible(selectedRange())
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if wantsKeyboard, window != nil { takeKeyboard() }
    }

    /// Its text changed from outside (a name picked from a list, a sent message gone, one brought
    /// back, a picture's name taken out): only the part that changed is replaced, and the caret
    /// moves with it, after what came in where it was typing. Undo starts over, as what it
    /// remembers was in text that's gone.
    func replace(with text: String) {
        guard let storage = textStorage else { return }
        // The rule both apps' fields follow (KuvoClient's TextChange).
        let change = TextChange(from: string, to: text)
        let caret = selectedRange().location
        storage.replaceCharacters(in: change.range, with: change.replacement)
        setSelectedRange(NSRange(location: min(change.caret(movedFrom: caret), (text as NSString).length), length: 0))
        forgetUndo()
    }

    func forgetUndo() {
        undoManager?.removeAllActions(withTarget: self)
        textStorage.map { undoManager?.removeAllActions(withTarget: $0) }
    }

    /// VoiceOver (and the end-to-end runs) setting what it says: as if typed, so its owner hears.
    override func setAccessibilityValue(_ value: Any?) {
        guard let text = value as? String else { return super.setAccessibilityValue(value) }
        insertText(text, replacementRange: NSRange(location: 0, length: (string as NSString).length))
    }

    override func becomeFirstResponder() -> Bool {
        // Asked by `makeFirstResponder` too, which doesn't ask `acceptsFirstResponder` first.
        guard !isOutOfSight else { return false }
        let became = super.becomeFirstResponder()
        if became { onFocus(true) }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onFocus(false) }
        return resigned
    }

    override func keyDown(with event: NSEvent) {
        // An input method composing has its keys (Return picks, Escape cancels, arrows choose).
        if !hasMarkedText(), let key = MessageField.Key(event) {
            if onKey(key) { return }
            // Escape that isn't taken does nothing here (a text view would list completions).
            if key.name == .escape { return }
        }
        super.keyDown(with: event)
    }

    // Tab and Shift-Tab go on to the next control and back, as in a field, rather than typing a tab.
    override func insertTab(_ sender: Any?) { window?.selectNextKeyView(self) }
    override func insertBacktab(_ sender: Any?) { window?.selectPreviousKeyView(self) }

    // A paste (⌘V, Paste and Match Style, a service): files and pictures are the owner's to
    // attach, words come in plain. A picture alone (a screenshot copied to the clipboard is only
    // `public.png`) is among what it reads, as macOS offers Paste only for that.
    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        super.readablePasteboardTypes + Self.pictureTypes
    }

    private static let pictureTypes = NSImage.imageTypes.map { NSPasteboard.PasteboardType(rawValue: $0) }

    // A picture nothing here attaches (a group chat's field) isn't pasted at all: as text it would
    // be a blank character.
    override func readSelection(from pboard: NSPasteboard) -> Bool {
        if attached(from: pboard) { return true }
        guard let type = preferredPasteboardType(from: pboard.types ?? [], restrictedToTypesFrom: nil), !Self.pictureTypes.contains(type) else { return false }
        return super.readSelection(from: pboard)
    }

    override func readSelection(from pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        attached(from: pboard) || (!Self.pictureTypes.contains(type) && super.readSelection(from: pboard, type: type))
    }

    private func attached(from pboard: NSPasteboard) -> Bool {
        guard let names = onPaste(pboard) else { return false }
        if !names.isEmpty { write(names.joined(separator: " ")) }
        return true
    }

    /// `words` where the caret is, in place of what's selected, as if typed (it can be undone):
    /// a space before them after a word, and one after them.
    func write(_ words: String) {
        let range = selectedRange()
        let before = range.location > 0 ? (string as NSString).substring(with: NSRange(location: range.location - 1, length: 1)).last : nil
        insertText(Self.spaced(words, after: before), replacementRange: range)
    }

    static func spaced(_ words: String, after before: Character?) -> String {
        (before.map { $0.isWhitespace ? "" : " " } ?? "") + words + " "
    }

    /// Backspace right after a mark, with nothing selected, takes the whole mark away, as one thing.
    override func deleteBackward(_ sender: Any?) {
        let caret = selectedRange()
        if caret.length == 0, let mark = marks.first(where: { NSMaxRange($0) == caret.location }) {
            setSelectedRange(mark)
        }
        super.deleteBackward(sender)
    }

    /// Where each mark is: the agents named and the pictures, for Backspace.
    private var marks: [NSRange] = []
    /// It has marks styled, so the next styling starts over from plain text.
    private var styled = false
    private var styledFont: NSFont?
    /// Past this many characters (a pasted log), its addresses aren't looked for as you type.
    private static let longest = 20_000

    /// Styles what the text names, each time from the field's own look, so a mark no longer whole
    /// goes back to plain text.
    func restyle(marks shown: Bool, images: Int, token: MessageField.Token? = nil, refs: [String: WorkRef] = [:]) {
        guard let storage = textStorage, !hasMarkedText() else { return }
        let font = font ?? .systemFont(ofSize: NSFont.systemFontSize)
        let text = string
        let length = storage.length
        let all = NSRange(location: 0, length: length)
        // Only where there's something to style, or was: typing in a long pasted log stays as
        // quick as in any text. Addresses aren't looked for in one that long.
        let mayMark = shown && (text.contains(AgentReferences.trigger) || text.contains("[Image ") || (!refs.isEmpty && text.contains("#"))
            || (length < Self.longest && (text.contains("http") || text.contains("www."))))
        guard mayMark || token != nil || styled || font != styledFont else { return }
        styledFont = font
        var faces = TextFaces()
        var marks: [NSRange] = []
        storage.beginEditing()
        storage.setAttributes([.font: font, .foregroundColor: NSColor.textColor], range: all)
        let bold = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
        let size = (font.pointSize * 1.1).rounded()
        faces.size = size
        /// The first character of a mark makes room for its face, unseen.
        func face(_ image: NSImage?, at span: NSRange) {
            faces.add(image, at: span, in: storage, font: bold)
        }
        if let token, token.length > 1, token.length <= length {
            let span = NSRange(location: 0, length: token.length)
            let ink = NSColor(Color.accentColor)
            storage.addAttributes([.font: bold, .foregroundColor: ink], range: span)
            // Not one piece for Backspace: what's typed stays text you can correct a letter at a time.
            face(TextFaces.symbol(token.symbol, size: size, ink: ink), at: span)
        }
        if mayMark, length > 0 {
            for (range, _) in length < Self.longest ? WebLinks.find(in: text) : [] {
                storage.addAttribute(.foregroundColor, value: ReplyDocument.Colors.link, range: NSRange(range, in: text))
            }
            if text.contains(AgentReferences.trigger) {
                let agents = MessageMentions.agents(namedIn: text)
                for (range, reference) in AgentReferences.find(in: text, references: agents.map(\.reference)) {
                    let span = NSRange(range, in: text)
                    guard span.upperBound <= length else { continue }
                    let look = agents.first { $0.reference.session == reference.session }?.look
                    let ink = look.map { NSColor(GroupMentions.ink($0)) } ?? NSColor(Color.accentColor)
                    storage.addAttributes([.font: bold, .foregroundColor: ink], range: span)
                    face(look.flatMap { MessageMentions.face($0, size: size) } ?? TextFaces.symbol("bubble.left", size: size), at: span)
                    marks.append(span)
                }
            }
            // A Work Queue item the box knows: its mark over the "#" (or the "g" of an issue's
            // `gh:`), the ref in its color.
            for (range, key) in refs.isEmpty ? [] : WorkItemRefs.findRefs(in: text) {
                guard let ref = refs[key] else { continue }
                let span = NSRange(range, in: text)
                guard span.upperBound <= length else { continue }
                let mark = WorkItemMark(category: ref.category, inProgress: ref.inProgress, removed: ref.removed == true)
                storage.addAttributes([.font: bold, .foregroundColor: NSColor(mark.color), .toolTip: "\(ref.name) \(ref.title)"], range: span)
                face(WorkItemChipAttachment.dot(mark, size: size), at: span)
                marks.append(span)
            }
            for (range, number) in ImageReferences.find(in: text) where number <= images {
                let span = NSRange(range, in: text)
                storage.addAttributes([.font: bold, .foregroundColor: NSColor(Color.accentColor)], range: span)
                face(TextFaces.symbol("photo", size: size), at: span)
                // Its "]" is left out, as in the message once sent.
                let close = NSRange(location: NSMaxRange(span) - 1, length: 1)
                let width = ("]" as NSString).size(withAttributes: [.font: bold]).width
                storage.addAttributes([.foregroundColor: NSColor.clear, .kern: -width], range: close)
                marks.append(span)
            }
        }
        storage.endEditing()
        self.faces = faces
        self.marks = marks
        styled = !faces.all.isEmpty || mayMark || token != nil
        // What you type next is plain, also right after a mark.
        typingAttributes = [.font: font, .foregroundColor: NSColor.textColor]
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let origin = textContainerOrigin
        if string.isEmpty, !placeholder.isEmpty {
            let attributes: [NSAttributedString.Key: Any] = [.font: font ?? .systemFont(ofSize: NSFont.systemFontSize), .foregroundColor: NSColor.placeholderTextColor]
            // One line, cut short with an ellipsis in a narrow window.
            let line = NSRect(x: origin.x, y: origin.y, width: bounds.width - origin.x, height: lineHeight)
            (placeholder as NSString).draw(with: line, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes)
        }
        if let example, !example.isEmpty, !string.isEmpty, let layoutManager, let textContainer {
            // After the last thing written, on its line, as far as there's room.
            let length = (string as NSString).length
            let glyphs = layoutManager.glyphRange(forCharacterRange: NSRange(location: length - 1, length: 1), actualCharacterRange: nil)
            let last = layoutManager.boundingRect(forGlyphRange: glyphs, in: textContainer).offsetBy(dx: origin.x, dy: origin.y)
            let gap: CGFloat = string.last?.isWhitespace == true ? 0 : 4
            let line = NSRect(x: last.maxX + gap, y: last.minY, width: max(0, bounds.width - last.maxX - gap - textContainerInset.width), height: lineHeight)
            let attributes: [NSAttributedString.Key: Any] = [.font: font ?? .systemFont(ofSize: NSFont.systemFontSize), .foregroundColor: NSColor.placeholderTextColor]
            if line.width > 40 { (example as NSString).draw(with: line, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes) }
        }
        faces.draw(in: self)
    }
}

extension MessageFont {
    /// The font a message is written in, for `MessageField`.
    var field: NSFont { ReplyDocument.Style.font(size, weight: .regular, design: typeface.systemDesign) }
}
