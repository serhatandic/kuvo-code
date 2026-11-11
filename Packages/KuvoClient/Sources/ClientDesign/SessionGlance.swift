import Foundation

/// What a session's row and its card show beyond the session itself, as its box states it
/// (`kuvo/sessions/glance`, KuvoLink's PROTOCOL.md, "A session at a glance"): the branch it has of
/// its own and, without a pull request, the lines it changed; its pull request with its state,
/// size and checks; the account it runs on; and since when it's waited on you. Both apps draw it
/// the same from here: which mark a row gains, which lines its card has, and what they say.
public struct SessionGlance: Decodable, Sendable, Equatable {
    public struct Pull: Decodable, Sendable, Equatable {
        public enum State: String, Sendable { case open, draft, merged, closed }

        /// Its checks, as the box counted GitHub's: skipped and neutral as passed, cancelled and
        /// timed out as failed, the rest under way.
        public struct Checks: Decodable, Sendable, Equatable {
            public let passed: Int
            public let failed: Int
            public let pending: Int

            public init(passed: Int, failed: Int, pending: Int) {
                (self.passed, self.failed, self.pending) = (passed, failed, pending)
            }

            public var total: Int { passed + failed + pending }
            /// How far they've come, for the ring that fills as they pass.
            public var share: Double { total > 0 ? Double(passed) / Double(total) : 0 }
        }

        public let number: Int
        public let url: String
        /// Nil until its box has read GitHub (or one it doesn't know yet).
        public let state: State?
        public let additions: Int?
        public let deletions: Int?
        public let checks: Checks?

        public init(number: Int, url: String = "", state: State?, additions: Int? = nil, deletions: Int? = nil, checks: Checks? = nil) {
            (self.number, self.url, self.state, self.additions, self.deletions, self.checks) = (number, url, state, additions, deletions, checks)
        }

        private enum CodingKeys: String, CodingKey { case number, url, state, additions, deletions, checks }

        public init(from decoder: Decoder) throws {
            let keys = try decoder.container(keyedBy: CodingKeys.self)
            number = try keys.decode(Int.self, forKey: .number)
            url = try keys.decodeIfPresent(String.self, forKey: .url) ?? ""
            state = (try? keys.decodeIfPresent(String.self, forKey: .state)).flatMap { $0.flatMap(State.init(rawValue:)) }
            additions = try? keys.decodeIfPresent(Int.self, forKey: .additions)
            deletions = try? keys.decodeIfPresent(Int.self, forKey: .deletions)
            checks = try? keys.decodeIfPresent(Checks.self, forKey: .checks)
        }

        /// Still open (a draft too), so its checks still count.
        public var isOpen: Bool { state == .open || state == .draft }
        /// A check failing on it while it's open: the whole of its mark on the row turns red.
        public var isFailing: Bool { isOpen && (checks?.failed ?? 0) > 0 }

        /// What VoiceOver says of it: "Pull request 41, open, a check failed".
        public var spoken: String {
            let state = switch state {
            case .open?: ", open"
            case .draft?: ", a draft"
            case .merged?: ", merged"
            case .closed?: ", closed"
            case nil: ""
            }
            let checks = if let checks, isOpen {
                checks.failed > 0 ? (checks.failed == 1 ? ", a check failed" : ", \(checks.failed) checks failed")
                    : checks.pending > 0 ? ", \(checks.passed) of \(checks.total) checks passed" : ", all checks passed"
            } else { "" }
            return "Pull request \(number)" + state + checks
        }
    }

    /// The account it runs on, as its box's Settings › Accounts names it.
    public struct Account: Decodable, Sendable, Equatable {
        public let name: String
        public let label: String?

        public init(name: String, label: String? = nil) {
            self.name = name
            self.label = label
        }
    }

    /// The branch it has of its own: a worktree's, or its pull request's. None for one in its
    /// project's own checkout without a pull request.
    public let branch: String?
    /// Without a pull request, the lines its branch changed since it left its base.
    public let additions: Int?
    public let deletions: Int?
    public let pull: Pull?
    public let account: Account?
    /// Since when it's waited on you, in ms since 1970, while it does.
    public let asked: Double?

