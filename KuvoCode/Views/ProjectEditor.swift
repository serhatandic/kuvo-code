import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI
import UniformTypeIdentifiers

/// Creating a project, or changing one, in a popup over the window: its name and its folders.
/// Sessions run in the primary folder, and the agent can work in the others too. An existing
/// project keeps its primary folder, since its sessions live there.
struct ProjectEditor: View {
    /// The project being edited; nil for a new one.
    let project: Workspace.Project?
    let save: (_ primary: String, _ settings: Workspace.ProjectSettings) -> Void
    /// Back to what was there before.
    let close: () -> Void

    @Environment(AppModel.self) private var app
    @Environment(Workspace.self) private var workspace
    @Environment(\.colorScheme) private var scheme
    @State private var name: String
    /// What runs in each new worktree; nil until it's known that the primary folder is in a
    /// git repository (and what the engine has for it).
    @State private var setup: String?
    @State private var savedSetup: String?
    /// The primary folder `setup` was read for.
    @State private var setupFolder: String?
    @State private var engineProject: String?
    @State private var run: String
    @FocusState private var isRunFocused: Bool
    @FocusState private var isSetupFocused: Bool
    private let focusesRun: Bool
    /// The primary folder first.
    @State private var folders: [String]
    @FocusState private var isNameFocused: Bool
    /// The machine the project's folders are on; nil for this Mac.
    @State private var machine: String?
    @State private var showsAddMachine = false
    /// Choosing a folder on the machine, from its own folders, in the form's place.
    @State private var choosesMachineFolder = false
    /// How tall the form is: the popup grows with it, up to a point, then it scrolls.
    @State private var formHeight: CGFloat = 320

    init(project: Workspace.Project?, folders: [String] = [], focusesRun: Bool = false, save: @escaping (String, Workspace.ProjectSettings) -> Void, close: @escaping () -> Void) {
        self.project = project
        self.save = save
        self.close = close
        self.focusesRun = focusesRun
        _name = State(initialValue: project?.settings.name ?? "")
        _run = State(initialValue: project?.settings.run ?? "")
        _folders = State(initialValue: project?.allFolders ?? folders)
        _machine = State(initialValue: (project?.allFolders ?? folders).first.flatMap(RemoteFolder.machine(of:)))
    }

    private var isNew: Bool { project == nil }

    var body: some View {
        if showsAddMachine {
            // A machine for its folders, added right here: the form is as it was on coming back.
            EditorDetail(back: isNew ? "New Project" : "Edit Project", title: "Add a Machine", onBack: { withAnimation(.ui) { showsAddMachine = false } }) {
                MachineForm(added: { added in
                    withAnimation(.ui) {
                        choose(added)
                        showsAddMachine = false
                    }
                }, cancel: { withAnimation(.ui) { showsAddMachine = false } })
            }
            .frame(width: Self.width, height: 480)
            .transition(.opacity)
        } else if choosesMachineFolder, let machine {
            // A folder on the machine, from its own folders: the form is as it was on coming back.
            VStack(alignment: .leading, spacing: 4) {
                Button { withAnimation(.ui) { choosesMachineFolder = false } } label: {
                    Label(isNew ? "New Project" : "Edit Project", systemImage: "chevron.backward")
                        .font(.system(size: 14, weight: .medium))
                }
                .buttonStyle(TextButtonStyle(outset: true))
                .padding(.horizontal, 28)
                .padding(.top, 24)
                Text("Add a Folder on \(app.machines.engine(machine)?.machine.name ?? machine)")
                    .font(.title2.weight(.bold))
                    .padding(.horizontal, 28)
                BoxFolderBrowser(box: machine, start: folders.first.flatMap { RemoteFolder.parse($0)?.path }.map { ($0 as NSString).deletingLastPathComponent }, primary: "Add Folder") { path, _ in
                    let folder = RemoteFolder.folder(path, on: machine)
                    withAnimation(.ui) {
                        if !folders.contains(folder) { folders.append(folder) }
                        choosesMachineFolder = false
                    }
                } cancel: {
                    withAnimation(.ui) { choosesMachineFolder = false }
                }
            }
            .frame(width: Self.width, height: 560)
            .transition(.opacity)
        } else {
            editor
        }
    }

    static let width: CGFloat = 560

