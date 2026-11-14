import AppKit
import ClientDesign
import ClientText
import SwiftUI
import WebKit

/// A browser tab: a web view and what the toolbar shows about it.
@Observable
final class BrowserSession: NSObject {
    let webView: WKWebView
    private(set) var title = ""
    private(set) var url: URL?
    private(set) var isLoading = false
    /// Why the last page didn't open, until another starts to: for the agent, which would see
    /// only an empty tab or the page before.
    fileprivate(set) var loadFailure: String?
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var progress = 0.0
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    /// Told about each page that finishes loading, for the new tab page's suggestions.
    @ObservationIgnored var onVisit: ((URL, String, URL?) -> Void)?
    /// Opens a window the page asked for, as a tab of its own, and hands back its web view.
    @ObservationIgnored var openWindow: ((WKWebViewConfiguration) -> WKWebView?)?
    /// The page closed its own window (a sign-in popup that's done).
    @ObservationIgnored var onClose: (() -> Void)?
    /// A sign-in you just sent, which the toolbar offers to save.
    var pendingLogin: PendingLogin?
    /// The pending login was offered again because saving it didn't work.
    var pendingLoginFailed = false
    /// The site of the page, when it asked for a passkey (which this browser can't use yet), until
    /// you leave the site: the agent's look at the page says so.
    var passkeySite: String? {
        didSet { if passkeySite != oldValue { passkeyNoteClosed = false } }
    }
    /// You closed the note about it.
    var passkeyNoteClosed = false
    /// The saved logins for the page's site, and whether it has a field to fill them into.
    private(set) var savedLogins: [Passwords.Login] = []
    private(set) var hasLoginField = false
    /// The agent's latest step on the page, for the pointer that shows it.
    private(set) var agentStep: AgentStep?
    /// An agent is at work in the page, or was a moment ago (it thinks between its steps), and
    /// its session.
    private(set) var isAgentBrowsing = false
    private(set) var agentSession: String?
    @ObservationIgnored private var resting: Task<Void, Never>?
    /// You took the page over from the agent: its browser steps wait until you hand it back.
    var isHeld = false {
        didSet { if isHeld, !oldValue { Analytics.shared.track("browser_taken_over", ["machine": false]) } }
    }

    /// Agent steps at work in this page now, and of them those told to accept confirmations: while
    /// any is, a dialog the page shows is answered at once (it would hold the page, and the step).
    @ObservationIgnored private var agentSteps = 0
    /// When the agent's latest step here began or ended.
    @ObservationIgnored private var agentSteppedAt: Date?
    @ObservationIgnored private var acceptingSteps = 0
    /// Of those steps, the ones waiting for you to answer the agent in Kuvo Code (a sign-in, a
    /// code, something only you can do on the page): meanwhile the page's dialogs are yours.
    @ObservationIgnored private var waitingSteps = 0

    /// An agent's step begins in this page.
    func agentStepBegan(_ session: String?, accepting: Bool) {
        agentSteps += 1
        agentSteppedAt = .now
        if accepting { acceptingSteps += 1 }
        agentWorks(session)
        answerWaitingDialog()
    }

    /// The agent's step waits for you to answer it in Kuvo Code, or goes on once you have.
    /// An agent's step waits on you here (a sign-in, a code, a step to do on the page).
    var waitsForYou: Bool { waitingSteps > 0 }

    func agentWaitsForYou(_ waiting: Bool) {
        waitingSteps = max(0, waitingSteps + (waiting ? 1 : -1))
        if !waiting { answerWaitingDialog() }
    }

    /// A dialog the page shows now is answered for the agent: a step of its is at work, not
    /// waiting for you, and you haven't taken the page over.
    private var answersForAgent: Bool { agentSteps > waitingSteps && !isHeld }

    /// The step ended.
    func agentStepEnded(accepting: Bool) {
        agentSteps = max(0, agentSteps - 1)
        agentSteppedAt = .now
        if accepting { acceptingSteps = max(0, acceptingSteps - 1) }
        if agentSteps == 0 { agentRests() }
    }

