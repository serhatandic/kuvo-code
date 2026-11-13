import ClientDesign
import ClientSessions
import ClientText
import SwiftUI

/// An item open in the Work Queue, read top to bottom: its number and status, its title, its
/// properties on one quiet line, the sessions on it (with Open Session), what it says (its
/// description, files and links), then its activity, oldest first. Read only: agents write it.
struct WorkItemPage: View {
    let opened: WorkQueues.Opened
    let view: WorkQueueView
    let utilities: Utilities
    /// Back to the list, in the narrow panel.
    let back: (() -> Void)?
    @Environment(AppModel.self) private var app
    @State private var pictures: URL?
    @State private var missing = false
    /// This page's own folder for the item's files (another page of the same item has its own).
    @State private var folder = FileManager.default.temporaryDirectory.appending(path: "WorkQueue/\(UUID().uuidString)", directoryHint: .isDirectory)

    @State private var retries = 0

    private var store: WorkQueues { app.workQueues }

    /// How it's asked for: by its id, else its number, else the issue it is.
    private var name: String { opened.name }

    /// The item as the list has it now (it moves as it changes), else as it was read.
    private var item: WorkItem? {
        view.items.first(where: opened.matches) ?? view.removed.first(where: opened.matches) ?? detail?.item
    }

    private var detail: WorkItemDetail? {
        store.detail(box: opened.box, id: opened.id, number: opened.number, source: opened.source)
    }

    /// The box the item is kept on: the panel's, or the computer it says it's on.
    private var keptOn: String {
        (view.items.first(where: opened.matches) ?? detail?.item).flatMap { store.box(of: $0, in: opened.box) } ?? opened.box
    }

