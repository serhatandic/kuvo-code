import AppKit
import ClientDesign
import ClientVault
import SwiftUI

/// Vault: what a computer's agents and bots sign in, build and work with, kept on that computer
/// (this Mac's in the Keychain, a machine's in its own encrypted store), filled in or handed to a
/// command without the agent ever seeing a value. Each computer has its own, read and changed
/// through its box (KuvoLink's PROTOCOL.md, "Vault"). An item opens as a sheet: its values (after
/// Touch ID), who may use it, and what it was used for.
struct VaultSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var settingsBox
    @AppStorage(Passwords.offersKey) private var offersToSave = true
    @State private var kind: Filter = .all
    @State private var search = ""
    @State private var opened: VaultItem?
    @State private var adding: VaultItem.Kind?
    @State private var showingActivity = false
    @State private var trouble: String?
    @State private var never: [String] = Passwords.neverSites
    /// The integrations added here with keys of their own, which Integrations still keeps.
    @State private var keyed: [Integrations.Entry] = []

    enum Filter: String, CaseIterable, Identifiable {
        case all = "All", signIns = "Sign-ins", keys = "Keys & Files", notes = "Notes"
        var id: String { rawValue }

        func holds(_ item: VaultItem) -> Bool {
            switch self {
            case .all: true
            case .signIns: item.kind == .login
            case .keys: item.kind == .key || item.kind == .file
            case .notes: item.kind == .note
            }
        }
    }

    private var box: String { settingsBox.machine ?? BoxClient.mac }
    private var shown: Vaults.Shown { Vaults.shared[box] }
    private var computer: String { settingsBox.machine == nil ? "this Mac" : app.name(of: settingsBox) }

    private var items: [VaultItem] {
        (shown.vault?.items ?? []).filter { kind.holds($0) && (search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.subtitle.localizedCaseInsensitiveContains(search)) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        ScrollingSettingsForm {
            if shown.locked {
                Section {
                    HStack(alignment: .firstTextBaseline) {
                        Label("\(computer)’s vault is locked since it started again. Its agents can’t use it until you unlock it.", systemImage: "lock.fill")
                        Spacer()
                        Button("Unlock") { change { try await Vaults.shared.unlock(box) } }
                    }
                }
            } else if let failure = shown.failure, shown.vault == nil {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Couldn’t open \(computer)’s vault").font(.headline)
                        Text(failure).foregroundStyle(.secondary)
                        Button("Try Again") { Task { await Vaults.shared.refresh(box) } }
                    }
                    .padding(.vertical, 4)
                }
            } else if shown.vault == nil {
                Section { ProgressView().controlSize(.small).frame(maxWidth: .infinity) }
            } else {
                content
            }
        }
        .task(id: box) {
            await Vaults.shared.refresh(box)
            keyed = ((try? await app.integrations(on: settingsBox))?.integrations ?? []).filter { $0.added && $0.takesKeys }
            #if DEBUG
            // KUVO_DEMO_VAULT_ITEM: that item's sheet, open (by name).
            if let name = ProcessInfo.processInfo.environment["KUVO_DEMO_VAULT_ITEM"] {
                for _ in 0..<30 where opened == nil {
                    opened = shown.vault?.items.first { $0.name == name }
                    if opened == nil { try? await Task.sleep(for: .seconds(1)); await Vaults.shared.refresh(box) }
                }
            }
            #endif
            await Vaults.shared.follow(box)
        }
        .sheet(item: $opened) { item in
            VaultItemSheet(item: item, box: box, computer: computer)
        }
        .sheet(item: $adding) { kind in
            VaultItemEditor(kind: kind, box: box)
        }
        .sheet(isPresented: $showingActivity) {
            VaultActivitySheet(box: box, computer: computer)
        }
        .alert("That didn’t work", isPresented: Binding(get: { trouble != nil }, set: { if !$0 { trouble = nil } })) {
            Button("OK") {}
        } message: {
            Text(trouble ?? "")
        }
    }

    @ViewBuilder private var content: some View {
        let state = shown.vault?.state ?? VaultState()
        if let failure = shown.failure {
            Section {
                HStack(alignment: .firstTextBaseline) {
                    Label("Couldn’t read the latest from \(computer): \(failure)", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Try Again") { Task { await Vaults.shared.refresh(box) } }
                }
            }
        }
        if shown.rolledBack {
            Section {
                Label("Its files were put back to older copies while it was stopped, so its grants or sites may be ones you changed. Every agent’s use is paused: look over its items, then let them go on.", systemImage: "exclamationmark.octagon.fill")
                    .foregroundStyle(.secondary)
            }
        }
        if let note = state.agentsNote(computer: computer) {
            Section {
                Label(note, systemImage: "lock")
                    .foregroundStyle(.secondary)
            }
        }
        if state.tampered == true {
            Section {
                Label("Its files were changed outside Kuvo Code, so it uses none of them, and every agent’s use is paused. Add its items again.", systemImage: "exclamationmark.octagon.fill")
                    .foregroundStyle(.secondary)
            }
        }

        if !shown.asks.isEmpty {
            Section("Waiting for You") {
                ForEach(shown.asks) { asked in
                    VaultAskRow(asked: asked, box: box, items: shown.vault?.items ?? [])
                }
            }
        }
        Section {
            Picker("Show", selection: $kind) {
                ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if (shown.vault?.items.count ?? 0) > 6 { SettingsSearchRow(text: $search, prompt: "Search the vault") }
            if items.isEmpty {
                Text(shown.vault?.items.isEmpty == true ? "Nothing yet. Add a sign-in, a key, a file or a note for your agents to use." : "None of these.")
                    .foregroundStyle(.secondary)
            }
            ForEach(items) { item in
                Button { opened = item } label: {
                    VaultItemRow(item: item, vault: shown.vault, bots: bots)
                }
                .buttonStyle(ListRowButtonStyle(isSelected: false))
            }
        } header: {
            HStack {
                Text("Items")
                Spacer()
                Menu {
                    ForEach(VaultItem.Kind.allCases, id: \.self) { kind in
                        Button(kind.title + "…") { adding = kind }
                    }
                } label: {
                    Label("Add", systemImage: "plus")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
        } footer: {
            Text(settingsBox.machine == nil
                 ? "Kept in this Mac’s Keychain. Agents fill them in or hand them to a command without ever seeing them, only as you allow."
                 : "Kept on \(computer), encrypted, with a key only your Mac and iPhone hold. Agents fill them in or hand them to a command without ever seeing them, only as you allow. On a machine, its browser runs as you, so a program you or an agent runs there could get an item an agent there may use.")
                .foregroundStyle(.secondary)
        }

        Section {
            Toggle(isOn: Binding(get: { state.paused }, set: { paused in change { try await Vaults.shared.pause(paused, on: box) } })) {
                Text("Pause Agents’ Use")
                Text("Stops every agent on \(computer) from using the vault at once. What they ask still comes to you.")
            }
            ForEach(state.pausedBots.sorted(by: { $0.key < $1.key }), id: \.key) { bot, why in
                LabeledContent {
                    Button("Let Go On") { change { try await Vaults.shared.pause(false, bot: bot, on: box) } }
                } label: {
                    Text("\(bots.first { $0.id == bot }?.name ?? (bot.hasPrefix("bot_") ? "A bot" : "A conversation")) is paused")
                    Text(why)
                }
            }
        }

        Section {
            if shown.activity.isEmpty {
                Text("Nothing used yet.").foregroundStyle(.secondary)
            }
            ForEach(shown.activity.prefix(4)) { entry in
                VaultActivityRow(entry: entry)
            }
        } header: {
            HStack {
                Text("Activity")
                Spacer()
                if !shown.activity.isEmpty {
                    Button("Show All") { showingActivity = true }
                        .buttonStyle(TextButtonStyle())
                }
            }
        }

        if !keyed.isEmpty {
            Section {
                ForEach(keyed) { entry in
                    Button { app.openSettings(.integrations, on: settingsBox) } label: {
                        HStack(spacing: 10) {
                            VaultKindTile(kind: .key)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(entry.title).lineLimit(1)
                                Text((entry.keys ?? []).map(\.label).joined(separator: ", ")).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 4)
                        .padding(.horizontal, 6)
                        .contentShape(.rect)
                        .accessibilityElement(children: .combine)
                    }
                    .buttonStyle(ListRowButtonStyle(isSelected: false))
                    .accessibilityHint("Opens Integrations")
                }
            } header: {
                Text("Integrations’ Keys")
            } footer: {
                Text("Kept and changed in Integrations.")
                    .foregroundStyle(.secondary)
            }
        }

        if settingsBox.machine == nil {
            Section {
                Toggle(isOn: $offersToSave) {
                    Text("Offer to Save Sign-ins")
                    Text("When you sign in to a site in the panel’s browser. Click the key in its toolbar to fill one in.")
                }
                ForEach(never, id: \.self) { host in
                    LabeledContent(host) {
                        Button("Offer Again") {
                            Passwords.setNever(host, false)
                            never = Passwords.neverSites
                        }
                    }
                }
            } header: {
                Text("Panel Browser")
            }
        }
    }

    /// The bots on this computer.
    private var bots: [Bot] { app.bots.list.filter { $0.machine == settingsBox.machine } }

    private func change(_ work: @escaping () async throws -> Void) {
        Task {
            do { try await work() } catch { trouble = error.localizedDescription }
        }
    }
}

/// An item's kind, as a small colored tile; for an item with a site, the site's mark instead,
/// where the app has one, as Passwords shows it.
struct VaultKindTile: View {
    let kind: VaultItem.Kind
    var size: CGFloat = 24
    var site: String?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if let mark = site.flatMap(BrandMark.id(forSite:)) {
            BrandMarkView(mark, size: size * 0.6)
                .foregroundStyle(.primary)
                .frame(width: size, height: size)
                .background(Color.primary.opacity(scheme == .dark ? 0.12 : 0.07), in: .rect(cornerRadius: size * 0.27))
        } else {
            tile
        }
    }

    private var tile: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color.gradient, in: .rect(cornerRadius: size * 0.27))
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch kind {
        case .login: "person.badge.key.fill"
        case .key: "key.horizontal.fill"
        case .file: "doc.fill"
        case .note: "note.text"
        }
    }

    private var color: Color {
        switch kind {
        case .login: .blue
        case .key: .orange
        case .file: .teal
        case .note: .yellow
        }
    }
}

