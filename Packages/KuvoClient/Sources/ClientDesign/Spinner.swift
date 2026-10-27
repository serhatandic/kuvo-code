import SwiftUI

/// A short wait in a control or beside a line of text: a button saving, a toggle being applied, a
/// row's action, an install. It's the sidebar's working ring (`StatusMark`) at the size of the
/// text around it, so a wait in a button looks like work in a row. Waits with a shape of their
/// own use theirs: a step at work, a sign-in, a computer starting, a download, content on its way.
/// Not `ProgressView`, which hosts an AppKit view that flies in from the window's corner when it
/// appears during an animation.
public struct Spinner: View {
    var size: CGFloat = 11

    public init(size: CGFloat = 11) {
        self.size = size
    }

    public var body: some View {
        StatusMark(.working, size: size)
    }
}
