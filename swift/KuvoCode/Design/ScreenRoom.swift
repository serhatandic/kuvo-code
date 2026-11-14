import AppKit
import SwiftUI

/// How much of the screen there is above and below a view, read when it's asked, for a popover
/// that has to stay on one side of it (one that grows past the room on its side jumps to the
/// other). Set by a `ScreenRoomReader` behind the view.
@MainActor
final class ScreenRoom {
    fileprivate weak var view: NSView?

    /// The room above and below the view, within the screen's visible part; nil before it's shown.
    var room: (above: CGFloat, below: CGFloat)? {
        guard let view, let window = view.window, let screen = window.screen else { return nil }
        let frame = window.convertToScreen(view.convert(view.bounds, to: nil))
        let visible = screen.visibleFrame
        return (visible.maxY - frame.maxY, frame.minY - visible.minY)
    }
}

/// Put behind a view, so `room` measures it.
struct ScreenRoomReader: NSViewRepresentable {
    let room: ScreenRoom

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        room.view = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        room.view = view
    }
}
