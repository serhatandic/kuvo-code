import Foundation

/// The sandbox a computer's agents' commands run in, as its box answers `kuvo/sandbox` (KuvoLink's
/// PROTOCOL.md, "Sandbox"): whether it's on, and when it isn't, why and what you can do. A word a
/// newer box adds reads as none, so `why` is what's left to show. The same in both apps.
public struct SandboxState: Codable, Equatable, Sendable {
    /// Why it isn't on, as a word a client maps.
    public enum Reason: String, Codable, Sendable {
        case kernel, namespaces, macos, engineMissing, checking, checkFailed, plugin, engineDown, waiting
    }

    /// What you can do about it; `route` is the box's route that does it.
    public enum Action: String, Codable, Sendable {
        case help, softwareUpdate, retry, fix, restartEngine
    }

    /// Which part of the check failed.
    public enum Check: String, Codable, Sendable {
        case folder, tempFiles, readsOwn, writesOwn, services, didntRun, setup
    }

    /// While it's on, what it can't keep commands from on this computer.
    public enum Gap: String, Codable, Sendable {
        /// The services your login runs (systemd, your keyring, your SSH agent): a Linux machine
        /// whose commands can't have a namespace of their own.
        case services
    }

    /// Every command the engine runs here goes through the sandbox, checked.
    public var on: Bool
    /// Why it isn't on, in the box's own words.
    public var why: String?
    /// This computer can run it at all.
    public var able: Bool
    /// The coding agents' own programs' commands are in it too.
    public var agents: Bool
    /// One of their processes started before it was on, and still runs outside it (`agents` is
    /// false then; false without this, the box hasn't heard from them yet).
    public var outside: Bool?
    public var reason: Reason?
    public var action: Action?
    public var route: String?
    /// What the computer needs first.
    public var needs: String?
    public var check: Check?
    /// Checks failed in a row.
    public var failures: Int?
    /// It asks you, once, to restart the agents started before it was on (`SandboxRoutes.restart`).
    public var restart: Bool?
    /// While it's on, what it can't keep commands from here (a newer box's words left out).
    public var gaps: [Gap]?

    public init(on: Bool, why: String? = nil, able: Bool = true, agents: Bool = false, outside: Bool? = nil, reason: Reason? = nil, action: Action? = nil, route: String? = nil, needs: String? = nil, check: Check? = nil, failures: Int? = nil, restart: Bool? = nil, gaps: [Gap]? = nil) {
        self.restart = restart
        self.gaps = gaps
        self.on = on
        self.why = why
        self.able = able
        self.agents = agents
        self.outside = outside
        self.reason = reason
        self.action = action
        self.route = route
        self.needs = needs
        self.check = check
        self.failures = failures
    }

    public init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: CodingKeys.self)
        on = try keys.decode(Bool.self, forKey: .on)
        why = try keys.decodeIfPresent(String.self, forKey: .why)
        able = try keys.decodeIfPresent(Bool.self, forKey: .able) ?? true
        agents = try keys.decodeIfPresent(Bool.self, forKey: .agents) ?? false
        outside = try? keys.decodeIfPresent(Bool.self, forKey: .outside)
        reason = try? keys.decodeIfPresent(Reason.self, forKey: .reason)
        action = try? keys.decodeIfPresent(Action.self, forKey: .action)
        route = try keys.decodeIfPresent(String.self, forKey: .route)
        needs = try keys.decodeIfPresent(String.self, forKey: .needs)
        check = try? keys.decodeIfPresent(Check.self, forKey: .check)
        failures = try keys.decodeIfPresent(Int.self, forKey: .failures)
        restart = try? keys.decodeIfPresent(Bool.self, forKey: .restart)
        gaps = (try? keys.decodeIfPresent([String].self, forKey: .gaps))?.compactMap(Gap.init(rawValue:))
    }
}

/// What the sandbox refused a command (from a Mac's own log): a write, a read, a connection,
/// starting a job or an app, with its path where it has one.
public struct SandboxStop: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case write, read, connect, job, app, other }

    public var kind: Kind
    public var path: String?

    public init(kind: Kind, path: String? = nil) {
        self.kind = kind
        self.path = path
    }

    public init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? keys.decode(Kind.self, forKey: .kind)) ?? .other
        path = try keys.decodeIfPresent(String.self, forKey: .path)
    }
}

/// A command an agent wants to run outside the sandbox, waiting for your answer: its conversation and
/// project, its bot, the command and why, what the sandbox stopped or the error it got, and what
/// Always would allow (`always`, the one folder it was stopped writing in; none, and it's
/// only once or no). `machine`: the computer's name, on a machine.
public struct SandboxAsk: Codable, Equatable, Identifiable, Sendable {
    /// A place a project's commands may write in the sandbox.
    public struct Place: Codable, Equatable, Sendable {
        public var kind: String
        public var path: String

