import AppKit
import KuvoLink
import SwiftUI
import Testing
@testable import KuvoCode

/// A Markdown file in the Artifacts popover is drawn, not shown as its raw `#` and backticks: the
/// first time it's opened, whether it has one version or several.
@MainActor
@Suite(.serialized) struct ArtifactMarkdownTests {
    let app = AppModel()

    init() { TestEnvironment.prepare() }

    private func version(_ n: Int) -> [String: Any] {
        ["n": n, "at": 1_000.0 * Double(n), "by": ["kind": "agent"], "via": [String](), "status": n == 1 ? "added" : "modified",
         "edits": 1, "size": 40, "kept": true]
    }

    private func box(versions: Int) -> BoxClient {
        let artifact: [String: Any] = ["id": "art_notes", "path": "/tmp/kuvo-tests-made/notes.md", "name": "notes.md", "kind": "document",
                                       "type": "text/markdown", "where": ["bots": [String](), "sessions": ["ses_1"], "groups": [String]()],
                                       "updated": 3_000.0, "versions": (1...versions).map(version)]
        let changes: [String: Any] = ["style": "words", "added": 1, "removed": 0,
                                      "lines": [["kind": "same", "text": "# Plan"], ["kind": "added", "text": "Some **bold** words"]]]
        let artifactData = (try? JSONSerialization.data(withJSONObject: artifact)) ?? Data()
        let changesData = (try? JSONSerialization.data(withJSONObject: changes)) ?? Data()
        let source = Data("# Plan\n\nSome **bold** words\n".utf8)
        return BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            let path = request.path.hasPrefix("/") ? String(request.path.dropFirst()) : request.path
            let isBytes = path.contains("/versions/") && !path.hasSuffix("/changes")
            let body = isBytes ? source : (path.hasSuffix("/changes") ? changesData : artifactData)
            return AsyncThrowingStream { continuation in
                continuation.yield(.head(status: 200, headers: ["content-type": isBytes ? "text/markdown" : "application/json"]))
                continuation.yield(.body(body))
                continuation.finish()
            }
        })
    }

    private func views(in view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views(in:)) }

    /// Opens the file as the popover does, and gives the window's picture once it has loaded.
    private func opened(versions: Int, scheme: ColorScheme = .light) async throws -> (drawn: Bool, png: Data) {
        let things = MadeThings(box: box(versions: versions), scope: .session("ses_1"))
        let header = try JSONDecoder().decode(ArtifactHeader.self, from: Data("""
            {"id":"art_notes","path":"/tmp/kuvo-tests-made/notes.md","name":"notes.md","kind":"document","type":"text/markdown",
             "where":{"bots":[],"sessions":["ses_1"],"groups":[]},"updated":3000}
            """.utf8))
        let root = ArtifactDetail(things: things, header: header, back: "Artifacts", close: {}, done: {})
            .environment(app)
            .environment(\.colorScheme, scheme)
            .frame(width: 420, height: 360)
        let host = NSHostingView(rootView: AnyView(root))
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 420, height: 360), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        window.contentView = host
        var drawn = false
        for _ in 0..<4000 where !drawn {
            host.layoutSubtreeIfNeeded()
            drawn = views(in: host).contains { $0 is ReplyPieceView }
            await Task.yield()
        }
        // Only for the picture: let the cross-fade finish. The check above doesn't wait on a clock.
        if ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil { try await Task.sleep(for: .seconds(1)) }
        host.layoutSubtreeIfNeeded()
        host.display()
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let png = try #require(rep.representation(using: .png, properties: [:]))
        window.contentView = nil
        window.close()
        return (drawn, png)
    }

    private func save(_ png: Data, _ name: String) throws {
        guard let out = ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] else { return }
        try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        try png.write(to: URL(fileURLWithPath: out).appending(path: name + ".png"))
    }

    @Test func aMarkdownFileWithOneVersionIsDrawn() async throws {
        let shown = try await opened(versions: 1)
        try save(shown.png, "one-version")
        #expect(shown.drawn)
    }

    @Test func aMarkdownFileWithSeveralVersionsIsDrawn() async throws {
        let shown = try await opened(versions: 2)
        try save(shown.png, "two-versions")
        #expect(shown.drawn)
    }
}
