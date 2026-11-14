import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// The composer's row of chips in a narrow window (#242): the mode chip gives way first, down to
/// its icon, so the model keeps its name; with room, it keeps its words. The phone's row does the
/// same. The composer is the real one, in a window of the test's own, read as VoiceOver reads it.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ComposerRowTests {
    let app = AppModel()
    let catalog = Catalog()

    init() {
        TestEnvironment.prepare()
        AXElement.reading(true)
    }

    /// The chips' frames in a composer `width` points wide, in Full Access.
    private func chips(width: CGFloat) async throws -> (mode: NSRect, model: NSRect) {
        let out = ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"]
        for look in out == nil ? [] : ["darkAqua", "aqua"] { try await chips(width: width, look: look, out: out) }
        return try await chips(width: width, look: nil, out: nil)
    }

    /// `out`: where a picture of the row goes (KUVO_SHOTS_OUT, passed as TEST_RUNNER_KUVO_SHOTS_OUT),
    /// to look at before and after a change.
    @discardableResult
    private func chips(width: CGFloat, look: String?, out: String?) async throws -> (mode: NSRect, model: NSRect) {
        let composer = Composer(session: "ses_row", text: .constant(""), files: .constant([]), quotes: .constant([]), quoteFocus: nil,
                                agent: "build", approval: .fullAccess, model: nil, isRunning: false, keywords: [],
                                onSelectAgent: { _ in }, onSelectApproval: { _ in }, onSelectModel: { _ in }, onSend: {}, onStop: {})
            .environment(\.messageFont, MessageFont())
            .environment(\.colorScheme, look == "aqua" ? .light : .dark)
            .environment(app)
            .environment(app.workspace)
            .environment(catalog)
            .frame(width: width, height: 200, alignment: .bottom)
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: width, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        if let look { window.appearance = NSAppearance(named: NSAppearance.Name(look)) }
        window.contentView = NSHostingView(rootView: composer)
        window.orderBack(nil)
        defer {
            window.orderOut(nil)
            window.close()
        }
        var found: (NSRect, NSRect)?
        try await until {
            window.contentView?.layoutSubtreeIfNeeded()
            TestPulse.beat()
            let elements = AXElement.all(in: window.contentView)
            guard let mode = elements.first(where: { $0.label == "Mode" }),
                  let model = elements.first(where: { $0.help == "Model and effort" || ($0.label ?? "").contains("Choose a Model") })
            else { return false }
            found = (mode.frame, model.frame)
            return true
        }
        if let out, let look, let view = window.contentView, let picture = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: picture)
            try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
            try picture.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out).appending(path: "mac-row-\(Int(width))-\(look == "aqua" ? "light" : "dark").png"))
        }
        let (mode, model) = try #require(found)
        return (mode, model)
    }

    @Test func shortOfRoomFullAccessGivesWayToItsIconBeforeTheModelsName() async throws {
        defer { AXElement.reading(false) }
        let (mode, model) = try await chips(width: 340)
        #expect(mode.width < 50, "Full Access shows only its icon: \(mode.width) points")
        #expect(model.width > mode.width * 2, "the model keeps its room: \(model.width) points")
        #expect(mode.maxX <= model.minX + 1, "the chips don't overlap")
    }

    @Test func withRoomFullAccessKeepsItsWords() async throws {
        defer { AXElement.reading(false) }
        let (mode, _) = try await chips(width: 620)
        #expect(mode.width > 80, "Full Access shows its words: \(mode.width) points")
    }
}
