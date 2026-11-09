import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI
import UniformTypeIdentifiers

/// Something attached to a message: kept by the engine, still on its way (a local file),
/// or sent as a path for the agent to open.
nonisolated enum AttachmentItem: Identifiable, Sendable {
    case stored(Message.User.Attachment, id: String)
    case local(URL)
    case path(String)
    case remote(String, machine: String)

    var id: String {
        switch self {
        case .stored(_, let id): id
        case .local(let url): url.absoluteString
        case .path(let path): "path:" + path
        case .remote(let path, let machine): "remote:" + machine + ":" + path
        }
    }

    var name: String {
        switch self {
        case .stored(let file, _): file.name ?? file.fileURL?.lastPathComponent ?? "Attachment"
        case .local(let url): url.lastPathComponent
        case .path(let path): (path as NSString).lastPathComponent
        case .remote(let path, _): (path as NSString).lastPathComponent
        }
    }

    /// The file on disk, if it's still there.
    var fileURL: URL? {
        let url: URL? = switch self {
        case .stored(let file, _): file.fileURL
        case .local(let url): url
        case .path(let path): URL(filePath: path)
        case .remote: nil
        }
        return url.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
    }

    /// From the file name when it says more than the stored type (a `.swift` file is more than
    /// "text") or that says nothing; the stored type otherwise, so a name can't make a picture a
    /// script.
    var type: UTType? {
        let byName = UTType(filenameExtension: (name as NSString).pathExtension)
        guard case .stored(let file, _) = self, let declared = UTType(mimeType: file.mime) else { return byName }
        guard let byName else { return declared }
        let saysMore = byName.conforms(to: declared) || (declared.conforms(to: .text) && byName.conforms(to: .text))
        return saysMore || declared.isDynamic || declared == .data ? byName : declared
    }

    var isImage: Bool { type?.conforms(to: .image) == true }

    /// "PNG image · 1.2 MB".
    var detail: String {
        let kind = isFolder ? "Folder" : type?.localizedDescription?.capitalizedFirst ?? "File"
        guard let bytes = byteCount, !isFolder else { return kind }
        return kind + " · " + bytes.formatted(.byteCount(style: .file))
    }

    private var isFolder: Bool {
        if case .stored(let file, _) = self { return file.mime == "application/x-directory" }
        return (try? fileURL?.resourceValues(forKeys: [.isDirectoryKey]))??.isDirectory == true
    }

    private var byteCount: Int? {
        if case .stored(let file, _) = self, let size = file.size { return size }
        return (try? fileURL?.resourceValues(forKeys: [.fileSizeKey]))??.fileSize
    }

    /// Changes with what it shows: a message's copy from the engine takes the place of the one
    /// it was sent with, under the same id. Cheap, as views compare it each time they update.
    var contentID: String {
        guard case .stored(let file, let id) = self else { return id }
        let source = switch file.source {
        case .uri(let uri)? where uri.hasPrefix("data:"): Self.sample(uri)
        case .uri(let uri)?: uri
        case .inline?: "inline"
        case nil: ""
        }
        return [id, file.mime, file.data.map(Self.sample) ?? "", source].joined(separator: "|")
    }

    /// A long string's length and two pieces of it: enough to tell two files apart without
    /// reading them.
    private static func sample(_ text: String) -> String {
        let utf8 = text.utf8
        let middle = utf8.index(utf8.startIndex, offsetBy: utf8.count / 2)
        return "\(utf8.count)," + String(decoding: utf8[middle...].prefix(32), as: UTF8.self) + "," + String(decoding: utf8.suffix(32), as: UTF8.self)
    }

    func loadImage() async -> NSImage? {
        let key = contentID as NSString
        if let cached = AttachmentImages.cache.object(forKey: key) { return cached }
        if case .remote(let path, let machine) = self {
            guard let data = try? await BoxClient.machine(machine).file(path), let image = NSImage(data: data) else { return nil }
            AttachmentImages.cache.setObject(image, forKey: key)
            return image
        }
        let item = self
        let image = await Task.detached(priority: .userInitiated) { () -> NSImage? in
            if let url = item.fileURL, let image = NSImage(contentsOf: url) { return image }
            if case .stored(let file, _) = item, let bytes = file.bytes { return NSImage(data: bytes) }
            return nil
        }.value
        if let image { AttachmentImages.cache.setObject(image, forKey: key) }
        return image
    }

    /// Opens it in its app. Anything that could run (an app, a script, an installer) shows in
    /// Finder instead: a click on an attachment never runs it.
    func open() {
        guard let url = localURL() else { return }
        if Attachments.canRun(url) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    /// Where it is on this Mac; one that only the engine has (a pasted image, a tool's picture)
    /// is written out first, once, as a download of its type.
    func localURL() -> URL? {
        if let url = fileURL { return url }
        if let written = AttachmentImages.written(id), FileManager.default.fileExists(atPath: written.path) { return written }
        guard case .stored(let file, let id) = self else { return nil }
        if let written = AttachmentImages.written(id), FileManager.default.fileExists(atPath: written.path) { return written }
        guard let bytes = file.bytes, let url = Attachments.writeReceived(bytes, named: name, type: type) else { return nil }
        AttachmentImages.wrote(url, for: id)
        return url
    }

    func readBytes() async -> Data? {
        if case .remote(let path, let machine) = self { return try? await BoxClient.machine(machine).file(path) }
        if let url = fileURL { return try? Data(contentsOf: url) }
        if case .stored(let file, _) = self { return file.bytes }
        return nil
    }

    func revealInFinder() {
        if let url = fileURL { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }
}

/// Decoded pictures, so scrolling the transcript doesn't decode them again. NSCache is thread-safe.
nonisolated enum AttachmentImages {
    nonisolated(unsafe) static let cache = NSCache<NSString, NSImage>()

    /// Where each attachment only the engine had was written out, so opening it again opens
    /// that copy rather than writing another.
    nonisolated(unsafe) private static var writtenOut: [String: URL] = [:]
    private static let lock = NSLock()
    static func written(_ id: String) -> URL? { lock.withLock { writtenOut[id] } }
    static func wrote(_ url: URL, for id: String) { lock.withLock { writtenOut[id] = url } }
}

nonisolated private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

// MARK: - In the composer

/// A file waiting to be sent: a preview or its icon, its name and kind, and a remove
/// button. Files that go as a path say so (in orange when the model can't read them), and so
/// does one too big to send to a machine, in orange; the reason shows on hover.
struct ComposerAttachment: View {
    let url: URL
    var route: Attachments.Route = .content
    /// A picture's place among the message's pictures: its name in the message, "[Image 2]".
    var number: Int?
    var pictures: [URL] = []
    let remove: () -> Void
    @State private var isHovering = false

    /// A pasted picture goes by its name in the message; a file by its own name.
    private var title: String {
        if let number, Attachments.isPasted(url) { return "Image \(number)" }
        return AttachmentItem.local(url).name
    }

    /// What it is, and a picture's name in the message when its title is the file's.
    private var detail: String {
        let detail = switch route {
        case .content: AttachmentItem.local(url).detail
        case .path: "Sent as a path"
        case .staysHere: "Stays on this Mac"
        }
        guard let number, !Attachments.isPasted(url) else { return detail }
        return "Image \(number) · " + detail
    }

    var body: some View {
        let item = AttachmentItem.local(url)
        HStack(spacing: 8) {
            AttachmentIcon(item: item, size: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(isWarning ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
            }
            .frame(maxWidth: 170, alignment: .leading)
        }
        .padding(.leading, 6)
        .padding(.trailing, 10)
        .padding(.vertical, 6)
        .background(Color.primary.opacity(0.05), in: .rect(cornerRadius: 10))
        .specularRim(RoundedRectangle(cornerRadius: 10))
        .overlay(alignment: .topTrailing) {
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 14))
            }
            .buttonStyle(BadgeButtonStyle())
            .offset(x: 5, y: -5)
            .opacity(isHovering ? 1 : 0)
            .help("Remove")
        }
        .onHover { isHovering = $0 }
        // A picture opens in the viewer.
        .contentShape(.rect(cornerRadius: 10))
        .onTapGesture { showPicture(item) }
        .help(reason.map { "\(url.path)\n\($0)" } ?? url.path)
        // One element for VoiceOver, whose remove button is there only on hover.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(detail)
        .accessibilityAction(named: "Remove", remove)
        .accessibilityAction { showPicture(item) }
    }

    private func showPicture(_ item: AttachmentItem) {
        guard item.isImage else { return }
        let images = pictures.isEmpty ? [url] : pictures
        ImageViewer.shared.show(images.map(AttachmentItem.local), at: images.firstIndex(of: url) ?? 0)
    }

    private var reason: String? {
        switch route {
        case .content: nil
        case .path(let reason, _), .staysHere(let reason): reason
        }
    }

    private var isWarning: Bool {
        switch route {
        case .content: false
        case .path(_, let isWarning): isWarning
        case .staysHere: true
        }
    }
}

