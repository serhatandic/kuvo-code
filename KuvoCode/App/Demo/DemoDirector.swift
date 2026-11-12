import AppKit
import ClientDesign
import Foundation
import KuvoVoice
import OpenCodeKit
import SwiftUI
import os

/// What the command palette opens with typed in it: KUVO_DEMO_PALETTE in debug builds, else nothing.
enum DemoPalette {
    #if DEBUG
    static let query = ProcessInfo.processInfo.environment["KUVO_DEMO_PALETTE"] ?? ""
    #else
    static let query = ""
    #endif
}

/// What Open Quickly, Report a Problem and the Changes panel's commit form open with typed in them:
/// KUVO_DEMO_OPEN_QUICKLY, KUVO_DEMO_REPORT_PROBLEM and KUVO_DEMO_COMMIT in debug builds, else nothing.
enum DemoTyped {
    #if DEBUG
    static let openQuickly = ProcessInfo.processInfo.environment["KUVO_DEMO_OPEN_QUICKLY"] ?? ""
    static let problem = ProcessInfo.processInfo.environment["KUVO_DEMO_REPORT_PROBLEM"] ?? ""
    static let commit = ProcessInfo.processInfo.environment["KUVO_DEMO_COMMIT"] ?? ""
    #else
    static let openQuickly = ""
    static let problem = ""
    static let commit = ""
    #endif
}

#if DEBUG

/// Opens the app in a given state without clicking, for trying a change or taking screenshots,
/// as the `KUVO_DEMO_*` launch variables in CONTRIBUTING.md ask: a project and a session with a
/// prompt, Settings on a page, the panel's tools, a bot, a group chat and so on. Debug builds only.
/// The window starts it once it's there (and again once the sessions are loaded), handing it
/// what it may do there (`DemoWindow`).
@MainActor
enum DemoDirector {
    /// The comment and prompt go in once, however often the window reappears.
    private static var ran = false
    private static let log = Logger(subsystem: "run.kuvo.code", category: "demo")

