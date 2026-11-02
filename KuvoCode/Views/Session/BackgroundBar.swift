import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// Commands the agent left running in the background, in a bar over the composer like the
/// others that say what the agent or its engine is doing (the queue below is only your
/// messages): one line that says so, and under it each command, how long it has run, what it
/// has printed, and Stop. Hidden, the line stays, still drawing itself. When one ends, the engine
/// tells the agent, and it carries on.
struct BackgroundBar: View {
    let jobs: [ShellJob]
    let api: OpenCodeAPI?
    let directory: String
    @Binding var isHidden: Bool
    let stop: (ShellJob) -> Void

    var body: some View {
        WorkBar(items: jobs, title: jobs.count == 1 ? "Running in the background" : "\(jobs.count) commands running in the background",
                detail: jobs.count == 1 ? jobs.first.map { job in
                    Text(job.command.replacingOccurrences(of: "\n", with: " ")).font(.system(size: 12, design: .monospaced))
                } : nil,
                showHelp: "Show what runs in the background", hideHelp: "Hide them: this line stays while they run", isHidden: $isHidden) { job in
            BackgroundJobRow(job: job, api: api, directory: directory) { stop(job) }
        }
    }
}

/// A bar over the composer for work going on there that the conversation doesn't show as it
/// happens (commands left running, subagents at work): one line that says so, and under it a row
/// for each, as many as fit before it scrolls. Hidden, the line stays, still drawing itself, with
/// what the one there is when there's one.
struct WorkBar<Item: Identifiable, Row: View>: View {
    let items: [Item]
    let title: String
    /// How far along it is, after the title.
    var progress: String?
    /// What the only one is, beside the title while the rows are hidden.
    var detail: Text?
    /// The mark before the title, for what waits rather than works (a wake-up); else a spinner.
    var symbol: String?
    /// A button of its own at the end of the line.
    var accessory: AnyView?
    let showHelp: String
    let hideHelp: String
    @Binding var isHidden: Bool
    @ViewBuilder let row: (Item) -> Row

    private static var rowHeight: CGFloat { 30 }
    private static var visibleRows: Int { 4 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if !isHidden {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(items) { item in
                            row(item)
                                // Under the line's words, past its mark.
                                .padding(.leading, 42)
                                .padding(.trailing, 10)
                                .frame(height: Self.rowHeight)
                        }
                    }
                }
                .frame(height: CGFloat(min(items.count, Self.visibleRows)) * Self.rowHeight)
                .scrollBounceBehavior(.basedOnSize)
                .padding(.bottom, 6)
                .transition(.fold)
            }
        }
        .animation(.ui, value: items.map(\.id))
        #if DEBUG
        // KUVO_DEMO_FOLDS=<seconds>: its rows fold and open a few times, that far apart.
        .task {
            guard let wait = ProcessInfo.processInfo.environment["KUVO_DEMO_FOLDS"].flatMap(Double.init) else { return }
            for _ in 0..<8 {
                await DemoWait.pause(.asked(wait))
                guard !Task.isCancelled else { return }
                withAnimation(.ui) { isHidden.toggle() }
            }
        }
        #endif
    }

    private var header: some View {
        BarLine(mark: symbol.map { symbol in
            AnyView(Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundStyle(.tint))
        } ?? AnyView(Spinner(size: 14)), title: title, progress: progress, detail: detail, accessory: accessory, showHelp: showHelp, hideHelp: hideHelp, isHidden: $isHidden, opens: !items.isEmpty)
    }
}

/// The line of a bar in the card over the composer (`WorkBar`, the goal's, the keywords'): its
/// mark, what it says, how far along it is, and while what's under it is hidden, what that is;
/// clicking it shows or hides what's under it. Its end is the same on every line of the card
/// (`BarEnd`): ✕ last, and before it one column for the chevron, or for its own button when
/// there's nothing under it to show.
struct BarLine: View {
    let mark: AnyView
    let title: String
    /// How far along it is, after the title ("3 turns · 12 min").
    var progress: String?
    /// `progress` drawn in its own look ("Paused · You", its why in a word stronger); VoiceOver
    /// reads `progress`.
    var status: Text?
    var detail: Text?
    var accessory: AnyView?
    /// What stands for what's under it while that's hidden, after how far along it is (a goal's
    /// tracks).
    var folded: AnyView?
    let showHelp: String
    let hideHelp: String
    @Binding var isHidden: Bool
    /// Whether there's anything under it: one with nothing keeps the chevron's room, empty.
    var opens = true
    /// Puts the bar away, as its ✕; nil for one that goes by itself.
    var close: (() -> Void)?
    /// What ✕ puts away, under the pointer ("Put the review away").
    var closeHelp = "Close"
    /// Where the line has no room for the title and how far along it is, both whole, the second
    /// goes under the first rather than either being cut or dropped (a goal's bar).
    var stacks = false