/// A thumbnail for images, the file's own icon otherwise.
private struct AttachmentIcon: View {
    let item: AttachmentItem
    let size: CGFloat
    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image, item.isImage {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: size, height: size)
                    .clipShape(.rect(cornerRadius: 6))
            } else {
                Image(nsImage: icon)
                    .resizable()
                    .frame(width: size, height: size)
            }
        }
        .task(id: item.contentID) { if item.isImage { image = await item.loadImage() } }
    }

    private var icon: NSImage {
        if let url = item.fileURL { return NSWorkspace.shared.icon(forFile: url.path) }
        return NSWorkspace.shared.icon(for: item.type ?? .data)
    }
}

// MARK: - In the transcript

/// A message's attachments, above its text: images as pictures, other files as rows.
struct MessageAttachments: View {
    let items: [AttachmentItem]

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            let images = items.filter(\.isImage)
            if !images.isEmpty {
                Flow(alignment: .trailing, spacing: 6) {
                    ForEach(Array(images.enumerated()), id: \.element.id) { index, item in
                        AttachmentPicture(item: item, height: images.count == 1 ? 220 : 140) {
                            ImageViewer.shared.show(images, at: index)
                        }
                    }
                }
            }
            ForEach(items.filter { !$0.isImage }) { item in
                AttachmentRow(item: item)
            }
        }
    }
}

