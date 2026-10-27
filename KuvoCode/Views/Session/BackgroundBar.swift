import ClientDesign
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
        } ?? AnyView(Spinner(size: 14)), title: title, detail: detail, accessory: accessory, showHelp: showHelp, hideHelp: hideHelp, isHidden: $isHidden)
    }
}

/// The line of a bar in the card over the composer (`WorkBar`, the goal's, the keywords'): its
/// mark, what it says, how far along it is, and while what's under it is hidden, what that is;
/// clicking it shows or hides what's under it. A button of its own goes before the end column:
/// the chevron, then ✕ to put the bar away, in the same place on every line of the card.
struct BarLine: View {
    let mark: AnyView
    let title: String
    /// How far along it is, after the title ("3 turns · 12 min").
    var progress: String?
    var detail: Text?
    var accessory: AnyView?
    let showHelp: String
    let hideHelp: String
    @Binding var isHidden: Bool
    /// Whether there's anything under it: one with nothing keeps the chevron's room, empty.
    var opens = true
    /// Puts the bar away, as its ✕; nil for one that goes by itself.
    var close: (() -> Void)?
    /// What ✕ puts away, under the pointer ("Put the review away").
    var closeHelp = "Close"

    var body: some View {
        HStack(spacing: 0) {
            toggle
            if let accessory {
                accessory
                    .padding(.trailing, 4)
            }
            BarEnd(isHidden: $isHidden, opens: opens, showHelp: showHelp, hideHelp: hideHelp, close: close, closeLabel: "Close \(title)", closeHelp: closeHelp)
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
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                    .layoutPriority(2)
                // Whole, or not at all where a narrow card has no room: cut down to a letter or
                // two, they said nothing.
                if let progress {
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
                if !opens, let detail {
                    // All it says beyond its title: cut at its end, never dropped.
                    detail
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
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
                }
                Spacer(minLength: 8)
            }
            .padding(.leading, 14)
            .frame(height: 36)
            .contentShape(.rect)
    }
}

/// In a bar's place for a few seconds after its ✕ put it away ("Review put away"): what went,
/// and Undo where the ✕ was, on the same line as the bars; then it folds away.
struct BarUndoLine: View {
    let mark: AnyView
    /// What went: "Review put away".
    let text: String
    let undo: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            mark
                .frame(width: 18)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button("Undo", action: undo)
                .buttonStyle(TextButtonStyle(dimsAtRest: false))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.tint)
                .help("Bring it back")
                // Its end where the ✕'s is.
                .padding(.trailing, 2)
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .frame(height: 36)
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Undo", undo)
    }
}

/// The end of a bar's line, one column down the whole card: the chevron that shows or hides
/// what's under it (the line itself does too), then ✕ that puts the bar away, or their room.
struct BarEnd: View {
    @Binding var isHidden: Bool
    var opens = true
    var showHelp = ""
    var hideHelp = ""
    var close: (() -> Void)?
    /// For VoiceOver: which bar it closes ("Close Review").
    var closeLabel = "Close"
    var closeHelp = "Close"

    var body: some View {
        HStack(spacing: 2) {
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
            .opacity(opens ? 1 : 0)
            .disabled(!opens)
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
        .padding(.trailing, 8)
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
            Button("Output", systemImage: "text.alignleft") { showsOutput.toggle() }
                .buttonStyle(TextButtonStyle())
                .font(.system(size: 13))
                .help("What it has printed so far")
                .popover(isPresented: $showsOutput, arrowEdge: .top) {
                    ShellOutputView(job: job, api: api, directory: directory)
                }
            Button("Stop", systemImage: "stop.circle") { stop() }
                .buttonStyle(TextButtonStyle())
                .font(.system(size: 13))
                .help("Stop it: the agent hears that it ended, with what it printed")
        }
    }
}

/// The end of what a command has printed, read again every moment while it shows.
struct ShellOutputView: View {
    let job: ShellJob
    let api: OpenCodeAPI?
    let directory: String
    @State private var text = ""

    /// How much of the end it shows, in bytes.
    static let tail = 24_000

    /// The end of what command `id` has printed: its last `tail` bytes, from the first whole line
    /// in them (a progress line that redraws itself ends in a return); all of them when there's no
    /// line end in them.
    static func end(of id: String, api: OpenCodeAPI, directory: String) async -> String? {
        guard let size = try? await api.shellOutput(id, limit: 1, directory: directory).size else { return nil }
        let start = max(0, size - tail)
        guard let read = try? await api.shellOutput(id, from: start, limit: tail, directory: directory) else { return nil }
        let lineEnd = start > 0 ? read.output.firstIndex(where: \.isNewline) : nil
        let output = lineEnd.map { read.output[read.output.index(after: $0)...] } ?? Substring(read.output)
        return String(output).trimmingCharacters(in: .newlines)
    }

    var body: some View {
        ScrollView {
            Text(text.isEmpty ? "Nothing printed yet." : text)
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundStyle(text.isEmpty ? .secondary : .primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
        }
        .defaultScrollAnchor(.bottom)
        .frame(width: 520, height: 300)
        .task {
            while !Task.isCancelled {
                if let api, let end = await Self.end(of: job.id, api: api, directory: directory), end != text { text = end }
                try? await Task.sleep(for: .seconds(1.5))
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
