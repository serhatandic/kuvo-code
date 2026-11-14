import Foundation
import Testing
@testable import OpenCodeKit

// "/loop <how often> <what to do>": what people write is read as the schedule a wake-up keeps,
// what the picker writes reads back the same, and the hint says when it first sends, on the
// computer's clock (a fixed one here: Monday 26 October 2026, 12:35, in UTC).

private let calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
}()
private let monday = calendar.date(from: DateComponents(year: 2026, month: 10, day: 26, hour: 12, minute: 35))!
private let british = Locale(identifier: "en_GB")

@Test func howOftenIsReadTheWaysPeopleWriteIt() {
    let read: [(String, Wakes.Repeat, Int?, Int?, String)] = [
        ("30m check CI", .minutes(30), nil, nil, "check CI"),
        ("every 2 hours look at the deploy", .hours(2), nil, nil, "look at the deploy"),
        ("hourly run the tests", .hours(1), nil, nil, "run the tests"),
        ("every hour run the tests", .hours(1), nil, nil, "run the tests"),
        ("every morning at 9 sum up the issues", .days(1), 9, 0, "sum up the issues"),
        ("weekdays at 8:30 standup notes", .weekdays, 8, 30, "standup notes"),
        ("every day at 2:15pm tidy the branch", .days(1), 14, 15, "tidy the branch"),
        ("daily", .days(1), 9, 0, ""),
        // By the day or week with no time: at 9.
        ("weekdays standup notes", .weekdays, 9, 0, "standup notes"),
        ("2d tidy up", .days(2), 9, 0, "tidy up"),
        ("1w sum up the week", .weeks(1), 9, 0, "sum up the week"),
        ("every week at 17 sum up the week", .weeks(1), 17, 0, "sum up the week"),
    ]
    for (typed, every, hour, minute, message) in read {
        let command = LoopCommand(typed)
        #expect(command.schedule == LoopSchedule(every: every, hour: hour, minute: minute), "\(typed)")
        #expect(command.message == message, "\(typed)")
    }
}

@Test func whatCantBeReadIsLeftAsWords() {
    // Too often for a wake-up, a time that isn't one, or no schedule at all.
    for typed in ["every 1 min ping", "every morning at 25 go", "check the deploy", ""] {
        #expect(LoopCommand(typed).schedule == nil, "\(typed)")
    }
    #expect(LoopCommand("check the deploy").message == "check the deploy")
}

@Test func theScheduleIsTheWordsBeforeTheMessage() {
    let command = LoopCommand(" every morning at 9  sum up\nthe issues")
    #expect(command.scheduleLength == " every morning at 9".utf16.count)
    #expect(command.message == "sum up\nthe issues")
    #expect(LoopCommand(" check it").scheduleLength == 0)
}

@Test func whatThePickerWritesReadsBackTheSame() {
    for schedule in LoopSchedule.presets + [LoopSchedule(every: .days(1), hour: 14, minute: 30), LoopSchedule(every: .weekdays, hour: 8, minute: 15), LoopSchedule(every: .hours(6)), LoopSchedule(every: .days(3), hour: 7, minute: 0), LoopSchedule(every: .weeks(1), hour: 9, minute: 0), LoopSchedule(every: .weeks(2), hour: 10, minute: 30)] {
        #expect(LoopCommand(schedule.phrase + " do it").schedule == schedule, "\(schedule.phrase)")
    }
    #expect(LoopSchedule.presets.map(\.title) == ["Every 5 minutes", "Every 30 minutes", "Every hour", "Every morning at 9", "Weekdays at 9"])
}

@Test func theHintSaysWhenItFirstSends() {
    #expect(LoopSchedule(every: .minutes(5)).firstPhrase(now: monday, calendar: calendar, locale: british) == "starts now")
    // The time as the locale writes it (9:00 or 09:00, by the system's version of it).
    let nine = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: monday)!
    var style = Date.FormatStyle(date: .omitted, time: .shortened, locale: british, calendar: calendar)
    style.timeZone = calendar.timeZone
    let nineWritten = nine.formatted(style)
    #expect(LoopSchedule(every: .days(1), hour: 9, minute: 0).firstPhrase(now: monday, calendar: calendar, locale: british) == "first tomorrow at \(nineWritten)")
    #expect(LoopSchedule(every: .days(1), hour: 14, minute: 30).firstPhrase(now: monday, calendar: calendar, locale: british) == "first today at 14:30")
    // A Friday afternoon's "weekdays at 9" waits for Monday.
    let friday = calendar.date(byAdding: .day, value: 4, to: monday)!
    #expect(LoopSchedule(every: .weekdays, hour: 9, minute: 0).firstPhrase(now: friday, calendar: calendar, locale: british) == "first Monday at \(nineWritten)")
    // An interval's wake-up comes one period after the message sent now.
    #expect(LoopSchedule(every: .hours(1)).firstWake(now: monday, calendar: calendar) == monday.addingTimeInterval(3600))
}
