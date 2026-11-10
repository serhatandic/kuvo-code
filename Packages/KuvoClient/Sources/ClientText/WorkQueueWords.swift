import Foundation

/// A Work Queue tool's call as both apps say it in the transcript: the item by its number
/// ("#243"), a new one by its title, a hand-off by the session's name.
public enum WorkQueueWords {
    /// `item`: the call's item as given (243, "#243", or a new one's id); `to`: who it's handed to,
    /// by name where the app knows it.
    public static func summary(_ tool: String, item: String?, title: String?, to: String?, category: String?, undo: Bool, add: String?, isActive: Bool) -> String {
        let named = item.map { $0.hasPrefix("#") || Int($0) == nil ? $0 : "#" + $0 } ?? "an item"
        let titled = title.map { "“\($0)”" } ?? "an item"
        switch tool {
        case "queue_list": return isActive ? "Reading the Work Queue" : "Read the Work Queue"
        case "queue_show": return (isActive ? "Reading " : "Read ") + named
        case "queue_add": return (isActive ? "Adding " : "Added ") + titled + " to the Work Queue"
        case "queue_update" where category == "done": return (isActive ? "Marking " : "Marked ") + named + " done"
        case "queue_update": return (isActive ? "Updating " : "Updated ") + named
        case "queue_hand": return (isActive ? "Handing " : "Handed ") + named + (to.map { " to \($0)" } ?? " on")
        case "queue_remove" where undo: return (isActive ? "Bringing back " : "Brought back ") + named
        case "queue_remove": return (isActive ? "Deleting " : "Deleted ") + named
        case "queue_categories":
            return add.map { (isActive ? "Adding the category " : "Added the category ") + "“\($0)”" } ?? (isActive ? "Reading the categories" : "Read the categories")
        case "queue_import": return isActive ? "Importing a backlog into the Work Queue" : "Imported a backlog into the Work Queue"
        default: return isActive ? "Using the Work Queue" : "Used the Work Queue"
        }
    }

    /// The symbol beside its step.
    public static let symbol = "checklist"
}
