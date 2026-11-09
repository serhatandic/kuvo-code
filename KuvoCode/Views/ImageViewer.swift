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
                    PictureCanvas(image: image, scale: $scale, fitScale: $fitScale)
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
                Menu("\(Int(scale * fitScale * 100))%") {
                    Button("Fit") { scale = 1 }
                    Button("Actual Size") { scale = 1 / max(fitScale, 0.000000001) }
                    Button("Zoom In") { scale = min(scale * 1.25, max(100, 1 / max(fitScale, 0.000000001))) }
                    Button("Zoom Out") { scale = max(scale / 1.25, 1) }
                }
                Button("Download", systemImage: "arrow.down.to.line") {
                    guard let source = item.localURL(), let data = try? Data(contentsOf: source) else { return }
                    let panel = NSSavePanel()
                    panel.nameFieldStringValue = item.name
                    if panel.runModal() == .OK, let url = panel.url { try? data.write(to: url) }
                }
                .disabled(image == nil)
                Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc", action: copy)
                    .contentTransition(.symbolEffect(.replace))
                    .disabled(image == nil)
                    .help("Copy the picture (⌘C)")
                Button("Open in Preview", systemImage: "arrow.up.forward.app") {
                    item.open()
                    ImageViewer.shared.close()
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


/// A single zoomable picture surface for the file panel and the conversation viewer.
struct PictureCanvas: View {
    let image: NSImage
    @Binding var scale: CGFloat
    @Binding var fitScale: CGFloat
    @State private var pinch: CGFloat = 1
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
            let fit = max(0.000000001, min(room.width / max(size.width, 1), room.height / max(size.height, 1), 1))
            let maximum = max(100, 1 / fit)
            let current = max(1, min(maximum, scale * pinch))
            ScrollView([.horizontal, .vertical]) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: max(1, size.width * fit * current), height: max(1, size.height * fit * current))
                    .frame(minWidth: room.width, minHeight: room.height)
            }
            .onAppear { fitScale = fit; focused = true }
            .onChange(of: fit) { _, value in fitScale = value }
            .gesture(MagnifyGesture().onChanged { pinch = $0.magnification }.onEnded { _ in
                scale = current
                pinch = 1
            })
            .onTapGesture(count: 2) {
                scale = scale > 1 ? 1 : 1 / fit
            }
            .focusable()
            .focused($focused)
            .onKeyPress(characters: ["+", "=", "-", "0"], phases: .down) { press in
                guard press.modifiers.contains(.command) else { return .ignored }
                switch press.characters {
                case "+", "=": scale = min(maximum, scale * 1.25)
                case "-": scale = max(1, scale / 1.25)
                case "0": scale = 1
                default: return .ignored
                }
                return .handled
            }
            .help("Pinch or double-click to zoom")
        }
    }
}
