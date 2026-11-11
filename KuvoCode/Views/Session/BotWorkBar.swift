import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// A bot's sessions at work, in a bar over its composer ("3 sessions at work"), like the one for
/// its subagents: each with where it stands, and Open and Stop under the pointer. While All's list
/// is open, the bar is only its line, so nothing's listed twice. It stays, folded to its line, while the
/// bot has done work today, for All: what's done, the asks it answered and why, and Stop All.
struct BotWorkBar: View {
    let bot: Bot
    let report: BotWorkReport
    @Binding var isHidden: Bool
    @State private var showsAll = false

    /// Whether it shows: sessions at work, or any started today.
    static func shows(_ report: BotWorkReport?) -> Bool {
        guard let report else { return false }
        return !report.atWork.isEmpty || report.today.started > 0
    }

    var body: some View {
        let atWork = report.atWork
        WorkBar(items: atWork, title: Self.title(report), progress: Self.progress(report),
                detail: atWork.count == 1 ? atWork.first.map { Text($0.title).font(.system(size: 12)) } : nil,
                symbol: atWork.isEmpty ? "checkmark.circle" : nil,
                accessory: AnyView(all),
                showHelp: "Show the sessions \(bot.name) runs", hideHelp: "Hide them: this line stays while they work",
                isHidden: showsAll ? .constant(true) : $isHidden) { item in
            BotWorkRow(bot: bot, item: item)
        }
    }

    /// The bar's line, and in a few words, the card's line once its bars are tucked away.
    static func title(_ report: BotWorkReport?) -> String {
        WorkWords.barTitle(atWork: report?.atWork.count ?? 0, today: report?.today.started ?? 0)
    }

    /// What it did today besides: asks it answered, tokens its sessions used.
    static func progress(_ report: BotWorkReport) -> String? {
        let midnight = Calendar.current.startOfDay(for: .now)
        let answered = report.answered.filter { $0.date >= midnight }.count
        let parts = [answered > 0 ? (answered == 1 ? "answered 1 ask" : "answered \(answered) asks") : nil,
                     report.today.tokens > 0 ? "\(WorkWords.tokens(report.today.tokens)) tokens today" : nil].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Its whole work, to look over and stop.
    private var all: some View {
        Button("All") { showsAll = true }
            .buttonStyle(TextButtonStyle())
            .font(.system(size: 13))
            .help("All of \(bot.name)’s work today, and the asks it answered")
            #if DEBUG
            // KUVO_DEMO_BOT_WORK_ALL: its whole work open, for a look at it.
            .task {
                guard ProcessInfo.processInfo.environment["KUVO_DEMO_BOT_WORK_ALL"] != nil else { return }
                await DemoWait.pause(.beat)
                showsAll = true
            }
            #endif
            .closesWhenKept($showsAll)
            .popover(isPresented: $showsAll, arrowEdge: .top) {
                ScrollView {
                    BotWorkList(bot: bot, report: report)
                        .padding(16)
                }
                .popoverContent()
                .frame(width: 440)
                .frame(maxHeight: 520)
            }
    }
}

/// A bot's sessions as a chip on its goal's line, in the work bar's stead while the goal shows:
/// "1 working" with a spinner, or "4 today"; its whole work in a popover, as the bar's All has it.
struct BotWorkChip: View {
    let bot: Bot
    let report: BotWorkReport
    @State private var showsAll = false

    var body: some View {
        let atWork = report.atWork.count
        Button { showsAll = true } label: {
            HStack(spacing: 5) {
                if atWork > 0 {
                    Spinner(size: 11)
                } else {
                    Image(systemName: "rectangle.stack")
                        .font(.system(size: 11, weight: .medium))
                }
                Text(WorkWords.chipTitle(atWork: atWork, today: report.today.started))
                    .monospacedDigit()
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 9)
            .frame(height: 22)
            .background(Capsule().fill(Color.primary.opacity(0.04)))
            .overlay(Capsule().strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .clipShape(Capsule())
        .fixedSize()
        .help("\(BotWorkBar.title(report)): all of \(bot.name)’s work today")
        .accessibilityLabel(BotWorkBar.title(report))
        .accessibilityHint("Shows all of \(bot.name)’s work today")
        .closesWhenKept($showsAll)
        .popover(isPresented: $showsAll, arrowEdge: .top) {
            ScrollView {
                BotWorkList(bot: bot, report: report)
                    .padding(16)
            }
            .popoverContent()
            .frame(width: 440)
            .frame(maxHeight: 520)
        }
    }
}

/// One of a bot's sessions: its title, then where it stands (its model and mode while it works,
/// what it asks while it waits), and Open and Stop while the pointer's on it (VoiceOver has them always).
private struct BotWorkRow: View {
    let bot: Bot
    let item: BotWorkReport.Item
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here
    @Environment(Catalog.self) private var catalog
    @State private var isStopping = false
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 10) {
            Text(item.title)
                .font(.system(size: 13))
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)
            Group {
                if item.state == .asking {
                    Text(item.asks.map(WorkWords.asking) ?? "Waiting for an answer")
                        .foregroundStyle(.orange)
                } else {
                    // The first that fits beside the title, which keeps its room: the account goes
                    // before the project, and the last is cut at its end.
                    let about = BotWorkList.about(item, catalog: catalog)
                    ViewThatFits(in: .horizontal) {
                        ForEach(about, id: \.self) { ShimmerText(text: $0) }
                    }
                    .help(about.first ?? "")
                    .accessibilityLabel(about.first ?? "")
                }
            }
            .font(.system(size: 12))
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Open", systemImage: "arrow.turn.down.right") {
                app.open(.session(item.session), from: here)
            }
            .buttonStyle(TextButtonStyle())
            .font(.system(size: 13))
            .fixedSize()
            .help("Open its conversation, to watch it and talk to it")
            .accessibilityLabel("Open \(item.title)")
            .opensInNewTab(.session(item.session))
            .opacity(showsActions ? 1 : 0)
            Button("Stop", systemImage: "stop.circle") { stop() }
                .buttonStyle(TextButtonStyle())
                .font(.system(size: 13))
                .fixedSize()
                .disabled(isStopping)
                .help("Stop it: \(bot.name) hears it was stopped")
                .accessibilityLabel("Stop \(item.title)")
                .opacity(showsActions ? 1 : 0)
        }
        .contentShape(Rectangle())
        .onHover { hovering in withAnimation(.easeOut(duration: 0.12)) { isHovered = hovering } }
    }

    private var showsActions: Bool { isHovered || isStopping }

    private func stop() {
        isStopping = true
        Task {
            do { try await app.botWork.stop(item.session, of: bot) } catch { app.workspace.model(for: bot.sessionID)?.failure = error.localizedDescription }
            isStopping = false
        }
    }
}

