import CryptoKit
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What this Mac's app still works out itself that a box works out too, until bots' jobs and
/// wake-ups move onto the box: a bot's job, from its memory (`Bots.job(inMemory:)`, as the agents
/// bridge's `jobInMemory` and kuvo-link.js read it), and when a repeat comes back
/// (`Wakes.Repeat.next`, as the bridge's `next` works out a meeting's). Both sides' tests check
/// against what these say (`Agents/test/box-vectors.json`). `scripts/box-vectors.sh` writes that
/// file from here and records its hash below, so a change here fails this test until it's run,
/// and the bridges' tests then say whether they still match.
@MainActor
struct BoxVectorsTests {
    static let recorded = "pending"

    @Test func aBoxReadsJobsAndRepeatsAsTheMacDoes() throws {
        let data = try JSONSerialization.data(withJSONObject: Self.vectors(), options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes])
        if let path = ProcessInfo.processInfo.environment["KUVO_WRITE_BOX_VECTORS"] {
            try data.write(to: URL(filePath: path))
            return
        }
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        #expect(hash == Self.recorded, "How a job or a repeat is read changed: run scripts/box-vectors.sh, then the bridges' tests.")
    }

    static func vectors() -> [String: Any] {
        [
            "job": memories.map { text in
                let job = Bots.job(inMemory: text)
                return ["memory": text, "line": job?.line ?? NSNull(), "section": job?.section ?? NSNull()] as [String: Any]
            },
            "next": repeatCases(),
        ]
    }

    static let memories = [
        "# Scout's memory\n\n## Job\nWatches the build\n",
        "## Job: Keeps CI green\nMore details here.\n## Notes\nx",
        "# Memory\n## My job\n- **Job:** Reviews PRs. Looks at each one carefully every morning before the standup starts.\n\n### Rules\nNever merge.\n## Other\n",
        "## Job — keeps CI green\n",
        "No job here",
        "```\n# not a heading\n```\n## Job\nInside code test\n```\n## fake\n```\nstill job\n## Next",
        "## Job (keeps the build green)\nDetails\n",
        "## Job log\nnothing",
        "#Job\nnot a heading\n## The job\n> __Plans the week.__\n",
        "## Job\n\n\n",
    ]

    /// When repeats come back, in time zones with and without daylight saving, across its changes
    /// and weekends.
    static func repeatCases() -> [[String: Any]] {
        var cases: [[String: Any]] = []
        let zones = ["Europe/Istanbul", "America/New_York", "Europe/Berlin", "Australia/Sydney", "Asia/Kolkata"]
        // Around each zone's clock changes in 2026–27, and an ordinary week.
        let moments: [String] = ["2026-10-24T07:00:00Z", "2026-10-31T13:00:00Z", "2027-03-13T14:00:00Z", "2027-03-27T06:00:00Z",
                                 "2027-04-03T15:00:00Z", "2027-01-15T09:30:00Z", "2027-01-16T20:00:00Z"]
        let iso = ISO8601DateFormatter()
        for zone in zones {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: zone)!
            for moment in moments {
                let due = iso.date(from: moment)!
                for every in ["30m", "2h", "1d", "2d", "1w", "2w", "weekdays"] {
                    let repeats = Wakes.Repeat(every)!
                    for (at, weekday) in [(nil as Int?, nil as Int?), (150, nil), (90, 2), (1439, 7)] where repeats.keepsTimeOfDay || at == nil {
                        if weekday != nil && !repeats.keepsWeekday { continue }
                        for later: TimeInterval in [60, 86_400 * 3 + 3600, 86_400 * 15] {
                            let now = due.addingTimeInterval(later)
                            let next = repeats.next(after: due, now: now, at: at, weekday: weekday, calendar: calendar)
                            var entry: [String: Any] = ["zone": zone, "every": every, "due": Int(due.timeIntervalSince1970), "now": Int(now.timeIntervalSince1970),
                                                        "next": Int(next.timeIntervalSince1970), "minutesOfDue": Wakes.minutes(of: due, calendar: calendar)]
                            if let at { entry["at"] = at }
                            if let weekday { entry["weekday"] = weekday }
                            cases.append(entry)
                        }
                    }
                }
            }
        }
        return cases
    }
}