        public init(kind: String = "write", path: String) {
            self.kind = kind
            self.path = path
        }
    }

    public var id: String
    public var at: Double
    public var session: String?
    public var sessionName: String?
    public var bot: String?
    public var botName: String?
    public var project: String
    public var command: String
    public var why: String
    public var stopped: [SandboxStop]?
    public var error: String?
    public var always: Place?
    public var machine: String?
    /// Whose its folder is, which Always gives the place to (none from a box before it).
    public var owner: SandboxOwner?

    public init(id: String, at: Double = 0, session: String? = nil, sessionName: String? = nil, bot: String? = nil, botName: String? = nil, project: String, command: String, why: String, stopped: [SandboxStop]? = nil, error: String? = nil, always: Place? = nil, machine: String? = nil, owner: SandboxOwner? = nil) {
        self.id = id
        self.at = at
        self.session = session
        self.sessionName = sessionName
        self.bot = bot
        self.botName = botName
        self.project = project
        self.command = command
        self.why = why
        self.stopped = stopped
        self.error = error
        self.always = always
        self.machine = machine
        self.owner = owner
    }

    /// Who's asking, by name.
    public var asker: String { botName ?? sessionName ?? "An agent" }

    /// Always can be given: the box named the one place to allow.
    public var canAlways: Bool { always != nil }
}

/// An answer to an ask: run it once, run it and keep `always` in Also Allowed, or don't.
public enum SandboxAnswer: String, Codable, Sendable { case once, always, no }

/// Whose a conversation's folder is, as Also Allowed groups its rules and an ask's card names it: a
/// project's, a bot's own (`id`, the bot's) or the chats' (one folder, so a rule there is every
/// chat's). `name`: the project's folder's name, the bot's, or "Chats".
public struct SandboxOwner: Codable, Equatable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable { case project, bot, chats }

    public var kind: Kind
    public var id: String?
    public var name: String

    public init(kind: Kind, id: String? = nil, name: String) {
        self.kind = kind
        self.id = id
        self.name = name
    }

    public static let chats = SandboxOwner(kind: .chats, name: "Chats")

    /// What a client sends to add a folder for it (a project's goes by its folder instead).
    public var sent: [String: String] {
        id.map { ["kind": kind.rawValue, "id": $0] } ?? ["kind": kind.rawValue]
    }
}

/// A rule kept in Also Allowed: a folder (or file) a project's commands may write in the sandbox, or
/// a bot's own, or the chats'.
public struct SandboxRule: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var project: String
    public var kind: String
    public var path: String
    /// When it was given, in milliseconds.
    public var at: Double
    /// Who gave it (an ask's Always, or a client).
    public var by: String?
    /// Whose it is; a box from before it says none, and it's its project's, by its folder's name.
    public var owner: SandboxOwner?
    /// Its project's folder isn't there any more (a project deleted, a bot moved away).
    public var gone: Bool?

    public init(id: String, project: String, kind: String = "write", path: String, at: Double = 0, by: String? = nil, owner: SandboxOwner? = nil, gone: Bool? = nil) {
        self.id = id
        self.project = project
        self.kind = kind
        self.path = path
        self.at = at
        self.by = by
        self.owner = owner
        self.gone = gone
    }

    /// Whose it is, from a box before owners too.
    public var whose: SandboxOwner {
        owner ?? SandboxOwner(kind: .project, name: SandboxAsk.name(of: project))
    }
}

/// The answers' envelopes.
public struct SandboxAsks: Codable, Equatable, Sendable {
    public var asks: [SandboxAsk]
    /// The box asks you, once, to restart the agents started before its sandbox was on (`SandboxState.restart`).
    public var restart: Bool?
    /// How Auto's reviewer takes up asks to work outside a conversation's folder (none from a box
    /// before bridge 0.9.192, whose asks are all yours).
    public var reviews: [AskReview]?
    /// Those it was checking or had left for you that are over: answered or gone (none from a box
    /// before `sandbox.reviews.settled`).
    public var settled: [AskReview]?
    public init(asks: [SandboxAsk], restart: Bool? = nil, reviews: [AskReview]? = nil, settled: [AskReview]? = nil) {
        self.asks = asks
        self.restart = restart
        self.reviews = reviews
        self.settled = settled
    }

