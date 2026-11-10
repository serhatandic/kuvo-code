import AppKit
import ClientDesign
import SwiftUI

/// Pictures you sent, looked at closer without leaving the window: over everything, fitted to it,
/// with the others from the same message an arrow key away. Escape, a click around the picture,
/// or the close button puts it away.
@Observable
final class ImageViewer {
    static let shared = ImageViewer()

    struct Request: Identifiable {
        let id = UUID()
        var items: [AttachmentItem]
        var index: Int
    }

    private(set) var request: Request?

    func show(_ items: [AttachmentItem], at index: Int = 0) {
        let pictures = items.filter(\.isImage)
        guard !pictures.isEmpty else { return }
        withAnimation(.easeOut(duration: 0.16)) {
            request = Request(items: pictures, index: min(max(0, index), pictures.count - 1))
        }
        OverContent.opened(Self.layer) { [weak self] in self?.close() }
    }

    func close() {
        OverContent.closed(Self.layer)
        withAnimation(.easeOut(duration: 0.14)) { request = nil }
    }

    /// It, among what's open over the window (`OverContent`), which Escape closes first.
    private static let layer = UUID()
}

/// The title bar's items, dimmed with the window while the viewer is open (it can't reach over
/// them), and out of reach of a click.
struct UnderImageViewer: ViewModifier {
    func body(content: Content) -> some View {
        let isOpen = ImageViewer.shared.request != nil
        content
            .opacity(isOpen ? 0.3 : 1)
            .allowsHitTesting(!isOpen)
            .animation(.easeOut(duration: 0.15), value: isOpen)
    }
}

/// Where the viewer shows, over the window's content.
struct ImageViewerOverlay: View {
    var body: some View {
        if let request = ImageViewer.shared.request {
            ImageLightbox(request: request)
                .id(request.id)
                .transition(.opacity)
        }
    }
}

private struct ImageLightbox: View {
    let request: ImageViewer.Request
    @State private var index: Int
    @State private var image: NSImage?
    @State private var loadFailed = false
    @State private var retry = 0
    @State private var actionError: String?
    /// Pinched or double-clicked in; 1 is fitted to the window.
    @State private var scale: CGFloat = 1
    @State private var fitScale: CGFloat = 1
    @State private var appeared = false
    /// Just copied: the button shows a check for a moment.
    @State private var copied = false
    @FocusState private var isFocused: Bool

    init(request: ImageViewer.Request) {
        self.request = request
        _index = State(initialValue: request.index)
    }

