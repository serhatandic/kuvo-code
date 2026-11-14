import Foundation

/// How often "/loop" sends its message again: every so many minutes or hours (it sends it now
/// too, then again each time), or each day or weekday at a time (it waits for that time). What
/// the box's wake-ups take (`Wakes.Repeat`), written the way you'd say it.
public struct LoopSchedule: Equatable, Sendable, Hashable {
    public var every: Wakes.Repeat
    /// The time of day it keeps (hour, minute), for one by days or weekdays.
    public var hour: Int?
    public var minute: Int?

    public init(every: Wakes.Repeat, hour: Int? = nil, minute: Int? = nil) {
        self.every = every
        self.hour = hour
        self.minute = minute
    }

    /// What "/loop" offers before you've said: from often to once a weekday morning.
    public static let presets: [LoopSchedule] = [
        LoopSchedule(every: .minutes(5)),
        LoopSchedule(every: .minutes(30)),
        LoopSchedule(every: .hours(1)),
        LoopSchedule(every: .days(1), hour: 9, minute: 0),
        LoopSchedule(every: .weekdays, hour: 9, minute: 0),
    ]

    /// By the clock (days, weekdays): it waits for its time; else it goes now, then again.
    public var keepsTimeOfDay: Bool { every.keepsTimeOfDay }

    /// What's written after "/loop", which `LoopCommand` reads back: "every 5 min", "every hour",
    /// "every morning at 9", "weekdays at 9", "every day at 14:30".
    public var phrase: String {
        switch every {
        case .minutes(let n): return "every \(n) min"
        case .hours(1): return "every hour"
        case .hours(let n): return "every \(n) hours"
        case .days(let n): return (n == 1 ? (hour == 9 && (minute ?? 0) == 0 ? "every morning" : "every day") : "every \(n) days") + " at " + Self.clock(hour, minute)
        case .weeks(let n): return (n == 1 ? "every week" : "every \(n) weeks") + " at " + Self.clock(hour, minute)
        case .weekdays: return "weekdays at " + Self.clock(hour, minute)
        }
    }

    /// As a list or a hint says it: "Every 5 minutes", "Every hour", "Every morning at 9".
    public var title: String {
        let phrase = phrase.replacingOccurrences(of: " min", with: " minutes")
        return phrase.prefix(1).uppercased() + phrase.dropFirst()
    }

    /// When it sends the message first: now, or at its next time of day.
    public func firstRun(now: Date, calendar: Calendar = .current) -> Date {
        guard keepsTimeOfDay, let hour else { return now }
        var next = calendar.date(bySettingHour: hour, minute: minute ?? 0, second: 0, of: now) ?? now
        while next <= now || (every == .weekdays && calendar.isDateInWeekend(next)) {
            next = calendar.date(byAdding: .day, value: 1, to: next) ?? next.addingTimeInterval(86_400)
        }
        return next
    }

    /// When the wake-up that repeats it is due first: its first time by the clock, or one period
    /// after now for one that goes now.
    public func firstWake(now: Date, calendar: Calendar = .current) -> Date {
        if keepsTimeOfDay { return firstRun(now: now, calendar: calendar) }
        switch every {
        case .minutes(let n): return now.addingTimeInterval(Double(n) * 60)
        case .hours(let n): return now.addingTimeInterval(Double(n) * 3600)
        default: return now
        }
    }

    /// When it first sends, as the list and the hint say it: "starts now",
    /// "first today at 14:30", "first tomorrow at 9:00", "first Monday at 9:00" (the time in
    /// `locale`'s way).
    public func firstPhrase(now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        guard keepsTimeOfDay else { return "starts now" }
        let first = firstRun(now: now, calendar: calendar)
        var style = Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar)
        style.timeZone = calendar.timeZone
        let time = first.formatted(style)
        if calendar.isDate(first, inSameDayAs: now) { return "first today at \(time)" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(first, inSameDayAs: tomorrow) { return "first tomorrow at \(time)" }
        var day = Date.FormatStyle(locale: locale, calendar: calendar).weekday(.wide)
        day.timeZone = calendar.timeZone
        return "first \(first.formatted(day)) at \(time)"
    }

    /// "9", "9:30", "14:30".
    static func clock(_ hour: Int?, _ minute: Int?) -> String {
        let hour = hour ?? 9
        let minute = minute ?? 0
        return minute == 0 ? "\(hour)" : String(format: "%d:%02d", hour, minute)
    }
}

/// "/loop <how often> <what to send>", read: the schedule (nil when what's typed doesn't say it
/// yet, or says it in a way it can't read) and the message.
public struct LoopCommand: Equatable, Sendable {
    public var schedule: LoopSchedule?
    public var message: String
    /// How much of what follows "/loop" says the schedule, in UTF-16, spaces before it included
    /// (0 without one): the composer draws it as part of the keyword.
    public var scheduleLength = 0
    /// The schedule as written ("every hour"), empty without one.
    public var scheduleText = ""

