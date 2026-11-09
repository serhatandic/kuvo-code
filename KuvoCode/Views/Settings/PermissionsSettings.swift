import AppKit
import OpenCodeKit
import SwiftUI

/// What the agent may do without asking: a choice for each kind of action, rules for
/// particular commands or files, approvals saved with "Always", and blocks nothing overrides.
struct PermissionsSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Workspace.self) private var workspace
    @State private var saved: [Saved] = []
    /// A rule's folder being chosen on a machine: what to do with it.
    @State private var choosingFolder: ((_ path: String, _ home: String) -> Void)?

    /// An approval saved with Always, and the engine that keeps it: this Mac's, or a machine's.
    struct Saved: Identifiable {
        let permission: SavedPermission
        let engine: MachineEngine?
        var id: String { (engine?.machine.id ?? "") + "/" + permission.id }
    }

    private var config: EngineConfig { app.config(for: box) }
    private static let path = ["permissions"]

    /// The kinds of action, with what they cover; each is a rule for every resource ("*").
    static let actions: [(id: String, title: String, detail: String)] = [
        ("edit", "Edit files", "Changing, creating or deleting files. Plan mode doesn't, by default."),
        ("shell", "Run commands", "In the terminal."),
        ("read", "Read files", "Files ending in .env ask first unless you allow this."),
        ("external_directory", "Work outside the project", "In folders that aren't the project's."),
        ("webfetch", "Open web pages", ""),
        ("websearch", "Search the web", ""),
        ("subagent", "Hand work to subagents", ""),
        ("skill", "Use skills", ""),
    ]

    /// What the engine does with no choice made: everything is allowed but working outside the
    /// project, which asks; Plan mode doesn't edit (its built-in rules, as the engine lists them).
    static func engineDefault(_ action: String, agent: String? = nil) -> PermissionRule.Effect {
        switch (action, agent) {
        case ("external_directory", _): .ask
        case ("edit", "plan"): .deny
        default: .allow
        }
    }

    var body: some View {
        ScrollingSettingsForm {
            // The sandbox's line, then whether your other computers may start work here, then
            // the folders its commands may write in besides their own.
            SandboxSettings(part: .notice)

            OtherComputersSettings()

            SandboxSettings(part: .allowed)

            Section {
                ActionChoices(path: Self.path)
            } header: {
                Text("When the Agent Wants To")
            } footer: {
                Text("For every session and mode. Don't Allow holds even in Full Access. Codex, Cursor, Grok and Antigravity may read files without asking.")
                    .foregroundStyle(.secondary)
            }

            ConfigProblem()

            Section {
                RulesEditor(path: Self.path, hiding: Set(Self.actions.map(\.id)))
            } header: {
                Text("Rules")
            } footer: {
                // Verbatim: as Markdown, the asterisks would turn part of the sentence into italics.
                Text(verbatim: "For particular commands, files or sites, like \"git push *\" or \"*.pem\". * matches anything. When rules overlap, the one lower in the list wins.")
                    .foregroundStyle(.secondary)
            }

            Section {
                if saved.isEmpty {
                    Text("None yet. Choosing Always when the agent asks saves an approval here.")
                        .foregroundStyle(.secondary)
                }
                ForEach(saved) { item in
                    let permission = item.permission
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(Self.title(of: permission.action)): \(permission.resource)")
                                .lineLimit(2)
                                .truncationMode(.middle)
                            Text(projectName(permission.projectID))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button {
                            Task {
                                // From the engine that keeps it (a machine's, not this Mac's, also
                                // while it's away: then it stays, and shows again).
                                try? await (item.engine.map(\.api) ?? app.api(for: box))?.removeSavedPermission(permission.id)
                                await loadSaved()
                            }
                        } label: {
                            Image(systemName: "minus.circle.fill")
                        }
                        .buttonStyle(RemoveButtonStyle())
                        .accessibilityLabel("Remove")
                        .help("Remove")
                    }
                }
            } header: {
                Text("Always Allowed")
            }

            Section {
                RulesEditor(path: ["policies"], actions: Self.policyKinds, effects: [.deny, .allow], prompt: "Like shell:git push *, openrouter or mcp:github")
            } header: {
                Text("Blocks")
            } footer: {
                Text(verbatim: "Blocks win over everything else, including approvals. Block a tool or command as \"shell:git push *\", a provider by its ID, or an MCP server, skill or plugin as \"mcp:name\", \"skill:name\" or \"plugin:name\".")
                    .foregroundStyle(.secondary)
            }
        }
        .task {
            // Engine 2.0.29 moved blocks out of `experimental`; bring any set there along.
            let old = config.items(["experimental", "policies"])
            if !old.isEmpty {
                config.set([(["policies"], .array(config.items(["policies"]) + old)), (["experimental", "policies"], nil)])
            }
            await loadSaved()
        }
        // Again once its engine answers (a machine's, connecting as the page opened).
        .task(id: app.isReady(box)) { if app.isReady(box) { await loadSaved() } }
        // Whether your other computers may start work here, as its box says now.
        .task(id: app.isReady(box)) { if app.isReady(box) { try? await workspace.readApprovalHere(onBox: box.machine ?? BoxClient.mac) } }
        // Its sandbox, as it changes while the page is open.
        .task(id: box) { await Sandboxes.shared.watchState(box.machine ?? BoxClient.mac) }
        // A machine's folder for a rule, from its own folders.
        .environment(\.chooseBoxFolder, box.machine == nil ? nil : { done in choosingFolder = done })
        .settingsDetail(isPresented: Binding(get: { choosingFolder != nil }, set: { if !$0 { choosingFolder = nil } }), title: "Choose a Folder") {
            BoxFolderBrowser(box: box.machine ?? BoxClient.mac, start: nil, primary: "Choose") { path, home in
                choosingFolder?(path, home)
                choosingFolder = nil
            } cancel: {
                choosingFolder = nil
            }
        }
    }

    static let policyKinds: [(id: String, title: String)] = [
        ("tool.use", "Tool or command"),
        ("provider.use", "Provider"),
        ("integration.use", "MCP server, skill or plugin"),
    ]

    /// This computer's engine's approvals: Always in a session saves it in the engine of the
    /// computer it's on.
    private func loadSaved() async {
        let engines: [(api: OpenCodeAPI, engine: MachineEngine?)] = app.api(for: box).map { [($0, app.machines.engine(box.machine))] } ?? []
        saved = await Self.saved(from: engines, sessions: workspace.sessions) { saved = $0 }
    }

    /// Every engine's approvals, `shown` as each engine answers (a slow machine doesn't hold up
    /// this Mac's). An engine lists one project's at a time: the folders outside any, then each
    /// project its sessions are in.
    static func saved(from engines: [(api: OpenCodeAPI, engine: MachineEngine?)], sessions: [Session], shown: ([Saved]) -> Void = { _ in }) async -> [Saved] {
        var all: [Saved] = []
        for (api, engine) in engines {
            let sessions = sessions.filter { RemoteFolder.machine(of: $0.location.directory) == engine?.machine.id }
            var found = (try? await api.savedPermissions()) ?? []
            for project in Set(sessions.map(\.projectID)).sorted() {
                for permission in (try? await api.savedPermissions(projectID: project)) ?? [] where !found.contains(where: { $0.id == permission.id }) {
                    found.append(permission)
                }
            }
            all += found.map { Saved(permission: $0, engine: engine) }
            shown(all)
        }
        return all
    }

    private func projectName(_ id: String) -> String {
        workspace.sessions.first { $0.projectID == id }.map { workspace.projectName($0.location.directory) } ?? "A project"
    }

    static func title(of action: String) -> String {
        actions.first { $0.id == action }?.title ?? action
    }
}

