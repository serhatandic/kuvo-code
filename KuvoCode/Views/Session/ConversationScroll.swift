import AppKit
import ClientDesign
import SwiftUI

/// How a conversation scrolls, for the view showing it: whether it keeps to the end, and asking
/// it to go somewhere (back to the end, to a row Find found).
@Observable
final class ConversationScroller {
    enum Request: Equatable {
        case end(animated: Bool)
        case row(String)
        /// A place in a row, this far down it, in the middle (a place Find found).
        case place(String, CGFloat)
        /// A distance from the top, for the scrolling test.
        case offset(CGFloat)
    }

    /// Whether to keep the newest in view: true until you scroll up, true again once you scroll
    /// back to the end. Set only when it changes (`follow`): each setting draws the conversation again.
    private(set) var followsEnd = true
    /// The end is in view, over the composer: no way back to it is needed, whether it's
    /// followed or not (Find stops following it). Set only when it changes, as `followsEnd`.
    fileprivate(set) var seesEnd = true
    /// The end in view, as last seen.
    @ObservationIgnored private var atEnd = true
    /// All of it fits in view: nothing to scroll. (Not until it's known.)
    @ObservationIgnored fileprivate(set) var fits = false
    @ObservationIgnored fileprivate(set) var request: Request?
    /// Goes up with each request, for the scroll view to take it.
    fileprivate(set) var requests = 0

    /// To the end, following it again (you sent something).
    func toEnd(animated: Bool = false) {
        follow(true)
        ask(.end(animated: animated))
    }

    /// `id`'s row in the middle, and no following the end meanwhile.
    func reveal(_ id: String) {
        follow(false)
        ask(.row(id))
    }

    /// The place `fraction` of the way down `id`'s row in the middle, and no following the end
    /// meanwhile.
    func reveal(_ id: String, at fraction: CGFloat) {
        follow(false)
        ask(.place(id, min(max(fraction, 0), 1)))
    }

    func scroll(to offset: CGFloat) {
        follow(false)
        ask(.offset(offset))
    }

    fileprivate func follow(_ follows: Bool) {
        heldFor = []
        if followsEnd != follows {
            followsEnd = follows
            followChanged?(follows)
            sees(atEnd: atEnd)
        }
    }

    /// Told as soon as following the end starts or stops: the rows keep what you read in place
    /// by it. (Told only as the view moved, they went on following once a scroll up had stopped,
    /// as where it stopped decides: what changed above what you read then moved it.)
    @ObservationIgnored fileprivate var followChanged: ((Bool) -> Void)?

    /// The steps you opened while following the end, which you left it to read. Going anywhere
    /// yourself since (each way goes through `follow`) means you left it for good.
    @ObservationIgnored private var heldFor: Set<String> = []

    /// You're scrolling, and this is where it's taken you (`wentUp`: up from where your scroll
    /// started). While you read what you opened, where it stops decides.
    fileprivate func scrolled(atEnd: Bool, wentUp: Bool) {
        if heldFor.isEmpty { follow(atEnd: atEnd, wentUp: wentUp) }
    }

    /// At the end, it follows; off it, only once you went up: what came in under your scroll at
    /// the end (a bounce there, a scroll down) took the end further, not you away from it.
    private func follow(atEnd: Bool, wentUp: Bool) {
        if atEnd { follow(true) } else if wentUp { follow(false) }
    }

    /// Your scroll stopped, where it says now: the change that took it there may never have been
    /// told, as SwiftUI passes on only one a frame. While you read what you opened, a nudge is
    /// still reading; moved further, you went somewhere else.
    fileprivate func stopped(atEnd: Bool, wentUp: Bool, moved: CGFloat) {
        if heldFor.isEmpty {
            follow(atEnd: atEnd, wentUp: wentUp)
        } else if moved >= 40 {
            follow(atEnd)
        }
        sees(atEnd: atEnd)
    }

    /// Whether the end is in view; while it's followed, it is, or will be in a moment (what
    /// comes in lands under the composer for a frame first): told so, rather than back and forth
    /// as a reply comes in, which drew the conversation again each time.
    fileprivate func sees(atEnd: Bool) {
        self.atEnd = atEnd
        let sees = atEnd || followsEnd
        if seesEnd != sees { seesEnd = sees }
    }

    /// `id`, a step you opened as it was under way, has ended, open: what comes in next doesn't
    /// move it. All of it in view first: following would have got there in a moment.
    fileprivate func reading(_ id: String) {
        guard followsEnd || !heldFor.isEmpty else { return }
        if followsEnd {
            follow(false)
            ask(.end(animated: true))
        }
        heldFor.insert(id)
    }

    /// `id` about to be opened or closed by you (and `closes` with it), before it grows or
    /// shrinks: only it changes, and what's above it stays where it is, as a disclosure row does
    /// (#416). Opened while following the end (`holds`: a step that's done), following stops
    /// first, so it opens down past the composer rather than taking the conversation up with it,
    /// and what comes in next doesn't move it. The last you left the end for closed, it follows
    /// the end again: as it closes, the end stays over the composer, where it was before it opened.
    fileprivate func folding(_ id: String, open: Bool, holds: Bool, closes: [String]) {
        if open {
            guard holds, followsEnd || !heldFor.isEmpty else { return }
            if followsEnd { follow(false) }
            heldFor.insert(id)
        } else {
            let closing = Set(closes + [id])
            guard !heldFor.isDisjoint(with: closing) else { return }
            heldFor.subtract(closing)
            if heldFor.isEmpty { follow(true) }
        }
    }

    private func ask(_ request: Request) {
        self.request = request
        requests += 1
    }
}

