import ClientAccounts
import ClientDesign
import OpenCodeKit
import SwiftUI

// MARK: Bring your subscriptions

/// What this Mac has that Kuvo Code can use, from its box, each with the one tap it needs: signed-in
/// agents are ready, an opencode key comes over with Use, the rest sign in here.
struct SubscriptionsStep: View {
    @Environment(AppModel.self) private var app
    @Environment(Catalog.self) private var catalog
    @Environment(\.colorScheme) private var scheme
    @State private var signingIn: SignIn?
    /// Add Another, open on a tab.
    @State private var adding: Adding?
    /// The API keys found here, shown on demand.
    @State private var showsKeys = false

    private struct SignIn: Identifiable {
        var id: String
    }

    private struct Adding: Identifiable {
        var tab: AddAnotherSheet.Tab
        var id: AddAnotherSheet.Tab { tab }
    }

    private var onboarding: Onboarding { app.onboarding }
    private var box: BoxClient { app.box(BoxClient.thisMac) }

    var body: some View {
        let offers = onboarding.offers
        Group {
            if onboarding.found == nil {
                OnboardingPage(title: "Bring your subscriptions", detail: lookingDetail) {
                    if lookFailure == nil { Spinner(size: 16).padding(.top, 20) }
                } buttons: {
                    Spacer()
                    Button("Not Now") { onboarding.advance() }
                        .buttonStyle(.glass)
                    if lookFailure != nil {
                        Button("Try Again") { Task { await onboarding.look(in: box, agentsUp: app.agents.api != nil) } }
                            .buttonStyle(.glassProminent)
                            .keyboardShortcut(.defaultAction)
                    }
                }
            } else {
                OnboardingPage(title: "Bring your subscriptions", detail: "Use the plans you pay for. Everything else works with free models.") {
                    VStack(alignment: .leading, spacing: 6) {
                        if app.engineIsDown {
                            EngineStoppedBar()
                                .background(Surface.cardFill(scheme, focused: scheme == .light), in: .rect(cornerRadius: 12))
                                .specularRim(RoundedRectangle(cornerRadius: 12))
                                .environment(\.backgroundMaterial, nil)
                                .transition(.opacity)
                        }
                        // Each kind one list, as Settings › Accounts has them: one card, one place
                        // for the eye to land, not a card per row.
                        heading("Plans")
                        OnboardingGroup {
                            switch onboarding.agents(failure: app.agents.failure) {
                            case .listed: EmptyView()
                            case .looking: AgentsPendingRow(failure: nil, again: lookAgain)
                            case .failed(let why): AgentsPendingRow(failure: why, again: lookAgain)
                            }
                            ForEach(offers.plans) { row(for: $0) }
                        }
                        heading("Free")
                        OnboardingGroup {
                            FreeModelsRow()
                        }
                        if showsKeys, !offers.keys.isEmpty {
                            heading("API Keys")
                            OnboardingGroup {
                                ForEach(offers.keys) { row(for: $0) }
                            }
                        }
                        links(offers)
                        if onboarding.offersUsage {
                            UsageRow(usage: onboarding.usage) { Task { await onboarding.turnOnUsage() } }
                                .padding(.top, 14)
                        }
                        failure
                    }
                    .animation(.ui, value: showsKeys)
                    .animation(.ui, value: app.engineIsDown)
                } buttons: {
                    Spacer()
                    Button("Continue") { onboarding.advance() }
                        .buttonStyle(.glassProminent)
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        // Again once this Mac's box and its engine are up, or back: the box names what it finds as
        // the engine does, and can start a moment after it.
        // And once the coding agents' bridge is up: it lists them.
        .task(id: [app.box.endpoint != nil, app.engine == .ready, app.agents.api != nil]) { await onboarding.look(in: box, agentsUp: app.agents.api != nil) }
        #if DEBUG
        // KUVO_DEMO_ADD_ANOTHER=plans|keys: Add Another open on that tab, for a look at it.
        .task {
            guard let tab = ProcessInfo.processInfo.environment["KUVO_DEMO_ADD_ANOTHER"] else { return }
            adding = Adding(tab: tab == "keys" ? .keys : .plans)
        }
        // KUVO_DEMO_SHOW_KEYS: the API keys found, open in place.
        .onAppear { if ProcessInfo.processInfo.environment["KUVO_DEMO_SHOW_KEYS"] != nil { showsKeys = true } }
        #endif
        .modifier(InstallFailureAlert(isShown: signingIn == nil && adding == nil))
        .sheet(item: $signingIn) { signIn in
            ConnectView(integrationID: signIn.id, onDone: { finishedSigningIn() }, onCancel: { signingIn = nil })
                .frame(width: 480)
                .frame(minHeight: 380)
        }
        .sheet(item: $adding, onDismiss: lookAgain) { adding in
            AddAnotherSheet(tab: adding.tab, offers: offers, failure: onboarding.useFailure, agents: onboarding.agents(failure: app.agents.failure), lookAgain: lookAgain, perform: perform, isBusy: isBusy, changed: lookAgain) { self.adding = nil }
                .frame(width: 480, height: 540)
        }
    }

    /// Add Another, and the keys: quiet, under the list.
    private func links(_ offers: Offers) -> some View {
        HStack(spacing: 18) {
            Button("Add Another…") { adding = Adding(tab: .plans) }
            // The keys found here, in place; with none, any provider's, in the sheet.
            if !showsKeys {
                Button("Use an API Key Instead…") {
                    if offers.keys.isEmpty { adding = Adding(tab: .keys) } else { showsKeys = true }
                }
            } else {
                Button("Another Provider’s Key…") { adding = Adding(tab: .keys) }
            }
            Spacer()
        }
        .buttonStyle(.link)
        .font(.callout)
        .padding(.horizontal, 4)
        .padding(.top, 8)
    }

    /// Why the list couldn't be read; none while this Mac's box is still starting (it's looked for
    /// again once it's up).
    private var lookFailure: String? {
        app.box.endpoint == nil ? app.box.failure : onboarding.lookFailure
    }

    private var lookingDetail: String {
        lookFailure.map { "\(AppInfo.name) couldn’t look for them: \($0)" } ?? "Looking for what’s on your Mac…"
    }

    @ViewBuilder private var failure: some View {
        if let failure = onboarding.useFailure {
            Text(failure)
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
        }
    }

    private func heading(_ title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
            .padding(.top, 8)
            .accessibilityAddTraits(.isHeader)
    }

    private func row(for row: Offers.Row) -> some View {
        OfferRow(row: row, isBusy: isBusy(row)) { _ in perform(row) { signingIn = SignIn(id: $0) } }
            // What's found stays in view; what needs the engine waits for it (the coding agents
            // run beside it, through its restarts).
            .waitsForEngine(app.engineIsDown && !OutsideAgents.isAgent(row.integrationID))
    }

    private func isBusy(_ row: Offers.Row) -> Bool {
        onboarding.using.contains(row.id) || app.agents.installing.contains(row.integrationID)
    }

    /// What a row's button does; `signIn` opens a sign-in where the row is (here, or in Add Another).
    private func perform(_ row: Offers.Row, signIn: @escaping (String) -> Void) {
        switch row.action {
        case .ready, .added: break
        case .signIn(let id): signIn(id)
        case .use(let item):
            Task {
                // Its models in the picker, and its plan in the usage panel.
                guard await onboarding.use(item, in: box) else { return }
                await catalog.refresh()
                await app.usage.sync()
            }
        case .install(let id):
            onboarding.install(row, with: app.agents) { signInHere in
                await catalog.refreshAgents(fresh: true)
                await onboarding.look(in: box, agentsUp: app.agents.api != nil)
                if signInHere { signIn(id) }
            }
        }
    }

    private func finishedSigningIn() {
        signingIn = nil
        lookAgain()
    }

    private func lookAgain() {
        Task {
            await catalog.refreshAgents(fresh: true)
            await onboarding.look(in: box, agentsUp: app.agents.api != nil)
        }
    }
}

/// The coding agents, while their bridge starts (looked for again once it's up), or why they
/// can't be listed, to try again.
private struct AgentsPendingRow: View {
    let failure: String?
    let again: () -> Void

    var body: some View {
        OnboardingRow(title: "Coding agents", detail: failure.map { "Couldn’t look for them: \($0)" } ?? "Looking for Claude Code, Codex, Cursor and the others…") {
            Image(systemName: "terminal")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.secondary)
        } trailing: {
            if failure == nil {
                Spinner(size: 12)
            } else {
                Button("Try Again", action: again)
                    .buttonStyle(.glass)
            }
        }
    }
}

/// OpenCode's free models: always there, no account.
private struct FreeModelsRow: View {
    var body: some View {
        OnboardingRow(title: "OpenCode free models", detail: "No account needed. Always there.") {
            ProviderLogo(id: "opencode", size: 18, colored: true)
        } trailing: {
            Done(text: "Included")
        }
    }
}

/// One thing found, with what it needs.
struct OfferRow: View {
    let row: Offers.Row
    let isBusy: Bool
    let act: (Offers.Row.Action) -> Void

    var body: some View {
        OnboardingRow(title: row.name, detail: detail) {
            ProviderLogo(id: OutsideAgents.isAgent(row.integrationID) ? OutsideAgents.logo(row.integrationID) : row.integrationID, size: 18, colored: true)
        } trailing: {
            trailing
        }
    }

    /// What it's doing, while it's busy.
    private var detail: String {
        guard isBusy else { return row.detail }
        if case .install = row.action { return "Installing…" }
        return "Adding…"
    }

    @ViewBuilder private var trailing: some View {
        if isBusy {
            Spinner(size: 12)
        } else {
            switch row.action {
            case .ready: Done(text: "Ready")
            case .added: Done(text: "Added")
            case .use: Button("Use") { act(row.action) }.buttonStyle(.glassProminent).help("Copy this key from opencode into \(AppInfo.name)")
            case .signIn: Button("Sign In…") { act(row.action) }.buttonStyle(.glass)
            case .install: Button("Install") { act(row.action) }.buttonStyle(.glass).help("Runs its maker’s installer, then signs in")
            }
        }
    }
}

/// An agent's install from the step (or Add Another) that didn't work, as Settings › Accounts says
/// it: the installer's words, and its command to run yourself. The step says it, or Add Another
/// while it's open over the step, so it's said once, wherever you are, each in turn.
struct InstallFailureAlert: ViewModifier {
    /// Nothing is open over this view.
    let isShown: Bool
    @Environment(AppModel.self) private var app
    @Environment(Catalog.self) private var catalog

    func body(content: Content) -> some View {
        let failure = isShown ? app.onboarding.installFailure : nil
        content.alert("Couldn't Install \(failure?.name ?? "")", isPresented: Binding(get: { failure != nil }, set: { if !$0, let failure { app.onboarding.seenInstallFailure(failure.integrationID) } }), presenting: failure) { failure in
            if let command = catalog.integrations.first(where: { $0.id == failure.integrationID })?.metadata?["install"]?.string {
                Button("Copy Command") { Clipboard.copy(command) }
            }
            Button("OK", role: .cancel) {}
        } message: { failure in
            Text(failure.message)
        }
    }
}

/// The usage panel in the menu bar, turned on from here: off until you do (it reads each plan's
/// sign-in, which macOS may ask about).
private struct UsageRow: View {
    let usage: Onboarding.Usage
    let turnOn: () -> Void

    var body: some View {
        OnboardingRow(title: "Usage in the menu bar", detail: detail) {
            SymbolTile(symbol: "menubar.rectangle")
        } trailing: {
            switch usage {
            case .off: Button("Turn On", action: turnOn).buttonStyle(.glass)
            case .turningOn: Spinner(size: 12)
            case .on: Done(text: "On")
            }
        }
    }

    private var detail: String {
        switch usage {
        case .off(let note): note ?? "How much of each plan is left. macOS may ask to let \(AppInfo.name) read their sign-ins."
        case .turningOn: "Checking your plans…"
        case .on(_, let failure?): failure
        case .on(let following, nil) where following.isEmpty: "Plans you use here show up as you add them."
        case .on(let following, nil): "Following \(following.formatted(.list(type: .and)))"
        }
    }
}

/// A symbol on a tile of the accent color, for a row that isn't a provider.
private struct SymbolTile: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 32, height: 32)
            .background(.tint, in: .rect(cornerRadius: 8))
    }
}

