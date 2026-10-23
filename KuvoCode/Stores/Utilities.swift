import AppKit
import Foundation
import OpenCodeKit
import WebKit

/// The window's right panel: Changes, files, terminals and browsers, as tabs. Each conversation
/// has its own: a session's tabs show while it's in view, a bot's in its conversation, a group
/// chat's in the chat (with its bots' pages). Terminals and pages keep running while their tab
/// is out of view, and close with it.
///
/// The browser is the place's where the session in view runs: this Mac's, or a machine's. A
/// machine's browser runs there (its agents browse with it), and each of its pages is a tab; this
/// Mac's browser tabs don't show for a session on a machine, nor a machine's for one here.
@Observable
final class Utilities {
    enum Kind: Hashable {
        case changes
        /// A file, or the file tree when there isn't one yet.
        case file(URL?)
        case terminal
        case browser
        /// A page of a machine's browser; nil for a new tab that hasn't gone anywhere yet.
        case machinePage(String, String?)
        /// A subagent at work for the conversation, by its session, with the folder it works in:
        /// what it does as it does it, and a composer to talk to it.
        case subagent(String, folder: String)
    }

    struct Tab: Identifiable, Hashable {
        var id = UUID()
        var kind: Kind
        /// The conversation whose panel it's in (`panelOf` names it): a session's, a bot's or a
        /// group chat's. A bot browses in its tabs out of sight. `Utilities.unclaimed` for a
        /// machine's page no conversation has yet.
        var owner: String
    }

    /// A machine's page whose conversation isn't known (one left open there when the app last
    /// quit): in every panel on that machine, until an agent works in it or you pick it.
    static let unclaimed = "*"

    private(set) var tabs: [Tab] = []
    var selection: UUID? {
        // A tab of an agent's shown to you is yours now: it stays (see `tidyAgentTabs`).
        didSet { if let selection, unseen[selection] != nil, tabs.first(where: { $0.id == selection }).map(isVisible) == true { unseen[selection] = nil } }
    }

    /// You picked a tab in the strip. A page you took over and moved on from goes back to its
    /// agent, which would otherwise wait for it (a tab chosen any other way, like a popup the page
    /// opened, leaves it yours).
    func choose(_ id: UUID) {
        if let old = selection, old != id, let tab = tabs.first(where: { $0.id == old }) {
            if let browser = browsers[old], browser.isHeld { browser.isHeld = false }
            if case .machinePage(let machine, let page?) = tab.kind { machineBrowser?(machine)?.handBack(page) }
        }
        // A page no conversation had is the one you picked it in now.
        if let index = tabs.firstIndex(where: { $0.id == id }), tabs[index].owner == Self.unclaimed { tabs[index].owner = panelKey }
        selection = id
        picked(id)
    }

    /// The page in view is one you took over: agents' steps elsewhere leave the panel on it.
    private var holdsSelection: Bool {
        guard let selected else { return false }
        if browsers[selected.id]?.isHeld == true { return true }
        if case .machinePage(let machine, _) = selected.kind { return machineBrowser?(machine)?.isHeld == true }
        return false
    }
    /// Whether file tabs show the tree beside the file.
    var showsTree = true
    private(set) var terminals: [UUID: TerminalSession] = [:]
    /// The terminals Run runs a project's command in, by the folder they run in.
    private var runs: [String: UUID] = [:]
    private(set) var browsers: [UUID: BrowserSession] = [:]
    /// Sites the browser visits, for the new tab page.
    let history = BrowserHistory()
    /// Goes up when something (the agent's browsing) needs the panel in view.
    private(set) var revealRequest = 0
    /// Puts text in the composer of the session in view, for Add to Message on a selection
    /// in a file or a terminal. The window sets it.
    @ObservationIgnored var addToMessage: ((String) -> Void)?
    /// Attaches files to that message, like a screenshot of a page.
    @ObservationIgnored var attachToMessage: (([URL]) -> Void)?
    /// A machine's browser, by the machine's ID.
    @ObservationIgnored var machineBrowser: ((String) -> MachineBrowser?)?

    /// The machine the session in view runs on, nil for this Mac: the browser tabs are its, and
    /// new ones open there. The window sets it.
    var place: String? {
        didSet { if place != oldValue { placeChanged(from: oldValue) } }
    }

    /// The session in view; an agent elsewhere browsing doesn't bring its page forward. The window
    /// sets it.
    var sessionInView: String? {
        didSet { if sessionInView != oldValue { panelChanged(from: panelKey(session: oldValue)) } }
    }
    /// The session beside it in split view, in view too. The window sets it.
    var besideInView: String? {
        didSet { if besideInView != oldValue, worksBeside { panelChanged(from: panelKey(beside: oldValue)) } }
    }
    /// The group chat in view, by its tab's key (`group:<id>`): its bots' seats are in view. The
    /// window sets it.
    var groupInView: String? {
        didSet { if groupInView != oldValue { panelChanged(from: panelKey(group: oldValue, isSet: true)) } }
    }
    /// You're working in the session beside the tab's (you clicked or typed there): a tab you pick
    /// is its agent's. The window sets it.
    var worksBeside = false {
        didSet { if worksBeside != oldValue { panelChanged(from: panelKey(worksBeside: oldValue)) } }
    }
    /// The session beside you work in, also while the expanded panel covers it (it's no longer
    /// in view then, but the panel stays its). The window sets it, before `worksBeside`.
    var workedBeside: String? {
        didSet { if workedBeside != oldValue, worksBeside, besideInView == nil { panelChanged(from: oldValue.map(panelOf) ?? panelKey) } }
    }

