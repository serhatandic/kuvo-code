import AppKit
import ClientChanges
import ClientDesign
import OpenCodeKit
import SwiftUI

/// What's changed in the project, Codex-style: uncommitted (or unstaged, or staged)
/// changes from git, new files included, each file folded to its changes with the
/// rest a click away. Lines take comments, which go to the agent with the next message.
struct ChangesPanel: View {
    /// The session, for its comments and its record of edits; none for a project
    /// without one open (no comments then).
    let model: SessionModel?
    /// The project's folders, the primary one first; a menu picks which one's changes show.
    let folders: [String]
    @State private var changes: ProjectChanges
    @State private var collapsed: Set<String> = []
    @State private var expandedFolds: Set<String> = []
    /// The line a comment is being written for: file and line index.
    @State private var draft: DraftTarget?
    /// The files' lines as comments were last moved with them (`follow`).
    @State private var followed: (directory: String, scope: ProjectChanges.Scope, lines: [String: [DiffLine]])?
    /// Syntax colors, per file, worked out off the main thread.
    @State private var highlighting: [String: DiffHighlighting] = [:]

    /// The line a comment is being written on, as it read then: the list can change under it (the
    /// agent edits the file), and the comment stays with that line, not its place.
    struct DraftTarget: Equatable {
        var file: String
        var side: ReviewComment.Side
        var number: Int
        var text: String
        /// What's written so far, kept while the line moves (its row is made again then).
        let typed = Typed()

        final class Typed { var text = "" }

        func isFor(_ line: DiffLine, in file: String) -> Bool {
            self.file == file && side == (line.kind == .removed ? .old : .new) && number == line.number && text == line.text
        }