/// A choice for each kind of action (Allow, Ask First, Don't Allow, or back to the default): a rule for every
/// resource ("*") in the rules list at `path`, kept at its front so rules for particular
/// commands or files, after it, win.
struct ActionChoices: View {
    let path: [String]
    /// The agent these are for, in its editor: Default there is what Settings › Permissions
    /// chose, else the engine's default for it.
    var agent: String? = nil
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(\.editedConfig) private var edited

    private var config: EngineConfig { edited ?? app.config(for: box) }

    var body: some View {
        ForEach(PermissionsSettings.actions, id: \.id) { action in
            let changed = effect(for: action.id).wrappedValue != nil
            LabeledContent {
                // What the agent may do, whether chosen here or not; Reset goes back to the default.
                Picker(action.title, selection: choice(for: action.id)) {
                    Text("Allow").tag(Choice.effect(.allow))
                    Text("Ask First").tag(Choice.effect(.ask))
                    Text("Don't Allow").tag(Choice.effect(.deny))
                    // One a newer engine set, shown as it is (and kept, unless you pick another).
                    if case .unknown(let raw)? = effect(for: action.id).wrappedValue {
                        Text(PermissionRule.Effect.newerTitle).tag(Choice.effect(.unknown(raw)))
                    }
                    if changed {
                        Divider()
                        Text("Reset to Default (\(inherited(action.id).title))").tag(Choice.reset)
                    }
                }
                .labelsHidden()
                .fixedSize()
            } label: {
                if changed {
                    Text(action.title) + Text(" · changed").foregroundColor(.accentColor)
                } else {
                    Text(action.title)
                }
                if !action.detail.isEmpty { Text(action.detail) }
            }
        }
    }

