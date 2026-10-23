import AppKit
import OpenCodeKit
import SwiftUI
import UsageKit

/// General: the window, where files open, and updates.
struct GeneralSettings: View {
    @AppStorage(TabBar.showsKey) private var showsTabBar = TabBar.showsByDefault
    @AppStorage(PairStyle.key) private var pairStyle = PairStyle.halves
    @AppStorage(SidebarSwipe.reversesKey) private var swipeReverses = false
    @AppStorage(OpenWith.editorKey) private var editor = ""
    @AppStorage(Awake.key) private var keepsAwake = true
    @Environment(Updates.self) private var updates
    @Environment(AppModel.self) private var app
    @Environment(Catalog.self) private var catalog
    /// What opencode has that could come over, once you asked.
    @State private var importing: ImportRequest?
    @State private var reading = false
    @State private var importNote: String?
    @State private var openAtLogin = OpenAtLogin()

    var body: some View {
        ScrollingSettingsForm {
            Section("Window") {
                Toggle(isOn: $showsTabBar) {
                    Text("Show the tab bar")
                    Text("Open sessions as tabs at the top of the window.")
                }
                .help("The row at the top, with the project, its branch and your sessions as tabs. Without it, switch sessions in the sidebar or with ⌘K.")
                LabeledContent {
                    Picker("Sessions side by side", selection: $pairStyle) {
                        Text("One tab in two halves").tag(PairStyle.halves)
                        Text("One tab with both names").tag(PairStyle.compact)
                        Text("Two tabs joined").tag(PairStyle.joined)
                    }
                    .labelsHidden()
                    .fixedSize()
                } label: {
                    Text("Sessions side by side")
                    Text(showsTabBar ? "How a split shows in the tab bar." : "Needs the tab bar.")
                }
                .disabled(!showsTabBar)
                if !app.machines.list.isEmpty {
                    LabeledContent {
                        Picker("Swipe between computers", selection: $swipeReverses) {
                            Text("Pages follow your fingers").tag(false)
                            Text("Reversed").tag(true)
                        }
                        .labelsHidden()
                        .fixedSize()
                    } label: {
                        Text("Swipe between computers")
                        Text("Two fingers sideways on the sidebar, in Settings too.")
                    }
                }
            }
            Section("While Agents Work") {
                Toggle(isOn: Binding(get: { openAtLogin.isOn }, set: { openAtLogin.set($0) })) {
                    Text("Open at login, in the background")
                    Text(openAtLogin.failure ?? "Your bots and sessions on this Mac keep working from the moment you log in, without the window.")
                }
                .help("Kuvo Code opens when you log in, without its window, and stays in the menu bar. Open it to see the window.")
                .onAppear { openAtLogin.refresh() }
                Toggle(isOn: $keepsAwake) {
                    Text("Keep this Mac awake")
                    Text("While an agent or a bot works. The display can still sleep.")
                }
                .help("This Mac doesn’t go to sleep on its own while an agent or a bot works on it; the display still can. Sessions on your machines run there either way.")
                .onChange(of: keepsAwake) { Awake.shared.update() }
            }
            Section("Files") {
                LabeledContent {
                    Picker("Open code and text in", selection: $editor) {
                        Text("Each file’s default app").tag("")
                        Divider()
                        ForEach(OpenWith.installedEditors, id: \.id) { editor in
                            Text(OpenWith.name(of: editor.url)).tag(editor.id)
                        }
                    }
                    .labelsHidden()
                    .fixedSize()
                } label: {
                    Text("Open code and text in")
                    Text("From the panel’s files and from Changes.")
                }
                .help("For Open in the panel’s files and Open in Editor in Changes. Pictures and other files open in their own apps.")
            }
            if OpencodeImport.isAvailable {
                Section("opencode") {
                    LabeledContent {
                        Button("Bring Over…") { readOpencode() }
                            .disabled(reading || app.api == nil)
                    } label: {
                        Text("Bring over your opencode setup")
                        Text(importNote ?? "Keys, models, servers, agents and skills. Nothing here is replaced.")
                    }
                    .help("Its API keys, model, MCP servers, agents, commands, plugins and skills. opencode keeps its own; nothing here is replaced.")
                }
            }
            Section("Updates") {
                if updates.isAvailable {
                    @Bindable var updates = updates
                    Toggle("Check for updates automatically", isOn: $updates.checksAutomatically)
                    Toggle(isOn: $updates.getsBetas) {
                        Text("Get beta updates")
                        Text("Try new features before they’re released. Betas can have bugs.")
                    }
                }
                LabeledContent {
                    if updates.isAvailable {
                        Button("Check Now") { updates.check() }
                            .disabled(!updates.canCheck)
                    }
                } label: {
                    Text("Version \(AppInfo.version)")
                    Text(updates.isAvailable ? "Signed updates from Kuvo Code’s releases." : "This build doesn’t update itself.")
                }
            }
        }
        .settingsDetail(item: $importing, title: { _ in "Bring Over from opencode" }) { request in
            OpencodeImportReview(plan: request.plan, names: catalog.providerName) { bring in
                importing = nil
                guard bring else { return }
                Task { await bringOver(request.plan) }
            }
        }
    }

    private struct ImportRequest: Identifiable {
        let id = UUID()
        let plan: OpencodeImport.Plan
    }

