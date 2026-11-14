import Foundation

/// A computer's vault as its box answers `kuvo/vault` (KuvoLink's PROTOCOL.md, "Vault"): how it
/// stands, its items without their values, and who may use which. The same in both apps.
public struct Vault: Codable, Equatable, Sendable {
    public var state: VaultState
    public var items: [VaultItem]
    public var grants: [VaultGrant]

    public init(state: VaultState, items: [VaultItem], grants: [VaultGrant]) {
        self.state = state
        self.items = items
        self.grants = grants
    }

    /// The grants for one item.
    public func grants(for item: VaultItem) -> [VaultGrant] { grants.filter { $0.item == item.id } }

    /// How a bot may use an item: its own grant, or one for everyone; nil for neither.
    public func how(_ item: VaultItem, bot: String) -> VaultGrant.How? {
        let fitting = grants(for: item).filter { $0.who.bot == bot || $0.who.everyone == true }
        if fitting.contains(where: { $0.how == .own }) { return .own }
        return fitting.isEmpty ? nil : .ask
    }

    /// The bot's own grants: the items it may use, and how.
    public func items(of bot: String) -> [(item: VaultItem, how: VaultGrant.How)] {
        items.compactMap { item in how(item, bot: bot).map { (item, $0) } }
    }

    /// Sign-ins for a page on `host`: the site's own and those under it.
    public func signIns(for host: String) -> [VaultItem] {
        let host = host.lowercased()
        return items.filter { $0.kind == .login && $0.sites.contains { host == $0 || host.hasSuffix("." + $0) } }
    }
}

public struct VaultState: Codable, Equatable, Sendable {
    public var made: Bool
    public var locked: Bool
    public var paused: Bool
    /// Bots whose use is paused (by id), and conversations that aren't a bot's (by session): why.
    public var pausedBots: [String: String]
    /// "keychain" (this Mac's) or "encrypted" (a machine's own store).
    public var store: String
    public var keptDays: Int
    /// Whether agents may use it on this computer: only where their commands are fenced. (Absent
    /// from a box older than the fence: yes.)
    public var agents: Bool?
    /// Its sandbox is on, and agents started before it came on still run: agents may use it once
    /// they're done.
    public var agentsWaiting: Bool?
    /// Its files were changed outside Kuvo Code, so it uses none of them.
    public var tampered: Bool?
    /// Each signed file's generation (`items`, `grants`, `paused`), for a client to remember and
    /// check: lower than one seen before means an older copy was put back.
    public var generations: [String: Int]?

    public init(made: Bool = true, locked: Bool = false, paused: Bool = false, pausedBots: [String: String] = [:], store: String = "keychain", keptDays: Int = 365, agents: Bool? = nil, tampered: Bool? = nil) {
        self.made = made
        self.locked = locked
        self.paused = paused
        self.pausedBots = pausedBots
        self.store = store
        self.keptDays = keptDays
        self.agents = agents
        self.tampered = tampered
    }

    /// While agents started before the sandbox was on still run: the same words everywhere.
    public static let lockedForOlderAgents = "Locked for now: some agents started before the sandbox was on. The vault opens when they finish."

    /// What its Vault page says while agents can't use its keys, files and notes; nil while they
    /// can.
    public func agentsNote(computer: String) -> String? {
        guard agents == false else { return nil }
        if agentsWaiting == true {
            return Self.lockedForOlderAgents
        }
        return "Agents can’t use keys, files and notes from \(computer)’s vault yet. Sign-ins you let them use on their own still fill."
    }

    /// What a bot's own vault list says meanwhile; nil while agents can use it.
    public var botAgentsNote: String? {
        guard agents == false else { return nil }
        if agentsWaiting == true {
            return Self.lockedForOlderAgents
        }
        return "For now it only fills sign-ins set to On Its Own. It can’t use keys, files or notes yet."
    }
}

