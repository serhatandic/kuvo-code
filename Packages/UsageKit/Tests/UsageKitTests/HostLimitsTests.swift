import XCTest
@testable import UsageKit

/// The host's plan limits, one row per account (fork addition): in the Bars view each takes the place
/// of the panel's own row for its provider, and the panel stops reading that provider's limits.
@MainActor
final class HostLimitsTests: XCTestCase {
    private func group(_ id: String) -> ProviderGroup {
        ProviderGroup(provider: Provider(id: id, displayName: id.capitalized, icon: .providerMark(id)), alwaysShownWidgets: [], expandedWidgets: [])
    }

    private func row(_ id: String, _ provider: String, _ name: String) -> HostLimitRow {
        HostLimitRow(id: id, providerID: provider, name: name, meters: [HostLimitRow.Meter(title: "Session", fraction: 0.4)], isLocal: !id.hasPrefix("mini/"))
    }

    private func names(_ entries: [BarsEntry]) -> [String] {
        entries.map { entry in
            switch entry {
            case .group(let group): "panel:\(group.provider.id)"
            case .host(let row, _, let spend): spend == nil ? row.name : "\(row.name) +spend"
            }
        }
    }

    func testEachLoginTakesItsProvidersPlaceAndTheRestStayAsTheyAre() {
        let limits = HostLimits()
        limits.update(rows: [
            row("mac/claude-code", "claude", "Claude"),
            row("mac/claude-code@1f2e", "claude", "Claude · Work"),
            row("mac/codex-cli", "codex", "Codex"),
            row("mini/claude-code", "claude", "Claude · mini"),
            row("mac/github-copilot", "copilot", "Copilot"),
        ], covered: ["claude", "codex", "copilot"])
        // The panel's own: Cursor first, then your own Claude logins (an account card too), then OpenRouter.
        let groups = [group("cursor"), group("claude"), group("claude@ab12cd34"), group("openrouter")]

        let entries = limits.entries(groups: groups) { _ in false }

        XCTAssertEqual(names(entries), [
            // The provider's own spend and trend under its first login.
            "panel:cursor", "Claude +spend", "Claude · Work", "Claude · mini", "panel:openrouter",
            // Providers the panel doesn't list here: after them.
            "Codex", "Copilot",
        ])
    }

    func testAnotherComputersAccountTakesClaudesBarWhileThisMacHasNoneOfItsOwn() {
        // This Mac's box has no Claude row yet (no turn here), and Claude's bar has no limits of its
        // own (only the box reads them): the machines' accounts take its place, its spend under the
        // first, each by its own name, as this Mac's own would.
        let limits = HostLimits()
        limits.update(rows: [
            HostLimitRow(id: "claude#a1", providerID: "claude", name: "Claude", meters: [], isLocal: false, place: "hetzner, mini-local"),
            HostLimitRow(id: "claude#b2", providerID: "claude", name: "Claude · Athas", meters: [], isLocal: false, place: "mini-local"),
        ], covered: ["claude"])
        XCTAssertEqual(names(limits.entries(groups: [group("claude"), group("cursor")]) { _ in false }), ["Claude +spend", "Claude · Athas", "panel:cursor"])
        // A phone gets Claude's place for them too.
        XCTAssertEqual(limits.phoneGroups([group("claude"), group("cursor")]).map { $0.group.provider.id + ($0.covers.map { ">" + $0 } ?? "") }, ["claude>claude", "cursor"])
        // With no bar of that name, just its name.
        XCTAssertEqual(names(limits.entries(groups: [group("cursor")]) { _ in false }), ["panel:cursor", "Claude", "Claude · Athas"])

        // Once this Mac has a Claude account of its own, it takes the place; another computer's
        // other account follows, named for where it's from where that's all that tells them apart.
        limits.update(rows: [
            row("mac/claude-code", "claude", "Claude"),
            HostLimitRow(id: "claude#a1", providerID: "claude", name: "Claude · hetzner", meters: [], isLocal: false, place: "hetzner"),
        ], covered: ["claude"])
        XCTAssertEqual(names(limits.entries(groups: [group("claude")]) { _ in false }), ["Claude +spend", "Claude · hetzner"])
    }

