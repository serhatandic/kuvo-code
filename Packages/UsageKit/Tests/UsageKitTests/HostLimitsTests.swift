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
}
