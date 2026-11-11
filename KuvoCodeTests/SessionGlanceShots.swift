import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Shots of #395 as built, not a test of behavior: the sidebar's session rows with the mark each
/// gains (a pull request's, red all over while a check fails, else its branch's), and the card a
/// row opens beside it as the pointer settles on it, light and dark. The app's own window
/// (`MainView`) in a window of the test's own, with this Mac's engine stubbed: eight sessions in one
/// project, all shown (KUVO_DEMO_SHOW_ALL), one at work, one waiting on you, one finished unseen,
/// one failed, the rest quiet; what their box says of them (`SessionGlance`) is set as a box would
/// answer it. The real card is a borderless panel over the window, which can't be drawn off screen,
/// so the card (the real `GlanceCardForRow`) is drawn on its own and laid where the panel puts it.
/// Only with KUVO_SHOTS_OUT (`TEST_RUNNER_KUVO_SHOTS_OUT=… ONLY=KuvoCodeTests/SessionGlanceShots
/// scripts/test-app.sh`).
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil), .timeLimit(.minutes(10)))
struct SessionGlanceShots {
    let engine = StubEngine(port: 47_396)
    let folder = "/tmp/kuvo-tests-395-build/pomodoro"
    let now = Date.now
    static let sidebar = 280.0

    init() throws {
        TestEnvironment.prepare()
        AXElement.reading(true)
        setenv("KUVO_DEMO_SHOW_ALL", "1", 1)
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let now = now, folder = folder
        let ms = { (minutes: Double) in (now.timeIntervalSince1970 - minutes * 60) * 1000 }
        let model = { (id: String, provider: String, variant: String?) -> [String: Any] in
            ["model": ["id": id, "providerID": provider].merging(variant.map { ["variant": $0] } ?? [:]) { $1 }]
        }
        let session = { (id: String, title: String, minutes: Double, extra: [String: Any]) in
            StubEngine.session(id, title: title, directory: folder, created: ms(minutes + 30),
                               extra: ["time": ["created": ms(minutes + 30), "updated": ms(minutes), "idle": ms(minutes), "viewed": ms(minutes) + 1]].merging(extra) { $1 })
        }
        engine.list([
            session("ses_g1", "Dark mode with system preference", 1, model("claude-opus-5-5", "anthropic", "high")),
            session("ses_g2", "Timer cycle: focus, short break, long break", 2, model("claude-opus-5-5", "anthropic", "xhigh")),
            session("ses_g3", "Keyboard shortcuts for skip", 12, model("gpt-5.5", "openai", "medium")
                .merging(["time": ["created": ms(60), "updated": ms(12), "idle": ms(12), "viewed": ms(40)]]) { $1 }),
            session("ses_g4", "README: how it works", 180, model("claude-sonnet-5", "anthropic", nil)),
            session("ses_g7", "Round counter off by one", 300, model("gpt-5.5", "openai", "medium")),
            session("ses_g5", "Flaky skip test", 60 * 26, model("claude-opus-5-5", "anthropic", "high").merging(["outcome": "failed"]) { $1 }),
            session("ses_g8", "Sound when a break ends", 60 * 24 * 2, model("claude-sonnet-5", "anthropic", nil)),
            session("ses_g6", "Theme flash on first paint", 60 * 24 * 3, model("claude-opus-5-5", "anthropic", "high")),
        ], running: ["ses_g1"])
        let named = { (id: String, provider: String, name: String) -> [String: Any] in
            ["id": id, "modelID": id, "providerID": provider, "name": name, "capabilities": ["tools": true, "input": ["text"], "output": ["text"]],
             "variants": ["low", "medium", "high", "xhigh"].map { ["id": $0] }, "time": ["released": 1], "cost": [["input": 1, "output": 1]],
             "status": "active", "enabled": true, "limit": ["context": 1_000_000, "output": 64_000]]
        }
        engine.on("GET", "/api/model", json: ["data": [named("claude-opus-5-5", "anthropic", "Opus 5.5"), named("claude-sonnet-5", "anthropic", "Sonnet 5"), named("gpt-5.5", "openai", "GPT-5.5")]])
    }