    /// An agent is at work in the page (or waiting for it): its badge shows.
    func agentWorks(_ session: String?) {
        resting?.cancel()
        if agentSession != session { agentSession = session }
        if !isAgentBrowsing { isAgentBrowsing = true }
        #if DEBUG
        // KUVO_DEMO_TAKE_OVER=<seconds>: you take the page over once an agent starts, and hand it
        // back that long after.
        if let seconds = ProcessInfo.processInfo.environment["KUVO_DEMO_TAKE_OVER"].flatMap(Double.init), !Self.tookOver {
            Self.tookOver = true
            Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(300))
                self?.isHeld = true
                try? await Task.sleep(for: .seconds(seconds))
                self?.isHeld = false
            }
        }
        #endif
    }
    #if DEBUG
    private static var tookOver = false
    #endif

    /// Its step ended: the badge stays a few seconds, for its next one.
    func agentRests() {
        resting?.cancel()
        resting = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            self?.isAgentBrowsing = false
        }
    }

    struct AgentStep: Identifiable, Equatable {
        let id = UUID()
        var action: AgentPointer.Action
        /// The element, in the web view's points.
        var rect: CGRect
    }

    /// The agent is about to act on the element at `rect` (CSS pixels in the window).
    func showAgentStep(_ action: AgentPointer.Action, at rect: CGRect) {
        let scale = webView.magnification
        agentStep = AgentStep(action: action, rect: CGRect(x: rect.minX * scale, y: rect.minY * scale, width: rect.width * scale, height: rect.height * scale))
    }

    /// What the page asks you (an alert, a confirmation, a question), until you answer.
    private(set) var dialog: PageDialog?
    @ObservationIgnored private var dialogAnswer: ((Bool, String?) -> Void)?

    struct PageDialog: Identifiable, Equatable {
        let id = UUID()
        enum Kind { case alert, confirm, prompt }
        var kind: Kind
        var message: String
        var defaultText = ""
    }

    /// Files the page downloaded, the latest last, while the bar shows them.
    private(set) var downloads: [Download] = []
    /// What happened since the agent last looked (a download started or finished), for its next
    /// tool result.
    @ObservationIgnored var agentNotes: [String] = []

    /// A file the page downloaded into your Downloads folder.
    struct Download: Identifiable {
        let id = UUID()
        var name: String
        var file: URL?
        var state: State = .running
        var progress = 0.0
        /// Bytes so far, and of how many when the server says.
        var received: Int64 = 0
        var expected: Int64?

        enum State: Equatable { case running, done, failed(String) }
    }

    /// Downloads under way, each with the conversation whose agent was at work in the page as it
    /// began (none when it's yours: no agent then, or you'd taken the page over).
    @ObservationIgnored private var running: [ObjectIdentifier: (download: WKDownload, id: UUID, progress: NSKeyValueObservation?, session: String?)] = [:]
    /// A download an agent's page finished, with that conversation, for the record of what agents made.
    @ObservationIgnored var onAgentDownload: ((URL, String) -> Void)?
    /// Where each download is written until it's done, in the app's temporary folder.
    @ObservationIgnored private var writing: [UUID: URL] = [:]
    /// When each download's bytes last went on screen.
    @ObservationIgnored private var counted: [UUID: ContinuousClock.Instant] = [:]

    /// A new tab, or, with the configuration WebKit passes for a window a page opens, that window:
    /// it stays connected to the page that opened it, which sign-in popups need to report back.
    init(configuration: WKWebViewConfiguration? = nil) {
        let configuration = configuration ?? Self.makeConfiguration()
        PasswordCapture.install(in: configuration)
        Passkeys.install(in: configuration)
        // A size of its own, so a page lays out (and the agent can use it) before the panel shows it,
        // as a bot's tab does out of sight; the panel sizes it when it shows it.
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1024, height: 768), configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        super.init()
        PasswordCapture.shared.register(self)
        PasskeyAsks.shared.register(self)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        observations = [
            webView.observe(\.title) { [weak self] view, _ in MainActor.assumeIsolated { self?.title = view.title ?? "" } },
            webView.observe(\.url) { [weak self] view, _ in
                MainActor.assumeIsolated {
                    self?.url = view.url
                    if let site = self?.passkeySite, BrowserAgent.site(of: view.url) != site { self?.passkeySite = nil }
                }
            },
            webView.observe(\.isLoading) { [weak self] view, _ in
                MainActor.assumeIsolated {
                    // A new page starts from nothing, not from where the last one finished.
                    if view.isLoading, self?.isLoading == false { self?.progress = view.estimatedProgress < 1 ? view.estimatedProgress : 0 }
                    self?.isLoading = view.isLoading
                }
            },
            webView.observe(\.canGoBack) { [weak self] view, _ in MainActor.assumeIsolated { self?.canGoBack = view.canGoBack } },
            webView.observe(\.canGoForward) { [weak self] view, _ in MainActor.assumeIsolated { self?.canGoForward = view.canGoForward } },
            webView.observe(\.estimatedProgress) { [weak self] view, _ in MainActor.assumeIsolated { self?.progress = view.estimatedProgress } },
        ]
    }

    private static func makeConfiguration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // Present as Safari, so sites don't serve a reduced page to an unknown browser.
        configuration.applicationNameForUserAgent = "Version/26.0 Safari/605.1.15"
        return configuration
    }

    /// The tab's name: the page title, else its host.
    var displayTitle: String {
        if !title.isEmpty { return title }
        return url?.host() ?? "New Tab"
    }

    /// Goes to an address, or searches for anything that doesn't look like one.
    func load(_ input: String) {
        guard let url = Self.url(from: input) else { return }
        // A question the page left open is turned down as you go elsewhere.
        if dialog != nil { answerDialog(accept: false) }
        // A file on this Mac, with what's in its folder (its pictures, its styles); a folder, with
        // what's in it, not its parent's.
        if url.isFileURL {
            var isFolder: ObjCBool = false
            let folder = FileManager.default.fileExists(atPath: url.path, isDirectory: &isFolder) && isFolder.boolValue
            webView.loadFileURL(url, allowingReadAccessTo: folder ? URL(filePath: url.path, directoryHint: .isDirectory) : url.deletingLastPathComponent())
        } else {
            webView.load(URLRequest(url: url))
        }
    }

    func close() {
        if dialog != nil { answerDialog(accept: false) }
        // An agent waiting for it goes on.
        isHeld = false
        webView.stopLoading()
        observations = []
    }

    // MARK: Passwords

    func offerToSave(_ login: PendingLogin) {
        pendingLogin = login
        pendingLoginFailed = false
        pagesSinceLogin = 0
    }

    /// Pages finished on other sites since the sign-in was offered.
    @ObservationIgnored private var pagesSinceLogin = 0

    func savePendingLogin() {
        guard let login = pendingLogin else { return }
        pendingLogin = nil
        pendingLoginFailed = false
        Task {
            if await Passwords.save(host: login.host, account: login.account, password: login.password) != nil {
                Analytics.shared.track("password_saved")
            } else if pendingLogin == nil {
                // This Mac's vault didn't answer: offered again, saying so, to try once more.
                pendingLogin = login
                pendingLoginFailed = true
            }
            refreshLogins()
        }
    }

    func dismissPendingLogin(never: Bool) {
        if never, let host = pendingLogin?.host { Passwords.setNever(host, true) }
        pendingLogin = nil
    }

    /// Fills the page's sign-in fields with a saved login: only when you ask, from the toolbar,
    /// and only one saved for the page's site (or a site it's under). (A test waits for it.)
    @discardableResult
    func fill(_ login: Passwords.Login) -> Task<Void, Never>? {
        guard let url = webView.url, url.scheme == "https", let host = url.host(),
              Passwords.logins(for: host).contains(where: { $0.item == login.item }) else { return nil }
        return Task {
            guard let password = await Passwords.password(for: login) else { return }
            _ = try? await webView.callAsyncJavaScript(Passwords.fillScript, arguments: ["username": login.account, "secret": password, "host": host], contentWorld: Passwords.world)
        }
    }

    /// What the toolbar's key offers for the page in view.
    func refreshLogins() {
        // Filled in over https only, so offered there only.
        guard let url = webView.url, url.scheme == "https", let host = url.host() else {
            savedLogins = []
            hasLoginField = false
            return
        }
        savedLogins = Passwords.logins(for: host)
        guard !savedLogins.isEmpty else {
            hasLoginField = false
            return
        }
        Task {
            hasLoginField = (try? await webView.callAsyncJavaScript(Passwords.hasLoginFieldScript, contentWorld: Passwords.world) as? Bool) ?? false
        }
    }

    /// Whether a page is on the site a sign-in was on (or the sign-in's host itself, for a
    /// local one with no site).
    static func sameSite(_ host: String, _ url: URL) -> Bool {
        guard let page = url.host()?.lowercased() else { return false }
        if page == host.lowercased() { return true }
        guard let site = SiteAddresses.site(of: url), let theirs = URL(string: "https://" + host).flatMap(SiteAddresses.site) else { return false }
        return site == theirs
    }

    /// An address on this Mac or its network, which a dev server answers over plain http:
    /// localhost, a computer's own name (`devbox:3000`), `.localhost`, `.test` and `.local`
    /// names, and private addresses by number (Tailscale's too).
    static func isLocal(_ host: String) -> Bool {
        let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host == "::1" || !host.contains(".") && !host.contains(":") { return true }
        if host.hasSuffix(".localhost") || host.hasSuffix(".test") || host.hasSuffix(".local") { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return false }
        return parts[0] == 127 || parts[0] == 10 || parts[0] == 0 || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && (16...31).contains(parts[1]))
            || (parts[0] == 169 && parts[1] == 254) || (parts[0] == 100 && (64...127).contains(parts[1]))
    }

    static func url(from input: String) -> URL? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let url = URL(string: text), let scheme = url.scheme, ["http", "https", "file", "about"].contains(scheme.lowercased()) {
            return url
        }
        // A file's path on this Mac ("/Users/me/report.html", "~/site/index.html").
        if text.hasPrefix("/") || text.hasPrefix("~/") {
            return URL(filePath: (text as NSString).expandingTildeInPath)
        }
        // "localhost:3000", "example.com/path": an address without its scheme.
        let looksLikeHost = !text.contains(" ") && (text.contains(".") || text.hasPrefix("localhost") || text.contains(":"))
        if looksLikeHost, let typed = URL(string: "https://" + text), let host = typed.host() {
            return isLocal(host) ? URL(string: "http://" + text) : typed
        }
        return SearchEngine.current.url(for: text)
    }
}

