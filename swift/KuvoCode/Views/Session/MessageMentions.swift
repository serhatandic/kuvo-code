import AppKit
import ClientDesign
import ClientText
import OpenCodeKit
import os
import SwiftUI
import Textual

/// What a message names, standing out wherever it shows. In your bubbles (a session's, a bot's, a
/// chat's or a group chat's; sent, on its way or waiting): the bots and sessions named with "&",
/// in bold, a bot's in its color, each opening its conversation, and the files named with "@", in
/// bold, each opening in the side panel. In a bot's message in a group chat: the agents it names
/// with "&", the same way. (A group chat's "@Mira" is `GroupMentions`.)
nonisolated enum MessageMentions {
    /// An agent named with "&": as written, its conversation, and a bot's look.
    struct Agent: Hashable, Sendable {
        var reference: AgentReferences.Reference
        var look: BotLook?
    }

    /// `references` with the looks of those that are bots: `bots`' (a view's own, so it's drawn
    /// again as they load), or the app's.
    @MainActor static func agents(_ references: [AgentReferences.Reference], bots: Bots? = nil) -> [Agent] {
        let bots = bots ?? AgentMail.shared.app?.bots
        return references.map { Agent(reference: $0, look: bots?.bot(forSession: $0.session)?.look) }
    }

    /// The agents `text` names with "&", as its message would name them now: for a group chat's,
    /// which carry no block saying who they are.
    @MainActor static func agents(namedIn text: String) -> [Agent] {
        agents(AgentReferences.named(in: [text]).map { AgentReferences.Reference(name: $0.name, session: $0.session) })
    }

    /// What stands for an agent's "&": a bot's face, or a conversation's mark, before its name.
    enum Marks {
        /// In your words (your bubbles, the queue): the "&" is marked (`AgentMark`), and
        /// `attributed(_:font:)` or `text(_:size:)` draws it as a picture.
        case inline
        /// In Textual's (a bot's message): an attachment in its place.
        case attachments
    }

    /// Styles in `text` each of `agents` it names with "&", its "&" made its face or mark, and with
    /// `folders` (a project's, in a session), each file it names with "@" as the composer writes
    /// them; with `links`, each opening what it names.
    static func apply(to text: inout AttributedString, agents: [Agent], folders: [String] = [], links: Bool = true, marks drawn: Marks = .inline) {
        let plain = String(text.characters)
        guard plain.contains(AgentReferences.trigger) || (!folders.isEmpty && plain.contains("@")) else { return }
        var looks: [String: BotLook] = [:]
        for agent in agents { looks[agent.reference.session] = agent.look }
        var marks: [(range: Range<String.Index>, link: URL?, look: BotLook?)] = AgentReferences.find(in: plain, references: agents.map(\.reference)).map {
            ($0.range, link(to: $0.reference.session), looks[$0.reference.session])
        }
        if !folders.isEmpty {
            for (range, path) in files(in: plain) where !marks.contains(where: { $0.range.overlaps(range) }) {
                marks.append((range, FileLinks.file(named: path, folders: folders), nil))
            }
        }
        // Last first, so each leaves the places of those before it as they were.
        for mark in marks.sorted(by: { $0.range.lowerBound > $1.range.lowerBound }) {
            let start = plain.distance(from: plain.startIndex, to: mark.range.lowerBound)
            let length = plain.distance(from: mark.range.lowerBound, to: mark.range.upperBound)
            let lower = text.characters.index(text.startIndex, offsetBy: start)
            let upper = text.characters.index(lower, offsetBy: length)
            if let look = mark.look { text[lower..<upper].swiftUI.foregroundColor = GroupMentions.ink(look) }
            text[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
            if links, let link = mark.link { text[lower..<upper].link = link }
            // An agent's "&" (a file's "@" stays): its face, or a conversation's mark.
            guard let session = mark.link.flatMap(Self.session(in:)), text.characters[lower] == AgentReferences.trigger else { continue }
            let amp = lower..<text.characters.index(after: lower)
            switch drawn {
            case .inline:
                text[amp][AgentMark.self] = Agent(reference: .init(name: "", session: session), look: mark.look)
            case .attachments:
                var face = AttributedString("\u{FFFC}", attributes: text[amp].runs.first?.attributes ?? AttributeContainer())
                face.link = nil
                face.textual.attachment = mark.look.map { AnyAttachment(MentionFace(look: $0)) } ?? AnyAttachment(ConversationMark())
                face[FindReadsAs.self] = AgentReferences.trigger
                text.replaceSubrange(amp, with: face)
            }
        }
    }

    /// In your own words (a bubble, the queue): each web address a link, in the replies' link
    /// color, and each of the first `pictures` pictures' names ("[Image 2]") as the composer shows
    /// it, its picture's mark and its name in bold, without the brackets.
    static func applyLinksAndPictures(to text: inout AttributedString, pictures: Int) {
        let plain = String(text.characters)
        func span(_ range: Range<String.Index>) -> Range<AttributedString.Index> {
            let lower = text.characters.index(text.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: range.lowerBound))
            return lower..<text.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: range.upperBound))
        }
        for (range, url) in WebLinks.find(in: plain) {
            let span = span(range)
            guard !text[span].runs.contains(where: { $0.link != nil }) else { continue }
            text[span].link = url
            text[span].swiftUI.foregroundColor = Color(nsColor: ReplyDocument.Colors.link)
        }
        for (range, number) in ImageReferences.find(in: plain) where number <= pictures {
            let span = span(range)
            text[span].inlinePresentationIntent = .stronglyEmphasized
            text[span].swiftUI.foregroundColor = .accentColor
            text[span.lowerBound..<text.characters.index(after: span.lowerBound)][PictureMark.self] = .open
            text[text.characters.index(before: span.upperBound)..<span.upperBound][PictureMark.self] = .close
        }
    }

    /// `text` with `typed`, the keyword it was sent with, in front, drawn as the composer draws it:
    /// its mark for the "/", the rest in bold, in the accent.
    static func keyword(_ typed: String, before text: AttributedString) -> AttributedString {
        guard typed.count > 1, let keyword = Keyword.parse(typed)?.keyword else { return text }
        var token = AttributedString(typed)
        token.inlinePresentationIntent = .stronglyEmphasized
        token.swiftUI.foregroundColor = .accentColor
        token[token.startIndex..<token.characters.index(after: token.startIndex)][KeywordTokenMark.self] = keyword.symbol
        return text.characters.isEmpty ? token : token + AttributedString(" ") + text
    }

    /// `attributed` as SwiftUI's Text (the queue's, the key page's line), each marked "&" drawn as
    /// its face or mark, `size` points, and its links marked for `LinkPointer`.
    @MainActor static func text(_ attributed: AttributedString, size: CGFloat) -> Text {
        guard attributed.runs.contains(where: { $0[AgentMark.self] != nil || $0[PictureMark.self] != nil || $0[KeywordTokenMark.self] != nil || $0.link != nil }) else { return Text(attributed) }
        var pieces: [Text] = []
        for run in attributed.runs {
            var piece: Text
            if let symbol = run[KeywordTokenMark.self] {
                // A keyword's mark in place of its "/", in its colour.
                piece = Text("\(Image(systemName: symbol))\u{2009}").font(.system(size: size * 0.82))
                    .foregroundStyle(run.swiftUI.foregroundColor ?? .accentColor)
            } else if let mark = run[PictureMark.self] {
                // A picture's mark in place of its "[", and its "]" left out.
                guard mark == .open else { continue }
                piece = Text("\(Image(systemName: "photo"))").font(.system(size: size * 0.82)).foregroundStyle(.secondary)
            } else if let agent = run[AgentMark.self] {
                if let look = agent.look, let face = face(look, size: size) {
                    piece = Text("\(Image(nsImage: face))").baselineOffset(-size * 0.2)
                } else {
                    piece = Text("\(Image(systemName: "bubble.left"))").font(.system(size: size * 0.82)).foregroundStyle(.secondary)
                }
            } else {
                piece = Text(AttributedString(attributed[run.range]))
            }
            // A link's words and its face both open it.
            if let link = run.link { piece = piece.customAttribute(LinkRun(url: link)) }
            pieces.append(piece)
        }
        return pieces.reduce(Text("")) { Text("\($0)\($1)") }
    }

    /// `attributed` for AppKit's text (`SelectableText`), in `font`, drawn as the composer draws
    /// it, in `color` where it sets none: each marked "&" its face or mark, a keyword's "/" its mark, a picture's name its mark
    /// for the "[" and without the "]", each over the character it stands for, which stays (so
    /// it's copied and found as written). Bold, color, links and Find's marks as they're set.
    @MainActor static func attributed(_ attributed: AttributedString, font: NSFont, color: NSColor = .labelColor, dark: Bool = false) -> (text: NSAttributedString, faces: TextFaces) {
        let text = NSMutableAttributedString()
        var faces = TextFaces()
        faces.size = (font.pointSize * 1.1).rounded()
        let bold = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
        let italic = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
        for run in attributed.runs {
            let intent = run.inlinePresentationIntent ?? []
            let runFont = intent.contains(.stronglyEmphasized) ? bold : intent.contains(.emphasized) ? italic : font
            var attributes: [NSAttributedString.Key: Any] = [
                .font: runFont,
                .foregroundColor: run.swiftUI.foregroundColor.map { NSColor($0) } ?? color,
            ]
            if let background = run.swiftUI.backgroundColor { attributes[.backgroundColor] = NSColor(background) }
            if run.swiftUI.strikethroughStyle != nil { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { attributes[.link] = link }
            let start = text.length
            text.append(NSAttributedString(string: String(attributed[run.range].characters), attributes: attributes))
            let span = NSRange(location: start, length: text.length - start)
            let ink = attributes[.foregroundColor] as? NSColor ?? color
            if let chip = run[WorkItemChipMark.self] {
                faces.addChip(WorkItemChipAttachment.image(chip, size: font.pointSize, dark: dark), over: span, in: text, font: runFont)
            } else if let symbol = run[KeywordTokenMark.self] {
                faces.add(TextFaces.symbol(symbol, size: faces.size, ink: ink), at: span, in: text, font: runFont)
            } else if let mark = run[PictureMark.self] {
                if mark == .open {
                    faces.add(TextFaces.symbol("photo", size: faces.size), at: span, in: text, font: runFont)
                } else {
                    faces.hide(span, in: text, font: runFont)
                }
            } else if let agent = run[AgentMark.self] {
                let face = agent.look.flatMap { face($0, size: faces.size) } ?? TextFaces.symbol("bubble.left", size: faces.size)
                faces.add(face, at: span, in: text, font: runFont)
            }
        }
        return (text, faces)
    }

    /// A bot's face as a picture of `size` points, drawn once for each look and size.
    @MainActor static func face(_ look: BotLook, size: CGFloat) -> NSImage? {
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let key = "\(look.hashValue) \(size) \(scale)"
        if let known = faces[key] { return known }
        let renderer = ImageRenderer(content: BotAvatar(look: look, size: size, animates: false).frame(width: size, height: size))
        renderer.scale = scale
        guard let image = renderer.nsImage else { return nil }
        faces[key] = image
        return image
    }

    @MainActor private static var faces: [String: NSImage] = [:]

    /// Each "@path" in `text`, as the composer writes a file or folder: the "@" starting a word,
    /// then a path (with a "/" or a "."), without the punctuation that may end a sentence after it.
    static func files(in text: String) -> [(range: Range<String.Index>, path: String)] {
        var found: [(range: Range<String.Index>, path: String)] = []
        var index = text.startIndex
        while let at = text[index...].firstIndex(of: "@") {
            index = text.index(after: at)
            if at > text.startIndex, !text[text.index(before: at)].isWhitespace, text[text.index(before: at)] != "(" { continue }
            var end = text[index...].firstIndex(where: \.isWhitespace) ?? text.endIndex
            while end > index, ".,;:!?)\"'”’".contains(text[text.index(before: end)]) { end = text.index(before: end) }
            let path = String(text[index..<end])
            guard path.contains("/") || path.contains("."), path.contains(where: \.isLetter), !path.contains("@") else { continue }
            found.append((at..<end, path))
            index = end
        }
        return found
    }

    /// The address a named agent's link opens: its conversation.
    static func link(to session: String) -> URL? {
        URL(string: "kuvo-agent://" + session)
    }

    /// The conversation a link made by `link(to:)` opens.
    static func session(in url: URL) -> String? {
        url.scheme == "kuvo-agent" ? url.host() : nil
    }
}

