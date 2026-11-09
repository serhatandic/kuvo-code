import AppKit
import ImageIO
import OpenCodeKit
import os

/// Where a machine's browser sends its page's pictures as they come.
@MainActor protocol PictureView: AnyObject {
    func show(_ picture: MachineBrowser.Picture?)
    /// The agent is about to act on the element at `rect` (CSS pixels in the window).
    func point(_ action: AgentPointer.Action, at rect: CGRect)
}

/// A machine's browser: a Chromium kept running on the machine (`kuvo-browser.js`), which the
/// agents there browse with, so it carries on while this Mac is off. The machine's box sets it up
/// itself; this Mac shows how that goes. Its pages are the panel's browser tabs while a session on the machine
/// is in view: the one you look at shows live, and you can click and type in it yourself.
@Observable
final class MachineBrowser {
    enum Setup: Equatable {
        case unknown
        /// The machine's box setting it up: downloading, by the fraction done; nil while it checks or
        /// puts it together.
        case installing(Double?)
        case ready
        case failed(String)
    }

    enum State: Equatable {
        case idle
        case connecting
        case live
        case failed(String)
    }

    struct Page: Identifiable, Equatable {
        let id: String
        var title: String
        var url: String
        /// The page that opened it (a sign-in's popup, a link to a new window).
        var opener: String?

        /// Nothing on it yet.
        var isBlank: Bool { url.isEmpty || url == "about:blank" }

        /// Its title, else its address, for tabs and menus.
        var name: String {
            if isBlank { return "New Tab" }
            // Until a page sets its title, Chromium gives its address without the scheme.
            if !title.isEmpty, title != url, !url.hasSuffix("://" + title) { return title }
            return URL(string: url)?.host()?.replacingOccurrences(of: "www.", with: "") ?? url
        }
    }

    /// An alert, confirmation or question the page is waiting on.
    struct Dialog: Equatable {
        var type: String
        var message: String
        var defaultPrompt: String
    }

    let machine: Machine
    private(set) var setup = Setup.unknown
    private(set) var state = State.idle
    /// The browser's pages, in the order they opened.
    private(set) var pages: [Page] = [] {
        // A page that's left the site that asked for a passkey, or closed: its note goes.
        didSet { passkeyPages = passkeyPages.filter { id, site in pages.first { $0.id == id }.flatMap { Self.site(of: $0.url) } == site } }
    }
    /// The page in use: the one the agent or you last used.
    private(set) var activeID: String?
    /// The page the panel shows.
    private(set) var shownPage: String?
    /// Its latest picture, which goes straight to the view showing it (`pictureView`), never
    /// through SwiftUI: they come many times a second.
    @ObservationIgnored private(set) var picture: Picture? {
        didSet {
            pictureView?.show(picture)
            if (picture != nil) != hasPicture { hasPicture = picture != nil }
        }
    }
    private(set) var hasPicture = false
    /// Files its pages downloaded on the machine lately, the latest last, while the bar shows them.
    private(set) var downloads: [Download] = []

    /// A file a page downloaded into the browser's folder on the machine, and its copy on this Mac.
    struct Download: Identifiable, Equatable {
        let id = UUID()
        var name: String
        var path: String
        var state: State = .onMachine

        enum State: Equatable { case onMachine, saving, saved(URL), failed(String) }
    }
    @ObservationIgnored weak var pictureView: PictureView? {
        didSet { pictureView?.show(picture) }
    }

    /// A picture of the page: its size and where it was scrolled to, in CSS pixels.
    struct Picture {
        var image: CGImage
        var size: CGSize
        var scroll: CGPoint
    }
    private(set) var isLoading = false
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    /// An agent is at work in the page shown, or was a moment ago (it thinks between its steps).
    var isAgentBrowsing: Bool { shownPage.map { workingPages.contains($0) || restingPages.contains($0) } ?? false }
    /// The session of the agent at work in the page shown, when it says.
    var browsingSession: String? { shownPage.flatMap { workers[$0] } }
    /// You took the page shown over from the agent: its tools wait until you hand it back.
    var isHeld: Bool { shownPage.map(heldPages.contains) ?? false }
    /// The pages agents are at work in, and whose sessions they are.
    private var workingPages: Set<String> = [] {
        didSet { rest(oldValue.subtracting(workingPages)) }
    }
    private var workers: [String: String] = [:]
    /// The session of the agent at work in a page, when it says.
    func session(of page: String) -> String? { workers[page] }
    /// Pages an agent finished a step in a moment ago, and pages taken over (by any Mac).
    private var restingPages: Set<String> = []
    private var heldPages: Set<String> = []

    private static func workingPages(_ status: [String: Any]) -> Set<String> {
        guard status["working"] as? Bool == true else { return [] }
        return Set(status["pages"] as? [String] ?? [])
    }

    /// Pages an agent just stopped in stay "browsing" a few seconds, so the badge (and its Take
    /// Over) doesn't flicker between its steps.
    private func rest(_ pages: Set<String>) {
        guard !pages.isEmpty else { return }
        restingPages.formUnion(pages)
        Task {
            try? await Task.sleep(for: .seconds(4))
            restingPages.subtract(pages.subtracting(workingPages))
        }
    }

    /// Pages this Mac took over.
    @ObservationIgnored private var myHolds: Set<String> = []
    /// Pages handed back while there was no connection, to tell the keeper once there is.
    @ObservationIgnored private var handedBackOffline: Set<String> = []

    /// Takes the page shown over from the agent, or hands it back.
    func takeOver(_ on: Bool) {
        guard let page = shownPage else { return }
        hold(page, on)
        if on { Analytics.shared.track("browser_taken_over", ["machine": true]) }
    }

    /// You moved on from a page you took over: back to its agent.
    func handBack(_ page: String) {
        if myHolds.contains(page) { hold(page, false) }
    }

    private func hold(_ page: String, _ on: Bool) {
        if on {
            heldPages.insert(page)
            myHolds.insert(page)
            handedBackOffline.remove(page)
        } else {
            heldPages.remove(page)
            myHolds.remove(page)
            if link == nil { handedBackOffline.insert(page) }
        }
        link?.fire("Kuvo.hold", ["targetId": page, "on": on, "mac": MachineEngine.macID])
    }

    /// Closing on purpose (the machine removed, the app quitting): the pages this Mac took over go
    /// back to their agents now, rather than when the keeper gives up on it.
    private func handBackAll() {
        if link == nil { handedBackOffline.formUnion(myHolds) }
        for page in myHolds { link?.fire("Kuvo.hold", ["targetId": page, "on": false, "mac": MachineEngine.macID]) }
        heldPages.subtract(myHolds)
        myHolds = []
    }

    private func noteWorkers(_ status: [String: Any]) {
        var found: [String: String] = [:]
        for worker in status["workers"] as? [[String: Any]] ?? [] {
            if let page = worker["targetId"] as? String, let session = worker["session"] as? String { found[page] = session }
        }
        if found != workers { workers = found }
    }
    private(set) var dialog: Dialog?

