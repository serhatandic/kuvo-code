import AppKit
import ClientDesign
import ClientSessions
import ClientText
import Foundation
import SwiftUI
import Textual

/// File names a reply writes as code (`src/App.swift`, `App.swift:42`) become links that open
/// the file in the side panel, when it's in one of the project's folders.
nonisolated enum FileLinks {
    /// The file a code span names, if it's one: a path with an optional line ("file.swift:12",
    /// "file.swift:12-20" or "file.swift#L12"), relative to one of `folders`, or absolute.
    static func file(named span: String, folders: [String]) -> URL? {
        guard !span.contains(where: \.isWhitespace), !span.contains("://"),
              span.contains("/") || span.contains(".") else { return nil }
        let path = span.replacing(/(:\d+(-\d+)?|#L\d+(-L?\d+)?)$/, with: "")
        // A name has a letter in it: not "1.2.3" or "..".
        guard (path as NSString).lastPathComponent.contains(where: \.isLetter) else { return nil }
        // A reply is read again on every word that streams in; the disk is asked at most every
        // few seconds per name (a file the agent is about to create links once it exists).
        let key = folders.joined(separator: "\n") + "\u{0}" + path as NSString
        if let known = cache.object(forKey: key), Date().timeIntervalSince(known.checked) < 5 { return known.url }
        let url = find(path, folders: folders)
        cache.setObject(Known(url: url), forKey: key)
        return url
    }

    private final class Known {
        let url: URL?
        let checked = Date()
        init(url: URL?) { self.url = url }
    }

    /// NSCache is thread-safe.
    nonisolated(unsafe) private static let cache: NSCache<NSString, Known> = {
        let cache = NSCache<NSString, Known>()
        cache.countLimit = 2000
        return cache
    }()

    private static func find(_ path: String, folders: [String]) -> URL? {
        // A project on a machine: its files aren't on this Mac's disk to be looked for, and a path
        // like "/etc/hosts" or "~/.gitconfig" is the machine's, never this Mac's file of that name.
        // (Linking them would need the machine asked about each name as a reply streams in.)
        if folders.contains(where: RemoteFolder.isRemote) { return nil }
        var candidates: [String] = []
        if path.hasPrefix("/") {
            candidates = [path]
        } else if path.hasPrefix("~/") {
            candidates = [NSHomeDirectory() + path.dropFirst()]
        } else {
            for folder in folders {
                candidates.append(folder + "/" + path)
                // Another folder's files by its name ("api/README.md"), as "@" writes them.
                let name = (folder as NSString).lastPathComponent
                if path.hasPrefix(name + "/") { candidates.append((folder as NSString).deletingLastPathComponent + "/" + path) }
            }
        }
        for candidate in candidates {
            var isFolder: ObjCBool = false
            if FileManager.default.fileExists(atPath: candidate, isDirectory: &isFolder), !isFolder.boolValue {
                return URL(filePath: candidate)
            }
        }
        return nil
    }
}

nonisolated extension FileLinks {
    /// The code spans in `text` that name a file in `folders`, with the file, last first (so
    /// replacing each leaves the ones before it where they were).
    static func spans(in text: AttributedString, folders: [String]) -> [(range: Range<AttributedString.Index>, url: URL)] {
        guard text.runs.contains(where: { $0.inlinePresentationIntent?.contains(.code) == true }) else { return [] }
        var links: [(range: Range<AttributedString.Index>, url: URL)] = []
        for run in text.runs where run.inlinePresentationIntent?.contains(.code) == true && run.link == nil {
            if let url = file(named: String(text[run.range].characters), folders: folders) {
                links.append((run.range, url))
            }
        }
        return links.reversed()
    }

    /// What a link shows: the file's name and any line, as "App.swift:42" for "src/App.swift:42".
    static func label(_ written: String) -> String {
        guard let slash = written.lastIndex(of: "/"), written.index(after: slash) < written.endIndex else { return written }
        return String(written[written.index(after: slash)...])
    }

    /// The icon in front of a file's name, as a character in the text.
    static let icon = "\u{FFFC}"
}

/// Textual's Markdown, with code spans that name a file made links to it, drawn as a file: an
/// icon and its name ("App.swift:42"), in link color rather than as code. With Find open, the
/// places it found marked.
struct FileLinkingParser: MarkupParser {
    /// Asked when parsing rather than while the view updates, so replies don't redraw each
    /// time the project's settings change.
    let folders: () -> [String]
    /// In a group chat, its bots: "@Name" shows their face and color.
    var mentions: [Bot] = []
    /// In a group chat, the bots and sessions a message names with "&" (see `MessageMentions`).
    var agents: [MessageMentions.Agent] = []
    var highlight: FindHighlight?
    /// What the Work Queue items it names are (`#243`): drawn as their chips.
    var refs: [String: WorkRef] = [:]

    func attributedString(for input: String) throws -> AttributedString {
        #if DEBUG
        let began = ContinuousClock.now
        defer { ParseClock.add(ContinuousClock.now - began) }
        #endif
        var text = try MathText.syntax.attributedString(markdown: input)
        if !mentions.isEmpty { GroupMentions.apply(to: &text, bots: mentions, faces: true) }
        if !agents.isEmpty { MessageMentions.apply(to: &text, agents: agents, marks: .attachments) }
        for (range, url) in FileLinks.spans(in: text, folders: folders()) {
            var attributes = text[range].runs.first?.attributes ?? AttributeContainer()
            var intent = attributes.inlinePresentationIntent ?? []
            intent.remove(.code)
            attributes.inlinePresentationIntent = intent.isEmpty ? nil : intent
            attributes.link = url
            var name = AttributedString(FileLinks.label(String(text[range].characters)), attributes: attributes)
            // The icon goes before the link, not in it: Textual draws attachments only outside links.
            var icon = AttributedString(FileLinks.icon, attributes: attributes)
            icon.link = nil
            icon.textual.attachment = AnyAttachment(FileIconAttachment())
            var gap = AttributedString(" ", attributes: attributes)
            gap.link = nil
            name.insert(icon + gap, at: name.startIndex)
            text.replaceSubrange(range, with: name)
        }
        SiteIconAttachment.mark(&text)
        WorkItemChipAttachment.apply(to: &text, refs: refs)
        if let highlight { FindText.mark(&text, highlight, inCode: true) }
        return text
    }
}

/// The icon of the site a web link in a reply leads to, before it, as a file's link has its
/// document icon: the site's own (`SiteIcons`), or the globe while it comes, when it doesn't come
/// within a second, or when it has none that reads well. The same square either way, so nothing
/// moves when it comes.
struct SiteIconAttachment: Attachment {
    let url: URL
    var description: String { "" }
    var selectionStyle: AttachmentSelectionStyle { .text }

    var host: String { url.host()?.lowercased() ?? "" }

    /// Where a reply's text is drawn by SwiftUI rather than TextKit.
    var body: some View { SiteIconView(url: url) }

    func baselineOffset(in environment: TextEnvironmentValues) -> CGFloat {
        FontScaled<CGFloat>.fontScaled(-0.12).resolve(in: environment)
    }

    /// Its square, and the room after it before the link's words (no space of its own, which
    /// copying the reply would keep).
    func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
        FontScaled<CGSize>.fontScaled(width: 1.2, height: 0.92).resolve(in: environment)
    }

    /// Puts the icon before each web link in `text` (once for a link in several runs), outside the
    /// link: Textual draws attachments only outside links.
    static func mark(_ text: inout AttributedString) {
        var starts: [(AttributedString.Index, URL, AttributeContainer)] = []
        var previous: URL?
        for run in text.runs {
            defer { previous = run.link }
            guard let url = run.link, url != previous, ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host() != nil else { continue }
            starts.append((run.range.lowerBound, url, run.attributes))
        }
        for (start, url, attributes) in starts.reversed() {
            var icon = AttributedString(FileLinks.icon, attributes: attributes)
            icon.link = nil
            icon.textual.attachment = AnyAttachment(SiteIconAttachment(url: url))
            text.insert(icon, at: start)
        }
    }
}

/// A site's icon in SwiftUI's text: the globe until it's here.
struct SiteIconView: View {
    let url: URL
    @State private var icon: NSImage?

    var body: some View {
        GeometryReader { room in
            Group {
                if let icon {
                    Image(nsImage: icon).resizable().clipShape(.rect(cornerRadius: room.size.height * 0.2))
                } else {
                    Image(systemName: "globe").resizable().fontWeight(.light).foregroundStyle(.tint)
                }
            }
            .aspectRatio(contentMode: .fit)
            .frame(width: room.size.height, height: room.size.height)
        }
        .task(id: url) {
            guard let site = SiteAddresses.site(of: url) else { return }
            if case .icon(let shown)? = SiteIcons.shared.shown(site) { return icon = shown }
            SiteIcons.shared.load(url)
            for await note in NotificationCenter.default.notifications(named: SiteIcons.loaded) where note.object as? String == site {
                if case .icon(let shown)? = SiteIcons.shared.shown(site) { icon = shown }
                break
            }
        }
    }
}

/// The document icon before a file's name in a reply, in link color like the name.
struct FileIconAttachment: Attachment {
    var description: String { "" }
    var selectionStyle: AttachmentSelectionStyle { .text }

    // Drawn scaled into its slot in the text, so no frame of its own.
    var body: some View {
        Image(systemName: "doc")
            .resizable()
            .fontWeight(.light)
            .aspectRatio(contentMode: .fit)
            .foregroundStyle(.tint)
    }

    func baselineOffset(in environment: TextEnvironmentValues) -> CGFloat {
        FontScaled<CGFloat>.fontScaled(-0.12).resolve(in: environment)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
        FontScaled<CGSize>.fontScaled(width: 0.78, height: 0.92).resolve(in: environment)
    }
}

#if DEBUG
/// How long parsing replies takes, for the scrolling test.
nonisolated enum ParseClock {
    nonisolated(unsafe) static var total = Duration.zero
    nonisolated(unsafe) static var count = 0
    static func add(_ time: Duration) {
        total += time
        count += 1
    }
}
#endif
