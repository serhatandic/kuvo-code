import SwiftUI

/// The scroll container shared by the popover's three full-height screens (dashboard, Customize,
/// Settings). Each one fills the region the pinned footer leaves and keeps the native scroll edge
/// effect alive while hiding the scrollbar.
///
/// The scroll edge effect (the blur as content passes under the `safeAreaBar`) needs the scroll view
/// to keep a vertical scroller, so indicators are not hidden the SwiftUI way (that removes the
/// scroller and kills the effect). `invisibleOverlayScroller()` instead keeps the overlay scroller
/// (which reserves no gutter) and just makes it invisible: effect intact, no visible bar.
///
/// Screen-specific modifiers — scroll position, edge-effect style, `onAppear`, reorder-frame
/// preferences — are applied by the caller on the returned view, since those differ per screen.
///
/// It also publishes its inner content's ideal height as a `ScrollContentHeightKey` preference so the
/// popover can auto-fit the window to its content (see `DashboardView`'s coordinated-morph resize). A
/// vertical `ScrollView` proposes `nil` height to its children, so the measured value is the content's
/// intrinsic height — invariant to the window/viewport height, which is what keeps the auto-fit from
/// feeding back on itself. The preference bubbles up past the `ScrollView` to the per-screen wrapper.
struct PopoverScrollView<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView(.vertical) {
            content
                .invisibleOverlayScroller()
                .background(
                    GeometryReader { proxy in
                        Color.clear.preference(key: ScrollContentHeightKey.self, value: proxy.size.height)
                    }
                )
        }
        .scrollBounceBehavior(.basedOnSize)
    }
}

/// The intrinsic height of a popover screen's scroll content, published by `PopoverScrollView` and
/// read per-screen in `DashboardView` to auto-fit the panel. One emitter per screen subtree, so the
/// reduce just carries the most recent non-zero measurement.
struct ScrollContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        let next = nextValue()
        if next > 0 { value = next }
    }
}