/// The links in a text made by `MessageMentions.text(_:size:)`, as links anywhere else: the
/// pointing hand over them, and a click opening them (with `openURL`). SwiftUI's Text shows no
/// hand over its links, and a selectable one keeps its text cursor over a pointer style, so a
/// view of AppKit's lies over each. Only for a text with links in it.
struct LinkPointer: ViewModifier {
    var isOn: Bool
    /// Its words can be selected: the I-beam over them, off a link (otherwise the arrow).
    var isSelectable = true
    @State private var spots = LinkSpots()
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        if isOn {
            content
                .textRenderer(LinkPlaces(spots: spots))
                .overlay { LinkArea(spots: spots, isSelectable: isSelectable, open: { openURL($0) }) }
        } else {
            content
        }
    }
}

/// A run of a link, for `LinkPointer`.
nonisolated struct LinkRun: TextAttribute {
    var url: URL
}

/// Where a text's links are drawn, kept by `LinkPlaces` as it draws, for `LinkArea`.
nonisolated final class LinkSpots: Sendable {
    struct Spot: Equatable, Sendable {
        var rect: CGRect
        var url: URL
    }

    private let spots = OSAllocatedUnfairLock<[Spot]>(initialState: [])

    var all: [Spot] { spots.withLock { $0 } }

    func set(_ new: [Spot]) {
        spots.withLock { $0 = new }
    }
}

