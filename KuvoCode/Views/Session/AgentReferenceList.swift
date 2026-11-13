import ClientDesign
import OpenCodeKit
import SwiftUI

/// "&" in a composer's field: the bots and sessions it can name, in a list above the field. The
/// same in every composer (a session's, a bot's, a chat's, a group chat's): each keeps one of
/// these, shows `AgentReferenceList` while it has matches, and asks it about its field's keys.
@MainActor @Observable final class AgentPicker {
    var selected = 0
    /// Where the "&" whose list was closed (with Escape, or by picking from it) is, so it stays
    /// closed as the message goes on. Watched: Escape changes only this, and the list must go.
    fileprivate var dismissed: Int?
    /// What was typed after the "&" last: the list's first one is chosen again when it changes.
    @ObservationIgnored fileprivate var typed: String?

    /// The agents the "&" being typed at the end of `text` matches, while its list is open; not
    /// the conversation `excluding`, which the message is written in. `from`: those its message
    /// can name, when not everyone this Mac's box names (a group chat's on a machine: its box's).
    func matches(in text: String, excluding: String?, from list: [AgentMail.Agent]? = nil) -> [AgentMail.Agent]? {
        guard !text.hasPrefix("!"), let (query, start) = AgentReferences.query(in: text),
              text.distance(from: text.startIndex, to: start) != dismissed else { return nil }
        let found = AgentReferences.matches(query, in: list?.filter { $0.session != excluding } ?? AgentReferences.candidates(excluding: excluding))
        return found.isEmpty ? nil : found
    }

    /// Names `agent` where the "&" is being typed.
    func insert(_ agent: AgentMail.Agent, into text: Binding<String>) {
        guard let start = AgentReferences.query(in: text.wrappedValue)?.start else { return }
        dismissed = text.wrappedValue.distance(from: text.wrappedValue.startIndex, to: start)
        text.wrappedValue = AgentReferences.insert(agent, into: text.wrappedValue)
        selected = 0
    }

    func reset() {
        selected = 0
        dismissed = nil
        typed = nil
    }

    /// The field's text changed: a new "&" query chooses its list's first one again.
    func textChanged(_ text: String) {
        guard let query = AgentReferences.query(in: text)?.query else { return reset() }
        if query != typed { selected = 0 }
        typed = query
    }

    /// A key of a composer's field while its "&" list is open: ↑ and ↓ choose, Return and Tab name
    /// the one chosen, Escape closes it. False for the field's own keys. The composer asks this
    /// before its own keys.
    func key(_ key: MessageField.Key, text: Binding<String>, excluding: String?, from list: [AgentMail.Agent]? = nil) -> Bool {
        guard let matches = matches(in: text.wrappedValue, excluding: excluding, from: list) else { return false }
        switch key.name {
        case .return where key.modifiers.isEmpty, .tab:
            insert(matches[min(selected, matches.count - 1)], into: text)
        case .escape:
            guard let start = AgentReferences.query(in: text.wrappedValue)?.start else { return false }
            dismissed = text.wrappedValue.distance(from: text.wrappedValue.startIndex, to: start)
        case .up, .down:
            selected = max(0, min(matches.count - 1, min(selected, matches.count - 1) + (key.name == .up ? -1 : 1)))
        default:
            return false
        }
        return true
    }
}

/// The bots and sessions an "&" matches, above the message field: each with its face or a
/// conversation's mark, its name and what it is; the chosen one highlighted, any one a click away.
struct AgentReferenceList: View {
    let agents: [AgentMail.Agent]
    let selected: Int
    let choose: (AgentMail.Agent) -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 1) {
            ForEach(Array(agents.enumerated()), id: \.element.session) { index, agent in
                Button { choose(agent) } label: {
                    HStack(spacing: 8) {
                        mark(of: agent)
                            .frame(width: 16, height: 16)
                        Text(agent.name)
                            .font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                        Text(detail(of: agent))
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 28)
                }
                .buttonStyle(ListRowButtonStyle(isSelected: index == selected))
                .accessibilityAddTraits(index == selected ? .isSelected : [])
                // Known by its place, for the list to scroll it into view (`ComposerListScroll`).
                .id(index)
            }
        }
        .padding(.leading, -8)
        .help("↑ ↓ to choose, Return or Tab to name it, Escape to close. The agent can read what it named, or write to it.")
    }

    @ViewBuilder private func mark(of agent: AgentMail.Agent) -> some View {
        if let bot = app.bots.bot(forSession: agent.session) {
            BotAvatar(look: bot.look, size: 16, animates: false)
        } else {
            Image(systemName: isChat(agent) ? "bubble.left" : "text.bubble")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
    }

    private func isChat(_ agent: AgentMail.Agent) -> Bool {
        app.workspace.session(agent.session).map { app.workspace.isInChats($0) } ?? false
    }

    /// A bot's job; a session's project, or that it's a chat; and the machine it's on.
    private func detail(of agent: AgentMail.Agent) -> String {
        let what = if agent.kind == "bot" {
            agent.about.flatMap { $0.isEmpty ? nil : $0 } ?? "Bot"
        } else {
            isChat(agent) ? "Chat" : agent.project ?? "Session"
        }
        return what + (agent.machine.map { " · on \($0)" } ?? "")
    }
}
