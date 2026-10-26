import AppKit
import OpenCodeKit
import SwiftUI

/// Git: how sessions' branches are named, and how commit messages and pull requests are written.
struct GitSettings: View {
    @AppStorage(GitPreferences.branchPrefixKey) private var branchPrefix = GitPreferences.defaultBranchPrefix
    @AppStorage(GitPreferences.commitInstructionsKey) private var commitInstructions = ""
    @AppStorage(GitPreferences.pullRequestInstructionsKey) private var pullRequestInstructions = ""

    var body: some View {
        ScrollingSettingsForm {
            Section {
                SettingsTextRow {
                    TextField("Branch prefix", text: $branchPrefix, prompt: Text(verbatim: GitPreferences.defaultBranchPrefix))
                } label: {
                    Text("Branch prefix")
                    Text("How a session’s own branch in a worktree starts.")
                }
            } header: {
                Text("Branches")
            }

            Section {
                InstructionsEditor(text: $commitInstructions, prompt: "For example: Start with the area changed, like “ui: …”, and never mention tickets.")
            } header: {
                Text("Commit Messages")
            } footer: {
                Text("Added when Suggest a Message in Changes asks the model for one.")
                    .foregroundStyle(.secondary)
            }

            Section {
                InstructionsEditor(text: $pullRequestInstructions, prompt: "For example: Add a Testing section, and link the issue if the branch names one.")
            } header: {
                Text("Pull Requests")
            } footer: {
                Text("Added when Create Pull Request writes the title and description.")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// A few lines of instructions for the model.
private struct InstructionsEditor: View {
    @Binding var text: String
    let prompt: String

    var body: some View {
        TextField("Instructions", text: $text, prompt: Text(prompt), axis: .vertical)
            .labelsHidden()
            .lineLimit(3...8)
    }
}

/// Worktrees: where they go, and the ones sessions have, with what each takes, on each computer.
struct WorktreesSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(Workspace.self) private var workspace
    @Environment(\.settingsBox) private var box
    @State private var sizes: [String: Int64] = [:]
    @State private var removing: Workspace.Worktree?
    @State private var failure: String?
    /// Choosing a machine's folder for new worktrees, in the page's place.
    @State private var choosingFolder = false
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
            WorktreesFolderSection(choosing: $choosingFolder)

            Section {
                if trees.isEmpty && reading {
                    Spinner(size: 16).frame(maxWidth: .infinity)
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
                            if let size = sizes[item.tree.root] {
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
                            Button("Remove…") { removing = item.tree }
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
            let read = await workspace.takeWorktrees(from: box.machine ?? BoxClient.mac, sizes: true)
            reading = false
            unreached = read == nil
            sizes = read ?? [:]
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
        .confirmationDialog("Remove the worktree for \(removing?.branch ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { tree in
            Button("Remove", role: .destructive) {
                guard let folder = workspace.worktrees.first(where: { $0.value.root == tree.root })?.key else { return }
                Task {
                    do { try await workspace.removeWorktree(folder) } catch { failure = error.localizedDescription }
                }
            }
        } message: { _ in
            Text("Its folder and anything in it that isn’t committed are deleted. Its sessions stay, without a folder to run in.")
        }
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
    /// Where new ones go, for the folder chosen now, as the box answered.
    @State private var preview: WorktreesWhere?

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
            if let preview, preview.projects.isEmpty {
                // No project in a repository here yet: the folder itself.
                LabeledContent("Each project’s go in") {
                    Text(chosen ?? BoxPaths.display(preview.default, home: preview.home) + "/…")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
            }
            ForEach(preview?.projects.prefix(3) ?? []) { project in
                WorktreePlace(project: project, home: preview?.home, onThisMac: box.machine == nil)
            }
        } header: {
            Text("New Worktrees")
        }
        .task(id: "\(boxID) \(chosen ?? "") \(app.isReady(box))") {
            // Kept as it was while the new one's read, so the rows don't blink.
            if preview?.directory != chosen { preview = nil }
            preview = try? await app.box(boxID).worktreesWhere(chosen)
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
            if box.machine == nil { chooseOnThisMac() } else { choosing = true }
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
    let home: String?
    let onThisMac: Bool

    var body: some View {
        LabeledContent {
            HStack(spacing: 6) {
                if let folder = project.folder {
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
                        .help("Show in Finder")
                    }
                } else {
                    Text("Known once the engine runs")
                        .foregroundStyle(.secondary)
                }
            }
        } label: {
            Text(project.name)
            if project.cantBeMade {
                Text("This folder can’t be made here.")
                    .foregroundStyle(.red)
            } else if project.isInRepository {
                Text("Inside \(project.name)’s repository, so git lists each worktree as new files.")
                    .foregroundStyle(.orange)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