    /// What the box says of each, as it would answer: two in worktrees of their own, one waiting on
    /// you with checks under way, one with a check failing, one merged; the rest in the project's
    /// own folder.
    private func glances() -> [String: SessionGlance] {
        let asked = (now.timeIntervalSince1970 - 120) * 1000
        return [
            "ses_g1": SessionGlance(branch: "dark-mode", additions: 128, deletions: 14),
            "ses_g2": SessionGlance(branch: "timer-cycle", pull: .init(number: 42, state: .open, additions: 435, deletions: 4, checks: .init(passed: 12, failed: 0, pending: 2)),
                                    account: .init(name: "Claude Code", label: "Work"), asked: asked),
            "ses_g3": SessionGlance(branch: "skip-shortcut", pull: .init(number: 41, state: .open, additions: 86, deletions: 9, checks: .init(passed: 13, failed: 1, pending: 0)),
                                    account: .init(name: "OpenAI")),
            "ses_g4": SessionGlance(branch: "readme-how-it-works", pull: .init(number: 38, state: .merged, additions: 11, deletions: 2, checks: .init(passed: 14, failed: 0, pending: 0))),
            "ses_g5": SessionGlance(account: .init(name: "Anthropic")),
        ]
    }

    @Test func shots() async throws {
        let out = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"]))
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        SSHConnection.standIn = { _, _ in nil }
        // The one-time note about usage, answered, so it doesn't cover the sidebar's end.
        let noticeShown = Analytics.shared.noticeShown
        Analytics.shared.noticeShown = true
        defer {
            Analytics.shared.noticeShown = noticeShown
            SSHConnection.standIn = nil
            unsetenv("KUVO_DEMO_SHOW_ALL")
            engine.stop()
            UserDefaults.standard.removeObject(forKey: "sessionsWidth")
            try? FileManager.default.removeItem(atPath: "/tmp/kuvo-tests-395-build")
        }
        for dark in [false, true] {
            // The card of the session waiting on you, of the one finished with a check failing, of
            // the one at work in a worktree, of one in the project's own folder, and of the first
            // in Recents, which no project heading is over.
            for (index, hovered) in [nil, "ses_g2", "ses_g3", "ses_g1", "ses_g5", "recents:ses_g2"].enumerated() {
                let png = try await picture(hovered: hovered, dark: dark)
                let name = "mac" + (index == 0 ? "" : "-card\(index)") + "-\(dark ? "dark" : "light").png"
                try png.write(to: out.appending(path: name))
            }
        }
    }