/// One row of the first launch: an icon, a name and a line, and what it needs at the end. A solid
/// card, with crisp text (the window's glass would grey it).
private struct OnboardingRow<Icon: View, Trailing: View>: View {
    let title: String
    let detail: String
    @ViewBuilder var icon: Icon
    @ViewBuilder var trailing: Trailing
    @Environment(\.colorScheme) private var scheme
    @Environment(\.onboardingRowGrouped) private var isGrouped

    var body: some View {
        HStack(spacing: 12) {
            icon
                .frame(width: 32, height: 32)
                .background(Surface.well(scheme), in: .rect(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.body.weight(.semibold))
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(10)
        .modifier(OnboardingCard(isOn: !isGrouped))
        .accessibilityElement(children: .contain)
    }
}

/// White in light mode, a step above the window in dark.
private struct OnboardingCard: ViewModifier {
    var isOn = true
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        if isOn {
            content
                .background(Surface.cardFill(scheme, focused: scheme == .light), in: .rect(cornerRadius: 12))
                .specularRim(RoundedRectangle(cornerRadius: 12))
                .environment(\.backgroundMaterial, nil)
        } else {
            content
        }
    }
}

/// Rows of one kind on one card, a hairline between them from the text's edge.
private struct OnboardingGroup<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Group(subviews: content) { rows in
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(rows) { row in
                        row
                            .overlay(alignment: .top) {
                                if row.id != rows.first?.id {
                                    Rectangle()
                                        .fill(Surface.hairline(scheme))
                                        .frame(height: 1)
                                        .padding(.leading, 54)
                                        .padding(.trailing, 10)
                                }
                            }
                    }
                }
                .environment(\.onboardingRowGrouped, true)
                .modifier(OnboardingCard())
            }
        }
    }
}

