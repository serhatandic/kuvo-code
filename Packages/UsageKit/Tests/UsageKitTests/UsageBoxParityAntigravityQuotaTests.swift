import XCTest
@testable import UsageKit

final class UsageBoxParityAntigravityQuotaTests: XCTestCase {
    func testQuotaSummaryMatchesBoxFixtures() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Box/test/fixtures/usage/antigravity-plan-cases.json")
        let cases = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        for each in cases {
            let name = each["name"] as? String ?? ""
            let bodies = try XCTUnwrap(each["bodies"] as? [Any]).map { try JSONSerialization.data(withJSONObject: $0) }
            let actual = AntigravityUsageMapper.parseQuotaSummaries(bodies)
            guard let expected = each["expected"] as? [[String: Any]] else {
                XCTAssertNil(actual, name)
                continue
            }
            let lines = try XCTUnwrap(actual, name)
            XCTAssertEqual(lines.count, expected.count, name)
            for (line, row) in zip(lines, expected) {
                guard case .progress(let label, let used, _, _, _, let period, _) = line else {
                    XCTFail(name); continue
                }
                XCTAssertEqual(label, row["label"] as? String, name)
                XCTAssertEqual(used, (row["used"] as? NSNumber)?.doubleValue, name)
                XCTAssertEqual(period, (row["periodMs"] as? NSNumber)?.intValue, name)
            }
        }
    }
    func testLegacyPoolsAndPlanNamesMatchBoxFixtures() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Box/test/fixtures/usage/antigravity-legacy-plan-cases.json")
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        for each in try XCTUnwrap(fixture["legacy"] as? [[String: Any]]) {
            let configs = try XCTUnwrap(each["configs"] as? [[String: Any]]).map { row in
                let quota = row["quotaInfo"] as? [String: Any]
                return AntigravityModelConfig(label: row["label"] as? String ?? "", modelID: row["modelID"] as? String,
                    remainingFraction: quota?["remainingFraction"] as? Double ?? 0, resetTime: nil)
            }
            let expected = try XCTUnwrap(each["expected"] as? [[String: Any]])
            let actual = AntigravityUsageMapper.buildLines(configs)
            XCTAssertEqual(actual.count, expected.count)
            for (line, row) in zip(actual, expected) {
                guard case .progress(let label, let used, _, _, _, let period, _) = line else { XCTFail(); continue }
                XCTAssertEqual(label, row["label"] as? String)
                XCTAssertEqual(used, (row["used"] as? NSNumber)?.doubleValue)
                XCTAssertEqual(period, (row["periodMs"] as? NSNumber)?.intValue)
            }
        }
        for each in try XCTUnwrap(fixture["plans"] as? [[String: Any]]) {
            XCTAssertEqual(AntigravityUsageMapper.formatPlan(each["input"] as? String), each["expected"] as? String)
        }
    }

}