/// A conversation's rows, a session's or a group chat's: made as they come into view, kept at the
/// end while new ones come in (until you scroll up, with a button back), softly blurred where they
/// go under the card's header and the composer, and with a menu over text you select to quote
/// or copy it.
struct ConversationScroll<Rows: View>: View {
    #if DEBUG
    private static var edgeStyle: ScrollEdgeEffectStyle? { Perf.noEdge ? nil : .soft }
    #else
    private static var edgeStyle: ScrollEdgeEffectStyle? { .soft }
    #endif

    let scroller: ConversationScroller
    var spacing: CGFloat = 0
    /// Rows changing animate with this (nil: not, as for a whole history arriving at once), when
    /// `change` does.
    var animation: Animation? = .ui
    let change: AnyHashable
    /// Thinking under way, if any: once it's done, it folds into its steps' summary, and its row
    /// gets much shorter.
    var thinking: Thinking? = nil
    /// Called as you scroll within a couple of screens of the top: earlier rows can come in
    /// then, above what you're reading, which stays where it is (see `ScrollAnchor`).
    var nearTop: (() -> Void)? = nil
    /// Text you selected, to answer in the composer.
    let quote: (String) -> Void
    @ViewBuilder let rows: Rows

    /// Scrolling now: a plain flag, so starting and stopping don't redraw the conversation.
    @State private var scrolling = ScrollingFlag()
    @State private var endFollower = EndFollower()
    @State private var spot = ScrollSpot()
    @State private var fold = FoldWatch()
    @State private var anchor = ScrollAnchor()
    @State private var rowsCheck = RowsCheck()
    @Environment(\.isConversationShown) private var isShown

    @Environment(\.conversationTopRoom) private var topRoom

    var body: some View {
        // Scrolled by AppKit's scroll view (to the end, to a place, keeping what you read in
        // place) or once to a row: SwiftUI keeps no position of its own here, which it would put
        // back over those as the conversation changes.
        ScrollViewReader { proxy in
            scrollView(proxy)
        }
    }

