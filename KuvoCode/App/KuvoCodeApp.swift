import ClientNews
import SwiftUI
import OpenCodeKit
import UsageKit
import os

/// Starts the app, or, when it only hosts the app's tests, an app that does nothing: no window,
/// engine, menu bar item or stores reading the real data. The tests build what they need.
@main
enum Launch {
    static func main() {
        // `--write-box-files <folder>`: what a machine runs, as a release for boxes to update
        // themselves with (the release workflow), and nothing else.
        if let index = CommandLine.arguments.firstIndex(of: "--write-box-files"), CommandLine.arguments.indices.contains(index + 1) {
            let folder = URL(filePath: CommandLine.arguments[index + 1])
            #if DEBUG
            // For a demo copy's folder on machines (a test of updates there), not ~/.kuvo-code.
            if let root = ProcessInfo.processInfo.environment["KUVO_DEMO_MACHINE_ROOT"], !root.isEmpty { RemoteEngineInstaller.root = root }
            #endif
            do {
                try MainActor.assumeIsolated { try BoxRelease.write(to: folder) }
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("Couldn't write the box's files: \(error.localizedDescription)\n".utf8))
                exit(1)
            }
        }
        // Before any window: a text field's I-beam only where nothing is drawn over it.
        MainActor.assumeIsolated { CursorRects.install() }
        if AppInfo.isHostingTests {
            // Only as a copy of its own (scripts/test-app.sh): as the app itself, the tests would
            // read and change your settings and reach your machines.
            guard AppInfo.bundleID.hasSuffix(".tests") else {
                FileHandle.standardError.write(Data("Run the app's tests with scripts/test-app.sh, which builds a copy of the app of their own (\(AppInfo.bundleID) is the app itself).\n".utf8))
                exit(78)
            }
            // Its Keychain is one in memory (see `Keychain`); nothing else gets to ask you.
            Keychain.neverAsk()
            NSApplication.shared.setActivationPolicy(.accessory)
            NSApplication.shared.run()
        } else {
            #if DEBUG
            // A demo, test or measurement never runs as the real app, or with its engine. Said and
            // left at once: an alert would wait on someone who isn't there.
            if let refusal = AppInfo.realAppRefusal(bundleID: AppInfo.bundleID, environment: ProcessInfo.processInfo.environment) {
                FileHandle.standardError.write(Data((refusal + "\n").utf8))
                Logger(subsystem: AppInfo.realBundleID, category: "launch").fault("\(refusal, privacy: .public)")
                exit(78)
            }
            // A demo copy left to run on its own asks nothing: what would wait on the Keychain's
            // prompt fails at once instead (see `AppInfo.neverPrompts`).
            if AppInfo.neverPrompts { Keychain.neverAsk() }
            #endif
            // This Mac's keeper, as launchd starts it (`Keeper`), and a command to the one running.
            if CommandLine.arguments.contains("--box") { Keeper.main() }
            if let index = CommandLine.arguments.firstIndex(of: "--box-control") { Keeper.control(Array(CommandLine.arguments[(index + 1)...])) }
            KuvoCodeApp.main()
        }
    }
}

struct KuvoCodeApp: App {
    @NSApplicationDelegateAdaptor private var delegate: AppDelegate

    init() {
        // Text drawn as the reference chat apps draw theirs, without macOS thickening it (its
        // "font smoothing"): light text on the dark cards read too bold. Set before anything is
        // drawn; a value set for the app, or for every app, still wins.
        UserDefaults.standard.register(defaults: ["AppleFontSmoothing": 0])
    }

