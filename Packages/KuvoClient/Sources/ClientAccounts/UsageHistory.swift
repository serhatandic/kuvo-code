import Foundation

/// What your accounts used, by the day, as a box states it (`GET kuvo/agents/api/kuvo/usage?zone=`,
/// PROTOCOL.md "Usage history"): one row per account across your computers, each account's days
/// added up from every box it's used on, and each service's (every account added up). The box works
/// the days out in the zone the client asks for: a client only draws them.
public struct BoxUsage: Decodable, Hashable, Sendable {
    /// The zone the days are in (the box's own when the one asked for isn't one it knows).
    public var zone: String
    /// The services (`claude`…) this box states the usage of: a client shows those from here.
    public var services: [String]
    /// When this box last read its own accounts' logs, in ms.
    public var scanned: Double?
    public var rows: [Row]
    /// Each service's days, every account of it on your own computers added up (not a box a peer
    /// vouches for: another Mac beside a machine you share may be another person's).
    public var totals: [String: [Day]]
    /// A service whose totals are short: one of your computers is away (its share as of then), or
    /// told less than all of it (`cut`: its oldest days).
    public var partial: [String: Partial]
    /// How this box prices what has no known price: Codex's fallback model (nil from a box from before).
    public var codexFallback: Fallback?

    /// A fallback model: the one this box prices its own logs with (nil: none), those it may be
    /// (`choices`, in order), and whether it was ever chosen on this box (none counts).
    public struct Fallback: Decodable, Hashable, Sendable {
        public var model: String?
        public var choices: [String]
        public var chosen: Bool

        private enum CodingKeys: String, CodingKey { case fallback, choices, chosen }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            model = (try? container.decodeIfPresent(String.self, forKey: .fallback)).flatMap { $0.isEmpty ? nil : $0 }
            choices = (try? container.decodeIfPresent([String].self, forKey: .choices)) ?? []
            chosen = (try? container.decodeIfPresent(Bool.self, forKey: .chosen)) ?? false
        }
    }

    private struct Pricing: Decodable {
        var codex: Fallback?
    }

    public struct Partial: Decodable, Hashable, Sendable {
        public var away: Bool
        public var cut: Bool

        private enum CodingKeys: String, CodingKey { case away, cut }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            away = (try? container.decodeIfPresent(Bool.self, forKey: .away)) ?? false
            cut = (try? container.decodeIfPresent(Bool.self, forKey: .cut)) ?? false
        }
    }

    public struct Day: Decodable, Hashable, Sendable {
        /// `yyyy-MM-dd` in `zone`.
        public var date: String
        public var tokens: Int
        /// US dollars, estimated from what each model costs.
        public var cost: Double
        public var models: [Model]
        /// Models used that day that couldn't be priced (counted nowhere).
        public var unknown: [String]
        /// The models whose rates estimated some of that day's cost for models with no known price.
        public var fallback: [String]

        public init(date: String, tokens: Int, cost: Double, models: [Model], unknown: [String] = [], fallback: [String] = []) {
            self.date = date
            self.tokens = tokens
            self.cost = cost
            self.models = models
            self.unknown = unknown
            self.fallback = fallback
        }

        private enum CodingKeys: String, CodingKey { case date, tokens, cost, models, unknown, fallback }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            date = try container.decode(String.self, forKey: .date)
            tokens = try container.decode(Int.self, forKey: .tokens)
            cost = try container.decode(Double.self, forKey: .cost)
            models = (try? container.decode(Readable<Model>.self, forKey: .models).items) ?? []
            unknown = (try? container.decodeIfPresent([String].self, forKey: .unknown)) ?? []
            fallback = (try? container.decodeIfPresent([String].self, forKey: .fallback)) ?? []
        }
    }

    public struct Model: Decodable, Hashable, Sendable {
        public var model: String
        public var tokens: Int
        public var cost: Double
        /// The row it shows under, where that isn't its own name (Cursor's effort and speed
        /// variants of one model, as the box's prices group them).
        public var family: String?

        public init(model: String, tokens: Int, cost: Double, family: String? = nil) {
            self.model = model
            self.tokens = tokens
            self.cost = cost
            self.family = family
        }

        private enum CodingKeys: String, CodingKey { case model, tokens, cost, family }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            model = try container.decode(String.self, forKey: .model)
            tokens = try container.decode(Int.self, forKey: .tokens)
            cost = try container.decode(Double.self, forKey: .cost)
            family = (try? container.decodeIfPresent(String.self, forKey: .family))?.flatMap { $0.isEmpty ? nil : $0 }
        }
    }

    /// One account across your computers.
    public struct Row: Decodable, Hashable, Sendable {
        /// The same as its plan limits row's `id`: limits and usage of an account go side by side.
        public var id: String
        public var service: String
        public var provider: String
        public var label: String?
        public var scanned: Double?
        /// Every computer it's used on is away: its numbers are as of then.
        public var away: Bool
        /// Its dollars are an estimate (priced from the logs); false where its maker billed them
        /// (OpenCode's hosted models).
        public var estimated: Bool
        /// Its maker's account of the whole account (Cursor's), not what each computer's logs say:
        /// its days are its newest computer's, not a sum.
        public var accountWide: Bool
        public var days: [Day]

        private enum CodingKeys: String, CodingKey { case id, service, provider, label, scanned, away, estimated, accountWide, days }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            service = try container.decode(String.self, forKey: .service)
            provider = try container.decode(String.self, forKey: .provider)
            label = try? container.decodeIfPresent(String.self, forKey: .label)
            scanned = try? container.decodeIfPresent(Double.self, forKey: .scanned)
            away = (try? container.decodeIfPresent(Bool.self, forKey: .away)) ?? false
            estimated = (try? container.decodeIfPresent(Bool.self, forKey: .estimated)) ?? true
            accountWide = (try? container.decodeIfPresent(Bool.self, forKey: .accountWide)) ?? false
            days = (try? container.decode(Readable<Day>.self, forKey: .days).items) ?? []
        }
    }

    private enum CodingKeys: String, CodingKey { case zone, services, scanned, rows, totals, partial, pricing }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        zone = (try? container.decode(String.self, forKey: .zone)) ?? TimeZone.current.identifier
        services = (try? container.decodeIfPresent([String].self, forKey: .services)) ?? []
        scanned = try? container.decodeIfPresent(Double.self, forKey: .scanned)
        rows = (try? container.decode(Readable<Row>.self, forKey: .rows).items) ?? []
        var totals: [String: [Day]] = [:]
        if let given = try? container.decodeIfPresent([String: Readable<Day>].self, forKey: .totals) {
            for (service, days) in given { totals[service] = days.items }
        }
        self.totals = totals
        partial = (try? container.decodeIfPresent([String: Partial].self, forKey: .partial)) ?? [:]
        codexFallback = (try? container.decodeIfPresent(Pricing.self, forKey: .pricing))?.codex
    }

    /// Where a box's bridge answers it (with `zone`, the client's time zone, as a query), and reads it again.
    public static let bridgePath = "api/kuvo/usage"
    public static let bridgeRefreshPath = "api/kuvo/usage/refresh"
    /// `PUT` `{"codex": {"fallback": <model> | null}}`: Codex's fallback model, this box's; answers as `bridgePath` does.
    public static let bridgePricingPath = "api/kuvo/usage/pricing"

    /// The event that says it changed, on the bridge's events: ask again.
    public static let event = "kuvo.usage.updated"
}