extension EnvironmentValues {
    /// A row inside an `OnboardingGroup`, whose card it shares.
    @Entry fileprivate var onboardingRowGrouped = false
}

/// A check and a word, for what needs nothing more.
struct Done: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "checkmark.circle.fill")
            .font(.callout.weight(.semibold))
            .foregroundStyle(.green)
            .symbolRenderingMode(.hierarchical)
    }
}

// MARK: Screen access

/// Screen Recording and Accessibility, each allowed by dragging Kuvo Code into System Settings'
/// list. With both allowed, it moves on by itself.
struct ScreenAccessStep: View {
    @Environment(AppModel.self) private var app

    private var screen: ScreenAccess { app.onboarding.screen }

    var body: some View {
        OnboardingPage(title: "Let agents see and use your screen", detail: "When you ask an agent to look at a window or take a screenshot, it needs Screen Recording; to click and type in other apps, Accessibility. Nothing is captured unless an agent does it for you.") {
            VStack(alignment: .leading, spacing: 6) {
                permissionRow(.screenRecording, title: "Screen Recording", detail: "Screenshots and windows", symbol: "rectangle.dashed.badge.record")
                permissionRow(.accessibility, title: "Accessibility", detail: "Clicking and typing in other apps", symbol: "accessibility")
                if !screen.refused.isEmpty {
                    // macOS can tell an app it has Screen Recording only once it's opened again.
                    Text(screen.refused.contains(.screenRecording)
                        ? "Not allowed yet. If you just allowed Screen Recording, quit and reopen \(AppInfo.name). You can also do it later in System Settings › Privacy & Security."
                        : "Not allowed yet. You can do it later in System Settings › Privacy & Security.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
                        .padding(.top, 4)
                        .transition(.opacity)
                }
            }
            .animation(.ui, value: screen.allowed)
            .animation(.ui, value: screen.refused)
        } buttons: {
            Spacer()
            Button("Not Now") { app.onboarding.finish() }
                .buttonStyle(.glass)
            Button("Continue") { app.onboarding.finish() }
                .buttonStyle(.glassProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(screen.allowed.isEmpty)
        }
    }

    private func permissionRow(_ permission: ScreenAccess.Permission, title: String, detail: String, symbol: String) -> some View {
        PermissionRow(title: title, detail: detail, symbol: symbol, isAllowed: screen.allowed.contains(permission), isAsking: screen.asking == permission) {
            screen.ask(permission)
        }
    }
}

private struct PermissionRow: View {
    let title: String
    let detail: String
    let symbol: String
    let isAllowed: Bool
    let isAsking: Bool
    let allow: () -> Void

    var body: some View {
        OnboardingRow(title: title, detail: isAsking ? "Drag \(AppInfo.name) into the list in System Settings" : detail) {
            SymbolTile(symbol: symbol)
        } trailing: {
            if isAllowed {
                Done(text: "Allowed")
                    .transition(.scale.combined(with: .opacity))
            } else {
                Button(isAsking ? "Show Again" : "Allow…", action: allow)
                    .buttonStyle(.glassProminent)
            }
        }
    }
}