public struct VaultItem: Codable, Equatable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case login, key, file, note

        /// What it's called in a list.
        public var title: String {
            switch self {
            case .login: "Sign-in"
            case .key: "API key"
            case .file: "File"
            case .note: "Note"
            }
        }

        /// The values it holds, by field, as a new one starts.
        public var fields: [String] {
            switch self {
            case .login: ["password"]
            case .key: ["value"]
            case .file: ["file"]
            case .note: ["text"]
            }
        }
    }

    public var id: String
    public var kind: Kind
    public var name: String
    public var sites: [String]
    public var username: String?
    public var fields: [String]
    public var fileName: String?
    public var readable: Bool?
    /// A sign-in only filled in to sign in, in the browser: never handed to a command.
    public var signInOnly: Bool?
    /// When it was made, changed and last used, in milliseconds since 1970.
    public var created: Double
    public var changed: Double
    public var used: Double?

    public init(id: String, kind: Kind, name: String, sites: [String] = [], username: String? = nil, fields: [String] = [], fileName: String? = nil, readable: Bool? = nil, signInOnly: Bool? = nil, created: Double = 0, changed: Double = 0, used: Double? = nil) {
        self.id = id
        self.kind = kind
        self.name = name
        self.sites = sites
        self.username = username
        self.fields = fields
        self.fileName = fileName
        self.readable = readable
        self.signInOnly = signInOnly
        self.created = created
        self.changed = changed
        self.used = used
    }

    /// The line under its name in a list: who it signs in as and where, the file it is, or where it's used.
    public var subtitle: String {
        switch kind {
        case .login: [username, sites.first].compactMap { $0 }.joined(separator: " · ")
        case .file: fileName.flatMap { $0 == name ? nil : $0 } ?? "A file"
        case .note: readable == true ? "Bots may read it" : "A note"
        case .key: sites.isEmpty ? (fields.count > 1 ? fields.joined(separator: ", ") : "A key") : sites.joined(separator: ", ")
        }
    }

    public var lastUsed: Date? { used.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

public struct VaultGrant: Codable, Equatable, Hashable, Sendable {
    public enum How: String, Codable, Sendable {
        /// Used on its own.
        case own
        /// You're asked each time.
        case ask
    }

    public struct Who: Codable, Equatable, Hashable, Sendable {
        public var bot: String?
        public var project: String?
        public var everyone: Bool?

        public init(bot: String? = nil, project: String? = nil, everyone: Bool? = nil) {
            self.bot = bot
            self.project = project
            self.everyone = everyone
        }
    }

    public var item: String
    public var who: Who
    public var how: How
    public var at: Double

    public init(item: String, who: Who, how: How, at: Double = 0) {
        self.item = item
        self.who = who
        self.how = how
        self.at = at
    }
}

/// What agents wait on you for: to use an item (`use`), or something they need (`item`).
public struct VaultAsk: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable { case use, item }

    public var id: String
    public var kind: Kind
    public var at: Double
    public var session: String?
    public var sessionName: String?
    public var bot: String?
    public var botName: String?
    public var item: String?
    public var itemName: String?
    public var need: String?
    public var why: String?
    public var site: String?
    public var machine: String?
    /// From a bot's seat in this group chat, where it shows: you answer it this once, never for good.
    public var group: String?

    public init(id: String, kind: Kind, at: Double = 0, session: String? = nil, sessionName: String? = nil, bot: String? = nil, botName: String? = nil, item: String? = nil, itemName: String? = nil, need: String? = nil, why: String? = nil, site: String? = nil, machine: String? = nil, group: String? = nil) {
        self.id = id
        self.kind = kind
        self.at = at
        self.session = session
        self.sessionName = sessionName
        self.bot = bot
        self.botName = botName
        self.item = item
        self.itemName = itemName
        self.need = need
        self.why = why
        self.site = site
        self.machine = machine
        self.group = group
    }

    /// Whether you may answer it for good (Always Allow, From Now On).
    public var mayAllowAlways: Bool { group == nil }

    /// Who's asking, by name.
    public var asker: String { botName ?? sessionName ?? "An agent" }

    /// The card's title, as both apps word it.
    public var title: String {
        switch kind {
        case .use: "\(asker) wants to use \(itemName ?? "an item")"
        case .item: "\(asker) needs \(need ?? "something from your vault")"
        }
    }
}

