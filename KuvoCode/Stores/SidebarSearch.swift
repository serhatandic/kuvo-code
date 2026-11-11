import Foundation
import OpenCodeKit

/// What the sidebar's search finds, as the sidebar shows it.
@MainActor
enum SidebarSearch {
    enum Found: Identifiable {
        case session(Session)
        case bot(Bot)

        var id: String {
            switch self {
            case .session(let session): session.id
            case .bot(let bot): bot.sessionID
            }
        }
    }

    /// Sessions whose title or project name has the search, and bots whose name has it, newest
    /// first; archived sessions too.
    static func byName(_ query: String, in workspace: Workspace, bots: Bots) -> [Found] {
        let query = query.trimmingCharacters(in: .whitespaces)
        let sessions = workspace.sessions.filter { session in
            workspace.projectName(of: session).localizedStandardContains(query)
                || (session.title ?? "New Session").localizedStandardContains(query)
        }
        let named = bots.list.filter { bot in bot.name.localizedStandardContains(query) && !sessions.contains { $0.id == bot.sessionID } }
        func updated(_ found: Found) -> Double {
            switch found {
            case .session(let session): session.time.updated
            case .bot(let bot): workspace.session(bot.sessionID)?.time.updated ?? 0
            }
        }
        return (sessions.map { shown($0, bots: bots) } + named.map(Found.bot)).sorted { updated($0) > updated($1) }
    }

    /// Conversations whose words have the search (`Workspace.searchConversations`), each with the
    /// words around them and the subagent that said them: not those already found by name, nor one
    /// deleted since.
    static func inConversations(_ found: [Workspace.ConversationFind], besides byName: [Found], in workspace: Workspace, bots: Bots) -> [(found: Found, snippet: String, subagent: String?)] {
        found.filter { found in !byName.contains { $0.id == found.session.id } && workspace.session(found.session.id) != nil }
            .map { (shown($0.session, bots: bots), $0.snippet, $0.subagent) }
    }

    /// A bot's own conversation as the bot: its face and name, as in the sidebar.
    static func shown(_ session: Session, bots: Bots) -> Found {
        bots.bot(forSession: session.id).map(Found.bot) ?? .session(session)
    }
}