    static func run(app: AppModel, window: DemoWindow) async {
        let environment = ProcessInfo.processInfo.environment
        let workspace = app.workspace
        // Launched from Terminal for screenshots, the window would otherwise stay inactive.
        // KUVO_DEMO_BACKGROUND leaves the copy behind other apps, so it doesn't take the keyboard.
        if environment.keys.contains(where: { $0.hasPrefix("KUVO_DEMO_") }), environment["KUVO_DEMO_BACKGROUND"] == nil { NSApp.activate() }
        if AppInfo.staysInBackground {
            // Behind every other window, not just the one in front: when you close or hide that,
            // macOS brings forward the app whose window is next. Again as the window settles.
            Task {
                for _ in 0..<3 {
                    for window in NSApp.windows where window.isVisible { window.orderBack(nil) }
                    await DemoWait.pause(.windowSettles)
                }
            }
        }
        switch environment["KUVO_DEMO_APPEARANCE"] {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: break
        }
        // KUVO_DEMO_APPEARANCE_THEN=light|dark: switched to that once the conversation's been read
        // a while, as the Mac does at sunset (a widget drawn in the first draws again).
        if let then = environment["KUVO_DEMO_APPEARANCE_THEN"] {
            Task { @MainActor in
                await DemoWait.pause(.launchSettles)
                await DemoWait.pause(.conversationRead)
                NSApp.appearance = NSAppearance(named: then == "dark" ? .darkAqua : .aqua)
            }
        }
        if environment["KUVO_DEMO_CHANGES"] != nil { app.tabs.showPanel() }
        DemoLoaders.showIfAsked(environment)
        DemoMoves.showIfAsked(environment, app: app)
        // KUVO_DEMO_PALETTE=<text>: the command palette, with that typed in it (`DemoPalette`).
        if workspace.isLoaded, environment["KUVO_DEMO_PALETTE"] != nil { window.showPalette() }
        // KUVO_DEMO_RENAME=header: the session in view, renamed in its card's header.
        if workspace.isLoaded, environment["KUVO_DEMO_RENAME"] == "header" { window.renameInView() }
        // KUVO_DEMO_WINDOW=WIDTHxHEIGHT resizes the window, for checking narrow layouts;
        // KUVO_DEMO_OFFSCREEN puts it past the screen's edge, where the pointer can't hover over it.
        if let size = environment["KUVO_DEMO_WINDOW"]?.split(separator: "x").compactMap({ Double($0) }), size.count == 2,
           let shown = NSApp.windows.first(where: \.isVisible) {
            var frame = shown.frame
            frame.size = CGSize(width: size[0], height: size[1])
            if environment["KUVO_DEMO_OFFSCREEN"] != nil, let screen = shown.screen ?? NSScreen.main {
                frame.origin = CGPoint(x: screen.frame.maxX + 40, y: screen.frame.minY)
            } else if let screen = NSScreen.main, !screen.visibleFrame.contains(frame) {
                // On the screen, for what can't sit past its edge (a popover is kept on it).
                frame.origin = CGPoint(x: screen.visibleFrame.minX + 40, y: screen.visibleFrame.maxY - frame.height - 40)
            }
            shown.setFrame(frame, display: true, animate: false)
            // Again once window restoration has settled.
            await DemoWait.pause(.windowSettles)
            shown.setFrame(frame, display: true, animate: false)
        }
        if workspace.isLoaded, environment["KUVO_DEMO_PROVIDERS"] != nil { app.openSettings(.accounts) }
        // KUVO_DEMO_NEW_PROJECT=<folder>,<folder>: the New Project sheet with these folders.
        if workspace.isLoaded, let list = environment["KUVO_DEMO_NEW_PROJECT"] {
            window.newProject(list.split(separator: ",").map(String.init))
        }
        // KUVO_DEMO_SETTINGS=<page>[@<machine>] opens Settings on that page, by its SettingsPage
        // name: general, appearance, storage, accounts, agents, mcp, git, browser, passwords and so
        // on; with a machine, that machine's.
        if workspace.isLoaded, let tab = environment["KUVO_DEMO_SETTINGS"] {
            let (page, box) = settingsPage(tab)
            app.openSettings(page, on: box)
        }
        guard workspace.isLoaded, !ran else { return }
        ran = true
        // KUVO_DEMO_SETTINGS_TABS=<pages>: those pages too, each in a tab of its own, comma-separated;
        // the first page (KUVO_DEMO_SETTINGS) stays in view.
        if let pages = environment["KUVO_DEMO_SETTINGS_TABS"] {
            let shown = app.settingsTabs.selectedID
            for (page, box) in pages.split(separator: ",").map({ settingsPage(String($0)) }) {
                if let page { app.settingsTabs.show(page, on: box, inNewTab: true) }
            }
            app.settingsTabs.select(shown)
        }
        // KUVO_DEMO_WELCOME: no tabs, so the welcome card shows.
        if environment["KUVO_DEMO_WELCOME"] != nil { app.tabs.clear() }
        // The folder's new session first, so the panel's tools open in it.
        if let folder = environment["KUVO_DEMO_FOLDER"], environment["KUVO_DEMO_PROMPT"] == nil, environment["KUVO_DEMO_REPLAY"] == nil { app.tabs.newSession(in: folder) }
        openPanelTools(environment["KUVO_DEMO_PANEL"] ?? "", app: app, window: window)
        // KUVO_DEMO_IMPORT_BOT=<path>: New Bot, from that shared bot's file.
        if let path = environment["KUVO_DEMO_IMPORT_BOT"], let data = FileManager.default.contents(atPath: path),
           let recipe = try? JSONDecoder().decode(BotRecipe.self, from: data) {
            app.tabs.openBotEditor(bot: nil, recipe: recipe)
        }
        // KUVO_DEMO_CHAT=<message>: a new chat, with this message sent; KUVO_DEMO_MOVE_CHAT=<folder>
        // then moves the newest chat into that project.
        if let message = environment["KUVO_DEMO_CHAT"] {
            Task {
                await DemoWait.until("the engine's models (KUVO_DEMO_CHAT)", limit: DemoWait.unbounded) { app.api != nil && app.catalog.isLoaded }
                // On the model a new chat from the UI starts on.
                guard let session = try? await workspace.createSession(in: Workspace.chatsFolder, model: app.catalog.startingModel(LastModel.current), agent: nil) else { return }
                app.tabs.open(.session(session.id))
                workspace.model(for: session.id)?.submit(message, files: [], for: nil, queue: false, commands: [])
            }
        }
        if let folder = environment["KUVO_DEMO_MOVE_CHAT"] {
            Task {
                // With KUVO_DEMO_CHAT, after its reply, while it's open.
                await DemoWait.pause(.replyComes(afterChat: environment["KUVO_DEMO_CHAT"] != nil))
                guard let chat = workspace.chats.first else { return log.error("KUVO_DEMO_MOVE_CHAT: no chat") }
                do {
                    try await workspace.move(chat.id, toProject: folder)
                    app.tabs.open(.session(chat.id))
                } catch {
                    log.error("KUVO_DEMO_MOVE_CHAT failed: \(String(describing: error), privacy: .public)")
                }
            }
        }
        // KUVO_DEMO_UNDO_RESEND=<seconds>: in the session in view, undoes its last message, then
        // sends it again after that many seconds.
        if let wait = environment["KUVO_DEMO_UNDO_RESEND"].flatMap(Double.init) {
            Task {
                await DemoWait.pause(.conversationRead)
                guard let id = app.tabs.sessionID, let model = workspace.model(for: id) else { return }
                if !model.isLoaded { await model.load() }
                guard let last = model.transcript.messages.last(where: { if case .user = $0 { true } else { false } }), case .user(let user) = last else { return }
                model.undo(from: user)
                await DemoWait.pause(.asked(wait))
                model.submit(model.draftText, files: model.draftFiles, for: nil, queue: false, commands: [])
                model.draftText = ""
                model.draftFiles = []
            }
        }
        // KUVO_DEMO_MACHINE_BROWSING=<machine>|<seconds>: as if an agent on that machine started
        // using its browser that long after launch, through the same event the engine sends.
        if let value = environment["KUVO_DEMO_MACHINE_BROWSING"] {
            let parts = value.split(separator: "|").map(String.init)
            Task {
                await DemoWait.pause(.asked(parts.count > 1 ? Double(parts[1]) ?? 3 : 3))
                let json = #"{"id":"evt_demo","type":"session.tool.input.started","data":{"sessionID":"ses_demo","assistantMessageID":"msg_demo","id":"call_demo","name":"kuvo-browser_browser_navigate"}}"#
                if let event = try? ServerEvent(json: Data(json.utf8)) { workspace.handle(event, machine: parts[0]) }
            }
        }
        // KUVO_DEMO_ASKING[=<title>]: every few seconds, as if the agent of the session in view (the
        // one with that title, once it shows) started asking in its browser; the ask itself comes
        // from calling the browser's tools.
        if let title = environment["KUVO_DEMO_ASKING"] {
            Task {
                var opened = false
                while true {
                    await DemoWait.pause(.betweenAsks)
                    if !opened, !["", "1"].contains(title), let session = workspace.sessions.first(where: { $0.title == title }) {
                        app.tabs.open(.session(session.id))
                        opened = true
                    }
                    guard let id = app.tabs.sessionID, let session = workspace.session(id) else { continue }
                    workspace.onBrowserAsk?(id, RemoteFolder.machine(of: session.location.directory))
                }
            }
        }
        // KUVO_DEMO_PASSKEY=<site>: the agent of the session in view asks for a step on that site,
        // which asked for a passkey (the card's line about it).
        if let site = environment["KUVO_DEMO_PASSKEY"] {
            Task {
                await DemoWait.pause(.asked(2))
                guard let id = app.tabs.sessionID else { return }
                app.browserAsks.passkeyAsked(host: site, machine: nil)
                app.browserAsks.add(BrowserAsks.Ask(id: "demo-passkey", kind: .action(instruction: "Sign in to \(site), then press Done."), host: site, machine: nil, session: id)) { _ in }
            }
        }
        // KUVO_DEMO_CYCLE_TABS=<seconds>: goes to the next session tab every so often, a few times.
        if let wait = environment["KUVO_DEMO_CYCLE_TABS"].flatMap(Double.init) {
            Task {
                for _ in 0..<4 {
                    await DemoWait.pause(.asked(wait))
                    app.tabs.cycle(by: 1)
                }
            }
        }
        DemoPerf.start(environment, app: app, window: window)
        // KUVO_DEMO_REOPEN_WINDOW=<seconds>: closes the window after that long, and opens it again.
        if let wait = environment["KUVO_DEMO_REOPEN_WINDOW"].flatMap(Double.init) {
            Task {
                await DemoWait.pause(.asked(wait))
                NSApp.windows.first { $0.isVisible && $0.canBecomeMain }?.performClose(nil)
                await DemoWait.pause(.windowStaysClosed)
                app.openMainWindow?()
            }
        }
        // KUVO_DEMO_TOGGLE_PANEL=<seconds>: shows and hides the panel every so often, a few times.
        if let every = environment["KUVO_DEMO_TOGGLE_PANEL"].flatMap(Double.init) {
            Task {
                for _ in 0..<6 {
                    await DemoWait.pause(.asked(every))
                    withAnimation(.ui) { app.tabs.showPanel(!app.tabs.showsPanel) }
                }
            }
        }
        // KUVO_DEMO_VIEW_IMAGE=<path>,…: those pictures in the image viewer.
        if let paths = environment["KUVO_DEMO_VIEW_IMAGE"] {
            ImageViewer.shared.show(paths.split(separator: ",").map { AttachmentItem.local(URL(filePath: String($0))) })
        }
        // KUVO_DEMO_NEW_BOT: the New Bot editor.
        if environment["KUVO_DEMO_NEW_BOT"] != nil { app.tabs.openBotEditor(bot: nil) }
        // KUVO_DEMO_REPORT_PROBLEM=<text>: Help › Report a Problem…'s sheet, with that typed in it
        // (`DemoTyped`), without bringing the window forward as the menu does.
        if environment["KUVO_DEMO_REPORT_PROBLEM"] != nil { app.showsProblemReport = true }
        // KUVO_DEMO_OPEN_QUICKLY=<text>: Open Quickly, with that typed in it, once the conversation
        // (and its folder) is in view.
        if environment["KUVO_DEMO_OPEN_QUICKLY"] != nil {
            Task {
                await DemoWait.pause(.conversationShows)
                window.openQuickly()
            }
        }
        if let wanted = environment["KUVO_DEMO_SUBAGENT"] { Task { await openSubagent(wanted, app: app) } }
        // In tasks of their own: SwiftUI cancels and restarts the window's task while it settles,
        // which would cut the session's creation short.
        Task { await runSession(environment, app: app, window: window) }
        Task { await runBot(environment, app: app, window: window) }
        Task { await runGroup(environment, app: app, window: window) }
    }

