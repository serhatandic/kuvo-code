import AppKit
import SwiftUI
import Testing
@testable import UsageKit

/// Pictures of a plan's extras and its resets under a usage bar (#631 E), drawn with the panel's own
/// bars and detail from host rows as the Mac's box states them, light and dark, for comparing with
/// the drafts the user picked (1A, 2A, 3C). Only with KUVO_SHOTS_OUT, the folder they go in.
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil))
struct ResetShots {
    let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] ?? "/dev/null")
    let schemes: [(ColorScheme, String)] = [(.light, "light"), (.dark, "dark")]
    let now = Date()
    /// The panel's settings, in a folder of this run's own (gone after each picture's test).
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("UsageKitResetShots-\(UUID().uuidString)", isDirectory: true)
    let store: WidgetDataStore
    let limits = HostLimits()

    init() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        store = WidgetDataStore(registry: WidgetRegistry(providers: [], descriptors: []), providers: [], defaults: try #require(UserDefaults(suiteName: folder.appendingPathComponent("shots").path)))
    }

    private func meter(_ title: String, used: Double, resetsIn: TimeInterval?, minutes: Int) -> HostLimitRow.Meter {
        HostLimitRow.Meter(title: title, fraction: used, resetsAt: resetsIn.map { now + $0 }, periodMinutes: minutes)
    }

    private func claude(done: Bool = false, elsewhere: String? = nil) -> HostLimitRow {
        HostLimitRow(id: "claude#work", providerID: "claude", name: "Claude · Work", plan: "Max 5x",
                     meters: [meter("Session", used: done ? 0 : 0.88, resetsIn: done ? nil : 72 * 60, minutes: 300), meter("Weekly", used: done ? 0 : 0.41, resetsIn: 3 * 86_400 + 6 * 3600, minutes: 10_080)],
                     extras: [.init(id: "extra_usage", name: "Extra Usage", kind: .capped, amount: 12.4, limit: 50, unit: "usd", resetsAt: now + 18 * 86_400 + 5 * 3600),
                              .init(id: "resets", name: "Rate Limit Resets", kind: .resets, count: done ? 1 : 2, expiries: [now + 4 * 86_400], usable: true, elsewhere: elsewhere, elsewhereHelp: elsewhere.map { "\($0) has this account's sign-in." })])
    }

    private var codex: HostLimitRow {
        HostLimitRow(id: "codex#own", providerID: "codex", name: "Codex", plan: "Plus",
                     meters: [meter("Session", used: 0.92, resetsIn: 100 * 60, minutes: 300), meter("Weekly", used: 0.22, resetsIn: 5 * 86_400 + 2 * 3600, minutes: 10_080)],
                     extras: [.init(id: "credits", name: "Extra Usage", kind: .left, amount: 1240, unit: "credits"),
                              .init(id: "resets", name: "Rate Limit Resets", kind: .resets, count: 2, expiries: [now + 3 * 86_400], usable: true)])
    }

    private var openrouter: HostLimitRow {
        HostLimitRow(id: "openrouter#key", providerID: "openrouter", name: "OpenRouter", meters: [], balance: .init(left: 7.7, limit: 50, unit: "usd"),
                     extras: [.init(id: "today", name: "Today", amount: 1.84, unit: "usd", resetsAt: now + 3600),
                              .init(id: "week", name: "This Week", amount: 9.2, unit: "usd", resetsAt: now + 86_400),
                              .init(id: "month", name: "This Month", amount: 31.75, unit: "usd", resetsAt: now + 9 * 86_400)])
    }

    /// One account's bar, its detail open or not, its resets in `phase`.
    @ViewBuilder
    private func account(_ row: HostLimitRow, open: Bool, phase: HostResetFlow.Phase = .idle) -> some View {
        let rows = HostLimitData.rows(row, store: store, now: now)
        let provider = Provider(id: row.providerID, displayName: row.name, icon: .providerMark(row.providerID), links: [ProviderLink(label: "Usage", url: "https://example.com")])
        let flow = limits.resetFlow(for: row.id + "\(phase)")
        let _ = (flow.phase = phase)
        VStack(alignment: .leading, spacing: 0) {
            // (As the Bars view picks it: the plan's limits before what it has beyond them.)
            let limits = rows.filter { data in data.isBounded && row.meters.contains { $0.title == data.title } }
            ProviderBar(provider: provider, reading: (limits.isEmpty ? rows.filter(\.isBounded) : limits).min { $0.remainingFraction < $1.remainingFraction } ?? rows.first, notice: nil, isExpanded: open)
            if open {
                BarDetailContent(provider: provider, plan: row.plan, notice: nil, staleness: nil, rows: rows, links: provider.links, refresh: {},
                                 resets: row.resets.map { ($0, flow) }, unreadable: row.unreadable, extrasEnd: rows.count)
                    .padding(.vertical, 4)
            }
        }
    }

    private func panel(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 5) { content() }
            .padding(ProviderBar.inset)
            .frame(width: 340, alignment: .topLeading)
            .background(Theme.traySurface, in: .rect(cornerRadius: 13))
            .overlay(RoundedRectangle(cornerRadius: 13).strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5))
    }

    @Test func rows() throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        for (scheme, s) in schemes {
            try render(panel { account(claude(), open: true); account(codex, open: false); account(openrouter, open: false) }, "mac-row-claude-\(s)", scheme: scheme)
            try render(panel { account(codex, open: true); account(claude(), open: false); account(openrouter, open: false) }, "mac-row-codex-\(s)", scheme: scheme)
            try render(panel { account(openrouter, open: true); account(claude(), open: false); account(codex, open: false) }, "mac-row-openrouter-\(s)", scheme: scheme)
        }
    }

    @Test func resetStates() throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let states: [(String, HostLimitRow, HostResetFlow.Phase)] = [
            ("available", claude(), .idle), ("elsewhere", claude(elsewhere: "hetzner"), .idle), ("resetting", claude(), .using),
            ("done", claude(done: true), .done), ("failed", claude(), .failed("Didn't go through. Nothing was used.")),
        ]
        for (scheme, s) in schemes {
            for (name, row, phase) in states {
                try render(panel { account(row, open: true, phase: phase); account(codex, open: false); account(openrouter, open: false) }, "mac-reset-\(name)-\(s)", scheme: scheme)
            }
        }
    }

    @Test func confirm() throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let offer = HostResetOffer(confirm: "rsc_1", question: "Use 1 of 2 resets?", detail: "Your usage limits start over now.")
        for (scheme, s) in schemes {
            try render(panel { account(codex, open: true, phase: .confirming(offer)); account(claude(), open: false); account(openrouter, open: false) }, "mac-confirm-\(s)", scheme: scheme)
        }
    }

    private func render(_ content: some View, _ name: String, scheme: ColorScheme) throws {
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let root = content
            .padding(28)
            .background(scheme == .dark ? Color(white: 0.11) : Color(white: 0.88))
            .environment(\.colorScheme, scheme)
            .fixedSize()
        let host = NSHostingView(rootView: AnyView(root))
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 400, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        window.contentView = host
        for _ in 0..<3 {
            host.layoutSubtreeIfNeeded()
            let size = host.fittingSize
            window.setContentSize(size)
            host.frame = NSRect(origin: .zero, size: size)
        }
        host.layoutSubtreeIfNeeded()
        host.display()
        let size = host.bounds.size
        let rep = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * 2), pixelsHigh: Int(size.height * 2),
                                                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        rep.size = size
        host.cacheDisplay(in: host.bounds, to: rep)
        let png = try #require(rep.representation(using: .png, properties: [:]))
        try png.write(to: out.appending(path: name + ".png"))
        window.contentView = nil
        window.close()
    }
}
