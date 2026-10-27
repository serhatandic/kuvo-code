import SwiftUI

extension View {
    /// What a popover shows. Its rows sit on the popover itself, divided by hairlines, as in the
    /// system's own: a group of rows (`WellGroup`) draws no card of its own there.
    func popoverContent() -> some View {
        environment(\.isInPopover, true)
    }
}

extension EnvironmentValues {
    /// In a popover (`popoverContent`).
    @Entry var isInPopover = false
}
