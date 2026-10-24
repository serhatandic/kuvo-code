#if DEBUG
import AppKit
import SwiftUI

/// The measured runs the `KUVO_PERF_*` launch variables ask for: tab switches, the sidebar and the
/// panel shown and hidden, the sidebar scrolled, the window resized and the composer typed in,
/// each written to KUVO_PERF_LOG. Each starts ten seconds after launch, once the window has
/// settled. Debug builds only.
@MainActor
enum DemoPerf {
    /// How long after launch a run starts.
    private static let settled = DemoWait.Pace.seconds(10)

    static func start(_ environment: [String: String], app: AppModel, window: DemoWindow) {
        Task { await PerfLayers.run() }
        if let count = environment["KUVO_PERF_SWITCH"].flatMap(Int.init) { Task { await switchTabs(count, environment, app: app, window: window) } }
        if let count = environment["KUVO_PERF_TOGGLE"].flatMap(Int.init) { Task { await toggle(count, environment, window: window) } }
        if let count = environment["KUVO_PERF_SIDEBAR"].flatMap(Int.init) { Task { await scrollSidebar(count, environment) } }
        if let count = environment["KUVO_PERF_RESIZE"].flatMap(Int.init) { Task { await resize(count, environment, window: window) } }
        if let count = environment["KUVO_PERF_TYPE"].flatMap(Int.init) { Task { await type(count, environment) } }
    }