    func testAMachinesLoginBesideABarThatReadsItsOwnLimitsSaysWhereItsFrom() {
        // Codex's bar reads your own Codex's limits until this Mac's box has a row of it: it stays,
        // and a machine's Codex beside it says which computer it's on.
        let limits = HostLimits()
        limits.update(rows: [HostLimitRow(id: "mini/codex-cli", providerID: "codex", name: "Codex", meters: [], isLocal: false, place: "mini-local")], covered: ["codex"])
        XCTAssertEqual(names(limits.entries(groups: [group("codex"), group("cursor")]) { _ in false }), ["panel:codex", "Codex · mini-local", "panel:cursor"])
        XCTAssertEqual(limits.phoneGroups([group("codex")]).map { $0.covers }, [nil])
    }

    func testAPhoneGetsThePanelInOrderWithWhereThisMacsBoxRowsGo() {
        let limits = HostLimits()
        limits.update(rows: [row("this Mac/claude-code", "claude", "Claude"), row("this Mac/openrouter", "openrouter", "OpenRouter")], covered: ["claude", "openrouter", "copilot"])
        // Claude's place (once for its account cards) and OpenRouter's, marked; Copilot, covered with
        // no row here, as the panel's own.
        XCTAssertEqual(limits.phoneGroups([group("cursor"), group("claude"), group("claude@ab12cd34"), group("copilot"), group("openrouter")]).map { $0.group.provider.id + ($0.covers.map { ">" + $0 } ?? "") },
                       ["cursor", "claude>claude", "copilot", "openrouter>openrouter"])
    }

    func testACoveredProviderTheHostHasNoRowForYetKeepsItsOwnBar() {
        // (Claude on a Mac before any turn there; OpenCode with a Zen key and no Go plan.)
        let limits = HostLimits()
        limits.update(rows: [row("this Mac/codex-cli", "codex", "Codex")], covered: ["claude", "codex", "opencode"])
        let entries = limits.entries(groups: [group("claude"), group("opencode"), group("codex")]) { _ in false }
        XCTAssertEqual(names(entries), ["panel:claude", "panel:opencode", "Codex +spend"])
    }

    func testAProviderYouHidStaysHidden() {
        let limits = HostLimits()
        limits.update(rows: [row("mac/codex-cli", "codex", "Codex"), row("mac/claude-code", "claude", "Claude")], covered: ["codex", "claude"])
        let entries = limits.entries(groups: []) { $0 == "codex" }
        XCTAssertEqual(names(entries), ["Claude"])
    }

