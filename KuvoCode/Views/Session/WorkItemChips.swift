import AppKit
import ClientDesign
import ClientSessions
import ClientText
import SwiftUI
import Textual

/// A Work Queue item named in a reply (`#243`), drawn as its chip: the item's mark, its number
/// and its title. Copied, it's "#243" again. Clicking it opens the item in the panel
/// (`WorkItemRefs.link`). A number the box doesn't know stays as it was written.
nonisolated struct WorkItemChipAttachment: Attachment {
    let number: Int
    let title: String
    let mark: WorkItemMark

    init(_ ref: WorkRef, number: Int) {
        self.number = number
        title = ref.title
        mark = WorkItemMark(category: ref.category, inProgress: ref.inProgress, removed: ref.removed == true)
    }

    var description: String { "#\(number)" }
    var selectionStyle: AttachmentSelectionStyle { .text }

    /// Where a reply's text is drawn by SwiftUI rather than TextKit.
    var body: some View { WorkItemChip(number: number, title: title, mark: mark, size: 13, dark: false) }

    /// About its size at 13 points (TextKit draws it at its own, `image`).
    func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
        CGSize(width: 34 + 7 * Double("\(number)".count + WorkItemChip.shownTitle(title).count), height: 18)
    }

    /// The chip drawn at a text's `size`, for light or dark, once each.
    @MainActor static func image(_ chip: WorkItemChipAttachment, size: CGFloat, dark: Bool) -> NSImage {
        let key = "\(chip.hashValue)|\(size)|\(dark)"
        if let known = images[key] { return known }
        let renderer = ImageRenderer(content: WorkItemChip(number: chip.number, title: chip.title, mark: chip.mark, size: size, dark: dark))
        renderer.scale = 2 * max(1, (NSScreen.main?.backingScaleFactor ?? 2) / 2)
        let image = renderer.nsImage ?? NSImage()
        image.accessibilityDescription = WorkItemChip.spoken(number: chip.number, title: chip.title, mark: chip.mark)
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

    /// Turns each `#n` in `text` the box knows (`refs`) into its chip, a link to the item. Not in
    /// code or a link, nor a number for someone else (`WorkItemRefs`).
    static func apply(to text: inout AttributedString, refs: [Int: WorkRef]) {
        guard !refs.isEmpty else { return }
        let plain = String(text.characters)
        let found = WorkItemRefs.find(in: plain).filter { refs[$0.number] != nil }
        guard !found.isEmpty else { return }
        for (range, number) in found.reversed() {
            guard let ref = refs[number] else { continue }
            let lower = text.characters.index(text.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: range.lowerBound))
            let span = lower..<text.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: range.upperBound))
            guard !text[span].runs.contains(where: { run in
                run.link != nil || run.inlinePresentationIntent?.contains(.code) == true || run.textual.attachment != nil
                    || run.presentationIntent?.components.contains { if case .codeBlock = $0.kind { true } else { false } } == true
            }) else { continue }
            var chip = AttributedString("\u{FFFC}", attributes: text[span].runs.first?.attributes ?? AttributeContainer())
            chip.link = WorkItemRefs.link(number)
            chip.textual.attachment = AnyAttachment(WorkItemChipAttachment(ref, number: number))
            text.replaceSubrange(span, with: chip)
        }
    }

    /// Marks each `#n` in plain `text` (your own message, as written) the box knows (`refs`) to
    /// be drawn as its chip (`WorkItemChipMark`), a link to the item.
    static func mark(_ text: inout AttributedString, refs: [Int: WorkRef]) {
        guard !refs.isEmpty else { return }
        let plain = String(text.characters)
        for (range, number) in WorkItemRefs.find(in: plain) {
            guard let ref = refs[number] else { continue }
            let lower = text.characters.index(text.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: range.lowerBound))
            let span = lower..<text.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: range.upperBound))
            guard !text[span].runs.contains(where: { $0.link != nil }) else { continue }
            text[span][WorkItemChipMark.self] = WorkItemChipAttachment(ref, number: number)
            text[span].link = WorkItemRefs.link(number)
        }
    }
}