    /// A page of Settings as the demo variables name it: `permissions`, or `permissions@<machine>`.
    private static func settingsPage(_ text: String) -> (SettingsPage?, SidebarBox) {
        let parts = text.split(separator: "@", maxSplits: 1).map(String.init)
        return (SettingsPage(rawValue: parts[0]), parts.count > 1 ? .machine(parts[1]) : .mac)
    }

    /// The catalog of the engine a folder's sessions run on: its machine's, or this Mac's.
    private static func catalog(for folder: String, app: AppModel) -> Catalog {
        app.machines.engine(RemoteFolder.machine(of: folder))?.catalog ?? app.catalog
    }

    /// KUVO_DEMO_PANEL: tools to open in the panel, comma-separated: terminal, browser=<address>,
    /// machine=<machine>[=<address>] (a tab in its browser, with a session there in view), files,
    /// file=<path>, folder=<path>, changes, run (the project's run command), expand, toggle=<seconds>.
    private static func openPanelTools(_ list: String, app: AppModel, window: DemoWindow) {
        let utilities = app.utilities
        for item in list.split(separator: ",").map(String.init) {
            let parts = item.split(separator: "=", maxSplits: 1).map(String.init)
            switch parts.first {
            case "terminal":
                // Once the conversation is in view, so the tab is its panel's, in its folder.
                Task {
                    await DemoWait.pause(.conversationShows)
                    utilities.newTerminal(in: app.tabs.focusedDirectory, environment: app.shellEnvironment)
                    app.tabs.showPanel()
                }
            case "browser":
                // Once the conversation is in view, so the tab is its panel's.
                Task {
                    await DemoWait.pause(.conversationShows)
                    let browser = utilities.newBrowser(parts.count > 1 ? parts[1] : nil)
                    app.tabs.showPanel()
                    await showPointer(over: browser, app: app)
                }
            case "machine" where parts.count > 1:
                let rest = parts[1].split(separator: "=", maxSplits: 1).map(String.init)
                // A stand-in (KUVO_DEMO_MACHINE), which has no sessions: a new session's draft in a
                // folder there, so its panel is the machine's.
                let standIn = (DemoMachines.standIn(rest[0]) ?? DemoMachines.standIn(rest[0] + ".invalid"))?.id
                if let standIn { app.tabs.newSession(in: RemoteFolder.folder("/home/demo/sample", on: standIn)) }
                let machine = standIn ?? rest[0]
                // Once a session there is in view, so the tab shows.
                Task {
                    await DemoWait.until("a session on \(machine) in view (KUVO_DEMO_PANEL)", limit: .seconds(30)) { utilities.place == machine }
                    utilities.newMachinePage(machine, address: rest.count > 1 ? rest[1] : nil)
                }
            case "files": utilities.showFiles()
            case "file" where parts.count > 1:
                // Once the conversation is in view, so the tab is its panel's.
                Task {
                    await DemoWait.pause(.conversationShows)
                    utilities.show(RemoteFolder.url(parts[1]))
                }
            case "folder" where parts.count > 1:
                // Files, open down to that folder, as an agent's show_in_panel opens it.
                Task {
                    await DemoWait.pause(.conversationShows)
                    utilities.show(RemoteFolder.url(parts[1]), isFolder: true)
                }
            case "changes": utilities.showChanges()
            case "run": window.runProject()
            case "expand": app.tabs.panelExpanded = true
            // toggle=<seconds>: expands and collapses it a few times, that far apart.
            case "toggle" where parts.count > 1:
                let wait = Double(parts[1]) ?? 3
                Task {
                    for _ in 0..<4 {
                        await DemoWait.pause(.asked(wait))
                        withAnimation(.ui) { app.tabs.panelExpanded.toggle() }
                    }
                }
            default: continue
            }
            app.tabs.showPanel()
        }
    }

    /// KUVO_DEMO_POINTER=<x>,<y>[,<action>]: the agent's pointer over the panel's browser at that
    /// point of the page (its points, from its top left), as if the agent of the session in view
    /// were about to `click` there (or `type`, `select`, `hover`), with its badge; shown again before
    /// it would fade, so it stays.
    private static func showPointer(over browser: BrowserSession, app: AppModel) async {
        guard let spec = ProcessInfo.processInfo.environment["KUVO_DEMO_POINTER"] else { return }
        let values = spec.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        let xy = values.prefix(2).compactMap(Double.init)
        guard xy.count == 2 else { return }
        let action = values.count > 2 ? AgentPointer.Action(rawValue: values[2]) ?? .click : .click
        // Once the page has loaded.
        await DemoWait.pause(.conversationRead)
        browser.agentWorks(app.tabs.sessionID)
        // An element's size around the point, for the ring a field gets.
        let element = CGRect(x: xy[0] - 90, y: xy[1] - 16, width: 180, height: 32)
        while !Task.isCancelled {
            browser.showAgentStep(action, at: element)
            await DemoWait.pause(.asked(2))
        }
    }

