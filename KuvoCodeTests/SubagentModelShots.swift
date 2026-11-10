import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Pictures of Settings › Agents' Subagents section (#100), the real section in a grouped form as
/// Settings draws it, light and dark, in a window of the test's own. Not a test of behavior: only
/// with KUVO_SHOTS_OUT, the folder they go in (`scripts/test-app.sh` with
/// ONLY=KuvoCodeTests/SubagentModelShots, passed as TEST_RUNNER_KUVO_SHOTS_OUT).
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil), .timeLimit(.minutes(2)))
struct SubagentModelShots {
    let app = AppModel()
    let catalog = Catalog()

    init() { TestEnvironment.prepare() }

    @Test func shots() throws {
        let out = try #require(ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"])
        try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        for dark in [false, true] {
            let form = Form {
                Section {
                    ConfigModelPicker(title: "Model for new sessions", path: ["model"], defaultTitle: "The engine's choice")
                    ConfigModelPicker(title: "Model for session titles", path: ["agents", "title", "model"], defaultTitle: "The session's model")
                } footer: {
                    Text("New sessions use the model you picked last; this one is for when there's none. A small, fast model is enough for titles.")
                        .foregroundStyle(.secondary)
                }
                SubagentModelSection()
            }
            .formStyle(.grouped)
            .scrollDisabled(true)
            .environment(app)
            .environment(catalog)
            .environment(\.editedConfig, EngineConfig(draft: [:]))
            .environment(\.colorScheme, dark ? .dark : .light)
            .frame(width: 620)
            .fixedSize(horizontal: false, vertical: true)
            let host = NSHostingView(rootView: form)
            let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 620, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.contentView = host
            window.orderBack(nil)
            defer {
                window.orderOut(nil)
                window.close()
            }
            host.layoutSubtreeIfNeeded()
            window.setContentSize(NSSize(width: 620, height: host.fittingSize.height))
            host.layoutSubtreeIfNeeded()
            let picture = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: picture)
            try #require(picture.representation(using: .png, properties: [:]))
                .write(to: URL(filePath: out).appending(path: "mac-agents-subagents-\(dark ? "dark" : "light").png"))
        }
    }
}
