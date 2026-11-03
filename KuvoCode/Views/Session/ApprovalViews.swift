import ClientDesign
import SwiftUI

/// Over the composer of a conversation in Auto: what its reviewer held back since you last
/// looked, or that it paused after too many refusals, with what you can do about it.
struct ApprovalBar: View {
    @Bindable var model: SessionModel

    private var paused: Bool { model.decisions?.paused != nil }
    private var held: [ReviewDecisions.Decision] { model.unseenHeld }

    var body: some View {
        // In a narrow window the buttons go under the words rather than squeezing them.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                words
                Spacer(minLength: 8)
                buttons
            }
            VStack(alignment: .leading, spacing: 8) {
                words
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    buttons
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var words: some View {
        HStack(spacing: 10) {
            Image(systemName: paused ? "pause.circle" : "hand.raised")
                .font(.system(size: 14))
                .foregroundStyle(.orange)
                .frame(width: 18)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(paused ? "Auto paused" : held.count == 1 ? "Auto held back one thing" : "Auto held back \(held.count) things")
                    .font(.system(size: 13, weight: .medium))
                if paused {
                    Text("It refused too much in a row, so nothing runs until you let it go on.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else if let first = held.last {
                    Text(first.action)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(first.reason)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder private var buttons: some View {
        Button("Decisions") { model.openDecisions() }
            .buttonStyle(.glass)
            .help("What Auto allowed and held back here")
        if paused {
            Button("Resume") { model.resumeAuto() }
                .buttonStyle(.glassProminent)
                .help("Let Auto go on")
        } else if held.count == 1, let one = held.first {
            Button("Approve") { model.approveDecision(one) }
                .buttonStyle(.glassProminent)
                .help("Let it run once, the next time the agent does it the same way")
        }
    }
}

/// Auto's Decisions: what its reviewer allowed and held back in a conversation, the latest
/// first. One held back can be approved once; a pause, let go on.
struct DecisionsView: View {
    @Bindable var model: SessionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Auto’s Decisions")
                    .font(.system(size: 13, weight: .semibold))
                if let summary {
                    Text(summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 8)
            if model.decisions?.paused != nil { paused }
            if let decisions = model.decisions {
                if decisions.decisions.isEmpty {
                    Text("Nothing yet. What the agent wants past the sandbox is decided here, as it asks.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(decisions.latestFirst) { decision in
                                Divider().padding(.horizontal, 16)
                                DecisionRow(decision: decision) { model.approveDecision(decision) }
                            }
                        }
                        .padding(.bottom, 6)
                    }
                    .frame(maxHeight: 440)
                }
            } else {
                Spinner(size: 13)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                    .accessibilityElement()
                    .accessibilityLabel("Reading Auto’s decisions")
            }
        }
        .frame(width: 420)
        .fixedSize(horizontal: false, vertical: true)
        .popoverContent()
        .onAppear { model.readDecisions() }
    }

    private var summary: String? {
        guard let decisions = model.decisions?.decisions, !decisions.isEmpty else { return nil }
        let allowed = decisions.filter { !$0.refused }.count
        let held = decisions.count - allowed
        return [allowed > 0 ? "\(allowed) allowed" : nil, held > 0 ? "\(held) held back" : nil].compactMap { $0 }.joined(separator: " · ")
    }

    private var paused: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Auto paused")
                    .font(.system(size: 13, weight: .medium))
                Text("It refused too much in a row, so the conversation stopped. Look them over, then let it go on.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button("Resume") { model.resumeAuto() }
                .buttonStyle(.glassProminent)
        }
        .padding(12)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
    }
}

/// One decision: what the agent wanted, why, and where it stands (Approve while it's yours to).
private struct DecisionRow: View {
    let decision: ReviewDecisions.Decision
    let approve: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(decision.action)
                    .font(.system(size: 12, design: .monospaced))
                    .lineLimit(3)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Text("\(decision.reason) · \(decision.date.formatted(date: .omitted, time: .shortened))")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            if decision.waiting {
                Button("Approve", action: approve)
                    .buttonStyle(TextButtonStyle())
                    .font(.system(size: 12))
                    .fixedSize()
                    .help("Let it run once, the next time the agent does it the same way")
                    .accessibilityLabel("Approve \(decision.action)")
            } else {
                Text(state)
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                    .fixedSize()
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private var state: String {
        if decision.used != nil { return "Ran" }
        if decision.approved != nil { return "Approved" }
        if decision.by == "you" { return "Ran" }
        return decision.refused ? "Refused" : "Allowed"
    }
}

/// The first time Full Access is picked on a computer: what it means, and yes or no.
struct FullAccessConfirmation: ViewModifier {
    @Binding var isPresented: Bool
    /// The machine's name; nil for this Mac.
    let computer: String?
    let confirm: () -> Void

    func body(content: Content) -> some View {
        content.alert("Allow Full Access on \(computer ?? "this Mac")?", isPresented: $isPresented) {
            Button("Allow Full Access", role: .destructive, action: confirm)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A conversation in Full Access runs every command without the sandbox and never asks you, so a mistake can reach anything you can: your keys, other projects, your accounts. Bots never get it.")
        }
    }
}
