import ClientSessions
import Foundation
import Testing

/// The days along a long goal's axis: each gets its own label where it has room, else one every few
/// days counted out from Today, never so close that two labels run into each other, and a week
/// apart (on Today's weekday) once the days are that narrow. A goal of hours labels its hours the
/// same way. The room is the Mac's (a date's label 56 points, a day of its own from 52); the
/// phone gives its own.
@MainActor
struct GoalDayLabelsTests {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        return calendar
    }()

    /// The days of a window `count` days long, Today `todayAt` days in.
    private func days(_ count: Int, todayAt: Int) -> (days: [Date], now: Date) {
        let first = calendar.date(from: DateComponents(year: 2026, month: 10, day: 5))!
        let days = (0..<count).map { calendar.date(byAdding: .day, value: $0, to: first)! }
        return (days, days[todayAt].addingTimeInterval(14 * 3600))
    }

    /// The axis drawn across the room the bar has, as the bar draws it.
    private func labeled(_ count: Int, todayAt: Int, room: CGFloat = 900) -> (labeled: [Date], dayWidth: CGFloat, now: Date) {
        let (days, now) = days(count, todayAt: todayAt)
        let dayWidth = room / CGFloat(count)
        let set = GoalChart.labeledDays(days, dayWidth: dayWidth, week: count <= 7, now: now, room: 56, everyDay: 52, calendar: calendar)
        return (days.filter(set.contains), dayWidth, now)
    }

    @Test func aWeekLabelsEveryDay() {
        let (labeled, _, _) = labeled(7, todayAt: 3)
        #expect(labeled.count == 7)
    }

    @Test func twoWeeksAcrossTheBarLabelEveryDayTheyHaveRoomFor() {
        let (labeled, dayWidth, _) = labeled(14, todayAt: 5)
        #expect(dayWidth >= 52)
        #expect(labeled.count == 14)
    }

    @Test func twoMonthsLabelEveryFewDaysClearOfEachOtherAndCountedFromToday() {
        let (labeled, dayWidth, now) = labeled(61, todayAt: 20)
        #expect(labeled.count > 4)
        #expect(labeled.contains { calendar.isDate($0, inSameDayAs: now) })
        for (a, b) in zip(labeled, labeled.dropFirst()) {
            let apart = calendar.dateComponents([.day], from: a, to: b).day!
            #expect(CGFloat(apart) * dayWidth >= 56, "labels \(apart) days apart run into each other")
            #expect(apart < 7, "two months across the bar have room for more than one label a week")
        }
    }

    @Test func sixMonthsLabelWholeWeeksOnTodaysWeekday() {
        let (labeled, dayWidth, now) = labeled(182, todayAt: 90)
        let weekday = calendar.component(.weekday, from: now)
        #expect(labeled.count > 4)
        for day in labeled {
            #expect(calendar.component(.weekday, from: day) == weekday)
        }
        for (a, b) in zip(labeled, labeled.dropFirst()) {
            let apart = calendar.dateComponents([.day], from: a, to: b).day!
            #expect(apart % 7 == 0)
            #expect(CGFloat(apart) * dayWidth >= 56)
        }
    }

    @Test func withTodayOutsideTheWindowTheLabelsCountFromItsFirstDay() {
        let (days, _) = days(61, todayAt: 0)
        let set = GoalChart.labeledDays(days, dayWidth: 900 / 61, week: false, now: days[0].addingTimeInterval(-90 * 86400), room: 56, everyDay: 52,
                                        calendar: calendar)
        #expect(set.contains(days[0]))
    }

    @Test func hoursAcrossANarrowAxisLabelEveryFewClearOfEachOtherAndEachWhereThereIsRoom() {
        let first = calendar.date(from: DateComponents(year: 2026, month: 11, day: 4, hour: 3))!
        let hours = (0..<8).map { first.addingTimeInterval(Double($0) * 3600) }
        // Eight hours over a narrow pane: about 35 points an hour, too close for every one.
        let narrow = hours.filter(GoalChart.labeledHours(hours, hourWidth: 35).contains)
        #expect(narrow.count > 2)
        #expect(narrow.first == hours.first)
        for (a, b) in zip(narrow, narrow.dropFirst()) {
            #expect(CGFloat(b.timeIntervalSince(a) / 3600) * 35 >= 44, "hour labels run into each other")
        }
        #expect(GoalChart.labeledHours(hours, hourWidth: 90).count == 8)
    }
}