/// An item in the list: what it is, and who may use it.
struct VaultItemRow: View {
    let item: VaultItem
    let vault: Vault?
    let bots: [Bot]

    var body: some View {
        HStack(spacing: 10) {
            VaultKindTile(kind: item.kind, site: item.sites.first)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.name).lineLimit(1)
                Text(item.subtitle).font(.callout).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            let grants = vault?.grants(for: item) ?? []
            let users = bots.filter { bot in grants.contains { $0.who.bot == bot.id } }
            HStack(spacing: -6) {
                ForEach(users.prefix(3)) { bot in BotAvatar(look: bot.look, size: 18, animates: false) }
            }
            VaultWhoPill(grants: grants)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

/// How an item's used, at a glance: on its own or by asking. Nothing where no one may use it,
/// as most items are: the exception is marked, not the rule.
struct VaultWhoPill: View {
    let grants: [VaultGrant]

    var body: some View {
        if !grants.isEmpty {
            let (words, color): (String, Color) = grants.contains { $0.how == .own } ? ("On its own", .green) : ("Asks", .blue)
            pill(words, color)
        }
    }

    private func pill(_ words: String, _ color: Color) -> some View {
        Text(words)
            .font(.caption.weight(.medium))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.13), in: .capsule)
    }
}

/// One line of activity: what happened, and when.
struct VaultActivityRow: View {
    let entry: VaultActivity

