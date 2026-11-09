import AppKit
import CoreGraphics
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// The sidebar's computers by name, above their pages, on one line as the phone's strip has them
/// (#232): the one in view first, the others after it in turn (past the last, the first again),
/// as many as show whole, and "+3" for the rest; picking one brings it first. A name too long for
/// the line is cut at its end, never in the middle. Read as VoiceOver reads it, in a window of the
/// test's own: the names it finds are those that show whole, left to right.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BoxStripTests {
    let app = AppModel()

    init() { TestEnvironment.prepare() }

    @Observable final class Picked {
        var box: SidebarBox
        init(_ box: SidebarBox) { self.box = box }
    }

    private struct Host: View {
        let boxes: [SidebarBox]
        @Bindable var picked: Picked

        var body: some View {
            BoxNameStrip(boxes: boxes, selected: $picked.box)
        }
    }

    /// The strip, `width` wide, over `names`' machines (stand-ins with no engine, so each is as a
    /// connected one is), the one at `inView` picked.
    final class Strip {
        let window: NSWindow
        let picked: Picked
        let names: [String]

        /// `beside`: room past the strip's end, as the window's other cards have beside the sidebar.
        init(app: AppModel, names: [String], width: CGFloat, inView: Int = 0, beside: CGFloat = 0) {
            AXElement.reading(true)
            self.names = names
            let boxes = names.map { SidebarBox.machine($0) }
            picked = Picked(boxes[inView])
            window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: width + beside, height: 60), styleMask: [.titled], backing: .buffered,
                              defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: Host(boxes: boxes, picked: picked).environment(app)
                .frame(width: width, height: 60, alignment: .topLeading)
                .frame(width: width + beside, alignment: .leading))
            window.orderBack(nil)
            window.contentView?.layoutSubtreeIfNeeded()
        }

        func close() {
            window.orderOut(nil)
            window.close()
            window.contentView = nil
            AXElement.reading(false)
        }

        /// What VoiceOver finds in it, as it lays out now (and a beat on the main queue's next turn,
        /// for `until` to look again after SwiftUI's update).
        var elements: [AXElement] {
            window.contentView?.layoutSubtreeIfNeeded()
            DispatchQueue.main.async { TestPulse.beat() }
            return AXElement.all(in: window.contentView)
        }

        /// The names that show, left to right: those VoiceOver reads (it skips those that don't).
        var shown: [AXElement] {
            elements.filter { $0.label.map(names.contains) == true && $0.isRead }.sorted { $0.frame.minX < $1.frame.minX }
        }

        var shownNames: [String] { shown.compactMap(\.label) }

        /// "+3".
        var count: AXElement? { elements.first { $0.label?.hasSuffix(" more") == true } }

        /// Measured and laid out: the names show once it knows what fits.
        var isLaidOut: Bool { !shown.isEmpty }

        /// A click on what VoiceOver calls `label`, sent through the window.
        func click(_ label: String) throws {
            let element = try #require(elements.first { $0.label == label }, "“\(label)” among \(shownNames)")
            try click(at: window.convertPoint(fromScreen: NSPoint(x: element.frame.midX, y: element.frame.midY)))
        }

        /// A click at `point`, in the window, sent through it.
        func click(at point: NSPoint) throws {
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                let event = try #require(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
                window.sendEvent(event)
            }
        }

        /// The strip as drawn, and how many pixels a point is.
        func picture() throws -> (image: CGImage, scale: CGFloat) {
            let host = try #require(window.contentView)
            host.layoutSubtreeIfNeeded()
            host.display()
            let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            let image = try #require(rep.cgImage)
            return (image, CGFloat(image.width) / host.bounds.width)
        }
    }

    private static let five = ["mini-local", "devbox", "gpu-box", "staging", "lab"]

    /// 1, 2 and 4 machines besides the one in view, in a narrow sidebar and a wide one.
    @Test(arguments: [2, 3, 5], [220, 360] as [CGFloat])
    func theOneInViewFirstThenTheOthersAndACountForTheRest(computers: Int, width: CGFloat) async throws {
        let names = Array(Self.five.prefix(computers))
        let strip = Strip(app: app, names: names, width: width, inView: 1)
        defer { strip.close() }
        try await until { strip.isLaidOut }
        let line = Array(names[1...] + names[..<1])
        let shown = strip.shown
        #expect(strip.shownNames == Array(line.prefix(shown.count)), "the one in view first, then the others in turn: \(strip.shownNames)")
        #expect(shown.first?.isSelected == true)
        let rest = names.count - shown.count
        if rest == 0 {
            #expect(strip.count == nil, "no count while every name shows: \(strip.shownNames), \(strip.count?.label ?? "")")
        } else {
            let count = try #require(strip.count, "\(rest) don't show: \(strip.shownNames)")
            #expect(count.label == "\(rest) more")
            #expect(count.help == line.suffix(rest).formatted(.list(type: .and)), "the count stands for those that don't show, in turn")
            for name in shown { #expect(name.frame.maxX <= count.frame.minX + 0.5, "\(name.label ?? ""), whole, before the count") }
        }
        // Short names, wide: all of them when they fit (five such fit, just); five narrow never do.
        if width == 360, computers <= 3 { #expect(rest == 0) }
        if computers == 5, width == 220 { #expect(rest > 0, "\(strip.shownNames) \(strip.shown.map(\.frame))") }
    }

    @Test func clickingANameBringsItFirst() async throws {
        let names = Array(Self.five.prefix(4))
        let strip = Strip(app: app, names: names, width: 360)
        defer { strip.close() }
        try await until { strip.shownNames.count >= 2 }
        let next = strip.shownNames[1]
        #expect(next == "devbox")

        try strip.click(next)
        #expect(strip.picked.box == .machine("devbox"))
        // Once the line has slid a step: the one that was first goes round to the end.
        let line = ["devbox", "gpu-box", "staging", "mini-local"]
        try await until { strip.shownNames.first == "devbox" && strip.shownNames == Array(line.prefix(strip.shownNames.count)) }
        #expect(strip.shown.first?.isSelected == true)
    }

    /// Picked from the count's menu (or swiped to, or a tab's): it comes first, and the line goes
    /// round after it.
    @Test func oneThatDidntShowComesFirstOncePicked() async throws {
        let strip = Strip(app: app, names: Self.five, width: 220)
        defer { strip.close() }
        try await until { strip.count != nil }
        #expect(!strip.shownNames.contains("lab"))

        strip.picked.box = .machine("lab")
        try await until { strip.shownNames.first == "lab" }
        let line = ["lab", "mini-local", "devbox", "gpu-box", "staging"]
        #expect(strip.shownNames == Array(line.prefix(strip.shownNames.count)), "\(strip.shownNames)")
        let count = try #require(strip.count)
        #expect(count.help == line.dropFirst(strip.shownNames.count).formatted(.list(type: .and)))
    }

    /// A long name in view is cut at its end, before the count: its start reads as it does whole,
    /// and VoiceOver says it whole.
    @Test func aLongNameIsCutAtItsEndNeverInTheMiddle() async throws {
        let long = "build-server-in-the-basement-with-a-very-long-name"
        let strip = Strip(app: app, names: [long, "devbox"], width: 220)
        defer { strip.close() }
        try await until { strip.count != nil }
        let name = try #require(strip.shown.first)
        #expect(name.label == long)
        let count = try #require(strip.count)
        #expect(strip.shownNames == [long])
        #expect(name.frame.maxX <= count.frame.minX + 0.5)

        // The ink of the name as drawn, against the name drawn whole: the same from its start for
        // most of the way (a cut in the middle would differ from halfway), and nothing past the
        // name's end, where the count is.
        let (image, scale) = try strip.picture()
        let host = try #require(strip.window.contentView)
        let frame = strip.window.convertFromScreen(name.frame)
        let drawn = Self.inkedColumns(image, rows: Self.rows(of: frame, in: host, scale: scale))
        let whole = try Self.wholeName(long, scale: scale)
        let start = try #require(drawn.first), wholeStart = try #require(whole.first)
        let countStart = Int(strip.window.convertFromScreen(count.frame).minX * scale)
        let shownWidth = (drawn.filter { $0 < countStart }.max() ?? start) - start
        #expect(start + shownWidth <= Int(frame.maxX * scale), "no ink past the name's end")
        let compared = Int(Double(shownWidth) * 0.8)
        let shifted = Set(drawn.filter { $0 - start < compared }.map { $0 - start })
        let reference = Set(whole.filter { $0 - wholeStart < compared }.map { $0 - wholeStart })
        let differing = shifted.symmetricDifference(reference).count
        #expect(differing <= 3 * Int(scale), "the cut name reads as the whole one for 80% of its width (\(differing) columns differ)")
        #expect(shownWidth < whole.last! - wholeStart, "it is cut")
    }

    /// A machine that isn't connected says so, in the line and through the count.
    @Test func aMachineThatIsntConnectedSaysSo() async throws {
        SSHConnection.standIn = { _, _ in nil }
        let away = app.machines.add("gpu-box-\(UUID().uuidString.prefix(6).lowercased()).invalid")
        let failed = app.machines.add("lab-\(UUID().uuidString.prefix(6).lowercased()).invalid")
        defer {
            app.removeMachine(away.machine.id)
            app.removeMachine(failed.machine.id)
            SSHConnection.standIn = nil
        }
        away.showStandIn("notConnected")
        failed.showStandIn("failed")
        let names = ["mini-local", "devbox", "staging", away.machine.id, failed.machine.id]
        let strip = Strip(app: app, names: names, width: 220, inView: 3)
        defer { strip.close() }
        let awayName = app.name(of: .machine(away.machine.id)), failedName = app.name(of: .machine(failed.machine.id))
        try await until { strip.count != nil && strip.elements.contains { $0.label == awayName } }
        let shown = try #require(strip.elements.first { $0.label == awayName })
        #expect(shown.isSelected)
        #expect(shown.value == away.statusText, "the one in view, not connected, says so")
        let count = try #require(strip.count)
        #expect(count.value?.contains("\(failedName), \(failed.statusText)") == true, "\(count.value ?? "")")
    }

    /// A name fading out at the line's end isn't a button: a click past the strip's end, over
    /// the card beside the sidebar, where it would run on, leaves the computer in view as it is.
    @Test func aClickPastTheStripsEndPicksNothing() async throws {
        // The third shows its start, fading out, and runs on far past the strip's end.
        let strip = Strip(app: app, names: ["devbox", "gpu", "build-server-in-the-basement"], width: 220, beside: 200)
        defer { strip.close() }
        try await until { strip.count != nil }
        #expect(strip.shownNames == ["devbox", "gpu"], "\(strip.shownNames)")
        let name = try #require(strip.shown.first)
        let row = strip.window.convertFromScreen(name.frame).midY
        for x in [230.0, 260, 300, 380] { try strip.click(at: NSPoint(x: x, y: row)) }
        #expect(strip.picked.box == .machine("devbox"))
        // While the names that show whole are buttons.
        try strip.click("gpu")
        #expect(strip.picked.box == .machine("gpu"))
    }

    /// A long name in view that couldn't connect is cut in its words: its orange mark still shows,
    /// before the count (marked too, for another that couldn't).
    @Test func aCutNameKeepsItsMark() async throws {
        SSHConnection.standIn = { _, _ in nil }
        let failed = app.machines.add("build-server-in-the-basement-\(UUID().uuidString.prefix(6).lowercased()).invalid")
        let other = app.machines.add("lab-\(UUID().uuidString.prefix(6).lowercased()).invalid")
        defer {
            app.removeMachine(failed.machine.id)
            app.removeMachine(other.machine.id)
            SSHConnection.standIn = nil
        }
        failed.showStandIn("failed")
        other.showStandIn("failed")
        let strip = Strip(app: app, names: [failed.machine.id, other.machine.id], width: 220)
        defer { strip.close() }
        try await until { strip.count != nil }
        let name = try #require(strip.shown.first)
        #expect(name.label == failed.machine.id)
        let count = try #require(strip.count)
        let (image, scale) = try strip.picture()
        let host = try #require(strip.window.contentView)
        let frame = strip.window.convertFromScreen(name.frame)
        let orange = Self.orangeColumns(image, rows: Self.rows(of: frame, in: host, scale: scale))
        let countStart = strip.window.convertFromScreen(count.frame).minX * scale
        #expect(orange.contains { CGFloat($0) < countStart }, "its mark, before the count")
    }

    // MARK: How the line is laid out

    /// Names `widths` wide (with their padding), the one in view first, in 220 pt with a 40-pt count.
    private func fit(_ widths: [CGFloat], room: CGFloat = 220) -> BoxNameStrip.Fit {
        BoxNameStrip.fit(widths: widths, room: room, more: 40)
    }

    @Test func thoseThatFitWholeShowAndTheRestAreCounted() {
        #expect(fit([100, 60]).hidden.isEmpty, "all fit: no count")
        // 4 + 100, 2 + 60 (to 166), 2 + 60 (to 228, past the line's 180).
        let three = fit([100, 60, 60, 60])
        #expect(three.hidden == [2, 3])
        #expect(three.line == 180)
        #expect(three.fadesFrom == 174 && three.fadesTo == three.fadesFrom, "6 pt of it would show: none")
        // A short one in view leaves room for the next to show as it fades out.
        let fading = fit([120, 120])
        #expect(fading.hidden == [1])
        #expect(fading.fadesFrom == 132 && fading.fadesTo == 180)
    }

    @Test func aLongNameInViewIsCutToTheLine() {
        let long = fit([300, 60])
        #expect(long.hidden == [1])
        #expect(long.most == 182, "its words and mark to the line's end")
        #expect(long.starts[1] == 188, "the next begins past the cut, out of sight")
        #expect(long.fadesTo == long.fadesFrom)
        #expect(fit([300]).hidden.isEmpty, "alone, there's nothing to count")
    }

    // MARK: Pictures

    /// The pixel rows `frame` (in the window, from its bottom) covers in the host's picture.
    private static func rows(of frame: NSRect, in host: NSView, scale: CGFloat) -> Range<Int> {
        let top = Int((host.bounds.height - frame.maxY) * scale), bottom = Int((host.bounds.height - frame.minY) * scale)
        return max(top, 0)..<max(bottom, top + 1)
    }

    /// The columns with ink among `rows`.
    private static func inkedColumns(_ image: CGImage, rows: Range<Int>) -> [Int] {
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return [] }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let rows = rows.clamped(to: 0..<height)
        return (0..<width).filter { x in rows.contains { y in pixels[(y * width + x) * 4 + 3] > 40 } }
    }

    /// The columns with something orange (a mark) among `rows`.
    private static func orangeColumns(_ image: CGImage, rows: Range<Int>) -> [Int] {
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return [] }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let rows = rows.clamped(to: 0..<height)
        return (0..<width).filter { x in
            rows.contains { y in
                let at = (y * width + x) * 4
                let (r, g, b, a) = (Int(pixels[at]), Int(pixels[at + 1]), Int(pixels[at + 2]), Int(pixels[at + 3]))
                return a > 200 && r > 200 && (90...190).contains(g) && b < 90
            }
        }
    }

    /// The name drawn whole, as the strip draws the one in view: its inked columns.
    private static func wholeName(_ name: String, scale: CGFloat) throws -> [Int] {
        let text = Text(name).sidebarFont(BoxNameStrip.size, weight: .bold).fixedSize().foregroundStyle(.primary)
        let host = NSHostingView(rootView: text.padding(4))
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 600, height: 40), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        host.display()
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let image = try #require(rep.cgImage)
        #expect(CGFloat(image.width) / host.bounds.width == scale, "drawn at the strip's scale")
        return inkedColumns(image, rows: 0..<image.height)
    }
}

extension AXElement {
    /// Whether VoiceOver reads it: not one hidden from it, which stays in the tree, ignored.
    var isRead: Bool {
        let selector = #selector(NSAccessibilityProtocol.isAccessibilityElement)
        return object.responds(to: selector) ? (object.isAccessibilityElement?() ?? true) : true
    }

    /// What VoiceOver says after its label.
    var value: String? {
        let selector = #selector(NSAccessibilityProtocol.accessibilityValue)
        guard object.responds(to: selector) else { return nil }
        return object.perform(selector)?.takeUnretainedValue() as? String
    }
}
