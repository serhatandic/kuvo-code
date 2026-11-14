import ClientAccounts
import ClientDesign
import OpenCodeKit
import SwiftUI

/// Accounts' first sections: what you may already pay for, each signed in as you. The coding
/// agents (Claude Code, Codex, Cursor, Grok, Antigravity) run as their makers built them, on this
/// Mac or a machine, and each signs in to them on its own (picked in their section); the plans
/// (GitHub Copilot, GitLab Duo, Poe, OpenCode) bring their models to Kuvo Code's own agent, signed
/// in to on this Mac or a machine too. A new machine starts with a copy of the keys and of GitHub
/// Copilot's sign-in, then signs in on its own; a sign-in that renews itself can't be shared
/// (AppModel.renewsItself).
///
/// What you use is in a card, a product to a block: its name with what it needs from you on the
/// right (an update), and under it your accounts with it, side by side (none is the main one). The
/// rest are tiles below, to sign in to with a click.
struct SubscriptionsSection: View {
    enum Shows { case agents, plans }
    let shows: Shows
    /// The machine whose they are (nil: this Mac's).
    var machine: MachineEngine?
    /// Opens a sign-in, in the page's place.
    let connect: (Integration) -> Void
    @Environment(Catalog.self) private var catalog
    @Environment(AppModel.self) private var app
    /// The agents shown: this Mac's, or a machine's (`agentsBridge`).
    @Environment(\.agentsBridge) private var bridge
    private var agents: OutsideAgents { bridge ?? app.agents }
    /// The computer whose page this is.
    @Environment(\.settingsBox) private var box
    @Environment(\.colorScheme) private var scheme
    /// Another account asked of a product, from the header's Add Account menu.
    @State private var addRequest: AddRequest?
    /// Why Update All couldn't be asked of this page's computer.
    @State private var updateAllFailure: String?

    struct AddRequest: Equatable {
        let product: String
        private let asked = UUID()
        init(_ product: String) { self.product = product }
    }

    var body: some View {
        let products = self.products
        let used = products.filter(\.hasAccounts)
        let more = products.filter { !$0.hasAccounts }
        if shows == .agents || !products.isEmpty { section(used: used, more: more) }
    }

