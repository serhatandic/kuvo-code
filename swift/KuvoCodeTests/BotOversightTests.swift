import ClientSessions
import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// A bot overseeing its sessions, as this Mac's sidebar plays it (PROTOCOL.md, "Work", Oversight):
/// what the bot does to one of them on its box lights its lane to that session, once, as it
/// happens; what it did before the Mac looked isn't played late, and nothing plays for long. The
/// machine's box is the real one (`kuvo-link.js serve`), reached over HTTP where a Mac reaches it
/// over SSH.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BotOversightTests {
    let app = AppModel()

    init() {
        TestEnvironment.prepare()
        app.botOversight.app = app
    }

    /// The box's marks as its bots' processes note them (`run/work/oversight.json`).
    private func note(_ marks: [(id: String, session: String, kind: String)], on machine: MachineTestBox) throws {
        let work = machine.folder.appending(path: "run/work")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let now = Date.now.timeIntervalSince1970 * 1000
        let kept = marks.map { ["id": $0.id, "bot": "bot_pixel00001", "session": $0.session, "kind": $0.kind, "at": now] as [String: Any] }
        try JSONSerialization.data(withJSONObject: kept).write(to: work.appending(path: "oversight.json"))
    }

    @Test func whatABotDoesToItsSessionOnAMachinePlaysOnceAsItHappensAndNotWhatItDidBefore() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        var clock = Date.now
        app.botOversight.now = { clock }
        app.botOversight.boxes = { _ in machine.client }
        try note([("m1", "ses_core", "read")], on: machine)
        let following = Task { await app.botOversight.follow("lab") }
        defer { following.cancel() }
        try await until { app.botOversight.live.contains("lab") }
        #expect(app.botOversight.playing(in: ["ses_core"]).isEmpty, "it read Core before you looked: not played late")

        // It finishes Icons: Icons' lane lights, and its face is pleased.
        try note([("m1", "ses_core", "read"), ("m2", "ses_icons", "finished")], on: machine)
        try await until { !app.botOversight.playing(in: ["ses_icons"]).isEmpty }
        #expect(app.botOversight.playing(in: ["ses_icons"]).map(\.kind) == [.finished])
        #expect(app.botOversight.playing(in: ["ses_core"]).isEmpty, "Core's isn't played again")
        #expect(app.botOversight.playing(in: ["ses_mine"]).isEmpty, "nothing for a session that isn't one of these")

        // A moment later, a row made again (a project opened) doesn't play it.
        clock += BotOversight.fresh
        #expect(app.botOversight.playing(in: ["ses_icons"]).isEmpty)
    }
}
