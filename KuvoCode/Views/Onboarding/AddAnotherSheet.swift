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
    /// A row's action, as the step does it; `signIn` opens a sign-in in this sheet.
    let perform: (_ row: Offers.Row, _ signIn: @escaping (String) -> Void) -> Void
    let isBusy: (Offers.Row) -> Bool
    /// A sign-in here finished: what's found is read again.
    let changed: () -> Void
    let done: () -> Void

    @Environment(Catalog.self) private var catalog
    @State private var connecting: String?
    @State private var search = ""

    var body: some View {
        if let connecting {
            ConnectView(integrationID: connecting, onDone: {
                self.connecting = nil
                changed()
            }, onCancel: { self.connecting = nil })
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
                HStack {
                    Spacer()
                    Button("Done", action: done)
                        .buttonStyle(.glass)
                        .keyboardShortcut(.cancelAction)
                }
            }
            .padding(20)
        }
    }

    @ViewBuilder private var plans: some View {
        if offers.more.isEmpty {
            Text("You have every plan \(AppInfo.name) signs in to.")
                .foregroundStyle(.secondary)
        }
        ForEach(offers.more) { row in
            OfferRow(row: row, isBusy: isBusy(row)) { _ in perform(row) { connecting = $0 } }
        }
    }

    @ViewBuilder private var keys: some View {
        if !offers.keys.isEmpty {
            heading("On Your Mac")
            ForEach(offers.keys) { row in
                OfferRow(row: row, isBusy: isBusy(row)) { _ in perform(row) { connecting = $0 } }
            }
            heading("Another Provider")
        }
        SearchField(text: $search, prompt: "Search providers")
        ForEach(providers) { provider in
            Button { connecting = provider.id } label: {
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
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
        }
    }

    /// The engine's providers you sign in to with a key: not the ones a plan covers (the plans'
    /// tab has those) and not the plans themselves.
    private var providers: [Integration] {
        let plans = Set(Plans.agents + Plans.engine + Plans.providers.values)
        let found = Set(offers.keys.map(\.integrationID))
        return catalog.providers
            .filter { !plans.contains($0.id) && !found.contains($0.id) && !OutsideAgents.isAgent($0.id) && !$0.methods.isEmpty }
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
