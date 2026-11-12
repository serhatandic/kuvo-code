import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI

/// Git: how sessions' branches are named, and how commit messages and pull requests are written,
/// on one computer: each keeps its own (`kuvo/config`), for any client that asks it.
struct GitSettings: View {
    var body: some View {
        ScrollingSettingsForm {
            Section {
                SettingsTextRow {
                    GitField(title: "Branch prefix", path: ["branch_prefix"], prompt: "kuvo/", unset: "kuvo/")
                } label: {
                    Text("Branch prefix")
                    Text("How a session’s own branch in a worktree starts.")
                }
            } header: {
                Text("Branches")
            }

            Section {
                GitField(title: "Instructions", path: ["commit_instructions"], prompt: "For example: Start with the area changed, like “ui: …”, and never mention tickets.", multiline: true)
            } header: {
                Text("Commit Messages")
            } footer: {
                Text("Added when Suggest a Message in Changes asks the model for one.")
                    .foregroundStyle(.secondary)
            }

            Section {
                GitField(title: "Instructions", path: ["pull_request_instructions"], prompt: "For example: Add a Testing section, and link the issue if the branch names one.", multiline: true)
            } header: {
                Text("Pull Requests")
            } footer: {
                Text("Added when Create Pull Request writes the title and description.")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// One of a computer's Git settings, saved when you press Return or leave the field. `unset`: what
/// it shows when the computer has none (the branch prefix's `kuvo/`); emptied, it's kept empty (no
/// prefix). Without one, an emptied field removes the setting (no instructions).
private struct GitField: View {
    let title: String
    let path: [String]
    let prompt: String
    var unset: String?
    /// A few lines of instructions for the model.
    var multiline = false
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @State private var field = SettingField()
    @FocusState private var isFocused: Bool

    private var config: EngineConfig { app.config(for: box) }

    var body: some View {
        let stored = config.value(at: path)?.string ?? unset ?? ""
        TextField(title, text: $field.text, prompt: Text(prompt), axis: multiline ? .vertical : .horizontal)
            .labelsHidden()
            .lineLimit(multiline ? 3...8 : 1...1)
            .focused($isFocused)
            .onSubmit(commit)
            .onChange(of: isFocused) { if !isFocused { commit() } }
            .onAppear { field.load(stored) }
            .onChange(of: stored) { if !isFocused { field.load(stored) } }
            .onDisappear(perform: commit)
    }

    private func commit() {
        guard let value = field.edit(trimming: true) else { return }
        config.set(value.isEmpty && unset == nil ? nil : .string(value), at: path)
    }
}

/// Worktrees: where they go, and the ones sessions have, with what each takes, on each computer.
struct WorktreesSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(Workspace.self) private var workspace
    @Environment(\.settingsBox) private var box
    /// Each worktree as its box last listed it, by root: the room it takes, what isn't committed.
    @State private var listed: [String: Workspace.BoxWorktree] = [:]
    @State private var removing: Workspace.Worktree?
    /// What Remove's question says of the worktree, read again as Remove… is clicked; the one
    /// being read meanwhile.
    @State private var removalNote = ""
    @State private var checking: String?
    @State private var failure: String?
    /// Choosing a machine's folder for new worktrees, or new projects, in the page's place.
    @State private var choosingFolder = false
    @State private var choosingProjectsFolder = false
    @State private var chosenProjectsFolder: String?
    /// A machine's: asked for them as they are now (`reading`), and whether it couldn't be.
    @State private var reading = false
    @State private var unreached = false

    /// The folder new ones go in, where Choose a Folder opens on a machine: one named from `/` or `~/`.
    private var worktreesFolder: String? {
        app.config(for: box).value(at: ["worktree", "directory"])?.string.flatMap { $0.hasPrefix("/") || $0.hasPrefix("~/") ? $0 : nil }
    }

    /// One row per worktree (several session folders can share one), this computer's.
    private var trees: [(folder: String, tree: Workspace.Worktree)] {
        var seen = Set<String>()
        return workspace.worktrees
            .sorted { $0.value.root < $1.value.root }
            .filter { RemoteFolder.machine(of: $0.value.root) == box.machine && seen.insert($0.value.root).inserted }
            .map { ($0.key, $0.value) }
    }

    var body: some View {
        ScrollingSettingsForm {
            ProjectsFolderSection(choosing: $choosingProjectsFolder, chosen: $chosenProjectsFolder)
            WorktreesFolderSection(choosing: $choosingFolder)

            Section {
                if trees.isEmpty && reading {
                    Placeholder(.rows(count: 2), label: "Loading worktrees", fadesOut: false)
                        .padding(.vertical, 6)
                } else if trees.isEmpty && unreached {
                    Text(box.machine == nil ? "This Mac’s worktrees show once its engine is running." : "\(app.name(of: box)) isn’t connected. Its worktrees show once it is.")
                        .foregroundStyle(.secondary)
                } else if trees.isEmpty {
                    Text("None yet. Choose Worktree in a new session’s composer to give it one.")
                        .foregroundStyle(.secondary)
                }
                ForEach(trees, id: \.tree.root) { item in
                    let sessions = workspace.sessions.filter { workspace.worktrees[$0.location.directory]?.root == item.tree.root }
                    LabeledContent {
                        HStack(spacing: 6) {
                            if let size = listed[item.tree.root]?.size {
                                Text(StorageSettings.format(size))
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                            }
                            if box.machine == nil {
                                Button {
                                    NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: item.tree.root)])
                                } label: {
                                    Image(systemName: "folder")
                                }
                                .buttonStyle(IconButtonStyle(width: 28, height: 24))
                                .help("Show in Finder")
                            }
                            if checking == item.tree.root {
                                Spinner(size: 13)
                                    .frame(width: 70)
                                    .accessibilityLabel("Looking at what’s in it")
                            } else {
                                Button("Remove…") { Task { await askToRemove(item.tree) } }
                                    // One at a time: what's read is for the question it opens.
                                    .disabled(checking != nil)
                            }
                        }
                    } label: {
                        Text(item.tree.branch)
                        Text("\(workspace.projectName(item.tree.project)) · \(sessions.count.counting("session"))")
                    }
                }
            } header: {
                Text("Worktrees")
            } footer: {
                if let failure {
                    Text(failure).foregroundStyle(.red)
                } else if unreached && !trees.isEmpty {
                    Text(box.machine == nil ? "This Mac’s engine isn’t running, so these are its worktrees as they were last read." : "\(app.name(of: box)) isn’t connected, so these are its worktrees as it last said.")
                        .foregroundStyle(.secondary)
                } else {
                    Text("Removing one deletes its folder and anything in it that isn’t committed. Its branch stays if it isn’t merged yet.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        // This computer's as its box keeps them now (one made there from a phone, say), with the
        // room each takes there.
        // Again once this Mac's box is up, if it wasn't when the page opened.
        .task(id: "\(box.machine ?? BoxClient.mac) \(app.box.endpoint != nil)") {
            reading = true
            let read = await workspace.takeWorktrees(from: box.machine ?? BoxClient.mac, details: true)
            reading = false
            unreached = read == nil
            listed = read ?? [:]
        }
        #if DEBUG
        // KUVO_DEMO_WORKTREES_FOLDER=browse: Choose a Folder's browser open, as a machine's page opens it.
        .task { if ProcessInfo.processInfo.environment["KUVO_DEMO_WORKTREES_FOLDER"] == "browse" { choosingFolder = true } }
        #endif
        .settingsDetail(isPresented: $choosingFolder, title: "Choose a Folder for Worktrees") {
            BoxFolderBrowser(box: box.machine ?? BoxClient.mac, start: worktreesFolder, primary: "Choose") { path, home in
                app.config(for: box).set(.string(BoxPaths.setting(path, home: home)), at: ["worktree", "directory"])
                choosingFolder = false
            } cancel: {
                choosingFolder = false
            }
        }
        .settingsDetail(isPresented: $choosingProjectsFolder, title: "Choose a Folder for Projects") {
            BoxFolderBrowser(box: box.machine ?? BoxClient.mac, start: nil, primary: "Choose") { path, _ in
                chosenProjectsFolder = path
                choosingProjectsFolder = false
            } cancel: {
                choosingProjectsFolder = false
            }
        }
        .confirmationDialog("Remove the worktree for \(removing?.branch ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { tree in
            Button("Remove", role: .destructive) {
                guard let folder = workspace.worktrees.first(where: { $0.value.root == tree.root })?.key else { return }
                Task {
                    do {
                        try await workspace.removeWorktree(folder)
                        failure = nil
                    } catch {
                        failure = error.localizedDescription
                    }
                }
            }
        } message: { _ in
            Text(removalNote)
        }
    }

    /// Asks before removing `tree`, saying what's in it now: changes made since the list was read
    /// count. When the box can't say, the question says what's lost without guessing.
    private func askToRemove(_ tree: Workspace.Worktree) async {
        let unsure = Workspace.BoxWorktree(project: tree.project, root: tree.root, folder: nil, branch: tree.branch, base: tree.base)
        // Not reached when the page opened: asked without waiting on it again.
        guard !unreached else {
            removalNote = unsure.removalNote
            removing = tree
            return
        }
        checking = tree.root
        let read = await workspace.takeWorktrees(from: box.machine ?? BoxClient.mac, details: true)
        checking = nil
        if let read {
            listed = read
            // Gone meanwhile (removed from a phone): its row goes, with nothing to ask.
            guard read[tree.root] != nil else { return }
        }
        removalNote = (read?[tree.root] ?? unsure).removalNote
        removing = tree
    }
}

/// Where new projects go on this computer: the folder bots make them in (`make_project`), picked
/// the first time one asks, or here; none until then. On a machine, its own folders.
private struct ProjectsFolderSection: View {
    /// Choosing a machine's folder, which the page opens in its place, and the one chosen there.
    @Binding var choosing: Bool
    @Binding var chosen: String?
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @State private var settings: WorkSettings?
    @State private var unread = false
    @State private var failure: String?

    private var boxID: String { box.machine ?? BoxClient.mac }

    var body: some View {
        Section {
            if let settings {
                LabeledContent("Folder") {
                    Picker("Folder", selection: Binding(get: { settings.projectsFolder == nil ? Choice.none : .chosen }, set: pick)) {
                        Text("None").tag(Choice.none)
                        if let folder = settings.projectsFolder {
                            Label((folder as NSString).lastPathComponent, systemImage: "folder").tag(Choice.chosen)
                        }
                        Divider()
                        Text("Choose a Folder…").tag(Choice.choose)
                    }
                    .labelsHidden()
                    .fixedSize()
                    .help(settings.projectsFolder.map(shown) ?? "None picked yet")
                }
            } else if unread {
                Text(box.machine == nil ? "Shows once this Mac’s background service is running." : "Shows once \(app.name(of: box)) is connected and up to date.")
                    .foregroundStyle(.secondary)
            }
            if let failure {
                Text(failure)
                    .foregroundStyle(.red)
            }
        } header: {
            Text("New Projects")
        } footer: {
            Text("Where projects your bots make go. A bot asks you before it makes one, and Kuvo Code never deletes them.")
                .foregroundStyle(.secondary)
        }
        .task(id: "\(boxID) \(app.isReady(box))") { await read() }
        .onChange(of: chosen) {
            guard let folder = chosen else { return }
            chosen = nil
            set(folder)
        }
    }

    private func read() async {
        do {
            settings = try await app.box(boxID).workSettings()
            unread = false
        } catch {
            guard !(error is CancellationError) else { return }
            unread = true
        }
    }

    private func shown(_ path: String) -> String {
        box.machine == nil ? (path as NSString).abbreviatingWithTildeInPath : path
    }

    private enum Choice: Hashable { case none, chosen, choose }

    private func pick(_ choice: Choice) {
        switch choice {
        case .none: set(nil)
        case .chosen: break
        case .choose: choose()
        }
    }

    private func choose() {
        guard box.machine == nil else {
            DispatchQueue.main.async { choosing = true }
            return
        }
        // Once the menu has closed.
        DispatchQueue.main.async {
            if let folder = ProjectsFolderPanel.choose(start: settings?.projectsFolder ?? settings?.suggested) { set(folder) }
        }
    }

    private func set(_ folder: String?) {
        failure = nil
        Task {
            do { settings = try await app.box(boxID).setProjectsFolder(folder) } catch { failure = error.localizedDescription }
        }
    }
}

/// Where new projects go on this Mac, chosen in a folder panel (Settings › Worktrees, and a bot's
/// asking card the first time).
enum ProjectsFolderPanel {
    static func choose(start: String?) -> String? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Choose"
        panel.message = "Choose where new projects go. Each one is a folder in it."
        if let start { panel.directoryURL = URL(filePath: start) }
        guard panel.runModal() == .OK else { return nil }
        return panel.url?.path
    }
}

/// Where new worktrees go on this computer: Kuvo Code's own folder or one you choose, as a folder
/// panel chooses it (on a machine, its own folders), and the real folder each project's go in,
/// as its box works it out, with what's wrong with it, if anything.
private struct WorktreesFolderSection: View {
    /// Choosing a machine's folder, which the page opens in its place.
    @Binding var choosing: Bool
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    /// Where new ones go, for the folder chosen now, as the box answered; `unread`: it couldn't.
    @State private var preview: WorktreesWhere?
    @State private var unread = false
    /// The projects shown each with their own folder; the rest are counted.
    private static let shown = 5

    private var config: EngineConfig { app.config(for: box) }
    private var boxID: String { box.machine ?? BoxClient.mac }
    /// The folder chosen, as the settings name it; nil for Kuvo Code's own.
    private var chosen: String? { config.value(at: ["worktree", "directory"])?.string.flatMap { $0.isEmpty ? nil : $0 } }

    private enum Choice: Hashable { case own, chosen, choose }

    var body: some View {
        Section {
            LabeledContent("Folder") {
                Picker("Folder", selection: Binding(get: { chosen == nil ? Choice.own : .chosen }, set: pick)) {
                    Label("Kuvo Code’s Folder", systemImage: "folder").tag(Choice.own)
                    if let chosen {
                        Label(title(of: chosen), systemImage: "folder").tag(Choice.chosen)
                    }
                    Divider()
                    Text("Choose a Folder…").tag(Choice.choose)
                }
                .labelsHidden()
                .fixedSize()
            }
            .task(id: "\(boxID) \(chosen ?? "") \(app.isReady(box))") {
                // Kept as it was while the new one's read, so the rows don't blink.
                if preview?.directory != chosen { preview = nil }
                do {
                    let answer = try await app.box(boxID).worktreesWhere(chosen)
                    // Another folder chosen meanwhile: its own read puts in its answer.
                    guard !Task.isCancelled, answer.directory == chosen else { return }
                    preview = answer
                    unread = false
                } catch {
                    guard !Task.isCancelled, !(error is CancellationError) else { return }
                    preview = nil
                    unread = true
                }
            }
            if let preview {
                let projects = preview.projects
                if projects.isEmpty {
                    // No project in a repository here yet: the folder itself, by its path (the
                    // picker above already names it).
                    LabeledContent("New worktrees go in") {
                        let folder = chosen ?? preview.default
                        Text(BoxPaths.display(folder, home: preview.home))
                            .help(folder)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                } else if Set(projects.map(\.folder)).count == 1, let first = projects.first {
                    // The same folder for every project (one named in full): said once.
                    WorktreePlace(project: projects.first(where: { $0.isInRepository }) ?? first, title: "New worktrees go in", home: preview.home, onThisMac: box.machine == nil)
                } else {
                    ForEach(projects.prefix(Self.shown)) { project in
                        WorktreePlace(project: project, home: preview.home, onThisMac: box.machine == nil)
                    }
                    if projects.count > Self.shown {
                        Text("And \((projects.count - Self.shown).counting("more project"))")
                            .foregroundStyle(.secondary)
                    }
                }
            } else if unread {
                Text(box.machine == nil ? "Where they go shows once this Mac’s background service is running." : "Where they go shows once \(app.name(of: box)) is connected.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("New Worktrees")
        }
    }

    /// Where Choose a Folder… opens: the folder chosen now, else beside the first project.
    private var startFolder: String? {
        if let folder = preview?.projects.first?.folder, chosen != nil { return folder }
        return preview?.projects.first.map { ($0.project as NSString).deletingLastPathComponent }
    }

    private func title(of setting: String) -> String {
        setting.hasPrefix("/") || setting.hasPrefix("~/") ? (setting as NSString).lastPathComponent : setting
    }

    private func pick(_ choice: Choice) {
        switch choice {
        case .own: set(nil)
        case .chosen: break
        case .choose:
            // Once the menu has closed.
            DispatchQueue.main.async {
                if box.machine == nil { chooseOnThisMac() } else { choosing = true }
            }
        }
    }

    private func chooseOnThisMac() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Choose"
        panel.message = "Choose where new worktrees go. Each one is a folder in it."
        if let start = startFolder { panel.directoryURL = URL(filePath: start) }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        set(BoxPaths.setting(url.path, home: NSHomeDirectory()))
    }

    private func set(_ folder: String?) {
        config.set(folder.map(JSONValue.string), at: ["worktree", "directory"])
    }
}

/// Where a project's new worktrees go: the folder, as a path you can find, and what's wrong with
/// it, if anything.
private struct WorktreePlace: View {
    let project: WorktreesWhere.Project
    /// Its name; another for the one folder every project's go in.
    var title: String?
    let home: String?
    let onThisMac: Bool

    var body: some View {
        LabeledContent {
            HStack(spacing: 6) {
                if let folder = project.folder {
                    // By its path, Kuvo Code's own folder too: the picker above names that one.
                    Text(BoxPaths.display(folder, home: home))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .help(folder)
                    if onThisMac, project.exists == true {
                        Button {
                            NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: folder)])
                        } label: {
                            Image(systemName: "folder")
                        }
                        .buttonStyle(IconButtonStyle(width: 28, height: 24))
                        .accessibilityLabel("Show in Finder")
                        .help("Show in Finder")
                    }
                } else {
                    Text("Known once the engine runs")
                        .foregroundStyle(.secondary)
                }
            }
        } label: {
            Text(title ?? project.name)
            if project.cantBeMade {
                Text("Kuvo Code can’t create this folder. Choose another one.")
                    .foregroundStyle(.red)
            } else if project.isInRepository {
                // Under its own name, "this project"; under the one row for every project, its name.
                Text("It’s inside \(title == nil ? "this project’s" : "\(project.name)’s") repository, so git would list each worktree as new files there. Choose a folder outside it.")
                    .foregroundStyle(.orange)
            }
        }
        .accessibilityElement(children: .contain)
    }
}
