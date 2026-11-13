import ClientAccounts
import Foundation
import Testing

/// What both apps show of a box's plan limits, from its route's answer as a box sends it.
struct PlanLimitsTests {
    /// `kuvo/agents/api/kuvo/limits`, as a box answers it: two Claude logins, the engine's Copilot,
    /// and a window from a newer box this copy can't read.
    let answer = """
    {"data": {"services": ["claude", "codex", "copilot"], "accounts": [
      {"provider": "claude-code", "service": "claude", "agent": "claude", "account": "default", "plan": "Max 20x", "next": 1794170000000,
       "windows": [
         {"id": "five_hour", "used": 0.42, "minutes": 300, "resetsAt": 1794180000000, "read": 1794160000000, "source": "turn"},
         {"id": "seven_day", "used": 0.18, "minutes": 10080, "resetsAt": 1794600000000, "read": 1794150000000, "source": "turn"},
         {"id": "seven_day_fable", "used": 0.07, "minutes": 10080, "model": "Fable", "resetsAt": 1794600000000, "read": 1794150000000, "source": "turn"},
         {"id": "from_the_future", "used": "a lot"}
       ]},
      {"provider": "claude-code@1f2e3d4c", "service": "claude", "agent": "claude", "account": "1f2e3d4c", "label": "Work",
       "windows": [{"id": "five_hour", "used": 0.9, "minutes": 300, "resetsAt": 1794100000000, "read": 1794090000000, "source": "usage"}],
       "problem": {"kind": "rate-limited", "message": "Anthropic is turning away reads of the plan's limits for now.", "until": 1794173000000}},
      {"provider": "github-copilot", "service": "copilot", "plan": "Individual Pro",
       "windows": [{"id": "premium_interactions", "name": "Premium requests", "used": 0.6, "minutes": 43200, "amount": {"used": 180, "limit": 300, "unit": "requests"}, "read": 1794160000000, "source": "usage"}]},
      {"provider": "openrouter", "service": "openrouter", "windows": [], "balance": {"left": 12.5, "unit": "usd"}}
    ]}}
    """

    let now = Date(timeIntervalSince1970: 1_794_165_000)

    @Test func eachLoginIsARowOfItsOwnByName() throws {
        let limits = try BoxLimits.decode(Data(answer.utf8))
        #expect(limits.services == ["claude", "codex", "copilot"])
        #expect(limits.accounts.map(\.title) == ["Claude", "Claude · Work", "Copilot", "OpenRouter"])
        #expect(limits.accounts[3].balance?.left == 12.5)
    }

    @Test func windowsAreNamedAsTheUsagePanelNamesThem() throws {
        let limits = try BoxLimits.decode(Data(answer.utf8))
        // The one this copy can't read is left out, not the account.
        #expect(limits.accounts[0].windows.map(\.title) == ["Session", "Weekly", "Fable"])
        #expect(limits.accounts[2].windows.map(\.title) == ["Premium requests"])
        #expect(limits.accounts[2].windows[0].amount?.limit == 300)
    }

    @Test func aWindowThatStartedOverSinceIsNotShownAsUsed() throws {
        let limits = try BoxLimits.decode(Data(answer.utf8))
        // Work's session reset after it was read: what's used now isn't known.
        #expect(limits.accounts[1].windows(at: now).isEmpty)
        #expect(limits.accounts[1].tightest(at: now) == nil)
        #expect(limits.accounts[1].problem?.kind == "rate-limited")
        #expect(limits.accounts[0].tightest(at: now)?.id == "five_hour")
        // As of when it was last heard of; out of date once that's over half an hour.
        #expect(limits.accounts[0].readAt(now: now) == Date(timeIntervalSince1970: 1_794_160_000))
        #expect(!limits.accounts[0].isOutdated(now: Date(timeIntervalSince1970: 1_794_161_000)))
        #expect(limits.accounts[0].isOutdated(now: Date(timeIntervalSince1970: 1_794_162_000)))
    }

