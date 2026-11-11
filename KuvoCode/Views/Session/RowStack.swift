import AppKit
import ClientDesign
import SwiftUI
import Textual

/// Something you opened is in this row: `RowStackView.rowResized`.
struct RowHasOpenFold: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

extension EnvironmentValues {
    /// The conversation's row a view is in, by its id (`RowStackView.reveal`).
    @Entry var conversationRow: String?
}

extension View {
    /// Says so to the row it's in, along with whatever else in the row does.
    func foldOpen(_ isOpen: Bool) -> some View {
        transformPreference(RowHasOpenFold.self) { $0 = $0 || isOpen }
    }
}

/// A conversation's rows, laid out here rather than by a lazy stack: each row in view is a
/// SwiftUI view of its own, measured at the width it's shown at, and the rows out of view keep
/// the height they were last measured at (or a guess, never measured). The lazy stack guessed
/// the whole conversation's height again at each new width, and could swing from a screen to
/// tens of thousands of points in a frame; it made and dropped rows on the way and could leave
/// the view where it had none. Here what's in view is laid out first, and stays where it is.
struct RowStack<Item, Row: View>: NSViewRepresentable {
    let items: [Item]
    let id: (Item) -> String
    var spacing: CGFloat = 0
    /// Whether a row is drawn the same as it was (so it isn't measured again).
    let same: (Item, Item) -> Bool
    /// A row's height before it's been measured.
    let estimate: (Item) -> CGFloat
    /// Rows added come in, rising a little as they fade in (not a whole history arriving).
    var animatesNew = true
    /// A row's words as they're copied, for a selection that takes all of it (a row without text
    /// of its own to select in: your message, a line of steps; or one not made at the time).
    var text: (Item) -> String = { _ in "" }
    /// A row copied by `text` from a selection that takes all of it, though it's made: its texts
    /// don't hold all its words (a command you ran: only what it printed is text to select in).
    var whole: (Item) -> Bool = { _ in false }
    /// The space a row leaves above itself (inside its view): a selection's tint leaves it out.
    var space: (Item, Int) -> CGFloat = { _, _ in 0 }
    /// Told the row under the pointer, by its id, as the pointer moves or the rows move under it;
    /// nil off them.
    var pointer: ((String?) -> Void)?
    @ViewBuilder let row: (Item, Int) -> Row

    final class Coordinator {
        var items: [String: Item] = [:]
        /// Each row's space above it, which goes by the row before it.
        var spaces: [String: CGFloat] = [:]
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> RowStackView { RowStackView() }

    func updateNSView(_ view: RowStackView, context: Context) {
        // A conversation out of sight (kept for coming back to, or under Settings) is hidden for
        // AppKit too: its rows are views of their own, which would still follow the pointer and
        // set it (an I-beam over their text) under what's in sight, from buttons to the panel.
        let isShown = context.environment.isConversationShown
        if view.isHidden == isShown {
            // Text picked in a row lets go of the keyboard first: hidden, AppKit would hand it on
            // to the next view that takes it, wherever that is, as if you'd pressed Tab.
            if !isShown, let window = view.window, let responder = window.firstResponder as? NSView, responder.isDescendant(of: view) {
                window.makeFirstResponder(nil)
            }
            view.isHidden = !isShown
        }
        let old = context.coordinator.items
        let oldSpaces = context.coordinator.spaces
        var now: [String: Item] = [:]
        var spaces: [String: CGFloat] = [:]
        var ids: [String] = []
        var changed: Set<String> = []
        ids.reserveCapacity(items.count)
        now.reserveCapacity(items.count)
        spaces.reserveCapacity(items.count)
        for (index, item) in items.enumerated() {
            let key = id(item)
            ids.append(key)
            now[key] = item
            // Changed too when the row before it did, or came or went: its space above.
            let gap = space(item, index)
            spaces[key] = gap
            if let before = old[key], same(before, item), oldSpaces[key] == gap { continue }
            changed.insert(key)
        }
        context.coordinator.items = now
        context.coordinator.spaces = spaces
        let items = items, row = row, estimate = estimate, text = text, whole = whole, space = space
        let environment = context.environment
        view.rowText = { index in index < items.count ? text(items[index]) : "" }
        view.rowWhole = { index in index < items.count && whole(items[index]) }
        view.rowSpace = { index in index < items.count ? space(items[index], index) : 0 }
        view.pointerRow = pointer
        view.scrollAnchor = environment.scrollAnchor
        environment.scrollAnchor?.stack = view
        view.apply(ids: ids, changed: changed, spacing: spacing, animatesNew: animatesNew && !old.isEmpty, estimate: { estimate(items[$0]) }) { index in
            // Light and dark again by itself: a row drawn only when what it shows changes
            // (`.equatable()`, as the transcript's are) doesn't see it change in the whole.
            AnyView(row(items[index], index).environment(\.self, environment).environment(\.colorScheme, environment.colorScheme))
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: RowStackView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        return CGSize(width: width, height: nsView.height(for: width))
    }
}

final class RowStackView: NSView, NSUserInterfaceValidations {
    override var isFlipped: Bool { true }

    func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        switch item.action {
        case #selector(copy(_:)): orderedSelection != nil
        case #selector(selectAll(_:)): !ids.isEmpty
        default: true
        }
    }

    /// One row's view.
    private final class Host {
        let controller: NSHostingController<AnyView>
        var isShown = false
        /// Put away since its row changed: given its view again as it comes back.
        var isStale = false

        init(_ root: AnyView) {
            #if DEBUG
            ScrollFrameMonitor.rowsMade += 1
            #endif
            controller = NSHostingController(rootView: root)
            controller.sizingOptions = []
            // A row has no safe area of its own: kept, it was worked out again at every step of
            // a scroll, as the row moved under the window's title bar.
            controller.safeAreaRegions = []
            controller.view.translatesAutoresizingMaskIntoConstraints = true
        }

        var view: NSView { controller.view }

        func height(at width: CGFloat) -> CGFloat {
            ceil(controller.sizeThatFits(in: CGSize(width: width, height: 0)).height)
        }
    }

    private struct Height {
        var value: CGFloat
        /// The width it was measured at; 0 for a guess, -1 measured but changed since.
        var width: CGFloat
    }