/// An image the agent made (generate_image, whichever agent's), in the conversation's flow as
/// its widgets are: a line while it's being made, then the picture, large, to click for a closer look.
/// A file it showed you (show_file) too: a picture as one it made, any other file as a row that
/// opens it in the side panel, with its caption under it.
struct MadePictureRow: View {
    let call: Message.ToolCall
    /// Where the conversation runs, for a file it showed on a machine.
    var directory: String?
    @Environment(AppModel.self) private var app

    static func isMade(_ call: Message.ToolCall) -> Bool {
        call.name == "generate_image" || isShownFile(call) || isShownPage(call)
    }

    /// A screenshot of the page the agent took to show you (browser_screenshot's show).
    static func isShownPage(_ call: Message.ToolCall) -> Bool {
        call.name == "kuvo-browser_browser_screenshot" && call.state.input?["show"]?.bool == true
    }

    static func isShownFile(_ call: Message.ToolCall) -> Bool {
        call.name == "kuvo-browser_" + BrowserTools.showFile
    }

    static func isGroupable(_ call: Message.ToolCall) -> Bool {
        guard isShownFile(call), case .completed = call.state,
              let path = call.state.input?["path"]?.string,
              UTType(filenameExtension: (path as NSString).pathExtension)?.conforms(to: .image) == true else { return false }
        return true
    }

    /// Consecutive pictures form one gallery; intervening content starts another.
    static func groups(in content: [Message.Content]) -> [Int: [Message.ToolCall]] {
        var groups: [Int: [Message.ToolCall]] = [:]
        var start: Int?
        for (index, block) in content.enumerated() {
            if case .tool(let call) = block, isGroupable(call) {
                if start == nil { start = index }
                groups[start!, default: []].append(call)
            } else {
                start = nil
            }
        }
        return groups
    }

    var body: some View {
        if Self.isShownFile(call) { shownFile } else { made }
    }