    /// KUVO_DEMO_SUBAGENT[=<session ID or title>]: that session (else the one in view), then its
    /// first subagent's own conversation in its place, as the subagent's Open does, once its agent
    /// has started one (with KUVO_DEMO_PROMPT, a prompt that asks for one).
    private static func openSubagent(_ wanted: String, app: AppModel) async {
        let workspace = app.workspace
        if !["", "1"].contains(wanted), let session = workspace.sessions.first(where: { $0.id == wanted || $0.title == wanted }) {
            app.tabs.open(.session(session.id))
        }
        // With a prompt, its new session.
        let before = ProcessInfo.processInfo.environment["KUVO_DEMO_PROMPT"] != nil ? app.tabs.sessionID : nil
        guard await DemoWait.until("a session in view (KUVO_DEMO_SUBAGENT)", limit: .seconds(60), { app.tabs.sessionID != nil && app.tabs.sessionID != before }),
              let id = app.tabs.sessionID, let model = workspace.model(for: id) else { return }
        if !model.isLoaded { await model.load() }
        guard await DemoWait.until("a subagent of \(id) (KUVO_DEMO_SUBAGENT)", limit: .seconds(300), { !model.subagents.isEmpty }),
              let subagent = model.subagents.first else { return }
        // Once its session's known as the conversation's (its tab finds its way back by it).
        await DemoWait.until("\(subagent.id)'s session (KUVO_DEMO_SUBAGENT)", limit: .seconds(60)) { workspace.parent(of: subagent.id) != nil }
        app.tabs.openInPlace(subagent.id)
    }

    /// KUVO_DEMO_GROUP=<name>|<bot>,<bot>,…[|<message>] makes that group chat of those bots unless
    /// one has the name, opens it, and sends it the message; KUVO_DEMO_EDIT_GROUP opens its editor,
    /// and KUVO_DEMO_MOVE_GROUP=<machine> moves it there first.
    private static func runGroup(_ environment: [String: String], app: AppModel, window: DemoWindow) async {
        let groups = app.chats
        if environment["KUVO_DEMO_NEW_GROUP"] != nil { app.tabs.openGroupEditor(group: nil) }
        guard let spec = environment["KUVO_DEMO_GROUP"] else { return }
        let parts = spec.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard let name = parts.first, !name.isEmpty else { return }
        let members = (parts.count > 1 ? parts[1] : "").split(separator: ",").compactMap { member in
            app.bots.list.first { $0.name == member.trimmingCharacters(in: .whitespaces) }?.id
        }
        // A new one on this Mac once its group chats run.
        if !groups.list.contains(where: { $0.name == name }) {
            await DemoWait.until("this Mac's group chats (KUVO_DEMO_GROUP)", limit: .seconds(180)) { groups.macReach == .ready }
        }
        var made = groups.list.first { $0.name == name }
        if made == nil { made = try? await groups.create(name: name, purpose: nil, members: members, meeting: nil) }
        guard let group = made else { return print("KUVO_DEMO_GROUP: \(name) couldn't be made") }
        app.tabs.open(.group(group.id))
        if environment["KUVO_DEMO_EDIT_GROUP"] != nil { app.tabs.openGroupEditor(group: group) }
        // KUVO_DEMO_GROUP_UNDO=<seconds>: then undoes from your last message there, into the composer.
        if let wait = environment["KUVO_DEMO_GROUP_UNDO"].flatMap(Double.init) {
            await DemoWait.pause(.asked(wait))
            if let last = groups.messages(in: group.id).last(where: { $0.author == nil && $0.kind != .note }),
               let text = await groups.undo(from: last.id, in: group.id) {
                Drafts.shared[BotGroups.tabKey(group.id)].text = text
            }
        }
        // KUVO_DEMO_MOVE_GROUP=<machine>: then it moves there (once the machines it moves between run
        // group chats), or to this Mac when empty, before its message goes.
        if let place = environment["KUVO_DEMO_MOVE_GROUP"], groups.machine(of: group.id) != (place.isEmpty ? nil : place) {
            let machine = place.isEmpty ? nil : place
            let ends = [machine, groups.machine(of: group.id)]
            await DemoWait.until("group chats running on \(ends) (KUVO_DEMO_MOVE_GROUP)", limit: .seconds(180)) {
                ends.allSatisfy { $0.map(app.boxGroups.running.contains) ?? app.boxGroups.reachable(nil) }
            }
            do {
                try await app.moves.move(group: group.id, to: machine)
                print("KUVO_DEMO_MOVE_GROUP moved \(group.name)")
            } catch {
                print("KUVO_DEMO_MOVE_GROUP failed: \(error.localizedDescription)")
            }
        }
        guard parts.count > 2, !parts[2].isEmpty else { return }
        guard await DemoWait.until("the engine (KUVO_DEMO_GROUP)", limit: DemoWait.unbounded, { app.api != nil }) else { return }
        // Once it's reached where it lives, as its composer waits.
        await DemoWait.until("the group chat's computer (KUVO_DEMO_GROUP)", limit: .seconds(180)) { groups.reach(group.id) == .ready }
        await DemoWait.pause(.beforeSending)
        groups.send(parts[2], to: group.id)
        // KUVO_DEMO_GROUP_LATER=<seconds>|<message>: another message, sent while they talk.
        let later = (environment["KUVO_DEMO_GROUP_LATER"] ?? "").split(separator: "|", maxSplits: 1).map(String.init)
        if later.count == 2, let seconds = Double(later[0]) {
            await DemoWait.pause(.asked(seconds))
            groups.send(later[1], to: group.id)
        }
    }

