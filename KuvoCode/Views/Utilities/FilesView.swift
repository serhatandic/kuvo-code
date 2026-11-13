import AppKit
import ClientDesign
import OpenCodeKit
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
        // In a narrow panel the file takes it all: the tree folds away once a file opens, or the
        // panel narrows, and comes back from the toolbar.
        .onChange(of: file) { if file != nil, isNarrow { showsTree = false } }
        .onChange(of: isNarrow) { if isNarrow, file != nil { showsTree = false } }
        .task(id: reveal) {
            guard let reveal else { return }
            // In this project's tree, the tree shows beside the file.
            if await tree.reveal(reveal), file != nil { showsTree = true }
            revealed()
        }
    }

    /// Too narrow for the tree beside a file without squeezing its lines.
    private var isNarrow: Bool { width < 520 }

    /// Beside a file, the tree takes up to 260 points, less in a narrow panel, so the file
    /// keeps most of the room.
    private var treeWidth: CGFloat {
        min(260, max(140, width * 0.4))
    }
}

// MARK: - Tree

@Observable
final class FileTree {
    nonisolated struct Entry: Identifiable, Hashable, Sendable {
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

    /// A line of the tree: a file or folder, or, in an open folder, why nothing's under it.
    enum Row: Identifiable {
        case entry(Entry, depth: Int)
        /// An open folder that couldn't be read, and why.
        case unreadable(URL, FolderFailure, depth: Int)
        /// An open folder that was read, with nothing in it.
        case empty(URL, depth: Int)

        var id: String {
            switch self {
            case .entry(let entry, _): entry.url.absoluteString
            case .unreadable(let folder, _, _): "unreadable:" + folder.absoluteString
            case .empty(let folder, _): "empty:" + folder.absoluteString
            }
        }
    }

    /// The project's folders, the primary one first.
    let roots: [URL]
    var expanded: Set<URL> = []
    var filter = ""
    private var children: [URL: [Entry]] = [:]
    /// Folders that couldn't be read, and why: never shown as empty.
    private(set) var failures: [URL: FolderFailure] = [:]
    /// A machine's folders being read now.
    private(set) var loading: Set<URL> = []
    /// Each read of a machine's folder, counted: one overtaken by a later read (Reload, Try
    /// Again) lands nowhere.
    @ObservationIgnored private var reads: [URL: Int] = [:]
    /// Every file, for filtering; read on first use.
    private(set) var allFiles: [ProjectFiles.File]?
    /// Why filtering found nothing, when a folder couldn't be read.
    private(set) var allFilesFailure: FolderFailure?
    /// The list a filter searches waits for this Mac's box, which is starting.
    @ObservationIgnored private var waitsForBox = false

    init(roots: [URL]) {
        self.roots = roots
        // With several folders each is a row of its own; the primary one starts open.
        if roots.count > 1, let primary = roots.first { expanded.insert(primary) }
    }

    /// The tree as rows, with each row's depth: one folder's contents, or each folder with
    /// its contents under it; an open folder that couldn't be read, or has nothing, says so.
    var rows: [Row] {
        var rows: [Row] = []
        func walk(_ directory: URL, depth: Int) {
            let entries = entries(in: directory)
            if let failure = failures[directory] {
                rows.append(.unreadable(directory, failure, depth: depth))
            } else if entries.isEmpty, !loading.contains(directory) {
                rows.append(.empty(directory, depth: depth))
            }
            for entry in entries {
                rows.append(.entry(entry, depth: depth))
                if entry.isDirectory, expanded.contains(entry.url) { walk(entry.url, depth: depth + 1) }
            }
        }
        if roots.count == 1, let root = roots.first {
            walk(root, depth: 0)
        } else {
            for root in roots {
                rows.append(.entry(Entry(url: root, isDirectory: true), depth: 0))
                if expanded.contains(root) { walk(root, depth: 1) }
            }
        }
        return rows
    }

    /// The one folder shown, when it couldn't be read: the tree's whole room says so.
    var rootFailure: FolderFailure? {
        guard roots.count == 1, let root = roots.first else { return nil }
        _ = entries(in: root)
        return failures[root]
    }

    /// The one folder shown, while a machine reads it.
    var isLoadingRoot: Bool {
        guard roots.count == 1, let root = roots.first else { return false }
        _ = entries(in: root)
        return loading.contains(root)
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
            loading.insert(directory)
            let read = (reads[directory] ?? 0) + 1
            reads[directory] = read
            Task {
                let listed = await Task.detached(operation: { Self.list(directory) }).value
                guard reads[directory] == read else { return }
                switch listed {
                case .success(let listed):
                    failures[directory] = nil
                    children[directory] = listed
                case .failure(let failure):
                    failures[directory] = failure
                }
                loading.remove(directory)
            }
            return []
        }
        switch Self.list(directory) {
        case .success(let entries):
            children[directory] = entries
            return entries
        case .failure(let failure):
            children[directory] = []
            failures[directory] = failure
            return []
        }
    }