        static func == (a: Self, b: Self) -> Bool {
            a.file == b.file && a.side == b.side && a.number == b.number && a.text == b.text && a.typed === b.typed
        }
    }
    @Environment(AppModel.self) private var app
    @Environment(Workspace.self) private var workspace
    @Environment(Catalog.self) private var catalog
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isPanelShown) private var isShown
    @State private var isCommitting = false
    @State private var showsBackups = false

    /// The session's own worktree, when it has one.
    private var worktree: Workspace.Worktree? { workspace.worktrees[changes.directory] }

    /// What the Branch scope compares with: the worktree's base, or the repository's main
    /// branch when another one is checked out.
    private var base: String? { base(of: changes.directory) }

    private func base(of directory: String) -> String? {
        if let worktree = workspace.worktrees[directory] { return worktree.base }
        guard let main = workspace.defaultBranches[directory], workspace.branches[directory] != main else { return nil }
        return main
    }

    init(directory: String, folders: [String] = [], model: SessionModel?) {
        self.model = model
        self.folders = folders.isEmpty ? [directory] : folders
        _changes = State(initialValue: ProjectChanges(directory: directory))
    }

    private var isPrimary: Bool { changes.directory == folders.first }

    /// The machine the project is on, if it's on one.
    private var machine: MachineEngine? { RemoteFolder.machine(of: changes.directory).flatMap { app.machines.engine($0) } }
    /// Its machine isn't connected: nothing is asked of it, and the list shows as last seen.
    private var isMachineAway: Bool { machine.map { !$0.isReady } ?? false }
    /// As last seen, or not read: what needs the machine waits until it's back.
    private var isAsLastSeen: Bool { changes.shown != .list }

    /// The session's record of its edits is about its own folder.
    /// The session's changes as kept for it: the engine's record, or for a coding agent's session
    /// (whose bridge keeps none) the edits its steps made.
    private var engineChanges: [FileDiff] {
        guard isPrimary, let model else { return [] }
        return OutsideAgents.isAgentSession(model.session) ? model.editedFiles : model.changes
    }
    private var editedFiles: [FileDiff] { isPrimary ? model?.editedFiles ?? [] : [] }

    /// Comments name files by their path, after the folder's name outside the primary folder,
    /// as the agent knows the project's folders.
    private var commentPrefix: String { isPrimary ? "" : (changes.directory as NSString).lastPathComponent + "/" }

    /// Git asked again now, as the agent works: not while the panel's hidden, where it's asked as
    /// it shows again.
    private func lookAgain() {
        guard isShown else { return }
        Task { await changes.refresh(fallback: engineChanges, edits: editedFiles) }
    }

    /// Moves the session's comments, and the one being written, to where their lines are in
    /// `files` now, from where they were in the list before. Only where lines are the files on
    /// disk, which is what the agent reads the numbers against (not Staged's, not the engine's).
    private func follow(_ files: [ChangedFile]) {
        let lines = Dictionary(files.map { ($0.path, $0.lines) }, uniquingKeysWith: { first, _ in first })
        defer { followed = (changes.directory, changes.scope, lines) }
        guard [.uncommitted, .unstaged, .branch].contains(changes.scope),
              let before = followed, before.directory == changes.directory, before.scope == changes.scope else { return }
        if let model {
            func named(_ lines: [String: [DiffLine]]) -> [String: [DiffLine]] {
                Dictionary(lines.map { (commentPrefix + $0.key, $0.value) }, uniquingKeysWith: { first, _ in first })
            }
            let moved = ReviewComment.following(model.reviewComments, from: named(before.lines), to: named(lines))
            if moved != model.reviewComments { model.reviewComments = moved }
        }
        if let target = draft, let old = before.lines[target.file], let new = lines[target.file],
           let line = ReviewComment.line(side: target.side, number: target.number, from: old, to: new),
           line.text == target.text, line.number != target.number {
            draft?.number = line.number
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .onChange(of: base, initial: true) { old, new in
            changes.base = new
            if new == nil, changes.scope == .branch { changes.scope = .uncommitted }
            // A worktree's work is all on its branch, committed or not.
            if old == new, worktree != nil, new != nil { changes.scope = .branch }
        }
        // Git is quick to ask; look again every few seconds while the panel is open. Started over
        // for another session in the same folder: the loop reads the session it began with.
        // (Its machine away or back: started over, so it's back's look comes at once. The panel
        // hidden: stopped, and started over as it shows again.)
        .task(id: "\(changes.directory)\n\(changes.scope)\n\(changes.base ?? "")\n\(model?.id ?? "")\n\(isMachineAway)\n\(isShown)") {
            changes.isAway = isMachineAway
            guard isShown else { return }
            while !Task.isCancelled {
                await changes.refresh(fallback: engineChanges, edits: editedFiles)
                try? await Task.sleep(for: .seconds(3))
            }
        }
        // The agent edited above a commented line: the comment, and one being written, follow it.
        .onChange(of: changes.files, initial: true) { follow(changes.files) }
        .task(id: changes.files) {
            for file in changes.files {
                guard !Task.isCancelled else { return }
                highlighting[file.id] = await DiffHighlighting.make(for: file)
            }
        }
        // A comment half written is the session's it was begun in: not saved to another's.
        .onChange(of: model?.id) { draft = nil }
        .onChange(of: changes.directory) { draft = nil }
        .onChange(of: model?.isRunning) { lookAgain() }
        .onChange(of: engineChanges) { lookAgain() }
        .onChange(of: editedFiles) { lookAgain() }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            if folders.count > 1 {
                Menu {
                    Picker("Folder", selection: Binding(get: { changes.directory }, set: { folder in
                        let scope = changes.scope
                        changes = ProjectChanges(directory: folder)
                        // Set here too: the same as the last folder's, it isn't a change.
                        changes.base = base(of: folder)
                        changes.scope = scope == .branch || scope == .session ? .uncommitted : scope
                        collapsed = []
                        highlighting = [:]
                    })) {
                        ForEach(folders, id: \.self) { Text(($0 as NSString).lastPathComponent).tag($0) }
                    }
                    .pickerStyle(.inline)
                } label: {
                    HStack(spacing: 4) {
                        Label((changes.directory as NSString).lastPathComponent, systemImage: "folder")
                            .labelStyle(.titleAndIcon)
                        MenuChevron()
                    }
                    .font(.system(size: 13, weight: .semibold))
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                .fixedSize()
                .help("Which of the project's folders to show")
            }
            if changes.isRepository {
                Menu {
                    Picker("Changes", selection: $changes.scope) {
                        ForEach([ProjectChanges.Scope.uncommitted, .unstaged, .staged]) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.inline)
                    if let base = changes.base {
                        Divider()
                        Picker("Branch", selection: $changes.scope) {
                            Text("Since \(base)").tag(ProjectChanges.Scope.branch)
                        }
                        .pickerStyle(.inline)
                    }
                    if model != nil, isPrimary {
                        Divider()
                        Picker("Session", selection: $changes.scope) {
                            Text("This Session").tag(ProjectChanges.Scope.session)
                        }
                        .pickerStyle(.inline)
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(changes.scope == .branch ? changes.base.map { "Since \($0)" } ?? "Branch" : changes.scope.title)
                        MenuChevron()
                    }
                    .font(.system(size: 13, weight: .semibold))
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                .fixedSize()
                .help(isAsLastSeen ? ChangesAway.waits("Show other changes", for: machineName) : "What to show: uncommitted, unstaged or staged changes, and more")
                // What showed is the scope it was read for.
                .disabled(isAsLastSeen)
            } else {
                Text("This Session")
                    .font(.system(size: 13, weight: .semibold))
                    .help("Not a git repository: showing the agent's edits in this session.")
            }
            DiffStat(additions: changes.additions, deletions: changes.deletions)
            Spacer()
            if let worktree {
                BranchMenu(tree: worktree, isWorktree: true, directory: changes.directory, model: model, environment: app.shellEnvironment)
                    .disabled(isAsLastSeen)
                    .help(isAsLastSeen ? ChangesAway.waits("Merge or push", for: machineName) : "")
            } else if let base, let branch = workspace.branches[changes.directory] {
                // A branch of your own, in the project's folder: it can go up for a pull request.
                BranchMenu(tree: Workspace.Worktree(project: changes.directory, root: changes.directory, branch: branch, base: base), isWorktree: false,
                           directory: changes.directory, model: model, environment: app.shellEnvironment)
                    .disabled(isAsLastSeen)
                    .help(isAsLastSeen ? ChangesAway.waits("Push", for: machineName) : "")
            }
            if let model, changes.isRepository, !changes.files.isEmpty, changes.scope != .session,
               catalog.commands(in: model.session.location.directory).contains(where: { $0.name == "review" }) {
                Button {
                    review(in: model)
                } label: {
                    Image(systemName: "text.badge.checkmark")
                }
                .buttonStyle(CardActionStyle())
                .disabled(model.isRunning || isAsLastSeen)
                .accessibilityLabel("Review")
                .help(isAsLastSeen ? ChangesAway.waits("Review", for: machineName)
                      : model.isRunning ? "Review the changes once the agent is done" : "Have the agent review these changes (/review)")
            }
            // Kept while its form is open, so a push problem stays readable after the commit.
            if changes.isRepository, !changes.files.isEmpty && changes.hasUncommitted || isCommitting {
                Button("Commit…") { isCommitting = true }
                    #if DEBUG
                    // KUVO_DEMO_COMMIT=<message>: its form open, with that typed in it (`DemoTyped`).
                    .task {
                        guard ProcessInfo.processInfo.environment["KUVO_DEMO_COMMIT"] != nil, !isCommitting else { return }
                        await DemoWait.pause(.conversationShows)
                        isCommitting = true
                    }
                    #endif
                    .buttonStyle(.borderless)
                    .font(.system(size: 12, weight: .medium))
                    .fixedSize()
                    .help(isAsLastSeen && !isCommitting ? ChangesAway.waits("Commit", for: machineName) : "Commit the changes, and push them if you like")
                    .disabled(isAsLastSeen && !isCommitting)
                    .popover(isPresented: $isCommitting, arrowEdge: .bottom) {
                        // A coding agent's session asks its own model (Claude Code, Codex); one whose
                        // agent can't answer outside the conversation, the engine's default model.
                        let isAgents = model.map { OutsideAgents.isAgentSession($0.session) } ?? false
                        // (Its bridge: this Mac's, or its machine's.)
                        let bridge = model.flatMap { workspace.agents(forFolder: $0.session.location.directory)?.api }
                        // (This Mac's engine: the box attached in place's, if that's where it is.)
                        let thisMacs = app.api(for: app.thisMacsBox)
                        CommitForm(changes: changes, environment: app.shellEnvironment,
                                   api: isAgents ? bridge ?? thisMacs : model.flatMap { workspace.api(forSession: $0.id) } ?? thisMacs,
                                   session: isAgents && bridge == nil ? nil : model?.id, model: isAgents ? nil : model?.session.model,
                                   fallback: isAgents ? thisMacs : nil) { isCommitting = false }
                        .popoverContent()
                    }
            }
            Button {
                withAnimation(.ui) {
                    collapsed = collapsed.count == changes.files.count ? [] : Set(changes.files.map(\.id))
                }
            } label: {
                Image(systemName: collapsed.count == changes.files.count && !changes.files.isEmpty ? "rectangle.expand.vertical" : "rectangle.compress.vertical")
            }
            .buttonStyle(CardActionStyle())
            .help(collapsed.count == changes.files.count ? "Expand All" : "Collapse All")
            .accessibilityLabel(collapsed.count == changes.files.count ? "Expand All" : "Collapse All")
            .disabled(changes.files.isEmpty)
            // Also outside a repository: one whose .git is gone is made again from its backups.
            NativeMenuButton(name: "changes", opensBelow: true, menu: panelMenu) {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13))
                    .frame(width: 26, height: 24)
                    .hoverHighlight(in: RoundedRectangle(cornerRadius: 6), mutesInk: true)
            }
            .help("More")
            .accessibilityLabel("More")
            .fixedSize()
        }
        .padding(.horizontal, 14)
        .frame(height: 40)
        .branchBackupsSheet(isPresented: $showsBackups, folder: changes.directory)
        #if DEBUG
        // KUVO_DEMO_BRANCH_BACKUPS=<sample>: Branch Backups open, with that sample (`DemoBackups`).
        .task {
            guard ProcessInfo.processInfo.environment["KUVO_DEMO_BRANCH_BACKUPS"] != nil, !showsBackups else { return }
            await DemoWait.pause(.conversationShows)
            showsBackups = true
        }
        #endif
    }

    /// The panel's ⋯ menu.
    private func panelMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(ActionItem("Branch Backups…", subtitle: "Take back deleted branches and stashes") { showsBackups = true })
        return menu
    }

    /// A review of what the tab shows: the uncommitted changes with fresh eyes (/review), or the
    /// branch, which the engine's own review reads (/review-quick, where the keyword has the name).
    private func review(in model: SessionModel) {
        Analytics.shared.track("review_requested", ["scope": changes.scope.rawValue])
        let commands = Keyword.commands(catalog.commands(in: model.session.location.directory), keywords: model.keywords)
        let message = Self.reviewMessage(scope: changes.scope, base: changes.base, keywords: model.keywords)
        model.submit(message, files: [], for: catalog.model(model.session.model), queue: false, commands: commands)
    }

    /// What the review button sends. The engine's review, given a branch, reviews what this one
    /// changed since it (`git diff <base>...HEAD`): so the branch it's compared with, its base.
    static func reviewMessage(scope: ProjectChanges.Scope, base: String?, keywords: [Keyword]) -> String {
        guard scope == .branch, let base else { return "/review" }
        return (keywords.contains(.review) ? "/" + Keyword.quickReview : "/review") + " " + base
    }

    // MARK: Files

    /// The machine the project is on, as the app names it; on this Mac, its box, which runs git.
    private var machineName: String {
        RemoteFolder.machine(of: changes.directory).map { app.machines.engine($0)?.machine.name ?? $0 } ?? "Kuvo Code’s background service"
    }

    @ViewBuilder private var content: some View {
        // Not connected, never read; up, but its box couldn't be asked: said so below.
        if changes.shown == .waiting, changes.isAway, let machine {
            MachineWaitingView(engine: machine, note: "Its changes show here once it’s connected.")
        } else if changes.shown == .waiting {
            ContentUnavailableView {
                Label(RemoteFolder.isRemote(changes.directory) ? "Can’t Reach \(machineName)" : "Can’t Reach Kuvo Code’s Background Service", systemImage: "network.slash")
            } description: {
                Text("Its changes show once it’s back.")
            }
            .frame(maxHeight: .infinity)
        } else if changes.shown == .asLastSeen, let machine {
            VStack(spacing: 0) {
                // "3 minutes ago" kept true while it stays away.
                TimelineView(.everyMinute) { context in
                    MachineOfflineBar(engine: machine, kept: ChangesAway.asLastSeen(changes.read, now: context.date))
                }
                .background(Surface.well(scheme), in: .rect(cornerRadius: 12))
                .padding(8)
                list
                    .accessibilityHint("As last seen, while \(machine.machine.name) isn’t connected")
            }
        } else {
            list
        }
    }

    @ViewBuilder private var list: some View {
        if changes.files.isEmpty {
            ContentUnavailableView {
                Label(changes.isLoaded ? "No Changes" : "Reading Changes…", systemImage: "doc.text.magnifyingglass")
            } description: {
                if changes.isLoaded {
                    Text(!changes.isRepository ? "Files the agent edits show up here."
                        : changes.scope == .branch ? "Nothing changed since \(changes.base ?? "the branch began")."
                        : changes.scope == .session ? "The agent hasn't changed any files in this session yet."
                        : "Nothing \(changes.scope.title.lowercased()) in this project.")
                }
            }
            .frame(maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    ForEach(changes.files) { file in
                        Section {
                            if !collapsed.contains(file.id) {
                                FileBody(
                                    file: file,
                                    highlighted: highlighting[file.id],
                                    comments: model?.reviewComments.filter { $0.file == commentPrefix + file.path } ?? [],
                                    expandedFolds: $expandedFolds,
                                    draft: $draft,
                                    waitsFor: isAsLastSeen ? machineName : nil,
                                    addComment: model.map { model in { [commentPrefix] comment in
                                        var comment = comment
                                        comment.file = commentPrefix + comment.file
                                        model.reviewComments.append(comment)
                                        Analytics.shared.track("review_comment_added")
                                    } },
                                    deleteComment: { comment in model?.reviewComments.removeAll { $0.id == comment.id } }
                                )
                            }
                        } header: {
                            FileHeader(file: file, isCollapsed: collapsed.contains(file.id), scope: changes.isRepository && changes.scope != .branch && changes.scope != .session ? changes.scope : nil,
                                       waitsFor: isAsLastSeen ? machineName : nil) {
                                withAnimation(.ui) {
                                    if collapsed.contains(file.id) { collapsed.remove(file.id) } else { collapsed.insert(file.id) }
                                }
                            } perform: { action in
                                Task {
                                    // In the session's bar; with none open, an alert.
                                    guard let failure = await changes.perform(action, on: file) else { return }
                                    if let model { model.failure = failure } else { Modal.show(GitFailure(message: failure)) }
                                }
                            }
                        }
                    }
                }
                .padding(.bottom, 24)
            }
        }
    }
}