    private func scrollView(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            column {
                rows
                // Room under the last message, so it doesn't sit on the composer: the end,
                // which going to the end goes to (so it's made, wherever the lazy stack guessed
                // the end was; a guess could leave the view past the rows, showing nothing).
                Color.clear
                    .frame(height: max(0, ConversationEndFade.height - spacing))
                    .id(ScrollAnchor.end)
            }
            .environment(\.scrollAnchor, anchor)
            .onAppear {
                wire()
                anchor.quote = quote
            }
            // Another scroller for the same view: it's the one told and asked.
            .onChange(of: ObjectIdentifier(scroller)) { wire() }
            .padding(.horizontal, Metrics.gutter)
            // Room under the card's header, which the conversation scrolls beneath (and under
            // Find's bar while it's open).
            .padding(.top, 16 + topRoom)
            .readableColumn()
            .coordinateSpace(.named(ScrollAnchor.space))
            .background {
                ScrollViewFinder {
                    anchor.scrollView = $0
                    #if DEBUG
                    if isShown {
                        ScrollAnchor.shownScrollView = $0
                        ScrollAnchor.shownAnchor = anchor
                    }
                    #endif
                }
            }
            .animation(animation, value: change)
        }
        // Fading out above the composer, under the selection's menu and the scroll-to-end button,
        // and clear of the scroller, which would look cut off at its end.
        .overlay(alignment: .bottom) { ConversationEndFade().padding(.trailing, Metrics.gutter - 4) }
        .modifier(SelectionMenu(addToChat: quote))
        // Only where it starts. An anchor for size changes fought the rubber band: the lazy
        // stack re-measures rows during a bounce, so the end kept moving and the bounce
        // crawled, then snapped back. Following the end is done below, only while idle.
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        #if DEBUG
        .onChange(of: isShown) {
            guard isShown else { return }
            ScrollAnchor.shownScrollView = anchor.scrollView
            ScrollAnchor.shownAnchor = anchor
        }
        #endif
        .onScrollPhaseChange { _, phase, context in
            scrolling.isOn = phase != .idle
            // Taken in hand on the way to the end: where it goes is yours again.
            if phase == .tracking || phase == .interacting {
                scrolling.goesToEnd = false
                if scrolling.from == nil { scrolling.from = context.geometry.contentOffset.y }
            }
            if phase == .idle, let from = scrolling.from {
                scrolling.from = nil
                let geometry = context.geometry
                // (On its way to the end from its button, where it stops doesn't decide.)
                if !scrolling.goesToEnd {
                    let atEnd = geometry.isAtConversationEnd
                    scroller.stopped(atEnd: atEnd, wentUp: geometry.contentOffset.y < from - 1, moved: abs(geometry.contentOffset.y - from))
                    // Still following, with more come in under your scroll: to the end it took.
                    if scroller.followsEnd, !atEnd { toEnd(proxy) }
                }
            }
            // Its button's way to the end is over, with the glide it stopped: at the end, wherever
            // the rows measured on the way moved it.
            if phase == .idle, scrolling.goesToEnd {
                scrolling.goesToEnd = false
                let geometry = context.geometry
                if scroller.followsEnd, abs(geometry.contentSize.height - geometry.visibleRect.maxY) > 1 { toEnd(proxy) }
            }
            #if DEBUG
            ScrollFrameMonitor.shared.scrolling(phase != .idle)
            #endif
        }
        // One watcher for both, as SwiftUI passes on only one change a frame from each.
        .onScrollGeometryChange(for: EndGeometry.self) { geometry in
            EndGeometry(atEnd: geometry.isAtConversationEnd, height: geometry.contentSize.height,
                        fits: geometry.contentSize.height <= geometry.containerSize.height + 1,
                        visible: geometry.containerSize.height, isPastEnd: geometry.contentOffset.y > geometry.roomyEnd + 1,
                        isPastConversationEnd: geometry.contentOffset.y > geometry.conversationEnd + 1, width: geometry.containerSize.width,
                        over: geometry.contentInsets.bottom, offset: geometry.contentOffset.y,
                        isAtVeryEnd: geometry.contentOffset.y >= geometry.conversationEnd - 0.5)
        } action: { old, new in
            scroller.fits = new.fits
            scroller.sees(atEnd: new.atEnd)
            // Thinking that was under way is done: for a moment, the conversation getting much
            // shorter is it folding. (Seen here, as the layout that makes it shorter.)
            if fold.thinking != thinking {
                if let done = fold.thinking { fold.folded = (done.row, .now + .seconds(1)) }
                fold.thinking = thinking
            }
            if endFollower.isSettling { return }
            // A row that got much shorter (long thinking folding into its summary), seen from the
            // end. The lazy stack re-measures only the rows it lays out in view: it goes on keeping
            // the row's old room, and following "the bottom" lands below the rows, looking at
            // nothing, each time a little less. So first to the row's top, which is where it's
            // laid out, so the rows from there are measured, then to the end.
            if anchor.stack == nil, let folded = fold.folded, folded.until > .now, !scrolling.isYours,
               new.isPastEnd || (scroller.followsEnd && old.height - new.height > new.visible) {
                fold.folded = nil
                endFollower.settle {
                    proxy.scrollTo(folded.row, anchor: .top)
                } then: {
                    toEnd(proxy)
                }
                return
            }
            // Being resized: kept at the end through AppKit's scroll view as it goes, and taken
            // to it through the lazy stack once it stops. Going to the end through the lazy stack
            // at every step of a resize laid the conversation out again each time, and made and
            // dropped the rows at the end over and over: a couple of frames a second.
            // Only while the window's being resized (a pane opening or closing changes the width
            // once: to the end through the lazy stack then, as AppKit's end is a guess the lazy
            // stack hasn't made rows at yet, which showed a blank conversation for a moment).
            let resizing = new.width != old.width && (anchor.scrollView?.window?.inLiveResize ?? false)
            if new.width != old.width, !resizing { makeSureOfRows(proxy) }
            // What's over the end grew or shrank (the composer as you write, quote or attach, the
            // cards and bars over it): it pushes the conversation, so nothing sits under it. Its
            // height is only the room kept under the rows, which nothing else moves the view for;
            // told as it animates, frame by frame, so the conversation goes with it. Following the
            // end, or right at it (Find took it there), the end stays over it; with nothing left to
            // see where the view is, back to the end; reading further up, what's over it stays
            // there too, by the same distance. Moved by what it's grown since it was last moved
            // for: kept out of sight (another conversation shown, with a composer of its own) or
            // scrolled by you, it isn't, and back in sight, it's as you left it.
            let overChanged = new.over != old.over
            if overChanged {
                if scrolling.isYours {
                    anchor.pushedOver = new.over
                } else if scroller.followsEnd || old.isAtVeryEnd || (new.isPastConversationEnd && anchor.stack?.isAboutToGrow != true) {
                    anchor.scroll(to: nil)
                    anchor.pushedOver = new.over
                } else if isShown {
                    anchor.push(by: new.over - (anchor.pushedOver ?? old.over))
                    anchor.pushedOver = new.over
                }
            }
            // Past the end, with nothing there to see, and you're not the one scrolling: to it.
            // (Following, past where the end is over the composer; reading further up, only past
            // where it was always counted: see `roomyEnd`.)
            if scroller.followsEnd ? new.isPastConversationEnd : new.isPastEnd, !overChanged, !scrolling.isYours, anchor.stack?.isAboutToGrow != true {
                if resizing {
                    anchor.scroll(to: nil)
                    endFollower.follow { settled in if settled { toEnd(proxy) } }
                } else {
                    toEnd(proxy)
                }
                return
            }
            // Your scrolling decides; growth below the fold doesn't. Set only when it changes: each
            // setting draws the conversation again, and this runs on every frame of a scroll.
            // (Not on its way to the end from its button: the rest of a glide doesn't decide.)
            // (Up from where your scroll started; a wheel that says nothing of its phases, up since
            // the frame before.)
            if scrolling.isYours { scroller.scrolled(atEnd: new.atEnd, wentUp: new.offset < (scrolling.from ?? old.offset) - 1) }
            // Shrinking too: the lazy stack's first guess at the height can be too big, and a
            // conversation would then open part of the way up.
            guard scroller.followsEnd, !scrolling.isYours, new.height != old.height else { return }
            endFollower.follow { settled in
                // Later, you may have started scrolling meanwhile.
                guard scroller.followsEnd, !scrolling.isYours else { return }
                if resizing, !settled { anchor.scroll(to: nil) } else { toEnd(proxy) }
            }
        }
        // Where it's scrolled to, for going to a place (a plain value, read only then).
        .onScrollGeometryChange(for: ScrollSpot.Geometry.self) { ScrollSpot.Geometry(offset: $0.contentOffset.y, height: $0.containerSize.height) } action: { _, new in
            spot.geometry = new
            anchor.viewMoved(offset: new.offset, height: new.height)
            if let nearTop, !scroller.followsEnd, new.offset < new.height * 2 { nearTop() }
        }
        // Messages scroll on under the card's header, blurring away there instead of being cut at
        // an edge. (Under the composer they fade out in the card's color: `conversationBar`.)
        .scrollEdgeEffectStyle(Self.edgeStyle, for: .all)
        .overlay(alignment: .bottom) {
            // Scrolled up: a way back to the newest, which also follows it again. Not while the
            // end is in view anyway (Find, say, stopped following it there).
            if !scroller.followsEnd, !scroller.seesEnd {
                Button {
                    // Gliding on from a flick too: the rest of the glide is let go, rather than
                    // carrying it away from the end again.
                    if scrolling.isOn {
                        scrolling.goesToEnd = true
                        anchor.dropGlide()
                    }
                    scroller.toEnd(animated: true)
                } label: {
                    Image(systemName: "arrow.down")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Scroll to the End")
                .help("Scroll to the End")
                .padding(.bottom, 12)
                .transition(.opacity.combined(with: .scale(scale: 0.8)))
            }
        }
        .animation(.ui, value: scroller.followsEnd)
        .animation(.ui, value: scroller.seesEnd)
        .onChange(of: scroller.requests) {
            switch scroller.request {
            case .end(let animated):
                if animated {
                    anchor.scroll(to: nil, animated: true)
                } else {
                    toEnd(proxy)
                }
            case .row(let id):
                go(to: id, anchor: .center, proxy) {}
            case .place(let id, let fraction):
                // Rows laid out by a stack of their own: straight to the place in the middle, in
                // one move (moved again only if measuring the rows on the way shifted it), so
                // going through Find's places doesn't jump about.
                if let stack = anchor.stack {
                    let half = spot.geometry.height / 2
                    let target = { () -> CGFloat? in
                        guard let frame = stack.frameInDocument(of: id) else { return nil }
                        return max(0, frame.minY + frame.height * fraction - half)
                    }
                    guard let first = target() else { return }
                    anchor.scroll(to: first)
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(60))
                        guard scroller.request == .place(id, fraction), let settled = target(), abs(settled - first) > 1 else { return }
                        anchor.scroll(to: settled)
                    }
                    return
                }
                // Lined up so the place is as far down the view as it is down its row (in view,
                // however tall the row), then moved to the middle.
                go(to: id, anchor: UnitPoint(x: 0.5, y: fraction), proxy) {
                    guard scroller.request == .place(id, fraction) else { return }
                    anchor.scroll(by: (fraction - 0.5) * spot.geometry.height)
                }
            case .offset(let y):
                anchor.scroll(to: y)
            case nil:
                break
            }
        }
    }
}