    weak var scrollAnchor: ScrollAnchor?
    private var ids: [String] = []
    private var rowIndex: [String: Int] = [:]
    private var heights: [String: Height] = [:]
    private var tops: [CGFloat] = []
    private var total: CGFloat = 0
    private var spacing: CGFloat = 0
    private var hosts: [String: Host] = [:]
    /// Rows put away lately, latest last: kept, out of the window, for scrolling back to them.
    private var keptOrder: [String] = []
    /// Rows added that haven't come in yet.
    private var fresh: Set<String> = []
    private var make: ((Int) -> AnyView)?
    private var width: CGFloat = 0
    private var watch: NSObjectProtocol?
    private weak var watchedClip: NSClipView?
    private var isLayingOut = false
    /// The rows you opened something in.
    private var rowsWithOpenFolds: Set<String> = []
    /// The rows last laid out: scrolling past them lays out again.
    private var laidOut: Range<Int> = 0..<0
    /// Rows below one that changed height from within (a part opening) move to their new
    /// places, rather than jumping there.
    private var movesRows = false
    /// The row to keep in view where it was, through a change of width: how far the view's top
    /// was into it, as a fraction of its height.
    private var keptThroughWidth: (id: String, offset: CGFloat)?
    /// Half a screen's worth above and below what's in view is made too, so scrolling finds
    /// rows made.
    private static let overscan: CGFloat = 500
    private static let kept = 40

    private var isFollowingEnd: Bool { scrollAnchor?.isFollowingEnd ?? true }

    // MARK: Rows

    func apply(ids newIDs: [String], changed: Set<String>, spacing: CGFloat, animatesNew: Bool, estimate: (Int) -> CGFloat, make: @escaping (Int) -> AnyView) {
        self.make = make
        // What you're reading stays where it is (earlier messages coming in above, rows above
        // changing), unless the end is followed.
        var kept = isFollowingEnd ? nil : rowAtTop()
        if newIDs != ids {
            let before = Set(ids)
            // The row you're reading is another by id now (steps before it came in, and it starts
            // with them): it's still what's before the rows that were after it, as tall as you
            // knew it until it's measured, when what it gained goes above you.
            if let read = kept, !newIDs.contains(read.id), let index = ids.firstIndex(of: read.id) {
                let next = ids[(index + 1)...].lazy.compactMap { newIDs.firstIndex(of: $0) }.first ?? newIDs.count
                if next > 0, !before.contains(newIDs[next - 1]) {
                    kept = (newIDs[next - 1], read.offset)
                    heights[newIDs[next - 1]] = heights[read.id].map { Height(value: $0.value, width: 0) }
                }
            }
            ids = newIDs
            rowIndex = Dictionary(newIDs.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
            for (id, host) in hosts where rowIndex[id] == nil {
                host.view.removeFromSuperview()
                hosts[id] = nil
            }
            for id in heights.keys where rowIndex[id] == nil { heights[id] = nil }
            rowsWithOpenFolds.formIntersection(rowIndex.keys)
            keptOrder.removeAll { rowIndex[$0] == nil }
            fresh = fresh.filter { rowIndex[$0] != nil }
            // Only while the end is in view, where they come: rows that came while you read
            // further up would all come in at once when you went back to the end.
            if animatesNew, isFollowingEnd, let last = newIDs.last, !before.contains(last) {
                // Only rows added at the end come in; earlier messages put ahead are just there.
                for id in newIDs.reversed() {
                    guard !before.contains(id) else { break }
                    fresh.insert(id)
                }
            }
        }
        self.spacing = spacing
        for (index, id) in ids.enumerated() where heights[id] == nil {
            heights[id] = Height(value: estimate(index), width: 0)
        }
        // The rows made get their views again: what's changed in them, and what they're shown
        // with (the environment) may have. Changed rows out of view are measured when they come.
        for (id, host) in hosts {
            guard let index = rowIndex[id] else { continue }
            // Those put away, once they come back (a reply being written changes the view of
            // every row, many times a second).
            guard host.isShown else {
                host.isStale = true
                if changed.contains(id), heights[id]?.width ?? 0 > 0 { heights[id]?.width = -1 }
                continue
            }
            host.controller.rootView = root(id, make(index))
            if changed.contains(id), width > 0 {
                heights[id] = Height(value: host.height(at: width), width: width)
            }
        }
        for id in changed where hosts[id] == nil && heights[id]?.width ?? 0 > 0 {
            heights[id]?.width = -1
        }
        place()
        if let kept { restore(kept) }
        invalidateIntrinsicContentSize()
        needsLayout = true
    }

    /// Row `index`'s view, made or given its view again if it changed while put away.
    private func host(at index: Int) -> Host {
        let id = ids[index]
        if let host = hosts[id] {
            if host.isStale, let make {
                host.controller.rootView = root(id, make(index))
                host.isStale = false
            }
            return host
        }
        let host = Host(root(id, make?(index) ?? AnyView(EmptyView())))
        hosts[id] = host
        return host
    }

    /// The row's view, telling of its height as it changes from within (a part opening).
    private func root(_ id: String, _ content: AnyView) -> AnyView {
        // At its view's top, whatever height the view has: a part opening or folding changes the
        // view's height at once, and centered in it, the row slid down and back as it animated.
        AnyView(
            TopLayout {
                content
                    .environment(\.conversationRow, id)
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { ceil($0.size.height) } action: { [weak self] height in
                        self?.rowResized(id, to: height)
                    }
                    .onPreferenceChange(RowHasOpenFold.self) { [weak self] isOpen in
                        MainActor.assumeIsolated {
                            if isOpen { self?.rowsWithOpenFolds.insert(id) } else { self?.rowsWithOpenFolds.remove(id) }
                        }
                    }
            }
        )
    }

    private func rowResized(_ id: String, to height: CGFloat) {
        if isLayingOut {
            DispatchQueue.main.async { [weak self] in self?.rowResized(id, to: height) }
            return
        }
        guard let known = heights[id], abs(known.value - height) > 0.5, width > 0, hosts[id]?.isShown == true,
              let index = rowIndex[id] else { return }
        // A row whose top is above the view (coming in as you scroll up, a picture or widget
        // growing as it draws) grows up out of view, so what's below it stays. Except one you
        // opened something in, which you may be reading: it grows under that, moving nothing.
        let changedAt = rowsWithOpenFolds.contains(id) ? tops[index] + known.value : tops[index]
        keepInPlace(changedAt: changedAt, by: height - known.value) {
            heights[id] = Height(value: height, width: width)
            place()
        }
        movesRows = true
        invalidateIntrinsicContentSize()
        needsLayout = true
    }

    /// The rows' tops, and the whole height.
    private func place() {
        tops.removeAll(keepingCapacity: true)
        var y: CGFloat = 0
        for (index, id) in ids.enumerated() {
            if index > 0 { y += spacing }
            tops.append(y)
            y += heights[id]?.value ?? 0
        }
        total = y
    }

    private func frame(at index: Int) -> NSRect {
        NSRect(x: 0, y: tops[index], width: width, height: heights[ids[index]]?.value ?? 0)
    }

    // MARK: Size

    func height(for width: CGFloat) -> CGFloat {
        guard width != self.width else { return total }
        let first = self.width == 0
        keptThroughWidth = first || isFollowingEnd ? nil : rowAtTop(asFraction: true)
        self.width = width
        // What's in view is measured at the new width now; the rest as it comes into view.
        for (id, host) in hosts where host.isShown {
            heights[id] = Height(value: host.height(at: width), width: width)
        }
        place()
        needsLayout = true
        return total
    }

    // MARK: Layout

    override func layout() {
        super.layout()
        // Not told a width yet (SwiftUI asks for the height at one first), but given one.
        if width == 0, bounds.width > 0 { _ = height(for: bounds.width) }
        guard !isLayingOut, make != nil, width > 0 else { return }
        isLayingOut = true
        defer { isLayingOut = false }
        // Rows that came, went or changed height under a still pointer.
        defer { followPointer() }
        watchScrolling()
        if let anchor = keptThroughWidth {
            keptThroughWidth = nil
            restore(anchor, asFraction: true)
        }
        // Rows coming into view measured at this width: those above what's in view move it.
        var range = shownRange()
        var measuredAny = false
        for index in range {
            let id = ids[index]
            guard let height = heights[id], height.width != width else { continue }
            let measured = host(at: index).height(at: width)
            measuredAny = true
            keepInPlace(changedAt: tops[index], by: measured - height.value) {
                heights[id] = Height(value: measured, width: width)
                place()
            }
        }
        if measuredAny {
            invalidateIntrinsicContentSize()
            range = shownRange()
        }
        laidOut = range
        let moves = movesRows
        movesRows = false
        for index in range {
            let id = ids[index]
            let host = host(at: index)
            let view = host.view
            let frame = frame(at: index)
            let cameNow = !host.isShown
            if view.superview !== self { addSubview(view) }
            host.isShown = true
            if cameNow { keptOrder.removeAll { $0 == id } }
            if fresh.remove(id) != nil {
                comeIn(view, at: frame)
            } else if moves, !cameNow, view.frame.size.width == frame.width, view.frame.origin.y != frame.origin.y {
                move(view, to: frame)
            } else if view.frame != frame {
                view.frame = frame
            }
        }
        // Out of view: put away, the latest few kept for coming back to.
        for (id, host) in hosts where host.isShown {
            guard let index = rowIndex[id], !range.contains(index) else { continue }
            host.isShown = false
            // Out of the window, not just hidden: a row in it hears of each step of a scroll
            // (rows that light up under the pointer, or have glass, follow where they are),
            // and lays out and draws again for it.
            host.view.removeFromSuperview()
            keptOrder.append(id)
        }
        if selection != nil || !tints.isEmpty { showSelection() }
        // Made but not shown (measured on the way, then out of view once what's above moved it,
        // or to go to it): kept as those put away are, so they're let go in turn.
        for (id, host) in hosts where !host.isShown && !keptOrder.contains(id) { keptOrder.append(id) }
        while keptOrder.count > Self.kept {
            let id = keptOrder.removeFirst()
            hosts[id]?.view.removeFromSuperview()
            hosts[id] = nil
        }
    }

    /// A row added: rising a little as it fades in, as the lazy stack's rows did.
    private func comeIn(_ view: NSView, at frame: NSRect) {
        view.frame = frame.offsetBy(dx: 0, dy: 8)
        view.alphaValue = 0
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.3
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
            context.allowsImplicitAnimation = true
            view.animator().frame = frame
            view.animator().alphaValue = 1
        }
    }

