import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Mark All as Read (#424, as Mail's): from the sidebar's menu, every computer's box reads
/// everything new it has, once each (`POST kuvo/sessions/read`), and what it read comes back as it
/// does from any other client (`session.viewed`): no session shows new, and one that asks you
/// still needs you. A computer with nothing new isn't asked. The engine and the boxes are stand-ins.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct MarkAllReadTests {
    let engine = StubEngine(port: 47935)
    let project = "/tmp/kuvo-tests-mark-all-read/web"

    /// Boxes that answer Mark All as Read as a box does: what each was asked, and each read told
    /// to `workspace` as its engine would.
    final class Boxes: @unchecked Sendable {
        private let lock = NSLock()
        private var asked: [String: [String]] = [:]
        /// What each box reads, by its id: sessions and where they ended.
        let reads: [String: [(String, Double)]]
        weak var workspace: Workspace?
        let engine: StubEngine

        init(reads: [String: [(String, Double)]], engine: StubEngine) {
            self.reads = reads
            self.engine = engine
        }

        func requests(of box: String) -> [String] { lock.withLock { asked[box] ?? [] } }

        @MainActor func client(_ box: String) -> BoxClient {
            BoxClient(box: box, transport: LocalBox { [self] request in
                lock.withLock { asked[box, default: []].append("\(request.method) \(request.path)") }
                let read = reads[box] ?? []
                return AsyncThrowingStream { continuation in
                    Task { @MainActor in
                        for (session, idle) in read { workspace?.handle(try engine.event("session.viewed", session: session, ["idle": idle])) }
                        continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                        continuation.yield(.body(Data(#"{"read": \#(read.count)}"#.utf8)))
                        continuation.finish()
                        TestPulse.beat()
                    }
                }
            })
        }
    }

    @Test func everyComputerReadsItsNewsOnceAndWhatAsksYouStays() async throws {
        defer { engine.stop() }
        let unread = { (id: String) in StubEngine.session(id, directory: project, extra: ["time": ["created": 1, "updated": 9, "idle": 9, "viewed": 4]]) }
        engine.list([unread("ses_bots"), unread("ses_yours"), unread("ses_asks")])
        let app = AppModel()
        app.workspace.api = engine.api
        await app.workspace.refresh()
        let boxes = Boxes(reads: ["mac": [("ses_bots", 9), ("ses_yours", 9), ("ses_asks", 9)]], engine: engine)
        boxes.workspace = app.workspace
        app.workspace.boxes = { boxes.client($0) }
        app.workspace.askingInBrowser = ["ses_asks"]
        #expect(app.hasNew(on: .mac))

        await app.markAllRead(on: app.boxes).value
        try await until { app.workspace.session("ses_yours")?.isUnread == false }
        #expect(boxes.requests(of: "mac") == ["POST kuvo/sessions/read"], "one call to the box, which does the reading")
        #expect(["ses_bots", "ses_yours", "ses_asks"].allSatisfy { app.workspace.session($0)?.isUnread == false })
        #expect(app.news(on: .mac) == .needsYou, "what asks you still does")
        #expect(!app.hasNew(on: .mac))

        // Nothing new: the box isn't asked again.
        #expect(app.boxesToMarkRead(app.boxes).isEmpty)
        await app.markAllRead(on: app.boxes).value
        #expect(boxes.requests(of: "mac").count == 1)
    }

    @Test func eachBoxIsAskedOnce() async throws {
        defer { engine.stop() }
        let workspace = Workspace()
        let boxes = Boxes(reads: [:], engine: engine)
        workspace.boxes = { boxes.client($0) }
        await workspace.markAllRead(on: [BoxClient.mac, "devbox", "gpu-box"])
        #expect(boxes.requests(of: BoxClient.mac) == ["POST kuvo/sessions/read"])
        #expect(boxes.requests(of: "devbox") == ["POST kuvo/sessions/read"])
        #expect(boxes.requests(of: "gpu-box") == ["POST kuvo/sessions/read"])
    }
}
