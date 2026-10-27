import AppKit
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
        /// In SwiftUI's Text (your bubbles, the queue): the "&" is marked (`AgentMark`), and
        /// `text(_:size:)` draws it as a picture.
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

    /// `attributed` as SwiftUI's Text, each marked "&" drawn as its face or mark, `size` points,
    /// and its links marked for `LinkPointer`.
    /// `text` with its first `length` characters the keyword it was sent with, drawn as the
    /// composer draws it: its mark for the "/", the rest in bold, in the accent (Plan's orange).
    static func keyword(_ length: Int, in text: AttributedString) -> AttributedString {
        var text = text
        let plain = String(text.characters)
        guard length > 1, length <= plain.count, let keyword = Keyword.parse(String(plain.prefix(length)))?.keyword else { return text }
        let end = text.characters.index(text.startIndex, offsetBy: length)
        text[text.startIndex..<end].inlinePresentationIntent = .stronglyEmphasized
        text[text.startIndex..<end].swiftUI.foregroundColor = keyword.isPlan ? .orange : .accentColor
        text[text.startIndex..<text.characters.index(after: text.startIndex)][KeywordTokenMark.self] = keyword.symbol
        return text
    }

    @MainActor static func text(_ attributed: AttributedString, size: CGFloat) -> Text {
        guard attributed.runs.contains(where: { $0[AgentMark.self] != nil || $0[PictureMark.self] != nil || $0[KeywordTokenMark.self] != nil || $0.link != nil }) else { return Text(attributed) }
        var pieces: [Text] = []
        for run in attributed.runs {
            var piece: Text
            if let symbol = run[KeywordTokenMark.self] {
                // A keyword's mark in place of its "/", in its colour.
                piece = Text("\(Image(systemName: symbol))\u{2009}").font(.system(size: size * 0.82, weight: .semibold))
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
    @State private var spots = LinkSpots()
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        if isOn {
            content
                .textRenderer(LinkPlaces(spots: spots))
                .overlay { LinkArea(spots: spots, open: { openURL($0) }) }
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
    /// Told when they change.
    private let changed = OSAllocatedUnfairLock<(@Sendable () -> Void)?>(initialState: nil)

    var all: [Spot] { spots.withLock { $0 } }

    func set(_ new: [Spot]) {
        guard spots.withLock({ old in
            guard old != new else { return false }
            old = new
            return true
        }) else { return }
        if let tell = changed.withLock({ $0 }) { DispatchQueue.main.async(execute: tell) }
    }

    func onChange(_ tell: (@Sendable () -> Void)?) {
        changed.withLock { $0 = tell }
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
    let open: (URL) -> Void

    func makeNSView(context: Context) -> LinkAreaView {
        let view = LinkAreaView()
        view.spots = spots
        view.open = open
        spots.onChange { [weak view] in
            MainActor.assumeIsolated { view?.spotsChanged() }
        }
        return view
    }

    func updateNSView(_ view: LinkAreaView, context: Context) {
        view.open = open
    }

    static func dismantleNSView(_ view: LinkAreaView, coordinator: ()) {
        view.spots?.onChange(nil)
    }
}

private final class LinkAreaView: NSView {
    var spots: LinkSpots?
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

    func spotsChanged() {
        window?.invalidateCursorRects(for: self)
        updateTrackingAreas()
    }

    override func resetCursorRects() {
        for spot in spots?.all ?? [] { addCursorRect(spot.rect, cursor: .pointingHand) }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        for spot in spots?.all ?? [] {
            addTrackingArea(NSTrackingArea(rect: spot.rect, options: [.cursorUpdate, .activeInKeyWindow], owner: self))
        }
    }

    override func cursorUpdate(with event: NSEvent) {
        NSCursor.pointingHand.set()
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

/// A keyword's "/" in a bubble, which `MessageMentions.text(_:size:)` draws as its mark (the
/// keyword's symbol).
nonisolated enum KeywordTokenMark: AttributedStringKey {
    typealias Value = String
    static let name = "kuvo.keywordTokenMark"
}

/// An agent's "&" in a bubble, which `MessageMentions.text(_:size:)` draws as its face or mark.
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
