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
    /// when the client drops its fallback for a box without it, or would say it needs a newer
    /// Kuvo Code. `messages.send` (#668 item 3: a message sent as fields, the box writing what the
    /// agent reads) came before the last: a box that has it has what came before it too
    /// (`sessions.list`, `typed`, plan limits' `rows`, `kuvo/updates`, Cursor's limits,
    /// `kuvo/sessions/read`). `sessions.asks`, `queue.items` and `sessions.mentions` came last, for
    /// the desktop client (gpui), which draws asks, the queue and "@" and "&" as the box says them;
    /// then `git.files`, `git.changes.path` and `git.branches.worktree`, for its side panel's
    /// Changes and Branches.
    public static let required: [String] = [
        "agent-tools.own",
        "folders.tree",
        "git.branches",
        "git.branches.worktree",
        "git.changes.path",
        "git.files",
        "git.merge",
        "git.pull-request",
        "git.status",
        "messages.send",
        "models.offered",
        "models.offered.folder",
        "models.offered.sides",
        "models.readiness",
        "queue.items",
        "sessions.asks",
        "sessions.list",
        "sessions.mentions",
        "sessions.models",
        "sessions.start.empty",
        "typed",
        "usage.notices",
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
    /// (`kuvo/update`, `kuvo/box/update`); its Mac's app registering with it (`kuvo/box/app`: where
    /// its agents' browser calls and a phone's asks of the Mac's own go, never held), and the keys
    /// it holds for that app (`kuvo/box/proof`, the vault's proof for one of your machines, and
    /// `kuvo/box/kept-keys`, bots' keys an earlier Kuvo Code kept): what the app does with its own
    /// box's keys, which an update doesn't change; and what keeps work already under way there
    /// going: its engine (`api/…`) and coding agents' bridge (`kuvo/agents/…`), its running agents'
    /// own tool calls (`kuvo/agent-tools`), and what answers a session waiting on you (its asks:
    /// `kuvo/asks`, `kuvo/sandbox/asks`, `kuvo/vault/asks`, `kuvo/work/asks`, and Auto's
    /// decisions). A route it hasn't says so in its own words. Every other request to it waits for
    /// the update.
    public static func isAllowed(_ path: String) -> Bool {
        let route = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        if ["kuvo/info", "kuvo/update", "kuvo/box/update", "kuvo/box/app", "kuvo/box/proof", "kuvo/box/kept-keys", "kuvo/agent-tools"].contains(route) { return true }
        if route.hasPrefix("api/") || route.hasPrefix("kuvo/agents/") { return true }
        for asks in ["kuvo/asks", "kuvo/sandbox/asks", "kuvo/vault/asks", "kuvo/work/asks"] where route == asks || route.hasPrefix(asks + "/") { return true }
        let parts = route.split(separator: "/")
        // A conversation's decisions, and its asks (`…/asks`, `…/asks/events`, `…/asks/<ask>`).
        let session = parts.count >= 4 && parts[0] == "kuvo" && parts[1] == "sessions"
        return (session && parts.count == 4 && parts[3] == "decisions") || (session && parts[3] == "asks" && parts.count <= 5)
    }

    /// What both apps say of a box that's older than they need.
    public enum Words {
        /// The state's title, wherever it shows.
        public static let updating = "Updating…"
        /// This Mac's own box, run by an older app's keeper until the work under way ends.
        public static let thisMacFinishing = "Kuvo Code on this Mac finishes updating once the work running now ends."

        /// This Mac's box, attached in place, taking the release the app offered it.
        public static let thisMacTaking = "Kuvo Code on this Mac updates at the first moment nothing runs there. A session waiting on you holds it until you answer."

        /// A phone's title for a computer older than it, which it can't update itself: it waits.
        public static let waitingTitle = "Waiting for an Update"
        /// The same, in a row: "Waiting for update".
        public static let waitingShort = "Waiting for update"

        /// What a phone says of a computer older than it: who brings it up to date. `isMac`: a
        /// Mac's box, which updates with Kuvo Code there; a machine updates when a Mac connects to
        /// it, and by itself overnight only where it can (`updatesItself`: its `kuvo/info` lists
        /// `update`; a 0.7 machine's doesn't).
        public static func waiting(for name: String, isMac: Bool, updatesItself: Bool) -> String {
            if isMac { return "Kuvo Code on \(name) is older than this iPhone’s. Update it there, or let it finish an update under way. Nothing changes there meanwhile." }
            let itself = updatesItself ? ", or by itself overnight" : ""
            return "Kuvo Code on \(name) is older than this iPhone’s. It updates when a Mac with Kuvo Code connects to it\(itself). Nothing changes there meanwhile."
        }

        /// Why a Mac couldn't bring `name` up to date, and what to do. `why`: what went wrong, in a
        /// sentence; `setUpElsewhere`: another Kuvo Code may update it (one this Mac set up itself
        /// only gets Try Again).
        public static func couldntUpdate(_ name: String, why: String?, setUpElsewhere: Bool = true) -> String {
            let reason = why.map { " \($0.hasSuffix(".") ? $0 : $0 + ".")" } ?? ""
            return "Kuvo Code on \(name) couldn’t be updated.\(reason) " + (setUpElsewhere ? "Try again, or update it with the Kuvo Code that set it up." : "Try again.")
        }
    }
}
