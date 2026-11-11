import AppKit
import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// Pictures looked at closer without leaving the window: over everything, fitted to it, with every
/// other picture of the conversation before and after it (KuvoClient's `ConversationPictures`), a
/// swipe, an arrow key or a click away. Escape, a click around the picture, or the close button
/// puts it away.
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
        // The one asked for, wherever it is among the pictures.
        let asked = items.indices.contains(index) ? items[index].id : nil
        let at = asked.flatMap { id in pictures.firstIndex { $0.id == id } } ?? min(max(0, index), pictures.count - 1)
        withAnimation(.easeOut(duration: 0.16)) {
            request = Request(items: pictures, index: at)
        }
        OverContent.opened(Self.layer) { [weak self] in self?.close() }
    }

    /// Opens `items[index]` among every picture of `conversation`, where it's one of them; among
    /// `items` otherwise (a picture of a message still on its way, of a step's own).
    func show(_ items: [AttachmentItem], at index: Int, in conversation: ConversationPictureSet?) {
        guard items.indices.contains(index) else { return }
        let all = conversation?.items ?? []
        if let found = all.firstIndex(where: { $0.id == items[index].id }) {
            show(all, at: found)
        } else {
            show(items, at: index)
        }
    }

    /// Opens `items[index]`, a picture in the composer, after every picture of `conversation`.
    func show(composer items: [AttachmentItem], at index: Int, in conversation: ConversationPictureSet?) {
        let all = conversation?.items ?? []
        show(all + items, at: all.count + index)
    }

    func close() {
        OverContent.closed(Self.layer)
        withAnimation(.easeOut(duration: 0.14)) { request = nil }
    }

    /// It, among what's open over the window (`OverContent`), which Escape closes first.
    private static let layer = UUID()
}

/// Every picture of a conversation, in order, as the viewer opens them: read from its messages
/// when a picture opens (KuvoClient's `ConversationPictures`), so it's never behind them. A
/// session's, or a group chat's (its bots' pictures, each in its bot's folder).
struct ConversationPictureSet: Equatable {
    /// Which conversation: the same one is the same set.
    let key: String
    private let read: @MainActor () -> [AttachmentItem]

    init(model: SessionModel) {
        key = model.id
        read = { [weak model] in
            guard let model else { return [] }
            return Self.items(ConversationPictures.all(in: model.transcript.messages, undoneFrom: model.session.revert?.messageID), directory: model.session.location.directory)
        }
    }

    init(group: String, groups: GroupChats, bots: Bots) {
        key = "group:" + group
        read = { [weak groups, weak bots] in
            guard let groups else { return [] }
            return groups.messages(in: group).flatMap { message in
                Self.items(ConversationPictures.pictures(of: message.steps ?? [], in: message.id), directory: message.author.flatMap { bots?.bot($0)?.directory })
            }
        }
    }

    var items: [AttachmentItem] { read() }

    /// The same pictures as the conversation draws them, under the same ids.
    static func items(_ pictures: [ConversationPicture], directory: String?) -> [AttachmentItem] {
        pictures.map { picture in
            switch picture.source {
            case .attachment(let file): .stored(file, id: picture.id)
            case .file(let uri, let mime): StepPictures.item(uri: uri, mime: mime, name: picture.name, id: picture.id)
            case .shown(let path): MadePictureRow.shown(path, in: directory, id: picture.id)
            // As its message draws it (`YourMessage`), by its path.
            case .path(let path): .path(path)
            }
        }
    }

    static func == (a: Self, b: Self) -> Bool { a.key == b.key }
}