    /// Reads a folder that couldn't be read again.
    func retry(_ directory: URL) {
        reads[directory, default: 0] += 1
        failures[directory] = nil
        children[directory] = nil
        loading.remove(directory)
    }

    /// What the tree leaves out: Finder's own file, and version control's folders, which nobody
    /// works in by hand.
    nonisolated static let unlisted: Set<String> = [".DS_Store", ".git", ".hg", ".svn"]

    /// A folder's entries, folders first, or why it can't be read. A link to a folder is a
    /// folder, as on a machine (a package manager's linked packages).
    nonisolated static func list(_ directory: URL) -> Result<[Entry], FolderFailure> {
        if !directory.isFileURL {
            return RemoteShell.list(directory).map { listed in
                listed
                    .filter { !unlisted.contains($0.name) }
                    .map { Entry(url: directory.appending(path: $0.name, directoryHint: $0.isDirectory ? .isDirectory : .notDirectory), isDirectory: $0.isDirectory) }
                    .sorted(by: Entry.inFinderOrder)
            }
        }
        // A linked folder's contents, read where it leads, named under the link.
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: directory.resolvingSymlinksInPath().path(percentEncoded: false))
        } catch {
            return .failure(FolderFailure(error))
        }
        return .success(names
            .filter { !unlisted.contains($0) }
            .map { directory.appending(path: $0) }
            .map { url in
                let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                let isFolder = values?.isSymbolicLink == true
                    ? (try? url.resolvingSymlinksInPath().resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
                    : values?.isDirectory == true
                return Entry(url: url, isDirectory: isFolder)
            }
            .sorted(by: Entry.inFinderOrder))
    }

    /// Reads again what's been read, keeping what's open, so files the agent made, removed or
    /// renamed since show; a folder that can't be read now keeps what it showed, and one that
    /// couldn't be read (its machine asleep) shows its files once it can. A look overtaken by
    /// Reload or Try Again lands nowhere.
    func refresh() async {
        for directory in children.keys where !loading.contains(directory) {
            let read = reads[directory]
            guard case .success(let listed) = await Task.detached(operation: { Self.list(directory) }).value,
                  reads[directory] == read, children[directory] != nil else { continue }
            if failures[directory] != nil { failures[directory] = nil }
            if children[directory] != listed { children[directory] = listed }
        }
        // The list a filter searches: read again while one's typed, otherwise when one is.
        if filter.isEmpty {
            allFiles = nil
            allFilesFailure = nil
        } else if allFiles != nil {
            let roots = roots
            let listing = await ProjectFiles.listing(roots)
            // This Mac's box starting again (after an update): what showed stays until it answers.
            guard listing.failure != .starting else { return }
            if listing.files != allFiles { allFiles = listing.files }
            if listing.failure != allFilesFailure { allFilesFailure = listing.failure }
        } else if waitsForBox {
            await loadAllFiles()
        }
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
            for _ in 0..<50 where entry == nil && !directory.isFileURL && failures[directory] == nil {
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
        reads = reads.mapValues { $0 + 1 }
        children = [:]
        failures = [:]
        loading = []
        allFiles = nil
        allFilesFailure = nil
    }

    func loadAllFiles() async {
        guard allFiles == nil else { return }
        let roots = roots
        let listing = await ProjectFiles.listing(roots)
        // This Mac's box starting (with the app, or again after an update): still loading, and read
        // again as the panel looks again (`refresh`), rather than said it couldn't be read.
        waitsForBox = listing.failure == .starting
        guard !waitsForBox, allFiles == nil else { return }
        allFiles = listing.files
        allFilesFailure = listing.failure
    }

    /// Filters again, reading the files afresh.
    func retryAllFiles() {
        allFiles = nil
        allFilesFailure = nil
    }
}

