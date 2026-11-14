import Foundation
import XCTest
@testable import UsageKit

@MainActor
final class UsageAlertAvailabilityTests: XCTestCase {
    func testOnlyActiveProviderCaptionsComeFromTheBox() {
        let availability = UsageAlertAvailability()
        availability.apply(Data(#"[{"provider":"unsupported","available":false,"message":"Box explanation"},{"provider":"supported","available":true,"message":"Hidden"}]"#.utf8))
        XCTAssertEqual(availability.messages(for: ["other"]), [])
        XCTAssertEqual(availability.messages(for: ["supported"]), [])
        XCTAssertEqual(availability.messages(for: ["unsupported@12345678"]), ["Box explanation"])
        availability.apply(Data("[]".utf8))
        XCTAssertEqual(availability.messages(for: ["unsupported"]), [])
    }
}
