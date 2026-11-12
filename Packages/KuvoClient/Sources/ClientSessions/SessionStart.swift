import Foundation
import OpenCodeKit

/// A new session, made by its box (`POST kuvo/sessions` with no task; PROTOCOL.md, "Agents' tools"):
/// in a project's folder, one of its worktrees (made for it) or the chats, with that project's other
/// folders allowed and named, its approval, Autopilot, mode and model, and nothing sent to it yet.
/// What both apps ask and read; the box decides the rest.
public enum SessionStart {
    /// What a box that starts one says in `kuvo/info`'s features. (A box from before needs a task:
    /// its client makes the session itself.)
    public static let feature = "sessions.start.empty"
    public static let route = "kuvo/sessions"

    /// What's asked: where (a folder there, `chat`, or `worktree` of the folder's project), its
    /// engine agent (Build, Plan or one of yours), its model as the picker has it, its approval (none:
    /// that computer's default) and whether it starts on Autopilot. Paths as its box knows them.
    public struct Asked: Encodable, Sendable, Equatable {
        public var folder: String?
        public var chat: Bool?
        public var worktree: Bool?
        public var agent: String?
        public var model: ModelRef?
        public var approval: String?
        public var autopilot: Bool?

        public init(folder: String?, chat: Bool = false, worktree: Bool = false, agent: String? = nil, model: ModelRef? = nil, approval: String? = nil, autopilot: Bool = false) {
            self.folder = chat ? nil : folder
            self.chat = chat ? true : nil
            self.worktree = worktree ? true : nil
            self.agent = agent
            self.model = model
            self.approval = approval
            self.autopilot = autopilot ? true : nil
        }
    }

    /// What it says back: the session (`info`, as its engine lists it, paths as its box knows them;
    /// none if it couldn't be read just then), the worktree made for it, and the approval it runs
    /// with now where that's less than asked (`got`).
    public struct Started: Decodable, Sendable {
        public var session: String
        public var info: Session?
        public var worktree: Worktree?
        public var got: String?

        /// A worktree made for it, as `kuvo/worktrees` makes one.
        public struct Worktree: Decodable, Sendable, Equatable {
            public var project: String
            public var root: String
            public var folder: String?
            public var branch: String
            public var base: String?
        }
    }
}

/// A conversation moved into a project by its box (`POST kuvo/sessions/<id>/move`): its
/// conversation goes along, and it gets that project's other folders, as a session started there
/// has them. Refused for a coding agent's session (409) and one moving to another computer (409).
public enum SessionMove {
    /// What a box that moves one says in `kuvo/info`'s features. (A box from before: its client moves
    /// it with the engine and gives it its folders itself.)
    public static let feature = "sessions.move"

    public static func route(_ id: String) -> String {
        "kuvo/sessions/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id)/move"
    }

    /// Where it goes: the project's folder, as its box knows it.
    public struct Asked: Encodable, Sendable, Equatable {
        public var directory: String
        public init(directory: String) { self.directory = directory }
    }

    /// The session as it is now (it moves at its next step while it's at work).
    public struct Moved: Decodable, Sendable {
        public var session: String
        public var directory: String
        public var info: Session?
    }
}

/// Whether a box gives every session of a project its folders as they change (`PUT kuvo/projects`),
/// and each one it starts or moves: then a client gives none itself. (A box from before: its client
/// gives each open session its folders.)
public enum ProjectFoldersOnBox {
    public static let feature = "projects.folders"
}
