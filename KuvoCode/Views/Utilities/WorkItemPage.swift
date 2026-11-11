import ClientDesign
import ClientSessions
import ClientText
import SwiftUI

/// An item open in the Work Queue: its state and whose it is, its title, what's being done now
/// and by which sessions (each to open), its description (Markdown, with its pictures), its files
/// and links, and the notes agents left, oldest first. Read only: agents write it.
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
                }
                .padding(.horizontal, 14)
                .padding(.top, 10)
            }
            if let item {
                ScrollView {
                    page(item)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 14)
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
        .onDisappear { removePictures() }
    }

    /// As the user's layout has it: the number and where it stands, the title, its description;
    /// then the current work, notes and files, links; Open agent session at the end.
    @ViewBuilder private func page(_ item: WorkItem) -> some View {
        let working = WorkQueue.isInProgress(item)
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    if let source = item.source, let url = source.url.flatMap(URL.init(string:)), url.absoluteString.hasPrefix("https://github.com/") {
                        // An issue's or a pull request's name opens it on GitHub, in the panel's browser.
                        Button { utilities.newBrowser(url.absoluteString) } label: {
                            HStack(spacing: 4) {
                                if let brand = item.brand { BrandMarkView(brand, size: 13) }
                                Text(item.name).monospacedDigit()
                            }
                            .font(.system(size: 13))
                        }
                        .buttonStyle(TextButtonStyle(outset: true))
                        .help("Open \(source.ref) on GitHub")
                        .accessibilityLabel(item.spokenName)
                    } else {
                        HStack(spacing: 4) {
                            if let brand = item.brand { BrandMarkView(brand, size: 13) }
                            Text(item.name).monospacedDigit()
                        }
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                    }
                    status(item)
                    Spacer(minLength: 0)
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
                Text(item.title)
                    .font(.system(size: 20, weight: .semibold))
                    .strikethrough(item.isStruck, color: .secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 4) {
                    Text("\(WorkQueue.updated(item.updated.date)) by \(item.updated.by.words)")
                    if let owner = WorkQueue.ownerName(of: item, in: view) { Text("· in \(owner)") }
                    if let computer = WorkQueue.computerName(of: item) { Text("· on \(computer)") }
                    if let handing = item.handing { Text("· handing to \(handing.name.isEmpty ? "another computer" : handing.name)") }
                }
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
                .help("Added \(SentTime.full(item.created.date)) by \(item.created.by.words)")
            }
            if let detail, !detail.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ReplyView(markdown: detail.body, parser: parser(detail.body, fromSource: item.source != nil), images: pictures) { url in open(url) }
            } else if detail != nil {
                Text("No description yet.")
                    .font(.system(size: 13))
                    .foregroundStyle(.tertiary)
            }
            Divider()
            if working || item.progress != nil || !item.sessions.isEmpty {
                part("Current work") { currentWork(item, working: working) }
            }
            if let detail, !detail.notes.isEmpty || !detail.files.isEmpty {
                part("Notes") {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(detail.notes.enumerated()), id: \.offset) { _, note in
                            VStack(alignment: .leading, spacing: 3) {
                                Text("\(note.by.words.prefix(1).uppercased() + note.by.words.dropFirst()) · \(WorkQueue.ago(note.date))")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(.secondary)
                                    .help(SentTime.full(note.date))
                                ReplyView(markdown: note.text, parser: parser(note.text)) { url in open(url) }
                            }
                        }
                        if !detail.files.isEmpty { files(detail) }
                    }
                }
            }
            if let detail, !detail.links.isEmpty {
                part("Links") {
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
            }
            ForEach(item.sessions, id: \.session) { session in
                let known = app.workspace.session(session.session) != nil
                Button { app.open(.session(session.session), from: app.tabs.messageTarget) } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "bubble.left")
                        Text(item.sessions.count > 1 ? "Open \(session.title.isEmpty ? "agent session" : session.title)" : "Open agent session")
                        Image(systemName: "arrow.up.right").font(.system(size: 10, weight: .semibold))
                    }
                    .font(.system(size: 13))
                }
                .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                .disabled(!known)
                .help(known ? "Open the session working on it" : "That session isn’t on this Mac’s list.")
                .opensInNewTab(known ? .session(session.session) : nil)
            }
        }
    }

    private func status(_ item: WorkItem) -> some View {
        let mark = WorkItemMark(category: item.category, inProgress: WorkQueue.isInProgress(item), removed: item.removed != nil)
        let category = WorkQueue.categoryName(item.category, in: view.categories)
        let words = switch mark {
        case .inProgress: "In progress"
        case .removed: "Deleted"
        default: category
        }
        return Text(words)
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(mark.color)
            .padding(.horizontal, 9)
            .frame(height: 22)
            .background(Capsule().fill(mark.color.opacity(0.14)))
            .help(mark == .inProgress ? "A session is at work on it. It’s kept in \(category)."
                : mark == .removed ? "Kept for 30 days: Restore brings it back."
                : item.keptIn.map { "\(item.seen?.state == "merged" ? "Merged" : "Closed") on GitHub. If it’s reopened there, it’s back in \(WorkQueue.categoryName($0, in: view.categories))." } ?? "")
    }

    /// What's being done now, how far along, and who's on it.
    @ViewBuilder private func currentWork(_ item: WorkItem, working: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let now = WorkQueue.currentWork(item) {
                Text(now)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if !working {
                Text("No one is at work on it now.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }
            if let value = item.progress?.value {
                ProgressLine("Progress", fraction: value, layout: .inline)
            }
            if item.sessions.count > 1 || (item.sessions.count == 1 && WorkQueue.currentWork(item) != "\(item.sessions[0].title) is at work on it") {
                ForEach(item.sessions, id: \.session) { session in
                    HStack(spacing: 6) {
                        StatusMark(showing: session.working ? .working : nil, size: 10)
                            .frame(width: 10)
                        Text(session.title.isEmpty ? "Untitled session" : session.title)
                        Text(session.working ? "at work" : "idle").foregroundStyle(.tertiary)
                    }
                    .font(.system(size: 12))
                }
            }
        }
    }

    private func part<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
            content()
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
        var refs = text.contains("#") ? store.refs(in: text, box: opened.box) : [:]
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
