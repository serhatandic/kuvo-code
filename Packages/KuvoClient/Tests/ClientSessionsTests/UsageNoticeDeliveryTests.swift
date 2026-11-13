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
}
