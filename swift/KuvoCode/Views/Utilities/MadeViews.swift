import AppKit
import ClientDesign
import KuvoLink
import OpenCodeKit
import PDFKit
import Quartz
import SwiftUI

/// Where something was made, as the conversation's bar shows it: a bot's, a group chat's, or a
/// coding session's (which shows only what isn't code: its Changes are in the panel).
enum MadePlace: Equatable {
    case bot(Bot)
    case group(BotGroup, box: String)
    case session(String, box: String)

    var scope: ArtifactScope {
        switch self {
        case .bot(let bot): .bot(bot.id)
        case .group(let group, _): .group(group.id)
        case .session(let id, _): .session(id)
        }
    }

    var box: String {
        switch self {
        case .bot(let bot): bot.machine ?? BoxClient.mac
        case .group(_, let box), .session(_, let box): box
        }
    }

    var key: String { "\(box)|\(scope)" }

    /// The button's words, and the popover's title.
    var title: String {
        switch self {
        case .bot(let bot): "What \(bot.name) Made"
        case .group: "What the Chat Made"
        case .session: "What This Session Made"
        }
    }

    var isSession: Bool { if case .session = self { true } else { false } }
    var isGroup: Bool { if case .group = self { true } else { false } }

    /// What it shows: a session, only what it made besides code.
    func shows(_ artifact: ArtifactSummary) -> Bool {
        isSession ? ArtifactWords.isOutput(artifact) : true
    }
}

// MARK: - The button

/// The button on a conversation's bar that shows what was made there, in a popover over the
/// conversation, as other coding apps show a task's outputs. It follows the record while the
/// conversation shows, for its dot: something new since you last looked. A coding session's shows
/// only once the session has made something besides code.
struct MadeButton: View {
    let place: MadePlace
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var scheme
    @State private var things: MadeThings?
    @State private var isOpen = false
    /// When you last looked, by place, on this Mac: the newest thing's time then.
    @AppStorage("made.seen") private var seen: String = "{}"

    var body: some View {
        HStack(spacing: 0) {
            if let things, isShown(things) {
                Button { isOpen.toggle() } label: {
                    Label(title, systemImage: "tray.full")
                }
                .buttonStyle(CardActionStyle())
                .background(isOpen ? Pressable.hoverFill : .clear, in: .rect(cornerRadius: 6))
                .overlay(alignment: .topTrailing) {
                    if hasNew(things) {
                        Circle()
                            .fill(.tint)
                            .frame(width: 6, height: 6)
                            .offset(x: -4, y: 4)
                            .allowsHitTesting(false)
                    }
                }
                .help(title)
                .accessibilityLabel(title)
                .accessibilityValue(hasNew(things) ? "Something new" : "")
                .closesWhenKept($isOpen)
                .popover(isPresented: $isOpen, arrowEdge: .bottom) {
                    MadePopover(things: things, place: place) { isOpen = false }
                    .popoverContent()
                        // The conversation card's own surface, edge to edge: the popover's see-through
                        // material showed the window under one part and the desktop under another.
                        .presentationBackground(Surface.cardFill(scheme, focused: true))
                }
                .onChange(of: isOpen) { _, open in if open { markSeen(things) } }
                .onChange(of: newest(things)) { if isOpen { markSeen(things) } }
            }
            // Always there, for the record to be followed before the button shows (an empty
            // stack would never start its task).
            Color.clear.frame(width: 0, height: 0)
        }
        .task(id: place.key) {
            let made = MadeThings(box: app.box(place.box), scope: place.scope)
            things = made
            await made.follow()
        }
        .onChange(of: things?.state) { _, state in
            guard state == .loaded, let things else { return }
            // The first time a bot's or a group chat's is read here, what it has is what you've
            // seen. (A session's first output is news: it has no record until you look.)
            if !place.isSession, seenTimes[place.key] == nil { store(newest(things)) }
            #if DEBUG
            // KUVO_DEMO_MADE: the popover open (`open`, `timeline`, or a thing's name to open it), for screenshots.
            if let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_MADE"], !demo.isEmpty, !isOpen {
                if demo == "timeline" { things.mode = .timeline }
                // After the window has settled, so it points at the button.
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    isOpen = true
                }
            }
            #endif
        }
    }

    private var title: String { place.title }

    private func isShown(_ things: MadeThings) -> Bool {
        !place.isSession || things.artifacts.contains(where: place.shows)
    }

    private func newest(_ things: MadeThings) -> Double {
        ArtifactWords.newest(things.artifacts.filter(place.shows))
    }

    private var seenTimes: [String: Double] {
        (try? JSONDecoder().decode([String: Double].self, from: Data(seen.utf8))) ?? [:]
    }

    private func hasNew(_ things: MadeThings) -> Bool {
        guard let last = seenTimes[place.key] ?? (place.isSession ? 0 : nil) else { return false }
        return newest(things) > last
    }

    private func markSeen(_ things: MadeThings) { store(newest(things)) }

    private func store(_ time: Double) {
        var times = seenTimes
        times[place.key] = time
        if let data = try? JSONEncoder().encode(times), let text = String(data: data, encoding: .utf8) { seen = text }
    }
}

// MARK: - The popover

/// What was made in a conversation, in its popover: a bot's Shelf (its Timeline a click away), a
/// group chat's Timeline (a face per bot, one bot's on its own), a coding session's outputs besides
/// code. Something opened shows over the list, which keeps its place underneath.
struct MadePopover: View {
    @Bindable var things: MadeThings
    let place: MadePlace
    let close: () -> Void
    @Environment(AppModel.self) private var app
    @State private var opened: ArtifactHeader?
    /// What its list takes: all of it as laid out, the part that scrolls, and that part's own rows.
    @State private var listFrame: CGFloat = 0
    @State private var contentFrame: CGFloat = 0
    @State private var rows: CGFloat?

