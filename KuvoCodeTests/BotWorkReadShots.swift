import AppKit
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Pictures of the sidebar with a bot's sessions (#424): three it started and leads have new
/// replies to it, and one asks you. "before": as a box left them before #424, unread, so blue dots
/// on their rows, their project and this Mac's name in the computers' strip; "after": as a box
/// leaves them now (READ_RULE, the box's `keepWorkRead`), read, so no dots, while the one asking
/// you keeps its orange. The app's own window (`MainView`) in a window of the test's own, light and
/// dark; this Mac's engine is stubbed, and a machine is a stand-in so the strip shows. Only with
/// KUVO_SHOTS_OUT, the folder they go in (`scripts/test-app.sh` with ONLY=KuvoCodeTests/BotWorkReadShots).
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil), .timeLimit(.minutes(5)))
struct BotWorkReadShots {
    let engine = StubEngine(port: 47932)
    let folder = "/tmp/kuvo-tests-work-read-shots/kuvo-store"

    init() throws {
        TestEnvironment.prepare()
        AXElement.reading(true)
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    }

    /// The sessions, each bot's one with a reply to the bot at 20, read (`read`) or last read at 10.
    private func sessions(read: Bool) -> [[String: Any]] {
        let work: [String: Any] = ["kuvo": ["startedBy": "ses_foreman", "by": ["bot": "bot_foreman", "name": "Kuvo Foreman"], "depth": 1, "wake": ["finished", "asks"]]]
        let botWork = { (id: String, title: String, created: Double) in
            StubEngine.session(id, title: title, directory: folder, created: created,
                               extra: ["metadata": work, "time": ["created": created, "updated": 20, "idle": 20, "viewed": read ? 20 : 10]])
        }
        return [
            botWork("ses_shots_checkout", "Fix the checkout page", 5),
            botWork("ses_shots_prices", "Update the price table", 4),
            botWork("ses_shots_tests", "Make the store's tests pass", 3),
            botWork("ses_shots_asks", "Publish the new release", 2),
            StubEngine.session("ses_shots_yours", title: "Plan the spring sale", directory: folder, created: 1,
                               extra: ["time": ["created": 1, "updated": 2, "idle": 2, "viewed": 2]]),
        ]
    }

    @Test func shots() async throws {
        let out = try #require(ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"])
        try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        SSHConnection.standIn = { _, _ in nil }
        defer {
            SSHConnection.standIn = nil
            engine.stop()
            UserDefaults.standard.removeObject(forKey: "sessionsWidth")
            UserDefaults.standard.removeObject(forKey: SidebarBox.inViewKey)
            try? FileManager.default.removeItem(atPath: "/tmp/kuvo-tests-work-read-shots")
        }
        for read in [false, true] {
            for dark in [true, false] {
                let png = try await picture(read: read, dark: dark)
                try png.write(to: URL(fileURLWithPath: out).appending(path: "mac-\(read ? "after" : "before")-\(dark ? "dark" : "light").png"))
            }
        }
    }

    private func picture(read: Bool, dark: Bool) async throws -> Data {
        engine.list(sessions(read: read))
        let app = AppModel()
        app.workspace.api = engine.api
        await app.workspace.refresh()
        let machine = app.machines.add("mini-local")
        machine.showStandIn("connected")
        defer { app.removeMachine(machine.machine.id) }
        // The one asking you something: it needs you, before and after.
        app.workspace.askingInBrowser = ["ses_shots_asks"]
        let width = 300.0
        UserDefaults.standard.set(width, forKey: "sessionsWidth")
        UserDefaults.standard.set("mac", forKey: SidebarBox.inViewKey)
        let scheme: ColorScheme = dark ? .dark : .light
        let view = MainView()
            .appLook()
            .environment(app)
            .environment(app.catalog)
            .environment(app.workspace)
            .environment(app.bots)
            .environment(app.chats)
            .environment(Updates())
            .environment(\.colorScheme, scheme)
            .frame(width: 1000, height: 560)
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 1000, height: 560), styleMask: [.titled, .fullSizeContentView],
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
        func shows(_ name: String) -> Bool {
            host.layoutSubtreeIfNeeded()
            DispatchQueue.main.async { TestPulse.beat() }
            return AXElement.all(in: host).contains { $0.label == name && $0.isRead }
        }
        try await until { shows("Fix the checkout page") }
        // What the rows show is what every client reads: unread as the box left them, or not.
        #expect(app.workspace.session("ses_shots_checkout")?.isUnread == !read)
        // Only for the picture: let the rows' fades finish.
        try await Task.sleep(for: .seconds(1))
        host.layoutSubtreeIfNeeded()
        host.display()
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let full = try #require(rep.cgImage)
        let scale = CGFloat(full.width) / host.bounds.width
        // The sidebar, past its card's edge.
        let image = try #require(full.cropping(to: CGRect(x: 0, y: 0, width: (width + 24) * scale, height: 560 * scale)))
        // Over a plain desktop, as the glass shows over one.
        let backdrop = NSImage(size: NSSize(width: image.width, height: image.height), flipped: false) { rect in
            NSColor(white: dark ? 0.16 : 0.86, alpha: 1).setFill()
            rect.fill()
            NSGraphicsContext.current?.cgContext.draw(image, in: rect)
            return true
        }
        let tiff = try #require(backdrop.tiffRepresentation)
        return try #require(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
    }
}
