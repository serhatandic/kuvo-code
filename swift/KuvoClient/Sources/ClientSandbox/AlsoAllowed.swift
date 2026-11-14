import Foundation

/// Also Allowed as both apps list it: every rule on a computer at a glance, grouped by whose it is
/// (each project, each bot's own folder, the chats), each group with the places beneath it, and
/// what's added for whom.
public enum AlsoAllowed {
    /// One project, bot or the chats, with its rules.
    public struct Group: Identifiable, Equatable, Sendable {
        public var owner: SandboxOwner
        /// Its folder on the box, as the rules name it.
        public var project: String
        public var rules: [SandboxRule]
        /// Its folder isn't there any more.
        public var gone: Bool

        public var id: String { project }

        /// Its name: a project as the client calls it, a bot's, or "Chats".
        public var name: String { owner.name }

        /// Under its name, how far its rules reach.
        public var caption: String {
            if gone { return owner.kind == .bot ? "no longer on this computer" : "folder no longer there" }
            switch owner.kind {
            case .project: return "project"
            case .bot: return "its own folder"
            case .chats: return "every chat"
            }
        }
    }

    /// The groups, in the order a client lists them: projects in `order` (the client's own, most
    /// recently used first), then any other project by name, then the bots by name, then the chats.
    /// `names`: a project's name as the client knows it, by its folder on the box.
    public static func groups(_ rules: [SandboxRule], names: [String: String] = [:], order: [String] = []) -> [Group] {
        var groups: [Group] = []
        for rule in rules {
            if let at = groups.firstIndex(where: { $0.project == rule.project }) {
                groups[at].rules.append(rule)
                continue
            }
            var owner = rule.whose
            if owner.kind == .project, let name = names[rule.project], !name.isEmpty { owner.name = name }
            groups.append(Group(owner: owner, project: rule.project, rules: [rule], gone: rule.gone ?? false))
        }
        func rank(_ group: Group) -> (Int, Int, String) {
            switch group.owner.kind {
            case .project:
                if let at = order.firstIndex(of: group.project) { return (0, at, "") }
                return (1, 0, group.name.lowercased())
            case .bot: return (2, 0, group.name.lowercased())
            case .chats: return (3, 0, "")
            }
        }
        return groups.sorted { rank($0) < rank($1) }
    }

    /// Under the list.
    public static func footer(on computer: String) -> String {
        "Besides each one’s own folder, its repository, the temporary folder and tools’ caches. What you allow for good on a stopped command’s card lands here, kept on \(computer), so nothing in a project’s folder can add to it."
    }

    /// The list with nothing in it.
    public static let empty = "Nothing else yet. When you choose Always on a stopped command’s card, the folder shows here under its project, bot or Chats."

    /// The button that adds a folder, and its menu's groups, which say whose it is.
    public static let add = "Add Folder"
    public static let projects = "Projects"
    public static let bots = "Bots"

    /// The open panel's words, adding for `name`.
    public static func choosing(for owner: SandboxOwner) -> String {
        switch owner.kind {
        case .project: "Choose a folder \(owner.name)’s commands may write in, still in the sandbox."
        case .bot: "Choose a folder \(owner.name) may write in from its own conversation, still in the sandbox."
        case .chats: "Choose a folder every chat may write in, still in the sandbox."
        }
    }

    /// A place's line under its path: "Can write · Oct 29, from Alex’s iPhone".
    public static func detail(of rule: SandboxRule, locale: Locale = .current) -> String {
        let date = Date(timeIntervalSince1970: rule.at / 1000).formatted(.dateTime.month(.abbreviated).day().locale(locale))
        return "Can write · \(date)" + (rule.by.map { ", from \($0)" } ?? "")
    }
}
