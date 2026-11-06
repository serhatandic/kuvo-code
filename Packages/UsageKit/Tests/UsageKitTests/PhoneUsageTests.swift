import AppKit
import XCTest
@testable import UsageKit

/// The usage panel for the host's phones (fork addition): the marks it sends.
@MainActor
final class PhoneUsageTests: XCTestCase {
    func testMarksArePNGsSixtyFourSquare() throws {
        for id in ["claude", "codex", "cursor", "copilot", "a-provider-without-a-mark"] {
            let encoded = try XCTUnwrap(UsageMenuBar.phoneMark(for: id), id)
            let data = try XCTUnwrap(Data(base64Encoded: encoded), id)
            let image = try XCTUnwrap(NSBitmapImageRep(data: data), id)
            XCTAssertEqual(image.pixelsWide, 64, id)
            XCTAssertEqual(image.pixelsHigh, 64, id)
            XCTAssertTrue(image.hasAlpha, id)
            // Something drawn, and clear around it.
            let alphas = (0..<64).flatMap { y in (0..<64).map { x in image.colorAt(x: x, y: y)?.alphaComponent ?? 0 } }
            XCTAssertTrue(alphas.contains { $0 > 0.5 }, id)
            XCTAssertTrue(alphas.contains { $0 < 0.01 }, id)
        }
    }

    func testALineJSONCantCarryLeavesTheOthers() {
        let good = MetricLine.progress(label: "Weekly", used: 62, limit: 100, format: .percent)
        let bad = MetricLine.progress(label: "Session", used: .infinity, limit: 0, format: .percent)
        XCTAssertEqual(UsageMenuBar.phoneLines([bad, good, .values(label: "Spend", values: [MetricValue(number: .nan, kind: .dollars)])]), [good])
    }

    func testNoUsageBeforeThePanelIsUp() {
        XCTAssertNil(UsageMenuBar.shared.phoneUsage())
        XCTAssertFalse(UsageMenuBar.shared.refreshAll())
    }
}
