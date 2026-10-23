import AppKit
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

/// Above the sidebar's pages, staying put while they slide: the computer in view by name, and every
/// computer's icon to switch with beside the two-finger swipe (the one in view lit, a machine that
/// needs you or is connecting marked).
struct BoxSwitchLine: View {
    let boxes: [SidebarBox]
    @Binding var selected: SidebarBox
    @Environment(AppModel.self) private var app
    @Namespace private var lit

    var body: some View {
        HStack(spacing: 6) {
            Text(app.name(of: selected))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .contentTransition(.opacity)
            Spacer(minLength: 8)
            HStack(spacing: 0) {
                ForEach(boxes) { box in
                    let isOn = box == selected
                    Button {
                        guard !isOn else { return }
                        withAnimation(.spring(response: 0.38, dampingFraction: 0.9)) { selected = box }
                    } label: {
                        Image(systemName: box.symbol)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(isOn ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                            .overlay(alignment: .topTrailing) {
                                if let connection = app.machines.engine(box.machine)?.connection {
                                    MachineIndicator(connection: connection, size: 5, quiet: true)
                                        .offset(x: 4, y: -2)
                                }
                            }
                    }
                    .buttonStyle(IconButtonStyle(width: 24, height: 20))
                    .background {
                        if isOn {
                            RoundedRectangle(cornerRadius: 6)
                                .fill(Pressable.hoverFill)
                                .matchedGeometryEffect(id: "lit", in: lit)
                        }
                    }
                    .help(app.name(of: box))
                    .accessibilityLabel(app.name(of: box))
                    .accessibilityAddTraits(isOn ? .isSelected : [])
                }
            }
        }
        .frame(height: 22)
        .padding(.leading, 10)
        .padding(.trailing, 4)
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
}

/// Pages side by side, one in view, that follow two fingers sideways on the trackpad as Arc's
/// and Dia's spaces do: the pages slide with them and, as they lift, go on to the next box (or
/// spring back). A box picked otherwise (the switcher, a tab on another box) slides in too.
struct BoxPager<Page: View>: View {
    let boxes: [SidebarBox]
    @Binding var selected: SidebarBox
    @ViewBuilder let page: (SidebarBox) -> Page

    @State private var motion = BoxPagerMotion()
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
                            // (over the conversation): only the one in view does.
                            .allowsHitTesting(box == selected)
                    }
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
            .clipped()
            .onAppear { width = proxy.size.width }
            .onChange(of: proxy.size.width) { _, room in width = room }
        }
        .background {
            if boxes.count > 1 {
                TrackpadSwipe(onDrag: drag, onEnd: settle)
            }
        }
        .animation(.spring(response: 0.38, dampingFraction: 0.9), value: index)
    }

    /// Fingers moved `dx` sideways: the pages follow (or go the other way, set so), with give past
    /// the first and the last.
    private func drag(_ moved: CGFloat) {
        let dx = reverses ? -moved : moved
        let pulled = motion.offset + dx
        let pastEnd = (pulled > 0 && index == 0) || (pulled < 0 && index == boxes.count - 1)
        motion.offset = pastEnd ? motion.offset + dx * 0.3 : pulled
    }

    /// Fingers lifted, moving at `velocity` points a step: on to the next box when pulled far
    /// enough or flicked, else back.
    private func settle(_ speed: CGFloat) {
        let velocity = reverses ? -speed : speed
        let threshold = max(width * 0.22, 40)
        var target = index
        if (motion.offset < -threshold || velocity < -6) && index < boxes.count - 1 { target += 1 }
        if (motion.offset > threshold || velocity > 6) && index > 0 { target -= 1 }
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