    var body: some View {
        ZStack {
            list
                .offset(x: opened == nil ? 0 : -40)
                .opacity(opened == nil ? 1 : 0)
                .allowsHitTesting(opened == nil)
                .accessibilityHidden(opened != nil)
            if let opened {
                ArtifactDetail(things: things, header: opened, back: backTitle, close: close) {
                    withAnimation(.ui) { self.opened = nil }
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .frame(width: 400, height: height)
        #if DEBUG
        .task {
            // KUVO_DEMO_MADE=<a thing's name>: it opened, for screenshots.
            guard let name = ProcessInfo.processInfo.environment["KUVO_DEMO_MADE"], !["open", "timeline"].contains(name) else { return }
            for _ in 0..<20 where opened == nil {
                if let found = things.artifacts.first(where: { $0.name == name }) { opened = found.header } else { try? await Task.sleep(for: .milliseconds(200)) }
            }
        }
        #endif
        // The Timeline, while it shows (the list is followed by the button, for its dot).
        .task(id: "\(showsTimeline)|\(things.only ?? "")") {
            if showsTimeline { await things.followTimeline() }
        }
    }

    /// As tall as its list, up to as tall as there's room for; a thing opened from it gets all of that.
    private var height: CGFloat {
        let room = (NSScreen.main?.visibleFrame.height ?? 800) - 160
        let most = min(560, max(room, 260))
        // Nothing made yet: room for its few words, not a tall empty box.
        if opened == nil, isEmpty { return 260 }
        guard opened == nil, let rows, listFrame > contentFrame else { return most }
        return min(most, max(220, listFrame - contentFrame + rows))
    }

    /// Loaded, with nothing to list.
    private var isEmpty: Bool {
        guard case .loaded = showsTimeline ? things.timelineState : things.state else { return false }
        return showsTimeline ? things.entries.isEmpty : shown.isEmpty || (!place.isSession && ArtifactWords.shelf(things.artifacts).isEmpty)
    }

    private var showsTimeline: Bool { place.isGroup || (!place.isSession && things.mode == .timeline) }

    private var shown: [ArtifactSummary] { things.artifacts.filter(place.shows) }

    private var backTitle: String {
        if place.isSession { return "Made" }
        return showsTimeline ? "Timeline" : "Shelf"
    }

    private var list: some View {
        VStack(spacing: 0) {
            header
            if case .bot = place { ModeTabs(selection: $things.mode) }
            content
                .onGeometryChange(for: CGFloat.self, of: \.size.height) { contentFrame = $0 }
                .onPreferenceChange(MadeRowsHeight.self) { rows = $0 }
            if place.isSession { changesNote }
        }
        .onGeometryChange(for: CGFloat.self, of: \.size.height) { listFrame = $0 }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            Text(heading)
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            if case .group(let group, _) = place { botFilter(group) }
        }
        .padding(.leading, 16)
        .padding(.trailing, 10)
        // A bot's title stays where every other one is, and its tabs sit close under it.
        .padding(.top, hasTabs ? 12 : 0)
        .frame(height: hasTabs ? 30 : 40, alignment: hasTabs ? .top : .center)
    }

    private var hasTabs: Bool { if case .bot = place { true } else { false } }

    private var heading: String { place.title }

    /// A coding session's changes to tracked files are in the panel. Its words wrap rather
    /// than cut off, beside a button that keeps its size.
    private var changesNote: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 8) {
                Text("Changes to tracked files are in the side panel.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button("Show Changes") {
                    close()
                    app.utilities.revealChanges()
                }
                .buttonStyle(TextButtonStyle(outset: true))
                .fixedSize()
            }
            .font(.system(size: 12))
            .padding(.horizontal, 16)
            .padding(.vertical, 9)
            .frame(minHeight: 36)
            .accessibilityElement(children: .contain)
        }
    }

    /// Who to show in a group chat's Timeline: everyone, or one bot (asked of its computer).
    private func botFilter(_ group: BotGroup) -> some View {
        Menu {
            Picker("Show", selection: $things.only) {
                Text("Everyone").tag(String?.none)
                Divider()
                ForEach(group.members, id: \.self) { member in
                    Text(app.bots.bot(member)?.name ?? "A bot that left").tag(Optional(member))
                }
            }
            .pickerStyle(.inline)
        } label: {
            HStack(spacing: 5) {
                if let only = things.only, let bot = app.bots.bot(only) {
                    BotAvatar(look: bot.look, size: 14, animates: false)
                    Text(bot.name)
                } else {
                    Text("Everyone")
                }
                MenuChevron()
            }
            .font(.system(size: 12.5, weight: .medium))
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
        .fixedSize()
        .help("Show what one bot made, or everyone")
        .accessibilityLabel("Show")
        .accessibilityValue(things.only.flatMap { app.bots.bot($0)?.name } ?? "Everyone")
    }

    // MARK: Content

    private var content: some View {
        // One over the other, so the placeholder and the list cross-fade.
        ZStack {
            switch showsTimeline ? things.timelineState : things.state {
            case .loading:
                Placeholder(.rows(count: 4))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 9)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            case .failed(let why):
                MadeNotice(symbol: "exclamationmark.triangle", title: "Can’t Show What Was Made", detail: why)
                    .transition(.replacingPlaceholder)
            case .loaded:
                Group {
                    if showsTimeline {
                        if things.entries.isEmpty {
                            empty
                        } else {
                            TimelineList(things: things, colored: place.isGroup, open: open)
                        }
                    } else if isEmpty {
                        empty
                    } else if place.isSession {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(shown) { artifact in
                                    MadeRow(things: things, header: artifact.header, version: artifact.latest, versions: artifact.versions) { open(artifact.header) }
                                }
                            }
                            .padding(.vertical, 4)
                            .padding(.bottom, 8)
                            .reportsMadeRowsHeight()
                        }
                    } else {
                        ShelfList(things: things, open: open)
                    }
                }
                .transition(.replacingPlaceholder)
            }
        }
    }

    private var empty: some View {
        let detail = switch place {
        case .bot(let bot): "What \(bot.name) writes, makes and keeps in its memory shows up here, with every version."
        case .group: things.only == nil ? "What the bots in this chat write and make shows up here, each with its face." : "This bot hasn’t made anything in this chat yet."
        case .session: "Pictures, documents and other files this session makes show up here. Changes to tracked files are in the side panel."
        }
        return MadeNotice(symbol: "tray", title: "Nothing Made Yet", detail: detail)
    }

    private func open(_ header: ArtifactHeader) {
        withAnimation(.ui) { opened = header }
    }
}

// MARK: - Shelf or Timeline

