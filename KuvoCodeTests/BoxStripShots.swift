import AppKit
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Pictures of the sidebar's top with its computers' strip (#232), from the app's own window
/// (`MainView`) in a window of the test's own: narrow and wide, light and dark, with 1, 2 and 4
/// machines, a long name, and a machine in view. Only with KUVO_SHOTS_OUT, the folder they go in
/// (`scripts/test-app.sh` with ONLY=KuvoCodeTests/BoxStripShots). The window's glass can't be
/// drawn off screen: its tint is, laid over a plain gray desktop. The machines are stand-ins
/// shown as connected (or as each case says), and this Mac's engine is stubbed, with one
/// session that needs you.
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil), .timeLimit(.minutes(5)))
struct BoxStripShots {
    let engine = StubEngine(port: 47931)
    let folder = "/tmp/kuvo-tests-strip-shots/sample-app"

    init() throws {
        TestEnvironment.prepare()
        AXElement.reading(true)
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        engine.list([StubEngine.session("ses_shots_a", title: "Fix the login form", directory: folder, created: 2),
                     StubEngine.session("ses_shots_b", title: "Release notes", directory: folder, created: 1)])
    }

    struct Case {
        var name: String
        var machines: [(String, String)]
        var inView: String = "mac"
        /// Settings › Appearance › Text size.
        var textSize = 14.0
    }

    static let cases: [Case] = [
        Case(name: "1", machines: [("mini-local", "connected")]),
        Case(name: "2", machines: [("mini-local", "connected"), ("devbox", "connected")]),
        Case(name: "4", machines: [("mini-local", "connected"), ("devbox", "connected"), ("gpu-box", "reconnecting"), ("staging", "notConnected")]),
        Case(name: "long", machines: [("build-server-in-the-basement-with-a-long-name", "connected"), ("devbox", "connected")],
             inView: "build-server-in-the-basement-with-a-long-name"),
        Case(name: "machine", machines: [("mini-local", "connected"), ("devbox", "connected"), ("gpu-box", "reconnecting"), ("staging", "notConnected")],
             inView: "devbox"),
        Case(name: "away", machines: [("mini-local", "connected"), ("gpu-box", "failed")], inView: "gpu-box"),
        Case(name: "larger", machines: [("mini-local", "connected"), ("devbox", "connected"), ("gpu-box", "reconnecting"), ("staging", "notConnected")],
             textSize: 17),
    ]

    @Test func shots() async throws {
        let out = try #require(ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"])
        // KUVO_SHOTS_PREFIX: "before" for the strip as it was, "after" by default.
        let prefix = ProcessInfo.processInfo.environment["KUVO_SHOTS_PREFIX"] ?? "after"
        try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        SSHConnection.standIn = { _, _ in nil }
        defer {
            SSHConnection.standIn = nil
            engine.stop()
            UserDefaults.standard.removeObject(forKey: "sessionsWidth")
            UserDefaults.standard.removeObject(forKey: SidebarBox.inViewKey)
            UserDefaults.standard.removeObject(forKey: Look.textSizeKey)
            try? FileManager.default.removeItem(atPath: "/tmp/kuvo-tests-strip-shots")
        }
        for shot in Self.cases {
            for width in [220.0, 360.0] {
                for dark in [true, false] {
                    let png = try await picture(shot, width: width, dark: dark)
                    try png.write(to: URL(fileURLWithPath: out).appending(path: "\(prefix)-\(Int(width))-\(shot.name)-\(dark ? "dark" : "light").png"))
                }
            }
        }
    }

    private func picture(_ shot: Case, width: Double, dark: Bool) async throws -> Data {
        let app = AppModel()
        app.workspace.api = engine.api
        await app.workspace.refresh()
        // (Its sidebar as this Mac's box lists these sessions.)
        let follows = try await engine.listing.follow(app.workspace)
        defer { follows.cancel() }
        var engines: [MachineEngine] = []
        for (name, status) in shot.machines {
            let machine = app.machines.add(name)
            machine.showStandIn(status)
            engines.append(machine)
        }
        defer { for machine in engines { app.removeMachine(machine.machine.id) } }
        // A session here that needs you: this Mac's mark.
        app.workspace.askingInBrowser = ["ses_shots_a"]
        UserDefaults.standard.set(width, forKey: "sessionsWidth")
        UserDefaults.standard.set("mac", forKey: SidebarBox.inViewKey)
        UserDefaults.standard.set(shot.textSize, forKey: Look.textSizeKey)
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
            .frame(width: 1000, height: 420)
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 1000, height: 420), styleMask: [.titled, .fullSizeContentView],
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
            return AXElement.all(in: host).contains { $0.label == name && $0.isSelected && $0.isRead }
        }
        // The window opens with what was open, which brings its computer into view (#318): the
        // case's computer picked after that, as you would.
        try await until { shows(app.name(of: .mac)) }
        UserDefaults.standard.set(shot.inView, forKey: SidebarBox.inViewKey)
        let inView = app.name(of: SidebarBox(id: shot.inView))
        try await until { shows(inView) }
        // Only for the picture: let the line's slide and the rows' fades finish.
        try await Task.sleep(for: .seconds(1))
        host.layoutSubtreeIfNeeded()
        host.display()
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let full = try #require(rep.cgImage)
        let scale = CGFloat(full.width) / host.bounds.width
        // The sidebar's top: past its card's edge, down to its first sections.
        let crop = CGRect(x: 0, y: 0, width: (width + 24) * scale, height: 245 * scale)
        let image = try #require(full.cropping(to: crop))
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