    private enum Choice: Hashable {
        case effect(PermissionRule.Effect)
        case reset
    }

    /// The effect in force, chosen here or inherited. Picking what's inherited already sets
    /// nothing, so a row reads as changed only when it differs by your choice.
    private func choice(for action: String) -> Binding<Choice> {
        let explicit = effect(for: action)
        return Binding {
            .effect(explicit.wrappedValue ?? inherited(action))
        } set: { choice in
            switch choice {
            case .reset: explicit.wrappedValue = nil
            case .effect(let effect):
                if explicit.wrappedValue == nil, effect == inherited(action) { return }
                explicit.wrappedValue = effect
            }
        }
    }

    /// What applies with no choice here: Settings › Permissions' choice (for an agent), else the
    /// engine's default.
    private func inherited(_ action: String) -> PermissionRule.Effect {
        if agent != nil || path != ["permissions"],
           let global = app.config(for: box).items(["permissions"]).compactMap(\.rule).last(where: { $0.action == action && $0.resource == "*" }) {
            return global.effect
        }
        return PermissionsSettings.engineDefault(action, agent: agent)
    }

    private func effect(for action: String) -> Binding<PermissionRule.Effect?> {
        Binding {
            config.items(path).compactMap(\.rule).last { $0.action == action && $0.resource == "*" }?.effect
        } set: { effect in
            // Only the rule this sets; the rest, including any written by hand, stay as they are.
            var items = config.items(path).filter { $0.rule.map { !($0.action == action && $0.resource == "*") } ?? true }
            if let effect { items.insert(PermissionRule(action: action, resource: "*", effect: effect).json, at: 0) }
            config.setItems(items, at: path)
        }
    }
}

extension PermissionRule.Effect {
    /// As the choices name it.
    var title: String {
        switch self {
        case .allow: "Allow"
        case .ask: "Ask First"
        case .deny: "Don't Allow"
        case .unknown: Self.newerTitle
        }
    }

    /// One a newer engine set that this app doesn't know.
    static let newerTitle = "Set by a Newer Engine"
}

extension PermissionRule {
    var json: JSONValue {
        .object(["action": .string(action), "resource": .string(resource), "effect": .string(effect.rawValue)])
    }
}

