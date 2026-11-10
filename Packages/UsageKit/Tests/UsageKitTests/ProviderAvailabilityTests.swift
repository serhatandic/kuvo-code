import XCTest
@testable import UsageKit

/// Fork addition: providers with no login (or no usage to read) leave the dashboard, the menu bar and
/// Total Spend, and come back once a refresh succeeds.
@MainActor
final class ProviderAvailabilityTests: XCTestCase {
    private func makeDefaults() -> UserDefaults {
        let name = "UsageKitTests.ProviderAvailability.\(UUID().uuidString)"
        let defaults = testDefaults(suiteName: name)!
        return defaults
    }

    func testNoLoginOrNoUsageHidesAndASuccessBringsItBack() {
        let availability = ProviderAvailability(defaults: makeDefaults())
        XCTAssertTrue(availability.isAvailable("cursor"))

        availability.record("cursor", succeeded: false, category: .notLoggedIn)
        XCTAssertFalse(availability.isAvailable("cursor"))
        XCTAssertEqual(availability.note(for: "cursor"), "Not signed in on this Mac")

        availability.record("codex", succeeded: false, category: .notAvailable)
        XCTAssertFalse(availability.isAvailable("codex"))
        XCTAssertEqual(availability.note(for: "codex"), "No usage to show for this account")

        availability.record("cursor", succeeded: true, category: nil)
        XCTAssertTrue(availability.isAvailable("cursor"))
        XCTAssertNil(availability.note(for: "cursor"))
    }

    func testOtherFailuresLeaveItAsItWas() {
        let availability = ProviderAvailability(defaults: makeDefaults())
        for category in [ErrorCategory.network, .authExpired, .http5xx, .rateLimited] {
            availability.record("claude", succeeded: false, category: category)
            XCTAssertTrue(availability.isAvailable("claude"), "\(category) is worth seeing, not hiding")
        }
        availability.record("claude", succeeded: false, category: .notLoggedIn)
        availability.record("claude", succeeded: false, category: .network)
        XCTAssertFalse(availability.isAvailable("claude"), "a network failure doesn't prove a login appeared")
    }

    func testOnlyProvidersConnectedInTheHostAreFollowed() {
        let defaults = makeDefaults()
        let availability = ProviderAvailability(defaults: defaults)
        XCTAssertTrue(availability.isAvailable("claude"), "until the host says, nothing is left out")

        XCTAssertEqual(availability.setConnected(["codex", "copilot"]), ["codex", "copilot"])
        XCTAssertFalse(availability.isAvailable("claude"), "Claude Code signed in on the Mac isn't an account connected here")
        XCTAssertTrue(availability.note(for: "claude")?.hasPrefix("Not connected in") == true)
        XCTAssertTrue(availability.isAvailable("codex"))
        XCTAssertTrue(availability.isAvailable("codex@work"), "every account of a connected provider")

        XCTAssertEqual(availability.setConnected(["codex", "copilot", "openrouter"]), ["openrouter"], "only the new one turns on")
        XCTAssertEqual(availability.setConnected(["codex", "copilot", "openrouter"]), [])
        XCTAssertFalse(ProviderAvailability(defaults: defaults).isAvailable("claude"), "remembered at the next launch")
    }

    func testItIsRememberedAcrossLaunches() {
        let defaults = makeDefaults()
        ProviderAvailability(defaults: defaults).record("grok", succeeded: false, category: .notLoggedIn)
        XCTAssertFalse(ProviderAvailability(defaults: defaults).isAvailable("grok"))
    }

    func testTheLayoutLeavesOutProvidersItIsntShown() {
        let defaults = makeDefaults()
        let store = LayoutStore(registry: .from([AntigravityProvider()]), defaults: defaults, storageKey: "layout")
        XCTAssertFalse(store.displayGroups.isEmpty)
        XCTAssertTrue(store.hasSpendCapableProvider)

        store.isProviderShown = { $0 != "antigravity" }
        XCTAssertTrue(store.displayGroups.isEmpty)
        XCTAssertFalse(store.hasSpendCapableProvider)
        XCTAssertTrue(store.pinnedGroups.isEmpty)
        XCTAssertTrue(store.customizeProviderRows.allSatisfy(\.isEnabled), "Customize still shows it as turned on")
    }
}