/// One line of a vault's activity, as its box keeps it: never a value.
public struct VaultActivity: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var at: Double
    public var what: String
    public var item: String?
    public var itemName: String?
    public var kind: VaultItem.Kind?
    public var bot: String?
    public var botName: String?
    public var session: String?
    public var sessionName: String?
    public var client: String?
    /// Whether the client reading it did it: the box tells by who it is, not its name, which phones
    /// may share ("iPhone").
    public var mine: Bool?
    public var site: String?
    public var program: String?
    public var how: String?
    public var why: String?

    public init(id: String, at: Double, what: String, item: String? = nil, itemName: String? = nil, kind: VaultItem.Kind? = nil, bot: String? = nil, botName: String? = nil, session: String? = nil, sessionName: String? = nil, client: String? = nil, mine: Bool? = nil, site: String? = nil, program: String? = nil, how: String? = nil, why: String? = nil) {
        self.id = id
        self.at = at
        self.what = what
        self.item = item
        self.itemName = itemName
        self.kind = kind
        self.bot = bot
        self.botName = botName
        self.session = session
        self.sessionName = sessionName
        self.client = client
        self.mine = mine
        self.site = site
        self.program = program
        self.how = how
        self.why = why
    }

    public var date: Date { Date(timeIntervalSince1970: at / 1000) }

    /// Whether it's one you'd want to look at: refused, or a bot paused.
    public var isWarning: Bool { what == "refused" && how != "no grant" && how != "autopilot" }

    /// What happened, in a sentence both apps show. What you did from the client reading it
    /// (`mine`) says only what happened ("Added “GitHub”"); who and where are said when it was
    /// somewhere else. A line no client is named on (an older box's, kept before it knew who did
    /// it) says what happened without saying who.
    public var sentence: String {
        if mine == true {
            let item = itemName.map { "“\($0)”" } ?? "an item"
            let agent = botName ?? sessionName ?? "an agent"
            switch what {
            case "allowed": return "Let \(agent) use \(item)\(how == "always" ? " from now on" : " once")"
            case "declined": return "Said no to \(agent) using \(item)"
            case "added": return "Added \(item)"
            case "changed": return "Changed \(item)"
            case "removed": return "Removed \(item)"
            case "shown": return "Looked at \(item)"
            default: break
            }
        }
        if client == nil {
            let item = itemName.map { "“\($0)”" }
            let agent = botName ?? sessionName ?? "An agent"
            switch what {
            case "allowed": return how == "always" ? "\(agent) may use \(item ?? "an item") from now on" : "\(agent) was allowed \(item ?? "an item") once"
            case "declined": return "\(agent) wasn’t allowed \(item ?? "an item")"
            case "added": return "\(item ?? "An item") was added"
            case "changed": return "\(item ?? "An item") was changed"
            case "removed": return "\(item ?? "An item") was removed"
            case "shown": return "\(item ?? "An item") was looked at"
            default: break
            }
        }
        // You, on the client you did it from: "Mac" is the Mac that keeps it, or a machine's.
        let you = client.map { "You, on \($0 == "Mac" ? "your Mac" : $0)," } ?? "You"
        let who = botName ?? sessionName ?? (client == nil ? "An agent" : you)
        let item = itemName.map { "“\($0)”" } ?? "an item"
        let where_ = site.map { " on \($0)" } ?? program.map { " with \($0)" } ?? ""
        switch what {
        case "used": return "\(who) used \(item)\(where_)" + (how == "once" ? ", allowed once" : how == "always" ? ", now always allowed" : "")
        case "asked": return itemName == nil ? "\(who) asked for something from the vault" : "\(who) asked to use \(item)\(where_)"
        case "allowed": return "\(you) let \(botName ?? sessionName ?? "an agent") use \(item)\(how == "always" ? " from now on" : " once")"
        case "declined": return "\(you) said no to \(botName ?? sessionName ?? "an agent") using \(item)"
        case "refused":
            switch how {
            case "wrong site": return "Refused \(item)\(where_): not one of its sites. \(botName ?? "The bot") was paused"
            case "paused": return "\(who) couldn’t use \(item): paused"
            case "autopilot": return itemName == nil ? "\(who) went on without something from your vault, on Autopilot" : "\(who) left \(item) for you, on Autopilot"
            default: return "\(who) wasn’t allowed \(item)"
            }
        case "added": return "\(you) added \(item)"
        case "changed": return "\(you) changed \(item)"
        case "removed": return "\(you) removed \(item)"
        case "shown": return "\(you) looked at \(item)"
        case "granted": return "\(item) is now \(how == "own" ? "used on its own" : "asked for each time") by \(botName ?? "everyone allowed")"
        case "ungranted": return "\(item) taken away from \(botName ?? "an agent")"
        case "paused": return botName.map { "\($0)’s use of the vault was paused" } ?? "The vault was paused"
        case "resumed": return botName.map { "\($0)’s use of the vault goes on again" } ?? "The vault goes on again"
        default: return "\(who): \(what) \(item)"
        }
    }

    /// The sentence; `here` no longer counts, since phones may share a name: the box says which
    /// lines are the reader's own (`mine`).
    @available(*, deprecated, message: "Use `sentence`: the box marks the reader's own lines (`mine`).")
    public func sentence(here _: String?) -> String { sentence }
}