    /// Told when pages open or close, and when the agent moves to another page (or you do).
    @ObservationIgnored var onPages: ([Page]) -> Void = { _ in }
    @ObservationIgnored var onActive: (_ page: String, _ byAgent: Bool, _ session: String?) -> Void = { _, _, _ in }
    /// The conversation in view, whose agent a page you pick is for.
    @ObservationIgnored var sessionInView: (() -> String?)?
    /// Told when the agent asks you for something (a sign-in, a code, a step only you can do),
    /// and when that ask ends without you (it stopped waiting, or another Mac answered).
    @ObservationIgnored var onAsk: (BrowserAsks.Ask) -> Void = { _ in }
    @ObservationIgnored var onAskClosed: (String) -> Void = { _ in }
    /// Told of each site whose page asked for a passkey, which this browser can't use yet.
    @ObservationIgnored var onPasskeyAsked: (String) -> Void = { _ in }
    /// The site of each page (by target) that asked for a passkey, for its note in the live view,
    /// until you close it (or the page is on another site).
    private(set) var passkeyPages: [String: String] = [:]

    /// Notes you closed, by page and site: the keeper's hello after a reconnect (a sleep) doesn't
    /// bring them back.
    @ObservationIgnored private var closedPasskeyNotes: Set<String> = []

    /// You closed a page's note about a passkey.
    func closePasskeyNote(_ page: String) {
        guard let site = passkeyPages.removeValue(forKey: page) else { return }
        closedPasskeyNotes.insert(page + "|" + site)
    }

    /// A page's site as the keeper names it (and asks do): its host, "http://host" over http.
    static func site(of address: String) -> String? {
        BrowserAgent.site(of: URL(string: address)).map { $0 == "a file on this Mac" ? "a file on this machine" : $0 }
    }
    /// The asks open on the machine.
    @ObservationIgnored private var openAsks: Set<String> = []
    @ObservationIgnored private var expecting = false

    @ObservationIgnored private var link: MachineBrowserLink?
    @ObservationIgnored private var session: String?
    /// Goes up with each page shown, so a slower earlier switch can't win.
    @ObservationIgnored private var generation = 0
    /// The panel wants the browser while its tabs are in the strip, and while a tab shows a page.
    @ObservationIgnored private var keepers = 0
    @ObservationIgnored private var viewers = 0
    @ObservationIgnored private var dropTask: Task<Void, Never>?
    @ObservationIgnored private var viewport = (size: CGSize(width: 800, height: 600), scale: CGFloat(2))
    @ObservationIgnored private var viewportTask: Task<Void, Never>?
    @ObservationIgnored private var history: [Int] = []
    @ObservationIgnored private var historyIndex = 0
    @ObservationIgnored private var preparing: Task<Void, Never>?
    @ObservationIgnored private var reconnects = 0
    private let log = Logger(subsystem: "run.kuvo.code", category: "machine-browser")