// MARK: - Commit

/// A commit message, what it'll take, and whether to push afterwards (remembered).
private struct CommitForm: View {
    let changes: ProjectChanges
    let environment: [String: String]
    let api: OpenCodeAPI?
    /// The session open in the window: its model suggests the message.
    let session: String?
    let model: ModelRef?
    /// Where to ask when the session's model can't (its coding agent can't answer outside the
    /// conversation): the engine, with its default model.
    var fallback: OpenCodeAPI? = nil
    let done: () -> Void
    @State private var isSuggesting = false
    @State private var message = DemoTyped.commit
    @State private var hasStaged: Bool?
    @State private var failure: String?
    @State private var isWorking = false
    @AppStorage("changes.pushAfterCommit") private var pushes = false
    @FocusState private var isFocused: Bool
    @Environment(AppModel.self) private var app

    /// The box the project is on, and the folder as it names it.
    private var box: (client: BoxClient, path: String) {
        if let (machine, path) = RemoteFolder.parse(changes.directory) { return (app.box(machine), path) }
        return (app.box(BoxClient.thisMac), changes.directory)
    }

    private var place: String {
        RemoteFolder.machine(of: changes.directory).map { app.machines.engine($0)?.machine.name ?? $0 } ?? "This Mac"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Commit Changes")
                .font(.headline)
            TextField("Message", text: $message, axis: .vertical)
                .lineLimit(3...10)
                .textFieldStyle(.roundedBorder)
                .focused($isFocused)
            if api != nil {
                Button {
                    suggest()
                } label: {
                    Label(isSuggesting ? "Writing…" : "Suggest a Message", systemImage: "pencil.line")
                }
                .buttonStyle(.link)
                .font(.callout)
                .disabled(isSuggesting)
                .help("Have the session's model write a message from the changes")
            }
            if let hasStaged {
                Text(hasStaged ? "Commits what's staged." : changes.scope == .branch ? "Commits what isn't committed yet." : "Commits all the changes shown, \(changes.files.count) \(changes.files.count == 1 ? "file" : "files").")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Toggle("Push afterwards", isOn: $pushes)
            if let failure {
                Text(failure)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if isWorking { Spinner(size: 12) }
                Spacer()
                Button("Cancel", role: .cancel, action: done)
                    .keyboardShortcut(.cancelAction)
                Button(pushes ? "Commit and Push" : "Commit") { commit() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking || changes.isAway)
                    .help(changes.isAway ? ChangesAway.waits("Commit", for: RemoteFolder.machine(of: changes.directory) ?? "its machine") : "")
            }
        }
        .padding(16)
        .frame(width: 340)
        .task {
            isFocused = true
            hasStaged = await changes.hasStaged()
        }
    }

