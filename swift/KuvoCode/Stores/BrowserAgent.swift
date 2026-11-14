import AppKit
import UniformTypeIdentifiers
import WebKit

/// Lets the agent use the panel's browser, the way browser-use does: it reads a page as
/// numbered interactive elements (browser-use's buildDomTree.js, MIT, in
/// box/src/browser, bundled from there), then clicks, types and scrolls by number. Every step happens in the
/// browser you see, and the numbers are drawn on the page while it works.
@MainActor
final class BrowserAgent {
    private let utilities: Utilities
    private let asks: BrowserAsks
    /// The bot on this Mac this agent is, which browses in tabs of its own; nil for an agent in
    /// your sessions, which uses yours (each conversation's its own, see `Utilities.agentBrowser`).
    let owner: String?
    /// The session whose tool call this agent serves, when the engine says.
    let caller: String?

    init(utilities: Utilities, asks: BrowserAsks, owner: String? = nil, caller: String? = nil) {
        self.utilities = utilities
        self.asks = asks
        self.owner = owner
        self.caller = caller
    }

    /// Which bot on this Mac a session is, if it is one.
    static var botOwner: (String) -> String? = { _ in nil }

    /// The agent for one tool call: a bot's browses in its own tabs.
    /// The panel this agent's tabs are in: its bot's, or its conversation's (the one in view's
    /// when nobody called).
    private var panel: String { owner ?? caller.map(utilities.panelOf) ?? utilities.panelKey }

    func serving(_ caller: String?) -> BrowserAgent {
        BrowserAgent(utilities: utilities, asks: asks, owner: caller.flatMap(Self.botOwner), caller: caller)
    }

    static let stillHeld = "The user took over the browser and still has it. Carry on without it for now, or try again later; if you work on your own (a bot), schedule a wake-up to come back to it."
    static let handedBack = "The user took over the browser while you worked, and has handed it back. The page may have changed: this is where it is now. Go on from here.\n\n"

    /// While you have the page this agent would use, it waits, up to ten minutes; once you hand
    /// it back, it says so, with the page as it is now, rather than doing its step. Nil when the
    /// page is the agent's to use.
    func waitForControl() async -> String? {
        let page = owner.map { owner in use ?? utilities.botBrowser(owner) }
            ?? caller.map { utilities.agentBrowser(for: $0) } ?? utilities.activeBrowser
        guard let page, page.isHeld else { return nil }
        // Its badge shows while it waits; a closed page, or a stopped run, ends the wait.
        page.agentWorks(caller)
        let started = ContinuousClock.now
        while page.isHeld, !Task.isCancelled, ContinuousClock.now - started < .seconds(600) {
            try? await Task.sleep(for: .milliseconds(300))
        }
        page.agentRests()
        guard !page.isHeld else { return Self.stillHeld }
        // Handed back on a file the conversation may not read: it stays as it is, unread, and the
        // agent goes on in a new tab.
        if let moved = await moveOffForbiddenFile() { return "The user took over the browser while you worked, and has handed it back. " + moved + "Go on from here." }
        return Self.handedBack + (await snapshot())
    }

    /// The tool call ended: its page's badge stays a moment, for the next.
    func finished() {
        touched?.agentStepEnded(accepting: acceptsDialogs)
        touched = nil
    }

    /// The page this call works in: its dialogs are answered for it, and a bot's is the one it
    /// goes on in.
    private weak var touched: BrowserSession?

    private func works(in browser: BrowserSession) {
        guard touched !== browser else { return }
        touched?.agentStepEnded(accepting: acceptsDialogs)
        touched = browser
        browser.agentStepBegan(caller, accepting: acceptsDialogs)
        utilities.agentUsed(browser)
        if let owner { utilities.botWorks(owner, in: browser) }
    }

    // MARK: Actions

    /// Whether what `navigate` said is that the page didn't open.
    static func notOpened(_ said: String) -> Bool {
        said.hasPrefix("Couldn't open ") || said.hasPrefix("Not an address or search: ")
    }

    func navigate(_ address: String) async -> String {
        let browser = browser()
        guard BrowserSession.url(from: address) != nil else { return "Not an address or search: \(address)" }
        browser.load(address)
        await settle(browser, expectNavigation: true)
        // Didn't open (nothing answers there, say): why, rather than an empty tab or the page before.
        if let failure = browser.loadFailure {
            let before = browser.url == nil ? "" : "\n\nThe tab is still on the page before:\n\n" + (await snapshot())
            return "Couldn't open \(address): \(failure)" + before
        }
        return await snapshot()
    }

    func newTab(_ address: String?) async -> String {
        let shows = owner == nil ? caller.map(utilities.bringsForward) ?? true : true
        let browser = utilities.newBrowser(address, byAgent: true, owner: panel, shown: shows)
        // A bot's new tab is the one it goes on in, and a conversation's.
        if owner != nil { use = browser }
        if owner == nil, let caller { utilities.agentWorks(caller, in: browser) }
        Analytics.shared.trackOnce("agent_used_browser")
        Analytics.shared.trackOnce("browser_used", key: "agent.mac", ["by": "agent", "place": "mac"])
        // Brought forward, unless it's a bot's out of view, or another conversation's than the one in view.
        if shows { utilities.reveal(browser) }
        if let address {
            await settle(browser, expectNavigation: true)
            if let failure = browser.loadFailure { return "Couldn't open \(address): \(failure)" }
        }
        return await snapshot()
    }

    /// Attaches files on this Mac to the page's file input [index] (or the one its button is for).
    func upload(_ index: Int, files paths: [String]) async -> String {
        let browser = browser()
        var files: [[String: String]] = []
        var total = 0
        for path in paths {
            let url = URL(filePath: (path as NSString).expandingTildeInPath)
            // Its size first, and only a plain file: a huge one, or a device or pipe, would hold
            // the app while it was read.
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values?.isRegularFile == true, let size = values?.fileSize else { return "Can't read \(path) on this Mac. Give the full path of a file." }
            total += size
            guard total <= 25_000_000 else { return "That's too much to attach at once (25 MB at most)." }
            guard let data = await Task.detached(operation: { try? Data(contentsOf: url) }).value else { return "Can't read \(path) on this Mac. Give its full path." }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            files.append(["name": url.lastPathComponent, "type": type, "data": data.base64EncodedString()])
        }
        let outcome = await run(Self.uploadScript, ["index": index, "files": files], in: browser)
        switch outcome {
        case "ok":
            try? await Task.sleep(for: .milliseconds(400))
            return "Attached \(paths.count == 1 ? "the file" : "\(paths.count) files").\n\n" + (await snapshot())
        case "missing": return "There's no element [\(index)] on the page now. Take a fresh browser_snapshot."
        case "none": return "[\(index)] isn't a file input, and the page doesn't have just one. Give the number of the upload button or its file input."
        default: return outcome
        }
    }

    /// What happened in this agent's tabs (a bot's own, or the ones its conversation works in)
    /// since its last tool, for its next result: downloads, dialogs.
    func takeNotes() -> String {
        let tabs = owner == nil ? caller.map(utilities.agentTabs) : nil
        let notes = (tabs ?? utilities.browserTabs(of: panel).map(\.browser)).flatMap { browser in
            defer { browser.agentNotes = [] }
            return browser.agentNotes
        }
        return notes.isEmpty ? "" : notes.joined(separator: "\n") + "\n\n"
    }