    var body: some View {
        HStack(spacing: 0) {
            toggle
            BarEnd(isHidden: $isHidden, opens: opens, accessory: accessory, showHelp: showHelp, hideHelp: hideHelp, close: close, closeLabel: "Close \(title)", closeHelp: closeHelp)
        }
    }

    @ViewBuilder private var toggle: some View {
        if opens {
            Button {
                withAnimation(.ui) { isHidden.toggle() }
            } label: {
                words
            }
            .buttonStyle(.plain)
            .clickablePointer()
            .help(isHidden ? showHelp : hideHelp)
            .accessibilityLabel(progress.map { "\(title), \($0.replacingOccurrences(of: " · ", with: ", "))" } ?? title)
            .accessibilityValue(isHidden ? "Hidden" : "Shown")
        } else {
            // Nothing under it: words, not a button, its detail read with them.
            words
                .accessibilityElement(children: .combine)
        }
    }

    private var words: some View {
            HStack(spacing: 10) {
                mark
                    .frame(width: 18)
                if stacks {
                    stacked
                        .layoutPriority(2)
                } else {
                    oneLine
                }
                if !opens, let detail {
                    // All it says beyond its title: cut at its end, never dropped.
                    detail
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        // Before the space after it: all the room left, not half.
                        .layoutPriority(0.5)
                } else if isHidden, let detail {
                    ViewThatFits(in: .horizontal) {
                        detail
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .fixedSize()
                        detail
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(minWidth: 90, idealWidth: 90, maxWidth: .infinity, alignment: .leading)
                        Color.clear.frame(width: 0, height: 0)
                    }
                    .layoutPriority(0.5)
                }
                Spacer(minLength: 8)
            }
            .padding(.leading, 14)
            .frame(minHeight: 36)
            .contentShape(.rect)
    }

    private var titleText: some View {
        Text(title)
            .font(.system(size: 13, weight: .semibold))
            .lineLimit(1)
    }

    /// How far along it is, or its status, in one line.
    @ViewBuilder private var says: some View {
        if let status {
            status
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        } else if let progress {
            Text(progress)
                .font(.system(size: 13).monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    /// The title, how far along and the folded strip on one line where all of them fit whole;
    /// otherwise the title on its own line (cut in its middle only where even that has no room)
    /// and the rest under it, the strip left out where it doesn't fit.
    private var stacked: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                titleText.fixedSize()
                says.fixedSize()
                if isHidden, let folded { folded.fixedSize() }
            }
            VStack(alignment: .leading, spacing: 2) {
                titleText.truncationMode(.middle)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        says.fixedSize()
                        if isHidden, let folded { folded.fixedSize() }
                    }
                    says
                }
            }
            .padding(.vertical, 6)
        }
    }

    /// The title, then how far along cut out where there's no room, and the folded strip.
    @ViewBuilder private var oneLine: some View {
        titleText
            .layoutPriority(2)
        // A status ("Paused · Error") is why the bar matters now: always whole, the title
        // cut short before it.
        if let status {
            status
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
                .layoutPriority(3)
        } else if let progress {
            // Whole, or not at all where a narrow card has no room: cut down to a letter
            // or two, they said nothing.
            ViewThatFits(in: .horizontal) {
                Text(progress)
                    .font(.system(size: 13).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
                Color.clear.frame(width: 0, height: 0)
            }
            .layoutPriority(1)
        }
        if isHidden, let folded {
            folded
                .fixedSize()
                .layoutPriority(1)
        }
    }
}

/// The end of a bar's line, the same on every line of the card: ✕ that puts the bar away (or its
/// room), and before it one column, centered on the same place whatever is in it: the chevron
/// that shows or hides what's under it (the line itself does too), or, with nothing under it, the
/// bar's own button ("Stop"). Its own button goes before the chevron when there's both.
struct BarEnd: View {
    @Binding var isHidden: Bool
    var opens = true
    var accessory: AnyView?
    var showHelp = ""
    var hideHelp = ""
    var close: (() -> Void)?
    /// For VoiceOver: which bar it closes ("Close Review").
    var closeLabel = "Close"
    var closeHelp = "Close"

    /// The column before ✕: as wide as a short word's button, which is centered in it as the
    /// chevron is (a longer one grows it to the left).
    static let column: CGFloat = 40
    /// Between the controls at the end.
    static let gap: CGFloat = 2
    /// From ✕ to the card's edge.
    static let trailing: CGFloat = 8

