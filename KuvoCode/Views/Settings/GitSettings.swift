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
    /// A machine's: asked for them as they are now (`reading`), and whether it couldn't be.
    @State private var reading = false
    @State private var unreached = false

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
            Section {
                ConfigTextField(title: "Worktrees folder", path: ["worktree", "directory"], prompt: "Default")
            } footer: {
                Text("Where new worktrees go. A relative path starts at the project’s folder.")
                    .foregroundStyle(.secondary)
            }

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
