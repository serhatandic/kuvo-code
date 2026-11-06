import AppKit
import ClientDesign
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

    /// Your servers: not Kuvo Code's own, nor integrations', which their page adds and removes
    /// (with their keys and sign-ins, which removing one here would leave), where it has one.
    private var names: [String] {
        let configured = config.value(at: Self.path)?.object?.keys.map { $0 } ?? []
        return Set(configured + live.map(\.name)).subtracting(Self.builtIn).filter { !integrationsHere || Integrations.service($0) == nil }.sorted()
    }

    /// This computer has an Integrations page, which keeps integrations' servers.
    private var integrationsHere: Bool { SettingsPage.integrations.isShown(on: box) }

    /// The popular servers that run here: on a machine, not those only a Mac can run; and not an
    /// integration's, which Integrations connects, so each is in one place.
    private var popular: [MCPCatalog.Server] {
        MCPCatalog.servers.filter { server in
            (box.machine == nil || !MCPCatalog.macOnly.contains(server.id)) && !(integrationsHere && Integrations.service(server.id) != nil)
        }
    }

    /// The popular servers Integrations has instead, by their makers' names ("Linear, Notion and
    /// Atlassian").
    private var inIntegrations: [String] {
        integrationsHere ? MCPCatalog.servers.filter { Integrations.service($0.id) != nil }.map(\.title) : []
    }

    private func popularRow(_ server: MCPCatalog.Server) -> some View {
        SettingsRowLayout {
            HStack(alignment: .center, spacing: 12) {
                BrandMarkView(server.id, size: 17)
                    .foregroundStyle(.secondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(server.title)
                    Text(server.summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
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

            // Popular servers in groups by what they need, so no row carries a tag of its own.
            ForEach(MCPCatalog.Access.allCases, id: \.self) { access in
                let servers = popular.filter { $0.access == access }
                if !servers.isEmpty {
                    Section {
                        ForEach(servers) { server in popularRow(server) }
                        if access == .signIn, !inIntegrations.isEmpty {
                            LabeledContent {
                                Button("Show Integrations") { app.settingsTabs.show(.integrations, on: box) }
                            } label: {
                                Text("\(inIntegrations.formatted(.list(type: .and))) are in Integrations")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    } header: {
                        // Read on from the first: "Popular Servers That Need an Account", then
                        // "No Account Needed", "Run on This Mac".
                        Text(access.title(on: box.machine == nil ? "This Mac" : app.name(of: box)))
                    } footer: {
                        if access == MCPCatalog.Access.allCases.last(where: { a in popular.contains { $0.access == a } }) {
                            Text("Popular servers, each from the company behind it, as listed in the official MCP Registry. One that needs an account asks you to sign in once it's added.")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
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
            ServerEditor(name: edit.name, taken: Set(live.map(\.name)), live: live, refresh: refresh) { editing = nil } remove: { path in
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
    /// How the engine's servers stand now, and reading them again.
    let live: [MCPServer]
    let refresh: () async -> Void
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
    /// The address as you type it, saved as `MCPSettings.webAddress` makes it once you're done;
    /// `loadedAddress`, what it was as it was shown (so one changed elsewhere isn't put back).
    @State private var address = ""
    @State private var loadedAddress = ""
    /// What you typed isn't an address: said under it, and what was saved stays.
    @State private var addressProblem = false
    @FocusState private var addressFocused: Bool
    /// A server's setup pasted into its name before it was named: written once it is.
    @State private var pasted: MCPSnippet?
    /// The setup you pasted was taken in: said under the field it went into.
    @State private var tookPaste = false
    /// Where its box runs the command's program from; nil while that's asked, "" for nowhere.
    @State private var program: (name: String, path: String?)?
    /// Choosing a machine's folder to run it in.
    @State private var choosingFolder = false

    /// Where it runs: here (a command), on the web, or on the web once you give it a URL.
    private enum Kind { case local, waitingForURL, web }

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
        .settingsDetail(isPresented: $choosingFolder, title: "Choose Its Working Folder") {
            BoxFolderBrowser(box: box.machine ?? BoxClient.mac, start: config.value(at: MCPSettings.path + [name ?? "", "cwd"])?.string, primary: "Choose") { folder, home in
                if let name { config.set(.string(BoxPaths.setting(folder, home: home)), at: MCPSettings.path + [name, "cwd"]) }
                choosingFolder = false
            } cancel: {
                choosingFolder = false
            }
        }
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
                TextField("Name", text: $newName, prompt: Text("files, or paste its setup from the README"))
                    .onSubmit(add)
                    .onChange(of: newName) { takeNamePaste() }
            }
        } footer: {
            let several = MCPSnippet.all(newName)
            if several.count > 1 {
                Text("This sets up \(several.count) servers (\(several.compactMap(\.name).joined(separator: ", "))). Paste one server’s part at a time.")
                    .foregroundStyle(.secondary)
            } else if let pasted, newID.isEmpty {
                Text("Name it to add it with the setup you pasted.").foregroundStyle(.secondary)
            } else if let pasted, problem == nil {
                // What it'll run or reach, to read before adding it.
                Text(pasted.url.map { "Add it to reach \($0)." } ?? "Add it to run \(Self.commandLine(.array(pasted.command.map(JSONValue.string))))" + (pasted.environment.isEmpty ? "." : ", with \(pasted.environment.count.counting("key")) to fill in."))
                    .foregroundStyle(.secondary)
            } else if let problem {
                Text(problem).foregroundStyle(.red)
            } else if !newID.isEmpty, newID != newName.trimmingCharacters(in: .whitespaces) {
                Text(verbatim: "It'll be called \(newID).").foregroundStyle(.secondary)
            } else {
                Text("A short name without spaces. The server's tools are named after it.").foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func editor(_ path: [String]) -> some View {
        let kind: Kind = pendingRemote ? .waitingForURL : config.value(at: path + ["type"])?.string == "remote" ? .web : .local
        let isOn = config.value(at: path + ["disabled"])?.bool != true
        let server = live.first { $0.name == path.last }
        Group {
            if kind != .waitingForURL, server != nil || !isOn {
                Section {
                    LabeledContent("Status") {
                        HStack(spacing: 10) {
                            StatusLabel(status: server?.status, isOn: isOn)
                            if isOn, server?.status.status == "failed" {
                                Button("Try Again") {
                                    Task {
                                        if let api = app.api(for: box), let name = path.last { await app.reconnect(name, api: api, machine: box.machine) }
                                        await refresh()
                                    }
                                }
                            }
                        }
                    }
                    if isOn, let error = server?.status.error, !error.isEmpty {
                        Text(error)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Section {
                Picker("Runs", selection: Binding(
                    get: { kind == .local ? "local" : "remote" },
                    set: { picked in
                        // Back before a URL was given: nothing was written.
                        if picked == "local", pendingRemote {
                            pendingRemote = false
                        } else {
                            // A URL typed and not saved yet goes aside with the rest.
                            if picked == "local" { saveAddress(path) }
                            switchKind(of: path, to: picked)
                        }
                        // The address it had before comes back with it, shown as saved.
                        showAddress(path)
                    }
                )) {
                    Text(box.machine == nil ? "On this Mac" : "On the machine").tag("local")
                    Text("On the web").tag("remote")
                }
                .pickerStyle(.segmented)
                if kind != .local {
                    SettingsTextRow(title: "URL") {
                        TextField("URL", text: $address, prompt: Text(verbatim: "https://example.com/mcp"))
                            .focused($addressFocused)
                            .onSubmit { saveAddress(path) }
                            .onChange(of: addressFocused) { if !addressFocused { saveAddress(path) } }
                            .onDisappear { saveAddress(path) }
                            .onChange(of: address) { addressProblem = false }
                            // Waiting for one: where you type next.
                            .onAppear { if pendingRemote { addressFocused = true } }
                    }
                }
                if kind == .web {
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
                            .onChange(of: command) { takeCommandPaste(path) }
                        if tookPaste {
                            Label("Filled in from the setup you pasted.", systemImage: "checkmark")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        } else if let program {
                            ProgramNote(name: program.name, path: program.path, computer: computer)
                        }
                    }
                    .task(id: "\(box.machine ?? BoxClient.mac) \(Self.words(command).first ?? "")") { await findProgram() }
                    WorkingFolderRow(path: path + ["cwd"], choosing: $choosingFolder)
                }
                Toggle(isOn: config.bool(path + ["codemode"], default: true)) {
                    Text("Let the agent call its tools from code")
                    Text("Code Mode: the agent looks up this server's tools and combines several in one step, which keeps each message small for a server with many tools. Smaller models may not find its tools this way.")
                }
            } footer: {
                if addressProblem {
                    Text("That isn’t a web address. Give one like https://example.com/mcp.")
                        .foregroundStyle(.red)
                } else if kind == .waitingForURL {
                    Text("Add its URL to save it.")
                        .foregroundStyle(.secondary)
                }
            }
            if kind == .web {
                Section {
                    ConfigKeyValueList(path: path + ["headers"], keyPrompt: "Header, like Authorization", valuePrompt: "Value")
                } header: {
                    Text("Headers")
                } footer: {
                    Self.keyNote
                }
            } else if kind == .local {
                Section {
                    ConfigKeyValueList(path: path + ["environment"], keyPrompt: "NAME", valuePrompt: "Value")
                } header: {
                    Text("Environment Variables")
                } footer: {
                    Text("Each by its name, like GITHUB_TOKEN. To keep a key out of the settings file, write {env:NAME} to use one of your environment variables.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .onAppear {
            command = Self.commandLine(config.value(at: path + ["command"]))
            shownCommand = command
            showAddress(path)
            #if DEBUG
            if ProcessInfo.processInfo.environment["KUVO_DEMO_MCP_SERVER"] == "\(path.last ?? "")|web" { switchKind(of: path, to: "remote") }
            #endif
        }
        // A URL typed into a server that had none turns it on, as a command does. (Switching
        // kinds brings back its own URL, on or off as it was, so that's left alone.)
        .onChange(of: config.value(at: path)) { old, new in
            // Changed elsewhere (the file, a phone) while you weren't typing here: shown as it is.
            if !addressFocused, old?["url"] != new?["url"], !pendingRemote { showAddress(path) }
            guard old?["type"] == new?["type"], (old?["url"]?.string ?? "").isEmpty, !(new?["url"]?.string ?? "").isEmpty else { return }
            config.set(nil, at: path + ["disabled"])
        }
    }

    private func add() {
        guard !newID.isEmpty, problem == nil else { return }
        // Off until it has a command or URL, so the engine doesn't try to start an empty one.
        config.set(.object(["type": .string("local"), "command": .array([]), "disabled": .bool(true), "codemode": .bool(false)]), at: MCPSettings.path + [newID])
        if let pasted {
            apply(pasted, at: MCPSettings.path + [newID])
            self.pasted = nil
            tookPaste = true
        }
        Analytics.shared.track("mcp_server_added")
        name = newID
    }

    /// Closed only with an address that is one, or none typed yet: what isn't one is said, and
    /// the editor stays for you to fix it.
    private func close(_ path: [String]) {
        saveCommand(path)
        guard saveAddress(path) else { return }
        done()
    }

    private func showAddress(_ path: [String]) {
        address = config.value(at: path + ["url"])?.string ?? ""
        loadedAddress = address
        addressProblem = false
    }

    /// The address you typed, if you changed it, saved as an address (`MCPSettings.webAddress`):
    /// for a server waiting for one, it's on the web now, and on. One that isn't an address is
    /// said, and what was saved stays (never a server on the web without one): false.
    @discardableResult private func saveAddress(_ path: [String]) -> Bool {
        let typed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard pendingRemote || config.value(at: path + ["type"])?.string == "remote" else { return true }
        if pendingRemote ? typed.isEmpty : typed == loadedAddress { return true }
        guard let url = MCPSettings.webAddress(typed) else {
            addressProblem = true
            return false
        }
        address = url
        loadedAddress = url
        if pendingRemote {
            pendingRemote = false
            switchKind(of: path, to: "remote", url: url)
        } else {
            config.set(.string(url), at: path + ["url"])
        }
        return true
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

    /// "this Mac", or the machine's name.
    private var computer: String { box.machine == nil ? "this Mac" : app.name(of: box) }

    /// A server's setup pasted into its name: its name taken, and the rest kept to write once you
    /// add it (never before: what it runs is said under the name first).
    private func takeNamePaste() {
        guard let snippet = MCPSnippet.parse(newName) else { return }
        pasted = snippet
        newName = snippet.name ?? ""
    }

    /// A server's setup pasted into its command: what it runs or reaches, and its keys' names,
    /// in their places.
    private func takeCommandPaste(_ path: [String]) {
        // As shown (what a paste just filled in): nothing new.
        guard command != shownCommand else { return }
        tookPaste = false
        guard let snippet = MCPSnippet.parse(command) else { return }
        apply(snippet, at: path)
        tookPaste = true
    }

    /// `snippet` as this server's settings: running its command, or reaching its URL. What it
    /// doesn't say stays (a working folder, a sign-in, keys it doesn't name); one that had
    /// nothing to run yet is turned on, and one turned off stays off.
    private func apply(_ snippet: MCPSnippet, at path: [String]) {
        var settings = config.value(at: path)?.object ?? [:]
        let wasEmpty = (settings["command"]?.array ?? []).isEmpty && (settings["url"]?.string ?? "").isEmpty
        let merged = { (key: String, given: [String: String]) -> JSONValue? in
            let kept = settings[key]?.object ?? [:]
            return kept.isEmpty && given.isEmpty ? nil : .object(kept.merging(given.mapValues(JSONValue.string)) { $1 })
        }
        if let url = snippet.url {
            for key in ["command", "cwd", "environment"] { settings[key] = nil }
            settings["type"] = .string("remote")
            settings["url"] = .string(url)
            settings["headers"] = merged("headers", snippet.headers)
        } else {
            for key in ["url", "headers", "oauth"] { settings[key] = nil }
            settings["type"] = .string("local")
            settings["command"] = .array(snippet.command.map(JSONValue.string))
            settings["environment"] = merged("environment", snippet.environment)
        }
        if wasEmpty { settings["disabled"] = nil }
        putAside = [:]
        pendingRemote = false
        config.set(.object(settings), at: path)
        command = Self.commandLine(settings["command"])
        shownCommand = command
        showAddress(path)
    }

    /// Whether this computer has the command's program, as its box finds it: nothing said while
    /// it's asked, or for one it can't tell (`./server`, from the working folder).
    private func findProgram() async {
        // Never the last word's answer under a new one.
        program = nil
        guard let word = Self.words(command).first else { return }
        struct Found: Decodable { var name: String; var path: String?; var unknown: Bool? }
        // A moment after the last key, so each one isn't asked.
        try? await Task.sleep(for: .milliseconds(400))
        guard !Task.isCancelled, let found = try? await app.box(box.machine ?? BoxClient.mac).value(Found.self, "GET", "kuvo/programs?name=\(Workspace.queryValue(word))"),
              !Task.isCancelled, found.unknown != true else { return }
        program = (found.name, found.path)
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
    /// What you typed for a server on the web, as an address to save: as it is with its scheme
    /// (a name on your network too); without one, https (http for this computer's own,
    /// `localhost`); nil for one that isn't an address.
    static func webAddress(_ typed: String) -> String? {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains(where: \.isWhitespace) else { return nil }
        let schemed = text.contains("://")
        let local = ["localhost", "127.0.0.1", "[::1]"].contains { text.lowercased().hasPrefix($0) }
        let full = schemed ? text : (local ? "http://" : "https://") + text
        guard let url = URL(string: full), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host(), !host.isEmpty else { return nil }
        // Without a scheme, a word alone is taken for a typo, not a name on your network.
        guard schemed || host.contains(".") || host.lowercased() == "localhost" || host.contains(":") else { return nil }
        return full
    }

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

/// Whether the computer has the program a server's command runs, and where it comes from when it
/// hasn't.
private struct ProgramNote: View {
    let name: String
    let path: String?
    let computer: String

    /// What a program that isn't there comes with, for the ones servers' READMEs use most.
    static func source(of program: String) -> String? {
        switch (program as NSString).lastPathComponent {
        case "npx", "npm", "node": "Node.js"
        case "uvx", "uv": "uv"
        case "docker": "Docker"
        case "python", "python3", "pip", "pip3": "Python"
        case "bun", "bunx": "Bun"
        case "deno": "Deno"
        default: nil
        }
    }

    var body: some View {
        if path != nil {
            Label {
                Text("\(name) is on \(computer).")
            } icon: {
                Image(systemName: "checkmark").foregroundStyle(.green).accessibilityHidden(true)
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .help(path ?? "")
            .accessibilityElement(children: .combine)
        } else {
            Label {
                Text("\(name) isn’t on \(computer)" + (Self.source(of: name).map { ". It comes with \($0): install that there first." } ?? ". Install it there first, or use a command it has."))
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityHidden(true)
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
        }
    }
}

/// The folder a server runs in: the project's, or one you choose, as a folder panel chooses it (a
/// machine's own folders on its page).
private struct WorkingFolderRow: View {
    let path: [String]
    @Binding var choosing: Bool
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box

    var body: some View {
        let config = app.config(for: box)
        let folder = config.value(at: path)?.string.flatMap { $0.isEmpty ? nil : $0 }
        LabeledContent("Working folder") {
            HStack(spacing: 8) {
                Text(folder.map { BoxPaths.display($0, home: box.machine == nil ? NSHomeDirectory() : nil) } ?? "The project’s folder")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(folder ?? "")
                    // The path gives way first, at larger text too.
                    .layoutPriority(-1)
                Button("Choose…") {
                    guard box.machine == nil else {
                        choosing = true
                        return
                    }
                    let panel = NSOpenPanel()
                    panel.canChooseDirectories = true
                    panel.canChooseFiles = false
                    panel.canCreateDirectories = true
                    panel.prompt = "Choose"
                    panel.message = "Choose the folder the server runs in."
                    guard panel.runModal() == .OK, let url = panel.url else { return }
                    config.set(.string(BoxPaths.setting(url.path, home: NSHomeDirectory())), at: path)
                }
                if folder != nil {
                    Button {
                        config.set(nil, at: path)
                    } label: {
                        Image(systemName: "minus.circle.fill")
                    }
                    .buttonStyle(RemoveButtonStyle())
                    .help("Run it in the project’s folder")
                    .accessibilityLabel("Run it in the project’s folder")
                }
            }
        }
    }
}