extension ConversationScroll {
    /// To row `id`: the lazy stack goes to where it guessed the row was, and the rows on the way
    /// are measured as they're made, so it's asked again once they have been; meanwhile what's
    /// in view isn't kept in place (that would keep it from getting there). Then `then`.
    fileprivate func go(to id: String, anchor point: UnitPoint, _ proxy: ScrollViewProxy, then: @escaping () -> Void) {
        // Rows laid out by a stack of their own: it knows where the row is.
        if let stack = anchor.stack {
            func scroll() {
                guard let frame = stack.frameInDocument(of: id) else { return }
                anchor.scroll(to: max(0, frame.minY + frame.height * point.y - spot.geometry.height * point.y))
            }
            scroll()
            Task {
                // Again once the rows on the way are measured, which may have moved it.
                try? await Task.sleep(for: .milliseconds(60))
                scroll()
                try? await Task.sleep(for: .milliseconds(40))
                then()
            }
            return
        }
        anchor.hold(for: .milliseconds(500))
        proxy.scrollTo(id, anchor: point)
        #if DEBUG
        anchor.noteWhere(id, "asked")
        #endif
        Task {
            for wait in [50, 120] {
                try? await Task.sleep(for: .milliseconds(wait))
                #if DEBUG
                anchor.noteWhere(id, "after \(wait) ms")
                #endif
                proxy.scrollTo(id, anchor: point)
            }
            try? await Task.sleep(for: .milliseconds(50))
            #if DEBUG
            anchor.noteWhere(id, "done")
            #endif
            then()
            #if DEBUG
            try? await Task.sleep(for: .milliseconds(300))
            anchor.noteWhere(id, "settled")
            if let file = ProcessInfo.processInfo.environment["KUVO_PERF_FIND"] {
                try? ScrollAnchor.notes.joined(separator: "\n").write(toFile: file, atomically: true, encoding: .utf8)
            }
            #endif
        }
    }

    /// Once a width change has settled: if no row is laid out where the view is, to the end
    /// again (or, scrolled up, a nudge), and a nudge if that didn't do it.
    fileprivate func makeSureOfRows(_ proxy: ScrollViewProxy) {
        // At each step of a slide too, once it's laid out: the lazy stack guesses the height
        // again at every width, by far more than a screen, and a guess can leave the view where
        // it has no rows. To the last row it showed, which it lays out where the view is.
        DispatchQueue.main.async { [anchor] in
            guard !scrolling.isOn, !anchor.showsRows(), let row = anchor.lastKnownRow else { return }
            #if DEBUG
            ScrollAnchor.blankRecoveries += 1
            #endif
            proxy.scrollTo(row, anchor: .bottom)
        }
        // Once the width has stopped changing (a slide changes it every frame).
        rowsCheck.task?.cancel()
        rowsCheck.task = Task {
            for step in 0..<4 {
                try? await Task.sleep(for: .milliseconds(150))
                guard !Task.isCancelled, !scrolling.isOn, !anchor.showsRows() else { return }
                #if DEBUG
                ScrollAnchor.blankRecoveries += 1
                #endif
                switch step {
                // Where it guessed the end was, there may be no rows: to the last one it has
                // made, which it lays out (and measures again from), then to the end.
                case 0, 2:
                    if let row = anchor.lastKnownRow {
                        proxy.scrollTo(row, anchor: .bottom)
                    } else {
                        anchor.nudge()
                    }
                default:
                    if scroller.followsEnd { toEnd(proxy) } else { anchor.nudge() }
                }
            }
        }
    }

