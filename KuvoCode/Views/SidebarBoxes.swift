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

/// Above the sidebar's pages, staying put while they slide: your computers by name on one line, as
/// the phone's strip has them. The one in view comes first, large and bold; the others follow it
/// (past the last, the first again) in the same size, faded, trailing off at the end of the line,
/// and "+3" stands for those that don't show whole, opening a menu of them with how each is and
/// Add Machine…. Picking another slides the line a step, so it comes first. A name too long for the
/// line is cut at its end, never in the middle. A computer that needs you or has something new is
/// marked, one that isn't connected says so, and so does the count when one of those it stands for
/// does.
struct BoxNameStrip: View {
    let boxes: [SidebarBox]
    @Binding var selected: SidebarBox
    /// Whether names carry their computer's news (the sidebar's), or only how it's connected
    /// (Settings').
    var marksNews = true
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.messageFont) private var messageFont
    /// Each name's width as it shows whole, measured off screen, so what fits is known before it's shown.
    @State private var widths: [SidebarBox: CGFloat] = [:]
    @State private var moreWidth: CGFloat = 0
    @State private var room: CGFloat = 0
    /// Where the line stands: the place of the one in view, counted on past the last (a computer's
    /// place is this modulo how many there are). Each name keeps its place as the line slides, so
    /// picking the next one moves every name a step, and the one that was first goes as the one
    /// after the last comes in.
    @State private var position = 0

    /// The names' size: a step up from the rows' 12.5 ("a bit bigger, not more").
    static let size: CGFloat = 14
    /// Between one name's words and the next one's.
    static let spacing: CGFloat = 14
    /// Around a name's words, for the fill under the pointer to clear them.
    static let pad: CGFloat = 6
    /// Where the first name's words begin: in line with the sections' headings below.
    static let inset: CGFloat = 10

    var body: some View {
        let count = boxes.count
        let places = Array(position..<(position + count))
        let order = places.map { boxes[Self.wrapped($0, count)] }
        let names = order.map(name)
        let fit = Self.fit(widths: order.map { widths[$0] }, room: room, more: moreWidth)
        let hidden = Set(fit.hidden)
        // Until every name is measured, what fits isn't known: nothing rather than a jump.
        let measured = room > 0 && boxes.allSatisfy { widths[$0] != nil }
        HStack(spacing: 0) {
            // Over a line of the room it's offered, so however long the names run they never widen it.
            Color.clear
                .frame(maxWidth: .infinity)
                .overlay(alignment: .leading) {
                    HStack(spacing: Self.spacing - 2 * Self.pad) {
                        ForEach(Array(zip(places, names).enumerated()), id: \.element.0) { step, item in
                            let name = item.1
                            label(name, most: step == 0 ? fit.most : nil)
                                // Only those that show whole are buttons: the rest, fading out or out of
                                // sight, take no clicks (a clipped view still would, past the line's end
                                // over the window's other cards), nor the keyboard, nor VoiceOver; the
                                // count's menu has them. Nor any before it's known what fits.
                                .allowsHitTesting(!hidden.contains(step))
                                .disabled(hidden.contains(step))
                                .accessibilityHidden(!measured || hidden.contains(step))
                                .transition(.opacity)
                        }
                    }
                    .fixedSize()
                    .padding(.leading, Self.inset - Self.pad)
                }
                .clipped()
                .mask {
                    // Once names trail off, the first that doesn't fit whole fades out where it begins,
                    // to the count; those before it show clear. Along the line as it is (the count is
                    // often narrower than at its widest, which the layout allows for).
                    GeometryReader { geometry in
                        let width = max(geometry.size.width, 1)
                        let from = hidden.isEmpty ? 1 : min(fit.fadesFrom / width, 1)
                        let to = hidden.isEmpty || fit.fadesTo > fit.fadesFrom ? 1 : from
                        LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: from),
                                               .init(color: hidden.isEmpty ? .black : .clear, location: to)],
                                       startPoint: .leading, endPoint: .trailing)
                    }
                }
            if !hidden.isEmpty {
                more(fit.hidden.map { names[$0] })
                    // Its words end where the sections' controls below do.
                    .padding(.trailing, Self.inset - Self.pad)
                    .accessibilityHidden(!measured)
                    .transition(.opacity)
            }
        }
        .opacity(measured ? 1 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: (28 * messageFont.sidebarScale).rounded())
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { room = $0 }
        .background(alignment: .topLeading) {
            // Every name as it shows whole, and the count at its widest, to measure: never seen.
            HStack(spacing: Self.spacing) {
                ForEach(boxes, id: \.self) { box in
                    label(name(box), most: nil)
                        .onGeometryChange(for: CGFloat.self, of: \.size.width) { widths[box] = $0 }
                }
                moreLabel(count: boxes.count, mark: .new)
                    .padding(.trailing, Self.inset - Self.pad)
                    .onGeometryChange(for: CGFloat.self, of: \.size.width) { moreWidth = $0 }
            }
            .fixedSize()
            .hidden()
            .accessibilityHidden(true)
        }
        .onAppear { position = boxes.firstIndex(of: selected) ?? 0 }
        .onChange(of: boxes) { position = boxes.firstIndex(of: selected) ?? 0 }
        .onChange(of: selected) { slide(to: selected) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Computers")
    }

    /// `place` among `count`, however far the line has gone round (either way).
    static func wrapped(_ place: Int, _ count: Int) -> Int {
        count > 0 ? ((place % count) + count) % count : 0
    }

    /// The line moved on to `box`, the shorter way round, a step at a time.
    private func slide(to box: SidebarBox) {
        let count = boxes.count
        guard count > 0, let target = boxes.firstIndex(of: box) else { return }
        var steps = Self.wrapped(target - position, count)
        if steps > count / 2 { steps -= count }
        guard steps != 0 else { return }
        withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.9)) { position += steps }
    }

    /// How the line lays out its names, in its order (the one in view first).
    struct Fit: Equatable {
        /// Those that don't show whole, by their place in the line: what "+3" stands for.
        var hidden: [Int] = []
        /// Where each name's fill begins along the line.
        var starts: [CGFloat] = []
        /// The line's length, short of the count when there is one.
        var line: CGFloat = 0
        /// How wide the name in view may be (its words, mark and padding), its words cut at their
        /// end past that.
        var most: CGFloat?
        /// Where the line starts to fade out, while names trail off: where the words of the first
        /// that doesn't fit whole begin. It's gone by the line's end, or at once where too little of
        /// it would show to read.
        var fadesFrom: CGFloat = 0
        var fadesTo: CGFloat = 0
    }

    /// Lays out names `widths` wide (each with its padding; nil until measured), the one in view
    /// first, in `room` with a count `more` wide: every name, and no count, when all fit; else the
    /// one in view (its words cut at their end if they have to be), those after it that fit whole
    /// before the count, fill and all, and the rest counted, the first of them fading out where it
    /// begins.
    static func fit(widths: [CGFloat?], room: CGFloat, more: CGFloat) -> Fit {
        let gap = spacing - 2 * pad
        let lead = inset - pad
        guard room > 0, !widths.isEmpty, widths.allSatisfy({ $0 != nil }) else { return Fit(line: room) }
        let known = widths.map { $0! }
        var starts: [CGFloat] = []
        var end = lead
        for width in known {
            starts.append(end)
            end += width + gap
        }
        let whole = end - gap
        guard known.count > 1, whole > room else {
            // All of them fit, or it's alone: the one in view cut only if it can't fit at all.
            return Fit(starts: starts, line: room, most: max(room - lead, 40))
        }
        let line = room - more
        // (Its trailing padding may run on under the count: the one in view shows no fill.)
        let most = max(line - lead + pad, 40)
        // Where the names after the one in view begin, once it's cut.
        let cut = known[0] - min(known[0], most)
        starts = starts.enumerated().map { $0 == 0 ? $1 : $1 - cut }
        // The first that runs past the line's end, its fill under the pointer too, and those after it.
        let first = known.indices.dropFirst().first { starts[$0] + known[$0] > line } ?? known.count
        let hidden = Array(first..<known.count)
        // Its words fade out from where they begin to the count; a sliver of them (a letter's
        // stroke) not at all.
        let fadesFrom = first < known.count ? starts[first] + pad : line
        return Fit(hidden: hidden, starts: starts, line: line, most: most, fadesFrom: fadesFrom, fadesTo: line - fadesFrom < 28 ? fadesFrom : line)
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

    /// A name, with its mark; `most`: as wide as the one in view may be, cut at its end past that.
    private func label(_ name: Name, most: CGFloat?) -> some View {
        Button { pick(name.box) } label: {
            StripName(name: name, most: most)
        }
        // The one in view is where you are already: nothing to show under the pointer.
        .buttonStyle(StripNameStyle(isOn: !name.isOn))
        .help(name.title)
        .accessibilityLabel(name.title)
        .accessibilityValue(name.said ?? "")
        .accessibilityAddTraits(name.isOn ? .isSelected : [])
        .contextMenu {
            // As a mailbox's in Mail: everything new on that computer read (the sidebar's strip).
            if marksNews {
                Button("Mark All as Read") { app.markAllRead(on: [name.box]) }
                    .disabled(!app.hasNew(on: name.box))
            }
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
                .modifier(StripHover())
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
                .sidebarFont(13, weight: .semibold)
                .monospacedDigit()
            switch mark {
            case .failed: MachineIndicator(connection: .failed, size: 6, quiet: true)
            case .needsYou: NewsDot(news: .needsYou)
            case .new: NewsDot(news: .new)
            case nil: EmptyView()
            }
        }
        .padding(.horizontal, Self.pad)
        .frame(height: 24)
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

/// A computer's name in the strip: the one in view in full ink, the others faded (a machine that
/// isn't connected more so), each brought up to full ink with a soft fill under the pointer, as the
/// app's chrome-less controls are. Its mark after it: how it's connected while it isn't, else its
/// news.
private struct StripName: View {
    let name: BoxNameStrip.Name
    let most: CGFloat?
    @Environment(\.stripHovered) private var hovered

    var body: some View {
        HStack(spacing: 6) {
            Text(name.title)
                .sidebarFont(BoxNameStrip.size, weight: .bold)
                .foregroundStyle(name.isOn || hovered ? AnyShapeStyle(.primary) : name.isAway ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.tertiary))
                .lineLimit(1)
                .truncationMode(.tail)
            // Its mark keeps its room: a name cut short is cut in its words.
            Group {
                if let connection = name.connection {
                    MachineIndicator(connection: connection, size: 6, quiet: true, progress: name.progress)
                } else if let news = name.news {
                    NewsDot(news: news)
                }
            }
            .fixedSize()
        }
        .padding(.horizontal, BoxNameStrip.pad)
        // As wide as it is, never the room it's offered, up to where it's cut.
        .frame(maxWidth: most ?? .infinity, alignment: .leading)
        .fixedSize(horizontal: true, vertical: false)
        .frame(height: 26)
    }
}

/// A name in the strip as a button: the strip's hover, and a deeper fill while pressed.
private struct StripNameStyle: ButtonStyle {
    let isOn: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.modifier(StripHover(isOn: isOn, isPressed: configuration.isPressed))
    }
}

