import AppKit
import PDFKit
import WebKit

/// Prints a web view to a PDF file, in pages, showing nothing. WebKit's print operation draws
/// nothing for a web view outside a window, so a tab out of view (a bot's, or the panel closed)
/// borrows a window no one sees for the moment.
@MainActor
enum PagePrinter {
    enum Outcome { case saved(pages: Int), notShown, failed }

    static func save(_ webView: WKWebView, to url: URL) async -> Outcome {
        // In a view that isn't in a window: moving it would take it from the panel for good.
        if webView.window == nil, webView.superview != nil { return .notShown }
        let info = (NSPrintInfo.shared.copy() as? NSPrintInfo) ?? NSPrintInfo()
        info.topMargin = 36
        info.bottomMargin = 36
        info.leftMargin = 36
        info.rightMargin = 36
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.jobDisposition = .save
        info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = url

        var borrowed: NSWindow?
        let window: NSWindow
        if let own = webView.window {
            window = own
        } else {
            let size = NSSize(width: max(webView.frame.width, 1024), height: max(webView.frame.height, 768))
            let offscreen = NSWindow(contentRect: NSRect(origin: NSPoint(x: -20_000, y: -20_000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
            offscreen.isReleasedWhenClosed = false
            offscreen.contentView = webView
            borrowed = offscreen
            window = offscreen
        }
        defer {
            if let borrowed, webView.superview === borrowed.contentView || borrowed.contentView === webView { borrowed.contentView = nil }
        }

        let operation = webView.printOperation(with: info)
        operation.showsPrintPanel = false
        operation.showsProgressPanel = false
        operation.view?.frame = webView.bounds
        let done = Done()
        let succeeded = await withCheckedContinuation { continuation in
            done.onFinish { continuation.resume(returning: $0) }
            operation.runModal(for: window, delegate: done, didRun: #selector(Done.printOperationDidRun(_:success:contextInfo:)), contextInfo: nil)
        }
        guard succeeded, let document = PDFDocument(url: url), document.pageCount > 0 else { return .failed }
        return .saved(pages: document.pageCount)
    }

    /// The print operation's word that it's done, which comes on a thread of its own.
    private nonisolated final class Done: NSObject, @unchecked Sendable {
        private let lock = NSLock()
        private var finish: (@Sendable (Bool) -> Void)?

        func onFinish(_ finish: @escaping @Sendable (Bool) -> Void) {
            lock.withLock { self.finish = finish }
        }

        @objc func printOperationDidRun(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
            let finish = lock.withLock { () -> (@Sendable (Bool) -> Void)? in
                defer { self.finish = nil }
                return self.finish
            }
            finish?(success)
        }
    }
}
