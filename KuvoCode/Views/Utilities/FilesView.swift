import AppKit
import Quartz
import SwiftUI
import UniformTypeIdentifiers

/// A file tab: the file on the left (rendered, highlighted or previewed), the project's
/// tree on the right. With no file yet, the tree fills the tab.
struct FilesView: View {
    /// The project's folders, the primary one first.
    let roots: [String]
    let file: URL?
    @Binding var showsTree: Bool
    /// Where the tree should open down to; `revealed` says it has.
    var reveal: URL?
    var revealed: () -> Void = {}
    let open: (URL) -> Void
    @State private var tree: FileTree
    @State private var width: CGFloat = 600

    init(roots: [String], file: URL?, showsTree: Binding<Bool>, reveal: URL? = nil, revealed: @escaping () -> Void = {}, open: @escaping (URL) -> Void) {
        self.roots = roots
        self.file = file
        _showsTree = showsTree
        self.reveal = reveal
        self.revealed = revealed
        self.open = open
        _tree = State(initialValue: FileTree(roots: roots.map(RemoteFolder.url)))
    }

    /// Each folder's path as its files' URLs have it: a machine's folder is named "ssh://…".
    private var rootPaths: [String] { roots.map { RemoteFolder.url($0).path } }

    /// The folder `file` is in, for its breadcrumb.
    private func root(of file: URL) -> String {
        rootPaths.firstIndex { file.path.hasPrefix($0 + "/") }.map { roots[$0] } ?? roots[0]
    }

    /// How a message names `file`, as "@" does: its path in the primary folder, after its
    /// folder's name in the others, in full anywhere else.
    private func mention(of file: URL) -> String {
        let paths = rootPaths
        guard let index = paths.firstIndex(where: { file.path.hasPrefix($0 + "/") }) else { return file.path }
        let relative = String(file.path.dropFirst(paths[index].count + 1))
        return index == 0 ? relative : RemoteFolder.url(roots[index]).lastPathComponent + "/" + relative
    }

    var body: some View {
        HStack(spacing: 0) {
            if let file {
                FileViewer(url: file, root: root(of: file), mention: mention(of: file), showsTree: $showsTree)
                    .id(file)
                    .frame(minWidth: 0, maxWidth: .infinity)
                    .clipped()
            }
            if showsTree || file == nil {
                if file != nil { Divider() }
                FileTreeView(tree: tree, selected: file, open: open)
                    .frame(width: file == nil ? nil : treeWidth)
                    .frame(maxWidth: file == nil ? .infinity : nil)
            }
        }
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { width = $0 }
        .task(id: reveal) {
            guard let reveal else { return }
            // In this project's tree, the tree shows beside the file.
            if await tree.reveal(reveal), file != nil { showsTree = true }
            revealed()
        }
    }

    /// Beside a file, the tree takes up to 260 points, less in a narrow panel, so the file
    /// keeps most of the room.
    private var treeWidth: CGFloat {
        min(260, max(140, width * 0.4))
    }
}

// MARK: - Tree

@Observable
final class FileTree {
    struct Entry: Identifiable, Hashable {
        let url: URL
        let isDirectory: Bool
        var id: URL { url }
        var name: String { url.lastPathComponent }