extension BrowserSession: WKUIDelegate {
    // The completion handlers are WebKit's own type, main-actor ones: with plain closures these
    // methods aren't WebKit's at all, and it never calls them.

    /// The page's alerts, confirmations and questions show in a bar over it. While the agent is
    /// at work they're answered at once: an alert accepted, the others declined unless the agent
    /// said to accept them; the agent hears about it. One left in the bar between its steps is
    /// answered so when its next step begins. While it waits for you to answer it, they're yours.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        ask(PageDialog(kind: .alert, message: message)) { _, _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        ask(PageDialog(kind: .confirm, message: message)) { accepted, _ in completionHandler(accepted) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        ask(PageDialog(kind: .prompt, message: prompt, defaultText: defaultText ?? "")) { accepted, text in completionHandler(accepted ? text ?? "" : nil) }
    }

    private func ask(_ dialog: PageDialog, answer: @escaping (Bool, String?) -> Void) {
        // While you have the page, or the agent waits for you, it asks you, even with a step at work.
        if answersForAgent { return answerForAgent(dialog, answer) }
        // One at a time: an older one is turned down.
        dialogAnswer?(false, nil)
        dialogAnswer = answer
        withAnimation(.ui) { self.dialog = dialog }
    }

    /// Answers a dialog for the agent: an alert accepted, the others declined unless its step said
    /// to accept them. The agent hears about it.
    private func answerForAgent(_ dialog: PageDialog, _ answer: (Bool, String?) -> Void) {
        let accept = dialog.kind == .alert || acceptingSteps > 0
        answer(accept, dialog.defaultText)
        let what = dialog.kind == .alert ? "an alert" : dialog.kind == .confirm ? "a confirmation" : "a question"
        agentNotes.append("The page showed \(what): “\(dialog.message)” (\(accept ? "accepted" : "declined"))." + (accept ? "" : " If it should go ahead, do it again with accept_dialog: true."))
    }

    /// A dialog left in the bar (shown between the agent's steps, or while it waited for you) would
    /// hold its next step: answered for it, as one shown during a step is.
    private func answerWaitingDialog() {
        guard let dialog, let answer = dialogAnswer, answersForAgent else { return }
        dialogAnswer = nil
        withAnimation(.ui) { self.dialog = nil }
        answerForAgent(dialog, answer)
    }

    func answerDialog(accept: Bool, text: String? = nil) {
        let answer = dialogAnswer
        dialogAnswer = nil
        withAnimation(.ui) { dialog = nil }
        answer?(accept, text)
    }

    /// The page's file picker: the Mac's open panel, over the window. A page in no window (a bot's
    /// out of view, say) gets none: you'd pick a file not knowing which page it goes to.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        guard let window = webView.window else { return completionHandler(nil) }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.prompt = "Choose"
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    /// A window the page opens, a link or a script's, becomes a real window in a tab of its own, as
    /// in any browser. It stays connected to the page that opened it, which sign-in windows like
    /// "Sign in with Google" need to report back before they close.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let window = openWindow?(configuration) { return window }
        webView.load(navigationAction.request)
        return nil
    }

    /// The page closed its own window, like a sign-in popup that's done.
    func webViewDidClose(_ webView: WKWebView) {
        onClose?()
    }
}

