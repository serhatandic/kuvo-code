import AppKit
import ClientSandbox
import SwiftUI

/// Atop Settings › Permissions, the computer's sandbox as its box says it is: one quiet line while
/// it's on, an orange row with what happened and the button that fixes it while it isn't; then
/// each project's Also Allowed, the folders its commands may write in besides its own. A box from
/// before the sandbox shows none of it. (`PermissionsSettings` follows the state while it's open.)
struct SandboxSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Workspace.self) private var workspace
    @Environment(\.chooseBoxFolder) private var chooseBoxFolder
    @State private var picked: String?
    /// The computer's home folder, for paths shown from `~`, by the box it's of.
    @State private var home: (box: String, path: String?)?
    /// Why the last add or remove didn't go through.
    @State private var failure: String?
    @State private var confirmsRestart = false

    private var sandboxes: Sandboxes { .shared }
    private var id: String { box.machine ?? BoxClient.mac }

    var body: some View {
        if let state = sandboxes.states[id] {
            notice(state)
            // (Nothing to allow where it can't sandbox commands at all.)
            if state.able { allowed }
        } else if !sandboxes.without.contains(id) {
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

    private var project: (path: String, name: String)? {
        let projects = projects
        return projects.first { $0.path == picked } ?? projects.first
    }

    @ViewBuilder private var allowed: some View {
        let projects = projects
        Section {
            if let project {
                let rules = sandboxes.rules(for: project.path, on: id)
                Label {
                    Text("Always: \(project.name), its repository, the temporary folder and tools’ caches")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "folder").foregroundStyle(.secondary)
                }
                .settingsText()
                .task(id: id + "\n" + project.path) {
                    failure = nil
                    do { try await sandboxes.readRules(for: project.path, on: id) } catch { failure = Self.words(error) }
                    if home?.box != id {
                        let box = id
                        let path = box == BoxClient.mac ? NSHomeDirectory() : try? await app.box(box).folders(at: nil).home
                        home = (box, path)
                    }
                }
                ForEach(rules) { rule in
                    row(rule, in: project.path)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Button("Add Folder…") { chooseFolder(for: project.path) }
                    if let failure {
                        Text(failure).font(.system(size: 12)).foregroundStyle(.red)
                    }
                }
            } else {
                Text("No projects on \(app.name(of: box)) yet.")
                    .foregroundStyle(.secondary)
                    .settingsText()
            }
        } header: {
            HStack {
                Text("Also Allowed")
                Spacer()
                if projects.count > 1, let project {
                    Picker("Project", selection: Binding(get: { project.path }, set: { picked = $0 })) {
                        ForEach(projects, id: \.path) { Text($0.name).tag($0.path) }
                    }
                    .labelsHidden()
                    // A long name truncates, rather than pushing past a narrow window.
                    .frame(maxWidth: 240)
                    .font(.system(size: 12))
                } else if let project {
                    Text(project.name).font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
        } footer: {
            Text("What you allow for good on a stopped command’s card lands here. Kept on \(app.name(of: box)), so nothing in a project’s folder can add to it.")
        }
    }

    private func row(_ rule: SandboxRule, in project: String) -> some View {
        let path = BoxPaths.display(rule.path, home: home?.box == id ? home?.path : nil)
        return HStack(spacing: 10) {
            Image(systemName: "folder").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(path)
                    .font(.system(size: 13, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(rule.path)
                Text(Self.detail(of: rule))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .settingsText()
            Spacer()
            Button {
                Task {
                    failure = nil
                    do { try await sandboxes.remove(rule, from: project, on: id) } catch { failure = Self.words(error) }
                }
            } label: {
                Image(systemName: "minus.circle.fill")
            }
            .buttonStyle(RemoveButtonStyle())
            .help("Remove")
            .accessibilityLabel("Remove \(path)")
        }
        .accessibilityElement(children: .contain)
    }

    /// "Can write · Oct 29, from Serhat’s iPhone".
    static func detail(of rule: SandboxRule) -> String {
        let date = Date(timeIntervalSince1970: rule.at / 1000).formatted(.dateTime.month(.abbreviated).day())
        return "Can write · \(date)" + (rule.by.map { ", from \($0)" } ?? "")
    }

    private func chooseFolder(for project: String) {
        if box.machine != nil {
            chooseBoxFolder? { path, _ in add(path, to: project) }
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Allow"
        panel.message = "Choose a folder this project’s commands may write in, still in the sandbox."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        add(url.path, to: project)
    }

    private func add(_ path: String, to project: String) {
        Task {
            failure = nil
            do { try await sandboxes.allow(path, in: project, on: id) } catch { failure = Self.words(error) }
        }
    }

    private static func words(_ error: Error) -> String {
        (error as? BoxRefusal)?.message ?? error.localizedDescription
    }
}
