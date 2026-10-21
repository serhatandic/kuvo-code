import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// One thing the palette can do: an action, a session to open, or a file to show.
struct PaletteItem: Identifiable {
    enum Kind: String { case action, session, file }

    var id: String
    var kind: Kind
    var title: String
    var detail: String?
    var symbol: String?
    /// The menu shortcut that does the same, like "⌘R".
    var shortcut: String?
    var run: () -> Void
}

/// The command palette (⌘K): type to find a session in any project, a file in this one, or
/// something to do (with its shortcut, to learn it). Before anything's typed, the latest
/// sessions and the usual actions.
struct CommandPalette: View {
    var initialQuery = ""
    let actions: [PaletteItem]
    /// The latest first.
    let sessions: [PaletteItem]
    /// The project's folders, for its files; none without a project.
    let roots: [String]
    let openFile: (URL) -> Void
    let dismiss: () -> Void

    @State private var query = ""
    @State private var files: [ProjectFiles.File] = []
    @State private var selected = 0
    @FocusState private var isFocused: Bool

    struct Section: Identifiable {
        var title: String
        var items: [PaletteItem]
        var id: String { title }
    }

    private var sections: [Section] {
        Self.sections(for: query, actions: actions, sessions: sessions, files: files, openFile: openFile)
    }

    /// What the palette lists for `query`: before anything's typed, the latest sessions and the
    /// usual actions; then the best actions, sessions and files.
    static func sections(for query: String, actions: [PaletteItem], sessions: [PaletteItem], files: [ProjectFiles.File], openFile: @escaping (URL) -> Void) -> [Section] {
        let query = query.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else {
            return [Section(title: "Recent Sessions", items: Array(sessions.prefix(5))), Section(title: "Actions", items: Array(actions.prefix(7)))]
                .filter { !$0.items.isEmpty }
        }
        func best(_ items: [PaletteItem], limit: Int) -> [PaletteItem] {
            items.enumerated()
                .compactMap { index, item in Fuzzy.rank(query, item.title).map { (item, $0, index) } }
                .sorted { ($0.1, $0.2) < ($1.1, $1.2) }
                .prefix(limit)
                .map(\.0)
        }
        let found = Mentions.matches(query, in: files.filter { !$0.isFolder }, limit: 5).map { file in
            let folder = (file.path as NSString).deletingLastPathComponent
            return PaletteItem(id: "file:" + file.path, kind: .file, title: file.name, detail: folder.isEmpty ? nil : folder) { openFile(file.url) }
        }
        return [
            Section(title: "Actions", items: best(actions, limit: 5)),
            Section(title: "Sessions", items: best(sessions, limit: 5)),
            Section(title: "Files", items: found),
        ].filter { !$0.items.isEmpty }
    }

    var body: some View {
        let sections = sections
        let items = sections.flatMap(\.items)
        let current = items.isEmpty ? nil : items[min(selected, items.count - 1)].id
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField(roots.isEmpty ? "Search sessions and actions" : "Search sessions, files and actions", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 17))
                    .focused($isFocused)
                    .onSubmit { if let current, let item = items.first(where: { $0.id == current }) { choose(item) } }
            }
            .padding(.horizontal, 16)
            .frame(height: 48)
            if !sections.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(sections) { section in
                        Text(section.title)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 10)
                            .padding(.top, section.id == sections.first?.id ? 4 : 10)
                            .padding(.bottom, 3)
                        ForEach(section.items) { item in
                            row(item, isSelected: item.id == current)
                        }
                    }
                }
                .padding(6)
            } else if !query.isEmpty {
                Divider()
                Text("Nothing matches.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
        }
        .frame(width: 600)
        // Over a busy transcript, plain glass lets the words behind it through.
        .background(.background.opacity(0.75), in: .rect(cornerRadius: 18))
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
        .onKeyPress(.upArrow) {
            selected = max(0, min(selected, items.count - 1) - 1)
            return .handled
        }
        .onKeyPress(.downArrow) {
            selected = min(max(items.count - 1, 0), selected + 1)
            return .handled
        }
        .onKeyPress(.escape) {
            dismiss()
            return .handled
        }
        .onChange(of: query) { selected = 0 }
        .onAppear {
            if query.isEmpty { query = initialQuery }
            isFocused = true
        }
        .task {
            guard !roots.isEmpty else { return }
            let roots = roots.map(RemoteFolder.url)
            files = await Task.detached { ProjectFiles.newestFirst(ProjectFiles.list(roots, dated: true)) }.value
        }
    }

    private func row(_ item: PaletteItem, isSelected: Bool) -> some View {
        Button { choose(item) } label: {
            HStack(spacing: 8) {
                Group {
                    if item.kind == .file {
                        Image(nsImage: NSWorkspace.shared.icon(for: UTType(filenameExtension: (item.title as NSString).pathExtension) ?? .data))
                            .resizable()
                    } else {
                        Image(systemName: item.symbol ?? (item.kind == .session ? "bubble.left" : "command"))
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 16, height: 16)
                Text(item.title)
                    .font(.system(size: 13, weight: .medium))
                if let detail = item.detail {
                    Text(detail)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .truncationMode(.head)
                }
                Spacer(minLength: 8)
                if let shortcut = item.shortcut {
                    Text(shortcut)
                        .font(.system(size: 12))
                        .foregroundStyle(.tertiary)
                }
            }
            .lineLimit(1)
            .padding(.horizontal, 10)
            .frame(height: 30)
        }
        .buttonStyle(ListRowButtonStyle(isSelected: isSelected, cornerRadius: 8))
    }

    private func choose(_ item: PaletteItem) {
        Analytics.shared.track("command_palette_used", ["kind": item.kind.rawValue])
        dismiss()
        item.run()
    }
}

/// Loose matching for names people half remember.
nonisolated enum Fuzzy {
    /// How well `query` matches `text`, best (0) first; nil when it doesn't. The start, then the
    /// start of a word, then the words' first letters ("nt" finds "New Terminal"), then
    /// anywhere, then each word of it starting a word ("set mcp" finds "Settings › MCP").
    static func rank(_ query: String, _ text: String) -> Int? {
        let query = query.lowercased().trimmingCharacters(in: .whitespaces), text = text.lowercased()
        guard !query.isEmpty else { return nil }
        let words = text.split { !$0.isLetter && !$0.isNumber }
        if text.hasPrefix(query) { return 0 }
        if words.contains(where: { $0.hasPrefix(query) }) { return 1 }
        if query.count > 1, !query.contains(" "), String(words.compactMap(\.first)).hasPrefix(query) { return 2 }
        if text.contains(query) { return 3 }
        let parts = query.split(separator: " ")
        if parts.count > 1, parts.allSatisfy({ part in words.contains { $0.hasPrefix(part) } }) { return 4 }
        return nil
    }
}