    var body: some Scene {
        Window(AppInfo.name, id: "main") {
            RootView()
                .environment(delegate.model)
                .environment(delegate.model.catalog)
                .environment(delegate.model.workspace)
                .environment(delegate.model.bots)
                .environment(delegate.model.chats)
                .environment(delegate.updates)
                // The engine starts with the app (AppDelegate), not with this window: closing the
                // window, at login say, would cancel a start made here.
        }
        .defaultSize(width: 1180, height: 760)
        .windowToolbarStyle(.unified)
        // Settings open in this window (AppModel.openSettings), so there's no Settings scene.
        .commands { AppCommands(model: delegate.model, updates: delegate.updates) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    let updates = Updates()

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Opened from the disk image, it can't update itself: it offers to move to Applications
        // (not when the keeper opened it for an agent, with nobody looking).
        if !InBackground.shared.openedQuietly { AppLocation.offerMove() }
        // Opened again after an update installed from the background, or by the keeper for an
        // agent's browser: there again, without showing in the Dock on the way.
        if InBackground.shared.relaunchesInBackground { NSApp.setActivationPolicy(.accessory) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // This Mac's box, at work from launch: at login, in the background, without the window,
        // which goes as soon as it's there (it opens with the app); opening Kuvo Code brings it.
        model.startedAtLogin = Self.launchedAtLogin
        // Open again after an update: the keeper may open it for an agent's browser again.
        try? FileManager.default.removeItem(at: AppOpener.updateFile)
        Task { [model] in await model.start() }
        InBackground.shared.keepsWorking = { [weak model] in model?.keepsWorkingAfterQuit ?? false }
        // Relaunched after an update installed from the background, or opened hidden by the
        // keeper for an agent's browser (`InBackground`): the same, unless you opened it
        // meanwhile. Opened hidden, its window is closed unseen, and it's shown again after (with
        // nothing to show), so its menu bar panels open.
        let intoBackground = InBackground.shared.relaunchesInBackground
        if model.startedAtLogin || intoBackground {
            for delay in [0.0, 0.2, 0.6, 1.5] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    if intoBackground, !InBackground.shared.isOn { return }
                    for window in NSApp.windows where InBackground.isMainWindow(window) && (window.isVisible || intoBackground) { window.close() }
                    if delay == 1.5, intoBackground, NSApp.isHidden { NSApp.unhideWithoutActivation() }
                }
            }
        }
        Notifier.shared.start()
        FieldScrolling.start()
        // A notification clicked: its conversation, in the window.
        Notifier.shared.open = { [model] session in model.open(.session(session)) }
        Notifier.shared.openUsage = { UsageMenuBar.shared.open(.dashboard) }
        Notifier.shared.answer = { [model] session, request, answer in model.workspace.answer(request, in: session, with: answer) }
        Notifier.shared.reply = { [model] session, text in
            // A group chat's (its meeting's): to the chat.
            if let group = BotGroups.groupID(fromTab: session) {
                // Moving: kept in its composer, to send once it's there.
                if !model.chats.send(text, to: group) {
                    let key = BotGroups.tabKey(group)
                    Drafts.shared[key].text = [Drafts.shared[key].text, text].filter { !$0.isEmpty }.joined(separator: "\n\n")
                }
            } else { Task { await model.workspace.send(text, to: session) } }
        }
        Notifier.shared.answerQuestion = { [model] session, form, field, answer in model.workspace.answerQuestion(form, in: session, field: field, with: answer) }
        model.phoneLink.listen(to: Notifier.shared)
        model.attention.start()
        Notifier.shared.shownHere = { [model] shown in model.attention.shown(shown) }
        Analytics.shared.start()
        UsageMenuBar.shared.onPanelShown = { Analytics.shared.track("usage_panel_opened") }
        UsageMenuBar.shared.settingsInHost = { [model] in model.openSettings(.usage) }
        #if DEBUG
        // KUVO_DEMO_USAGE=off leaves the usage tracker out, so a second copy of the app
        // (for screenshots) never renews the logins the first one is using.
        if ProcessInfo.processInfo.environment["KUVO_DEMO_USAGE"] == "off" {
            if intoBackground { InBackground.shared.enterAtLaunch(model, usageStarting: false) }
            return
        }
        #endif
        // Plan limits and spend in the menu bar (UsageKit).
        let usageStarts = model.startUsage()
        if intoBackground { InBackground.shared.enterAtLaunch(model, usageStarting: usageStarts) }
        #if DEBUG
        // KUVO_DEMO_USAGE=dashboard|customize|settings opens the usage panel, for screenshots.
        // (Asked for by name, it starts in a copy that never prompts too: see `AppInfo.demoUsageScreen`.)
        if let screen = AppInfo.demoUsageScreen(ProcessInfo.processInfo.environment) {
            Task {
                while !UsageMenuBar.shared.isRunning { try? await Task.sleep(for: .milliseconds(250)) }
                try? await Task.sleep(for: .seconds(3))
                UsageMenuBar.shared.open(screen == "settings" ? .settings : screen == "customize" ? .customize : .dashboard)
            }
        }
        #endif
    }

