import AppKit
import ClientDesign
import SwiftUI
import Textual

/// A page of a machine's browser, in its tab: the page live, with back, forward, reload and the
/// address, and what the agent is doing. Clicks, scrolling and typing go to the page. A new tab,
/// or a blank page, shows the new tab page until you go somewhere.
struct MachineBrowserPane<NewTab: View>: View {
    let browser: MachineBrowser
    /// The page this tab shows; nil for a new tab that hasn't opened one yet.
    let page: String?
    /// Attaches files to the message being written, for Add Screenshot to Message.
    /// None where there's no message to add a screenshot to (signing in, in Settings).
    var attach: (([URL]) -> Void)?
    @ViewBuilder let newTab: () -> NewTab
    /// Goes to an address typed in a new tab (opening its page).
    let onSubmit: (String) -> Void
    @State private var address = ""
    @FocusState private var editing: Bool
    @Environment(\.isPanelShown) private var isPanelShown

    private var isShown: Bool { page != nil && browser.shownPage == page }
    private var isLive: Bool { browser.state == .live && isShown }
    private var url: URL? { browser.url(of: page) }
    /// Nothing to show yet: a new tab, or a page that hasn't gone anywhere.
    private var isBlank: Bool { page == nil || (browser.page(page)?.isBlank ?? true) && !(isShown && browser.isLoading) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                navigation
                addressField
                actions
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 8)
            if isShown, let page, let site = browser.passkeyPages[page], site == browser.page(page).flatMap({ MachineBrowser.site(of: $0.url) }) {
                PasskeyBar { withAnimation(.ui) { browser.closePasskeyNote(page) } }
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            if isShown, let dialog = browser.dialog {
                DialogBar(dialog: dialog, browser: browser)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            if isShown, let download = browser.downloads.last {
                MachineDownloadBar(download: download, browser: browser)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .animation(.ui, value: browser.dialog)
        .animation(.ui, value: browser.downloads)
        .task(id: isPanelShown ? page : nil) {
            // While this tab shows its page, that's the page in use, live; not while the panel's
            // hidden.
            guard isPanelShown, let page else { return }
            browser.show(page)
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
            browser.hide(page)
        }
        .onAppear {
            address = displayAddress
            if isBlank, !AppInfo.staysInBackground { editing = true }
        }
        .onChange(of: url) { if !editing { address = displayAddress } }
        .onChange(of: editing) { _, isEditing in address = isEditing ? (url?.absoluteString ?? "") : displayAddress }
    }

    @ViewBuilder private var content: some View {
        switch browser.setup {
        case .unknown:
            Spinner(size: 16)
        case .installing(let progress):
            SetupCard(machine: browser.machine.name, progress: progress)
        case .failed(let message):
            problem("Couldn’t Set Up the Browser", message) { browser.retry() }
        case .ready:
            if case .failed(let message) = browser.state {
                problem("The Browser Isn’t Available", message) { browser.retry() }
            } else if isBlank {
                newTab()
            } else if isLive {
                LivePage(browser: browser)
                    .overlay(alignment: .bottom) {
                        if browser.isAgentBrowsing || browser.isHeld {
                            AgentBadge(session: browser.browsingSession, isHeld: browser.isHeld) { browser.takeOver($0) }
                                .padding(.bottom, 12)
                                .transition(.opacity)
                        }
                    }
                    .animation(.ui, value: browser.isAgentBrowsing || browser.isHeld)
            } else {
                ZStack {
                    LivePage(browser: browser)
                        .opacity(0.4)
                    Spinner(size: 16)
                }
            }
        }
    }

    private func problem(_ title: String, _ message: String, retry: @escaping () -> Void) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
                .textSelection(.enabled)
        } actions: {
            Button("Try Again", action: retry)
        }
    }

    private var navigation: some View {
        BrowserNavigation(canGoBack: isLive && browser.canGoBack, canGoForward: isLive && browser.canGoForward, isLoading: isLive && browser.isLoading,
                          canReload: isLive && url != nil, back: browser.goBack, forward: browser.goForward,
                          reloadOrStop: { if browser.isLoading { browser.stopLoading() } else { browser.reload() } })
    }