/// A bot's two ways to look at what it made, as quiet tabs under the title (the arrow over the
/// popover points at its title, not at them): the one showing underlined.
private struct ModeTabs: View {
    @Binding var selection: MadeThings.Mode
    @Namespace private var underline

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 18) {
                ModeTab(title: "Shelf", isOn: selection == .shelf, underline: underline) { pick(.shelf) }
                ModeTab(title: "Timeline", isOn: selection == .timeline, underline: underline) { pick(.timeline) }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .zIndex(1)
            Divider()
        }
        // VoiceOver reads it as the segmented picker it is: "Shelf, selected, 1 of 2".
        .accessibilityRepresentation {
            Picker("Show", selection: $selection) {
                Text("Shelf").tag(MadeThings.Mode.shelf)
                Text("Timeline").tag(MadeThings.Mode.timeline)
            }
            .pickerStyle(.segmented)
        }
    }

    private func pick(_ mode: MadeThings.Mode) {
        withAnimation(.ui) { selection = mode }
    }
}

private struct ModeTab: View {
    let title: String
    let isOn: Bool
    let underline: Namespace.ID
    let pick: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: pick) {
            // As wide as its bold self either way, so picking one never nudges the other.
            Text(title)
                .font(.system(size: 12.5, weight: .semibold))
                .hidden()
                .overlay(alignment: .leading) {
                    Text(title)
                        .font(.system(size: 12.5, weight: isOn ? .semibold : .regular))
                        .foregroundStyle(isOn || isHovered ? .primary : .secondary)
                }
                .frame(height: 28)
                .overlay(alignment: .bottom) {
                    if isOn {
                        Rectangle()
                            .fill(.primary)
                            .frame(height: 2)
                            .matchedGeometryEffect(id: "underline", in: underline)
                            // Over the hairline under the row, not stacked on it.
                            .offset(y: 1)
                    }
                }
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .onHover { isHovered = $0 }
    }
}

// MARK: - Shelf

/// A bot's Shelf: what it marked final first, then its memory (its latest change in its words),
/// pages, documents, images, skills and downloads, with its other files folded at the end.
private struct ShelfList: View {
    let things: MadeThings
    let open: (ArtifactHeader) -> Void
    @State private var showsOther = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(ArtifactWords.shelf(things.artifacts), id: \.section) { shelf in
                    switch shelf.section {
                    case .images:
                        SectionTitle(title: shelf.section.rawValue, count: shelf.artifacts.count)
                        ImageGrid(things: things, images: shelf.artifacts, open: open)
                    case .other:
                        otherFiles(shelf.artifacts)
                    default:
                        SectionTitle(title: shelf.section.rawValue, count: shelf.artifacts.count)
                        ForEach(shelf.artifacts) { artifact in
                            if artifact.name == "MEMORY.md", shelf.section == .memory {
                                MemoryCard(things: things, artifact: artifact) { open(artifact.header) }
                            } else {
                                MadeRow(things: things, header: artifact.header, version: artifact.latest, versions: artifact.versions) { open(artifact.header) }
                            }
                        }
                    }
                }
                if things.next != nil {
                    Button("Show More") { Task { await things.more() } }
                        .buttonStyle(TextButtonStyle(outset: true))
                        .font(.system(size: 12))
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                }
            }
            .padding(.bottom, 12)
            .reportsMadeRowsHeight()
        }
    }

    /// Code and other files, folded: the Shelf is for what the bot made for you.
    @ViewBuilder private func otherFiles(_ artifacts: [ArtifactSummary]) -> some View {
        Button {
            withAnimation(.ui) { showsOther.toggle() }
        } label: {
            HStack(spacing: 5) {
                Text("Other Files")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.secondary)
                Text("\(artifacts.count)")
                    .font(.system(size: 13))
                    .foregroundStyle(.tertiary)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(showsOther ? 0 : -90))
                    .accessibilityHidden(true)
                Spacer()
            }
            .frame(height: 22)
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 2)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .help(showsOther ? "Hide Other Files" : "Show Other Files")
        .accessibilityValue(showsOther ? "Expanded" : "Collapsed")
        if showsOther {
            ForEach(artifacts) { artifact in
                MadeRow(things: things, header: artifact.header, version: artifact.latest, versions: artifact.versions) { open(artifact.header) }
            }
        }
    }
}

private struct SectionTitle: View {
    let title: String
    let count: Int

    var body: some View {
        HStack(spacing: 5) {
            Text(title)
                .fontWeight(.medium)
                .foregroundStyle(.secondary)
            // A count only where there are enough to count.
            if count >= 5 { Text("\(count)").foregroundStyle(.tertiary) }
            Spacer()
        }
        .font(.system(size: 13))
        .frame(height: 22)
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A bot's memory on its Shelf: its latest change, read in its words.
private struct MemoryCard: View {
    let things: MadeThings
    let artifact: ArtifactSummary
    let open: () -> Void
    @State private var changes: ArtifactChanges?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(ArtifactWords.when(artifact.latest.at))
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    if let lines = artifact.latest.lines { MadeDiffStat(lines: lines) }
                }
                if case .words(let lines, _, _) = changes {
                    let changed = lines.filter { if case .folded = $0 { false } else if case .same = $0 { false } else { true } }
                    ChangedWords(lines: Array(changed.prefix(3)), lineLimit: 3, selectable: false)
                        .font(.system(size: 13))
                        .lineSpacing(2)
                } else {
                    Text(artifact.name)
                        .font(.system(size: 13, weight: .medium))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Surface.well(scheme), in: .rect(cornerRadius: 10))
            .contentShape(.rect(cornerRadius: 10))
            .hoverHighlight(in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Its memory")
        .accessibilityHint("Shows its memory and every version")
        .task(id: artifact.latest.n) {
            changes = try? await things.changes(of: artifact.id, version: artifact.latest.n)
        }
    }
}

/// Pictures as thumbnails, newest first: two rows of them, the rest a click away.
private struct ImageGrid: View {
    let things: MadeThings
    let images: [ArtifactSummary]
    let open: (ArtifactHeader) -> Void
    @State private var showsAll = false

