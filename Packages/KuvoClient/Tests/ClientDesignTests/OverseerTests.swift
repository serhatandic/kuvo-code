#if os(macOS)
import AppKit
import SwiftUI
import Testing
@testable import ClientDesign

/// A bot's lanes and faces over a project in a sidebar, in a window as an app shows them: still at
/// rest, with no animation on any of their layers (a sidebar of watched projects costs nothing
/// while nothing happens); a light runs down the lane as the bot does something, once however
/// often the view is drawn again (with Reduce Motion, only the elbow lights), and a finished
/// session pleases the bot's face once.
@MainActor
@Suite(.serialized) struct OverseerTests {
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 280, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
    let pixel = BotLook(color: .sky, shape: .round, face: .calm)

    private var lane: OverseerLane {
        OverseerLane(bot: "pixel", look: pixel, paused: false, x: 19, top: 25, bottom: 115, elbows: ["ses_core": 49, "ses_icons": 115], reach: 32)
    }

    /// With Reduce Motion as `still` says, not as the Mac has it: GitHub's macOS runners have it on.
    private func host(_ view: some View, still: Bool = false) -> NSHostingView<AnyView> {
        let hosting = NSHostingView(rootView: shown(view, still: still))
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        return hosting
    }

    private func shown(_ view: some View, still: Bool = false) -> AnyView {
        AnyView(view.frame(width: 280, height: 200).environment(\._accessibilityReduceMotion, still))
    }

    private func find<View: NSView>(_ type: View.Type, in view: NSView) -> View? {
        if let found = view as? View { return found }
        for child in view.subviews {
            if let found = find(type, in: child) { return found }
        }
        return nil
    }

    /// Every animation on a layer under `layer`.
    private func animations(under layer: CALayer?) -> [String] {
        guard let layer else { return [] }
        return (layer.animationKeys() ?? []) + (layer.sublayers ?? []).flatMap { animations(under: $0) }
    }

    @Test func aWatchedProjectAtRestHasNothingMoving() throws {
        let hosting = host(HStack {
            OverseerFace(look: pixel, size: 20, pose: .rest)
            OverseerLanes(lanes: [lane], lights: [])
        })
        let lights = try #require(find(OverseerLightsView.self, in: hosting))
        let face = try #require(find(OverseerFaceView.self, in: hosting))
        #expect(lights.playing == 0)
        #expect(animations(under: lights.layer).isEmpty)
        #expect(animations(under: face.layer).isEmpty)
    }

    @Test func aLightRunsDownTheLaneOnceAsTheBotDoesSomething() throws {
        let read = OverseerLight(id: "m1", bot: "pixel", session: "ses_icons")
        let hosting = host(OverseerLanes(lanes: [lane], lights: [read]))
        let lights = try #require(find(OverseerLightsView.self, in: hosting))
        // The light on its way, and the elbow it lights.
        #expect(lights.playing == 3)
        #expect(!animations(under: lights.layer).isEmpty)

        // Drawn again (another session changed, say): the same mark isn't played again.
        hosting.rootView = shown(OverseerLanes(lanes: [lane], lights: [read]))
        hosting.layoutSubtreeIfNeeded()
        #expect(lights.playing == 3)

        // One for a bot with no lane here plays nothing.
        hosting.rootView = shown(OverseerLanes(lanes: [lane], lights: [read, OverseerLight(id: "m2", bot: "ada", session: "ses_core")]))
        hosting.layoutSubtreeIfNeeded()
        #expect(lights.playing == 3)
    }

    @Test func withReduceMotionOnlyTheElbowLights() throws {
        let read = OverseerLight(id: "m1", bot: "pixel", session: "ses_icons")
        let hosting = host(OverseerLanes(lanes: [lane], lights: [read]), still: true)
        let lights = try #require(find(OverseerLightsView.self, in: hosting))
        // The elbow and where it meets the title, with no light running down to them.
        #expect(lights.playing == 2)
    }

    @Test func aFinishedSessionPleasesItsBotOnce() throws {
        let hosting = host(OverseerFace(look: pixel, size: 20, pose: .rest))
        let face = try #require(find(OverseerFaceView.self, in: hosting))
        hosting.rootView = shown(OverseerFace(look: pixel, size: 20, pose: .rest, pleased: "m2"))
        hosting.layoutSubtreeIfNeeded()
        #expect(animations(under: face.layer) == ["pleased"])
    }
}
#endif
