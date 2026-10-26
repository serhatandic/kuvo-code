import OpenCodeKit
import SwiftUI

/// Settings › Engine's plugins: each one added, with whether it loaded, and Add Plugin…, which
/// opens `AddPluginPage` in the page's place.
struct PluginsSection: View {
    @Binding var adding: Bool
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Catalog.self) private var catalog
    /// What npm doesn't have of those that failed, by name ("" when it has it), once asked.
    @State private var missing: [String: String] = [:]

    private var config: EngineConfig { app.config(for: box) }
    private var boxID: String { box.machine ?? BoxClient.mac }
    private var computer: String { box.machine == nil ? "your Mac" : app.name(of: box) }

    var body: some View {
        let value = config.value(at: ["plugins"])
        Section {
            if let value, value.array == nil {
                Text("Set up by hand in the settings file.")
                    .foregroundStyle(.secondary)
            } else {
                let items = config.items(["plugins"])
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    PluginRow(entry: PluginEntry(item), status: status(of: PluginEntry(item))) {
                        var items = items
                        items.remove(at: index)
                        config.setItems(items, at: ["plugins"])
                    }
                }
                Button("Add Plugin…") { adding = true }
            }
        } header: {
            Text("Plugins")
        } footer: {
            Text("Plugins add tools and change how the engine works. They run code on \(computer), so add only ones you trust.")
                .foregroundStyle(.secondary)
        }
        // Why each that failed did, from npm, once.
        .task(id: failedNames) {
            for name in failedNames where missing[name] == nil {
                guard let answer = try? await app.box(boxID).searchPlugins(name) else { continue }
                missing[name] = answer.missing ?? ""
            }
        }
    }

    /// The packages that didn't load, as added.
    private var failedNames: [String] {
        (catalog.plugins ?? []).filter { $0.state.status == "failed" && $0.source.type == "package" }.compactMap(\.source.entry).sorted()
    }

    private func status(of entry: PluginEntry) -> PluginRow.Status {
        guard app.isReady(box), let plugins = catalog.plugins else { return .unknown }
        guard let name = entry.name else { return .unknown }
        let found = plugins.first { $0.source.entry == name }
            ?? (entry.isFolder ? plugins.first { ($0.source.path as NSString?)?.lastPathComponent == (name as NSString).lastPathComponent } : nil)
        guard let found else { return entry.isFolder || entry.turnsOff ? .unknown : .installing }
        if found.state.status == "active" { return .loaded(version: found.source.version) }
        if let gone = missing[name], !gone.isEmpty {
            // "name@9.9.9": the package is there, that version isn't.
            return .failed(gone.dropFirst().contains("@") ? "npm doesn’t have this version." : "There’s no package by this name on npm.")
        }
        return .failed(found.state.error.map { $0 == "Plugin failed to load" ? "It didn’t load." : $0 } ?? "It didn’t load.")
    }
}

/// A plugin as the settings add it: a package's name, a folder, or one set up with options.
private struct PluginEntry {
    /// The package or folder; nil for one the settings set up some other way.
    let name: String?
    let hasOptions: Bool

    init(_ item: JSONValue) {
        name = item.string ?? item["package"]?.string
        hasOptions = item.string == nil && item["options"] != nil
    }

    /// A folder of your own, rather than a package on npm.
    var isFolder: Bool { name.map { $0.hasPrefix("/") || $0.hasPrefix("~/") || $0.hasPrefix("./") || $0.hasPrefix("../") || $0.hasPrefix("file://") } ?? false }
    /// "-name": turns off one that other settings add.
    var turnsOff: Bool { name?.hasPrefix("-") ?? false }
}

/// One added: what it is, whether it loaded, and Remove.
private struct PluginRow: View {
    enum Status: Equatable {
        /// The engine isn't running, or it isn't one it says anything about.
        case unknown
        case installing
        case loaded(version: String?)
        case failed(String)
    }

