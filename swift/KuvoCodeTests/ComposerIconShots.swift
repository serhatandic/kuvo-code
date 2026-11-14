import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Pictures of the composer's row (#440): the paperclip, the mode's icon, the chips' chevrons and
/// ✕, the mic, Send and Stop, light and dark, from the real composer offscreen, into
/// KUVO_SHOTS_OUT. Not a test of behavior (`ComposerRowTests` is); it runs only when that's set.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ComposerIconShots {
    let out = ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"].map { URL(fileURLWithPath: $0) }
    let app = AppModel()
    let catalog = Catalog()

    init() {
        TestEnvironment.prepare()
        AXElement.reading(true)
    }

    /// The engine's one model, Opus 5.5 with its efforts, as it answers.
    private func models() async throws {
        let engine = "http://127.0.0.1:47997"
        StubWeb.start(hosts: ["127.0.0.1", "models.opencode.ai"])
        catalog.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: engine)!, password: "test"))
        let opus: [String: Any] = ["id": "claude-opus-5-5", "modelID": "claude-opus-5-5", "providerID": "anthropic", "name": "Opus 5.5",
                                   "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": ["low", "medium", "high", "max"].map { ["id": $0] },
                                   "time": ["released": 1], "cost": [["input": 1, "output": 1]], "status": "active", "enabled": true,
                                   "limit": ["context": 1_000_000, "output": 64_000]]
        let account: [String: Any] = ["id": "anthropic", "name": "Anthropic", "methods": [["type": "key"]],
                                      "connections": [["type": "credential", "credentialID": "cred_anthropic", "method": "key"]]]
        let location = ["directory": "/"]
        try StubWeb.answer(engine + "/api/integration", json: ["location": location, "data": [account]])
        try StubWeb.answer(engine + "/api/model", json: ["location": location, "data": [opus]])
        try StubWeb.answer(engine + "/api/model/default", json: ["location": location, "data": opus])
        try StubWeb.answer(engine + "/api/agent", json: ["location": location, "data": []])
        try StubWeb.answer(engine + "/api/command", json: ["location": location, "data": []])
        await catalog.refresh()
    }

    private func shot(_ name: String, width: CGFloat, agent: String = "build", approval: ToolApproval = .fullAccess,
                      autopilot: Bool = false, running: Bool = false) async throws {
        guard let out else { return }
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        try await models()
        defer { StubWeb.stop() }
        let model = ModelRef(id: "claude-opus-5-5", providerID: "anthropic", variant: "high")
        #expect(catalog.chipModel(model)?.name == "Opus 5.5")
        for scheme in [ColorScheme.light, .dark] {
            let composer = Composer(session: "ses_icons", text: .constant(""), files: .constant([]), quotes: .constant([]), quoteFocus: nil,
                                    agent: agent, approval: approval, model: model,
                                    isRunning: running, keywords: [],
                                    onSelectAgent: { _ in }, onSelectApproval: { _ in },
                                    autopilot: autopilot ? AutopilotChoice(on: true) : nil,
                                    onSelectModel: { _ in }, onSend: {}, onStop: {}, focusesOnAppear: false)
                .environment(\.messageFont, MessageFont())
                .padding(16)
                .background(Surface.cardFill(scheme, focused: true))
                .environment(\.colorScheme, scheme)
                .environment(app)
                .environment(app.workspace)
                .environment(catalog)
                .frame(width: width)
                .fixedSize(horizontal: false, vertical: true)
            let host = NSHostingView(rootView: AnyView(composer))
            let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: width, height: 200), styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
            window.contentView = host
            window.orderBack(nil)
            defer {
                window.contentView = nil
                window.orderOut(nil)
                window.close()
            }
            try await until {
                host.layoutSubtreeIfNeeded()
                let size = host.fittingSize
                window.setContentSize(NSSize(width: width, height: size.height))
                host.frame = NSRect(origin: .zero, size: NSSize(width: width, height: size.height))
                TestPulse.beat()
                return AXElement.all(in: host).contains { $0.label == "Mode" }
            }
            host.layoutSubtreeIfNeeded()
            host.display()
            // At twice the points, as a Retina screen shows it.
            let picture = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(host.bounds.width * 2), pixelsHigh: Int(host.bounds.height * 2),
                                                        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                                        bytesPerRow: 0, bitsPerPixel: 0))
            picture.size = host.bounds.size
            host.cacheDisplay(in: host.bounds, to: picture)
            try #require(picture.representation(using: .png, properties: [:])).write(to: out.appending(path: "\(name)-\(scheme == .dark ? "dark" : "light").png"))
        }
    }

    @Test func theRow() async throws {
        defer { AXElement.reading(false) }
        try await shot("mac-row", width: 640)
    }

    @Test func narrowTheModesIconAlone() async throws {
        defer { AXElement.reading(false) }
        try await shot("mac-row-narrow", width: 360)
    }

    @Test func planAndAutopilotWhileItWorks() async throws {
        defer { AXElement.reading(false) }
        try await shot("mac-row-chips", width: 640, agent: "plan", approval: .auto, autopilot: true, running: true)
    }
}