    /// A row moved by one above it opening or folding a part: with the app's spring, which the
    /// part opens and folds with, so the row keeps to its edge rather than running over it.
    private func move(_ view: NSView, to frame: NSRect) {
        NSAnimationContext.animate(.ui) {
            view.animator().frame = frame
        }
    }

    /// What's in view of this, with room above and below.
    private func visibleArea() -> NSRect {
        guard let clip = enclosingScrollView?.contentView else { return bounds }
        return convert(clip.bounds, from: clip).insetBy(dx: 0, dy: -Self.overscan)
    }

    private func shownRange() -> Range<Int> {
        guard !ids.isEmpty else { return 0..<0 }
        let area = visibleArea()
        let first = max(0, tops.partitioningIndex { $0 > area.minY } - 1)
        let end = min(ids.count, tops.partitioningIndex { $0 >= area.maxY })
        return first..<max(first, end)
    }

    // MARK: Keeping what you read in place

    /// The row at the top of the view, and how far the view's top is into it (in points, or as
    /// a fraction of its height).
    private func rowAtTop(asFraction: Bool = false) -> (id: String, offset: CGFloat)? {
        guard let clip = enclosingScrollView?.contentView, !ids.isEmpty, width > 0 else { return nil }
        let top = convert(clip.bounds, from: clip).minY
        guard top >= 0 else { return nil }
        let index = min(ids.count - 1, max(0, tops.partitioningIndex { $0 > top } - 1))
        let offset = top - tops[index]
        return (ids[index], asFraction ? offset / max(1, heights[ids[index]]?.value ?? 1) : offset)
    }

