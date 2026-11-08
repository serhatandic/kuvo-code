import Foundation

/// Wake-ups for bots and sessions. A conversation's agent schedules one with the `kuvo-wake`
/// command: a file in its folder's `wakes`, named by the time it's due, holding a note. When it's
/// due, the note goes to the conversation's session as a message. On a machine the engine's
/// watchdog sends it (`kuvo-wake fire`), so it arrives while the Mac is off; on the Mac, the app
/// does.
///
/// A bot's folder holds `session` (its session's ID), `MEMORY.md`, `wakes` and, for a bot with no
/// project, `workspace`. A session's is `wakes/<its ID>` beside the bots' folder (`KUVO_WAKES`),
/// made by its first wake-up or watch, with `session` and `directory` (the folder it works in),
/// and for a coding agent's session, `via` ("bridge"): on a machine, `fire` sends its wake-ups to
/// the agents' bridge (`run/bridge.json`, as `run/engine.json`) rather than the engine.
public enum Wakes {
    /// A wake-up's message starts with this, so the app can show it as one, and the bot knows it.
    public static let marker = "[Wake-up] "
    /// A bot may have this many waiting at once, so a loop can't pile them up.
    public static let limit = 50

    /// One waiting wake-up, from its file.
    public struct Pending: Sendable, Hashable, Identifiable {
        /// The file's name: the time it's due, in seconds, a dash and a few random letters, and for
        /// one that repeats, a dash and its repeat; for days, weeks and weekdays, then "@" and the
        /// time of day it keeps (1d@0900), for weeks with its day (1w@Mon0900).
        public let id: String
        public let due: Date
        public let note: String
        /// How often it comes back, if it does.
        public let every: Repeat?
        /// The time of day it keeps, in minutes, for one that repeats by days; nil for one made
        /// before it kept it.
        public let at: Int?
        /// The day of the week a weekly one keeps, as `Calendar` counts them (1 is Sunday); nil
        /// for one made before it kept it.
        public let weekday: Int?

        public init?(id: String, note: String) {
            let parts = id.split(separator: "-", maxSplits: 2)
            guard let seconds = parts.first.flatMap({ TimeInterval($0) }) else { return nil }
            self.id = id
            due = Date(timeIntervalSince1970: seconds)
            self.note = note
            let repeating = parts.count > 2 ? parts[2].split(separator: "@", maxSplits: 1).map(String.init) : []
            every = repeating.first.flatMap(Repeat.init)
            let kept = repeating.count > 1 ? Wakes.kept(repeating[1]) : nil
            at = kept?.minutes
            weekday = kept?.weekday
        }

        /// The letters that name it for good: a repeating one keeps them when it comes back.
        public var letters: String { String(id.split(separator: "-").dropFirst().first ?? "") }

        /// The file's name for its next time, after it went at `now`, with the same letters, time
        /// of day and day of the week (one made before it kept those, the ones it was due at); nil
        /// if it doesn't repeat.
        public func nextID(after now: Date = .now, calendar: Calendar = .current) -> String? {
            guard let every else { return nil }
            let at = every.keepsTimeOfDay ? at ?? Wakes.minutes(of: due, calendar: calendar) : nil
            let weekday = every.keepsWeekday ? weekday ?? calendar.component(.weekday, from: due) : nil
            let next = every.next(after: due, now: now, at: at, weekday: weekday, calendar: calendar)
            return "\(Int(next.timeIntervalSince1970))-\(letters)-" + Wakes.text(of: every, at: at, weekday: weekday)
        }
    }

    /// How often a wake-up comes back: every so many minutes, hours, days or weeks, or on weekdays.
    public enum Repeat: Sendable, Hashable {
        case minutes(Int), hours(Int), days(Int), weeks(Int)
        case weekdays

        /// 30m, 2h, 1d, 1w or weekdays, as `kuvo-wake` takes it: at most a year, and no leading
        /// zero (the script's shell reads 08 as a bad octal number).
        public init?(_ text: String) {
            if text == "weekdays" { self = .weekdays; return }
            guard let unit = text.last, text.first?.isNumber == true, text.first != "0", text.count <= 7, let count = Int(text.dropLast()), count > 0 else { return nil }
            switch unit {
            case "m" where (5...525_600).contains(count): self = .minutes(count)
            case "h" where count <= 8_760: self = .hours(count)
            case "d" where count <= 366: self = .days(count)
            case "w" where count <= 52: self = .weeks(count)
            default: return nil
            }
        }

        public var text: String {
            switch self {
            case .minutes(let n): "\(n)m"
            case .hours(let n): "\(n)h"
            case .days(let n): "\(n)d"
            case .weeks(let n): "\(n)w"
            case .weekdays: "weekdays"
            }
        }

        /// Whether it comes back at a time of day (days, weeks and weekdays) rather than after so long.
        public var keepsTimeOfDay: Bool {
            switch self {
            case .minutes, .hours: false
            case .days, .weeks, .weekdays: true
            }
        }

        /// Whether it comes back on a day of the week too (weeks).
        public var keepsWeekday: Bool {
            if case .weeks = self { true } else { false }
        }

        /// The first time after `now` it comes back, from when it was due. Days, weeks and
        /// weekdays come back at `at` (minutes into the day; nil for the time of day it was due),
        /// and weeks on `weekday` (1 is Sunday; nil for the day it was due), on `calendar`'s
        /// clock, whatever daylight saving or a new time zone did to the last time: on the night
        /// clocks go forward, a time in the hour skipped is that much later that day only.
        /// Weekdays skip weekends.
        public func next(after due: Date, now: Date, at minutes: Int? = nil, weekday: Int? = nil, calendar: Calendar = .current) -> Date {
            switch self {
            case .minutes(let n), .hours(let n):
                let period = TimeInterval(n) * (self == .hours(n) ? 3600 : 60)
                return due.addingTimeInterval(((now.timeIntervalSince(due) / period).rounded(.down) + 1) * period)
            case .days, .weeks, .weekdays:
                let days = switch self { case .days(let n): n; case .weeks(let n): n * 7; default: 1 }
                let minutes = minutes ?? Wakes.minutes(of: due, calendar: calendar)
                var first = calendar.startOfDay(for: due)
                // The day it keeps nearest to the one it was due (a new time zone can put that
                // the day before or after).
                if keepsWeekday, let weekday {
                    let shift = (weekday - calendar.component(.weekday, from: first) + 7) % 7
                    first = calendar.date(byAdding: .day, value: shift > 3 ? shift - 7 : shift, to: first) ?? first
                }
                // Whole periods missed first, but not one still to come today; then one at a time.
                let missed = calendar.dateComponents([.day], from: first, to: calendar.startOfDay(for: now)).day ?? 0
                var periods = max(1, missed / days)
                for _ in 0..<400 {
                    defer { periods += 1 }
                    guard let day = calendar.date(byAdding: .day, value: periods * days, to: first) else { continue }
                    var time = calendar.dateComponents([.year, .month, .day], from: day)
                    time.hour = minutes / 60
                    time.minute = minutes % 60
                    if let next = calendar.date(from: time), next > now, self != .weekdays || !Wakes.isWeekend(next, calendar: calendar) { return next }
                }
                return now.addingTimeInterval(Double(days) * 86_400)
            }
        }
    }

    /// Saturday or Sunday, whatever the locale calls the weekend: weekdays are Monday to Friday,
    /// as `kuvo-wake` has them on a machine.
    public static func isWeekend(_ date: Date, calendar: Calendar = .current) -> Bool {
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar.timeZone
        let weekday = gregorian.component(.weekday, from: date)
        return weekday == 1 || weekday == 7
    }