    /// What's told of an ask left undone on Autopilot (LEFT_UNDONE_WORDS on the box).
    static let leftOnAutopilot = "This is on Autopilot: nothing was put to the user, and nothing was chosen for you. If only the user can do it, don't do it or ask again: leave that step undone, keep it as waiting if you're at a goal (goal_progress), carry on with everything else, and list what's left for them in your final reply."
    static let unanswered = "The user didn't answer in time. Carry on with what you can without it, and say in your reply what you need; if you work on your own (a bot), schedule a wake-up to try again later."

    /// This call said to accept confirmations and prompts its page shows, rather than decline them.
    var acceptsDialogs = false

    /// The panel's browser tabs (a bot's own, for a bot), numbered from 1; or switches to one, or
    /// closes one.
    func tabs(_ action: String, tab number: Int?) async -> String {
        let open = utilities.browserTabs(of: panel)
        if action != "list" {
            guard let number, open.indices.contains(number - 1) else { return "There's no tab [\(number ?? 0)]. " + list(open) }
            let chosen = open[number - 1]
            // Another conversation's agent is at work there: not this one's to take or close.
            if owner == nil, let caller, !utilities.isFree(chosen.id, for: caller) {
                return "Another conversation's agent is using tab [\(number)]. Pick another, or open one with browser_new_tab."
            }
            if chosen.browser.isHeld { return "The user took tab [\(number)] over and has it now. Pick another, or carry on without it." }
            if let url = chosen.browser.url, url.isFileURL, BrowserTools.fileNote(for: url.absoluteString, caller: caller) != nil {
                return "Tab [\(number)] shows a file outside this conversation's folder, which this session asks about before reading. Pick another, or open one with browser_new_tab."
            }
            if action == "close" {
                utilities.close(chosen.id)
                return "Closed tab [\(number)]. " + list(utilities.browserTabs(of: panel))
            }
            if owner != nil { use = chosen.browser }
            if owner == nil, let caller { utilities.agentWorks(caller, in: chosen.browser) }
            if owner != nil || caller.map(utilities.bringsForward) ?? true { utilities.reveal(chosen.browser) }
            return await snapshot()
        }
        return list(open)
    }

    private func list(_ tabs: [(id: UUID, browser: BrowserSession)]) -> String {
        guard !tabs.isEmpty else { return "No tabs are open." }
        let inUse = inUse
        return "Tabs:\n" + tabs.enumerated().map { index, tab in
            let title = tab.browser.title.isEmpty ? "(untitled)" : tab.browser.title
            let note = tab.browser === inUse ? " (in use)" : owner == nil && caller.map { !utilities.isFree(tab.id, for: $0) } == true ? " (another conversation's)" : ""
            // One on a file the conversation may not read shows as one, without its name.
            if let url = tab.browser.url, url.isFileURL, BrowserTools.fileNote(for: url.absoluteString, caller: caller) != nil {
                return "[\(index + 1)] A file outside this conversation's folder" + note
            }
            return "[\(index + 1)] \(title) — \(tab.browser.url?.absoluteString ?? "empty")" + note
        }.joined(separator: "\n")
    }

    /// What the agent's look at a page says when its site asked for a passkey (as a machine's).
    static let passkeyNote = "This site asked for a passkey, which this browser can't use. Don't choose its passkey option again: sign in another way (a password, a code or an email link), or ask the user."

    /// The page as text: title, address, scroll position, and its numbered elements.
    func snapshot() async -> String {
        let browser = browser()
        guard browser.url != nil else { return "The browser is empty. Use browser_navigate to open a page." }
        let script = Self.snapshotScript
        let id = UUID().uuidString
        // What the page set to run on a click, which only its own world sees, for the snapshot
        // to count those elements as clickable too.
        let handlers = (try? await browser.webView.callAsyncJavaScript(Self.handlersScript, contentWorld: .page)) as? [Any] ?? []
        let result = try? await browser.webView.callAsyncJavaScript(script, arguments: ["kuvoSnapshot": id, "kuvoHandlers": handlers], contentWorld: Self.world) as? [String: Any]
        guard let result else { return "Couldn't read the page at \(browser.url?.absoluteString ?? "")." }
        // Its numbers are the ones this conversation's actions use, in this page only.
        if let caller { Self.snapshots[caller] = id }
        let text = result["text"] as? String ?? ""
        let above = result["above"] as? Int ?? 0, below = result["below"] as? Int ?? 0
        let body = text.count > 18_000 ? String(text.prefix(18_000)) + "\n… (cut; scroll or use browser_text for more)" : text
        let passkey = browser.passkeySite != nil && browser.passkeySite == Self.site(of: browser.url) ? "\n" + Self.passkeyNote : ""
        return """
        Page: \(result["title"] as? String ?? "")
        URL: \(result["url"] as? String ?? "")
        Scroll: \(above) px above, \(below) px below\(below > 1200 ? " (browser_text reads all of it at once)" : "")\(passkey)
        Interactive elements are numbered like [3]; use the number with browser_click, browser_type and browser_select.

        \(body.isEmpty ? "(no visible content)" : body)
        """
    }

    func click(_ index: Int) async -> String {
        let browser = browser()
        let before = browser.url
        await point(.click, at: index, in: browser)
        let outcome = await run(Self.clickScript, ["index": index], in: browser)
        guard outcome == "ok" else { return outcome }
        await settleAfterClick(browser, from: before)
        return "Clicked [\(index)].\n\n" + (await snapshot())
    }

    func type(_ index: Int, text: String, submit: Bool, clear: Bool) async -> String {
        let browser = browser()
        await point(.type, at: index, in: browser)
        let outcome = await run(Self.typeScript, ["index": index, "text": text, "submit": submit, "clear": clear], in: browser)
        guard outcome == "ok" else { return outcome }
        await settle(browser, expectNavigation: submit)
        return "Typed into [\(index)]\(submit ? " and submitted" : "").\n\n" + (await snapshot())
    }

    func select(_ index: Int, option: String) async -> String {
        let browser = browser()
        await point(.select, at: index, in: browser)
        let outcome = await run(Self.selectScript, ["index": index, "option": option], in: browser)
        guard outcome == "ok" else { return outcome }
        await settle(browser, expectNavigation: false)
        return "Selected “\(option)” in [\(index)].\n\n" + (await snapshot())
    }

    func scroll(down: Bool, pages: Double) async -> String {
        let browser = browser()
        _ = await run("window.scrollBy({top: (down ? 1 : -1) * window.innerHeight * 0.85 * pages, behavior: 'instant'}); return 'ok';", ["down": down, "pages": pages], in: browser)
        try? await Task.sleep(for: .milliseconds(300))
        return await snapshot()
    }

    func press(_ key: String) async -> String {
        let browser = browser()
        let outcome = await run(Self.pressScript, ["key": key], in: browser)
        guard outcome == "ok" else { return outcome }
        await settle(browser, expectNavigation: key == "Enter")
        return "Pressed \(key).\n\n" + (await snapshot())
    }