    @Test func theEventCarriesTheAccountsAlone() throws {
        let event = #"{"accounts": [{"provider": "codex-cli", "agent": "codex", "windows": []}]}"#
        let limits = try BoxLimits.decode(Data(event.utf8))
        #expect(limits.accounts.map(\.title) == ["Codex"])
        // (A box from before it said what service an account is: its agent.)
        #expect(limits.accounts[0].service == "codex")
        #expect(limits.services.isEmpty)
    }

    /// The Mac panel's providers as `kuvo/usage` lists them: Cursor, Claude's place (covered, its
    /// spend only), Copilot, OpenRouter's place.
    struct Entry: Equatable { var id: String; var covers: String? }

    @Test func everyClientListsABoxsRowsWhereTheMacPanelSaysTheyGo() throws {
        let limits = try BoxLimits.decode(Data(answer.utf8))
        let panel = [Entry(id: "cursor"), Entry(id: "claude", covers: "claude"), Entry(id: "copilot"), Entry(id: "openrouter", covers: "openrouter")]
        let listed = UsageListing.items(panel: panel, covers: \.covers, accounts: limits.accounts).map { item -> String in
            switch item {
            case .panel(let entry): "panel:\(entry.id)"
            case .account(let row, let below): row.account.title + (below.map { " +\($0.id)" } ?? "")
            }
        }
        // The box's Copilot comes after: the panel's own Copilot isn't one it covers here.
        #expect(listed == ["panel:cursor", "Claude +claude", "Claude · Work", "panel:copilot", "OpenRouter +openrouter", "Copilot"])
        // A machine's: no panel, every row.
        #expect(UsageListing.items(panel: [Entry](), covers: \.covers, accounts: limits.accounts).count == 4)
    }

    // MARK: One row per account, across computers

