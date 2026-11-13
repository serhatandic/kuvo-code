import AppKit
import ClientDesign
import ClientSessions
import ClientText
import SwiftUI
import Textual

/// A Work Queue item named in a reply (`#243`, or the issue it is, `gh:owner/repo#12`), drawn as
/// its chip: the item's mark, its number (or GitHub's mark and the issue's name) and its title.
/// Copied, it's as it was written again. Clicking it opens the item in the panel
/// (`WorkItemRefs.link`). One the box doesn't know stays as it was written.
nonisolated struct WorkItemChipAttachment: Attachment {
    /// As it was written: "#243", `gh:owner/repo#12`.
    let written: String
    let name: String
    let brand: String?
    let title: String
    let mark: WorkItemMark
    let struck: Bool
    let gone: Bool
    let spokenName: String

    init(_ ref: WorkRef, written: String) {
        self.written = written
        name = ref.name
        brand = ref.brand
        title = ref.title
        mark = WorkItemMark(category: ref.category, inProgress: ref.inProgress, removed: ref.removed == true)
        struck = ref.isStruck
        gone = ref.isGone
        spokenName = ref.spokenName
    }

    var description: String { written }
    var selectionStyle: AttachmentSelectionStyle { .text }

    func chip(size: CGFloat, dark: Bool) -> WorkItemChip {
        WorkItemChip(name: name, brand: brand, title: title, mark: mark, struck: struck, gone: gone, spokenAs: spokenName, size: size, dark: dark)
    }

    /// Where a reply's text is drawn by SwiftUI rather than TextKit.
    var body: some View { chip(size: 13, dark: false) }

    /// About its size at 13 points (TextKit draws it at its own, `image`).
    func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
        CGSize(width: 34 + (brand == nil ? 0 : 13) + 7 * Double(name.count + WorkItemChip.shownTitle(title).count), height: 18)
    }

    /// The chip drawn at a text's `size`, for light or dark, once each.
    @MainActor static func image(_ chip: WorkItemChipAttachment, size: CGFloat, dark: Bool) -> NSImage {
        let key = "\(chip.hashValue)|\(size)|\(dark)"
        if let known = images[key] { return known }
        let renderer = ImageRenderer(content: chip.chip(size: size, dark: dark))
        renderer.scale = 2 * max(1, (NSScreen.main?.backingScaleFactor ?? 2) / 2)
        let image = renderer.nsImage ?? NSImage()
        image.accessibilityDescription = WorkItemChip.spoken(name: chip.spokenName, title: chip.title, mark: chip.mark, gone: chip.gone)
        images[key] = image
        return image
    }

    /// An item's mark alone, `size` points square: over its "#" in the composer.
    @MainActor static func dot(_ mark: WorkItemMark, size: CGFloat) -> NSImage? {
        let key = "dot|\(mark.hashValue)|\(size)"
        if let known = images[key] { return known }
        let renderer = ImageRenderer(content: WorkItemDot(mark, size: size * 0.62).frame(width: size, height: size))
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2
        guard let image = renderer.nsImage else { return nil }
        images[key] = image
        return image
    }

    @MainActor private static var images: [String: NSImage] = [:]

    /// Turns each ref in `text` the box knows (`refs`, by the ref as asked: "243",
    /// `gh:owner/repo#12`) into its chip, a link to the item. Not in code or a link, nor a number
    /// for someone else (`WorkItemRefs`).
    static func apply(to text: inout AttributedString, refs: [String: WorkRef]) {
        guard !refs.isEmpty else { return }
        let plain = String(text.characters)
        let found = WorkItemRefs.findRefs(in: plain).filter { refs[$0.ref] != nil }
        guard !found.isEmpty else { return }
        for (range, key) in found.reversed() {
            guard let ref = refs[key] else { continue }
            let lower = text.characters.index(text.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: range.lowerBound))
            let span = lower..<text.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: range.upperBound))
            guard !text[span].runs.contains(where: { run in
                run.link != nil || run.inlinePresentationIntent?.contains(.code) == true || run.textual.attachment != nil
                    || run.presentationIntent?.components.contains { if case .codeBlock = $0.kind { true } else { false } } == true
            }) else { continue }
            var chip = AttributedString("\u{FFFC}", attributes: text[span].runs.first?.attributes ?? AttributeContainer())
            chip.link = WorkItemRefs.link(ref: key)
            chip.textual.attachment = AnyAttachment(WorkItemChipAttachment(ref, written: String(plain[range])))
            text.replaceSubrange(span, with: chip)
        }
    }

    /// Marks each ref in plain `text` (your own message, as written) the box knows (`refs`) to
    /// be drawn as its chip (`WorkItemChipMark`), a link to the item.
    static func mark(_ text: inout AttributedString, refs: [String: WorkRef]) {
        guard !refs.isEmpty else { return }
        let plain = String(text.characters)
        for (range, key) in WorkItemRefs.findRefs(in: plain) {
            guard let ref = refs[key] else { continue }
            let lower = text.characters.index(text.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: range.lowerBound))
            let span = lower..<text.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: range.upperBound))
            guard !text[span].runs.contains(where: { $0.link != nil }) else { continue }
            text[span][WorkItemChipMark.self] = WorkItemChipAttachment(ref, written: String(plain[range]))
            text[span].link = WorkItemRefs.link(ref: key)
        }
    }
}