    private func restore(_ anchor: (id: String, offset: CGFloat), asFraction: Bool = false) {
        guard let index = rowIndex[anchor.id], let clip = enclosingScrollView?.contentView else { return }
        let into = asFraction ? anchor.offset * (heights[anchor.id]?.value ?? 0) : anchor.offset
        let now = convert(clip.bounds, from: clip).minY
        scroll(by: tops[index] + into - now)
    }

    /// A row at `y` changed height by `delta` (`change`): if it's above what's in view, the view
    /// moves with what's under it. Not while the end is followed: that keeps to the end.
    private func keepInPlace(changedAt y: CGFloat, by delta: CGFloat, _ change: () -> Void) {
        guard abs(delta) > 0.5, !isFollowingEnd, let clip = enclosingScrollView?.contentView else { change(); return }
        let top = convert(clip.bounds, from: clip).minY
        change()
        if y < top - 0.5 { scroll(by: delta) }
    }

    /// The view this far down; what the conversation doesn't reach yet (it grows in this same
    /// pass, and SwiftUI sizes it after), once it does.
    private func scroll(by delta: CGFloat) {
        guard abs(delta) > 0.5, let scrollView = enclosingScrollView else { return }
        let clip = scrollView.contentView
        let origin = clip.bounds.origin
        let target = max(0, origin.y + delta)
        clip.scroll(to: NSPoint(x: origin.x, y: target))
        scrollView.reflectScrolledClipView(clip)
        let short = target - clip.bounds.origin.y
        DispatchQueue.main.async { [weak scrollView] in
            guard let scrollView else { return }
            let clip = scrollView.contentView
            if abs(short) > 0.5 {
                clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: clip.bounds.origin.y + short))
                scrollView.reflectScrolledClipView(clip)
            }
            // SwiftUI's scroll view, told once its update is over: else it puts the view back
            // where it last knew it to be, the next time the conversation's size changes.
            NotificationCenter.default.post(name: NSView.boundsDidChangeNotification, object: clip)
        }
    }

    /// Row `id`, opened by you where it was, brought as far into what's in sight as it needs: its
    /// end over the composer, its top no higher than the top of what's in sight. Nothing moves when
    /// it's all in sight already.
    func reveal(_ id: String) {
        guard let index = rowIndex[id], let clip = enclosingScrollView?.contentView, width > 0 else { return }
        let row = frame(at: index), sight = inSight
        let down = min(row.maxY - sight.maxY, row.minY - sight.minY)
        guard down > 0.5 else { return }
        scrollAnchor?.scroll(to: clip.bounds.origin.y + down, animated: true)
    }

    /// The rows are taller than the conversation has been told yet: where the view is may be past
    /// its end only until it has.
    var isAboutToGrow: Bool { total > frame.height + 0.5 }

    // MARK: Going to a row

    /// Where row `id` is, in the scroll view's document, measured at this width.
    func frameInDocument(of id: String) -> NSRect? {
        guard let index = rowIndex[id], let document = enclosingScrollView?.documentView, width > 0 else { return nil }
        if heights[id]?.width != width {
            let host = host(at: index)
            if !host.isShown, !keptOrder.contains(id) { keptOrder.append(id) }
            heights[id] = Height(value: host.height(at: width), width: width)
            place()
            invalidateIntrinsicContentSize()
        }
        return convert(frame(at: index), to: document)
    }

    // MARK: Scrolling

    /// Watches the scroll view it's in now: one it was in before (SwiftUI can make the scroll
    /// view again around it) would leave it unaware of scrolling, its rows unmade where you look.
    private func watchScrolling() {
        let clip = enclosingScrollView?.contentView
        guard clip !== watchedClip else { return }
        if let watch { NotificationCenter.default.removeObserver(watch) }
        watch = nil
        watchedClip = clip
        guard let clip else { return }
        clip.postsBoundsChangedNotifications = true
        watch = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: nil) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.layOutIfRowsMissing()
                self?.followPointer()
            }
        }
    }

    /// Lays out again when what's in view has rows not shown: scrolled to other rows, or come
    /// into view without having been laid out where it is now.
    private func layOutIfRowsMissing() {
        let range = shownRange()
        if range != laidOut || range.contains(where: { hosts[ids[$0]]?.isShown != true }) { needsLayout = true }
    }

    // MARK: The pointer

    /// Told the row under the pointer (see `RowStack.pointer`).
    var pointerRow: ((String?) -> Void)?
    private var pointerArea: NSTrackingArea?
    private var rowUnderPointer: String?

    // Tracked here, not by each row: a row's own tracking is told nothing as it's put away or
    // scrolled from under a still pointer, and the gaps between rows, and what's see-through in
    // them, would each count as leaving.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        guard pointerArea == nil else { return }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area)
        pointerArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        followPointer(at: event.locationInWindow)
    }

    override func mouseMoved(with event: NSEvent) {
        followPointer(at: event.locationInWindow)
    }

    override func mouseExited(with event: NSEvent) {
        tellPointer(nil)
    }

    /// The pointer held still while the rows moved under it: scrolled, or laid out again.
    private func followPointer() {
        guard pointerRow != nil, let window else { return }
        followPointer(at: window.mouseLocationOutsideOfEventStream)
    }

    /// The row under the pointer: from one row's top to the next one's, so the space between two
    /// rows is the upper one's; none where something else is on top (the composer, a menu).
    private func followPointer(at location: NSPoint) {
        guard pointerRow != nil else { return }
        let point = convert(location, from: nil)
        guard !isHidden, !ids.isEmpty, visibleRect.contains(point), point.y < total, PointerClaim.isTopmost(self, at: location) else { return tellPointer(nil) }
        let index = min(ids.count - 1, max(0, tops.partitioningIndex { $0 > point.y } - 1))
        tellPointer(ids[index])
    }

    private func tellPointer(_ id: String?) {
        guard id != rowUnderPointer else { return }
        rowUnderPointer = id
        pointerRow?(id)
    }

    // Each way of coming into view lays out again: in a window, shown, resized. Any could come
    // with no other change that would, and leave the rows unmade until you scrolled.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        for observer in keyWatch { NotificationCenter.default.removeObserver(observer) }
        keyWatch = []
        if window == nil {
            if let watch { NotificationCenter.default.removeObserver(watch) }
            watch = nil
            watchedClip = nil
        } else {
            needsLayout = true
            // In front or behind: the selection shows as in use, or set aside.
            for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification] {
                keyWatch.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.updateEmphasis() }
                })
            }
            #if DEBUG
            showDemoSelection()
            #endif
        }
        updateEmphasis()
    }

    #if DEBUG
    /// Once, in the conversation in view: KUVO_DEMO_SELECTION_MENU's.
    private static var demoSelectionShown = false

    /// KUVO_DEMO_SELECTION_MENU=<x>,<y>: the paragraph at that point of the window (from its top
    /// left) selected, as a triple click selects it, with the menu over it (Add to Chat, Copy),
    /// once the conversation there has its rows.
    private func showDemoSelection() {
        guard !Self.demoSelectionShown, let spec = ProcessInfo.processInfo.environment["KUVO_DEMO_SELECTION_MENU"] else { return }
        let xy = spec.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard xy.count == 2 else { return }
        Task { @MainActor [weak self] in
            for _ in 0..<20 {
                await DemoWait.pause(.beat)
                guard let self, !Self.demoSelectionShown else { return }
                guard let window, let content = window.contentView, !isHiddenOrHasHiddenAncestor else { continue }
                let point = convert(NSPoint(x: xy[0], y: content.bounds.height - xy[1]), from: nil)
                guard visibleRect.contains(point), let pressed = spot(at: point), pressed.unit != .max,
                      let paragraph = unit(around: pressed, by: .selectByParagraph) else { continue }
                Self.demoSelectionShown = true
                select(paragraph.start, paragraph.end)
                showMenu()
                return
            }
        }
    }
    #endif

    private var keyWatch: [NSObjectProtocol] = []

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        needsLayout = true
    }

    override func viewDidUnhide() {
        super.viewDidUnhide()
        needsLayout = true
    }

    override func setFrameSize(_ newSize: NSSize) {
        let changed = newSize != frame.size
        super.setFrameSize(newSize)
        if changed { needsLayout = true }
    }

    /// Whether rows are shown across what's in view (or there's room under a short
    /// conversation): what the conversation checks after its width changes, and the tests.
    func showsRowsInView() -> Bool {
        guard let clip = enclosingScrollView?.contentView, !ids.isEmpty, width > 0 else { return true }
        let view = convert(clip.bounds, from: clip).intersection(NSRect(x: 0, y: 0, width: width, height: total))
        guard view.height > 40 else { return true }
        let covered = hosts.values.filter { $0.isShown && $0.view.superview === self }.reduce(CGFloat(0)) {
            $0 + max(0, min($1.view.frame.maxY, view.maxY) - max($1.view.frame.minY, view.minY))
        }
        if covered <= view.height * 0.4 { layOutIfRowsMissing() }
        return covered > view.height * 0.4
    }

    // MARK: Selecting across rows

    /// A place in the conversation's text: a row, the text in it (its replies' text views, top
    /// to bottom), and a character in that. A row without text of its own to select in counts
    /// whole: before it (0) or after it (`Int.max`).
    struct Spot: Comparable {
        var row: Int
        var unit: Int
        var offset: Int

        static func < (a: Spot, b: Spot) -> Bool {
            (a.row, a.unit, a.offset) < (b.row, b.unit, b.offset)
        }
    }

    /// A spot kept by its row's id, not where the row is: rows come in above (earlier messages)
    /// and go (an undo) while a selection's kept.
    struct Mark: Equatable {
        var id: String
        var unit: Int
        var offset: Int
    }

    /// One selection across the conversation, as in a page: from where a drag began to where it
    /// is, through replies, your messages, steps and code between, whichever text holds it.
    private(set) var selection: (anchor: Mark, focus: Mark)?

    private func mark(_ spot: Spot) -> Mark { Mark(id: ids[spot.row], unit: spot.unit, offset: spot.offset) }

    /// Where a mark's row is now; nil once it's gone.
    private func spot(_ mark: Mark) -> Spot? {
        rowIndex[mark.id].map { Spot(row: $0, unit: mark.unit, offset: mark.offset) }
    }

    private func select(_ anchor: Spot, _ focus: Spot) {
        selection = (mark(anchor), mark(focus))
        // The keyboard comes here with it (⌘C, ⌘A), and with that it shows as the selection in use.
        if let window, window.firstResponder !== self { window.makeFirstResponder(self) }
        showSelection()
    }
    var rowText: (Int) -> String = { _ in "" }
    var rowWhole: (Int) -> Bool = { _ in false }
    var rowSpace: (Int) -> CGFloat = { _ in 0 }
    /// The rows selected whole, each tinted behind.
    private var tints: [String: SelectionTint] = [:]

    private var orderedSelection: (start: Spot, end: Spot)? {
        guard let selection, let anchor = spot(selection.anchor), let focus = spot(selection.focus), anchor != focus else { return nil }
        return anchor < focus ? (anchor, focus) : (focus, anchor)
    }

    /// The text you select in, in a row's view: its prose and its code, in reading order.
    private func units(in view: NSView) -> [NSTextView] {
        var found: [NSTextView] = []
        func walk(_ view: NSView) {
            for sub in view.subviews where !sub.isHidden {
                if sub is ReplyTextView || sub is ReplyCodeTextView || sub is SelectableTextView, let text = sub as? NSTextView { found.append(text) } else { walk(sub) }
            }
        }
        walk(view)
        return found.sorted {
            let a = $0.convert($0.bounds, to: view), b = $1.convert($1.bounds, to: view)
            return a.minY != b.minY ? a.minY < b.minY : a.minX < b.minX
        }
    }

    /// Where `point` (in this view) is in the conversation's text.
    private func spot(at point: NSPoint) -> Spot? {
        guard !ids.isEmpty, width > 0 else { return nil }
        let y = min(max(point.y, 0), max(0, total - 1))
        let index = min(ids.count - 1, max(0, tops.partitioningIndex { $0 > y } - 1))
        let frame = frame(at: index)
        // Before a row or after all of it, whatever text it has.
        let whole = point.y < frame.midY ? Spot(row: index, unit: 0, offset: 0) : Spot(row: index, unit: .max, offset: .max)
        guard let host = hosts[ids[index]], host.isShown else { return whole }
        let texts = units(in: host.view)
        guard !texts.isEmpty else { return whole }
        for (unit, text) in texts.enumerated() {
            let box = text.convert(text.bounds, to: self)
            if point.y < box.minY { return Spot(row: index, unit: unit, offset: 0) }
            if point.y <= box.maxY {
                return Spot(row: index, unit: unit, offset: text.characterIndexForInsertion(at: text.convert(point, from: self)))
            }
        }
        return Spot(row: index, unit: texts.count - 1, offset: texts[texts.count - 1].textStorage?.length ?? 0)
    }

    /// The part of `unit` in row `row` the selection takes, if any.
    private func range(row: Int, unit: Int, length: Int, in selected: (start: Spot, end: Spot)) -> NSRange? {
        let here = (row, unit), start = (selected.start.row, selected.start.unit), end = (selected.end.row, selected.end.unit)
        guard !(here < start), !(end < here) else { return nil }
        let low = here == start ? min(selected.start.offset, length) : 0
        let high = here == end ? min(selected.end.offset, length) : length
        return high > low ? NSRange(location: low, length: high - low) : nil
    }

    /// Whether the selection takes all of a row: one between its ends, or one it ends in from its
    /// start or past its end (as Select All does).
    private func takesAll(_ row: Int, in selected: (start: Spot, end: Spot)) -> Bool {
        (row != selected.start.row || (selected.start.unit == 0 && selected.start.offset == 0)) && (row != selected.end.row || selected.end.unit == .max)
    }

    /// Whether a row without text of its own is in the selection.
    private func takesWhole(_ row: Int, in selected: (start: Spot, end: Spot)) -> Bool {
        guard row >= selected.start.row, row <= selected.end.row else { return false }
        if row == selected.start.row, selected.start.unit == .max { return false }
        if row == selected.end.row, selected.end.offset == 0, selected.end.unit == 0 { return false }
        return true
    }

    /// Whether the selection shows as the one in use (its window in front, the conversation with
    /// the keyboard) or set aside, in every text it takes part of and every row it tints alike.
    private(set) var isSelectionEmphasized = false

    private func updateEmphasis() {
        let emphasized = window?.isKeyWindow == true && window?.firstResponder === self
        guard emphasized != isSelectionEmphasized else { return }
        isSelectionEmphasized = emphasized
        for host in hosts.values {
            for text in units(in: host.view) where text.selectedRange().length > 0 { text.needsDisplay = true }
        }
        for tint in tints.values { tint.isEmphasized = emphasized }
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { updateEmphasis() }
        return became
    }

    /// The selection drawn: ranges in the texts it takes part of, a tint behind rows it takes whole.
    private func showSelection() {
        let selected = orderedSelection
        var tinted: Set<String> = []
        for (id, host) in hosts {
            guard let index = rowIndex[id] else { continue }
            let texts = units(in: host.view)
            for (unit, text) in texts.enumerated() {
                let length = text.textStorage?.length ?? 0
                let range = selected.flatMap { range(row: index, unit: unit, length: length, in: $0) } ?? NSRange(location: 0, length: 0)
                if text.selectedRange() != range { text.setSelectedRange(range) }
            }
            if texts.isEmpty, host.isShown, let selected, takesWhole(index, in: selected) { tinted.insert(id) }
        }
        for (id, tint) in tints where !tinted.contains(id) {
            tint.removeFromSuperview()
            tints[id] = nil
        }
        for id in tinted {
            guard let host = hosts[id], let index = rowIndex[id] else { continue }
            let tint = tints[id] ?? SelectionTint()
            tint.isEmphasized = isSelectionEmphasized
            tints[id] = tint
            if tint.superview !== self { addSubview(tint, positioned: .below, relativeTo: host.view) }
            // Its words, not the space above them.
            var box = frame(at: index)
            let space = min(rowSpace(index), box.height)
            box = NSRect(x: box.minX, y: box.minY + space, width: box.width, height: box.height - space)
            tint.frame = box.insetBy(dx: -4, dy: -2)
        }
        if actionsBar != nil { placeMenu() }
    }

    /// Follows a press from `event` (in a reply's text, or between rows) to where it's let go,
    /// selecting as it goes: a drag from where it began, the conversation scrolling when it
    /// reaches the top or bottom; a double click a word, a triple click a paragraph, a drag after
    /// either going on from it; a shift-click from where the selection began. A press that selects
    /// nothing clears the selection; `click` is told of it. Let go on a selection, its menu shows.
    func trackSelection(from event: NSEvent, click: () -> Void) {
        hideMenu()
        guard let window, let clip = enclosingScrollView?.contentView else { return click() }
        let start = convert(event.locationInWindow, from: nil)
        let kept = selection.flatMap { spot($0.anchor) }
        let extending = event.modifierFlags.contains(.shift) && kept != nil
        guard let pressed = spot(at: start) else { return click() }
        // What a double or triple click takes (a word, a paragraph): the drag after it goes on
        // from it, whichever way.
        let whole = event.clickCount >= 2 ? unit(around: pressed, by: event.clickCount == 2 ? .selectByWord : .selectByParagraph) : nil
        let anchor = extending ? kept! : (whole?.start ?? pressed)
        var dragged = extending || whole != nil
        if extending {
            select(anchor, pressed)
        } else if let whole {
            select(whole.start, whole.end)
        }
        func focus(_ spot: Spot) {
            guard let whole else { return select(anchor, spot) }
            if spot < whole.start { select(whole.end, spot) } else { select(whole.start, max(spot, whole.end)) }
        }
        NSEvent.startPeriodicEvents(afterDelay: 0.05, withPeriod: 0.03)
        defer { NSEvent.stopPeriodicEvents() }
        // Where the pointer last was, in the window: held still past an edge, the conversation
        // goes on scrolling under it.
        var pointer = event.locationInWindow
        tracking: while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp, .periodic]) {
            switch next.type {
            case .leftMouseUp:
                break tracking
            case .leftMouseDragged, .periodic:
                if next.type == .leftMouseDragged { pointer = next.locationInWindow }
                let point = convert(pointer, from: nil)
                if !dragged, hypot(point.x - start.x, point.y - start.y) < 3 { continue }
                dragged = true
                // Past the top or bottom of what's in sight (not under the header or the
                // composer): the conversation scrolls, faster the further.
                let view = inSight
                let past = point.y < view.minY ? point.y - view.minY : point.y > view.maxY ? point.y - view.maxY : 0
                if past != 0, next.type == .periodic {
                    let step = max(-60, min(60, past / 2))
                    if step < 0 { scrollAnchor?.stopFollowing() }
                    // As far as it goes either way: to the first row, out from under the header.
                    var bounds = clip.bounds
                    bounds.origin.y += step
                    let target = clip.constrainBoundsRect(bounds).origin
                    if abs(target.y - clip.bounds.origin.y) > 0.5, let scrollView = enclosingScrollView {
                        clip.scroll(to: target)
                        scrollView.reflectScrolledClipView(clip)
                        DispatchQueue.main.async { [weak clip] in
                            guard let clip else { return }
                            NotificationCenter.default.post(name: NSView.boundsDidChangeNotification, object: clip)
                        }
                    }
                    layoutSubtreeIfNeeded()
                }
                let clamped = NSPoint(x: point.x, y: min(max(point.y, view.minY), view.maxY))
                // Past an end that's in view: to the very start or end.
                let top = convert(NSPoint.zero, to: enclosingScrollView?.documentView).y >= clip.bounds.minY + (enclosingScrollView?.contentInsets.top ?? 0) - 1
                let bottom = convert(NSPoint(x: 0, y: total), to: enclosingScrollView?.documentView).y <= clip.bounds.maxY - (enclosingScrollView?.contentInsets.bottom ?? 0) + 1
                if past < 0, top {
                    focus(Spot(row: 0, unit: 0, offset: 0))
                } else if past > 0, bottom, let last = ids.indices.last {
                    focus(Spot(row: last, unit: .max, offset: .max))
                } else if let spot = spot(at: clamped) {
                    focus(spot)
                }
            default:
                break
            }
        }
        guard dragged, orderedSelection != nil else {
            clearSelection()
            return click()
        }
        showMenu()
    }

    /// The word or paragraph around `spot`, in the text it's in; a row without text of its own
    /// is taken whole.
    private func unit(around spot: Spot, by granularity: NSSelectionGranularity) -> (start: Spot, end: Spot)? {
        guard spot.row < ids.count else { return nil }
        let texts = hosts[ids[spot.row]].map { units(in: $0.view) } ?? []
        guard spot.unit < texts.count, let length = texts[spot.unit].textStorage?.length, length > 0 else {
            return (Spot(row: spot.row, unit: 0, offset: 0), Spot(row: spot.row, unit: .max, offset: .max))
        }
        let range = texts[spot.unit].selectionRange(forProposedRange: NSRange(location: min(spot.offset, length - 1), length: 0), granularity: granularity)
        return (Spot(row: spot.row, unit: spot.unit, offset: range.location), Spot(row: spot.row, unit: spot.unit, offset: NSMaxRange(range)))
    }

    // MARK: The menu over a selection

    /// Over what's selected once a press lets go of it: Add to Chat (it goes over the composer as
    /// a quote to answer, where the conversation takes quotes) and Copy. It goes with the
    /// selection, at the next press, or a key.
    private var actionsBar: NSView?

    private func showMenu() {
        let actions = SelectionActions(addToChat: scrollAnchor?.quote.map { quote in { [weak self] in
            guard let self else { return }
            let text = self.selectedText().trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { quote(text) }
            self.hideMenu()
        } }, copy: { [weak self] in
            self?.copy(nil)
            self?.hideMenu()
        })
        let view = ActionsBar(rootView: actions)
        actionsBar?.removeFromSuperview()
        actionsBar = view
        addSubview(view)
        placeMenu()
    }

    /// What's in sight of the conversation: not under the header or the composer.
    private var inSight: NSRect {
        guard let scroll = enclosingScrollView else { return bounds }
        let view = convert(scroll.contentView.bounds, from: scroll.contentView)
        let insets = scroll.contentInsets
        return NSRect(x: view.minX, y: view.minY + insets.top, width: view.width, height: max(1, view.height - insets.top - insets.bottom))
    }

    private func hideMenu() {
        actionsBar?.removeFromSuperview()
        actionsBar = nil
    }

    /// Over the selection's first line, centered on it; under its last, centered on that, when
    /// there's no room above in what's in sight. Clear of the lines' text, leading and all, unless
    /// what's selected runs past both edges of what's in sight: then at its top, in sight. In
    /// front of the rows.
    private func placeMenu() {
        guard let bar = actionsBar, let selected = orderedSelection, let first = edgeLine(of: selected, last: false) else { return hideMenu() }
        let size = bar.fittingSize
        let visible = inSight
        let last = edgeLine(of: selected, last: true) ?? first
        let above = first.minY - size.height - 8
        let (line, y): (NSRect, CGFloat) = if above >= visible.minY {
            (first, above)
        } else if last.maxY + 8 + size.height <= visible.maxY {
            (last, last.maxY + 8)
        } else {
            (first, visible.minY + 8)
        }
        let x = min(max(line.midX - size.width / 2, bounds.minX + 4), bounds.maxX - size.width - 4)
        bar.frame = NSRect(x: x, y: y, width: size.width, height: size.height)
        if subviews.last !== bar { addSubview(bar, positioned: .above, relativeTo: nil) }
    }

    /// Where the selection's first line is (or its `last`), as tall as the line: the part of it in
    /// its first text, else the first row it takes whole.
    private func edgeLine(of selected: (start: Spot, end: Spot), last: Bool) -> NSRect? {
        let rows = Array(selected.start.row...min(selected.end.row, ids.count - 1))
        for row in last ? rows.reversed() : rows {
            guard let host = hosts[ids[row]], host.isShown else { continue }
            let texts = Array(units(in: host.view).enumerated())
            for (unit, text) in last ? texts.reversed() : texts {
                guard let storage = text.textStorage, let range = range(row: row, unit: unit, length: storage.length, in: selected),
                      let layout = text.layoutManager, let container = text.textContainer else { continue }
                let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
                guard glyphs.length > 0 else { continue }
                var line = NSRange()
                let fragment = layout.lineFragmentRect(forGlyphAt: last ? NSMaxRange(glyphs) - 1 : glyphs.location, effectiveRange: &line)
                var rect = layout.boundingRect(forGlyphRange: NSIntersectionRange(glyphs, line), in: container)
                // The line's whole height, not only its ink: a menu 8 pt off the ink still
                // touched the line.
                rect.origin.y = fragment.minY
                rect.size.height = fragment.height
                rect.origin.x += text.textContainerOrigin.x
                rect.origin.y += text.textContainerOrigin.y
                return convert(rect, from: text)
            }
            if let tint = tints[ids[row]] { return tint.frame }
        }
        return nil
    }

    /// Row `index`'s view, made and laid out where it is if it's not there.
    private func madeHost(_ index: Int) -> Host? {
        let id = ids[index]
        if let host = hosts[id] { return host }
        guard make != nil, width > 0 else { return nil }
        let host = host(at: index)
        host.view.frame = frame(at: index)
        host.view.layoutSubtreeIfNeeded()
        if !keptOrder.contains(id) { keptOrder.append(id) }
        return host
    }

    func clearSelection() {
        hideMenu()
        guard selection != nil || !tints.isEmpty else { return }
        selection = nil
        showSelection()
    }

    /// The selection's words, in order: what's selected in each text, and rows taken whole as
    /// they're copied.
    func selectedText() -> String {
        guard let selected = orderedSelection else { return "" }
        var parts: [String] = []
        for index in selected.start.row...selected.end.row where index < ids.count {
            // The rows it ends in, taken in part: made again if they were let go, for the part. Those
            // between by their texts, or whole as they're copied: one with none (your message, or
            // one not made), and one taken all of whose texts don't hold all its words (a command
            // you ran with its command, though only what it printed is text to select in).
            let isEnd = index == selected.start.row || index == selected.end.row
            let texts = (isEnd ? madeHost(index) : hosts[ids[index]]).map { units(in: $0.view) } ?? []
            if texts.isEmpty || (rowWhole(index) && takesAll(index, in: selected)) {
                let whole = takesWhole(index, in: selected) ? rowText(index).trimmingCharacters(in: .whitespacesAndNewlines) : ""
                if !whole.isEmpty { parts.append(whole) }
                continue
            }
            var row: [String] = []
            for (unit, text) in texts.enumerated() {
                guard let storage = text.textStorage, let range = range(row: index, unit: unit, length: storage.length, in: selected) else { continue }
                row.append(text is ReplyTextView ? ReplyTextView.plain(storage, in: range) : (storage.string as NSString).substring(with: range))
            }
            if !row.isEmpty { parts.append(row.joined(separator: "\n\n")) }
        }
        return parts.joined(separator: "\n\n")
    }

    // The selection takes the keyboard once made: ⌘C and Add to Chat copy it, ⌘A selects all.
    override var acceptsFirstResponder: Bool { selection != nil }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned {
            clearSelection()
            updateEmphasis()
        }
        return resigned
    }

    override func keyDown(with event: NSEvent) {
        hideMenu()
        super.keyDown(with: event)
    }

    @objc func copy(_ sender: Any?) {
        let text = selectedText()
        guard !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    override func selectAll(_ sender: Any?) {
        guard let last = ids.indices.last else { return }
        select(Spot(row: 0, unit: 0, offset: 0), Spot(row: last, unit: .max, offset: .max))
    }

    override func mouseDown(with event: NSEvent) {
        // Between rows: a selection starts here too.
        trackSelection(from: event) {}
    }

    #if DEBUG
    /// The rows in view, where they are in the window (from its top, as SwiftUI's global space
    /// has it) and in the scroll view's document, for the tests.
    func shownFrames() -> (window: [String: CGRect], document: [String: CGRect]) {
        var window: [String: CGRect] = [:], document: [String: CGRect] = [:]
        guard let root = self.window?.contentView, let doc = enclosingScrollView?.documentView else { return ([:], [:]) }
        for (id, host) in hosts where host.isShown {
            guard let index = rowIndex[id] else { continue }
            let rect = frame(at: index)
            let inWindow = convert(rect, to: nil)
            window[id] = CGRect(x: inWindow.minX, y: root.bounds.height - inWindow.maxY, width: rect.width, height: rect.height)
            document[id] = convert(rect, to: doc)
        }
        return (window, document)
    }
    #endif
}

