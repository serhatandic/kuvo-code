import ClientAccounts
import ClientDesign
import OpenCodeKit
import SwiftUI

/// Add Another, over "Bring your subscriptions": the plans the step doesn't show, and API keys (the
/// ones found on this Mac, then any provider's), each signed in to here, in the sheet. The first
/// launch never sends you to Settings.
struct AddAnotherSheet: View {
    enum Tab: Hashable { case plans, keys }

    @State var tab: Tab
    let offers: Offers
    /// Why a key couldn't come over.
    let failure: String?
    /// The coding agents, as the step looks for them, and looking again.
    let agents: Onboarding.AgentsLookup
    let lookAgain: () -> Void
    /// A row's action, as the step does it; `signIn` opens a sign-in in this sheet.
    let perform: (_ row: Offers.Row, _ signIn: @escaping (String) -> Void) -> Void
    let isBusy: (Offers.Row) -> Bool
    /// A sign-in here finished: what's found is read again.
    let changed: () -> Void
    let done: () -> Void

    @Environment(Catalog.self) private var catalog
    @Environment(AppModel.self) private var app
    /// A sign-in open in the sheet; `keysOnly`: from API Keys, its key only.
    @State private var connecting: String?
    @State private var keysOnly = false
    /// The plans the sheet opened with, by id: one signed in to here stays, saying so.
    @State private var shown: [String]?
    @State private var search = ""

    var body: some View {
        if let connecting {
            ConnectView(integrationID: connecting, onDone: {
                self.connecting = nil
                changed()
            }, onCancel: { self.connecting = nil }, keysOnly: keysOnly)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Text("Add Another")
                    .font(.title3.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                Picker("Show", selection: $tab) {
                    Text("Plans").tag(Tab.plans)
                    Text("API Keys").tag(Tab.keys)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        switch tab {
                        case .plans: plans
                        case .keys: keys
                        }
                    }
                    .padding(.vertical, 2)
                }
                .scrollBounceBehavior(.basedOnSize)
                // The list scrolls in the sheet; the buttons stay below it.
                .frame(maxHeight: .infinity)
                if let failure {
                    Text(failure)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Spacer()
                    Button("Done", action: done)
                        .keyboardShortcut(.cancelAction)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            // The plans to add as they're listed (one signed in to meanwhile stays, saying so).
            .onChange(of: offers.more.map(\.id), initial: true) { _, ids in
                let known = shown ?? []
                shown = known + ids.filter { !known.contains($0) }
            }
            .modifier(InstallFailureAlert(isShown: true))
        }
    }

    /// The plans to add: the ones it opened with, as they are now.
    private var morePlans: [Offers.Row] {
        let all = offers.more + offers.plans
        // In the plans' own order, however late each was listed (the agents come with their bridge).
        let order = Plans.agents + Plans.engine
        return (shown ?? offers.more.map(\.id)).compactMap { id in all.first { $0.id == id } }
            .sorted { (order.firstIndex(of: $0.id) ?? .max) < (order.firstIndex(of: $1.id) ?? .max) }
    }

    @ViewBuilder private var plans: some View {
        if case .failed(let why) = agents {
            // As the step says it: not looking for ever.
            HStack(spacing: 8) {
                Text("Couldn’t look for your coding agents: \(why)")
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button("Try Again", action: lookAgain)
            }
            .foregroundStyle(.secondary)
        } else if offers.plans.isEmpty || agents == .looking {
            // Not listed yet, or the coding agents not yet.
            HStack(spacing: 8) {
                Spinner(size: 12)
                Text(offers.plans.isEmpty ? "Looking for what’s on your Mac…" : "Looking for your coding agents…")
            }
            .foregroundStyle(.secondary)
        } else if morePlans.isEmpty {
            Text("Every plan \(AppInfo.name) signs in to is on the list already.")
                .foregroundStyle(.secondary)
        }
        ForEach(morePlans) { row in
            OfferRow(row: row, isBusy: isBusy(row)) { _ in perform(row) { open($0, keysOnly: false) } }
                // The coding agents work while this Mac's engine is down; the rest waits for it.
                .waitsForEngine(app.engineIsDown && !OutsideAgents.isAgent(row.integrationID))
        }
    }

    private func open(_ id: String, keysOnly: Bool) {
        self.keysOnly = keysOnly
        connecting = id
    }

    @ViewBuilder private var keys: some View {
        if !offers.keys.isEmpty {
            heading("On Your Mac")
            ForEach(offers.keys) { row in
                OfferRow(row: row, isBusy: isBusy(row)) { _ in perform(row) { open($0, keysOnly: true) } }
                    .waitsForEngine(app.engineIsDown)
            }
            heading("Another Provider")
        }
        SearchField(text: $search, prompt: "Search providers")
        if catalog.providers.isEmpty {
            HStack(spacing: 8) {
                Spinner(size: 12)
                Text("Loading providers…")
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
        } else if providers.isEmpty {
            Text("No provider matches “\(search)”.")
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
        }
        ForEach(providers) { provider in
            Button { open(provider.id, keysOnly: true) } label: {
                HStack(spacing: 10) {
                    ProviderLogo(id: provider.id, size: 18, colored: true)
                        .frame(width: 28, height: 28)
                    Text(provider.name)
                    Spacer()
                    if provider.isConnected {
                        Done(text: "Connected")
                    } else {
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.tertiary)
                            .accessibilityHidden(true)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .waitsForEngine(app.engineIsDown)
        }
    }

    /// The engine's providers that take an API key, not the plans themselves (a key for one a plan
    /// covers, OpenAI's, is offered: only its sign-in is the plan's).
    private var providers: [Integration] {
        let plans = Set(Plans.agents + Plans.engine)
        let found = Set(offers.keys.map(\.integrationID))
        return catalog.providers
            .filter { !plans.contains($0.id) && !found.contains($0.id) && !OutsideAgents.isAgent($0.id) && $0.takesKey }
            .filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.id.localizedCaseInsensitiveContains(search) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    private func heading(_ title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
            .padding(.top, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

private extension Integration {
    /// It can be signed in to with an API key.
    var takesKey: Bool {
        methods.contains { if case .key = $0 { true } else { false } }
    }
}
