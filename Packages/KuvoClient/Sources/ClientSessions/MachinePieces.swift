import Foundation

/// Which version each of a machine's pieces runs, as its box says it (`kuvo/info`'s `pieces`,
/// PROTOCOL.md "Updates", "A new version while it works"): its link, its coding agents' bridge and
/// its engine, each against the version its files hold now. A Mac that connected puts new files
/// there while the box works; each piece takes them as it starts again. The line both apps show
/// under the machine while one hasn't yet; nothing once all have.
public struct MachinePieces: Decodable, Equatable, Sendable {
    public struct Piece: Decodable, Equatable, Sendable {
        /// The version it runs (nil while it doesn't, or doesn't say).
        public var running: String?
        /// The version its files hold now.
        public var current: String?
        /// It runs another version than its files hold.
        public var behind: Bool

        public init(running: String?, current: String?, behind: Bool) {
            self.running = running
            self.current = current
            self.behind = behind
        }
    }

    /// The coding agents' bridge making way for a newer one in its place: since when (ms since
    /// 1970), and whether new messages wait for it now (it found no quiet moment in time).
    public struct Renewal: Decodable, Equatable, Sendable {
        public var since: Double
        public var holding: Bool

        public init(since: Double, holding: Bool) {
            self.since = since
            self.holding = holding
        }
    }

    public struct Agents: Decodable, Equatable, Sendable {
        /// The build it runs; nil while none runs, or one from before builds were said runs.
        public var running: String?
        public var current: String?
        public var behind: Bool
        /// While it's behind, how it makes way (nil: one that doesn't by itself, from before).
        public var renewal: Renewal?

        public init(running: String?, current: String?, behind: Bool, renewal: Renewal?) {
            self.running = running
            self.current = current
            self.behind = behind
            self.renewal = renewal
        }
    }

    public var link: Piece
    public var agents: Agents
    public var engine: Piece

    public init(link: Piece, agents: Agents, engine: Piece) {
        self.link = link
        self.agents = agents
        self.engine = engine
    }

    /// What's still on an older version, in a sentence each, the coding agents first; nil when
    /// nothing is.
    public var line: String? {
        var said: [String] = []
        if agents.behind {
            if agents.renewal?.holding == true {
                said.append("Its coding agents are moving to a new version: new messages wait until the turns under way finish.")
            } else if agents.running != nil || agents.renewal != nil {
                said.append("Its coding agents move to a new version once nothing runs there.")
            } else {
                said.append("Its coding agents run an older version until its engine next starts.")
            }
        }
        if engine.behind {
            said.append("Its engine runs an older version until it next starts.")
        }
        if link.behind {
            said.append("Its link to your phones and computers runs an older version until it next starts.")
        }
        return said.isEmpty ? nil : said.joined(separator: " ")
    }
}