    private var addressField: some View {
        BrowserAddressField(address: $address, editing: $editing, isSecure: url?.scheme == "https", isLoading: isLive && browser.isLoading,
                            help: "Pages open on \(browser.machine.name), so localhost is that machine") {
            if page == nil { onSubmit(address) } else { browser.load(address) }
            editing = false
        }
    }

    private var actions: some View {
        BrowserToolbarGroup {
            if browser.zoom != 1 {
                BrowserZoomChip(zoom: browser.zoom) { browser.resetZoom() }
            }
            if let attach {
                Button {
                    if let file = browser.screenshotFile() { attach([file]) }
                } label: {
                    Label("Add Screenshot to Message", systemImage: "camera.viewfinder")
                }
                .disabled(!isLive || !browser.hasPicture || url == nil)
                .help("Add a screenshot of the page to your message, so the agent sees what you see")
            }
            BrowserMoreMenu(url: url, canReload: isLive && url != nil, reload: browser.reload) { step in
                if step == 0 { browser.resetZoom() } else { browser.zoom(in: step > 0) }
            }
        }
    }

    private var displayAddress: String { BrowserAddressField.display(url, editing: editing) }
}

/// The page, live. Its pictures go straight to the view, not through SwiftUI.
private struct LivePage: View {
    let browser: MachineBrowser

    var body: some View {
        RemotePage(browser: browser)
    }
}

/// While the browser goes onto the machine, the first time.
private struct SetupCard: View {
    let machine: String
    let progress: Double?

