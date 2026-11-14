import AppKit
import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Pictures of a bot's work bar over its composer (#370): each session's row says its model and
/// effort, the account it runs on (its provider, and the account's own name) and its project, and
/// where the row is short the account goes before the project, the title keeping its room. The
/// real `BotWorkBar`, offscreen, light and dark, wide and narrow; the engine's models are stubbed so
/// they're named as the picker names them. Only with KUVO_SHOTS_OUT, the folder they go in
/// (`scripts/test-app.sh` with ONLY=KuvoCodeTests/BotWorkBarShots); KUVO_SHOTS_PREFIX names them
/// ("after" by default).
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil), .timeLimit(.minutes(5)))
struct BotWorkBarShots {
    let app = AppModel()
    let catalog = Catalog()
    let updates = Updates()
    let engine = "http://127.0.0.1:47996"

    init() {
        TestEnvironment.prepare()
    }

    private let bot = Bot(id: "bot_foreman", name: "Kuvo Foreman", job: "", instructions: "", jobInMemory: true, look: BotLook(color: .orange, shape: .round, face: .calm),
                          machine: nil, project: nil, folder: "/bots/bot_foreman", sessionID: "ses_foreman", created: .now, model: nil, personality: nil)

    /// Three sessions at work, on a Claude Code account you named, the engine's Copilot plan and a
    /// Codex account you named, as the box tells them.
    private var report: BotWorkReport {
        get throws {
            let now = Date.now.timeIntervalSince1970 * 1000
            let row = { (id: String, title: String, provider: String, model: String, variant: String, account: String) in
                #"{"session": "\#(id)", "title": "\#(title)", "folder": "/p", "project": "Kuvo Code", "startedBy": "ses_foreman", "depth": 1, "model": {"id": "\#(model)", "providerID": "\#(provider)", "variant": "\#(variant)"}, "account": \#(account), "state": "working", "started": \#(now - 600_000), "tokens": 120000}"#
            }
            let rows = [
                row("ses_a", "Review #181 part 3 before merge (security)", "claude-code@athas", "opus", "high", #"{"name": "Claude Code", "label": "Athas"}"#),
                row("ses_b", "Fix the flaky upload test", "github-copilot", "claude-opus-5.5", "high", #"{"name": "GitHub Copilot"}"#),
                row("ses_c", "Write the release notes", "codex-cli@work", "gpt-5.5", "medium", #"{"name": "Codex", "label": "Work"}"#),
            ].joined(separator: ", ")
            let json = #"{"bot": "bot_foreman", "sessions": [\#(rows)], "answered": [], "today": {"started": 3, "working": 3, "tokens": 360000}, "limits": null}"#
            return try JSONDecoder().decode(BotWorkReport.self, from: Data(json.utf8))
        }
    }

    /// The engine's models, as the picker names them.
    private func models() async throws {
        StubWeb.start(hosts: ["127.0.0.1", "models.opencode.ai"])
        catalog.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: engine)!, password: "test"))
        let model = { (id: String, provider: String, name: String) -> [String: Any] in
            ["id": id, "modelID": id, "providerID": provider, "name": name, "capabilities": ["tools": true, "input": ["text"], "output": ["text"]],
             "variants": ["low", "medium", "high"].map { ["id": $0] }, "time": ["released": 1], "cost": [["input": 1, "output": 1]], "status": "active", "enabled": true,
             "limit": ["context": 1_000_000, "output": 64_000]]
        }
        let location = ["directory": "/"]
        let listed = [model("opus", "claude-code@athas", "Opus 5.5"), model("claude-opus-5.5", "github-copilot", "Opus 5.5"), model("gpt-5.5", "codex-cli@work", "GPT-5.5")]
        try StubWeb.answer(engine + "/api/integration", json: ["location": location, "data": []])
        try StubWeb.answer(engine + "/api/model", json: ["location": location, "data": listed])
        try StubWeb.answer(engine + "/api/model/default", json: ["location": location, "data": listed[0]])
        try StubWeb.answer(engine + "/api/agent", json: ["location": location, "data": []])
        try StubWeb.answer(engine + "/api/command", json: ["location": location, "data": []])
        await catalog.refresh()
    }

    @Test func shots() async throws {
        let out = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"]))
        let prefix = ProcessInfo.processInfo.environment["KUVO_SHOTS_PREFIX"] ?? "after"
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        defer { StubWeb.stop() }
        try await models()
        let report = try report
        // Wide, as a conversation usually is; narrower, where the account goes first; narrowest,
        // where the project's line is cut too.
        for (width, name) in [(CGFloat(760), "wide"), (520, "narrow"), (400, "narrowest")] {
            for dark in [false, true] {
                let png = try await picture(report, width: width, dark: dark)
                try png.write(to: out.appending(path: "\(prefix)-mac-\(name)-\(dark ? "dark" : "light").png"))
            }
        }
    }

    private func picture(_ report: BotWorkReport, width: CGFloat, dark: Bool) async throws -> Data {
        let scheme: ColorScheme = dark ? .dark : .light
        let root = BotWorkBar(bot: bot, report: report, isHidden: .constant(false))
            .background(Surface.cardFill(scheme, focused: true), in: .rect(cornerRadius: 18))
            .padding(12)
            .appLook()
            .environment(\.colorScheme, scheme)
            .environment(app)
            .environment(app.workspace)
            .environment(catalog)
            .environment(updates)
            .frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
        let host = NSHostingView(rootView: AnyView(root))
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: width, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.backgroundColor = dark ? NSColor(white: 0.12, alpha: 1) : NSColor(white: 0.94, alpha: 1)
        window.contentView = host
        defer {
            window.contentView = nil
            window.close()
        }
        for _ in 0..<10 {
            host.layoutSubtreeIfNeeded()
            let size = host.fittingSize
            window.setContentSize(NSSize(width: width, height: size.height))
            host.frame = NSRect(origin: .zero, size: NSSize(width: width, height: size.height))
            try await Task.sleep(for: .milliseconds(60))
        }
        host.layoutSubtreeIfNeeded()
        host.display()
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        return try #require(rep.representation(using: .png, properties: [:]))
    }
}
