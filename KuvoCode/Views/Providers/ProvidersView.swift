import ClientAccounts
import ClientDesign
import OpenCodeKit
import SwiftUI

/// Accounts, a page of Settings, on each computer: what's connected there, the popular providers,
/// and every other one its engine knows. The list comes from the engine, so it grows without app
/// updates. Signing in to a provider, or setting up one of your own, opens in the page's place,
/// and is that computer's own.
struct ProvidersView: View {
    @Environment(Catalog.self) private var catalog
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(\.colorScheme) private var scheme
    @Environment(\.settingsInset) private var inset
    @State private var connecting: Connecting?
    /// One of your own providers, open in the page's place.
    @State private var editing: ProviderEdit?
    /// What to remove once its editor has closed (and its fields are done saving).
    @State private var removal: [String]?
    /// Why a removed provider's key couldn't go with it.
    @State private var removalFailure: String?
    @State private var search = ""

    /// The machine whose accounts these are, on a machine's tab.
    private var machine: MachineEngine? { app.machines.engine(box.machine) }

    /// A machine that isn't connected: what's shown is as last seen, and can't change until it's
    /// back.
    private var away: MachineEngine? { machine.flatMap { $0.isReady ? nil : $0 } }

    /// This Mac's engine stopped (a machine's says so as it's away).
    private var engineIsDown: Bool { box.machine == nil && app.engineIsDown }

    /// Under the away bar: as of when, and that nothing changes meanwhile.
    static func asLastSeen(_ read: Date?, now: Date = .now, locale: Locale = .current) -> String {
        let ago = RelativeDateTimeFormatter()
        ago.dateTimeStyle = .named
        ago.locale = locale
        let when = read.map { now.timeIntervalSince($0) < 60 ? ", a moment ago" : ", " + ago.localizedString(for: $0, relativeTo: now) } ?? ""
        return "These are its accounts as last seen\(when). They can’t change until it’s back."
    }

    /// A sign-in, open in the page's place, on the computer it's for.
    struct Connecting: Identifiable {
        let integration: Integration
        var machine: String?
        var id: String { (machine ?? "") + "/" + integration.id }
    }