extension BrowserSession: WKNavigationDelegate {
    /// What a link asks to download, or a page the browser can't show (a PDF it's told to save,
    /// a zip), goes into your Downloads folder, as in any browser.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, preferences: WKWebpagePreferences) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
        (navigationAction.shouldPerformDownload ? .download : .allow, preferences)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        let attachment = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
        return navigationResponse.isForMainFrame && (attachment || !navigationResponse.canShowMIMEType) ? .download : .allow
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        start(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        start(download)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loadFailure = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        noteFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        noteFailure(error)
    }

    private func noteFailure(_ error: Error) {
        let error = error as NSError
        // Stopped for another page, or become a download (WebKit's "frame load interrupted"): not a failure.
        guard !(error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled), !(error.domain == "WebKitErrorDomain" && error.code == 102) else { return }
        loadFailure = error.localizedDescription
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The offer stays through where signing in leads: the same site's other pages
        // (accounts.google.com to myaccount.google.com) and the first page after it, wherever it
        // is (a sign-in service sending you back to the site). A login offered on another site
        // doesn't follow you around after that.
        if let pending = pendingLogin, let url = webView.url, !Self.sameSite(pending.host, url) {
            pagesSinceLogin += 1
            if pagesSinceLogin > 1 { pendingLogin = nil }
        }
        refreshLogins()
        guard let url = webView.url, let onVisit else { return }
        let title = webView.title ?? ""
        // The page's own icon, the largest it names; the site's /favicon.ico otherwise.
        let script = """
        (() => {
          // Only icons meant for the current appearance (sites name light and dark ones).
          const links = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')]
            .filter((l) => !l.media || matchMedia(l.media).matches);
          const size = (l) => parseInt((l.sizes && l.sizes.value || '0').split('x')[0]) || (l.rel.includes('apple') ? 180 : 16);
          links.sort((a, b) => size(b) - size(a));
          return links.length ? links[0].href : null;
        })()
        """
        webView.evaluateJavaScript(script) { result, _ in
            MainActor.assumeIsolated { onVisit(url, title, (result as? String).flatMap(URL.init(string:))) }
        }
    }
}

