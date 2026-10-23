import OpenCodeKit
import SwiftUI

/// The engine: how it's doing, and how it works: summaries, formatting, the shell, web search,
/// limits, files it ignores, plugins, and its settings file.
struct EngineSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @State private var shells: [ShellOption] = []
    @State private var searchProviders: [WebSearchProvider] = []
    @State private var plugins: [PluginInfo] = []
    /// A search service's key, while it's being added.
    @State private var addingKey: IntegrationRef?
    @Environment(Catalog.self) private var catalog

    private var config: EngineConfig { app.config(for: box) }
    /// The machine's, on a machine's tab.
    private var machine: MachineEngine? { app.machines.engine(box.machine) }
    /// Its engine is running and answering, here or there.
    private var isReady: Bool { app.isReady(box) }

    var body: some View {
        ScrollingSettingsForm {
            Section {
                LabeledContent("Engine", value: "opencode \(machine?.engineVersion ?? OpenCodeEngine.version)")
                // The dot carries the color; the words stay readable.
                LabeledContent("Status") {
                    HStack(spacing: 12) {
                        if let machine {
                            MachineStatus(engine: machine)
                                .fixedSize()
                            switch machine.state {
                            case .ready: Button("Restart") { app.restartEngine(machine) }
                            case .preparing where machine.isStopped: Button("Start") { app.startEngine(machine) }
                            case .failed, .preparing: Button("Connect") { app.connect(machine) }
                            default: EmptyView()
                            }
                        } else {
                            switch app.engine {
                            case .ready: StatusText(app.isLive ? "Running" : "Reconnecting", color: app.isLive ? .green : .orange)
                            case .failed: StatusText("Stopped", color: .red)
                            default: Text("Starting…")
                            }
                            Button("Restart") { Task { await app.restart() } }
                        }
                    }
                }
                if let machine {
                    LabeledContent("Data folder", value: "~/\(RemoteEngineInstaller.root) on \(machine.machine.name)")
                } else {
                    LabeledContent("Data folder") {
                        Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([AppInfo.supportDirectory]) }
                    }
                }
            } footer: {
                Text("Sessions, accounts and settings are kept in the data folder, separate from any opencode you have installed.")
                    .foregroundStyle(.secondary)
            }

            ConfigProblem()
            Section("Behavior") {
                Toggle(isOn: config.bool(["compaction", "auto"], default: true)) {
                    Text("Summarize long conversations automatically")
                    Text("Before the context window fills up, older messages are replaced by a summary.")
                }
                // Formatters set up by hand (an object) aren't this toggle's to replace.
                let customFormatters = config.value(at: ["formatter"])?.object != nil
                Toggle(isOn: customFormatters ? .constant(true) : config.bool(["formatter"], default: false)) {
                    Text("Format files after the agent changes them")
                    Text(customFormatters
                        ? "With the formatters set up in the settings file."
                        : "With the formatters the engine knows, such as Prettier, gofmt or rustfmt, when the project has them.")
                }
                .disabled(customFormatters)
                // Warming set up by hand (an object) isn't this switch's to replace.
                let customWarming = config.value(at: ["warming"])?.object != nil
                Toggle(isOn: customWarming ? .constant(true) : config.bool(["warming"], default: false)) {
                    Text("Keep recent sessions warm")
                    Text(customWarming
                        ? "As set up in the settings file."
                        : "Sends a small request every few minutes so the model's cache stays ready. Uses a little of your quota.")
                }
                .disabled(customWarming)
                Toggle(isOn: config.bool(["snapshots"], default: true)) {
                    Text("Keep snapshots of files")
                    Text("Undo From Here needs them to put files back.")
                }
                Picker("Shell", selection: config.string(["shell"])) {
                    Text("Your login shell").tag(String?.none)
                    ForEach(shells.filter(\.acceptable)) { shell in
                        Text("\(shell.name) (\(shell.path))").tag(Optional(shell.path))
                    }
                }
                Picker("Subagents can start subagents", selection: Binding(
                    get: { config.value(at: ["experimental", "subagent_depth"])?.int ?? 1 },
                    set: { config.set($0 == 1 ? nil : .number(Double($0)), at: ["experimental", "subagent_depth"]) }
                )) {
                    Text("No").tag(1)
                    ForEach(2...5, id: \.self) { Text("Up to \($0) levels").tag($0) }
                }
            }

            Section {
                Picker("Search service", selection: Binding<String>(
                    get: {
                        guard let value = config.value(at: ["websearch"]) else { return "" }
                        if value.bool == false { return "off" }
                        return value["provider"]?.string ?? ""
                    },
                    set: { choice in
                        switch choice {
                        case "": config.set(nil, at: ["websearch"])
                        case "off": config.set(.bool(false), at: ["websearch"])
                        default: config.set(.object(["provider": .string(choice)]), at: ["websearch"])
                        }
                    }
                )) {
                    Text("None").tag("")
                    Text("Any service").tag("random")
                    ForEach(searchProviders) { Text($0.name).tag($0.id) }
                    Divider()
                    Text("Off").tag("off")
                }
                // The chosen service's key, or every service's when any one will do.
                ForEach(keyedServices) { integration in
                    LabeledContent("\(integration.name) API key") {
                        let credentials = integration.connections.filter { $0.type == "credential" }.compactMap(\.credentialID)
                        if !credentials.isEmpty {
                            HStack(spacing: 12) {
                                Text("Added").foregroundStyle(.secondary)
                                Button("Remove") { removeKeys(credentials, of: integration.id) }
                            }
                        } else if let variable = integration.connections.first(where: { $0.type == "env" }) {
                            // From the environment: nothing here to change.
                            Text("From \(variable.name ?? "the environment")").foregroundStyle(.secondary)
                        } else {
                            Button("Add API Key…") { addingKey = IntegrationRef(id: integration.id) }
                        }
                    }
                }
            } header: {
                Text("Web Search")
            } footer: {
                Text("Some services need an API key; others search without one. With none chosen, the agent can't search the web.")
                    .foregroundStyle(.secondary)
            }

            Section("Limits") {
                ConfigNumberField(title: "Lines of tool output the agent keeps", path: ["tool_output", "max_lines"])
                ConfigNumberField(title: "Bytes of tool output the agent keeps", path: ["tool_output", "max_bytes"])
                Toggle("Shrink large images the agent reads", isOn: config.bool(["media", "image", "auto_resize"], default: true))
                ConfigNumberField(title: "Largest image width, in pixels", path: ["media", "image", "max_width"])
                ConfigNumberField(title: "Largest image height, in pixels", path: ["media", "image", "max_height"])
            }

            Section {
                ConfigStringList(path: ["watcher", "ignore"], prompt: "A pattern, like dist/** or *.log")
            } header: {
                Text("Files the Engine Doesn't Watch")
            } footer: {
                Text("Changes to these don't reach the agent while it works.")
                    .foregroundStyle(.secondary)
            }

            Section {
                ConfigStringList(path: ["plugins"], prompt: "An npm package, like opencode-wakatime")
                ForEach(plugins.filter { $0.source.type != "builtin" && $0.state.status == "failed" }) { plugin in
                    Label("\(plugin.id): \(plugin.state.error ?? "didn't load")", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            } header: {
                Text("Plugins")
            } footer: {
                Text(box.machine == nil
                    ? "Plugins add tools and change how the engine works. They run code on your Mac, so add only ones you trust."
                    : "Plugins add tools and change how the engine works. They run code on \(app.name(of: box)), so add only ones you trust.")
                    .foregroundStyle(.secondary)
            }

            Section {
                if let machine {
                    LabeledContent("Settings file", value: "~/\(RemoteEngineInstaller.root)/box/opencode.json on \(machine.machine.name)")
                        .textSelection(.enabled)
                } else {
                    LabeledContent("Settings file") {
                        HStack {
                            Button("Open") { NSWorkspace.shared.open(config.file) }
                                .disabled(!FileManager.default.fileExists(atPath: config.file.path))
                            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([config.file]) }
                                .disabled(!FileManager.default.fileExists(atPath: config.file.path))
                        }
                    }
                }
            } footer: {
                Text("Everything in Settings is saved in this file, in opencode's format, and the engine picks up changes as you make them. A project's own opencode.json takes precedence for that project.")
                    .foregroundStyle(.secondary)
            }
        }
        .settingsDetail(item: $addingKey, title: { _ in nil }) { ref in
            ConnectDetail(integrationID: ref.id, note: "The agent can search the web with it now.") { addingKey = nil }
        }
        // Again once the engine is ready: opened while it starts, or after Restart.
        .task(id: isReady) {
            guard let api = app.api(for: box) else { return }
            shells = (try? await api.shells()) ?? []
            searchProviders = (try? await api.webSearchProviders()) ?? []
            plugins = (try? await api.plugins()) ?? []
        }
    }

    /// The search services whose keys to show: the chosen one, or all of them for "Any
    /// connected service", so there's somewhere to add one.
    private var keyedServices: [Integration] {
        guard let chosen = config.value(at: ["websearch", "provider"])?.string else { return [] }
        let ids = chosen == "random" ? searchProviders.map(\.id) : [chosen]
        return ids.compactMap { id in catalog.integrations.first { $0.id == id } }
    }

    /// Removes a service's stored keys from this computer's engine, so a wrong one can be added
    /// again.
    private func removeKeys(_ ids: [String], of integration: String) {
        guard let api = app.api(for: box) else { return }
        Task {
            for id in ids { try? await api.removeCredential(id) }
            app.forgetSignIn(integration, on: box)
            await catalog.refresh()
        }
    }
}

/// The engine's state: a colored dot, and the words in the usual ink.
private struct StatusText: View {
    let title: String
    let color: Color

    init(_ title: String, color: Color) {
        self.title = title
        self.color = color
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(title)
        }
    }
}