/// Draws a text as it is, keeping where its links are.
nonisolated private struct LinkPlaces: TextRenderer {
    let spots: LinkSpots

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        var found: [LinkSpots.Spot] = []
        for line in layout {
            for run in line {
                if let link = run[LinkRun.self] { found.append(.init(rect: run.typographicBounds.rect, url: link.url)) }
                context.draw(run)
            }
        }
        spots.set(found)
    }
}

/// A text's links in AppKit: the pointing hand over each, and a click on one opening it. Away from
/// them, the pointer and clicks go on to the text below.
private struct LinkArea: NSViewRepresentable {
    let spots: LinkSpots
    let isSelectable: Bool
    let open: (URL) -> Void

    func makeNSView(context: Context) -> LinkAreaView {
        let view = LinkAreaView()
        view.spots = spots
        view.isSelectable = isSelectable
        view.open = open
        return view
    }

    func updateNSView(_ view: LinkAreaView, context: Context) {
        view.isSelectable = isSelectable
        view.open = open
    }
}

private final class LinkAreaView: NSView {
    var spots: LinkSpots?
    var isSelectable = true
    var open: ((URL) -> Void)?
    private var pressed: LinkSpots.Spot?

    override var isFlipped: Bool { true }

    private func spot(at point: NSPoint) -> LinkSpots.Spot? {
        spots?.all.first { $0.rect.contains(point) }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, let superview else { return nil }
        return spot(at: convert(point, from: superview)) == nil ? nil : self
    }