        /// Folders first, then names as Finder orders them: file3 before file29.
        static func inFinderOrder(_ a: Entry, _ b: Entry) -> Bool {
            if a.isDirectory != b.isDirectory { return a.isDirectory }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    /// The project's folders, the primary one first.
    let roots: [URL]
    var expanded: Set<URL> = []
    var filter = ""
    private var children: [URL: [Entry]] = [:]
    /// Every file, for filtering; read on first use.
    private(set) var allFiles: [ProjectFiles.File]?

    init(roots: [URL]) {
        self.roots = roots
        // With several folders each is a row of its own; the primary one starts open.
        if roots.count > 1, let primary = roots.first { expanded.insert(primary) }
    }

    /// The tree as rows, with each row's depth: one folder's contents, or each folder with
    /// its contents under it.
    var rows: [(entry: Entry, depth: Int)] {
        var rows: [(Entry, Int)] = []
        func walk(_ directory: URL, depth: Int) {
            for entry in entries(in: directory) {
                rows.append((entry, depth))
                if entry.isDirectory, expanded.contains(entry.url) { walk(entry.url, depth: depth + 1) }
            }
        }
        if roots.count == 1, let root = roots.first {
            walk(root, depth: 0)
        } else {
            for root in roots {
                rows.append((Entry(url: root, isDirectory: true), 0))
                if expanded.contains(root) { walk(root, depth: 1) }
            }
        }
        return rows
    }

    /// Files whose path contains the filter, up to a few hundred.
    var matches: [ProjectFiles.File] {
        let query = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty, let allFiles else { return [] }
        return Array(allFiles.lazy.filter { $0.path.lowercased().contains(query) }.prefix(300))
    }

    func toggle(_ directory: URL) {
        if expanded.contains(directory) { expanded.remove(directory) } else { expanded.insert(directory) }
    }

    func entries(in directory: URL) -> [Entry] {
        if let cached = children[directory] { return cached }
        if !directory.isFileURL {
            // On a machine: read in the background, shown when it's in.
            children[directory] = []
            Task {
                let listed = await Task.detached { RemoteShell.list(directory) ?? [] }.value
                children[directory] = listed
                    .map { Entry(url: directory.appending(path: $0.name, directoryHint: $0.isDirectory ? .isDirectory : .notDirectory), isDirectory: $0.isDirectory) }
                    .sorted(by: Entry.inFinderOrder)
            }
            return []
        }
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        let entries = urls
            .filter { $0.lastPathComponent != ".DS_Store" }
            .map { Entry(url: $0, isDirectory: (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true) }
            .sorted(by: Entry.inFinderOrder)
        children[directory] = entries
        return entries
    }

    /// Opens the tree down to `target` (and it too, a folder), reading it afresh: an agent just
    /// made it, maybe. A machine's folders are read in the background, so each level waits for
    /// its listing.
    @discardableResult
    func reveal(_ target: URL) async -> Bool {
        guard let root = roots.first(where: { $0.scheme == target.scheme && $0.host() == target.host() && (target.path == $0.path || target.path.hasPrefix($0.path + "/")) }) else { return false }
        filter = ""
        reload()
        if roots.count > 1 { expanded.insert(root) }
        var directory = root
        for part in target.path.dropFirst(root.path.count).split(separator: "/").map(String.init) {
            var entry = entries(in: directory).first { $0.name == part }
            for _ in 0..<50 where entry == nil && !directory.isFileURL {
                try? await Task.sleep(for: .milliseconds(150))
                entry = entries(in: directory).first { $0.name == part }
            }
            guard let entry, entry.isDirectory else { return true }
            expanded.insert(entry.url)
            directory = entry.url
        }
        return true
    }

    /// Forgets what's been read, so the tree shows files created since.
    func reload() {
        children = [:]
        allFiles = nil
    }

    func loadAllFiles() async {
        guard allFiles == nil else { return }
        let roots = roots
        allFiles = await Task.detached { ProjectFiles.list(roots) }.value
    }
}

private struct FileTreeView: View {
    @Bindable var tree: FileTree
    let selected: URL?
    let open: (URL) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Filter files…", text: $tree.filter)
                    .textFieldStyle(.plain)
                if !tree.filter.isEmpty {
                    Button { tree.filter = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(ClearFieldButtonStyle())
                }
            }
            .font(.system(size: 13))
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(Color.primary.opacity(0.05), in: .rect(cornerRadius: 8))
            .padding(10)
            .task(id: tree.filter.isEmpty) { if !tree.filter.isEmpty { await tree.loadAllFiles() } }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    if tree.filter.isEmpty {
                        ForEach(tree.rows, id: \.entry.id) { row in
                            TreeRow(entry: row.entry, depth: row.depth, isRoot: tree.roots.count > 1 && row.depth == 0, isOpen: tree.expanded.contains(row.entry.url), isSelected: row.entry.url == selected) {
                                if row.entry.isDirectory { tree.toggle(row.entry.url) } else { open(row.entry.url) }
                            }
                        }
                    } else {
                        ForEach(tree.matches) { match in
                            MatchRow(path: match.path, isSelected: match.url == selected) { open(match.url) }
                        }
                        if tree.allFiles == nil {
                            Spinner(size: 16).padding()
                        } else if tree.matches.isEmpty {
                            Text("No matching files")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .padding(10)
                        }
                    }
                }
                .padding(.horizontal, 6)
                .padding(.bottom, 10)
            }
        }
        .contextMenu {
            Button("Reload") { tree.reload() }
        }
    }
}