extension BrowserSession: WKDownloadDelegate {
    fileprivate func start(_ download: WKDownload) {
        download.delegate = self
        let entry = Download(name: download.originalRequest?.url?.lastPathComponent ?? "Download")
        // By the bytes, which come in whether or not the server said how many there are: on
        // screen ten times a second at most (they come a chunk at a time), and exactly once done.
        let progress = download.progress.observe(\.completedUnitCount) { [weak self] progress, _ in
            let (fraction, received, expected) = (progress.fractionCompleted, progress.completedUnitCount, progress.totalUnitCount)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    // Not once it's over: its end set the last count.
                    guard let self, self.running.values.contains(where: { $0.id == entry.id }) else { return }
                    let now = ContinuousClock.now
                    if let last = self.counted[entry.id], now - last < .milliseconds(100), fraction < 1 { return }
                    self.counted[entry.id] = now
                    self.count(entry.id, received: received, expected: expected)
                }
            }
        }
        // The agent's when one is at work in the page, or was in the last two minutes (a link's
        // server can be slow to start sending), as a machine's browser decides it; not once you'd
        // taken the page over.
        let agents = !isHeld && (agentSteps > 0 || agentSteppedAt.map { Date.now.timeIntervalSince($0) < 120 } == true)
        running[ObjectIdentifier(download)] = (download, entry.id, progress, agents ? agentSession : nil)
        withAnimation(.ui) { downloads = (downloads + [entry]).suffix(3) }
    }

    /// It downloads into the app's temporary folder first, then moves to your Downloads folder
    /// when done: WebKit holds the whole app still while macOS asks whether it may use Downloads,
    /// and a move off the main thread doesn't.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let name = Self.safeName(suggestedFilename)
        let folder = FileManager.default.temporaryDirectory.appending(path: "Downloads/\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: name)
        if let id = running[ObjectIdentifier(download)]?.id {
            update(id) { $0.name = name }
            writing[id] = file
        }
        agentNotes.append("The page started downloading \(name).")
        return file
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let entry = running.removeValue(forKey: ObjectIdentifier(download)), let source = writing.removeValue(forKey: entry.id) else { return }
        let id = entry.id
        // The last bytes, which the ten-a-second count may have skipped.
        counted[id] = nil
        count(id, received: download.progress.completedUnitCount, expected: download.progress.totalUnitCount)
        Task {
            let moved: Result<URL, Error> = await Task.detached {
                defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent()) }
                let file = BrowserSession.free(source.lastPathComponent, in: BrowserSession.downloadsFolder)
                do {
                    try FileManager.default.moveItem(at: source, to: file)
                    return .success(file)
                } catch {
                    return .failure(error)
                }
            }.value
            switch moved {
            case .success(let file):
                update(id) {
                    $0.state = .done
                    $0.progress = 1
                    $0.file = file
                    $0.name = file.lastPathComponent
                }
                agentNotes.append("Downloaded \(file.lastPathComponent) to \(file.path).")
                if let session = entry.session { onAgentDownload?(file, session) }
            case .failure(let error):
                update(id) { $0.state = .failed("Couldn't put it in Downloads: \(error.localizedDescription)") }
                agentNotes.append("A download couldn't be saved: \(error.localizedDescription)")
            }
        }
    }

    /// Your Downloads folder (KUVO_DEMO_DOWNLOADS, in a debug build, names another).
    nonisolated static var downloadsFolder: URL {
        #if DEBUG
        if let folder = ProcessInfo.processInfo.environment["KUVO_DEMO_DOWNLOADS"] { return URL(filePath: folder) }
        #endif
        return FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    }

    /// A file name a site gave, safe to use: no folders, no leading dots.
    nonisolated static func safeName(_ suggested: String) -> String {
        let name = (suggested as NSString).lastPathComponent.trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        return name.isEmpty ? "Download" : String(name.prefix(200))
    }

    /// `name` in `folder`, numbered if that's taken.
    nonisolated static func free(_ name: String, in folder: URL) -> URL {
        var file = folder.appending(path: name)
        let stem = file.deletingPathExtension().lastPathComponent, ext = file.pathExtension
        var number = 2
        while FileManager.default.fileExists(atPath: file.path) {
            file = folder.appending(path: ext.isEmpty ? "\(stem) \(number)" : "\(stem) \(number).\(ext)")
            number += 1
        }
        return file
    }

    func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
        guard let entry = running.removeValue(forKey: ObjectIdentifier(download)) else { return }
        counted[entry.id] = nil
        if let file = writing.removeValue(forKey: entry.id) { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        update(entry.id) { $0.state = .failed(error.localizedDescription) }
        agentNotes.append("A download failed: \(error.localizedDescription)")
    }

    private func count(_ id: UUID, received: Int64, expected: Int64) {
        update(id) {
            $0.received = received
            $0.expected = expected > 0 ? expected : nil
            $0.progress = expected > 0 ? min(1, Double(received) / Double(expected)) : 0
        }
    }

    private func update(_ id: UUID, _ change: (inout Download) -> Void) {
        guard let index = downloads.firstIndex(where: { $0.id == id }) else { return }
        change(&downloads[index])
    }

    func dismissDownloads() {
        withAnimation(.ui) { downloads.removeAll { $0.state != .running } }
    }
}

