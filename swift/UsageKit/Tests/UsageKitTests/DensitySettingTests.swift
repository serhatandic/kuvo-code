import XCTest
@testable import UsageKit

/// Compact must be tighter than Default on every density-driven dimension — the setting's whole
/// point. A tweak that accidentally inverts or equalizes a pair would make Density "do nothing"
/// again without any compile error.
final class DensitySettingTests: XCTestCase {
    func testCompactIsTighterOnEveryDimension() {
        let spacing: [(String, KeyPath<DensitySetting, CGFloat>)] = [
            ("barRowPadding", \.barRowPadding),
            ("textRowPadding", \.textRowPadding),
            ("condensedTextRowTopPadding", \.condensedTextRowTopPadding),
            ("rowInnerSpacing", \.rowInnerSpacing),
            ("sectionSpacing", \.sectionSpacing),
            ("headerToCardSpacing", \.headerToCardSpacing),
            ("cardGutter", \.cardGutter),
            ("controlRowPadding", \.controlRowPadding),
            ("contentTopPadding", \.contentTopPadding),
            ("meterHeight", \.meterHeight),
            ("estimatedMetricRowHeight", \.estimatedMetricRowHeight),
        ]
        for (name, dimension) in spacing {
            XCTAssertLessThan(
                DensitySetting.compact[keyPath: dimension],
                DensitySetting.regular[keyPath: dimension],
                "\(name) should be tighter in Compact"
            )
        }
    }

    func testCompactStepsTypeDownOneSize() {
        let type: [(String, KeyPath<DensitySetting, CGFloat>)] = [
            ("labelPointSize", \.labelPointSize),
            ("supportingPointSize", \.supportingPointSize),
            ("headerPointSize", \.headerPointSize),
            ("planBadgePointSize", \.planBadgePointSize),
        ]
        for (name, size) in type {
            XCTAssertEqual(
                DensitySetting.compact[keyPath: size],
                DensitySetting.regular[keyPath: size] - 1,
                "\(name) should be exactly one point down in Compact"
            )
        }
        XCTAssertEqual(DensitySetting.compact.headerIconSize, DensitySetting.regular.headerIconSize - 2)
    }

    func testSectionSpacingStaysWiderThanRowRhythm() {
        // Groups must still read as groups: the section gap has to clearly beat the in-card step.
        for density in DensitySetting.allCases {
            XCTAssertGreaterThan(density.sectionSpacing, density.textRowPadding)
            XCTAssertGreaterThan(density.sectionSpacing, density.headerToCardSpacing)
        }
    }
}