    private var symbol: String {
        if entry.isWarning { return "exclamationmark.triangle.fill" }
        switch entry.what {
        case "used": return "key"
        case "asked": return "questionmark.bubble"
        case "allowed", "granted": return "checkmark.circle"
        case "declined", "refused", "ungranted": return "xmark.circle"
        case "added": return "plus.circle"
        case "changed": return "pencil"
        case "removed": return "trash"
        case "shown": return "eye"
        case "paused": return "pause.circle"
        case "resumed": return "play.circle"
        default: return "circle"
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(entry.isWarning ? .orange : .secondary)
                .font(.caption)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.sentence).lineLimit(2)
                Text("\(entry.date, format: .relative(presentation: .named))\(entry.why.map { " · \($0)" } ?? "")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// What an agent waits on you for, with your answers.
struct VaultAskRow: View {
    let asked: VaultAsk
    let box: String
    let items: [VaultItem]
    @State private var trouble: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(asked.title).font(.body.weight(.medium))
            if let why = asked.why { Text(why).foregroundStyle(.secondary) }
            if let trouble { Text(trouble).foregroundStyle(.red).font(.callout) }
            HStack {
                Spacer()
                Button("Don’t Allow") { answer("no") }
                switch asked.kind {
                case .use:
                    if asked.mayAllowAlways {
                        Button("Allow Once") { answer("once") }
                        Button("Always Allow") { answer("always") }.buttonStyle(.borderedProminent)
                    } else {
                        Button("Allow Once") { answer("once") }.buttonStyle(.borderedProminent)
                    }
                case .item:
                    Menu("Give…") {
                        ForEach(items) { item in
                            if asked.mayAllowAlways {
                                Menu(item.name) {
                                    Button("This Once") { answer("once", item) }
                                    Button("From Now On") { answer("always", item) }
                                }
                            } else {
                                Button(item.name) { answer("once", item) }
                            }
                        }
                    }
                    .fixedSize()
                    .disabled(items.isEmpty)
                }
            }
            .controlSize(.small)
        }
        .padding(.vertical, 4)
    }

    private func answer(_ answer: String, _ item: VaultItem? = nil) {
        Task {
            // From now on is a grant, which asks you first, as one made in the item's sheet does.
            if answer == "always", !(await Passwords.authenticate(reason: "let \(asked.asker) use \(item.map { "“\($0.name)”" } ?? asked.itemName.map { "“\($0)”" } ?? "it") from now on")) { return }
            do { try await Vaults.shared.answer(asked, answer, item: item, on: box) } catch { trouble = error.localizedDescription }
        }
    }
}

/// Everything the vault did, newest first.
struct VaultActivitySheet: View {
    let box: String
    let computer: String
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [VaultActivity]?
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Activity on \(computer)").font(.headline)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding()
            Divider()
            if let entries {
                List(entries) { VaultActivityRow(entry: $0) }
                    .overlay { if entries.isEmpty { Text("Nothing yet.").foregroundStyle(.secondary) } }
            } else if let failure {
                VStack(spacing: 8) {
                    Text("Couldn’t read the activity").font(.headline)
                    Text(failure).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Try Again") { Task { await read() } }
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: 520, height: 480)
        .task { await read() }
    }

    private func read() async {
        failure = nil
        do { entries = try await Vaults.shared.activity(on: box, limit: 500) } catch { failure = error.localizedDescription }
    }
}
