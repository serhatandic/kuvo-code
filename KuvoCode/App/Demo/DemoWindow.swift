#if DEBUG
import Foundation

/// What the demo director may read and do in the window, as its own controls do: the window
/// hands it these, so the director never reaches into the view.
struct DemoWindow {
    /// The open tabs' keys, in order, and the one in view.
    var tabs: () -> [String]
    var selection: () -> String?
    /// The session of the tab in view, if it's a session's.
    var sessionInView: () -> String?
    /// The folder of the tab in view, and of the session you work in (the one beside, once you've
    /// clicked into it).
    var activeDirectory: () -> String?
    var focusedDirectory: () -> String?

    var openTab: (String) -> Void
    /// Every tab gone, none to reopen: the welcome card.
    var clearTabs: () -> Void
    var cycleTabs: (Int) -> Void
    /// A new session in this folder, or the project in view, as ⌘N starts one.
    var newSession: (String?) -> Void

    var showsPanel: () -> Bool
    var showPanel: (Bool) -> Void
    var panelExpanded: () -> Bool
    var expandPanel: (Bool) -> Void
    var showsSidebar: () -> Bool
    var showSidebar: (Bool) -> Void

    var showPalette: () -> Void
    /// The session in view, renamed in its card's header.
    var renameInView: () -> Void
    /// Runs the project's run command, as ⌘R does.
    var runProject: () -> Void
    /// New Project, with these folders.
    var newProject: ([String]) -> Void
    var openBotEditor: (Bot?, BotRecipe?) -> Void
    var openGroupEditor: (BotGroup?) -> Void
}
#endif
