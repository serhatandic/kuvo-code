import ClientDesign
import ClientVault
import SwiftUI

/// Edit Bot's Vault: what the bot may use from its computer's vault, and how (on its own, or asking
/// you each time), what more it may use, whether its use is paused, and what it used last. The
/// same grants each item's sheet in Settings › Vault shows (KuvoLink's PROTOCOL.md, "Vault").
struct BotVaultSection: View {
    let bot: Bot
    @Environment(AppModel.self) private var app
    @State private var recent: [VaultActivity] = []
    @State private var trouble: String?

    private var box: String { bot.machine ?? BoxClient.mac }
    private var vault: Vault? { Vaults.shared[box].vault }
    private var own: [(item: VaultItem, how: VaultGrant.How)] {
        guard let vault else { return [] }
        return vault.items.compactMap { item in
            vault.grants(for: item).first { $0.who.bot == bot.id }.map { (item, $0.how) }
        }
    }
    private var others: [VaultItem] { (vault?.items ?? []).filter { item in !own.contains { $0.item.id == item.id } } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let why = vault?.state.pausedBots[bot.id] {
                HStack(alignment: .firstTextBaseline) {
                    Image(systemName: "pause.circle.fill").foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Its use of the vault is paused").font(.body.weight(.medium))
                        Text(why).font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Let Go On") { change { try await Vaults.shared.pause(false, bot: bot.id, on: box) } }
                }
                .padding(10)
                .background(.orange.opacity(0.08), in: .rect(cornerRadius: 10))
            }
            if let note = vault?.state.botAgentsNote {
                // Its computer's commands don't all run sandboxed yet (VaultSettings says the same).
                Label(note, systemImage: "lock")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            WellGroup {
                if own.isEmpty {
                    WellRow { Image(systemName: "lock.shield") } content: {
                        Text(vault != nil ? "Nothing yet. When it needs a sign-in or a key, it asks you." : Vaults.shared[box].failure.map { "Couldn’t read the vault: \($0)" } ?? "Reading the vault…")
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(own, id: \.item.id) { item, how in
                    WellRow { VaultKindTile(kind: item.kind, size: 20, site: item.sites.first) } content: {
                        HStack {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.name).lineLimit(1)
                                Text(item.subtitle).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Picker(item.name, selection: Binding(get: { Optional(how) }, set: { new in grant(item, new) })) {
                                Text("On Its Own").tag(VaultGrant.How?.some(.own))
                                Text("Asks Each Time").tag(VaultGrant.How?.some(.ask))
                                Divider()
                                Text("Remove").tag(VaultGrant.How?.none)
                            }
                            .labelsHidden()
                            .fixedSize()
                        }
                    }
                }
                if !others.isEmpty {
                    WellDivider()
                    HStack {
                        Menu {
                            ForEach(others) { item in
                                Button(item.name) { grant(item, .own) }
                            }
                        } label: {
                            Label("Let It Use…", systemImage: "plus")
                        }
                        .menuStyle(.button)
                        .buttonStyle(TextButtonStyle(outset: true))
                        .menuIndicator(.hidden)
                        .fixedSize()
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
            }
            if !recent.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(recent.prefix(3)) { VaultActivityRow(entry: $0) }
                }
                .font(.callout)
                .padding(.top, 2)
            }
            if let trouble { Text(trouble).font(.callout).foregroundStyle(.red) }
        }
        .task(id: bot.id) {
            await Vaults.shared.refresh(box)
            recent = (try? await Vaults.shared.activity(on: box, bot: bot.id, limit: 3)) ?? []
        }
    }

    private func grant(_ item: VaultItem, _ how: VaultGrant.How?) {
        change {
            guard await Passwords.authenticate(reason: "change what \(bot.name) can use from the vault") else { return }
            try await Vaults.shared.grant(item, to: .init(bot: bot.id), how: how, on: box)
        }
    }

    private func change(_ work: @escaping () async throws -> Void) {
        Task {
            do {
                try await work()
                trouble = nil
            } catch { trouble = error.localizedDescription }
        }
    }
}

/// What a conversation's agent asks of its computer's vault, over its composer: allow it once or
/// always, give it an item, or say no. Its conversation follows the box's asks (`Vaults.follow`):
/// with none, this is nothing, so a task here would never start.
struct VaultAskCards: View {
    /// A conversation's, or a group chat's (its bots' seats').
    var session: String?
    var group: String?
    let box: String

    var body: some View {
        let shown = Vaults.shared[box]
        ForEach(shown.asks.filter { group != nil ? $0.group == group : $0.session == session && $0.group == nil }) { asked in
            VaultAskCard(asked: asked, box: box)
                .modifier(ComposerSurface())
                .transition(.opacity.combined(with: .offset(y: 6)))
        }
    }
}

/// One of them: what it asks of the vault, and the answers.
struct VaultAskCard: View {
    let asked: VaultAsk
    let box: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.shield.fill").foregroundStyle(.tint).font(.title3)
            VaultAskRow(asked: asked, box: box, items: Vaults.shared[box].vault?.items ?? [])
        }
        .padding(14)
    }
}