    /// What the conversation is laid out in: a plain stack, as what's in it is `RowStack` (which
    /// makes only the rows in view itself) and a row or two around it. A lazy stack let go of the
    /// whole `RowStack` when it guessed it was out of view, as the conversation's size changed by
    /// thousands of points at once (a long reply coming in), and showed nothing until you
    /// scrolled. Lazy only with the rows in it one by one (KUVO_PERF_LAZY).
    @ViewBuilder private func column<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        #if DEBUG
        if Perf.lazy {
            LazyVStack(alignment: .leading, spacing: spacing, content: content)
        } else {
            VStack(alignment: .leading, spacing: spacing, content: content)
        }
        #else
        VStack(alignment: .leading, spacing: spacing, content: content)
        #endif
    }

    /// The rows and the scroller, each told what the other does. The rows hear whether the end is
    /// followed at once, whatever started or stopped it: the next row to come mustn't count as
    /// followed, nor what changes above what you read.
    fileprivate func wire() {
        anchor.stopFollowing = { [scroller] in scroller.follow(false) }
        anchor.reading = { [scroller] id in scroller.reading(id) }
        anchor.folding = { [scroller] id, open, holds, closes in scroller.folding(id, open: open, holds: holds, closes: closes) }
        anchor.isFollowingEnd = scroller.followsEnd
        scroller.followChanged = { [weak anchor] in anchor?.isFollowingEnd = $0 }
    }

    fileprivate func toEnd(_ proxy: ScrollViewProxy) {
        proxy.scrollTo(ScrollAnchor.end, anchor: .bottom)
    }
}

/// The check that rows are laid out where the view is, after the width changes.
final class RowsCheck {
    var task: Task<Void, Never>?
}

/// Where the conversation is scrolled to, read only when going to a place.
final class ScrollSpot {
    struct Geometry: Equatable {
        var offset: CGFloat = 0
        var height: CGFloat = 0
    }

    var geometry = Geometry()
}

/// Thinking under way: its row, and which of the row's steps it is.
struct Thinking: Equatable {
    var row: String
    var step: Int
}

/// The thinking under way as last seen, and the row of thinking that just folded.
final class FoldWatch {
    var thinking: Thinking?
    var folded: (row: String, until: ContinuousClock.Instant)?
}

/// Set while you scroll, read by the handlers only.
final class ScrollingFlag {
    var isOn = false
    /// Sent to the end by its button while it scrolled: the scroll that's left is its, not yours.
    var goesToEnd = false
    /// Where your scroll started.
    var from: CGFloat?
    /// You're scrolling: not the end's button finishing a scroll you'd started.
    var isYours: Bool { isOn && !goesToEnd }
}

extension ScrollGeometry {
    /// Where the view is with the conversation's end just over what's over it (the composer).
    /// (The container leaves out what's over the end; the visible rect is all of the view.)
    fileprivate var conversationEnd: CGFloat {
        max(-contentInsets.top, contentSize.height + contentInsets.bottom - visibleRect.height)
    }

    /// The end as it was always counted for being past it: as far again as what's over it. A
    /// step closing under where you read leaves the view this far past the real end for a moment,
    /// which AppKit takes back itself; taken to the end through the lazy stack instead, it landed
    /// there after you'd opened the step again.
    fileprivate var roomyEnd: CGFloat {
        max(-contentInsets.top, contentSize.height + contentInsets.bottom - containerSize.height)
    }

    /// The end is in view: over the composer, not under it, however tall that is now.
    fileprivate var isAtConversationEnd: Bool {
        contentOffset.y >= conversationEnd - 40
    }
}

/// Whether the end is in view, and how tall the conversation is.
struct EndGeometry: Equatable {
    var atEnd: Bool
    var height: CGFloat
    var fits = false
    /// How tall the view of it is, and whether it's scrolled past its end.
    var visible: CGFloat = 0
    var isPastEnd = false
    /// Past where the view can go with the end over the composer.
    var isPastConversationEnd = false
    /// How wide the view is: changing, the window or a pane is being resized.
    var width: CGFloat = 0
    /// How much of the view's height is under what's over the conversation's end.
    var over: CGFloat = 0
    /// Where it's scrolled to, and whether that's right at the end (not only near it).
    var offset: CGFloat = 0
    var isAtVeryEnd = false
}

/// Keeps the end in view as the conversation grows. Scrolling makes the lazy stack make the rows
/// it comes to, which measure taller or shorter than it guessed, so the height changes again in
/// the same frame, and SwiftUI drops scroll geometry updates that come more than once a frame. A
/// height that shrank and was dropped left it scrolled past the end: a blank conversation until
/// something laid it out again (showing the panel). So each change scrolls at once (a
/// conversation opens at its end), again on the next turn of the run loop for the changes after
/// it, and once more when they've settled, for any that weren't passed on.
final class EndFollower {
    private var isBusy = false
    private var settle: Task<Void, Never>?
    private(set) var isSettling = false

    /// `first`, then, once the conversation has been laid out there, `then`; following the end
    /// waits meanwhile, as it would undo `first`.
    func settle(first: @escaping () -> Void, then: @escaping () -> Void) {
        isSettling = true
        settle?.cancel()
        first()
        settle = Task {
            try? await Task.sleep(for: .milliseconds(150))
            isSettling = false
            then()
        }
    }

