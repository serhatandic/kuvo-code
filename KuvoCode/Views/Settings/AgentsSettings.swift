import OpenCodeKit
import SwiftUI

/// The agents: the defaults new sessions start with, the built-in agents (Build, Plan and the
/// subagents), and your own, each with its instructions, model and permissions.
struct AgentsSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Catalog.self) private var catalog
    @State private var editing: AgentEdit?
    /// What to remove once its sheet has closed (and its fields are done saving).
    @State private var removal: [String]?
    /// Claude Code's agents, to bring over.
    @State private var claudeAgents: [ClaudeAgents.Agent] = []

    private var config: EngineConfig { app.config(for: box) }

    /// The engine's own agents that people see; the hidden ones (titles, summaries) aren't
    /// listed, but their models can be set above.
    static let builtIn = BuiltInAgents.shown
    static let hiddenBuiltIn = BuiltInAgents.hidden

    /// Built-in ones first, then yours: from the engine's list and from the settings (one
    /// that's turned off is only there).
    private var agents: [(id: String, name: String, mode: String, description: String?, isBuiltIn: Bool, isOff: Bool)] {
        let configured = config.value(at: ["agents"])?.object ?? [:]
        var rows: [(id: String, name: String, mode: String, description: String?, isBuiltIn: Bool, isOff: Bool)] = []
        for id in Self.builtIn + configured.keys.sorted() where !rows.contains(where: { $0.id == id }) && !Self.hiddenBuiltIn.contains(id) {
            let live = catalog.agents.first { $0.id == id }
            let settings = configured[id]
            rows.append((
                id,
                live?.name ?? id,
                settings?["mode"]?.string ?? live?.mode ?? "primary",
                settings?["description"]?.string ?? live?.description,
                Self.builtIn.contains(id),
                settings?["disabled"]?.bool == true
            ))
        }
        return rows
    }

    var body: some View {
        ScrollingSettingsForm {
            Section {
                Picker("Mode for new sessions", selection: config.string(["default_agent"])) {
                    Text("Build").tag(String?.none)
                    ForEach(catalog.primaryAgents.filter { $0.id != "build" }) { Text($0.name).tag(Optional($0.id)) }
                }
                ConfigModelPicker(title: "Model for new sessions", path: ["model"], defaultTitle: "The engine's choice")
                ConfigModelPicker(title: "Model for session titles", path: ["agents", "title", "model"], defaultTitle: "The session's model")
            } footer: {
                Text("New sessions use the model you picked last; this one is for when there's none. A small, fast model is enough for titles.")
                    .foregroundStyle(.secondary)
            }

            ConfigProblem()

            Section {
                ForEach(agents, id: \.id) { agent in
                    SettingsRowLayout {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(agent.name)
                                Text(Self.modeTitle(agent.mode))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                if agent.isOff {
                                    Text("Off").font(.subheadline).foregroundStyle(.orange)
                                }
                            }
                            if let description = agent.description, !description.isEmpty {
                                Text(description)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                                    .help(description)
                            }
                        }
                        .settingsText()
                        Button("Edit…") { editing = AgentEdit(agentID: agent.id, isBuiltIn: agent.isBuiltIn) }
                    }
                }
                Button("New Agent…") { editing = AgentEdit(agentID: nil) }
            } header: {
                Text("Agents")
            } footer: {
                Text("Modes are the agents you pick in the composer. Subagents are ones the agent hands part of a task to.")
                    .foregroundStyle(.secondary)
            }

            if !claudeAgents.isEmpty {
                Section {
                    ForEach(claudeAgents) { agent in
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(agent.name)
                                if !agent.description.isEmpty {
                                    Text(agent.description)
                                        .font(.callout)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                            }
                            Spacer()
                            if config.value(at: ["agents", agent.id]) != nil {
                                Label("Imported", systemImage: "checkmark")
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            } else {
                                Button("Import") { importAgent(agent) }
                            }
                        }
                    }
                } header: {
                    Text("From Claude Code")
                } footer: {
                    Text("Agents in ~/.claude/agents, brought over as subagents with their description and instructions. They use the session's model and the permissions here, not the tools and model Claude Code gives them.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .task { claudeAgents = await Task.detached { ClaudeAgents.load() }.value }
        .settingsDetail(item: $editing, title: { $0.agentID ?? "New Agent" }, onDismiss: removePending) { edit in
            AgentEditor(id: edit.agentID, isBuiltIn: edit.isBuiltIn) { editing = nil } remove: { path in
                removal = path
                editing = nil
            }
        }
    }

    private func importAgent(_ agent: ClaudeAgents.Agent) {
        config.set(agent.settings, at: ["agents", agent.id])
        Analytics.shared.track("agent_created", ["from": "claude"])
    }

    static func modeTitle(_ mode: String) -> String {
        switch mode {
        case "subagent": "Subagent"
        case "all": "Mode and subagent"
        default: "Mode"
        }
    }

    private func removePending() {
        guard let removal else { return }
        self.removal = nil
        // Once the closing editor's fields have saved what you typed last, or they'd write it
        // back into a half-made entry.
        let config = app.config(for: box)
        DispatchQueue.main.async { config.set(nil, at: removal) }
    }
}

