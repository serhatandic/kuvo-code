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
    }

    func close() {
        withAnimation(.easeOut(duration: 0.14)) { request = nil }
    }
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
    /// Pinched or double-clicked in; 1 is fitted to the window.
    @State private var scale: CGFloat = 1
    @State private var pinch: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var drag: CGSize = .zero
    @State private var appeared = false
    /// Just copied: the button shows a check for a moment.
    @State private var copied = false
    @FocusState private var isFocused: Bool

    init(request: ImageViewer.Request) {
        self.request = request
        _index = State(initialValue: request.index)
    }

    private var item: AttachmentItem { request.items[index] }
    private var zoom: CGFloat { max(1, min(8, scale * pinch)) }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Rectangle()
                    .fill(.black.opacity(0.62))
                    .ignoresSafeArea()
                    .contentShape(.rect)
                    .onTapGesture { ImageViewer.shared.close() }
                if let image {
                    let fitted = fit(image.size, in: CGSize(width: proxy.size.width - 96, height: proxy.size.height - 150))
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: fitted.width, height: fitted.height)
                        .clipShape(.rect(cornerRadius: zoom > 1 ? 0 : 10))
                        .shadow(color: .black.opacity(0.35), radius: 24, y: 8)
                        .scaleEffect(zoom)
                        .offset(x: offset.width + drag.width, y: offset.height + drag.height)
                        .scaleEffect(appeared ? 1 : 0.94)
                        .gesture(
                            MagnifyGesture()
                                .onChanged { pinch = $0.magnification }
                                .onEnded { _ in
                                    scale = zoom
                                    pinch = 1
                                    if scale <= 1 { withAnimation(.ui) { offset = .zero } }
                                }
                        )
                        .simultaneousGesture(
                            DragGesture()
                                .onChanged { if zoom > 1 { drag = $0.translation } }
                                .onEnded { value in
                                    guard zoom > 1 else { return }
                                    offset.width += value.translation.width
                                    offset.height += value.translation.height
                                    drag = .zero
                                }
                        )
                        // Double-click: in to twice the size, or back to fitted.
                        .onTapGesture(count: 2) {
                            withAnimation(.ui) {
                                scale = zoom > 1 ? 1 : 2
                                offset = .zero
                            }
                        }
                        .help("Pinch or double-click to zoom")
                        .transition(.replacingPlaceholder)
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
        .task(id: index) { image = await item.loadImage() }
    }

    /// Its name and size, and what else you can do with it.
    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(item.name)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(request.items.count > 1 ? "\(index + 1) of \(request.items.count) · \(item.detail)" : item.detail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: 320, alignment: .leading)
            Spacer(minLength: 12)
            HStack(spacing: 2) {
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
        scale = 1
        offset = .zero
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
