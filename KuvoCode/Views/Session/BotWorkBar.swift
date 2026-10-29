import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// A bot's sessions at work, in a bar over its composer ("At work: 3 sessions"), like the one for
/// its subagents: each with where it stands and Open. All shows its whole work: what's done, the
/// asks it answered and why, today's count, and Stop All.
struct BotWorkBar: View {
    let bot: Bot
    let report: BotWorkReport
    @Binding var isHidden: Bool
    @State private var showsAll = false

    var body: some View {
        let atWork = report.atWork
        WorkBar(items: atWork, title: Self.title(atWork.count), progress: Self.progress(report),
                detail: atWork.count == 1 ? atWork.first.map { Text($0.title).font(.system(size: 12)) } : nil,
                accessory: AnyView(all),
                showHelp: "Show the sessions \(bot.name) runs", hideHelp: "Hide them: this line stays while they work", isHidden: $isHidden) { item in
            BotWorkRow(item: item)
        }
    }

    /// The bar's line, and in a few words, the card's line once its bars are tucked away.
    static func title(_ count: Int) -> String { count == 1 ? "At work: 1 session" : "At work: \(count) sessions" }

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
/// what it asks while it waits), and Open.
private struct BotWorkRow: View {
    let item: BotWorkReport.Item
    @Environment(AppModel.self) private var app
    @Environment(Catalog.self) private var catalog

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
                    ShimmerText(text: BotWorkList.about(item, catalog: catalog))
                }
            }
            .font(.system(size: 12))
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Open", systemImage: "arrow.turn.down.right") {
                app.tabs.open(.session(item.session))
            }
            .buttonStyle(TextButtonStyle())
            .font(.system(size: 13))
            .fixedSize()
            .help("Open its conversation, to watch it and talk to it")
        }
    }
}

/// A bot's work in full: its sessions at work and done, the asks it answered and why, and what it
/// started today; Stop All stops every session at work.
struct BotWorkList: View {
    let bot: Bot
    let report: BotWorkReport
    @Environment(AppModel.self) private var app
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
                Text(Self.limitsLine(limits))
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
                    app.tabs.open(.session(item.session))
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        StatusMark(showing: Self.mark(item))
                            .frame(width: 14)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title)
                                .font(.system(size: 13))
                                .lineLimit(1)
                            Text(item.state == .asking ? (item.asks.map(WorkWords.asking) ?? "Waiting for an answer") : item.lastReply ?? Self.about(item, catalog: catalog))
                                .font(.system(size: 12))
                                .foregroundStyle(item.state == .asking ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                                .lineLimit(2)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
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
                        Text("\(answer.verdict): \(answer.reason)")
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

    /// Its model, effort and mode, and where, in a few words: "Claude Sonnet 5.5 · high · Plan · Tidepool".
    static func about(_ item: BotWorkReport.Item, catalog: Catalog) -> String {
        let model = item.model.map { model in catalog.model(ModelRef(id: model.id, providerID: model.providerID))?.name ?? model.id }
        return [model, item.model?.variant, item.mode == "plan" ? "Plan" : nil, item.project].compactMap { $0 }.joined(separator: " · ")
    }

    /// The limits you set, in a line.
    static func limitsLine(_ limits: WorkLimits) -> String {
        let parts = [limits.atOnce.map { "\($0) at once" }, limits.perDay.map { "\($0) a day" }, limits.depth.map { $0 == 1 ? "one level deep" : "\($0) levels deep" },
                     limits.tokensPerDay.map { "\(WorkWords.tokens($0)) tokens a day" }].compactMap { $0 }
        return "Your limits: " + parts.joined(separator: ", ") + " (Edit Bot › Work)"
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
