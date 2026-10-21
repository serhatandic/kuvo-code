import OpenCodeKit
import SwiftUI

/// The window: the engine's setup screen until it's running, then the workspace.
struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openWindow) private var openWindow
    @AppStorage(Appearance.key) private var appearance = Appearance.system

    var body: some View {
        ZStack {
            switch app.engine {
            case .ready:
                MainView()
                    .transition(.opacity)
            default:
                // Settings are there before the engine is, for its own page among others.
                if app.showsSettings {
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
                } else {
                    EngineSetupView()
                        .transition(.opacity.combined(with: .scale(0.98)))
                }
            }
        }
        .animation(.ui, value: app.engine == .ready)
        .animation(.ui, value: app.showsSettings)
        // What an agent asks you for while it browses, when no conversation shows it.
        .overlay { BrowserAskOverlay() }
        // A picture you sent, looked at closer, over everything.
        .overlay { ImageViewerOverlay() }
        // The window closing ends the panel's terminals and pages, and the terminal tabs. (Not the
        // sessions' view going away: that also happens while the engine restarts, and they should
        // outlive that.)
        .onDisappear {
            app.utilities.closeAll()
            app.mainTerminals.closeAll()
        }
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
                ProgressView(value: progress)
                    .progressViewStyle(.linear)
                    .frame(width: 280)
            case .failed:
                Button("Try Again") { Task { await app.restart() } }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
            default:
                Spinner(size: 16)
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
        default: "Starting"
        }
    }

    private var detail: String {
        switch app.engine {
        case .downloading(let progress):
            "Downloading the agent engine (opencode \(OpenCodeEngine.version)). This happens once.\n\(Int(progress * 100))%"
        case .failed(let message):
            message
        default:
            "Getting the agent engine ready…"
        }
    }
}