    var body: some View {
        VStack(spacing: 14) {
            // One sign of progress: the bar, once it can say how far.
            if progress == nil { Spinner(size: 22) }
            VStack(spacing: 6) {
                Text("Setting Up the Browser on \(machine)")
                    .font(.system(size: 15, weight: .semibold))
                Text("\(machine) downloads a browser from Google (on Linux, with the libraries it needs from Rocky Linux) into ~/.kuvo-code. Nothing is installed on the system.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 340)
            }
            if let progress {
                VStack(spacing: 5) {
                    HStack {
                        Text("Downloading the browser")
                        Spacer(minLength: 8)
                        Text(min(max(progress, 0), 1), format: .percent.precision(.fractionLength(0)))
                            .monospacedDigit()
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                    ProgressLine("Downloading the browser", fraction: progress, layout: .bar)
                }
                .frame(width: 220)
            } else {
                Text("Putting it together…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(24)
    }
}

/// The page's zoom, when it isn't actual size; a click goes back to it.
/// A page downloaded a file on the machine: where it is, and a copy for this Mac.
private struct MachineDownloadBar: View {
    let download: MachineBrowser.Download
    let browser: MachineBrowser

    var body: some View {
        BrowserDownloadBar(name: download.name, symbol: symbol, hide: browser.dismissDownloads) {
            Text(detail)
        } actions: {
            switch download.state {
            case .onMachine, .failed:
                Button("Save to Mac") { browser.saveToMac(download.id) }
                    .help("Copy it into your Downloads folder")
            case .saving:
                Spinner(size: 14)
            case .saved(let file):
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([file]) }
            }
        }
    }

    private var symbol: String {
        if case .saved = download.state { return "checkmark.circle.fill" }
        return "arrow.down.circle"
    }

    private var detail: String {
        switch download.state {
        case .onMachine: "Downloaded on \(browser.machine.name)"
        case .saving: "Copying to this Mac…"
        case .saved: "In your Downloads folder"
        case .failed(let reason): reason
        }
    }
}

/// The page asks something (an alert, a confirmation, a question, whether to leave it): answer
/// it here.
private struct DialogBar: View {
    let dialog: MachineBrowser.Dialog
    let browser: MachineBrowser

    var body: some View {
        BrowserDialogBar(message: dialog.message, asks: dialog.type == "prompt", isAlert: dialog.type == "alert",
                         okTitle: dialog.type == "beforeunload" ? "Leave" : "OK", defaultText: dialog.defaultPrompt) { accept, text in
            browser.answer(dialog, accept: accept, text: text)
        }
    }
}

// MARK: - The page

/// Shows the page's pictures, fitted to the width, and sends what you do there to the page.
private struct RemotePage: NSViewRepresentable {
    let browser: MachineBrowser

    func makeNSView(context: Context) -> RemotePageView {
        let view = RemotePageView(browser: browser)
        browser.pictureView = view
        return view
    }

    func updateNSView(_ view: RemotePageView, context: Context) {}

    static func dismantleNSView(_ view: RemotePageView, coordinator: ()) {
        if view.browser.pictureView === view { view.browser.pictureView = nil }
    }
}

final class RemotePageView: NSView, @preconcurrency NSTextInputClient, PictureView {
    let browser: MachineBrowser
    private let imageLayer = CALayer()
    private var pageSize = CGSize(width: 1280, height: 800)
    /// Scrolling shows at once: the picture moves by what you scrolled until the page's next one
    /// catches up (a picture takes a moment to come from the machine), once the page has shown
    /// that it scrolls as a whole, not a part of it.
    private var ahead = CGPoint.zero
    private var pageScroll: CGPoint?
    private var pageScrolls = false
    private var lastScroll = Date.distantPast
    private var aheadSince: Date?
    private var settle: Task<Void, Never>?
    private lazy var pointer = AgentPointerLayers(in: layer!)
    private var tracking: NSTrackingArea?
    private var lastMove = Date.distantPast
    private var marked: String?

    init(browser: MachineBrowser) {
        self.browser = browser
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.cgColor
        // A picture shown ahead of the page's scrolling stays inside the page's room.
        layer?.masksToBounds = true
        imageLayer.contentsGravity = .resize
        imageLayer.magnificationFilter = .linear
        imageLayer.minificationFilter = .trilinear
        layer?.addSublayer(imageLayer)
    }

    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func show(_ picture: MachineBrowser.Picture?) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.contents = picture?.image
        if let picture {
            if picture.size.width > 0, picture.size.height > 0 { pageSize = picture.size }
            caughtUp(to: picture.scroll)
        } else {
            ahead = .zero
            pageScroll = nil
            pageScrolls = false
            pointer.clear()
        }
        placeImage()
        CATransaction.commit()
    }

    func point(_ action: AgentPointer.Action, at rect: CGRect) {
        let page = pageRect
        let scale = pageSize.width > 0 ? page.width / pageSize.width : 1
        let element = CGRect(x: page.minX + rect.minX * scale, y: page.maxY - rect.maxY * scale, width: rect.width * scale, height: rect.height * scale)
        pointer.show(action, at: CGPoint(x: element.midX, y: element.midY), over: element)
    }

    /// A new picture, scrolled to `scroll`: what it shows of your scrolling needn't be shown ahead
    /// any more.
    private func caughtUp(to scroll: CGPoint) {
        defer { pageScroll = scroll }
        guard let before = pageScroll else { return }
        let moved = CGPoint(x: scroll.x - before.x, y: scroll.y - before.y)
        // The page scrolled with your scrolling: it does as a whole, so scrolling shows ahead.
        if Date.now.timeIntervalSince(lastScroll) < 0.5, moved != .zero { pageScrolls = true }
        // A while into your scrolling, the page shows changes but hasn't moved: a part of it
        // scrolls (a list, a pane), so the picture stays put.
        if moved == .zero, ahead != .zero, let since = aheadSince, Date.now.timeIntervalSince(since) > 0.25 {
            pageScrolls = false
            ahead = .zero
        }
        ahead.x = Self.remaining(ahead.x, after: moved.x)
        ahead.y = Self.remaining(ahead.y, after: moved.y)
        if ahead == .zero { aheadSince = nil }
    }

    /// What's still ahead of the page after it moved: never past where it is.
    private static func remaining(_ ahead: CGFloat, after moved: CGFloat) -> CGFloat {
        guard ahead != 0 else { return 0 }
        let left = ahead - moved
        return left * ahead > 0 ? left : 0
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        placeImage()
        CATransaction.commit()
        reportSize()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        reportSize()
    }

    private func reportSize() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        browser.resize(to: bounds.size, scale: window?.backingScaleFactor ?? 2)
    }

    /// Where the page shows: as wide as the view, from its top (the page follows the view's
    /// size, so this only differs for a moment while it resizes).
    private var pageRect: CGRect {
        guard pageSize.width > 0 else { return bounds }
        let scale = min(bounds.width / pageSize.width, bounds.height / pageSize.height)
        let size = CGSize(width: pageSize.width * scale, height: pageSize.height * scale)
        return CGRect(x: (bounds.width - size.width) / 2, y: bounds.height - size.height, width: size.width, height: size.height)
    }

    private func placeImage() {
        let rect = pageRect
        let scale = pageSize.width > 0 ? rect.width / pageSize.width : 1
        imageLayer.frame = rect.offsetBy(dx: -ahead.x * scale, dy: ahead.y * scale)
    }

    /// A point in the view, in the page's CSS pixels.
    private func pagePoint(_ event: NSEvent) -> CGPoint {
        let point = convert(event.locationInWindow, from: nil)
        let rect = pageRect
        guard rect.width > 0, rect.height > 0 else { return .zero }
        return CGPoint(
            x: ((point.x - rect.minX) / rect.width * pageSize.width).rounded(),
            y: ((rect.maxY - point.y) / rect.height * pageSize.height).rounded()
        )
    }

    // MARK: Mouse

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = PointerClaim.trackingArea(owner: self, in: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        browser.mouse("mousePressed", at: pagePoint(event), button: "left", buttons: 1, clicks: event.clickCount, modifiers: MachineBrowser.modifiers(event.modifierFlags))
    }

    override func mouseUp(with event: NSEvent) {
        browser.mouse("mouseReleased", at: pagePoint(event), button: "left", buttons: 0, clicks: event.clickCount, modifiers: MachineBrowser.modifiers(event.modifierFlags))
    }

    override func mouseDragged(with event: NSEvent) {
        browser.mouse("mouseMoved", at: pagePoint(event), button: "left", buttons: 1, modifiers: MachineBrowser.modifiers(event.modifierFlags))
    }

    override func mouseMoved(with event: NSEvent) {
        // At once, so it lets go onto a bar or a button over the page (Take Over).
        showCursor(at: event.locationInWindow)
        // Hovers at most 30 times a second: each is a message over the network.
        guard Date.now.timeIntervalSince(lastMove) > 1.0 / 30 else { return }
        lastMove = .now
        let point = pagePoint(event)
        browser.mouse("mouseMoved", at: point, modifiers: MachineBrowser.modifiers(event.modifierFlags))
        updateCursor(at: point)
    }

    // MARK: Cursor

    /// The page's cursor where the pointer is (a hand over a link, a text cursor over a field),
    /// asked of the page a few times a second at most.
    private var cursor = NSCursor.arrow
    private var cursorQuery: Task<Void, Never>?
    private var lastCursorQuery = Date.distantPast
    /// Shown only where the page is what's under the pointer, not under a bar or card over it.
    private let claim = PointerClaim()

    private func showCursor(at location: NSPoint) {
        claim.show(PointerClaim.isTopmost(self, at: location) ? cursor : nil)
    }

    override func cursorUpdate(with event: NSEvent) {
        showCursor(at: event.locationInWindow)
    }

    override func mouseEntered(with event: NSEvent) {
        showCursor(at: event.locationInWindow)
    }

    override func mouseExited(with event: NSEvent) {
        claim.show(nil)
    }

    // Removed under the pointer (the pane closed): no `mouseExited` comes.
    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow == nil { claim.show(nil) }
    }

    private func updateCursor(at point: CGPoint) {
        guard cursorQuery == nil else { return }
        let wait = max(0, 0.12 - Date.now.timeIntervalSince(lastCursorQuery))
        cursorQuery = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard let self else { return }
            lastCursorQuery = .now
            let name = await browser.cursor(at: point)
            cursorQuery = nil
            guard let name else { return }
            cursor = Self.cursor(named: name)
            // Only where the page is on top: off it, the last move let go already, and what's
            // there (Take Over's hand) keeps its pointer.
            if let window {
                let location = window.mouseLocationOutsideOfEventStream
                if PointerClaim.isTopmost(self, at: location) { claim.show(cursor) }
            }
        }
    }