    private func suggest() {
        guard let api else { return }
        isSuggesting = true
        failure = nil
        Task {
            defer { isSuggesting = false }
            do {
                // In the words of the box the project is on, with your instructions there.
                let prompt = try await CommitMessages.prompt(on: box.client, directory: box.path, place: place)
                // Through the session where there is one: free models only answer there.
                let text: String
                if let session {
                    do {
                        text = try await api.generate(prompt, session: session)
                    } catch let error where fallback != nil && !(error is CancellationError) {
                        text = try await fallback!.generate(prompt, model: nil)
                    }
                } else {
                    text = try await api.generate(prompt, model: model)
                }
                message = text.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "`\"")))
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    private func commit() {
        isWorking = true
        failure = nil
        Task {
            failure = await changes.commit(message: message.trimmingCharacters(in: .whitespacesAndNewlines), push: pushes, environment: environment)
            isWorking = false
            if failure == nil { done() }
        }
    }
}

// MARK: - Worktree

/// A branch, and bringing its work back: a worktree's merged into the project's folder, or any
/// pushed for a pull request.
private struct BranchMenu: View {
    let tree: Workspace.Worktree
    /// A session's own worktree, rather than a branch checked out in the project's folder.
    let isWorktree: Bool
    /// Where the session runs, in the worktree.
    let directory: String
    let model: SessionModel?
    let environment: [String: String]
    @Environment(Catalog.self) private var catalog
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    @State private var isWorking = false
    @State private var outcome: Outcome?
    @State private var confirmsPullRequest = false

    enum Outcome {
        case merged(into: String)
        case conflict([String], into: String)
        case pushed
        case failed(title: String, message: String)
    }

    var body: some View {
        Menu {
            Section(tree.branch) {
                if isWorktree {
                    Button("Merge into \(tree.base ?? "the Project’s Branch")", systemImage: "arrow.triangle.merge", action: merge)
                }
                Button("Create Pull Request…", systemImage: "arrow.up.forward.square") { confirmsPullRequest = true }
            }
            // (A machine's isn't in the Finder.)
            if isWorktree, !RemoteFolder.isRemote(directory) {
                Divider()
                Button("Show Worktree in Finder") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: directory) }
            }
        } label: {
            if isWorking {
                Spinner(size: 12)
            } else {
                Image(systemName: "arrow.triangle.branch")
            }
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(CardActionStyle())
        .fixedSize()
        .disabled(isWorking)
        .help(isWorktree ? "This session works on its own branch, \(tree.branch). Merge it or create a pull request." : "Create a pull request for \(tree.branch)")
        .accessibilityLabel(isWorktree ? "Merge or Create Pull Request" : "Create Pull Request")
        .closesWhenKept($confirmsPullRequest)
        .popover(isPresented: $confirmsPullRequest, arrowEdge: .bottom) {
            PullRequestForm(directory: directory, model: model) { pushedOnly in
                confirmsPullRequest = false
                if pushedOnly { outcome = .pushed }
            }
                .popoverContent()
        }
        #if DEBUG
        // KUVO_DEMO_BRANCH=merged|conflict|pushed|failed: what Merge or Create Pull Request said,
        // as if it had just run (nothing is merged or pushed); pull-request: its confirmation open.
        .task {
            guard let shown = ProcessInfo.processInfo.environment["KUVO_DEMO_BRANCH"] else { return }
            await DemoWait.pause(.conversationShows)
            switch shown {
            case "merged": outcome = .merged(into: tree.base ?? "main")
            case "conflict": outcome = .conflict(["src/timer.js", "test/timer.test.js"], into: tree.base ?? "main")
            case "pushed": outcome = .pushed
            case "pull-request": confirmsPullRequest = true
            case "failed": outcome = .failed(title: "Couldn’t Push", message: "fatal: could not read Username for 'https://github.com': terminal prompts disabled")
            default: break
            }
        }
        #endif
        .alert(title, isPresented: Binding(get: { outcome != nil }, set: { if !$0 { outcome = nil } })) {
            if case .conflict(_, let target) = outcome, let model {
                Button("Ask the Agent to Fix It") {
                    model.send("Merge \(target) into this branch (\(tree.branch)), resolve the conflicts, and commit the merge.", for: catalog.model(model.session.model), withComments: false)
                }
                Button("Cancel", role: .cancel) {}
            } else if case .merged = outcome, let model, !workspace.worktreeIsShared(directory, besides: model.id) {
                // Its work is in the project now. Its box removes the worktree with it, saving changes made since.
                Button("Archive Session") { Task { await workspace.setArchived(model.id, true) } }
                Button("Keep", role: .cancel) {}
            } else {
                Button("OK") {}
            }
        } message: {
            Text(message)
        }
    }

    private var title: String {
        switch outcome {
        case .merged(let target): "Merged into \(target)"
        case .conflict: "Merging Would Conflict"
        case .pushed: "Pushed \(tree.branch)"
        case .failed(let title, _): title
        case nil: ""
        }
    }

    private var message: String {
        switch outcome {
        case .merged: "The branch’s commits are in \(workspace.projectName(tree.project)) now, so its worktree can go."
        case .conflict(let files, let target):
            "\(target) changed some of the same lines: \(files.prefix(5).joined(separator: ", "))\(files.count > 5 ? " and \(files.count - 5) more" : ""). Nothing was merged."
        case .pushed: "Open a pull request for it on your git host."
        case .failed(_, let message): message
        case nil: ""
        }
    }

    private func merge() {
        let tree = tree, place = GitPlace.of(directory, box: app.box), author = Git.author(of: environment)
        isWorking = true
        Task {
            outcome = switch await tree.mergeBack(at: place, author: author) {
            case .merged(let target): .merged(into: target)
            case .conflict(let files, let target): .conflict(files, into: target)
            case .failed(let message): .failed(title: "Couldn’t Merge", message: message)
            }
            isWorking = false
            let result = switch outcome {
            case .merged: "merged"
            case .conflict: "conflict"
            default: "failed"
            }
            Analytics.shared.track("worktree_merged", ["outcome": result])
        }
    }
}

