import AppKit
import SwiftUI

/// Takes files dropped anywhere over what it covers, text fields included: a text field would
/// take a file dropped on its text as the file's path. It's there only for files being dragged;
/// clicks, typing and text dragged in go on to what's underneath.
struct FileDropArea: NSViewRepresentable {
    let isTargeted: (Bool) -> Void
    let drop: ([URL]) -> Void

    func makeNSView(context: Context) -> DropView {
        let view = DropView()
        view.registerForDraggedTypes([.fileURL])
        return view
    }

    func updateNSView(_ view: DropView, context: Context) {
        view.isTargeted = isTargeted
        view.drop = drop
    }

    final class DropView: NSView {
        var isTargeted: (Bool) -> Void = { _ in }
        var drop: ([URL]) -> Void = { _ in }

        /// Only while something is being dragged (a button held, past its press), so the pointer's
        /// clicks and scrolls, and VoiceOver, find the views underneath.
        override func hitTest(_ point: NSPoint) -> NSView? {
            guard NSEvent.pressedMouseButtons != 0 else { return nil }
            switch NSApp.currentEvent?.type {
            case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel:
                return nil
            default:
                return super.hitTest(point)
            }
        }

        override func isAccessibilityElement() -> Bool { false }

        private func files(_ info: NSDraggingInfo) -> [URL] {
            info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        }

        override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
            guard !files(sender).isEmpty else { return [] }
            isTargeted(true)
            return .copy
        }

        override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
            files(sender).isEmpty ? [] : .copy
        }

        override func draggingExited(_ sender: NSDraggingInfo?) {
            isTargeted(false)
        }

        override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
            isTargeted(false)
            let urls = files(sender)
            guard !urls.isEmpty else { return false }
            drop(urls)
            return true
        }

        override func concludeDragOperation(_ sender: NSDraggingInfo?) {
            isTargeted(false)
        }
    }
}
