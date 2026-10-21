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
                .transition(.opacity)
            }
        }
        .animation(.ui, value: items.map(\.id))
    }

    private var header: some View {
        HStack(spacing: 0) {
            toggle
            if let accessory {
                accessory
                    .padding(.trailing, 12)
            }
        }
    }

    private var toggle: some View {
        Button {
            withAnimation(.ui) { isHidden.toggle() }
        } label: {
            HStack(spacing: 10) {
                if let symbol {
                    Image(systemName: symbol)
                        .font(.system(size: 13))
                        .foregroundStyle(.tint)
                        .frame(width: 18)
                } else {
                    Spinner(size: 14)
                        .frame(width: 18)
                }
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                if isHidden, let detail {
                    detail
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isHidden ? 180 : 0))
                    .accessibilityHidden(true)
            }
            .padding(.leading, 14)
            .padding(.trailing, 16)
            .frame(height: 36)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .help(isHidden ? showHelp : hideHelp)
        .accessibilityLabel(title)
        .accessibilityValue(isHidden ? "Hidden" : "Shown")
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
