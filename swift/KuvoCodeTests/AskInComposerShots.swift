import AppKit
import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Pictures of a permission in the composer's place, its answers numbered (#376), light and dark,
/// from the app's own views, offscreen, into KUVO_SHOTS_OUT. Not a test of behavior
/// (`PermissionAnswerKeysTests`, `AskInComposerTests` are); it runs only when that's set.
@MainActor
@Suite(.serialized) struct AskInComposerShots {
    let out = ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"].map { URL(fileURLWithPath: $0) }
    let app = AppModel()

    init() {
        TestEnvironment.prepare()
    }

    private func request() throws -> PermissionRequest {
        let ask: [String: Any] = ["id": "per_1", "sessionID": "ses_shots", "action": "shell", "resources": ["swift test --filter SettingsTests"], "save": ["swift test *"]]
        return try JSONDecoder().decode(PermissionRequest.self, from: JSONSerialization.data(withJSONObject: ask))
    }

    private func shot(_ name: String, waiting: [String], instead: String) async throws {
        guard let out else { return }
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let request = try request()
        var place = AskPlace()
        place.update(waiting)
        for scheme in [ColorScheme.light, .dark] {
            let width: CGFloat = 640
            let root = AskInComposer(place: place) { _ in } content: {
                PermissionCard(request: request, directory: "/Users/me/pomodoro", instead: .constant(instead)) { _, _ in }
            }
            .modifier(ComposerSurface())
            .padding(16)
            .background(Surface.cardFill(scheme, focused: true))
            .environment(\.colorScheme, scheme)
            .environment(\.cardRoom, 400)
            .environment(app)
            .environment(app.workspace)
            .frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
            let host = NSHostingView(rootView: AnyView(root))
            let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: width, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
            window.contentView = host
            for _ in 0..<10 {
                host.layoutSubtreeIfNeeded()
                let size = host.fittingSize
                window.setContentSize(NSSize(width: width, height: size.height))
                host.frame = NSRect(origin: .zero, size: NSSize(width: width, height: size.height))
                await Task.yield()
            }
            host.layoutSubtreeIfNeeded()
            host.display()
            let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            try #require(rep.representation(using: .png, properties: [:])).write(to: out.appending(path: "\(name)-\(scheme == .dark ? "dark" : "light").png"))
            window.contentView = nil
            window.close()
        }
    }

    @Test func aPermission() async throws {
        try await shot("mac-376-permission", waiting: ["per_1"], instead: "")
    }

    @Test func twoWaiting() async throws {
        try await shot("mac-376-two-waiting", waiting: ["per_1", "frm_1"], instead: "")
    }

    @Test func toldWhatToDoInstead() async throws {
        try await shot("mac-376-instead", waiting: ["per_1"], instead: "Run only SettingsTests, not the whole suite")
    }
}
