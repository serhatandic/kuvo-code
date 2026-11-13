import XCTest
@testable import UsageKit

/// The panel's settings your computers share, as the host's boxes keep them (fork addition, #631
/// piece F): what this Mac kept before goes to the host as its parts, the host's parts show in the
/// panel (Customize, the cards turned on, notifications, the total spend card), and a change made
/// here goes to the host, never what the host put here. Each test keeps its settings in a suite of
/// its own.
@MainActor
final class HostSettingsTests: XCTestCase {
    private struct Panel {
        let defaults: UserDefaults
        let layout: LayoutStore
        let enablement: ProviderEnablementStore
        let notifications: NotificationSettingsStore
        let settings: HostSettings
    }

    private func panel(_ name: String) -> (Panel, () -> [[String: Any]]) {
        let defaults = testDefaults(suiteName: "HostSettings.\(name)")!
        let layout = LayoutStore(
            registry: .mock,
            defaults: defaults,
            storageKey: HostSettings.layoutStorageKey,
            defaultMetricIDs: ["claude.session", "claude.weekly", "codex.session"],
            migrationBaselineMetricIDs: ["claude.session", "claude.weekly", "codex.session"],
            defaultPinnedMetricIDs: ["claude.session"],
            defaultExpandedMetricIDs: []
        )
        let enablement = ProviderEnablementStore(defaults: defaults)
        enablement.seedEnabledProviders(["claude", "codex"])
        enablement.registerKnownProviders(["claude", "codex", "cursor"])
        let notifications = NotificationSettingsStore(defaults: defaults)
        let settings = HostSettings(defaults: defaults, liveLayout: { layout }) { parts in
            if parts.contains("layout") { layout.reloadShared() }
            if parts.contains("providers") { enablement.reload() }
            if parts.contains("notifications") { notifications.reload() }
        }
        var told: [[String: Any]] = []
        settings.onChange = { data in told.append((try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]) }
        return (Panel(defaults: defaults, layout: layout, enablement: enablement, notifications: notifications, settings: settings), { told })
    }

    private func object(_ data: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    func testWhatThisMacKeptGoesAsTheBoxsParts() {
        let (mac, _) = panel("Import")
        mac.layout.setPinned(true, for: "codex.session")
        mac.notifications.closeToRunningOut = true
        mac.defaults.set(false, forKey: TotalSpendSetting.key)
        mac.defaults.set("Last 30 Days", forKey: TotalSpendSetting.periodKey)
        mac.defaults.set("gpt-5", forKey: CodexFallbackModelSetting.key)

        let parts = object(mac.settings.current(withCodexFallback: true))
        let layout = parts["layout"] as? [String: Any]
        XCTAssertEqual(layout?["placed"] as? [String], ["claude.session", "claude.weekly", "codex.session"])
        XCTAssertEqual(layout?["pinned"] as? [String], ["claude.session", "codex.session"], "pins in one order, whatever order the panel kept them in")
        XCTAssertEqual(layout?["providerOrder"] as? [String], ["claude", "codex", "cursor"])
        XCTAssertEqual((parts["providers"] as? [String: Any])?["enabled"] as? [String], ["claude", "codex"])
        XCTAssertEqual((parts["providers"] as? [String: Any])?["known"] as? [String], ["claude", "codex", "cursor"])
        XCTAssertEqual(parts["totalSpend"] as? [String: AnyHashable], ["show": false, "period": "Last 30 Days"])
        XCTAssertEqual(parts["notifications"] as? [String: Bool], ["underTenPercent": false, "healthyToClose": false, "closeToRunningOut": true])
        XCTAssertEqual(parts["codexFallback"] as? String, "gpt-5")
        // Not as a change: Codex's fallback model goes to the host through its own route.
        XCTAssertNil(object(mac.settings.current())["codexFallback"])
    }

    func testTheHostsPartsShowInThePanelAndNoneGoBack() {
        let (mac, told) = panel("Apply")
        let shown = mac.layout.placed.first { $0.descriptorID == "claude.session" }!.id
        mac.layout.setProviderExpanded(true, for: "codex")
        mac.layout.menuBarStyle = .text
        // Another computer's: Codex first, Claude's session and weekly, the weekly pinned; Cursor on; an alert on.
        let fromHost: [String: Any] = [
            "layout": [
                "placed": ["codex.session", "claude.session", "claude.weekly"],
                "providerOrder": ["codex", "claude", "cursor"],
                "metricOrder": ["claude": ["claude.weekly", "claude.session"]],
                "pinned": ["claude.weekly"],
                "expanded": [],
                "expandOnEnable": [],
                "seeded": ["claude.session", "claude.weekly", "codex.session"],
            ],
            "providers": ["enabled": ["claude", "codex", "cursor"], "known": ["claude", "codex", "cursor"]],
            "totalSpend": ["show": false, "metric": "tokens"],
            "notifications": ["underTenPercent": true, "healthyToClose": false, "closeToRunningOut": false],
        ]
        mac.settings.apply(try! JSONSerialization.data(withJSONObject: fromHost))

        XCTAssertEqual(mac.layout.providerOrder, ["codex", "claude", "cursor"])
        XCTAssertEqual(mac.layout.placed.map(\.descriptorID), ["codex.session", "claude.weekly", "claude.session"], "in the cards' order and each card's meters' order")
        XCTAssertTrue(mac.layout.isPinned("claude.weekly"))
        XCTAssertFalse(mac.layout.isPinned("claude.session"))
        XCTAssertEqual(mac.layout.placed.first { $0.descriptorID == "claude.session" }?.id, shown, "a meter already shown stays the same meter")
        XCTAssertFalse(mac.layout.canUndo, "undo doesn't go back past what came from another computer")
        XCTAssertTrue(mac.enablement.isEnabled("cursor"))
        XCTAssertTrue(mac.notifications.underTenPercent)
        XCTAssertEqual(mac.defaults.object(forKey: TotalSpendSetting.key) as? Bool, false)
        XCTAssertEqual(mac.defaults.string(forKey: TotalSpendSetting.metricKey), "tokens")
        // This Mac's own: how its cards are opened, and its menu bar's style.
        XCTAssertTrue(mac.layout.isProviderExpanded("codex"))
        XCTAssertEqual(mac.layout.menuBarStyle, .text)

        // What the host put here isn't a change made here.
        mac.settings.check()
        XCTAssertTrue(told().isEmpty)
    }

    func testAChangeMadeHereGoesToTheHostOnceTheHostHasSaid() {
        let (mac, told) = panel("Change")
        // Before the host has said its own: nothing goes (this Mac's startup and first-run choices).
        mac.notifications.underTenPercent = true
        mac.settings.check()
        XCTAssertTrue(told().isEmpty)

        mac.settings.apply(Data("{}".utf8))
        mac.layout.setPinned(true, for: "codex.session")
        mac.settings.check()
        XCTAssertEqual(told().count, 1)
        XCTAssertEqual(Set(told()[0].keys), ["layout"], "only the part that changed, whole")
        XCTAssertEqual((told()[0]["layout"] as? [String: Any])?["pinned"] as? [String], ["claude.session", "codex.session"])

        // Nothing more changed: nothing more goes.
        mac.settings.check()
        XCTAssertEqual(told().count, 1)

        mac.enablement.setEnabled(true, for: "cursor")
        mac.settings.check()
        XCTAssertEqual(told().count, 2)
        XCTAssertEqual((told()[1]["providers"] as? [String: Any])?["enabled"] as? [String], ["claude", "codex", "cursor"])
    }
}