/// A bot's work in full: its sessions at work and done, the asks it answered and why, and what it
/// started today; Stop All stops every session at work.
struct BotWorkList: View {
    let bot: Bot
    let report: BotWorkReport
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here
    @Environment(Catalog.self) private var catalog
    @State private var isStopping = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(bot.name)’s work")
                    .font(.headline)
                Spacer()
                Text(today)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            if !report.atWork.isEmpty { section("At work", items: report.atWork) }
            let done = report.sessions.filter { !$0.isAtWork }.prefix(12)
            if !done.isEmpty { section("Done", items: Array(done)) }
            if report.sessions.isEmpty {
                Text("\(bot.name) hasn’t started any sessions yet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if !report.answered.isEmpty { answers }
            if let limits = report.limits, !limits.isEmpty {
                Text(WorkWords.limits(limits))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            if let failure {
                Text(failure)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !report.atWork.isEmpty {
                HStack {
                    Spacer()
                    Button(isStopping ? "Stopping…" : "Stop All", role: .destructive) { stopAll() }
                        .disabled(isStopping)
                        .help("Stop every session \(bot.name) runs; each keeps what it did, and you can carry on in it")
                }
            }
        }
    }

    private var today: String {
        let started = report.today.started == 1 ? "1 started" : "\(report.today.started) started"
        return "Today: " + ([started, report.today.tokens > 0 ? "\(WorkWords.tokens(report.today.tokens)) tokens" : nil] as [String?]).compactMap { $0 }.joined(separator: " · ")
    }

    private func section(_ title: String, items: [BotWorkReport.Item]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .tracking(0.4)
            ForEach(items) { item in
                Button {
                    app.open(.session(item.session), from: here)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        StatusMark(showing: Self.mark(item))
                            .frame(width: 14)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title)
                                .font(.system(size: 13))
                                .lineLimit(1)
                            Text(item.state == .asking ? (item.asks.map(WorkWords.asking) ?? "Waiting for an answer") : item.lastReply ?? Self.about(item, catalog: catalog).first ?? "")
                                .font(.system(size: 12))
                                .foregroundStyle(item.state == .asking ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                                .lineLimit(2)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .opensInNewTab(.session(item.session))
                .clickablePointer()
                .help("Open this session")
            }
        }
    }

    private var answers: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Answered for its sessions")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .tracking(0.4)
            ForEach(report.answered.prefix(20)) { answer in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: answer.decision == .deny ? "xmark.circle" : "checkmark.circle")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(WorkWords.asking(answer.what))
                            .font(.system(size: 12))
                            .lineLimit(2)
                        Text(answer.reason.isEmpty ? answer.verdict : "\(answer.verdict): \(answer.reason)")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                    Spacer(minLength: 0)
                    Text(answer.date, format: .dateTime.hour().minute())
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    /// Its mark: working, waiting on an answer, done or not.
    static func mark(_ item: BotWorkReport.Item) -> StatusMark.Kind? {
        switch item.state {
        case .working: .working
        case .asking: .needsYou
        case .failed: .failed
        case .finished, .stopped, .idle: nil
        }
    }

    /// Its model, effort and mode, the account it runs on, and where, in a few words, the longest
    /// first (`WorkWords.about`): "Claude Sonnet 5.5 · high · Plan · Claude · Work · Tidepool".
    static func about(_ item: BotWorkReport.Item, catalog: Catalog) -> [String] {
        let model = item.model.map { model in catalog.model(ModelRef(id: model.id, providerID: model.providerID))?.name ?? model.id }
        return WorkWords.about(item, model: model)
    }

    private func stopAll() {
        isStopping = true
        failure = nil
        Task {
            do { try await app.botWork.stopAll(bot) } catch { failure = error.localizedDescription }
            isStopping = false
        }
    }
}