    func back() async -> String {
        let browser = browser()
        guard browser.canGoBack else { return "There's no page to go back to." }
        browser.webView.goBack()
        await settle(browser, expectNavigation: true)
        return await snapshot()
    }

    func forward() async -> String {
        let browser = browser()
        guard browser.canGoForward else { return "There's no page to go forward to." }
        browser.webView.goForward()
        await settle(browser, expectNavigation: true)
        return await snapshot()
    }

    /// The page's readable text, for reading rather than acting.
    func text() async -> String {
        let browser = browser()
        let text = (try? await browser.webView.callAsyncJavaScript("return document.body ? document.body.innerText : ''", contentWorld: .page) as? String) ?? ""
        return text.count > 30_000 ? String(text.prefix(30_000)) + "\n… (cut)" : (text.isEmpty ? "(no text)" : text)
    }

    /// What's on screen, as a PNG (base64), at most 1280 points wide.
    func screenshot() async -> String? {
        let browser = browser()
        // What you filled in stays out of the picture.
        _ = await run(Self.maskScript, [:], in: browser)
        let image = try? await browser.webView.takeSnapshot(configuration: nil)
        _ = await run(Self.unmaskScript, [:], in: browser)
        guard let image else { return nil }
        let scale = min(1, 1280 / max(image.size.width, 1))
        let size = NSSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        image.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        return bitmap.representation(using: .png, properties: [:])?.base64EncodedString()
    }

