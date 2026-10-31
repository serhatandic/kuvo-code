import Foundation

/// The sandbox a computer's agents' commands run in, as its box answers `kuvo/sandbox` (KuvoLink's
/// PROTOCOL.md, "Sandbox"): whether it's on, and when it isn't, why and what you can do. A word a
/// newer box adds reads as none, so `why` is what's left to show. The same in both apps.
public struct SandboxState: Codable, Equatable, Sendable {
    /// Why it isn't on, as a word a client maps.
    public enum Reason: String, Codable, Sendable {
        case kernel, macos, engineMissing, checking, checkFailed, plugin, engineDown, waiting
    }

    /// What you can do about it; `route` is the box's route that does it.
    public enum Action: String, Codable, Sendable {
        case help, softwareUpdate, retry, fix, restartEngine
    }

    /// Which part of the check failed.
    public enum Check: String, Codable, Sendable {
        case folder, tempFiles, readsOwn, writesOwn, didntRun, setup
    }

    /// Every command the engine runs here goes through the sandbox, checked.
    public var on: Bool
    /// Why it isn't on, in the box's own words.
    public var why: String?
    /// This computer can run it at all.
    public var able: Bool
    /// The coding agents' own programs' commands are in it too.
    public var agents: Bool
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

    public init(on: Bool, why: String? = nil, able: Bool = true, agents: Bool = false, reason: Reason? = nil, action: Action? = nil, route: String? = nil, needs: String? = nil, check: Check? = nil, failures: Int? = nil, restart: Bool? = nil) {
        self.restart = restart
        self.on = on
        self.why = why
        self.able = able
        self.agents = agents
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
        reason = try? keys.decodeIfPresent(Reason.self, forKey: .reason)
        action = try? keys.decodeIfPresent(Action.self, forKey: .action)
        route = try keys.decodeIfPresent(String.self, forKey: .route)
        needs = try keys.decodeIfPresent(String.self, forKey: .needs)
        check = try? keys.decodeIfPresent(Check.self, forKey: .check)
        failures = try keys.decodeIfPresent(Int.self, forKey: .failures)
        restart = try? keys.decodeIfPresent(Bool.self, forKey: .restart)
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
/// Always for This would allow (`always`, the one folder it was stopped writing in; none, and it's
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

    public init(id: String, at: Double = 0, session: String? = nil, sessionName: String? = nil, bot: String? = nil, botName: String? = nil, project: String, command: String, why: String, stopped: [SandboxStop]? = nil, error: String? = nil, always: Place? = nil, machine: String? = nil) {
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
    }

    /// Who's asking, by name.
    public var asker: String { botName ?? sessionName ?? "An agent" }

    /// Always for This can be given: the box named the one place to allow.
    public var canAlways: Bool { always != nil }
}

/// An answer to an ask: run it once, run it and keep `always` in Also Allowed, or don't.
public enum SandboxAnswer: String, Codable, Sendable { case once, always, no }

/// A rule kept in a project's Also Allowed: a folder (or file) its commands may write in the sandbox.
public struct SandboxRule: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var project: String
    public var kind: String
    public var path: String
    /// When it was given, in milliseconds.
    public var at: Double
    /// Who gave it (an ask's Always for This, or a client).
    public var by: String?

    public init(id: String, project: String, kind: String = "write", path: String, at: Double = 0, by: String? = nil) {
        self.id = id
        self.project = project
        self.kind = kind
        self.path = path
        self.at = at
        self.by = by
    }
}

/// The answers' envelopes.
public struct SandboxAsks: Codable, Equatable, Sendable {
    public var asks: [SandboxAsk]
    /// The box asks you, once, to restart the agents started before its sandbox was on (`SandboxState.restart`).
    public var restart: Bool?
    public init(asks: [SandboxAsk], restart: Bool? = nil) {
        self.asks = asks
        self.restart = restart
    }
}

public struct SandboxAllowed: Codable, Equatable, Sendable {
    public var allowed: [SandboxRule]
    public init(allowed: [SandboxRule]) { self.allowed = allowed }
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
}

// MARK: The restart card's words

/// How both apps word the box's one ask to restart the agents started before its sandbox was on,
/// on a plain card in that computer's conversations (`SandboxState.restart`).
public enum SandboxRestart {
    public static let title = "Restart agents in the sandbox?"
    public static let detail = "Some agents started before the sandbox was on and still run outside it. Each restarts after its current turn and picks up where it left off. Commands they left running stop."
    public static let restart = "Restart Agents"
    public static let notNow = "Not Now"
}

// MARK: The card's words

/// How both apps word an ask's card (card A): who wants what, what the sandbox stopped, and what
/// Always for This keeps.
extension SandboxAsk {
    /// "Scout wants to run a command outside the sandbox".
    public var title: String { "\(asker) wants to run a command outside the sandbox" }

    /// The project's folder by its name.
    public var projectName: String {
        let name = (project as NSString).lastPathComponent
        return name.isEmpty ? project : name
    }

    /// What stopped it, in a sentence under the title: by the first thing the sandbox refused, or
    /// the error the command got where it can't say (Linux).
    public var subtitle: String {
        if let first = stopped?.first {
            switch first.kind {
            case .write: return "The sandbox stopped it from changing a file outside \(projectName)."
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

    /// The place Always for This keeps, short (`~` for a home folder).
    public var alwaysPath: String? { always.map { SandboxStop.short($0.path) } }

    /// What Always for This does, in full, for VoiceOver and its help.
    public var alwaysMeaning: String? {
        alwaysPath.map { "Run it outside the sandbox now, and from now on let commands in \(projectName) write in \($0), in the sandbox" }
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