    /// `scroll` now and again a moment later, then once more (`settled`) once it has stopped
    /// changing for a while.
    func follow(_ scroll: @escaping (_ settled: Bool) -> Void) {
        if !isBusy {
            isBusy = true
            scroll(false)
            DispatchQueue.main.async { [self] in
                isBusy = false
                scroll(false)
            }
        }
        settle?.cancel()
        settle = Task {
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            scroll(true)
        }
    }
}

/// Keeps what you're reading where it is while rows above it change height: rows made as they
/// come into view (scrolling up, they're above it) measure taller or shorter than the lazy stack
/// guessed, and earlier messages come in above, which moved everything after them. The row at the
/// top of the view is noted, and when it moves in the conversation, the view moves with it, at
/// once, before it's drawn. It also moves the view to a place: through AppKit's scroll view, as
/// SwiftUI would put a position of its own back over what this did.
final class ScrollAnchor {
    static let space = "conversation"
    /// Add to Chat, for what's selected in the conversation: a quote over the composer.
    var quote: ((String) -> Void)?
    /// The conversation's end, after its last row.
    static let end = "conversation-end"
    #if DEBUG
    static let isOn = ProcessInfo.processInfo.environment["KUVO_PERF_NO_ANCHOR"] == nil
    #else
    static let isOn = true
    #endif