    public init(branch: String? = nil, additions: Int? = nil, deletions: Int? = nil, pull: Pull? = nil, account: Account? = nil, asked: Double? = nil) {
        (self.branch, self.additions, self.deletions, self.pull, self.account, self.asked) = (branch, additions, deletions, pull, account, asked)
    }

    private enum CodingKeys: String, CodingKey { case branch, additions, deletions, pull, account, asked }

    /// Each part on its own: one a newer box says differently is left out, not the whole.
    public init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: CodingKeys.self)
        branch = try? keys.decodeIfPresent(String.self, forKey: .branch)
        additions = try? keys.decodeIfPresent(Int.self, forKey: .additions)
        deletions = try? keys.decodeIfPresent(Int.self, forKey: .deletions)
        pull = try? keys.decodeIfPresent(Pull.self, forKey: .pull)
        account = try? keys.decodeIfPresent(Account.self, forKey: .account)
        asked = try? keys.decodeIfPresent(Double.self, forKey: .asked)
    }

    /// The one mark a row gains before its state's: its pull request's, else its branch's. None for
    /// a session in its project's own checkout, whose row stays as it was.
    public enum RowMark: Equatable, Sendable {
        case pull(Pull)
        case branch(String)
    }

    /// `worktreeBranch`: the branch of the worktree the session runs in, as the client already
    /// knows it (a box from before this, or before it's answered).
    public static func rowMark(_ glance: SessionGlance?, worktreeBranch: String? = nil) -> RowMark? {
        if let pull = glance?.pull { return .pull(pull) }
        if let branch = glance?.branch ?? worktreeBranch { return .branch(branch) }
        return nil
    }

    /// What the card says after the model's name, quieter: its effort, then the account's own name,
    /// where you gave it one ("Extra · Work"); the account's maker is the model's mark beside it.
    public static func details(effort: String?, account: Account?) -> String? {
        let named = account?.label?.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = [effort, named?.isEmpty == false ? named : nil].compactMap(\.self)
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Whether the card says the folder: only on a row that isn't under its project's heading
    /// (Recents, Pinned, search results), which says it; never for a chat, whose folder is no
    /// project.
    public static func showsFolder(underItsProject: Bool, isChat: Bool) -> Bool { !underItsProject && !isChat }

    /// Whether the card says the computer: only in search results that span the computers. Recents
    /// and Pinned are on one computer's page, which says it.
    public static func showsComputer(acrossComputers: Bool) -> Bool { acrossComputers }
}

/// What the box answers for the sessions asked (`kuvo/sessions/glance`), by session; one that
/// can't be read is left out, not the rest.
public struct SessionGlances: Decodable, Sendable, Equatable {
    public let sessions: [String: SessionGlance]

    public init(sessions: [String: SessionGlance]) {
        self.sessions = sessions
    }

    private enum CodingKeys: String, CodingKey { case sessions }

    public init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: CodingKeys.self)
        let each = try keys.decode([String: Lenient].self, forKey: .sessions)
        sessions = each.compactMapValues(\.glance)
    }

    private struct Lenient: Decodable {
        let glance: SessionGlance?
        init(from decoder: Decoder) throws { glance = try? SessionGlance(from: decoder) }
    }

    /// The route for `sessions` (at most `most`), following them with `events`.
    public static func path(_ sessions: [String], events: Bool) -> String {
        let named = sessions.prefix(most).joined(separator: ",")
        return "kuvo/sessions/glance" + (events ? "/events" : "") + "?sessions=" + named
    }

    /// At most this many in one ask, as the box takes them.
    public static let most = 200
}