    init(machine: Machine) {
        self.machine = machine
        _ = Self.oldCacheGone
        // After the Mac sleeps, the connection is gone, though SSH takes a while to notice: start
        // a fresh one right away.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main, using: { [weak self] _ in
            MainActor.assumeIsolated { self?.wake() }
        })
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main, using: { [weak self] _ in
            MainActor.assumeIsolated {
                // Written before the app is gone; SSH sends it as its input closes.
                self?.handBackAll()
                self?.link?.flush()
            }
        })
    }

    private func wake() {
        guard link != nil || state != .idle else { return }
        disconnect()
        resume()
    }

    /// What this Mac put together for machines before their boxes set the browser up themselves
    /// (hundreds of MB, `browser-linux`): gone, once, in the background.
    private static let oldCacheGone: Void = {
        let old = StorageReport.oldBrowserFolder
        Task.detached(priority: .background) { try? FileManager.default.removeItem(at: old) }
    }()

    private var isWanted: Bool { keepers > 0 || viewers > 0 }

    func page(_ id: String?) -> Page? {
        pages.first { $0.id == id }
    }

    /// A page's address, unless it's empty.
    func url(of id: String?) -> URL? {
        guard let page = page(id), !page.isBlank else { return nil }
        return URL(string: page.url)
    }

    // MARK: Setting it up

    /// Makes sure the machine has the browser, its box setting it up if not. Once at a time.
    func prepare(now: Bool = false) async {
        if setup == .ready { return }
        if let preparing { return await preparing.value }
        let task = Task { await install(now: now) }
        preparing = task
        await task.value
        preparing = nil
        if setup == .ready, isWanted, link == nil { connect() }
    }

    private func install(now: Bool) async {
        // A stand-in (a demo copy's, under `.invalid`) is never contacted: nothing's installed there.
        guard !machine.connection.isNeverContacted else {
            #if DEBUG
            // KUVO_DEMO_MACHINE_BROWSER: how its browser shows (`DemoMachines`).
            switch DemoMachines.browser {
            case "failed": setup = .failed(DemoMachines.failure(of: machine.name))
            case "connecting":
                setup = .ready
                state = .connecting
            default: setup = .installing(0.37)
            }
            #else
            setup = .failed("Couldn’t reach \(machine.name).")
            #endif
            return
        }
        let connection = machine.connection
        // The machine's box sets the browser up itself (PROTOCOL.md, "The browser on a machine"):
        // this asks it to, and follows how it goes. A connection that drops on the way is tried
        // twice more.
        var asked = false
        var drops = 0
        while true {
            do {
                guard let status = try await MachineBrowserInstaller.status(start: !asked, now: now, on: connection) else {
                    // An older box: its helper sets the browser up when it's first used.
                    setup = .ready
                    return
                }
                asked = true
                drops = 0
                if status.installed != nil || status.state == "ready" {
                    setup = .ready
                    return
                }
                if !status.isUnderWay {
                    log.error("\(self.machine.destination, privacy: .public) couldn't get the browser: \(status.message ?? status.state, privacy: .public)")
                    setup = .failed(status.message ?? "\(machine.name) couldn’t set up its browser.")
                    return
                }
                setup = .installing(status.state == "downloading" ? status.progress ?? 0 : nil)
            } catch where drops < 2 && Self.dropped(error) {
                drops += 1
                log.notice("\(self.machine.destination, privacy: .public): SSH dropped asking about the browser, trying again")
            } catch {
                log.error("\(self.machine.destination, privacy: .public) couldn't get the browser: \(error.localizedDescription, privacy: .public)")
                setup = .failed(error.localizedDescription)
                return
            }
            try? await Task.sleep(for: .seconds(2))
            if Task.isCancelled { return }
        }
    }

    /// SSH stopped on its own (exit 255), not over the machine's host key or this Mac's keys,
    /// which trying again wouldn't change.
    static func dropped(_ error: Error) -> Bool {
        guard case RemoteEngineError.ssh(status: 255, let message) = error else { return false }
        return !message.contains("Host key verification failed") && !message.localizedCaseInsensitiveContains("permission denied")
    }

    /// The machine was removed, or you disconnected it: the live view ends with it.
    func reset() {
        handBackAll()
        disconnect()
        state = .idle
        pages = []
        shownPage = nil
        if case .failed = setup { setup = .unknown }
    }

    /// The machine is connected (again, maybe after the Mac slept): tabs in view come back live.
    func resume() {
        reconnects = 0
        guard isWanted else { return }
        connectWhenReady()
    }

    // MARK: What the panel wants

    /// The panel has this browser's tabs in its strip (or stops having them): the browser stays
    /// connected while it does, to keep them in step with its pages.
    func keep(_ keeping: Bool) {
        keepers = max(0, keepers + (keeping ? 1 : -1))
        wantsChanged()
    }

    /// A tab shows `page`: it's the page in use now, and it shows live.
    func show(_ page: String) {
        viewers += 1
        shownPage = page
        if activeID != page {
            activeID = page
            // Picked for the conversation in view: its agent goes on in this page.
            var params: [String: Any] = ["targetId": page, "by": "user"]
            if let session = sessionInView?() { params["session"] = session }
            link?.fire("Kuvo.setActive", params)
        }
        wantsChanged()
        if state == .live { Task { await attach(page) } }
    }

    /// A tab stopped showing `page` (another took its place, or the panel closed).
    func hide(_ page: String) {
        viewers = max(0, viewers - 1)
        if viewers == 0, shownPage == page {
            // A moment later, unless another tab shows it again: no more pictures.
            Task {
                try? await Task.sleep(for: .milliseconds(500))
                guard viewers == 0, shownPage == page else { return }
                stopShowing()
            }
        }
        wantsChanged()
    }

    private func wantsChanged() {
        dropTask?.cancel()
        if isWanted {
            connectWhenReady()
        } else {
            // A few seconds later, if nothing wants it again: the connection closes (the browser
            // keeps running on the machine).
            dropTask = Task {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, !isWanted else { return }
                // Pages you took over stay yours meanwhile, as the keeper keeps them a while.
                disconnect()
            }
        }
    }

    private func connectWhenReady() {
        if setup != .ready {
            Task { await prepare() }
        } else if link == nil {
            connect()
        }
    }

    /// Connects again after it stopped.
    func retry() {
        reconnects = 0
        if setup != .ready {
            setup = .unknown
            // You asked: the box tries at once, rather than waiting after a failure.
            Task { await prepare(now: true) }
        } else {
            disconnect()
            connect()
        }
    }

    private func connect() {
        guard link == nil else { return }
        // A stand-in is never contacted (see `install`).
        guard !machine.connection.isNeverContacted else { return }
        state = .connecting
        let link = MachineBrowserLink(connection: machine.connection, command: MachineBrowserInstaller.command("connect"))
        link.onEvent = { [weak self] method, params, session in self?.handle(method, params, session) }
        link.onFrame = { [weak self] frame in
            guard let self, frame.session == self.session else { return }
            // The page as it was: taking a sharp picture of it draws it again, which comes as a
            // picture too. Not one to show (over the sharp one) or sharpen again.
            if frame.digest == lastDigest, frame.scroll == picture?.scroll { return }
            lastDigest = frame.digest
            #if DEBUG
            meter.frame(frame.image, bytes: frame.bytes)
            meter.picture(scrollY: frame.scroll.y)
            #endif
            picture = Picture(image: frame.image, size: frame.size, scroll: frame.scroll)
            pictureCount += 1
            sharpen()
            // Back at the browser's own size: another viewer (another Mac) that set its size left.
            if frame.size == Self.windowSize, viewport.size != Self.windowSize { reapplyViewport() }
        }
        link.onClose = { [weak self, weak link] reason in
            guard let self, let link, self.link === link else { return }
            closed(reason)
        }
        self.link = link
        do {
            try link.start()
        } catch {
            self.link = nil
            state = .failed(error.localizedDescription)
        }
    }

    private func disconnect() {
        link?.stop()
        link = nil
        session = nil
        workingPages = []
        dialog = nil
        if case .live = state { state = .idle }
        if case .connecting = state { state = .idle }
    }

    private func closed(_ reason: String) {
        let wasLive = state == .live
        link = nil
        session = nil
        workingPages = []
        if case .failed = state { return }
        // It stopped (the machine restarted, the browser quit): back by itself if it can.
        if isWanted, reconnects < 3 {
            reconnects += 1
            state = .connecting
            Task {
                try? await Task.sleep(for: .seconds(wasLive ? 1 : 3))
                guard isWanted, link == nil else { return }
                connect()
            }
        } else {
            state = isWanted ? .failed(reason.isEmpty ? "The connection to the browser on \(machine.name) closed." : reason) : .idle
        }
    }

    private func handle(_ method: String, _ params: [String: Any], _ sessionID: String?) {
        switch method {
        case "Kuvo.hello":
            if case .installing = setup { setup = .ready }
            // This Mac can answer what agents ask in the browser.
            link?.fire("Kuvo.viewing")
            activeID = params["targetId"] as? String
            workingPages = (params["status"] as? [String: Any]).map(Self.workingPages) ?? []
            noteWorkers(params["status"] as? [String: Any] ?? [:])
            heldPages = Set(params["held"] as? [String] ?? [])
            // A new connection (after a sleep, a dropped one): the pages this Mac took over are
            // taken again, which the keeper kept a while for it, so their agents don't go on in
            // them; those handed back meanwhile go back now.
            // (The keeper knows this Mac's holds by its ID, so this connection can hand back one
            // the old connection still has there, but not another Mac's.)
            for page in handedBackOffline { link?.fire("Kuvo.hold", ["targetId": page, "on": false, "mac": MachineEngine.macID]) }
            heldPages.subtract(handedBackOffline)
            handedBackOffline = []
            // Its own still (by this Mac's ID), not one another Mac took over meanwhile.
            let holders = params["holdMacs"] as? [String: String] ?? [:]
            myHolds = myHolds.filter { heldPages.contains($0) && (holders[$0] ?? MachineEngine.macID) == MachineEngine.macID }
            for page in myHolds { link?.fire("Kuvo.hold", ["targetId": page, "on": true, "mac": MachineEngine.macID]) }
            for ask in params["asks"] as? [[String: Any]] ?? [] { asked(ask) }
            // Pages whose site asked for a passkey before this connection.
            for (page, site) in params["passkeys"] as? [String: String] ?? [:] where !closedPasskeyNotes.contains(page + "|" + site) { passkeyPages[page] = site }
            Task { await begin() }
        case "Kuvo.installing":
            // The box sets the browser up again (it went, or didn't start) as this connects.
            if ["checking", "downloading", "installing"].contains(params["state"] as? String ?? "") {
                setup = .installing((params["progress"] as? NSNumber)?.doubleValue)
            }
        case "Kuvo.asked":
            asked(params)
        case "Kuvo.pointer":
            guard params["targetId"] as? String == shownPage, let rect = params["rect"] as? [String: Any],
                  let x = (rect["x"] as? NSNumber)?.doubleValue, let y = (rect["y"] as? NSNumber)?.doubleValue,
                  let width = (rect["width"] as? NSNumber)?.doubleValue, let height = (rect["height"] as? NSNumber)?.doubleValue else { return }
            pictureView?.point(AgentPointer.Action(rawValue: params["action"] as? String ?? "") ?? .click, at: CGRect(x: x, y: y, width: width, height: height))
        case "Kuvo.downloaded":
            guard let name = params["name"] as? String, let path = params["path"] as? String else { return }
            downloads = (downloads + [Download(name: name, path: path)]).suffix(3)
            #if DEBUG
            // KUVO_DEMO_SAVE_DOWNLOADS: each download is saved to this Mac, as Save to Mac does.
            if ProcessInfo.processInfo.environment["KUVO_DEMO_SAVE_DOWNLOADS"] != nil, let id = downloads.last?.id {
                Task {
                    try? await Task.sleep(for: .seconds(3))
                    saveToMac(id)
                }
            }
            #endif
        case "Kuvo.passkeyAsked":
            guard let host = params["host"] as? String else { return }
            // (Asked anew: the page left the site and came back, so a note you closed shows again.)
            if let page = params["targetId"] as? String {
                closedPasskeyNotes.remove(page + "|" + host)
                passkeyPages[page] = host
            }
            onPasskeyAsked(host)
        case "Kuvo.passkeyCleared":
            if let page = params["targetId"] as? String { passkeyPages[page] = nil }
        case "Kuvo.askClosed":
            if let id = params["id"] as? String, openAsks.remove(id) != nil { onAskClosed(id) }
        case "Kuvo.error":
            let message = params["message"] as? String ?? "The browser couldn't start."
            link?.stop()
            link = nil
            if params["kind"] as? String == "missing" {
                // Asked of its box again (it says why it couldn't).
                state = .idle
                setup = .unknown
                Task { await prepare() }
            } else {
                state = .failed(message)
            }
        case "Kuvo.activeChanged":
            guard let id = params["targetId"] as? String else {
                activeID = nil
                return
            }
            let byAgent = params["by"] as? String == "agent"
            guard id != activeID || byAgent else { return }
            activeID = id
            onActive(id, byAgent, params["session"] as? String)
        case "Kuvo.status":
            workingPages = Self.workingPages(params)
            noteWorkers(params)
        case "Kuvo.held":
            heldPages = Set(params["pages"] as? [String] ?? [])
        case "Target.targetCreated", "Target.targetInfoChanged":
            if let info = params["targetInfo"] as? [String: Any] { note(info) }
        case "Target.targetDestroyed":
            let id = params["targetId"] as? String
            guard pages.contains(where: { $0.id == id }) else { return }
            pages.removeAll { $0.id == id }
            if shownPage == id { stopShowing() }
            onPages(pages)
        case "Target.detachedFromTarget":
            if params["sessionId"] as? String == session { session = nil }
        default:
            guard sessionID != nil, sessionID == session else { return }
            #if DEBUG
            if method.hasPrefix("Page.frame") || method.hasSuffix("EventFired") { meter.event(method) }
            #endif
            switch method {
            case "Page.frameStartedLoading":
                if params["frameId"] as? String == shownPage { isLoading = true }
            case "Page.frameStoppedLoading":
                if params["frameId"] as? String == shownPage { isLoading = false }
            case "Page.frameNavigated":
                if (params["frame"] as? [String: Any])?["parentId"] == nil { Task { await refreshHistory() } }
            case "Page.navigatedWithinDocument":
                Task { await refreshHistory() }
                Task { await refreshPages() }
            case "Page.domContentEventFired", "Page.loadEventFired":
                Task { await refreshPages() }
            case "Page.javascriptDialogOpening":
                dialog = Dialog(type: params["type"] as? String ?? "alert", message: params["message"] as? String ?? "", defaultPrompt: params["defaultPrompt"] as? String ?? "")
            case "Page.javascriptDialogClosed":
                dialog = nil
            default:
                break
            }
        }
    }

    private func asked(_ params: [String: Any]) {
        guard let id = params["id"] as? String, !openAsks.contains(id), let host = params["host"] as? String else { return }
        let kind: BrowserAsks.Kind
        switch params["kind"] as? String {
        case "signIn": kind = .signIn(username: params["username"] as? Bool ?? false, password: params["password"] as? Bool ?? false)
        case "code": kind = .code(prompt: params["prompt"] as? String ?? "")
        case "action": kind = .action(instruction: params["instruction"] as? String ?? "")
        default: return
        }
        openAsks.insert(id)
        var ask = BrowserAsks.Ask(id: id, kind: kind, host: host, machine: machine.id, session: params["session"] as? String, page: params["targetId"] as? String)
        ask.passkey = params["passkey"] as? Bool ?? false
        onAsk(ask)
    }

    /// Your answer to an ask, back to the machine's browser, which fills it in.
    func answer(_ id: String, _ answer: BrowserAsks.Answer) {
        openAsks.remove(id)
        let value: [String: Any] = switch answer {
        case .signIn(let username, let password): ["type": "signIn", "username": username ?? NSNull(), "password": password ?? NSNull()]
        case .code(let code): ["type": "code", "code": code]
        case .done: ["type": "done"]
        case .declined, .timedOut, .leftOnAutopilot: ["type": "declined"]
        }
        link?.fire("Kuvo.answer", ["id": id, "answer": value])
    }

    /// An agent on the machine is about to ask you something: the browser stays connected, to
    /// hear it, until it's answered (or a while goes by without one).
    func expectAsk() {
        guard !expecting else { return }
        expecting = true
        keep(true)
        Task {
            let start = ContinuousClock.now
            while ContinuousClock.now < start + .seconds(960) {
                try? await Task.sleep(for: .seconds(5))
                if openAsks.isEmpty, ContinuousClock.now > start + .seconds(30) { break }
            }
            expecting = false
            keep(false)
        }
    }

    private func note(_ info: [String: Any]) {
        guard info["type"] as? String == "page", let id = info["targetId"] as? String else { return }
        let page = Page(id: id, title: info["title"] as? String ?? "", url: info["url"] as? String ?? "", opener: info["openerId"] as? String)
        if let index = pages.firstIndex(where: { $0.id == id }) {
            if pages[index] != page { pages[index] = page }
        } else {
            pages.append(page)
            onPages(pages)
        }
    }

    /// Once connected: the pages, and the one a tab shows, live.
    private func begin() async {
        guard let link else { return }
        do {
            _ = try await link.send("Target.setDiscoverTargets", ["discover": true])
            let infos = try await link.send("Target.getTargets")["targetInfos"] as? [[String: Any]] ?? []
            pages = infos.compactMap { info in
                guard info["type"] as? String == "page", let id = info["targetId"] as? String else { return nil }
                return Page(id: id, title: info["title"] as? String ?? "", url: info["url"] as? String ?? "", opener: info["openerId"] as? String)
            }
            state = .live
            reconnects = 0
            onPages(pages)
            if let shownPage { await attach(shownPage) }
            keepTitles(link)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Pages' titles: Chromium says when a page's address changes, not when its title does.
    private func refreshPages() async {
        guard let link, let infos = try? await link.send("Target.getTargets")["targetInfos"] as? [[String: Any]], self.link === link else { return }
        let open = Set(infos.compactMap { $0["type"] as? String == "page" ? $0["targetId"] as? String : nil })
        let gone = pages.contains { !open.contains($0.id) }
        pages.removeAll { !open.contains($0.id) }
        for info in infos { note(info) }
        if gone { onPages(pages) }
    }

    /// Every few seconds while live, for pages that change their title as you use them.
    private func keepTitles(_ link: MachineBrowserLink) {
        Task { [weak self] in
            while true {
                try? await Task.sleep(for: .seconds(4))
                guard let self, self.link === link, state == .live else { return }
                await refreshPages()
            }
        }
    }

    /// Shows `target` live: its pictures, at the panel's size.
    private func attach(_ target: String) async {
        guard let link, shownPage == target else { return }
        generation += 1
        let current = generation
        if let old = session {
            session = nil
            link.fire("Target.detachFromTarget", ["sessionId": old])
        }
        picture = nil
        isLoading = false
        dialog = nil
        do {
            let attached = try await link.send("Target.attachToTarget", ["targetId": target, "flatten": true])
            guard let id = attached["sessionId"] as? String else { return }
            guard generation == current, self.link === link, shownPage == target else {
                link.fire("Target.detachFromTarget", ["sessionId": id])
                return
            }
            session = id
            lastSharp = nil
            // In front in its window: a tab behind another (a site's new tab) isn't drawn.
            link.fire("Target.activateTarget", ["targetId": target])
            _ = try await link.send("Page.enable", session: id)
            // What a right-click lands on, for the Mac's own menu where the page has none.
            link.fire("Page.addScriptToEvaluateOnNewDocument", ["source": Self.menuRecorder], session: id)
            link.fire("Runtime.evaluate", ["expression": Self.menuRecorder], session: id)
            // As the page in front: it gets focus, and shows its caret.
            link.fire("Emulation.setFocusEmulationEnabled", ["enabled": true], session: id)
            await applyViewport()
            await refreshHistory()
        } catch {
            // Closed as it was picked: its tab goes with it.
            log.error("Couldn't show a page: \(error.localizedDescription, privacy: .public)")
            await refreshPages()
        }
    }

    /// No tab shows a page: no more pictures, though the connection stays for the tabs.
    private func stopShowing() {
        generation += 1
        if let old = session { link?.fire("Target.detachFromTarget", ["sessionId": old]) }
        session = nil
        shownPage = nil
        picture = nil
        lastSharp = nil
        isLoading = false
        dialog = nil
    }

    /// The browser's window size on the machine (`--window-size`), which pages have when nobody
    /// watching has set their own.
    static let windowSize = CGSize(width: 1280, height: 800)

    @ObservationIgnored private var lastReapplied = Date.distantPast

    private func reapplyViewport() {
        guard Date.now.timeIntervalSince(lastReapplied) > 2 else { return }
        lastReapplied = .now
        Task { await applyViewport() }
    }

    /// The view's size: the page takes it, at the screen's scale, so it lays out for the room the
    /// panel has, as the panel's own browser does.
    func resize(to size: CGSize, scale: CGFloat) {
        let size = CGSize(width: max(200, size.width.rounded()), height: max(150, size.height.rounded()))
        guard size != viewport.size || scale != viewport.scale else { return }
        viewport = (size, scale)
        viewportTask?.cancel()
        viewportTask = Task {
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            await applyViewport()
        }
    }

    // MARK: Zoom

    /// How large pages show: below 1 they lay out wider than the panel (as on a desktop) and
    /// shrink to fit; above 1 they grow. Still at the screen's full sharpness either way.
    private(set) var zoom: CGFloat = 1
    static let zooms: [CGFloat] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5]

    func zoom(in bigger: Bool) {
        let next = bigger ? Self.zooms.first { $0 > zoom + 0.001 } : Self.zooms.last { $0 < zoom - 0.001 }
        guard let next else { return }
        zoom = next
        Task { await applyViewport() }
    }

    func resetZoom() {
        guard zoom != 1 else { return }
        zoom = 1
        Task { await applyViewport() }
    }

    private func applyViewport() async {
        guard let link, let session else { return }
        let (size, scale) = viewport
        _ = try? await link.send("Emulation.setDeviceMetricsOverride", ["width": Int((size.width / zoom).rounded()), "height": Int((size.height / zoom).rounded()), "deviceScaleFactor": scale * zoom, "mobile": false], session: session)
        // At the screen's own size (not its scale) while the page moves: making and encoding a
        // picture at twice that took a server's Chrome long enough to hold up scrolling and clicks
        // by a good part of a second. Once it stops, a sharp one comes (`sharpen`).
        _ = try? await link.send("Page.startScreencast", ["format": "jpeg", "quality": 75, "maxWidth": Int(size.width), "maxHeight": Int(size.height)], session: session)
    }

    /// Pictures that came, to tell whether one came while a sharp one was being made.
    @ObservationIgnored private var pictureCount = 0
    @ObservationIgnored private var lastDigest = 0
    @ObservationIgnored private var sharpening: Task<Void, Never>?
    /// Where the page was scrolled and when, at the last sharp picture, and whether you did
    /// anything to the page since.
    @ObservationIgnored private var lastSharp: (scroll: CGPoint, at: ContinuousClock.Instant)?
    @ObservationIgnored private var inputSinceSharp = true

    /// A moment after the page last changed, a picture of it at the screen's scale, for the
    /// pictures that come at half of it while it moves. A page that changes on its own (a
    /// blinking caret, an animation) gets one every couple of seconds, not one per change.
    private func sharpen() {
        sharpening?.cancel()
        guard viewport.scale > 1, let link, let session, let picture else { return }
        let count = pictureCount
        var wait = Duration.milliseconds(300)
        if !inputSinceSharp, let lastSharp, lastSharp.scroll == picture.scroll {
            wait = max(wait, .seconds(2) - (ContinuousClock.now - lastSharp.at))
        }
        sharpening = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled, let self, self.pictureCount == count, self.session == session else { return }
            guard let result = try? await link.send("Page.captureScreenshot", ["format": "jpeg", "quality": 85, "fromSurface": true], session: session),
                  let base64 = result["data"] as? String else { return }
            let image = await Task.detached(priority: .userInitiated) { () -> CGImage? in
                guard let data = Data(base64Encoded: base64), let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
                return CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
            }.value
            // Only if the page is as it was: a picture since is newer.
            guard let image, !Task.isCancelled, self.pictureCount == count, self.session == session else { return }
            self.picture = Picture(image: image, size: picture.size, scroll: picture.scroll)
            self.lastSharp = (picture.scroll, .now)
            self.inputSinceSharp = false
        }
    }

    private func refreshHistory() async {
        guard let link, let session else { return }
        guard let result = try? await link.send("Page.getNavigationHistory", session: session), session == self.session else { return }
        let entries = result["entries"] as? [[String: Any]] ?? []
        history = entries.compactMap { $0["id"] as? Int }
        historyIndex = result["currentIndex"] as? Int ?? 0
        canGoBack = historyIndex > 0
        canGoForward = historyIndex < history.count - 1
    }

    // MARK: What you do

    /// Goes to an address, or searches for anything else, in the page shown.
    func load(_ input: String) {
        guard let url = BrowserSession.url(from: input) else { return }
        #if DEBUG
        meter.event("navigate")
        #endif
        fire("Page.navigate", ["url": url.absoluteString])
    }

    func goBack() { step(-1) }
    func goForward() { step(1) }

    private func step(_ by: Int) {
        guard history.indices.contains(historyIndex + by) else { return }
        fire("Page.navigateToHistoryEntry", ["entryId": history[historyIndex + by]])
    }

    func reload() { fire("Page.reload") }
    func stopLoading() { fire("Page.stopLoading") }

    /// A new page, at `address` if given: its ID once the browser has opened it, or nil if it
    /// couldn't. Waits for the browser to be set up and connected first (the first time on a
    /// machine, that's its download).
    func newPage(_ address: String? = nil) async -> String? {
        connectWhenReady()
        let deadline = ContinuousClock.now + .seconds(900)
        while state != .live {
            if case .failed = setup { return nil }
            if case .failed = state { return nil }
            if ContinuousClock.now > deadline { return nil }
            // Set up only now (it was being installed, with nothing showing it yet, which is what
            // has it connect): this page is what it's wanted for.
            if setup == .ready, link == nil { connect() }
            try? await Task.sleep(for: .milliseconds(200))
        }
        guard let link else { return nil }
        // Blank first, then the address: a page opened at an address sends its first request
        // before the browser gives it its identity (Chrome, not headless), and sites that turn
        // headless browsers away (x.com) answer that one with an empty page.
        guard let id = try? await link.send("Target.createTarget", ["url": "about:blank", "newWindow": true])["targetId"] as? String else { return nil }
        let url = address.flatMap { BrowserSession.url(from: $0)?.absoluteString }
        if !pages.contains(where: { $0.id == id }) {
            pages.append(Page(id: id, title: "", url: url ?? "about:blank"))
            onPages(pages)
        }
        if let url { await navigate(id, to: url, link: link) }
        return id
    }

    /// The browser's cookies (domain, name, expiry), while it's connected; nil otherwise.
    func cookies() async -> [(domain: String, name: String, expires: Date?)]? {
        guard state == .live, let link, let all = try? await link.send("Storage.getCookies")["cookies"] as? [[String: Any]] else { return nil }
        return all.compactMap { cookie in
            guard let domain = cookie["domain"] as? String, let name = cookie["name"] as? String else { return nil }
            // -1 for a session cookie.
            let expires = (cookie["expires"] as? Double).flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0) : nil }
            return (domain, name, expires)
        }
    }

    /// Takes `page` to `url`, through a session of its own for the moment.
    private func navigate(_ page: String, to url: String, link: MachineBrowserLink) async {
        guard let attached = try? await link.send("Target.attachToTarget", ["targetId": page, "flatten": true]),
              let session = attached["sessionId"] as? String else { return }
        _ = try? await link.send("Page.navigate", ["url": url], session: session)
        link.fire("Target.detachFromTarget", ["sessionId": session])
    }

    /// Closes a page (its tab closed).
    func close(_ id: String) {
        pages.removeAll { $0.id == id }
        if shownPage == id { stopShowing() }
        link?.fire("Target.closeTarget", ["targetId": id])
    }

    func answer(_ dialog: Dialog, accept: Bool, text: String? = nil) {
        var params: [String: Any] = ["accept": accept]
        if let text { params["promptText"] = text }
        fire("Page.handleJavaScriptDialog", params)
        self.dialog = nil
    }

    #if DEBUG
    /// KUVO_DEMO_LOG_FRAMES: the live view's frames a second, their size, and how long after you
    /// scroll the page's next picture arrives, in the log.
    @ObservationIgnored private let meter = FrameMeter()

    final class FrameMeter {
        private let on = ProcessInfo.processInfo.environment["KUVO_DEMO_LOG_FRAMES"] != nil
        private let log = Logger(subsystem: "run.kuvo.code", category: "machine-browser")
        private var count = 0, since = Date.now, waitingSince: Date?, delays: [Double] = []
        private var size = ""

        private var lastInput: Date?

        func input() {
            guard on else { return }
            if waitingSince == nil { waitingSince = .now }
            lastInput = .now
        }

        /// Each picture for a while after input, and where the page was scrolled to.
        func picture(scrollY: CGFloat) {
            guard on, let lastInput, Date.now.timeIntervalSince(lastInput) < 3 else { return }
            log.notice("picture \(String(format: "%.0f", Date.now.timeIntervalSince(lastInput) * 1000), privacy: .public) ms after the last input, at \(Int(scrollY), privacy: .public)")
        }

        /// A navigation's steps, from when it was asked for, and the first picture after each.
        private var navigatedAt: Date?
        private var awaitingFrame: String?
        private var bytes = 0

        func event(_ name: String) {
            guard on else { return }
            if name == "navigate" { navigatedAt = .now }
            let since = navigatedAt.map { String(format: "%.0f", Date.now.timeIntervalSince($0) * 1000) } ?? "-"
            log.notice("event \(name, privacy: .public) at \(since, privacy: .public) ms")
            awaitingFrame = name
        }

        func frame(_ image: CGImage, bytes frameBytes: Int) {
            guard on else { return }
            bytes += frameBytes
            if let awaiting = awaitingFrame, let navigatedAt {
                log.notice("first picture after \(awaiting, privacy: .public) at \(String(format: "%.0f", Date.now.timeIntervalSince(navigatedAt) * 1000), privacy: .public) ms, \(frameBytes / 1024, privacy: .public) KB")
                awaitingFrame = nil
            }
            count += 1
            size = "\(image.width)x\(image.height)"
            if let start = waitingSince {
                delays.append(Date.now.timeIntervalSince(start) * 1000)
                waitingSince = nil
            }
            let elapsed = Date.now.timeIntervalSince(since)
            guard elapsed >= 1 else { return }
            let delay = delays.isEmpty ? "-" : String(format: "%.0f", delays.reduce(0, +) / Double(delays.count))
            log.notice("frames \(String(format: "%.1f", Double(self.count) / elapsed), privacy: .public)/s \(self.size, privacy: .public), \(Int(Double(self.bytes) / elapsed / 1024), privacy: .public) KB/s, scroll to frame \(delay, privacy: .public) ms")
            bytes = 0
            count = 0
            since = .now
            delays = []
        }
    }
    #endif

    // MARK: Downloads

    /// Copies a download from the machine into this Mac's Downloads folder, over SSH.
    func saveToMac(_ id: UUID) {
        guard let index = downloads.firstIndex(where: { $0.id == id }) else { return }
        let download = downloads[index]
        downloads[index].state = .saving
        let connection = machine.connection
        Task {
            let outcome: Download.State = await Task.detached {
                // Copied into the app's temporary folder first, and into Downloads once it's all
                // there: never a half-copied file under its name, nor one left if the app quits.
                let partial = FileManager.default.temporaryDirectory.appending(path: "kuvo-download-\(UUID().uuidString)")
                defer { try? FileManager.default.removeItem(at: partial) }
                guard FileManager.default.createFile(atPath: partial.path, contents: nil) else {
                    return .failed("Couldn't write to Downloads.")
                }
                // As long as the copy takes (SSH notices a machine gone away by itself).
                let script = "cat -- '" + download.path.replacingOccurrences(of: "'", with: "'\\''") + "'"
                let copied = try? await ChildProcess.run("/usr/bin/ssh", connection.arguments(running: script), output: .file(partial),
                                                         errors: .discard, cancellable: false)
                guard copied?.succeeded == true else { return .failed("The file isn't on the machine any more.") }
                // Marked as downloaded, as a browser marks what it saves: macOS checks it before it
                // opens (an app, a script) as it would any download.
                var values = URLResourceValues()
                values.quarantineProperties = [kLSQuarantineTypeKey as String: kLSQuarantineTypeWebDownload as String, kLSQuarantineAgentNameKey as String: "Kuvo Code"]
                var quarantined = partial
                try? quarantined.setResourceValues(values)
                let destination = BrowserSession.free(BrowserSession.safeName(download.name), in: BrowserSession.downloadsFolder)
                do { try FileManager.default.moveItem(at: partial, to: destination) } catch { return .failed("Couldn't write to Downloads.") }
                return .saved(destination)
            }.value
            if let index = downloads.firstIndex(where: { $0.id == id }) { downloads[index].state = outcome }
        }
    }

    func dismissDownloads() {
        downloads.removeAll { $0.state != .saving }
    }

    // MARK: Input

    /// CDP's modifier bits: Alt 1, Control 2, Meta 4, Shift 8.
    static func modifiers(_ flags: NSEvent.ModifierFlags) -> Int {
        (flags.contains(.option) ? 1 : 0) | (flags.contains(.control) ? 2 : 0) | (flags.contains(.command) ? 4 : 0) | (flags.contains(.shift) ? 8 : 0)
    }

    func mouse(_ type: String, at point: CGPoint, button: String = "none", buttons: Int = 0, clicks: Int = 0, modifiers: Int = 0) {
        fire("Input.dispatchMouseEvent", ["type": type, "x": point.x, "y": point.y, "button": button, "buttons": buttons, "clickCount": clicks, "modifiers": modifiers])
    }

    // MARK: Context menu

    /// Notes, as a right-click reaches the page, whether the page took it (its own menu) and what
    /// it landed on: a link, a picture, a selection, a field.
    static let menuRecorder = """
    if (!window.__kuvoMenuRecorder) {
      window.__kuvoMenuRecorder = true;
      window.addEventListener('contextmenu', (event) => {
        const target = event.target instanceof Element ? event.target : event.target && event.target.parentElement;
        const link = target && target.closest('a[href]');
        const image = target && target.closest('img');
        window.__kuvoMenu = {
          prevented: event.defaultPrevented,
          link: link ? link.href : null,
          image: image ? (image.currentSrc || image.src) : null,
          selection: String(getSelection() || '').slice(0, 20000),
          editable: !!(target && target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')),
          at: Date.now(),
        };
      });
    }
    """

    /// What the last right-click landed on, if the page left it to us.
    struct MenuTarget {
        var link: URL?
        var image: URL?
        var selection: String
        var editable: Bool
    }

    func menuTarget() async -> MenuTarget? {
        guard let link, let session else { return nil }
        let expression = "(() => { const m = window.__kuvoMenu; return m && Date.now() - m.at < 2000 && !m.prevented ? m : null })()"
        guard let result = try? await link.send("Runtime.evaluate", ["expression": expression, "returnByValue": true], session: session),
              let value = (result["result"] as? [String: Any])?["value"] as? [String: Any] else { return nil }
        return MenuTarget(
            link: (value["link"] as? String).flatMap(URL.init(string:)),
            image: (value["image"] as? String).flatMap(URL.init(string:)),
            selection: value["selection"] as? String ?? "",
            editable: value["editable"] as? Bool ?? false
        )
    }

    /// The CSS cursor over `point` in the page shown ("pointer" over a link, "text" over a field),
    /// for the Mac's own pointer.
    func cursor(at point: CGPoint) async -> String? {
        guard let link, let session else { return nil }
        let expression = """
        (() => {
          const element = document.elementFromPoint(\(Int(point.x)), \(Int(point.y)));
          if (!element) return 'default';
          const cursor = getComputedStyle(element).cursor;
          if (cursor && cursor !== 'auto') return cursor;
          const field = element.closest('textarea, [contenteditable=""], [contenteditable="true"], input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file])');
          return field ? 'text' : 'default';
        })()
        """
        let result = try? await link.send("Runtime.evaluate", ["expression": expression, "returnByValue": true], session: session)
        return (result?["result"] as? [String: Any])?["value"] as? String
    }

    func wheel(at point: CGPoint, dx: CGFloat, dy: CGFloat, modifiers: Int) {
        #if DEBUG
        meter.input()
        #endif
        fire("Input.dispatchMouseEvent", ["type": "mouseWheel", "x": point.x, "y": point.y, "deltaX": dx, "deltaY": dy, "modifiers": modifiers])
    }

    func key(_ type: String, key: String, code: String, keyCode: Int, text: String? = nil, modifiers: Int = 0, commands: [String] = []) {
        var params: [String: Any] = ["type": type, "key": key, "code": code, "windowsVirtualKeyCode": keyCode, "nativeVirtualKeyCode": keyCode, "modifiers": modifiers]
        if let text {
            params["text"] = text
            params["unmodifiedText"] = text
        }
        if !commands.isEmpty { params["commands"] = commands }
        fire("Input.dispatchKeyEvent", params)
    }

    func insertText(_ text: String) {
        fire("Input.insertText", ["text": text])
    }

    func compose(_ text: String, selection: NSRange) {
        fire("Input.imeSetComposition", ["text": text, "selectionStart": selection.location, "selectionEnd": selection.location + selection.length])
    }

    /// What's selected on the page, for Copy.
    func selectedText() async -> String? {
        guard let link, let session else { return nil }
        let expression = """
            (() => {
              const element = document.activeElement;
              if (element && typeof element.selectionStart === 'number' && typeof element.value === 'string') {
                return element.value.slice(element.selectionStart, element.selectionEnd);
              }
              return String(getSelection());
            })()
            """
        let result = try? await link.send("Runtime.evaluate", ["expression": expression, "returnByValue": true], session: session)
        return (result?["result"] as? [String: Any])?["value"] as? String
    }

    /// The page in view as a PNG file in Attachments, for Add Screenshot to Message.
    func screenshotFile() -> URL? {
        guard let frame = picture?.image else { return nil }
        let host = url(of: shownPage)?.host()?.replacingOccurrences(of: "www.", with: "") ?? "page"
        guard let png = NSBitmapImageRep(cgImage: frame).representation(using: .png, properties: [:]) else { return nil }
        return Attachments.write(png, named: "Screenshot of \(host)", extension: "png")
    }

    private func fire(_ method: String, _ params: [String: Any] = [:]) {
        guard let link, let session else { return }
        inputSinceSharp = true
        link.fire(method, params, session: session)
    }
}