    weak var scrollView: NSScrollView? {
        didSet {
            #if DEBUG
            if scrollView !== oldValue, scrollView != nil { Self.latest = self }
            if scrollView !== oldValue, let clip = scrollView?.contentView, let file = Self.boundsLog {
                // KUVO_PERF_BOUNDS=<file>: each move of the view, and what moved it.
                clip.postsBoundsChangedNotifications = true
                var last = clip.bounds.origin.y
                boundsWatch = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: nil) { [weak clip] _ in
                    MainActor.assumeIsolated {
                        guard let clip else { return }
                        let now = clip.bounds.origin.y
                        guard abs(now - last) > 0.5 else { return }
                        let callers = Thread.callStackSymbols.dropFirst(9).prefix(8).map { line in
                            line.split(separator: " ", omittingEmptySubsequences: true).dropFirst(3).dropLast(2).joined(separator: " ")
                        }.joined(separator: " < ")
                        let line = "\(String(format: "%.3f", CACurrentMediaTime())) \(Int(last))→\(Int(now)) doc \(Int(clip.documentView?.frame.height ?? 0)) | \(callers)\n"
                        last = now
                        if let handle = FileHandle(forWritingAtPath: file) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() } else { FileManager.default.createFile(atPath: file, contents: Data(line.utf8)) }
                    }
                }
            }
            #endif
        }
    }
    #if DEBUG
    /// The scroll view of the conversation in view, not one kept hidden, for the tests, and
    /// its anchor.
    static weak var shownScrollView: NSScrollView?
    static weak var shownAnchor: ScrollAnchor?
    /// How often a conversation was found showing no rows and was brought back.
    static var blankRecoveries = 0
    /// The conversation's scroll view, for the tests: the one in view, else the tallest.
    static func conversationScrollView() -> NSScrollView? {
        if let shownScrollView, shownScrollView.window != nil { return shownScrollView }
        func scrollViews(in view: NSView) -> [NSScrollView] { (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap(scrollViews) }
        return NSApp.windows.compactMap(\.contentView).flatMap(scrollViews).max { ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0) }
    }
    private static let boundsLog = ProcessInfo.processInfo.environment["KUVO_PERF_BOUNDS"]
    private var boundsWatch: NSObjectProtocol?
    #endif
    var isFollowingEnd = true
    /// The rows, when they're laid out by a `RowStack` rather than the lazy stack: it keeps
    /// them in place itself, and knows where each is.
    weak var stack: RowStackView?
    /// Stops keeping the end in view, as scrolling up does: a selection dragged up past the top
    /// scrolls the conversation, which would otherwise go back to the end.
    var stopFollowing: () -> Void = {}
    /// A step you opened as it was under way has ended, open, by what its fold is kept by.
    var reading: ((String) -> Void)?
    /// Steps about to be opened (true) or closed by you, whether opening holds (a step that's
    /// done), and what closes with them: `ConversationScroller.folding`.
    var folding: ((String, Bool, Bool, [String]) -> Void)?

    /// The rows laid out, where they are in the conversation, and those shown now. A row that
    /// goes and comes back where it was (the whole conversation hidden a moment) isn't told its
    /// place again, so where it was is kept.
    private var frames: [String: CGRect] = [:]
    private var shown: Set<String> = []
    /// The row kept in place, and where it was.
    private var anchor: (id: String, minY: CGFloat)?
    /// Where this last put the view, to keep a row in place.
    private var placed: CGFloat?

    #if DEBUG
    /// What it did lately, the one in use, and where its rows are, for the scrolling test.
    static var notes: [String] = []
    static weak var latest: ScrollAnchor?
    var conversationFrames: [String: CGRect] { stack?.shownFrames().document ?? frames }
    func noteWhere(_ id: String, _ when: String) {
        let origin = Int(scrollView?.contentView.bounds.origin.y ?? -1)
        let frame = frames[id].map { "\(Int($0.minY))…\(Int($0.maxY))" } ?? "not made"
        Self.note("go to \(id.suffix(10)) \(when): view at \(origin), row at \(frame), conversation \(Int(scrollView?.documentView?.frame.height ?? 0)) tall")
    }

    private static func note(_ text: String) {
        notes.append(text)
        if notes.count > 40 { notes.removeFirst() }
    }
    #endif

    /// Nothing kept in place until then: going to a row, the view moves as rows are measured.
    private var heldUntil: ContinuousClock.Instant?

    func hold(for duration: Duration) {
        heldUntil = .now + duration
    }

    func rowMoved(_ id: String, to frame: CGRect) {
        frames[id] = frame
        shown.insert(id)
        guard Self.isOn, let anchor, anchor.id == id else { return }
        let shift = frame.minY - anchor.minY
        self.anchor?.minY = frame.minY
        if let heldUntil, heldUntil > .now {
            #if DEBUG
            if abs(shift) > 0.5 { Self.note("\(id) moved \(Int(shift)), held") }
            #endif
            return
        }
        guard abs(shift) > 0.5, !isFollowingEnd, let scrollView else {
            #if DEBUG
            if abs(shift) > 0.5 { Self.note("\(id) moved \(Int(shift)), following the end") }
            #endif
            return
        }
        let clip = scrollView.contentView
        let origin = clip.bounds.origin.y
        // Not while it bounces at an edge. Past the end AppKit knows of where this put it a moment
        // ago is no bounce: the conversation grew in this same pass (earlier messages came in above),
        // and AppKit hears of it after.
        guard origin >= 0, origin <= (scrollView.documentView?.frame.height ?? 0) - clip.bounds.height
                || placed.map({ abs($0 - origin) < 0.5 }) == true else {
            #if DEBUG
            Self.note("\(id) moved \(Int(shift)), at an edge: view at \(Int(origin)) of \(Int(scrollView.documentView?.frame.height ?? 0))")
            #endif
            return
        }
        // Never above the conversation's start: rows above that turn out shorter than guessed
        // would take it there, and it would bounce back.
        let target = max(0, origin + shift)
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: target))
        scrollView.reflectScrolledClipView(clip)
        placed = clip.bounds.origin.y
        // What's over the end pushes on from here.
        pushed = nil
        // SwiftUI's scroll view, told again once its update is over: told only during it, it
        // keeps where it last knew the view to be, and puts the view back there the next time
        // the conversation's size changes (earlier messages coming in above).
        DispatchQueue.main.async { [weak clip] in
            guard let clip else { return }
            NotificationCenter.default.post(name: NSView.boundsDidChangeNotification, object: clip)
        }
        // Further down than the conversation reaches yet (it grows in this same pass): the rest
        // once it has.
        let short = target - clip.bounds.origin.y
        if abs(short) > 0.5 {
            DispatchQueue.main.async { [weak scrollView] in
                guard let scrollView else { return }
                let clip = scrollView.contentView
                clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: clip.bounds.origin.y + short))
                scrollView.reflectScrolledClipView(clip)
            }
        }
        #if DEBUG
        Self.note("\(id) moved \(Int(shift))\(abs(short) > 0.5 ? ", \(Int(short)) of it later" : "")")
        #endif
    }

    /// Whether any row is laid out where the view is. Given a very different width at once, the
    /// lazy stack could leave the view where it had made no rows, and show nothing there until
    /// you scrolled.
    func showsRows() -> Bool {
        if let stack { return stack.showsRowsInView() }
        guard let scrollView, let document = scrollView.documentView, !frames.isEmpty else { return true }
        let visible = scrollView.contentView.bounds
        // A conversation shorter than the view has room under it.
        guard document.frame.height > visible.height + 40 else { return true }
        // How much of the view rows cover: with a row peeking in at its bottom only (and nothing
        // above it), it's still blank.
        let spans = frames.filter { shown.contains($0.key) }.map { max($0.value.minY, visible.minY)...max(min($0.value.maxY, visible.maxY), max($0.value.minY, visible.minY)) }
            .filter { $0.upperBound > $0.lowerBound }.sorted { $0.lowerBound < $1.lowerBound }
        var covered: CGFloat = 0
        var end = visible.minY
        for span in spans where span.upperBound > end {
            covered += span.upperBound - max(span.lowerBound, end)
            end = span.upperBound
        }
        return covered > visible.height * 0.4
    }

    /// The lowest row laid out so far: one the lazy stack has, to go to when it has none where
    /// the view is.
    var lastKnownRow: String? {
        frames.max { $0.value.maxY < $1.value.maxY }?.key
    }

    /// Moves the view a point and back, so SwiftUI lays out rows where it is.
    func nudge() {
        guard let scrollView else { return }
        let clip = scrollView.contentView
        let origin = clip.bounds.origin
        clip.scroll(to: NSPoint(x: origin.x, y: max(0, origin.y - 1)))
        scrollView.reflectScrolledClipView(clip)
        clip.scroll(to: origin)
        scrollView.reflectScrolledClipView(clip)
        NotificationCenter.default.post(name: NSView.boundsDidChangeNotification, object: clip)
    }

    #if DEBUG
    /// Where the view is and the rows across it, for the tests.
    func describeView() -> String {
        guard let scrollView, let document = scrollView.documentView else { return "no scroll view" }
        let visible = scrollView.contentView.bounds
        let across = frames.filter { shown.contains($0.key) && $0.value.maxY > visible.minY && $0.value.minY < visible.maxY }
            .sorted { $0.value.minY < $1.value.minY }
            .map { "\($0.key.suffix(6)) \(Int($0.value.minY))…\(Int($0.value.maxY))" }
        return "view \(Int(visible.minY))…\(Int(visible.maxY)) of \(Int(document.frame.height)), \(shown.count) rows shown, across it: \(across.joined(separator: ", "))"
    }
    #endif

    func rowCame(_ id: String) {
        if frames[id] != nil { shown.insert(id) }
    }

    func rowGone(_ id: String) {
        shown.remove(id)
        if anchor?.id == id {
            anchor = nil
            #if DEBUG
            Self.note("anchor \(id) gone")
            #endif
        }
    }

    /// The view scrolled: the first row that starts in it is the one to keep in place (or, with
    /// none, the one across it). The one kept stays while any of it is in view: rows move several
    /// times in one pass (earlier messages coming in above), and another, whose place isn't told
    /// yet, would be moved for again. Where the view is comes from AppKit, as SwiftUI tells it a
    /// moment late, from before this moved it.
    func viewMoved(offset: CGFloat, height: CGFloat) {
        let offset = scrollView?.contentView.bounds.origin.y ?? offset
        if let anchor, shown.contains(anchor.id), let frame = frames[anchor.id], frame.maxY > offset, frame.minY < offset + height { return }
        let rows = frames.filter { shown.contains($0.key) }
        let first = rows.filter { $0.value.minY >= offset && $0.value.minY < offset + height }.min { $0.value.minY < $1.value.minY }
            ?? rows.filter { $0.value.maxY > offset && $0.value.minY < offset + height }.min { $0.value.minY < $1.value.minY }
        #if DEBUG
        if first?.key != anchor?.id { Self.note("anchor \(first?.key ?? "none of \(rows.count)") at \(Int(offset))") }
        #endif
        anchor = first.map { ($0.key, $0.value.minY) }
    }

    /// Where moving the view with what's over the end means it to be, and where that put it.
    /// Between frames, SwiftUI puts the view back on whole points; moved on from there each frame,
    /// those roundings added up to points out of place by the time the composer stopped growing.
    private var pushed: (target: CGFloat, placed: CGFloat)?
    /// How tall what's over the end was when the view was last moved for it (or you placed it).
    var pushedOver: CGFloat?

    /// Moved with what's over the end: from where the last push meant it to be, if nothing but
    /// rounding moved it since; else from where it is. Past an edge, by more than a spring's
    /// overshoot, isn't owed.
    func push(by distance: CGFloat) {
        guard let clip = scrollView?.contentView else { return }
        let now = clip.bounds.origin.y
        var target = (pushed.flatMap { abs(now - $0.placed) <= 1 ? $0.target : nil } ?? now) + distance
        scroll(to: target)
        let placed = clip.bounds.origin.y
        if abs(target - placed) > 1 { target = placed }
        pushed = (target, placed)
    }

    /// This far down from where it is now (up, less than 0).
    func scroll(by distance: CGFloat) {
        guard let scrollView else { return }
        scroll(to: max(0, scrollView.contentView.bounds.origin.y + distance))
    }

    /// What's left of a glide from a flick of the trackpad, let go: its steps aren't scrolled, its
    /// end still is (so the scroll view knows it's over). Until the next scroll of yours.
    func dropGlide() {
        guard glideMonitor == nil, let window = scrollView?.window else { return }
        glideMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self, weak window] event in
            guard let self else { return event }
            // A scroll of yours (anywhere), the glide's end, or the window gone: no more to drop.
            let momentum = event.momentumPhase
            if window == nil || momentum.isEmpty || momentum.contains(.ended) || momentum.contains(.cancelled) {
                self.stopDroppingGlide()
                return event
            }
            return event.window === window ? nil : event
        }
    }

    private var glideMonitor: Any?

    private func stopDroppingGlide() {
        if let glideMonitor { NSEvent.removeMonitor(glideMonitor) }
        glideMonitor = nil
    }

    isolated deinit {
        stopDroppingGlide()
    }

    /// To `y` in the conversation (nil: its end).
    func scroll(to y: CGFloat?, animated: Bool = false) {
        guard let scrollView else { return }
        let clip = scrollView.contentView
        var bounds = clip.bounds
        bounds.origin.y = y ?? (scrollView.documentView?.frame.height ?? 0) + 10_000
        let target = clip.constrainBoundsRect(bounds).origin
        guard abs(target.y - clip.bounds.origin.y) > 0.5 else { return }
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.3
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                clip.animator().setBoundsOrigin(target)
            } completionHandler: { [weak scrollView] in
                scrollView?.reflectScrolledClipView(clip)
            }
        } else {
            clip.scroll(to: target)
            scrollView.reflectScrolledClipView(clip)
            // SwiftUI's scroll view, told once its update is over (as `rowMoved` tells it): else
            // it may not lay rows out where the view is now, and show nothing there.
            DispatchQueue.main.async { [weak clip] in
                guard let clip else { return }
                NotificationCenter.default.post(name: NSView.boundsDidChangeNotification, object: clip)
            }
        }
    }
}

extension EnvironmentValues {
    @Entry var scrollAnchor: ScrollAnchor?
}

extension View {
    /// A row of a conversation, kept in place as rows above it change (see `ScrollAnchor`).
    func conversationRow(_ id: String) -> some View {
        modifier(ConversationRow(id: id))
    }
}

private struct ConversationRow: ViewModifier {
    let id: String
    @Environment(\.scrollAnchor) private var anchor

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(ScrollAnchor.space)) } action: { anchor?.rowMoved(id, to: $0) }
            .onAppear { anchor?.rowCame(id) }
            .onDisappear { anchor?.rowGone(id) }
    }
}

/// The scroll view its background is in, once it's there.
private struct ScrollViewFinder: NSViewRepresentable {
    let found: (NSScrollView) -> Void

    func makeNSView(context: Context) -> FinderView {
        let view = FinderView()
        view.found = found
        return view
    }

    func updateNSView(_ view: FinderView, context: Context) {
        view.found = found
    }

    final class FinderView: NSView {
        var found: ((NSScrollView) -> Void)?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil, let scrollView = enclosingScrollView else { return }
            found?(scrollView)
        }
    }
}