extension EnvironmentValues {
    /// The conversation a picture shows in, whose pictures it opens among.
    @Entry var conversationPictures: ConversationPictureSet? = nil
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
    /// How far a swipe on the trackpad has moved the picture, as it follows your fingers.
    @State private var swiped: CGFloat = 0
    /// Where the next picture comes in from: the side the one before it went towards.
    @State private var arrival: CGFloat = 0
    /// ‹ › show while the pointer moves over the viewer, and while it's over one of them.
    @State private var showsTurns = false
    @State private var isOverTurn = false
    @State private var hidingTurns: Task<Void, Never>?
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
                ZStack {
                    if let image {
                        PictureCanvas(image: image, scale: $scale, fitScale: $fitScale, name: item.name, ownsKeys: true) { ImageViewer.shared.close() }
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
                }
                .offset(x: swiped)
                .id(index)
                .transition(.asymmetric(insertion: .offset(x: arrival).combined(with: .opacity), removal: .opacity))
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
            .onContinuousHover { phase in
                switch phase {
                case .active: pointerMoved()
                case .ended: withAnimation(.easeOut(duration: 0.2)) { showsTurns = false }
                }
            }
            // A swipe across it with two fingers, and ← →, go to the picture before or after.
            .background(PictureTurns(canTurn: canStep, swipes: scale <= 1.001, arrows: true, modal: true, width: proxy.size.width) { travel in
                // Let go short of turning, it goes back.
                if travel == 0 { withAnimation(.ui) { swiped = 0 } } else { swiped = travel }
            } turn: { direction in
                turned(direction)
            })
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
        .onKeyPress(characters: ["c"], phases: .down) { press in
            guard press.modifiers == .command else { return .ignored }
            copy()
            return .handled
        }
        .onAppear {
            isFocused = true
            withAnimation(.snappy(duration: 0.22)) { appeared = true }
        }
        .onDisappear { hidingTurns?.cancel() }
        .task(id: "\(index)-\(retry)") {
            loadFailed = false
            let loaded = await item.loadImage()
            guard !Task.isCancelled else { return }
            image = loaded
            loadFailed = loaded == nil
        }
    }