    /// A wake-up's file name: its time, a few random letters, and its repeat if it has one, with
    /// the time of day and day of the week it keeps (from `due`, on `calendar`'s clock).
    public static func name(due: Date, every: Repeat?, calendar: Calendar = .current) -> String {
        let letters = String((0..<6).map { _ in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".randomElement()! })
        let repeating = every.map {
            "-" + text(of: $0, at: $0.keepsTimeOfDay ? minutes(of: due, calendar: calendar) : nil, weekday: $0.keepsWeekday ? calendar.component(.weekday, from: due) : nil)
        } ?? ""
        return "\(Int(due.timeIntervalSince1970))-\(letters)" + repeating
    }

    /// A repeat as a wake-up's name has it: 1d@0900 for every day at 9:00, 1w@Mon0900 for every
    /// Monday at 9:00.
    static func text(of every: Repeat, at minutes: Int?, weekday: Int? = nil) -> String {
        let day = weekday.flatMap { dayNames.indices.contains($0 - 1) ? dayNames[$0 - 1] : nil } ?? ""
        return every.text + (minutes.map { "@" + day + String(format: "%02d%02d", $0 / 60, $0 % 60) } ?? "")
    }

    /// The days of the week as names keep them, from Sunday, whatever the language.
    static let dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    /// The time of day, and the day of the week, a repeat's name keeps: from 0900 or Mon0900.
    static func kept(_ text: String) -> (minutes: Int, weekday: Int?)? {
        guard text.count == 7, let day = dayNames.firstIndex(of: String(text.prefix(3))) else { return minutes(text).map { ($0, nil) } }
        return minutes(String(text.dropFirst(3))).map { ($0, day + 1) }
    }

    /// Minutes into the day, from 0900.
    static func minutes(_ text: String) -> Int? {
        guard text.count == 4, text.allSatisfy({ $0.isASCII && $0.isNumber }), let hhmm = Int(text), hhmm / 100 < 24, hhmm % 100 < 60 else { return nil }
        return hhmm / 100 * 60 + hhmm % 100
    }

    /// Minutes into the day of a time, on `calendar`'s clock.
    public static func minutes(of date: Date, calendar: Calendar = .current) -> Int {
        let time = calendar.dateComponents([.hour, .minute], from: date)
        return (time.hour ?? 0) * 60 + (time.minute ?? 0)
    }

    /// A watch: every so often its check (a shell command) runs, without the model, and when what
    /// it prints changes, the bot wakes up with the new output. Kept in the bot's `watches`, a
    /// folder for each, named by its letters.
    public struct Watch: Sendable, Hashable, Identifiable {
        public let letters: String
        /// 30m, 2h, 1d.
        public let every: String
        public let check: String
        public let note: String
        public var id: String { letters }

        public init(letters: String, every: String, check: String, note: String) {
            self.letters = letters
            self.every = every
            self.check = check
            self.note = note
        }
    }

    /// The watches `kuvo-wake <bot> check` found changed, by their letters, from what it prints.
    public static func changedWatches(in output: String) -> [String] {
        output.split(separator: "\n").compactMap { line in
            line.hasPrefix("KUVO-WATCH ") ? String(line.dropFirst("KUVO-WATCH ".count)) : nil
        }
    }

    /// What `kuvo-wake <bot> try <letters>` printed: what the check printed, and why a run like
    /// it wouldn't count (nil when it would). Nil for anything else, like a kuvo-wake without `try`.
    public static func tried(_ output: String) -> (output: String, skipped: String?)? {
        guard output.hasPrefix("KUVO-TRY ") else { return nil }
        let line = output.prefix { $0 != "\n" }
        let why = line.dropFirst("KUVO-TRY ".count).trimmingCharacters(in: .whitespaces)
        return (String(output.dropFirst(line.count + 1)), why.isEmpty ? nil : why)
    }

    /// A changed watch's wake-up, from its folder in the bot's (on this Mac).
    public static func watchMessage(_ letters: String, inBot folder: String) -> String? {
        try? String(contentsOfFile: watchFolder(letters, inBot: folder) + "/message", encoding: .utf8)
    }

    /// The watch's wake-up went: its output is what the bot heard, as kuvo-wake's `delivered` does.
    public static func watchDelivered(_ letters: String, inBot folder: String) {
        let watch = watchFolder(letters, inBot: folder)
        let manager = FileManager.default
        if manager.fileExists(atPath: watch + "/pending") {
            try? manager.removeItem(atPath: watch + "/last")
            try? manager.moveItem(atPath: watch + "/pending", toPath: watch + "/last")
        }
        try? manager.removeItem(atPath: watch + "/message")
    }

    private static func watchFolder(_ letters: String, inBot folder: String) -> String {
        ((folder as NSString).appendingPathComponent("watches") as NSString).appendingPathComponent(letters)
    }

    /// A `kuvo-wake` command a bot ran, read back: what it did, and for `add`, when, how often and
    /// the note; for `watch`, how often (as `when`) and the note.
    public struct Command: Sendable, Equatable {
        public enum Verb: String, Sendable { case add, list, cancel, watch }
        public let verb: Verb
        /// As written: +2h, 2026-10-16T09:00, …
        public let when: String?
        public let note: String?
        public var every: Repeat? = nil

        public init(verb: Verb, when: String?, note: String?, every: Repeat? = nil) {
            self.verb = verb
            self.when = when
            self.note = note
            self.every = every
        }
    }

    /// The command, if `line` runs `kuvo-wake` (by name, or by its full path), for a bot or a
    /// session named before its verb, or for the conversation running it.
    public static func command(in line: String) -> Command? {
        let pattern = #/kuvo-wake"?\s+(?:(?:"[^"]*"|'[^']*'|\S+)\s+)??(add|list|cancel|watch)\b\s*(.*)$/#
        guard let match = line.firstMatch(of: pattern), let verb = Command.Verb(rawValue: String(match.1)) else { return nil }
        if verb == .watch {
            // watch <every> <check> <note>: the check is quoted, or one word.
            let rest = match.2.trimmingCharacters(in: .whitespaces)
            let every = rest.prefix { !$0.isWhitespace }
            var after = rest.dropFirst(every.count).drop { $0.isWhitespace }
            if let quote = after.first, quote == "\"" || quote == "'", let end = after.dropFirst().firstIndex(of: quote) {
                after = after[after.index(after: end)...]
            } else {
                after = after.drop { !$0.isWhitespace }
            }
            var note = after.trimmingCharacters(in: .whitespaces)
            if let first = note.first, first == "\"" || first == "'", note.last == first, note.count >= 2 { note = String(note.dropFirst().dropLast()) }
            return Command(verb: .watch, when: every.isEmpty ? nil : String(every), note: note.isEmpty ? nil : note)
        }
        guard verb == .add else { return Command(verb: verb, when: nil, note: nil) }
        let rest = match.2.trimmingCharacters(in: .whitespaces)
        let when = rest.prefix { !$0.isWhitespace }
        var note = rest.dropFirst(when.count).trimmingCharacters(in: .whitespaces)
        var every: Repeat?
        // Its options, in either order: how often, and a summary (one word, or quoted), not the note's.
        while true {
            if note.hasPrefix("--every ") {
                let repeating = note.dropFirst("--every ".count).trimmingCharacters(in: .whitespaces)
                let text = repeating.prefix { !$0.isWhitespace }
                every = Repeat(String(text))
                note = repeating.dropFirst(text.count).trimmingCharacters(in: .whitespaces)
            } else if note.hasPrefix("--summary ") {
                let after = note.dropFirst("--summary ".count).drop { $0.isWhitespace }
                if let quote = after.first, quote == "\"" || quote == "'", let end = after.dropFirst().firstIndex(of: quote) {
                    note = after[after.index(after: end)...].trimmingCharacters(in: .whitespaces)
                } else {
                    note = after.drop { !$0.isWhitespace }.trimmingCharacters(in: .whitespaces)
                }
            } else {
                break
            }
        }
        if let first = note.first, first == "\"" || first == "'", note.last == first, note.count >= 2 { note = String(note.dropFirst().dropLast()) }
        return Command(verb: verb, when: when.isEmpty ? nil : String(when), note: note.isEmpty ? nil : note, every: every)
    }

    /// Puts `kuvo-wake` in `$K/bin` on a machine, and the bots' folder beside it (needs `$K`).
    static var installScript: String {
        """
        mkdir -p "$K/bin" "$K/bots"
        cat >"$K/bin/kuvo-wake.new" <<'KUVO_WAKE'
        \(script)
        KUVO_WAKE
        chmod 755 "$K/bin/kuvo-wake.new" && mv -f "$K/bin/kuvo-wake.new" "$K/bin/kuvo-wake"
        """
    }

    #if os(macOS)
    /// Puts `kuvo-wake` on the machine, for an engine started before it was there.
    public static func install(on connection: SSHConnection) async throws {
        try await connection.run(BoxVersion.guardScript + "\n" + RemoteEngineInstaller.folders + "\n" + installScript)
    }
    #endif

    /// The command, in POSIX sh, for macOS and Linux. A bot is named by its ID, its folder being
    /// in `$KUVO_BOTS` (`~/.kuvo-code/bots` by default); a session by its ID (ses_…), its folder
    /// being in `$KUVO_WAKES` (`~/.kuvo-code/wakes`); either by its folder's path. Left out, it's
    /// the conversation running the command, which the engine names in `OPENCODE_SESSION_ID`:
    /// its bot's, if it's a bot's conversation, or its session's.
    ///
    ///     kuvo-wake [<bot or session>] add <when> [--every <repeat>] [--summary <line>] <note>
    ///                          when: +30m, +2h, +1d, or 2026-10-16T09:00
    ///                          repeat: 30m, 2h, 1d, 1w (at least 5m) or weekdays, until canceled
    ///                          summary: what its card shows (`summaries/<letters>`), sent with it
    ///                          as `metadata.kuvo.wake.summary`; the agent reads the note whole
    ///     kuvo-wake [<bot or session>] watch <every> <check> [--summary <line>] <note>
    ///     kuvo-wake [<bot or session>] list
    ///     kuvo-wake [<bot or session>] cancel <id>
    ///     kuvo-wake fire <bots folder> <engine.json>   sends what's due, for the bots there and the
    ///                                                  sessions in the wakes folder beside it
    ///                                                  (the watchdog, on a machine)
    public static let script = #"""
    #!/bin/sh
    # Kuvo Code's wake-ups for bots and sessions. See `kuvo-wake help`.
    now=$(date +%s)

    # What it runs (watches' checks) gets the computer's own folders back, as the agent's commands
    # do: on a machine, the engine's watchdog runs it with them pointed into ~/.kuvo-code, each one's
    # own value kept as KUVO_OWN_<name>, empty when it had none (see CommandEnvironment).
    for o_name in $(env | sed -n 's/^KUVO_OWN_\([A-Za-z0-9_]*\)=.*/\1/p'); do
      o_value=$(printenv "KUVO_OWN_$o_name"); unset "KUVO_OWN_$o_name"
      if [ -n "$o_value" ]; then export "$o_name=$o_value"; else unset "$o_name"; fi
    done
    # Nor the engine's password or settings, which a check printing its environment would show
    # (`fire` reads the password from the engine's record, and never puts it on a command line).
    unset OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG

    usage() {
      echo "Usage:"
      echo "  kuvo-wake add <when> [--every <repeat>] [--summary <line>] <note>"
      echo "      when: +30m, +2h, +1d, or a time like 2026-10-16T09:00 on this computer's clock"
      echo "      repeat: 30m, 2h, 1d, 1w (at least 5m), or weekdays; it keeps coming back until canceled"
      echo "      summary: one short line the user sees for it in the conversation; you get the whole note"
      echo "  kuvo-wake list"
      echo "  kuvo-wake watch <every> <check> [--summary <line>] <note>"
      echo "      every 5m or more, 2h, 1d: runs the check, a shell command, and wakes you when what it prints changes"
      echo "  kuvo-wake cancel <id>"
      echo "Each is for the conversation that runs it; before the verb, a bot's ID or a session's (ses_...) names another."
      echo "Times are on this computer's clock, or in the time zone in the folder's timezone file."
    }

    # A time as seconds since 1970, from +30m, +2h, +1d, an ISO date and time, or seconds.
    seconds() {
      case "$1" in
        +*[mhd])
          n=${1#+}; unit=${n#"${n%?}"}; n=${n%?}
          # No leading zero, which is octal here: 08 an error, 010 eight.
          case "$n" in ''|0*|*[!0-9]*|???????*) return 1;; esac
          case "$unit" in m) echo $((now + n * 60));; h) echo $((now + n * 3600));; d) echo $((now + n * 86400));; esac ;;
        *[!0-9]*)
          t=$(echo "$1" | sed 's/T/ /')
          # A time zone after it (Z, +03:00, -0500), as %z has it.
          t_z=
          case "$t" in
            *Z) t_z=+0000; t=${t%Z} ;;
            *:*[+-][0-9][0-9]:[0-9][0-9]) t_z=$(printf '%s' "${t#"${t%??????}"}" | tr -d :); t=${t%??????} ;;
            *:*[+-][0-9][0-9][0-9][0-9]) t_z=${t#"${t%?????}"}; t=${t%?????} ;;
          esac
          case "$t" in *:*:*) ;; *:*) t="$t:00" ;; esac
          date -d "$t${t_z:+ $t_z}" +%s 2>/dev/null && return 0
          # The BSD one reads only this, and says nothing of what's after it.
          case "$t" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\ [0-9][0-9]:[0-9][0-9]:[0-9][0-9]) ;; *) return 1 ;; esac
          date -j -f "%Y-%m-%d %H:%M:%S${t_z:+ %z}" "$t${t_z:+ $t_z}" +%s 2>/dev/null && return 0
          return 1 ;;
        '') return 1 ;;
        *) echo "$1" ;;
      esac
    }

    readable() { date -d "@$1" "+%a %b %-d, %H:%M" 2>/dev/null || date -r "$1" "+%a %b %-d, %H:%M"; }

    # A time (seconds) in a date format, with GNU's date or the BSD one.
    clock() { date -d "@$1" "+$2" 2>/dev/null || date -r "$1" "+$2"; }

    # How far this computer's clock is ahead of UTC at a time, in seconds.
    offset() {
      o_z=$(clock "$1" %z); case "$o_z" in [+-][0-9][0-9][0-9][0-9]) ;; *) echo 0; return ;; esac
      o_h=${o_z#?}; o_m=${o_h#??}; o_h=${o_h%??}
      o_s=$((${o_h#0} * 3600 + ${o_m#0} * 60))
      case "$o_z" in -*) echo $((-o_s)) ;; *) echo "$o_s" ;; esac
    }

    # The day of a time on this computer's clock, counted from January 1, 1970 (a Thursday).
    day() { echo $((($1 + $(offset "$1")) / 86400)); }

    # Whether a day is Monday to Friday.
    weekday() { [ $((($1 + 3) % 7)) -lt 5 ]; }

    # A day's name as a repeat keeps it (Mon), and the day of the week a name is (0 for Monday).
    dayname() { case $((($1 + 3) % 7)) in 0) echo Mon;; 1) echo Tue;; 2) echo Wed;; 3) echo Thu;; 4) echo Fri;; 5) echo Sat;; *) echo Sun;; esac; }
    daynumber() { case "$1" in Mon) echo 0;; Tue) echo 1;; Wed) echo 2;; Thu) echo 3;; Fri) echo 4;; Sat) echo 5;; Sun) echo 6;; *) return 1;; esac; }

    # The time on day $1 at $2 (0900, on this computer's clock). When clocks go back, the first of
    # the two; when they go forward, one in the hour skipped is that much later (2:30 is 3:30).
    daytime() {
      d_h=${2%??}; d_m=${2#??}
      d_l=$(($1 * 86400 + ${d_h#0} * 3600 + ${d_m#0} * 60))
      d_t=$((d_l - $(offset $((d_l - 86400)))))
      if [ $((d_t + $(offset "$d_t"))) -ne "$d_l" ]; then
        d_u=$((d_l - $(offset "$d_t")))
        [ $((d_u + $(offset "$d_u"))) -ne "$d_l" ] || d_t=$d_u
      fi
      echo "$d_t"
    }

    # Whether a repeat reads: 30m, 2h, 1d, 1w (at least 5m), or weekdays; days, weeks and weekdays
    # may say the time of day they keep (1d@0900), and weeks their day too (1w@Mon0900).
    repeats() {
      r_e=${1%@*}
      if [ "$r_e" != "$1" ]; then
        r_at=${1#*@}
        case "$r_e" in *[dw]|weekdays) ;; *) return 1 ;; esac
        case "$r_e" in *w) daynumber "${r_at%????}" >/dev/null && r_at=${r_at#???} ;; esac
        case "$r_at" in [01][0-9][0-5][0-9]|2[0-3][0-5][0-9]) ;; *) return 1 ;; esac
      fi
      case "$r_e" in
        weekdays) return 0 ;;
        # At most a year, and no leading zero (08 is a bad octal number here).
        *[mhdw]) r_n=${r_e%?}; case "$r_n" in ''|0*|*[!0-9]*|???????*) return 1;; esac
          case "$r_e" in
            *m) [ "$r_n" -ge 5 ] && [ "$r_n" -le 525600 ] ;;
            *h) [ "$r_n" -le 8760 ] ;;
            *d) [ "$r_n" -le 366 ] ;;
            *) [ "$r_n" -le 52 ] ;;
          esac ;;
        *) return 1 ;;
      esac
    }

    # A repeat as a wake-up's name has it, from its time ($1): days, weeks and weekdays with the
    # time of day they keep, and weeks with their day, whatever daylight saving or a new time zone
    # does to the last time (what it keeps already stays).
    kept() {
      k_e=${2%@*}; k_at=${2#*@}; [ "$k_e" != "$2" ] || k_at=$(clock "$1" %H%M)
      case "$k_e" in
        *w) case "$k_at" in [0-9]*) k_at=$(dayname "$(day "$1")")$k_at ;; esac; echo "$k_e@$k_at" ;;
        *d|weekdays) echo "$k_e@$k_at" ;;
        *) echo "$2" ;;
      esac
    }

    # A repeating wake-up's next time after now: $1 the time it was due, $2 its repeat as its name
    # has it (an older one without its time of day or day keeps the ones it was due at).
    next() {
      case "$2" in
        *m|*h)
          n_p=${2%?}; case "$2" in *h) n_p=$((n_p * 3600));; *) n_p=$((n_p * 60));; esac
          echo $(($1 + (($now - $1) / n_p + 1) * n_p)) ;;
        *)
          n_e=${2%@*}; n_at=${2#*@}; [ "$n_e" != "$2" ] || n_at=$(clock "$1" %H%M)
          if n_wd=$(daynumber "${n_at%????}"); then n_at=${n_at#???}; fi
          case "$n_e" in weekdays) n_days=1 n_wd=;; *w) n_days=$((${n_e%?} * 7));; *) n_days=${n_e%?} n_wd=;; esac
          n_day=$(day "$1")
          # The day it keeps nearest to the one it was due (a new time zone can put that the day
          # before or after).
          if [ -n "$n_wd" ]; then
            n_s=$(((n_wd - (n_day + 3) % 7 + 7) % 7)); [ "$n_s" -le 3 ] || n_s=$((n_s - 7))
            n_day=$((n_day + n_s))
          fi
          # Whole periods missed first, but not one still to come today; then one at a time.
          n_k=$((($(day "$now") - n_day) / n_days)); [ "$n_k" -ge 1 ] || n_k=1
          while :; do
            n_t=$(daytime $((n_day + n_k * n_days)) "$n_at")
            [ "$n_t" -gt "$now" ] && { [ "$n_e" != weekdays ] || weekday $((n_day + n_k)); } && break
            n_k=$((n_k + 1))
          done
          echo "$n_t" ;;
      esac
    }

    # What a wake-up's file is called: its time, a few random letters, and its repeat if it has one.
    name() { echo "$1-$(random 6)${2:+-$2}"; }

    # Seconds in a watch's interval: 5m or more, 2h, 1d.
    period() {
      p_n=${1%?}; case "$p_n" in ''|0*|*[!0-9]*|???????*) return 1;; esac
      case "$1" in *m) [ "$p_n" -ge 5 ] && echo $((p_n * 60));; *h) [ "$p_n" -ge 1 ] && echo $((p_n * 3600));; *d) [ "$p_n" -ge 1 ] && echo $((p_n * 86400));; *) return 1;; esac
    }

    # Runs a command for at most a minute, where the system lets one say so: sh -c with the
    # arguments given (or the sandbox's shell, $l_shell). Its status is the command's, as `timeout`
    # gives it: 124 when out of time, 128 and the signal when killed. One that ignores the minute's
    # TERM is killed 5 s later: left running, it held up every wake-up after it.
    limited() {
      l_shell=${l_shell:-sh}
      if command -v timeout >/dev/null 2>&1; then
        # An older busybox's timeout has no -k: the minute alone there.
        if timeout -k 1 1 true 2>/dev/null; then timeout -k 5 60 "$l_shell" -c "$@"; else timeout 60 "$l_shell" -c "$@"; fi
      elif command -v perl >/dev/null 2>&1; then
        # In a group of its own, so the minute's end stops the whole pipeline, not just sh.
        perl -e 'my $p = fork; if (!$p) { setpgrp; exec @ARGV; exit 127 } $SIG{ALRM} = sub { kill "TERM", -$p; sleep 1; kill "KILL", -$p; exit 124 }; alarm 60; waitpid $p, 0; exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$l_shell" -c "$@"
      else "$l_shell" -c "$@"; fi
    }

    # Goes before a watch's check: its curl, wget and gh say on descriptor 3 (which `run` opens,
    # outside any sandbox the check runs in) when they fail, but not for an error page (curl's 22,
    # wget's 8), checks still pending (gh's 8) or what reads them stopping early (curl's 23, wget's
    # 3, 141). A curl that writes out its own result (-w '%{http_code}' is 000 when it can't
    # connect) never does.
    noting='kuvo_ran() { case $1 in 0|141|$3|$4) ;; *) echo "$2 $1" >&3 ;; esac; return $1; }
    curl() { command curl "$@"; kuvo_s=$?; for kuvo_a; do case $kuvo_a in --write-out*|-w*|-[!-]*w*) return $kuvo_s ;; esac; done; kuvo_ran $kuvo_s curl 22 23; }
    wget() { command wget "$@"; kuvo_ran $? wget 3 8; }
    gh() { command gh "$@"; kuvo_ran $? gh 8 8; }
    '

    # Runs a watch's check once, as its runs do ($1, the watch's folder; $2, the bot's; $3, what
    # its files for the run start with): in the folder the bot works in, for at most a minute.
    # Sets t_out to what it prints (not its errors), and t_why to why the run is no reading, or
    # to nothing when it's one.
    #
    # A check's status alone can't tell an outage from "nothing there": in `curl -s … | grep -o …`
    # it's grep's, 1 both times, and in `curl … | jq …` it's 0. So curl, wget and gh say how they
    # did, and a run is no reading when:
    # - it ran out of time, couldn't run, or was killed (141 is only its output cut short);
    # - a curl or wget in it failed, as when the network is down (an error page is a reading);
    # - it printed nothing, and a gh in it failed, or it exited 2 or more.
    # Printing nothing and exiting 0 or 1, as grep finding nothing does, is a reading: what it
    # looks for isn't there.
    run() {
      t_out= t_why=
      # While the box runs agents' commands in its sandbox, a check (which an agent's command may
      # have written) runs in it too, as its conversation's commands do (`sandbox`), in the folder
      # its conversation works in, never a folder of its own instead. One the sandbox is wanted for
      # but can't take yet waits.
      [ -z "$unready" ] || { t_why="the sandbox isn't ready yet"; return; }
      t_dir=$(cat "$2/directory" 2>/dev/null)
      if [ ! -d "$t_dir" ]; then
        [ -z "$fenced" ] || { t_why="its conversation's folder isn't there"; return; }
        t_dir=$2
      fi
      t_tmp=$1$3; rm -f "${t_tmp}status" "${t_tmp}failed" "${t_tmp}out"
      # What it prints goes to a file, not a pipe: something it leaves running that holds the pipe
      # open would hold the watches' round up with it.
      (cd "$t_dir" && {
        if [ -n "$fenced" ]; then
          l_shell=$fenced KUVO_FENCE_WORK=$t_dir KUVO_FENCE_SHELL=/bin/sh OPENCODE_SESSION_ID=$(cat "$2/session" 2>/dev/null)
          export KUVO_FENCE_WORK KUVO_FENCE_SHELL OPENCODE_SESSION_ID
        fi
        limited "$noting$(cat "${1}check")" sh >"${t_tmp}out" 3>"${t_tmp}failed" 2>/dev/null </dev/null; echo "$?" >"${t_tmp}status"; })
      t_out=$(head -c 4000 "${t_tmp}out" 2>/dev/null)
      t_status=$(cat "${t_tmp}status" 2>/dev/null)
      t_failed=$(head -n 1 "${t_tmp}failed" 2>/dev/null); t_lost=$(grep -v '^gh ' "${t_tmp}failed" 2>/dev/null | head -n 1)
      rm -f "${t_tmp}status" "${t_tmp}failed" "${t_tmp}out"
      case "$t_status" in
        ''|*[!0-9]*) t_why="the check didn't finish" ;;
        124) t_why="the check ran out of time (a minute)" ;;
        12[5-8]) t_why="the check couldn't run (exit $t_status)" ;;
        *) if [ "$t_status" -gt 128 ] && [ "$t_status" -ne 141 ]; then t_why="the check was stopped (signal $((t_status - 128)))"
          elif [ -n "$t_lost" ]; then t_why="${t_lost% *} failed (exit ${t_lost##* })"
          elif [ -n "$t_out" ]; then :
          elif [ -n "$t_failed" ]; then t_why="${t_failed% *} failed (exit ${t_failed##* }), and the check printed nothing"
          elif [ "$t_status" -ge 2 ]; then t_why="the check failed (exit $t_status) without printing anything"
          fi ;;
      esac
    }

    # A bot's watches that are due ($1, its folder): each runs its check (see `run`) and compares
    # what it prints with `last`, what the bot last heard (at first, its first reading).
    #
    # A run that's no reading (a network that's down, or not back yet after sleep) is never a
    # change, nor what later runs are compared with. A change counts when two readings in a row
    # differ from `last`: the one that saw it (`seen` keeps when) and a second look two minutes
    # later, once a period, on the watch's own times. The two needn't match, so a value that keeps
    # moving (a price, a counter) wakes the bot once a period, with its latest output, while one
    # odd reading between two as before doesn't. The wake-up goes to `message`, its output's sum to
    # `pending`, and "KUVO-WATCH <letters>" is printed; once it's delivered, `delivered` makes it
    # what the bot heard, so a value that changes and stays wakes it once.
    checks() {
      for w in "$1"/watches/*/; do
        [ -f "${w}check" ] || continue
        c_next=$(cat "${w}next" 2>/dev/null); case "$c_next" in ''|*[!0-9]*) c_next=0;; esac
        [ "$c_next" -le "$now" ] || continue
        c_period=$(period "$(cat "${w}every" 2>/dev/null)") || continue
        c_seen=$(cat "${w}seen" 2>/dev/null); case "$c_seen" in ''|*[!0-9]*) c_seen=;; esac
        # A period on, from the run that saw a change when this is its second look.
        c_next=$((${c_seen:-$now} + c_period)); [ "$c_next" -gt "$now" ] || c_next=$((now + c_period))
        printf '%s' "$c_next" >"${w}next"
        run "$w" "$1" run-
        [ -z "$t_why" ] || continue
        # Sums start with "2/", for runs read this way. One from before (errors counted, a quiet
        # grep didn't) is replaced by this reading, silently, so the new way wakes no one.
        c_sum=2/$(printf '%s' "$t_out" | cksum)
        c_last=$(cat "${w}last" 2>/dev/null)
        case "$c_last" in 2/*) ;; *) printf '%s' "$c_sum" >"${w}last"; rm -f "${w}pending" "${w}message" "${w}seen"; continue ;; esac
        # As the bot heard it: no change, and one seen before was a passing one.
        [ "$c_last" != "$c_sum" ] || { rm -f "${w}pending" "${w}message" "${w}seen"; continue; }
        # (One that woke the bot without reaching it yet is told again, as it is now.)
        if [ -z "$c_seen" ] && [ ! -f "${w}pending" ]; then printf '%s' "$now" >"${w}seen"; printf '%s' $((now + 120)) >"${w}next"; continue; fi
        rm -f "${w}seen"
        c_letters=${w%/}; c_letters=${c_letters##*/}
        if [ -n "$t_out" ]; then c_now="now prints:
    $t_out"; else c_now="now prints nothing."; fi
        printf '%s\n\nYour watch (%s, every %s) saw a change. Its check, %s, %s\n' \
          "$(cat "${w}note")" "$c_letters" "$(cat "${w}every")" "$(head -n 1 "${w}check")" "$c_now" >"${w}message"
        printf '%s' "$c_sum" >"${w}pending"
        echo "KUVO-WATCH $c_letters"
      done
    }

    # A watch's wake-up went: its output is what the bot heard ($1, the watch's folder).
    delivered() { [ -f "$1/pending" ] && mv -f "$1/pending" "$1/last"; rm -f "$1/message"; }

    random() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c "$1"; }

    # A wake-up's or a watch's summary, given after --summary ($1): on one line, and short (what its
    # card shows; the agent reads the note whole). Sets `summary`, empty for none.
    summed() {
      summary=$(printf '%s' "$1" | tr '\n\r\t' '   ' | sed -e 's/^ *//' -e 's/ *$//')
      # (In bytes, as every sh counts them alike.)
      [ "$(printf '%s' "$summary" | wc -c)" -le 300 ] || { echo "Keep the summary to one short line: it's what the user sees for it, and you get the whole note." >&2; exit 2; }
    }
    # A folder's path as a header carries it, as encodeURIComponent does: each byte but letters,
    # digits and -_.!~*'() as %XX (UTF-8 names too).
    encoded() {
      for h in $(printf '%s' "$1" | od -An -v -tx1); do
        case $h in
          2[1d-e]|27|28|29|2a|3[0-9]|4[1-9a-f]|5[0-9a]|5f|6[1-9a-f]|7[0-9a]|7e) printf "\\$(printf '%03o' "0x$h")" ;;
          *) printf '%%%s' "$h" | tr 'a-f' 'A-F' ;;
        esac
      done
    }

    # The time zone a bot's times are in ($1, its folder, ending in /): its timezone file's, from
    # the computer's own zone files, or from the copy of your Mac's beside it, on a machine that
    # has none (without one, times would be in UTC). A session's folder has none of its own: the
    # one in the folder above, which the Mac keeps current, is its.
    zone() {
      z_at=$1
      if [ ! -s "${z_at}timezone" ]; then z_up=${1%/}; z_up=${z_up%/*}/; [ -s "${z_up}timezone" ] && z_at=$z_up; fi
      z_name=$(cat "${z_at}timezone" 2>/dev/null)
      if [ -n "$z_name" ] && [ ! -e "/usr/share/zoneinfo/$z_name" ] && [ -s "${z_at}zoneinfo" ]; then echo ":${z_at}zoneinfo"; else echo "$z_name"; fi
    }

    # A string as JSON.
    json() { printf '%s' "$1" | tr -d '\000-\010\013-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'; }

    # The port ($2 port) or password ($2 password) in the record $1, an engine's or the bridge's:
    # its own, not those of an object inside it (an engine's record has named the bridge's,
    # "agents":{…}, before or after its own).
    listens() {
      case $2 in
        port) sed 's/:{[^{}]*}/:0/g' "$1" 2>/dev/null | sed -n 's/.*"port":\([0-9]*\).*/\1/p' ;;
        *) sed 's/:{[^{}]*}/:0/g' "$1" 2>/dev/null | sed -n 's/.*"password":"\([^"]*\)".*/\1/p' ;;
      esac
    }

    # A session the engine has as archived: Kuvo Code's mark in its metadata, or the engine's own.
    archived='"kuvo\.archived" *: *true|"archived" *: *[0-9]'
    # Whether the session $3 is archived, as the engine (or the agents' bridge) answering on port
    # $1, to password $2, has it now; not when it can't be asked.
    archivedAt() {
      [ -n "$1" ] && [ -n "$2" ] && command -v curl >/dev/null 2>&1 || return 1
      printf 'user = "opencode:%s"\n' "$2" | curl -q -sf -m 5 --noproxy '*' -K - "http://127.0.0.1:$1/api/session/$3" 2>/dev/null | grep -qE "$archived"
    }

    # The box's sandbox, while it's on (`fenced`, its launcher): its folder is the first of those
    # given that has a `run` folder (beside the engine's record; this Mac's box keeps its own in
    # `box`, beside the bots' folder). Set up and checked (`ready`) but not on yet, or its launcher
    # missing, `unready`: checks wait rather than run without it. One the box can't set up here
    # leaves commands as they were, and checks with them.
    fenced= l_shell= unready=
    sandbox() {
      for s_k in "$@"; do
        [ -d "$s_k/run" ] || continue
        fenced="$s_k/bin/kuvo-fence"
        [ -f "$s_k/run/fence/on" ] && [ -x "$fenced" ] && return 0
        fenced=
        [ -f "$s_k/run/fence/ready" ] && unready=1
        return 0
      done
    }

    # A file a command in the sandbox left that's its own: a plain one (not a link, nor another name
    # for a file it can't read), and small.
    plain() {
      [ -f "$1" ] && [ ! -L "$1" ] && [ "$( (stat -c %h "$1" || stat -f %l "$1") 2>/dev/null)" = 1 ] \
        && [ "$(( $(wc -c <"$1") ))" -le 65536 ]
    }

    # What a conversation's commands asked for in the sandbox ($1, its folder ending in /): its
    # `inbox`, the one folder of it they write (kuvo-wake's own wake-ups, watches and cancels go
    # there). Moved out of their reach before anything in it is read, as a link moves as the link,
    # never what it names; then only plain files, by names kuvo-wake gives them. On macOS the
    # sandbox goes by paths, and a command may put a link where the inbox was: the inbox itself is
    # moved. Linux's goes with the folder, which a command can't move (nor make again).
    take() {
      k_in=${1}inbox k=${1}.took
      [ -e "$k_in" ] || [ -L "$k_in" ] || return 0
      # Nothing asked, or something being written there now (kuvo-wake builds each in a `.new-` of
      # its own, then puts it in place): left for the next round.
      if [ ! -L "$k_in" ]; then
        [ -n "$(ls -A "$k_in" 2>/dev/null)" ] || return 0
        [ -z "$(find "$k_in" -mindepth 1 -maxdepth 1 -name '.new-*' -mmin -1 2>/dev/null)" ] || return 0
      fi
      rm -rf "$k" "${1}.taking"
      if [ "$(uname)" = Darwin ]; then mv -f "$k_in" "${1}.taking" 2>/dev/null || return 0; k_in=${1}.taking; fi
      if [ -d "$k_in" ] && [ ! -L "$k_in" ] && (umask 077; mkdir "$k") 2>/dev/null; then
        for k_part in wakes summaries watches cancel; do
          { [ -e "$k_in/$k_part" ] || [ -L "$k_in/$k_part" ]; } && mv -f "$k_in/$k_part" "$k/$k_part" 2>/dev/null
        done
        # And whatever else was left there, moved out of their reach before it goes (a command could
        # put a link in place of a folder being cleared where it is).
        mkdir "$k/rest" && find "$k_in" -mindepth 1 -maxdepth 1 -exec mv -f {} "$k/rest/" \; 2>/dev/null
        mkdir -p "${1}wakes" "${1}watches"
        if [ -d "$k/cancel" ] && [ ! -L "$k/cancel" ]; then
          for f in "$k"/cancel/*; do
            l=${f##*/}; case $l in ''|*[!A-Za-z0-9]*) continue ;; esac
            for x in "${1}wakes/"*-"$l" "${1}wakes/"*-"$l"-*; do [ -f "$x" ] && rm -f "$x"; done
            rm -f "${1}summaries/$l"
            [ -d "${1}watches/$l" ] && rm -rf "${1}watches/$l"
          done
        fi
        if [ -d "$k/wakes" ] && [ ! -L "$k/wakes" ]; then
          for f in "$k"/wakes/*; do
            n=${f##*/}; case $n in [0-9]*-*) ;; *) continue ;; esac; case $n in *[!A-Za-z0-9@-]*) continue ;; esac
            plain "$f" || continue
            [ "$(ls "${1}wakes" | wc -l)" -lt 50 ] || break
            # A copy: what a command still has open of it, it can't change once it's taken in.
            { (umask 077; head -c 65536 "$f" >"${1}wakes/.new-$n") && mv -f "${1}wakes/.new-$n" "${1}wakes/$n"; } 2>/dev/null || rm -f "${1}wakes/.new-$n"
          done
        fi
        # Wake-ups' summaries, by their letters.
        if [ -d "$k/summaries" ] && [ ! -L "$k/summaries" ]; then
          mkdir -p "${1}summaries"
          for f in "$k"/summaries/*; do
            n=${f##*/}; case $n in ''|*[!A-Za-z0-9]*) continue ;; esac
            # One line, and no longer than kuvo-wake keeps one (never cut, which could split a character).
            plain "$f" && [ "$(wc -c <"$f")" -le 300 ] || continue
            { (umask 077; tr '\n\r\t' '   ' <"$f" >"${1}summaries/.new-$n") && mv -f "${1}summaries/.new-$n" "${1}summaries/$n"; } 2>/dev/null || rm -f "${1}summaries/.new-$n"
          done
        fi
        if [ -d "$k/watches" ] && [ ! -L "$k/watches" ]; then
          for d in "$k"/watches/*; do
            n=${d##*/}; case $n in ''|*[!A-Za-z0-9]*) continue ;; esac
            [ -d "$d" ] && [ ! -L "$d" ] && [ ! -e "${1}watches/$n" ] || continue
            plain "$d/every" && plain "$d/check" && plain "$d/note" || continue
            [ "$(ls "${1}watches" | wc -l)" -lt 20 ] || break
            # Copies, as wake-ups are, and no bigger than they were checked to be.
            { mkdir "${1}watches/$n" && head -c 65536 "$d/every" >"${1}watches/$n/every" && head -c 65536 "$d/check" >"${1}watches/$n/check" \
              && head -c 65536 "$d/note" >"${1}watches/$n/note" && printf '%s' "$now" >"${1}watches/$n/next"; } 2>/dev/null || rm -rf "${1}watches/$n"
            [ -d "${1}watches/$n" ] && plain "$d/summary" && [ "$(wc -c <"$d/summary")" -le 300 ] && tr '\n\r\t' '   ' <"$d/summary" >"${1}watches/$n/summary" 2>/dev/null
          done
        fi
      fi
      rm -rf "$k" "${1}.taking"
    }

    if [ "$1" = fire ]; then
      record=$3; botsroot=$2
      sandbox "${record%/*/*}"
      # Gone sessions' wake-ups (`settle`) are kept a month, then go for good.
      find "${botsroot%/*}/trash" -mindepth 1 -maxdepth 1 -name 'wakes-*' -mtime +30 -exec rm -rf {} + 2>/dev/null
      [ -f "$record" ] || exit 0
      eport=$(listens "$record" port)
      epassword=$(listens "$record" password)
      # The coding agents' bridge beside the engine, which answers the same paths for its sessions.
      bridge="${record%/*}/bridge.json"
      bport=$(listens "$bridge" port)
      bpassword=$(listens "$bridge" password)
      [ -n "$eport$bport" ] || exit 0
      # Where a conversation lives ($bot, its folder): the bridge for one its folder says is a
      # coding agent's (`via`), whose tools aren't the engine's to wait for; else the engine.
      reach() {
        if [ "$(cat "${bot}via" 2>/dev/null)" = bridge ]; then port=$bport password=$bpassword tools=1; else port=$eport password=$epassword; fi
        [ -n "$port" ] && [ -n "$password" ]
      }
      # A session's watches wait too while it's archived (its wake-ups do, in `settle`).
      archivedNow() { [ "$bots" != "$botsroot" ] && archivedAt "$port" "$password" "$session"; }
      # A conversation you stopped, its queue paused on the box (`run/queues.json`, beside the
      # engine's record): its wake-ups wait there, in the list you resume, as what else arrives
      # does (`hold`); its watches wait until you resume it.
      stopped() { grep -qF "\"$session\":{\"paused\":true" "${record%/*}/queues.json" 2>/dev/null; }
      # A wake-up handed to the box to wait with the conversation's queue, through its own command
      # (`box route`, which the box that runs this names: `KUVO_LINK_*`); true once it's taken.
      # Sent, rather, if the conversation went on meanwhile.
      hold() {
        [ -n "${KUVO_LINK_SCRIPT-}" ] && [ -n "${KUVO_LINK_RUNTIME-}" ] || return 1
        h_ms=$(date +%s%3N 2>/dev/null); case "$h_ms" in *[!0-9]*|'') h_ms=$((now * 1000));; esac
        h_id=msg_$(printf '%012x' $(((h_ms * 4096 + 1) & 0xFFFFFFFFFFFF)))$(random 14)
        h_asked="{\"method\":\"POST\",\"path\":\"kuvo/sessions/$session/queue/add\",\"body\":{\"id\":\"$h_id\",\"text\":\"$(json "[Wake-up] $1")\",\"delivery\":\"queue\",\"from\":\"Wake-up\",\"words\":\"$(json "$1")\",\"kept\":true$(marked "$2")}}"
        # shellcheck disable=SC2086
        printf '%s' "$h_asked" | KUVO_HOME="${record%/*/*}" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$KUVO_LINK_RUNTIME" ${KUVO_LINK_FLAGS-} "$KUVO_LINK_SCRIPT" box route 2>/dev/null | grep -qF '"status":200'
      }
      # Whether this wake-up waits on the box already (one that repeats, kept from last time), in
      # this conversation's own entry: another's may wait with the same words (bots made from one
      # template). One entry to a line (a quote inside the words is escaped, so no `},"…":{"paused":`
      # is in them).
      held() {
        sed 's/},"\([^"]*\)":{"paused":/}\
    "\1":{"paused":/g' "${record%/*}/queues.json" 2>/dev/null | grep -F "\"$session\":{\"paused\":" | grep -qF "\"from\":\"Wake-up\",\"text\":\"$(json "$1")\""
      }
      # A session's folder (not a bot's, in $botsroot) as its engine knows the
      # session now: one that's gone goes to the trash, rather than its wake-ups being tried for
      # ever; a subagent's goes to the conversation that started it (its bot's folder, if it's a
      # bot's); and it works where its session does. False when it's gone or moved.
      settle() {
        [ "$bots" != "$botsroot" ] && command -v curl >/dev/null 2>&1 || return 0
        s_ask() { printf 'user = "opencode:%s"\n' "$2" | curl -q -s -m 5 --noproxy '*' -K - -w '\n%{http_code}' "http://127.0.0.1:$1/api/session/$session" 2>/dev/null; }
        s_out=$(s_ask "$port" "$password") || return 0
        s_code=$(printf '%s' "$s_out" | tail -n 1)
        # Not the engine's but the agents' bridge's, which its folder didn't say: its from now on.
        if [ "$s_code" = 404 ] && [ "$port" = "$eport" ] && [ -n "$bport" ] && [ -n "$bpassword" ]; then
          s_out=$(s_ask "$bport" "$bpassword") || return 0
          s_code=$(printf '%s' "$s_out" | tail -n 1)
          [ "$s_code" = 200 ] && printf bridge >"${bot}via" && port=$bport password=$bpassword tools=1
        # Or the engine's, which its folder took for the bridge's (neither answered as it was made).
        elif [ "$s_code" = 404 ] && [ "$port" = "$bport" ] && [ -n "$eport" ] && [ -n "$epassword" ]; then
          s_out=$(s_ask "$eport" "$epassword") || return 0
          s_code=$(printf '%s' "$s_out" | tail -n 1)
          [ "$s_code" = 200 ] && rm -f "${bot}via" && port=$eport password=$epassword tools=
        fi
        case "$s_code" in
          404) mkdir -p "${botsroot%/*}/trash" && mv "${bot%/}" "${botsroot%/*}/trash/wakes-$session-$now" 2>/dev/null; return 1 ;;
          200) ;;
          *) return 0 ;;
        esac
        s_body=$(printf '%s' "$s_out" | sed '$d')
        # One held (`held`) is only let go once it's gone, or, held as archived, once it's back
        # (its bringing back didn't reach this computer): then it goes on as any other.
        if [ -n "$held" ]; then
          [ "$(cat "${bot}paused" 2>/dev/null)" = archived ] && ! printf '%s' "$s_body" | grep -qE "$archived" && rm -f "${bot}paused"
          return 1
        fi
        # Archived, from any app (a Mac's, a phone's: they mark the session itself), wherever it
        # was done, or a folder made since (by the box's sandbox, say): held as archiving holds
        # them (`paused`), so it shows held wherever it's listed, until it's brought back.
        printf '%s' "$s_body" | grep -qE "$archived" && { printf archived >"${bot}paused"; return 1; }
        s_dir=$(printf '%s' "$s_body" | sed -n 's/.*"location" *: *{[^}]*"directory" *: *"\([^"]*\)".*/\1/p' | head -n 1)
        [ -n "$s_dir" ] && [ "$s_dir" != "$(cat "${bot}directory" 2>/dev/null)" ] && printf '%s' "$s_dir" >"${bot}directory"
        s_parent=$(printf '%s' "$s_body" | sed -n 's/.*"parentID" *: *"\(ses_[A-Za-z0-9]*\)".*/\1/p' | head -n 1)
        [ -n "$s_parent" ] || return 0
        s_to="$bots/$s_parent"
        for b in "$botsroot"/*/; do [ "$(cat "${b}session" 2>/dev/null)" = "$s_parent" ] && s_to=${b%/} && break; done
        if [ ! -d "$s_to" ]; then
          (umask 077; mkdir -p "$s_to") && printf '%s' "$s_parent" >"$s_to/session" || return 1
          cp "${bot}directory" "$s_to/directory" 2>/dev/null; [ -f "${bot}via" ] && cp "${bot}via" "$s_to/via"
        fi
        mkdir -p "$s_to/wakes" "$s_to/watches"
        for f in "${bot}wakes/"*; do [ -f "$f" ] && mv -f "$f" "$s_to/wakes/"; done
        for f in "${bot}summaries/"*; do [ -f "$f" ] && mkdir -p "$s_to/summaries" && mv -f "$f" "$s_to/summaries/"; done
        for f in "${bot}watches/"*/; do [ -d "$f" ] && mv -f "${f%/}" "$s_to/watches/"; done
        rm -rf "${bot%/}"
        return 1
      }
      # The mark a wake-up's message carries with its summary ($1; none without one), which clients
      # show in its place (KuvoClient's WakeMessage): `,"metadata":…` for a message's JSON.
      marked() { [ -z "$1" ] || printf ',"metadata":{"kuvo":{"wake":{"summary":"%s"}}}' "$(json "$1")"; }
      # Sends a wake-up's text to the bot's session, marked with its summary ($2); true once it's gone.
      deliver() {
        # The bot's folder's tools (its browser, integrations) first: the engine connects them
        # after it opens the folder, and a wake-up sent sooner goes without them. A folder it has
        # only just opened lists none for a moment before they're pending. Twenty seconds at most,
        # as an integration's server can take a while the first time.
        if [ -f "${bot}directory" ] && command -v curl >/dev/null 2>&1 && [ -z "$tools" ]; then
          tools=1; pended=; began=$(date +%s)
          folder=$(encoded "$(cat "${bot}directory")")
          while listed=$(printf 'user = "opencode:%s"\n' "$password" | curl -q -sf -m 5 --noproxy '*' -K - -H "x-opencode-directory: $folder" "http://127.0.0.1:$port/api/mcp"); do
            [ -z "$stopping" ] || return 1
            waited=$(($(date +%s) - began))
            [ "$waited" -ge 20 ] && break
            case "$listed" in
              *'"pending"'*) pended=1 ;;
              *'"status"'*) break ;;
              *) [ "$waited" -ge 3 ] && break ;;
            esac
            sleep 0.25
          done
          [ -n "$pended" ] && sleep 1.5
        fi
        [ -z "$stopping" ] || return 1
        ms=$(date +%s%3N 2>/dev/null); case "$ms" in *[!0-9]*|'') ms=$((now * 1000));; esac
        id=msg_$(printf '%012x' $(((ms * 4096 + 1) & 0xFFFFFFFFFFFF)))$(random 14)
        body="{\"id\":\"$id\",\"text\":\"$(json "[Wake-up] $1")\",\"delivery\":\"queue\"$(marked "$2")}"
        url="http://127.0.0.1:$port/api/session/$session/prompt"
        # The password from its standard input (curl) or a file only this user can read (wget):
        # on a command line, any user on the machine could read it while it runs. Straight to the
        # engine, never through a proxy the machine names (and without curl's own settings).
        if command -v curl >/dev/null 2>&1; then
          printf 'user = "opencode:%s"\n' "$password" | curl -q -sf -m 20 --noproxy '*' -K - -H 'Content-Type: application/json' --data-binary "$body" "$url" >/dev/null
        elif command -v wget >/dev/null 2>&1; then
          auth=$(printf 'opencode:%s' "$password" | base64 | tr -d '\n')
          settings="${record%/*}/.wget-$$"
          (umask 077; printf 'header = Authorization: Basic %s\n' "$auth" >"$settings")
          wget -q --config="$settings" --no-proxy -T 20 -O /dev/null --header='Content-Type: application/json' --post-data="$body" "$url"
          sent=$?
          rm -f "$settings"
          return $sent
        else
          return 1
        fi
      }
      # Whether the bot's session still has this text queued as a wake-up.
      waiting() {
        command -v curl >/dev/null 2>&1 || return 1
        printf 'user = "opencode:%s"\n' "$password" | curl -q -sf -m 5 --noproxy '*' -K - "http://127.0.0.1:$port/api/session/$session/inbox" | grep -qF "\"$(json "[Wake-up] $1")\""
      }
      # The bots' folders, then the sessions' beside them, each on its own.
      for bots in "$2" "${2%/*}/wakes"; do
      [ -d "$bots" ] || continue
      # One at a time: two at once (a watchdog left from before the engine started over, say)
      # would send a wake-up twice. One stopped lets go of it once the wake-up it's sending is
      # done with (dash runs no EXIT trap for a signal): stopped as soon as the signal comes, one
      # the engine took would be sent again. One left by one killed outright goes after ten minutes.
      lock="$bots/.firing"
      [ -z "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ] || rmdir "$lock" 2>/dev/null
      mkdir "$lock" 2>/dev/null || continue
      stopping=
      trap 'rmdir "$lock" 2>/dev/null' EXIT
      trap 'stopping=1' INT TERM HUP
      stop() { [ -z "$stopping" ] || { rmdir "$lock" 2>/dev/null; exit 143; }; }
      held=
      for bot in "$bots"/*/; do
        stop
        # Paused by you (a session's, while it's archived: see `settle` too): its wake-ups wait.
        # Though one whose session is gone (deleted while it was held) goes to the trash, as
        # `settle` has one go; not one on its way to another computer.
        if [ -e "${bot}paused" ]; then
          if [ "$(cat "${bot}paused" 2>/dev/null)" != moving ] && session=$(cat "$bot/session" 2>/dev/null) && [ -n "$session" ] && reach; then
            held=1; settle; held=
          fi
          # (One let go as its session is back goes on now, as any other.)
          [ -e "${bot}paused" ] || [ ! -d "$bot" ] && continue
        fi
        # One whose last wake-up couldn't go waits before it's tried again (`.retry`: when, and how
        # long it waited): a minute, then twice as long each time, up to half an hour.
        r_at=; r_wait=
        [ -f "${bot}.retry" ] && read -r r_at r_wait <"${bot}.retry"
        case "$r_at" in ''|*[!0-9]*) r_at=0;; esac
        [ "$r_at" -le "$now" ] || continue
        take "$bot"
        # Nothing kept (a conversation that only ran commands): nothing to ask its engine.
        [ -n "$(ls -A "${bot}wakes" "${bot}watches" 2>/dev/null | grep -v ':$' | grep .)" ] || continue
        tools=
        session=$(cat "$bot/session" 2>/dev/null) || continue
        [ -n "$session" ] || continue
        reach || continue
        settle || continue
        # Stopped: its wake-ups wait on the box (`hold`), or here, where the box can't take them.
        paused=
        if stopped; then [ -n "${KUVO_LINK_SCRIPT-}" ] || continue; paused=1; fi
        failed=
        for wake in "$bot"wakes/*; do
          stop
          [ -f "$wake" ] || continue
          file=${wake##*/}; rest=${file#*-}; due=${file%%-*}
          case "$rest" in *-*) every=${rest#*-};; *) every=;; esac
          case "$due" in ''|*[!0-9]*) continue;; esac
          [ "$due" -le "$now" ] || continue
          # Sent: a repeating one comes back at its next time (in the user's time zone, which the
          # bot's folder names), keeping its letters, time of day and day of the week (one made
          # before it kept those, the ones it was due at); others are done.
          # One that repeats and still waits from last time (the bot busy, or waiting on you) isn't
          # queued again: it just comes back at its next time.
          summary=$(cat "${bot}summaries/${rest%%-*}" 2>/dev/null)
          if [ -n "$paused" ]; then
            { [ -n "$every" ] && { waiting "$(cat "$wake")" || held "$(cat "$wake")"; }; } || hold "$(cat "$wake")" "$summary"
          else
            { [ -n "$every" ] && waiting "$(cat "$wake")"; } || deliver "$(cat "$wake")" "$summary"
          fi
          if [ $? -eq 0 ]; then
            if [ -n "$every" ] && repeats "${every%@*}"; then
              tz=$(zone "$bot")
              again=$( [ -n "$tz" ] && export TZ="$tz"
                every=$(kept "$due" "$every")
                at=$(next "$due" "$every") && [ -n "$at" ] && echo "$at-${rest%%-*}-$every" )
              # Without a next time it's done, rather than sent again every minute.
              case "$again" in [0-9]*-*) mv -f "$wake" "${bot}wakes/$again" ;; *) rm -f "$wake" "${bot}summaries/${rest%%-*}" ;; esac
            else
              rm -f "$wake" "${bot}summaries/${rest%%-*}"
            fi
          else
            failed=1
          fi
        done
        stop
        if [ -n "$failed" ]; then
          case "$r_wait" in ''|*[!0-9]*) r_wait=30;; esac
          r_wait=$((r_wait * 2)); [ "$r_wait" -le 1800 ] || r_wait=1800
          printf '%s %s\n' "$((now + r_wait))" "$r_wait" >"${bot}.retry"
        else
          rm -f "${bot}.retry"
        fi
      done
      rmdir "$lock" 2>/dev/null; trap - EXIT INT TERM HUP
      # Then their watches, apart (a slow check, up to a minute each, never holds up a wake-up, nor
      # the next round's): what changed wakes the bot, with what its check prints now; one that
      # can't go is tried again at the next check. One round of them at a time.
      watching="$bots/.watching"
      [ -z "$(find "$watching" -maxdepth 0 -mmin +60 2>/dev/null)" ] || rmdir "$watching" 2>/dev/null
      mkdir "$watching" 2>/dev/null || continue
      (
      trap 'rmdir "$watching" 2>/dev/null' EXIT
      trap 'rmdir "$watching" 2>/dev/null; exit 143' INT TERM HUP
      for bot in "$bots"/*/; do
        [ -e "${bot}paused" ] && continue
        [ -d "${bot}watches" ] || continue
        tools=
        session=$(cat "$bot/session" 2>/dev/null) || continue
        [ -n "$session" ] || continue
        reach || continue
        archivedNow && continue
        stopped && continue
        tz=$(zone "$bot")
        for letters in $( ( [ -n "$tz" ] && export TZ="$tz"; checks "${bot%/}" ) | sed -n 's/^KUVO-WATCH //p'); do
          w="${bot}watches/$letters"
          [ -f "$w/message" ] && deliver "$(cat "$w/message")" "$(cat "$w/summary" 2>/dev/null)" && delivered "$w"
        done
      done
      ) </dev/null >/dev/null 2>&1 &
      done
      exit 0
    fi

    # Whose: left out, the conversation running this (as the engine names it), its bot's if it's
    # a bot's; then how to name it again in what this says (as it was written).
    shown=kuvo-wake queued=
    case "$1" in
      add|list|cancel|watch)
        me=$OPENCODE_SESSION_ID
        case "$me" in ses_?*) ;; *) echo "Name whose wake-ups these are: kuvo-wake <bot or session> $1 ..., as this doesn't run in a conversation of its own." >&2; exit 2 ;; esac
        # In the sandbox, which hides the other bots' folders, the sandbox names its own; there it
        # writes only the folder's inbox, which the box takes in (`take`) within a minute.
        if [ -n "$KUVO_WAKE_FOLDER" ] && [ "$(cat "$KUVO_WAKE_FOLDER/session" 2>/dev/null)" = "$me" ]; then me=$KUVO_WAKE_FOLDER queued=1
        else
          for b in "${KUVO_BOTS:-$HOME/.kuvo-code/bots}"/*/; do
            [ "$(cat "${b}session" 2>/dev/null)" = "$me" ] && me=${b%/} && break
          done
        fi
        set -- "$me" "$@" ;;
      *) shown="kuvo-wake $1" ;;
    esac
    # How to cancel or list them, as this was asked: Kuvo Code's tools (KUVO_WAKE_TOOL), or kuvo-wake.
    if [ -n "$KUVO_WAKE_TOOL" ]; then cancelling="cancel_wake_up"; listing="list_wake_ups"; else cancelling="$shown cancel"; listing="$shown list"; fi
    bot=$1; command=$2; session=
    # A bot's ID is letters, digits, _ and -, and a session's starts with ses_; a folder is named
    # by its path.
    case "$bot" in
      */*) ;;
      -*|*[!A-Za-z0-9_-]*) bot= ;;
      ses_?*) session=$bot; bot="${KUVO_WAKES:-$HOME/.kuvo-code/wakes}/$bot" ;;
      ?*) bot="${KUVO_BOTS:-$HOME/.kuvo-code/bots}/$bot" ;;
    esac
    # A session's folder comes with its first wake-up or watch, once what's asked checks out
    # (`made`): its session, and the folder it works in, where its watches' checks run and whose
    # tools wait for its wake-ups; for a coding agent's (its bridge says so, in KUVO_WAKE_VIA),
    # that its wake-ups go through the bridge.
    fresh=
    if [ -n "$session" ] && [ ! -d "$bot" ]; then
      case "$command" in
        add|watch) fresh=1 ;;
        list) echo "No wake-ups scheduled."; exit 0 ;;
      esac
    fi
    if [ -z "$bot" ] || { [ ! -d "$bot" ] && [ -z "$fresh" ]; }; then usage >&2; exit 2; fi
    [ -n "$fresh" ] || bot=$(CDPATH= cd -- "$bot" && pwd) || exit 2
    # Where what's asked goes: the folder, or its inbox in the sandbox.
    into=$bot; [ -z "$queued" ] || into=$bot/inbox
    # A watch's check run by hand, in the sandbox while it's on (see `sandbox`).
    case "$command" in try|check) b_root=${KUVO_BOTS:-$HOME/.kuvo-code/bots}; sandbox "${b_root%/*}/box" "${b_root%/*}" ;; esac
    made() {
      [ -n "$fresh" ] || return 0
      (umask 077; mkdir -p "$bot") && printf '%s' "$session" >"$bot/session" && printf '%s' "$PWD" >"$bot/directory" \
        && { [ "$KUVO_WAKE_VIA" != bridge ] || printf bridge >"$bot/via"; } || { echo "Couldn't keep it in $bot." >&2; exit 2; }
      # An archived session's is held from the start (`paused`), as archiving holds the wake-ups a
      # session has, until it's brought back: as the Mac's app makes one (WakeUps.makeFolder) and the
      # box's routes do, so too for this Mac's keeper with the app closed, a machine's tools and an
      # agent's own kuvo-wake. Asked of its engine (a coding agent's, of the agents' bridge), found
      # by its record in the box's `run` folder, beside the wakes folder: this Mac's is in `box`.
      m_home=${bot%/*}; m_home=${m_home%/*}; m_record=
      for m_k in "$m_home/box" "$m_home"; do [ -f "$m_k/run/engine.json" ] && m_record=$m_k/run/engine.json && break; done
      [ -n "$m_record" ] && [ "$KUVO_WAKE_VIA" = bridge ] && m_record=${m_record%/*}/bridge.json
      if [ -n "$m_record" ] && archivedAt "$(listens "$m_record" port)" "$(listens "$m_record" password)" "$session"; then
        printf archived >"$bot/paused"
      fi
    }
    # The user's time zone, when the bot lives on a machine whose clock may be in another.
    z=$(zone "$bot/"); if [ -n "$z" ]; then TZ=$z; export TZ; fi
    case "$command" in
      add)
        due=$(seconds "$3") || { echo "Couldn't read the time \"$3\". Use +30m, +2h, +1d, or a time like 2026-10-16T09:00." >&2; exit 2; }
        shift 3; every= summary=
        while [ $# -ge 2 ]; do
          case "$1" in
            --every)
              repeats "$2" || { echo "Couldn't read the repeat \"$2\". Use 30m, 2h, 1d, 1w (at least 5m), or weekdays." >&2; exit 2; }
              every=${2%@*}; shift 2 ;;
            --summary) summed "$2"; shift 2 ;;
            *) break ;;
          esac
        done
        # On weekdays: the first one too, at the same time of day.
        if [ "$every" = weekdays ] && ! weekday "$(day "$due")"; then
          a_day=$(day "$due"); a_at=$(clock "$due" %H%M)
          while ! weekday "$a_day"; do a_day=$((a_day + 1)); done
          due=$(daytime "$a_day" "$a_at")
        fi
        note="$*"
        [ -n "$note" ] || { echo "Add a note for yourself: what to do when you wake up." >&2; exit 2; }
        [ "$due" -gt $((now + 30)) ] || { echo "That's not in the future. Wake-ups are for later; do it now instead." >&2; exit 2; }
        made
        mkdir -p "$into" 2>/dev/null || { echo "Couldn't keep it in $bot." >&2; exit 2; }
        count=$(find "$bot/wakes" "$bot/inbox/wakes" -type f 2>/dev/null | wc -l)
        [ "$count" -lt 50 ] || { echo "You already have 50 wake-ups waiting. Cancel some first." >&2; exit 2; }
        id=$(name "$due" "${every:+$(kept "$due" "$every")}")
        # Whole before it's in place (the box may take the inbox in meanwhile), its summary first.
        a_l=${id#*-}; a_l=${a_l%%-*}
        if [ -n "$summary" ]; then
          { printf '%s' "$summary" >"$into/.new-s$a_l" && mkdir -p "$into/summaries" && mv -f "$into/.new-s$a_l" "$into/summaries/$a_l"; } 2>/dev/null \
            || { rm -f "$into/.new-s$a_l" 2>/dev/null; echo "Couldn't keep it in $bot." >&2; exit 2; }
        fi
        { printf '%s' "$note" >"$into/.new-$id" && mkdir -p "$into/wakes" && mv -f "$into/.new-$id" "$into/wakes/$id"; } 2>/dev/null \
          || { rm -f "$into/.new-$id" "$into/summaries/$a_l" 2>/dev/null; echo "Couldn't keep it in $bot." >&2; exit 2; }
        echo "Scheduled $id for $(readable "$due")${every:+, then every $every until canceled}." ;;
      watch)
        every=$3; check=$4
        period "$every" >/dev/null || { echo "Couldn't read how often, \"$3\". Use 5m or more, 2h or 1d." >&2; exit 2; }
        [ -n "$check" ] || { echo "Give the check: a shell command that prints what you watch, and prints something else when it changes." >&2; exit 2; }
        shift 4; summary=
        if [ "$1" = --summary ] && [ $# -ge 2 ]; then summed "$2"; shift 2; fi
        note="$*"
        [ -n "$note" ] || { echo "Add a note for yourself: what to do when it changes." >&2; exit 2; }
        count=$(find "$bot/watches" "$bot/inbox/watches" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
        [ "$count" -lt 20 ] || { echo "You already have 20 watches. Cancel some first." >&2; exit 2; }
        made
        letters=$(random 6); w="$into/.new-$letters"
        { mkdir -p "$w" && printf '%s' "$every" >"$w/every" && printf '%s' "$check" >"$w/check" && printf '%s' "$note" >"$w/note" && printf '%s' "$now" >"$w/next" \
          && { [ -z "$summary" ] || printf '%s' "$summary" >"$w/summary"; } \
          && mkdir -p "$into/watches" && mv "$w" "$into/watches/$letters"; } 2>/dev/null \
          || { rm -rf "$w" 2>/dev/null; echo "Couldn't keep it in $bot." >&2; exit 2; }
        echo "Watching ($letters): every $every the check runs, without you, and when what it prints changes (not the first time), you wake up with the new output. Cancel it with: $cancelling $letters" ;;
      check)
        # For the Mac's app: the watches that are due, run now.
        checks "$bot" ;;
      try)
        # For Check Now: a watch's check, by its letters, run as its runs are, without counting.
        # A line with why a run like it wouldn't count (after "KUVO-TRY "), then what it printed.
        case "$3" in ''|*[!A-Za-z0-9]*) w= ;; *) w="$bot/watches/$3/" ;; esac
        [ -n "$w" ] && [ -f "${w}check" ] || { echo "No watch \"$3\". See $listing." >&2; exit 2; }
        run "$w" "$bot" try-
        printf 'KUVO-TRY %s\n%s' "$t_why" "$t_out" ;;
      list)
        found=
        for wake in "$bot"/wakes/* "$bot"/inbox/wakes/*; do
          [ -f "$wake" ] || continue
          id=${wake##*/}; l=${id#*-}; l=${l%%-*}
          [ ! -e "$bot/inbox/cancel/$l" ] || continue
          found=1
          every=${id#*-}; case "$every" in *-*) every=${every#*-}; every=" (every ${every%@*})";; *) every=;; esac
          echo "$id  $(readable "${id%%-*}")$every  $(head -n 1 "$wake")"
        done
        for w in "$bot"/watches/*/ "$bot"/inbox/watches/*/; do
          [ -f "${w}check" ] || continue
          l=${w%/}; l=${l##*/}
          [ ! -e "$bot/inbox/cancel/$l" ] || continue
          found=1
          echo "$l  watch every $(cat "${w}every"): $(head -n 1 "${w}check")  ->  $(head -n 1 "${w}note")"
        done
        [ -n "$found" ] || echo "No wake-ups scheduled." ;;
      cancel)
        # By its letters, which a repeating one keeps as its time moves on: its ID as list shows
        # it, or the letters alone. Nothing else, so it never names a folder outside the bot's.
        letters=${3#*-}; letters=${letters%%-*}; found=
        case "$3" in -*|*[!A-Za-z0-9@-]*) letters= ;; esac
        case "$letters" in *[!A-Za-z0-9]*) letters= ;; esac
        if [ -n "$letters" ]; then
          for f in "$into"/wakes/*-"$letters" "$into"/wakes/*-"$letters"-*; do [ -f "$f" ] && rm -f "$f" && found=1; done
          [ -z "$found" ] || rm -f "$into/summaries/$letters"
          # Or a watch, by its letters alone.
          [ "$letters" = "$3" ] && [ -d "$into/watches/$letters" ] && rm -rf "$into/watches/$letters" && found=1
          # In the sandbox, one the box already took in is canceled as it takes the inbox in.
          if [ -n "$queued" ]; then
            c_box=
            for f in "$bot"/wakes/*-"$letters" "$bot"/wakes/*-"$letters"-*; do [ -f "$f" ] && c_box=1; done
            [ "$letters" = "$3" ] && [ -d "$bot/watches/$letters" ] && c_box=1
            if [ -n "$c_box" ]; then
              { mkdir -p "$into/cancel" && : >"$into/cancel/$letters"; } 2>/dev/null || { echo "Couldn't keep it in $bot." >&2; exit 2; }
              found=1
            fi
          fi
        fi
        [ -n "$found" ] || { echo "No wake-up \"$3\". See $listing." >&2; exit 2; }
        echo "Canceled $3." ;;
      *) usage ;;
    esac
    """#
}