extension JSONValue {
    /// This item of a rules list as a rule, if it is one.
    var rule: PermissionRule? { try? decode(as: PermissionRule.self) }
}

/// An ordered list of `{action, resource, effect}` rules at a path in the settings, each
/// editable in place, with a button to add one. Rules for actions in `hiding`, for everything
/// ("*"), are left out: they have their own controls (`ActionChoices`), and a rule can't be
/// made one of those here. Items that aren't rules (written by hand) are kept where they are.
///
/// Rules you add are new rows under the others, as many as you like, each saved once it has a
/// pattern and you press Return or leave it (or leave the page). In a draft (a new agent), the
/// new ones wait at `pendingKey` for its Create.
struct RulesEditor: View {
    let path: [String]
    var actions: [(id: String, title: String)] = PermissionsSettings.actions.map { ($0.id, $0.title) }
    var effects: [PermissionRule.Effect] = [.allow, .ask, .deny]
    var hiding: Set<String> = []
    /// What a new rule's pattern field says while it's empty; nil for the action's own example.
    var prompt: String?
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(\.editedConfig) private var edited
    @Environment(\.chooseBoxFolder) private var chooseBoxFolder
    @Environment(Catalog.self) private var catalog
    /// The computer's skills, by name, for a rule's pattern menu.
    @State private var skills: [String] = []
    /// Rules being added, until each has a pattern: a half-made rule never changes what the
    /// agent may do.
    @State private var drafts: [Draft] = []
    /// The one just added, which takes the cursor.
    @State private var focused: UUID?

    private struct Draft: Identifiable, Equatable {
        let id = UUID()
        var rule: PermissionRule
    }

    /// Where a draft's new rules wait, in front of their path: `[pendingKey] + path`.
    static let pendingKey = "pendingRules"

    private var config: EngineConfig { edited ?? app.config(for: box) }

    /// Why a rule can't be saved as it is, if it can't.
    static func problem(of rule: PermissionRule, hiding: Set<String>) -> String? {
        let pattern = rule.resource.trimmingCharacters(in: .whitespacesAndNewlines)
        if pattern.isEmpty { return "Needs a pattern." }
        if pattern == "*", hiding.contains(rule.action) { return "For all of them, set \(PermissionsSettings.title(of: rule.action)) above." }
        return nil
    }

    var body: some View {
        let items = config.items(path)
        let shown = items.indices.filter { index in
            guard let rule = items[index].rule else { return false }
            return !(hiding.contains(rule.action) && rule.resource == "*")
        }
        Group {
            if shown.isEmpty, drafts.isEmpty {
                Text("None yet.")
                    .foregroundStyle(.secondary)
            }
            // Each row by its rule's action and effect, and which of those it is, not by its place
            // in the list: a rule put in above (an action's choice) or one removed doesn't hand a
            // row being typed in to another rule. (Typing a pattern doesn't change it, so the row
            // keeps the cursor.)
            ForEach(Self.keyed(shown, in: items), id: \.key) { row in
                let index = row.index
                if let rule = items[index].rule {
                    RuleRow(rule: rule, actions: actions, effects: effects, prompt: prompt ?? Self.example(for: rule.action),
                            suggestions: suggestions(for: rule.action), problem: { Self.problem(of: $0, hiding: hiding) }) { changed in
                        change(index, from: rule, to: changed)
                    } typed: { text in
                        // A draft keeps up with every key, for its Create; without spaces around
                        // the pattern there (they're the end of a word you're typing).
                        let typed = PermissionRule(action: rule.action, resource: text, effect: rule.effect)
                        if config.isDraft, Self.problem(of: typed, hiding: hiding) == nil, text != rule.resource { change(index, from: rule, to: typed) }
                    }
                }
            }
            // By its ID, not a binding into the list: a row that's going (removed, saved) can still
            // write what it shows as it goes, after it's out of the list.
            ForEach(drafts) { draft in
                RuleRow(rule: draft.rule, actions: actions, effects: effects, prompt: prompt ?? Self.example(for: draft.rule.action),
                        suggestions: suggestions(for: draft.rule.action), isNew: true, focusesOnAppear: focused == draft.id, problem: { Self.problem(of: $0, hiding: hiding) }) { changed in
                    guard let index = drafts.firstIndex(where: { $0.id == draft.id }) else { return }
                    if let changed { drafts[index].rule = changed } else { drafts.remove(at: index) }
                } typed: { text in
                    guard let index = drafts.firstIndex(where: { $0.id == draft.id }) else { return }
                    drafts[index].rule.resource = text
                } commit: {
                    save(draft.id)
                }
            }
            Button("Add Rule", action: add)
                // Leaving the page keeps the ones that have a pattern.
                .onDisappear { for draft in drafts { save(draft.id) } }
        }
        .onChange(of: drafts) {
            guard config.isDraft else { return }
            config.setItems(drafts.map(\.rule.json), at: [Self.pendingKey] + path)
        }
        .task(id: app.isReady(box)) {
            skills = ((try? await app.api(for: box)?.skills()) ?? []).map(\.name).sorted()
        }
    }