    private var item: AttachmentItem { request.items[index] }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Rectangle()
                    .fill(.black.opacity(0.62))
                    .ignoresSafeArea()
                    .contentShape(.rect)
                    .onTapGesture { ImageViewer.shared.close() }
                if let image {
                    PictureCanvas(image: image, scale: $scale, fitScale: $fitScale, ownsKeys: true)
                        .padding(.horizontal, 48)
                        .padding(.vertical, 75)
                        .transition(.replacingPlaceholder)
                } else if loadFailed {
                    VStack(spacing: 12) {
                        Text("This picture couldn’t be loaded.")
                        Button("Try Again") { loadFailed = false; retry += 1 }
                    }
                } else {
                    let room = fit(CGSize(width: 480, height: 360), in: CGSize(width: proxy.size.width - 96, height: proxy.size.height - 150))
                    Placeholder(.image, label: "Loading picture")
                        .frame(width: room.width, height: room.height)
                        .environment(\.colorScheme, .dark)
                }
                if request.items.count > 1 {
                    HStack {
                        stepButton(-1)
                        Spacer()
                        stepButton(1)
                    }
                    .padding(.horizontal, 20)
                }
                VStack {
                    header
                    Spacer()
                    if request.items.count > 1 {
                        Text("\(index + 1) of \(request.items.count)")
                            .font(.system(size: 12, weight: .medium))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .glassEffect(.regular, in: .capsule)
                            .padding(.bottom, 20)
                    }
                }
                .padding(.top, 14)
                .padding(.horizontal, 20)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .alert("Picture Unavailable", isPresented: Binding(
            get: { actionError != nil }, set: { if !$0 { actionError = nil } }
        )) {
            Button("OK", role: .cancel) { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
        .focusable()
        .focusEffectDisabled()
        .focused($isFocused)
        .onKeyPress(.escape) {
            ImageViewer.shared.close()
            return .handled
        }
        .onKeyPress(.space) {
            ImageViewer.shared.close()
            return .handled
        }
        .onKeyPress(.leftArrow) { step(-1) ? .handled : .ignored }
        .onKeyPress(characters: ["c"], phases: .down) { press in
            guard press.modifiers == .command else { return .ignored }
            copy()
            return .handled
        }
        .onKeyPress(.rightArrow) { step(1) ? .handled : .ignored }
        .onAppear {
            isFocused = true
            withAnimation(.snappy(duration: 0.22)) { appeared = true }
        }
        .task(id: "\(index)-\(retry)") {
            loadFailed = false
            let loaded = await item.loadImage()
            guard !Task.isCancelled else { return }
            image = loaded
            loadFailed = loaded == nil
        }
    }

    /// Its name and size, and what else you can do with it.
    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(item.name)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(item.detail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: 320, alignment: .leading)
            Spacer(minLength: 12)
            HStack(spacing: 2) {
                Menu("\(PictureZoom.percent(scale, fit: fitScale))%") {
                    Button("Fit") { withAnimation(.ui) { scale = 1 } }
                    Button("Actual Size") { withAnimation(.ui) { scale = PictureZoom.clamped(PictureZoom.actual(fit: fitScale), fit: fitScale) } }
                    Divider()
                    Button("Zoom In") { withAnimation(.ui) { scale = PictureZoom.zoomedIn(scale, fit: fitScale) } }
                    Button("Zoom Out") { withAnimation(.ui) { scale = PictureZoom.zoomedOut(scale, fit: fitScale) } }
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .menuIndicator(.hidden)
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .fixedSize()
                .disabled(image == nil)
                .help("Zoom (⌘+, ⌘−, ⌘0)")
                Button("Download", systemImage: "arrow.down.to.line") {
                    let panel = NSSavePanel()
                    panel.nameFieldStringValue = item.name
                    if panel.runModal() == .OK, let url = panel.url {
                        let selected = item
                        Task {
                            guard let data = await selected.readBytes() else {
                                actionError = "The picture couldn’t be read. Please try again."
                                return
                            }
                            do { try data.write(to: url) }
                            catch { actionError = "The picture couldn’t be saved: \(error.localizedDescription)" }
                        }
                    }
                }
                .disabled(image == nil)
                .help("Save a copy")
                Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc", action: copy)
                    .contentTransition(.symbolEffect(.replace))
                    .disabled(image == nil)
                    .help("Copy the picture (⌘C)")
                Button("Open in Preview", systemImage: "arrow.up.forward.app") {
                    let selected = item
                    Task {
                        let url: URL
                        if let local = selected.fileURL {
                            url = local
                        } else {
                            guard let data = await selected.readBytes() else {
                                actionError = "The picture couldn’t be read. Please try again."
                                return
                            }
                            guard let written = Attachments.writeReceived(data, named: selected.name, type: selected.type) else {
                                actionError = "The picture couldn’t be saved for opening."
                                return
                            }
                            url = written
                        }
                        if Attachments.canRun(url) {
                            NSWorkspace.shared.activateFileViewerSelecting([url])
                            ImageViewer.shared.close()
                        } else if NSWorkspace.shared.open(url) {
                            ImageViewer.shared.close()
                        } else {
                            actionError = "No app could open this picture."
                        }
                    }
                }
                .help("Open in its app")
                if item.fileURL != nil {
                    Button("Show in Finder", systemImage: "folder") { item.revealInFinder() }
                        .help("Show in Finder")
                }
                Button("Close", systemImage: "xmark") { ImageViewer.shared.close() }
                    .help("Close (Esc)")
            }
            .labelStyle(.iconOnly)
            .buttonStyle(IconButtonStyle(width: 30, height: 28))
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .glassEffect(.regular, in: .capsule)
        .frame(maxWidth: 560)
    }

    private func stepButton(_ direction: Int) -> some View {
        Button {
            _ = step(direction)
        } label: {
            Image(systemName: direction < 0 ? "chevron.left" : "chevron.right")
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 36, height: 36)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .disabled(!request.items.indices.contains(index + direction))
        .accessibilityLabel(direction < 0 ? "Previous" : "Next")
        .help(direction < 0 ? "Previous (←)" : "Next (→)")
    }

    /// The picture to the clipboard, as one item that pastes as a picture anywhere.
    private func copy() {
        guard let image, let tiff = image.tiffRepresentation else { return }
        let entry = NSPasteboardItem()
        if let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            entry.setData(png, forType: .png)
        }
        entry.setData(tiff, forType: .tiff)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([entry])
        withAnimation(.ui) { copied = true }
        Task {
            try? await Task.sleep(for: .seconds(1.4))
            withAnimation(.ui) { copied = false }
        }
    }