/// Create Pull Request's confirmation: the branch, the base it goes into, its title and description
/// (from the commits, or written by the session's model), and what Create does on the box the
/// project is on: makes it there with `gh`, or opens the host's page when `gh` isn't signed in
/// there (said so). The box pushes and creates it, as for a phone.
private struct PullRequestForm: View {
    /// Where the session runs: this Mac's folder, or a machine's.
    let directory: String
    let model: SessionModel?
    /// Closed; true when the branch was only pushed (a host the box can't open one on).
    let done: (_ pushedOnly: Bool) -> Void
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    @State private var draft: PullRequestDraft?
    @State private var title = ""
    @State private var description = ""
    @State private var failure: String?
    @State private var isSuggesting = false
    @State private var isWorking = false
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Create Pull Request")
                    .font(.headline)
                if let draft {
                    Text(draft.into)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
            }
            if let draft {
                TextField("Title", text: $title)
                    .textFieldStyle(.roundedBorder)
                    .focused($isFocused)
                TextField("Description", text: $description, prompt: Text("Optional"), axis: .vertical)
                    .lineLimit(3...10)
                    .textFieldStyle(.roundedBorder)
                if model != nil {
                    Button {
                        suggest()
                    } label: {
                        Label(isSuggesting ? "Writing…" : "Suggest a Title and Description", systemImage: "pencil.line")
                    }
                    .buttonStyle(.link)
                    .font(.callout)
                    .disabled(isSuggesting)
                    .help("Have the session's model write them from the branch's commits and changes")
                }
                Text(draft.what(on: place))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if failure == nil {
                HStack(spacing: 8) {
                    Spinner(size: 12)
                    Text("Looking at the branch…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            if let failure {
                Text(failure)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if isWorking { Spinner(size: 12) }
                Spacer()
                // Once it's pushing, it goes on to the end: closed then, it'd still open the page.
                Button("Cancel", role: .cancel) { done(false) }
                    .keyboardShortcut(.cancelAction)
                    .disabled(isWorking)
                Button(draft?.action ?? "Create Pull Request") { create() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(draft == nil || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking)
            }
        }
        .padding(16)
        .frame(width: 340)
        .interactiveDismissDisabled(isWorking)
        .task { await read() }
    }

    /// The box the project is on, and the folder as it names it.
    private var box: (client: BoxClient, path: String) {
        if let (machine, path) = RemoteFolder.parse(directory) { return (app.box(machine), path) }
        return (app.box(BoxClient.thisMac), directory)
    }

    private var place: String {
        RemoteFolder.machine(of: directory).map { app.machines.engine($0)?.machine.name ?? $0 } ?? "this Mac"
    }

    private func read() async {
        do {
            let found = try await PullRequests.draft(on: box.client, directory: box.path)
            draft = found
            title = found.title
            description = found.body
            isFocused = true
        } catch let refusal as BoxRefusal where refusal.isOlderBox {
            // A machine's box from before it made pull requests itself.
            failure = "\(place) needs a newer Kuvo Code to create pull requests. It updates by itself overnight, or connect to it from this Mac."
        } catch {
            failure = error.localizedDescription
        }
    }

    /// A title and description the session's model writes from what the branch brings.
    private func suggest() {
        guard let session = model?.id, let api = workspace.api(forSession: session) else { return }
        let isAgents = model.map { OutsideAgents.isAgentSession($0.session) } ?? false
        isSuggesting = true
        Task {
            defer { isSuggesting = false }
            // In the words of the box the project is on, with your instructions there.
            let asked: String?
            do {
                asked = try await PullRequests.draft(on: box.client, directory: box.path, withPrompt: true).prompt
            } catch {
                failure = error.localizedDescription
                return
            }
            guard let prompt = asked else {
                failure = "\(place.prefix(1).uppercased() + place.dropFirst()) needs a newer Kuvo Code to write one. It updates by itself overnight, or connect to it from this Mac."
                return
            }
            // A coding agent's session asks its own model; one whose agent can't answer outside
            // the conversation, the engine's default model.
            var written = try? await api.generate(prompt, session: session)
            if written == nil, isAgents { written = try? await app.api(for: app.thisMacsBox)?.generate(prompt) }
            guard let text = written, let pull = PullRequestDraft.parse(text) else {
                failure = "The model didn’t write one. Try again, or write it yourself."
                return
            }
            failure = nil
            (title, description) = (pull.title, pull.body)
        }
    }

    private func create() {
        guard let draft else { return }
        isWorking = true
        failure = nil
        let (title, body) = (title.trimmingCharacters(in: .whitespacesAndNewlines), description.trimmingCharacters(in: .whitespacesAndNewlines))
        Task {
            defer { isWorking = false }
            do {
                let made = try await PullRequests.create(on: box.client, directory: box.path, title: title, body: body, session: model?.session.id)
                Analytics.shared.track("pull_request_opened", ["host": draft.host, "made": draft.creates ? "yes" : "no"])
                switch made {
                case .made(let page), .toOpen(let page):
                    NSWorkspace.shared.open(page)
                    done(false)
                case .pushed: done(true)
                }
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}

// MARK: - File header

private struct FileHeader: View {
    let file: ChangedFile
    let isCollapsed: Bool
    /// What the panel shows, for which git actions make sense; nil outside a repository.
    let scope: ProjectChanges.Scope?
    /// Its machine, while it's away: the file is as last seen, and staging it waits.
    var waitsFor: String?
    let toggle: () -> Void
    let perform: (ProjectChanges.Action) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.cardIsFocused) private var cardIsFocused
    @State private var confirmsDiscard = false
    @State private var isHovering = false

    var body: some View {
        HStack(spacing: 8) {
            // Clicking the header folds the file away; the chevron says so.
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(hasBody ? (isHovering ? .primary : .secondary) : .quaternary)
                .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                .frame(width: 10)
                .accessibilityLabel("\(isCollapsed ? "Expand" : "Collapse") \((file.path as NSString).lastPathComponent)")
                .accessibilityRemoveTraits(.isHeader)
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { toggle() }
                .accessibilityHidden(!hasBody)
            Image(nsImage: NSWorkspace.shared.icon(of: file.url))
                .resizable()
                .frame(width: 18, height: 18)
            pathText
                .lineLimit(1)
                .truncationMode(.head)
                .help(file.oldPath.map { "\($0) → \(file.path)" } ?? file.path)
                .opacity(waitsFor == nil ? 1 : 0.55)
            if file.status != .modified {
                Text(statusLabel)
                    .opacity(waitsFor == nil ? 1 : 0.55)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(statusColor)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(statusColor.opacity(0.14), in: .capsule)
            }
            Spacer(minLength: 6)
            if hasBody {
                DiffStat(additions: file.additions, deletions: file.deletions)
                    .opacity(waitsFor == nil ? 1 : 0.55)
            } else {
                // Why it has no lines to show.
                Text(file.isTooBig ? "Too big to show" : "Binary")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            // A machine's files open nowhere on this Mac.
            if file.url.isFileURL {
                Button {
                    OpenWith.open(file.url)
                } label: {
                    Image(systemName: "arrow.up.forward.square")
                }
                .buttonStyle(CardActionStyle())
                .help("Open in Editor")
                .accessibilityLabel("Open in Editor")
                .disabled(file.status == .deleted)
            }
            // An AppKit menu, so Open With shows the apps' icons (SwiftUI's leaves them out).
            NativeMenuButton(opensBelow: true, menu: fileMenu) {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13))
                    .frame(width: 26, height: 24)
                    .hoverHighlight(in: RoundedRectangle(cornerRadius: 6), mutesInk: true)
            }
            .help("More")
            .fixedSize()
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .frame(height: 38)
        // Opaque: the header stays pinned while the file's lines scroll under it. A plain
        // rectangle: without a shape, the background takes the rounded shape of its container.
        .background(headerFill, in: .rect)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Surface.wellBorder(scheme)).frame(height: 1)
        }
        .contentShape(.rect)
        .onHover { isHovering = $0 && hasBody }
        .animation(.easeOut(duration: 0.12), value: isHovering)
        .onTapGesture { if hasBody { toggle() } }
        .alert("Discard the changes to \((file.path as NSString).lastPathComponent)?", isPresented: $confirmsDiscard) {
            Button("Discard", role: .destructive) { perform(.discard) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(file.isFolder && file.status != .added
                 ? "The folder in its place has a repository of its own: all of it goes to the Trash, with any of its commits you haven't pushed, and the file comes back."
                 : file.isFolder
                 ? "It's a new folder with a repository of its own, so all of it goes to the Trash, with any of its commits you haven't pushed."
                 : file.status == .added
                 ? "It's a new file, so it goes to the Trash."
                 : scope == .unstaged ? "Its unstaged changes are thrown away; staged ones stay. This can't be undone." : "It goes back to how it was in the last commit. This can't be undone.")
        }
    }

    /// Binary files other than pictures have nothing to open.
    private var hasBody: Bool { !(file.isBinary || file.isTooBig) || file.isImage }

    /// "Sources/Models/" quiet, "Message.swift" bold.
    private var pathText: Text {
        let name = (file.path as NSString).lastPathComponent
        let folder = String(file.path.dropLast(name.count))
        let folderText = Text(folder).foregroundStyle(.secondary).font(.system(size: 13))
        let nameText = Text(name).font(.system(size: 13, weight: .semibold))
        return Text("\(folderText)\(nameText)")
    }

    /// The card's own fill, opaque, so the header stays readable while lines scroll under it
    /// and still reads as part of the card (white or ivory); a shade deeper under the pointer.
    private var headerFill: Color {
        Surface.cardFill(scheme, focused: cardIsFocused)
            .mix(with: scheme == .dark ? .white : .black, by: isHovering ? 0.045 : 0, in: .device)
    }

    /// The file's ⋯ menu: opening it, its path, and staging it.
    private func fileMenu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let exists = file.status != .deleted
        if file.url.isFileURL {
            let open = ActionItem("Open in Editor") { OpenWith.open(file.url) }
            open.isEnabled = exists
            menu.addItem(open)
            let openWith = NSMenuItem(title: "Open With", action: nil, keyEquivalent: "")
            let apps = NSMenu()
            OpenWith.items(for: file.url).forEach(apps.addItem)
            openWith.submenu = apps
            openWith.isEnabled = exists
            menu.addItem(openWith)
            let finder = ActionItem("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([file.url]) }
            finder.isEnabled = exists
            menu.addItem(finder)
            menu.addItem(.separator())
        }
        // As everywhere, the whole path; and from the project, as git names it.
        menu.addItem(ActionItem("Copy Path") { Clipboard.copy(file.url.path) })
        menu.addItem(ActionItem("Copy Relative Path") { Clipboard.copy(file.path) })
        if let scope {
            menu.addItem(.separator())
            let items: [(ActionItem, verb: String)] = scope == .staged
                ? [(ActionItem("Unstage") { perform(.unstage) }, "Unstage")]
                : [(ActionItem("Stage") { perform(.stage) }, "Stage"), (ActionItem("Discard Changes…") { confirmsDiscard = true }, "Discard")]
            for (item, verb) in items {
                // As last seen: they wait for its machine, and say so.
                if let waitsFor {
                    item.isEnabled = false
                    item.subtitle = ChangesAway.waits(for: waitsFor)
                    item.toolTip = ChangesAway.waits(verb, for: waitsFor)
                }
                menu.addItem(item)
            }
        }
        return menu
    }

    private var statusLabel: String {
        switch file.status {
        case .added: "NEW"
        case .deleted: "DELETED"
        case .renamed: "RENAMED"
        case .modified: ""
        }
    }

    private var statusColor: Color {
        switch file.status {
        case .added: .green
        case .deleted: .red
        default: .secondary
        }
    }
}

// MARK: - File body

/// A file's lines, folded around its changes. Rows are direct children of the panel's
/// lazy stack, so long files only build what's on screen.
private struct FileBody: View {
    let file: ChangedFile
    let highlighted: DiffHighlighting?
    let comments: [ReviewComment]
    @Binding var expandedFolds: Set<String>
    @Binding var draft: ChangesPanel.DraftTarget?
    /// Its machine, while it's away: the lines are dimmed as last seen (comments stay as they are,
    /// and can still be written: they go with your next message).
    var waitsFor: String?
    private var isAsLastSeen: Bool { waitsFor != nil }
    /// Nil without a session: lines don't take comments then.
    let addComment: ((ReviewComment) -> Void)?
    let deleteComment: (ReviewComment) -> Void

    var body: some View {
        if file.isImage {
            ImageDiff(file: file, waitsFor: waitsFor)
                .opacity(isAsLastSeen ? 0.55 : 1)
        } else if file.isBinary || file.isTooBig {
            // Nothing to show line by line; the header says what changed.
            EmptyView()
        } else if file.lines.isEmpty {
            Text(file.status == .renamed ? "Renamed without changes" : "No content changes")
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
        } else {
            let gutter = DiffLineRow.gutterWidth(for: file.lines)
            ForEach(DiffFolding.rows(for: file.lines, expanded: expandedFolds, file: file.id)) { row in
                switch row.kind {
                case .fold(let range):
                    FoldRow(count: range.count) {
                        withAnimation(.ui) { _ = expandedFolds.insert(row.id) }
                    }
                case .gap:
                    FoldRow(count: nil) {}
                case .line(let index):
                    let line = file.lines[index]
                    DiffLineRow(line: line, runs: highlighted?.runs(for: line, at: index), gutterWidth: gutter,
                                comment: addComment == nil ? nil : {
                                    draft = .init(file: file.id, side: line.kind == .removed ? .old : .new, number: line.number, text: line.text)
                                })
                                .opacity(isAsLastSeen ? 0.55 : 1)
                    ForEach(comments.filter { $0.matches(line) }) { comment in
                        CommentCard(comment: comment) { deleteComment(comment) }
                    }
                    if let target = draft, target.isFor(line, in: file.id) {
                        CommentEditor(typed: target.typed) {
                            draft = nil
                        } save: { text in
                            addComment?(ReviewComment(file: file.path, line: target.number, side: target.side, snippet: target.text.trimmingCharacters(in: .whitespaces), text: text))
                            draft = nil
                        }
                    }
                }
            }
        }
    }
}

/// A changed picture: before and after side by side, or just the one that exists.
private struct ImageDiff: View {
    let file: ChangedFile
    /// Its machine, while it's away: its pictures are read once it's back.
    var waitsFor: String?
    @State private var images: Pair?
    @Environment(\.colorScheme) private var scheme

    struct Pair { var old: NSImage?; var new: NSImage? }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if let images {
                if let old = images.old { side(images.new == nil ? nil : "Before", old, edge: .deletions) }
                if let new = images.new { side(images.old == nil ? nil : "After", new, edge: .additions) }
                if images.old == nil && images.new == nil {
                    Text("Couldn't read this picture")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            } else if let waitsFor {
                Text("Its pictures show once \(waitsFor) is back.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                Placeholder(.image, label: "Loading pictures", fadesOut: false)
                    .frame(width: 200, height: 150)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .task(id: waitsFor == nil ? file : nil) { if waitsFor == nil { images = await Self.load(file) } }
    }

    private func side(_ label: String?, _ image: NSImage, edge: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let label {
                Text(label)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(edge)
            }
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: 260, maxHeight: 220, alignment: .topLeading)
                .background(Surface.well(scheme))
                .clipShape(.rect(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(edge.opacity(0.6), lineWidth: 1))
            if let rep = image.representations.first, rep.pixelsWide > 0 {
                Text("\(rep.pixelsWide) × \(rep.pixelsHigh)")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Each side from git (on its box) when it's committed or staged, otherwise from disk.
    private static func load(_ file: ChangedFile) async -> Pair {
        let repository = file.root.map { GitPlace.of($0) }
        return await Task.detached {
            // A machine's file from disk comes from its box, as a phone reads it.
            func read(_ object: String?, disk: URL?) async -> NSImage? {
                if let object, let repository, let data = await Git.shown(object, at: repository) { return NSImage(data: data) }
                if let disk, let (machine, path) = RemoteFolder.parse(disk) {
                    return (try? await BoxClient.machine(machine).file(path)).flatMap(NSImage.init(data:))
                }
                if let disk, FileManager.default.fileExists(atPath: disk.path) { return NSImage(contentsOf: disk) }
                return nil
            }
            return Pair(
                old: file.status == .added ? nil : await read(file.oldObject, disk: nil),
                new: file.status == .deleted ? nil : await read(file.newObject, disk: file.url)
            )
        }.value
    }
}

extension ReviewComment {
    /// The line it was written on: by its number (kept where its line is, `following`) and its
    /// text, so it doesn't slide onto another line.
    func matches(_ line: DiffLine) -> Bool {
        side == (line.kind == .removed ? .old : .new) && self.line == line.number
            && line.text.trimmingCharacters(in: .whitespaces) == snippet
    }
}

nonisolated extension DiffLine {
    /// The number shown in the gutter: the old one for a removed line, the new one otherwise.
    var number: Int { (kind == .removed ? oldNumber : newNumber) ?? 0 }
}

// MARK: - Folding

private struct FoldRow: View {
    /// Nil for a gap that can't be opened (git left those lines out).
    let count: Int?
    let expand: () -> Void

    var body: some View {
        Button(action: expand) {
            HStack(spacing: 10) {
                Image(systemName: count == nil ? "ellipsis" : "chevron.up.chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 30)
                if let count {
                    Text("\(count) unmodified lines")
                }
                Spacer()
            }
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .frame(height: 26)
        }
        .buttonStyle(FilledButtonStyle(shape: .rect, rest: 0.04))
        .disabled(count == nil)
        .help(count == nil ? "" : "Show these lines")
    }
}

// MARK: - Lines

/// One diff line: its number, a colored edge for changes, and the code, wrapped.
/// Hovering the number offers a comment.
struct DiffLineRow: View {
    let line: DiffLine
    var runs: [CodeHighlighter.Run]?
    let gutterWidth: CGFloat
    /// Nil where lines don't take comments.
    var comment: (() -> Void)?
    @Environment(\.colorScheme) private var scheme
    @State private var isHovering = false

    static func gutterWidth(for lines: [DiffLine]) -> CGFloat {
        let largest = lines.map(\.number).max() ?? 1
        return CGFloat(String(largest).count) * 7.5 + 22
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            // One column counts the file as it is now: a removed line has no number in it (a
            // comment on it still names its old line).
            Text(line.kind != .removed && line.number > 0 ? "\(line.number)" : "")
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundStyle(numberColor)
                .frame(width: gutterWidth - 10, alignment: .trailing)
                .padding(.trailing, 10)
                .overlay(alignment: .leading) {
                    if let comment, isHovering {
                        Button(action: comment) {
                            Image(systemName: "plus")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 16, height: 16)
                                .background(.tint, in: .rect(cornerRadius: 4))
                        }
                        .buttonStyle(AccentBadgeButtonStyle())
                        .offset(x: 2)
                        .accessibilityLabel("Comment on This Line")
                        .help("Comment on This Line")
                    }
                }
            code
                .font(.system(size: 12, design: .monospaced))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 8)
                .padding(.trailing, 12)
        }
        .padding(.vertical, 1.5)
        .background(rowColor, in: .rect)
        .overlay(alignment: .leading) {
            if line.kind != .context {
                Rectangle().fill(edgeColor).frame(width: 3)
            }
        }
        .contentShape(.rect)
        .onHover { isHovering = $0 }
        // The + shows under the pointer; with VoiceOver, the line offers the same.
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Comment on This Line") { comment?() }
    }

    /// The code, its indent apart, so a long line wraps under its own start as editors wrap it,
    /// not back at the margin where it would read as a line of its own.
    @ViewBuilder private var code: some View {
        let whole = colored
        let indent = line.text.prefix(while: { $0 == " " || $0 == "\t" }).count
        if indent > 0, indent < line.text.count, whole.characters.count == line.text.count {
            let split = whole.characters.index(whole.startIndex, offsetBy: indent)
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text(AttributedString(whole[..<split]))
                    .fixedSize()
                Text(AttributedString(whole[split...]))
            }
        } else {
            Text(whole)
        }
    }

    private var colored: AttributedString {
        guard let runs, !runs.isEmpty else { return AttributedString(line.text.isEmpty ? " " : line.text) }
        var string = AttributedString()
        for run in runs {
            var piece = AttributedString(run.text)
            if let color = CodeColors.color(for: run.type, dark: scheme == .dark) { piece.foregroundColor = color }
            string += piece
        }
        return string
    }

    private var rowColor: Color {
        switch line.kind {
        case .added: Color.additions.opacity(scheme == .dark ? 0.12 : 0.12)
        case .removed: Color.deletions.opacity(scheme == .dark ? 0.13 : 0.10)
        case .context: .clear
        }
    }

    private var edgeColor: Color { line.kind == .added ? .additions : .deletions }

    private var numberColor: Color {
        switch line.kind {
        case .added: Color.additions.opacity(0.9)
        case .removed: Color.deletions.opacity(0.9)
        case .context: Color.secondary.opacity(0.7)
        }
    }
}

/// Highlighted runs for a file's lines: the new side for added and unchanged lines,
/// the old side for removed ones, each tokenized whole so strings and comments that
/// span lines come out right.
nonisolated struct DiffHighlighting: Sendable {
    private var newSide: [[CodeHighlighter.Run]]
    private var oldSide: [[CodeHighlighter.Run]]
    private var newIndex: [Int: Int]
    private var oldIndex: [Int: Int]

    static func make(for file: ChangedFile) async -> DiffHighlighting? {
        guard let language = CodeHighlighter.language(for: file.path) else { return nil }
        var newLines: [String] = [], oldLines: [String] = []
        var newIndex: [Int: Int] = [:], oldIndex: [Int: Int] = [:]
        for (index, line) in file.lines.enumerated() {
            if line.kind != .removed { newIndex[index] = newLines.count; newLines.append(line.text) }
            if line.kind != .added { oldIndex[index] = oldLines.count; oldLines.append(line.text) }
        }
        let highlighter = CodeHighlighter.shared
        let new = await highlighter.lines(of: newLines.joined(separator: "\n"), language: language) ?? []
        let old = oldLines.isEmpty ? [] : await highlighter.lines(of: oldLines.joined(separator: "\n"), language: language) ?? []
        return DiffHighlighting(newSide: new, oldSide: old, newIndex: newIndex, oldIndex: oldIndex)
    }

    func runs(for line: DiffLine, at index: Int) -> [CodeHighlighter.Run]? {
        let runs: [CodeHighlighter.Run]
        if line.kind == .removed {
            guard let position = oldIndex[index], position < oldSide.count else { return nil }
            runs = oldSide[position]
        } else {
            guard let position = newIndex[index], position < newSide.count else { return nil }
            runs = newSide[position]
        }
        // Made for the file before its latest change, where another line had this place: the
        // line as it is, plain, until it's colored again.
        guard runs.map(\.text).joined() == line.text else { return nil }
        return runs
    }
}

// MARK: - Comments

/// A comment under its line, until it's sent. In accent glass, like your messages: it's yours,
/// and goes with the next one.
struct CommentCard: View {
    let comment: ReviewComment
    var delete: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Avatar()
                Text("You")
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Text(comment.side == .old ? "Line \(comment.line), before" : "Line \(comment.line)")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Text(comment.text)
                .font(.system(size: 13))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if let delete {
                HStack {
                    Spacer()
                    Button("Delete", action: delete)
                        .buttonStyle(TextButtonStyle(outset: true))
                        .font(.system(size: 12))
                }
            }
        }
        .padding(12)
        .modifier(RaisedNote())
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }
}

/// A comment as sent, in the transcript: where it points, the line, and what it says. In
/// accent glass, like the message it went with.
struct CommentReference: View {
    let comment: ReviewComment

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(comment.location, systemImage: "text.bubble")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.head)
            if !comment.snippet.isEmpty {
                Text(comment.snippet)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .padding(.leading, 8)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(comment.side == .old ? Color.deletions : Color.additions).frame(width: 2)
                    }
            }
            Text(comment.text)
                .transcriptFont()
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: 420, alignment: .leading)
        .accentGlass(RoundedRectangle(cornerRadius: 14))
    }
}