    var body: some View {
        HStack(spacing: Self.gap) {
            if opens {
                if let accessory { accessory }
                Button {
                    withAnimation(.ui) { isHidden.toggle() }
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .rotationEffect(.degrees(isHidden ? 180 : 0))
                }
                .buttonStyle(IconButtonStyle(width: 24, height: 24))
                .foregroundStyle(.secondary)
                .help(isHidden ? showHelp : hideHelp)
                // The line says the same, and shows and hides it.
                .accessibilityHidden(true)
                .focusable(false)
                .frame(width: Self.column)
            } else if let accessory {
                accessory
                    .frame(minWidth: Self.column)
            }
            if let close {
                Button(closeLabel, systemImage: "xmark", action: close)
                    .font(.system(size: 10, weight: .semibold))
                    .buttonStyle(IconButtonStyle(width: 24, height: 24))
                    .foregroundStyle(.secondary)
                    .help(closeHelp)
                    .accessibilityHint(closeHelp)
            } else {
                Color.clear
                    .frame(width: 24, height: 24)
                    .accessibilityHidden(true)
            }
        }
        .padding(.trailing, Self.trailing)
    }
}

private struct BackgroundJobRow: View {
    let job: ShellJob
    let api: OpenCodeAPI?
    let directory: String
    let stop: () -> Void
    @State private var showsOutput = false

    var body: some View {
        HStack(spacing: 10) {
            Text(job.command.replacingOccurrences(of: "\n", with: " "))
                .font(.system(size: 12, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(job.command)
            if let started = job.time?.started {
                Text(Date(timeIntervalSince1970: started / 1000), style: .timer)
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .help("How long it has been running")
            }
            Button("Output") { showsOutput.toggle() }
                .buttonStyle(TextButtonStyle())
                .font(.system(size: 13))
                .help("What it has printed so far")
                .closesWhenKept($showsOutput)
                .popover(isPresented: $showsOutput, arrowEdge: .top) {
                    ShellOutputView(job: job, api: api, directory: directory)
                        .popoverContent()
                }
            Button("Stop") { stop() }
                .buttonStyle(TextButtonStyle())
                .font(.system(size: 13))
                .help("Stop it: the agent hears that it ended, with what it printed")
        }
    }
}

/// The end of what a command has printed, read again every moment while it shows, until its engine
/// says it has ended (as the phone's Output does; the rule is ClientSessions' `ShellRead`).
struct ShellOutputView: View {
    let job: ShellJob
    let api: OpenCodeAPI?
    let directory: String
    /// What it has printed, once read; kept while a read fails.
    @State private var text: String?
    /// Its output couldn't be read, and none has been yet.
    @State private var isUnread = false
    /// It ended and its engine let go of what it printed: nothing more to read.
    @State private var hasEnded = false

    /// Reads command `id`'s output every `pause`, showing each read, until its engine says the
    /// command has ended; a read that fails otherwise (its computer away) is tried again.
    static func follow(_ id: String, api: OpenCodeAPI, directory: String, every pause: Duration = .seconds(1.5),
                       show: @MainActor (ShellRead) -> Void) async {
        while !Task.isCancelled {
            let read = await api.shellOutputEnd(of: id, directory: directory)
            show(read)
            if read == .ended { return }
            try? await Task.sleep(for: pause)
        }
    }

    private var shown: String {
        switch text {
        case let text? where !text.isEmpty: text
        case _? where hasEnded: "It printed nothing."
        case nil where hasEnded: "This command has ended. What it printed is no longer kept."
        case nil where isUnread: "Couldn’t read what it printed. Its computer may be away; this tries again on its own."
        default: "Nothing printed yet."
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(shown)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(text?.isEmpty == false ? .primary : .secondary)
                    .textSelection(.enabled)
                if hasEnded, text != nil {
                    Text("This command has ended.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        }
        .defaultScrollAnchor(.bottom)
        .frame(width: 520, height: 300)
        .task {
            guard let api else { return }
            await Self.follow(job.id, api: api, directory: directory) { read in
                switch read {
                case .printed(let end):
                    if end != text { text = end }
                    isUnread = false
                case .ended:
                    // What was read stays; there's nothing more to wait for.
                    withAnimation(.ui) { hasEnded = true }
                case .unread:
                    if text == nil { isUnread = true }
                }
            }
        }
    }
}

extension TranscriptView {
    /// The line for a background command's end (OpenCodeKit words it, for the phone too).
    static func backgroundEnd(_ notice: Message.Notice) -> String {
        notice.backgroundEnd ?? notice.description ?? notice.text
    }
}