    private func picture(hovered: String?, dark: Bool) async throws -> Data {
        let app = AppModel()
        app.workspace.api = engine.api
        app.catalog.api = engine.api
        await app.catalog.refresh()
        await app.workspace.refresh()
        app.workspace.askingInBrowser = ["ses_g2"]
        for (id, glance) in glances() { app.glances.show(glance, for: id) }
        UserDefaults.standard.set(Self.sidebar, forKey: "sessionsWidth")
        let scheme: ColorScheme = dark ? .dark : .light
        let width = 1000.0, height = 1000.0
        let view = MainView()
            .appLook()
            .environment(app)
            .environment(app.catalog)
            .environment(app.workspace)
            .environment(app.bots)
            .environment(app.chats)
            .environment(Updates())
            .environment(\.colorScheme, scheme)
            .frame(width: width, height: height)
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: width, height: height), styleMask: [.titled, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let host = NSHostingView(rootView: view)
        window.contentView = host
        window.orderBack(nil)
        defer {
            window.orderOut(nil)
            window.close()
            window.contentView = nil
        }
        /// The row's frame in the host; `lower`, the lowest of its rows (its row in Recents).
        func rowFrame(_ title: String, lower: Bool = false) -> NSRect? {
            host.layoutSubtreeIfNeeded()
            DispatchQueue.main.async { TestPulse.beat() }
            let frames = AXElement.all(in: host).filter { ($0.label ?? "").hasPrefix(title) }
                .map { host.convert(window.convertFromScreen($0.frame), from: nil) }.filter { $0.width > 100 }
            let rows = Dictionary(grouping: frames) { Int($0.midY / 8) }.values.compactMap { $0.max { $0.width < $1.width } }
            return rows.max { a, b in
                let lowerA = host.isFlipped ? a.minY : -a.minY, lowerB = host.isFlipped ? b.minY : -b.minY
                return lower ? lowerA < lowerB : lowerA > lowerB
            }
        }
        let titles = ["ses_g1": "Dark mode", "ses_g2": "Timer cycle", "ses_g3": "Keyboard shortcuts", "ses_g5": "Flaky skip"]
        try await until { rowFrame("Theme flash") != nil && rowFrame("Timer cycle") != nil }
        // Only for the picture: the rows' fades and the marks' arrival.
        try await Task.sleep(for: .seconds(1))
        let inRecents = hovered?.hasPrefix("recents:") == true
        let hoveredID = hovered.map { $0.replacingOccurrences(of: "recents:", with: "") }
        let row = hoveredID.flatMap { titles[$0] }.flatMap { rowFrame($0, lower: inRecents) }
        host.layoutSubtreeIfNeeded()
        host.display()
        let full = try Self.retina(host)
        let scale = CGFloat(full.width) / host.bounds.width
        let cropTop = 300.0
        let cropHeight = inRecents ? 640.0 : 360.0
        let cropWidth = Self.sidebar + 24 + 360
        let image = try #require(full.cropping(to: CGRect(x: 0, y: cropTop * scale, width: cropWidth * scale, height: cropHeight * scale)))

        var card: CGImage?
        if let hoveredID, let session = app.workspace.session(hoveredID) {
            let isUnread = session.isUnread || app.workspace.hasNewSubSessions(session.id)
            let row = GlanceCardForRow(id: session.id, fallback: session, underItsProject: !inRecents, acrossComputers: false, isUnread: isUnread, folded: [])
            card = try await cardImage(row, app: app, dark: dark)
        }
        let flipped = host.isFlipped
        let canvas = NSImage(size: NSSize(width: image.width, height: image.height), flipped: false) { rect in
            NSColor(white: dark ? 0.16 : 0.86, alpha: 1).setFill()
            rect.fill()
            let context = NSGraphicsContext.current!.cgContext
            context.draw(image, in: rect)
            if let row {
                // The row under the pointer, as its hover fill shows it.
                let top = (flipped ? row.minY : host.bounds.height - row.maxY) - cropTop
                let inset = inRecents ? 0 : 10 + SidebarMetrics.iconWidth
                let fill = CGRect(x: (row.minX + inset) * scale, y: (cropHeight - top - row.height) * scale, width: (row.width - inset) * scale, height: row.height * scale)
                NSColor(white: dark ? 1 : 0, alpha: dark ? 0.07 : 0.05).setFill()
                NSBezierPath(roundedRect: fill, xRadius: 8 * scale, yRadius: 8 * scale).fill()
                if let card {
                    // Where its panel puts it (`GlanceCardPanel.place`): past the row's end, its
                    // first line level with the row.
                    let margin = Self.cardMargin * scale
                    let midY = cropHeight - top - row.height / 2
                    let x = (row.maxX + 4) * scale - margin
                    let y = (midY + SessionGlanceCard<EmptyView>.firstLine(size: 13)) * scale + margin - CGFloat(card.height)
                    context.draw(card, in: CGRect(x: x, y: y, width: CGFloat(card.width), height: CGFloat(card.height)))
                }
            }
            return true
        }
        let tiff = try #require(canvas.tiffRepresentation)
        return try #require(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
    }

    static let cardMargin = 28.0

    /// What `view` draws, at twice its size, as on a Retina screen.
    static func retina(_ view: NSView) throws -> CGImage {
        let size = view.bounds.size
        let rep = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * 2), pixelsHigh: Int(size.height * 2), bitsPerSample: 8,
                                                samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        rep.size = size
        view.cacheDisplay(in: view.bounds, to: rep)
        return try #require(rep.cgImage)
    }

    /// The card on its own, on its raised surface with its shadow, with room around it for the shadow.
    private func cardImage(_ card: GlanceCardForRow, app: AppModel, dark: Bool) async throws -> CGImage {
        let scheme: ColorScheme = dark ? .dark : .light
        let root = card
            .glanceCardSurface(scheme)
            .padding(Self.cardMargin)
            .fixedSize()
            .appLook()
            .environment(app)
            .environment(app.workspace)
            .environment(\.colorScheme, scheme)
        let host = NSHostingView(rootView: AnyView(root))
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 400, height: 300), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.isOpaque = false
        window.backgroundColor = .clear
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = host
        window.orderBack(nil)
        defer {
            window.orderOut(nil)
            window.close()
            window.contentView = nil
        }
        for _ in 0..<6 {
            host.layoutSubtreeIfNeeded()
            let size = host.fittingSize
            window.setContentSize(size)
            host.frame = NSRect(origin: .zero, size: size)
            try await Task.sleep(for: .milliseconds(80))
        }
        host.layoutSubtreeIfNeeded()
        host.display()
        return try Self.retina(host)
    }
}
