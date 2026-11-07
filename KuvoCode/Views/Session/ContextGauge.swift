import ClientDesign
import OpenCodeKit
import SwiftUI
import UsageKit

/// How full the model's context window is: its number, and from half full a ring with it (a part
/// of a ring alone at rest has a spinner's shape). Clicking it says what the number is, with the
/// plan's limits and what the session has cost so far.
struct ContextGauge: View {
    let model: SessionModel
    @Environment(Catalog.self) private var catalog
    @State private var showsDetails = false

    var body: some View {
        if let used, let limit, limit > 0 {
            let fraction = min(Double(used) / Double(limit), 1)
            Button { showsDetails.toggle() } label: {
                HStack(spacing: 5) {
                    if fraction >= 0.5 {
                        ZStack {
                            Circle().stroke(.quaternary, lineWidth: 2.5)
                            Circle()
                                .trim(from: 0, to: fraction)
                                .stroke(fraction > 0.8 ? AnyShapeStyle(.orange) : AnyShapeStyle(.tint), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                                .rotationEffect(.degrees(-90))
                        }
                        .frame(width: 12, height: 12)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                    }
                    Text(Self.percent(fraction))
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                        .foregroundStyle(fraction > 0.8 ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                }
                .padding(.horizontal, 6)
                .frame(height: 24)
                .contentShape(.rect)
                .hoverHighlight(in: RoundedRectangle(cornerRadius: 7), selected: showsDetails)
            }
            .buttonStyle(.plain)
            .clickablePointer()
            .animation(.ui, value: fraction)
            .help("Context window: \(used.compactTokens) of \(limit.compactTokens) tokens")
            // What it is, and how full, not "12%, button".
            .accessibilityLabel("Context window")
            .accessibilityValue("\(Self.percent(fraction)) full, \(used.compactTokens) of \(limit.compactTokens) tokens")
            .accessibilityHint("Shows the details")
            .closesWhenKept($showsDetails)
            .popover(isPresented: $showsDetails, arrowEdge: .bottom) {
                ContextDetails(used: used, limit: limit, cost: model.session.cost, plan: planLimits, openUsage: {
                    showsDetails = false
                    UsageMenuBar.shared.open(.dashboard)
                }, summarize: {
                    showsDetails = false
                    model.compact()
                })
                .popoverContent()
            }
            #if DEBUG
            // KUVO_DEMO_CONTEXT=1: its details open once the conversation shows.
            .task {
                guard ProcessInfo.processInfo.environment["KUVO_DEMO_CONTEXT"] != nil else { return }
                await DemoWait.pause(.conversationShows)
                showsDetails = true
            }
            #endif
        }
    }

    /// What the last step sent and got back is what's in the window now.
    private var used: Int? {
        #if DEBUG
        // KUVO_DEMO_CONTEXT_FULL=0.72: the window that full, to see the gauge past half.
        if let full = ProcessInfo.processInfo.environment["KUVO_DEMO_CONTEXT_FULL"].flatMap(Double.init), let limit {
            return Int(Double(limit) * full)
        }
        #endif
        return model.contextUsed
    }

    private var limit: Int? { Self.window(of: model, in: catalog) }

    /// What the session's model can hold of the conversation: on Auto, the model in your list at
    /// work now.
    static func window(of model: SessionModel, in catalog: Catalog) -> Int? {
        let current = model.session.model?.providerID == OutsideAgents.autoProvider ? model.modelInUse : model.session.model
        return catalog.model(current)?.limit.usable
    }

    /// The limits of the account the session runs on, from the usage tracker in the menu bar.
    /// Copilot, OpenRouter, Z.ai and OpenCode Go accounts there are the ones connected here.
    /// ChatGPT and Claude plans are read from Codex's and Claude Code's sign-ins, so they only
    /// count when the session is signed in to a plan too, not using an API key.
    private var planLimits: PlanLimits? {
        guard let id = model.session.model?.providerID, let tracker = Self.trackers[id] else { return nil }
        if id == "openai" || id == "anthropic" {
            guard catalog.integrations.first(where: { $0.id == id })?.connections.first?.method == "oauth" else { return nil }
        }
        return UsageMenuBar.shared.planLimits(for: tracker)
    }

    /// The tracker's provider for each engine provider.
    private static let trackers = [
        "github-copilot": "copilot",
        "openrouter": "openrouter",
        "zai-coding-plan": "zai",
        "zai": "zai",
        "opencode-go": "opencode",
        "openai": "codex",
        "anthropic": "claude",
    ]
}

/// The gauge's popover: the context window, the plan's limits and the session's cost.
extension ContextGauge {
    /// "21%", with the sign after the number in any region: Turkey's pattern reads "%21", which
    /// looks wrong in an English interface.
    static func percent(_ fraction: Double) -> String {
        "\(Int((fraction * 100).rounded()).formatted())%"
    }

    /// "Resets in 2 hr, 28 min" within a day, else "Resets Sat 1:00 AM".
    static func resets(_ date: Date, now: Date = .now) -> String {
        let seconds = date.timeIntervalSince(now)
        if seconds >= 24 * 3600 {
            return "Resets " + date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
        }
        let left = Duration.seconds(max(seconds, 60))
        return "Resets in " + left.formatted(.units(allowed: [.hours, .minutes], width: .abbreviated, maximumUnitCount: 2))
    }
}

private struct ContextDetails: View {
    let used: Int
    let limit: Int
    let cost: Double
    let plan: PlanLimits?
    let openUsage: () -> Void
    let summarize: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 7) {
                // Its percentage is the gauge's own: here, what that is of.
                row("Context window", detail: "\(used.compactTokens) of \(limit.compactTokens)", fraction: Double(used) / Double(limit), showsPercent: false)
                Text("What the model sees of this session. When it fills up, the conversation is summarized to make room.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let summarize {
                    Button("Summarize Now", action: summarize)
                        .buttonStyle(.link)
                        .font(.caption.weight(.medium))
                        .help("Summarize the conversation so far, to free up the context window")
                }
            }

            if let plan {
                Divider()
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("Usage limits · " + ([plan.providerName, plan.plan].compactMap(\.self).joined(separator: " ")))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Open Usage", systemImage: "arrow.up.right", action: openUsage)
                            .labelStyle(.iconOnly)
                            .buttonStyle(.borderless)
                            .help("Open the usage panel in the menu bar")
                    }
                    TimelineView(.everyMinute) { context in
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(plan.limits) { limit in
                                row(limit.label, detail: limit.resetsAt.map { ContextGauge.resets($0, now: context.date) }, fraction: limit.fraction)
                            }
                        }
                    }
                }
            }

            if let cost = cost.formattedCost {
                Divider()
                HStack {
                    Text("Cost so far")
                    Spacer()
                    Text(cost)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        }
        .font(.body)
        .padding(16)
        .frame(width: 320)
    }

    /// A label, its detail and percentage, and a bar under them.
    private func row(_ label: String, detail: String?, fraction: Double, showsPercent: Bool = true) -> some View {
        let fraction = min(max(fraction, 0), 1)
        let tint = fraction > 0.8 ? AnyShapeStyle(.orange) : AnyShapeStyle(.tint)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(label)
                Spacer()
                if let detail {
                    Text(detail)
                        .foregroundStyle(.secondary)
                }
                if showsPercent {
                    Text(ContextGauge.percent(fraction))
                        .foregroundStyle(fraction > 0.8 ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                }
            }
            .monospacedDigit()
            Capsule()
                .fill(.quaternary)
                .frame(height: 5)
                .overlay(alignment: .leading) {
                    GeometryReader { proxy in
                        Capsule()
                            .fill(tint)
                            .frame(width: max(proxy.size.width * fraction, fraction > 0 ? 5 : 0))
                    }
                }
        }
    }
}
