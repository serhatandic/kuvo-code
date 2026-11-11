import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// The sidebar's computers go round in a loop (#446): from the last one, the next is the first,
/// and its page comes in from the side the next one always does, one more step the same way, as
/// on the phone; not a slide back past every page between. Going back from the first, the same
/// the other way.
///
/// The pages are drawn in a window of the test's own, part way through each change: the motion
/// held at a fraction of the way (`HeldAt`), so a frame is the real view's, as it shows that far
/// into the switch. Each computer's page is a tint of its own, to tell them apart. With
/// KUVO_SHOTS_OUT, the frames of a loop go in that folder, light and dark.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(2)))
struct BoxLoopTests {
    static let boxes: [SidebarBox] = [.mac, .machine("devbox"), .machine("gpu-box")]
    static let names: [SidebarBox: String] = [.mac: "mini-local", .machine("devbox"): "devbox", .machine("gpu-box"): "gpu-box"]

    /// Picking the first computer after the last one, as its name in the strip does.
    @Test func onFromTheLastComputerIsOneStepForward() async throws {
        for fraction in [0.25, 0.5, 0.75] {
            let shown = try await Pages.shown(from: .machine("gpu-box"), to: .mac, at: fraction)
            #expect(shown[.machine("devbox")] == nil, "at \(Int(fraction * 100))%, the page between shows: \(shown)")
            let last = try #require(shown[.machine("gpu-box")]), first = try #require(shown[.mac])
            #expect(last.upperBound < first.lowerBound, "the last page goes out to the left as the first comes in from the right: \(shown)")
            #expect(abs(Double(first.count) - fraction * Pages.width) < 0.1 * Pages.width, "one page's step: \(shown)")
        }
    }

    @Test func backFromTheFirstComputerIsOneStepBack() async throws {
        for fraction in [0.25, 0.5, 0.75] {
            let shown = try await Pages.shown(from: .mac, to: .machine("gpu-box"), at: fraction)
            #expect(shown[.machine("devbox")] == nil, "at \(Int(fraction * 100))%, the page between shows: \(shown)")
            let last = try #require(shown[.machine("gpu-box")]), first = try #require(shown[.mac])
            #expect(last.upperBound < first.lowerBound, "the first page goes out to the right as the last comes in from the left: \(shown)")
            #expect(abs(Double(last.count) - fraction * Pages.width) < 0.1 * Pages.width, "one page's step: \(shown)")
        }
    }

    /// Any other step, as it always was.
    @Test func onToTheNextComputerSlides() async throws {
        let shown = try await Pages.shown(from: .mac, to: .machine("devbox"), at: 0.5)
        let first = try #require(shown[.mac]), next = try #require(shown[.machine("devbox")])
        #expect(first.upperBound < next.lowerBound && shown[.machine("gpu-box")] == nil, "half way to the next: \(shown)")
    }

