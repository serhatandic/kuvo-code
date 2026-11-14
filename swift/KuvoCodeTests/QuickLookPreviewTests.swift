import AppKit
import Quartz
import SwiftUI
import Testing
@testable import KuvoCode

/// A file the panel shows with Quick Look (a PDF, a spreadsheet, a video): the preview stays
/// usable when the window it's in closes and SwiftUI updates it once more on the way out, or it's
/// shown again. Quick Look aborts the whole app when it's given a file after it was closed. A real
/// preview, in a window of the test's own.
@MainActor
@Suite(.serialized) struct QuickLookPreviewTests {
    @Test func aPreviewWhoseWindowClosedTakesTheNextFile() throws {
        TestEnvironment.prepare()
        let folder = FileManager.default.temporaryDirectory.appending(path: "kuvo-quicklook-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let first = folder.appending(path: "first.rtf")
        let next = folder.appending(path: "next.rtf")
        try Data(#"{\rtf1 The first.}"#.utf8).write(to: first)
        try Data(#"{\rtf1 The next.}"#.utf8).write(to: next)

        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 480, height: 360), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: QuickLookView(url: first))
        window.contentView = host
        window.orderBack(nil)
        host.layoutSubtreeIfNeeded()
        let preview = try #require(Self.preview(in: host))
        #expect((preview.previewItem as? NSURL) as URL? == first)

        // The window closes, and the view is told of the file shown next before it goes.
        window.close()
        host.rootView = QuickLookView(url: next)
        host.layoutSubtreeIfNeeded()
        #expect((preview.previewItem as? NSURL) as URL? == next)
    }

    private static func preview(in view: NSView) -> QLPreviewView? {
        if let preview = view as? QLPreviewView { return preview }
        return view.subviews.lazy.compactMap(preview(in:)).first
    }
}
