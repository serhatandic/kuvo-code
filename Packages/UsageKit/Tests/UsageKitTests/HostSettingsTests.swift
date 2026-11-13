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

        let parts = object(mac.settings.toImport())
        let layout = parts["layout"] as? [String: Any]
        XCTAssertEqual(layout?["placed"] as? [String], ["claude.session", "claude.weekly", "codex.session"])
        XCTAssertEqual(layout?["pinned"] as? [String], ["claude.session", "codex.session"], "pins in one order, whatever order the panel kept them in")
        XCTAssertEqual(layout?["providerOrder"] as? [String], ["claude", "codex", "cursor"])
        XCTAssertNil(parts["providers"], "the cards each Mac turned on for the tools it found aren't brought")
        XCTAssertEqual(parts["totalSpend"] as? [String: AnyHashable], ["show": false, "period": "Last 30 Days"])
        XCTAssertEqual(parts["notifications"] as? [String: Bool], ["underTenPercent": false, "healthyToClose": false, "closeToRunningOut": true])
        XCTAssertEqual(parts["codexFallback"] as? String, "gpt-5")
    }

    func testAMacStillOnItsFirstRunSettingsBringsNothing() {
        let (fresh, _) = panel("Fresh")
        // (It turned on the cards for the tools it found, and shows its default meters.)
        XCTAssertEqual(object(fresh.settings.toImport()).count, 0, "nothing to put over the panel you made on another Mac")
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
        // Before the host has ever said its own: nothing goes (this Mac's startup and first-run choices).
        mac.notifications.underTenPercent = true
        mac.settings.check()
        XCTAssertTrue(told().isEmpty)

        mac.settings.apply(Data("{}".utf8))
        mac.layout.setPinned(true, for: "codex.session")
        mac.settings.check()
        XCTAssertEqual(told().count, 1)
        XCTAssertEqual(Set(told()[0].keys), ["layout", "knows"], "only the part that changed, whole, with what this panel knows")
        XCTAssertEqual((told()[0]["layout"] as? [String: Any])?["pinned"] as? [String], ["claude.session", "codex.session"])
        XCTAssertEqual((told()[0]["knows"] as? [String: Any])?["cards"] as? [String], ["claude", "codex", "cursor"])

        // Nothing more changed: nothing more goes.
        mac.settings.check()
        XCTAssertEqual(told().count, 1)

        mac.enablement.setEnabled(true, for: "cursor")
        mac.settings.check()
        XCTAssertEqual(told().count, 2)
        XCTAssertEqual((told()[1]["providers"] as? [String: Any])?["enabled"] as? [String], ["claude", "codex", "cursor"])
    }

    func testAChangeMadeAfterARestartBeforeTheHostAnswersGoesToo() {
        let (mac, _) = panel("Restart")
        mac.settings.apply(Data("{}".utf8))
        // The app starts again, its host not answering yet; the panel is changed meanwhile.
        let again = HostSettings(defaults: mac.defaults, liveLayout: { mac.layout }) { _ in }
        var told: [[String: Any]] = []
        again.onChange = { told.append(self.object($0)) }
        again.panelStarted()
        mac.layout.setPinned(true, for: "codex.session")
        again.check()
        XCTAssertEqual(told.count, 1)
        XCTAssertEqual((told.first?["layout"] as? [String: Any])?["pinned"] as? [String], ["claude.session", "codex.session"])
    }

    func testAResetOrAChangePutBackIsAFreshPanelsLayoutAndIsntBrought() {
        let (mac, _) = panel("Reset")
        mac.layout.setPinned(true, for: "codex.session")
        XCTAssertNotNil(object(mac.settings.toImport())["layout"])
        // Put back as it was.
        mac.layout.setPinned(false, for: "codex.session")
        XCTAssertNil(object(mac.settings.toImport())["layout"])
        // Reset.
        mac.layout.setMetricEnabled("claude.weekly", false)
        XCTAssertNotNil(object(mac.settings.toImport())["layout"])
        mac.layout.resetToDefault()
        XCTAssertNil(object(mac.settings.toImport())["layout"], "Reset gives a fresh panel's layout, to bring over no one's")
    }

    func testWhatThisMacSendsIsWhatItKnowsAndTheHostsKeepingTheRestPutsNothingInAgain() {
        let (mac, told) = panel("Newer")
        // A newer app's: a Grok card with a meter this Mac doesn't know, shown, starred and offered.
        let fromHost: [String: Any] = [
            "layout": [
                "placed": ["claude.session", "grok.weekly"],
                "providerOrder": ["grok", "claude", "codex", "cursor"],
                "metricOrder": ["grok": ["grok.weekly"], "claude": ["claude.session", "claude.weekly", "claude.next"]],
                "pinned": ["grok.weekly"],
                "expanded": [],
                "expandOnEnable": [],
                "seeded": ["claude.session", "claude.weekly", "codex.session", "grok.weekly"],
            ],
        ]
        mac.settings.apply(try! JSONSerialization.data(withJSONObject: fromHost))
        XCTAssertEqual(mac.layout.placed.map(\.descriptorID), ["claude.session"], "what it can't show stays out of its panel")

        mac.layout.setPinned(true, for: "claude.session")
        mac.settings.check()
        let sent = told().last?["layout"] as? [String: Any]
        XCTAssertEqual(sent?["pinned"] as? [String], ["claude.session"], "only what it knows: the host keeps the rest")
        XCTAssertEqual((told().last?["knows"] as? [String: Any])?["meters"] as? [String], MockData.descriptors.map(\.id))

        // The host answers with what it kept (Grok's put back): Undo and the panel stay as they are.
        var kept = sent!
        kept["placed"] = (sent?["placed"] as? [String] ?? []) + ["grok.weekly"]
        kept["pinned"] = ["claude.session", "grok.weekly"]
        kept["providerOrder"] = (sent?["providerOrder"] as? [String] ?? []) + ["grok"]
        kept["metricOrder"] = (sent?["metricOrder"] as? [String: [String]] ?? [:]).merging(["grok": ["grok.weekly"]]) { first, _ in first }
        XCTAssertTrue(mac.layout.canUndo)
        mac.settings.apply(try! JSONSerialization.data(withJSONObject: ["layout": kept, "notifications": ["underTenPercent": true, "healthyToClose": false, "closeToRunningOut": false]]))
        XCTAssertTrue(mac.layout.canUndo, "not put in again")
        XCTAssertTrue(mac.layout.isPinned("claude.session"))
        XCTAssertTrue(mac.notifications.underTenPercent)
    }

    func testAChangeOnItsWayStaysWhileAnOlderAnswerComes() {
        let (mac, _) = panel("OnItsWay")
        mac.settings.apply(Data("{}".utf8))
        mac.layout.setPinned(true, for: "codex.session")
        mac.settings.check()
        // The host's answer to an earlier ask, before it has this change: the layout stays.
        let older: [String: Any] = ["layout": ["placed": ["claude.session"], "providerOrder": [], "metricOrder": [:], "pinned": [], "expanded": [], "expandOnEnable": [], "seeded": []]]
        mac.settings.apply(try! JSONSerialization.data(withJSONObject: older), except: ["layout"])
        XCTAssertTrue(mac.layout.isPinned("codex.session"))
        XCTAssertTrue(mac.layout.canUndo)
    }
}
