import AppKit
import ClientDesign
import WebKit

/// A Mermaid diagram in a document (a Markdown file's preview): drawn by Mermaid, which the app
/// carries (`mermaid.min.js`), in a web view that reaches nothing (see `MermaidRenderer`, which
/// draws every diagram in one). A button swaps it for its code, and a diagram Mermaid can't read
/// shows as code, with what's wrong with it.
final class MermaidView: NSView {
    var cardIsFocused = true { didSet { code.cardIsFocused = cardIsFocused } }
    /// Called when the height it needs changes (the diagram was drawn, or failed).
    var onHeightChange: () -> Void = {}

    private let picture = NSImageView()
    private let code = ReplyCodeView()
    private let problem = NSTextField(wrappingLabelWithString: "")
    private let toggle = ReplyChipButton(title: "Code", widest: "Diagram")

    private var shown: (source: String, dark: Bool)?
    /// The look the code was last shown in.
    private var shownStyle: ReplyDocument.Style?
    private var error: String?
    private var showsCode = false
    /// How big the diagram is, as it was drawn.
    private var diagramSize: CGSize = .zero
    /// How wide the diagram was drawn: some diagrams (a Gantt chart) are drawn for the width they
    /// have, so they're drawn again, a moment after it changes.
    private var drawnWidth: CGFloat = 0
    private var redraw: DispatchWorkItem?
    private var drawing: Task<Void, Never>?

    private static let bar: CGFloat = 22
    private static let placeholder: CGFloat = 60

    override var isFlipped: Bool { true }

    init() {
        super.init(frame: .zero)
        picture.imageScaling = .scaleProportionallyDown
        picture.imageAlignment = .alignTop
        picture.setAccessibilityLabel("Diagram")
        problem.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        problem.textColor = .systemRed
        problem.isSelectable = true
        problem.isHidden = true
        toggle.target = self
        toggle.action = #selector(toggleCode)
        addSubview(picture)
        addSubview(code)
        addSubview(problem)
        addSubview(toggle)
        code.isHidden = true
        updateParts()
    }

    required init?(coder: NSCoder) { nil }

    deinit {
        drawing?.cancel()
    }

    func show(source: String, style: ReplyDocument.Style) {
        let sourceChanged = shown?.source != source
        let redraws = sourceChanged || shown?.dark != style.dark
        // Another text size or typeface: the code shows in it, and the diagram stays as it is.
        guard redraws || shownStyle != style else { return }
        shownStyle = style
        guard redraws else {
            code.show(code: source, language: "mermaid", marks: [], style: style)
            changed()
            return
        }
        shown = (source, style.dark)
        if sourceChanged {
            error = nil
            showsCode = false
            diagramSize = .zero
            picture.image = nil
        }
        code.show(code: source, language: "mermaid", marks: [], style: style)
        updateParts()
        draw()
    }

    private func draw() {
        redraw?.cancel()
        drawing?.cancel()
        // Not before it has its width (a diagram drawn into none comes out squeezed).
        guard let shown, bounds.width > 0 else { return }
        let width = bounds.width
        drawnWidth = width
        // Drawn already (scrolled back to): at its height at once, rather than coming in short.
        if let kept = MermaidRenderer.shared.known(shown.source, dark: shown.dark, width: width) { return apply(kept) }
        drawing = Task { [weak self] in
            let outcome = await MermaidRenderer.shared.render(shown.source, dark: shown.dark, width: width)
            // Still the diagram it was drawn for.
            guard let self, !Task.isCancelled, let outcome, self.shown?.source == shown.source, self.shown?.dark == shown.dark else { return }
            apply(outcome)
        }
    }

    private func apply(_ outcome: MermaidRenderer.Outcome) {
        switch outcome {
        case .drawn(let image):
            error = nil
            picture.image = image
            diagramSize = image.size
        case .failed(let message):
            error = message
        }
        changed()
    }

    @objc private func toggleCode() {
        showsCode.toggle()
        changed()
    }

    private func changed() {
        updateParts()
        needsLayout = true
        onHeightChange()
    }

    /// The code and what's wrong with it, when that's what's shown; the diagram otherwise.
    private var isShowingCode: Bool { showsCode || error != nil }

    private func updateParts() {
        code.isHidden = !isShowingCode
        picture.isHidden = isShowingCode
        problem.isHidden = error == nil
        problem.stringValue = error.map { "Mermaid can't draw this:\n\($0)" } ?? ""
        toggle.isHidden = error != nil
        toggle.show(title: showsCode ? "Diagram" : "Code")
        let label = showsCode ? "Show Diagram" : "Show Code"
        toggle.toolTip = label
        toggle.setAccessibilityLabel(label)
    }

    func height(for width: CGFloat) -> CGFloat {
        if isShowingCode {
            // What's wrong is at the top, in the button bar's place.
            return (error != nil ? 0 : Self.bar) + problemHeight(for: width) + code.height(for: width)
        }
        return Self.bar + (diagramSize.height > 0 ? pictureHeight(for: width) : Self.placeholder)
    }