    /// The frames of a loop on from the last computer to the first, for a look (KUVO_SHOTS_PREFIX:
    /// before or after).
    @Test(.enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil))
    func frames() async throws {
        let out = try #require(ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"])
        let prefix = ProcessInfo.processInfo.environment["KUVO_SHOTS_PREFIX"] ?? "after"
        try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        for dark in [false, true] {
            var frames: [CGImage] = []
            for fraction in [0, 0.2, 0.4, 0.6, 0.8, 1] {
                frames.append(try await Pages.draw(from: .machine("gpu-box"), to: .mac, at: fraction, dark: dark).image)
            }
            try Pages.strip(frames, dark: dark).write(to: URL(filePath: out).appending(path: "\(prefix)-sidebar-loop-\(dark ? "dark" : "light").png"))
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
private final class PagerState {
    var selected: SidebarBox

    init(selected: SidebarBox) { self.selected = selected }
}

/// A computer's page: its name over a few rows, on a tint of its own.
private struct Page: View {
    let box: SidebarBox

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(BoxLoopTests.names[box] ?? "")
                .font(.system(size: 15, weight: .bold))
            ForEach(0..<4, id: \.self) { row in
                RoundedRectangle(cornerRadius: 4).fill(.primary.opacity(0.12)).frame(width: CGFloat(120 + row * 23 % 70), height: 10)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Pages.tint(box))
    }
}

private struct PagerHost: View {
    let state: PagerState
    let motion: BoxPagerMotion

    var body: some View {
        @Bindable var state = state
        BoxPager(boxes: BoxLoopTests.boxes, selected: $state.selected, motion: motion) { box in
            Page(box: box)
        }
        .frame(width: Pages.width, height: Pages.height)
    }
}

@MainActor
private enum Pages {
    static let width: CGFloat = 280
    static let height: CGFloat = 170

    static func tint(_ box: SidebarBox) -> Color {
        switch box {
        case .mac: Color(red: 1, green: 0.72, blue: 0.72)
        case .machine("devbox"): Color(red: 0.72, green: 1, blue: 0.72)
        default: Color(red: 0.72, green: 0.72, blue: 1)
        }
    }

    /// The pages drawn `fraction` of the way from one computer to another, picked as a name in
    /// the strip picks it.
    static func draw(from: SidebarBox, to: SidebarBox, at fraction: Double, dark: Bool = false) async throws -> (image: CGImage, scale: CGFloat) {
        let state = PagerState(selected: from)
        let host = NSHostingView(rootView: PagerHost(state: state, motion: BoxPagerMotion()).environment(\.colorScheme, dark ? .dark : .light))
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
        // What the window shows now, once SwiftUI has drawn what it has.
        func drawn() throws -> CGImage {
            host.needsLayout = true
            host.layoutSubtreeIfNeeded()
            host.display()
            CATransaction.flush()
            let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            return try #require(rep.cgImage)
        }
        // Drawn as it is: the page in view across the whole width at first, and after the change,
        // something other than before (drawn a turn or two after the views change). Each look
        // comes again after a turn of the main run loop.
        var image = try drawn()
        let scale = CGFloat(image.width) / host.bounds.width
        func shows(_ check: (Pixels) -> Bool) -> Bool {
            DispatchQueue.main.async { TestPulse.beat() }
            guard let now = try? drawn(), let pixels = try? Pixels(now) else { return false }
            image = now
            return check(pixels)
        }
        do {
            try await until { shows { Self.pages($0, scale: scale) == [from: 0...Int(width) - 1] } }
            if from != to {
                let before = try Pixels(image)
                withTransaction(Transaction(animation: Animation(HeldAt(fraction: fraction)))) { state.selected = to }
                try await until { shows { fraction == 0 || $0 != before } }
            }
        } catch {
            // What it showed instead, to see why.
            let pages = (try? Pixels(image)).map { Self.pages($0, scale: scale) } ?? [:]
            Issue.record("Never drawn as \(from) then \(to): the pages' tints show at \(pages)")
            throw error
        }
        return (image, scale)
    }

    /// Which pages show, and where: the columns of each one's tint, in points, along a line near
    /// the bottom, below their names and rows.
    static func shown(from: SidebarBox, to: SidebarBox, at fraction: Double) async throws -> [SidebarBox: ClosedRange<Int>] {
        let (image, scale) = try await draw(from: from, to: to, at: fraction)
        return pages(try Pixels(image), scale: scale)
    }

    private static func pages(_ pixels: Pixels, scale: CGFloat) -> [SidebarBox: ClosedRange<Int>] {
        let y = Int((height - 12) * scale)
        var columns: [SidebarBox: [Int]] = [:]
        for x in 0..<pixels.width {
            guard let box = pixels.tint(x: x, y: y) else { continue }
            columns[box, default: []].append(Int(CGFloat(x) / scale))
        }
        return columns.compactMapValues { list in list.min().flatMap { low in list.max().map { low...$0 } } }
    }

    /// The frames one under another.
    static func strip(_ frames: [CGImage], dark: Bool) throws -> Data {
        let width = frames.map(\.width).max() ?? 0, gap = 8, height = frames.map(\.height).reduce(0, +) + gap * (frames.count - 1)
        let picture = NSImage(size: NSSize(width: width, height: height), flipped: true) { rect in
            NSColor(white: dark ? 0.16 : 0.86, alpha: 1).setFill()
            rect.fill()
            var y = 0
            for frame in frames {
                guard let context = NSGraphicsContext.current?.cgContext else { break }
                context.saveGState()
                context.translateBy(x: 0, y: CGFloat(y + frame.height))
                context.scaleBy(x: 1, y: -1)
                context.draw(frame, in: CGRect(x: 0, y: 0, width: frame.width, height: frame.height))
                context.restoreGState()
                y += frame.height + gap
            }
            return true
        }
        let tiff = try #require(picture.tiffRepresentation)
        return try #require(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
    }
}

/// An image's pixels, as 8-bit RGBA.
private struct Pixels: Equatable {
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

    /// Whose page's tint this is: the channel that stands out.
    func tint(x: Int, y: Int) -> SidebarBox? {
        // Rows from the top: the context's are from the bottom.
        let index = ((height - 1 - y) * width + x) * 4
        let (r, g, b, a) = (Int(bytes[index]), Int(bytes[index + 1]), Int(bytes[index + 2]), Int(bytes[index + 3]))
        guard a > 200 else { return nil }
        if r > g + 30, r > b + 30 { return .mac }
        if g > r + 30, g > b + 30 { return .machine("devbox") }
        if b > r + 30, b > g + 30 { return .machine("gpu-box") }
        return nil
    }
}