/// Under the pointer: a soft fill behind it (deeper while pressed), its words in full ink, and the
/// pointing hand, as `Pressable` has the app's chrome-less controls.
private struct StripHover: ViewModifier {
    var isOn = true
    var isPressed = false
    @State private var isHovering = false

    func body(content: Content) -> some View {
        let hovering = isOn && isHovering
        content
            .foregroundStyle(hovering ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            .environment(\.stripHovered, hovering)
            .background(isOn && isPressed ? Pressable.pressedFill : hovering ? Pressable.hoverFill : .clear, in: .rect(cornerRadius: 6))
            .contentShape(.rect(cornerRadius: 6))
            .onHover { isHovering = $0 }
            .pointerStyle(isOn ? .link : nil)
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

private extension EnvironmentValues {
    /// The strip's name under the pointer, for its words to come up to full ink.
    @Entry var stripHovered = false
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
        return hasNew(on: box) ? .new : nil
    }

    /// Whether `box` has something you haven't read (a conversation, a sub-session's finish, a group
    /// chat): what Mark All as Read reads.
    func hasNew(on box: SidebarBox) -> Bool {
        let sessions = workspace.sessions.filter { SidebarBox(directory: $0.location.directory) == box && !Workspace.isArchived($0) }
        // A session's sub-session finished since you read it is news too, as its folded row says.
        return sessions.contains(where: { $0.isUnread || workspace.hasNewSubSessions($0.id) }) || chats.list.contains(where: { SidebarBox(machine: chats.machine(of: $0.id)) == box && chats.isUnread($0) })
    }

    /// Mark All as Read on `boxes` (every computer, or one), through each box.
    func markAllRead(on boxes: [SidebarBox]) {
        let ids = boxes.filter(hasNew(on:)).map { $0.machine ?? BoxClient.mac }
        guard !ids.isEmpty else { return }
        Task { await workspace.markAllRead(on: ids) }
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
                            // Its rows count as on screen only while it's in view.
                            .environment(\.pageInView, box == selected)
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
        // A row's card goes with its page.
        .onChange(of: index) { GlanceCardPanel.shared.hide() }
    }

    /// Fingers moved `dx` sideways: the pages follow (or go the other way, set so), with give past
    /// the first and the last, where no page lies beside (let go far enough, the line wraps round).
    private func drag(_ moved: CGFloat) {
        GlanceCardPanel.shared.hide()
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