private struct FileTreeView: View {
    @Bindable var tree: FileTree
    let selected: URL?
    let open: (URL) -> Void
    @Environment(\.isPanelShown) private var isShown
    /// The panel was hidden since the tree was last looked at.
    @State private var wasHidden = false

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
                        .accessibilityLabel("Clear")
                        .help("Clear")
                }
            }
            .font(.system(size: 13))
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(Color.primary.opacity(0.05), in: .rect(cornerRadius: 8))
            .padding(10)
            // Filtering, the files are read (again, after Reload).
            .task(id: !tree.filter.isEmpty && tree.allFiles == nil) { if !tree.filter.isEmpty { await tree.loadAllFiles() } }
            // What the agent changes shows while the tree does: looked at again every few seconds,
            // a machine's less often (each look is a round trip). Not while the panel's hidden;
            // looked at as soon as it shows again.
            .task(id: isShown) {
                guard isShown else {
                    wasHidden = true
                    return
                }
                if wasHidden {
                    wasHidden = false
                    await tree.refresh()
                }
                let pause: Duration = tree.roots.allSatisfy(\.isFileURL) ? .seconds(3) : .seconds(10)
                while !Task.isCancelled {
                    try? await Task.sleep(for: pause)
                    if !Task.isCancelled { await tree.refresh() }
                }
            }

            if tree.filter.isEmpty, let failure = tree.rootFailure, let root = tree.roots.first {
                UnreadableFolderPage(failure: failure, computer: RemoteFolder.parse(root)?.machine) { tree.retry(root) }
            } else if tree.filter.isEmpty, tree.isLoadingRoot {
                Placeholder(.rows(count: 6), label: "Loading files")
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                rows
            }
        }
        .heldContextMenu {
            HeldRow.button("Reload") { tree.reload() }
        }
    }

    private var rows: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 1) {
                if tree.filter.isEmpty {
                    ForEach(tree.rows) { row in
                        switch row {
                        case .entry(let entry, let depth):
                            TreeRow(entry: entry, depth: depth, isRoot: tree.roots.count > 1 && depth == 0, isOpen: tree.expanded.contains(entry.url), isSelected: entry.url == selected) {
                                if entry.isDirectory { tree.toggle(entry.url) } else { open(entry.url) }
                            }
                        case .unreadable(let folder, let failure, let depth):
                            UnreadableRow(failure: failure, depth: depth) { tree.retry(folder) }
                        case .empty(_, let depth):
                            NoteRow(depth: depth) { Text("Empty") }
                        }
                    }
                } else {
                    ForEach(tree.matches) { match in
                        MatchRow(path: match.path, isSelected: match.url == selected) { open(match.url) }
                    }
                    if tree.allFiles == nil {
                        Placeholder(.rows(count: 3), label: "Loading files", fadesOut: false)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                    } else if let failure = tree.allFilesFailure, tree.matches.isEmpty {
                        UnreadableRow(failure: failure, depth: 0) { tree.retryAllFiles() }
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
}

/// An open folder's line, in its files' place, as a row of the tree is laid out.
private struct NoteRow<Content: View>: View {
    let depth: Int
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 6) {
            Color.clear.frame(width: 16)
            content
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .font(.system(size: 12))
        .foregroundStyle(.tertiary)
        .padding(.leading, 6 + CGFloat(depth) * 14)
        .padding(.trailing, 6)
        .frame(height: 24)
    }
}

/// An open folder that couldn't be read, in its files' place: why, as the computer said it, and
/// Try Again, so it never looks empty. Two lines, so the reason stays whole in a narrow tree.
private struct UnreadableRow: View {
    let failure: FolderFailure
    let depth: Int
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: failure == .denied ? "lock" : "exclamationmark.triangle")
                .foregroundStyle(.secondary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text("Couldn’t read this folder")
                    .foregroundStyle(.secondary)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(failure.reason)
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Try Again", action: retry)
                        .buttonStyle(TextButtonStyle())
                        .accessibilityLabel("Try reading this folder again")
                }
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: 12))
        .padding(.leading, 6 + CGFloat(depth) * 14)
        .padding(.trailing, 6)
        .padding(.vertical, 4)
        .help("Couldn’t read this folder: \(failure.reason)")
        .accessibilityElement(children: .contain)
    }
}

