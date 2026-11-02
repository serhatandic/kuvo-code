import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI

/// The computers the sidebar pages through, one at a time: this Mac, then your machines, each a
/// box of its own with its bots, chats and projects.
enum SidebarBox: Hashable, Identifiable {
    case mac
    case machine(String)

    var id: String { machine ?? "mac" }

    /// The box in view in the sidebar, by `id`, as it's kept.
    static let inViewKey = "sidebarBox"

    /// The machine it is; nil for this Mac.
    var machine: String? {
        if case .machine(let id) = self { id } else { nil }
    }

    init(id: String) {
        self = id == "mac" ? .mac : .machine(id)
    }

    /// Where `directory` is: this Mac, or the machine it's on.
    init(directory: String) {
        self = RemoteFolder.machine(of: directory).map(SidebarBox.machine) ?? .mac
    }

    init(machine: String?) {
        self = machine.map(SidebarBox.machine) ?? .mac
    }

    var symbol: String { machine == nil ? "laptopcomputer" : "server.rack" }
}

extension EnvironmentValues {
    /// Rows mark what's on a machine: in search results, which cover every computer, not on a
    /// computer's own page.
    @Entry var marksMachines = true
}

/// Above the sidebar's pages, staying put while they slide: your computers by name, in order, as
/// many as fit, and "+3" for the rest, which opens a menu of them with how each is and Add
/// Machine…. The one in view is lit, and always among the names. A computer that needs you or has
/// something new is marked, one that isn't connected says so, and so does the count when one of
/// those it stands for does.
struct BoxNameStrip: View {
    let boxes: [SidebarBox]
    @Binding var selected: SidebarBox
    /// Whether names carry their computer's news (the sidebar's), or only how it's connected
    /// (Settings').
    var marksNews = true
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.messageFont) private var messageFont
    /// Each name's width at rest, measured off screen, so what fits is known before it's shown.
    @State private var widths: [SidebarBox: CGFloat] = [:]
    @State private var moreWidth: CGFloat = 0
    @State private var room: CGFloat = 0

    private static let spacing: CGFloat = 2

    var body: some View {
        let names = boxes.map(name)
        let shown = Self.shown(widths: boxes.map { widths[$0] ?? 0 }, room: room, more: moreWidth, spacing: Self.spacing,
                               selected: boxes.firstIndex(of: selected) ?? 0)
        let rest = boxes.indices.filter { !shown.contains($0) }.map { names[$0] }
        // Until every name is measured, what fits isn't known: nothing rather than a jump.
        let measured = room > 0 && boxes.allSatisfy { widths[$0] != nil }
        HStack(spacing: Self.spacing) {
            ForEach(shown.map { names[$0] }, id: \.box) { name in
                label(name)
            }
            if !rest.isEmpty {
                more(rest)
            }
        }
        .opacity(measured ? 1 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: (24 * messageFont.sidebarScale).rounded())
        .clipped()
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { room = $0 }
        .background(alignment: .topLeading) {
            // Every name as it would show lit (its widest), and the count at its widest, to
            // measure: never seen.
            HStack(spacing: Self.spacing) {
                ForEach(names, id: \.box) { name in
                    label(name, lit: true)
                        .onGeometryChange(for: CGFloat.self, of: \.size.width) { widths[name.box] = $0 }
                }
                moreLabel(count: boxes.count, mark: .new)
                    .onGeometryChange(for: CGFloat.self, of: \.size.width) { moreWidth = $0 }
            }
            .fixedSize()
            .hidden()
            .accessibilityHidden(true)
        }
        .padding(.horizontal, 10)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Computers")
    }

    /// Which of the names show, by their place: from the first, as many as fit in `room` with
    /// the count after them, and the one in view always, in place of the last that would have
    /// fit. All of them when they fit without the count, or before the room is known.
    static func shown(widths: [CGFloat], room: CGFloat, more: CGFloat, spacing: CGFloat, selected: Int) -> [Int] {
        let all = Array(widths.indices)
        guard room > 0, widths.reduce(0, +) + spacing * CGFloat(max(widths.count - 1, 0)) > room else { return all }
        // The first `count` that fit beside `extra` (and the count, after a gap).
        func fitting(besides extra: CGFloat) -> Int {
            var used = extra + more
            var count = 0
            for width in widths {
                guard used + width + spacing <= room else { break }
                used += width + spacing
                count += 1
            }
            return count
        }
        let first = fitting(besides: 0)
        if selected < first { return Array(0..<first) }
        // In view but past them: it takes the place of the last, or more if it's wider.
        let before = min(fitting(besides: widths[selected] + spacing), selected)
        return Array(0..<before) + [selected]
    }

    private func pick(_ box: SidebarBox) {
        guard box != selected else { return }
        withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.9)) { selected = box }
    }

    /// A computer's name as the line shows it.
    private func name(_ box: SidebarBox) -> Name {
        let engine = app.machines.engine(box.machine)
        let isAway = engine.map { !$0.isReady } ?? false
        return Name(box: box, title: app.name(of: box), isOn: box == selected, isAway: isAway, isStopped: engine?.isStopped == true,
                    connection: isAway ? engine?.connection : nil, status: engine?.statusText, progress: engine?.installProgress,
                    news: marksNews ? app.news(on: box) : nil)
    }

    struct Name {
        var box: SidebarBox
        var title: String
        var isOn: Bool
        var isAway: Bool
        var isStopped: Bool
        var connection: MachineEngine.Connection?
        /// How it's connected, in words, for a machine.
        var status: String?
        /// How far its engine has come to it, while it's being installed there.
        var progress: Double?
        var news: BoxNews?

        /// What the menu and VoiceOver say beside its name: how it's connected while it isn't,
        /// else what it has for you.
        var said: String? {
            isAway ? (isStopped ? "Stopped" : progress.map { "Installing, \(Int(($0 * 100).rounded())) percent" } ?? status ?? "Not connected") : news?.said
        }
    }

    /// `lit`: drawn in the lit one's weight, whichever it is, to measure.
    private func label(_ name: Name, lit: Bool = false) -> some View {
        Button { pick(name.box) } label: {
            HStack(spacing: 5) {
                Text(name.title)
                    .sidebarFont(12.5, weight: name.isOn || lit ? .semibold : .medium)
                    .foregroundStyle(name.isOn ? AnyShapeStyle(.primary) : name.isAway ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .modifier(NameWidth())
                if let connection = name.connection {
                    MachineIndicator(connection: connection, size: 5, quiet: true, progress: name.progress)
                } else if let news = name.news {
                    NewsDot(news: news)
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 22)
            .pickHighlight(RoundedRectangle(cornerRadius: 6), isOn: name.isOn)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .help(name.title)
        .accessibilityLabel(name.title)
        .accessibilityValue(name.said ?? "")
        .accessibilityAddTraits(name.isOn ? .isSelected : [])
    }

    /// A name as wide as it is, never the room it's offered, up to a width it's cut at.
    struct NameWidth: ViewModifier {
        func body(content: Content) -> some View {
            content
                .frame(maxWidth: 150, alignment: .leading)
                .fixedSize(horizontal: true, vertical: false)
        }
    }

    /// "+3", and the menu of the computers it stands for.
    private func more(_ rest: [Name]) -> some View {
        NativeMenuButton(name: "boxes", opensBelow: true) {
            let menu = NSMenu()
            for name in rest {
                menu.addItem(ActionItem(name.title, subtitle: name.said ?? name.status, image: Self.dot(for: name)) { pick(name.box) })
            }
            menu.addItem(.separator())
            menu.addItem(ActionItem("Add Machine…") {
                app.addsMachine = true
                app.openSettings(.machines)
            })
            return menu
        } label: {
            moreLabel(count: rest.count, mark: Self.mark(of: rest))
        }
        .help(rest.map(\.title).formatted(.list(type: .and)))
        .accessibilityLabel("\(rest.count) more")
        .accessibilityValue(rest.compactMap { name in name.said.map { "\(name.title), \($0)" } }.formatted(.list(type: .and)))
    }

    /// What the count is marked with: the most pressing of those it stands for.
    private enum Mark { case failed, needsYou, new }

    private static func mark(of rest: [Name]) -> Mark? {
        if rest.contains(where: { $0.connection == .failed }) { return .failed }
        if rest.contains(where: { $0.news == .needsYou }) { return .needsYou }
        return rest.contains { $0.news == .new } ? .new : nil
    }

    private func moreLabel(count: Int, mark: Mark?) -> some View {
        HStack(spacing: 5) {
            Text("+\(count)")
                .sidebarFont(12.5, weight: .semibold)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            switch mark {
            case .failed: MachineIndicator(connection: .failed, size: 5, quiet: true)
            case .needsYou: NewsDot(news: .needsYou)
            case .new: NewsDot(news: .new)
            case nil: EmptyView()
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 22)
        .pickHighlight(RoundedRectangle(cornerRadius: 6), isOn: false)
    }

    /// A computer's dot in the menu, as its name's in the strip, and green while all is well.
    private static func dot(for name: Name) -> NSImage {
        let color: NSColor = switch name.connection {
        case .failed?: .systemOrange
        case .notConnected?, .stopped?: .secondaryLabelColor
        case .connecting?, .reconnecting?, .installing?: .tertiaryLabelColor
        case .connected?, nil: name.news == .needsYou ? .systemOrange : name.news == .new ? .controlAccentColor : .systemGreen
        }
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { _ in
            color.setFill()
            NSBezierPath(ovalIn: NSRect(x: 4.5, y: 4.5, width: 7, height: 7)).fill()
            return true
        }
        return image
    }
}

/// Something waiting on a computer: orange when it needs you, the accent when it's only new.
private struct NewsDot: View {
    let news: BoxNews

    var body: some View {
        Circle()
            .fill(news == .needsYou ? AnyShapeStyle(.orange) : AnyShapeStyle(.tint))
            .frame(width: 6, height: 6)
            .accessibilityHidden(true)
    }
}

/// What a computer has for you, for its name in the strip: something waiting on your answer, or
/// something you haven't seen.
enum BoxNews {
    case needsYou, new

    var said: String { self == .needsYou ? "Needs you" : "Something new" }
}

extension AppModel {
    /// What's waiting on `box`: an answer it needs (a permission, a question, a sign-in), else
    /// news (a conversation, bot or group chat you haven't read).
    func news(on box: SidebarBox) -> BoxNews? {
        let sessions = workspace.sessions.filter { SidebarBox(directory: $0.location.directory) == box && !Workspace.isArchived($0) }
        if sessions.contains(where: { workspace.needsAttention($0.id) }) { return .needsYou }
        // A session's sub-session finished since you read it is news too, as its folded row says.
        if sessions.contains(where: { $0.isUnread || workspace.hasNewSubSessions($0.id) }) || chats.list.contains(where: { SidebarBox(machine: chats.machine(of: $0.id)) == box && chats.isUnread($0) }) { return .new }
        return nil
    }
}

/// The top of a box's page: a machine that isn't connected, with what it's doing and the way to
/// connect it or start its engine.
struct BoxHeading: View {
    let box: SidebarBox
    @Environment(AppModel.self) private var app

    var body: some View {
        if let engine = app.machines.engine(box.machine), !engine.isReady {
            HStack(spacing: 8) {
                MachineStatus(engine: engine)
                Spacer(minLength: 0)
                if !engine.connection.isUnderWay {
                    // COMPAT(0.7 engine-stop): Start. Goes 3 months after 0.8.0.
                    Button(engine.isStopped ? "Start" : "Connect") { app.connectOrStart(engine) }
                        .buttonStyle(.glass)
                        .controlSize(.small)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
        }
    }
}

/// Which way a two-finger swipe takes the sidebar's pages, in Settings › General: they follow the
/// fingers (the next computer comes in from the side the fingers leave), or the other way.
enum SidebarSwipe {
    static let reversesKey = "sidebarSwipeReverses"
}

/// Where the sidebar's two-finger swipes go: the page's offset, read only by the track that
/// slides, so a swipe moves the pages without building them again.
@Observable final class BoxPagerMotion {
    /// How far the pages are pulled from where they rest, in points (left is negative).
    var offset: CGFloat = 0
    /// A page's width, for how far that is in pages.
    var width: CGFloat = 0
}

/// Pages side by side, one in view, that follow two fingers sideways on the trackpad as Arc's
/// and Dia's spaces do: the pages slide with them and, as they lift, go on to the next box (or
/// spring back); past the last comes the first again, and before the first the last. A box
/// picked otherwise (the name strip, a tab on another box) slides in too.
struct BoxPager<Page: View>: View {
    let boxes: [SidebarBox]
    @Binding var selected: SidebarBox
    let motion: BoxPagerMotion
    @ViewBuilder let page: (SidebarBox) -> Page

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Wrapped around (the last to the first): the pages come in faded rather than sliding past
    /// every one between.
    @State private var wrapFade = 1.0
    @AppStorage(SidebarSwipe.reversesKey) private var reverses = false
    /// The room it's given, for how far a swipe has to go: read from what the sidebar offers, never
    /// from the pages, so their size can't feed back into it.
    @State private var width: CGFloat = 0

    private var index: Int { boxes.firstIndex(of: selected) ?? 0 }

    var body: some View {
        GeometryReader { proxy in
            BoxTrack(motion: motion, index: index, width: proxy.size.width) {
                HStack(alignment: .top, spacing: 0) {
                    ForEach(boxes) { box in
                        page(box)
                            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
                            // Clipped out of sight, a page beside still takes clicks where it lies
                            // (over the conversation): only the one in view does, and only it is
                            // there for VoiceOver and the keyboard.
                            .allowsHitTesting(box == selected)
                            .accessibilityHidden(box != selected)
                    }
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
            .clipped()
            .opacity(wrapFade)
            .onAppear { width = proxy.size.width; motion.width = proxy.size.width }
            .onChange(of: proxy.size.width) { _, room in width = room; motion.width = room }
        }
        .background {
            if boxes.count > 1 {
                TrackpadSwipe(onDrag: drag, onEnd: settle)
            }
        }
        .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.9), value: index)
    }

    /// Fingers moved `dx` sideways: the pages follow (or go the other way, set so), with give past
    /// the first and the last, where no page lies beside (let go far enough, the line wraps round).
    private func drag(_ moved: CGFloat) {
        let dx = reverses ? -moved : moved
        let pulled = motion.offset + dx
        let pastEnd = (pulled > 0 && index == 0) || (pulled < 0 && index == boxes.count - 1)
        motion.offset = pastEnd ? motion.offset + dx * 0.3 : pulled
    }

    /// Fingers lifted, moving at `velocity` points a step: on to the next box when pulled far
    /// enough or flicked, else back. Past the last, the first; before the first, the last, faded
    /// in rather than slid past every page between.
    private func settle(_ speed: CGFloat) {
        let velocity = reverses ? -speed : speed
        // Past an end the pages give, so less pull goes there.
        let pastEnd = (motion.offset > 0 && index == 0) || (motion.offset < 0 && index == boxes.count - 1)
        let threshold = pastEnd ? max(width * 0.22 * 0.3, 24) : max(width * 0.22, 40)
        var step = 0
        if motion.offset < -threshold || velocity < -6 { step = 1 }
        if motion.offset > threshold || velocity > 6 { step = -1 }
        let target = (index + step + boxes.count) % boxes.count
        // Round the end: forward to the first, or back to the last (so with two, the other side).
        let wraps = (step == 1 && target < index) || (step == -1 && target > index)
        if wraps || reduceMotion {
            var quiet = Transaction()
            quiet.disablesAnimations = true
            withTransaction(quiet) {
                motion.offset = 0
                selected = boxes[target]
                wrapFade = 0.35
            }
            withAnimation(.easeOut(duration: 0.22)) { wrapFade = 1 }
            return
        }
        withAnimation(.spring(response: 0.38, dampingFraction: 0.9)) {
            motion.offset = 0
            selected = boxes[target]
        }
    }
}

/// The pages' track: rests on `index`, pulled by the motion's offset. Only this reads the offset.
private struct BoxTrack<Content: View>: View {
    let motion: BoxPagerMotion
    let index: Int
    let width: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        content
            .offset(x: -CGFloat(index) * width + motion.offset)
    }
}

/// Two fingers moving sideways over the view it backs: reported as they move (`onDrag`, in
/// points, rightward positive, as the fingers go whatever the scrolling direction) and as they
/// lift (`onEnd`, with the last step's speed). Up and down is left to the lists. Once a swipe is
/// sideways the list holds still, and what the trackpad carries on with after it is dropped.
/// Disabled (the sessions' sidebar under Settings, which lies where Settings' own is), it leaves
/// swipes to what's in view.
struct TrackpadSwipe: NSViewRepresentable {
    let onDrag: (CGFloat) -> Void
    let onEnd: (CGFloat) -> Void
    @Environment(\.isEnabled) private var isEnabled

    func makeNSView(context: Context) -> SwipeView {
        let view = SwipeView()
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: SwipeView, context: Context) {
        view.onDrag = onDrag
        view.onEnd = onEnd
        view.listens = isEnabled
    }

    final class SwipeView: NSView {
        var onDrag: (CGFloat) -> Void = { _ in }
        var onEnd: (CGFloat) -> Void = { _ in }
        /// It takes swipes only while it's enabled; one it was following when it stops ends there.
        var listens = true {
            didSet {
                guard !listens, way == .sideways else { return }
                way = .notOurs
                onEnd(0)
            }
        }

        private enum Way { case undecided, sideways, along, notOurs }
        private var way = Way.notOurs
        private var moved = CGSize.zero
        private var lastStep: CGFloat = 0
        /// The trackpad's carrying on after a sideways swipe: nothing scrolls with it.
        private var droppingMomentum = false
        private var monitor: Any?

        // Clicks go through to what's in front: it only listens.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                guard let self else { return event }
                return self.take(event)
            }
        }

        isolated deinit {
            if let monitor { NSEvent.removeMonitor(monitor) }
        }

        private func take(_ event: NSEvent) -> NSEvent? {
            guard event.window === window, event.hasPreciseScrollingDeltas else { return event }
            if !event.momentumPhase.isEmpty {
                let drops = droppingMomentum
                if event.momentumPhase == .ended || event.momentumPhase == .cancelled { droppingMomentum = false }
                return drops ? nil : event
            }
            if event.phase == .began {
                let inside = listens && bounds.contains(convert(event.locationInWindow, from: nil))
                way = inside ? .undecided : .notOurs
                moved = .zero
                lastStep = 0
                droppingMomentum = false
                return event
            }
            guard way != .notOurs else { return event }
            // As the fingers go: the deltas follow the scrolling direction set in System Settings.
            let step = event.isDirectionInvertedFromDevice ? event.scrollingDeltaX : -event.scrollingDeltaX
            switch event.phase {
            case .changed:
                if way == .undecided {
                    moved.width += event.scrollingDeltaX
                    moved.height += event.scrollingDeltaY
                    guard abs(moved.width) + abs(moved.height) > 6 else { return event }
                    way = abs(moved.width) > abs(moved.height) * 1.2 ? .sideways : .along
                    if way == .sideways { onDrag(event.isDirectionInvertedFromDevice ? moved.width : -moved.width) }
                    return way == .sideways ? nil : event
                }
                guard way == .sideways else { return event }
                lastStep = step
                onDrag(step)
                return nil
            case .ended, .cancelled:
                if way == .sideways {
                    onEnd(lastStep)
                    droppingMomentum = true
                }
                way = .notOurs
                // The list's own gesture ends too, however it went.
                return event
            default:
                return event
            }
        }
    }
}
