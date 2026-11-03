import Foundation

/// When a message was sent, as both apps say it beside the message: "9:14" today,
/// "Yesterday 9:14", then "Oct 25 at 10:21"; in full ("Saturday, October 25, 2026 at 10:21") where
/// there's room, as a tooltip or for VoiceOver.
public enum SentTime {
    public static func short(_ date: Date, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String {
        var calendar = calendar
        calendar.locale = locale
        let (day, time) = split(date, now: now, calendar: calendar, locale: locale)
        guard let day else { return time }
        if day == "Yesterday" { return "Yesterday " + time }
        return date.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day().hour().minute())
    }

    /// The day and the time apart, for a narrow slot that stacks them: no day today, "Yesterday"
    /// the day before, then "Oct 25".
    public static func split(_ date: Date, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> (day: String?, time: String) {
        var calendar = calendar
        calendar.locale = locale
        let time = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone))
        let day = calendar.startOfDay(for: now)
        if calendar.isDate(date, inSameDayAs: day) { return (nil, time) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: day), calendar.isDate(date, inSameDayAs: yesterday) { return ("Yesterday", time) }
        return (date.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day()), time)
    }

    public static func full(_ date: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        date.formatted(Date.FormatStyle(date: .complete, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone))
    }
}
