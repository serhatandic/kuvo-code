import XCTest
@testable import UsageKit

@MainActor
final class AntigravityHostedTests: XCTestCase {
    func testCardUsesOnlyBoxAccountsEvenBeforeCoverageArrives() async {
        let limits = HostLimits.shared
        let history = HostHistory.shared
        let oldRows = limits.rows, oldCoverage = limits.covered
        let oldDays = history.days, oldHistoryCoverage = history.covered
        defer {
            limits.update(rows: oldRows, covered: oldCoverage)
            history.update(days: oldDays, covered: oldHistoryCoverage)
        }
        limits.update(rows: [], covered: [])
        history.update(days: [:], covered: [])
        let card = AntigravityProvider()
        let absent = await card.hasLocalCredentials()
        XCTAssertFalse(absent)
        let snapshot = await card.refresh()
        XCTAssertNil(snapshot.usageHistory)
        limits.update(rows: [.init(id: "antigravity#fixture", providerID: "antigravity", name: "Antigravity", meters: [], notice: "Language server unavailable", isLocal: false)], covered: ["antigravity"])
        let present = await card.hasLocalCredentials()
        XCTAssertTrue(present)
        XCTAssertTrue(HostLimits.limitsOnlyFromHost.contains("antigravity"))
    }
}
