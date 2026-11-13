import Foundation

/// The update gate (PROTOCOL.md, "The update gate", #679): what a box must have before this client
/// uses it, and what both apps say while it doesn't. A client never keeps an older box's way of
/// doing something: it brings the box up to date first ("Updating…"), and until then sends it
/// nothing but what tells or brings about its update.
///
/// A box is checked by name, never by version (PROTOCOL.md, "Features"): one whose `kuvo/info`
/// `features` lack any of `required` is older than this client needs.
public enum BoxGate {
    /// What this client uses with no way around it on a box that hasn't it. A name goes in here
    /// when the client drops its fallback for a box without it. `sessions.list` (#668) came last:
    /// a box that has it has what came before it too (plan limits' `rows`, `kuvo/updates`,
    /// Cursor's limits, `kuvo/sessions/read`).
    public static let required: [String] = [
        "agent-tools.own",
        "folders.tree",
        "git.branches",
        "git.merge",
        "git.pull-request",
        "git.status",
        "models.offered",
        "sessions.list",
        "sessions.models",
        "sessions.start.empty",
    ]

    /// What `features` lack of `required`, in its order: none when the box is up to date. Nil
    /// features (a box from before `kuvo/info` said any, or none at all) lack them all.
    public static func missing(_ features: some Sequence<String>) -> [String] {
        let has = Set(features)
        return required.filter { !has.contains($0) }
    }

    /// Whether a box with `features` is as new as this client needs.
    public static func isCurrent(_ features: some Sequence<String>) -> Bool { missing(features).isEmpty }

    /// The routes a held box is still asked: what it is (`kuvo/info`) and its own update
    /// (`kuvo/update`, `kuvo/box/update`). Every other request to it waits for the update.
    public static func isAllowed(_ path: String) -> Bool {
        let route = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        return ["kuvo/info", "kuvo/update", "kuvo/box/update"].contains(route)
    }

    /// What both apps say of a box that's older than they need.
    public enum Words {
        /// The state's title, wherever it shows.
        public static let updating = "Updating…"
        /// This Mac's own box, run by an older app's keeper until the work under way ends.
        public static let thisMacFinishing = "Kuvo Code on this Mac finishes updating once the work running now ends."

        /// This Mac's box, attached in place, taking the release the app offered it.
        public static let thisMacTaking = "Kuvo Code on this Mac updates at the first moment nothing runs there."

        /// What a phone says of a computer older than it: who brings it up to date. `isMac`: a
        /// Mac's box, which updates with Kuvo Code there; a machine updates when a Mac connects
        /// to it, or by itself overnight.
        public static func waiting(for name: String, isMac: Bool) -> String {
            isMac
                ? "Update Kuvo Code on \(name) to use it from this phone. Nothing changes there meanwhile."
                : "\(name) updates when a Mac with Kuvo Code connects to it, or by itself overnight. Nothing changes there meanwhile."
        }

        /// Why a Mac couldn't bring `name` up to date, and what to do. `why`: what went wrong, in a
        /// sentence (nil: it was set up by a Kuvo Code this one can't update over).
        public static func couldntUpdate(_ name: String, why: String?) -> String {
            let reason = why.map { " \($0.hasSuffix(".") ? $0 : $0 + ".")" } ?? ""
            return "Kuvo Code on \(name) couldn’t be updated.\(reason) Try again, or update it with the Kuvo Code that set it up."
        }
    }
}