    /// ‹ › in sight for a moment, as in Quick Look.
    private func pointerMoved() {
        if !showsTurns { withAnimation(.easeOut(duration: 0.15)) { showsTurns = true } }
        hidingTurns?.cancel()
        hidingTurns = Task {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.3)) { showsTurns = false }
        }
    }

    /// Turned by a swipe: the next comes in from the side the fingers went to, the swipe's travel
    /// carried on rather than jumping back.
    private func turned(_ direction: Int) {
        guard canStep(direction) else {
            withAnimation(.ui) { swiped = 0 }
            return
        }
        arrival = CGFloat(direction) * 60
        withAnimation(.snappy(duration: 0.25)) {
            _ = step(direction)
            swiped = 0
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
                .accessibilityLabel("Zoom")
                .accessibilityValue("\(PictureZoom.percent(scale, fit: fitScale))%")
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
                        if let local = selected.localURL() {
                            url = local
                        } else if let written = AttachmentImages.written(selected.id), FileManager.default.fileExists(atPath: written.path) {
                            url = written
                        } else {
                            // One only its machine has: its bytes through its box, written out once.
                            guard let data = await selected.readBytes() else {
                                actionError = "The picture couldn’t be read. Please try again."
                                return
                            }
                            guard let written = Attachments.writeReceived(data, named: selected.name, type: selected.type) else {
                                actionError = "The picture couldn’t be saved for opening."
                                return
                            }
                            AttachmentImages.wrote(written, for: selected.id)
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
        let can = canStep(direction)
        return Button {
            turned(direction)
        } label: {
            Image(systemName: direction < 0 ? "chevron.left" : "chevron.right")
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 36, height: 36)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .disabled(!can)
        .help(direction < 0 ? "Previous (←)" : "Next (→)")
        // In sight while the pointer moves over the viewer.
        .opacity(can && (showsTurns || isOverTurn) ? 1 : 0)
        .allowsHitTesting(can && (showsTurns || isOverTurn))
        .animation(.easeOut(duration: 0.2), value: showsTurns || isOverTurn)
        .onHover { isOverTurn = $0 }
        // VoiceOver offers it shown or not: hidden, it would be skipped.
        .accessibilityRepresentation {
            Button(direction < 0 ? "Previous" : "Next") { turned(direction) }
                .disabled(!can)
        }
    }

    private func canStep(_ direction: Int) -> Bool {
        request.items.indices.contains(index + direction)
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
/// is the picture fitted to its room (never enlarged past its own size); its own size is 1 / fit;
/// it goes no further than eight times that, nor past what a view can draw.
nonisolated enum PictureZoom {
    /// The longest side a zoomed picture is drawn at: past it, a layer can't hold it.
    static let largest: CGFloat = 16_000

    /// The scale that fits `size` in `room`, at most 1.
    static func fit(_ size: CGSize, in room: CGSize) -> CGFloat {
        guard size.width > 0, size.height > 0, room.width > 0, room.height > 0 else { return 1 }
        return max(0.0001, min(room.width / size.width, room.height / size.height, 1))
    }

    static func actual(fit: CGFloat) -> CGFloat { 1 / max(fit, 0.0001) }

    /// `side`: the fitted picture's longest side, when known.
    static func most(fit: CGFloat, side: CGFloat = 0) -> CGFloat {
        let most = max(2, 8 * actual(fit: fit))
        return side > 0 ? max(1, min(most, largest / side)) : most
    }

    static func clamped(_ scale: CGFloat, fit: CGFloat, side: CGFloat = 0) -> CGFloat { max(1, min(most(fit: fit, side: side), scale)) }

    static func zoomedIn(_ scale: CGFloat, fit: CGFloat, side: CGFloat = 0) -> CGFloat { clamped(scale * 1.25, fit: fit, side: side) }

    static func zoomedOut(_ scale: CGFloat, fit: CGFloat, side: CGFloat = 0) -> CGFloat { clamped(scale / 1.25, fit: fit, side: side) }

    /// A double-click: back to fitted when zoomed, otherwise its own size (twice the fit for one
    /// that fits already).
    static func toggled(_ scale: CGFloat, fit: CGFloat, side: CGFloat = 0) -> CGFloat {
        scale > 1 ? 1 : clamped(max(actual(fit: fit), 2), fit: fit, side: side)
    }

    /// "100%": of its own size.
    static func percent(_ scale: CGFloat, fit: CGFloat) -> Int { Int((scale * fit * 100).rounded()) }

    /// ⌘+ (⌘= too), ⌘− and ⌘0: its new scale, or nil for another key.
    static func key(_ characters: String, scale: CGFloat, fit: CGFloat, side: CGFloat = 0) -> CGFloat? {
        switch characters {
        case "+", "=": zoomedIn(scale, fit: fit, side: side)
        case "-": zoomedOut(scale, fit: fit, side: side)
        case "0": 1
        default: nil
        }
    }
}

/// A picture to look at closely, the one surface for every picture opened in the app: the viewer
/// over the window and a picture in the side panel. Fitted at first, rounded; a pinch, a
/// double-click and ⌘+ ⌘− ⌘0 zoom it, and zoomed in it scrolls.
struct PictureCanvas: View {
    let image: NSImage
    /// 1 is fitted; see `PictureZoom`.
    @Binding var scale: CGFloat
    /// The fit, for what says its size in percent.
    @Binding var fitScale: CGFloat
    /// Its name, for VoiceOver.
    var name = "Picture"
    /// The viewer over the window: its zoom keys are the picture's while it's open, and the
    /// keyboard stays with the viewer for its arrows. The side panel's picture takes them once
    /// it has the keyboard, or while the pointer is over it.
    var ownsKeys = false
    /// A click beside the picture (the viewer closes).
    var tapOutside: (() -> Void)?
    /// The pictures before and after it, where it turns to them itself (the side panel's, among
    /// the conversation's): a swipe, ← → once it has the keyboard, and ‹ › under the pointer. The
    /// viewer over the window turns its own.
    var turns: Turns?
    @State private var pinch: CGFloat = 1
    @State private var isHovering = false
    @State private var swiped: CGFloat = 0
    @FocusState private var focused: Bool

    struct Turns {
        /// Whether there's one that way: -1 before, 1 after.
        var canTurn: (Int) -> Bool
        var turn: (Int) -> Void
    }

    var body: some View {
        GeometryReader { proxy in
            let room = proxy.size
            // In points, as Preview's Actual Size: a Retina screenshot at the size it was on screen.
            let size = image.size
            let fit = PictureZoom.fit(size, in: room)
            let side = max(size.width, size.height) * fit
            let current = PictureZoom.clamped(scale * pinch, fit: fit, side: side)
            ScrollView([.horizontal, .vertical]) {
                ZStack {
                    Color.clear
                        .contentShape(.rect)
                        .onTapGesture { tapOutside?() }
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(current * fit > 2 ? .none : .high)
                        .frame(width: max(1, size.width * fit * current), height: max(1, size.height * fit * current))
                        // Rounded while it's whole, as in the conversation.
                        .clipShape(.rect(cornerRadius: current > 1.001 ? 0 : 10))
                        .onTapGesture(count: 2) {
                            withAnimation(.ui) { scale = PictureZoom.toggled(scale, fit: fit, side: side) }
                        }
                }
                .frame(minWidth: room.width, minHeight: room.height)
            }
            .offset(x: swiped)
            .scrollIndicators(current > 1 ? .automatic : .never)
            .scrollBounceBehavior(.basedOnSize, axes: [.horizontal, .vertical])
            .defaultScrollAnchor(.center, for: .initialOffset)
            .defaultScrollAnchor(.center, for: .sizeChanges)
            .onAppear {
                fitScale = fit
                if let demo = Self.demoScale { scale = PictureZoom.clamped(demo, fit: fit, side: side) }
                // A file can finish loading while someone is typing in the composer.
                if !ownsKeys, !(NSApp.keyWindow?.firstResponder is NSTextView) { focused = true }
            }
            .onChange(of: fit) { _, value in fitScale = value }
            // Never past what it can draw, whatever set it (the viewer's zoom menu).
            .onChange(of: scale) { _, value in
                let most = PictureZoom.clamped(value, fit: fit, side: side)
                if most != value { scale = most }
            }
            .gesture(MagnifyGesture().onChanged { pinch = $0.magnification }.onEnded { _ in
                scale = current
                pinch = 1
            })
            .background(PictureKeys(isActive: ownsKeys || focused || isHovering) { characters in
                guard let zoomed = PictureZoom.key(characters, scale: scale, fit: fit, side: side) else { return false }
                withAnimation(.ui) { scale = zoomed }
                return true
            })
            .focusable(!ownsKeys)
            .focusEffectDisabled()
            .focused($focused)
            .help("Pinch or double-click to zoom")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(name)
            .accessibilityValue("\(PictureZoom.percent(current, fit: fit))%")
            .accessibilityAddTraits(.isImage)
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: scale = PictureZoom.zoomedIn(scale, fit: fit, side: side)
                case .decrement: scale = PictureZoom.zoomedOut(scale, fit: fit, side: side)
                @unknown default: break
                }
            }
            .background {
                if let turns {
                    PictureTurns(canTurn: turns.canTurn, swipes: current <= 1.001, arrows: focused, width: room.width) { travel in
                        if travel == 0 { withAnimation(.ui) { swiped = 0 } } else { swiped = travel }
                    } turn: { direction in
                        turns.turn(direction)
                        swiped = 0
                    }
                }
            }
        }
        .overlay {
            if let turns {
                HStack {
                    turnButton(-1, turns)
                    Spacer()
                    turnButton(1, turns)
                }
                .padding(.horizontal, 8)
            }
        }
        .onHover { isHovering = $0 }
    }

    /// ‹ or ›, in sight under the pointer where there's a picture that way.
    private func turnButton(_ direction: Int, _ turns: Turns) -> some View {
        let shows = isHovering && turns.canTurn(direction)
        return Button {
            turns.turn(direction)
        } label: {
            Image(systemName: direction < 0 ? "chevron.left" : "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 30, height: 30)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .disabled(!turns.canTurn(direction))
        .help(direction < 0 ? "Previous picture (←)" : "Next picture (→)")
        .opacity(shows ? 1 : 0)
        .allowsHitTesting(shows)
        .animation(.easeOut(duration: 0.15), value: shows)
        // VoiceOver offers it shown or not: hidden, it would be skipped.
        .accessibilityRepresentation {
            Button(direction < 0 ? "Previous Picture" : "Next Picture") { turns.turn(direction) }
                .disabled(!turns.canTurn(direction))
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

/// Going to the picture before or after, the same wherever a picture is looked at (the viewer,
/// the side panel): a swipe across it with two fingers on the trackpad, the picture following the
/// fingers until they let go (far enough, or a flick, and it turns; else it goes back), as in
/// Photos; a three-finger swipe where the trackpad pages that way; and ← →, while `arrows`. A
/// picture zoomed in (`swipes` false) moves under the fingers instead.
struct PictureTurns: NSViewRepresentable {
    /// Whether there's a picture that way: -1 before, 1 after.
    var canTurn: (Int) -> Bool
    var swipes: Bool
    var arrows: Bool
    /// Over everything (the viewer): ← → are its at either end too, and go nowhere else.
    var modal = false
    /// How wide it is: a third of it, or a flick, turns.
    var width: CGFloat
    /// How far the fingers have taken the picture (0 once they let go).
    var dragged: (CGFloat) -> Void
    var turn: (Int) -> Void

    func makeNSView(context: Context) -> Watcher { Watcher() }

    func updateNSView(_ view: Watcher, context: Context) {
        view.turns = self
    }

    final class Watcher: NSView {
        var turns: PictureTurns?
        private var monitor: Any?
        private enum Swipe { case undecided, mine, notMine, gliding }
        private var swipe: Swipe?
        private var travel = CGSize.zero
        private var started: TimeInterval = 0

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .swipe, .keyDown]) { [weak self] event in
                guard let self else { return event }
                switch event.type {
                case .scrollWheel: return self.scrolled(event) ? nil : event
                case .swipe: return self.swiped(event) ? nil : event
                default: return self.pressed(event) ? nil : event
                }
            }
        }

        /// Whether it's the one to turn now: the viewer's while it's open, over the panel's.
        private var isInFront: Bool {
            guard let turns, let window, window.attachedSheet == nil, !isHiddenOrHasHiddenAncestor else { return false }
            return turns.modal || ImageViewer.shared.request == nil
        }

        /// Whether `event` is in its window, with nothing over it, and where in it.
        private func isOver(_ event: NSEvent) -> Bool {
            guard let window, isInFront else { return false }
            let point: NSPoint
            if event.window === window {
                point = event.locationInWindow
            } else if event.window == nil, event.windowNumber == window.windowNumber {
                point = window.convertPoint(fromScreen: event.locationInWindow)
            } else {
                return false
            }
            return bounds.contains(convert(point, from: nil))
        }

        /// The fingers' way across, left negative, whichever way scrolling goes on this Mac.
        private static func across(_ event: NSEvent, _ x: CGFloat) -> CGFloat {
            event.isDirectionInvertedFromDevice ? x : -x
        }

        private func scrolled(_ event: NSEvent) -> Bool {
            guard let turns else { return false }
            // What glides on after a swipe of its own is its own too, to its end.
            if !event.momentumPhase.isEmpty {
                guard swipe == .gliding else { return false }
                if event.momentumPhase.contains(.ended) || event.momentumPhase.contains(.cancelled) { swipe = nil }
                return true
            }
            if event.phase.contains(.began) {
                guard isOver(event) else { swipe = nil; return false }
                swipe = .undecided
                travel = .zero
                started = event.timestamp
            }
            guard let current = swipe, current == .undecided || current == .mine else { return false }
            if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
                swipe = .gliding
                guard current == .mine else { swipe = nil; return false }
                let across = Self.across(event, travel.width)
                let seconds = max(0.001, event.timestamp - started)
                let direction = across < 0 ? 1 : -1
                let far = abs(across) > min(160, turns.width / 3) || (abs(across) > 30 && abs(across) / seconds > 600)
                if event.phase.contains(.ended), far, turns.canTurn(direction) {
                    turns.turn(direction)
                } else {
                    turns.dragged(0)
                }
                return true
            }
            guard event.phase.contains(.changed) || event.phase.contains(.began) else { return false }
            travel.width += event.scrollingDeltaX
            travel.height += event.scrollingDeltaY
            if current == .undecided {
                // Sideways more than up or down, on a picture that isn't zoomed in: a turn.
                guard abs(travel.width) + abs(travel.height) > 6 else { return turns.swipes }
                swipe = turns.swipes && abs(travel.width) > abs(travel.height) * 1.5 ? .mine : .notMine
                guard swipe == .mine else { return false }
            }
            let across = Self.across(event, travel.width)
            // Past either end it gives a little, and goes back.
            turns.dragged(turns.canTurn(across < 0 ? 1 : -1) ? across : across / 4)
            return true
        }

        /// A three-finger swipe, where the trackpad turns pages that way: left for the next.
        private func swiped(_ event: NSEvent) -> Bool {
            guard let turns, turns.swipes, event.deltaX != 0, isOver(event) else { return false }
            let direction = event.deltaX > 0 ? 1 : -1
            if turns.canTurn(direction) { turns.turn(direction) }
            return true
        }

        private func pressed(_ event: NSEvent) -> Bool {
            guard let turns, turns.arrows, event.keyCode == 123 || event.keyCode == 124, let window,
                  event.window === window, isInFront,
                  event.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty else { return false }
            // Typing in a field: its caret moves, unless the viewer is over it.
            if !turns.modal, (window.firstResponder as? NSTextView)?.isEditable == true { return false }
            let direction = event.keyCode == 123 ? -1 : 1
            guard turns.canTurn(direction) else { return turns.modal }
            turns.turn(direction)
            return true
        }
    }
}