/// What an item is made or changed with (`POST kuvo/vault/items`, `PATCH kuvo/vault/items/<id>`).
public struct VaultDraft: Sendable {
    public var kind: VaultItem.Kind
    public var name: String
    public var sites: [String]
    public var username: String?
    public var fileName: String?
    public var readable: Bool?
    /// A sign-in only for signing in, in the browser (nil leaves it as it is).
    public var signInOnly: Bool?
    /// Values by field; nil takes one away (a change only).
    public var values: [String: String?]

    public init(kind: VaultItem.Kind, name: String, sites: [String] = [], username: String? = nil, fileName: String? = nil, readable: Bool? = nil, signInOnly: Bool? = nil, values: [String: String?] = [:]) {
        self.kind = kind
        self.name = name
        self.sites = sites
        self.username = username
        self.fileName = fileName
        self.readable = readable
        self.signInOnly = signInOnly
        self.values = values
    }

    /// Its body.
    public var json: [String: Any] {
        var body: [String: Any] = ["kind": kind.rawValue, "name": name, "sites": sites]
        body["username"] = username ?? ""
        if kind == .file { body["fileName"] = fileName ?? "" }
        if kind == .note { body["readable"] = readable == true }
        if kind == .login, let signInOnly { body["signInOnly"] = signInOnly }
        if !values.isEmpty { body["values"] = values.mapValues { $0 as Any? ?? NSNull() } }
        return body
    }
}

/// The routes, as a client calls them.
public enum VaultRoutes {
    public static let vault = "kuvo/vault"
    public static let items = "kuvo/vault/items"
    public static func item(_ id: String) -> String { "kuvo/vault/items/\(id)" }
    public static func values(_ id: String) -> String { "kuvo/vault/items/\(id)/values" }
    /// Whether values given are the ones kept, without giving them (`vault.same`).
    public static func same(_ id: String) -> String { "kuvo/vault/items/\(id)/same" }
    public static let grants = "kuvo/vault/grants"
    public static let pause = "kuvo/vault/pause"
    public static let key = "kuvo/vault/key"
    public static let unlock = "kuvo/vault/unlock"
    public static let asks = "kuvo/vault/asks"
    public static let askEvents = "kuvo/vault/asks/events"
    public static func ask(_ id: String) -> String { "kuvo/vault/asks/\(id)" }
    public static func activity(item: String? = nil, bot: String? = nil, session: String? = nil, limit: Int = 100) -> String {
        var query = ["limit=\(limit)"]
        if let item { query.append("item=\(item)") }
        if let bot { query.append("bot=\(bot)") }
        if let session { query.append("session=\(session)") }
        return "kuvo/vault/activity?" + query.joined(separator: "&")
    }
}
