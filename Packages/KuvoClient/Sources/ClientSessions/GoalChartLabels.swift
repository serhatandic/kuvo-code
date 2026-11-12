import Foundation

/// Which marks along a goal's timeline axis get a label, in both apps: each app gives the room its
/// own labels take, as its own fonts draw them.
extension GoalChart {
    /// The hours that get a label: each where it has room for its time, else every second, third…
    /// counted from the first, so no two run into each other on a narrow axis.
    public static func labeledHours(_ hours: [Date], hourWidth: CGFloat, room: CGFloat = 44) -> Set<Date> {
        let step = hourWidth > 0 ? max(1, Int((room / hourWidth).rounded(.up))) : max(hours.count, 1)
        return Set(hours.enumerated().compactMap { $0.offset % step == 0 ? $0.element : nil })
    }

    /// The days that get a label of their own: every day across a week or where each has room for
    /// its date (a day `everyDay` wide or more); else one every few days, `room` apart at least,
    /// counted out from Today (or the first day) so the labels keep clear of it and of each other,
    /// and a week apart once that's most of a week.
    public static func labeledDays(_ days: [Date], dayWidth: CGFloat, week: Bool, now: Date, room: CGFloat, everyDay: CGFloat,
                                   calendar: Calendar = .current) -> Set<Date> {
        let fit = dayWidth > 0 ? Int((room / dayWidth).rounded(.up)) : 7
        let step = week || dayWidth >= everyDay ? 1 : fit >= 5 ? 7 * Int((Double(fit) / 7).rounded(.up)) : max(fit, 1)
        let origin = calendar.startOfDay(for: days.contains { calendar.isDate($0, inSameDayAs: now) } ? now : days.first ?? now)
        return Set(days.filter { day in
            (calendar.dateComponents([.day], from: origin, to: calendar.startOfDay(for: day)).day ?? 1) % step == 0
        })
    }
}