    private static func cursor(named name: String) -> NSCursor {
        switch name {
        case "pointer": .pointingHand
        case "text", "vertical-text": .iBeam
        case "grab": .openHand
        case "grabbing", "move", "all-scroll": .closedHand
        case "not-allowed", "no-drop": .operationNotAllowed
        case "crosshair", "cell": .crosshair
        case "col-resize", "ew-resize", "e-resize", "w-resize": .resizeLeftRight
        case "row-resize", "ns-resize", "n-resize", "s-resize": .resizeUpDown
        case "copy": .dragCopy
        case "alias": .dragLink
        case "context-menu": .contextualMenu
        default: .arrow
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        browser.mouse("mousePressed", at: pagePoint(event), button: "right", buttons: 2, clicks: 1, modifiers: MachineBrowser.modifiers(event.modifierFlags))
    }

    override func rightMouseUp(with event: NSEvent) {
        browser.mouse("mouseReleased", at: pagePoint(event), button: "right", buttons: 0, clicks: 1, modifiers: MachineBrowser.modifiers(event.modifierFlags))
        // Where the page has no menu of its own, this Mac's.
        let location = convert(event.locationInWindow, from: nil)
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(60))
            guard let self, let target = await browser.menuTarget() else { return }
            menu(for: target).popUp(positioning: nil, at: location, in: self)
        }
    }

    private func menu(for target: MachineBrowser.MenuTarget) -> NSMenu {
        let menu = NSMenu()
        func item(_ title: String, _ action: @escaping @MainActor () -> Void) {
            menu.addItem(ActionItem(title, handler: action))
        }
        func copy(_ text: String) {
            Clipboard.copy(text)
        }
        if let link = target.link {
            item("Open Link in New Tab") { [browser] in Task { _ = await browser.newPage(link.absoluteString) } }
            item("Copy Link") { copy(link.absoluteString) }
            menu.addItem(.separator())
        }
        if let image = target.image {
            item("Open Image in New Tab") { [browser] in Task { _ = await browser.newPage(image.absoluteString) } }
            item("Copy Image Address") { copy(image.absoluteString) }
            menu.addItem(.separator())
        }
        if !target.selection.isEmpty {
            item("Copy") { copy(target.selection) }
        }
        if target.editable {
            item("Paste") { [weak self] in self?.paste(nil) }
        }
        if !target.selection.isEmpty || target.editable { menu.addItem(.separator()) }
        item("Back") { [browser] in browser.goBack() }
        item("Forward") { [browser] in browser.goForward() }
        item("Reload") { [browser] in browser.reload() }
        return menu
    }

    override func otherMouseDown(with event: NSEvent) {
        browser.mouse("mousePressed", at: pagePoint(event), button: "middle", buttons: 4, clicks: 1, modifiers: MachineBrowser.modifiers(event.modifierFlags))
    }

    override func otherMouseUp(with event: NSEvent) {
        browser.mouse("mouseReleased", at: pagePoint(event), button: "middle", buttons: 0, clicks: 1, modifiers: MachineBrowser.modifiers(event.modifierFlags))
    }

    override func scrollWheel(with event: NSEvent) {
        var dx = -event.scrollingDeltaX
        var dy = -event.scrollingDeltaY
        if !event.hasPreciseScrollingDeltas {
            dx *= 40
            dy *= 40
        }
        guard dx != 0 || dy != 0 else { return }
        browser.wheel(at: pagePoint(event), dx: dx, dy: dy, modifiers: MachineBrowser.modifiers(event.modifierFlags))
        showAhead(dx: dx, dy: dy)
    }

    /// Moves the picture by what you scrolled, while the page's own picture is on its way: never
    /// above the page's top or left, and back where the page is if it doesn't follow (a page that
    /// can't scroll further).
    private func showAhead(dx: CGFloat, dy: CGFloat) {
        lastScroll = .now
        guard pageScrolls, let scroll = pageScroll else { return }
        if ahead == .zero { aheadSince = .now }
        ahead.x = max(ahead.x + dx, -scroll.x)
        ahead.y = max(ahead.y + dy, -scroll.y)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        placeImage()
        CATransaction.commit()
        settle?.cancel()
        settle = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self, !Task.isCancelled, self.ahead != .zero else { return }
            self.ahead = .zero
            self.aheadSince = nil
            CATransaction.begin()
            CATransaction.setAnimationDuration(0.18)
            self.placeImage()
            CATransaction.commit()
        }
    }

    // MARK: Keyboard

    /// Keys that aren't text, by the Mac's key code: their name, code and Windows key code.
    private static let keys: [UInt16: (key: String, code: String, keyCode: Int)] = [
        36: ("Enter", "Enter", 13), 76: ("Enter", "NumpadEnter", 13), 48: ("Tab", "Tab", 9),
        51: ("Backspace", "Backspace", 8), 117: ("Delete", "Delete", 46), 53: ("Escape", "Escape", 27),
        123: ("ArrowLeft", "ArrowLeft", 37), 124: ("ArrowRight", "ArrowRight", 39),
        125: ("ArrowDown", "ArrowDown", 40), 126: ("ArrowUp", "ArrowUp", 38),
        115: ("Home", "Home", 36), 119: ("End", "End", 35), 116: ("PageUp", "PageUp", 33), 121: ("PageDown", "PageDown", 34),
    ]

    /// ⌘+ and ⌘− zoom the page, before the menus see them.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.firstResponder === self else { return super.performKeyEquivalent(with: event) }
        let flags = event.modifierFlags.intersection([.command, .option, .control])
        guard flags == .command, let character = event.charactersIgnoringModifiers else { return super.performKeyEquivalent(with: event) }
        switch character {
        case "=", "+": browser.zoom(in: true)
        case "-", "_": browser.zoom(in: false)
        default: return super.performKeyEquivalent(with: event)
        }
        return true
    }

    /// A pinch zooms the page, a step at a time.
    private var pinch: CGFloat = 0

    override func magnify(with event: NSEvent) {
        if event.phase == .began { pinch = 0 }
        pinch += event.magnification
        if pinch > 0.18 {
            browser.zoom(in: true)
            pinch = 0
        } else if pinch < -0.18 {
            browser.zoom(in: false)
            pinch = 0
        }
    }

    override func keyDown(with event: NSEvent) {
        if let special = keyEvent(for: event) {
            browser.key(special.text == nil ? "rawKeyDown" : "keyDown", key: special.key, code: special.code, keyCode: special.keyCode, text: special.text, modifiers: special.modifiers)
            return
        }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags.contains(.command) || flags.contains(.control), let character = event.charactersIgnoringModifiers?.lowercased().first, character.isLetter || character.isNumber {
            // A shortcut the menus don't take: as Control is on Linux (⌘B bolds in an editor).
            let letter = String(character).uppercased()
            let code = character.isLetter ? "Key\(letter)" : "Digit\(letter)"
            let keyCode = Int(letter.unicodeScalars.first?.value ?? 0)
            var modifiers = MachineBrowser.modifiers(flags.subtracting(.command))
            modifiers |= 2
            browser.key("rawKeyDown", key: String(character), code: code, keyCode: keyCode, modifiers: modifiers)
            browser.key("keyUp", key: String(character), code: code, keyCode: keyCode, modifiers: modifiers)
            return
        }
        interpretKeyEvents([event])
    }

    override func keyUp(with event: NSEvent) {
        guard let special = keyEvent(for: event) else { return }
        browser.key("keyUp", key: special.key, code: special.code, keyCode: special.keyCode, modifiers: special.modifiers)
    }

    /// A key that isn't text, as Chrome on Linux knows it: the Mac's ⌘ and ⌥ moves become Linux's
    /// Home, End and Control ones.
    private func keyEvent(for event: NSEvent) -> (key: String, code: String, keyCode: Int, text: String?, modifiers: Int)? {
        guard var key = Self.keys[event.keyCode] else { return nil }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        var modifiers = MachineBrowser.modifiers(flags.subtracting([.command, .option, .function, .numericPad]))
        let horizontal = event.keyCode == 123 || event.keyCode == 124
        if flags.contains(.command) {
            switch event.keyCode {
            case 123: key = Self.keys[115]!
            case 124: key = Self.keys[119]!
            case 126: key = Self.keys[115]!; modifiers |= 2
            case 125: key = Self.keys[119]!; modifiers |= 2
            default: modifiers |= 2
            }
        } else if flags.contains(.option) {
            // Word by word.
            if horizontal || event.keyCode == 51 || event.keyCode == 117 { modifiers |= 2 } else { modifiers |= 1 }
        }
        let text: String? = key.key == "Enter" ? "\r" : nil
        return (key.key, key.code, key.keyCode, text, modifiers)
    }

    override func doCommand(by selector: Selector) {
        // Keys are sent as they are, above; nothing to beep about.
    }

    // Edit menu commands, for the page.

    @objc func copy(_ sender: Any?) {
        Task {
            guard let text = await browser.selectedText(), !text.isEmpty else { return }
            Clipboard.copy(text)
        }
    }

    @objc func cut(_ sender: Any?) {
        Task {
            if let text = await browser.selectedText(), !text.isEmpty {
                Clipboard.copy(text)
            }
            browser.key("rawKeyDown", key: "Delete", code: "Delete", keyCode: 46)
            browser.key("keyUp", key: "Delete", code: "Delete", keyCode: 46)
        }
    }

    @objc func paste(_ sender: Any?) {
        guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else { return }
        browser.insertText(text)
    }

    @objc override func selectAll(_ sender: Any?) {
        controlShortcut("a", command: "selectAll")
    }

    @objc func undo(_ sender: Any?) {
        controlShortcut("z", command: "undo")
    }

    @objc func redo(_ sender: Any?) {
        controlShortcut("z", command: "redo", shift: true)
    }

    private func controlShortcut(_ letter: String, command: String, shift: Bool = false) {
        let code = "Key\(letter.uppercased())"
        let keyCode = Int(letter.uppercased().unicodeScalars.first!.value)
        let modifiers = 2 | (shift ? 8 : 0)
        browser.key("rawKeyDown", key: letter, code: code, keyCode: keyCode, modifiers: modifiers, commands: [command])
        browser.key("keyUp", key: letter, code: code, keyCode: keyCode, modifiers: modifiers)
    }

    func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        switch item.action {
        case #selector(copy(_:)), #selector(cut(_:)), #selector(paste(_:)), #selector(selectAll(_:)), #selector(undo(_:)), #selector(redo(_:)):
            browser.state == .live
        default:
            false
        }
    }

    // MARK: Text input

    func insertText(_ string: Any, replacementRange: NSRange) {
        let text = (string as? String) ?? (string as? NSAttributedString)?.string ?? ""
        marked = nil
        guard !text.isEmpty else { return }
        browser.insertText(text)
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        let text = (string as? String) ?? (string as? NSAttributedString)?.string ?? ""
        marked = text.isEmpty ? nil : text
        browser.compose(text, selection: selectedRange)
    }

    func unmarkText() {
        if let marked { browser.insertText(marked) }
        marked = nil
    }

    func selectedRange() -> NSRange { NSRange(location: NSNotFound, length: 0) }

    func markedRange() -> NSRange {
        marked.map { NSRange(location: 0, length: ($0 as NSString).length) } ?? NSRange(location: NSNotFound, length: 0)
    }

    func hasMarkedText() -> Bool { marked != nil }

    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }

    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }

    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        // Where the page's caret is isn't known here: the input method's window goes near the
        // view's bottom left.
        guard let window else { return .zero }
        let rect = convert(CGRect(x: 20, y: 20, width: 1, height: 20), to: nil)
        return window.convertToScreen(rect)
    }

    func characterIndex(for point: NSPoint) -> Int { 0 }

    #if DEBUG
    // KUVO_DEMO_PAGE_INPUT: what you'd do on the page, steps separated by `;`, through the same
    // handlers as real events: `wait:<s>`, `click:<x>,<y>` (points from the page's top left),
    // `type:<text>`, `key:<code>` (a Mac key code), `scroll:<x>,<y>,<dy>`, `selectAll`, `copy`, `paste`,
    // `zoom:in`, `zoom:out`, `go:<address>`, `swipe:<x>,<y>,<dy>,<n>`.
    private static var demoStarted = false

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // Once, in the page view that's live (one shows dimmed while connecting).
        guard !Self.demoStarted, window != nil, browser.state == .live, let script = ProcessInfo.processInfo.environment["KUVO_DEMO_PAGE_INPUT"] else { return }
        Self.demoStarted = true
        Task { @MainActor in
            for step in script.split(separator: ";").map(String.init) {
                let parts = step.split(separator: ":", maxSplits: 1).map(String.init)
                let value = parts.count > 1 ? parts[1] : ""
                let numbers = value.split(separator: ",").compactMap { Double($0) }
                switch parts[0] {
                case "wait": try? await Task.sleep(for: .seconds(numbers.first ?? 1))
                case "click" where numbers.count == 2: demoMouse(CGPoint(x: numbers[0], y: numbers[1]))
                case "type": for character in value { demoKey(String(character), code: 0) }
                case "key": demoKey("", code: UInt16(numbers.first ?? 0))
                case "scroll" where numbers.count == 3: demoScroll(CGPoint(x: numbers[0], y: numbers[1]), dy: numbers[2])
                case "selectAll": selectAll(nil)
                case "copy": copy(nil)
                case "paste": paste(nil)
                case "zoom": browser.zoom(in: value == "in")
                case "go": browser.load(value)
                // swipe:<x>,<y>,<dy>,<n>: n scrolls of dy, 8 ms apart, as a trackpad sends them.
                case "swipe" where numbers.count == 4:
                    for _ in 0..<Int(numbers[3]) {
                        demoScroll(CGPoint(x: numbers[0], y: numbers[1]), dy: numbers[2])
                        try? await Task.sleep(for: .milliseconds(8))
                    }
                default: break
                }
                try? await Task.sleep(for: .milliseconds(150))
            }
        }
    }

    private func demoLocation(_ point: CGPoint) -> CGPoint {
        convert(CGPoint(x: point.x, y: bounds.height - point.y), to: nil)
    }

    private func demoMouse(_ point: CGPoint) {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            guard let event = NSEvent.mouseEvent(with: type, location: demoLocation(point), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window?.windowNumber ?? 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { continue }
            if type == .leftMouseDown { mouseDown(with: event) } else { mouseUp(with: event) }
        }
    }

    private func demoKey(_ characters: String, code: UInt16) {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window?.windowNumber ?? 0, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) else { continue }
            if type == .keyDown { keyDown(with: event) } else { keyUp(with: event) }
        }
    }

    private func demoScroll(_ point: CGPoint, dy: Double) {
        guard let cgEvent = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(dy), wheel2: 0, wheel3: 0) else { return }
        let location = window?.convertPoint(toScreen: demoLocation(point)) ?? .zero
        cgEvent.location = CGPoint(x: location.x, y: (NSScreen.screens.first?.frame.height ?? 0) - location.y)
        if let event = NSEvent(cgEvent: cgEvent) { scrollWheel(with: event) }
    }
    #endif
}
