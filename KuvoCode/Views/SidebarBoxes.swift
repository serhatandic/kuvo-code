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

/// Above the sidebar's pages, staying put while they slide: your computers by name, in a line that
/// wraps around, the one in view lit at the start and those after it trailing off (after the
/// last, the first again). It follows a two-finger swipe as the pages do; a name clicked goes
/// there. A computer that needs you or has something new is marked, one that isn't connected
/// says so.
struct BoxNameStrip: View {
    let boxes: [SidebarBox]
    @Binding var selected: SidebarBox
    let motion: BoxPagerMotion
    /// Whether names carry their computer's news (the sidebar's), or only how it's connected
    /// (Settings').
    var marksNews = true
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var widths: [SidebarBox: CGFloat] = [:]
    /// Where the line stands: which of the names, laid out three times over, is the one in view.
    /// It moves to the nearest copy of the one picked, so the line only ever slides a step, and is
    /// brought back to the middle copy (which looks the same) once it rests.
    @State private var position = 0

    var body: some View {
        let names = boxes.map(name)
        NameTrack(names: names, widths: widths, position: position, motion: reduceMotion ? nil : motion) { index in
            pick(boxes[index % boxes.count])
        } measured: { box, width in
            widths[box] = width
        }
        .onAppear { position = boxes.count + (boxes.firstIndex(of: selected) ?? 0) }
        .onChange(of: boxes) { position = boxes.count + (boxes.firstIndex(of: selected) ?? 0) }
        .onChange(of: selected) { _, box in
            guard let at = boxes.firstIndex(of: box) else { return }
            let n = boxes.count
            // The copy of it nearest where the line stands.
            let nearest = [at, at + n, at + 2 * n].min { abs($0 - position) < abs($1 - position) }!
            withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.9)) {
                position = nearest
            } completion: {
                // Back to the middle copy, which looks the same: there's always a line either side.
                if position < n || position >= 2 * n { position = n + at }
            }
        }
        .padding(.horizontal, 6)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Computers")
    }

    private func pick(_ box: SidebarBox) {
        guard box != selected else { return }
        withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.9)) { selected = box }
    }

    /// A computer's name as the line shows it.
    private func name(_ box: SidebarBox) -> NameTrack.Name {
        let engine = app.machines.engine(box.machine)
        let isAway = engine.map { !$0.isReady } ?? false
        return NameTrack.Name(box: box, title: app.name(of: box), isOn: box == selected, isAway: isAway, isStopped: engine?.isStopped == true,
                              connection: isAway ? engine?.connection : nil, progress: engine?.installProgress, news: marksNews ? app.news(on: box) : nil)
    }
}

/// The names themselves, three times over, slid to where the line stands and pulled along with a
/// swipe. Only this reads the swipe's offset, so a swipe redraws the line and nothing else.
private struct NameTrack: View {
    struct Name {
        var box: SidebarBox
        var title: String
        var isOn: Bool
        var isAway: Bool
        var isStopped: Bool
        var connection: MachineEngine.Connection?
        /// How far its engine has come to it, while it's being installed there.
        var progress: Double?
        var news: BoxNews?
    }

    let names: [Name]
    let widths: [SidebarBox: CGFloat]
    let position: Int
    /// The pages' swipe, to follow; none with Reduce Motion.
    let motion: BoxPagerMotion?
    let pick: (Int) -> Void
    let measured: (SidebarBox, CGFloat) -> Void

    private static let spacing: CGFloat = 2
    private static let inset: CGFloat = 4

    /// Where the `index`th name starts along the line.
    private func start(of index: Int) -> CGFloat {
        guard !names.isEmpty else { return 0 }
        return (0..<index).reduce(0) { $0 + (widths[names[$1 % names.count].box] ?? 0) + Self.spacing }
    }

    var body: some View {
        let n = names.count
        // Pulled left, the next one comes toward the start; right, the one before.
        let pulled = motion.map { $0.width > 0 ? max(-1, min(1, $0.offset / $0.width)) : 0 } ?? 0
        let here = start(of: position)
        let shift = pulled < 0 ? start(of: position + 1) - here : here - start(of: max(position - 1, 0))
        // Over a line of the sidebar's width, so however long the names run they never widen it.
        Color.clear
            .frame(maxWidth: .infinity)
            .frame(height: 24)
            .overlay(alignment: .leading) {
                HStack(spacing: Self.spacing) {
                    ForEach(0..<(3 * n), id: \.self) { index in
                        let name = names[index % n]
                        label(name, lit: index == position) { pick(index) }
                            // One copy of each for VoiceOver and the keyboard: the middle one.
                            .accessibilityHidden(index / n != 1)
                            .onGeometryChange(for: CGFloat.self, of: \.size.width) { if index < n { measured(name.box, $0) } }
                    }
                }
                .fixedSize()
                .offset(x: Self.inset - here + pulled * shift)
            }
            .clipped()
            .mask {
                LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.04),
                                       .init(color: .black, location: 0.86), .init(color: .clear, location: 1)],
                               startPoint: .leading, endPoint: .trailing)
            }
    }

    private func label(_ name: Name, lit: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(name.title)
                    .font(.system(size: 12.5, weight: lit ? .semibold : .medium))
                    .foregroundStyle(lit ? AnyShapeStyle(.primary) : name.isAway ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 150, alignment: .leading)
                if let connection = name.connection {
                    MachineIndicator(connection: connection, size: 5, quiet: true, progress: name.progress)
                } else if let news = name.news {
                    Circle()
                        .fill(news == .needsYou ? AnyShapeStyle(.orange) : AnyShapeStyle(.tint))
                        .frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 22)
            .pickHighlight(RoundedRectangle(cornerRadius: 6), isOn: lit)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .help(name.title)
        .accessibilityLabel(name.title)
        .accessibilityValue(name.isAway ? (name.isStopped ? "Stopped" : name.progress.map { "Installing, \(Int(($0 * 100).rounded())) percent" } ?? "Not connected") : name.news?.said ?? "")
        .accessibilityAddTraits(name.isOn ? .isSelected : [])
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
    /// A page's width, for how far that is in pages (the name strip follows it).
    var width: CGFloat = 0
}

/// Pages side by side, one in view, that follow two fingers sideways on the trackpad as Arc's
/// and Dia's spaces do: the pages slide with them and, as they lift, go on to the next box (or
/// spring back); past the last comes the first again, and before the first the last. A box
/// picked otherwise (the name strip, a tab on another box) slides in too. The strip above shares
/// `motion`, to follow the swipe.
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