/// A project's folder that couldn't be read, in the whole tree's place, as the panel's pages
/// say what's missing.
struct UnreadableFolderPage: View {
    let failure: FolderFailure
    /// The machine it's on (nil: this Mac).
    let computer: String?
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Couldn’t Read This Folder", systemImage: failure == .denied ? "lock.folder" : "folder.badge.questionmark")
        } description: {
            Text(failure.detail(on: computer))
                .textSelection(.enabled)
        } actions: {
            Button("Try Again", action: retry)
        }
        .frame(maxHeight: .infinity)
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
            .pickHighlight(RoundedRectangle(cornerRadius: 6), isOn: isSelected)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .heldContextMenu {
            if entry.url.isFileURL {
                HeldRow.button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([entry.url]) }
            }
            HeldRow.button("Copy Path") { copyPath(entry.url) }
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
struct FileViewer: View {
    let url: URL
    let root: String
    let mention: String
    @Binding var showsTree: Bool
    @Environment(AppModel.self) private var app
    @Environment(\.isPanelShown) private var isShown
    @State private var content: Content?
    @State private var showsSource = false
    @State private var pictureScale: CGFloat = 1
    @State private var pictureFitScale: CGFloat = 1
    /// The conversation's pictures that are files, in its order: a picture here that's one of them
    /// turns to the one before or after it, as the viewer does.
    @State private var pictureFiles: [String] = []

    enum Content {
        case text(String)
        case image(NSImage)
        case preview
        /// Why it can't be shown: gone, or what a machine's box said (too big, can't be read).
        case unavailable(String)
    }

    private var isMarkdown: Bool { Self.isMarkdown(named: url.lastPathComponent) }

