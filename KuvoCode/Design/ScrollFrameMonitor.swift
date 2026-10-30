#if DEBUG
import AppKit
import os

/// While the conversation scrolls, counts the frames that came late and the rows and code blocks
/// made meanwhile, and logs them when it stops: scrolling measured where it's seen, on screen.
/// Debug builds only; read it with
/// `log show --last 1h --predicate 'subsystem == "run.kuvo.code" AND category == "scroll"'`.
final class ScrollFrameMonitor: NSObject {
    static let shared = ScrollFrameMonitor()

    /// Made since launch, counted as they appear.
    static var rowsMade = 0
    static var codeBlocksMade = 0
    static var piecesMade = 0
    /// Rows made, by row.
    static var rowsMadeByID: [String: Int] = [:]
    /// The sidebar's body worked out, and its rows' (`KUVO_PERF_TOGGLE` says how many a toggle
    /// of the panel took, which should be none).
    static var sidebarBodies = 0
    static var sidebarRowBodies = 0

    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private var began: CFTimeInterval = 0
    private var interval: CFTimeInterval = 1.0 / 60
    private var frames = 0
    private var late = 0
    private var dropped = 0
    private var worst: CFTimeInterval = 0
    private var rows = 0
    private var codeBlocks = 0
    private let log = Logger(subsystem: "run.kuvo.code", category: "scroll")

    func scrolling(_ isOn: Bool) {
        isOn ? start() : stop()
    }

    private func start() {
        guard link == nil, let view = NSApp.keyWindow?.contentView ?? NSApp.mainWindow?.contentView else { return }
        let link = view.displayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
        last = 0
        began = CACurrentMediaTime()
        frames = 0
        late = 0
        dropped = 0
        worst = 0
        rows = Self.rowsMade
        codeBlocks = Self.codeBlocksMade
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        if link.duration > 0 { interval = link.duration }
        if last > 0 {
            let gap = now - last
            frames += 1
            worst = max(worst, gap)
            // A frame and a half or more: at least one was missed.
            if gap > interval * 1.5 {
                late += 1
                dropped += max(Int((gap / interval).rounded()) - 1, 1)
            }
        }
        last = now
    }

    private func stop() {
        guard let link else { return }
        link.invalidate()
        self.link = nil
        guard frames > 0 else { return }
        let seconds = CACurrentMediaTime() - began
        let hertz = Int((1 / interval).rounded())
        log.notice("scrolled \(seconds, format: .fixed(precision: 2), privacy: .public) s: \(self.frames, privacy: .public) frames at \(hertz, privacy: .public) Hz, \(self.late, privacy: .public) late, \(self.dropped, privacy: .public) missed, worst \(Int(self.worst * 1000), privacy: .public) ms; \(Self.rowsMade - self.rows, privacy: .public) rows and \(Self.codeBlocksMade - self.codeBlocks, privacy: .public) code blocks made")
    }
}
#endif