    /// What the computer being edited has, as its engine lists it; nil while a machine's isn't
    /// running (never this Mac's in its place).
    private var here: Catalog? {
        guard let machine = box.machine else { return catalog }
        return app.machines.engine(machine)?.catalog
    }

    /// What a rule for `action` can name, from what this computer has: its subagents, skills,
    /// providers and servers, a folder, or the patterns people use most.
    private func suggestions(for action: String) -> [PatternSuggestion] {
        let servers = (config.value(at: MCPSettings.path)?.object?.keys.map { $0 } ?? []).filter { !MCPSettings.builtIn.contains($0) }.sorted()
        switch action {
        case "shell":
            return [.init("Pushing with git", "git push *"), .init("Committing", "git commit *"), .init("Deleting files", "rm *"), .init("Installing packages", "npm install *")]
        case "edit", "read":
            return [.init("Environment files", "*.env"), .init("Keys and certificates", "*.pem"), .init("Lock files", "*.lock")]
        case "external_directory":
            return [.init("Downloads", "~/Downloads/*"), .init("Temporary files", "/tmp/*")] + (box.machine == nil || chooseBoxFolder != nil ? [PatternSuggestion.folder] : [])
        case "webfetch":
            return [.init("GitHub", "https://github.com/*"), .init("Any http address", "http://*")]
        case "subagent":
            return (here?.agents ?? []).filter { !$0.isPrimary && !$0.hidden }.map { .init($0.name, $0.id) }
        case "skill":
            return skills.map { .init($0, $0) }
        case "provider.use":
            return (here?.connectedProviders ?? []).map { .init($0.name, $0.id) }
        case "integration.use":
            return servers.map { .init("\($0) (MCP server)", "mcp:\($0)") } + skills.map { .init("\($0) (skill)", "skill:\($0)") }
        case "tool.use":
            return [.init("Pushing with git", "shell:git push *"), .init("Deleting files", "shell:rm *"), .init("Opening web pages", "webfetch:*")]
        default:
            return []
        }
    }

    /// For the pattern field: what one looks like for this kind of action.
    static func example(for action: String) -> String {
        switch action {
        case "shell": "Like git push * or npm run *"
        case "edit", "read": "Like *.env or docs/*"
        case "external_directory": "Like ~/Downloads/*"
        default: "A pattern; * matches anything"
        }
    }

    /// Changes `rule`, at `index` when its row was drawn: where it is now, as the list may have
    /// moved meanwhile (a choice above added a rule, one was removed), and not at all if it's gone.
    /// A row saving what you typed as it goes away wrote over whatever had come to its place.
    private struct RowKey: Hashable {
        let action: String
        let effect: String
        let occurrence: Int
    }

