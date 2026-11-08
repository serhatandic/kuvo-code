import XCTest
@testable import UsageKit

/// The host's plan limits, one row per login (fork addition): in the Bars view each takes the place
/// of the panel's own row for its provider, and the panel stops reading that provider's limits.
@MainActor
final class HostLimitsTests: XCTestCase {
    private func group(_ id: String) -> ProviderGroup {
        ProviderGroup(provider: Provider(id: id, displayName: id.capitalized, icon: .providerMark(id)), alwaysShownWidgets: [], expandedWidgets: [])
    }

    private func row(_ id: String, _ provider: String, _ name: String) -> HostLimitRow {
        HostLimitRow(id: id, providerID: provider, name: name, meters: [HostLimitRow.Meter(title: "Session", fraction: 0.4)])
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
        let defaults = UserDefaults(suiteName: "HostLimitsTests")!
        defer { defaults.removePersistentDomain(forName: "HostLimitsTests") }
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
            HostLimitRow(id: "this Mac/claude-code", providerID: "claude", name: "Claude", plan: "Max 20x", meters: [
                HostLimitRow.Meter(title: "Session", fraction: 0.42, resetsAt: now.addingTimeInterval(3_600), periodMinutes: 300),
                HostLimitRow.Meter(title: "Weekly", fraction: 0.18, periodMinutes: 10_080),
            ]),
        ], covered: ["claude"])
        defer { HostLimits.shared.update(rows: [], covered: []) }

        let snapshot = await provider.refresh()

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
}