extension Array {
    /// The first index whose element `belongs`, in an array where those come after all the
    /// others.
    func partitioningIndex(where belongs: (Element) -> Bool) -> Int {
        var low = 0, high = count
        while low < high {
            let mid = (low + high) / 2
            if belongs(self[mid]) { high = mid } else { low = mid + 1 }
        }
        return low
    }
}


/// The menu over a selection: its buttons work without taking the keyboard, which would take the
/// selection with it before they read it.
private final class ActionsBar: NSHostingView<SelectionActions> {
    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// What tints a row a selection takes whole, behind it, in the selection's look as its texts
/// show it.
private final class SelectionTint: NSView {
    var isEmphasized = false {
        didSet { if isEmphasized != oldValue { needsDisplay = true } }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 6
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = (isEmphasized ? NSColor.selectedTextBackgroundColor : NSColor.unemphasizedSelectedTextBackgroundColor).cgColor
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Its one child at its top left, at the child's own height; as big as it's offered itself, even
/// when the child is taller (measured, a row is offered no height at all: then the child's
/// height). A part opening makes the child taller before its row's view is: grown past what the
/// view offered, the hosting view would center it in itself, and SwiftUI animate everything in it
/// from there, as if it had moved by half what it grew. Each thing in the row then came in from
/// below its place (and went the other way), while the words that came in were already in theirs.
private struct TopLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let child = subviews.first?.sizeThatFits(.init(width: proposal.width, height: nil)) ?? .zero
        let offered = proposal.height ?? 0
        return CGSize(width: proposal.width ?? child.width, height: offered > 0 && offered.isFinite ? offered : child.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading, proposal: .init(width: bounds.width, height: nil))
    }
}