    /// Whether a file is Markdown, by its name: shown rendered here and in the Artifacts popover.
    static func isMarkdown(named name: String) -> Bool {
        ["md", "markdown", "mdx"].contains((name as NSString).pathExtension.lowercased())
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            // One over the other, so the placeholder and the file cross-fade.
            ZStack {
                if let content {
                    Group {
                        switch content {
                        case .text(let text) where isMarkdown && !showsSource:
                            ScrollView {
                                markdownPreview(text)
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
                            PictureCanvas(image: image, scale: $pictureScale, fitScale: $pictureFitScale, name: url.lastPathComponent, turns: pictureTurns)
                                .padding(20)
                                .id(url)
                        case .unavailable(let why):
                            ContentUnavailableView("No Preview", systemImage: "doc", description: Text(why))
                        case .preview where !url.isFileURL:
                            ContentUnavailableView("No Preview", systemImage: "doc", description: Text("This file can’t be shown here."))
                        case .preview:
                            QuickLookView(url: url)
                        }
                    }
                    .transition(.replacingPlaceholder)
                } else {
                    Placeholder(.lines(count: 14), label: "Loading \(url.lastPathComponent)")
                        .padding(20)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // A picture swiped to the next doesn't slide out over the tree.
            .clipped()
        }
        .task(id: "\(url.absoluteString)\n\(app.utilities.fileShown)\n\(isShown)") {
            // The panel hidden, it's read again as it shows.
            guard isShown else { return }
            pictureScale = 1
            content = await Self.load(url, from: RemoteFolder.parse(url).map { app.box($0.machine) })
            if case .image? = content { pictureFiles = conversationPictureFiles() }
            // Changed on disk (by the agent, say): shown again as it is. A machine's file is read
            // again when it's shown again, which reading it each time would cost a round trip for.
            guard url.isFileURL else { return }
            var seen = Self.modified(url)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                let now = Self.modified(url)
                if now != seen {
                    seen = now
                    content = await Self.load(url, from: RemoteFolder.parse(url).map { app.box($0.machine) })
                }
            }
        }
    }

    /// File images resolve beside the document; diagrams use the same renderer as replies.
    private func markdownPreview(_ markdown: String) -> some View {
        ReplyView(markdown: markdown, parser: MathMarkdownParser(),
                  images: url.deletingLastPathComponent(), diagrams: true, openURL: { destination in
            if destination.scheme == nil && destination.path.isEmpty { return true }
            guard let target = Self.linked(destination, from: url, root: root) else { return false }
            app.utilities.show(target)
            return true
        })
    }

    /// The picture before or after this one among the conversation's, opened here in its place.
    private var pictureTurns: PictureCanvas.Turns? {
        let files = pictureFiles
        guard let at = files.firstIndex(of: Self.pictureKey(url)) else { return nil }
        let utilities = app.utilities
        return PictureCanvas.Turns(canTurn: { files.indices.contains(at + $0) }) { direction in
            guard files.indices.contains(at + direction), let next = URL(string: files[at + direction]) else { return }
            utilities.open(next)
        }
    }

    /// The pictures of the conversation you work in that are files, here or on its machine.
    private func conversationPictureFiles() -> [String] {
        let inView = app.utilities.inView
        let set: ConversationPictureSet
        if let group = inView.group.flatMap(BotGroups.groupID(fromTab:)) {
            set = ConversationPictureSet(group: group, groups: app.chats, bots: app.bots)
        } else if let session = inView.worksBeside ?? inView.session, let model = app.workspace.model(for: session) {
            set = ConversationPictureSet(model: model)
        } else {
            return []
        }
        // A file shown again (changed since) is the same file here: each once, where it came first.
        var seen = Set<String>()
        return set.items.compactMap { item -> String? in
            guard item.isImage else { return nil }
            switch item {
            case .local(let url): return Self.pictureKey(url)
            case .path(let path): return Self.pictureKey(URL(filePath: path))
            case .stored(let file, _):
                guard case .uri(let uri)? = file.source, !uri.hasPrefix("data:"), let url = URL(string: uri) else { return nil }
                return Self.pictureKey(url)
            }
        }
        .filter { seen.insert($0).inserted }
    }

    /// A file's address, the same however it was written.
    private static func pictureKey(_ url: URL) -> String {
        (url.isFileURL ? url.standardizedFileURL : url).absoluteString
    }

    /// The file a Markdown file's link names (`link`, in `file`, in the project folder `root`):
    /// relative to it, or to the project's folder for "/docs/setup.md", as GitHub reads them; on
    /// the machine the file is on. nil for a web link.
    static func linked(_ link: URL, from file: URL, root: String) -> URL? {
        if link.isFileURL { return link.standardizedFileURL }
        guard link.scheme == nil, !link.path.isEmpty else { return nil }
        let path = link.path(percentEncoded: false)
        if path.hasPrefix("/") { return RemoteFolder.fileURL(String(path.dropFirst()), in: root).standardized }
        // Its folder without the "/" a machine's URL ends it with.
        var folder = RemoteFolder.folder(of: file.deletingLastPathComponent())
        while folder.count > 1, folder.hasSuffix("/") { folder.removeLast() }
        return RemoteFolder.fileURL(path, in: folder).standardized
    }

    /// Read from the disk each time (a URL keeps the values it was asked for).
    private static func modified(_ url: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }

    /// How much of the file's place the header has room for.
    private enum HeaderFit { case path, name, nameWithIconOpen, cutName }

    private var header: some View {
        // The whole path where it fits, else the file's name whole, then Open as its app's icon
        // alone to make room for it; the name is cut in its middle only when nothing else fits.
        ViewThatFits(in: .horizontal) {
            headerRow(.path)
            headerRow(.name)
            headerRow(.nameWithIconOpen)
            headerRow(.cutName)
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .frame(height: 40)
    }

    private func headerRow(_ fit: HeaderFit) -> some View {
        HStack(spacing: 6) {
            Group {
                switch fit {
                case .path:
                    breadcrumb.lineLimit(1).fixedSize()
                case .name, .nameWithIconOpen:
                    fileName.fixedSize()
                case .cutName:
                    fileName.truncationMode(.middle)
                }
            }
            .help(url.path)
            .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 8)
            if isMarkdown {
                Button(showsSource ? "View Rendered" : "View Source") { showsSource.toggle() }
                    .buttonStyle(.plain)
                    .clickablePointer()
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 10)
                    .frame(height: 26)
                    .hoverHighlight(in: Capsule())
                    .fixedSize()
            }
            Button { withAnimation(.ui) { showsTree.toggle() } } label: {
                Image(systemName: "sidebar.right")
            }
            .buttonStyle(CardActionStyle())
            .help(showsTree ? "Hide Files" : "Show Files")
            // A machine's files open nowhere on this Mac.
            if url.isFileURL { OpenMenu(url: url, saysOpen: fit == .path || fit == .name) }
        }
    }