    private func readOpencode() {
        guard let engine = app.engineBinary, let api = app.api else { return }
        reading = true
        Task {
            defer { reading = false }
            // What's connected already stays as it is: without knowing, nothing is planned (every
            // key would be, and replace the one in use).
            guard let credentials = try? await api.credentials() else {
                importNote = "Couldn’t read your accounts here, so nothing was brought over. Try again in a moment."
                return
            }
            let connected = Set(credentials.map(\.integrationID))
            do {
                let plan = try await OpencodeImport.plan(engine: engine, config: app.engineConfig.settings, connected: connected)
                if plan.isEmpty {
                    // Nothing to bring: no page to look over, only what's left to sign in to.
                    let signIns = plan.signIns.map(catalog.signInName)
                    importNote = (plan.settingsFailure.map { "Couldn’t read your opencode settings: \($0)" } ?? "Everything in your opencode setup is here already.")
                        + (signIns.isEmpty ? "" : " Sign in to \(ListFormatter.localizedString(byJoining: signIns)) again in Settings › Accounts.")
                } else {
                    importing = ImportRequest(plan: plan)
                }
            } catch {
                importNote = "Couldn’t read your opencode setup: \(error.localizedDescription)"
            }
        }
    }

    private func bringOver(_ plan: OpencodeImport.Plan) async {
        guard let api = app.api else { return }
        let count = await OpencodeImport.apply(plan, to: app.engineConfig, api: api)
        importNote = count == 1 ? "Brought over 1 thing from opencode." : "Brought over \(count) things from opencode."
        // Accounts and servers take effect as this Mac's engine starts again, once it's not at work.
        app.renewEngines(mac: true)
    }
}

/// What would come over from opencode, to look over before it does: in the page's place.
private struct OpencodeImportReview: View {
    let plan: OpencodeImport.Plan
    let names: (String) -> String
    let done: (Bool) -> Void

    var body: some View {
        SettingsDetailPage {
            Section {
                ForEach(plan.lines(name: names), id: \.self) { line in
                    Text(line)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("These aren’t in Kuvo Code yet; what it has already stays as it is. API keys are copied into Kuvo Code’s engine, and skills are found where opencode keeps them. The engine starts again to use them.")
                    if let failure = plan.settingsFailure {
                        Text("Your opencode settings couldn’t be read, so only its keys and skills are here: \(failure)")
                    }
                    if !plan.signIns.isEmpty {
                        Text("Sign in to \(ListFormatter.localizedString(byJoining: plan.signIns.map { Catalog.planName($0) ?? names($0) })) again in Settings › Accounts: a sign-in copied over would be refreshed by both apps, which can sign both out.")
                    }
                }
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        } footer: {
            EditorFooter(primary: "Bring Over", onPrimary: { done(true) }, onCancel: { done(false) })
        }
    }
}

/// Notifications: when Kuvo Code tells you about a session, and how.
struct NotificationSettings: View {
    @AppStorage(Notifier.enabledKey) private var notifies = true
    @AppStorage(Notifier.soundKey) private var playsSound = true
    @AppStorage(Notifier.badgeKey) private var showsBadge = true

    var body: some View {
        ScrollingSettingsForm {
            Section {
                Toggle(isOn: $notifies) {
                    Text("Sessions")
                    Text("When one finishes or needs your answer.")
                }
                .help("When a session finishes or needs your answer while you’re in another app. A permission request can be answered from its notification.")
                Toggle(isOn: $playsSound) {
                    Text("Play a sound")
                    Text("With each notification.")
                }
                .disabled(!notifies)
                Toggle(isOn: $showsBadge) {
                    Text("Count on the Dock icon")
                    Text("Sessions that finished or wait for you.")
                }
                LabeledContent {
                    Button("Open…") {
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(Bundle.main.bundleIdentifier ?? "")")!)
                    }
                } label: {
                    Text("System notification settings")
                    Text("How they look, or to allow them again.")
                }
            }
        }
    }
}

/// Privacy: anonymous usage, and where your data is.
struct PrivacySettings: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollingSettingsForm {
            Section {
                @Bindable var analytics = Analytics.shared
                Toggle(isOn: $analytics.isEnabled) {
                    Text("Share anonymous usage")
                    Text("Features used and errors. Never your code, prompts or files.")
                }
                .help("Which features you use and how often, and what kind of trouble you run into, with the app and macOS versions. Never your code, prompts, files or accounts.")
                LabeledContent("What’s sent") {
                    Link("Privacy and Data", destination: URL(string: "https://www.kuvo.run/code/docs/privacy/")!)
                }
            }
            Section {
                LabeledContent {
                    Button("Storage…") { app.settingsTabs.show(.storage) }
                } label: {
                    Text("Sessions and accounts")
                    Text("Kept on this Mac. Messages go only to your providers.")
                }
                LabeledContent {
                    Button("Browser…") { app.settingsTabs.show(.browser) }
                } label: {
                    Text("The panel’s browser")
                    Text("Kept apart from your other browsers.")
                }
                LabeledContent {
                    Button("Passwords…") { app.settingsTabs.show(.passwords) }
                } label: {
                    Text("Saved passwords")
                    Text("In your Keychain, filled in only when you ask.")
                }
            } header: {
                Text("On This Mac")
            }
        }
    }
}

/// Usage has its own settings in the menu bar panel; this page points there.
struct UsageSettings: View {
    var body: some View {
        ScrollingSettingsForm {
            Section {
                LabeledContent {
                    Button("Open…") { UsageMenuBar.shared.open(.settings) }
                } label: {
                    Text("Usage settings")
                    Text("Plan limits, pace and spend, in the menu bar.")
                }
                LabeledContent {
                    Button("Choose…") { UsageMenuBar.shared.open(.customize) }
                } label: {
                    Text("Providers")
                    Text("Which accounts the menu bar shows, and in what order.")
                }
            } footer: {
                Text("Usage tracking is a fork of OpenUsage by Robin Ebers (MIT). It isn’t affiliated with or endorsed by OpenUsage.")
                    .foregroundStyle(.secondary)
            }
        }
    }
}
