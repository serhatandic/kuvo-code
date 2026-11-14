import ClientSessions
import Foundation
import Testing

@MainActor
struct UsageNoticeDeliveryTests {
    @Test func idsSurviveRelaunchAndAreSharedAcrossBoxes() async throws {
        let name = "UsageNoticeDeliveryTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let delivery = UsageNoticeDelivery(defaults: defaults)
        var count = 0
        await delivery.deliver(id: "notice-1") { count += 1; return true }
        await delivery.deliver(id: "notice-1") { count += 1; return true }
        let relaunched = UsageNoticeDelivery(defaults: defaults)
        await relaunched.deliver(id: "notice-1") { count += 1; return true }
        await relaunched.deliver(id: "notice-2") { count += 1; return true }
        #expect(count == 2)
    }

    @Test func failedDeliveryCanRetry() async throws {
        let name = "UsageNoticeDeliveryTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let delivery = UsageNoticeDelivery(defaults: defaults)
        var attempts = 0
        await delivery.deliver(id: "notice-1") { attempts += 1; return false }
        await delivery.deliver(id: "notice-1") { attempts += 1; return true }
        await delivery.deliver(id: "notice-1") { attempts += 1; return true }
        #expect(attempts == 2)
    }

    @Test func simultaneousReadsReserveTheIdBeforeScheduling() async throws {
        let name = "UsageNoticeDeliveryTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let delivery = UsageNoticeDelivery(defaults: defaults)
        var attempts = 0
        await delivery.deliver(id: "notice-1") {
            attempts += 1
            await delivery.deliver(id: "notice-1") { attempts += 1; return true }
            return true
        }
        #expect(attempts == 1)
    }
    @Test func disabledNotificationsConsumeIdsWithoutAnEnableBacklog() async throws {
        let name = "UsageNoticeDeliveryTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let delivery = UsageNoticeDelivery(defaults: defaults)
        var attempts = 0
        await delivery.deliver(id: "while-off", enabled: false) { attempts += 1; return true }
        await UsageNoticeDelivery(defaults: defaults).deliver(id: "while-off") { attempts += 1; return true }
        #expect(attempts == 0)
        await delivery.deliver(id: "after-on") { attempts += 1; return true }
        #expect(attempts == 1)
    }

    @Test func timestampedReceiptsExpireAfterADay() async throws {
        let name = "UsageNoticeDeliveryTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set(["old": Date().timeIntervalSince1970 - 2 * 86_400, "recent": Date().timeIntervalSince1970], forKey: "usage.notices.shown")
        let delivery = UsageNoticeDelivery(defaults: defaults)
        var posted: [String] = []
        await delivery.deliver(id: "recent") { posted.append("recent"); return true }
        await delivery.deliver(id: "old") { posted.append("old"); return true }
        #expect(posted == ["old"])
    }

    @Test func migrationClockRollbackAndSilentDeliveryDoNotReplay() async throws {
        let name = "UsageNoticeDeliveryTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        var clock = Date(timeIntervalSince1970: 200000)
        defaults.set(["legacy"], forKey: "usage.notices.shown")
        let delivery = UsageNoticeDelivery(defaults: defaults, now: { clock })
        var attempts = 0
        #expect(await delivery.deliver(id: "legacy") { attempts += 1; return true })
        clock = clock.addingTimeInterval(-3600)
        #expect(await delivery.deliver(id: "legacy") { attempts += 1; return true })
        #expect(!(await delivery.deliver(id: "silent", visible: { false }) { attempts += 1; return true }))
        #expect(!(await delivery.deliver(id: "silent") { attempts += 1; return true }))
        #expect(attempts == 1)
        clock = clock.addingTimeInterval(86401)
        _ = await delivery.deliver(id: "new") { true }
        #expect(defaults.dictionary(forKey: "usage.notices.shown")?.count == 1)
    }

}
