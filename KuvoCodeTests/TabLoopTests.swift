import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Cycling through the title bar's tabs goes round in a loop (#446): from the last tab, the next
/// one is the first, one more step forward like every other, not a slide all the way back across
/// the bar (and the same from the first tab going back). Clicking a tab far away still slides.
///
/// The tab bar is drawn in a window of the test's own, part way through each change: its motion
/// held at a fraction of the way (`HeldAt`), so a frame is the real view's, as it shows that far
/// into the switch. With KUVO_SHOTS_OUT, the frames of a loop go in that folder, light and dark.
@MainActor
@Suite(.serialized)
struct TabLoopTests {
    static let tabs = ["Fix the login form", "Release notes", "Tests", "Docs"].enumerated().map { index, title in
        TabItem(id: "tab\(index + 1)", title: title, logo: nil, status: .idle)
    }

    @Test func goingOnFromTheLastTabIsOneStepForward() throws {
        let rest = try Bar.resting()
        let first = try #require(rest["tab1"]), last = try #require(rest["tab4"])
        for fraction in [0.25, 0.5, 0.75] {
            let pill = try Bar.pill(from: "tab4", to: "tab1", by: 1, at: fraction)
            // Never over the tabs between: it leaves the last one ahead, and comes into the first
            // from behind, as a step forward would.
            #expect(pill.allSatisfy { first.contains($0) || last.contains($0) || $0 > last.upperBound },
                    "at \(Int(fraction * 100))%, the pill is drawn over \(Bar.spans(pill)), only \(first) and \(last) are the loop's")
            let leaving = pill.filter { $0 >= last.lowerBound }, coming = pill.filter { $0 <= first.upperBound }
            #expect((leaving.min() ?? .max) > last.lowerBound, "it leaves forward: \(Bar.spans(leaving)) from \(last)")
            #expect((coming.max() ?? .min) < first.upperBound, "it comes in from behind: \(Bar.spans(coming)) into \(first)")
            #expect(!pill.contains { $0 > last.upperBound + 3 }, "nothing past the bar's end: \(Bar.spans(pill))")
        }
    }

    @Test func goingBackFromTheFirstTabIsOneStepBack() throws {
        let rest = try Bar.resting()
        let first = try #require(rest["tab1"]), last = try #require(rest["tab4"])
        for fraction in [0.25, 0.5, 0.75] {
            let pill = try Bar.pill(from: "tab1", to: "tab4", by: -1, at: fraction)
            #expect(pill.allSatisfy { first.contains($0) || last.contains($0) || $0 < first.lowerBound },
                    "at \(Int(fraction * 100))%, the pill is drawn over \(Bar.spans(pill)), only \(first) and \(last) are the loop's")
            let leaving = pill.filter { $0 <= first.upperBound }, coming = pill.filter { $0 >= last.lowerBound }
            #expect((leaving.max() ?? .min) < first.upperBound, "it leaves back: \(Bar.spans(leaving)) from \(first)")
            #expect((coming.min() ?? .max) > last.lowerBound, "it comes in from ahead: \(Bar.spans(coming)) into \(last)")
        }
    }

    /// A tab far away, clicked: the pill slides there, over the tabs between, as it always has.
    @Test func clickingTheFirstTabStillSlides() throws {
        let rest = try Bar.resting()
        let second = try #require(rest["tab2"]), third = try #require(rest["tab3"])
        let pill = try Bar.pill(from: "tab4", to: "tab1", by: nil, at: 0.5)
        #expect(pill.contains { second.contains($0) || third.contains($0) }, "half way, over the tabs between: \(Bar.spans(pill))")
    }

    /// The frames of a loop forward, before and after, for a look (KUVO_SHOTS_PREFIX: before or after).
    @Test(.enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil))
    func frames() throws {
        let out = try #require(ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"])
        let prefix = ProcessInfo.processInfo.environment["KUVO_SHOTS_PREFIX"] ?? "after"
        try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        for dark in [false, true] {
            var frames: [CGImage] = []
            for fraction in [0, 0.2, 0.4, 0.6, 0.8, 1] {
                frames.append(try Bar.draw(from: "tab4", to: "tab1", by: 1, at: fraction, dark: dark).image)
            }
            try Bar.strip(frames, dark: dark).write(to: URL(filePath: out).appending(path: "\(prefix)-loop-\(dark ? "dark" : "light").png"))
        }
    }
}

/// Motion held part way: `fraction` of the way through, for as long as it's drawn.
private struct HeldAt: CustomAnimation {
    let fraction: Double

    func animate<V: VectorArithmetic>(value: V, time: TimeInterval, context: inout AnimationContext<V>) -> V? {
        value.scaled(by: fraction)
    }
}

@MainActor
@Observable
private final class BarState {
    var selection: String?
    var loops = 0

    init(selection: String) { self.selection = selection }
}

private struct BarHost: View {
    let state: BarState

    var body: some View {
        @Bindable var state = state
        TabStrip(tabs: TabLoopTests.tabs, selection: $state.selection, close: { _ in }, closeAll: { _ in }, loops: state.loops)
            .padding(.horizontal, 20)
            .frame(width: Bar.width, height: Bar.height)
    }
}

