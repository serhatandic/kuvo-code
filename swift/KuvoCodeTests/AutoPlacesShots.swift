import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Pictures of Auto's Decisions with a folder Auto allowed edits in for the session (#422), before
/// and after Revoke: the real `DecisionsView`, offscreen, light and dark, with the decisions as a
/// box lists them. Only with KUVO_SHOTS_OUT, the folder they go in (`scripts/test-app.sh` with
/// ONLY=KuvoCodeTests/AutoPlacesShots).
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil), .timeLimit(.minutes(5)))
struct AutoPlacesShots {
    init() {
        TestEnvironment.prepare()
    }

    /// An evening's evaluation: the folder allowed, its first edit, a test run, and one held back.
    private func decisions(revoked: Bool) throws -> ReviewDecisions {
        let now = Date.now.timeIntervalSince1970 * 1000
        let place = "/private/tmp/eval-ds/T2"
        let rows: [[String: Any]] = [
            ["id": "d1", "at": now - 1_800_000, "action": "Change \(place)/box/src/link/server/serve.ts", "kind": "file", "decision": "allowed", "reason": "Part of the evaluation it was given, in the worktree its task names.", "by": "model"],
            ["id": "d2", "at": now - 1_800_000, "action": "Change \(place)", "kind": "file", "decision": "allowed", "reason": "Auto allowed edits in \(place) for this session.", "by": "model", "place": place]
                .merging(revoked ? ["revoked": now - 60_000] : [:]) { $1 },
            ["id": "d3", "at": now - 900_000, "action": "cd \(place)/box && node --test bridge-tests/sandbox-asks.test.js", "kind": "command", "decision": "allowed", "reason": "Runs the project's own tests.", "by": "model"],
            ["id": "d4", "at": now - 300_000, "action": "git push origin eval/ds-T2", "kind": "command", "decision": "refused", "reason": "Pushing wasn't part of what it was asked to do.", "by": "model", "why": "reviewer", "held": true],
        ]
        return try JSONDecoder().decode(ReviewDecisions.self, from: JSONSerialization.data(withJSONObject: ["decisions": rows]))
    }

    @Test func shots() async throws {
        let out = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"]))
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let session = try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: StubEngine.session("ses_eval", directory: "/Users/me/Projects/kuvo-ai")))
        for revoked in [false, true] {
            for dark in [false, true] {
                let model = SessionModel(session: session, api: OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: "http://127.0.0.1:1")!, password: "test")))
                model.decisions = try decisions(revoked: revoked)
                let png = try await picture(model, dark: dark)
                try png.write(to: out.appending(path: "mac-decisions-\(revoked ? "after-revoke" : "before-revoke")-\(dark ? "dark" : "light").png"))
            }
        }
    }

    private func picture(_ model: SessionModel, dark: Bool) async throws -> Data {
        let scheme: ColorScheme = dark ? .dark : .light
        let root = DecisionsView(model: model)
            .background(dark ? Color(white: 0.17) : Color(white: 0.98), in: .rect(cornerRadius: 12))
            .padding(12)
            .appLook()
            .environment(\.colorScheme, scheme)
            .fixedSize()
        let host = NSHostingView(rootView: AnyView(root))
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 460, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
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
            window.setContentSize(size)
            host.frame = NSRect(origin: .zero, size: size)
            try await Task.sleep(for: .milliseconds(60))
        }
        host.layoutSubtreeIfNeeded()
        host.display()
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        return try #require(rep.representation(using: .png, properties: [:]))
    }
}