    var body: some View {
        page
            // The page's way back is the way out, so no Cancel in the steps. (On a machine, its
            // own sign-in, finishing in this Mac's browser.)
            .settingsDetail(item: $connecting, title: { _ in nil }) { item in
                let engine = item.machine.flatMap { app.machines.engine($0) }
                ConnectView(integrationID: item.integration.id, onDone: {
                    withAnimation(.ui) { connecting = nil }
                })
                .environment(engine?.catalog ?? catalog)
                .environment(\.agentsBridge, engine?.agents)
            }
            .settingsDetail(item: $editing, title: { _ in "New Provider" }, onDismiss: removePending) { edit in
                CustomProviderEditor(id: edit.providerID) { editing = nil } remove: { path in
                    removal = path
                    editing = nil
                }
            }
            .alert("Couldn't Remove Its Key", isPresented: Binding(get: { removalFailure != nil }, set: { if !$0 { removalFailure = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(removalFailure ?? "")
            }
            // Which providers its box can Refresh Models for (a machine's from the box that brings
            // it), read as the page opens and once the engine's accounts are in.
            .task(id: "\(box.machine ?? "")/\(catalog.integrationsRead != nil)") { await catalog.readRefreshable() }
        #if DEBUG
        // Once it's listed (a coding agent's comes after the engine's).
        .task(id: catalog.providers.contains { $0.id == ProcessInfo.processInfo.environment["KUVO_DEMO_PROVIDERS"] }) {
            if connecting == nil, let id = ProcessInfo.processInfo.environment["KUVO_DEMO_PROVIDERS"], let provider = catalog.providers.first(where: { $0.id == id }) {
                connecting = Connecting(integration: provider, machine: box.machine)
            }
        }
        .task {
            // KUVO_DEMO_ACCOUNTS_MACHINE=<machine>: that machine's accounts.
            if let id = ProcessInfo.processInfo.environment["KUVO_DEMO_ACCOUNTS_MACHINE"], app.machines.engine(id) != nil, box.machine == nil {
                app.settingsTabs.show(.accounts, on: .machine(id))
            }
        }
        #endif
    }

    private func removePending() {
        guard let removal else { return }
        app.config(for: box).set(nil, at: removal)
        // Its key goes with it: one made again with its name doesn't quietly reconnect with the
        // old one.
        // Its key, any the engine has (the list may not show one added just now); with the
        // computer out of reach, only one the list shows is worth saying couldn't go.
        if let id = removal.last, let provider = catalog.integrations.first(where: { $0.id == id }),
           app.api(for: box) != nil || provider.connections.contains(where: { $0.type == "credential" }) {
            Task {
                do {
                    try await app.forgetSignIn(id, on: box)
                } catch {
                    removalFailure = error.localizedDescription
                }
            }
        }
        self.removal = nil
    }

    /// The accounts; a machine's that isn't connected as last seen, under a bar that says so,
    /// or, never read, waiting for it.
    @ViewBuilder private var page: some View {
        if let away, catalog.integrationsRead == nil {
            MachineWaitingView(engine: away, note: "Its accounts show once it’s connected.")
        } else {
            list
        }
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                if let away {
                    // "2 hours ago" kept true while the page stays open.
                    TimelineView(.everyMinute) { context in
                        MachineOfflineBar(engine: away, kept: Self.asLastSeen(catalog.integrationsRead, now: context.date))
                    }
                    .background(SettingsMetrics.groupFill(scheme), in: .rect(cornerRadius: SettingsMetrics.groupRadius))
                } else if engineIsDown {
                    EngineStoppedBar()
                        .background(SettingsMetrics.groupFill(scheme), in: .rect(cornerRadius: SettingsMetrics.groupRadius))
                        .transition(.opacity)
                }

                SearchField(text: $search, prompt: "Search \(catalog.providers.count) providers")

                accounts
                    // As last seen: nothing here acts until it's back.
                    .disabled(away != nil)
                    .opacity(away != nil ? 0.55 : 1)
                    .accessibilityHint(away != nil ? "As last seen, while \(away?.machine.name ?? "it") isn’t connected" : "")
            }
            .animation(.ui, value: engineIsDown)
            // Lined up with the page's title above it.
            .padding(.horizontal, inset)
            .padding(.vertical, 16)
        }
    }

    @ViewBuilder private var accounts: some View {
        VStack(alignment: .leading, spacing: 26) {
            if search.isEmpty {
                // The coding agents run beside the engine, through its restarts: they work meanwhile.
                SubscriptionsSection(shows: .agents, machine: machine) { connecting = Connecting(integration: $0, machine: box.machine) }
            }
            // This Mac's engine down: the rest stays in view, and waits for it.
            providers
        }
    }

    @ViewBuilder private var providers: some View {
        VStack(alignment: .leading, spacing: 26) {
            if search.isEmpty {
                SubscriptionsSection(shows: .plans, machine: machine) { connecting = Connecting(integration: $0, machine: box.machine) }
                    .waitsForEngine(engineIsDown)
            }

            if search.isEmpty, !connected.isEmpty {
                section("Connected") {
                    VStack(spacing: 0) {
                        ForEach(connected) { provider in
                            ConnectedRow(provider: provider) { connecting = Connecting(integration: provider, machine: box.machine) }
                            if provider.id != connected.last?.id {
                                Divider().padding(.leading, 56)
                            }
                        }
                    }
                    .background(SettingsMetrics.groupFill(scheme), in: .rect(cornerRadius: SettingsMetrics.groupRadius))
                }
                .waitsForEngine(engineIsDown)
            }

            if search.isEmpty, !featured.isEmpty {
                section("Popular") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 12)], spacing: 12) {
                        ForEach(featured) { provider in
                            ProviderTile(provider: provider, hint: catalog.signInHint(provider.id)) { connecting = Connecting(integration: provider, machine: box.machine) }
                        }
                    }
                }
                .waitsForEngine(engineIsDown)
            }

            if search.isEmpty {
                CustomProvidersSection { connecting = Connecting(integration: $0, machine: box.machine) } edit: { id in editing = ProviderEdit(id: id) }
                    .waitsForEngine(engineIsDown)
            }

            if others.isEmpty, !search.isEmpty {
                ContentUnavailableView {
                    Label("No Results for “\(search.trimmingCharacters(in: .whitespaces))”", systemImage: "magnifyingglass")
                } description: {
                    Text("Check the spelling, or search for the company that makes the model.")
                } actions: {
                    Button("Clear Search") { search = "" }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 24)
            } else {
                section(search.isEmpty ? "All Providers" : "Results") {
                    LazyVStack(spacing: 0) {
                        ForEach(others) { provider in
                            ProviderRow(provider: provider) { connecting = Connecting(integration: provider, machine: box.machine) }
                                // A search finds the coding agents too, which work meanwhile.
                                .waitsForEngine(engineIsDown && !OutsideAgents.isAgent(provider.id))
                        }
                    }
                    .padding(4)
                    .background(SettingsMetrics.groupFill(scheme), in: .rect(cornerRadius: SettingsMetrics.groupRadius))
                }
            }
        }
    }

    /// Accounts connected, but the coding agents' and plans': they have sections of their own.
    private var connected: [Integration] {
        catalog.connectedProviders.filter { !OutsideAgents.isAgent($0.id) && !Catalog.planProviders.contains($0.id) }
    }

    private var featured: [Integration] {
        Catalog.featured.compactMap { id in catalog.providers.first { $0.id == id && !$0.isConnected && !Catalog.planProviders.contains(id) } }
    }

    private var others: [Integration] {
        let query = search.trimmingCharacters(in: .whitespaces)
        if query.isEmpty {
            // Your own are listed in their own section.
            let shown = Set(Catalog.featured).union(app.config(for: box).value(at: CustomProvidersSection.path)?.object?.keys ?? [:].keys)
            return catalog.providers.filter { !shown.contains($0.id) && !$0.isConnected && !OutsideAgents.isAgent($0.id) && !Catalog.planProviders.contains($0.id) }
        }
        return catalog.providers.filter { $0.name.localizedCaseInsensitiveContains(query) || $0.id.localizedCaseInsensitiveContains(query) }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            content()
        }
    }
}

