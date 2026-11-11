import ClientDesign
import ClientSessions
import SwiftUI

/// An item's properties on one quiet line under its title, as KuvoClient says them: the category
/// it's kept in (only while no session is at work on it), whose queue it's in, the computer it's
/// on, where it's being handed, and when it was added.
struct WorkItemProperties: View {
    let item: WorkItem
    let view: WorkQueueView

    var body: some View {
        Flow(spacing: 12) {
            ForEach(WorkQueue.properties(of: item, in: view)) { property in
                HStack(spacing: 4) {
                    switch property.kind {
                    case .category(let id):
                        WorkItemDot(id == WorkCategory.done ? .done : .category(id), size: 9)
                    case .owner(let owner):
                        WorkOwnerFace(owner: owner, size: 13)
                    case .computer:
                        Image(systemName: "desktopcomputer").font(.system(size: 10))
                    case .handing:
                        Image(systemName: "arrow.right").font(.system(size: 9, weight: .semibold))
                    case .added:
                        EmptyView()
                    }
                    Text(property.words)
                }
                .help(property.help ?? "")
            }
        }
        .font(.system(size: 11.5))
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }
}

/// A conversation's face, where it's a bot here: its avatar; a group chat's or a session's mark
/// otherwise.
struct WorkOwnerFace: View {
    let owner: String
    let size: CGFloat
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            if let bot = app.bots.bot(forSession: owner) {
                BotAvatar(look: bot.look, size: size, animates: false)
            } else {
                Image(systemName: owner.hasPrefix("grp_") ? "person.2.circle.fill" : "bubble.left.circle.fill")
                    .resizable()
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The sessions on an item: whether one is at work (its mark turns), which, what the agent said
/// it's doing and how far, and Open Session, the page's one filled button. Tinted while one works.
struct WorkItemSessionCard: View {
    let card: WorkQueue.SessionCard
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var scheme

    private let blue = WorkItemMark.inProgress.color

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                if card.working {
                    WorkItemStatusMark(.inProgress, size: 12.5)
                } else {
                    Image(systemName: "pause.circle")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.secondary)
                }
                Text(card.heading)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(card.working ? AnyShapeStyle(blue) : AnyShapeStyle(.secondary))
                Spacer(minLength: 8)
                if card.sessions.count == 1 { open(card.sessions[0]) }
            }
            ForEach(card.sessions, id: \.session) { session in
                HStack(spacing: 5) {
                    Image(systemName: "bubble.left")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.tertiary)
                    Text(WorkQueue.sessionName(session))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .help(WorkQueue.sessionName(session))
                    if card.sessions.count > 1 {
                        Spacer(minLength: 8)
                        if session.working { WorkItemStatusMark(.inProgress, size: 10) }
                        open(session)
                    }
                }
            }
            if let note = card.note {
                Text(note)
                    .font(.system(size: 13))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let progress = card.progress {
                ProgressLine("Progress", fraction: progress, layout: .inline)
                    .frame(maxWidth: 240, alignment: .leading)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(card.working ? blue.opacity(scheme == .dark ? 0.11 : 0.06) : Color.primary.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(card.working ? blue.opacity(scheme == .dark ? 0.35 : 0.28) : Color.primary.opacity(0.1)))
        .accessibilityElement(children: .contain)
    }

    /// Opens the session in this conversation's place, with the way back (⌘-click: in a new tab).
    @ViewBuilder private func open(_ session: WorkItemSession) -> some View {
        let known = app.workspace.session(session.session) != nil
        Button("Open Session") { app.open(.session(session.session), from: app.tabs.messageTarget) }
            .buttonStyle(OpenSessionButtonStyle(filled: card.working))
            .disabled(!known)
            .help(known ? "Open \(WorkQueue.sessionName(session))" : "That session isn’t on this Mac’s list.")
            .accessibilityLabel("Open Session \(WorkQueue.sessionName(session))")
            .opensInNewTab(known ? .session(session.session) : nil)
    }
}

/// Open Session: In progress blue, filled, while the session works (the page's one filled button);
/// a quiet fill while it doesn't. No icon. Its fill deepens under the pointer.
struct OpenSessionButtonStyle: ButtonStyle {
    let filled: Bool

    func makeBody(configuration: Configuration) -> some View {
        Shown(configuration: configuration, filled: filled)
    }

    private struct Shown: View {
        let configuration: ButtonStyleConfiguration
        let filled: Bool
        @State private var isHovering = false
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            let blue = WorkItemMark.inProgress.color
            let deeper = !isEnabled ? 0 : configuration.isPressed ? 0.1 : isHovering ? 0.05 : 0
            configuration.label
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(filled ? AnyShapeStyle(Color.white) : AnyShapeStyle(.primary))
                .padding(.horizontal, 10)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 6).fill(filled ? AnyShapeStyle(blue) : AnyShapeStyle(Color.primary.opacity(0.08 + deeper))))
                .brightness(filled ? -deeper : 0)
                .shadow(color: filled ? blue.opacity(0.3) : .clear, radius: 3, y: 1)
                .opacity(isEnabled ? 1 : 0.45)
                .fixedSize()
                .contentShape(.rect(cornerRadius: 6))
                .onHover { isHovering = $0 }
                .clickablePointer()
                .animation(.easeOut(duration: 0.12), value: isHovering)
        }
    }
}

/// The mark leading a line of an item's activity: who did it (a bot's face, you, a session), or
/// what happened (handed on, done, deleted).
struct WorkActivityMark: View {
    let line: WorkQueue.Activity
    let size: CGFloat
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch line.kind {
            case .handed: symbol("arrow.right.circle", Color.secondary)
            case .done: symbol("checkmark.circle.fill", Color.green)
            case .deleted: symbol("trash.circle", Color.secondary)
            case .added, .note:
                switch line.who {
                case .session(let id, _)?:
                    if let bot = app.bots.bot(forSession: id) {
                        BotAvatar(look: bot.look, size: size, animates: false)
                    } else {
                        symbol("bubble.left.circle.fill", Color.secondary)
                    }
                case .user?: symbol("person.crop.circle.fill", Color.secondary)
                default: symbol("person.crop.circle", Color.secondary)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func symbol(_ name: String, _ style: Color) -> some View {
        Image(systemName: name)
            .resizable()
            .foregroundStyle(style)
    }
}