    /// What follows "/loop".
    public init(_ rest: String) {
        let words = rest.split(whereSeparator: \.isWhitespace).map(String.init)
        for count in stride(from: min(words.count, 6), through: 1, by: -1) {
            // "every morning at 25": a time was meant, and isn't one; not "every morning" with
            // "at 25" to send.
            if count < words.count, words[count].lowercased() == "at" { continue }
            if let schedule = Self.schedule(Array(words.prefix(count)).map { $0.lowercased() }) {
                self.schedule = schedule
                // The message as written after the schedule, its lines kept.
                var index = rest.startIndex
                for _ in 0..<count {
                    while index < rest.endIndex, rest[index].isWhitespace { index = rest.index(after: index) }
                    while index < rest.endIndex, !rest[index].isWhitespace { index = rest.index(after: index) }
                }
                scheduleLength = rest[..<index].utf16.count
                scheduleText = rest[..<index].trimmingCharacters(in: .whitespacesAndNewlines)
                message = rest[index...].trimmingCharacters(in: .whitespacesAndNewlines)
                return
            }
        }
        schedule = nil
        message = rest.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A schedule the whole of `words` says, or nil.
    static func schedule(_ words: [String]) -> LoopSchedule? {
        switch words {
        case ["hourly"], ["every", "hour"]: return LoopSchedule(every: .hours(1))
        // By the day or week with no time said: at 9, as a morning's.
        case ["daily"], ["every", "day"], ["every", "morning"]: return LoopSchedule(every: .days(1), hour: 9, minute: 0)
        case ["weekdays"], ["every", "weekday"]: return LoopSchedule(every: .weekdays, hour: 9, minute: 0)
        case ["weekly"], ["every", "week"]: return LoopSchedule(every: .weeks(1), hour: 9, minute: 0)
        default: break
        }
        // "30m", "2h", "every 30 min", "every 2 hours".
        let spoken = words.first == "every" ? Array(words.dropFirst()) : words
        if spoken.count == 1, let every = Wakes.Repeat(spoken[0]) { return every.keepsTimeOfDay ? LoopSchedule(every: every, hour: 9, minute: 0) : LoopSchedule(every: every) }
        if spoken.count == 2, let n = Int(spoken[0]), n > 0 {
            let unit = spoken[1]
            if ["m", "min", "mins", "minute", "minutes"].contains(unit), let every = Wakes.Repeat("\(n)m") { return LoopSchedule(every: every) }
            if ["h", "hr", "hrs", "hour", "hours"].contains(unit), let every = Wakes.Repeat("\(n)h") { return LoopSchedule(every: every) }
        }
        // "every morning at 9", "every day at 14:30", "daily at 9am", "weekdays at 9", "every weekday at 8:30".
        guard let at = words.firstIndex(of: "at"), at + 1 == words.count - 1, let (hour, minute) = clock(words[at + 1]) else { return nil }
        switch Array(words[..<at]) {
        case ["every", "morning"], ["mornings"], ["every", "day"], ["daily"]: return LoopSchedule(every: .days(1), hour: hour, minute: minute)
        case ["weekdays"], ["every", "weekday"], ["on", "weekdays"]: return LoopSchedule(every: .weekdays, hour: hour, minute: minute)
        case ["every", "week"], ["weekly"]: return LoopSchedule(every: .weeks(1), hour: hour, minute: minute)
        case let days where days.count == 3 && days[0] == "every" && ["days", "day", "weeks", "week"].contains(days[2]):
            // "every 2 days at 9", "every 2 weeks at 9".
            guard let n = Int(days[1]), let every = Wakes.Repeat("\(n)\(days[2].hasPrefix("day") ? "d" : "w")") else { return nil }
            return LoopSchedule(every: every, hour: hour, minute: minute)
        default: return nil
        }
    }

    /// "9", "9am", "9:30", "14:30", "2pm", "2:15pm".
    static func clock(_ text: String) -> (Int, Int)? {
        var text = text
        let half = text.hasSuffix("am") ? "am" : text.hasSuffix("pm") ? "pm" : nil
        if half != nil { text.removeLast(2) }
        let parts = text.split(separator: ":")
        guard let hour = parts.first.flatMap({ Int($0) }), parts.count <= 2 else { return nil }
        let minute = parts.count == 2 ? Int(parts[1]) : 0
        guard let minute, (0..<60).contains(minute), (0...23).contains(hour), half == nil || (1...12).contains(hour) else { return nil }
        switch half {
        case "am": return (hour == 12 ? 0 : hour, minute)
        case "pm": return (hour == 12 ? 12 : hour + 12, minute)
        default: return (hour, minute)
        }
    }
}