    /// A box's answer, as `kuvo/agents/api/kuvo/limits` sends it.
    func box(_ accounts: String) throws -> [LimitsAccount] {
        try BoxLimits.decode(Data(#"{"data": {"services": [], "accounts": [\#(accounts)]}}"#.utf8)).accounts
    }

    /// Claude's own sign-in, as a box states it: `used` of its session and week, read at `read` (s).
    func claude(_ identity: String?, used: Double, read: Double, provider: String = "claude-code", label: String? = nil, problem: Bool = false) -> String {
        let windows = #"[{"id": "five_hour", "used": \#(used), "minutes": 300, "resetsAt": 1794180000000, "read": \#(read * 1000), "source": "usage"}, {"id": "seven_day", "used": \#(used / 2), "minutes": 10080, "resetsAt": 1794600000000, "read": \#(read * 1000), "source": "usage"}]"#
        return #"{"provider": "\#(provider)", "service": "claude", "agent": "claude", "account": "default", "plan": "Max 20x", "checked": \#(read * 1000), "windows": \#(windows)"#
            + (identity.map { #", "identity": "\#($0)""# } ?? "") + (label.map { #", "label": "\#($0)""# } ?? "")
            + (problem ? #", "problem": {"kind": "rate-limited", "message": "Anthropic is turning away reads of the plan's limits for now."}"# : "") + "}"
    }

    @Test func oneAccountSignedInOnTwoComputersIsOneRowWithTheNewestNumbers() throws {
        let rows = UsageListing.accounts([
            .init(key: "mac", name: nil, accounts: try box(claude("a1b2c3d4e5f60718", used: 0.40, read: 1_794_160_000))),
            .init(key: "hetzner", name: "hetzner", accounts: try box(claude("a1b2c3d4e5f60718", used: 0.53, read: 1_794_164_000))),
            .init(key: "mini", name: "mini-local", accounts: try box(claude("a1b2c3d4e5f60718", used: 0.45, read: 1_794_162_000))),
        ])
        #expect(rows.map(\.account.title) == ["Claude"])
        #expect(rows[0].account.tightest(at: now)?.used == 0.53)
        #expect(rows[0].account.readAt(now: now) == Date(timeIntervalSince1970: 1_794_164_000))
        #expect(rows[0].sources.map(\.box) == ["mac", "hetzner", "mini"])
    }

    @Test func everyComputersAccountsAreListedOnceWhereTheFirstMacsPanelSaysTheyGo() throws {
        // The phone's list: the first Mac's panel places them; its machine has the same Claude, and
        // one of its own the panel doesn't cover.
        let panel = [Entry(id: "cursor"), Entry(id: "claude", covers: "claude")]
        let listed = UsageListing.items(panel: panel, covers: \.covers, boxes: [
            .init(key: "mac", name: nil, accounts: try box(claude("a1b2c3d4e5f60718", used: 0.40, read: 1_794_160_000))),
            .init(key: "hetzner", name: "hetzner", accounts: try box([
                claude("a1b2c3d4e5f60718", used: 0.53, read: 1_794_164_000),
                claude("bbbbbbbbbbbbbbbb", used: 0.9, read: 1_794_161_000, provider: "claude-code@1f2e3d4c", label: "Athas"),
            ].joined(separator: ","))),
        ]).map { item -> String in
            switch item {
            case .panel(let entry): "panel:\(entry.id)"
            case .account(let row, let below): row.account.title + (below.map { " +\($0.id)" } ?? "") + " on " + row.sources.map(\.box).joined(separator: ",")
            }
        }
        #expect(listed == ["panel:cursor", "Claude +claude on mac,hetzner", "Claude · Athas on hetzner"])
    }

    /// Boxes from before rows, merged here as the box merges them: an account's `extras` are its
    /// newest reading's that had no problem, and a reading without any says there are none now.
    @Test func mergedExtrasAreTheNewestGoodReadings() throws {
        func cursor(_ read: Double, extras: Bool, problem: Bool = false) -> String {
            #"{"provider": "cursor", "service": "cursor", "agent": "cursor", "account": "default", "identity": "cccccccccccccccc", "checked": \#(read * 1000), "windows": []"#
                + (extras ? #", "extras": [{"id": "on_demand", "name": "On-demand", "kind": "spent", "amount": 43, "unit": "usd"}]"# : "")
                + (problem ? #", "problem": {"kind": "failed", "message": "x"}"# : "") + "}"
        }
        let capped = UsageListing.accounts([
            .init(key: "mac", name: nil, accounts: try box(cursor(1_794_160_000, extras: true))),
            .init(key: "dev", name: "dev", accounts: try box(cursor(1_794_164_000, extras: false))),
        ])
        #expect(capped[0].account.extras.isEmpty)
        let failedSince = UsageListing.accounts([
            .init(key: "mac", name: nil, accounts: try box(cursor(1_794_160_000, extras: true))),
            .init(key: "dev", name: "dev", accounts: try box(cursor(1_794_164_000, extras: false, problem: true))),
        ])
        #expect(failedSince[0].account.extras.map(\.name) == ["On-demand"])
    }

    @Test func twoAccountsOfOneProviderStayTwoRowsByTheirOwnNames() throws {
        let rows = UsageListing.accounts([
            .init(key: "mac", name: nil, accounts: try box(claude("aaaaaaaaaaaaaaaa", used: 0.4, read: 1_794_160_000))),
            .init(key: "hetzner", name: "hetzner", accounts: try box([
                claude("aaaaaaaaaaaaaaaa", used: 0.5, read: 1_794_161_000),
                claude("bbbbbbbbbbbbbbbb", used: 0.9, read: 1_794_161_000, provider: "claude-code@1f2e3d4c", label: "Athas"),
            ].joined(separator: ","))),
        ])
        #expect(rows.map(\.account.title) == ["Claude", "Claude · Athas"])
        #expect(rows.map { $0.account.tightest(at: now)?.used } == [0.5, 0.9])
    }

    @Test func aBoxThatDoesntSayWhoAnAccountIsStillShowsIt() throws {
        // An older box (no identity), and a Mac's Claude token before Claude Code has run with it,
        // which can't say yet: each its box's own row, named for where it's from only where two
        // would have one name.
        let rows = UsageListing.accounts([
            .init(key: "mac", name: nil, accounts: try box(claude(nil, used: 0.4, read: 1_794_160_000))),
            .init(key: "hetzner", name: "hetzner", accounts: try box(claude("aaaaaaaaaaaaaaaa", used: 0.5, read: 1_794_161_000))),
            .init(key: "lokum", name: "lokum", accounts: try box(claude("aaaaaaaaaaaaaaaa", used: 0.5, read: 1_794_161_000))),
            .init(key: "old", name: "old-box", accounts: try box(#"{"provider": "codex-cli", "agent": "codex", "windows": []}"#)),
        ])
        #expect(rows.map(\.account.title) == ["Claude", "Claude · hetzner, lokum", "Codex"])
        #expect(rows[1].sources.map(\.box) == ["hetzner", "lokum"])
    }

    @Test func aProblemShowsOnlyWhenNoComputerCanReadIt() throws {
        let one = UsageListing.accounts([
            .init(key: "mac", name: nil, accounts: try box(claude("aaaaaaaaaaaaaaaa", used: 0.4, read: 1_794_160_000, problem: true))),
            .init(key: "hetzner", name: "hetzner", accounts: try box(claude("aaaaaaaaaaaaaaaa", used: 0.5, read: 1_794_150_000))),
        ])
        #expect(one[0].account.problem == nil)
        let none = UsageListing.accounts([
            .init(key: "mac", name: nil, accounts: try box(claude("aaaaaaaaaaaaaaaa", used: 0.4, read: 1_794_160_000, problem: true))),
            .init(key: "hetzner", name: "hetzner", accounts: try box(claude("aaaaaaaaaaaaaaaa", used: 0.5, read: 1_794_150_000, problem: true))),
        ])
        #expect(none[0].account.problem?.kind == "rate-limited")
    }

    @Test func aCodingAgentsAndTheEnginesSignInToOneAccountAreOneRow() throws {
        // Codex's own sign-in and the engine's ChatGPT, one account, each naming its windows its own
        // way: one row, each window once, as read last.
        let accounts = try box(#"""
        {"provider": "codex-cli", "service": "codex", "agent": "codex", "account": "default", "identity": "c0dec0dec0dec0de", "windows": [
          {"id": "primary", "used": 0.30, "minutes": 300, "read": 1794160000000, "source": "turn"},
          {"id": "codex_spark.primary", "used": 0.05, "minutes": 300, "model": "GPT-5.3-Codex-Spark", "read": 1794160000000, "source": "usage"}]},
        {"provider": "openai", "service": "codex", "identity": "c0dec0dec0dec0de", "plan": "Pro", "windows": [
          {"id": "primary", "used": 0.25, "minutes": 300, "read": 1794150000000, "source": "usage"},
          {"id": "secondary", "used": 0.60, "minutes": 10080, "read": 1794150000000, "source": "usage"},
          {"id": "GPT-5.3-Codex-Spark.primary", "used": 0.07, "minutes": 300, "model": "GPT-5.3-Codex-Spark", "read": 1794162000000, "source": "usage"}]}
        """#)
        let listed = UsageListing.items(panel: [Entry](), covers: \.covers, accounts: accounts)
        guard listed.count == 1, case .account(let row, _) = listed[0] else {
            Issue.record("two rows for one account: \(listed.count)")
            return
        }
        let account = row.account
        #expect(account.title == "Codex")
        #expect(account.plan == "Pro")
        #expect(account.windows.map(\.title) == ["Session", "GPT-5.3-Codex-Spark", "Weekly"])
        #expect(account.windows.map(\.used) == [0.30, 0.07, 0.60])
    }

    @Test func rowsOfOneNameAreToldApart() throws {
        let codex = { (provider: String, identity: String, agent: Bool) -> String in
            #"{"provider": "\#(provider)", "service": "codex", \#(agent ? #""agent": "codex", "account": "default","# : "") "identity": "\#(identity)", "windows": [{"id": "primary", "used": 0.5, "minutes": 300, "read": 1794160000000, "source": "usage"}]}"#
        }
        // This Mac's Codex is one account and its ChatGPT sign-in another, which hetzner's Codex is
        // signed in to: "Codex" and "ChatGPT", as this Mac names them.
        let rows = UsageListing.accounts([
            .init(key: "mac", name: nil, accounts: try box([codex("codex-cli", "1111111111111111", true), codex("openai", "2222222222222222", false)].joined(separator: ","))),
            .init(key: "hetzner", name: "hetzner", accounts: try box(codex("codex-cli", "2222222222222222", true))),
        ])
        #expect(rows.map(\.account.title) == ["Codex", "ChatGPT"])

        // A row from two machines names both; one model's limit named in another case is one.
        let named = UsageListing.accounts([
            .init(key: "mac", name: nil, accounts: try box(claude(nil, used: 0.4, read: 1_794_160_000))),
            .init(key: "hetzner", name: "hetzner", accounts: try box(claude("aaaaaaaaaaaaaaaa", used: 0.5, read: 1_794_161_000))),
            .init(key: "lokum", name: "lokum", accounts: try box(claude("aaaaaaaaaaaaaaaa", used: 0.5, read: 1_794_161_000))),
        ])
        #expect(named.map(\.account.title) == ["Claude", "Claude · hetzner, lokum"])
        let spark = { (model: String, read: Double) in
            #"{"provider": "p\#(Int(read))", "service": "codex", "identity": "3333333333333333", "windows": [{"id": "x\#(Int(read))", "used": 0.1, "minutes": 300, "model": "\#(model)", "read": \#(read), "source": "usage"}]}"#
        }
        let one = UsageListing.accounts([.init(key: "mac", name: nil, accounts: try box([spark("GPT-5.3-Codex-Spark", 1), spark("gpt-5.3-codex-spark", 2)].joined(separator: ",")))])
        #expect(one.map { $0.account.windows.count } == [1])

        // Two accounts of one name on a machine, listed by a client that isn't on it (the phone with
        // only that machine): named for it once, never twice.
        let away = UsageListing.accounts([
            .init(key: "hetzner", name: "hetzner", accounts: try box([claude(nil, used: 0.4, read: 1_794_160_000),
                                                                       claude(nil, used: 0.5, read: 1_794_160_000, provider: "claude-code@1f2e3d4c")].joined(separator: ","))),
        ])
        #expect(away.map(\.account.title) == ["Claude · hetzner", "Claude · hetzner"])
    }

    // MARK: As the box lists them (#210)

    /// `rows`, as a box from #210 on answers: this box's Claude, read on lokum, and an account
    /// signed in only on hetzner, which isn't heard from lately.
    let rowsAnswer = """
    {"data": {"services": ["claude"], "accounts": [
      {"provider": "claude-code", "service": "claude", "agent": "claude", "account": "default", "identity": "aaaaaaaaaaaaaaaa", "windows": []}
    ], "rows": [
      {"id": "claude#aaaaaaaaaaaaaaaa", "provider": "claude-code", "service": "claude", "agent": "claude", "account": "default", "identity": "aaaaaaaaaaaaaaaa", "plan": "Max 20x", "checked": 1794164000000,
       "windows": [{"id": "five_hour", "used": 0.53, "minutes": 300, "resetsAt": 1794180000000, "read": 1794164000000, "source": "usage"}],
       "boxes": [{"key": "kmac", "name": "MacBook Pro", "provider": "claude-code", "agent": "claude", "account": "default", "here": true},
                 {"key": "klokum", "name": "lokum", "provider": "claude-code", "agent": "claude", "account": "default", "checked": 1794164000000}]},
      {"id": "claude#bbbbbbbbbbbbbbbb", "provider": "claude-code", "service": "claude", "agent": "claude", "account": "default", "identity": "bbbbbbbbbbbbbbbb", "checked": 1794164500000, "away": true,
       "windows": [{"id": "five_hour", "used": 0.2, "minutes": 300, "resetsAt": 1794180000000, "read": 1794164500000, "source": "usage"}],
       "boxes": [{"key": "khetzner", "name": "hetzner", "provider": "claude-code", "agent": "claude", "account": "default", "checked": 1794164500000, "away": true}]}
    ]}}
    """

    @Test func aBoxsRowsAreListedAsTheyAreWithTheComputersEachIsOn() throws {
        let limits = try BoxLimits.decode(Data(rowsAnswer.utf8))
        let rows = try #require(limits.rows)
        let panel = [Entry(id: "claude", covers: "claude")]
        let listing = UsageListing.listing([.init(key: "", name: nil, limits: limits)])
        #expect(listing.lister == "")
        let listed = UsageListing.items(panel: panel, covers: \.covers, listing: listing).map { item -> String in
            switch item {
            case .panel(let entry): "panel:\(entry.id)"
            case .account(let row, let below):
                row.account.title + (below.map { " +\($0.id)" } ?? "") + " on " + row.sources.map { $0.name ?? "here" }.joined(separator: ",")
            }
        }
        // Its own numbers are lokum's: the box listed it so; the other, only on hetzner, named for it.
        #expect(listed == ["Claude +claude on here,lokum", "Claude · hetzner on hetzner"])
        let first = UsageListing.accounts(rows: rows)[0]
        #expect(first.id == "claude#aaaaaaaaaaaaaaaa")
        #expect(first.account.tightest(at: now)?.used == 0.53)
        #expect(first.sources.map(\.box) == ["", "klokum"])
    }

    @Test func aRowWhoseComputersAreAllAwayIsNeverShownAsLive() throws {
        let rows = try #require(try BoxLimits.decode(Data(rowsAnswer.utf8)).rows)
        // Read a moment ago, but its computer isn't heard from: as of then.
        let soon = Date(timeIntervalSince1970: 1_794_164_600)
        #expect(rows[1].away)
        #expect(rows[1].isOutdated(now: soon))
        #expect(!rows[0].isOutdated(now: soon))
        #expect(rows[1].boxes.map(\.away) == [true])
    }

    @Test func aBoxFromBeforeRowsSaysNone() throws {
        #expect(try BoxLimits.decode(Data(answer.utf8)).rows == nil)
    }

    /// The first box's list stands for every computer the client reached only when it has each of
    /// their own accounts: one from before rows, or one it hasn't heard from yet (just added, or
    /// cut off from the relay), has each box's own merged here, so none goes missing.
    @Test func theFirstBoxsListIsShownOnlyWhenItHasEveryComputerTheClientReached() throws {
        // The Mac's box hears from hetzner now.
        let mac = try BoxLimits.decode(Data(rowsAnswer.replacingOccurrences(of: #", "away": true"#, with: "").utf8))
        // hetzner, as it says itself: its Athas, which the Mac's list has.
        let hetzner = try BoxLimits.decode(Data(#"""
        {"data": {"services": ["claude"], "accounts": [], "rows": [
          {"id": "claude#bbbbbbbbbbbbbbbb", "provider": "claude-code", "service": "claude", "identity": "bbbbbbbbbbbbbbbb", "windows": [],
           "boxes": [{"key": "khetzner", "name": "hetzner", "provider": "claude-code", "here": true}]}]}}
        """#.utf8))
        #expect(UsageListing.listing([.init(key: "", name: nil, limits: mac), .init(key: "hetzner", name: "hetzner", limits: hetzner)]).lister == "")
        // A machine just added, whose account the Mac's box hasn't heard of: each box's own, merged.
        let added = try BoxLimits.decode(Data(#"""
        {"data": {"services": ["grok"], "accounts": [{"provider": "grok-cli", "service": "grok", "agent": "grok", "identity": "6600660066006600", "windows": []}], "rows": [
          {"id": "grok#6600660066006600", "provider": "grok-cli", "service": "grok", "identity": "6600660066006600", "windows": [],
           "boxes": [{"key": "kadded", "name": "added", "provider": "grok-cli", "here": true}]}]}}
        """#.utf8))
        let merged = UsageListing.listing([.init(key: "", name: nil, limits: mac), .init(key: "added", name: "added", limits: added)])
        #expect(merged.lister == nil)
        #expect(merged.accounts.map(\.account.title) == ["Claude", "Grok"])
        // One from before rows: the same.
        let old = try BoxLimits.decode(Data(answer.utf8))
        #expect(UsageListing.listing([.init(key: "", name: nil, limits: mac), .init(key: "old", name: "old", limits: old)]).lister == nil)
        // hetzner away from the Mac's box (the relay down), though this Mac reaches it: what
        // hetzner says now, merged, not the Mac's box's last word of it.
        let cutOff = try BoxLimits.decode(Data(rowsAnswer.utf8))
        #expect(UsageListing.listing([.init(key: "", name: nil, limits: cutOff), .init(key: "hetzner", name: "hetzner", limits: hetzner)]).lister == nil)
    }
}