/// How long ago, in a word: "now", "4m", "2h", "3d", "2w"; and on the card, "4m ago".
public enum GlanceAge {
    public static func short(_ date: Date, now: Date = .now) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60: return "now"
        case ..<3600: return "\(Int(seconds / 60))m"
        case ..<86_400: return "\(Int(seconds / 3600))h"
        case ..<(86_400 * 7): return "\(Int(seconds / 86_400))d"
        default: return "\(Int(seconds / (86_400 * 7)))w"
        }
    }

    public static func card(_ date: Date, now: Date = .now) -> String {
        let word = short(date, now: now)
        return word == "now" ? "now" : word + " ago"
    }

    /// What the card's age counts from: while it waits on you, since it asked (its box's word, else
    /// its last change); otherwise since its last turn ended. Nil while it works, when the age says
    /// nothing. Times in ms since 1970, as sessions keep them.
    public static func since(_ state: StatusMark.Kind?, asked: Double?, idle: Double?, updated: Double) -> Date? {
        switch state {
        case .working?, .subagents?, .waitingForComputer?: nil
        case .needsYou?: Date(timeIntervalSince1970: (asked ?? updated) / 1000)
        default: Date(timeIntervalSince1970: (idle ?? updated) / 1000)
        }
    }
}

/// What a session's card says, worked out once from what its client knows of it and what its box
/// says (`SessionGlance`), for the card and for VoiceOver alike, the same in both apps.
public struct GlanceCardFacts: Equatable, Sendable {
    public let glance: SessionGlance?
    public let state: StatusMark.Kind?
    /// What its age counts from; none while it works.
    public let since: Date?
    /// The branch it has of its own: its box's word, else the worktree's it runs in as the client
    /// knows it (a box from before `sessions.glance`; goes once every box says it).
    public let branch: String?
    /// The model's name, and quieter after it, its effort and the account's own name.
    public let model: String?
    public let details: String?
    /// Only where the row doesn't say them.
    public let folder: String?
    public let computer: GlanceComputer?

    /// `idle`, `updated`: the session's times (ms). `variant`: its model's effort as the engine says
    /// it, named in the app's words (`effortName`). `folder`, `computer`: given only where the card
    /// says them (`SessionGlance.showsFolder`, `showsComputer`).
    public init(glance: SessionGlance?, state: StatusMark.Kind?, idle: Double?, updated: Double, worktreeBranch: String?,
                model: String?, variant: String?, effortName: (String) -> String, folder: String? = nil, computer: GlanceComputer? = nil) {
        self.glance = glance
        self.state = state
        since = GlanceAge.since(state, asked: glance?.asked, idle: idle, updated: updated)
        branch = glance?.branch ?? worktreeBranch
        self.model = model
        let effort = variant.flatMap { $0.isEmpty || $0 == "default" ? nil : effortName($0) }
        details = SessionGlance.details(effort: effort, account: glance?.account)
        self.folder = folder
        self.computer = computer
    }

    /// Its state in a word or two: "Needs you", "Done", "Idle".
    public var stateWords: String {
        guard let state else { return "Idle" }
        return state == .new ? "Done" : state.words
    }

    /// What VoiceOver says of the card on its row, which it can't reach: each line's name and what it
    /// says, as the card has them.
    public func spoken(now: Date = .now) -> [(label: String, value: String)] {
        var lines: [(label: String, value: String)] = [("State", stateWords + (since.map { ", " + GlanceAge.card($0, now: now) } ?? ""))]
        if let folder { lines.append(("Project", folder)) }
        if let computer { lines.append(("Computer", computer.name)) }
        if let branch {
            var value = branch
            if glance?.pull == nil, let additions = glance?.additions, let deletions = glance?.deletions { value += ", \(additions) lines added, \(deletions) removed" }
            lines.append(("Branch", value))
        }
        if model != nil || details != nil { lines.append(("Model", [model, details].compactMap(\.self).joined(separator: ", "))) }
        if let pull = glance?.pull {
            var value = pull.spoken
            if let additions = pull.additions, let deletions = pull.deletions { value += ", \(additions) lines added, \(deletions) removed" }
            lines.append(("Pull request", value))
        }
        return lines
    }
}