    func testAMeterThatStartedOverSinceIsNotShownAsUsed() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let defaults = testDefaults(suiteName: "HostLimitsTests")!
        let store = WidgetDataStore(registry: WidgetRegistry(providers: [], descriptors: []), providers: [], defaults: defaults)
        let limits = HostLimitRow(id: "x", providerID: "copilot", name: "Copilot", meters: [
            HostLimitRow.Meter(title: "Session", fraction: 0.4, resetsAt: now.addingTimeInterval(-60)),
            HostLimitRow.Meter(title: "Premium requests", fraction: 0.6, resetsAt: now.addingTimeInterval(86_400), periodMinutes: 43_200, count: (used: 180, limit: 300, unit: "requests")),
        ], balance: HostLimitRow.Balance(left: 12.5, unit: "usd"))
        let rows = HostLimitData.rows(limits, store: store, now: now)
        XCTAssertEqual(rows.map(\.title), ["Premium requests", "Credits"])
        XCTAssertEqual(rows[0].used, 180)
        XCTAssertEqual(rows[0].limit, 300)
        XCTAssertEqual(rows[0].countSuffix, "requests")
        XCTAssertNil(rows[1].limit)
    }

    func testClaudesOwnRowDoesntAskAnthropicWhileTheHostStatesItsLimits() async throws {
        let now = OpenUsageISO8601.date(from: "2026-02-20T16:00:00.000Z")!
        let httpClient = FakeHTTPClient(response: HTTPResponse(
            statusCode: 200, headers: [:],
            body: Data(#"{"five_hour":{"utilization":25,"resets_at":"2099-01-01T00:00:00.000Z"}}"#.utf8)
        ))
        let home = try ClaudeLogFixture.makeHome(files: [
            "project-a/session.jsonl": ClaudeLogFixture.usageLine(timestamp: "2026-02-20T16:00:00.000Z", input: 100, output: 50, costUSD: 0.25)
        ])
        let provider = ClaudeProvider(
            authStore: ClaudeAuthStore(
                environment: FakeEnvironment(["CLAUDE_CONFIG_DIR": "/tmp/claude"]),
                files: FakeFiles(["/tmp/claude/.credentials.json": #"{"claudeAiOauth":{"accessToken":"yours","subscriptionType":"pro","scopes":["user:profile"]}}"#]),
                keychain: FakeKeychain(),
                now: { now }
            ),
            usageClient: ClaudeUsageClient(httpClient: httpClient),
            logUsageScanner: ClaudeLogFixture.scanner(home: home),
            now: { now },
            pricing: { TestPricing.bundled }
        )
        // This Mac's own login's limits, as its box states them; a machine's isn't this Mac's.
        HostLimits.shared.update(rows: [
            HostLimitRow(id: "devbox/claude-code", providerID: "claude", name: "Claude · devbox", meters: [HostLimitRow.Meter(title: "Session", fraction: 0.9)], isLocal: false),
            // One you added, listed first (it had a turn first): not the panel's own card's.
            HostLimitRow(id: "this Mac/claude-code@1f2e", providerID: "claude", name: "Claude · Work", meters: [HostLimitRow.Meter(title: "Session", fraction: 0.77)]),
            HostLimitRow(id: "this Mac/claude-code", providerID: "claude", name: "Claude", plan: "Max 20x", meters: [
                HostLimitRow.Meter(title: "Session", fraction: 0.42, resetsAt: now.addingTimeInterval(3_600), periodMinutes: 300),
                HostLimitRow.Meter(title: "Weekly", fraction: 0.18, periodMinutes: 10_080),
            ], readAt: now.addingTimeInterval(-120), isOwnLogin: true),
        ], covered: ["claude"])
        defer { HostLimits.shared.update(rows: [], covered: []) }

        let read = await provider.refresh()
        let snapshot = try XCTUnwrap(HostLimits.shared.applied(to: ["claude": read], now: now)["claude"])

        // Anthropic isn't asked with your own login: the menu bar, the cards and the notices read the box's.
        XCTAssertEqual(httpClient.requests.count, 0)
        XCTAssertEqual(snapshot.plan, "Max 20x")
        guard case .progress(_, let used, _, _, let resetsAt, _, _)? = snapshot.lines.first(where: { $0.label == "Session" }) else { return XCTFail("no Session") }
        XCTAssertEqual(used, 42)
        XCTAssertEqual(resetsAt, now.addingTimeInterval(3_600))
        XCTAssertNotNil(snapshot.lines.first(where: { $0.label == "Weekly" }))
        // Its spend still counts.
        XCTAssertNotNil(snapshot.lines.first(where: { $0.label == "Today" }))
    }

    func testWithNoClaudeCodeSignInOfYourOwnTheBoxsLimitsStillShow() async throws {
        let now = OpenUsageISO8601.date(from: "2026-02-20T16:00:00.000Z")!
        let httpClient = FakeHTTPClient(response: HTTPResponse(statusCode: 200, headers: [:], body: Data()))
        let provider = ClaudeProvider(
            authStore: ClaudeAuthStore(environment: FakeEnvironment(), files: FakeFiles(), keychain: FakeKeychain(), now: { now }),
            usageClient: ClaudeUsageClient(httpClient: httpClient),
            logUsageScanner: ClaudeLogFixture.scanner(home: try ClaudeLogFixture.makeHome(files: [:])),
            now: { now },
            pricing: { TestPricing.bundled }
        )
        HostLimits.shared.update(rows: [
            HostLimitRow(id: "this Mac/claude-code", providerID: "claude", name: "Claude", meters: [HostLimitRow.Meter(title: "Session", fraction: 0.3)],
                         notice: "Anthropic is turning away reads of the plan's limits for now.", isOwnLogin: true),
        ], covered: ["claude"])
        defer { HostLimits.shared.update(rows: [], covered: []) }

        let read = await provider.refresh()
        let snapshot = try XCTUnwrap(HostLimits.shared.applied(to: ["claude": read], now: now)["claude"])

        XCTAssertNil(snapshot.errorCategory)
        XCTAssertNotNil(snapshot.lines.first(where: { $0.label == "Session" }))
        XCTAssertEqual(snapshot.warning, "Anthropic is turning away reads of the plan's limits for now.")
        XCTAssertEqual(httpClient.requests.count, 0)
    }

    func testAnyCoveredProvidersReadingTakesThisMacsOwnLoginsNumbersWhileTheyreCurrent() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let limits = HostLimits()
        limits.update(rows: [
            HostLimitRow(id: "this Mac/github-copilot", providerID: "copilot", name: "Copilot", meters: [
                HostLimitRow.Meter(title: "Premium requests", fraction: 0.6, resetsAt: now.addingTimeInterval(86_400), count: (used: 180, limit: 300, unit: "requests")),
            ], readAt: now.addingTimeInterval(-60), isOwnLogin: true),
            HostLimitRow(id: "this Mac/openrouter", providerID: "openrouter", name: "OpenRouter", meters: [HostLimitRow.Meter(title: "Key limit", fraction: 0.1)], readAt: now.addingTimeInterval(-3_600), isOwnLogin: true),
        ], covered: ["copilot", "openrouter"])
        let panel = ProviderSnapshot.make(provider: Provider(id: "copilot", displayName: "Copilot", icon: .providerMark("copilot")), plan: "Pro",
                                          lines: [.progress(label: "Credits", used: 10, limit: 300, format: .count(suffix: "requests"), resetsAt: nil, periodDurationMs: nil)], refreshedAt: now)
        let stale = ProviderSnapshot.make(provider: Provider(id: "openrouter", displayName: "OpenRouter", icon: .providerMark("openrouter")), plan: nil,
                                          lines: [.progress(label: "Mine", used: 50, limit: 100, format: .percent, resetsAt: nil, periodDurationMs: nil)], refreshedAt: now)
        let applied = limits.applied(to: ["copilot": panel, "openrouter": stale], now: now)
        guard case .progress(let label, let used, let limit, _, _, _, _)? = applied["copilot"]?.lines.first else { return XCTFail("no meter") }
        XCTAssertEqual([label, "\(used)", "\(limit)"], ["Premium requests", "180.0", "300.0"])
        XCTAssertEqual(applied["copilot"]?.lines.count, 1)
        // Read over half an hour ago: the panel's own, as it was.
        XCTAssertEqual(applied["openrouter"]?.lines.first?.label, "Mine")
    }

    /// Cursor's on-demand spend with no cap, from the box: on its card as before ("Extra Usage …
    /// spent"), until its billing cycle starts over; and in the bar's detail once, its card's own
    /// widgets of the same lines (Extra Usage, Credits) not again beside it.
    func testCursorsSpendWithNoCapShowsOnceAndGoesWhenItsCycleStartsOver() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let limits = HostLimits()
        let row = HostLimitRow(id: "cursor#aaaaaaaaaaaaaaaa", providerID: "cursor", name: "Cursor", meters: [HostLimitRow.Meter(title: "Total usage", fraction: 1)],
                               balance: .init(left: 18, unit: "usd"), extras: [.init(id: "on_demand", name: "On-demand", amount: 43.21, unit: "usd", resetsAt: now.addingTimeInterval(86_400))],
                               readAt: now, isOwnLogin: true)
        limits.update(rows: [row], covered: ["cursor"])
        let empty = ProviderSnapshot.make(provider: Provider(id: "cursor", displayName: "Cursor", icon: .providerMark("cursor")), plan: nil, lines: [], refreshedAt: now)
        let drawn = limits.applied(to: ["cursor": empty], now: now)["cursor"]
        XCTAssertEqual(drawn?.lines.first { $0.label == "On-demand" }, .values(label: "On-demand", values: [MetricValue(number: 43.21, kind: .dollars)]))
        let shown = HostLimitData.labels(row)
        let repeated = CursorProvider().widgetDescriptors.filter { shown.contains($0.metricLabel) }.map(\.id)
        XCTAssertEqual(Set(repeated), ["cursor.onDemand", "cursor.credits"], "the card's widgets the bar's detail leaves out beside the row's own")
        var over = row
        over.extras[0].resetsAt = now.addingTimeInterval(-60)
        limits.update(rows: [over], covered: ["cursor"])
        let later = limits.applied(to: ["cursor": empty], now: now)["cursor"]
        XCTAssertNil(later?.lines.first { $0.label == "On-demand" }, "started over since it was read: not known now")
        XCTAssertEqual(later?.lines.first { $0.label == "Credits" }, .values(label: "Credits", values: [MetricValue(number: 18, kind: .dollars)]))
    }

    /// What a phone gets of a covered card: not the lines it has from the rows (Cursor's credits and
    /// on-demand spend), which the phone draws from each row, under its own account; another card's
    /// credits (OpenRouter's) are its own, and go.
    func testThePhoneDrawsCursorsCreditsAndSpendFromItsRowsNotTheCards() {
        let limits = HostLimits()
        limits.update(rows: [
            HostLimitRow(id: "cursor#a", providerID: "cursor", name: "Cursor", meters: [], balance: .init(left: 18, unit: "usd"), extras: [.init(id: "on_demand", name: "On-demand", amount: 4, unit: "usd")]),
            HostLimitRow(id: "openrouter#b", providerID: "openrouter", name: "OpenRouter", meters: [], balance: .init(left: 2, unit: "usd")),
        ], covered: ["cursor", "openrouter"])
        XCTAssertEqual(limits.rowLines(for: "cursor"), ["Credits", "On-demand"])
        // (OpenRouter's credits are the box's too since #631 E: the phone draws them from its row.)
        XCTAssertEqual(limits.rowLines(for: "openrouter"), ["Balance", "Credits"])
    }

    /// What a plan has beyond its windows, as the box states it (#631 E), under its bar: a capped
    /// amount a meter, the rest amounts; credits bought a meter of what's left; its resets and what
    /// its login can't read are rows of their own, not readings. The card's own lines of the same
    /// facts (its "Rate Limit Resets", "Extra usage spent", OpenRouter's "Balance") don't show again.
    func testAPlansExtrasUnderItsBarAsThePanelDrawsItsOwn() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let store = WidgetDataStore(registry: WidgetRegistry(providers: [], descriptors: []), providers: [], defaults: testDefaults(suiteName: "HostLimitsTests.extras")!)
        let claude = HostLimitRow(id: "claude#a", providerID: "claude", name: "Claude · Work", meters: [HostLimitRow.Meter(title: "Session", fraction: 0.88)], extras: [
            .init(id: "extra_usage", name: "Extra Usage", kind: .capped, amount: 12.4, limit: 50, unit: "usd", resetsAt: now.addingTimeInterval(18 * 86_400)),
            .init(id: "resets", name: "Rate Limit Resets", kind: .resets, count: 2, expiries: [now.addingTimeInterval(86_400)], usable: true, elsewhere: "hetzner"),
        ])
        let rows = HostLimitData.rows(claude, store: store, now: now)
        XCTAssertEqual(rows.map(\.title), ["Session", "Extra Usage"])
        XCTAssertTrue(rows[1].isBounded)
        XCTAssertEqual([rows[1].used, rows[1].limit], [12.4, 50])
        XCTAssertEqual(claude.resets?.elsewhere, "hetzner")
        XCTAssertTrue(HostLimitData.labels(claude).isSuperset(of: ["Rate Limit Resets", "Extra usage spent"]))

        let codex = HostLimitRow(id: "codex#b", providerID: "codex", name: "Codex", meters: [], extras: [.init(id: "credits", name: "Extra Usage", kind: .left, amount: 1240, unit: "credits")])
        let credits = HostLimitData.rows(codex, store: store, now: now)
        XCTAssertEqual(credits.map(\.unboundedDetail), ["1,240 credits"])
        XCTAssertTrue(HostLimitData.labels(codex).contains("Credits"), "the card's own Credits line isn't shown again")

        let openrouter = HostLimitRow(id: "openrouter#c", providerID: "openrouter", name: "OpenRouter", meters: [], balance: .init(left: 7.7, limit: 50, unit: "usd"), extras: [
            .init(id: "today", name: "Today", amount: 1.84, unit: "usd", resetsAt: now.addingTimeInterval(3600)),
            .init(id: "week", name: "This Week", amount: 9.2, unit: "usd", resetsAt: now.addingTimeInterval(-60)),
        ])
        let spend = HostLimitData.rows(openrouter, store: store, now: now)
        // (This week's started over since it was read: not known now.)
        XCTAssertEqual(spend.map(\.title), ["Credits", "Today"])
        XCTAssertTrue(spend[0].isBounded)
        XCTAssertEqual(spend[0].used, 50 - 7.7, accuracy: 0.001)
        XCTAssertEqual(spend[1].unboundedDetail, "$1.84 spent")

        let mac = HostLimitRow(id: "mac/claude-code", providerID: "claude", name: "Claude", meters: [], extras: [.init(id: "resets", name: "Rate Limit Resets", kind: .unreadable, message: "Can't.")])
        XCTAssertEqual(HostLimitData.rows(mac, store: store, now: now).count, 0)
        XCTAssertEqual(mac.unreadable?.message, "Can't.")
        XCTAssertNil(mac.resets)
    }

    /// #631 E second review: the answer to Use didn't come back (the connection dropped), or the box
    /// said it may have gone: Retry sends the same confirmation again (the box's journal makes it the
    /// same request), never a new one; only once the box no longer knows it does Retry ask anew.
    func testRetryAfterALostAnswerSendsTheSameConfirmationAgain() async throws {
        struct Dropped: LocalizedError { var errorDescription: String? { "The connection was lost." } }
        let limits = HostLimits()
        var asked = 0
        var used: [String] = []
        var answers: [Result<HostResetDone, Error>] = [
            .failure(Dropped()),
            .success(HostResetDone(succeeded: false, message: "No answer came, so it may have been used. Asking again won't use another.", stillOpen: true)),
            .success(HostResetDone(succeeded: true)),
            .failure(HostResetExpired()),
            .success(HostResetDone(succeeded: true)),
        ]
        limits.askReset = { _ in
            asked += 1
            return HostResetOffer(confirm: "rsc_\(asked)", question: "Use 1 of 2 resets?", detail: "")
        }
        limits.useReset = { _, confirm in
            used.append(confirm)
            return try answers.removeFirst().get()
        }
        let flow = limits.resetFlow(for: "claude#a")
        flow.doneFor = .zero

        await flow.begin()?.value
        await flow.confirm()?.value
        XCTAssertEqual(flow.phase, .failed("The connection was lost."))
        await flow.begin()?.value
        XCTAssertEqual(flow.phase, .failed("No answer came, so it may have been used. Asking again won't use another."))
        await flow.begin()?.value
        XCTAssertEqual(flow.phase, .idle)
        XCTAssertEqual(used, ["rsc_1", "rsc_1", "rsc_1"], "Retry is the same confirmation")
        XCTAssertEqual(asked, 1)

        // A new one the box no longer knows when it's sent (it started again meanwhile): asked anew.
        await flow.begin()?.value
        await flow.confirm()?.value
        XCTAssertEqual(used.last, "rsc_2")
        XCTAssertEqual(asked, 3, "a new confirmation once the box no longer knows the old")
        if case .confirming(let offer) = flow.phase { XCTAssertEqual(offer.confirm, "rsc_3") } else { XCTFail("not confirming: \(flow.phase)") }
    }

    /// Using a reset from its row: asked of the box, confirmed in place, used once, done; Cancel
    /// leaves it as it was; what the box says when it doesn't go through shows, and Retry asks again.
    func testAResetIsAskedConfirmedInPlaceAndUsedOnce() async throws {
        let limits = HostLimits()
        var asked: [String] = []
        var used: [String] = []
        var answer = HostResetDone(succeeded: true)
        limits.askReset = { row in
            asked.append(row)
            return HostResetOffer(confirm: "rsc_\(asked.count)", question: "Use 1 of 2 resets?", detail: "Your 5-hour window starts over now.")
        }
        limits.useReset = { _, confirm in
            used.append(confirm)
            return answer
        }
        let flow = limits.resetFlow(for: "codex#b")
        XCTAssertTrue(limits.resetFlow(for: "codex#b") === flow, "the same flow wherever its bar is drawn")
        flow.doneFor = .zero

        await flow.begin()?.value
        XCTAssertEqual(flow.phase, .confirming(HostResetOffer(confirm: "rsc_1", question: "Use 1 of 2 resets?", detail: "Your 5-hour window starts over now.")))
        XCTAssertEqual(used, [], "asking spends nothing")
        flow.cancel()
        XCTAssertEqual(flow.phase, .idle)

        await flow.begin()?.value
        let using = flow.confirm()
        // A second tap while it's used does nothing.
        XCTAssertNil(flow.confirm())
        XCTAssertNil(flow.begin())
        await using?.value
        XCTAssertEqual(used, ["rsc_2"])
        XCTAssertEqual(flow.phase, .idle)

        answer = HostResetDone(succeeded: false, message: "Nothing to reset: this account isn't at a limit. Nothing was used.")
        await flow.begin()?.value
        await flow.confirm()?.value
        XCTAssertEqual(flow.phase, .failed("Nothing to reset: this account isn't at a limit. Nothing was used."))
        // Retry asks again (a new confirmation).
        await flow.begin()?.value
        XCTAssertEqual(asked.count, 4)
        if case .confirming(let offer) = flow.phase { XCTAssertEqual(offer.confirm, "rsc_4") } else { XCTFail("not confirming") }
    }

    /// The credits a row has go on the card only where the card reads nothing of its own (Cursor's):
    /// OpenRouter's card keeps its own credits meter, not the box's credits left in its place.
    func testOnlyACardThatReadsNothingTakesTheRowsCredits() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let limits = HostLimits()
        limits.update(rows: [
            HostLimitRow(id: "this Mac/openrouter", providerID: "openrouter", name: "OpenRouter", meters: [HostLimitRow.Meter(title: "Key limit", fraction: 0.1)],
                         balance: .init(left: 12.5, unit: "usd"), readAt: now, isOwnLogin: true),
            HostLimitRow(id: "cursor#aaaaaaaaaaaaaaaa", providerID: "cursor", name: "Cursor", meters: [HostLimitRow.Meter(title: "Total usage", fraction: 0.25)],
                         balance: .init(left: 18, unit: "usd"), readAt: now, isOwnLogin: true),
        ], covered: ["openrouter", "cursor"])
        let snapshot = { (id: String) in ProviderSnapshot.make(provider: Provider(id: id, displayName: id, icon: .providerMark(id)), plan: nil, lines: [], refreshedAt: now) }
        let applied = limits.applied(to: ["openrouter": snapshot("openrouter"), "cursor": snapshot("cursor")], now: now)
        XCTAssertEqual(applied["openrouter"]?.lines.map(\.label), ["Key limit"])
        XCTAssertEqual(applied["cursor"]?.lines.map(\.label), ["Total usage", "Credits"])
    }

    func testClaudesBarSaysWhenItsLimitsWillShowWhileThisMacHasNone() async throws {
        let now = OpenUsageISO8601.date(from: "2026-02-20T16:00:00.000Z")!
        let provider = ClaudeProvider(
            authStore: ClaudeAuthStore(environment: FakeEnvironment(), files: FakeFiles(), keychain: FakeKeychain(), now: { now }),
            usageClient: ClaudeUsageClient(httpClient: FakeHTTPClient(response: HTTPResponse(statusCode: 200, headers: [:], body: Data()))),
            logUsageScanner: ClaudeLogFixture.scanner(home: try ClaudeLogFixture.makeHome(files: [:])),
            now: { now },
            pricing: { TestPricing.bundled }
        )
        HostLimits.shared.update(rows: [], covered: ["claude"])
        defer { HostLimits.shared.update(rows: [], covered: []) }
        let snapshot = await provider.refresh()
        XCTAssertEqual(snapshot.warning, HostLimits.waitingForClaude)
    }

    /// #210: a row whose computers aren't heard from says "As of …" however recent its reading:
    /// never shown as live.
    func testARowWhoseComputersAreAwayIsShownAsOfWhenItWasRead() {
        let now = Date()
        var row = HostLimitRow(id: "claude#a7", providerID: "claude", name: "Claude · Athas", meters: [HostLimitRow.Meter(title: "Session", fraction: 0.2)], readAt: now.addingTimeInterval(-120), isLocal: false, place: "hetzner")
        XCTAssertNil(HostLimitData.staleness(row, now: now))
        row.isAway = true
        XCTAssertEqual(HostLimitData.staleness(row, now: now)?.label.hasPrefix("As of "), true)
    }
}