    /// A line added to KUVO_PERF_LOG.
    private static func log(_ line: String, _ environment: [String: String]) {
        guard let file = environment["KUVO_PERF_LOG"] else { return }
        if let handle = FileHandle(forWritingAtPath: file) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            FileManager.default.createFile(atPath: file, contents: Data(line.utf8))
        }
    }

    /// KUVO_PERF_SWITCH=<n>: goes to the next session tab n times, a second and a half apart, and
    /// writes how the main thread kept up.
    private static func switchTabs(_ count: Int, _ environment: [String: String], app: AppModel, window: DemoWindow) async {
        await DemoWait.pause(settled)
        // KUVO_PERF_SWITCH_CHECK: each tab's session with a draft of its own, and after each
        // switch, whether the composer shows it, and takes what's typed there.
        let check = environment["KUVO_PERF_SWITCH_CHECK"] != nil
        if check { for (index, tab) in window.tabs().enumerated() { app.workspace.model(for: tab)?.draftText = "draft \(index)" } }
        var wrong: [String] = []
        let meter = PerfMeter()
        meter.start()
        // KUVO_PERF_SWITCH_BY=<steps>: tabs to go by, in turn ("1,1,-1,-1": back and forth
        // among three), rather than always the next.
        let by = environment["KUVO_PERF_SWITCH_BY"].map { $0.split(separator: ",").compactMap { Int($0) } } ?? [1]
        for step in 0..<count {
            window.cycleTabs(by[step % by.count])
            await DemoWait.pause(.step(.milliseconds(1500)))
            if check, let id = window.selection(), let model = app.workspace.model(for: id),
               let editor = NSApp.windows.lazy.compactMap({ $0.firstResponder as? NSTextView }).first(where: \.isFieldEditor) {
                if editor.string != model.draftText { wrong.append("step \(step): shows \"\(editor.string)\", draft \"\(model.draftText)\"") }
                editor.insertText("+", replacementRange: NSRange(location: (editor.string as NSString).length, length: 0))
                await DemoWait.pause(.step(.milliseconds(100)))
                if !model.draftText.hasSuffix("+") { wrong.append("step \(step): typed, draft \"\(model.draftText)\"") }
            } else if check {
                wrong.append("step \(step): no field editor")
            }
        }
        let line = "switch x\(count) among \(window.tabs().count) tabs: " + meter.stop() + (check ? "; check: " + (wrong.isEmpty ? "all right" : wrong.prefix(6).joined(separator: "; ")) : "") + "\n"
        if let file = environment["KUVO_PERF_STALLS"] { try? meter.stallReport().write(toFile: file, atomically: true, encoding: .utf8) }
        log(line, environment)
    }

    /// KUVO_PERF_TOGGLE=<n>: the sidebar hidden and shown n times, then the panel, as their buttons
    /// do, a second apart; how the main thread kept up with the slides.
    private static func toggle(_ count: Int, _ environment: [String: String], window: DemoWindow) async {
        await DemoWait.pause(settled)
        let sidebar = PerfMeter()
        sidebar.start()
        // KUVO_PERF_TOGGLE_ONLY=panel: the panel alone (and its profile alone).
        let panelOnly = environment["KUVO_PERF_TOGGLE_ONLY"] == "panel"
        for _ in 0..<(panelOnly ? 0 : count * 2) {
            withAnimation(.ui) { window.showSidebar(!window.showsSidebar()) }
            await DemoWait.pause(.step(.seconds(1)))
        }
        if !panelOnly {
            log("toggle sidebar x\(count * 2): " + sidebar.stop() + "\n", environment)
            if let file = environment["KUVO_PERF_STALLS"] { try? sidebar.stallReport().write(toFile: file, atomically: true, encoding: .utf8) }
        }
        let panel = PerfMeter()
        panel.start()
        for _ in 0..<(count * 2) {
            withAnimation(.ui) { window.showPanel(!window.showsPanel()) }
            await DemoWait.pause(.step(.seconds(1)))
        }
        log("toggle panel x\(count * 2): " + panel.stop() + "\n", environment)
        if let file = environment["KUVO_PERF_STALLS"] { try? panel.stallReport().write(toFile: file + ".panel", atomically: true, encoding: .utf8) }
    }

    /// KUVO_PERF_SIDEBAR=<n>: the sidebar scrolled down and back up, n frames each way, as a
    /// trackpad does; then ten seconds left alone. How the main thread kept up with each.
    private static func scrollSidebar(_ count: Int, _ environment: [String: String]) async {
        await DemoWait.pause(settled)
        func scrollViews(in view: NSView) -> [NSScrollView] { ((view as? NSScrollView).map { [$0] } ?? []) + view.subviews.flatMap(scrollViews) }
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.canBecomeMain }), let content = window.contentView,
              let sidebar = scrollViews(in: content).first(where: { $0.convert($0.bounds, to: nil).minX < 60 && $0.frame.height > 200 }) else { return }
        let meter = PerfMeter()
        meter.start()
        let range = max(0, (sidebar.documentView?.frame.height ?? 0) - sidebar.contentView.bounds.height)
        // KUVO_PERF_SIDEBAR_WHEEL: by a trackpad's events (began, changed, ended), as you
        // scroll, so SwiftUI knows it's being scrolled; otherwise moved there directly.
        let wheel = environment["KUVO_PERF_SIDEBAR_WHEEL"] != nil
        func send(_ delta: CGFloat, phase: CGScrollPhase) {
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(delta), wheel2: 0, wheel3: 0) else { return }
            event.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase.rawValue))
            event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            if let ns = NSEvent(cgEvent: event) { sidebar.scrollWheel(with: ns) }
        }
        for step in 0..<(count * 2) {
            let done = Double(step < count ? step + 1 : count * 2 - step - 1) / Double(count)
            if wheel {
                let delta = (step < count ? -1.0 : 1.0) * range / Double(count)
                send(delta, phase: step == 0 || step == count ? .began : .changed)
                if step == count - 1 || step == count * 2 - 1 { send(0, phase: .ended) }
            } else {
                let clip = sidebar.contentView
                clip.scroll(to: NSPoint(x: 0, y: range * done))
                sidebar.reflectScrolledClipView(clip)
            }
            await DemoWait.pause(.step(.milliseconds(16)))
        }
        log("sidebar scroll x\(count * 2) over \(Int(range)) pt: " + meter.stop() + "\n", environment)
        // KUVO_PERF_SIDEBAR_IDLE=0: not the idle part (whose profile would replace this one's).
        guard environment["KUVO_PERF_SIDEBAR_IDLE"] != "0" else { return log("sidebar idle skipped\n", environment) }
        let idle = PerfMeter()
        idle.start()
        await DemoWait.pause(.step(.seconds(10)))
        log("sidebar idle 10 s: " + idle.stop() + "\n", environment)
    }

    /// KUVO_PERF_RESIZE=<n>: goes through the next three session tabs and back, then makes the
    /// window narrower and wider again, n frames each way; how the main thread kept up.
    private static func resize(_ count: Int, _ environment: [String: String], window: DemoWindow) async {
        await DemoWait.pause(settled)
        for by in [1, 1, 1, -3] {
            window.cycleTabs(by)
            await DemoWait.pause(.step(.milliseconds(1500)))
        }
        guard let shown = NSApp.windows.first(where: { $0.isVisible && $0.canBecomeMain }) else { return }
        let start = shown.frame
        let meter = PerfMeter()
        meter.start()
        for step in 0..<(count * 2) {
            let done = Double(step < count ? step + 1 : count * 2 - step - 1) / Double(count)
            var frame = start
            frame.size.width = start.width - 400 * done
            shown.setFrame(frame, display: true)
            await DemoWait.pause(.step(.milliseconds(16)))
        }
        let line = "resize x\(count * 2): " + meter.stop() + "\n"
        if let file = environment["KUVO_PERF_STALLS"] { try? meter.stallReport().write(toFile: file, atomically: true, encoding: .utf8) }
        log(line, environment)
    }

    /// KUVO_PERF_TYPE=<n>: types n characters into the composer, one every 60 ms; how the main
    /// thread kept up, and the longest a character took to be handled.
    private static func type(_ count: Int, _ environment: [String: String]) async {
        await DemoWait.pause(settled)
        guard let editor = NSApp.windows.lazy.compactMap({ $0.firstResponder as? NSTextView }).first(where: \.isFieldEditor) else { return }
        let meter = PerfMeter()
        meter.start()
        var longest = 0.0
        let words = Array("the quick brown fox jumps over the lazy dog and keeps on running ")
        for index in 0..<count {
            let started = CACurrentMediaTime()
            editor.insertText(String(words[index % words.count]), replacementRange: NSRange(location: (editor.string as NSString).length, length: 0))
            // Until the run loop has handled it and drawn.
            await Task.yield()
            longest = max(longest, (CACurrentMediaTime() - started) * 1000)
            await DemoWait.pause(.step(.milliseconds(60)))
        }
        log(String(format: "type x%d: longest %.0f ms; ", count, longest) + meter.stop() + "\n", environment)
    }
}
#endif