    /// Whether macOS opened it as a login item (Open at Login). Only readable as it finishes
    /// launching, while the event that opened it is the one at hand.
    private static var launchedAtLogin: Bool {
        #if DEBUG
        // KUVO_DEMO_LOGIN: as if opened at login.
        if ProcessInfo.processInfo.environment["KUVO_DEMO_LOGIN"] != nil { return true }
        #endif
        guard let event = NSAppleEventManager.shared().currentAppleEvent, event.eventID == kAEOpenApplication else { return false }
        return event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }

    func applicationWillTerminate(_ notification: Notification) {
        // You've gone: what your phones' notices waited for goes now, here and on your machines.
        model.attention.stop()
        model.phoneLink.flushBeforeQuit()
        // What the window shows of your group chats next time, as it is now.
        model.boxGroups.flush()
        // Closing the engine's stdin shuts it down cleanly (it would also exit with us).
        model.stop()
        // This Mac's box: the keeper's goes on; the app's own goes with it. This Mac's own box in a
        // home of its own goes on too, told the app quit.
        model.stopBox()
        if model.attachedIsOwnBox { AppModel.tellOwnBoxQuitting(updating: false) }
        model.stopMachines()
        Analytics.shared.flushBeforeQuit()
    }

    /// Folders dropped on the Dock icon, picked in Finder's Open With, or passed to
    /// `open -a "Kuvo Code" <folder>`: each becomes a project, with a new session in the first.
    func application(_ application: NSApplication, open urls: [URL]) {
        // A shared bot: New Bot, from it.
        if let file = urls.first(where: { $0.pathExtension == "kuvobot" }) {
            if let recipe = try? BotRecipe.read(file) {
                Analytics.shared.track("bot_imported")
                model.open(.bot(recipe))
            } else {
                BotRecipe.cantOpen()
            }
        }
        let folders = urls.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
        for folder in folders.dropFirst().reversed() { model.workspace.addFolder(folder.path(percentEncoded: false)) }
        if let first = folders.first { model.open(.folder(first.path(percentEncoded: false))) }
    }

    /// The Dock icon's menu: the latest sessions and chats, and a new session.
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        let sessions = (model.workspace.projects.flatMap(\.sessions) + model.workspace.chats)
            .sorted { $0.time.updated > $1.time.updated }.prefix(5)
        for session in sessions {
            let id = session.id
            menu.addItem(ActionItem(session.title ?? "New Session") { [model] in model.open(.session(id)) })
        }
        if !sessions.isEmpty { menu.addItem(.separator()) }
        menu.addItem(ActionItem("New Session") { [model] in model.open(.newSession) })
        return menu
    }

    /// The usage meter stays in the menu bar after the window closes.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Quit, while this Mac's keeper runs its box: the work goes on, and Kuvo Code goes to the menu
    /// bar (`InBackground`). It quits for real for Stop Background Work, an update, and macOS
    /// logging out, restarting or shutting down. An update waiting to install on Quit installs
    /// then, and Kuvo Code opens again in the background.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // As macOS has it now: switched off in Login Items since, Quit quits.
        BackgroundWork.shared.refresh()
        guard model.keepsWorkingAfterQuit, !InBackground.shared.quitsForReal, !InBackground.systemIsQuitting else { return .terminateNow }
        // ⌥⌘Q is Stop Background Work, but AppKit gives Quit an Option alternate of its own (Quit
        // and Keep Windows), which can be the one that matches it, and Quit with ⌥ held in the
        // menu is that too: any Quit with ⌥ held stops the work, whichever item it came from.
        if NSApp.currentEvent?.modifierFlags.contains(.option) == true {
            Task { [model] in await InBackground.shared.stop(model) }
            return .terminateCancel
        }
        InBackground.shared.enter(model)
        return .terminateCancel
    }

    /// Opened again (the Finder, Spotlight) while in the background: back with its window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        guard InBackground.shared.isOn else { return true }
        InBackground.shared.leave()
        return false
    }
}