    @ViewBuilder private var shownFile: some View {
        let path = call.state.input?["path"]?.string ?? ""
        let name = (path as NSString).lastPathComponent
        switch call.state {
        case .completed:
            let url = RemoteFolder.fileURL(path, in: directory ?? "/")
            VStack(alignment: .leading, spacing: 6) {
                if UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true {
                    StepPictures(items: [ShownPictures.item(url)], height: 420, maxWidth: 560)
                } else {
                    AttachmentRow(item: .path(path)) { app.utilities.show(url) }
                }
                if let caption = call.state.input?["caption"]?.string, !caption.isEmpty {
                    Text(caption)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        case .failed(_, let error, _, _):
            line("Couldn't show \(name.isEmpty ? "the file" : name): \(error.message)", symbol: "exclamationmark.triangle")
        default:
            HStack(spacing: 8) {
                Spinner(size: 12)
                Text("Showing \(name.isEmpty ? "a file" : name)…")
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var made: some View {
        switch call.state {
        case .completed(_, let output, _):
            let items = StepPictures.items(in: output, step: call.id)
            if items.isEmpty {
                line(Self.isShownPage(call) ? "Took a screenshot, but it didn't come back" : "Made an image, but it isn't where it said", symbol: "photo")
            } else {
                StepPictures(items: items, height: 420, maxWidth: 560)
            }
        case .failed(_, let error, _, _):
            line((Self.isShownPage(call) ? "Couldn't take the screenshot: " : "Couldn't make the image: ") + error.message, symbol: "exclamationmark.triangle")
        default:
            HStack(spacing: 8) {
                Spinner(size: 12)
                Text(Self.isShownPage(call) ? "Taking a screenshot…" : "Making an image…")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func line(_ text: String, symbol: String) -> some View {
        Label(text, systemImage: symbol)
            .foregroundStyle(.secondary)
    }
}

struct ShownPictures: View {
    let calls: [Message.ToolCall]
    let directory: String

    static func item(_ url: URL) -> AttachmentItem {
        if let remote = RemoteFolder.parse(url) { return .remote(remote.path, machine: remote.machine) }
        return .path(url.path)
    }

    var body: some View {
        let items = calls.compactMap { call -> AttachmentItem? in
            guard let path = call.state.input?["path"]?.string else { return nil }
            return Self.item(RemoteFolder.fileURL(path, in: directory))
        }
        StepPictures(items: items, height: items.count == 1 ? 420 : 140, maxWidth: items.count == 1 ? 560 : 220,
                     captions: calls.compactMap { call in
                         guard call.state.input?["path"]?.string != nil else { return nil }
                         return call.state.input?["caption"]?.string ?? ""
                     })
    }
}

/// Pictures a step brought back (a screenshot of the page the agent browses), under the step.
struct StepPictures: View {
    let items: [AttachmentItem]
    /// How tall and wide one may be: a step's are small, an image the agent made is shown large.
    var height: CGFloat?
    var maxWidth: CGFloat = 360
    var captions: [String] = []

    var body: some View {
        Flow(spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                VStack(alignment: .leading, spacing: 6) {
                    AttachmentPicture(item: item, height: height ?? (items.count == 1 ? 220 : 140), maxWidth: maxWidth) {
                        ImageViewer.shared.show(items, at: index)
                    }
                    if captions.indices.contains(index), !captions[index].isEmpty {
                        Text(captions[index])
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: maxWidth, alignment: .leading)
                    }
                }
            }
        }
    }

    /// The pictures among a step's results, from the data they carry or the files they name. A
    /// name the tool gives keeps only its stem: the extension is the picture type's.
    static func items(in output: [Message.ToolOutput], step: String) -> [AttachmentItem] {
        output.enumerated().compactMap { index, part -> AttachmentItem? in
            guard case .file(let uri, let mime, let name) = part, mime.lowercased().hasPrefix("image/") else { return nil }
            let type = UTType(mimeType: mime).flatMap { $0.conforms(to: .image) ? $0 : nil } ?? .png
            let stem = name.map { (Attachments.fileName($0) as NSString).deletingPathExtension } ?? "Screenshot"
            let file = Message.User.Attachment(mime: mime, name: stem + "." + (type.preferredFilenameExtension ?? "png"), source: .uri(uri))
            return .stored(file, id: "\(step)-\(index)")
        }
    }
}

private struct AttachmentPicture: View {
    let item: AttachmentItem
    let height: CGFloat
    let maxWidth: CGFloat
    /// Opens it in the viewer.
    let view: () -> Void
    @State private var image: NSImage?
    /// Loaded without a picture (data that isn't one, a file that's gone): no spinner then.
    @State private var isMissing = false
    @State private var isHovering = false
    @Environment(\.colorScheme) private var scheme

    init(item: AttachmentItem, height: CGFloat, maxWidth: CGFloat = 360, view: @escaping () -> Void) {
        self.item = item
        self.height = height
        self.maxWidth = maxWidth
        self.view = view
        // One already decoded shows at once, rather than its placeholder first (as a message is
        // drawn again).
        _image = State(initialValue: AttachmentImages.cache.object(forKey: item.contentID as NSString))
    }

    var body: some View {
        Group {
            if let image {
                let size = fitted(image.size)
                // Narrower where the conversation is narrower than it, in its own shape.
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(size.width / size.height, contentMode: .fit)
                    .frame(idealWidth: size.width, maxWidth: size.width)
            } else {
                RoundedRectangle(cornerRadius: 12)
                    .fill(.fill.tertiary)
                    .aspectRatio(1.4, contentMode: .fit)
                    .frame(idealWidth: height * 1.4, maxWidth: height * 1.4)
                    .overlay {
                        if isMissing {
                            Image(systemName: "photo")
                                .font(.system(size: 20))
                                .foregroundStyle(.tertiary)
                        } else {
                            Spinner(size: 16)
                        }
                    }
            }
        }
        .clipShape(.rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Surface.wellBorder(scheme)).allowsHitTesting(false))
        // Under the pointer, a firmer edge and a touch of shade: it opens.
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .fill(Color.black.opacity(isHovering ? 0.06 : 0))
                .strokeBorder(.primary.opacity(isHovering ? 0.25 : 0), lineWidth: 1.5)
        }
        .contentShape(.rect(cornerRadius: 12))
        .onHover { isHovering = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovering)
        .onTapGesture(perform: view)
        .contextMenu { AttachmentMenu(item: item) }
        .help("\(item.name) — click to look closer")
        .task(id: item.contentID) {
            image = await item.loadImage()
            isMissing = image == nil
        }
    }

    /// The picture's own shape, at most `height` tall and `maxWidth` wide, never enlarged.
    private func fitted(_ size: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else { return CGSize(width: height, height: height) }
        let scale = min(maxWidth / size.width, height / size.height, 1)
        // At least a point each way: a thin banner keeps a shape to draw in.
        return CGSize(width: max(1, (size.width * scale).rounded()), height: max(1, (size.height * scale).rounded()))
    }
}

private struct AttachmentRow: View {
    let item: AttachmentItem
    /// What a click does, when not opening it in its app.
    var open: (() -> Void)?
    @State private var isHovering = false

    var body: some View {
        Button(action: open ?? item.open) {
            HStack(spacing: 10) {
                AttachmentIcon(item: item, size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.name)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(item.detail)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: 260, alignment: .leading)
            }
            .padding(.leading, 8)
            .padding(.trailing, 14)
            .padding(.vertical, 8)
            .background(isHovering ? AnyShapeStyle(.fill.secondary) : AnyShapeStyle(.fill.tertiary), in: .rect(cornerRadius: 14))
            .specularRim(RoundedRectangle(cornerRadius: 14))
            .contentShape(.rect(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .onHover { isHovering = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovering)
        .contextMenu { AttachmentMenu(item: item) }
        .help(item.fileURL?.path ?? item.name)
    }
}

private struct AttachmentMenu: View {
    let item: AttachmentItem

    var body: some View {
        Button("Open") { item.open() }
        Button("Show in Finder") { item.revealInFinder() }
            .disabled(item.fileURL == nil)
    }
}