    private var editor: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(isNew ? "New Project" : "Edit Project")
                    .font(.title2.weight(.bold))
                Spacer(minLength: 12)
                Button("Close", systemImage: "xmark", action: close)
                    .buttonStyle(CardActionStyle())
                    .help("Close")
            }
            .padding(.horizontal, 28)
            .padding(.top, 24)
            .padding(.bottom, 18)
            ScrollView {
                form
                    .padding(.horizontal, 28)
                    .padding(.bottom, 4)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { formHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            // What's under the footer fades there, rather than being cut by it.
            .fadingScrollEdges()
            .frame(height: min(formHeight, 520))
            EditorFooter(primary: isNew ? "Create Project" : "Save", canDoPrimary: !folders.isEmpty, onPrimary: saveProject, onCancel: close, cancelsOnEscape: true)
                .padding(.horizontal, 28)
                .padding(.top, 20)
                .padding(.bottom, 24)
        }
        .frame(width: Self.width)
        .onAppear { if focusesRun { isRunFocused = true } else { isNameFocused = true } }
        .task(id: folders.first) { await loadSetup() }
        #if DEBUG
        // KUVO_DEMO_ADD_MACHINE: Add a Machine, open in its place.
        .task {
            if isNew, ProcessInfo.processInfo.environment["KUVO_DEMO_ADD_MACHINE"] != nil {
                try? await Task.sleep(for: .seconds(1))
                showsAddMachine = true
            }
        }
        #endif
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 20) {
            nameField

            if isNew {
                section("Location") {
                    WellGroup { locationMenu }
                }
            }

            section("Folders", note: "Sessions run in the primary folder; the agent can work in the others too.") {
                folderList
            }

            section("Run") {
                WellGroup(isFocused: isRunFocused) {
                    WellRow {
                        Image(systemName: "play.fill")
                            .font(.system(size: 13))
                    } content: {
                        // A command can be long: it wraps, all of it in view.
                        TextField("Run", text: $run, prompt: Text(verbatim: "npm run dev"), axis: .vertical)
                            .textFieldStyle(.plain)
                            .font(.system(size: 14, design: .monospaced))
                            .lineLimit(1...8)
                            .focused($isRunFocused)
                            .padding(.vertical, 12)
                    }
                }
            }

            if setup != nil {
                section("Worktree Setup") {
                    WellGroup(isFocused: isSetupFocused) {
                        WellRow {
                            Image(systemName: "arrow.triangle.branch")
                                .font(.system(size: 14))
                        } content: {
                            TextField("Worktree setup", text: Binding(get: { setup ?? "" }, set: { setup = $0 }), prompt: Text(verbatim: "npm install && cp \"$OPENCODE_WORKTREE_BASE/.env\" ."), axis: .vertical)
                                .textFieldStyle(.plain)
                                .font(.system(size: 14, design: .monospaced))
                                .lineLimit(1...8)
                                .focused($isSetupFocused)
                                .padding(.vertical, 12)
                        }
                    }
                }
            }
        }
    }

    private func saveProject() {
        guard let primary = folders.first else { return }
        save(primary, Workspace.ProjectSettings(name: name, folders: Array(folders.dropFirst()), run: run))
        saveSetup()
        close()
    }

    // MARK: Worktree setup

    /// The engine keeps the setup command with its project (the repository).
    private func loadSetup() async {
        // Back from Add a Machine with the same folder: what's typed stays.
        guard folders.first != setupFolder else { return }
        setup = nil
        setupFolder = nil
        guard let primary = folders.first, let api = workspace.api(forFolder: primary),
              await Git.branches(at: GitPlace.of(primary, box: app.box))?.repository == true,
              let project = try? await api.location(directory: primary).project else { return }
        let command = (try? await api.projects())?.first { $0.id == project.id }?.commands?.start ?? ""
        // Another folder since, or the form went away: this one's read again when it's back.
        guard !Task.isCancelled else { return }
        engineProject = project.id
        savedSetup = command
        setup = command
        setupFolder = primary
    }

    private func saveSetup() {
        guard let primary = folders.first, let api = workspace.api(forFolder: primary), let engineProject, let setup, setup != savedSetup else { return }
        let command = setup.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { try? await api.setSetupCommand(project: engineProject, command.isEmpty ? nil : command) }
    }

    /// A titled part of the form, and a line under it when it needs one. (Run and worktree
    /// setup don't explain themselves here; the docs do.)
    private func section(_ title: String, note: String? = nil, isFailure: Bool = false, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            content()
            if let note {
                Text(note)
                    .font(.callout)
                    .foregroundStyle(isFailure ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Name

    private var nameField: some View {
        WellGroup(isFocused: isNameFocused) {
            WellRow {
                Image(systemName: "folder")
            } content: {
                // Left empty, the project takes its primary folder's name.
                TextField("Project name", text: $name, prompt: Text(folders.first.map { ($0 as NSString).lastPathComponent }.flatMap { $0.isEmpty ? nil : $0 } ?? "Project name"))
                    .textFieldStyle(.plain)
                    .focused($isNameFocused)
            }
        }
        .font(.system(size: 15))
    }

    // MARK: Location

    /// This Mac or one of your machines, as one row that opens a menu.
    private var locationMenu: some View {
        NativeMenuButton(name: "location", opensBelow: true) {
            let menu = NSMenu()
            menu.addItem(ActionItem("This Mac", image: NSImage(systemSymbolName: "laptopcomputer", accessibilityDescription: nil), checked: machine == nil) { choose(nil) })
            for engine in app.machines.list.compactMap({ app.machines.engine($0.id) }) {
                menu.addItem(ActionItem(engine.machine.name, subtitle: engine.statusText, image: NSImage(systemSymbolName: "server.rack", accessibilityDescription: nil), checked: machine == engine.machine.id) { choose(engine.machine.id) })
            }
            menu.addItem(.separator())
            menu.addItem(ActionItem("Add Machine…") { showsAddMachine = true })
            return menu
        } label: {
            LocationRow(machine: machine.flatMap { app.machines.engine($0) })
        }
    }

    /// Folders are all on one machine: changing it starts the list over.
    private func choose(_ machine: String?) {
        guard machine != self.machine else { return }
        withAnimation(.ui) {
            self.machine = machine
            folders = []
        }
        if let engine = app.machines.engine(machine), case .failed = engine.state { app.connect(engine) }
    }

    // MARK: Folders

    /// The folders as rows of one field, the way the name is drawn, with adding a folder as
    /// its last row.
    private var folderList: some View {
        WellGroup {
            ForEach(folders, id: \.self) { folder in
                FolderRow(
                    path: folder,
                    isPrimary: folder == folders.first,
                    canChangePrimary: isNew,
                    makePrimary: { withAnimation(.ui) { folders.removeAll { $0 == folder }; folders.insert(folder, at: 0) } },
                    remove: { withAnimation(.ui) { folders.removeAll { $0 == folder } } }
                )
                WellDivider()
            }
            Button {
                if machine == nil { addFolders() } else { withAnimation(.ui) { choosesMachineFolder = true } }
            } label: {
                WellRow {
                    Image(systemName: "plus")
                        .font(.system(size: 14, weight: .medium))
                } content: {
                    Text(folders.isEmpty ? "Add Folder…" : "Add Another Folder…")
                }
                .contentShape(.rect)
            }
            .buttonStyle(WellRowButtonStyle())
        }
    }

    private func addFolders() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Add"
        panel.message = folders.isEmpty ? "Choose the project's folders. The first one is where sessions run." : "Choose more folders for the agent to work with."
        guard panel.runModal() == .OK else { return }
        withAnimation(.ui) {
            folders += panel.urls.map(\.path).filter { !folders.contains($0) }
        }
    }
}

private struct FolderRow: View {
    let path: String
    let isPrimary: Bool
    /// A new project can still move its sessions' home; an existing one can't.
    let canChangePrimary: Bool
    let makePrimary: () -> Void
    let remove: () -> Void

    private var remote: (machine: String, path: String)? { RemoteFolder.parse(path) }

    var body: some View {
        WellRow {
            Image(nsImage: remote == nil ? NSWorkspace.shared.icon(forFile: path) : NSWorkspace.shared.icon(for: .folder))
                .resizable()
                .frame(width: 20, height: 20)
        } content: {
            HStack(spacing: 10) {
                // Just the name; the full path shows on hover.
                Text((path as NSString).lastPathComponent)
                    .lineLimit(1)
                    .help(remote.map { "\($0.machine):\($0.path)" } ?? (path as NSString).abbreviatingWithTildeInPath)
                Spacer(minLength: 8)
                // A checkmark: a state, not a button like Make Primary.
                if isPrimary {
                    Label("Primary", systemImage: "checkmark")
                        .labelStyle(.titleAndIcon)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                        .help("Sessions run in this folder")
                } else if canChangePrimary {
                    Button("Make Primary", action: makePrimary)
                        .font(.subheadline.weight(.medium))
                        .buttonStyle(TextButtonStyle(outset: true))
                        .help("Run sessions in this folder")
                }
                if !(isPrimary && !canChangePrimary) {
                    Button(action: remove) {
                        Image(systemName: "minus.circle.fill")
                    }
                    .buttonStyle(RemoveButtonStyle())
                    .accessibilityLabel("Remove from the project")
                    .help("Remove from the project")
                }
            }
        }
    }
}

/// A group of rows drawn into the sheet like one field: sunken, with an edge of its own. While
/// you type in one of its rows it has the focus rim, as every well does. In a popover, the rows
/// sit on the popover itself (`popoverContent`).
struct WellGroup<Content: View>: View {
    var isFocused = false
    @ViewBuilder var content: Content
    @Environment(\.isInPopover) private var isInPopover

    var body: some View {
        if isInPopover {
            VStack(spacing: 0) { content }
        } else {
            VStack(spacing: 0) { content }
                .clipShape(.rect(cornerRadius: 10))
                .recessedWell(RoundedRectangle(cornerRadius: 10), isFocused: isFocused)
        }
    }
}

/// One row of a well: an icon in its own column, a hairline, then the content.
struct WellRow<Icon: View, Content: View>: View {
    var height: CGFloat = 44
    @ViewBuilder var icon: Icon
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isInPopover) private var isInPopover

    var body: some View {
        HStack(spacing: 0) {
            icon
                .foregroundStyle(.secondary)
                .frame(width: isInPopover ? WellRow.popoverIcon : 42)
            // In a popover, the icon and the words with nothing between, as in the system's.
            if !isInPopover {
                Rectangle()
                    .fill(Surface.wellBorder(scheme))
                    .frame(width: 1)
            }
            content
                .padding(.horizontal, isInPopover ? 0 : 12)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: height)
    }
}

