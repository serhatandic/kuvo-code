import AppKit
import ClientDesign
import ClientSandbox
import SwiftUI

/// Atop Settings › Permissions, the computer's sandbox as its box says it is: one quiet line while
/// it's on, an orange row with what happened and the button that fixes it while it isn't; then
/// Also Allowed, every folder its projects', bots' own and chats' commands may write in besides
/// their own, grouped by whose. A box from
/// before the sandbox shows none of it. (`PermissionsSettings` follows the state while it's open.)
struct SandboxSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Workspace.self) private var workspace
    @Environment(\.chooseBoxFolder) private var chooseBoxFolder
    /// The computer's home folder, for paths shown from `~`, by the box it's of.
    @State private var home: (box: String, path: String?)?
    /// Why Also Allowed couldn't be read, or the last add or remove didn't go through.
    @State private var failure: String?
    /// Reads of Also Allowed asked for again (Try Again), so its read starts over.
    @State private var attempt = 0
    /// A folder being added: the menu waits.
    @State private var isAdding = false
    @State private var confirmsRestart = false

    /// Which of it to draw: all of it, or its line (`notice`) and Also Allowed (`allowed`) apart,
    /// for the page to put a group between them.
    enum Part { case all, notice, allowed }
    var part: Part = .all

    private var sandboxes: Sandboxes { .shared }
    private var id: String { box.machine ?? BoxClient.mac }

    var body: some View {
        if let state = sandboxes.states[id] {
            if part != .allowed { notice(state) }
            // (Nothing to allow where it can't sandbox commands at all.)
            if state.able, part != .notice { allowed }
        } else if part != .allowed, !sandboxes.without.contains(id) {
            // Not read yet, or it couldn't be: a line in its place, so the page doesn't jump.
            Section {
            } header: {
                VStack(alignment: .leading, spacing: 4) {
                    if let failed = sandboxes.stateFailures[id] {
                        Text("Couldn’t read the sandbox on \(app.name(of: box)). \(failed)").foregroundStyle(.red)
                    } else {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.mini)
                            Text("Reading the sandbox…")
                        }
                    }
                }
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .settingsText()
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: How it is

    @ViewBuilder private func notice(_ state: SandboxState) -> some View {
        let notice = state.notice
        switch notice.look {
        case .on, .checking:
            // Only a header: a line under the page's title, not a group.
            Section {
            } header: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        if notice.look == .on {
                            Image(systemName: "checkmark.shield.fill").foregroundStyle(.green)
                        } else {
                            ProgressView().controlSize(.mini)
                        }
                        Text(notice.detail)
                    }
                    // What's shown may be out of date.
                    if let failed = sandboxes.stateFailures[id] {
                        Text(failed).foregroundStyle(.red).padding(.leading, 20)
                    }
                }
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .settingsText()
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
            }
        case .needsYou:
            Section {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "shield.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 26, height: 26)
                        .background(.orange, in: .rect(cornerRadius: 7))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        if let title = notice.title {
                            Text(title).font(.system(size: 13, weight: .medium)).accessibilityAddTraits(.isHeader)
                        }
                        Text(notice.detail)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if !notice.buttons.isEmpty {
                            HStack(spacing: 8) {
                                ForEach(notice.buttons, id: \.title) { button in
                                    Button(button.title) { act(button.action) }
                                        .disabled(button.action == .check && sandboxes.checking.contains(id))
                                }
                                if sandboxes.checking.contains(id) {
                                    ProgressView().controlSize(.small)
                                }
                            }
                            .padding(.top, 5)
                        }
                        if let failed = sandboxes.stateFailures[id] {
                            Text(failed).font(.system(size: 12)).foregroundStyle(.red)
                        }
                    }
                }
                .settingsText()
                .padding(.vertical, 4)
                .accessibilityElement(children: .contain)
                .confirmationDialog("Restart \(app.name(of: box))’s engine?", isPresented: $confirmsRestart) {
                    Button("Restart Engine") { restartEngine() }
                } message: {
                    Text("What agents are doing there now stops. Commands run in the sandbox once it’s back.")
                }
            }
        }
    }

    private func act(_ action: SandboxNotice.Action) {
        switch action {
        case .check: Task { try? await sandboxes.check(id) }
        case .restartEngine(let asking): if asking { confirmsRestart = true } else { restartEngine() }
        case .help: NSWorkspace.shared.open(URL(string: "https://www.kuvo.run/code/docs/machines/#sandbox")!)
        case .softwareUpdate: NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Software-Update-Settings.extension")!)
        case .report: app.reportProblem()
        }
    }

    private func restartEngine() {
        if let machine = box.machine {
            if let engine = app.machines.engine(machine) { app.restartEngine(engine) }
        } else {
            Task { await app.restart() }
        }
    }

    // MARK: Also Allowed

    /// This computer's projects, most recently active first, by the folder its box knows them by.
    private var projects: [(path: String, name: String)] {
        workspace.projects.compactMap { project in
            guard !Workspace.isChat(project.directory), SidebarBox(directory: project.directory) == box else { return nil }
            let path = box.machine == nil ? project.directory : RemoteFolder.parse(project.directory)?.path ?? project.directory
            return (path, project.name)
        }
    }

    /// This computer's bots, for their faces.
    private var bots: [Bot] { app.bots.list.filter { $0.machine == box.machine } }

    /// Every rule here, grouped by whose it is: its projects as this Mac names and orders them, then
    /// its bots, then the chats.
    private var groups: [AlsoAllowed.Group] {
        let projects = projects
        return AlsoAllowed.groups(sandboxes.allowed[id]?.allowed ?? [], names: Dictionary(projects.map { ($0.path, $0.name) }, uniquingKeysWith: { first, _ in first }), order: projects.map(\.path))
    }

    @ViewBuilder private var allowed: some View {
        let groups = groups
        Section {
            if sandboxes.allowed[id] == nil {
                // Not read yet, or it couldn't be (its words under it).
                if failure == nil {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Reading Also Allowed…").foregroundStyle(.secondary)
                    }
                    .settingsText()
                }
            } else if groups.isEmpty {
                Text(AlsoAllowed.empty)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .settingsText()
            }
            ForEach(groups) { group in
                owner(group)
                ForEach(group.rules) { rule in
                    row(rule)
                }
            }
            if let failure {
                HStack(alignment: .firstTextBaseline) {
                    Text(failure).font(.system(size: 12)).foregroundStyle(.red)
                    Spacer()
                    // Read again where it couldn't be read at all.
                    if sandboxes.allowed[id] == nil {
                        Button("Try Again") { attempt += 1 }.controlSize(.small)
                    }
                }
                .settingsText()
            }
        } header: {
            HStack {
                Text("Also Allowed")
                Spacer()
                addMenu
            }
            // (On the header: on a Section, it would run for each row.)
            .task(id: "\(id) \(attempt)") {
                failure = nil
                #if DEBUG
                if Sandboxes.demoRules != nil {
                    sandboxes.showDemo(on: id, project: projects.first?.path, bot: bots.first.map { ($0.id, $0.name) })
                    home = (id, NSHomeDirectory())
                    return
                }
                #endif
                do { try await sandboxes.readAllowed(on: id) } catch is CancellationError {} catch { failure = Self.words(error) }
                if home?.box != id {
                    let box = id
                    let path = box == BoxClient.mac ? NSHomeDirectory() : try? await app.box(box).folders(at: nil).home
                    home = (box, path)
                }
            }
        } footer: {
            Text(AlsoAllowed.footer(on: app.name(of: box)))
        }
    }

    /// A project's, a bot's or the chats' row, over its places: its folder, the bot's face or a
    /// chat's bubble, its name and how far its rules reach.
    private func owner(_ group: AlsoAllowed.Group) -> some View {
        HStack(spacing: 8) {
            Group {
                switch group.owner.kind {
                case .bot:
                    if let bot = bots.first(where: { $0.id == group.owner.id }) {
                        BotAvatar(look: bot.look, size: 20, animates: false)
                    } else {
                        Image(systemName: "person.crop.circle").foregroundStyle(.secondary)
                    }
                case .chats: Image(systemName: "bubble.left").foregroundStyle(.secondary)
                case .project: Image(systemName: "folder").foregroundStyle(.secondary)
                }
            }
            .frame(width: 20)
            .accessibilityHidden(true)
            Text(group.name).fontWeight(.semibold).lineLimit(1).truncationMode(.middle)
            Text(group.caption).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
        }
        .opacity(group.gone ? 0.6 : 1)
        .settingsText()
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /// Whom a folder can be added for: this computer's projects, its bots working in their own
    /// folder and the chats (as its box names them; a box before them, projects only).
    private var addMenu: some View {
        let owners = sandboxes.allowed[id]?.owners ?? []
        let botOwners = owners.filter { $0.kind == .bot }
        return Menu {
            Section(AlsoAllowed.projects) {
                ForEach(projects, id: \.path) { project in
                    Button { chooseFolder(for: SandboxOwner(kind: .project, name: project.name), project: project.path) } label: {
                        Label(project.name, systemImage: "folder")
                    }
                }
            }
            if !botOwners.isEmpty {
                Section(AlsoAllowed.bots) {
                    ForEach(botOwners, id: \.self) { owner in
                        Button { chooseFolder(for: owner) } label: {
                            if let look = bots.first(where: { $0.id == owner.id })?.look, let face = MessageMentions.face(look, size: 16) {
                                Label { Text(owner.name) } icon: { Image(nsImage: face) }
                            } else {
                                Label(owner.name, systemImage: "person.crop.circle")
                            }
                        }
                    }
                }
            }
            if owners.contains(.chats) {
                Divider()
                Button { chooseFolder(for: .chats) } label: { Label("Chats", systemImage: "bubble.left") }
            }
        } label: {
            Label(AlsoAllowed.add, systemImage: "plus")
        }
        .menuStyle(.button)
        .controlSize(.small)
        .fixedSize()
        .font(.system(size: 12))
        .disabled(isAdding || (projects.isEmpty && owners.isEmpty))
        .overlay(alignment: .leading) {
            if isAdding { ProgressView().controlSize(.mini).offset(x: -18).accessibilityLabel("Adding") }
        }
    }

    private func row(_ rule: SandboxRule) -> some View {
        let path = BoxPaths.display(rule.path, home: home?.box == id ? home?.path : nil)
        return HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(path)
                    .font(.system(size: 13, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(rule.path)
                Text(AlsoAllowed.detail(of: rule))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .settingsText()
            Spacer()
            Button {
                Task {
                    failure = nil
                    do { try await sandboxes.remove(rule, on: id) } catch { failure = Self.words(error) }
                }
            } label: {
                Image(systemName: "minus.circle.fill")
            }
            .buttonStyle(RemoveButtonStyle())
            .help("Remove")
            .accessibilityLabel("Remove \(path) from \(rule.whose.name)")
        }
        // Beneath its project's, bot's or the chats' row.
        .padding(.leading, 28)
        .accessibilityElement(children: .contain)
    }

    /// Adds a folder for a project (by its folder), a bot or the chats, chosen on this Mac or, on a
    /// machine, in its folders.
    private func chooseFolder(for owner: SandboxOwner, project: String? = nil) {
        if box.machine != nil {
            chooseBoxFolder? { path, _ in add(path, for: owner, project: project) }
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Allow"
        panel.message = AlsoAllowed.choosing(for: owner)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        add(url.path, for: owner, project: project)
    }

    private func add(_ path: String, for owner: SandboxOwner, project: String?) {
        isAdding = true
        Task {
            defer { isAdding = false }
            failure = nil
            do { try await sandboxes.allow(path, in: project, for: project == nil ? owner : nil, on: id) } catch { failure = Self.words(error) }
        }
    }

    private static func words(_ error: Error) -> String {
        (error as? BoxRefusal)?.message ?? error.localizedDescription
    }
}
