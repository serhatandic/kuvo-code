import OpenCodeKit
import SwiftUI

/// Slash commands: prompts you use often, run by typing "/" and their name in the composer.
struct CommandsSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Catalog.self) private var catalog
    @State private var editing: CommandEdit?
    /// What to remove once its sheet has closed (and its fields are done saving).
    @State private var removal: [String]?
    /// Claude Code's commands, to bring over.
    @State private var claudeCommands: [ClaudeCommands.Command] = []

    private var config: EngineConfig { app.config(for: box) }
    static let path = ["commands"]

    private var names: [String] { (config.value(at: Self.path)?.object?.keys).map { $0.sorted() } ?? [] }
    /// The engine's own, and ones from plugins and MCP servers.
    private var others: [Command] { catalog.commands.filter { !names.contains($0.name) } }

    /// The name a Claude Code command comes over as.
    private func importedName(_ command: ClaudeCommands.Command) -> String {
        ClaudeCommands.importedName(command, others: Set(others.map(\.name)))
    }

    var body: some View {
        ScrollingSettingsForm {
            Section {
                if names.isEmpty {
                    Text("None yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(names, id: \.self) { name in
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("/" + name)
                            if let description = config.value(at: Self.path + [name, "description"])?.string, !description.isEmpty {
                                Text(description)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                        Spacer()
                        Button("Edit…") { editing = CommandEdit(name: name) }
                    }
                }
                Button("New Command…") { editing = CommandEdit(name: nil) }
            } header: {
                Text("Your Commands")
            } footer: {
                Text("Type / and a command's name at the start of a message to run it. What you type after the name fills in $ARGUMENTS.")
                    .foregroundStyle(.secondary)
            }

            ConfigProblem()

            if !claudeCommands.isEmpty {
                Section {
                    ForEach(claudeCommands) { command in
                        let name = importedName(command)
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("/" + name)
                                if !command.description.isEmpty {
                                    Text(command.description)
                                        .font(.callout)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                            }
                            Spacer()
                            if config.value(at: Self.path + [name]) != nil {
                                Label("Imported", systemImage: "checkmark")
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            } else {
                                Button("Import") {
                                    config.set(command.settings, at: Self.path + [name])
                                    Analytics.shared.track("command_created", ["from": "claude"])
                                }
                            }
                        }
                    }
                } header: {
                    Text("From Claude Code")
                } footer: {
                    Text("Commands in ~/.claude/commands. Their prompts come over as they are.")
                        .foregroundStyle(.secondary)
                }
            }

            if !others.isEmpty {
                Section("Also Available") {
                    ForEach(others) { command in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("/" + command.name)
                            if let description = command.description {
                                // The engine's own read "guided AGENTS.md setup": a capital, like ours.
                                Text(description.prefix(1).uppercased() + description.dropFirst())
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .task { claudeCommands = await Task.detached { ClaudeCommands.load() }.value }
        .settingsDetail(item: $editing, title: { $0.name.map { "/" + $0 } ?? "New Command" }, onDismiss: removePending) { edit in
            CommandEditor(name: edit.name) { editing = nil } remove: { path in
                removal = path
                editing = nil
            }
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

private struct CommandEdit: Identifiable {
    /// Nil for a new one.
    var name: String?
    var id: String { name ?? "" }
}

/// One command's settings, in the page's place. A new one is named first; after that, changes
/// are saved as you make them.
private struct CommandEditor: View {
    /// Nil for a new one, until it's named.
    @State var name: String?
    let done: () -> Void
    /// Removes this entry, once it's closed.
    let remove: ([String]) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Catalog.self) private var catalog
    @State private var newName = ""
    @State private var confirmsRemoval = false

    private var config: EngineConfig { app.config(for: box) }
    private var title: String { name.map { "/" + $0 } ?? "New Command" }

    /// The name you typed, without spaces around it or a "/" in front.
    private var typedName: String {
        newName.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    /// The name you typed, as a command's: hyphens for spaces, and only letters, digits,
    /// hyphens and underscores.
    private var newID: String {
        typedName.replacingOccurrences(of: " ", with: "-")
            .filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }

    /// Why the name you typed can't be used, if it can't.
    private var problem: String? {
        // Nothing would be written: what you fill in would be lost.
        if let broken = config.problem { return "The engine's settings file can't be changed here: \(broken)" }
        if newID.isEmpty {
            return typedName.isEmpty ? nil : "A name needs a letter or a number."
        }
        // Not one you have already, or one the engine or a server has.
        let isTaken = config.value(at: CommandsSettings.path + [newID]) != nil || catalog.commands.contains(where: { $0.name == newID })
        return isTaken ? "There's a command called /\(newID) already." : nil
    }

    var body: some View {
        SettingsDetailPage {
            if let name {
                editor(name)
            } else {
                naming
            }
        } footer: {
            SettingsEditorButtons(create: name == nil ? "Create Command" : nil, canCreate: !newID.isEmpty && problem == nil, onCreate: create,
                                  remove: "Delete Command…", onRemove: { confirmsRemoval = true }, done: done)
        }
        .settingsDetailTitle(title)
        .confirmationDialog("Delete \(title)?", isPresented: $confirmsRemoval) {
            Button("Delete", role: .destructive) {
                if let name { remove(CommandsSettings.path + [name]) }
            }
        } message: {
            Text("It's removed from the engine's settings.")
        }
    }

    /// A new command's name, before anything is written: what's wrong with it, or what it'll
    /// be called when that isn't quite what you typed.
    private var naming: some View {
        Section {
            SettingsTextRow(title: "Name") {
                TextField("Name", text: $newName, prompt: Text("test"))
                    .onSubmit(create)
            }
        } footer: {
            if let problem {
                Text(problem).foregroundStyle(.red)
            } else if !newID.isEmpty, newID != typedName {
                Text(verbatim: "It'll be called /\(newID).").foregroundStyle(.secondary)
            } else {
                Text("A short name without spaces: you'll type / and this name.").foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func editor(_ name: String) -> some View {
        let path = CommandsSettings.path + [name]
        Group {
            Section {
                ConfigTextField(title: "Description", path: path + ["description"], prompt: "Shown in the list when you type /", multiline: true)
                Picker("Agent", selection: config.string(path + ["agent"])) {
                    Text("The session's agent").tag(String?.none)
                    ForEach(catalog.agents.filter { !$0.hidden }) { Text($0.name).tag(Optional($0.id)) }
                }
                ConfigModelPicker(title: "Model", path: path + ["model"], defaultTitle: "The agent's or session's model")
                Toggle(isOn: Binding(
                    get: { config.value(at: path + ["subagent"])?.bool == true },
                    set: { config.set($0 ? .bool(true) : nil, at: path + ["subagent"]) }
                )) {
                    Text("Run as a subagent")
                    Text("In the background, without filling up the conversation.")
                }
            }
            Section {
                ConfigTextEditor(path: path + ["template"], minHeight: 180)
            } header: {
                Text("Prompt")
            } footer: {
                // Verbatim: as Markdown, the backticks would be taken for code and vanish.
                Text(verbatim: "What the agent gets. $ARGUMENTS is what you type after the command; $1, $2 and so on are its words. !`command` puts in a command's output.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func create() {
        guard !newID.isEmpty, problem == nil else { return }
        config.set(.object(["template": .string("")]), at: CommandsSettings.path + [newID])
        name = newID
    }
}
