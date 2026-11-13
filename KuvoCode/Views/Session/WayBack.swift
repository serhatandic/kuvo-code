import OpenCodeKit
import SwiftUI

// The way back from a conversation opened from inside another (a bot's session from its bot, a
// bot's conversation from a group chat, a subagent from its session): the tab keeps where it came
// from (`WindowTabs.go`), and the conversation shows a link back to it at its top, a step at a
// time. A subagent's header has it as its title; a session's or a group chat's has it in a row of
// its own (`BackBar`).

extension EnvironmentValues {
    /// The conversation a view is in, as its tab knows it: what it opens comes from there
    /// (`AppModel.open(_:from:)`), with the way back.
    @Entry var conversationTab: TabKey?
}

/// Back to the conversation `to` names: a chevron and its name, clickable as text buttons are.
struct BackLink: View {
    let to: String
    var help: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 10, weight: .semibold))
                Text(to).fontWeight(.semibold)
            }
            .font(.system(size: 13))
            .lineLimit(1)
            .truncationMode(.tail)
        }
        .buttonStyle(TextButtonStyle(outset: true))
        .help((help ?? "Back to \(to)") + " (⌘[)")
        .accessibilityLabel("Back to \(to)")
    }
}

/// The row at the top of a session's or a group chat's conversation with its way back, as a
/// subagent's header has it; the conversation scrolls under it, not under the card's header.
struct BackBar: View {
    let to: String
    let action: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            BackLink(to: to, action: action)
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) { Divider().opacity(0.5) }
        .preference(key: CardTopIsFixed.self, value: true)
    }
}

extension View {
    /// Its right-click menu's Open in New Tab: `key` in a tab of its own next to the one in view,
    /// as a ⌘-click on it opens it, rather than in this conversation's place.
    func opensInNewTab(_ key: TabKey?) -> some View {
        modifier(OpenInNewTab(key: key))
    }
}

private struct OpenInNewTab: ViewModifier {
    let key: TabKey?
    @Environment(AppModel.self) private var app
    @Environment(\.conversationTab) private var here

    func body(content: Content) -> some View {
        content.heldContextMenu {
            if let key {
                HeldRow.button("Open in New Tab") { app.open(key, from: here, newTab: true) }
            }
        }
    }
}

extension AppModel {
    /// What a conversation's way back calls it: a bot by its name, a session by its title, a
    /// subagent by its task, a group chat by its name.
    func backName(_ key: TabKey) -> String {
        switch key {
        case .session(let id):
            if let bot = bots.bot(forSession: id) { return bot.name }
            if let session = workspace.session(id) ?? workspace.subSession(id) {
                return session.parentID == nil ? session.title ?? "New Session" : SubagentTask.title(session.title ?? "")
            }
            return workspace.remoteTitle(id) ?? "Session"
        case .group(let id):
            return chats.group(id)?.name ?? "Group Chat"
        case .draft(let folder):
            return Workspace.isChat(folder) ? "New Chat" : "New Session"
        }
    }
}
