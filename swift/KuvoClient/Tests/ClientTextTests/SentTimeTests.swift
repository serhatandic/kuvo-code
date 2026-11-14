import ClientText
import Foundation
import Testing

/// When a message was sent, as it shows beside it: the time alone today, "Yesterday" before it
/// the day before, the date further back; in full for a tooltip or VoiceOver.
struct SentTimeTests {
    let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        return calendar
    }()
    let locale = Locale(identifier: "en_US")

    /// Read with plain spaces: the formatter puts a narrow one before AM and PM.
    private func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{202F}", with: " ")
    }

    private func date(_ day: Int, _ hour: Int, _ minute: Int) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }

    @Test func todayShowsTheTimeAlone() {
        #expect(plain(SentTime.short(date(25, 9, 14), now: date(25, 18, 0), calendar: calendar, locale: locale)) == "9:14 AM")
    }

    @Test func theDayBeforeSaysYesterday() {
        // Late last night is yesterday, however few hours ago.
        #expect(plain(SentTime.short(date(24, 23, 50), now: date(25, 0, 10), calendar: calendar, locale: locale)) == "Yesterday 11:50 PM")
    }

    @Test func furtherBackShowsTheDate() {
        #expect(plain(SentTime.short(date(20, 10, 21), now: date(25, 9, 0), calendar: calendar, locale: locale)) == "Oct 20 at 10:21 AM")
    }

    @Test func stackedTheDayGoesAboveTheTime() {
        let now = date(25, 18, 0)
        let today = SentTime.split(date(25, 9, 14), now: now, calendar: calendar, locale: locale)
        #expect(today.day == nil && plain(today.time) == "9:14 AM")
        #expect(SentTime.split(date(24, 23, 50), now: now, calendar: calendar, locale: locale).day == "Yesterday")
        let older = SentTime.split(date(20, 10, 21), now: now, calendar: calendar, locale: locale)
        #expect(older.day == "Oct 20" && plain(older.time) == "10:21 AM")
    }

    @Test func inFullNamesTheDay() {
        #expect(plain(SentTime.full(date(25, 9, 14), calendar: calendar, locale: locale)) == "Sunday, October 25, 2026 at 9:14 AM")
    }
}