    /// The diagram's height at `width`: as drawn, or smaller where it's narrower than that (until
    /// it's drawn again for it, at about the same height).
    private func pictureHeight(for width: CGFloat) -> CGFloat {
        ceil(diagramSize.width > width ? diagramSize.height * width / diagramSize.width : diagramSize.height)
    }

    private func problemHeight(for width: CGFloat) -> CGFloat {
        guard error != nil else { return 0 }
        problem.preferredMaxLayoutWidth = width
        return ceil(problem.sizeThatFits(NSSize(width: width, height: .greatestFiniteMagnitude)).height) + 8
    }

    override func layout() {
        super.layout()
        let width = bounds.width
        let size = toggle.fittingSize
        toggle.frame = CGRect(x: width - size.width, y: (Self.bar - size.height) / 2, width: size.width, height: size.height)
        if isShowingCode {
            let problemHeight = problemHeight(for: width)
            problem.frame = CGRect(x: 0, y: 0, width: width, height: problemHeight > 0 ? problemHeight - 8 : 0)
            let top = error != nil ? problemHeight : Self.bar
            code.frame = CGRect(x: 0, y: top, width: width, height: code.height(for: width))
        } else {
            picture.frame = CGRect(x: 0, y: Self.bar, width: width, height: max(0, bounds.height - Self.bar))
            if shown != nil, abs(width - drawnWidth) > 1 {
                redraw?.cancel()
                let work = DispatchWorkItem { [weak self] in self?.draw() }
                redraw = work
                DispatchQueue.main.asyncAfter(deadline: .now() + (drawnWidth == 0 ? 0 : 0.25), execute: work)
            }
        }
    }
}

/// Draws every diagram, one at a time, in a single web view (Mermaid needs a page; one per diagram
/// is a process each), and hands back each as a picture. What it has drawn is kept, for the width
/// and appearance it was drawn for.
@MainActor
final class MermaidRenderer: NSObject, WKNavigationDelegate {
    static let shared = MermaidRenderer()

    enum Outcome {
        case drawn(NSImage)
        case failed(String)
    }

    private final class Job: @unchecked Sendable {
        let source: String
        let dark: Bool
        let width: CGFloat
        var isCancelled = false
        var continuation: CheckedContinuation<Outcome?, Never>?

        init(source: String, dark: Bool, width: CGFloat) {
            self.source = source
            self.dark = dark
            self.width = width
        }
    }

    private final class Kept {
        let outcome: Outcome
        init(_ outcome: Outcome) { self.outcome = outcome }
    }

    private var web: WKWebView
    private var isLoaded = false
    private var loadFailed = false
    private var loadWaiters: [() -> Void] = []
    private var jobs: [Job] = []
    private var isWorking = false
    private let kept = NSCache<NSString, Kept>()

    private override init() {
        web = Self.makeWeb()
        super.init()
        kept.countLimit = 60
        // Tall, wide pictures add up: about 64 MB of them at most.
        kept.totalCostLimit = 64 << 20
        web.navigationDelegate = self
        load()
    }

