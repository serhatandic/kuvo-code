import Foundation
import Testing

/// Reduce Motion (System Settings › Accessibility › Display) as this process sees it, whatever
/// the Mac's own setting, which is never changed. Off for every test, as most Macs have it, so a
/// test runs the same on any Mac: GitHub's runners have it on, and there SwiftUI shows at once
/// what slides in, so the tests of a slide saw none. On for a test with the `.reduceMotion` trait.
@MainActor enum ReduceMotion {
    private typealias Override = @convention(c) (Int) -> Void

    /// HIServices' override for this process, which AppKit and SwiftUI read in place of the
    /// Mac's setting: 0 that setting, 1 on, 2 off.
    private static let override: Override? = {
        let services = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_NOW)
        return dlsym(services, "_AXInterfaceSetReduceMotionEnabledOverride").map { unsafeBitCast($0, to: Override.self) }
    }()

    /// Set by a test (its trait) already.
    private static var isChosen = false

    /// Off, unless a test already chose: one with the trait can be the run's first, and set it
    /// before its suite's `init` prepares the tests' environment.
    static func offUnlessChosen() {
        if !isChosen { set(false) }
    }

    /// Sets it for this process; false if macOS has no way to here.
    @discardableResult static func set(_ isOn: Bool) -> Bool {
        isChosen = true
        guard let override else { return false }
        override(isOn ? 1 : 2)
        return true
    }
}

/// Reduce Motion on for the whole test, its suite's window made with it too: SwiftUI reads it as
/// it makes the window's views, so turned on in the test, after that, it changed nothing there.
struct ReduceMotionTrait: TestTrait, TestScoping {
    @concurrent func provideScope(for test: Test, testCase: Test.Case?, performing function: @concurrent @Sendable () async throws -> Void) async throws {
        guard await ReduceMotion.set(true) else {
            Issue.record("macOS has no way to turn Reduce Motion on for this process only")
            return
        }
        do {
            try await function()
        } catch {
            await ReduceMotion.set(false)
            throw error
        }
        await ReduceMotion.set(false)
    }
}

extension Trait where Self == ReduceMotionTrait {
    /// The test, and its suite's window, with Reduce Motion on.
    static var reduceMotion: Self { Self() }
}