@MainActor
private enum Bar {
    static let width: CGFloat = 760
    static let height: CGFloat = 60

    /// The bar drawn `fraction` of the way from one tab to another: going on (1) or back (-1)
    /// through the tabs, as Show Next Tab and Show Previous Tab do, or clicked (nil).
    static func draw(from: String, to: String, by step: Int?, at fraction: Double, dark: Bool = false) throws -> (image: CGImage, scale: CGFloat) {
        let state = BarState(selection: from)
        let host = NSHostingView(rootView: BarHost(state: state).environment(\.colorScheme, dark ? .dark : .light))
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: width, height: height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = host
        window.orderBack(nil)
        defer {
            window.orderOut(nil)
            window.close()
            window.contentView = nil
        }
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date())
        if from != to {
            withTransaction(Transaction(animation: Animation(HeldAt(fraction: fraction)))) {
                state.selection = to
                if step != nil { state.loops += 1 }
            }
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date())
            host.layoutSubtreeIfNeeded()
        }
        host.display()
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let image = try #require(rep.cgImage)
        return (image, CGFloat(image.width) / host.bounds.width)
    }

    /// Where each tab's pill is, at rest: the columns it covers, in points.
    static func resting() throws -> [String: ClosedRange<Int>] {
        var spans: [String: ClosedRange<Int>] = [:]
        for tab in TabLoopTests.tabs {
            let pill = try pill(from: tab.id, to: tab.id, by: nil, at: 1)
            if let low = pill.min(), let high = pill.max() { spans[tab.id] = low...high }
        }
        return spans
    }

    /// The columns, in points, where the pill shows (white, in light mode), along a line near its
    /// top, clear of the tabs' icons and titles.
    static func pill(from: String, to: String, by step: Int?, at fraction: Double) throws -> [Int] {
        let (image, scale) = try draw(from: from, to: to, by: step, at: fraction)
        let pixels = try Pixels(image)
        let row = try #require(pillRow(pixels, scale: scale), "no pill drawn")
        var columns = Set<Int>()
        for x in 0..<pixels.width where pixels.isPill(x: x, y: row) { columns.insert(Int(CGFloat(x) / scale)) }
        return columns.sorted()
    }

    /// A line 3 points into the pill from its top, the first line with a run of the pill's white.
    private static func pillRow(_ pixels: Pixels, scale: CGFloat) -> Int? {
        for y in 0..<pixels.height {
            let run = (0..<pixels.width).filter { pixels.isPill(x: $0, y: y) }.count
            if CGFloat(run) > 30 * scale { return y + Int(3 * scale) }
        }
        return nil
    }

    static func spans(_ columns: [Int]) -> String {
        var spans: [ClosedRange<Int>] = []
        for column in columns {
            if let last = spans.last, last.upperBound + 1 == column { spans[spans.count - 1] = last.lowerBound...column } else { spans.append(column...column) }
        }
        return spans.map { "\($0.lowerBound)…\($0.upperBound)" }.joined(separator: ", ")
    }

    /// The frames one under another, over a plain desktop (the glass isn't drawn off screen).
    static func strip(_ frames: [CGImage], dark: Bool) throws -> Data {
        let width = frames.map(\.width).max() ?? 0, height = frames.map(\.height).reduce(0, +)
        let picture = NSImage(size: NSSize(width: width, height: height), flipped: true) { rect in
            NSColor(white: dark ? 0.16 : 0.86, alpha: 1).setFill()
            rect.fill()
            var y = 0
            for frame in frames {
                NSGraphicsContext.current?.cgContext.saveGState()
                NSGraphicsContext.current?.cgContext.translateBy(x: 0, y: CGFloat(y + frame.height))
                NSGraphicsContext.current?.cgContext.scaleBy(x: 1, y: -1)
                NSGraphicsContext.current?.cgContext.draw(frame, in: CGRect(x: 0, y: 0, width: frame.width, height: frame.height))
                NSGraphicsContext.current?.cgContext.restoreGState()
                y += frame.height
            }
            return true
        }
        let tiff = try #require(picture.tiffRepresentation)
        return try #require(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
    }
}

/// An image's pixels, as 8-bit RGBA.
private struct Pixels {
    let width: Int, height: Int
    private let bytes: [UInt8]

    init(_ image: CGImage) throws {
        width = image.width
        height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let context = try #require(CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                             space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        self.bytes = bytes
    }

    /// The pill's white, even half faded in or out (over nothing, as the bar is drawn here).
    func isPill(x: Int, y: Int) -> Bool {
        // Rows from the top: the context's are from the bottom.
        let index = ((height - 1 - y) * width + x) * 4
        let (r, g, b, a) = (Int(bytes[index]), Int(bytes[index + 1]), Int(bytes[index + 2]), Int(bytes[index + 3]))
        return a > 90 && r * 255 / max(a, 1) > 240 && g * 255 / max(a, 1) > 240 && b * 255 / max(a, 1) > 240
    }
}