    /// The page as a PDF at `path`, in pages on the paper this Mac prints on, with its colors.
    func savePDF(to path: String) async -> String {
        let browser = browser()
        guard browser.url != nil else { return "The browser is empty. Open the page first: for a document, write it as an HTML file and open it (file:///…)." }
        let expanded = (path as NSString).expandingTildeInPath
        guard expanded.hasPrefix("/"), expanded.lowercased().hasSuffix(".pdf") else { return "Give a full path ending in .pdf." }
        let url = URL(filePath: expanded)
        var isFolder: ObjCBool = false
        if FileManager.default.fileExists(atPath: expanded, isDirectory: &isFolder), isFolder.boolValue { return "There's a folder at \(expanded). Give the path of a file to save." }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        } catch {
            return "Can't make the folder for \(expanded): \(error.localizedDescription)"
        }
        // Printed in the app's temporary folder first: a file already there is only replaced once
        // the new one is saved.
        let folder = FileManager.default.temporaryDirectory.appending(path: "PDF/\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            return "Couldn't save the page as a PDF: \(error.localizedDescription)"
        }
        let printed = folder.appending(path: url.lastPathComponent)
        // Backgrounds and colors as on screen; printing leaves them out otherwise.
        _ = try? await browser.webView.callAsyncJavaScript(Self.keepColorsScript, contentWorld: .page)
        // What you filled in stays out of it, as out of a screenshot.
        _ = await run(Self.printMaskScript, [:], in: browser)
        let saved = await PagePrinter.save(browser.webView, to: printed)
        _ = await run(Self.printUnmaskScript, [:], in: browser)
        switch saved {
        case .saved(let pages):
            do {
                try Data(contentsOf: printed).write(to: url, options: .atomic)
            } catch {
                return "Couldn't save the PDF at \(expanded): \(error.localizedDescription)"
            }
            return "Saved the page as a \(pages)-page PDF at \(expanded)."
        case .notShown: return "The page is out of view in a way it can't be printed from. Show it in the panel, then save it again."
        case .failed: return "Couldn't save the page as a PDF."
        }
    }

    static let keepColorsScript = """
        if (!document.getElementById('kuvo-keep-colors')) {
          const style = document.createElement('style');
          style.id = 'kuvo-keep-colors';
          style.textContent = '* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }';
          (document.head || document.documentElement).appendChild(style);
        }
        """

    // MARK: Asking you

    /// Signs in with your username and password: from the vault when the conversation may use one
    /// of its sign-ins on this site (or the one it names), else which you type (or pick from your
    /// saved passwords) in Kuvo Code. They go straight into the fields named, and the agent never
    /// sees them. A password only goes into a password field.
    func signIn(username: Int?, password: Int?, item: String? = nil, for caller: String? = nil) async -> String {
        let browser = browser()
        guard let host = Self.site(of: browser.url) else { return "Open the sign-in page first." }
        guard username != nil || password != nil else { return "Name the username field, the password field, or both, by number." }
        // The address shows a page on its way before its document arrives: the card names the
        // site whose page it is, or none.
        guard await Self.documentSite(in: browser) == host else {
            return "The page is still on its way to \(host). Wait for it, take a browser_snapshot, and call browser_sign_in again."
        }
        if let problem = await checkFields(username: username, password: password, in: browser) { return problem }
        if let said = await signInFromVault(username: username, password: password, item: item, host: host, in: browser, for: caller) { return said }
        switch await ask(.signIn(username: username != nil, password: password != nil), host: host, in: browser, for: caller) {
        case .signIn(let user, let secret):
            let username = user?.isEmpty == false ? username : nil
            let password = secret?.isEmpty == false ? password : nil
            guard username != nil || password != nil else { return "The user didn't give a sign-in for that." }
            // The page may have moved on while you answered: the same site and fields still, or
            // nothing goes in.
            if let problem = stillOn(host, in: browser) { return problem }
            if let problem = await checkFields(username: username, password: password, in: browser) { return Self.changed + problem }
            var filled: [String] = []
            if let username, let user {
                let outcome = await run(Self.fillScript, ["index": username, "value": user, "wanted": "text", "site": host], in: browser)
                guard outcome == "ok" else { return outcome }
                filled.append("the username")
            }
            if let password, let secret {
                let outcome = await run(Self.fillScript, ["index": password, "value": secret, "wanted": "password", "site": host], in: browser)
                guard outcome == "ok" else { return outcome }
                filled.append("the password")
            }
            try? await Task.sleep(for: .milliseconds(300))
            return "Filled \(filled.joined(separator: " and ")) for \(host) (you can't see them). Submit the form to sign in.\n\n" + (await snapshot())
        case .timedOut:
            return Self.unanswered
        case .leftOnAutopilot:
            return Self.leftOnAutopilot
        default:
            return "The user didn't sign in. Ask them in the chat how to go on."
        }
    }

    /// A sign-in from the vault, filled on its own site (the box checks where the page really is):
    /// what to tell the agent, or nil to ask you as before (nothing in the vault is this
    /// conversation's here, or it's locked).
    private func signInFromVault(username: Int?, password: Int?, item: String?, host: String, in browser: BrowserSession, for caller: String?) async -> String? {
        guard let address = browser.url?.absoluteString else { return nil }
        var body: [String: Any] = ["origin": address, "purpose": "sign-in"]
        if let caller { body["session"] = caller }
        if let item, !item.isEmpty { body["item"] = item }
        guard let filled = await BrowserTools.vaultFill(body) else { return nil }
        let said = filled.value["message"] as? String
        guard filled.status == 200 else {
            // Refused (a site that isn't the item's, Pause, you said no), or the item it named isn't one: said. Else you're asked.
            return filled.status == 403 || (item != nil && filled.status != 423) ? said ?? "The vault didn't fill that." : nil
        }
        let name = (filled.value["item"] as? [String: Any])?["name"] as? String ?? "the vault"
        let user = filled.value["username"] as? String
        let secret = (filled.value["values"] as? [String: String])?["password"]
        if let problem = stillOn(host, in: browser) { return problem }
        var done: [String] = []
        if let username, let user {
            let outcome = await run(Self.fillScript, ["index": username, "value": user, "wanted": "text", "site": host], in: browser)
            guard outcome == "ok" else { return outcome }
            done.append("the username")
        }
        if let password, let secret {
            let outcome = await run(Self.fillScript, ["index": password, "value": secret, "wanted": "password", "site": host], in: browser)
            guard outcome == "ok" else { return outcome }
            done.append("the password")
        }
        guard !done.isEmpty else { return "“\(name)” has nothing for those fields." }
        try? await Task.sleep(for: .milliseconds(300))
        return "Filled \(done.joined(separator: " and ")) for \(host) from the vault's “\(name)” (you can't see them). Submit the form to sign in.\n\n" + (await snapshot())
    }

    /// One field filled from a vault item, on the item's own sites only: a sign-in's username or
    /// password, a key's or a note's field. The agent never sees it.
    func fill(_ index: Int, item: String, field: String?, why: String?, for caller: String? = nil) async -> String {
        let browser = browser()
        guard let host = Self.site(of: browser.url), let address = browser.url?.absoluteString else { return "Open the page first." }
        guard await Self.documentSite(in: browser) == host else {
            return "The page is still on its way to \(host). Wait for it, take a browser_snapshot, and call browser_fill again."
        }
        let kind = await run(Self.fieldKindScript, ["index": index], in: browser)
        guard kind == "text" || kind == "password" else { return kind == "missing" ? "There's no element [\(index)] on the page now. Take a fresh browser_snapshot." : "[\(index)] isn't a field to fill." }
        var body: [String: Any] = ["origin": address, "purpose": "field", "item": item]
        if let caller { body["session"] = caller }
        if let field, !field.isEmpty { body["field"] = field }
        if let why, !why.isEmpty { body["why"] = why }
        guard let filled = await BrowserTools.vaultFill(body) else { return "This Mac's vault can't be reached now. Try again in a moment." }
        guard filled.status == 200, let values = filled.value["values"] as? [String: String], let (name, value) = values.first else {
            return filled.value["message"] as? String ?? "The vault didn't fill that (\(filled.status))."
        }
        let itemName = (filled.value["item"] as? [String: Any])?["name"] as? String ?? item
        if let problem = stillOn(host, in: browser) { return problem }
        // A password only into a password field; anything else into either.
        let outcome = await run(Self.fillScript, ["index": index, "value": value, "wanted": name == "password" ? "password" : "code", "site": host], in: browser)
        guard outcome == "ok" else { return outcome }
        try? await Task.sleep(for: .milliseconds(300))
        return "Filled [\(index)] with “\(itemName)”'s \(name) (you can't see it).\n\n" + (await snapshot())
    }

    /// A one-time code (from a text, an email or an authenticator) that you type in Kuvo Code,
    /// filled into the field named.
    func askCode(_ index: Int, prompt: String?, for caller: String? = nil) async -> String {
        let browser = browser()
        guard let host = Self.site(of: browser.url) else { return "Open the page that asks for the code first." }
        // Asked for the site whose page it is, as a sign-in is: the address can show the next
        // site while the last one's page is still there.
        guard await Self.documentSite(in: browser) == host else {
            return "The page is still on its way to \(host). Wait for it, take a browser_snapshot, and call browser_ask_code again."
        }
        let kind = await run(Self.fieldKindScript, ["index": index], in: browser)
        guard kind == "text" || kind == "password" else { return kind == "missing" ? "There's no element [\(index)] on the page now. Take a fresh browser_snapshot." : "[\(index)] isn't a field to type a code into." }
        switch await ask(.code(prompt: prompt ?? ""), host: host, in: browser, for: caller) {
        case .code(let code):
            if let problem = stillOn(host, in: browser) { return problem }
            let outcome = await run(Self.fillScript, ["index": index, "value": code, "wanted": "code", "site": host], in: browser)
            guard outcome == "ok" else { return outcome }
            try? await Task.sleep(for: .milliseconds(300))
            return "Filled the code (you can't see it). Submit it if the page doesn't on its own.\n\n" + (await snapshot())
        case .timedOut:
            return Self.unanswered
        case .leftOnAutopilot:
            return Self.leftOnAutopilot
        default:
            return "The user didn't give a code. Ask them in the chat how to go on."
        }
    }

    /// Something only you can do on the page (a CAPTCHA, approving the sign-in on your phone):
    /// waits until you say you're done.
    func askUser(_ instruction: String, for caller: String? = nil) async -> String {
        let browser = browser()
        let host = Self.site(of: browser.url) ?? "the page"
        switch await ask(.action(instruction: instruction), host: host, in: browser, for: caller) {
        case .done:
            await settle(browser, expectNavigation: false)
            return "The user says it's done.\n\n" + (await snapshot())
        case .timedOut:
            return Self.unanswered
        case .leftOnAutopilot:
            return Self.leftOnAutopilot
        default:
            return "The user couldn't do it. Ask them in the chat how to go on."
        }
    }

    /// Asks you, in the conversation `caller`, about the page in `browser` (Show Page shows it).
    /// While it waits, the page's dialogs (from what you do there) are yours to answer.
    private func ask(_ kind: BrowserAsks.Kind, host: String, in browser: BrowserSession, for caller: String?) async -> BrowserAsks.Answer {
        browser.agentWaitsForYou(true)
        defer { browser.agentWaitsForYou(false) }
        return await asks.ask(kind, host: host, session: caller, page: utilities.id(of: browser)?.uuidString)
    }

    static let changed = "The page changed while the user answered, so nothing was filled in. "

    /// Nil if the page is still open on the site you were asked about, else why nothing goes in.
    private func stillOn(_ host: String, in browser: BrowserSession) -> String? {
        guard utilities.id(of: browser) != nil else { return "The page was closed while the user answered, so nothing was filled in." }
        let now = Self.site(of: browser.url)
        guard now == host else { return Self.changed + "It's on \(now ?? "another page") now, not \(host). Take a fresh browser_snapshot, and ask again on the page that asks." }
        return nil
    }

    /// The site of the document the page shows, as `site(of:)` names it.
    static func documentSite(in browser: BrowserSession) async -> String? {
        let script = "return location.protocol === 'file:' ? 'a file on this Mac' : location.protocol === 'http:' ? 'http://' + location.hostname : location.hostname"
        return try? await browser.webView.callAsyncJavaScript(script, arguments: [:], contentWorld: world) as? String
    }

    /// The site a page is on, as the ask names it and Passwords keeps it: its host, or for a page
    /// from a file, that it is one. One over plain http is a site of its own ("http://host"):
    /// passwords are saved from https, and one sent over http can be read on the way, so a saved
    /// one isn't offered or filled in there.
    static func site(of url: URL?) -> String? {
        guard let url else { return nil }
        if url.isFileURL { return "a file on this Mac" }
        return url.scheme == "http" ? url.host().map { "http://" + $0 } : url.host()
    }

    /// Nil if the fields are there and fit what goes in them, else why not.
    private func checkFields(username: Int?, password: Int?, in browser: BrowserSession) async -> String? {
        for (index, wanted) in [(password, "password"), (username, "text")] {
            guard let index else { continue }
            let kind = await run(Self.fieldKindScript, ["index": index], in: browser)
            if kind == "missing" { return "There's no element [\(index)] on the page now. Take a fresh browser_snapshot." }
            if wanted == "password", kind != "password" { return "[\(index)] isn't a password field: a password only goes into one." }
            if wanted == "text", kind != "text" { return "[\(index)] isn't a field for a username or email." }
        }
        return nil
    }

    func wait(_ seconds: Double) async -> String {
        try? await Task.sleep(for: .seconds(min(max(seconds, 0), 10)))
        return await snapshot()
    }

    /// Until `wanted` shows on the page, for 30 seconds at most, or until the call's stopped.
    func wait(for wanted: String) async -> String {
        let browser = browser()
        let deadline = ContinuousClock.now + .seconds(30)
        while ContinuousClock.now < deadline, !Task.isCancelled {
            let found = try? await browser.webView.callAsyncJavaScript("return (document.body ? document.body.innerText : '').toLowerCase().includes(wanted.toLowerCase())", arguments: ["wanted": wanted], contentWorld: .page) as? Bool
            if found == true { return "“\(wanted)” is on the page.\n\n" + (await snapshot()) }
            try? await Task.sleep(for: .milliseconds(500))
        }
        // Stopped: nobody's waiting for the page any more.
        guard !Task.isCancelled else { return "Stopped waiting for “\(wanted)”." }
        return "“\(wanted)” didn't show up in 30 seconds.\n\n" + (await snapshot())
    }

    func hover(_ index: Int) async -> String {
        let browser = browser()
        await point(.hover, at: index, in: browser)
        let outcome = await run(Self.hoverScript, ["index": index], in: browser)
        guard outcome == "ok" else { return outcome }
        try? await Task.sleep(for: .milliseconds(400))
        return "Hovered over [\(index)].\n\n" + (await snapshot())
    }

    // MARK: Helpers

    /// The tab this agent works in, and the panel shows it. A bot on this Mac uses its own tab,
    /// out of sight unless its conversation is in view. In your sessions, each conversation's agent
    /// keeps to a tab of its own: the one in view, unless another conversation's agent is using
    /// it, else a new one; another conversation's than the one in view stays behind it.
    private func browser() -> BrowserSession {
        let browser: BrowserSession
        var shows = true
        if let owner {
            browser = use ?? utilities.botBrowser(owner) ?? utilities.newBrowser(byAgent: true, owner: owner)
            use = browser
        } else if let caller {
            shows = utilities.bringsForward(caller)
            browser = utilities.agentBrowser(for: caller) ?? utilities.newBrowser(byAgent: true, owner: panel, shown: shows)
            utilities.agentWorks(caller, in: browser)
        } else {
            browser = utilities.activeBrowser ?? utilities.newBrowser(byAgent: true)
        }
        Analytics.shared.trackOnce("agent_used_browser")
        Analytics.shared.trackOnce("browser_used", key: "agent.mac", ["by": "agent", "place": "mac"])
        if shows { utilities.reveal(browser) }
        works(in: browser)
        return browser
    }

    /// The tab a bot works in during this call.
    private var use: BrowserSession?

    /// The page this call works in, without opening one.
    private var currentPage: BrowserSession? {
        if let owner { return use ?? utilities.botBrowser(owner) }
        if let caller { return utilities.agentBrowser(for: caller) }
        return utilities.activeBrowser
    }

    /// What the browser says of `page` being on a file the conversation may not read without
    /// asking (see `BrowserTools.fileNote`); nil if it isn't. It reached it by a link, a redirect
    /// or going back, or you opened it: its address was never checked.
    private func forbiddenFile(in page: BrowserSession) async -> String? {
        if let caller, BrowserTools.readsAnywhere(caller) { return nil }
        var addresses = [page.webView.url?.absoluteString].compactMap { $0 }
        // Its document's own address too, read apart from the page's scripts: going back, the
        // page can be there before the address says so. Not while it shows a dialog, which holds
        // scripts until it's answered.
        if page.dialog == nil, let own = try? await page.webView.evaluateJavaScript("location.href", in: nil, contentWorld: .defaultClient) as? String {
            addresses.append(own)
        }
        return addresses.lazy.compactMap { BrowserTools.fileNote(for: $0, caller: self.caller) }.first
    }

    /// Before a step: the tab in use on such a file (one you opened, say) stays as it is, and the
    /// step goes on in a new tab. Says so, or nil.
    func moveOffForbiddenFile() async -> String? {
        guard let page = currentPage, await forbiddenFile(in: page) != nil else { return nil }
        if let owner {
            use = utilities.newBrowser(byAgent: true, owner: owner)
        } else if let caller {
            utilities.agentWorks(caller, in: utilities.newBrowser(byAgent: true, owner: panel, shown: utilities.bringsForward(caller)))
        } else {
            utilities.reveal(utilities.newBrowser(byAgent: true))
        }
        return "The tab in use shows a file outside this conversation's folder, so this goes on in a new tab.\n\n"
    }

    /// After a step: the page on such a file goes blank, unless you have it, and what the step read
    /// is held back. Says why (not which file), or nil.
    func leaveForbiddenFile() async -> String? {
        guard let page = currentPage, await forbiddenFile(in: page) != nil else { return nil }
        if page.isHeld { return "The page shows a file outside this conversation's folder, so this step's result was held back." }
        page.webView.stopLoading()
        page.load("about:blank")
        await settle(page, expectNavigation: true)
        return "The page went to a file outside this conversation's folder, which this session asks about before reading, so it's blank now and this step's result was held back."
    }

    /// The tab in use, for the tab list.
    private var inUse: BrowserSession? {
        if let owner { return utilities.botBrowser(owner) }
        if let caller { return utilities.agentBrowser(for: caller) }
        return utilities.activeBrowser
    }

    /// Shows the pointer where the agent's about to act, and gives it a moment to get there.
    private func point(_ action: AgentPointer.Action, at index: Int, in browser: BrowserSession) async {
        guard let json = try? await browser.webView.callAsyncJavaScript(Self.findElement + Self.rectScript, arguments: withSnapshot(["index": index]), contentWorld: Self.world) as? String,
              let values = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Double],
              let x = values["x"], let y = values["y"], let width = values["width"], let height = values["height"] else { return }
        browser.showAgentStep(action, at: CGRect(x: x, y: y, width: width, height: height))
        try? await Task.sleep(for: .milliseconds(150))
    }

    /// The agent's own world in each page: the element scripts run there, and the numbers they
    /// keep stay there, where the page's own scripts can't read or change them. The DOM is the
    /// same in both, so what they do to the page is the same. Kept: WebKit drops a world, and
    /// what its scripts kept, once nothing holds it, so a world made afresh for each call had
    /// lost the snapshot's numbers by the click.
    static let world = WKContentWorld.world(name: "kuvo-agent")

    /// Runs one of the element scripts with the numbers from the last snapshot.
    private func run(_ body: String, _ arguments: [String: Any], in browser: BrowserSession) async -> String {
        do {
            let result = try await browser.webView.callAsyncJavaScript(Self.findElement + body, arguments: withSnapshot(arguments), contentWorld: Self.world)
            return result as? String ?? "ok"
        } catch {
            return "The page refused that: \(error.localizedDescription)"
        }
    }

    /// Each conversation's latest snapshot: the numbers its actions use are that snapshot's, and
    /// not another page's, or another conversation's in the same page.
    private static var snapshots: [String: String] = [:]

    private func withSnapshot(_ arguments: [String: Any]) -> [String: Any] {
        guard let caller else { return arguments }
        // One that hasn't read a page yet has no numbers of its own.
        return arguments.merging(["kuvoSnapshot": Self.snapshots[caller] ?? "none"]) { old, _ in old }
    }

    /// A click may start a navigation a beat later: wait up to a second for the address to
    /// change or loading to begin, then for it to finish. A stopped call stops waiting (its sleeps
    /// end at once, so the loops would only spin).
    private func settleAfterClick(_ browser: BrowserSession, from before: URL?) async {
        let start = ContinuousClock.now
        while ContinuousClock.now < start + .seconds(1), !browser.isLoading, browser.url == before, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(100))
        }
        await settle(browser, expectNavigation: browser.isLoading || browser.url != before)
    }

    /// Waits for a navigation to start and finish (up to 10 s), then a moment for the page to settle.
    private func settle(_ browser: BrowserSession, expectNavigation: Bool) async {
        if expectNavigation { try? await Task.sleep(for: .milliseconds(250)) }
        let deadline = ContinuousClock.now + .seconds(10)
        while browser.isLoading, ContinuousClock.now < deadline, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(150))
        }
        try? await Task.sleep(for: .milliseconds(expectNavigation ? 500 : 350))
    }

    // MARK: Scripts

    static let domTree: String = {
        guard let url = Bundle.main.url(forResource: "buildDomTree", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8) else { return "() => ({ rootId: null, map: {} })" }
        // The file is one arrow function ending in ";", which can't sit inside parentheses.
        var function = source.trimmingCharacters(in: .whitespacesAndNewlines)
        while function.hasSuffix(";") { function.removeLast() }
        // Each element as it's numbered, handed to `onIndex`: the actions use that very element,
        // in a frame or a shadow root too, where the path it keeps leads nowhere or elsewhere. The
        // file itself stays as browser-use has it.
        let numbered = "nodeData.highlightIndex = highlightIndex++;"
        assert(function.contains(numbered), "buildDomTree.js no longer numbers elements where onIndex hooks in")
        return function.replacingOccurrences(of: numbered, with: numbered + " if (args.onIndex) args.onIndex(nodeData.highlightIndex, node);")
    }()

    /// What an element is, to tell later it's still the one numbered: its kind, and how its text
    /// starts, digits aside (counters and times change on their own).
    static let fingerprintScript = """
    const fingerprint = (element) => {
      let text = '';
      const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (text.length < 200 && walker.nextNode()) text += walker.currentNode.data + ' ';
      const attribute = (name) => element.getAttribute(name) || '';
      return [element.localName, attribute('type'), attribute('name'), attribute('role'), attribute('href'),
        text.replace(/\\s+/g, ' ').trim().slice(0, 80).replace(/\\d+/g, '#')].join('|');
    };

    """

    /// Every element, in the page, its open shadow roots and its frames, in an order the page's
    /// world and the agent's walk alike: one names an element to the other by its place in it.
    static let everyElementScript = """
    const everyElement = (visit) => {
      let place = 0;
      (function walk(root) {
        for (const element of root.querySelectorAll('*')) {
          visit(element, place++);
          if (element.shadowRoot) walk(element.shadowRoot);
          if (element.localName === 'iframe' || element.localName === 'frame') {
            try { if (element.contentDocument) walk(element.contentDocument); } catch {}
          }
        }
      })(document);
    };

    """

    /// Run in the page's own world: the elements the page set something to run on a click as a
    /// property (`element.onclick = …`), which the agent's world can't see, as [place, tag, names].
    static let handlersScript = """
    \(everyElementScript)
    const names = ['onclick', 'onmousedown', 'onmouseup', 'ondblclick'];
    const found = [];
    everyElement((element, place) => {
      const set = names.filter((name) => typeof element[name] === 'function' && !element.hasAttribute(name));
      if (set.length) found.push([place, element.localName, set]);
    });
    return found;
    """

    /// Runs buildDomTree, keeps each numbered element (and what it was) for the actions, and
    /// writes the elements out the way browser-use shows them to a model. `kuvoSnapshot`, when
    /// given, names this snapshot, so actions can tell their numbers are from it.
    /// `kuvoHandlers`, from `handlersScript`, are the page's click handlers, which buildDomTree
    /// sees here only while it runs.
    static let snapshotScript = """
    document.getElementById('playwright-highlight-container')?.remove();
    const numbered = {};
    \(everyElementScript)
    const lent = [];
    if (typeof kuvoHandlers === 'object' && kuvoHandlers && kuvoHandlers.length) {
      const handlers = new Map(kuvoHandlers.map((entry) => [entry[0], entry]));
      everyElement((element, place) => {
        const entry = handlers.get(place);
        if (!entry || entry[1] !== element.localName) return;
        for (const name of entry[2]) {
          Object.defineProperty(element, name, { value: () => {}, configurable: true });
          lent.push([element, name]);
        }
      });
    }
    let result;
    try {
      result = (\(domTree))({ doHighlightElements: false, focusHighlightIndex: -1, viewportExpansion: 0, debugMode: false, onIndex: (number, element) => { numbered[number] = element; } });
    } finally {
      for (const [element, name] of lent) delete element[name];
    }
    \(fingerprintScript)
    const map = result.map || {};
    const ATTRIBUTES = ['title', 'type', 'checked', 'name', 'role', 'value', 'placeholder', 'alt', 'aria-label', 'aria-expanded', 'aria-checked', 'data-state', 'href'];
    const index = {};
    const lines = [];
    const clean = (text) => text.replace(/\\s+/g, ' ').trim();
    function textUntilClickable(id) {
      const parts = [];
      (function walk(nodeID, isRoot) {
        const node = map[nodeID];
        if (!node) return;
        if (node.type === 'TEXT_NODE') { if (node.isVisible !== false) parts.push(node.text); return; }
        if (!isRoot && node.highlightIndex !== undefined && node.highlightIndex !== null) return;
        (node.children || []).forEach((child) => walk(child, false));
      })(id, true);
      return clean(parts.join(' '));
    }
    (function walk(nodeID, insideClickable) {
      const node = map[nodeID];
      if (!node) return;
      if (node.type === 'TEXT_NODE') {
        if (!insideClickable && node.isVisible !== false && clean(node.text)) lines.push(clean(node.text));
        return;
      }
      let inside = insideClickable;
      if (node.highlightIndex !== undefined && node.highlightIndex !== null) {
        const element = numbered[node.highlightIndex];
        if (element) index[node.highlightIndex] = { element, print: fingerprint(element) };
        const attributes = ATTRIBUTES
          .filter((name) => node.attributes && node.attributes[name])
          // A password field's value never goes to the model.
          .filter((name) => !(name === 'value' && String(node.attributes.type).toLowerCase() === 'password'))
          // Nor what the user filled in through Kuvo Code.
          .filter((name) => !(name === 'value' && node.attributes['data-kuvo-secret'] !== undefined))
          .map((name) => `${name}="${String(node.attributes[name]).slice(0, 100)}"`)
          .join(' ');
        const tag = node.tagName || 'element';
        lines.push(`[${node.highlightIndex}]<${tag}${attributes ? ' ' + attributes : ''}>${textUntilClickable(nodeID).slice(0, 150)}</${tag}>`);
        inside = true;
      }
      (node.children || []).forEach((child) => walk(child, inside));
    })(result.rootId, false);
    // In the agent's world (`BrowserAgent.world`, and a machine's), out of the page's reach.
    window.__kuvoIndex = { snapshot: typeof kuvoSnapshot === 'string' ? kuvoSnapshot : null, elements: index };
    // A page that asks to sign in (or for a one-time code) says what to do about it, where the
    // agent reads it: ask the user in Kuvo Code, not in the chat.
    const shown = (field) => !field.disabled && field.getClientRects().length > 0 && getComputedStyle(field).visibility !== 'hidden';
    const fields = [...document.querySelectorAll('input')].filter(shown);
    const filled = fields.some((field) => field.hasAttribute('data-kuvo-secret'));
    const autocomplete = (pattern) => fields.some((field) => pattern.test(field.autocomplete || ''));
    if (!filled && autocomplete(/one-time-code/)) {
      lines.unshift('(This page asks for a one-time code: call browser_ask_code with its field now, unless the user already said no. The user types it in Kuvo Code; never ask for it in the chat.)', '');
    } else if (!filled && (fields.some((field) => field.type === 'password') || autocomplete(/\\busername\\b|current-password/))) {
      lines.unshift('(This page asks to sign in: call browser_sign_in with its fields now, unless the user already said no. The user answers in Kuvo Code, where they can also say Not Now; do not ask in the chat whether to sign in, or for their password.)', '');
    }
    const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    return {
      text: lines.join('\\n'),
      title: document.title,
      url: location.href,
      above: Math.round(window.scrollY),
      below: Math.max(0, Math.round(scrollHeight - window.scrollY - window.innerHeight)),
    };
    """

    /// What the element scripts start with: `find(number)` gives the element numbered in the latest
    /// snapshot while it's on the page as it was (in a frame or a shadow root too), else null, and
    /// `missing(number)` says why. With `kuvoSnapshot`, the numbers must be from that snapshot.
    static let findElement = """
    \(fingerprintScript)
    let lost = 'none';
    // On the page now: in its document, and that document still in its frame, out to the page's own.
    const attached = (element) => {
      for (let node = element; node;) {
        if (!node.isConnected) return false;
        const doc = node.ownerDocument;
        if (doc === document) return true;
        const frame = doc.defaultView && doc.defaultView.frameElement;
        if (!frame || frame.contentDocument !== doc) return false;
        node = frame;
      }
      return false;
    };
    const find = (number) => {
      const map = window.__kuvoIndex;
      const entry = map && map.elements ? map.elements[number] : null;
      if (!entry) { lost = 'none'; return null; }
      if (typeof kuvoSnapshot === 'string' && map.snapshot !== kuvoSnapshot) { lost = 'other'; return null; }
      if (!attached(entry.element) || fingerprint(entry.element) !== entry.print) { lost = 'changed'; return null; }
      return entry.element;
    };
    const missing = (number) => lost === 'changed'
      ? `The page changed since the snapshot: [${number}] is gone or isn't what it was. Take a fresh browser_snapshot.`
      : lost === 'other'
        ? `[${number}] is from a snapshot of another page or tab. Take a fresh browser_snapshot of this one.`
        : `There's no element [${number}] on the page now. Take a fresh browser_snapshot.`;
    // The window an element is in (its frame's), whose events and types it takes.
    const viewOf = (element) => element.ownerDocument.defaultView || window;
    // What kind of field an element is: "password", "text" (a username, an email, a code) or "other".
    const kindOf = (element) => {
      if (element.localName === 'input') {
        const type = (element.type || 'text').toLowerCase();
        if (type === 'password') return 'password';
        return ['text', 'email', 'tel', 'number', 'search', 'url'].includes(type) ? 'text' : 'other';
      }
      return element.localName === 'textarea' ? 'text' : 'other';
    };

    """

    /// Brings [index] into view, as the actions do, and says where it is (JSON, CSS pixels from
    /// the window's top left), for the pointer that shows what the agent's doing.
    static let rectScript = """
    const element = find(index);
    if (!element) return '';
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = element.getBoundingClientRect();
    let x = r.left, y = r.top;
    // In a frame: plus where the frame's content is, out to the page's own window.
    for (let view = viewOf(element); view !== window && view.frameElement; view = view.parent) {
      const frame = view.frameElement, box = frame.getBoundingClientRect(), style = view.parent.getComputedStyle(frame);
      x += box.left + frame.clientLeft + (parseFloat(style.paddingLeft) || 0);
      y += box.top + frame.clientTop + (parseFloat(style.paddingTop) || 0);
    }
    return JSON.stringify({ x, y, width: r.width, height: r.height });
    """

    /// What the page hears when the pointer comes over [index].
    static let hoverScript = """
    const element = find(index);
    if (!element) return missing(index);
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const view = viewOf(element);
    const rect = element.getBoundingClientRect();
    const options = { bubbles: true, cancelable: true, composed: true, view, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      const bubbles = !type.endsWith('enter');
      element.dispatchEvent(type.startsWith('pointer') ? new view.PointerEvent(type, { ...options, bubbles }) : new view.MouseEvent(type, { ...options, bubbles }));
    }
    return 'ok';
    """

    static let clickScript = """
    const element = find(index);
    if (!element) return missing(index);
    document.getElementById('playwright-highlight-container')?.remove();
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const view = viewOf(element);
    const rect = element.getBoundingClientRect();
    const options = { bubbles: true, cancelable: true, composed: true, view, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
    for (const type of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      element.dispatchEvent(type.startsWith('pointer') ? new view.PointerEvent(type, options) : new view.MouseEvent(type, options));
    }
    if (typeof element.focus === 'function') element.focus();
    element.click();
    return 'ok';
    """

    static let typeScript = """
    const element = find(index);
    if (!element) return missing(index);
    document.getElementById('playwright-highlight-container')?.remove();
    element.scrollIntoView({ block: 'center' });
    element.focus();
    const view = viewOf(element);
    if (element.isContentEditable) {
      const doc = element.ownerDocument;
      if (clear) { doc.execCommand('selectAll', false); doc.execCommand('delete', false); }
      doc.execCommand('insertText', false, text);
    } else if (element.localName === 'input' || element.localName === 'textarea') {
      const prototype = element.localName === 'textarea' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      setter.call(element, (clear ? '' : element.value) + text);
      element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new view.Event('change', { bubbles: true }));
    } else {
      return `[${index}] doesn't take text. Click it first, or pick an input.`;
    }
    if (submit) {
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
      const proceed = element.dispatchEvent(new view.KeyboardEvent('keydown', init));
      element.dispatchEvent(new view.KeyboardEvent('keypress', init));
      element.dispatchEvent(new view.KeyboardEvent('keyup', init));
      if (proceed && element.form) element.form.requestSubmit ? element.form.requestSubmit() : element.form.submit();
    }
    return 'ok';
    """

    static let selectScript = """
    const element = find(index);
    if (!element) return missing(index);
    if (element.localName !== 'select') return `[${index}] isn't a list to select from.`;
    const view = viewOf(element);
    const wanted = option.toLowerCase();
    const match = Array.from(element.options).find((item) => item.text.trim().toLowerCase() === wanted || item.value.toLowerCase() === wanted);
    if (!match) return `No option “${option}” in [${index}]. Options: ` + Array.from(element.options).map((item) => item.text.trim()).join(', ');
    element.value = match.value;
    element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new view.Event('change', { bubbles: true }));
    return 'ok';
    """

    /// The file input [index] stands for: itself, one inside it or that its label is for, the
    /// nearest one around it (an upload button beside its hidden input), or the only one where it
    /// is (its shadow root, else its page); else "missing" or "none".
    static let fileInputScript = """
    const element = find(index);
    if (!element) return 'missing';
    const isFile = (node) => !!node && node.localName === 'input' && node.type === 'file';
    let input = isFile(element) ? element : element.querySelector && element.querySelector('input[type=file]');
    const label = element.closest && element.closest('label');
    if (!input && label && isFile(label.control)) input = label.control;
    for (let around = element.parentElement, level = 0; !input && around && level < 3; around = around.parentElement, level++) {
      const inside = around.querySelectorAll('input[type=file]');
      if (inside.length === 1) input = inside[0];
    }
    for (const root of new Set([element.getRootNode(), element.ownerDocument])) {
      if (input || !root.querySelectorAll) continue;
      const all = [...root.querySelectorAll('input[type=file]')];
      if (all.length === 1) input = all[0];
    }
    return input || 'none';
    """

    /// Puts `files` ({name, type, data in base64}) into the file input [index], as choosing them
    /// in the file picker would.
    static let uploadScript = """
    const input = (() => {
    \(fileInputScript)
    })();
    if (typeof input === 'string') return input;
    const view = viewOf(input);
    const transfer = new view.DataTransfer();
    for (const file of files) {
      const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
      transfer.items.add(new view.File([bytes], file.name, { type: file.type }));
    }
    input.files = transfer.files;
    input.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new view.Event('change', { bubbles: true }));
    return 'ok';
    """

    /// What kind of field [index] is: "password", "text" (a username, an email, a code), "other"
    /// or "missing".
    static let fieldKindScript = """
    const element = find(index);
    if (!element) return 'missing';
    return kindOf(element);
    """

    /// Puts what the user gave into [index], as typing would, and marks it so it stays out of
    /// what the agent reads and sees. Only into the field `wanted` as it is now: "password" only
    /// into a password field, "text" (a username) only into a text field, "code" into either.
    static let fillScript = """
    const element = find(index);
    if (!element) return missing(index);
    // Only into a page of the site the user was asked about: its address may already show the
    // next site while this document is still the last one's.
    const where = element.ownerDocument.location;
    const here = where.protocol === 'file:' ? 'a file on this Mac' : where.protocol === 'http:' ? 'http://' + where.hostname : where.hostname;
    if (typeof site === 'string' && here !== site) {
      return `The page isn't on ${site} now, so nothing was filled in. Take a fresh browser_snapshot and ask again.`;
    }
    const kind = kindOf(element);
    if (wanted === 'password' ? kind !== 'password' : wanted === 'code' ? kind === 'other' : kind !== 'text') {
      return wanted === 'password'
        ? `[${index}] isn't a password field now: a password only goes into one. Nothing was filled in. Take a fresh browser_snapshot and ask again.`
        : `[${index}] isn't a field for that now. Nothing was filled in. Take a fresh browser_snapshot and ask again.`;
    }
    element.scrollIntoView({ block: 'center' });
    element.focus();
    const view = viewOf(element);
    const prototype = element.localName === 'textarea' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new view.Event('change', { bubbles: true }));
    element.setAttribute('data-kuvo-secret', '');
    return 'ok';
    """

    /// The page's documents and shadow roots that hold something the user filled in: the page's
    /// own, its frames' and those inside them, for the mask to reach.
    static let secretRootsScript = """
    const roots = [];
    (function collect(root) {
      roots.push(root);
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) collect(element.shadowRoot);
        if (element.localName === 'iframe' || element.localName === 'frame') {
          try { if (element.contentDocument) collect(element.contentDocument); } catch {}
        }
      }
    })(document);

    """

    /// Hides what the user filled in, for a screenshot, and shows it again.
    static let maskScript = mask("color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important", id: "kuvo-secret-mask")
    static let unmaskScript = unmask("kuvo-secret-mask")

    /// The same for a PDF: there, text drawn clear is still in it, to copy or search, so the
    /// fields are left out (their place stays empty). A mask of its own, so a screenshot at the
    /// same time neither stands in for it nor takes it away.
    static let printMaskScript = mask("visibility:hidden!important", id: "kuvo-secret-print-mask")
    static let printUnmaskScript = unmask("kuvo-secret-print-mask")

    private static func mask(_ rule: String, id: String) -> String {
        """
        \(secretRootsScript)
        for (const root of roots) {
          if (!root.querySelector('[data-kuvo-secret]') || root.getElementById('\(id)')) continue;
          const doc = root.ownerDocument || root;
          const style = doc.createElement('style');
          style.id = '\(id)';
          style.textContent = '[data-kuvo-secret]{\(rule)}';
          (root.head || root.documentElement || root).appendChild(style);
        }
        return 'ok';
        """
    }

    private static func unmask(_ id: String) -> String {
        """
        \(secretRootsScript)
        for (const root of roots) root.getElementById('\(id)')?.remove();
        return 'ok';
        """
    }

    /// Presses `key` on the element with the focus, inside frames and shadow roots too.
    static let pressScript = """
    let target = document.activeElement || document.body;
    for (;;) {
      const frame = (target.localName === 'iframe' || target.localName === 'frame') && target.contentDocument;
      const inner = target.shadowRoot ? target.shadowRoot.activeElement : frame ? frame.activeElement : null;
      if (!inner || inner === target) break;
      target = inner;
    }
    const view = target.ownerDocument.defaultView || window;
    const codes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32 };
    const init = { key: key, code: key, keyCode: codes[key] || 0, which: codes[key] || 0, bubbles: true, cancelable: true, composed: true };
    const proceed = target.dispatchEvent(new view.KeyboardEvent('keydown', init));
    if (key === 'Enter') target.dispatchEvent(new view.KeyboardEvent('keypress', init));
    target.dispatchEvent(new view.KeyboardEvent('keyup', init));
    if (key === 'Enter' && proceed && target.form) target.form.requestSubmit ? target.form.requestSubmit() : target.form.submit();
    if (key === 'Escape' && typeof target.blur === 'function') target.blur();
    return 'ok';
    """
}