// MARK: - The connection

/// One live connection to a machine's browser: `kuvo-browser.js connect` over SSH, speaking
/// Chrome's DevTools protocol, a message per line. Pictures of the page are read and decoded off
/// the main thread, and acknowledged right away, so the next one comes as soon as it's ready.
final class MachineBrowserLink {
    private let process = Process()
    private let reader: Reader
    private var next = 1
    private var waiting: [Int: CheckedContinuation<Message, Error>] = [:]
    private var stopped = false
    var onEvent: (String, [String: Any], String?) -> Void = { _, _, _ in }
    var onFrame: (Reader.Frame) -> Void = { _ in }
    var onClose: (String) -> Void = { _ in }

    /// A message as it crosses from the reading thread.
    nonisolated struct Message: @unchecked Sendable {
        var value: [String: Any]
    }

    init(connection: SSHConnection, command: String) {
        process.executableURL = URL(filePath: "/usr/bin/ssh")
        process.arguments = connection.arguments(running: command, shared: false)
        reader = Reader()
    }

    func start() throws {
        let input = Pipe.unshared()
        let output = Pipe.unshared()
        let errors = Pipe.unshared()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        reader.writer = input.fileHandleForWriting
        reader.deliver = { [weak self] message in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.receive(message) } }
        }
        reader.deliverFrame = { [weak self] frame in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.onFrame(frame) } }
        }
        output.fileHandleForReading.readabilityHandler = { [reader] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
            } else {
                reader.read(data)
            }
        }
        errors.fileHandleForReading.readabilityHandler = { [reader] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { reader.noteError(data) }
        }
        process.terminationHandler = { [weak self, reader] _ in
            let text = reader.errors.trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.ended(text) } }
        }
        try process.run()
    }

    /// Waits until what was sent has gone to SSH.
    func flush() { reader.flush() }

    func stop() {
        guard !stopped else { return }
        stopped = true
        process.terminationHandler = nil
        // What was written last (pages handed back, say) goes first: with its input closed after
        // it, SSH sends it and ends; stopped a moment later if it hasn't.
        let process = UncheckedProcess(process)
        reader.close {
            DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { if process.value.isRunning { process.value.terminate() } }
        }
        fail("The browser connection closed.")
    }

    /// Sends a request and waits for its answer (30 s at most).
    func send(_ method: String, _ params: [String: Any] = [:], session: String? = nil) async throws -> [String: Any] {
        guard !stopped else { throw MachineBrowserError.browser("The browser connection closed.") }
        let id = next
        next += 1
        let message = try await withCheckedThrowingContinuation { continuation in
            waiting[id] = continuation
            write(id: id, method, params, session: session)
            Task {
                try? await Task.sleep(for: .seconds(30))
                waiting.removeValue(forKey: id)?.resume(throwing: MachineBrowserError.browser("The browser didn't answer (\(method))."))
            }
        }
        return message.value
    }

    /// Sends a request without waiting for its answer, for input and actions.
    func fire(_ method: String, _ params: [String: Any] = [:], session: String? = nil) {
        guard !stopped else { return }
        let id = next
        next += 1
        write(id: id, method, params, session: session)
    }

    private func write(id: Int, _ method: String, _ params: [String: Any], session: String?) {
        var message: [String: Any] = ["id": id, "method": method, "params": params]
        if let session { message["sessionId"] = session }
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        reader.write(data + Data("\n".utf8))
    }

    private func receive(_ message: Message) {
        let value = message.value
        if let id = value["id"] as? Int {
            guard let continuation = waiting.removeValue(forKey: id) else { return }
            if let error = value["error"] as? [String: Any] {
                continuation.resume(throwing: MachineBrowserError.browser(error["message"] as? String ?? "The browser refused that."))
            } else {
                continuation.resume(returning: Message(value: value["result"] as? [String: Any] ?? [:]))
            }
        } else if let method = value["method"] as? String {
            onEvent(method, value["params"] as? [String: Any] ?? [:], value["sessionId"] as? String)
        }
    }

    private func ended(_ output: String) {
        guard !stopped else { return }
        stopped = true
        fail(output)
        onClose(output)
    }

    private func fail(_ reason: String) {
        let pending = waiting
        waiting = [:]
        for continuation in pending.values { continuation.resume(throwing: MachineBrowserError.browser(reason.isEmpty ? "The browser connection closed." : reason)) }
    }

    /// Reads lines off the connection, and writes to it, on threads of its own.
    nonisolated final class Reader: @unchecked Sendable {
        struct Frame: @unchecked Sendable {
            var image: CGImage
            var size: CGSize
            var scroll: CGPoint
            var session: String?
            /// How big it came, as JPEG.
            var bytes = 0
            /// Its JPEG's hash: the same picture again (one made as a sharp one was taken) has it.
            var digest = 0
        }

        var writer: FileHandle?
        var deliver: @Sendable (Message) -> Void = { _ in }
        var deliverFrame: @Sendable (Frame) -> Void = { _ in }
        private var buffer = Data()
        private let writing = DispatchQueue(label: "run.kuvo.code.machine-browser.write")
        private let lock = NSLock()
        private var errorOutput = Data()

        /// The last of what SSH wrote to stderr, for when it stops.
        var errors: String { lock.withLock { String(decoding: errorOutput, as: UTF8.self) } }

        func noteError(_ data: Data) {
            lock.withLock {
                errorOutput.append(data)
                if errorOutput.count > 8192 { errorOutput.removeFirst(errorOutput.count - 8192) }
            }
        }

        func write(_ data: Data) {
            writing.async { [writer] in try? writer?.write(contentsOf: data) }
        }

        /// Waits until what was written has gone to SSH.
        func flush() { writing.sync {} }

        /// Closes the input once what was written before has gone, then `done`.
        func close(then done: @escaping @Sendable () -> Void) {
            writing.async { [writer] in
                try? writer?.close()
                done()
            }
        }

        func read(_ data: Data) {
            buffer.append(data)
            while let end = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<end]
                buffer.removeSubrange(buffer.startIndex...end)
                guard !line.isEmpty, let value = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
                if value["method"] as? String == "Page.screencastFrame", let params = value["params"] as? [String: Any] {
                    frame(params, session: value["sessionId"] as? String)
                } else {
                    deliver(Message(value: value))
                }
            }
        }

        /// A picture of the page: acknowledged at once, so the next comes, and decoded here.
        private func frame(_ params: [String: Any], session: String?) {
            if let id = params["sessionId"] {
                var ack: [String: Any] = ["id": -1, "method": "Page.screencastFrameAck", "params": ["sessionId": id]]
                if let session { ack["sessionId"] = session }
                if let data = try? JSONSerialization.data(withJSONObject: ack) { write(data + Data("\n".utf8)) }
            }
            guard let base64 = params["data"] as? String, let data = Data(base64Encoded: base64),
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { return }
            let metadata = params["metadata"] as? [String: Any] ?? [:]
            let width = (metadata["deviceWidth"] as? NSNumber)?.doubleValue ?? Double(image.width)
            let height = (metadata["deviceHeight"] as? NSNumber)?.doubleValue ?? Double(image.height)
            let scroll = CGPoint(x: (metadata["scrollOffsetX"] as? NSNumber)?.doubleValue ?? 0, y: (metadata["scrollOffsetY"] as? NSNumber)?.doubleValue ?? 0)
            deliverFrame(Frame(image: image, size: CGSize(width: width, height: height), scroll: scroll, session: session, bytes: data.count, digest: Self.digest(data)))
        }

        /// A hash of all of it: `Data`'s own covers only its length and first 80 bytes, the same
        /// JPEG header in every picture, so a changed one the same size passed for the last.
        private static func digest(_ data: Data) -> Int {
            var hasher = Hasher()
            data.withUnsafeBytes { hasher.combine(bytes: $0) }
            return hasher.finalize()
        }
    }
}

/// A process to stop from another thread, once its link has let go of it.
private struct UncheckedProcess: @unchecked Sendable {
    let value: Process
    init(_ value: Process) { self.value = value }
}
