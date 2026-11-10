import ClientDesign
import SwiftUI

/// Over the composer of a conversation in Auto: what its reviewer held back since you last
/// looked, or that it paused after too many refusals, with what you can do about it.
struct ApprovalBar: View {
    @Bindable var model: SessionModel

    private var paused: Bool { model.decisions?.paused != nil }
    private var held: [ReviewDecisions.Decision] { model.unseenHeld }

    var body: some View {
        // The buttons keep their size; in a narrow window the command shortens in the middle
        // and the pause's words wrap.
        HStack(spacing: 10) {
            words
            Spacer(minLength: 8)
            HStack(spacing: 8) { buttons }
                .fixedSize()
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

/// Auto's Decisions: how many its reviewer held back and allowed of each kind in a conversation,
/// then a line for each, what's yours to approve first and then the latest, a long list folded.
/// Why, on hover or a click. One held back can be approved once; a pause, let go on.
struct DecisionsView: View {
    @Bindable var model: SessionModel
    @State private var showsAll = false

    /// Of what's past what waits on you, how many show before "…N more".
    private static let folded = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Auto’s Decisions")
                .font(.system(size: 13, weight: .semibold))
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 8)
            if model.decisions?.paused != nil { paused }
            if let decisions = model.decisions {
                if decisions.decisions.isEmpty {
                    Text("Nothing reviewed yet.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                } else {
                    DecisionCounts(counts: decisions.counts)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                    let listed = decisions.listed(limit: showsAll ? nil : Self.folded)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(listed.rows) { decision in
                                DecisionRow(decision: decision, approve: { model.approveDecision(decision) }, revoke: { model.revokePlace(decision) })
                            }
                            if listed.more > 0 {
                                Button("…\(listed.more) more") { showsAll = true }
                                    .buttonStyle(TextButtonStyle())
                                    .font(.system(size: 12))
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 6)
                                    .accessibilityLabel("Show \(listed.more) more")
                            }
                        }
                        .padding(.horizontal, 6)
                        .padding(.bottom, 8)
                    }
                    .frame(maxHeight: 440)
                }
            } else if model.decisionsUnread {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Couldn’t reach this conversation’s computer to read them.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Try Again") { model.readDecisions() }
                        .controlSize(.small)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            } else {
                Spinner(size: 13)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                    .accessibilityElement()
                    .accessibilityLabel("Reading Auto’s decisions")
            }
        }
        .frame(width: 420, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .popoverContent()
        .onAppear { model.readDecisions() }
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

/// The counts over the list, each kind's number with a thin bar of how they share it.
private struct DecisionCounts: View {
    let counts: ReviewDecisions.Counts

    private struct Part: Identifiable {
        var count: Int, one: String, many: String, color: Color
        var id: String { one }
        var isHeldBack: Bool { one == "held back" }
    }

    private var parts: [Part] {
        [Part(count: counts.heldBack, one: "held back", many: "held back", color: .orange), Part(count: counts.edits, one: "edit", many: "edits", color: .green),
         Part(count: counts.commands, one: "command", many: "commands", color: .accentColor), Part(count: counts.reads, one: "read", many: "reads", color: .teal),
         Part(count: counts.other, one: "other", many: "other", color: .gray)].filter { $0.count > 0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 14) {
                ForEach(parts) { part in
                    Text("\(Text("\(part.count)").fontWeight(.semibold).foregroundStyle(part.isHeldBack ? AnyShapeStyle(.orange) : AnyShapeStyle(.primary))) \(part.count == 1 ? part.one : part.many)")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            GeometryReader { room in
                let total = CGFloat(parts.reduce(0) { $0 + $1.count })
                let gaps = CGFloat(max(parts.count - 1, 0)) * 2
                HStack(spacing: 2) {
                    ForEach(parts) { part in
                        part.color.opacity(part.isHeldBack ? 1 : 0.7)
                            .frame(width: max(2, (room.size.width - gaps) * CGFloat(part.count) / max(total, 1)))
                    }
                }
            }
            .frame(height: 4)
            .clipShape(Capsule())
            .accessibilityHidden(true)
        }
    }
}

/// One decision on a line: its kind, what (a file's name with its folder dimmed, or the command)
/// and when, or Approve while it's yours to, or Revoke for a folder it allows edits in. Why, on
/// hover, or under it once clicked.
private struct DecisionRow: View {
    let decision: ReviewDecisions.Decision
    let approve: () -> Void
    let revoke: () -> Void
    @State private var showsWhy = false
    @State private var isHovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Image(systemName: symbol)
                    .font(.system(size: 11))
                    .foregroundStyle(decision.refused && decision.approved == nil ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                    .frame(width: 16)
                    .accessibilityHidden(true)
                what
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if decision.waiting {
                    Button("Approve", action: approve)
                        .buttonStyle(TextButtonStyle())
                        .font(.system(size: 12))
                        .fixedSize()
                        .help("Let it run once, the next time the agent does it the same way")
                        .accessibilityLabel("Approve \(decision.action)")
                } else if decision.revocable {
                    Button("Revoke", action: revoke)
                        .buttonStyle(TextButtonStyle())
                        .font(.system(size: 12))
                        .fixedSize()
                        .help("Have Auto check each change here again")
                        .accessibilityLabel("Revoke edits in \(decision.place ?? decision.action)")
                } else {
                    Text(state ?? decision.date.formatted(date: .omitted, time: .shortened))
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                        .fixedSize()
                }
            }
            // The line, not the reason under it: that stays selectable.
            .contentShape(Rectangle())
            .onTapGesture { showsWhy.toggle() }
            if showsWhy {
                Text(decision.reason)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.leading, 24)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(isHovering || showsWhy ? AnyShapeStyle(.quaternary.opacity(0.5)) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .onHover { isHovering = $0 }
        .help(showsWhy ? "" : decision.reason)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(decision.action)
        .accessibilityValue("\(spoken). \(decision.reason)")
        .accessibilityActions {
            if decision.waiting { Button("Approve", action: approve) }
            if decision.revocable { Button("Revoke", action: revoke) }
        }
    }

    /// What VoiceOver says of where it stands.
    private var spoken: String {
        if decision.waiting { return "Held back, waiting on you" }
        if decision.revocable { return "Edits allowed here for this session" }
        if let state { return state }
        return decision.refused ? "Held back" : "Allowed"
    }

    /// A file's name with its folder dimmed; a command, or what a tool was.
    @ViewBuilder private var what: some View {
        if decision.kind == "file", let space = decision.action.firstIndex(of: " ") {
            let path = String(decision.action[decision.action.index(after: space)...])
            let file = (path as NSString).lastPathComponent
            let folder = (path as NSString).deletingLastPathComponent.split(separator: "/").suffix(2).joined(separator: "/")
            Text("\(Text(file).foregroundStyle(.primary)) \(Text(folder).foregroundStyle(.tertiary))")
                .font(.system(size: 12))
        } else {
            Text(decision.action)
                .font(.system(size: 12, design: decision.kind == "command" ? .monospaced : .default))
        }
    }

    private var symbol: String {
        if decision.waiting { return "hand.raised" }
        if decision.place != nil { return "folder" }
        if decision.approved != nil || decision.used != nil { return "checkmark.circle" }
        if decision.refused { return "nosign" }
        switch decision.kind {
        case "command": return "terminal"
        case "file": return decision.action.hasPrefix("Read ") ? "doc.text" : "pencil"
        default: return "wrench.and.screwdriver"
        }
    }

    /// Where it stands, where that's more than when: run or approved after it was held back.
    private var state: String? {
        if decision.revoked != nil { return "Revoked" }
        if decision.used != nil { return "Ran" }
        if decision.approved != nil { return "Approved" }
        return nil
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
            Text("A conversation in Full Access runs every command without the sandbox and never asks you, so a mistake can reach anything you can: your keys, other projects, your accounts.")
        }
    }
}