    private static func makeWeb() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 600, height: 400), configuration: configuration)
        web.setValue(false, forKey: "drawsBackground")
        return web
    }

    /// A new web view for the next diagrams: one whose page is stuck (a diagram Mermaid never
    /// finishes keeps its script busy) can't even load its page again.
    private func replaceWeb() {
        web.navigationDelegate = nil
        web.stopLoading()
        // Its page's process ends with it: a stuck script keeps it running after the view is let
        // go, and WebKit has no public way to end it (checked for, in case it goes).
        let end = NSSelectorFromString("_killWebContentProcessAndResetState")
        if web.responds(to: end) { _ = web.perform(end) }
        web = Self.makeWeb()
        web.navigationDelegate = self
        load()
    }

    private func load() {
        isLoaded = false
        guard let page = Bundle.main.url(forResource: "mermaid-page", withExtension: "html") else {
            loadFailed = true
            return
        }
        loadFailed = false
        web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }

    /// What's kept of `source` drawn `width` points wide: drawn, or what Mermaid said was wrong.
    func known(_ source: String, dark: Bool, width: CGFloat) -> Outcome? {
        (kept.object(forKey: Self.key(source, dark: dark, width: width)) ?? kept.object(forKey: Self.slowKey(source))
            ?? kept.object(forKey: Self.failedKey(source)))?.outcome
    }

    private static func key(_ source: String, dark: Bool, width: CGFloat) -> NSString {
        ("\(dark ? 1 : 0)|\(Int(width.rounded()))|" + source) as NSString
    }

    /// `source` drawn `width` points wide, or why it can't be; nil if the call was canceled first.
    func render(_ source: String, dark: Bool, width: CGFloat) async -> Outcome? {
        let width = width.rounded()
        let key = Self.key(source, dark: dark, width: width)
        if let hit = known(source, dark: dark, width: width) { return hit }
        let job = Job(source: source, dark: dark, width: width)
        let outcome: Outcome? = await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                job.continuation = continuation
                jobs.append(job)
                work()
            }
        } onCancel: {
            Task { @MainActor in job.isCancelled = true }
        }
        if let outcome, case .drawn(let image) = outcome { kept.setObject(Kept(outcome), forKey: key, cost: Self.bytes(of: image)) }
        return outcome
    }

    private func work() {
        guard !isWorking else { return }
        isWorking = true
        Task {
            while !jobs.isEmpty {
                let job = jobs.removeFirst()
                let outcome = job.isCancelled ? nil : await draw(job)
                job.continuation?.resume(returning: outcome)
                job.continuation = nil
            }
            isWorking = false
        }
    }

    private func draw(_ job: Job) async -> Outcome {
        // One Mermaid never finished isn't tried again, at any width (each try costs its wait),
        // queued before it ran out or not.
        if let slow = kept.object(forKey: Self.slowKey(job.source)) { return slow.outcome }
        if !isLoaded, !loadFailed {
            // As long as a diagram may take, then the page is taken as stuck.
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let once = Once()
                let resume = { if once.claim() { continuation.resume() } }
                loadWaiters.append(resume)
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.patience) { resume() }
            }
            if !isLoaded, !loadFailed { replaceWeb() }
        }
        guard isLoaded else { return .failed("Mermaid didn't load.") }
        web.frame = NSRect(x: 0, y: 0, width: job.width, height: 400)
        // Given up on after a while: a diagram Mermaid never finishes would hold up every other
        // one. The next ones get a new web view, as its page may not even load again.
        guard let answer = await answer(to: job) else {
            kept.setObject(Kept(.failed(Self.tooLong)), forKey: Self.slowKey(job.source), cost: 1)
            replaceWeb()
            return .failed(Self.tooLong)
        }
        guard let result = answer else { return .failed("The page didn't answer.") }
        if let message = result.error {
            // Mermaid can't read it, at any width: not tried again.
            kept.setObject(Kept(.failed(message)), forKey: Self.failedKey(job.source), cost: 1)
            return .failed(message)
        }
        guard let height = result.height.map({ CGFloat($0) }), height > 0 else { return .failed("It has nothing to show.") }
        web.frame.size.height = height
        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(x: 0, y: 0, width: job.width, height: height)
        configuration.snapshotWidth = NSNumber(value: Double(job.width))
        configuration.afterScreenUpdates = true
        guard let image = try? await web.takeSnapshot(configuration: configuration) else { return .failed("It couldn't be drawn.") }
        return .drawn(image)
    }

    /// What the page said of `job`, or nil if it didn't answer in time.
    private func answer(to job: Job) async -> Answer?? {
        let arguments: [String: Any] = ["code": job.source, "dark": job.dark]
        let once = Once()
        return await withCheckedContinuation { (continuation: CheckedContinuation<Answer??, Never>) in
            // With a completion handler, not awaited: the call doesn't keep the web view, so one
            // let go after the wait runs out goes (`replaceWeb` ends its page's process; the
            // late error that brings is ignored).
            web.callAsyncJavaScript("return await draw(code, dark)", arguments: arguments, in: nil, in: .page) { result in
                let answer = (try? result.get()) as? [String: Any]
                if once.claim() { continuation.resume(returning: .some(answer.map { Answer(error: $0["error"] as? String, height: $0["height"] as? Double) })) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.patience) {
                if once.claim() { continuation.resume(returning: nil) }
            }
        }
    }

    private struct Answer: Sendable {
        var error: String?
        var height: Double?
    }

    /// The first of two ways to finish (the answer, or the wait running out) to get there.
    private final class Once {
        private var done = false
        func claim() -> Bool {
            guard !done else { return false }
            done = true
            return true
        }
    }

    private static let patience: TimeInterval = 10
    private static let tooLong = "It took too long to draw."
    private static func slowKey(_ source: String) -> NSString { ("slow|" + source) as NSString }
    private static func failedKey(_ source: String) -> NSString { ("failed|" + source) as NSString }

    /// What a picture takes in memory: its pixels, four bytes each.
    private static func bytes(of image: NSImage) -> Int {
        if let pixels = image.representations.first, pixels.pixelsWide > 0 { return pixels.pixelsWide * pixels.pixelsHigh * 4 }
        return Int(image.size.width * image.size.height * 16)
    }

    // MARK: WKNavigationDelegate

    /// Its own page only: a diagram that tried to go elsewhere (a link, a script) goes nowhere, so
    /// no diagram's code could be sent on to a page on the web.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        let page = Bundle.main.url(forResource: "mermaid-page", withExtension: "html")?.resolvingSymlinksInPath()
        let asked = action.request.url.flatMap { $0.isFileURL ? $0.resolvingSymlinksInPath() : nil }
        decisionHandler(asked != nil && asked == page ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoaded = true
        resumeWaiters()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadFailed = true
        resumeWaiters()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadFailed = true
        resumeWaiters()
    }

    /// Its web content process ended (memory pressure, say): the page is loaded again for the next.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        load()
    }

    private func resumeWaiters() {
        let waiting = loadWaiters
        loadWaiters = []
        for waiter in waiting { waiter() }
    }
}