/// Writing a comment: ⌘Return saves, Escape cancels. In the same accent glass as the comment
/// it becomes.
private struct CommentEditor: View {
    let typed: ChangesPanel.DraftTarget.Typed
    let cancel: () -> Void
    let save: (String) -> Void
    @State private var text: String
    @FocusState private var focused: Bool

    init(typed: ChangesPanel.DraftTarget.Typed, cancel: @escaping () -> Void, save: @escaping (String) -> Void) {
        self.typed = typed
        self.cancel = cancel
        self.save = save
        _text = State(initialValue: typed.text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Avatar()
                Text("You")
                    .font(.system(size: 12, weight: .semibold))
            }
            TextField("Add a comment…", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .lineLimit(2...8)
                .focused($focused)
                .onKeyPress(.escape) {
                    if Composer.isComposing { return .ignored }
                    cancel()
                    return .handled
                }
                // Here, not on the button: a button's ⌘Return would take it from the composer too.
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.contains(.command) else { return .ignored }
                    submit()
                    return .handled
                }
            HStack {
                Spacer()
                Button("Cancel", action: cancel)
                    .buttonStyle(TextButtonStyle(outset: true))
                Button("Comment") { submit() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .help("Comment (⌘Return)")
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .font(.system(size: 12))
        }
        .padding(12)
        .modifier(RaisedNote())
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .onAppear { focused = true }
        .onChange(of: text) { typed.text = text }
    }

    private func submit() {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        save(text)
    }
}

/// The user's initials in a circle.
private struct Avatar: View {
    var body: some View {
        Text(initials)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
            .frame(width: 22, height: 22)
            .background(Color.primary.opacity(0.08), in: .circle)
    }

    private var initials: String {
        var name = NSFullUserName()
        #if DEBUG
        // KUVO_DEMO_NAME stands in for the user's name, for screenshots.
        if let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_NAME"] { name = demo }
        #endif
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap(\.first).map(String.init).joined()
        return letters.isEmpty ? "?" : letters.uppercased()
    }
}

/// A review comment in the diff: a raised note in the card's own color with a lit edge. Neutral,
/// so with a green or red accent it never reads as added or removed lines.
private struct RaisedNote: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.cardIsFocused) private var cardIsFocused

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10)
        content
            .background {
                shape
                    .fill(Surface.cardFill(scheme, focused: cardIsFocused))
                    .shadow(color: scheme == .dark ? .black.opacity(0.3) : Surface.slate.opacity(0.08), radius: 4, y: 1)
            }
            .specularRim(shape)
    }
}
