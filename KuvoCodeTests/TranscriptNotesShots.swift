import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Pictures of a transcript with no pills (#404, #406): a lead's conversation whose sessions'
/// news (one finished, one asking) reads as messages from them, with a model change said in the
/// next reply's footer; and a session's transcript whose notes for the model (work moved to the
/// background for a message, the command ending) show nothing. From the app's own TranscriptView,
/// off screen, light and dark, into KUVO_SHOTS_OUT. Not a test of behavior (TranscriptNotesTests
/// is); it runs only when that's set. The engine is stubbed.
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil), .timeLimit(.minutes(5)))
struct TranscriptNotesShots {
    let engine = StubEngine(port: 47872)

    private static func reply(_ id: String, at: Double, _ text: String, model: String = "claude-opus-5.5", tokens: Int = 412) -> [String: Any] {
        ["id": id, "type": "assistant", "agent": "build", "time": ["created": at, "completed": at + 4_000], "model": ["id": model, "providerID": "anthropic"],
         "tokens": ["input": 1200, "output": tokens, "reasoning": 0, "cache": ["read": 0, "write": 0]],
         "content": [["type": "text", "text": text]]]
    }

    private static func step(_ id: String, at: Double, command: String, output: String) -> [String: Any] {
        ["id": id, "type": "assistant", "agent": "build", "time": ["created": at, "completed": at + 2_000], "model": ["id": "claude-opus-5.5", "providerID": "anthropic"],
         "content": [["type": "tool", "id": "call_\(id)", "name": "bash", "state": ["status": "completed", "input": ["command": command], "content": [["type": "text", "text": output]]]]]]
    }

    // 18:40 on a day, in ms.
    static let base: Double = 1_794_329_000_000

    static let lead: [[String: Any]] = [
        ["id": "msg_01", "type": "user", "time": ["created": base], "text": "Start #398 and #399, and tell me when they're done."],
        reply("msg_02", at: base + 5_000, "Started both: **#398** (the sign-in card) and **#399** (keep-alive). I'll tell you as each reports back."),
        ["id": "msg_03", "type": "idle", "time": ["created": base + 10_000], "outcome": "succeeded"],
        ["id": "msg_04", "type": "model-switched", "time": ["created": base + 20_000], "model": ["id": "claude-sonnet-5.5", "providerID": "anthropic", "variant": "high"],
         "previous": ["id": "claude-opus-5.5", "providerID": "anthropic"]],
        ["id": "msg_05", "type": "user", "time": ["created": base + 3_600_000],
         "text": "[Session finished] \"#399 keep-alive\" in kuvo-ai (address ses_399), after 58 min:\nMerged to main at 1a2b3c4. The box keeps idle connections open past what clients assume; the test that failed under load now checks the relay's word. All box and bridge tests pass.\n\n[Session asks] \"#398 sign-in card answers the wrong computer\" in kuvo-ai (address ses_398) asks to run `scripts/heavy.sh phone sh scripts/test-app.sh` (ask per_1). Answer with answer_ask if it's yours to allow, or tell the user in a line and carry on.",
         "metadata": ["kuvo": ["note": ["from": "Its sessions", "line": "2 updates from its sessions"]]]],
        reply("msg_06", at: base + 3_610_000, "**#399** is merged. **#398** wants to run the phone's tests: I allowed it, as it runs only in its own simulator.", model: "claude-sonnet-5.5", tokens: 999),
        ["id": "msg_07", "type": "idle", "time": ["created": base + 3_620_000], "outcome": "succeeded"],
    ]

    static let session: [[String: Any]] = {
        let command = "cd /tmp/kuvo-373/phone && KUVO_HEAVY_SLOTS=2 ONLY=KuvoCodeMobileUITests/PictureGalleryTests timeout -k 30 2400 ../kuvo-ai/scripts/heavy.sh phone sh scripts/test-app.sh > /tmp/phone-ui.log 2>&1; echo exit $?"
        return [
            ["id": "msg_01", "type": "user", "time": ["created": base], "text": "Run the phone's picture gallery UI tests, then implement the TextKit picture segment."],
            step("msg_02", at: base + 2_000, command: command, output: "Command moved to the background."),
            ["id": "msg_03", "type": "synthetic", "time": ["created": base + 6_000],
             "text": "User requested that active blocking work be moved to the background.\n\nBackgrounded work:\n- shell: \(command)\n\nThe backgrounded work is still unfinished. Move on to other work if you can. If there is nothing else useful to do, finish your response. Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation."],
            reply("msg_04", at: base + 8_000, "I'll wait for the UI run to finish.", tokens: 159),
            ["id": "msg_05", "type": "idle", "time": ["created": base + 12_000], "outcome": "succeeded"],
            ["id": "msg_06", "type": "synthetic", "time": ["created": base + 1_200_000], "text": "<shell id=\"sh_1\" state=\"completed\" command=\"\(command)\">\nexit 0\n</shell>",
             "description": command, "metadata": ["source": "shell", "shellID": "sh_1", "state": "completed", "exit": 0]],
            step("msg_07", at: base + 1_202_000, command: "grep -c passed /tmp/phone-ui.log", output: "14"),
            reply("msg_08", at: base + 1_206_000, "All 14 gallery tests passed. Now the TextKit picture segment.", tokens: 233),
            ["id": "msg_09", "type": "idle", "time": ["created": base + 1_210_000], "outcome": "succeeded"],
        ]
    }()

    @Test func shots() async throws {
        let out = try #require(ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"])
        try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        // Every reply's footer, not only the last's under the pointer.
        setenv("KUVO_DEMO_SHOW_HOVER", "1", 1)
        defer {
            unsetenv("KUVO_DEMO_SHOW_HOVER")
            engine.stop()
        }
        for (name, conversation) in [("mac-lead", Self.lead), ("mac-session", Self.session)] {
            for dark in [false, true] {
                let png = try await picture(conversation, dark: dark)
                try png.write(to: URL(fileURLWithPath: out).appending(path: "\(name)-\(dark ? "dark" : "light").png"))
            }
        }
    }

    private func picture(_ conversation: [[String: Any]], dark: Bool) async throws -> Data {
        let id = "ses_shots_notes"
        let app = AppModel()
        app.workspace.api = engine.api
        engine.list([StubEngine.session(id, title: "Lead", directory: "/tmp/kuvo-tests-notes-shots")])
        engine.conversation(id, conversation)
        await app.workspace.refresh()
        let model = try #require(app.workspace.model(for: id))
        await model.load()
        let size = NSSize(width: 720, height: 760)
        let scheme: ColorScheme = dark ? .dark : .light
        let view = TranscriptView(model: model)
            .appLook()
            .environment(app)
            .environment(app.catalog)
            .environment(app.workspace)
            .environment(app.bots)
            .environment(app.chats)
            .environment(\.colorScheme, scheme)
            .background(Surface.cardFill(scheme, focused: true))
            .frame(width: size.width, height: size.height)
        let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: -20_000, y: -20_000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let host = NSHostingView(rootView: view)
        window.contentView = host
        window.orderBack(nil)
        defer {
            window.orderOut(nil)
            window.close()
            window.contentView = nil
        }
        // Only for the picture: let the rows lay out and their fades finish.
        for _ in 0..<6 {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(300))
        }
        host.display()
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        return try #require(rep.representation(using: .png, properties: [:]))
    }
}