/// A rounded search field that lives in the content, not in a toolbar: a recessed well, with the
/// focus rim while you type. Also filters the skills in Settings.
struct SearchField: View {
    @Binding var text: String
    let prompt: String
    @FocusState private var isFocused: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .focused($isFocused)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(ClearFieldButtonStyle())
                .accessibilityLabel("Clear")
                .help("Clear")
            }
        }
        .font(.body)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        // Sunken, like the sidebar's search.
        .background(Surface.well(scheme), in: .rect(cornerRadius: 10))
        .focusRim(.rect(cornerRadius: 10), isOn: isFocused)
        .contentShape(.rect)
        .onTapGesture { isFocused = true }
    }
}

/// A big, inviting tile for the providers most people use, with an explicit Connect button.
private struct ProviderTile: View {
    let provider: Integration
    /// The way in it names under its name, as its box says ("Sign in with ChatGPT", "API key").
    let hint: String?
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var isHovering = false

    var body: some View {
        HStack(spacing: 12) {
            ProviderLogo(id: provider.id, size: 20)
                .frame(width: 36, height: 36)
                .background(Surface.well(scheme), in: .rect(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.name)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                if let hint {
                    Text(hint)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Button("Connect", action: action)
                .buttonStyle(.glass)
                .controlSize(.small)
        }
        .padding(12)
        .background(SettingsMetrics.groupFill(scheme), in: .rect(cornerRadius: SettingsMetrics.groupRadius))
        // Under the pointer, an accent edge: the whole tile connects.
        .overlay {
            RoundedRectangle(cornerRadius: SettingsMetrics.groupRadius)
                .strokeBorder(.tint, lineWidth: 1.5)
                .opacity(isHovering ? 1 : 0)
        }
        .contentShape(.rect)
        .onTapGesture(perform: action)
        .onHover { hovering in withAnimation(.easeOut(duration: 0.15)) { isHovering = hovering } }
        .pointerStyle(.link)
    }

}

/// A row in the full list; the whole row is the button, and it highlights under the pointer.
private struct ProviderRow: View {
    let provider: Integration
    let action: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                ProviderLogo(id: provider.id, size: 18)
                    .frame(width: 28)
                Text(provider.name)
                Spacer()
                if provider.isConnected {
                    Label("Connected", systemImage: "checkmark.circle.fill")
                        .labelStyle(.titleAndIcon)
                        .font(.callout)
                        .foregroundStyle(.green)
                } else {
                    Text("Connect")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(isHovering ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(isHovering ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(.clear), in: .rect(cornerRadius: 10))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .onHover { isHovering = $0 }
    }
}

private struct ConnectedRow: View {
    let provider: Integration
    let addAccount: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Catalog.self) private var catalog
    @State private var failure: String?
    @State private var refreshFailure: String?
    @State private var refreshWaits = false

    var body: some View {
        HStack(spacing: 12) {
            ProviderLogo(id: provider.id, size: 22)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.name)
                    .font(.body.weight(.medium))
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(needsAttention ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
            }
            Spacer()
            Button(signInEnded ? "Sign In Again" : "Add Account", action: addAccount)
                .buttonStyle(.glass)
            if provider.connections.contains(where: { $0.type == "credential" }) {
                Button("Disconnect", role: .destructive, action: disconnect)
                    .buttonStyle(.glass)
            }
            // Its menu at the right edge, as an account's has it on this page.
            if catalog.refreshesModels(provider.id) {
                if catalog.refreshingModels[provider.id] != nil {
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
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(.rect)
        .heldContextMenu { if catalog.refreshesModels(provider.id) { menu() } }
        .alert("Couldn't Disconnect \(provider.name)", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
        .refreshModelsFailure($refreshFailure)
    }

    private func menu() -> [HeldRow] {
        refreshModelsRow(provider.id, catalog: catalog, failure: $refreshFailure, waits: $refreshWaits)
    }

    private var active: Integration.Connection? { provider.connections.first }

    /// Its sign-in ended: the engine says so, or a run was refused it.
    private var signInEnded: Bool { catalog.hasEndedSignIn(provider.id) }
    private var needsAttention: Bool { active?.status?.status == "needs_auth" || signInEnded }

    private var detail: String {
        guard let active else { return "" }
        if signInEnded { return "Sign-in ended" }
        if refreshWaits { return refreshWaitsNote }
        if let status = active.status { return status.message }
        switch active.type {
        case "env": return "From \(active.name ?? "the environment")"
        default:
            let kind = active.method == "oauth" ? "Signed in" : active.method == "key" ? "API key" : "Connected"
            let count = provider.connections.count
            return count > 1 ? "\(kind) · \(count) accounts" : kind
        }
    }

    /// Its sign-ins and keys on this computer.
    private func disconnect() {
        Task {
            do {
                try await app.forgetSignIn(provider.id, on: box)
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}
