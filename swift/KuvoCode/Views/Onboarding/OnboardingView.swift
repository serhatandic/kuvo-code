import ClientDesign
import Network
import OpenCodeKit
import SwiftUI

/// The first launch, in the window, in place of the workspace: the bots while Kuvo Code gets ready,
/// then bringing over your subscriptions, then screen access for agents.
struct OnboardingView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let onboarding = app.onboarding
        VStack(spacing: 0) {
            // On the traffic lights' line.
            StepDots(step: onboarding.step)
                .frame(height: 28)
            ZStack {
                switch onboarding.step {
                case .loader: LoaderStep()
                case .subscriptions: SubscriptionsStep()
                case .screenAccess: ScreenAccessStep()
                case .done: EmptyView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .transition(reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity)))
            .id(onboarding.step)
        }
        .ignoresSafeArea(.container, edges: .top)
        // Crisp text on the window's glass, as on the rows' cards.
        .environment(\.backgroundMaterial, nil)
        .animation(.ui, value: onboarding.step)
        #if DEBUG
        // A demo copy's window size and appearance (`KUVO_DEMO_*`) also before the workspace shows.
        .task {
            // Once the window's on screen, for its size.
            await DemoWait.pause(.windowSettles)
            await DemoDirector.run(app: app, window: DemoWindow(showsSidebar: { false }, showSidebar: { _ in }, showPalette: {}, openQuickly: {}, renameInView: {}, runProject: {}, newProject: { _ in }))
        }
        #endif
        .toolbar(removing: .title)
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
        .iconOnlyToolbar()
    }
}

/// Where you are in the three steps.
private struct StepDots: View {
    let step: Onboarding.Step
    private let steps = Onboarding.Step.allCases.filter { $0 != .done }

    var body: some View {
        HStack(spacing: 6) {
            ForEach(steps, id: \.self) { each in
                Capsule()
                    .fill(each == step ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
                    .frame(width: each == step ? 16 : 6, height: 6)
            }
        }
        .animation(.ui, value: step)
        .accessibilityElement()
        .accessibilityLabel("Step \((steps.firstIndex(of: step) ?? 0) + 1) of \(steps.count)")
    }
}

/// A step's words and what's under them (a picture over them, for some), centered in the window
/// at a width that reads well, with its buttons under them; scrolls when the window's short or the
/// text is large.
struct OnboardingPage<Header: View, Content: View, Buttons: View>: View {
    var title: String
    var detail: String
    @ViewBuilder var header: Header
    @ViewBuilder var content: Content
    @ViewBuilder var buttons: Buttons