    var body: some View {
        let shown = showsAll ? images : Array(images.prefix(8))
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 4), spacing: 6) {
            ForEach(shown) { image in
                Button { open(image.header) } label: {
                    Thumbnail(things: things, id: image.id, version: image.latest.kept && image.latest.status != .deleted ? image.latest.n : nil, side: 90)
                        .aspectRatio(1, contentMode: .fit)
                        .clipShape(.rect(cornerRadius: 8))
                        .specularRim(RoundedRectangle(cornerRadius: 8), strength: 0.7)
                        .contentShape(.rect(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .clickablePointer()
                .help(image.name)
                .accessibilityLabel(image.name)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        if images.count > shown.count {
            Button("Show All \(images.count)") { withAnimation(.ui) { showsAll = true } }
                .buttonStyle(TextButtonStyle(outset: true))
                .font(.system(size: 12))
                .padding(.horizontal, 16)
                .padding(.top, 2)
        }
    }
}

/// A picture's version, small, or its kind's symbol while it comes (or if it can't).
private struct Thumbnail: View {
    let things: MadeThings
    let id: String
    /// Nil for one with no copy to show (cleared, or deleted): its symbol.
    let version: Int?
    let side: CGFloat
    var symbol = "photo"
    @State private var image: NSImage?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        // As big as it's given, the picture filling it.
        Rectangle()
            .fill(Surface.well(scheme))
            .overlay {
                if let image {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    Image(systemName: symbol)
                        .font(.system(size: min(side / 3, 16)))
                        .foregroundStyle(.tertiary)
                }
            }
            .clipped()
        .task(id: "\(id)#\(version ?? -1)") {
            guard let version else { return }
            image = await things.thumbnail(of: id, version: version, side: side)
        }
    }
}

// MARK: - Timeline

/// Every version made, newest first, by day: who made it (a bot's face in a group chat), and a
/// hand-off where a bot took up what another made.
private struct TimelineList: View {
    let things: MadeThings
    let colored: Bool
    let open: (ArtifactHeader) -> Void

    var body: some View {
        let days = Dictionary(grouping: things.entries) { Calendar.current.startOfDay(for: Date(timeIntervalSince1970: $0.version.at)) }
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(days.keys.sorted(by: >), id: \.self) { day in
                    Text(ArtifactWords.day(day))
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(height: 22)
                        .padding(.horizontal, 16)
                        .padding(.top, 14)
                        .padding(.bottom, 2)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(days[day] ?? []) { entry in
                        if let from = entry.version.handoff?.from { HandoffMark(from: from) }
                        MadeRow(things: things, header: entry.artifact, version: entry.version, showsBot: colored, timeOnly: true) { open(entry.artifact) }
                    }
                }
                if things.timelineNext != nil {
                    Button("Show Earlier") { Task { await things.moreTimeline() } }
                        .buttonStyle(TextButtonStyle(outset: true))
                        .font(.system(size: 12))
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                }
            }
            .padding(.bottom, 12)
            .reportsMadeRowsHeight()
        }
    }
}

/// "Taken up from Ben", over the version that took it up.
private struct HandoffMark: View {
    let from: String
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.turn.down.right")
                .font(.system(size: 10, weight: .semibold))
            Text("Taken up from \(app.bots.bot(from)?.name ?? "another bot")")
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .padding(.leading, 56)
        .padding(.top, 4)
    }
}

// MARK: - Rows

/// A thing made: a small picture of it (or its bot, in a group chat's Timeline, or its kind), its
/// name, what happened to it and when, and how much changed.
struct MadeRow: View {
    let things: MadeThings
    let header: ArtifactHeader
    let version: ArtifactVersion
    var versions: Int?
    var showsBot = false
    var timeOnly = false
    let open: () -> Void
    @Environment(AppModel.self) private var app

    /// The bot it was made for, by name.
    private var owner: String? { header.where.bots.first.flatMap { app.bots.bot($0)?.name } }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                leading
                    .frame(width: 30, height: 30)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(ArtifactWords.name(header, bot: owner))
                            .font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        // Kept, wherever it's listed: a star for yours, Final for its bot's.
                        if let pin = header.pinned {
                            if pin.by == "bot" { MarkBadge(text: ArtifactWords.mark(pin)) } else { KeptStar() }
                        }
                    }
                    Text(subtitle)
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 6)
                if let lines = version.lines, version.status == .modified {
                    MadeDiffStat(lines: lines)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
        }
        .buttonStyle(ListRowButtonStyle(isSelected: false, cornerRadius: 8))
        .padding(.horizontal, 8)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Shows it and its versions")
    }

    @ViewBuilder private var leading: some View {
        if showsBot, let bot = version.by.bot.flatMap({ app.bots.bot($0) }) {
            BotAvatar(look: bot.look, size: 26, animates: false)
        } else if header.kind == .image, version.kept {
            Thumbnail(things: things, id: header.id, version: version.n, side: 30)
                .clipShape(.rect(cornerRadius: 7))
                .specularRim(RoundedRectangle(cornerRadius: 7), strength: 0.6)
        } else {
            KindTile(kind: header.kind, type: header.type)
        }
    }

    private var subtitle: String {
        // On the Timeline, what happened and when; on a list of things, when it last changed.
        var parts: [String] = []
        if timeOnly {
            parts.append(ArtifactWords.what(version, bot: showsBot ? version.by.bot.flatMap { app.bots.bot($0)?.name } : nil))
            parts.append(ArtifactWords.time(version.at))
        } else {
            if version.status == .deleted || version.by.kind != "agent" { parts.append(ArtifactWords.what(version)) }
            parts.append(ArtifactWords.when(version.at))
        }
        if let versions, versions > 1 { parts.append("\(versions) versions") }
        if header.gone != nil, version.status != .deleted { parts.append("since deleted") }
        return parts.joined(separator: " · ")
    }
}

/// Its kind's symbol on a quiet tile, as the phone shows it. (macOS's file icons are drawn by
/// the app that opens the kind, so a PDF showed a browser's.)
private struct KindTile: View {
    let kind: Artifact.Kind
    let type: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Image(systemName: ArtifactWords.symbol(kind: kind, type: type))
            .font(.system(size: 14))
            .foregroundStyle(.secondary)
            .frame(width: 28, height: 28)
            .background(Surface.well(scheme), in: .rect(cornerRadius: 7))
    }
}

/// How much a version changed, as Changes shows it, said in words to VoiceOver.
private struct MadeDiffStat: View {
    let lines: ArtifactVersion.Lines

    var body: some View {
        DiffStat(additions: lines.added, deletions: lines.removed)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(lines.added) \(lines.added == 1 ? "line" : "lines") added, \(lines.removed) removed")
    }
}