/// A browser tab in the panel: back, forward and reload, the address, a few actions, and the
/// page, or the new tab page while the tab hasn't gone anywhere.
struct BrowserPane<NewTab: View>: View {
    let session: BrowserSession
    /// Attaches files to the message being written, for Add Screenshot to Message.
    /// None where there's no message to add a screenshot to (signing in, in Settings).
    var attach: (([URL]) -> Void)?
    @ViewBuilder let newTab: () -> NewTab
    @State private var address = ""
    @FocusState private var editing: Bool
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                navigation
                addressField
                actions
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 8)
            if let login = session.pendingLogin {
                SaveLoginBar(login: login, session: session)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            if session.passkeySite != nil, !session.passkeyNoteClosed {
                PasskeyBar { withAnimation(.ui) { session.passkeyNoteClosed = true } }
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            if let dialog = session.dialog {
                PageDialogBar(dialog: dialog, session: session)
                    .id(dialog.id)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            if let download = session.downloads.last {
                DownloadBar(download: download, more: session.downloads.count - 1, session: session)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            Divider()
            if session.url == nil && !session.isLoading {
                newTab()
            } else {
                WebViewHost(webView: session.webView)
                    .overlay { AgentPointerOverlay(step: session.agentStep) }
                    .overlay(alignment: .bottom) {
                        if session.isAgentBrowsing || session.isHeld {
                            AgentBadge(session: session.agentSession, isHeld: session.isHeld) { session.isHeld = $0 }
                                .padding(.bottom, 12)
                                .transition(.opacity)
                        }
                    }
                    .animation(.ui, value: session.isAgentBrowsing || session.isHeld)
            }
        }
        .onAppear {
            address = displayAddress
            if session.url == nil, !AppInfo.staysInBackground { editing = true }
        }
        .onChange(of: session.url) { if !editing { address = displayAddress } }
        .onChange(of: editing) { _, isEditing in address = isEditing ? (session.url?.absoluteString ?? "") : displayAddress }
    }

    private var navigation: some View {
        BrowserNavigation(canGoBack: session.canGoBack, canGoForward: session.canGoForward, isLoading: session.isLoading, canReload: session.url != nil,
                          back: { session.webView.goBack() }, forward: { session.webView.goForward() },
                          reloadOrStop: { if session.isLoading { session.webView.stopLoading() } else { session.webView.reload() } })
    }

    private var addressField: some View {
        BrowserAddressField(address: $address, editing: $editing, isSecure: session.url?.scheme == "https", isLoading: session.isLoading, progress: session.progress) {
            session.load(address)
            editing = false
        }
    }

    private var actions: some View {
        BrowserToolbarGroup {
            if session.hasLoginField, !session.savedLogins.isEmpty {
                // Filling is yours to ask for: never on its own, never the agent's.
                Menu {
                    ForEach(session.savedLogins) { login in
                        Button(login.account.isEmpty ? "No username" : login.account) { session.fill(login) }
                    }
                    Divider()
                    Button("Vault…") { app.openSettings(.vault) }
                } label: {
                    Label("Fill Password", systemImage: "key.fill")
                } primaryAction: {
                    if let login = session.savedLogins.first { session.fill(login) }
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .fixedSize()
                .help(session.savedLogins.count == 1 ? "Fill in the saved password for \(session.savedLogins[0].account)" : "Fill in a saved password")
            }
            if attach != nil {
                Button(action: addScreenshot) {
                    Label("Add Screenshot to Message", systemImage: "camera.viewfinder")
                }
                .disabled(session.url == nil)
                .help("Add a screenshot of the page to your message, so the agent sees what you see")
            }
            Button {
                if let url = session.url { NSWorkspace.shared.open(url) }
            } label: { Label("Open in Your Browser", systemImage: "arrow.up.forward.app") }
                .disabled(session.url == nil)
                .help("Open in Your Browser")
            BrowserMoreMenu(url: session.url, canReload: session.url != nil, reload: { session.webView.reload() }) { step in
                let view = session.webView
                view.magnification = step == 0 ? 1 : min(max(view.magnification + 0.1 * CGFloat(step), 0.5), 3)
            }
        }
    }

    /// What's in view of the page, as a picture attached to the message being written.
    private func addScreenshot() {
        let host = session.url?.host()?.replacingOccurrences(of: "www.", with: "") ?? "page"
        session.webView.takeSnapshot(with: nil) { image, _ in
            MainActor.assumeIsolated {
                guard let image, let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]),
                      let url = Attachments.write(png, named: "Screenshot of \(host)", extension: "png") else { return }
                Analytics.shared.track("browser_screenshot_added")
                attach?([url])
            }
        }
    }

    private var displayAddress: String { BrowserAddressField.display(session.url, editing: editing) }
}

