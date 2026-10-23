import OpenCodeKit
import SwiftUI

/// MCP servers: programs on this Mac or services on the web that give the agent more tools.
/// Each can be turned off, connected again, or signed in to.
struct MCPSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @State private var live: [MCPServer] = []
    @State private var editing: ServerEdit?
    /// What to remove once its sheet has closed (and its fields are done saving).
    @State private var removal: [String]?
    /// A server's sign-in, while it's open.
    @State private var signingIn: IntegrationRef?

    private var config: EngineConfig { app.config(for: box) }
    static let path = ["mcp", "servers"]
    /// The app's own browser tools: not yours to change.
    static let builtIn: Set = ["kuvo-browser"]

    /// Servers start with their tools as plain tools, as integrations' do: the agent sees each one,
    /// where behind Code Mode a smaller model often doesn't find them. One that never had a say
    /// (added before, from the catalog or opencode's settings, or in the file) gets the same; one
    /// you turned Code Mode on for keeps it.
    @MainActor static func upgrade(_ config: EngineConfig) {
        guard case .object(let servers) = config.value(at: path) else { return }
        let changes: [(path: [String], value: JSONValue?)] = servers.compactMap { id, server in
            guard !builtIn.contains(id), case .object(let settings) = server, settings["codemode"] == nil else { return nil }
            return (path + [id, "codemode"], .bool(false))
        }
        if !changes.isEmpty { config.set(changes, noted: false) }
    }

    /// Your servers: not Kuvo Code's own, nor integrations', which their page adds and removes
    /// (with their keys and sign-ins, which removing one here would leave), where it has one.
    private var names: [String] {
        let configured = config.value(at: Self.path)?.object?.keys.map { $0 } ?? []
        return Set(configured + live.map(\.name)).subtracting(Self.builtIn).filter { !integrationsHere || Integrations.service($0) == nil }.sorted()
    }

    /// This computer has an Integrations page, which keeps integrations' servers.
    private var integrationsHere: Bool { SettingsPage.integrations.isShown(on: box) }

    /// The popular servers that run here: on a machine, not those only a Mac can run.
    private var popular: [MCPCatalog.Server] {
        box.machine == nil ? MCPCatalog.servers : MCPCatalog.servers.filter { !MCPCatalog.macOnly.contains($0.id) }
    }

    var body: some View {
        ScrollingSettingsForm {
            Section {
                if names.isEmpty {
                    Text("None yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(names, id: \.self) { name in
                    row(name)
                }
                Button("Add Server…") { editing = ServerEdit(name: nil) }
            } header: {
                Text("Servers")
            } footer: {
                Text("A server on \(box.machine == nil ? "this Mac" : app.name(of: box)) runs a command; one on the web is a URL.")
                    .foregroundStyle(.secondary)
            }

            ConfigProblem()

            Section {
                ForEach(popular) { server in
                    SettingsRowLayout {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(server.title)  \(Text(server.access.title).font(.subheadline).foregroundStyle(.secondary))")
                            Text(server.summary)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                        .settingsText()
                        Group {
                        if config.value(at: Self.path + [server.id]) != nil, integrationsHere, Integrations.service(server.id) != nil {
                            // Added as an integration: kept on that page, not in Servers above.
                            Button("In Integrations…") { app.settingsTabs.show(.integrations, on: box) }
                                .help("Added from Integrations, where it's kept with its sign-in")
                        } else if config.value(at: Self.path + [server.id]) != nil {
                            Label("Added", systemImage: "checkmark")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        } else {
                            Button("Add") { MCPCatalog.add(server, to: config) }
                                .accessibilityLabel("Add \(server.title)")
                        }
                        }
                    }
                }
            } header: {
                Text("Popular Servers")
            } footer: {
                Text("Each from the company behind it, as listed in the official MCP Registry. One that needs an account asks you to sign in here once it's added.")
                    .foregroundStyle(.secondary)
            }

            Section {
                ConfigNumberField(title: "Time to start, in milliseconds", path: ["mcp", "timeout", "startup"], prompt: "30000")
                ConfigNumberField(title: "Time to list tools, in milliseconds", path: ["mcp", "timeout", "catalog"], prompt: "30000")
                ConfigNumberField(title: "Time for one tool call, in milliseconds", path: ["mcp", "timeout", "execution"], prompt: "43200000")
            } header: {
                Text("Timeouts")
            } footer: {
                Text("For every server, unless one sets its own.")
                    .foregroundStyle(.secondary)
            }
        }
        .modifier(LiveMCPServers(servers: $live, api: { app.api(for: box) }, change: config.settings))
        #if DEBUG
        // KUVO_DEMO_MCP_SERVER=<name>[|web]: that server's editor, open (added, off, if it isn't
        // there); `web`: switched to On the web.
        .onAppear {
            guard let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_MCP_SERVER"], let name = demo.split(separator: "|").first.map(String.init) else { return }
            if config.value(at: Self.path + [name]) == nil {
                config.set(.object(["type": .string("local"), "command": .array([]), "disabled": .bool(true), "codemode": .bool(false)]), at: Self.path + [name])
            }
            editing = ServerEdit(name: name)
        }
        #endif
        .settingsDetail(item: $editing, title: { $0.name ?? "Add Server" }, onDismiss: removePending) { edit in
            ServerEditor(name: edit.name, taken: Set(live.map(\.name))) { editing = nil } remove: { path in
                removal = path
                editing = nil
            }
        }
        .settingsDetail(item: $signingIn, title: { _ in nil }) { ref in
            ConnectDetail(integrationID: ref.id, name: ref.service?.title, symbol: ref.service?.symbol, note: "The agent can use its tools now.") {
                signingIn = nil
                Task {
                    if let api = app.api(for: box) { for server in live where server.integrationID == ref.id { await app.reconnect(server.name, api: api, machine: box.machine) } }
                    await refresh()
                }
            }
        }
    }

    private func row(_ name: String) -> some View {
        let settings = config.value(at: Self.path + [name])
        let status = live.first { $0.name == name }?.status
        let isOn = settings?["disabled"]?.bool != true
        return HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(name)
                    StatusLabel(status: status, isOn: isOn)
                }
                if let detail = Self.detail(of: settings) {
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if let error = status?.error, !error.isEmpty {
                    Text(error)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .textSelection(.enabled)
                        .help(error)
                }
            }
            Spacer()
            // Centered on each other, so the switch sits level with the buttons rather than on
            // their text's baseline; the buttons line up with the name. The switch is last, at
            // the edge, as in the other tabs.
            HStack {
                if isOn, let server = live.first(where: { $0.name == name }), server.status.status == "needs_auth", let integrationID = server.integrationID {
                    // Signing in goes through the server's sign-in, as an account does.
                    Button("Sign In…") { signingIn = IntegrationRef(id: integrationID, service: Integrations.service(name)) }
                } else if isOn, status?.status == "failed" {
                    Button("Try Again") {
                        Task {
                            if let api = app.api(for: box) { await app.reconnect(name, api: api, machine: box.machine) }
                            await refresh()
                        }
                    }
                }
                if settings != nil {
                    Button("Edit…") { editing = ServerEdit(name: name) }
                    Toggle("Turn on \(name)", isOn: Binding(
                        get: { isOn },
                        set: { config.set($0 ? nil : .bool(true), at: Self.path + [name, "disabled"]) }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
                }
            }
        }
    }

    /// The command it runs, or its URL.
    static func detail(of settings: JSONValue?) -> String? {
        if let url = settings?["url"]?.string { return url }
        if let command = settings?["command"]?.array?.compactMap(\.string), !command.isEmpty { return command.joined(separator: " ") }
        return nil
    }

    private func refresh() async {
        live = await MCPStatus.read(app.api(for: box)) ?? []
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

private struct ServerEdit: Identifiable {
    /// Nil for a new one.
    var name: String?
    var id: String { name ?? "" }
}

private struct StatusLabel: View {
    let status: MCPServer.Status?
    let isOn: Bool

    var body: some View {
        let (title, color): (String, Color) = switch (isOn, status?.status) {
        case (false, _): ("Off", .secondary)
        case (_, "connected"): ("Connected", .green)
        case (_, "pending"): ("Connecting…", .secondary)
        case (_, "needs_auth"): ("Needs sign-in", .orange)
        case (_, "failed"): ("Couldn't connect", .red)
        case (_, "disabled"): ("Off", .secondary)
        default: ("Not started", .secondary)
        }
        return Text(title)
            .font(.subheadline)
            .foregroundStyle(color)
    }
}

/// One server's settings, in the page's place. A new one is named first; after that, changes
/// are saved as you make them.
private struct ServerEditor: View {
    /// Nil for a new one, until it's named.
    @State var name: String?
    /// The servers the engine has, from anywhere: a new one can't take their names.
    let taken: Set<String>
    let done: () -> Void
    /// Removes this entry, once it's closed.
    let remove: ([String]) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @State private var newName = ""
    @State private var command = ""
    /// The command as shown, to tell whether you changed it.
    @State private var shownCommand = ""
    /// What the kind you switched away from had (its command or URL and the rest, and whether
    /// it was on), to bring back if you switch back while this is open.
    @State private var putAside: [String: JSONValue] = [:]
    @State private var confirmsRemoval = false
    /// "On the web" chosen for a server with no URL yet: nothing's written until you give one.
    @State private var pendingRemote = false
    @State private var pendingURL = ""

    private var config: EngineConfig { app.config(for: box) }
    /// Under headers and environment variables alike.
    private static var keyNote: some View {
        Text("To keep a key out of the settings file, write {env:NAME} to use one of your environment variables.")
            .foregroundStyle(.secondary)
    }

    /// The name you typed, as a server's: hyphens for spaces, and only letters, digits,
    /// hyphens and underscores.
    private var newID: String {
        newName.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " ", with: "-")
            .filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }

    /// Why the name you typed can't be used, if it can't.
    private var problem: String? {
        // Nothing would be written: what you fill in would be lost.
        if let broken = app.config(for: box).problem { return "The engine's settings file can't be changed here: \(broken)" }
        if newID.isEmpty {
            return newName.trimmingCharacters(in: .whitespaces).isEmpty ? nil : "A name needs a letter or a number."
        }
        if MCPSettings.builtIn.contains(newID) { return "Kuvo Code uses that name for its own tools." }
        // Integrations know theirs by name: one of yours by that name would show as it there,
        // and removing that integration would remove it.
        if let service = Integrations.service(newID) { return "\(service.title) uses that name: add it in Integrations, or pick another name." }
        let isTaken = config.value(at: MCPSettings.path + [newID]) != nil || taken.contains(newID)
        return isTaken ? "There's a server called \(newID) already." : nil
    }

    var body: some View {
        SettingsDetailPage {
            if let name {
                editor(MCPSettings.path + [name])
            } else {
                naming
            }
        } footer: {
            SettingsEditorButtons(create: name == nil ? "Add Server" : nil, canCreate: !newID.isEmpty && problem == nil, onCreate: add,
                                  remove: "Remove Server…", onRemove: { confirmsRemoval = true },
                                  done: { if let name { close(MCPSettings.path + [name]) } else { done() } })
        }
        .settingsDetailTitle(name ?? "Add Server")
        .confirmationDialog("Remove \(name ?? "")?", isPresented: $confirmsRemoval) {
            Button("Remove", role: .destructive) {
                if let name { remove(MCPSettings.path + [name]) }
            }
        } message: {
            Text("The agent loses its tools.")
        }
    }

    /// A new server's name, before anything is written: what's wrong with it, or what it'll
    /// be called when that isn't quite what you typed.
    private var naming: some View {
        Section {
            SettingsTextRow(title: "Name") {
                TextField("Name", text: $newName, prompt: Text(verbatim: "files"))
                    .onSubmit(add)
            }
        } footer: {
            if let problem {
                Text(problem).foregroundStyle(.red)
            } else if !newID.isEmpty, newID != newName.trimmingCharacters(in: .whitespaces) {
                Text(verbatim: "It'll be called \(newID).").foregroundStyle(.secondary)
            } else {
                Text("A short name without spaces. The server's tools are named after it.").foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func editor(_ path: [String]) -> some View {
        let isRemote = pendingRemote || config.value(at: path + ["type"])?.string == "remote"
        Group {
            Section {
                Picker("Runs", selection: Binding(
                    get: { isRemote ? "remote" : "local" },
                    set: { kind in
                        // Back before a URL was given: nothing was written.
                        if kind == "local", pendingRemote {
                            pendingRemote = false
                            pendingURL = ""
                        } else {
                            switchKind(of: path, to: kind)
                        }
                    }
                )) {
                    Text(box.machine == nil ? "On this Mac" : "On \(app.name(of: box))").tag("local")
                    Text("On the web").tag("remote")
                }
                .pickerStyle(.segmented)
                if pendingRemote {
                    SettingsTextRow(title: "URL") {
                        TextField("URL", text: $pendingURL, prompt: Text(verbatim: "https://example.com/mcp"))
                            .onSubmit { saveURL(path) }
                            .onDisappear { saveURL(path) }
                    }
                } else if isRemote {
                    ConfigTextField(title: "URL", path: path + ["url"], prompt: "https://example.com/mcp")
                    // Sign-in set up by hand (an object) isn't this switch's to replace.
                    let customSignIn = config.value(at: path + ["oauth"])?.object != nil
                    Toggle(isOn: customSignIn ? .constant(true) : Binding(
                        get: { config.value(at: path + ["oauth"])?.bool != false },
                        set: { config.set($0 ? nil : .bool(false), at: path + ["oauth"]) }
                    )) {
                        Text("Sign in when the server asks")
                        Text(customSignIn ? "With the sign-in set up in the settings file." : "Turn off for a server that takes an API key in a header instead.")
                    }
                    .disabled(customSignIn)
                } else {
                    // A command is often long: it wraps, in a typeface that keeps its flags apart.
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Command")
                        TextField("Command", text: $command, prompt: Text(verbatim: "npx -y @modelcontextprotocol/server-filesystem ~/Documents"), axis: .vertical)
                            .labelsHidden()
                            .font(.body.monospaced())
                            .lineLimit(1...8)
                            .onSubmit { saveCommand(path) }
                            .onDisappear { saveCommand(path) }
                    }
                    ConfigTextField(title: "Working folder", path: path + ["cwd"], prompt: "The project's folder")
                }
                Toggle(isOn: config.bool(path + ["codemode"], default: true)) {
                    Text("Let the agent call its tools from code")
                    Text("Code Mode: the agent looks up this server's tools and combines several in one step, which keeps each message small for a server with many tools. Smaller models may not find its tools this way.")
                }
            } footer: {
                if pendingRemote {
                    Text("Add its URL to save it.")
                        .foregroundStyle(.secondary)
                }
            }
            if isRemote, !pendingRemote {
                Section {
                    ConfigKeyValueList(path: path + ["headers"], keyPrompt: "Header, like Authorization", valuePrompt: "Value")
                } header: {
                    Text("Headers")
                } footer: {
                    Self.keyNote
                }
            } else if !isRemote {
                Section {
                    ConfigKeyValueList(path: path + ["environment"], keyPrompt: "Variable, like GITHUB_TOKEN", valuePrompt: "Value")
                } header: {
                    Text("Environment Variables")
                } footer: {
                    Self.keyNote
                }
            }
        }
        .onAppear {
            command = Self.commandLine(config.value(at: path + ["command"]))
            shownCommand = command
            #if DEBUG
            if ProcessInfo.processInfo.environment["KUVO_DEMO_MCP_SERVER"]?.hasSuffix("|web") == true { switchKind(of: path, to: "remote") }
            #endif
        }
        // A URL typed into a server that had none turns it on, as a command does. (Switching
        // kinds brings back its own URL, on or off as it was, so that's left alone.)
        .onChange(of: config.value(at: path)) { old, new in
            guard old?["type"] == new?["type"], (old?["url"]?.string ?? "").isEmpty, !(new?["url"]?.string ?? "").isEmpty else { return }
            config.set(nil, at: path + ["disabled"])
        }
    }

    private func add() {
        guard !newID.isEmpty, problem == nil else { return }
        // Off until it has a command or URL, so the engine doesn't try to start an empty one.
        config.set(.object(["type": .string("local"), "command": .array([]), "disabled": .bool(true), "codemode": .bool(false)]), at: MCPSettings.path + [newID])
        Analytics.shared.track("mcp_server_added")
        name = newID
    }

    private func close(_ path: [String]) {
        saveCommand(path)
        saveURL(path)
        done()
    }

    /// The URL given for a server switched to "On the web": it's one now, and on.
    private func saveURL(_ path: [String]) {
        let url = pendingURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard pendingRemote, let parsed = URL(string: url), ["http", "https"].contains(parsed.scheme?.lowercased()), parsed.host() != nil else { return }
        pendingRemote = false
        pendingURL = ""
        switchKind(of: path, to: "remote", url: url)
    }

    /// Switches between running a command and connecting to a URL (`MCPSettings.switched`);
    /// "On the web" with no URL to bring back waits for one (`pendingRemote`).
    private func switchKind(of path: [String], to kind: String, url: String? = nil) {
        let isRemote = config.value(at: path + ["type"])?.string == "remote"
        guard kind != (isRemote ? "remote" : "local") else { return }
        // A command you typed and didn't press Return on is put aside with the rest.
        saveCommand(path)
        guard let switched = MCPSettings.switched(config.value(at: path)?.object ?? [:], to: kind, putAside: putAside, url: url) else {
            pendingRemote = true
            return
        }
        let settings = switched.settings
        putAside = switched.putAside
        config.set(.object(settings), at: path)
        // The field shows the command that came back, or none, as saved.
        command = Self.commandLine(settings["command"])
        shownCommand = command
    }

    /// The command as its words (quotes keep spaces in one); a server with a command is
    /// turned on.
    private func saveCommand(_ path: [String]) {
        // Only what you changed: the file's own form is kept otherwise.
        guard config.value(at: path + ["type"])?.string != "remote", command != shownCommand else { return }
        shownCommand = command
        let words = Self.words(command)
        let old = config.value(at: path + ["command"])?.array?.compactMap(\.string) ?? []
        guard words != old else { return }
        config.set(.array(words.map(JSONValue.string)), at: path + ["command"])
        if old.isEmpty, !words.isEmpty { config.set(nil, at: path + ["disabled"]) }
    }

    /// A command as one line to edit: its words, quoted where they need it.
    static func commandLine(_ command: JSONValue?) -> String {
        command?.array?.compactMap(\.string).map(quoted).joined(separator: " ") ?? ""
    }

    static func words(_ line: String) -> [String] { CommandWords.split(line) }
    static func quoted(_ word: String) -> String { CommandWords.quoted(word) }
}

extension MCPSettings {
    /// The fields only one kind of server has: a command and what it runs with, or a URL and how
    /// it signs in.
    static let kindFields = ["command", "cwd", "environment", "url", "headers", "oauth"]

    /// A server's settings switched to running a command (`local`) or to a URL (`remote`): what
    /// the kind it leaves had is put aside, and what the other had comes back (`putAside`); one
    /// with nothing to run yet is off, as a new server is, until it has a command or URL. `url`:
    /// one given as it's switched, which turns it on. Nil for a server on the web with no URL,
    /// which the engine doesn't take: nothing's written until there's one.
    static func switched(_ settings: [String: JSONValue], to kind: String, putAside: [String: JSONValue], url: String? = nil) -> (settings: [String: JSONValue], putAside: [String: JSONValue])? {
        var settings = settings
        var leaving: [String: JSONValue] = [:]
        for key in kindFields + ["disabled"] { leaving[key] = settings.removeValue(forKey: key) }
        if putAside.isEmpty {
            settings["disabled"] = .bool(true)
        } else {
            for (key, value) in putAside { settings[key] = value }
        }
        settings["type"] = .string(kind)
        if kind == "local", settings["command"] == nil { settings["command"] = .array([]) }
        if kind == "remote" {
            if let url, !url.isEmpty {
                settings["url"] = .string(url)
                settings["disabled"] = nil
            }
            guard !(settings["url"]?.string ?? "").isEmpty else { return nil }
        }
        return (settings, leaving)
    }
}

/// A command line, as the MCP server editor reads and writes it.
nonisolated enum CommandWords {
    /// A command line's words, as a shell splits them: quotes keep spaces in one word, and a
    /// backslash takes the next character as it is (not inside single quotes; inside double ones,
    /// only before ", \, $ or `, as in "a\.b", a pattern pasted from a README).
    static func split(_ line: String) -> [String] {
        var words: [String] = []
        var current = ""
        var quote: Character?
        var hasWord = false
        var escaped = false
        for character in line {
            if escaped {
                if quote == "\"", !"\"\\$`".contains(character) { current.append("\\") }
                current.append(character)
                escaped = false
            } else if character == "\\", quote != "'" {
                escaped = true
                hasWord = true
            } else if let open = quote {
                if character == open { quote = nil } else { current.append(character) }
            } else if character == "\"" || character == "'" {
                quote = character
                hasWord = true
            } else if character.isWhitespace {
                if hasWord { words.append(current) }
                current = ""
                hasWord = false
            } else {
                current.append(character)
                hasWord = true
            }
        }
        if hasWord { words.append(current) }
        return words
    }

    /// A word as it can be typed back: in double quotes, with quotes and backslashes escaped,
    /// when it has spaces, quotes or backslashes.
    static func quoted(_ word: String) -> String {
        guard word.isEmpty || word.contains(where: { $0.isWhitespace || $0 == "\"" || $0 == "'" || $0 == "\\" }) else { return word }
        return "\"" + word.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}
