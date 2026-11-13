import AppKit
import SwiftUI

/// Open Quickly (⇧⌘O): type part of a file's name to find it in any of the project's folders,
/// and open it in the side panel.
struct OpenQuickly: View {
    /// The project's folders, the primary one first.
    let roots: [String]
    let open: (URL) -> Void
    let dismiss: () -> Void

    @State private var query = DemoTyped.openQuickly
    @State private var files: [ProjectFiles.File] = []
    @State private var selected = 0
    @FocusState private var isFocused: Bool

    /// Before anything's typed, the files changed most recently.
    private var matches: [ProjectFiles.File] {
        Mentions.matches(query, in: files.filter { !$0.isFolder }, limit: 10)
    }

    var body: some View {
        let matches = matches
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Open a file in the project", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 17))
                    .focused($isFocused)
                    .onSubmit { choose(matches) }
            }
            .padding(.horizontal, 16)
            .frame(height: 48)
            if !matches.isEmpty {
                Divider()
                VStack(spacing: 1) {
                    ForEach(Array(matches.enumerated()), id: \.element.id) { index, file in
                        Button { open(file.url) } label: {
                            HStack(spacing: 8) {
                                Image(nsImage: NSWorkspace.shared.icon(of: file.url))
                                    .resizable()
                                    .frame(width: 16, height: 16)
                                // What you typed in semibold, as the command palette marks it.
                                Text(CommandPalette.marked(file.name, query: query, weight: .medium))
                                    .font(.system(size: 13, weight: .medium))
                                let folder = (file.path as NSString).deletingLastPathComponent
                                if !folder.isEmpty {
                                    Text(folder)
                                        .font(.system(size: 12))
                                        .foregroundStyle(.secondary)
                                        .truncationMode(.head)
                                }
                                Spacer(minLength: 0)
                            }
                            .lineLimit(1)
                            .padding(.horizontal, 10)
                            .frame(height: 30)
                        }
                        .buttonStyle(ListRowButtonStyle(isSelected: index == min(selected, matches.count - 1), cornerRadius: 8))
                    }
                }
                .padding(6)
            }
        }
        .frame(width: 560)
        // Over a busy transcript, plain glass lets the words behind it through.
        .background(.background.opacity(0.75), in: .rect(cornerRadius: 18))
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
        .onKeyPress(.upArrow) {
            selected = max(0, min(selected, matches.count - 1) - 1)
            return .handled
        }
        .onKeyPress(.downArrow) {
            selected = min(max(matches.count - 1, 0), selected + 1)
            return .handled
        }
        .onKeyPress(.escape) {
            dismiss()
            return .handled
        }
        .onChange(of: query) { selected = 0 }
        .onAppear { isFocused = true }
        .task {
            let roots = roots.map(RemoteFolder.url)
            files = await ProjectFiles.newestFirst(roots)
        }
    }

    private func choose(_ matches: [ProjectFiles.File]) {
        guard !matches.isEmpty else { return }
        open(matches[min(selected, matches.count - 1)].url)
    }
}
