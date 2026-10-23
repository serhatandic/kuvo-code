import SwiftUI

/// Edit Bot's keys: for each integration you bring a key for, whether the bot uses one of its
/// own, the shared one or none, and the way to give it its own (see `BotKeys`). A bot on a
/// machine's are on that machine, read as the section opens.
struct BotKeysSection: View {
    let bot: Bot
    /// Opens the key entry for an integration, in the editor's place.
    let edit: (Integrations.Service) -> Void
    @Environment(AppModel.self) private var app
    /// Nil until read; read, or not readable (its machine isn't connected).
    @State private var status: (own: Set<String>, shared: Set<String>)??
    @State private var removing: Set<String> = []
    @State private var failure: String?

    private var own: Set<String> { (status ?? nil)?.own ?? [] }
    private var shared: Set<String> { (status ?? nil)?.shared ?? [] }
    private var isReadable: Bool { (status ?? nil) != nil }
    /// Where it lives, for what's said: this Mac, or its machine.
    private var place: String { bot.machine ?? "this Mac" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WellGroup {
                ForEach(Array(BotKeys.services.enumerated()), id: \.element.id) { index, service in
                    if index > 0 { WellDivider() }
                    row(service)
                }
            }
            if let failure {
                Text(failure)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task(id: bot.id) { await reload() }
        // Its machine connecting (or going): read again.
        .task(id: bot.machine.flatMap { app.machines.engine($0)?.isReady }) { if status != nil { await reload() } }
    }

    /// What its row says of it now.
    private func state(of service: Integrations.Service) -> String {
        switch status {
        case nil: "Checking…"
        case .some(nil): "\(place) isn’t connected, so it can’t be checked now"
        case .some(.some): own.contains(service.id) ? "Its own key" : shared.contains(service.id) ? (bot.machine == nil ? "Your shared key, from Settings › Integrations" : "\(place)’s shared key, from its Settings › Integrations") : "No key"
        }
    }

    private func row(_ service: Integrations.Service) -> some View {
        WellRow(height: 52) {
            Image(systemName: service.symbol)
        } content: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(service.title)
                    Text(state(of: service))
                        .font(.caption)
                        .foregroundStyle(own.contains(service.id) ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                }
                Spacer(minLength: 8)
                if removing.contains(service.id) || status == nil {
                    Spinner(size: 14)
                } else if !isReadable {
                    EmptyView()
                } else if own.contains(service.id) {
                    Menu {
                        Button("Change Key…") { edit(service) }
                        Button("Remove Its Key", role: .destructive) { remove(service) }
                    } label: {
                        HStack(spacing: 4) {
                            Text("Its Key")
                            MenuChevron()
                        }
                    }
                    .menuStyle(.button)
                    .buttonStyle(.glass)
                    // Its own chevron, not the system's beside it too.
                    .menuIndicator(.hidden)
                    .fixedSize()
                } else {
                    Button("Add Its Own Key…") { edit(service) }
                        .buttonStyle(.glass)
                }
            }
        }
    }

    private func reload() async {
        status = .some(await BotKeys.status(of: bot, app: app))
    }

    private func remove(_ service: Integrations.Service) {
        removing.insert(service.id)
        failure = nil
        Task {
            failure = await BotKeys.remove(service, bot: bot, app: app)
            await reload()
            removing.remove(service.id)
        }
    }
}

/// A key of a bot's own for an integration, typed or pasted, kept where the bot lives: in Edit
/// Bot's place.
struct BotKeyEntry: View {
    let service: Integrations.Service
    let bot: Bot
    let done: () -> Void
    @Environment(AppModel.self) private var app
    @State private var values: [String: String] = [:]
    @State private var isSaving = false
    @State private var failure: String?

    private var keys: [Integrations.Key] { Integrations.keys(of: service.way) }

    private var isComplete: Bool {
        keys.allSatisfy { !(values[$0.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private var help: URL? {
        switch service.way {
        case .officialToken(_, _, let help): URL(string: help)
        case .package(_, _, let help, _, _, _): help.flatMap(URL.init(string:))
        default: nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            WellGroup {
                ForEach(Array(keys.enumerated()), id: \.element.name) { index, key in
                    if index > 0 { WellDivider() }
                    WellRow {
                        Image(systemName: "key")
                    } content: {
                        SecureField(key.label, text: Binding(get: { values[key.name] ?? "" }, set: { values[key.name] = $0 }), prompt: Text(key.label + ": " + key.prompt))
                            .textFieldStyle(.plain)
                            .labelsHidden()
                    }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Only \(bot.name)’s conversation uses it: its \(service.title) tools take this key in place of the shared one, and no other bot’s or session’s do. \(bot.machine.map { "It’s kept on \($0), where \(bot.name) lives." } ?? "It stays in your Keychain.")")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let help {
                    Link("Where to get one", destination: help)
                }
                if let failure {
                    Text(failure)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .font(.callout)
            EditorFooter(primary: "Save", canDoPrimary: isComplete, onPrimary: save, onCancel: done, cancelsOnEscape: true, working: isSaving ? "Saving…" : nil)
                .padding(.top, 8)
        }
    }

    private func save() {
        isSaving = true
        failure = nil
        Task {
            failure = await BotKeys.save(values, for: service, bot: bot, app: app)
            isSaving = false
            if failure == nil { done() }
        }
    }
}