    /// KUVO_DEMO_BOT=<name>|<job>|<instructions>[|<machine>[|<project>]] makes that bot unless one has the
    /// name (on KUVO_DEMO_BOT_MODEL=<provider>/<model>, if given), and opens it;
    /// KUVO_DEMO_BOT_PROMPT then gives it a task, and KUVO_DEMO_EDIT_BOT opens its editor.
    private static func runBot(_ environment: [String: String], app: AppModel, window: DemoWindow) async {
        let workspace = app.workspace
        let bots = app.bots
        guard let spec = environment["KUVO_DEMO_BOT"] else { return }
        let parts = spec.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard let name = parts.first, !name.isEmpty else { return }
        var bot = bots.list.first { $0.name == name }
        if bot == nil {
            let machine = parts.count > 3 && !parts[3].isEmpty ? parts[3] : nil
            if let machine, let engine = app.machines.engine(machine) {
                await DemoWait.until("\(machine) (KUVO_DEMO_BOT)", limit: DemoWait.unbounded) { engine.isReady }
            }
            do {
                // Its job, as it would have written it in its memory.
                let job = (line: parts.count > 1 ? parts[1] : "", details: parts.count > 2 ? parts[2] : "")
                let model = environment["KUVO_DEMO_BOT_MODEL"].flatMap { spec -> ModelRef? in
                    guard let slash = spec.firstIndex(of: "/") else { return nil }
                    return ModelRef(id: String(spec[spec.index(after: slash)...]), providerID: String(spec[..<slash]))
                }
                // (The coding agents' list first, for a model of theirs: the workspace is handed
                // the agents bridge without observation knowing.)
                if OutsideAgents.runsInBridge(model?.providerID) {
                    await DemoWait.poll("the coding agents (KUVO_DEMO_BOT)") { workspace.agents(forFolder: machine.map { RemoteFolder.folder("/", on: $0) } ?? "/")?.api != nil }
                }
                bot = try await bots.create(name: name, job: job.line.isEmpty && job.details.isEmpty ? nil : job,
                                            look: .random(), model: model, machine: machine, project: parts.count > 4 && !parts[4].isEmpty ? parts[4] : nil)
            } catch {
                print("KUVO_DEMO_BOT failed: \(error.localizedDescription)")
                return
            }
        }
        guard let bot else { return }
        app.tabs.open(.session(bot.sessionID))
        // KUVO_DEMO_EDIT_BOT: its editor, open.
        if environment["KUVO_DEMO_EDIT_BOT"] != nil { app.tabs.openBotEditor(bot: bot) }
        // KUVO_DEMO_REPLY: a reply sent as a notification's Reply sends it.
        if let reply = environment["KUVO_DEMO_REPLY"] { await workspace.send(reply, to: bot.sessionID) }
        if let prompt = environment["KUVO_DEMO_BOT_PROMPT"], let model = workspace.model(for: bot.sessionID) {
            await DemoWait.pause(.beat)
            model.submit(prompt, files: [], for: nil, queue: false, commands: [])
        }
        // KUVO_DEMO_MOVE_BOT=<machine, or nothing for this Mac>: once it's done, it moves there.
        if let place = environment["KUVO_DEMO_MOVE_BOT"] {
            let machine = place.isEmpty ? nil : place
            if let machine, let engine = app.machines.engine(machine) {
                await DemoWait.until("\(machine) (KUVO_DEMO_MOVE_BOT)", limit: DemoWait.unbounded) { engine.isReady }
            }
            // Its prompt's run has started by then.
            await DemoWait.pause(.runStarts)
            await DemoWait.until("the bot to finish (KUVO_DEMO_MOVE_BOT)", limit: DemoWait.unbounded) { !workspace.isWorking(bot.sessionID) }
            do {
                try await app.moves.move(bot: bot.id, to: machine)
                print("KUVO_DEMO_MOVE_BOT moved \(bot.name)")
            } catch {
                print("KUVO_DEMO_MOVE_BOT failed: \(error.localizedDescription)")
            }
        }
    }