    /// To the picture before or after, if there's one.
    private func step(_ direction: Int) -> Bool {
        guard request.items.indices.contains(index + direction) else { return false }
        index += direction
        image = nil
        loadFailed = false
        scale = 1
        return true
    }

    /// The picture's own shape, as large as fits, never enlarged past its pixels.
    /// `size` scaled down to fit `room`, never up; a window smaller than its margins leaves no room.
    private func fit(_ size: CGSize, in room: CGSize) -> CGSize {
        let room = CGSize(width: max(0, room.width), height: max(0, room.height))
        guard size.width > 0, size.height > 0 else { return CGSize(width: min(200, room.width), height: min(200, room.height)) }
        let scale = min(room.width / size.width, room.height / size.height, 1)
        return CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    }
}


/// How a picture zooms, the same in the viewer over the window and in the side panel. A scale of 1
/// is the picture fitted to its room (never enlarged past its pixels); its pixels at their own size
/// are 1 / fit; it goes no further than eight times that.
nonisolated enum PictureZoom {
    /// The scale that fits `pixels` in `room`, at most 1.
    static func fit(_ pixels: CGSize, in room: CGSize) -> CGFloat {
        guard pixels.width > 0, pixels.height > 0, room.width > 0, room.height > 0 else { return 1 }
        return max(0.0001, min(room.width / pixels.width, room.height / pixels.height, 1))
    }

    static func actual(fit: CGFloat) -> CGFloat { 1 / max(fit, 0.0001) }

    static func most(fit: CGFloat) -> CGFloat { max(2, 8 * actual(fit: fit)) }

    static func clamped(_ scale: CGFloat, fit: CGFloat) -> CGFloat { max(1, min(most(fit: fit), scale)) }

    static func zoomedIn(_ scale: CGFloat, fit: CGFloat) -> CGFloat { clamped(scale * 1.25, fit: fit) }

    static func zoomedOut(_ scale: CGFloat, fit: CGFloat) -> CGFloat { clamped(scale / 1.25, fit: fit) }

    /// A double-click: back to fitted when zoomed, otherwise its pixels at their own size (twice
    /// the fit for one that fits already).
    static func toggled(_ scale: CGFloat, fit: CGFloat) -> CGFloat {
        scale > 1 ? 1 : clamped(max(actual(fit: fit), 2), fit: fit)
    }

    /// "100%": of its own pixels.
    static func percent(_ scale: CGFloat, fit: CGFloat) -> Int { Int((scale * fit * 100).rounded()) }

    /// ⌘+ (⌘= too), ⌘− and ⌘0: its new scale, or nil for another key.
    static func key(_ characters: String, scale: CGFloat, fit: CGFloat) -> CGFloat? {
        switch characters {
        case "+", "=": zoomedIn(scale, fit: fit)
        case "-": zoomedOut(scale, fit: fit)
        case "0": 1
        default: nil
        }
    }
}

/// A picture to look at closely, the one surface for every picture opened in the app: the viewer
/// over the window and a picture in the side panel. Fitted at first; a pinch, a double-click and
/// ⌘+ ⌘− ⌘0 zoom it, and zoomed in it scrolls.
struct PictureCanvas: View {
    let image: NSImage
    /// 1 is fitted; see `PictureZoom`.
    @Binding var scale: CGFloat
    /// The fit, for what says its size in percent.
    @Binding var fitScale: CGFloat
    /// The viewer over the window: its zoom keys are the picture's while it's open, and the
    /// keyboard stays with the viewer for its arrows. The side panel's picture takes them once
    /// it has the keyboard, or while the pointer is over it.
    var ownsKeys = false
    @State private var pinch: CGFloat = 1
    @State private var isHovering = false
    @FocusState private var focused: Bool