    private static func keyed(_ shown: [Int], in items: [JSONValue]) -> [(key: RowKey, index: Int)] {
        var seen: [String: Int] = [:]
        return shown.compactMap { index in
            guard let rule = items[index].rule else { return nil }
            let base = rule.action + "\u{1}" + rule.effect.rawValue
            let occurrence = seen[base, default: 0]
            seen[base] = occurrence + 1
            return (RowKey(action: rule.action, effect: rule.effect.rawValue, occurrence: occurrence), index)
        }
    }

    private func change(_ index: Int, from rule: PermissionRule, to changed: PermissionRule?) {
        var items = config.items(path)
        let at = items.indices.contains(index) && items[index].rule == rule ? index : items.firstIndex { $0.rule == rule }
        guard let at else { return }
        if let changed { items[at] = changed.json } else { items.remove(at: at) }
        config.setItems(items, at: path)
    }

    /// Saves a new rule at the end of the list, once it can be.
    private func save(_ id: UUID) {
        guard let index = drafts.firstIndex(where: { $0.id == id }) else { return }
        var rule = drafts[index].rule
        rule.resource = rule.resource.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.problem(of: rule, hiding: hiding) == nil else { return }
        drafts.remove(at: index)
        config.setItems(config.items(path) + [rule.json], at: path)
    }

    /// Another new rule, under the others, with the cursor in its pattern.
    private func add() {
        // Most rules are for commands ("git push *"), when there are some.
        let action = actions.contains { $0.id == "shell" } ? "shell" : actions.first?.id ?? "shell"
        let draft = Draft(rule: PermissionRule(action: action, resource: "", effect: effects.first ?? .ask))
        focused = draft.id
        drafts.append(draft)
    }
}

/// One rule: what kind of action, which (a pattern), and what happens; under it, why it can't be
/// saved as it is, if it can't.
private struct RuleRow: View {
    let rule: PermissionRule
    let actions: [(id: String, title: String)]
    let effects: [PermissionRule.Effect]
    let prompt: String
    /// What its pattern can be, from what the computer has, in a menu beside it.
    var suggestions: [PatternSuggestion] = []
    /// Not saved yet: it's kept as typed until it can be.
    var isNew = false
    /// Takes the cursor as it shows (one just added).
    var focusesOnAppear = false
    let problem: (PermissionRule) -> String?
    /// The rule as changed, or nil to remove it.
    let change: (PermissionRule?) -> Void

    /// The pattern a change of kind or effect keeps: what's typed, once it can be a rule's (the
    /// row it moves to doesn't have it), else the saved one.
    private var pattern: String {
        let typed = resource.trimmingCharacters(in: .whitespacesAndNewlines)
        return !typed.isEmpty && problem(PermissionRule(action: rule.action, resource: typed, effect: rule.effect)) == nil ? typed : rule.resource
    }
    /// Each change to the pattern as it's typed.
    let typed: (String) -> Void
    /// For a new one: save it now, if it can be.
    var commit: () -> Void = {}
    @State private var resource = ""
    @Environment(\.settingsBox) private var box
    @Environment(\.chooseBoxFolder) private var chooseBoxFolder
    @FocusState private var isFocused: Bool
    /// You've been in its pattern and left it: only then does an empty new one say it needs one
    /// (not while the cursor is on its way there).
    @State private var wasLeft = false