private struct AgentEdit: Identifiable {
    /// Nil for a new one.
    var agentID: String?
    var isBuiltIn = false

    var id: String { agentID ?? "" }
}

/// One agent's settings, in the page's place. A new one is filled in on one page and made with
/// Create (until then it's a draft that isn't written anywhere); an existing one is saved as you
/// change it.
private struct AgentEditor: View {
    /// Nil for a new one.
    let id: String?
    let isBuiltIn: Bool
    let done: () -> Void
    /// Removes this entry, once it's closed.
    let remove: ([String]) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Catalog.self) private var catalog
    @State private var newName = ""
    @State private var confirmsRemoval = false
    /// A new one's settings, as they're filled in.
    @State private var draft: EngineConfig?

    /// Where a new one's settings are in its draft.
    private static let draftPath = ["agents", "new"]

    init(id: String?, isBuiltIn: Bool, done: @escaping () -> Void, remove: @escaping ([String]) -> Void) {
        self.id = id
        self.isBuiltIn = isBuiltIn
        self.done = done
        self.remove = remove
        _draft = State(initialValue: id == nil ? EngineConfig(draft: ["agents": .object(["new": .object(["mode": .string("primary")])])]) : nil)
    }

    private var config: EngineConfig { draft ?? app.config(for: box) }
    private var path: [String] { id.map { ["agents", $0] } ?? Self.draftPath }

    private var name: String {
        guard let id else { return newName.trimmingCharacters(in: .whitespaces).isEmpty ? "New Agent" : newName.trimmingCharacters(in: .whitespaces) }
        return catalog.agents.first { $0.id == id }?.name ?? id
    }

    /// The name you typed, as the agent is called: as you wrote it, with one space between words,
    /// and only letters, digits, spaces, hyphens and underscores (the engine takes it as it is, as
    /// a mode and a subagent).
    private var newID: String {
        newName.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == " " }
            .split(separator: " ").joined(separator: " ")
    }

    /// Why the name you typed can't be used, if it can't.
    private var problem: String? {
        // Nothing would be written: the instructions you write would be lost.
        if let broken = app.config(for: box).problem { return "The engine's settings file can't be changed here: \(broken)" }
        if newID.isEmpty {
            return newName.trimmingCharacters(in: .whitespaces).isEmpty ? nil : "A name needs a letter or a number."
        }
        // Not one the engine already has: that would change it instead.
        // Bug Hunter and bug hunter would be told apart only by their case.
        let name = newID.lowercased()
        let configured = (app.config(for: box).value(at: ["agents"])?.object ?? [:]).keys
        let isTaken = configured.contains { $0.lowercased() == name } || catalog.agents.contains { $0.id.lowercased() == name || $0.name.lowercased() == name }
            || AgentsSettings.builtIn.contains(name) || AgentsSettings.hiddenBuiltIn.contains(name)
        return isTaken ? "There's an agent called \(newID) already." : nil
    }

    /// The rules added on a new one's page that aren't saved into it yet (the cursor is still in
    /// one), which Create takes too; one left without a pattern is no rule, and isn't.
    private var pendingRules: [PermissionRule] {
        (draft?.items([RulesEditor.pendingKey] + Self.draftPath + ["permissions"]).compactMap(\.rule) ?? [])
            .filter { !$0.resource.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    /// A rule written in a way that can't be made (* for a kind of action with its choice above)
    /// keeps the agent from being created; it says why under it.
    private var rulesProblem: Bool {
        pendingRules.contains { RulesEditor.problem(of: $0, hiding: Set(PermissionsSettings.actions.map(\.id))) != nil }
    }

    private var mode: String {
        config.value(at: path + ["mode"])?.string ?? id.flatMap { id in catalog.agents.first { $0.id == id }?.mode } ?? "primary"
    }

    var body: some View {
        SettingsDetailPage {
            Group {
                if id == nil { naming }
                editor
            }
            .environment(\.editedConfig, draft)
        } footer: {
            SettingsEditorButtons(create: id == nil ? "Create Agent" : nil, canCreate: !newID.isEmpty && problem == nil && !rulesProblem, onCreate: create,
                                  remove: id.flatMap { app.config(for: box).value(at: ["agents", $0]) } != nil ? (isBuiltIn ? "Reset to Built-In…" : "Delete Agent…") : nil,
                                  onRemove: { confirmsRemoval = true }, done: done)
        }
        .settingsDetailTitle(name)
        .confirmationDialog(isBuiltIn ? "Reset \(name) to how it's built in?" : "Delete \(name)?", isPresented: $confirmsRemoval) {
            Button(isBuiltIn ? "Reset" : "Delete", role: .destructive) {
                if let id { remove(["agents", id]) }
            }
        } message: {
            Text(isBuiltIn ? "Your changes to it are removed." : "It's removed from the engine's settings.")
        }
    }

    /// A new agent's name: what's wrong with it, or what it'll be called when that isn't quite
    /// what you typed.
    private var naming: some View {
        Section {
            SettingsTextRow(title: "Name") { TextField("Name", text: $newName, prompt: Text("Bug Hunter")) }
        } footer: {
            if let problem {
                Text(problem).foregroundStyle(.red)
            } else if !newID.isEmpty, newID != newName.trimmingCharacters(in: .whitespaces) {
                Text(verbatim: "It'll be called \(newID).").foregroundStyle(.secondary)
            } else {
                Text("How it shows in the composer, and how other agents ask for it.").foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var editor: some View {
        // A built-in agent's own description, shown until you write another.
        let builtInDescription = isBuiltIn ? id.flatMap { id in catalog.agents.first(where: { $0.id == id })?.description } : nil
        Section {
            Picker("Use as", selection: Binding(get: { mode }, set: { config.set(.string($0), at: path + ["mode"]) })) {
                ForEach(["primary", "subagent", "all"], id: \.self) { mode in
                    Text(AgentsSettings.modeTitle(mode)).tag(mode)
                }
            }
            ConfigTextField(title: "Description", path: path + ["description"], prompt: builtInDescription ?? "What it's for, like: Finds bugs and explains them, without changing code", multiline: true)
            ConfigModelPicker(title: "Model", path: path + ["model"], defaultTitle: "The session's model")
            ConfigNumberField(title: "Most steps per message", path: path + ["steps"], prompt: "No limit")
            if id != nil {
                Toggle("Use this agent", isOn: Binding(
                    get: { config.value(at: path + ["disabled"])?.bool != true },
                    set: { config.set($0 ? nil : .bool(true), at: path + ["disabled"]) }
                ))
            }
        } footer: {
            Text(Self.modeDetail(mode))
                .foregroundStyle(.secondary)
        }
        Section {
            ConfigTextEditor(path: path + ["system"], prompt: isBuiltIn ? "" : "How it works: what to look for, what to leave alone, how to report back.")
        } header: {
            Text("Instructions")
        } footer: {
            Text(isBuiltIn
                ? "Leave empty to keep the built-in instructions. Anything here replaces them; the project's AGENTS.md, skills and MCP servers still apply."
                : "The project's AGENTS.md, skills and MCP servers apply too.")
                .foregroundStyle(.secondary)
        }
        Section {
            ActionChoices(path: path + ["permissions"], agent: id)
        } header: {
            Text("What It May Do")
        } footer: {
            Text(isBuiltIn
                ? "Default keeps how it's built in and what Settings › Permissions says. A choice here wins over Settings › Permissions for this agent."
                : "Default does what Settings › Permissions says. A choice here wins over it for this agent.")
                .foregroundStyle(.secondary)
        }
        Section {
            RulesEditor(path: path + ["permissions"], hiding: Set(PermissionsSettings.actions.map(\.id)))
        } header: {
            Text("Rules")
        } footer: {
            // Verbatim: as Markdown, the asterisks would turn part of the sentence into italics.
            Text(verbatim: "For particular commands, files or sites, like letting it run \"npm test *\" while other commands ask first. * matches anything. When rules overlap, the one lower in the list wins.")
                .foregroundStyle(.secondary)
        }
    }

    /// What picking it as a mode, a subagent or both means.
    static func modeDetail(_ mode: String) -> String {
        switch mode {
        case "subagent": "Other agents hand it part of their work; its description tells them when."
        case "all": "You can pick it in the composer, and other agents can hand it part of their work."
        default: "You pick it in the composer, as you pick Build or Plan."
        }
    }

    /// Writes the new agent as filled in, and goes back to the list.
    private func create() {
        guard let draft, !newID.isEmpty, problem == nil else { return }
        var agent = draft.value(at: Self.draftPath)?.object ?? [:]
        if agent["mode"] == nil { agent["mode"] = .string("primary") }
        // With the rules still being typed, and each pattern without spaces around it.
        let rules = (draft.items(Self.draftPath + ["permissions"]).compactMap(\.rule) + pendingRules).map {
            PermissionRule(action: $0.action, resource: $0.resource.trimmingCharacters(in: .whitespacesAndNewlines), effect: $0.effect).json
        }
        agent["permissions"] = rules.isEmpty ? nil : .array(rules)
        app.config(for: box).set(.object(agent), at: ["agents", newID])
        Analytics.shared.track("agent_created")
        done()
    }
}