    private static func runSession(_ environment: [String: String], app: AppModel, window: DemoWindow) async {
        let workspace = app.workspace
        // KUVO_DEMO_SHOW_IN_PANEL=<path>|<folder or file>: as if the agent of the session in view
        // showed that in the panel (its show_in_panel tool), once it's been connected a while.
        if let spec = environment["KUVO_DEMO_SHOW_IN_PANEL"] {
            let parts = spec.split(separator: "|").map(String.init)
            Task {
                await DemoWait.pause(.connectedAWhile)
                guard let id = app.tabs.sessionID, let session = workspace.session(id), parts.count == 2 else { return }
                let machine = RemoteFolder.machine(of: session.location.directory)
                // (As its box words a show it answers while the user looks at the conversation.)
                let said = "Shown: the \(parts[1] == "folder" ? "folder" : "file") \(parts[0]) is open in Kuvo Code's side panel, beside this conversation."
                for (type, data) in [
                    ("session.tool.input.started", #""name":"kuvo-browser_show_in_panel""#),
                    ("session.tool.called", #""input":{"path":\#(String(decoding: try! JSONEncoder().encode(parts[0]), as: UTF8.self))}"#),
                    ("session.tool.success", #""content":[{"type":"text","text":\#(String(decoding: try! JSONEncoder().encode(said), as: UTF8.self))}]"#),
                ] {
                    let json = #"{"id":"evt_demo","type":"\#(type)","data":{"sessionID":"\#(id)","assistantMessageID":"msg_demo","id":"call_show",\#(data)}}"#
                    if let event = try? ServerEvent(json: Data(json.utf8)) { workspace.handle(event, machine: machine) }
                }
            }
        }
        // KUVO_DEMO_SESSION=<id>: that session's tab, in view (one on a machine waits for it).
        if let id = environment["KUVO_DEMO_SESSION"] {
            app.tabs.open(TabKey(id))
            // KUVO_DEMO_VOICE=composer|field: voice input listening for it, with sample words, in
            // the composer or the voice field (without the microphone, which would ask); `tip`:
            // the tip about more accurate voice input, from its mic.
            if let voice = environment["KUVO_DEMO_VOICE"], voice == "tip" || VoiceStyle(rawValue: voice) != nil {
                Task {
                    guard await DemoWait.until("\(id) to load (KUVO_DEMO_VOICE)", limit: .seconds(30), { workspace.model(for: id)?.isLoaded == true }) else { return }
                    await DemoWait.pause(.beat)
                    if let style = VoiceStyle(rawValue: voice) { app.dictation.showSample(for: id, style: style) } else { app.dictation.tipFor = id }
                }
            }
            // KUVO_DEMO_FIND=<words>: Find in it, looking for those (once it's read, on a machine).
            if let words = environment["KUVO_DEMO_FIND"] {
                Task {
                    guard await DemoWait.until("\(id) to load (KUVO_DEMO_FIND)", limit: .seconds(30), { workspace.model(for: id)?.isLoaded == true }), let model = workspace.model(for: id) else { return }
                    await DemoWait.pause(.beat)
                    model.showFind(words)
                }
            }
            // KUVO_DEMO_WAITING=<text>|<text>…: those as messages waiting in its queue (not sent);
            // a text of "<words>@<picture path>" has that picture attached.
            // KUVO_DEMO_WAITING_FROM=<from>|<from>…: after them, these as what came while it was
            // stopped, waiting on its box (paused), each "<sender>:<words>" (no sender: yours).
            if environment["KUVO_DEMO_WAITING"] != nil || environment["KUVO_DEMO_WAITING_FROM"] != nil {
                let waiting = environment["KUVO_DEMO_WAITING"] ?? "", fromOthers = environment["KUVO_DEMO_WAITING_FROM"] ?? ""
                Task {
                    guard await DemoWait.until("\(id) to load (KUVO_DEMO_WAITING)", limit: .seconds(30), { workspace.model(for: id)?.isLoaded == true }), let model = workspace.model(for: id) else { return }
                    model.showWaiting(waiting.split(separator: "|").enumerated().map { index, entry in
                        let parts = entry.split(separator: "@", maxSplits: 1).map(String.init)
                        return Transcript.Pending(id: "msg_demo_waiting_\(index)", text: parts[0], delivery: .queue, isLocal: false,
                                                  files: parts.count > 1 ? [URL(filePath: parts[1])] : [])
                    }, onBox: fromOthers.split(separator: "|").enumerated().map { index, entry in
                        let parts = entry.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                        return SessionModel.BoxQueue.Waiting(id: "msg_demo_box_\(index)", from: parts.count > 1 && !parts[0].isEmpty ? parts[0] : nil, text: parts.last ?? "")
                    })
                }
            }
            // KUVO_DEMO_AUTO=held|paused|decisions|fullAccess|unread: it in Auto, with sample
            // decisions and no box behind it: one held back over the composer, Auto paused, its
            // Decisions open, Full Access asked for, or Decisions with its computer out of reach.
            if let state = environment["KUVO_DEMO_AUTO"] {
                Task {
                    guard await DemoWait.until("\(id) to load (KUVO_DEMO_AUTO)", limit: .seconds(30), { workspace.model(for: id)?.isLoaded == true }), let model = workspace.model(for: id) else { return }
                    await DemoWait.pause(.beat)
                    model.showAutoSample(state)
                }
            }
            // KUVO_DEMO_DRAFT=<text>: typed, not sent, in its composer.
            if let draft = environment["KUVO_DEMO_DRAFT"] { Drafts.shared[id].text = draft }
            // KUVO_DEMO_QUOTES=<n>: that many quotes to answer in its composer.
            if let count = Int(environment["KUVO_DEMO_QUOTES"] ?? "") {
                Drafts.shared[id].quotes = []
                for index in 1...max(count, 1) {
                    let text = "Point \(index): " + String(repeating: "a quoted line from the agent's reply ", count: index % 3 + 1)
                    if let model = workspace.model(for: id) { model.addQuote(text, how: "demo") } else { Drafts.shared.addQuote(text, to: id) }
                }
            }
        }
        // KUVO_DEMO_TABS: the project's sessions as tabs (KUVO_DEMO_TAB_COUNT=<n>: its latest n),
        // the one in view staying in view.
        if environment["KUVO_DEMO_TABS"] != nil,
           let project = workspace.projects.first(where: { $0.directory == app.tabs.activeDirectory }) ?? workspace.projects.first {
            let current = app.tabs.selection
            let count = environment["KUVO_DEMO_TAB_COUNT"].flatMap(Int.init) ?? .max
            let open = app.tabs.keys
            for session in project.sessions.prefix(count).reversed() where !open.contains(.session(session.id)) { app.tabs.open(.session(session.id)) }
            if let current { app.tabs.open(current) }
        }
        // KUVO_DEMO_BESIDE=<session ID or title>: that session beside the tab in view, as Open Beside
        // does; KUVO_DEMO_SWAP_BESIDE=<seconds>: the two trade places that long after.
        if let wanted = environment["KUVO_DEMO_BESIDE"], let session = workspace.sessions.first(where: { $0.id == wanted || $0.title == wanted }) {
            app.tabs.openBeside(session.id)
            if let wait = environment["KUVO_DEMO_SWAP_BESIDE"].flatMap(Double.init) {
                Task {
                    await DemoWait.pause(.asked(wait))
                    app.tabs.swapSplit()
                }
            }
        }
        // KUVO_DEMO_MOVE_TO_AGENTS=<provider>/<model>|<seconds>: the session in view carries on with
        // the coding agents that long after launch, as picking their model does.
        if let spec = environment["KUVO_DEMO_MOVE_TO_AGENTS"] {
            let parts = spec.split(separator: "|").map(String.init)
            let model = parts[0].split(separator: "/", maxSplits: 1).map(String.init)
            Task {
                await DemoWait.pause(.asked(parts.count > 1 ? Double(parts[1]) ?? 5 : 5))
                guard model.count == 2, let id = app.tabs.sessionID else { return }
                do {
                    try await workspace.moveToAgents(id, model: ModelRef(id: model[1], providerID: model[0]))
                } catch {
                    log.error("KUVO_DEMO_MOVE_TO_AGENTS failed: \(String(describing: error), privacy: .public)")
                }
            }
        }
        // KUVO_DEMO_COMMENT=<path in the project>:<line>:<text> adds a review comment to the
        // session in view, on that line of the changes.
        if let spec = environment["KUVO_DEMO_COMMENT"], let directory = app.tabs.activeDirectory {
            let parts = spec.split(separator: ":", maxSplits: 2).map(String.init)
            await DemoWait.pause(.changesRead)
            if parts.count == 3, let line = Int(parts[1]), let selection = app.tabs.selection?.text, let model = workspace.model(for: selection),
               let text = try? String(contentsOfFile: directory + "/" + parts[0], encoding: .utf8) {
                let lines = text.components(separatedBy: "\n")
                let snippet = lines.indices.contains(line - 1) ? lines[line - 1].trimmingCharacters(in: .whitespaces) : ""
                model.reviewComments.append(ReviewComment(file: parts[0], line: line, side: .new, snippet: snippet, text: parts[2]))
            }
        }
        // KUVO_DEMO_GROUP_REPLAY=setup|run: a group chat's discussion, measured (see PerfGroups).
        if let mode = environment["KUVO_DEMO_GROUP_REPLAY"] { return await PerfGroups.run(mode, app: app) }
        guard let folder = environment["KUVO_DEMO_FOLDER"] else { return }
        // KUVO_DEMO_REPLAY=<file>: a recorded run, played into a new session there (see PerfReplay).
        if let file = environment["KUVO_DEMO_REPLAY"] {
            let catalog = catalog(for: folder, app: app)
            await DemoWait.until("the engine's models (KUVO_DEMO_REPLAY)") { catalog.isLoaded }
            guard let session = try? await workspace.createSession(in: folder, model: catalog.startingModel(LastModel.current), agent: nil) else { return }
            app.tabs.open(.session(session.id))
            await DemoWait.until("the replay's session to load", limit: .seconds(10)) { workspace.model(for: session.id)?.isLoaded == true }
            // Its conversation drawn, before the run starts.
            await DemoWait.pause(.beforeSending)
            await PerfReplay.play(file, into: session.id, workspace: workspace)
            return
        }
        // KUVO_DEMO_DRAFT: a message typed, not sent, in the new session's composer.
        if let draft = environment["KUVO_DEMO_DRAFT"] { Drafts.shared[SidebarView.draftTag(folder)].text = draft }
        // KUVO_DEMO_DRAFT_FILES: comma-separated paths, attached there, not sent.
        if let files = environment["KUVO_DEMO_DRAFT_FILES"] {
            Drafts.shared[SidebarView.draftTag(folder)].files = files.split(separator: ",").map { URL(filePath: String($0)) }
        }
        guard let prompt = environment["KUVO_DEMO_PROMPT"] else { return app.tabs.newSession(in: folder) }
        let parts = environment["KUVO_DEMO_MODEL"]?.split(separator: "/", maxSplits: 1).map(String.init)
        let model = parts.flatMap { $0.count == 2 ? ModelRef(id: $0[1], providerID: $0[0]) : nil }
        // Like a new session from the UI: the chosen model, or the one a new session starts on (the
        // engine's default only when you can use it). KUVO_DEMO_WORKTREE gives it a worktree of its own.
        // A folder on a machine: once the machine is connected and its models are known.
        if let engine = app.machines.engine(RemoteFolder.machine(of: folder)) {
            await DemoWait.until("\(engine.machine.name)'s models (KUVO_DEMO_PROMPT)") { engine.isReady && engine.catalog.isLoaded }
        }
        let catalog = catalog(for: folder, app: app)
        await DemoWait.until("the engine's models (KUVO_DEMO_PROMPT)") { catalog.isLoaded }
        guard let session = try? await workspace.createSession(in: folder, model: model ?? catalog.startingModel(LastModel.current), agent: catalog.startingAgent(chosen: EngineConfig.of(catalog.machine)?.value(at: ["default_agent"])?.string), worktree: environment["KUVO_DEMO_WORKTREE"] != nil) else { return }
        app.tabs.open(.session(session.id))
        // KUVO_DEMO_FILES: comma-separated paths to attach.
        let files = environment["KUVO_DEMO_FILES"]?.split(separator: ",").map { URL(filePath: String($0)) } ?? []
        // As the composer sends it: "/" runs a command, "!" a shell command.
        workspace.model(for: session.id)?.submit(prompt, files: files, for: catalog.model(session.model), queue: false, commands: catalog.commands(in: folder))
        // KUVO_DEMO_THEN: messages separated by "|", each sent once the turn before it ended (a
        // keyword too, "/btw what changed?"); KUVO_DEMO_THEN_DRAFT: then left in the composer.
        if environment["KUVO_DEMO_THEN"] != nil || environment["KUVO_DEMO_THEN_DRAFT"] != nil, let model = workspace.model(for: session.id) {
            let commands = Keyword.commands(catalog.commands(in: folder), keywords: model.keywords)
            for message in (environment["KUVO_DEMO_THEN"] ?? "").split(separator: "|") {
                await DemoWait.until("the agent to start (KUVO_DEMO_THEN)", limit: .seconds(20)) { model.isRunning }
                await DemoWait.until("its turn to end (KUVO_DEMO_THEN)", limit: .seconds(180)) { !model.isRunning }
                model.submit(String(message), files: [], for: catalog.model(session.model), queue: false, commands: commands)
            }
            if let draft = environment["KUVO_DEMO_THEN_DRAFT"] {
                await DemoWait.until("its turn to end (KUVO_DEMO_THEN_DRAFT)", limit: .seconds(180)) { !model.isRunning }
                model.draftText = draft
            }
        }
        // KUVO_DEMO_GOAL: `met` or `working`, a sample goal over the composer, once the first turn
        // ended (no model checks it).
        // (`<bot's name>:<kind>` is a bot's goal and its plan: `GoalPlans.demo(for:)`.)
        if let kind = environment["KUVO_DEMO_GOAL"], !kind.contains(":"), let model = workspace.model(for: session.id) {
            await DemoWait.until("its turn to end (KUVO_DEMO_GOAL)", limit: .seconds(180)) { !model.isRunning }
            let now = Date.now.timeIntervalSince1970 * 1000
            var goal: [String: Any] = ["session": session.id, "condition": "The README says how to run the tests", "state": kind == "met" ? "met" : "working",
                                       "started": now - 60_000, "turns": 1, "checking": false]
            if kind == "met" {
                goal["ended"] = now
                goal["last"] = ["verdict": "met", "reason": "The README has a Tests section with the command.", "at": now]
            }
            if let goal = (try? JSONSerialization.data(withJSONObject: goal)).flatMap({ try? JSONDecoder().decode(Goal.self, from: $0) }) { model.goalBridge()?.took(goal) }
        }
        // KUVO_DEMO_REVIEW: `starting` (nothing found yet), `running`, `done` or `stopped`, a sample
        // security review of the whole project in parts over the composer, once the first turn
        // ended (no model reads it).
        if let kind = environment["KUVO_DEMO_REVIEW"], let model = workspace.model(for: session.id) {
            await DemoWait.until("its turn to end (KUVO_DEMO_REVIEW)", limit: .seconds(180)) { !model.isRunning }
            if let review = Self.sampleReview(kind, session: session.id, model: session.model) { model.goalBridge()?.took(review) }
        }
        // KUVO_DEMO_OPEN_PART: the first part of a review the prompt asked for ("/review …"), opened in
        // the conversation's place once it reads in a session of its own.
        if environment["KUVO_DEMO_OPEN_PART"] != nil, let model = workspace.model(for: session.id) {
            await DemoWait.until("a review's part (KUVO_DEMO_OPEN_PART)", limit: .seconds(120)) { model.review?.parts?.first?.session != nil }
            if let part = model.review?.parts?.first?.session {
                workspace.rememberReviewPart(part, of: session.id)
                app.tabs.openInPlace(part)
            }
        }
        // KUVO_DEMO_SIDE_THREAD: a sample side thread over the composer (three questions, the last
        // `answering` when it says so) and another thread before it, once the first turn ended.
        if let kind = environment["KUVO_DEMO_SIDE_THREAD"], let model = workspace.model(for: session.id), let bridge = model.goalBridge() {
            await DemoWait.until("its turn to end (KUVO_DEMO_SIDE_THREAD)", limit: .seconds(180)) { !model.isRunning }
            await bridge.loadSideQuestions(of: session.id)
            for question in Self.sampleSideThread(session: session.id, answering: kind == "answering") { bridge.took(question) }
            model.shownSideQuestion = "btw_demo_3"
        }
        // KUVO_DEMO_QUEUE: messages separated by "|", queued once the agent is working.
        guard let queue = environment["KUVO_DEMO_QUEUE"], let running = workspace.model(for: session.id) else { return }
        await DemoWait.until("the agent to start (KUVO_DEMO_QUEUE)", limit: .seconds(10)) { running.isRunning }
        for message in queue.split(separator: "|") {
            running.submit(String(message), files: [], for: catalog.model(session.model), queue: true, commands: catalog.commands(in: folder))
        }
    }
}
extension DemoDirector {
    /// A security review of the whole project in parts: under way at part 4 of 9, stopped there,
    /// or done, with what it found.
    static func sampleReview(_ kind: String, session: String, model: ModelRef?) -> Review? {
        let found: [[String: Any]] = [
            ["id": "fnd_s1", "title": "The session token is written to the log", "explanation": "Anyone who can read the logs can sign in as the user. Log that a session started, not its token.", "severity": "bug", "locations": [["file": "src/auth/login.ts", "line": 6]]],
            ["id": "fnd_s2", "title": "The redirect URL isn't checked", "explanation": "A link can send people to any site after they sign in. Allow only this app's own paths.", "severity": "bug", "locations": [["file": "src/auth/callback.ts", "line": 2], ["file": "src/auth/redirect.ts", "line": 9, "endLine": 12]]],
            ["id": "fnd_s3", "title": "The user's name goes into the query as it is", "explanation": "", "severity": "risk", "locations": [["file": "src/auth/login.ts", "line": 3]]],
            ["id": "fnd_s4", "title": "Passwords are compared with ===", "explanation": "", "severity": "risk", "locations": [["file": "src/auth/login.ts", "line": 4]]],
            ["id": "fnd_s5", "title": "Errors print the stack", "explanation": "", "severity": "nit", "locations": [["file": "src/server/log.ts", "line": 1]]],
        ]
        var review: [String: Any] = ["id": "rev_demo_\(kind)", "session": session, "scope": ["kind": "project"], "focus": "security", "started": Date.now.timeIntervalSince1970 * 1000 - 240_000]
        if let model { review["model"] = ["providerID": model.providerID, "id": model.id] }
        // Its parts, by the folders each reads (no session behind them: they show, they don't open,
        // unless KUVO_DEMO_REVIEW_PART names one that's there).
        let folders = ["src/auth", "src/billing", "src/server", "src/ui"]
        let partSession = ProcessInfo.processInfo.environment["KUVO_DEMO_REVIEW_PART"]
        func parts(read: Int, of: Int, reading: Bool) -> [[String: Any]] {
            (1...of).map { n in
                var part: [String: Any] = ["n": n, "of": of, "files": (1...(8 + n * 3)).map { "\(folders[(n - 1) % folders.count])/file\($0).ts" },
                                           "state": n <= read ? "done" : n == read + 1 && reading ? "reading" : "waiting", "found": n <= read ? [2, 0, 1, 1][(n - 1) % 4] : 0]
                if n <= read || (n == read + 1 && reading) { part["session"] = n == read + 1 ? partSession ?? "ses_demo_part_\(n)" : "ses_demo_part_\(n)" }
                if n == read + 1 && reading { part["now"] = "Reading \(folders[(n - 1) % folders.count])/charge.ts" }
                return part
            }
        }
        switch kind {
        case "starting":
            review["state"] = "reviewing"
            review["progress"] = ["read": 0, "of": 4]
            review["findings"] = [Any]()
            review["parts"] = parts(read: 0, of: 4, reading: true)
        case "running":
            review["state"] = "reviewing"
            review["progress"] = ["read": 3, "of": 9]
            review["findings"] = Array(found.prefix(3))
            review["parts"] = parts(read: 3, of: 9, reading: true)
        case "stopped":
            review["state"] = "done"
            review["stopped"] = ["read": 3, "of": 9]
            review["findings"] = Array(found.prefix(3))
            review["summary"] = "Stopped after 3 of 9 parts. It found 3 things to fix."
            review["fix"] = "Fix these."
        default:
            // More than the list shows at once, so it scrolls.
            review["state"] = "done"
            review["findings"] = found + [
                ["id": "fnd_s6", "title": "The reset link never expires", "explanation": "", "severity": "risk", "locations": [["file": "src/auth/reset.ts", "line": 14, "endLine": 18]]],
                ["id": "fnd_s7", "title": "Session cookies aren't marked Secure", "explanation": "", "severity": "risk", "locations": [["file": "src/server/session.ts", "line": 31]]],
            ]
            review["summary"] = "It read 312 files. It found 7 things to fix."
            review["parts"] = parts(read: 4, of: 4, reading: false)
            review["fix"] = "Fix these."
        }
        return (try? JSONSerialization.data(withJSONObject: review)).flatMap { try? JSONDecoder().decode(Review.self, from: $0) }
    }
}
extension DemoDirector {
    /// A side thread of three about the timer, and an older one-question thread.
    static func sampleSideThread(session: String, answering: Bool) -> [SideQuestion] {
        let now = Date.now.timeIntervalSince1970 * 1000
        let asked: [[String: Any]] = [
            ["id": "btw_demo_0", "thread": "btw_demo_0", "question": "What does the regex in parseDuration match?", "answer": "A number and a unit, like `25m` or `1h`.", "asked": now - 1_200_000],
            ["id": "btw_demo_1", "thread": "btw_demo_1", "question": "Why does the long break come every fourth round?", "answer": "Because `next()` checks `round % 4 === 0` when focus ends; `round` counts finished focus periods.", "asked": now - 300_000],
            ["id": "btw_demo_2", "thread": "btw_demo_1", "question": "Where is round reset?", "answer": "Only in `resetCycle()`, which Settings calls when you change the cycle length. `reset()` leaves it alone.", "asked": now - 200_000],
            ["id": "btw_demo_3", "thread": "btw_demo_1", "question": "So reopening the app starts at round 1?", "answer": "Yes: `round` isn't saved with the rest of the timer's state, so it starts at 0 on launch.", "asked": now - 60_000],
        ]
        return asked.compactMap { fields in
            var question = fields
            question["session"] = session
            let last = fields["id"] as? String == "btw_demo_3"
            question["state"] = last && answering ? "answering" : "answered"
            if last && answering { question["answer"] = nil } else { question["answered"] = (fields["asked"] as! Double) + 4000 }
            return (try? JSONSerialization.data(withJSONObject: question)).flatMap { try? JSONDecoder().decode(SideQuestion.self, from: $0) }
        }
    }
}
#endif
