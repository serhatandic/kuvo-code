import Foundation

/// Changes for a project on a computer that can't be reached, as both apps show it: the list as
/// last seen under the away bar, with what needs the computer greyed out, or, never read, the
/// computer's connection in the list's place. Neither asks its box (`kuvo/git/changes`) meanwhile.
public enum ChangesAway {
    public enum Shown: Equatable, Sendable {
        /// Connected: the list as it is.
        case list
        /// Away, read before: that list, dimmed under the away bar.
        case asLastSeen
        /// Away, never read: the connection's state in the list's place.
        case waiting
    }

    /// `isAway`: the computer isn't connected (or its box didn't answer); `read`: when the list
    /// was last read, nil if never.
    public static func shown(isAway: Bool, read: Date?) -> Shown {
        guard isAway else { return .list }
        return read == nil ? .waiting : .asLastSeen
    }

    /// Under the away bar: as of when, and what can't happen until it's back.
    public static func asLastSeen(_ read: Date?, now: Date = .now, locale: Locale = .current) -> String {
        let ago = RelativeDateTimeFormatter()
        ago.dateTimeStyle = .named
        ago.locale = locale
        let when = read.map { now.timeIntervalSince($0) < 60 ? ", a moment ago" : ", " + ago.localizedString(for: $0, relativeTo: now) } ?? ""
        return "These are its changes as last seen\(when). They can’t be staged or committed until it’s back."
    }

    /// Why an action is greyed out: "Stage once build-box is back".
    public static func waits(_ action: String, for name: String) -> String {
        "\(action) once \(name) is back"
    }

    /// Under a greyed-out menu item: "Once build-box is back".
    public static func waits(for name: String) -> String {
        "Once \(name) is back"
    }

    /// An action that needs the computer, tried while it's away (a form or an alert opened before
    /// it went): what it says rather than its connection's error.
    public static func notBack(_ name: String) -> String {
        "\(name) isn’t connected. Try again once it’s back."
    }
}
