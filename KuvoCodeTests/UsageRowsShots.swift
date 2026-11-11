import AppKit
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode
@testable import UsageKit

/// Pictures of the usage panel's bars for the accounts of the 0.8.0-beta.12 report (#441): this Mac
/// and two machines, one Claude account signed in on hetzner (Linux) and on mini-local (a Mac, by
/// Kuvo Code's token), a second Claude account there ("Athas", a team's), and Codex and Grok on
/// this Mac and mini-local. Each box is a stand-in answering `api/kuvo/limits`; the rows are what
/// `BoxPlanLimits` makes of them, placed among the panel's own bars as the Bars view places them
/// (`HostLimits.entries`) and drawn with its bars (`ProviderBar`), light and dark. Only with
/// KUVO_SHOTS_OUT, the folder they go in (`scripts/test-app.sh` with
/// ONLY=KuvoCodeTests/UsageRowsShots); KUVO_SHOTS_PREFIX names them ("after" by default; "before"
/// states mini-local's Claude as a box from before it said who a Mac's token is for).
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil), .timeLimit(.minutes(5)))
struct UsageRowsShots {
    private static let boxes = [("", "http://127.0.0.1:47971"), ("hetzner", "http://127.0.0.1:47972"), ("mini-local", "http://127.0.0.1:47974")]

    private static func account(_ provider: String, _ service: String, agent: String? = nil, label: String? = nil, identity: String? = nil,
                                plan: String? = nil, used: Double, week: Double, minutesAgo: Double) -> [String: Any] {
        let now = Date().timeIntervalSince1970 * 1000
        let read = now - minutesAgo * 60_000
        var account: [String: Any] = ["provider": provider, "service": service, "checked": read, "windows": [
            ["id": "five_hour", "used": used, "minutes": 300, "resetsAt": now + 2 * 3_600_000, "read": read, "source": "usage"],
            ["id": "seven_day", "used": week, "minutes": 10_080, "resetsAt": now + 4 * 86_400_000, "read": read, "source": "usage"],
        ]]
        if let agent { account["agent"] = agent; account["account"] = provider.contains("@") ? String(provider.split(separator: "@")[1]) : "default" }
        if let label { account["label"] = label }
        if let identity { account["identity"] = identity }
        if let plan { account["plan"] = plan }
        return account
    }

    /// What each box states, as in the report: this Mac has had no Claude turn (the panel's own
    /// Claude bar is its spend); mini-local's Claude is hetzner's account, which before #441 a Mac's
    /// box couldn't say.
    private static func said(before: Bool) -> [String: [[String: Any]]] {
        [
            "": [
                account("codex-cli", "codex", agent: "codex", identity: "c0dec0dec0dec0de", plan: "Plus", used: 0, week: 0.27, minutesAgo: 4),
                account("grok-cli", "grok", agent: "grok", identity: "a1a1a1a1a1a1a1a1", used: 0.01, week: 0.99, minutesAgo: 6),
            ],
            "hetzner": [
                account("claude-code", "claude", agent: "claude", identity: "c1a0dec1a0dec1a0", plan: "Max 20x", used: 0.12, week: 0.29, minutesAgo: 2),
            ],
            "mini-local": [
                account("claude-code", "claude", agent: "claude", identity: before ? nil : "c1a0dec1a0dec1a0", used: 0.12, week: 0.30, minutesAgo: 1),
                account("claude-code@57eea190", "claude", agent: "claude", label: "Athas", identity: "a7a7a7a7a7a7a7a7", used: 0.12, week: 0.31, minutesAgo: 3),
                account("codex-cli", "codex", agent: "codex", identity: "c0dec0dec0dec0de", plan: "Plus", used: 0, week: 0.27, minutesAgo: 7),
                account("grok-cli", "grok", agent: "grok", identity: "a1a1a1a1a1a1a1a1", used: 0.01, week: 0.99, minutesAgo: 9),
            ],
        ]
    }

    /// The panel's own providers, in its order: Claude's bar only its spend (covered, and this Mac
    /// has no row of it), Codex's and Grok's taken by this Mac's rows.
    private static let panel = ["claude", "codex", "grok"]

    init() {
        StubWeb.start(hosts: ["127.0.0.1"])
    }

    @Test func shots() async throws {
        let out = try #require(ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"])
        let prefix = ProcessInfo.processInfo.environment["KUVO_SHOTS_PREFIX"] ?? "after"
        try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        defer { StubWeb.stop(); HostLimits.shared.update(rows: [], covered: []); UserDefaults.standard.removeObject(forKey: "usage.boxServices") }
        let said = Self.said(before: prefix == "before")
        for (name, url) in Self.boxes {
            try StubWeb.answer(url + "/api/kuvo/limits", json: ["data": ["services": ["claude", "codex", "grok"], "accounts": said[name] ?? []]])
        }
        let planLimits = BoxPlanLimits()
        for (name, url) in Self.boxes {
            planLimits.connected(name.isEmpty ? nil : name, api: OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: url)!, password: "test")))
        }
        // Every box's answer in: mini-local's Claude a row of its own before, hetzner's account after.
        try await until { HostLimits.shared.rows.count == (prefix == "before" ? 5 : 4) }
        for dark in [false, true] {
            let png = try picture(dark: dark)
            try png.write(to: URL(fileURLWithPath: out).appending(path: "\(prefix)-mac-\(dark ? "dark" : "light").png"))
        }
    }

    /// The bars as the panel lists them (`HostLimits.entries`): its own, and the host's rows where they go.
    private func picture(dark: Bool) throws -> Data {
        let suite = "UsageRowsShots.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WidgetDataStore(registry: WidgetRegistry(providers: [], descriptors: []), providers: [], defaults: defaults)
        let groups = Self.panel.map { id in
            ProviderGroup(provider: Provider(id: id, displayName: id.capitalized, icon: .providerMark(id)), alwaysShownWidgets: [], expandedWidgets: [])
        }
        let entries = HostLimits.shared.entries(groups: groups) { _ in false }
        let view = VStack(alignment: .leading, spacing: 5) {
            ForEach(entries) { entry in
                switch entry {
                case .group(let group):
                    // The panel's own Claude bar: what this Mac's logs say it spent (no limits of its own).
                    ProviderBar(provider: group.provider, reading: WidgetData(title: "Last 30 Days", icon: group.provider.icon, kind: .dollars, used: 2_512, limit: nil),
                                notice: nil, isExpanded: false)
                case .host(let row, let provider, _):
                    let meters = HostLimitData.rows(row, store: store).filter(\.isBounded)
                    ProviderBar(provider: Provider(id: provider.id, displayName: row.name, icon: provider.icon, links: provider.links),
                                reading: meters.min { $0.remainingFraction < $1.remainingFraction }, notice: row.notice, isExpanded: false)
                }
            }
        }
        .padding(14)
        .frame(width: 340)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, dark ? .dark : .light)
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 340, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let host = NSHostingView(rootView: view)
        host.frame.size = host.fittingSize
        window.setContentSize(host.fittingSize)
        window.contentView = host
        window.orderBack(nil)
        defer {
            window.orderOut(nil)
            window.close()
            window.contentView = nil
        }
        host.layoutSubtreeIfNeeded()
        host.display()
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        return try #require(rep.representation(using: .png, properties: [:]))
    }
}