    private enum CodingKeys: String, CodingKey { case asks, restart, reviews, settled }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        asks = try container.decode([SandboxAsk].self, forKey: .asks)
        restart = try container.decodeIfPresent(Bool.self, forKey: .restart)
        // (One a newer box words otherwise is left out, not the whole list.)
        reviews = try container.decodeIfPresent([Lossy<AskReview>].self, forKey: .reviews)?.compactMap(\.value)
        settled = try container.decodeIfPresent([Lossy<AskReview>].self, forKey: .settled)?.compactMap(\.value)
    }

    /// Every ask its box says how Auto's reviewer took up, still at it or over, for `AskReview.isYours`
    /// (nil from a box that says nothing of them).
    public var everyReview: [AskReview]? {
        guard reviews != nil || settled != nil else { return nil }
        return (reviews ?? []) + (settled ?? [])
    }
}

/// One that reads as `Value`, or nothing for one that doesn't (a newer box's).
private struct Lossy<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
}

/// How an ask to work outside a conversation's folder (`external_directory`) was taken up on its
/// box (PROTOCOL.md, "Sandbox"): in Auto, its reviewer checks it and answers it, and only one left
/// for you is yours to answer; the rest show as a quiet mark on the step that asked (`call`).
public struct AskReview: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case checking, allowed, heldBack, refused, yours
        /// Over without the reviewer's word (`settled`, `sandbox.reviews.settled`): answered, or
        /// gone with its run or its engine. Never yours, heard or not.
        case answered, gone
    }

    public var id: String
    public var session: String
    public var call: String?
    public var state: State
    public var at: Double

    public init(id: String, session: String, call: String? = nil, state: State, at: Double) {
        self.id = id
        self.session = session
        self.call = call
        self.state = state
        self.at = at
    }

    /// The feature of a box that lists every ask its reviewer may take up, from the moment it
    /// hears it (PROTOCOL.md, "Sandbox"): its word is the whole of it.
    public static let listsAllFeature = "sandbox.reviews.whole"
    /// The feature of a box that lists the asks it took up that are over (`settled`, answered or
    /// gone) and keeps them to their end, so a client holds nothing of its own for them
    /// (PROTOCOL.md, "Sandbox").
    public static let settlesFeature = "sandbox.reviews.settled"

    /// Whether an ask is yours to answer, as its box says: one it left for you, or one it doesn't
    /// take up (only asks to work outside the folder are). One it may take up and hasn't listed is
    /// yours only from a box that doesn't list them all (`listsAll`, from before
    /// `sandbox.reviews.whole`), or while its box isn't heard (`heard`: its link down or starting
    /// again, so nothing would list it); what the box last said of one stands meanwhile (a phone
    /// back from the background doesn't tell you again of one being checked). One it lists as over
    /// (`answered`, `gone`) is never yours, heard or not. A client waits for nothing of its own.
    public static func isYours(action: String, review: AskReview?, listsAll: Bool, heard: Bool = true) -> Bool {
        if let review { return review.state == .yours }
        if !heard { return true }
        // (`!listsAll`, a box from before `sandbox.reviews.whole`: goes once no box before it is
        // supported.)
        return action != "external_directory" || !listsAll
    }

    /// The step's mark: what Auto did with what it asked.
    public var mark: String? {
        switch state {
        case .checking: "Auto is checking…"
        case .allowed: "Allowed by Auto-review"
        case .heldBack: "Held back"
        case .refused: "Not allowed by Auto-review"
        case .yours, .answered, .gone: nil
        }
    }
}

public struct SandboxAllowed: Codable, Equatable, Sendable {
    public var allowed: [SandboxRule]
    /// Whom else a folder can be added for: the bots working in their own folder, then the chats
    /// (a box from before them names none).
    public var owners: [SandboxOwner]?
    public init(allowed: [SandboxRule], owners: [SandboxOwner]? = nil) {
        self.allowed = allowed
        self.owners = owners
    }
}

/// The sandbox's routes on a box (KuvoLink's PROTOCOL.md, "Sandbox").
public enum SandboxRoutes {
    public static let state = "kuvo/sandbox"
    public static let check = "kuvo/sandbox/check"
    /// Your answer to its one ask to restart the agents started before it was on: `{restart}`, true or false.
    public static let restart = "kuvo/sandbox/restart"
    public static let asks = "kuvo/sandbox/asks"
    public static let askEvents = "kuvo/sandbox/asks/events"
    public static func ask(_ id: String) -> String { "kuvo/sandbox/asks/\(id)" }
    public static let allowed = "kuvo/sandbox/allowed"
    public static func allowed(project: String) -> String {
        var query = CharacterSet.urlQueryAllowed
        query.remove(charactersIn: "&+=?#")
        return "kuvo/sandbox/allowed?project=" + (project.addingPercentEncoding(withAllowedCharacters: query) ?? project)
    }
    public static func rule(_ id: String) -> String { "kuvo/sandbox/allowed/\(id)" }
    /// Adding a rule (for a project by `project`, a bot or the chats by `owner`), answered with every
    /// rule and the owners, as `allowed` is.
    public static let allowedAll = "kuvo/sandbox/allowed?all"
    /// Removing one, answered with every rule.
    public static func rule(_ id: String, all: Bool) -> String { rule(id) + (all ? "?all" : "") }
}