/// A quiet notice in the popover: why nothing shows, in a few words.
private struct MadeNotice: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 22))
                .foregroundStyle(.tertiary)
                .padding(.bottom, 2)
                .accessibilityHidden(true)
            Text(title)
                .font(.system(size: 13, weight: .semibold))
            Text(detail)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: 280)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Words that changed

/// Prose with the words that changed marked: added in green, removed in red and struck through;
/// VoiceOver says which.
struct ChangedWords: View {
    let lines: [ArtifactChanges.Line]
    var lineLimit: Int?
    var selectable = true

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 4) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Group {
                    switch line {
                    case .same(let text): Text(text.isEmpty ? " " : text)
                    case .added(let text):
                        Text(Self.marked(text, .added)).accessibilityLabel("Added: " + text)
                    case .removed(let text):
                        Text(Self.marked(text, .removed)).accessibilityLabel("Removed: " + text)
                    case .changed(let runs):
                        Text(runs.reduce(into: AttributedString()) { $0 += Self.marked($1.text, $1.mark) })
                            .accessibilityLabel(Self.spoken(runs))
                    case .folded(let count):
                        Text(count == 1 ? "1 line the same" : "\(count) lines the same")
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                            .padding(.vertical, 2)
                    }
                }
                .lineLimit(lineLimit)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(Selectable(on: selectable))
    }

    /// A changed line as it's heard: the words kept, then what was removed and added.
    static func spoken(_ runs: [ArtifactChanges.Run]) -> String {
        runs.map { run in
            switch run.mark {
            case .same: run.text
            case .added: " added: " + run.text + ";"
            case .removed: " removed: " + run.text + ";"
            }
        }.joined()
    }

    static func marked(_ text: String, _ mark: ArtifactChanges.Run.Mark) -> AttributedString {
        var string = AttributedString(text)
        switch mark {
        case .same: break
        case .added:
            string.foregroundColor = .additions
            string.backgroundColor = Color.additions.opacity(0.14)
        case .removed:
            string.foregroundColor = .deletions
            string.backgroundColor = Color.deletions.opacity(0.13)
            string.strikethroughStyle = .single
        }
        return string
    }

    private struct Selectable: ViewModifier {
        let on: Bool
        func body(content: Content) -> some View {
            if on { content.textSelection(.enabled) } else { content }
        }
    }
}

// MARK: - One thing and its versions

/// One thing made, at a version: arrows step through its versions (what it was before the agent
/// first changed it too), and Show Changes marks what that version changed (words in prose, lines
/// in code, the one before above it for pictures and PDFs). An older version can be put back.
struct ArtifactDetail: View {
    let things: MadeThings
    let header: ArtifactHeader
    let back: String
    let close: () -> Void
    let done: () -> Void
    @State private var artifact: Artifact?
    @State private var failure: String?
    @State private var at: Int?
    /// What changed is shown first, but not for Markdown: that opens drawn like the side panel's file view, and Show Changes is one click away.
    @State private var showsChanges: Bool
    /// Restore asked, waiting for your yes in place: the version.
    @State private var restoring: ArtifactVersion?
    @State private var isRestoring = false
    @State private var problem: String?
    /// A copy on its way to this Mac (Save a Copy).
    @State private var saving = false
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var scheme

    init(things: MadeThings, header: ArtifactHeader, back: String, close: @escaping () -> Void, done: @escaping () -> Void) {
        self.things = things
        self.header = header
        self.back = back
        self.close = close
        self.done = done
        _showsChanges = State(initialValue: !FileViewer.isMarkdown(named: header.name))
    }

    /// The bot it was made for, by name.
    private var owner: String? { header.where.bots.first.flatMap { app.bots.bot($0)?.name } }

