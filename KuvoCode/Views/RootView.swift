import ClientDesign
import OpenCodeKit
import SwiftUI

/// The window: the engine's setup screen until it's running, then the workspace.
struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openWindow) private var openWindow
    @Environment(\.appearsActive) private var appearsActive
    @AppStorage(Appearance.key) private var appearance = Appearance.system

    var body: some View {
        ZStack {
            // Settings are there before the workspace is: for the engine's own page while it isn't
            // running, and from the menus during the first launch.
            if app.showsSettings, app.onboarding.isActive || app.engine != .ready {
                SettingsView { withAnimation(.ui) { app.showsSettings = false } }
                    .padding(.horizontal, Metrics.paneGap)
                    .padding(.bottom, Metrics.paneGap)
                    .toolbar {
                        ToolbarItem(placement: .navigation) {
                            SettingsBackButton { withAnimation(.ui) { app.showsSettings = false } }
                        }
                        .sharedBackgroundVisibility(.hidden)
                    }
                    .toolbar(removing: .title)
                    .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
                    .transition(.opacity)
            } else if app.onboarding.isActive {
                OnboardingView()
                    .transition(.opacity)
            } else if app.engine == .ready {
                MainView()
                    .transition(.opacity)
                    #if DEBUG
                    // KUVO_DEMO_ACTIVE: drawn as the window in front, though it's behind (for captures).
                    .environment(\.appearsActive, ProcessInfo.processInfo.environment["KUVO_DEMO_ACTIVE"] != nil ? true : appearsActive)
                    #endif
            } else {
                EngineSetupView()
                    .transition(.opacity.combined(with: .scale(0.98)))
            }
        }
        .animation(.ui, value: app.onboarding.isActive)
        .animation(.ui, value: app.engine == .ready)
        .animation(.ui, value: app.showsSettings)
        // What an agent asks you for while it browses, when no conversation shows it.
        .overContentCard { BrowserAskOverlay() }
        // A picture you sent, looked at closer, over everything.
        .overlay { ImageViewerOverlay() }
        // This Mac's models and accounts, where nothing names another computer: its own engine's,
        // or, attached to the box already here, that box's.
        .environment(app.catalog(for: app.thisMacsBox))
        // Closing the window ends its panel; changing sessions keeps the panel running.
        .onDisappear { app.utilities.closeAll() }
        .frame(minWidth: 620, minHeight: 520)
        // The window itself is frosted glass, tinted by what's behind it; cards float on it.
        .windowGlass()
        .appLook()
        .onChange(of: appearance, initial: true) { appearance.apply() }
        // The usage menu's "Open Kuvo Code" brings this window back, even after it's closed.
        .onAppear { app.openMainWindow = { [openWindow] in openWindow(id: "main") } }
    }
}

/// First launch downloads the engine; every launch waits a moment for it to start.
struct EngineSetupView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 22) {
            // Kuvo Code's own icon, as on the welcome screen; the loader below says it's working.
            AppLogo(size: 64)
                .overlay(alignment: .bottomTrailing) {
                    if case .failed = app.engine {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 22))
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, .orange)
                            .background(Circle().fill(.background).padding(2))
                            .offset(x: 6, y: 6)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .animation(.ui, value: isFailed)

            VStack(spacing: 6) {
                Text(title)
                    .font(.title2.weight(.semibold))
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                    .frame(maxWidth: 420)
            }

            switch app.engine {
            case .downloading(let progress):
                ProgressLine("Downloading the agent engine", fraction: progress)
                    .frame(width: 280)
            case .failed:
                Button("Try Again") { Task { await app.restart() } }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
            default:
                // The heading says it; the wire lights as the engine answers.
                ConnectingLink(isConnected: app.engine == .ready)
                    .accessibilityHidden(true)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .toolbar(removing: .title)
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
        .iconOnlyToolbar()
    }

    private var isFailed: Bool {
        if case .failed = app.engine { true } else { false }
    }

    private var title: String {
        switch app.engine {
        case .downloading: "Setting up"
        case .failed: app.engineStoppedWhileRunning ? "The engine stopped" : "The engine couldn't start"
        default: app.calibration.isRunning ? "Updating" : "Starting"
        }
    }

    private var detail: String {
        switch app.engine {
        case .downloading:
            "Downloading the agent engine (opencode \(OpenCodeEngine.version)). This happens once."
        case .failed(let message):
            message
        default:
            if let moving = app.boxMoving {
                // (#333: the move's own view is piece 8's.)
                moving.isEmpty ? "Moving this Mac’s box into its own home. Nothing is lost; it starts again in a moment."
                    : "Moving this Mac’s box into its own home is held up: \(moving)"
            } else {
                app.calibration.isRunning ? "Getting your bots and settings ready for this version…" : "Getting the agent engine ready…"
            }
        }
    }
}
