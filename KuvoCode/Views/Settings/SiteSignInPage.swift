import ClientDesign
import SwiftUI
import WebKit

/// Signing in to a service the agent uses on its site (X, Discord…), in a tab of Settings: the
/// site, in the browser the agent and your bots browse with, on this Mac or on one of your
/// machines (each keeps its own sign-ins), and whether it's signed in there.
struct SiteSignInPage: View {
    @Bindable var site: SettingsTabs.Site
    /// Closes its tab.
    let done: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var scheme

    private var service: Integrations.Service { site.service }
    private var machine: String? { site.place.isEmpty ? nil : site.place }

    private var machines: [MachineEngine] {
        app.machines.list.compactMap { app.machines.engine($0.id) }.filter(\.isReady)
    }

    private var placeName: String {
        machine.flatMap { app.machines.engine($0)?.machine.name } ?? "this Mac"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, 18)
                .padding(.top, 16)
                .padding(.bottom, 14)
            browser
        }
        .onAppear {
            openOnMachine()
            #if DEBUG
            // KUVO_DEMO_SIGN_IN_PLACE=<machine>: on that machine.
            if let machine = ProcessInfo.processInfo.environment["KUVO_DEMO_SIGN_IN_PLACE"] {
                Task {
                    try? await Task.sleep(for: .seconds(4))
                    site.place = machine
                }
            }
            #endif
        }
        .onChange(of: site.place) { openOnMachine() }
        // A popup the page opens (Continue with Google, say) shows here, and closing it comes back.
        .onChange(of: machine.flatMap { app.machines.engine($0)?.browser.pages } ?? []) { _, pages in
            if let machine { site.follow(pages, on: machine) }
        }
        // Whether it's signed in, as you sign in.
        .task {
            while !Task.isCancelled {
                if let machine { await SiteSignIns.shared.refresh(machine, app: app) } else { _ = await SiteSignIns.shared.mac() }
                try? await Task.sleep(for: .seconds(2))
            }
        }
        .onExitCommand(perform: close)
    }

    private var header: some View {
        HStack(spacing: 14) {
            BrandMarkView(service.id, size: 22, fallback: service.symbol)
                .foregroundStyle(.secondary)
                .frame(width: 42, height: 42)
                .background(Surface.well(scheme), in: .rect(cornerRadius: 11))
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 10) {
                    Text("Sign in to \(service.title)")
                        .font(.system(size: 17, weight: .semibold))
                    if let signedIn = SiteSignIns.shared.isSignedIn(service.id, on: machine) {
                        SignedInBadge(signedIn: signedIn)
                            .transition(.opacity.combined(with: .scale(scale: 0.9)))
                    }
                }
                Text(machine == nil
                     ? "The agent and your bots on this Mac browse signed in as you."
                     : "Bots on \(placeName) browse in its own browser, signed in as you.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 12)
            if !machines.isEmpty {
                PillPicker(options: [.init(value: "", title: "This Mac", symbol: "laptopcomputer")]
                    + machines.map { .init(value: $0.machine.id, title: $0.machine.name, symbol: "server.rack") },
                           selection: $site.place)
            }
            Button("Done", action: close)
                .keyboardShortcut(.defaultAction)
                .controlSize(.large)
        }
        .animation(.ui, value: SiteSignIns.shared.isSignedIn(service.id, on: machine))
    }

    /// The page, edge to edge under the header, its toolbar on the card.
    private var browser: some View {
        Group {
            if let machine, let engine = app.machines.engine(machine) {
                if let id = site.machinePages[machine] {
                    MachineBrowserPane(browser: engine.browser, page: id) {
                        EmptyView()
                    } onSubmit: { address in
                        engine.browser.load(address)
                    }
                } else {
                    // Reaching the machine's browser; the page and its sign-in come after.
                    ConnectingLink("Opening \(service.title) on \(engine.machine.name)…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else if let session = site.pages.top {
                BrowserPane(session: session) { EmptyView() }
                    .id(ObjectIdentifier(session))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func openOnMachine() {
        guard let machine, site.machinePages[machine] == nil, site.opening != machine, let engine = app.machines.engine(machine) else { return }
        site.opening = machine
        Task {
            if let id = await engine.browser.newPage(service.site) { site.machinePages[machine] = id }
            site.opening = nil
        }
    }

    private func close() {
        done()
    }
}

/// Signed in there or not, as its cookies say.
private struct SignedInBadge: View {
    let signedIn: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: signedIn ? "checkmark.circle.fill" : "circle.dashed")
                .foregroundStyle(signedIn ? Color.green : Color.secondary)
            Text(signedIn ? "Signed in" : "Not signed in yet")
                .foregroundStyle(signedIn ? .primary : .secondary)
        }
        .font(.system(size: 12, weight: .medium))
        .padding(.horizontal, 9)
        .frame(height: 22)
        .background(signedIn ? Color.green.opacity(0.14) : Color.primary.opacity(0.06), in: .capsule)
    }
}

/// The page's tabs on this Mac: the site, and a window it opens over it (a "Continue with
/// Google" popup), until that closes.
@Observable
final class SignInPages {
    private(set) var stack: [BrowserSession] = []

    var top: BrowserSession? { stack.last }

    func open(_ address: String) {
        guard stack.isEmpty else { return }
        stack.append(make(configuration: nil, address: address))
    }

    private func make(configuration: WKWebViewConfiguration?, address: String?) -> BrowserSession {
        let session = BrowserSession(configuration: configuration)
        session.openWindow = { [weak self] configuration in
            guard let self else { return nil }
            let window = make(configuration: configuration, address: nil)
            stack.append(window)
            return window.webView
        }
        session.onClose = { [weak self, weak session] in
            // Closed, a dialog it shows answered: WebKit stops the app over one left unanswered.
            session?.close()
            self?.stack.removeAll { $0 === session }
        }
        if let address { session.load(address) }
        return session
    }

    func closeAll() {
        for page in stack { page.close() }
        stack = []
    }
}
