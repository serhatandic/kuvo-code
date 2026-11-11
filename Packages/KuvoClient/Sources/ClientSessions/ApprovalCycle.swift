/// ⇧Tab in an empty composer goes to the next mode, as Claude Code's Shift+Tab goes through its
/// permission modes: in the Mode menu's order (`order`), back to the first after the last. As
/// Claude Code leaves Bypass Permissions out until it's allowed, a mode that can't be picked now
/// is passed over: one its box says isn't to be had here, and Full Access until it's confirmed
/// on the conversation's computer, which only the menu asks.
public enum ApprovalCycle {
    /// The modes by the names their box keeps them under (`metadata.kuvo.approval`), in the
    /// Mode menu's order on the Mac and the phone.
    public static let order = ["askFirst", "acceptEdits", "auto", "fullAccess"]

    /// The mode after `current` that `canPick` allows, going round; nil when there's no other.
    /// One this list doesn't know is Auto, as `ApprovalWords` names it.
    public static func next(after current: String, canPick: (String) -> Bool) -> String? {
        let start = order.firstIndex(of: current) ?? order.firstIndex(of: "auto")!
        return (1..<order.count)
            .map { order[(start + $0) % order.count] }
            .first(where: canPick)
    }
}