/// Under the toolbar after you sign in somewhere: save the password, or don't.
private struct SaveLoginBar: View {
    let login: PendingLogin
    let session: BrowserSession

    var body: some View {
        BrowserBar {
            HStack(spacing: 10) {
                Image(systemName: "key.fill")
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.pendingLoginFailed ? "Couldn’t save it. Try again?" : login.isUpdate ? "Update the saved password?" : "Save this password?")
                        .font(.system(size: 13, weight: .semibold))
                    Text(login.account.isEmpty ? login.host : "\(login.account) on \(login.host)")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Menu("Not Now") {
                    Button("Never for This Site") { withAnimation(.ui) { session.dismissPendingLogin(never: true) } }
                } primaryAction: {
                    withAnimation(.ui) { session.dismissPendingLogin(never: false) }
                }
                .fixedSize()
                Button(login.isUpdate ? "Update" : "Save") { withAnimation(.ui) { session.savePendingLogin() } }
                    .buttonStyle(.borderedProminent)
            }
        }
    }
}

/// The page asks something (an alert, a confirmation, a question): answer it here.
private struct PageDialogBar: View {
    let dialog: BrowserSession.PageDialog
    let session: BrowserSession

    var body: some View {
        BrowserDialogBar(message: dialog.message, asks: dialog.kind == .prompt, isAlert: dialog.kind == .alert, defaultText: dialog.defaultText) { accept, text in
            session.answerDialog(accept: accept, text: text ?? "")
        }
    }
}