extension WellRow {
    /// An icon's column in a popover's row; its hairlines start after it, under the words.
    static var popoverIcon: CGFloat { 30 }
}

/// The hairline between a well's rows; in a popover, from under the rows' words.
struct WellDivider: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isInPopover) private var isInPopover

    var body: some View {
        Rectangle()
            .fill(Surface.wellBorder(scheme))
            .frame(height: 1)
            .padding(.leading, isInPopover ? WellRow<EmptyView, EmptyView>.popoverIcon : 0)
    }
}

/// A row of a well that's a button, like Add Folder…: secondary ink and a soft fill under
/// the pointer, so it reads as a field to click.
struct WellRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        WellRowButton(configuration: configuration)
    }

    private struct WellRowButton: View {
        let configuration: ButtonStyleConfiguration
        @State private var isHovering = false

        var body: some View {
            configuration.label
                .foregroundStyle(isHovering ? .primary : .secondary)
                .background(configuration.isPressed ? Pressable.pressedFill : isHovering ? Pressable.hoverFill : .clear)
                .onHover { isHovering = $0 }
                .animation(.easeOut(duration: 0.12), value: isHovering)
        }
    }
}

/// The Location row: where the project's folders are, and, for a machine, whether it's connected.
struct LocationRow: View {
    let machine: MachineEngine?
    @State private var isHovering = false

    var body: some View {
        WellRow {
            Image(systemName: machine == nil ? "laptopcomputer" : "server.rack")
        } content: {
            HStack(spacing: 8) {
                Text(machine?.machine.name ?? "This Mac")
                    .foregroundStyle(.primary)
                if let machine {
                    MachineStatus(engine: machine)
                }
                Spacer(minLength: 8)
                MenuChevron()
            }
        }
        .contentShape(.rect)
        .background(isHovering ? Pressable.hoverFill : .clear)
        .onHover { isHovering = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovering)
    }
}