private struct TreeRow: View {
    let entry: FileTree.Entry
    let depth: Int
    /// One of the project's folders, in a tree of several.
    var isRoot = false
    let isOpen: Bool
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Group {
                    if entry.isDirectory {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(isOpen ? 90 : 0))
                    } else {
                        Image(nsImage: NSWorkspace.shared.icon(of: entry.url))
                            .resizable()
                            .frame(width: 16, height: 16)
                    }
                }
                .frame(width: 16)
                Text(entry.name)
                    .font(.system(size: 13, weight: isRoot ? .semibold : .regular))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .padding(.leading, 6 + CGFloat(depth) * 14)
            .padding(.trailing, 6)
            .frame(height: 26)
            .hoverHighlight(in: RoundedRectangle(cornerRadius: 6), selected: isSelected)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .contextMenu {
            if entry.url.isFileURL {
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([entry.url]) }
            }
            Button("Copy Path") { copyPath(entry.url) }
        }
    }
}

private struct MatchRow: View {
    let path: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 1) {
                Text((path as NSString).lastPathComponent)
                    .font(.system(size: 13))
                let folder = (path as NSString).deletingLastPathComponent
                if !folder.isEmpty {
                    Text(folder)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .truncationMode(.head)
                }
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .hoverHighlight(in: RoundedRectangle(cornerRadius: 6), selected: isSelected)
        }
        .buttonStyle(.plain)
        .clickablePointer()
    }
}

extension NSWorkspace {
    /// A file's icon: its own on this Mac; for a file on a machine, its kind's.
    func icon(of url: URL) -> NSImage {
        if url.isFileURL { return icon(forFile: url.path) }
        if url.hasDirectoryPath { return icon(for: .folder) }
        return icon(for: UTType(filenameExtension: url.pathExtension) ?? .data)
    }
}

private func copyPath(_ url: URL) {
    Clipboard.copy(url.path)
}

// MARK: - Viewer

/// One file: Markdown rendered (or its source), code highlighted with line numbers,
/// pictures shown, anything else in Quick Look.
private struct FileViewer: View {
    let url: URL
    let root: String
    let mention: String
    @Binding var showsTree: Bool
    @Environment(AppModel.self) private var app
    @State private var content: Content?
    @State private var showsSource = false

    enum Content {
        case text(String)
        case image(NSImage)
        case preview
    }