    /// What's wrong with it as typed.
    private var shownProblem: String? {
        let typed = PermissionRule(action: rule.action, resource: resource, effect: rule.effect)
        guard let problem = problem(typed) else { return nil }
        return resource.trimmingCharacters(in: .whitespaces).isEmpty && !(isNew && wasLeft && !isFocused) ? nil : problem
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                // A fixed width that long titles truncate in, so the patterns line up.
                Picker("Action", selection: Binding(get: { rule.action }, set: { change(PermissionRule(action: $0, resource: pattern, effect: rule.effect)) })) {
                    ForEach(actions, id: \.id) { Text($0.title).tag($0.id) }
                    if !actions.contains(where: { $0.id == rule.action }) { Text(rule.action).tag(rule.action) }
                }
                .labelsHidden()
                .frame(width: 190, alignment: .leading)
                TextField("Pattern", text: $resource, prompt: Text(prompt))
                    .labelsHidden()
                    .focused($isFocused)
                    .onSubmit(save)
                    .onChange(of: isFocused) {
                        if !isFocused {
                            wasLeft = true
                            save()
                        }
                    }
                    .onChange(of: resource) { typed(resource) }
                if !suggestions.isEmpty {
                    ChoicesMenu(title: "Common Patterns", help: "What this rule’s pattern can be") {
                        ForEach(suggestions) { suggestion in
                            if suggestion.isFolder {
                                Divider()
                                Button("Choose a Folder…", action: chooseFolder)
                            } else {
                                Button {
                                    pick(suggestion.pattern)
                                } label: {
                                    Text(suggestion.title)
                                    Text(suggestion.pattern)
                                }
                            }
                        }
                    }
                }
                Picker("Effect", selection: Binding(get: { rule.effect }, set: { change(PermissionRule(action: rule.action, resource: pattern, effect: $0)) })) {
                    ForEach(effects, id: \.self) { Text(Self.title(of: $0)).tag($0) }
                    if !effects.contains(rule.effect) { Text(Self.title(of: rule.effect)).tag(rule.effect) }
                }
                .labelsHidden()
                .frame(width: 120)
                Button {
                    // Drop what was typed first, so going away doesn't save it back.
                    resource = rule.resource
                    change(nil)
                } label: {
                    Image(systemName: "minus.circle.fill")
                }
                .buttonStyle(RemoveButtonStyle())
                .accessibilityLabel("Remove Rule")
                .help("Remove Rule")
            }
            if let shownProblem {
                Label {
                    Text(shownProblem)
                } icon: {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(.orange)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .labelStyle(.titleAndIcon)
                // Under the pattern's words.
                .padding(.leading, 198)
                .transition(.opacity)
            }
        }
        .onAppear {
            resource = rule.resource
            if focusesOnAppear { isFocused = true }
        }
        .onChange(of: rule.resource) { if rule.resource != resource { resource = rule.resource } }
        // Closing the page or switching tabs while typing keeps what you typed.
        .onDisappear(perform: save)
    }

    /// A pattern from the menu, in place of what's typed, saved as Return saves it.
    private func pick(_ pattern: String) {
        resource = pattern
        typed(pattern)
        save()
    }

    /// A folder on the computer, and what's in it: a machine's in its own folders' browser.
    private func chooseFolder() {
        if box.machine != nil {
            chooseBoxFolder? { path, home in pick(BoxPaths.setting(path, home: home) + "/*") }
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Choose"
        panel.message = "Choose the folder the rule is for."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        pick(BoxPaths.setting(url.path, home: NSHomeDirectory()) + "/*")
    }

    private func save() {
        if isNew { return commit() }
        let value = resource.trimmingCharacters(in: .whitespacesAndNewlines)
        let changed = PermissionRule(action: rule.action, resource: value, effect: rule.effect)
        // A saved rule keeps its pattern until the new one can be used.
        guard problem(changed) == nil else {
            resource = rule.resource
            return
        }
        guard value != rule.resource else { return }
        change(changed)
    }

    static func title(of effect: PermissionRule.Effect) -> String {
        effect.title
    }
}

/// Something a rule's pattern can be, as its menu offers it: a pattern with what it means, or a
/// folder to choose.
struct PatternSuggestion: Identifiable {
    let title: String
    let pattern: String
    var isFolder = false
    var id: String { isFolder ? "\u{1}folder" : pattern }

    init(_ title: String, _ pattern: String) {
        self.title = title
        self.pattern = pattern
    }

    static let folder: PatternSuggestion = {
        var folder = PatternSuggestion("Choose a Folder…", "")
        folder.isFolder = true
        return folder
    }()
}