    /// Which conversation's panel a session's tabs are in: a bot's session's are the bot's (by its
    /// ID), a group chat seat's the chat's, a subagent's the session that started it. The app sets it.
    @ObservationIgnored var panelOf: (String) -> String = { $0 }

    /// What an agent in a terminal needs to reach Kuvo Code's tools (see `BrowserToolServer.terminalVariables`),
    /// added to the environment of the panel's terminals. The app sets it.
    @ObservationIgnored var toolVariables: () -> [String: String] = { [:] }
    /// Whether a key is a terminal tab of the window (see `MainTerminals`), which is its own panel.
    @ObservationIgnored var isMainTerminal: (String) -> Bool = { _ in false }

    private static let panelTerminalPrefix = "panel-terminal:"

    /// The panel a terminal's agent works in: a main terminal's own (its key), a panel terminal's
    /// the panel its tab is in. Nil for a key that isn't a terminal here (or one that has ended).
    func terminalPanel(_ key: String) -> String? {
        if key.hasPrefix(Self.panelTerminalPrefix) {
            guard let id = UUID(uuidString: String(key.dropFirst(Self.panelTerminalPrefix.count))) else { return nil }
            return tabs.first { $0.id == id }?.owner
        }
        return isMainTerminal(key) ? key : nil
    }

    /// The environment for a panel terminal: the app's, the tools' and the terminal's own name.
    private func terminalEnvironment(_ environment: [String: String], tab: Tab) -> [String: String] {
        environment.merging(toolVariables()) { _, new in new }.merging(["KUVO_TERMINAL": Self.panelTerminalPrefix + tab.id.uuidString]) { _, new in new }
    }

    /// The conversation whose panel shows: the group chat in view, else the session you work in
    /// (either half of a split); "" for none (a new session's draft).
    var panelKey: String { panelKey() }

    private func panelKey(session: String?? = nil, beside: String?? = nil, group: String? = nil, isSet: Bool = false, worksBeside: Bool? = nil) -> String {
        if let group = isSet ? group : groupInView { return group }
        let session = session ?? sessionInView
        let beside = beside ?? besideInView
        let working = (worksBeside ?? self.worksBeside) ? beside ?? workedBeside ?? session : session
        return working.map(panelOf) ?? ""
    }

    /// Where a session shows: a subagent's in the session that started it, a group chat seat's in
    /// its chat (by its tab's key), any other in itself. The app sets it.
    @ObservationIgnored var shownIn: (String) -> String = { $0 }

    /// On screen: the tab's session, the one beside it, or the group chat in view; a subagent's
    /// or a seat's when where it shows is.
    func isInView(_ session: String) -> Bool {
        let shown = shownIn(session)
        return shown == sessionInView || shown == besideInView || shown == groupInView
    }
    /// The bots on this Mac whose conversation is in view (one, or a group chat's): their tabs
    /// show beside yours. The window sets it.
    var botsInView: Set<String> = [] {
        didSet {
            guard botsInView != oldValue else { return }
            // A tab of the bot left behind goes out of view: the one beside it takes its place.
            if let selected = tabs.first(where: { $0.id == selection }), !isVisible(selected) {
                selection = visibleTabs.last { $0.kind == .browser }?.id ?? visibleTabs.first?.id
            }
        }
    }

    /// The tab chosen in each conversation's panel, and place, to come back to.
    @ObservationIgnored private var chosen: [String: UUID] = [:]

    private func chosenKey(_ panel: String, _ place: String?) -> String { panel + "|" + (place ?? "") }

    /// The tabs in the strip: every tool's, and the browser tabs of the place in view.
    var visibleTabs: [Tab] { tabs.filter(isVisible) }

    var selected: Tab? { visibleTabs.first { $0.id == selection } ?? visibleTabs.first }

    func isVisible(_ tab: Tab) -> Bool {
        let key = panelKey
        switch tab.kind {
        // A group chat's bots browse beside it.
        case .browser: return place == nil && (tab.owner == key || (groupInView != nil && botsInView.contains(tab.owner)))
        case .machinePage(let machine, _): return place == machine && (tab.owner == key || tab.owner == Self.unclaimed)
        default: return tab.owner == key
        }
    }

