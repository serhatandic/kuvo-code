import AppKit
import ClientDesign
import ClientVault
import SwiftUI
import UniformTypeIdentifiers

extension VaultItem.Kind: @retroactive Identifiable {
    public var id: String { rawValue }
}

/// One item: its values (shown or copied after Touch ID), who may use it, and what it was used
/// for. Edit changes it; Delete takes it away, with its grants.
struct VaultItemSheet: View {
    let item: VaultItem
    let box: String
    let computer: String
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var revealed: [String: String] = [:]
    @State private var recent: [VaultActivity] = []
    @State private var editing = false
    @State private var deleting = false
    @State private var trouble: String?
    /// The bots listed while the sheet is open: one set to No stays until it closes.
    @State private var listed: Set<String> = []

    /// The item as the vault has it now (changed by Edit).
    private var current: VaultItem { Vaults.shared[box].vault?.items.first { $0.id == item.id } ?? item }
    private var grants: [VaultGrant] { Vaults.shared[box].vault?.grants(for: current) ?? [] }
    private var bots: [Bot] { app.bots.list.filter { ($0.machine ?? BoxClient.mac) == box } }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                VaultKindTile(kind: current.kind, size: 32, site: current.sites.first)
                VStack(alignment: .leading, spacing: 1) {
                    Text(current.name).font(.headline)
                    Text([current.kind.title, current.sites.first].compactMap { $0 }.joined(separator: " · ")).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Edit") { editing = true }
            }
            .padding(16)
            Divider()
            ScrollingSettingsForm {
                Section { fields }
                Section {
                    // The bots that may use it; the others are a menu away, not a "No" each.
                    ForEach(listedBots) { bot in
                        whoRow(name: bot.name, who: .init(bot: bot.id)) { BotAvatar(look: bot.look, size: 22, animates: false) }
                    }
                    ForEach(listedProjects, id: \.self) { project in
                        whoRow(name: URL(filePath: project).lastPathComponent, who: .init(project: project)) {
                            Image(systemName: "folder").frame(width: 22)
                        }
                    }
                    // "Others" only under someone listed above it.
                    whoRow(name: listedBots.isEmpty && listedProjects.isEmpty ? "Every agent" : "Other sessions and bots", who: .init(everyone: true)) {
                        Image(systemName: "person.2").frame(width: 22).foregroundStyle(.secondary)
                    }
                    let others = bots.filter { bot in !isListed(bot) }
                    if !others.isEmpty {
                        Menu("Let a Bot Use It") {
                            ForEach(others) { bot in
                                Button(bot.name) {
                                    listed.insert(bot.id)
                                    grant(.init(bot: bot.id), .ask)
                                }
                            }
                        }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                    }
                } header: {
                    Text("Who Can Use It")
                } footer: {
                    Text(current.kind == .login
                         ? "Only on \(current.sites.joined(separator: ", ")). Agents never see the password: Kuvo Code fills it in."
                         : "Agents never see it: Kuvo Code fills it in, or hands it to a command they run.")
                        .foregroundStyle(.secondary)
                }
                Section("Recent Use") {
                    if recent.isEmpty { Text("Not used yet.").foregroundStyle(.secondary) }
                    ForEach(recent.prefix(5)) { VaultActivityRow(entry: $0) }
                }
            }
            Divider()
            HStack {
                Button("Delete…", role: .destructive) { deleting = true }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding(16)
        }
        .frame(width: 500, height: 560)
        .task { recent = (try? await Vaults.shared.activity(on: box, item: item.id, limit: 20)) ?? [] }
        .onChange(of: grants.compactMap(\.who.bot), initial: true) { _, granted in listed.formUnion(granted) }
        // What was shown may have changed: hidden again.
        .sheet(isPresented: $editing, onDismiss: { revealed = [:] }) { VaultItemEditor(kind: current.kind, box: box, item: current) }
        .confirmationDialog("Delete “\(current.name)” from \(computer)’s vault?", isPresented: $deleting) {
            Button("Delete", role: .destructive) {
                Task {
                    do {
                        try await Vaults.shared.remove(current, on: box)
                        dismiss()
                    } catch { trouble = error.localizedDescription }
                }
            }
        } message: {
            Text("Agents can’t use it any more. The account or service it’s for isn’t affected.")
        }
        .alert("That didn’t work", isPresented: Binding(get: { trouble != nil }, set: { if !$0 { trouble = nil } })) {
            Button("OK") {}
        } message: { Text(trouble ?? "") }
    }

    @ViewBuilder private var fields: some View {
        if let username = current.username {
            LabeledContent("Username") {
                HStack {
                    Text(username).textSelection(.enabled)
                    copyButton { username }
                        .accessibilityLabel("Copy Username")
                }
            }
        }
        if current.kind == .file, let name = current.fileName {
            LabeledContent("File", value: name)
        }
        if current.kind == .note, current.readable == true {
            LabeledContent("Bots may read it", value: "Yes")
        }
        if current.kind == .login, current.signInOnly == true {
            LabeledContent("Used", value: "Only to sign in, in the browser")
        }
        ForEach(current.fields.filter { $0 != "file" }, id: \.self) { field in
            LabeledContent(label(field)) {
                HStack(spacing: 4) {
                    Text(revealed[field] ?? "••••••••••")
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .lineLimit(current.kind == .note ? 6 : 1)
                        .frame(maxWidth: 240, alignment: .trailing)
                        .accessibilityLabel(revealed[field] ?? "Hidden")
                    Button {
                        if revealed[field] != nil { revealed[field] = nil } else { reveal(field) }
                    } label: { Image(systemName: revealed[field] == nil ? "eye" : "eye.slash") }
                        .buttonStyle(IconButtonStyle(width: 28, height: 24))
                        .help(revealed[field] == nil ? "Show" : "Hide")
                        .accessibilityLabel("\(revealed[field] == nil ? "Show" : "Hide") \(label(field))")
                    copyButton(field: field)
                }
            }
        }
    }

    private func label(_ field: String) -> String {
        switch field {
        case "password": "Password"
        case "text": "Text"
        case "value": "Value"
        default: field.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// The bots listed by name, and the projects whose sessions were always allowed.
    private var listedBots: [Bot] { bots.filter(isListed) }
    private var listedProjects: [String] { grants.compactMap(\.who.project) }

    /// Who may use it, and how (nil: no one), once you've confirmed it's you.
    private func isListed(_ bot: Bot) -> Bool {
        listed.contains(bot.id) || grants.contains { $0.who == .init(bot: bot.id) }
    }

    private func grant(_ who: VaultGrant.Who, _ how: VaultGrant.How?) {
        Task {
            guard await Passwords.authenticate(reason: "change who can use “\(current.name)”") else { return }
            do { try await Vaults.shared.grant(current, to: who, how: how, on: box) } catch { trouble = error.localizedDescription }
        }
    }

    private func whoRow<Icon: View>(name: String, who: VaultGrant.Who, @ViewBuilder icon: () -> Icon) -> some View {
        let how = grants.first { $0.who == who }?.how
        return LabeledContent {
            Picker(name, selection: Binding(get: { how }, set: { grant(who, $0) })) {
                Text("On Its Own").tag(VaultGrant.How?.some(.own))
                Text("Asks Each Time").tag(VaultGrant.How?.some(.ask))
                Text("No").tag(VaultGrant.How?.none)
            }
            .labelsHidden()
            .fixedSize()
        } label: {
            HStack(spacing: 8) {
                icon()
                Text(name)
            }
        }
    }

    private func reveal(_ field: String) {
        Task {
            guard await Passwords.authenticate(reason: "show “\(current.name)”") else { return }
            // Only the one asked for: the others stay hidden.
            do { revealed[field] = try await Vaults.shared.values(of: current, on: box)[field] } catch { trouble = error.localizedDescription }
        }
    }

    private func copyButton(_ value: @escaping () -> String) -> some View {
        Button {
            copy(value())
        } label: { Image(systemName: "doc.on.doc") }
            .buttonStyle(IconButtonStyle(width: 28, height: 24))
            .help("Copy")
    }

    private func copyButton(field: String) -> some View {
        Button {
            Task {
                if let shown = revealed[field] { return copy(shown) }
                guard await Passwords.authenticate(reason: "copy “\(current.name)”") else { return }
                do { if let value = try await Vaults.shared.values(of: current, on: box)[field] { copy(value) } } catch { trouble = error.localizedDescription }
            }
        } label: { Image(systemName: "doc.on.doc") }
            .buttonStyle(IconButtonStyle(width: 28, height: 24))
            .help("Copy")
            .accessibilityLabel("Copy \(label(field))")
    }

    private func copy(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        // Marked concealed, so clipboard managers that respect it don't keep it.
        NSPasteboard.general.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
    }
}

/// Adds an item, or changes one: what it's called, where it's used, and its values. A value left
/// empty while changing stays as it was.
struct VaultItemEditor: View {
    let kind: VaultItem.Kind
    let box: String
    var item: VaultItem?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var sites = ""
    @State private var username = ""
    @State private var secret = ""
    @State private var note = ""
    @State private var readable = false
    /// A sign-in only for signing in, in the browser: new ones are, until you say otherwise.
    @State private var signInOnly = true
    @State private var file: (name: String, data: Data)?
    @State private var extra: [ExtraField] = []
    /// A key's own fields it had, taken away here.
    @State private var removed: Set<String> = []
    @State private var saving = false
    @State private var trouble: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                VaultKindTile(kind: kind, size: 28)
                Text(item == nil ? "New \(kind.title)" : "Edit \(item!.name)").font(.headline)
                Spacer()
            }
            .padding(16)
            Divider()
            ScrollingSettingsForm {
                Section {
                    SettingsTextRow(title: "Name") { TextField("Name", text: $name, prompt: Text(placeholder)).labelsHidden() }
                    if kind == .login || kind == .key {
                        SettingsTextRow(title: kind == .login ? "Site" : "Hosts") {
                            TextField("Sites", text: $sites, prompt: Text(kind == .login ? "github.com" : "api.example.com (optional)")).labelsHidden()
                        }
                    }
                    if kind == .login {
                        SettingsTextRow(title: "Username") { TextField("Username", text: $username, prompt: Text("Email or username")).labelsHidden() }
                        Toggle(isOn: $signInOnly) {
                            Text("Only for Signing In")
                            Text("Agents sign in with it in the browser, and can’t hand it to a command.")
                        }
                    }
                } footer: {
                    if kind == .login { Text("It’s filled in only on this site and those under it.").foregroundStyle(.secondary) }
                }
                Section {
                    switch kind {
                    case .login, .key:
                        SettingsTextRow(title: kind == .login ? "Password" : "Value") {
                            SecureField("Value", text: $secret, prompt: Text(item == nil ? "" : "Unchanged")).labelsHidden()
                        }
                        if kind == .key {
                            ForEach($extra) { $row in
                                HStack {
                                    TextField("Field", text: $row.field, prompt: Text("field_name"))
                                        .frame(width: 120)
                                        .disabled(row.had)
                                    SecureField("Value", text: $row.value, prompt: Text(row.had ? "Unchanged" : ""))
                                    Button {
                                        if row.had { removed.insert(row.field) }
                                        extra.removeAll { $0.id == row.id }
                                    } label: { Image(systemName: "minus.circle") }
                                        .buttonStyle(IconButtonStyle(width: 24, height: 24))
                                        .help("Remove This Field")
                                        .accessibilityLabel("Remove \(row.field.isEmpty ? "this field" : row.field)")
                                }
                            }
                            Button("Add Another Field") { extra.append(ExtraField(field: "", value: "", had: false)) }.buttonStyle(TextButtonStyle())
                        }
                    case .file:
                        LabeledContent(file?.name ?? item?.fileName ?? "No file chosen") {
                            Button("Choose File…", action: chooseFile)
                        }
                    case .note:
                        TextEditor(text: $note)
                            .frame(minHeight: 90)
                            .font(.body)
                            .overlay(alignment: .topLeading) {
                                // Its text isn't read until you ask to see it: typing replaces it.
                                if item != nil, note.isEmpty {
                                    Text("Unchanged. Type here to replace it.")
                                        .foregroundStyle(.tertiary)
                                        .padding(.leading, 5)
                                        .allowsHitTesting(false)
                                }
                            }
                        Toggle(isOn: $readable) {
                            Text("Bots May Read It")
                            Text("For what isn’t a secret, like a contact for App Review.")
                        }
                    }
                }
                if let trouble { Section { Text(trouble).foregroundStyle(.red) } }
            }
            Divider()
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(item == nil ? "Add" : "Save") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!ready || saving)
            }
            .padding(16)
        }
        .frame(width: 480, height: kind == .note ? 460 : 420)
        .onAppear {
            guard let item else { return }
            name = item.name
            sites = item.sites.joined(separator: ", ")
            username = item.username ?? ""
            readable = item.readable == true
            signInOnly = item.signInOnly == true
            if kind == .key { extra = item.fields.filter { $0 != "value" }.map { ExtraField(field: $0, value: "", had: true) } }
        }
    }

    private var placeholder: String {
        switch kind {
        case .login: "GitHub"
        case .key: "App Store Connect API key"
        case .file: "App Store Connect key file"
        case .note: "App Review contact"
        }
    }

    private var ready: Bool {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        if kind == .login, sites.trimmingCharacters(in: .whitespaces).isEmpty { return false }
        guard item == nil else { return true }
        switch kind {
        case .login, .key: return !secret.isEmpty
        case .file: return file != nil
        case .note: return !note.isEmpty
        }
    }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url, let data = try? Data(contentsOf: url), data.count <= 700_000 else {
            if panel.url != nil { trouble = "That file is too big for the vault (at most about 700 KB)." }
            return
        }
        file = (url.lastPathComponent, data)
        if name.isEmpty { name = url.deletingPathExtension().lastPathComponent }
    }

    private func save() {
        var given = VaultDraft(kind: kind, name: name.trimmingCharacters(in: .whitespaces),
                                 sites: sites.split(whereSeparator: { $0 == "," || $0 == " " }).map(String.init).filter { !$0.isEmpty },
                                 username: username.trimmingCharacters(in: .whitespaces).isEmpty ? nil : username.trimmingCharacters(in: .whitespaces),
                                 fileName: file?.name ?? item?.fileName, readable: readable, signInOnly: kind == .login ? signInOnly : nil)
        switch kind {
        case .login: if !secret.isEmpty { given.values["password"] = secret }
        case .key:
            if !secret.isEmpty { given.values["value"] = secret }
            // Taken away first: one added again by the same name keeps its new value.
            for field in removed { given.values[field] = .some(nil) }
            for row in extra where !row.field.isEmpty && !row.value.isEmpty { given.values[row.field.lowercased().replacingOccurrences(of: " ", with: "_")] = row.value }
        case .file: if let file { given.values["file"] = file.data.base64EncodedString() }
        case .note: if !note.isEmpty { given.values["text"] = note }
        }
        saving = true
        Task {
            do {
                if let item { try await Vaults.shared.change(item, to: given, on: box) } else { try await Vaults.shared.add(given, on: box) }
                dismiss()
            } catch {
                trouble = error.localizedDescription
                saving = false
            }
        }
    }
}

/// A key's own field in its editor: one it had (its name fixed, its value Unchanged until typed),
/// or one added here.
private struct ExtraField: Identifiable {
    let id = UUID()
    var field: String
    var value: String
    let had: Bool
}