    var body: some View {
        VStack(spacing: 0) {
            let version = artifact.flatMap { artifact in artifact.versions.first { $0.n == at } ?? artifact.versions.last }
            top(version)
            if let artifact, let version {
                versionBar(artifact, version)
                    .padding(.bottom, 6)
                // What its bot said as it marked it final.
                if let note = artifact.pinned?.note, artifact.pinned?.by == "bot", !note.isEmpty {
                    Label(note, systemImage: "checkmark.seal")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }
                if let restoring { confirm(artifact, restoring) }
                if let problem {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                        Text(problem)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.system(size: 12))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                }
                Divider()
                VersionBody(things: things, artifact: artifact, version: version, showsChanges: showsChanges && comparable(artifact, version))
                    .id("\(artifact.id)#\(version.n)#\(showsChanges)")
            } else if let failure {
                Divider()
                MadeNotice(symbol: "exclamationmark.triangle", title: "Can’t Show It", detail: failure)
            } else {
                Divider()
                Placeholder(.lines(count: 10), label: "Loading \(header.name)", fadesOut: false)
                    .padding(16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .task(id: header.id) { await load() }
        // It changed meanwhile (a new version): read again, staying on the version in view.
        .onChange(of: newest) { Task { await load() } }
        .onChange(of: at) { problem = nil; restoring = nil }
    }

    /// Its newest version, as the list or the Timeline in view says.
    private var newest: Int? {
        things.artifacts.first { $0.id == header.id }?.latest.n ?? things.entries.first { $0.artifact.id == header.id }?.version.n
    }

    private func load() async {
        do {
            artifact = try await things.artifact(header.id)
            failure = nil
        } catch {
            if artifact == nil { failure = error.localizedDescription }
        }
    }

    private func top(_ version: ArtifactVersion?) -> some View {
        HStack(spacing: 4) {
            Button(action: done) {
                Label(back, systemImage: "chevron.left")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(CardActionStyle())
            .keyboardShortcut(restoring == nil ? .cancelAction : nil)
            .help("Back to \(back)")
            Text(ArtifactWords.name(header, bot: owner))
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(1)
            Spacer(minLength: 6)
            if let artifact, let version, canRestore(artifact, version) {
                Button { withAnimation(.ui) { restoring = version } } label: {
                    Label("Restore…", systemImage: "arrow.uturn.backward")
                }
                .buttonStyle(CardActionStyle())
                .disabled(isRestoring || restoring != nil)
                .help(version.before == true ? "Put it back as it was before" : "Put this version back in the file")
            }
            if let artifact {
                if let pin = artifact.pinned, pin.by == "bot" {
                    // Its bot's mark, with its note below: not a button to undo by a stray click, but
                    // a menu, so it can still go.
                    Menu {
                        Button("Stop Keeping", systemImage: "star.slash") {
                            Task {
                                do {
                                    try await things.pin(artifact.id, false)
                                    await load()
                                } catch {
                                    problem = error.localizedDescription
                                }
                            }
                        }
                    } label: {
                        MarkBadge(text: ArtifactWords.mark(pin))
                    }
                    .menuStyle(.button)
                    .buttonStyle(.plain)
                    .fixedSize()
                    .help("Its bot marked it final")
                } else {
                    let words = artifact.pinned == nil ? ArtifactWords.keep : ArtifactWords.kept
                    Button {
                        Task {
                            do {
                                try await things.pin(artifact.id, artifact.pinned == nil)
                                await load()
                            } catch {
                                problem = error.localizedDescription
                            }
                        }
                    } label: {
                        if artifact.pinned == nil {
                            Label(words.title, systemImage: words.symbol)
                        } else {
                            Label(words.title, systemImage: words.symbol).foregroundStyle(.tint)
                        }
                    }
                    .buttonStyle(CardActionStyle())
                    .help(words.help)
                }
                // The file: in the panel's Files (a machine's from its box), this Mac's in Finder, a
                // machine's saved to this Mac. One that's gone opens as the record keeps it.
                // (This Mac's box, attached in place too, keeps them on this disk.)
                let onMac = BoxClient.isThisMac(things.box.box)
                let known = onMac || app.machines.list.contains { $0.id == things.box.box }
                let there = artifact.gone == nil && (!onMac || FileManager.default.fileExists(atPath: artifact.path))
                let kept = version?.kept == true
                if known, there || kept {
                    Button {
                        openInPanel(artifact, version, there: there, onMac: onMac)
                    } label: {
                        Label("Open in the Side Panel", systemImage: "sidebar.right")
                    }
                    .buttonStyle(CardActionStyle())
                    .help(there ? "Open in the Side Panel" : "Open in the Side Panel, as it was kept")
                    if onMac, there {
                        Button {
                            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: artifact.path)])
                        } label: {
                            Label("Show in Finder", systemImage: "folder")
                        }
                        .buttonStyle(CardActionStyle())
                        .help("Show in Finder")
                    }
                }
                // A machine's, and this Mac's that's gone from its folder (there's no Finder for it).
                // The newest with no copy comes from its box, which sends 25 MB at most, unless it
                // looks like a secret (`mayLeave`, the phone's Share too).
                let label = onMac ? "Save a Copy…" : "Save a Copy to This Mac…"
                if known, let version, onMac ? !there && kept : kept || (there && version.n == artifact.versions.last?.n && version.size <= 25 * 1024 * 1024 && version.mayLeave) {
                    Button {
                        saveCopy(artifact, version)
                    } label: {
                        if saving {
                            Spinner(size: 14)
                        } else {
                            Label(label, systemImage: "square.and.arrow.down")
                        }
                    }
                    .buttonStyle(CardActionStyle())
                    .disabled(saving)
                    .help(saving ? "Saving a copy…" : label)
                    .accessibilityLabel(saving ? "Saving a copy…" : label)
                }
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, 10)
        .frame(height: 40)
    }

    /// The file in the panel's Files: as it is now where it's there (a machine's read from its
    /// box), else the version shown as the record keeps it.
    private func openInPanel(_ artifact: Artifact, _ version: ArtifactVersion?, there: Bool, onMac: Bool) {
        if there {
            close()
            app.utilities.revealFile(onMac ? URL(fileURLWithPath: artifact.path) : RemoteFolder.url(RemoteFolder.folder(artifact.path, on: things.box.box)))
            return
        }
        guard let version else { return }
        Task {
            do {
                let data = try await things.bytes(of: artifact.id, version: version.n)
                let file = try Self.keptCopy(data, name: artifact.name, id: artifact.id)
                close()
                app.utilities.revealFile(file)
            } catch {
                problem = error.localizedDescription
            }
        }
    }

    /// A copy saved where you choose (Downloads to begin with): the version shown as the record
    /// keeps it, or, for a machine's newest with no copy kept, the file as it is now from its box.
    /// The save panel is a window of its own (the popover may close for it), so a failure says so
    /// in an alert.
    private func saveCopy(_ artifact: Artifact, _ version: ArtifactVersion) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = artifact.name
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.canCreateDirectories = true
        let things = things
        Task {
            guard await panel.begin() == .OK, let url = panel.url else { return }
            saving = true
            defer { saving = false }
            do {
                let data = version.kept
                    ? try await things.bytes(of: artifact.id, version: version.n)
                    : try await things.box.file(artifact.path)
                try data.write(to: url, options: .atomic)
                // Done, which the popover may no longer be there to show: the Dock's Downloads
                // stack bounces for it, as for a browser's download.
                DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: url.resolvingSymlinksInPath().path)
            } catch {
                let alert = NSAlert()
                alert.messageText = "\(artifact.name) couldn’t be saved"
                alert.informativeText = error.localizedDescription
                alert.runModal()
            }
        }
    }

    /// A version as the record keeps it, as a file in the app's temporary folder for the panel to
    /// show, one folder for each thing (the one shown before goes); others' a day old go too, so
    /// none are left behind for long.
    private static func keptCopy(_ data: Data, name: String, id: String) throws -> URL {
        let copies = FileManager.default.temporaryDirectory.appending(path: AppInfo.bundleID).appending(path: "Made copies")
        let day = Date.now.addingTimeInterval(-86_400)
        for folder in (try? FileManager.default.contentsOfDirectory(at: copies, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            let modified = (try? folder.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            if folder.lastPathComponent == id || modified < day { try? FileManager.default.removeItem(at: folder) }
        }
        let file = copies.appending(path: id).appending(path: name)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file)
        return file
    }

    /// An older version, kept, of a file its box can write back.
    private func canRestore(_ artifact: Artifact, _ version: ArtifactVersion) -> Bool {
        artifact.restorable == true && version.kept && version.status != .deleted && version.n != artifact.versions.last?.n
    }

    private func previous(_ artifact: Artifact, _ version: ArtifactVersion) -> ArtifactVersion? {
        artifact.versions.last { $0.n < version.n }
    }

    /// Whether this version's changes can be shown: there's one before with a copy (or code's own
    /// change), and it's text, a picture or a PDF.
    private func comparable(_ artifact: Artifact, _ version: ArtifactVersion) -> Bool {
        guard version.status != .deleted else { return false }
        // Code git keeps has only its change, which shows whichever way.
        if version.patch != nil { return version.kept }
        guard version.kept, let previous = previous(artifact, version), previous.kept || previous.status == .deleted else { return false }
        return artifact.type.hasPrefix("text/") || artifact.type == "application/json" || artifact.kind == .image || artifact.type == "application/pdf"
    }

    private func versionBar(_ artifact: Artifact, _ version: ArtifactVersion) -> some View {
        let all = artifact.versions
        let index = all.firstIndex { $0.n == version.n } ?? all.count - 1
        let made = artifact.made
        let position = version.before == true ? "Before" : "Version \((made.firstIndex { $0.n == version.n } ?? 0) + 1) of \(made.count)"
        return HStack(spacing: 6) {
            Button { withAnimation(.ui) { at = all[max(0, index - 1)].n } } label: {
                Label("Previous Version", systemImage: "chevron.left")
            }
            .buttonStyle(CardActionStyle())
            .disabled(index == 0)
            .help("Previous Version")
            VStack(alignment: .leading, spacing: 1) {
                Text(position)
                    .font(.system(size: 12.5, weight: .semibold))
                    .monospacedDigit()
                Text(ArtifactWords.what(version, bot: version.by.bot.flatMap { app.bots.bot($0)?.name }) + " · " + ArtifactWords.when(version.at))
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .accessibilityElement(children: .combine)
            Button { withAnimation(.ui) { at = all[min(all.count - 1, index + 1)].n } } label: {
                Label("Next Version", systemImage: "chevron.right")
            }
            .buttonStyle(CardActionStyle())
            .disabled(index == all.count - 1)
            .help("Next Version")
            Spacer(minLength: 6)
            if comparable(artifact, version) {
                Toggle("Show Changes", isOn: $showsChanges)
                    .toggleStyle(.checkbox)
                    .controlSize(.small)
                    .font(.system(size: 12))
                    .fixedSize()
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, 14)
    }

    /// Restore's yes, in place (a dialog would close the popover): what it puts back, and what
    /// that replaces.
    private func confirm(_ artifact: Artifact, _ version: ArtifactVersion) -> some View {
        let name = ArtifactWords.name(header, bot: owner)
        let latest = artifact.versions.last
        let replaces = latest?.status == .deleted
            ? "\(name) was deleted: this brings it back."
            : "This replaces \(name) as it is now. What’s there now is kept as a version first, so you can undo this the same way."
        return VStack(alignment: .leading, spacing: 8) {
            Text(version.before == true ? "Put back \(name) as it was before?" : "Put back this version of \(name)?")
                .font(.system(size: 12.5, weight: .semibold))
            Text(replaces)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Spacer()
                Button("Cancel") { withAnimation(.ui) { restoring = nil } }
                    .keyboardShortcut(.cancelAction)
                Button {
                    Task { await restore(artifact, version) }
                } label: {
                    if isRestoring { Spinner(size: 11) } else { Text("Restore") }
                }
                .keyboardShortcut(.defaultAction)
                .markInk(.onFill)
                .disabled(isRestoring)
            }
            .controlSize(.small)
        }
        .padding(12)
        .background(Surface.well(scheme), in: .rect(cornerRadius: 10))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .transition(.opacity)
    }

    private func restore(_ artifact: Artifact, _ version: ArtifactVersion) async {
        isRestoring = true
        defer { isRestoring = false }
        do {
            self.artifact = try await things.restore(artifact.id, version: version.n)
            withAnimation(.ui) {
                restoring = nil
                at = nil
            }
        } catch {
            restoring = nil
            problem = error.localizedDescription
        }
    }
}

/// A version's content: prose and code as text (what it changed marked, with Show Changes),
/// pictures and PDFs as themselves (the one before above it), pages and documents in Quick Look.
private struct VersionBody: View {
    let things: MadeThings
    let artifact: Artifact
    let version: ArtifactVersion
    let showsChanges: Bool
    @State private var loaded: Loaded?
    @State private var failure: String?
    /// What's shown in place of the changes, when they couldn't be read.
    @State private var note: String?

    /// The most of a text shown here (the rest in the side panel or Finder).
    private static let textLimit = 200_000

    enum Loaded {
        case changes(ArtifactChanges)
        case text(String, cut: Bool)
        case image(NSImage, before: NSImage?)
        case pdf(PDFDocument, before: PDFDocument?)
        case quickLook(URL)
        case other
    }

    var body: some View {
        // One over the other, so the placeholder and the version cross-fade.
        ZStack {
            if version.status == .deleted {
                notice("Deleted", symbol: "trash", ArtifactWords.deleted(version, in: artifact.versions))
            } else if !version.kept, version.patch == nil {
                notice(version.reason == .secret || version.reason == .ignored ? "Not Kept" : "No Copy", symbol: version.reason == .secret ? "lock" : "clock.arrow.circlepath",
                       version.reason?.words ?? (version.before == true ? "What it was before couldn’t be read." : ArtifactVersion.NoCopy.cleared.words))
            } else if let failure {
                notice("Can’t Show It", symbol: "exclamationmark.triangle", failure)
                    .transition(.replacingPlaceholder)
            } else if let loaded {
                Group {
                    switch loaded {
                    case .changes(.words(let lines, _, _)):
                        ScrollView { ChangedWords(lines: lines).transcriptFont().lineSpacing(3).padding(16) }
                    case .changes(.lines(let patch, _, _)):
                        ScrollView([.vertical, .horizontal]) { PatchText(patch: patch).padding(.vertical, 8) }
                    case .changes:
                        notice("Can’t Compare", symbol: "doc", "Its changes can’t be shown for this kind of file.")
                    case .text(let text, let cut):
                        ScrollView {
                            VStack(alignment: .leading, spacing: 10) {
                                if let note { Text(note).font(.system(size: 11.5)).foregroundStyle(.secondary) }
                                if FileViewer.isMarkdown(named: artifact.name) {
                                    // Drawn as the side panel's file view and replies are, not as its source.
                                    ReplyView(markdown: text, parser: MathMarkdownParser(), diagrams: true) { link in
                                        // A file's own links to its folder mean nothing here.
                                        link.scheme == nil
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                } else {
                                    Text(text)
                                        .font(artifact.kind == .code ? .system(size: 12, design: .monospaced) : nil)
                                        .lineSpacing(3)
                                        .textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                if cut { Text("The rest is in the file.").font(.system(size: 11.5)).foregroundStyle(.secondary) }
                            }
                            .transcriptFont()
                            .padding(16)
                        }
                    case .image(let image, let before):
                        pair(before.map { AnyView(Image(nsImage: $0).resizable().scaledToFit()) }, AnyView(Image(nsImage: image).resizable().scaledToFit()))
                    case .pdf(let document, let before):
                        pair(before.map { AnyView(PDFPreview(document: $0)) }, AnyView(PDFPreview(document: document)))
                    case .quickLook(let url):
                        QuickLookPreview(url: url)
                    case .other:
                        notice(artifact.name, symbol: ArtifactWords.symbol(kind: artifact.kind, type: artifact.type), ByteCountFormatter.string(fromByteCount: Int64(version.size), countStyle: .file))
                    }
                }
                .transition(.replacingPlaceholder)
            } else if artifact.kind == .image || artifact.type.hasPrefix("image/") {
                // Where the picture will sit, fitted in the middle.
                Placeholder(.image, label: "Loading \(artifact.name)")
                    .frame(maxWidth: 360, maxHeight: 270)
                    .padding(12)
            } else {
                Placeholder(.lines(count: 10), label: "Loading \(artifact.name)")
                    .padding(16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await load() }
        .onDisappear {
            if case .quickLook(let url) = loaded { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        }
    }

    private var previous: ArtifactVersion? { artifact.versions.last { $0.n < version.n } }

    private func load() async {
        do {
            let isImage = artifact.kind == .image || artifact.type.hasPrefix("image/")
            if isImage || artifact.type == "application/pdf" {
                let data = try await things.bytes(of: artifact.id, version: version.n)
                var before: Data?
                if showsChanges, let previous, previous.kept { before = try? await things.bytes(of: artifact.id, version: previous.n) }
                if isImage, let image = NSImage(data: data) {
                    loaded = .image(image, before: before.flatMap { NSImage(data: $0) })
                } else if !isImage, let document = PDFDocument(data: data) {
                    loaded = .pdf(document, before: before.flatMap { PDFDocument(data: $0) })
                } else {
                    loaded = .other
                }
                return
            }
            if showsChanges || !version.kept {
                // Its changes; if they can't be read (the one before was cleared), the version itself.
                do {
                    loaded = .changes(try await things.changes(of: artifact.id, version: version.n))
                    return
                } catch {
                    guard version.kept else { throw error }
                    note = "What changed can’t be shown: the version before isn’t kept. This is the version itself."
                }
            }
            let data = try await things.bytes(of: artifact.id, version: version.n)
            let isText = artifact.type.hasPrefix("text/") && artifact.type != "text/html" || artifact.type == "application/json"
            if isText, let text = String(data: data, encoding: .utf8) {
                let cut = text.utf8.count > Self.textLimit
                loaded = .text(cut ? String(text.prefix(Self.textLimit)) : text, cut: cut)
            } else {
                // Not written once it's no longer shown (nothing would delete it).
                guard !Task.isCancelled else { return }
                loaded = .quickLook(try Self.previewFile(data, name: artifact.name, id: artifact.id, version: version.n))
            }
        } catch {
            failure = error.localizedDescription
        }
    }

    /// The version as a file of its own in the app's temporary folder, for Quick Look; gone once shown.
    private static func previewFile(_ data: Data, name: String, id: String, version: Int) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: AppInfo.bundleID).appending(path: "Made previews").appending(path: "\(id)-\(version)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: name)
        try data.write(to: file)
        return file
    }

    /// The version before above this one (Show Changes), or this one alone.
    @ViewBuilder private func pair(_ before: AnyView?, _ now: AnyView) -> some View {
        if let before {
            VStack(spacing: 8) {
                labeled("Before", before)
                labeled("This Version", now)
            }
            .padding(12)
        } else {
            now.padding(12)
        }
    }

    private func labeled(_ title: String, _ content: AnyView) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func notice(_ title: String, symbol: String, _ detail: String) -> some View {
        MadeNotice(symbol: symbol, title: title, detail: detail)
    }
}

/// A unified diff's lines, added and removed in their colors.
private struct PatchText: View {
    let patch: String

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(Array(patch.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                let mark = line.first
                Text(line.isEmpty ? " " : String(line))
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(mark == "+" ? Color.additions : mark == "-" ? Color.deletions : mark == "@" ? .secondary : .primary)
                    .padding(.horizontal, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(mark == "+" ? Color.additions.opacity(0.1) : mark == "-" ? Color.deletions.opacity(0.1) : .clear)
            }
        }
        .fixedSize(horizontal: true, vertical: false)
        .textSelection(.enabled)
    }
}

/// A PDF, scrolled through.
private struct PDFPreview: NSViewRepresentable {
    let document: PDFDocument

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.backgroundColor = .clear
        view.document = document
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        if view.document !== document { view.document = document }
    }
}

/// A page, a document or a spreadsheet, as Quick Look shows it.
private struct QuickLookPreview: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> QLPreviewView {
        let view = QLPreviewView(frame: .zero, style: .compact) ?? QLPreviewView()
        view.previewItem = url as NSURL
        return view
    }

    func updateNSView(_ view: QLPreviewView, context: Context) {
        if (view.previewItem as? NSURL) as URL? != url { view.previewItem = url as NSURL }
    }
}

/// What its bot marked final, as a small tinted capsule beside its name.
private struct MarkBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(.tint.opacity(0.14), in: .capsule)
    }
}

/// What you keep, as the star Keep fills, beside its name.
private struct KeptStar: View {
    var body: some View {
        Image(systemName: ArtifactWords.kept.symbol)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.tint)
            .help("Kept")
            .accessibilityLabel("Kept")
    }
}

/// How tall the rows a What Was Made list scrolls through are, for its popover to fit them.
private struct MadeRowsHeight: PreferenceKey {
    static let defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}

private extension View {
    func reportsMadeRowsHeight() -> some View {
        background { GeometryReader { Color.clear.preference(key: MadeRowsHeight.self, value: $0.size.height) } }
    }
}
