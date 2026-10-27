import ClientAccounts
import ClientDesign
import SwiftUI

// MARK: Bring your subscriptions

/// What this Mac has that Kuvo Code can use, from its box, each with the one tap it needs: signed-in
/// agents are ready, an opencode key comes over with Use, the rest sign in here.
struct SubscriptionsStep: View {
    @Environment(AppModel.self) private var app
    @Environment(Catalog.self) private var catalog
    @State private var signingIn: SignIn?

    private struct SignIn: Identifiable {
        var id: String
    }

    private var onboarding: Onboarding { app.onboarding }
    private var box: BoxClient { app.box(BoxClient.mac) }

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
                        Button("Try Again") { Task { await onboarding.look(in: box) } }
                            .buttonStyle(.glassProminent)
                            .keyboardShortcut(.defaultAction)
                    }
                }
            } else if offers.hasSomething {
                OnboardingPage(title: "Bring your subscriptions", detail: "\(AppInfo.name) found these on your Mac. Pick the ones to use here; you can change them any time in Settings › Accounts.") {
                    VStack(alignment: .leading, spacing: 6) {
                        section("Coding Agents", offers.agents)
                        section("From opencode", offers.opencode)
                        section("From Your Shell", offers.shell)
                        if onboarding.offersUsage {
                            UsageRow(usage: onboarding.usage) { Task { await onboarding.turnOnUsage() } }
                                .padding(.top, 14)
                        }
                        failure
                    }
                } buttons: {
                    Button("Connect Another Account…") { app.openSettings(.accounts) }
                        .buttonStyle(.link)
                    Spacer()
                    Button("Continue") { onboarding.advance() }
                        .buttonStyle(.glassProminent)
                        .keyboardShortcut(.defaultAction)
                }
            } else {
                OnboardingPage(title: "Nothing to bring over", detail: "You can start right away with free models, or sign in to a subscription you have.") {
                    BotAvatar(look: BotGathering.crew[2], size: 48, mood: .idle)
                        .accessibilityHidden(true)
                } content: {
                    VStack(spacing: 6) {
                        ForEach(offers.suggestions) { row(for: $0) }
                        failure
                    }
                } buttons: {
                    Button("Other Accounts…") { app.openSettings(.accounts) }
                        .buttonStyle(.link)
                    Spacer()
                    Button("Start with Free Models") { onboarding.advance() }
                        .buttonStyle(.glassProminent)
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        // Again once this Mac's box and its engine are up, or back: the box names what it finds as
        // the engine does, and can start a moment after it. (Back from Settings › Accounts, it's
        // shown anew, and looks again.)
        .task(id: [app.box.endpoint != nil, app.engine == .ready]) { await onboarding.look(in: box) }
        .sheet(item: $signingIn) { signIn in
            ConnectView(integrationID: signIn.id, onDone: { finishedSigningIn() }, onCancel: { signingIn = nil })
                .frame(width: 480)
                .frame(minHeight: 380)
        }
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

    @ViewBuilder private func section(_ title: String, _ rows: [Offers.Row]) -> some View {
        if !rows.isEmpty {
            heading(title)
            ForEach(rows) { row(for: $0) }
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
        OfferRow(row: row, logo: logo(row.integrationID), isBusy: onboarding.using.contains(row.id) || app.agents.installing.contains(row.integrationID)) { action in
            switch action {
            case .ready, .added: break
            case .signIn(let id): signingIn = SignIn(id: id)
            case .use(let item):
                Task {
                    // Its models in the picker, and its plan in the usage panel.
                    guard await onboarding.use(item, in: box) else { return }
                    await catalog.refresh()
                    await app.usage.sync()
                }
            case .install(let id):
                app.agents.install(id) { installed in
                    await catalog.refreshAgents(fresh: true)
                    await onboarding.look(in: box)
                    if installed { signingIn = SignIn(id: id) }
                }
            }
        }
    }

    private func logo(_ id: String) -> String {
        OutsideAgents.order.contains(id) ? OutsideAgents.logo(id) : id
    }

    private func finishedSigningIn() {
        signingIn = nil
        Task {
            await catalog.refreshAgents(fresh: true)
            await onboarding.look(in: box)
        }
    }
}

/// One thing found, with what it needs.
private struct OfferRow: View {
    let row: Offers.Row
    let logo: String
    let isBusy: Bool
    let act: (Offers.Row.Action) -> Void

    var body: some View {
        OnboardingRow(title: row.name, detail: detail) {
            ProviderLogo(id: logo, size: 18, colored: true)
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
        // White in light mode, a step above the window in dark.
        .background(Surface.cardFill(scheme, focused: scheme == .light), in: .rect(cornerRadius: 12))
        .specularRim(RoundedRectangle(cornerRadius: 12))
        .environment(\.backgroundMaterial, nil)
        .accessibilityElement(children: .contain)
    }
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
                    Text("Not allowed yet. You can do it later in System Settings › Privacy & Security.")
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