    private var isMarkdown: Bool { ["md", "markdown", "mdx"].contains(url.pathExtension.lowercased()) }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Group {
                switch content {
                case .text(let text) where isMarkdown && !showsSource:
                    ScrollView {
                        // Drawn as replies are (TextKit), so a long file opens at once. Its own
                        // pictures, beside it; none from the web (a README's badges and tracking
                        // pixels would reach their hosts as you open it).
                        ReplyView(markdown: text, parser: MathMarkdownParser(), images: url.deletingLastPathComponent(), diagrams: true) { link in
                            // Another file of the project's, here; web links in the browser.
                            let file = link.isFileURL ? link : link.scheme == nil && !link.path.isEmpty
                                ? URL(filePath: link.path(percentEncoded: false), relativeTo: url.deletingLastPathComponent()).standardizedFileURL : nil
                            guard let file else { return false }
                            app.utilities.show(file)
                            return true
                        }
                        .transcriptFont()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(20)
                    }
                case .text(let text):
                    CodeTextView(text: text, language: CodeHighlighter.language(for: url.path)) { lines in
                        let range = lines.count == 1 ? "\(lines.lowerBound)" : "\(lines.lowerBound)-\(lines.upperBound)"
                        app.utilities.addToMessage?("@\(mention):\(range)")
                    }
                case .image(let image):
                    ScrollView([.horizontal, .vertical]) {
                        Image(nsImage: image)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: image.size.width, maxHeight: image.size.height)
                            .padding(20)
                    }
                case .preview where !url.isFileURL:
                    ContentUnavailableView("No Preview", systemImage: "doc", description: Text("This file can’t be shown here."))
                case .preview:
                    QuickLookView(url: url)
                case nil:
                    Spinner(size: 24).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task(id: "\(url.absoluteString)\n\(app.utilities.fileShown)") {
            content = await Self.load(url)
            // Changed on disk (by the agent, say): shown again as it is. A machine's file is read
            // again when it's shown again, which reading it each time would cost a round trip for.
            guard url.isFileURL else { return }
            var seen = Self.modified(url)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                let now = Self.modified(url)
                if now != seen {
                    seen = now
                    content = await Self.load(url)
                }
            }
        }
    }

    /// Read from the disk each time (a URL keeps the values it was asked for).
    private static func modified(_ url: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }

    private var header: some View {
        HStack(spacing: 6) {
            breadcrumb
                .lineLimit(1)
                .truncationMode(.head)
                .help(url.path)
            Spacer(minLength: 8)
            if isMarkdown {
                Button(showsSource ? "View Rendered" : "View Source") { showsSource.toggle() }
                    .buttonStyle(.plain)
                    .clickablePointer()
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 10)
                    .frame(height: 26)
                    .hoverHighlight(in: Capsule())
            }
            Button { withAnimation(.ui) { showsTree.toggle() } } label: {
                Image(systemName: "sidebar.right")
            }
            .buttonStyle(CardActionStyle())
            .help(showsTree ? "Hide Files" : "Show Files")
            // A machine's files open nowhere on this Mac.
            if url.isFileURL { OpenMenu(url: url) }
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .frame(height: 40)
    }

    /// "kuvo-ai › Sources › App.swift".
    private var breadcrumb: Text {
        let base = RemoteFolder.url(root)
        // A file outside the project shows under its own folder.
        let parts = url.path.hasPrefix(base.path + "/")
            ? [base.lastPathComponent] + url.path.dropFirst(base.path.count + 1).split(separator: "/").map(String.init)
            : [url.deletingLastPathComponent().lastPathComponent, url.lastPathComponent]
        var text = Text("")
        for (index, part) in parts.enumerated() {
            let isLast = index == parts.count - 1
            if index > 0 { text = Text("\(text)\(Text("  ›  ").foregroundStyle(.tertiary))") }
            let partText = Text(part)
                .font(.system(size: 13, weight: isLast ? .semibold : .regular))
                .foregroundStyle(isLast ? .primary : .secondary)
            text = Text("\(text)\(partText)")
        }
        return text
    }

    /// Text up to 2 MB as text, pictures as pictures, the rest for Quick Look.
    private static func load(_ url: URL) async -> Content {
        await Task.detached { () -> Content in
            let type = UTType(filenameExtension: url.pathExtension)
            if !url.isFileURL {
                // On a machine: pictures and text, read over SSH; nothing for Quick Look there.
                guard let data = RemoteShell.read(url, limit: 2_000_001) else { return .preview }
                if type?.conforms(to: .image) == true, let image = NSImage(data: data) { return .image(image) }
                if data.count <= 2_000_000, !data.contains(0), let text = String(data: data, encoding: .utf8) { return .text(text) }
                return .preview
            }
            if type?.conforms(to: .image) == true, let image = NSImage(contentsOf: url) { return .image(image) }
            if type?.conforms(to: .pdf) == true { return .preview }
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            if size <= 2_000_000, let data = try? Data(contentsOf: url), !data.contains(0),
               let text = String(data: data, encoding: .utf8) {
                return .text(text)
            }
            return .preview
        }.value
    }
}

/// "Open" in the file's default app, and beside it a chevron for the other apps that open it.
/// (A menu behind a long press went unnoticed: a click only ever opened the default.)
private struct OpenMenu: View {
    let url: URL

    var body: some View {
        let workspace = NSWorkspace.shared
        let defaultApp = OpenWith.defaultApp(for: url)
        HStack(spacing: 0) {
            Button { OpenWith.open(url) } label: {
                HStack(spacing: 6) {
                    if let defaultApp {
                        Image(nsImage: workspace.icon(forFile: defaultApp.path))
                            .resizable()
                            .frame(width: 16, height: 16)
                    }
                    Text("Open")
                }
            }
            .buttonStyle(TextButtonStyle(cornerRadius: 7))
            .help(defaultApp.map { "Open in \(OpenWith.name(of: $0))" } ?? "Open")
            // An AppKit menu: SwiftUI's leaves out the apps' icons.
            NativeMenuButton(name: "openwith", opensBelow: true) {
                let menu = NSMenu()
                OpenWith.items(for: url).forEach(menu.addItem)
                menu.addItem(.separator())
                menu.addItem(ActionItem("Show in Finder") { workspace.activateFileViewerSelecting([url]) })
                menu.addItem(ActionItem("Copy Path") { copyPath(url) })
                return menu
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .frame(width: 20, height: 24)
                    .hoverHighlight(in: RoundedRectangle(cornerRadius: 7), mutesInk: true)
            }
            .help("Open With")
        }
        .font(.system(size: 12, weight: .medium))
        .fixedSize()
    }
}