    private func section(used: [Product], more: [Product]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(shows == .agents ? "Coding Agents" : "Plans")
                        .font(.headline)
                    Text(subtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                // Another account of one you use, once here rather than on each.
                if !used.isEmpty, shows == .plans || machine.map(isRunning) != false {
                    Menu {
                        ForEach(used) { product in
                            Button(product.title + "…") { addRequest = AddRequest(product.id) }
                                .disabled(product.isAgent && (agents.api == nil || agents.addingAccount.contains(product.main.metadata?["agent"]?.string ?? "")))
                        }
                    } label: {
                        Label("Add Account", systemImage: "plus")
                            .font(.callout)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help(shows == .agents ? "Another account, signed in on its own: each shows in the model picker" : "Another account: the engine uses one at a time")
                }
                // Only while its agents show: a machine's that aren't running show none.
                if shows == .agents, !updatable.isEmpty, machine.map(isRunning) != false {
                    Button(action: updateAll) {
                        Label("Update All", systemImage: "arrow.down.circle")
                            .font(.callout)
                            .fixedSize()
                    }
                    .buttonStyle(TextButtonStyle())
                    .help("Updates \(updatable.formatted(.list(type: .and))), each through the installer that owns it")
                }
                if shows == .agents {
                    // You installed one or signed in to one elsewhere: asked anew (so is
                    // everything when you come back to the app).
                    Button {
                        Task { await catalog.refreshAgents(fresh: true) }
                    } label: {
                        if catalog.isRefreshingAgents {
                            Spinner(size: 13)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 13, weight: .medium))
                        }
                    }
                    .buttonStyle(IconButtonStyle(width: 28, height: 26))
                    .disabled(catalog.isRefreshingAgents || agents.api == nil)
                    .accessibilityLabel("Refresh")
                    .help("Check again which agents are installed and signed in")
                }
            }
            if shows == .agents, let machine, !isRunning(machine) {
                unavailable(machine)
            } else {
                if shows == .agents, let failure = agents.failure, catalog.codingAgents.isEmpty {
                    ErrorCard(message: "The coding agents couldn't start. \(failure)")
                } else if shows == .agents, catalog.codingAgents.isEmpty {
                    HStack(spacing: 8) {
                        Spinner(size: 14)
                        Text("Looking for your coding agents…")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }
                if !used.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(used) { product in
                            ProductBlock(product: product, connect: connect, addRequest: addRequest)
                            if product.id != used.last?.id {
                                Divider().padding(.leading, 58)
                            }
                        }
                    }
                    .background(SettingsMetrics.groupFill(scheme), in: .rect(cornerRadius: SettingsMetrics.groupRadius))
                }
                if !more.isEmpty {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), spacing: 10)], spacing: 10) {
                        ForEach(more) { product in
                            SubscriptionTile(product: product, connect: connect)
                        }
                    }
                    .padding(.top, used.isEmpty ? 0 : 4)
                }
            }
        }
        .task(id: agents.api != nil) {
            if shows == .agents { await catalog.refreshAgents(fresh: true) }
        }
        // How an update went is news while you're here, not the next time you look.
        .onDisappear { if shows == .agents { agents.forgetUpdates(catalog.codingAgents) } }
        .alert("Couldn't Update All", isPresented: Binding(get: { updateAllFailure != nil }, set: { if !$0 { updateAllFailure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(updateAllFailure ?? "")
        }
    }

    /// What Update All updates, on this page's computer, as its box picks it; each shows how it
    /// goes on its row or tile.
    private var updatable: [String] {
        app.outdatedAgents(on: box).map { OutsideAgents.name($0.id) }
    }

    private func updateAll() {
        let app = app, box = box
        Task {
            do { try await app.updateAllAgents(on: box) } catch { updateAllFailure = error.localizedDescription }
        }
    }

    private var subtitle: String {
        switch shows {
        case .agents:
            if let machine { return "Signed in on \(machine.machine.name) on its own. Signing in finishes in your browser here." }
            return app.machines.list.isEmpty ? "Sign in with a plan or account you already have." : "Sign in with a plan or account you already have. Each of your machines signs in to these on its own."
        case .plans:
            if let machine { return "Their models, in Kuvo Code's own agent on \(machine.machine.name), which signs in on its own." }
            return app.machines.list.isEmpty ? "Their models, in Kuvo Code's own agent." : "Their models, in Kuvo Code's own agent. Each of your machines signs in to these on its own."
        }
    }

    private func isRunning(_ engine: MachineEngine) -> Bool {
        engine.isReady && engine.agents.api != nil && !engine.agents.isDown
    }

    /// A machine whose agents can't be asked now: why. Away, the page's bar says so and connects
    /// it; its agents aren't kept as last seen (they're asked afresh each time).
    @ViewBuilder private func unavailable(_ engine: MachineEngine) -> some View {
        if engine.isReady {
            ErrorCard(message: "The coding agents aren’t running on \(engine.machine.name). They start with its engine: when nothing runs there, stop its engine in Settings › Machines and start it again.")
        } else {
            Text("Its coding agents show here once it’s connected.")
                .foregroundStyle(.secondary)
                .padding(.vertical, 6)
        }
    }

    /// In a fixed order: the coding agents, then the plans.
    private var products: [Product] {
        var all: [Product] = []
        for base in OutsideAgents.order where shows == .agents {
            let accounts = catalog.codingAgents.filter { OutsideAgents.base($0.id) == base }
            guard let own = accounts.first(where: { OutsideAgents.account($0.id) == nil }) else { continue }
            let added = accounts.filter { OutsideAgents.account($0.id) != nil }
            all.append(Product(kind: .agent(own: own, added: added)))
        }
        for id in Catalog.planProviders where shows == .plans {
            guard let plan = catalog.providers.first(where: { $0.id == id }) else { continue }
            all.append(Product(kind: .plan(plan)))
        }
        return all
    }
}

/// A coding agent with your accounts with it, or a plan the engine signs in to.
struct Product: Identifiable {
    enum Kind {
        /// The agent's own sign-in (where its command-line tool keeps it), and the ones you added.
        case agent(own: Integration, added: [Integration])
        case plan(Integration)
    }

    let kind: Kind

    var id: String {
        switch kind {
        case .agent(let own, _): own.id
        case .plan(let plan): plan.id
        }
    }

    /// What its name, mark and actions read from: an agent's own sign-in, or the plan.
    var main: Integration {
        switch kind {
        case .agent(let own, _): own
        case .plan(let plan): plan
        }
    }

    var isAgent: Bool {
        if case .agent = kind { return true }
        return false
    }

    var title: String { isAgent ? OutsideAgents.name(main.id) : main.name }
    var logo: String { isAgent ? OutsideAgents.logo(main.id) : main.id }

    var hasAccounts: Bool {
        switch kind {
        case .agent(let own, let added): own.isListed || !added.isEmpty
        case .plan(let plan): plan.isConnected
        }
    }
}

extension Integration {
    /// An agent's own sign-in shows among your accounts while it's signed in, and once its sign-in
    /// has ended (to sign in again); never signed in, it's the product's Sign In.
    var isListed: Bool { isConnected || metadata?["signInEnded"]?.bool == true }
}

// MARK: A product

private struct ProductBlock: View {
    let product: Product
    let connect: (Integration) -> Void
    /// The header's Add Account menu asked for another account: this product's, when it names it.
    var addRequest: SubscriptionsSection.AddRequest?
    @Environment(AppModel.self) private var app
    /// The agents shown: this Mac's, or a machine's (`agentsBridge`).
    @Environment(\.agentsBridge) private var bridge
    private var agents: OutsideAgents { bridge ?? app.agents }
    @Environment(Catalog.self) private var catalog
    /// Naming an account you're adding (an agent's: each gets a folder and a name of its own).
    @State private var naming = false
    @State private var name = ""
    @State private var failure: String?
    /// Why its update couldn't be asked of its computer (how one goes is its box's).
    @State private var updateRefused: String?

    private var main: Integration { product.main }
    private var isAgent: Bool { product.isAgent }
    private var title: String { product.title }
    private var isInstalled: Bool { main.metadata?["installed"]?.bool ?? true }
    private var installCommand: String? { main.metadata?["install"]?.string }
    private var version: String? { main.metadata?["version"]?.string }
    private var latest: String? { main.metadata?["outdated"]?.bool == true ? main.metadata?["latestVersion"]?.string : nil }
    private var updates: Bool { main.metadata?["updates"]?.bool == true }
    private var updateCommand: String? { main.metadata?["updateCommand"]?.string }
    private var updateFailure: String? { updateRefused ?? agents.updateFailure(main) }
    private var isInstalling: Bool { agents.installing.contains(main.id) }
    private var installFailure: String? { agents.installFailures[main.id] }

    var body: some View {
        VStack(alignment: .leading, spacing: action == nil ? 0 : 6) {
            // The actions beside the name; in a narrow window, under it, lined up with the name
            // and the accounts; and one above the other when they don't fit side by side there
            // either, where what's still too long is cut short. With none, the accounts sit right
            // under the name, as one item.
            if let action {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 14) {
                        heading
                        Spacer(minLength: 12)
                        actions(action, AnyLayout(HStackLayout(spacing: 10)))
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        heading
                        actions(action, AnyLayout(HStackLayout(spacing: 10)), isUnder: true)
                            .padding(.leading, Self.indent)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        heading
                        actions(action, AnyLayout(VStackLayout(alignment: .leading, spacing: 4)), isUnder: true, truncates: true)
                            .padding(.leading, Self.indent)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                heading
            }
            VStack(alignment: .leading, spacing: 0) {
                switch product.kind {
                case .agent(let own, let added):
                    if own.isListed { AgentAccountRow(account: own, connect: { connect(own) }) }
                    ForEach(added) { account in
                        AgentAccountRow(account: account, connect: { connect(account) })
                    }
                case .plan(let plan):
                    ForEach(Array(plan.connections.enumerated()), id: \.element.id) { index, connection in
                        PlanAccountRow(plan: plan, connection: connection, isInUse: index == 0, isOnly: plan.connections.count == 1, connect: { connect(plan) })
                    }
                }
            }
            // Under the product's name.
            .padding(.leading, Self.indent)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .onChange(of: addRequest) { _, request in
            if request?.product == product.id { addAccount() }
        }
        .alert("Add Another \(title) Account", isPresented: $naming) {
            TextField("Name, like Work or Personal", text: $name)
            Button("Add") { addNamed() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It signs in on its own, and its models show in the model picker apart from your other \(title) accounts.")
        }
        .alert("Couldn't Add the Account", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
        .alert("Couldn't Update \(title)", isPresented: Binding(get: { updateFailure != nil }, set: { if !$0 { dismissUpdateFailure() } })) {
            if let updateCommand {
                Button("Copy Command") { Clipboard.copy(updateCommand) }
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text(updateFailure ?? "")
        }
        .alert("Couldn't Install \(title)", isPresented: Binding(get: { installFailure != nil }, set: { if !$0 { agents.installFailures[main.id] = nil } })) {
            if let installCommand {
                Button("Copy Command") { Clipboard.copy(installCommand) }
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text(installFailure ?? "")
        }
    }

    /// Where the name starts: past the mark's column and the space after it.
    private static let indent: CGFloat = 46

    /// Its mark and name.
    private var heading: some View {
        HStack(spacing: 14) {
            // As tall as the name, the mark beside it: the accounts under the name read as its
            // second line, not a row of their own.
            ProviderLogo(id: product.logo, size: 22)
                .frame(width: 32, height: 16)
            Text(title)
                .font(.body.weight(.medium))
                .lineLimit(1)
                .help(version.map { "Version \($0)" } ?? "")
        }
    }

    /// What it needs from you, if anything: installing again, or an update.
    private enum Action {
        case installing, install(command: String), updating, update(to: String), updated(String)
        /// Asked to update, it was already on the newest.
        case current
    }

    private var action: Action? {
        if isInstalling { return .installing }
        if isAgent, !isInstalled, let installCommand { return .install(command: installCommand) }
        switch agents.updateStatus(main) {
        case .updating: return .updating
        case .available(let latest): return .update(to: latest)
        case .updated(let version): return .updated(version)
        case .current: return .current
        // Not updated: its update offered again, if there still is one.
        case .failed, nil: return latest.map(Action.update)
        }
    }

    /// What it needs from you, on the product's line: installing again, or an update; and another
    /// account. Under the name (`isUnder`), the buttons' words line up with it, as the plain
    /// words do.
    private func actions(_ action: Action, _ layout: AnyLayout, isUnder: Bool = false, truncates: Bool = false) -> some View {
        layout {
            switch action {
            case .installing:
                HStack(spacing: 6) {
                    Spinner(size: 12)
                    Text("Installing…")
                        .font(.callout)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                }
            case .install(let installCommand):
                Button(action: install) {
                    Label("Install", systemImage: "arrow.down.circle")
                        .font(.callout)
                        .lineLimit(1)
                }
                .buttonStyle(TextButtonStyle(outset: isUnder))
                .disabled(agents.api == nil)
                .help("It isn't installed. Runs \(installCommand), its maker's installer.")
            case .updating:
                HStack(spacing: 6) {
                    Spinner(size: 12)
                    Text("Updating…")
                        .font(.callout)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                }
            case .updated(let version):
                Label("Updated to \(version)", systemImage: "checkmark.circle")
                    .font(.callout)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            case .current:
                Label("Up to date", systemImage: "checkmark.circle")
                    .font(.callout)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            case .update(let latest):
                if updates {
                    Button(action: update) {
                        Label("Update to \(latest)", systemImage: "arrow.down.circle")
                            .font(.callout)
                            .lineLimit(1)
                    }
                    .buttonStyle(TextButtonStyle(outset: isUnder))
                    .help("You have \(version ?? "an older version"). Newer models may need the newer version. Runs \(updateCommand ?? "its update").")
                } else {
                    Text("\(latest) is out")
                        .font(.callout)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                        .help("You have \(version ?? "an older version"). Update it the way you installed it.")
                }
            }
        }
        // Each on one line: the row puts them under the name when they don't fit beside it, and
        // cuts them short only when nothing else fits.
        .fixedSize(horizontal: !truncates, vertical: true)
    }

    // MARK: Doing

    /// Another account: an agent's own sign-in first, while it has none; then one with a name and
    /// a folder of its own. A plan's: the engine signs in to another.
    private func addAccount() {
        guard isAgent else { return connect(main) }
        if !main.isListed, main.metadata?["installed"]?.bool != false { return connect(main) }
        name = ""
        naming = true
    }

    private func addNamed() {
        guard let kind = main.metadata?["agent"]?.string else { return }
        let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                guard let providerID = try await agents.addAccount(agent: kind, label: label) else { return }
                // Listed at once (nothing to check anew): its sign-in opens without waiting on the others'.
                await catalog.refreshAgents()
                if let added = catalog.codingAgents.first(where: { $0.id == providerID }) {
                    connect(added)
                } else {
                    failure = "It was added, but the accounts couldn’t be listed just now. Sign in to it once it shows."
                }
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    private func update() {
        let catalog = catalog, agents = agents, main = main
        Task {
            do { try await agents.update(main) { await catalog.refreshAgents() } } catch { updateRefused = error.localizedDescription }
        }
    }

    private func dismissUpdateFailure() {
        if updateRefused != nil { updateRefused = nil } else { agents.dismissUpdateFailure(main) }
    }

    private func install() {
        let catalog = catalog
        agents.install(main.id) { _ in await catalog.refreshAgents(fresh: true) }
    }
}

/// A product you haven't signed in to: a click signs in (an agent that isn't installed, installed
/// first with its maker's installer). The same tile as the page's popular providers.
private struct SubscriptionTile: View {
    let product: Product
    let connect: (Integration) -> Void
    @Environment(AppModel.self) private var app
    /// The agents shown: this Mac's, or a machine's (`agentsBridge`).
    @Environment(\.agentsBridge) private var bridge
    private var agents: OutsideAgents { bridge ?? app.agents }
    @Environment(Catalog.self) private var catalog
    @Environment(\.colorScheme) private var scheme
    @State private var isHovering = false

    private var installCommand: String? {
        guard product.isAgent, product.main.metadata?["installed"]?.bool == false else { return nil }
        return product.main.metadata?["install"]?.string
    }

    private var isInstalling: Bool { agents.installing.contains(product.main.id) }
    private var installFailure: String? { agents.installFailures[product.main.id] }
    /// Its program's update (Update All updates one you haven't signed in to too).
    private var update: OutsideAgents.UpdateStatus? { product.isAgent ? agents.updateStatus(product.main) : nil }

    private var hint: String {
        if isInstalling { return "Installing…" }
        if installCommand != nil { return "Installs, then signs in" }
        switch update {
        case .updating: return "Updating…"
        case .updated(let version): return "Updated to \(version)"
        case .current: return "Up to date"
        case .failed: return "Couldn't update"
        case .available(let latest): return "\(latest) is out"
        case nil: return product.isAgent ? "Coding agent" : "Your plan's models"
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            ProviderLogo(id: product.logo, size: 18)
                .frame(width: 32, height: 32)
                .background(Surface.well(scheme), in: .rect(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 1) {
                Text(product.title)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                Text(hint)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if isInstalling || update == .updating { Spinner(size: 12) }
        }
        .padding(10)
        .background(SettingsMetrics.groupFill(scheme), in: .rect(cornerRadius: SettingsMetrics.groupRadius))
        // Under the pointer, an accent edge: the whole tile signs in.
        .overlay {
            RoundedRectangle(cornerRadius: SettingsMetrics.groupRadius)
                .strokeBorder(.tint, lineWidth: 1.5)
                .opacity(isHovering ? 1 : 0)
        }
        .contentShape(.rect)
        .onTapGesture(perform: open)
        .onHover { hovering in withAnimation(.easeOut(duration: 0.15)) { isHovering = hovering } }
        .pointerStyle(.link)
        .help(installCommand.map { "Runs \($0), its maker's installer, then signs in" } ?? product.main.metadata?["message"]?.string ?? "Sign in to \(product.title)")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(.default, open)
        // Installed from the first launch after you'd gone on: the sign-in that would have
        // followed there.
        .task(id: installCommand == nil) {
            guard installCommand == nil, agents.signInsAfterInstall.remove(product.main.id) != nil else { return }
            connect(product.main)
        }
        .alert("Couldn't Install \(product.title)", isPresented: Binding(get: { installFailure != nil }, set: { if !$0 { agents.installFailures[product.main.id] = nil } })) {
            if let installCommand {
                Button("Copy Command") { Clipboard.copy(installCommand) }
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text(installFailure ?? "")
        }
        .alert("Couldn't Update \(product.title)", isPresented: Binding(get: { agents.updateFailure(product.main) != nil }, set: { if !$0 { agents.dismissUpdateFailure(product.main) } })) {
            if let command = product.main.metadata?["updateCommand"]?.string {
                Button("Copy Command") { Clipboard.copy(command) }
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text(agents.updateFailure(product.main) ?? "")
        }
    }

    private func open() {
        if isInstalling || (product.isAgent && agents.api == nil) { return }
        guard installCommand != nil else { return connect(product.main) }
        // Installed, it signs in as it is now.
        let catalog = catalog
        let id = product.main.id
        let connect = connect
        agents.install(id) { installed in
            await catalog.refreshAgents(fresh: true)
            if installed, let agent = catalog.codingAgents.first(where: { $0.id == id }) { connect(agent) }
        }
    }
}

// MARK: Accounts

/// One of your accounts with an agent: who it is, the name you gave it, and what you can do with
/// it. Its own sign-in (the agent's, shared with its tool in Terminal) and the ones you added sit
/// side by side.
private struct AgentAccountRow: View {
    let account: Integration
    let connect: () -> Void
    @Environment(AppModel.self) private var app
    /// The agents shown: this Mac's, or a machine's (`agentsBridge`).
    @Environment(\.agentsBridge) private var bridge
    private var agents: OutsideAgents { bridge ?? app.agents }
    @Environment(Catalog.self) private var catalog
    @State private var renaming = false
    @State private var name = ""
    @State private var confirmsRemove = false
    @State private var failure: String?

    private var isAdded: Bool { OutsideAgents.account(account.id) != nil }
    private var label: String? { account.metadata?["accountLabel"]?.string }
    private var agentName: String { OutsideAgents.name(account.id) }
    /// Who's signed in, as the agent says: "you@example.com · Max plan".
    private var who: String? { account.connections.first?.label }
    private var signsOut: Bool { account.metadata?["signsOut"]?.bool ?? false }
    /// Its maker ended the sign-in.
    private var ended: Bool { account.metadata?["signInEnded"]?.bool == true }

    /// The command-line tool that shares the agent's own sign-in.
    private var tool: String? {
        switch OutsideAgents.base(account.id) {
        case "claude-code": "claude"
        case "codex-cli": "codex"
        case "grok-cli": "grok"
        default: nil
        }
    }

    /// Custom Auto holds it back at its usage limit.
    private var limit: Date? { account.isConnected ? agents.auto.limit(for: account.id) : nil }

    var body: some View {
        AccountLine(label: label, who: account.isConnected ? (who ?? "Signed in") : nil,
                    note: account.isConnected || ended ? nil : "Not signed in",
                    problem: ended ? AccountProblem.signInEnded.text : limit.map { AccountProblem.atLimit(until: $0).text },
                    signIn: account.isConnected ? nil : connect) {
            HeldRow.button("Sign In Again…", action: connect)
            agentsUseResetsRow(account.id, machine: catalog.machine, app: app, failure: $failure)
            if isAdded {
                HeldRow.button("Rename…") {
                    name = label ?? ""
                    renaming = true
                }
                HeldRow.divider
                HeldRow.button("Remove Account…", role: .destructive) { confirmsRemove = true }
            } else if signsOut {
                HeldRow.divider
                HeldRow.button("Sign Out", role: .destructive, action: signOut)
            } else if let tool {
                HeldRow.divider
                // Why it can't be removed here: it's the agent's own.
                HeldRow.note("Shared with \(tool) in Terminal")
            }
        }
        .alert("Rename This Account", isPresented: $renaming) {
            TextField("Name, like Work or Personal", text: $name)
            Button("Rename") { rename() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The name it goes by here and in the model picker.")
        }
        .alert("Remove \(account.name)?", isPresented: $confirmsRemove) {
            Button("Remove", role: .destructive) { remove() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Kuvo Code signs it out and forgets it. Sessions on its models go on when you pick another model.")
        }
        .alert("Couldn't Change This Account", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
    }

    private func rename() {
        let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                try await agents.renameAccount(account.id, label: label)
                await catalog.refreshAgents()
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    private func remove() {
        Task {
            do {
                try await agents.removeAccount(account.id)
                await catalog.refreshAgents()
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    private func signOut() {
        Task {
            do {
                try await agents.signOut(account.id)
                await catalog.refreshAgents()
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}

/// One of your accounts with a plan the engine signs in to: the engine uses one at a time.
private struct PlanAccountRow: View {
    let plan: Integration
    let connection: Integration.Connection
    let isInUse: Bool
    let isOnly: Bool
    let connect: () -> Void
    @Environment(AppModel.self) private var app
    /// The agents shown: this Mac's, or a machine's (`agentsBridge`).
    @Environment(\.agentsBridge) private var bridge
    private var agents: OutsideAgents { bridge ?? app.agents }
    /// Where it's signed in: this Mac's engine, or a machine's.
    @Environment(Catalog.self) private var catalog
    @State private var failure: String?
    @State private var refreshFailure: String?
    @State private var refreshWaits = false

    private var box: SidebarBox { catalog.machine.map { .machine($0) } ?? .mac }

    /// Its sign-in ended: the engine says so, or a run was refused it (the one in use).
    private var needsSignIn: Bool {
        connection.status?.status == "needs_auth" || (isInUse && catalog.hasEndedSignIn(plan.id))
    }

    private var who: String {
        if connection.type == "env" { return "From \(connection.name ?? "the environment")" }
        return connection.label ?? (connection.method == "key" ? "API key" : "Signed in")
    }

    /// The one in use, held back by Custom Auto at its usage limit.
    private var limit: Date? { isInUse && !needsSignIn ? agents.auto.limit(for: plan.id) : nil }

    var body: some View {
        AccountLine(label: nil, who: needsSignIn ? nil : who, note: isInUse && refreshWaits ? refreshWaitsNote : nil,
                    problem: needsSignIn ? AccountProblem.signInEnded.text : limit.map { AccountProblem.atLimit(until: $0).text },
                    signIn: needsSignIn ? connect : nil,
                    badge: isInUse && !isOnly ? "In use" : nil,
                    isWorking: isInUse && catalog.refreshingModels[plan.id] != nil) {
            if connection.type == "credential" {
                if isInUse { agentsUseResetsRow(plan.id, machine: catalog.machine, app: app, failure: $failure) }
                if !isInUse, let id = connection.credentialID {
                    HeldRow.button("Use This Account") {
                        change { try await app.reachableAPI(for: box).activateCredential(id) }
                        app.releaseLimit(plan.id)
                    }
                }
                HeldRow.button("Sign In Again…", action: connect)
                // The engine reads the models of the account in use.
                if isInUse { refreshModelsRow(plan.id, catalog: catalog, failure: $refreshFailure, waits: $refreshWaits) }
                HeldRow.divider
                HeldRow.button("Remove Account", role: .destructive, action: remove)
            } else {
                HeldRow.note("Set in your shell's environment")
                if isInUse, catalog.refreshesModels(plan.id) {
                    HeldRow.divider
                    refreshModelsRow(plan.id, catalog: catalog, failure: $refreshFailure, waits: $refreshWaits)
                }
            }
        }
        .alert("Couldn't Change This Account", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
        .refreshModelsFailure($refreshFailure)
    }

    /// Removes the account from the computer it's on: with it the last, that computer is signed
    /// out of the plan.
    private func remove() {
        guard let id = connection.credentialID else { return }
        let accounts = plan.connections.filter { $0.type == "credential" }
        change {
            if catalog.machine == nil, accounts.count <= 1 {
                try await app.forgetSignIn(plan.id)
            } else {
                try await app.reachableAPI(for: box).removeCredential(id)
            }
        }
    }

    /// Why one didn't work, in its alert.
    private func change(_ work: @escaping () async throws -> Void) {
        Task {
            do {
                try await work()
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}

/// An account's line: the name you gave it, who's signed in, a note when it's in use, and its
/// menu at the right edge, where every account's is. Not signed in, it says so, with Sign In;
/// a sign-in that ended says so in orange.
private struct AccountLine: View {
    let label: String?
    let who: String?
    /// How it stands, quietly: "Not signed in".
    let note: String?
    let problem: String?
    let signIn: (() -> Void)?
    var badge: String? = nil
    /// Refresh Models under way: a spinner in the menu's place.
    var isWorking = false
    @HeldRows let menu: () -> [HeldRow]

    var body: some View {
        HStack(spacing: 8) {
            if let label, !label.isEmpty {
                Text(label)
                    .font(.callout.weight(.medium))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Color.primary.opacity(0.08), in: .capsule)
            }
            if let who {
                Text(who)
                    .font(.callout)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
            if let note {
                Text(note)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let problem {
                Text(problem)
                    .font(.callout)
                    .foregroundStyle(.orange)
            }
            if let badge {
                Text(badge)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if let signIn {
                Button("Sign In", action: signIn)
                    .buttonStyle(.glass)
                    .controlSize(.small)
            }
            // Always there, in quiet ink, as System Settings has it: the line itself doesn't change
            // under the pointer. Right-click has the same.
            if isWorking {
                Spinner(size: 13)
                    .frame(width: 26, height: 22)
                    .accessibilityLabel("Refreshing models")
            } else {
                Menu {
                    HeldMenuContent(rows: menu())
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 22, height: 22)
                        .contentShape(.rect)
                }
                .menuStyle(.button)
                .buttonStyle(IconButtonStyle(width: 26, height: 22))
                .menuIndicator(.hidden)
                .fixedSize()
                .accessibilityLabel("More")
                .help("More")
            }
        }
        .frame(minHeight: 30)
        .contentShape(.rect)
        .heldContextMenu(menu)
    }
}

/// Always Allow for an account's rate-limit resets (Claude's reset grants, Codex's reset
/// credits), where its box says it has them: checked, agents use them without asking first (each use
/// still shows in its conversation); unchecked, every use asks on the card. Kept with the account on
/// the box whose page this is (`kuvo/agents/api/kuvo/limits/reset/always`).
@MainActor @HeldRows func agentsUseResetsRow(_ provider: String, machine: String?, app: AppModel, failure: Binding<String?>) -> [HeldRow] {
    if let resets = app.planLimits.resets(of: provider, on: machine) {
        HeldRow.button("Agents Use Resets Without Asking", checked: resets.agents,
                       help: resets.agents ? "Agents use this account's rate-limit resets without asking. Each use still shows in its conversation." : "Agents ask before they use one of this account's rate-limit resets.") {
            Task {
                do {
                    try await app.planLimits.setAgentsUseResets(!resets.agents, provider: provider, machine: machine)
                } catch {
                    failure.wrappedValue = error.localizedDescription
                }
            }
        }
    }
}

/// Refresh Models, in the menu of the account in use: its provider's models asked of again on the
/// computer whose page this is, without restarting its engine (the box's
/// `kuvo/accounts/<provider>/refresh`); a model the account gained shows in the model pickers once
/// it's done. Only for the providers that computer's box brings new models to.
/// `waits`: some of that computer's projects get them only once their work is done.
@HeldRows func refreshModelsRow(_ provider: String, catalog: Catalog, failure: Binding<String?>, waits: Binding<Bool>) -> [HeldRow] {
    if catalog.refreshesModels(provider) {
        HeldRow.button("Refresh Models", disabled: catalog.refreshingModels[provider] != nil) {
            Task {
                do { waits.wrappedValue = try await catalog.refreshModels(provider) } catch { failure.wrappedValue = error.localizedDescription }
            }
        }
    }
}

/// What the account's line says after Refresh Models, while some projects wait for their work.
let refreshWaitsNote = "Projects at work get new models when done"

extension View {
    /// Why Refresh Models didn't go, in an alert of its own.
    func refreshModelsFailure(_ failure: Binding<String?>) -> some View {
        alert("Couldn't Refresh Models", isPresented: Binding(get: { failure.wrappedValue != nil }, set: { if !$0 { failure.wrappedValue = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure.wrappedValue ?? "")
        }
    }
}

extension EnvironmentValues {
    /// The coding agents Accounts shows and signs in to: this Mac's (nil), or a machine's.
    @Entry var agentsBridge: OutsideAgents? = nil
}
