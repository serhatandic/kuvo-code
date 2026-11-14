import AppKit

/// The start of the screen's next frame, for work that changes what's drawn many times a second
/// (a reply being written): begun there, it has the whole frame to be done in before the screen
/// is drawn. Begun wherever a timer happened to wake, a third of a frame's time could be left,
/// and an update taking more than that came a frame late: about one in five as a reply streamed.
@MainActor final class FrameClock: NSObject {
    static let shared = FrameClock()

    private var link: CADisplayLink?
    private var waiting: [CheckedContinuation<Void, Never>] = []

    /// Returns as the next frame begins (at once with no screen to time it by).
    func nextFrame() async {
        guard let link = link ?? makeLink() else { return }
        await withCheckedContinuation { continuation in
            waiting.append(continuation)
            link.isPaused = false
        }
    }

    private func makeLink() -> CADisplayLink? {
        guard let screen = NSScreen.main else { return nil }
        let link = screen.displayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        link.isPaused = true
        self.link = link
        return link
    }

    @objc private func tick(_ link: CADisplayLink) {
        let ready = waiting
        waiting = []
        for continuation in ready { continuation.resume() }
        // Only while something waits: a display link left running wakes the app every frame.
        if waiting.isEmpty { link.isPaused = true }
    }
}