// MARK: The restart card's words

/// How both apps word the box's one ask to restart the agents started before its sandbox was on,
/// on a plain card in that computer's conversations (`SandboxState.restart`).
public enum SandboxRestart {
    public static let title = "Restart agents in the sandbox?"
    public static let detail = "Some agents started before the sandbox was on and still run outside it. Each restarts once it finishes what it’s doing, and picks up where it left off."
    public static let restart = "Restart Agents"
    public static let notNow = "Not Now"
}

// MARK: The card's words

/// How both apps word an ask's card (card A): who wants what, what the sandbox stopped, and what
/// Always keeps.
extension SandboxAsk {
    /// "Scout wants to run a command outside the sandbox".
    public var title: String { "\(asker) wants to run a command outside the sandbox" }

    /// The project's folder by its name.
    public var projectName: String { Self.name(of: project) }

    /// A folder by its name.
    static func name(of folder: String) -> String {
        let name = (folder as NSString).lastPathComponent
        return name.isEmpty ? folder : name
    }

    /// Where its commands write, by whose it is: a project by name, "Scout’s folder", or "Chats".
    public var placeName: String {
        switch owner?.kind {
        case .bot: "\(owner?.name ?? asker)’s folder"
        case .chats: "Chats"
        case .project, nil: projectName
        }
    }

    /// What stopped it, in a sentence under the title: by the first thing the sandbox refused, or
    /// the error the command got where it can't say (Linux).
    public var subtitle: String {
        if let first = stopped?.first {
            switch first.kind {
            case .write: return "The sandbox stopped it from changing a file outside \(placeName)."
            case .read: return "The sandbox stopped it from reading a file it keeps private."
            case .connect: return "The sandbox stopped it from making a connection."
            case .job: return "The sandbox stopped it from starting a background job."
            case .app: return "The sandbox stopped it from opening or talking to an app."
            case .other: return "The sandbox stopped it."
            }
        }
        if error != nil { return machine.map { "On \($0), the sandbox stopped it with this error." } ?? "The sandbox stopped it with this error." }
        return "The sandbox stopped it."
    }

    /// The place Always keeps, short (`~` for a home folder).
    public var alwaysPath: String? { always.map { SandboxStop.short($0.path) } }

    /// After Always's place, for the chats: one rule there is every chat's.
    public var alwaysScope: String? { owner?.kind == .chats ? "in every chat" : nil }

    /// Always's button in words, naming the place it keeps: "Always Allow ~/x in every chat".
    public var alwaysTitle: String? {
        alwaysPath.map { "Always Allow \($0)" + (alwaysScope.map { " " + $0 } ?? "") }
    }

    /// What Always does, with its place whole (the button may cut it): its hover text, and for
    /// VoiceOver. "Runs it, and from now on lets Scout’s commands write in ~/x too, in the sandbox."
    public var alwaysHint: String? {
        guard let path = alwaysPath else { return nil }
        let whose = switch owner?.kind {
        case .bot: "\(owner?.name ?? asker)’s commands"
        case .chats: "every chat’s commands"
        case .project, nil: "\(projectName)’s commands"
        }
        return "Runs it, and from now on lets \(whose) write in \(path) too, in the sandbox."
    }

    /// "Scout is waiting for you · 12 min", once it's waited a minute (`now` and `at` in
    /// milliseconds).
    public func waiting(now: Double) -> String? {
        let minutes = Int((now - at) / 60_000)
        return minutes >= 1 ? "\(asker) is waiting for you · \(minutes) min" : nil
    }
}

extension SandboxStop {
    /// Its tag in the card's well.
    public var label: String {
        switch kind {
        case .write: "Write"
        case .read: "Read"
        case .connect: "Connect"
        case .job: "Job"
        case .app: "App"
        case .other: "Other"
        }
    }

    /// What it was stopped doing: its path, or in words where there's none.
    public var detail: String {
        if let path { return Self.short(path) }
        switch kind {
        case .job: return "Start a background job"
        case .app: return "Open or talk to an app"
        case .connect: return "Make a connection"
        default: return "Something the sandbox keeps out"
        }
    }

    /// A path with its home folder as `~`: a Mac's, a Linux machine's or root's.
    public static func short(_ path: String) -> String {
        for prefix in ["/Users/", "/home/"] where path.hasPrefix(prefix) {
            let rest = path.dropFirst(prefix.count)
            guard let slash = rest.firstIndex(of: "/") else { return "~" }
            return "~" + rest[slash...]
        }
        if path == "/root" { return "~" }
        if path.hasPrefix("/root/") { return "~" + path.dropFirst("/root".count) }
        return path
    }
}
