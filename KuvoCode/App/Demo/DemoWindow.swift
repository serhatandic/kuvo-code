#if DEBUG
import Foundation

/// What the demo director may read and do in the window that isn't the window's tabs (those are
/// `AppModel.tabs`), as the window's own controls do it: the window hands it these, so the director
/// never reaches into the view.
struct DemoWindow {
    var showsSidebar: () -> Bool
    var showSidebar: (Bool) -> Void
    var showPalette: () -> Void
    /// The session in view, renamed in its card's header.
    var renameInView: () -> Void
    /// Runs the project's run command, as ⌘R does.
    var runProject: () -> Void
    /// New Project, with these folders.
    var newProject: ([String]) -> Void
}
#endif
