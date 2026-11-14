import XCTest
@testable import UsageKit

final class PlanLimitsTests: XCTestCase {
    func testKeepsBoundedRowsInOrderAsFractions() throws {
        let reset = Date(timeIntervalSince1970: 1_800_000_000)
        let snapshot = ProviderSnapshot(
            providerID: "codex",
            displayName: "Codex",
            plan: "Plus",
            lines: [
                .progress(label: "Session", used: 9, limit: 100, format: .percent, resetsAt: reset),
                .text(label: "Note", value: "ignored"),
                .progress(label: "Credits", used: 3, limit: 12, format: .dollars),
                .progress(label: "Over", used: 140, limit: 100, format: .percent),
            ]
        )

        let limits = try XCTUnwrap(PlanLimits(snapshot))

        XCTAssertEqual(limits.providerName, "Codex")
        XCTAssertEqual(limits.plan, "Plus")
        XCTAssertEqual(limits.limits.map(\.label), ["Session", "Credits", "Over"])
        XCTAssertEqual(limits.limits[0].fraction, 0.09, accuracy: 0.0001)
        XCTAssertEqual(limits.limits[0].resetsAt, reset)
        XCTAssertEqual(limits.limits[1].fraction, 0.25, accuracy: 0.0001)
        XCTAssertEqual(limits.limits[2].fraction, 1)
    }

    func testNothingForFailedReadsOrProvidersWithoutLimits() {
        let failed = ProviderSnapshot(
            providerID: "copilot",
            displayName: "Copilot",
            lines: [.badge(label: MetricLine.errorBadgeLabel, text: "Not signed in")],
            errorCategory: .other
        )
        let balanceOnly = ProviderSnapshot(
            providerID: "openrouter",
            displayName: "OpenRouter",
            lines: [.text(label: "Balance", value: "$4.20")]
        )

        XCTAssertNil(PlanLimits(failed))
        XCTAssertNil(PlanLimits(balanceOnly))
    }
}
