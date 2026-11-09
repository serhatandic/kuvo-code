import AppKit
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode
@testable import UsageKit

/// Pictures of the usage panel's bars for the accounts of the 0.8.0-beta.11 report (#336): this Mac
/// and three machines, the same Claude, Codex and Grok accounts signed in on several of them, and a
/// second Claude login ("Athas"). Each box is a stand-in answering `api/kuvo/limits`; the rows are
/// what `BoxPlanLimits` makes of them, drawn with the panel's own bars (`ProviderBar`), light and
/// dark. Only with KUVO_SHOTS_OUT, the folder they go in (`scripts/test-app.sh` with
/// ONLY=KuvoCodeTests/UsageRowsShots); KUVO_SHOTS_PREFIX names them ("after" by default).
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil), .timeLimit(.minutes(5)))
struct UsageRowsShots {
    private static let boxes = [
        ("", "http://127.0.0.1:47971"), ("hetzner", "http://127.0.0.1:47972"),
        ("lokum-tailscale", "http://127.0.0.1:47973"), ("mini-local", "http://127.0.0.1:47974"),
    ]

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

    /// What each box states, as in the report: one Claude account on this Mac (whose token can't say
    /// who it's for) and on hetzner, one Codex account everywhere, one Grok account on two.
    private static let said: [String: [[String: Any]]] = [
        "": [
            account("claude-code", "claude", agent: "claude", plan: "Max 20x", used: 0.53, week: 0.31, minutesAgo: 4),
            account("codex-cli", "codex", agent: "codex", identity: "c0dec0dec0dec0de", plan: "Pro", used: 0.85, week: 0.44, minutesAgo: 6),
            account("grok-cli", "grok", agent: "grok", identity: "a1a1a1a1a1a1a1a1", used: 0.97, week: 0.97, minutesAgo: 8),
        ],
        "hetzner": [
            account("claude-code", "claude", agent: "claude", identity: "c1a0dec1a0dec1a0", plan: "Max 20x", used: 0.53, week: 0.31, minutesAgo: 2),
            account("claude-code@a7", "claude", agent: "claude", label: "Athas", identity: "a7a7a7a7a7a7a7a7", plan: "Pro", used: 0.12, week: 0.4, minutesAgo: 3),
            account("codex-cli", "codex", agent: "codex", identity: "c0dec0dec0dec0de", plan: "Pro", used: 0.85, week: 0.44, minutesAgo: 1),
        ],
        "lokum-tailscale": [
            account("codex-cli", "codex", agent: "codex", identity: "c0dec0dec0dec0de", plan: "Pro", used: 0.85, week: 0.44, minutesAgo: 5),
        ],
        "mini-local": [
            account("codex-cli", "codex", agent: "codex", identity: "c0dec0dec0dec0de", plan: "Pro", used: 0.85, week: 0.44, minutesAgo: 7),
            account("grok-cli", "grok", agent: "grok", identity: "a1a1a1a1a1a1a1a1", used: 0.97, week: 0.97, minutesAgo: 9),
            account("opencode-go", "opencode", identity: "0c0c0c0c0c0c0c0c", plan: "Go", used: 0.6, week: 0.4, minutesAgo: 9),
        ],
    ]

    init() {
        StubWeb.start(hosts: ["127.0.0.1"])
    }

    @Test func shots() async throws {
        let out = try #require(ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"])
        let prefix = ProcessInfo.processInfo.environment["KUVO_SHOTS_PREFIX"] ?? "after"
        try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        defer { StubWeb.stop(); HostLimits.shared.update(rows: [], covered: []); UserDefaults.standard.removeObject(forKey: "usage.boxServices") }
        for (name, url) in Self.boxes {
            try StubWeb.answer(url + "/api/kuvo/limits", json: ["data": ["services": ["claude", "codex", "grok", "opencode"], "accounts": Self.said[name] ?? []]])
        }
        let planLimits = BoxPlanLimits()
        for (name, url) in Self.boxes {
            planLimits.connected(name.isEmpty ? nil : name, api: OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: url)!, password: "test")))
        }
        // Every box's answer in: a row each before (#336), one per account after.
        try await until { HostLimits.shared.rows.count == (prefix == "before" ? 10 : 6) }
        for dark in [false, true] {
            let png = try picture(dark: dark)
            try png.write(to: URL(fileURLWithPath: out).appending(path: "\(prefix)-mac-\(dark ? "dark" : "light").png"))
        }
    }

    /// The bars as the panel lists them: by provider, in the panel's order, each its rows.
    private func picture(dark: Bool) throws -> Data {
        let suite = "UsageRowsShots.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WidgetDataStore(registry: WidgetRegistry(providers: [], descriptors: []), providers: [], defaults: defaults)
        let order = ["claude", "codex", "grok", "opencode"]
        let rows = HostLimits.shared.rows.enumerated().sorted { a, b in
            let (x, y) = (order.firstIndex(of: a.element.providerID) ?? 9, order.firstIndex(of: b.element.providerID) ?? 9)
            return x != y ? x < y : a.offset < b.offset
        }.map(\.element)
        let view = VStack(alignment: .leading, spacing: 5) {
            ForEach(rows) { row in
                let provider = HostLimits.provider(for: row.providerID)
                let meters = HostLimitData.rows(row, store: store).filter(\.isBounded)
                ProviderBar(provider: Provider(id: provider.id, displayName: row.name, icon: provider.icon, links: provider.links),
                            reading: meters.min { $0.remainingFraction < $1.remainingFraction }, notice: row.notice, isExpanded: false)
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