    init() {
        startOver()
        tidying = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(min(300, max(5, Self.agentTabIdle / 2))))
                self?.tidyAgentTabs()
            }
        }
    }

    /// A conversation's panel as it opens: on Changes, or on a new tab if Settings › Panel says so.
    private func startOver() {
        if UserDefaults.standard.string(forKey: PanelSettings.startsWith) == PanelSettings.Start.newTab.rawValue {
            newTab()
        } else {
            add(Tab(kind: .changes, owner: panelKey), at: 0)
        }
    }

    /// Another place in view: its browser tabs in the strip, and the tab you had there.
    private func placeChanged(from old: String?) {
        chosen[chosenKey(panelKey, old)] = selection
        pendingReveal = nil
        if let old { machineBrowser?(old)?.keep(false) }
        if let place, let browser = machineBrowser?(place) {
            browser.keep(true)
            syncMachinePages(place, browser.pages)
        }
        restoreSelection()
    }

    /// Another conversation in view, or the other half of a split: its own panel, on the tab you
    /// had there, and what its agent showed you meanwhile.
    private func panelChanged(from old: String) {
        guard old != panelKey else { return }
        chosen[chosenKey(old, place)] = selection
        restoreSelection()
        showKept()
    }

    /// The tab you had in the panel in view, else the one in view if it's there too (a tool's, or
    /// a new tab opened as it changed); a panel with none of its own (only a machine's unclaimed
    /// pages, or a group chat's bots') starts over.
    private func restoreSelection() {
        let visible = visibleTabs
        let isVisible = { (id: UUID?) in id.flatMap { id in visible.contains { $0.id == id } ? id : nil } }
        selection = isVisible(chosen[chosenKey(panelKey, place)]) ?? isVisible(selection) ?? visible.first?.id
        if !visible.contains(where: { $0.owner == panelKey }) { startOver() }
    }

    /// Shows the Changes tab, opening it again if it was closed.
    func showChanges() {
        Analytics.shared.track("panel_opened", ["tool": "changes"])
        if let tab = visibleTabs.first(where: { $0.kind == .changes }) {
            selection = tab.id
        } else {
            add(Tab(kind: .changes, owner: panelKey), at: tabs.firstIndex { isVisible($0) } ?? 0)
        }
    }

    func newTerminal(in directory: String?, environment: [String: String]) {
        Analytics.shared.track("panel_opened", ["tool": "terminal"])
        let tab = Tab(kind: .terminal, owner: panelKey)
        let terminal = TerminalSession(directory: directory ?? NSHomeDirectory(), environment: terminalEnvironment(environment, tab: tab))
        terminal.addToMessage = { [weak self] text in self?.addToMessage?(text) }
        terminals[tab.id] = terminal
        add(tab)
    }

    /// Runs a project's run command in `directory`, in a terminal of its own. Run again, it
    /// stops what's still running there and starts the command over.
    func run(_ command: String, in directory: String, environment: [String: String]) {
        Analytics.shared.track("project_run")
        // Each conversation's panel runs it in its own terminal.
        let run = chosenKey(panelKey, directory)
        if let id = runs[run], let terminal = terminals[id], terminal.isRunning {
            terminal.run(command)
            selection = id
            return
        }
        let tab = Tab(kind: .terminal, owner: panelKey)
        let terminal = TerminalSession(directory: directory, environment: terminalEnvironment(environment, tab: tab), command: command)
        terminal.addToMessage = { [weak self] text in self?.addToMessage?(text) }
        terminals[tab.id] = terminal
        runs[run] = tab.id
        add(tab)
    }

    /// A browser tab at `address`; or, given WebKit's configuration, a window a page opened, placed
    /// right after the page's tab. When that window closes itself, its page's tab comes back. An
    /// agent's tab that isn't `shown` opens behind the one in view.
    @discardableResult
    func newBrowser(_ address: String? = nil, configuration: WKWebViewConfiguration? = nil, openedFrom opener: UUID? = nil, byAgent: Bool = false, owner: String? = nil, shown: Bool = true) -> BrowserSession {
        // Yours only: not the agent's tabs, nor windows a page opened.
        if !byAgent, configuration == nil {
            Analytics.shared.track("panel_opened", ["tool": "browser"])
            Analytics.shared.trackOnce("browser_used", key: "you.mac", ["by": "you", "place": "mac"])
        }
        // A window a page opens is in its panel too.
        let owner = owner ?? opener.flatMap { id in tabs.first { $0.id == id }?.owner } ?? panelKey
        let tab = Tab(kind: .browser, owner: owner)
        let browser = BrowserSession(configuration: configuration)
        browser.onVisit = { [weak history] url, title, icon in history?.record(url, title: title, iconURL: icon) }
        browser.openWindow = { [weak self] configuration in
            self?.newBrowser(configuration: configuration, openedFrom: tab.id).webView
        }
        browser.onClose = { [weak self] in
            guard let self else { return }
            close(tab.id)
            if let opener, let page = tabs.first(where: { $0.id == opener }), isVisible(page) { selection = opener }
        }
        browsers[tab.id] = browser
        if let address { browser.load(address) }
        // An agent's, or a window its page opened: it tidies itself away unless you look at it.
        if byAgent || opener.map({ unseen[$0] != nil }) == true { unseen[tab.id] = .now }
        // A window a conversation's page opens is that conversation's too, and the agent goes on
        // in it (a sign-in window); it comes forward if its page is in view, or its agent's
        // browsing would bring it.
        let claim = opener.flatMap { agentClaims[$0] }
        if let claim { agentClaims[tab.id] = (claim.session, .now) }
        let comesForward = shown && (opener == nil || opener == selection || claim.map { bringsForward($0.session) } ?? true)
        add(tab, at: opener.flatMap { id in tabs.firstIndex { $0.id == id }.map { $0 + 1 } }, select: comesForward)
        // One you opened yourself is the tab you're looking at now.
        if !byAgent, configuration == nil { picked(tab.id) }
        return browser
    }

    // MARK: Machines' browsers

    /// A new tab in a machine's browser: it opens a page there once you go somewhere (at
    /// `address` at once, if given).
    func newMachinePage(_ machine: String, address: String? = nil) {
        Analytics.shared.track("panel_opened", ["tool": "machine_browser"])
        Analytics.shared.trackOnce("browser_used", key: "you.machine", ["by": "you", "place": "machine"])
        let tab = Tab(kind: .machinePage(machine, nil), owner: panelKey)
        add(tab)
        if let address { open(address, inTab: tab.id) }
    }

    /// Opens `address` in a machine's new tab: a page there, which the tab then shows.
    func open(_ address: String, inTab id: UUID) {
        guard let tab = tabs.first(where: { $0.id == id }), case .machinePage(let machine, nil) = tab.kind,
              let browser = machineBrowser?(machine) else { return }
        Task {
            guard let page = await browser.newPage(address) else { return }
            bind(id, to: page, on: machine)
        }
    }

    /// A new tab's page is open: the tab shows it, in its own place in the strip.
    private func bind(_ id: UUID, to page: String, on machine: String) {
        // The page may have made a tab of its own on the way (its browser said it opened).
        if let other = tabs.firstIndex(where: { $0.kind == .machinePage(machine, page) && $0.id != id }) {
            tabs.remove(at: other)
        }
        guard let index = tabs.firstIndex(where: { $0.id == id }) else {
            // The tab closed meanwhile: so does its page.
            machineBrowser?(machine)?.close(page)
            return
        }
        tabs[index].kind = .machinePage(machine, page)
    }

    /// Keeps a machine's tabs in step with its browser's pages: a tab for each page (one the agent
    /// opened included), and none for a page that closed.
    func syncMachinePages(_ machine: String, _ pages: [MachineBrowser.Page]) {
        let open = Set(pages.map(\.id))
        // The tab its conversation's panel shows at that machine, in view or to come back to.
        func isShown(_ tab: Tab) -> Bool {
            (place == machine && selection == tab.id) || chosen[chosenKey(tab.owner, machine)] == tab.id
        }
        for tab in tabs {
            guard case .machinePage(machine, let page?) = tab.kind, !open.contains(page) else { continue }
            // A window that closed (a sign-in's popup, done) gives way to the page that opened it.
            let opener = openers.removeValue(forKey: page).flatMap { opener in tabs.first { $0.kind == .machinePage(machine, opener) } }
            let wasShown = isShown(tab)
            remove(tab.id)
            if wasShown, let opener { show(opener, on: machine) }
        }
        let tabbed = Set(tabs.compactMap { tab -> String? in
            if case .machinePage(machine, let page?) = tab.kind { return page }
            return nil
        })
        for page in pages where !tabbed.contains(page.id) {
            let last = tabs.lastIndex { if case .machinePage(machine, _) = $0.kind { true } else { false } }
            // In the panel of the conversation whose agent works there, or of the page that opened
            // it; else unclaimed, until an agent works in it (`machinePageActive`) or you pick it.
            let worker = machineBrowser?(machine)?.session(of: page.id)
            let opened = page.opener.flatMap { opener in tabs.first { $0.kind == .machinePage(machine, opener) }?.owner }
            let tab = Tab(kind: .machinePage(machine, page.id), owner: worker.map(panelOf) ?? opened ?? Self.unclaimed)
            tabs.insert(tab, at: last.map { $0 + 1 } ?? tabs.count)
            // A window the page in view opened comes forward, as a browser shows it.
            if let opener = page.opener {
                openers[page.id] = opener
                if let opening = tabs.first(where: { $0.kind == .machinePage(machine, opener) }), isShown(opening) { show(tab, on: machine) }
            }
        }
        // The page an agent started browsing in has its tab now: show it.
        if let pending = pendingReveal, pending.machine == machine, Date.now.timeIntervalSince(pending.since) < 120,
           tabs.contains(where: { if case .machinePage(machine, _?) = $0.kind { true } else { false } }) {
            pendingReveal = nil
            revealMachineBrowser(machine, for: pending.session)
        }
    }

    /// The page each machine window was opened by, by page.
    @ObservationIgnored private var openers: [String: String] = [:]

    private func show(_ tab: Tab, on machine: String) {
        if place == machine, isVisible(tab) { selection = tab.id } else { chosen[chosenKey(tab.owner, machine)] = tab.id }
    }

    /// The agent on a machine went to another page (or opened one): its tab comes forward, as the
    /// panel's browser does for the agent here.
    func machinePageActive(_ machine: String, page: String, byAgent: Bool, session: String? = nil) {
        guard byAgent, let index = tabs.firstIndex(where: { $0.kind == .machinePage(machine, page) }) else { return }
        // The page is in the panel of the conversation whose agent works in it.
        if let session { tabs[index].owner = panelOf(session) }
        let tab = tabs[index]
        if place == machine, isVisible(tab), session.map(isInView) ?? true {
            selection = tab.id
            if PanelSettings.isOn(PanelSettings.revealsForAgent) { revealRequest += 1 }
        } else {
            chosen[chosenKey(tab.owner, machine)] = tab.id
        }
    }

    /// An agent on a machine started browsing: with a session there in view, the panel shows the
    /// page it uses. Until the page has a tab here, the panel waits for it, rather than opening
    /// on another tool with nothing of the agent's to see.
    func revealMachineBrowser(_ machine: String, for session: String? = nil) {
        guard place == machine, session.map(isInView) ?? true else { return }
        let browser = machineBrowser?(machine)
        let visible = visibleTabs
        let tab = visible.first { $0.kind == .machinePage(machine, browser?.activeID) }
            ?? visible.last { if case .machinePage(machine, _?) = $0.kind { true } else { false } }
        guard let tab else {
            pendingReveal = (machine, session, .now)
            return
        }
        pendingReveal = nil
        selection = tab.id
        if PanelSettings.isOn(PanelSettings.revealsForAgent) { revealRequest += 1 }
    }

    /// An agent on a machine that started browsing before its page had a tab here.
    @ObservationIgnored private var pendingReveal: (machine: String, session: String?, since: Date)?

    /// Shows the browser in the panel: `page` if it's given (the page an ask is about: a machine's
    /// page, or this Mac's tab), else the one the agent used last.
    func revealBrowser(page: String? = nil) {
        if let place {
            let visible = visibleTabs
            let tab = page.flatMap { page in visible.first { $0.kind == .machinePage(place, page) } }
                ?? visible.first { $0.kind == .machinePage(place, machineBrowser?(place)?.activeID) }
                ?? visible.last { if case .machinePage(place, _) = $0.kind { true } else { false } }
            if let tab { selection = tab.id }
        } else if let id = page.flatMap(UUID.init(uuidString:)), browsers[id] != nil, let tab = tabs.first(where: { $0.id == id }), isVisible(tab) {
            // The tab an ask here is about.
            selection = id
        } else if let browser = botsInView.lazy.compactMap(botBrowser).first ?? activeBrowser, let id = id(of: browser) {
            selection = id
        }
        revealRequest += 1
    }

    /// Closes a machine's tabs: the machine was removed or disconnected.
    func closeMachineBrowser(_ machine: String) {
        for tab in tabs {
            if case .machinePage(machine, _) = tab.kind { remove(tab.id, refills: false) }
        }
        // Not with a new page on the machine that's going: the Changes tab, which needs none.
        if visibleTabs.isEmpty { add(Tab(kind: .changes, owner: panelKey)) }
    }

    // MARK: Files

    /// The file tree, in a tab of its own.
    func showFiles() {
        Analytics.shared.track("panel_opened", ["tool": "files"])
        if let tab = visibleTabs.first(where: { $0.kind == .file(nil) }) {
            selection = tab.id
        } else {
            add(Tab(kind: .file(nil), owner: panelKey))
        }
    }

    /// Opens `url` in a file tab: its own if it has one, else the file tab in view.
    func open(_ url: URL) {
        if let tab = visibleTabs.first(where: { $0.kind == .file(url) }) {
            selection = tab.id
        } else if let current = selected, case .file = current.kind, let index = tabs.firstIndex(of: current) {
            tabs[index].kind = .file(url)
        } else {
            add(Tab(kind: .file(url), owner: panelKey))
        }
    }

    /// A new tab: an empty browser tab of the place in view, which shows the tools and suggested
    /// sites until you go somewhere.
    func newTab() {
        if let place {
            newMachinePage(place)
        } else {
            newBrowser()
        }
    }

    /// Swaps a tab for another tool, in its place: what picking a tool on a new tab page does.
    func replace(_ id: UUID, with open: () -> Void) {
        let before = Set(tabs.map(\.id))
        open()
        // Put a tab the tool added where this one was (it may have reused an existing tab instead).
        if let added = tabs.first(where: { !before.contains($0.id) }), let from = tabs.firstIndex(of: added) {
            tabs.remove(at: from)
            tabs.insert(added, at: tabs.firstIndex(where: { $0.id == id }) ?? tabs.count)
        }
        close(id)
    }

    /// A subagent in a tab of the panel in view (its own, if it has one there), and the panel
    /// shown: you asked to see it, from the conversation you're in.
    func showSubagent(_ id: String, folder: String) {
        Analytics.shared.track("panel_opened", ["tool": "subagent"])
        let owner = panelKey
        if let tab = tabs.first(where: { $0.owner == owner && $0.kind == .subagent(id, folder: folder) }) {
            selection = tab.id
        } else {
            add(Tab(kind: .subagent(id, folder: folder), owner: owner))
        }
        revealRequest += 1
    }

    /// Shows the Changes tab and brings the panel into view: you asked to see it.
    func revealChanges() {
        showChanges()
        revealRequest += 1
    }

    /// Where the file tree should open down to (and show): what an agent showed you, until the
    /// tree has (it's taken once, not each time a file tab shows).
    private(set) var treeReveal: URL?

    /// The tree opened down to it.
    func revealed() { treeReveal = nil }

    /// What agents showed you while you were in another conversation, by its panel: the latest
    /// of each, shown when you come back to it.
    @ObservationIgnored private var kept: [String: (url: URL, isFolder: Bool)] = [:]

    /// An agent showing you a file or folder, in its conversation: a folder in the Files tab, open
    /// down to it; a file in a tab of its own (not over the one you have open), with the tree open
    /// to it too. With its conversation out of view, it waits for you to come back to it.
    func showInPanel(_ url: URL, isFolder: Bool, for session: String) {
        // Kept for its panel: a subagent's is the session's that started it.
        let panel = panelOf(session)
        guard panel == panelKey else {
            kept[panel] = (url, isFolder)
            return
        }
        kept[panel] = nil
        show(url, isFolder: isFolder)
    }

    /// Counts each time a file already open is shown again, for its tab to read it again.
    private(set) var fileShown = 0

    /// A folder in the Files tab, open down to it, or a file in a tab of its own, and the panel in
    /// view: what an agent showed you, again from its step in the conversation.
    func show(_ url: URL, isFolder: Bool) {
        if isFolder {
            showFiles()
        } else if let tab = visibleTabs.first(where: { $0.kind == .file(url) }) {
            selection = tab.id
            // Shown again: as it is now (the agent may have changed it since).
            fileShown += 1
        } else {
            add(Tab(kind: .file(url), owner: panelKey))
        }
        treeReveal = url
        revealRequest += 1
    }

    /// What was kept for the panel now in view, unless it's gone since.
    private func showKept() {
        guard let shown = kept.removeValue(forKey: panelKey) else { return }
        if shown.url.isFileURL, !FileManager.default.fileExists(atPath: shown.url.path) { return }
        show(shown.url, isFolder: shown.isFolder)
    }

    /// Opens `url` in a file tab and brings the panel into view: you asked to see it.
    func show(_ url: URL) {
        open(url)
        revealRequest += 1
    }

    /// Brings the panel into view, on `browser`'s tab if given.
    func reveal(_ browser: BrowserSession? = nil) {
        if let browser, let id = browsers.first(where: { $0.value === browser })?.key {
            // A bot's tab out of view stays there: the bot browses out of sight; and a page you
            // took over stays in view.
            guard let tab = tabs.first(where: { $0.id == id }), isVisible(tab), !holdsSelection || id == selection else { return }
            selection = id
        }
        if PanelSettings.isOn(PanelSettings.revealsForAgent) { revealRequest += 1 }
    }

    /// The tab `browser` is in, while it's open.
    func id(of browser: BrowserSession) -> UUID? {
        browsers.first { $0.value === browser }?.key
    }

    // MARK: Conversations' tabs

    /// The conversation whose agent works in each of your tabs lately, and when: a tab one uses
    /// isn't another's to take over (see `isFree`), so each keeps to its own page.
    @ObservationIgnored private var agentClaims: [UUID: (session: String, at: Date)] = [:]
    /// When you last picked one of your tabs with a conversation in view: its agent goes on there.
    @ObservationIgnored private var picks: [String: Date] = [:]
    /// How long a tab stays with the conversation whose agent used it last.
    static let agentHold: TimeInterval = 90

    /// The tab a conversation's agent works in: the one it worked in last, unless you picked
    /// another for it since; else, for a conversation in view, yours in view (or your latest),
    /// unless another conversation's agent is using it or you took it over. Nil when it needs a
    /// tab of its own: one you aren't looking at never starts in yours.
    func agentBrowser(for session: String) -> BrowserSession? {
        let panel = panelOf(session)
        if let own = ownTab(of: session), tabs.first(where: { $0.id == own })?.owner == panel { return browsers[own] }
        guard let browser = browser(in: panel), let id = id(of: browser), !browser.isHeld, isFree(id, for: session) else { return nil }
        return browser
    }

    /// The tab a conversation's agent worked in last, while it's open and you haven't picked
    /// another for it since.
    func ownTab(of session: String) -> UUID? {
        let mine = agentClaims.filter { $0.value.session == session && browsers[$0.key] != nil }.max { $0.value.at < $1.value.at }
        guard let mine, (picks[session] ?? .distantPast) <= mine.value.at else { return nil }
        return mine.key
    }

    /// Whether a conversation's agent may work in a tab: one no other conversation's agent has
    /// used in the last moments, nor waits in for you (a sign-in, a code), and whose conversation
    /// isn't in view; or one the same conversation's other agent (its subagent, or the one that
    /// started it) used, after those moments.
    func isFree(_ id: UUID, for session: String) -> Bool {
        guard let claim = agentClaims[id], claim.session != session else { return true }
        guard browsers[id]?.waitsForYou != true, Date.now.timeIntervalSince(claim.at) > Self.agentHold else { return false }
        return shownIn(claim.session) == shownIn(session) || !isInView(claim.session)
    }

    /// A conversation's agent works in `browser` now.
    func agentWorks(_ session: String, in browser: BrowserSession) {
        guard let id = id(of: browser) else { return }
        // What happened there before was someone else's business.
        if agentClaims[id]?.session != session { browser.agentNotes = [] }
        agentClaims[id] = (session, .now)
    }

    // MARK: Tidying agents' tabs

    /// The tabs an agent opened that you haven't looked at, and when an agent last worked in each.
    @ObservationIgnored private var unseen: [UUID: Date] = [:]
    @ObservationIgnored private var tidying: Task<Void, Never>?
    /// How long one of those stays once no agent works in it: then it closes itself, so
    /// conversations that browse out of sight (a session's subagents, a bot that wakes every hour)
    /// don't pile up pages that stay loaded. A machine's browser does the same with its pages
    /// (kuvo-browser.js, TAB_IDLE).
    static var agentTabIdle: TimeInterval {
        #if DEBUG
        // KUVO_DEMO_TAB_IDLE=<seconds>: sooner, to try it.
        if let seconds = ProcessInfo.processInfo.environment["KUVO_DEMO_TAB_IDLE"].flatMap(TimeInterval.init) { return seconds }
        #endif
        return 3600
    }

    /// Whether a conversation (by its session, or a bot by its ID) is at work, or waits for you
    /// (a permission, a question): its tabs stay however long it was since it browsed. The app
    /// sets it.
    @ObservationIgnored var isBusy: (String) -> Bool = { _ in false }

    /// An agent takes a step in `browser`'s tab.
    func agentUsed(_ browser: BrowserSession) {
        if let id = id(of: browser), unseen[id] != nil { unseen[id] = .now }
    }

    /// Closes the tabs agents opened that you never looked at and none has worked in for
    /// `agentTabIdle`; not one that waits for you (a sign-in, a code), one you took over, the one
    /// in view, or one whose conversation is at work or waits for you.
    func tidyAgentTabs(now: Date = .now) {
        // Settings › Panel can keep them.
        guard PanelSettings.isOn(PanelSettings.tidiesAgentTabs) else { return }
        for (id, used) in unseen where now.timeIntervalSince(used) > Self.agentTabIdle {
            guard let tab = tabs.first(where: { $0.id == id }), let browser = browsers[id] else {
                unseen[id] = nil
                continue
            }
            guard !browser.isHeld, !browser.waitsForYou, !(isVisible(tab) && selected?.id == id) else { continue }
            // Not while its conversation works, or waits for you, to go on in it.
            guard !isBusy(agentClaims[id]?.session ?? tab.owner) else { continue }
            close(id, refills: false)
        }
    }

    /// Tells a machine's browser whether to close agents' pages you never looked at, as Settings ›
    /// Panel says: a file in its folder, while it's to keep them (`kuvo-browser.js`).
    static func shareTabTidying(on machine: String) async {
        let file = "\"$HOME/\(RemoteEngineInstaller.root)/browser/keeps-agent-tabs\""
        let script = PanelSettings.isOn(PanelSettings.tidiesAgentTabs)
            ? "rm -f \(file)"
            : "mkdir -p \"$HOME/\(RemoteEngineInstaller.root)/browser\" && : > \(file)"
        _ = await Task.detached { RemoteShell.run(script, on: machine) }.value
    }

    /// The tabs a conversation's agent has worked in.
    func agentTabs(of session: String) -> [BrowserSession] {
        agentClaims.filter { $0.value.session == session }.compactMap { browsers[$0.key] }
    }

    /// Whether a conversation's browsing brings its tab forward: one in view's (beside the tab's
    /// too, and its subagents'), not another's behind it.
    func bringsForward(_ session: String) -> Bool {
        isInView(session)
    }

    /// You picked one of your tabs with a conversation in view: the agent of the one you work in
    /// (either half of a split) goes on in it, unless another conversation's agent is using it.
    private func picked(_ id: UUID) {
        guard let session = worksBeside ? besideInView ?? sessionInView : sessionInView, let browser = browsers[id], tabs.first(where: { $0.id == id })?.owner == panelOf(session), isFree(id, for: session) else { return }
        picks[session] = .now
        agentWorks(session, in: browser)
    }

    /// The browser in view in the panel in view, or its most recent one (never a group chat's bot's).
    var activeBrowser: BrowserSession? { browser(in: panelKey) }

    /// A conversation's panel's browser: the one in view if that panel is, else its most recent.
    func browser(in panel: String) -> BrowserSession? {
        if panel == panelKey, let selected, selected.owner == panel, let browser = browsers[selected.id] { return browser }
        return tabs.reversed().lazy.filter { $0.owner == panel }.compactMap { self.browsers[$0.id] }.first
    }

    /// The tab a bot on this Mac browses in: the one in view if it's the bot's, else the one it
    /// last worked in, else its latest.
    func botBrowser(_ owner: String) -> BrowserSession? {
        if let selected, selected.owner == owner, let browser = browsers[selected.id] { return browser }
        if let id = botTabs[owner], let browser = browsers[id] { return browser }
        return tabs.reversed().lazy.filter { $0.owner == owner }.compactMap { self.browsers[$0.id] }.first
    }

    /// Each bot's tab it last worked in, so a tab it switched to stays its tab in use.
    @ObservationIgnored private var botTabs: [String: UUID] = [:]

    func botWorks(_ owner: String, in browser: BrowserSession) {
        botTabs[owner] = browsers.first { $0.value === browser }?.key
    }

    /// The browser tabs of a conversation's panel (a bot's, by its ID), in order.
    func browserTabs(of owner: String) -> [(id: UUID, browser: BrowserSession)] {
        tabs.filter { $0.owner == owner }.compactMap { tab in browsers[tab.id].map { (tab.id, $0) } }
    }

    /// Closes a tab, and what it shows: its terminal, its page (on a machine too).
    func close(_ id: UUID, refills: Bool = true) {
        if let tab = tabs.first(where: { $0.id == id }), case .machinePage(let machine, let page?) = tab.kind {
            machineBrowser?(machine)?.close(page)
        }
        remove(id, refills: refills)
    }

    /// A new session's draft became the session: the tabs you opened while writing it are its.
    func adoptDraft(as session: String) {
        let panel = panelOf(session)
        for index in tabs.indices where tabs[index].owner == "" { tabs[index].owner = panel }
        if let tab = chosen.removeValue(forKey: chosenKey("", place)) { chosen[chosenKey(panel, place)] = tab }
    }

    /// A conversation that carries on in another (moved to the coding agents): its panel's tabs,
    /// the one you'd chosen there, and those its agent worked in go with it.
    func handOver(from old: String, to new: String) {
        let from = panelOf(old), to = panelOf(new)
        guard from != to else { return }
        for index in tabs.indices where tabs[index].owner == from { tabs[index].owner = to }
        for (key, tab) in chosen where key.hasPrefix(from + "|") {
            chosen[key] = nil
            chosen[to + key.dropFirst(from.count)] = tab
        }
        if let file = kept.removeValue(forKey: from) { kept[to] = file }
        for (id, claim) in agentClaims where claim.session == old { agentClaims[id] = (new, claim.at) }
        if let picked = picks.removeValue(forKey: old) { picks[new] = picked }
    }

    /// Closes a conversation's panel: the bot or session was deleted.
    func closeTabs(of owner: String) {
        for tab in tabs where tab.owner == owner { close(tab.id, refills: false) }
        chosen = chosen.filter { !$0.key.hasPrefix(owner + "|") }
        kept[owner] = nil
    }

    /// Takes a tab out of the strip; the tab beside it takes its place. A panel that's going
    /// (its conversation was deleted) isn't refilled.
    private func remove(_ id: UUID, refills: Bool = true) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        let at = visibleTabs.firstIndex { $0.id == id }
        let wasSelected = selected?.id == id
        tabs.remove(at: index)
        terminals.removeValue(forKey: id)?.terminate()
        browsers.removeValue(forKey: id)?.close()
        agentClaims[id] = nil
        unseen[id] = nil
        if wasSelected {
            let rest = visibleTabs
            selection = at.flatMap { rest.indices.contains($0) ? rest[$0].id : nil } ?? rest.last?.id
        }
        // The panel always has a tab: closing the last one leaves a new tab in its place.
        if refills, visibleTabs.isEmpty { newTab() }
    }

    /// Ends every terminal and page, and starts the panel over: the window is closing, and its
    /// tabs go with what they showed (a tab left without its terminal or page would show nothing).
    /// A machine's pages keep running there, and come back as tabs.
    func closeAll() {
        for terminal in terminals.values { terminal.terminate() }
        for browser in browsers.values { browser.close() }
        terminals = [:]
        browsers = [:]
        agentClaims = [:]
        unseen = [:]
        runs = [:]
        // Every conversation's panel starts over when it's next in view.
        tabs.removeAll { tab in
            if case .machinePage = tab.kind { return false }
            return true
        }
        chosen = [:]
        selection = nil
        let place = place
        // Back on this Mac for the start tab (going there may have made it already).
        self.place = nil
        if !visibleTabs.contains(where: { $0.owner == panelKey }) { startOver() }
        self.place = place
    }

    private func add(_ tab: Tab, at index: Int? = nil, select: Bool = true) {
        tabs.insert(tab, at: index ?? tabs.count)
        // A bot's tab out of view stays out of view.
        if select, isVisible(tab) { selection = tab.id }
    }
}