    // The hand over a link, where nothing is drawn over it (`PointerClaim`).
    private let claim = PointerClaim()
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = PointerClaim.trackingArea(owner: self, in: self)
        addTrackingArea(area)
        tracking = area
    }

    private func pointerMoved(_ event: NSEvent) {
        let onLink = PointerClaim.isTopmost(self, at: event.locationInWindow)
        // Off a link, still on the words: the selectable text's I-beam, as it shows elsewhere
        // (not under a menu open over them).
        let onText = isSelectable && bounds.contains(convert(event.locationInWindow, from: nil))
            && window.map { PointerClaim.isOnTop($0, at: event.locationInWindow) } == true
        claim.show(onLink ? .pointingHand : nil, otherwise: onText ? .iBeam : .arrow)
    }

    override func cursorUpdate(with event: NSEvent) { pointerMoved(event) }
    override func mouseEntered(with event: NSEvent) { pointerMoved(event) }
    override func mouseMoved(with event: NSEvent) { pointerMoved(event) }
    override func mouseExited(with event: NSEvent) { claim.show(nil) }

    // Removed under the pointer: no `mouseExited` comes.
    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow == nil { claim.show(nil) }
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        pressed = spot(at: convert(event.locationInWindow, from: nil))
    }

    override func mouseUp(with event: NSEvent) {
        defer { pressed = nil }
        guard let pressed, spot(at: convert(event.locationInWindow, from: nil))?.url == pressed.url else { return }
        open?(pressed.url)
    }
}

/// A picture's name in your words: its "[" is drawn as a picture's mark, its "]" left out.
nonisolated enum PictureMark: AttributedStringKey {
    enum Value: Hashable, Sendable { case open, close }
    static let name = "kuvo.pictureMark"
}

/// A keyword's "/" in a bubble, which `MessageMentions.attributed(_:font:color:)` (and
/// `text(_:size:)` in the queue) draws as its mark (the keyword's symbol).
nonisolated enum KeywordTokenMark: AttributedStringKey {
    typealias Value = String
    static let name = "kuvo.keywordTokenMark"
}

/// A Work Queue item's "#243" in a bubble, which `MessageMentions.attributed(_:font:color:dark:)`
/// draws as its chip.
nonisolated enum WorkItemChipMark: AttributedStringKey {
    typealias Value = WorkItemChipAttachment
    static let name = "kuvo.workItemChip"
}

/// An agent's "&" in a bubble, which `MessageMentions.attributed(_:font:color:)` (and
/// `text(_:size:)` in the queue) draws as its face or mark.
nonisolated enum AgentMark: AttributedStringKey {
    typealias Value = MessageMentions.Agent
    static let name = "kuvo.agentMark"
}

/// A conversation's mark in a line of Textual's text, where its "&" was (a bot's is its face).
nonisolated struct ConversationMark: Attachment {
    var description: String { "&" }
    var selectionStyle: AttachmentSelectionStyle { .text }

    var body: some View {
        Image(systemName: "bubble.left")
            .resizable()
            .scaledToFit()
            .foregroundStyle(.secondary)
    }

    func baselineOffset(in environment: TextEnvironmentValues) -> CGFloat {
        FontScaled<CGFloat>.fontScaled(-0.15).resolve(in: environment)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
        FontScaled<CGSize>.fontScaled(width: 0.9, height: 0.9).resolve(in: environment)
    }
}