    private var fileName: some View {
        Text(url.lastPathComponent)
            .font(.system(size: 13, weight: .semibold))
            .lineLimit(1)
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
    /// `machine`: the box a machine's file is on, which sends it as it does a phone (`kuvo/file`).
    static func load(_ url: URL, from machine: BoxClient?) async -> Content {
        await Task.detached { () -> Content in
            let type = UTType(filenameExtension: url.pathExtension)
            if !url.isFileURL {
                // On a machine: pictures and text, from its box; nothing for Quick Look there.
                guard let machine, let path = RemoteFolder.parse(url)?.path else { return .preview }
                // What can't be shown here (a PDF, an archive, a video) isn't fetched to find out.
                guard MachineFiles.shows(url.pathExtension) else { return .preview }
                // Pictures whole; anything else only as far as it's shown as text.
                let data: Data
                do {
                    data = try await machine.file(path, max: type?.conforms(to: .image) == true ? nil : 2_000_000)
                } catch {
                    return .unavailable(error.localizedDescription)
                }
                if type?.conforms(to: .image) == true, let image = NSImage(data: data) { return .image(image) }
                if data.count <= 2_000_000, !data.contains(0), let text = String(data: data, encoding: .utf8) { return .text(text) }
                return .preview
            }
            // Removed since it was listed (by the agent, say), as a machine's box says it.
            guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else { return .unavailable("That file isn’t there anymore.") }
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
    /// "Open" beside the app's icon; the icon alone where the header is tight.
    var saysOpen = true

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
                    if saysOpen || defaultApp == nil { Text("Open") }
                }
            }
            .accessibilityLabel(defaultApp.map { "Open in \(OpenWith.name(of: $0))" } ?? "Open")
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
            .accessibilityLabel("Open With")
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

/// Quick Look, for anything the panel doesn't draw itself. Closed when SwiftUI takes it away, never
/// by its window closing: SwiftUI can still hand it the next file then, and Quick Look aborts the
/// app when a closed preview is given one.
struct QuickLookView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> QLPreviewView {
        let view = QLPreviewView(frame: .zero, style: .normal)!
        view.shouldCloseWithWindow = false
        view.autostarts = true
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: QLPreviewView, context: Context) {
        // Hidden with the panel, a film or a sound in it stops, and starts again as it's back.
        context.coordinator.update(view, in: context) { [url] away in view.previewItem = away ? nil : url as NSURL }
        if !view.isHidden, (view.previewItem as? NSURL) as URL? != url { view.previewItem = url as NSURL }
    }

    func makeCoordinator() -> PanelVisibility { PanelVisibility() }

    static func dismantleNSView(_ view: QLPreviewView, coordinator: PanelVisibility) {
        view.close()
    }
}

/// What the panel shows of a machine's files.
nonisolated enum MachineFiles {
    /// Whether a machine's file can be shown here, by its extension: all but what's never text nor
    /// a picture (a PDF, an archive, a video), whose bytes decide. By name, not by this Mac's file
    /// types, which its apps change (to macOS, `.ts` is a video, and `.mod` a song with one).
    static func shows(_ extension: String) -> Bool {
        !neverShown.contains(`extension`.lowercased())
    }

    private static let neverShown: Set<String> = [
        "pdf", "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "dmg", "iso", "pkg",
        "mp4", "mov", "m4v", "mkv", "avi", "webm", "mp3", "wav", "m4a", "aac", "flac", "ogg",
    ]
}