    var body: some View {
        GeometryReader { space in
            ScrollView {
                VStack(spacing: 14) {
                    header
                    VStack(spacing: 8) {
                        Text(title)
                            .font(.title.weight(.semibold))
                            .accessibilityAddTraits(.isHeader)
                        Text(detail)
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 460)
                    content
                        .frame(maxWidth: 480)
                    HStack(spacing: 10) { buttons }
                        .controlSize(.large)
                        .frame(maxWidth: 480)
                        .padding(.top, 14)
                }
                .padding(.horizontal, 32)
                .padding(.vertical, 28)
                .frame(maxWidth: .infinity, minHeight: space.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

extension OnboardingPage where Header == EmptyView {
    init(title: String, detail: String, @ViewBuilder content: () -> Content, @ViewBuilder buttons: () -> Buttons) {
        self.init(title: title, detail: detail, header: { EmptyView() }, content: content, buttons: buttons)
    }
}

// MARK: The loader

/// The bots, while Kuvo Code gets ready (the engine's download and start, once). One drops in for
/// each fifth of the way and the others look round at it; when it's ready they hop together and the
/// next step slides in. Failed, they rest; offline, they fall asleep, and it carries on by itself
/// when the connection's back.
private struct LoaderStep: View {
    @Environment(AppModel.self) private var app
    @State private var online = true
    @State private var monitor: NWPathMonitor?
    @State private var celebrating = false

    var body: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 0)
            BotGathering(progress: progress, state: state)
                .frame(height: 110)
                .accessibilityHidden(true)
            VStack(spacing: 6) {
                Text(title)
                    .font(.title.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                Text(detail)
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: 440)
            // Why it failed, in the engine's words: small, and scrolling when it's long.
            if state == .failed, let reason {
                ScrollView {
                    Text(reason)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity)
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxWidth: 440, maxHeight: 96)
                .fixedSize(horizontal: false, vertical: true)
            }
            Group {
                switch state {
                case .working:
                    ProgressLine("Getting \(AppInfo.name) ready", fraction: progress)
                        .frame(width: 220)
                case .failed, .offline:
                    Button("Try Again") { Task { await app.restart() } }
                        .buttonStyle(.glassProminent)
                        .controlSize(.large)
                        .keyboardShortcut(.defaultAction)
                case .ready:
                    Color.clear.frame(height: 4)
                }
            }
            .frame(minHeight: 32)
            Spacer(minLength: 0)
        }
        .padding(32)
        .animation(.ui, value: state)
        // Said aloud as it changes, for VoiceOver.
        .onChange(of: state) { AccessibilityNotification.Announcement(title).post() }
        .onAppear(perform: follow)
        .onDisappear { monitor?.cancel() }
        .onChange(of: app.engine == .ready, initial: true) { _, ready in
            guard ready, !celebrating, Self.demo == nil else { return }
            celebrating = true
            // A moment for them to hop, then on.
            Task {
                try? await Task.sleep(for: .seconds(1.4))
                app.onboarding.engineReady()
            }
        }
    }

    #if DEBUG
    /// KUVO_DEMO_LOADER: holds the loader at a share of the way (`0.4`), or `failed` or `offline`,
    /// for a look at it in a demo copy.
    private static let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_LOADER"]
    #else
    private static let demo: String? = nil
    #endif

    private var state: LoaderMood {
        switch Self.demo {
        case "failed": return .failed
        case "offline": return .offline
        case .some: return .working
        case nil: break
        }
        return switch app.engine {
        case .ready: .ready
        case .failed: online ? .failed : .offline
        default: .working
        }
    }

    /// The download's share of the way; starting the engine after it, the last fifth.
    private var progress: Double {
        if let demo = Self.demo { return Double(demo) ?? 0.5 }
        return switch app.engine {
        case .preparing: 0
        case .downloading(let progress): progress * 0.85
        case .starting: 0.9
        case .ready: 1
        case .failed: 0.5
        }
    }

    private var title: String {
        switch state {
        case .working: "Welcome to \(AppInfo.name)"
        case .ready: "Ready"
        case .failed: "\(AppInfo.name) couldn’t finish setting up"
        case .offline: "Waiting for the internet"
        }
    }

    private var detail: String {
        switch state {
        case .working: "Getting everything ready. This happens once."
        case .ready: "Let’s bring over what you already use."
        case .failed: "Try again, or check your connection."
        case .offline: "\(AppInfo.name) needs the internet once, to finish setting up. It carries on by itself when you’re back online."
        }
    }

    /// Why it failed, as the engine's setup says it.
    private var reason: String? {
        if case .failed(let message) = app.engine, !message.isEmpty { return message }
        return Self.demo == "failed" ? "The download stopped partway (the server didn’t answer)." : nil
    }

    /// Whether there's a connection: offline, the failure says so, and the connection coming back
    /// tries again.
    private func follow() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { path in
            let now = path.status == .satisfied
            Task { @MainActor in
                let wasOffline = !online
                online = now
                if now, wasOffline, case .failed = app.engine { await app.restart() }
            }
        }
        monitor.start(queue: .main)
        self.monitor = monitor
    }
}

/// Five of Kuvo Code's bots, gathering as it gets ready.
struct BotGathering: View {
    let progress: Double
    let state: LoaderMood

    static let crew: [BotLook] = [
        BotLook(color: .sky, shape: .round, face: .calm),
        BotLook(color: .coral, shape: .squircle, face: .happy),
        BotLook(color: .mint, shape: .pebble, face: .curious),
        BotLook(color: .violet, shape: .bloom, face: .calm),
        BotLook(color: .amber, shape: .gem, face: .wink),
    ]

    /// The one that came last, whom the others turn to for a moment.
    @State private var newest: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var shown: Int {
        state == .working ? min(5, Int(progress * 5) + 1) : 5
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 22) {
            ForEach(Self.crew.indices, id: \.self) { index in
                ZStack(alignment: .bottom) {
                    // Where the next one lands.
                    Ellipse()
                        .fill(.quaternary)
                        .frame(width: 30, height: 6)
                        .opacity(index < shown ? 0 : 1)
                    if index < shown {
                        BotAvatar(look: look(index), size: 48, mood: mood(index), noticed: noticed(index), animates: state != .failed)
                            .transition(reduceMotion ? .opacity : .asymmetric(
                                insertion: .offset(y: -90).combined(with: .opacity),
                                removal: .opacity))
                    }
                }
                .frame(width: 52, height: 100, alignment: .bottom)
            }
        }
        .animation(reduceMotion ? .default : .spring(response: 0.42, dampingFraction: 0.55), value: shown)
        .onChange(of: shown) { old, new in
            guard new > old else { return }
            newest = new - 1
            Task {
                try? await Task.sleep(for: .seconds(1.3))
                if newest == new - 1 { newest = nil }
            }
        }
    }

    /// Each one's look; resting after a failure, calm.
    private func look(_ index: Int) -> BotLook {
        var look = Self.crew[index]
        if state == .failed { look.face = .calm }
        return look
    }

    private func mood(_ index: Int) -> BotMood {
        switch state {
        case .ready: .news
        case .offline: .sleeping
        case .failed, .working: .idle
        }
    }

    /// Turned to the newcomer: happy, with a little bounce.
    private func noticed(_ index: Int) -> Bool {
        state == .working && newest != nil && newest != index
    }
}

/// How the first launch's getting ready is going, as the bots show it.
enum LoaderMood: Equatable { case working, ready, failed, offline }