/// The latest download: how far along it is, then where it went.
private struct DownloadBar: View {
    let download: BrowserSession.Download
    let more: Int
    let session: BrowserSession

    var body: some View {
        BrowserDownloadBar(name: download.name, symbol: symbol, isRunning: download.state == .running, canHide: download.state != .running, hide: session.dismissDownloads) {
            switch download.state {
            case .running:
                // Beside the bar, so the row stays as tall as when it's done.
                ProgressLine("Downloading", bytes: download.received, of: download.expected, layout: .inline)
            case .done:
                Text(more > 0 ? "Downloaded, with \(more) more" : "Downloaded to Downloads")
            case .failed(let reason):
                Text(reason)
            }
        } actions: {
            if download.state == .done, let file = download.file {
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([file]) }
            }
        }
    }

    private var symbol: String {
        switch download.state {
        case .running: "arrow.down.circle"
        case .done: "checkmark.circle.fill"
        case .failed: "exclamationmark.circle"
        }
    }
}

/// The buttons inside the toolbar's capsules.
struct ToolbarGroupStyle: ButtonStyle {
    @State private var isHovering = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(isEnabled ? (isHovering ? .primary : .secondary) : .quaternary)
            .frame(width: 30, height: 28)
            .background(isHovering && isEnabled ? Color.primary.opacity(0.08) : .clear, in: .capsule)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .contentShape(.capsule)
            .onHover { isHovering = $0 }
    }
}

private struct WebViewHost: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> WKWebView {
        context.coordinator.update(webView, in: context)
        return webView
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.update(view, in: context)
    }

    func makeCoordinator() -> PanelVisibility { PanelVisibility() }
}