    var body: some View {
        VStack(spacing: 0) {
            if let back {
                HStack {
                    Button(action: back) {
                        Label("Work Queue", systemImage: "chevron.left")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .buttonStyle(TextButtonStyle(outset: true))
                    Spacer()
                    if let item { actions(item) }
                }
                .padding(.horizontal, 14)
                .padding(.top, 10)
            }
            if let item {
                ScrollView {
                    page(item)
                        .padding(.horizontal, 18)
                        .padding(.top, back == nil ? 14 : 8)
                        .padding(.bottom, 18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if let failure = store.loadFailure(box: opened.box, item: name) {
                ContentUnavailableView {
                    Label("Can’t Read the Item", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("Try Again") { retries += 1 }
                }
            } else if missing {
                ContentUnavailableView("Item Not Found", systemImage: "questionmark.circle", description: Text("It isn’t on this computer’s Work Queue, or it was deleted for good."))
            } else {
                Spinner(size: 16).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // Read again whenever it changes, so what it says now shows.
        .task(id: "\(opened.box)|\(name)|\(item?.updated.at ?? 0)|\(retries)") {
            let loaded = await store.load(box: opened.box, item: name)
            missing = loaded == nil
            if let loaded { pictures = await keepPictures(loaded) }
        }
        .workChipContext(item.map { WorkQueues.Key(box: opened.box, owner: $0.owner) })
        .onDisappear { removePictures() }
    }

    @ViewBuilder private func page(_ item: WorkItem) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    eyebrow(item)
                    Spacer(minLength: 0)
                    if back == nil { actions(item) }
                }
                Text(item.title)
                    .font(.system(size: 20, weight: .semibold))
                    .strikethrough(item.isStruck, color: .secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                WorkItemProperties(item: item, view: view)
            }
            if let card = WorkQueue.sessionCard(for: item) {
                WorkItemSessionCard(card: card)
            }
            if let detail {
                VStack(alignment: .leading, spacing: 12) {
                    if !detail.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        ReplyView(markdown: detail.body, parser: parser(detail.body, fromSource: item.source != nil), images: pictures) { url in open(url) }
                    } else {
                        Text("No description yet.")
                            .font(.system(size: 13))
                            .foregroundStyle(.tertiary)
                    }
                    if !detail.files.isEmpty { files(detail) }
                    if !detail.links.isEmpty { links(detail) }
                }
                Divider()
                activity(detail)
            }
        }
    }

    /// The mark, the item's name (an issue's opens it on GitHub), and its status when it has one.
    @ViewBuilder private func eyebrow(_ item: WorkItem) -> some View {
        let mark = WorkItemMark(category: item.category, inProgress: WorkQueue.isInProgress(item), removed: item.removed != nil)
        HStack(spacing: 7) {
            WorkItemStatusMark(mark, size: 12.5)
            if let source = item.source, let url = source.url.flatMap(URL.init(string:)), url.absoluteString.hasPrefix("https://github.com/") {
                // An issue's or a pull request's name opens it on GitHub, in the panel's browser.
                Button { utilities.newBrowser(url.absoluteString) } label: {
                    itemName(item)
                }
                .buttonStyle(TextButtonStyle(outset: true))
                .help("Open \(source.ref) on GitHub")
                .accessibilityLabel(item.spokenName)
            } else {
                itemName(item)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(item.spokenName)
            }
            if let status = WorkQueue.status(of: item) {
                let color = status == .inProgress ? WorkItemMark.inProgress.color : WorkItemMark.removed.color
                Text(status.words)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(color)
                    .padding(.horizontal, 8)
                    .frame(height: 21)
                    .background(Capsule().fill(color.opacity(0.15)))
                    .help(status.help)
            }
        }
    }

    private func itemName(_ item: WorkItem) -> some View {
        HStack(spacing: 4) {
            if let brand = item.brand { BrandMarkView(brand, size: 13).opacity(item.isGone ? WorkItemChip.goneOpacity : 1) }
            Text(item.name)
                .font(.system(size: 13, weight: .semibold).monospacedDigit())
        }
    }

    /// Move and Delete in •••, or Restore for one that's deleted.
    @ViewBuilder private func actions(_ item: WorkItem) -> some View {
        if item.removed == nil, WorkQueue.canMove(item) {
            Menu {
                WorkItemMenu(item: item, view: view, box: opened.box)
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(IconButtonStyle())
            .fixedSize()
            .help("Move or delete it")
            .accessibilityLabel("Move or Delete")
        } else if item.removed == nil {
            // (Done on GitHub: it stays so until it's reopened there; deleting is still yours.)
            Menu {
                Button("Delete", role: .destructive) { Task { await store.delete(item, on: opened.box) } }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(IconButtonStyle())
            .fixedSize()
            .help("Delete it")
            .accessibilityLabel("Delete")
        } else {
            Button("Restore") { Task { await store.restore(item, on: opened.box) } }
                .buttonStyle(ChipButtonStyle(tinted: true))
                .font(.system(size: 12, weight: .semibold))
        }
    }

    private func links(_ detail: WorkItemDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(detail.links, id: \.url) { link in
                Button {
                    if let url = URL(string: link.url) { _ = open(url) }
                } label: {
                    Label(link.title ?? link.url, systemImage: "link")
                        .font(.system(size: 13))
                        .lineLimit(1)
                }
                .buttonStyle(TextButtonStyle(outset: true))
                .help(link.url)
            }
        }
    }

    /// Notes and what the box kept of its history, oldest first, on a thread.
    private func activity(_ detail: WorkItemDetail) -> some View {
        let lines = WorkQueue.activity(of: detail, in: view)
        return VStack(alignment: .leading, spacing: 0) {
            Text("Activity")
                .font(.system(size: 13, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
                .padding(.bottom, 10)
            ForEach(Array(lines.enumerated()), id: \.element.id) { index, line in
                HStack(alignment: .top, spacing: 10) {
                    VStack(spacing: 3) {
                        WorkActivityMark(line: line, size: 16)
                        if index < lines.count - 1 {
                            Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 1).frame(maxHeight: .infinity)
                        }
                    }
                    .frame(width: 18)
                    VStack(alignment: .leading, spacing: 5) {
                        (Text(line.whoWords).fontWeight(.medium) + Text(line.whoWords.isEmpty ? line.what : " \(line.what)").foregroundStyle(.secondary) + Text(" · \(WorkQueue.ago(line.date))").foregroundStyle(.secondary))
                            .font(.system(size: 12))
                            .help(SentTime.full(line.date))
                        if let text = line.text {
                            ReplyView(markdown: text, parser: parser(text)) { url in open(url) }
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.primary.opacity(0.045), in: .rect(cornerRadius: 8))
                        }
                    }
                    .padding(.top, 1)
                    .padding(.bottom, index < lines.count - 1 ? 12 : 0)
                }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func files(_ detail: WorkItemDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            let shown = detail.files.filter(\.isPicture)
            if let pictures, !shown.isEmpty {
                Flow(spacing: 8) {
                    ForEach(shown, id: \.name) { file in
                        if let image = NSImage(contentsOf: pictures.appending(path: file.name)) {
                            Image(nsImage: image)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxWidth: 160, maxHeight: 120)
                                .clipShape(.rect(cornerRadius: 6))
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.1)))
                                .help(file.name)
                                .accessibilityLabel(file.name)
                        }
                    }
                }
            }
            ForEach(detail.files.filter { !$0.isPicture }, id: \.name) { file in
                Button { openFile(file, of: detail.item) } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "doc.text")
                            .foregroundStyle(.secondary)
                        Text(file.name)
                            .lineLimit(1)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                            .foregroundStyle(.tertiary)
                    }
                    .font(.system(size: 13))
                }
                .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                .help("Open it in the panel")
            }
        }
    }

    /// What it says, as a reply is drawn: other items it names (`#212`) as their chips. An issue's
    /// own description is GitHub's, where a bare `#45` is that repository's: only its `gh:` refs.
    private func parser(_ text: String, fromSource: Bool = false) -> FileLinkingParser {
        var refs = text.contains("#") ? store.refs(in: text, box: opened.box, owner: item?.owner) : [:]
        if fromSource { refs = refs.filter { Int($0.key) == nil } }
        return FileLinkingParser(folders: { [] }, refs: refs)
    }

    /// Opens a link from what it says: a chip's item here, a web page in the panel's browser.
    private func open(_ url: URL) -> Bool {
        if let ref = WorkItemRefs.ref(in: url) {
            store.open(ref: ref, on: opened.box, panel: utilities.panelKey)
            return true
        }
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return false }
        utilities.newBrowser(url.absoluteString)
        return true
    }

    // MARK: Pictures

    /// The item's pictures, copied from its box into this page's own folder in the app's temporary
    /// one, so its description shows them by name; read again each time the item changes (an
    /// agent may have replaced one), and gone when the page closes.
    private func keepPictures(_ detail: WorkItemDetail) async -> URL? {
        // (Names as the box keeps them: never a path.)
        let wanted = detail.files.filter { $0.isPicture && Self.isPlainName($0.name) }
        guard !wanted.isEmpty else { return nil }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for file in wanted {
            if let data = await store.file(box: keptOn, item: detail.item.id, name: file.name) {
                try? data.write(to: folder.appending(path: file.name))
            }
        }
        return folder
    }

    private static func isPlainName(_ name: String) -> Bool { !name.contains("/") && !name.hasPrefix(".") }

    /// A file that isn't a picture, opened in the panel (a Markdown note, a log), copied from its box.
    private func openFile(_ file: WorkItemDetail.File, of item: WorkItem) {
        guard Self.isPlainName(file.name) else { return }
        Task {
            guard let data = await store.file(box: keptOn, item: item.id, name: file.name) else { return }
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appending(path: file.name)
            guard (try? data.write(to: url)) != nil else { return }
            utilities.show(url)
        }
    }

    private func removePictures() {
        try? FileManager.default.removeItem(at: folder)
        pictures = nil
    }
}
