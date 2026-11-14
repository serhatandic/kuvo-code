import AppKit
import SwiftUI

extension View {
    /// Keeps the window's toolbar icon-only, without the "Icon and Text / Icon Only /
    /// Text Only" choices AppKit puts in its right-click menu. SwiftUI has no modifier for it.
    func iconOnlyToolbar() -> some View {
        background(IconOnlyToolbar())
    }
}

private struct IconOnlyToolbar: NSViewRepresentable {
    func makeNSView(context: Context) -> Probe { Probe() }

    /// SwiftUI installs and refills the toolbar as content changes, so check again on updates.
    func updateNSView(_ probe: Probe, context: Context) {
        probe.applySoon()
    }

    final class Probe: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            applySoon()
        }

        /// After the current update, when SwiftUI has put the toolbar in place.
        func applySoon() {
            DispatchQueue.main.async { [weak self] in self?.apply() }
        }

        private func apply() {
            guard let toolbar = window?.toolbar else { return }
            toolbar.displayMode = .iconOnly
            toolbar.allowsDisplayModeCustomization = false
            toolbar.allowsUserCustomization = false
        }
    }
}