    let entry: PluginEntry
    let status: Status
    let remove: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if entry.isFolder {
                        FolderIcon(isOpen: false, size: 14)
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                    }
                    Text(title)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .foregroundStyle(entry.name == nil ? .secondary : .primary)
                }
                detail
            }
            Spacer()
            Button(action: remove) {
                Image(systemName: "minus.circle.fill")
            }
            .buttonStyle(RemoveButtonStyle())
            .help("Remove")
            .accessibilityLabel("Remove \(title)")
        }
        .animation(.ui, value: status)
    }

    private var title: String {
        guard let name = entry.name else { return "Set up in the settings file" }
        if entry.turnsOff { return "\(name.dropFirst()), turned off" }
        return entry.isFolder ? (name as NSString).lastPathComponent : name
    }

    @ViewBuilder private var detail: some View {
        switch status {
        case .unknown:
            if entry.isFolder, let name = entry.name {
                Text(name).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
        case .installing:
            HStack(spacing: 6) {
                Spinner(size: 11)
                Text("Installing…")
            }
            .font(.callout)
            .foregroundStyle(.secondary)
        case .loaded(let version):
            Text(version.map { "Loaded · \($0)" } ?? "Loaded")
                .font(.callout)
                .foregroundStyle(.secondary)
        case .failed(let why):
            Label(why, systemImage: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Add a Plugin, in the page's place: npm's plugins for opencode, the most used first, searched
/// as you type, from the computer the engine runs on; or a folder of your own.
struct AddPluginPage: View {
    /// What's in the search field as it opens.
    var typed = ""
    let done: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var settingsBox
    @State private var query = ""
    @State private var found: PluginSearch?
    @State private var failure: String?
    @State private var isSearching = false
    @State private var confirming: PluginSearch.Package?
    @State private var choosingFolder = false

    private var search: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var config: EngineConfig { app.config(for: settingsBox) }
    private var box: String { settingsBox.machine ?? BoxClient.mac }
    private var computer: String { settingsBox.machine == nil ? "your Mac" : app.name(of: settingsBox) }
    /// Those added already, by name.
    private var added: Set<String> { Set(config.items(["plugins"]).compactMap { PluginEntry($0).name }) }

    private func add(_ entry: String) {
        let items = config.items(["plugins"])
        guard !items.contains(.string(entry)) else { return }
        config.setItems(items + [.string(entry)], at: ["plugins"])
    }

    var body: some View {
        SettingsDetailPage {
            Section {
                HStack {
                    SettingsSearchRow(text: $query, prompt: "Search npm, or type a package’s name")
                        .onSubmit(addTyped)
                    if isSearching { Spinner(size: 14) }
                }
                if let failure {
                    FailureLabel(title: "Couldn’t search npm", detail: failure, retrying: "npm") { Task { await find() } }
                } else if let found {
                    if let missing = found.missing, found.packages.isEmpty || search.contains("@") {
                        Label("npm doesn’t have \(missing).", systemImage: "questionmark.circle")
                            .foregroundStyle(.secondary)
                    } else if found.packages.isEmpty {
                        Text("No plugins match “\(search)”.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(found.packages) { package in
                        PackageRow(package: package, isAdded: added.contains(package.name) || added.contains(spec(of: package))) {
                            confirming = package
                        }
                    }
                } else {
                    HStack {
                        Spacer()
                        Spinner(size: 20)
                        Spacer()
                    }
                    .padding(.vertical, 16)
                }
            } header: {
                Text(search.isEmpty ? "Popular Plugins" : "On npm")
            } footer: {
                Text("These are made by their authors and published on npm, not by Kuvo Code.")
                    .foregroundStyle(.secondary)
            }
        } footer: {
            EditorFooter(primary: "Done", onPrimary: done) {
                Button("Use a Folder…", action: chooseFolder)
                    .buttonStyle(.glass)
                    .help("A plugin of your own, in a folder on \(computer)")
            }
        }
        .onAppear { if query.isEmpty { query = typed } }
        .task(id: search) {
            // A moment after the last key, so each one isn't a search.
            if !search.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            await find()
        }
        .confirmationDialog("Add \(confirming.map(spec(of:)) ?? "")?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), presenting: confirming) { package in
            Button("Add Plugin") { add(spec(of: package)) }
            Button("Cancel", role: .cancel) {}
        } message: { package in
            Text([package.description, "It runs code on \(computer) each time the engine starts."].compactMap { $0 }.joined(separator: "\n\n"))
        }
        .settingsDetail(isPresented: $choosingFolder, title: "Choose the Plugin’s Folder") {
            BoxFolderBrowser(box: box, start: nil, primary: "Add Plugin") { path, home in
                add(BoxPaths.setting(path, home: home))
                choosingFolder = false
            } cancel: {
                choosingFolder = false
            }
        }
    }

    /// What's added for a package: with the version typed, if one was (`name@1.2.0`).
    private func spec(of package: PluginSearch.Package) -> String {
        let typed = search.lowercased()
        return typed.hasPrefix(package.name + "@") ? typed : package.name
    }

    private func find() async {
        isSearching = true
        defer { isSearching = false }
        do {
            let answer = try await app.box(box).searchPlugins(search)
            withAnimation(.ui) {
                found = answer
                failure = nil
            }
        } catch {
            failure = error.localizedDescription
        }
    }

    /// Return: the package named exactly, once npm says it has it.
    private func addTyped() {
        guard let first = found?.packages.first, found?.missing == nil, search.lowercased() == first.name || search.lowercased().hasPrefix(first.name + "@") else { return }
        confirming = first
    }

    private func chooseFolder() {
        guard box == BoxClient.mac else {
            choosingFolder = true
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Add Plugin"
        panel.message = "Choose the folder of a plugin of your own."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        add(BoxPaths.setting(url.path, home: NSHomeDirectory()))
    }
}

/// A package on npm: its name and what it says it does, how much it's used, and Add.
private struct PackageRow: View {
    let package: PluginSearch.Package
    let isAdded: Bool
    let add: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(package.name)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let version = package.version {
                        Text(version)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                if let description = package.description {
                    Text(description)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .help(description)
                }
                if let weekly = package.weekly, weekly > 0 {
                    Text("\(weekly.formatted(.number.notation(.compactName))) downloads a week")
                        .font(.callout)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            if isAdded {
                Label("Added", systemImage: "checkmark")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            } else {
                Button("Add", action: add)
                    .accessibilityLabel("Add \(package.name)")
            }
        }
    }
}