/// The apps that open a file, as menu items with their icons: its default first, then the others
/// macOS knows for it, five in all, and Other… for any app.
enum OpenWith {
    /// Settings › General: the app code and text files open in, by bundle identifier; empty for
    /// each file's own default.
    static let editorKey = "openFiles.editor"

    /// Editors people use for code, by bundle identifier, as Settings offers them when installed.
    static let knownEditors = [
        "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92", "com.exafunction.windsurf", "dev.zed.Zed",
        "com.apple.dt.Xcode", "com.sublimetext.4", "com.panic.Nova", "com.barebones.bbedit",
        "com.jetbrains.intellij", "com.jetbrains.WebStorm", "com.jetbrains.pycharm", "com.vscodium", "com.apple.TextEdit",
    ]

    /// The editors in `knownEditors` that are on this Mac, with where they are.
    static var installedEditors: [(id: String, url: URL)] {
        knownEditors.compactMap { id in NSWorkspace.shared.urlForApplication(withBundleIdentifier: id).map { (id, $0) } }
    }

    /// The editor chosen in Settings, when it's still installed.
    static var preferredEditor: URL? {
        guard let id = UserDefaults.standard.string(forKey: editorKey), !id.isEmpty else { return nil }
        return NSWorkspace.shared.urlForApplication(withBundleIdentifier: id)
    }

    /// The app Open uses: the chosen editor for code and text, else the file's own default.
    static func defaultApp(for url: URL) -> URL? {
        if let editor = preferredEditor, isText(url) { return editor }
        return NSWorkspace.shared.urlForApplication(toOpen: url)
    }

    static func open(_ url: URL) {
        if let editor = preferredEditor, isText(url) {
            NSWorkspace.shared.open([url], withApplicationAt: editor, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    /// Code and text (and files with no known type, like Makefile): what an editor is for.
    private static func isText(_ url: URL) -> Bool {
        guard let type = UTType(filenameExtension: url.pathExtension), !url.pathExtension.isEmpty else { return true }
        return type.conforms(to: .text) || type.conforms(to: .sourceCode) || type.conforms(to: .data) && !type.conforms(to: .image) && !type.conforms(to: .audiovisualContent) && !type.conforms(to: .pdf) && !type.conforms(to: .archive)
    }

    static func items(for url: URL) -> [NSMenuItem] {
        let workspace = NSWorkspace.shared
        let defaultApp = defaultApp(for: url)
        var items: [NSMenuItem] = apps(for: url).map { app in
            ActionItem(app == defaultApp ? "\(name(of: app)) (Default)" : name(of: app), image: icon(of: app)) {
                workspace.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
            }
        }
        items.append(ActionItem("Other…") { chooseApp(for: url) })
        return items
    }

    static func apps(for url: URL) -> [URL] {
        let workspace = NSWorkspace.shared
        var apps = workspace.urlsForApplications(toOpen: url)
        if let defaultApp = defaultApp(for: url) {
            apps.removeAll { $0 == defaultApp }
            apps.insert(defaultApp, at: 0)
        }
        return Array(apps.prefix(5))
    }

    static func name(of app: URL) -> String {
        FileManager.default.displayName(atPath: app.path).replacingOccurrences(of: ".app", with: "")
    }

    /// At menu size: an app's icon comes large.
    private static func icon(of app: URL) -> NSImage {
        let icon = NSWorkspace.shared.icon(forFile: app.path).copy() as? NSImage ?? NSImage()
        icon.size = NSSize(width: 16, height: 16)
        return icon
    }

    private static func chooseApp(for url: URL) {
        let panel = NSOpenPanel()
        panel.directoryURL = URL(filePath: "/Applications")
        panel.allowedContentTypes = [.application]
        panel.prompt = "Open"
        panel.message = "Choose an app to open \(url.lastPathComponent) with."
        guard panel.runModal() == .OK, let app = panel.url else { return }
        NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
    }
}

/// Quick Look, for anything the panel doesn't draw itself.
private struct QuickLookView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> QLPreviewView {
        let view = QLPreviewView(frame: .zero, style: .normal)!
        view.autostarts = true
        view.previewItem = url as NSURL
        return view
    }

    func updateNSView(_ view: QLPreviewView, context: Context) {
        if (view.previewItem as? NSURL) as URL? != url { view.previewItem = url as NSURL }
    }

    static func dismantleNSView(_ view: QLPreviewView, coordinator: ()) {
        view.close()
    }
}