/// Menu commands. They act on whatever the focused window exposes.
struct AppCommands: Commands {
    let model: AppModel
    let updates: Updates
    @FocusedValue(\.sessionActions) private var actions
    @AppStorage(Appearance.key) private var appearance = Appearance.system
    @AppStorage(TabBar.showsKey) private var showsTabBar = TabBar.showsByDefault

    var body: some Commands {
        CommandGroup(after: .appTermination) {
            // Quit leaves the work going (`InBackground`); this stops it too.
            if model.keepsWorkingAfterQuit {
                Button("Stop Background Work…") { Task { await InBackground.shared.stop(model) } }
                    .keyboardShortcut("q", modifiers: [.command, .option])
            }
        }
        CommandGroup(after: .appInfo) {
            if updates.isAvailable {
                Button("Check for Updates…") { updates.check() }
                    .disabled(!updates.canCheck)
            }
        }
        CommandGroup(replacing: .newItem) {
            Button("New Session") { actions?.newSession() }
                .keyboardShortcut("n")
                .disabled(actions == nil)
            Button("New Project…") { actions?.newProject() }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(actions == nil)
            Button("New Chat") { actions?.newChat() }
                .keyboardShortcut("n", modifiers: [.command, .option])
                .disabled(actions == nil)
            Button("New Bot…") { actions?.newBot() }
                .disabled(actions == nil)
            Button("Import Bot…") { actions?.importBot() }
                .disabled(actions == nil)
            Button("New Group Chat…") { actions?.newGroup() }
                .disabled(actions == nil)
            Button("Open Folder…") { actions?.openFolder() }
                .keyboardShortcut("o")
                .disabled(actions == nil)
            Button("Open Quickly…") { actions?.openQuickly() }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(actions?.hasProject != true)
        }
        // In place of Close and Close All: ⌘W closes the session tab, as in browsers.
        CommandGroup(replacing: .saveItem) {
            Button("Close Tab") {
                // Another window in front, like an update window, just closes.
                if let actions, NSApp.keyWindow?.identifier?.rawValue == "main" { actions.closeTab() } else { NSApp.keyWindow?.performClose(nil) }
            }
            .keyboardShortcut("w")
            Button("Close Window") { NSApp.keyWindow?.performClose(nil) }
                .keyboardShortcut("w", modifiers: [.command, .shift])
            Button("Reopen Closed Tab") { actions?.reopenTab() }
                .keyboardShortcut("t", modifiers: [.command, .shift])
                .disabled(actions?.canReopenTab != true)
        }
        CommandGroup(before: .textEditing) {
            Button("Find in Conversation…") { actions?.find() }
                .keyboardShortcut("f")
                .disabled(actions?.hasSession != true)
        }
        CommandMenu("Session") {
            Button("Stop") { actions?.stop() }
                .keyboardShortcut(".")
                .disabled(actions?.canStop != true)
            Divider()
            Toggle("Plan Mode", isOn: Binding { actions?.isPlanning == true } set: { _ in actions?.togglePlan() })
                .keyboardShortcut("2", modifiers: [.command, .option])
                .disabled(actions?.hasSession != true)
            Divider()
            Button("Auto’s Decisions…") { actions?.showDecisions?() }
                .disabled(actions?.showDecisions == nil)
            Button("Branch Backups…") { actions?.branchBackups() }
                .disabled(actions?.hasSession != true)
        }
        CommandMenu("Tools") {
            Group {
                Button("Show Changes") { actions?.showChanges() }
                    .keyboardShortcut("i", modifiers: [.command, .option])
                    .disabled(actions?.panelHasProject == false)
                Button("Show Files") { actions?.showFiles() }
                    .keyboardShortcut("f", modifiers: [.command, .option])
                    .disabled(actions?.panelHasProject == false)
                Button("Show Work Queue") { actions?.showWorkQueue() }
                    .keyboardShortcut("u", modifiers: [.command, .option])
                Button("Run") { actions?.run() }
                    .keyboardShortcut("r")
                    .disabled(actions?.hasProject != true)
                Button("New Terminal") { actions?.newTerminal() }
                    .keyboardShortcut("`", modifiers: .control)
                Button("New Browser Tab") { actions?.newBrowser() }
                    .keyboardShortcut("b", modifiers: [.command, .option])
                Divider()
                Button("Show Panel") { actions?.togglePanel() }
                    .keyboardShortcut("0", modifiers: [.command, .option])
            }
            .disabled(actions == nil)
        }
        CommandGroup(before: .sidebar) {
            Button("Command Palette…") { actions?.commandPalette() }
                .keyboardShortcut("k")
                .disabled(actions == nil)
            Divider()
            Button("Show Sessions") { actions?.toggleSidebar() }
                .keyboardShortcut("0")
                .disabled(actions == nil)
            Button(showsTabBar ? "Hide Tab Bar" : "Show Tab Bar") { showsTabBar.toggle() }
                .keyboardShortcut("t", modifiers: [.command, .option])
            Button("Show Next Tab") { actions?.nextTab() }
                .keyboardShortcut(.tab, modifiers: .control)
                .disabled(actions == nil)
            Button("Show Previous Tab") { actions?.previousTab() }
                .keyboardShortcut(.tab, modifiers: [.control, .shift])
                .disabled(actions == nil)
            // To the conversation this one was opened from, as its way back at the top does.
            Button("Back") { actions?.goBack() }
                .keyboardShortcut("[")
                .disabled(actions?.canGoBack != true)
            // ⌘1 to ⌘8 show that tab, ⌘9 the last one, as in browsers.
            Menu("Show Tab") {
                ForEach(1...9, id: \.self) { number in
                    Button(number == 9 ? "Last Tab" : "Tab \(number)") { actions?.showTab(number) }
                        .keyboardShortcut(KeyEquivalent(Character("\(number)")))
                }
            }
            .disabled(actions == nil)
            Divider()
            Picker("Appearance", selection: $appearance) {
                ForEach(Appearance.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            Divider()
        }
        CommandGroup(replacing: .help) {
            Button("Kuvo Code Help") { NSWorkspace.shared.open(AppInfo.docs) }
            Button("What’s New") { model.showWhatsNew() }
            Button("Report a Problem…") { model.reportProblem() }
            Button("Contact Us…") { NSWorkspace.shared.open(AppInfo.contact) }
        }
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { model.openSettings() }
                .keyboardShortcut(",")
            Button("Accounts…") { model.openSettings(.accounts) }
                .keyboardShortcut("k", modifiers: [.command, .shift])
        }
    }
}

/// What the menu bar can do in the focused window.
struct SessionActions {
    var hasSession: Bool
    /// A session or a new one is open, so there's a project to look in.
    var hasProject: Bool
    /// The panel in view has changes and files to show (a group chat's has none).
    var panelHasProject: Bool
    var canStop: Bool
    var canReopenTab: Bool
    /// Back to the conversation the one in view was opened from (`WindowTabs.goBack`).
    var canGoBack: Bool
    var goBack: () -> Void
    var newSession: () -> Void
    var openFolder: () -> Void
    var newProject: () -> Void
    var newBot: () -> Void
    /// A new bot from a shared one's file.
    var importBot: () -> Void
    var newGroup: () -> Void
    var newChat: () -> Void
    var stop: () -> Void
    /// Whether the focused conversation is in Plan (`/plan`), and turning it on or off.
    var isPlanning: Bool
    var togglePlan: () -> Void
    /// Auto's Decisions in the focused conversation (nil: none to show there).
    var showDecisions: (() -> Void)?
    /// Branch Backups for the focused conversation's folder.
    var branchBackups: () -> Void
    var togglePanel: () -> Void
    var showChanges: () -> Void
    var showFiles: () -> Void
    var showWorkQueue: () -> Void
    var newTerminal: () -> Void
    /// The project's run command, in a terminal.
    var run: () -> Void
    var newBrowser: () -> Void
    var toggleSidebar: () -> Void
    var nextTab: () -> Void
    var previousTab: () -> Void
    var closeTab: () -> Void
    var reopenTab: () -> Void
    var find: () -> Void
    /// The tab at this place, 1 first; 9 is the last.
    var showTab: (Int) -> Void
    var showProviders: () -> Void
    var openQuickly: () -> Void
    var commandPalette: () -> Void
}

extension FocusedValues {
    @Entry var sessionActions: SessionActions?
}