    /// Bitmap representations carry pixel dimensions even when their logical size is in points.
    private var pixelSize: CGSize {
        guard let rep = image.representations.max(by: { $0.pixelsWide * $0.pixelsHigh < $1.pixelsWide * $1.pixelsHigh }),
              rep.pixelsWide > 0, rep.pixelsHigh > 0 else { return image.size }
        return CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    }

    var body: some View {
        GeometryReader { proxy in
            let room = proxy.size
            let size = pixelSize
            let fit = PictureZoom.fit(size, in: room)
            let current = PictureZoom.clamped(scale * pinch, fit: fit)
            ScrollView([.horizontal, .vertical]) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(current * fit > 2 ? .none : .high)
                    .frame(width: max(1, size.width * fit * current), height: max(1, size.height * fit * current))
                    // Rounded while it's whole, as in the conversation.
                    .clipShape(.rect(cornerRadius: current > 1.001 ? 0 : 10))
                    .frame(minWidth: room.width, minHeight: room.height)
            }
            .scrollIndicators(current > 1 ? .automatic : .never)
            .defaultScrollAnchor(.center, for: .initialOffset)
            .defaultScrollAnchor(.center, for: .sizeChanges)
            .onAppear {
                fitScale = fit
                if let demo = Self.demoScale { scale = PictureZoom.clamped(demo, fit: fit) }
                // A file can finish loading while someone is typing in the composer.
                if !ownsKeys, !(NSApp.keyWindow?.firstResponder is NSTextView) { focused = true }
            }
            .onChange(of: fit) { _, value in fitScale = value }
            .gesture(MagnifyGesture().onChanged { pinch = $0.magnification }.onEnded { _ in
                scale = current
                pinch = 1
            })
            .onTapGesture(count: 2) {
                withAnimation(.ui) { scale = PictureZoom.toggled(scale, fit: fit) }
            }
            .onHover { isHovering = $0 }
            .background(PictureKeys(isActive: ownsKeys || focused || isHovering) { characters in
                guard let zoomed = PictureZoom.key(characters, scale: scale, fit: fit) else { return false }
                withAnimation(.ui) { scale = zoomed }
                return true
            })
            .focusable(!ownsKeys)
            .focusEffectDisabled()
            .focused($focused)
            .help("Pinch or double-click to zoom")
            .accessibilityLabel("Picture")
            .accessibilityValue("\(PictureZoom.percent(current, fit: fit))%")
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: scale = PictureZoom.zoomedIn(scale, fit: fit)
                case .decrement: scale = PictureZoom.zoomedOut(scale, fit: fit)
                @unknown default: break
                }
            }
        }
    }

    /// KUVO_DEMO_PICTURE_ZOOM: a picture opens at this scale (1 fitted), for captures.
    private static let demoScale = ProcessInfo.processInfo.environment["KUVO_DEMO_PICTURE_ZOOM"].flatMap(Double.init).map { CGFloat($0) }
}

/// ⌘+ ⌘− ⌘0 for a picture, ahead of the menus (⌘0 is Show Sessions otherwise), while it's
/// active and its window has the keyboard with no sheet over it.
private struct PictureKeys: NSViewRepresentable {
    var isActive: Bool
    var zoom: (String) -> Bool

    func makeNSView(context: Context) -> Watcher { Watcher() }

    func updateNSView(_ view: Watcher, context: Context) {
        view.isActive = isActive
        view.zoom = zoom
    }

    final class Watcher: NSView {
        var isActive = false
        var zoom: (String) -> Bool = { _ in false }
        private var monitor: Any?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.isActive, let window = self.window, event.window === window, window.attachedSheet == nil,
                      event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .shift]) == .command,
                      let characters = event.charactersIgnoringModifiers, self.zoom(characters) else { return event }
                return nil
            }
        }
    }
}
