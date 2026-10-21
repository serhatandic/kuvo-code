import AppKit
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
    private let toggle = ReplyChipButton(title: "Code", symbol: "curlybraces", widest: "Diagram")

    private var shown: (source: String, dark: Bool)?
    private var error: String?
    private var showsCode = false
    /// How tall the diagram is, as it was drawn.
    private var diagramHeight: CGFloat = 0
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
        guard shown?.source != source || shown?.dark != style.dark else { return }
        let sourceChanged = shown?.source != source
        shown = (source, style.dark)
        if sourceChanged {
            error = nil
            showsCode = false
            diagramHeight = 0
            picture.image = nil
        }
        code.show(code: source, language: "mermaid", marks: [], style: style)
        updateParts()
        draw()
    }

    private func draw() {
        redraw?.cancel()
        // Not before it has its width (a diagram drawn into none comes out squeezed).
        guard let shown, bounds.width > 0 else { return }
        let width = bounds.width
        drawnWidth = width
        drawing?.cancel()
        drawing = Task { [weak self] in
            let outcome = await MermaidRenderer.shared.render(shown.source, dark: shown.dark, width: width)
            guard let self, !Task.isCancelled, let outcome else { return }
            switch outcome {
            case .drawn(let image):
                error = nil
                picture.image = image
                diagramHeight = image.size.height
            case .failed(let message):
                error = message
            }
            changed()
        }
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
        toggle.show(title: showsCode ? "Diagram" : "Code", symbol: showsCode ? "flowchart" : "curlybraces")
        let label = showsCode ? "Show Diagram" : "Show Code"
        toggle.toolTip = label
        toggle.setAccessibilityLabel(label)
    }

    func height(for width: CGFloat) -> CGFloat {
        if isShowingCode {
            return Self.bar + problemHeight(for: width) + code.height(for: width)
        }
        return Self.bar + (diagramHeight > 0 ? diagramHeight : Self.placeholder)
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

    private let web: WKWebView
    private var isLoaded = false
    private var loadFailed = false
    private var loadWaiters: [CheckedContinuation<Void, Never>] = []
    private var jobs: [Job] = []
    private var isWorking = false
    private let kept = NSCache<NSString, Kept>()

    private override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 600, height: 400), configuration: configuration)
        super.init()
        kept.countLimit = 60
        web.setValue(false, forKey: "drawsBackground")
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

    /// `source` drawn `width` points wide, or why it can't be; nil if the call was canceled first.
    func render(_ source: String, dark: Bool, width: CGFloat) async -> Outcome? {
        let width = width.rounded()
        let key = "\(dark ? 1 : 0)|\(Int(width))|" + source
        if let hit = kept.object(forKey: key as NSString) { return hit.outcome }
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
        if let outcome, case .drawn = outcome { kept.setObject(Kept(outcome), forKey: key as NSString) }
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
        if !isLoaded, !loadFailed {
            await withCheckedContinuation { loadWaiters.append($0) }
        }
        guard isLoaded else { return .failed("Mermaid didn't load.") }
        web.frame = NSRect(x: 0, y: 0, width: job.width, height: 400)
        let arguments: [String: Any] = ["code": job.source, "dark": job.dark]
        let answer = try? await web.callAsyncJavaScript("return await draw(code, dark)", arguments: arguments, in: nil, contentWorld: .page)
        guard let result = answer as? [String: Any] else { return .failed("The page didn't answer.") }
        if let message = result["error"] as? String { return .failed(message) }
        guard let height = (result["height"] as? Double).map({ CGFloat($0) }), height > 0 else { return .failed("It has nothing to show.") }
        web.frame.size.height = height
        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(x: 0, y: 0, width: job.width, height: height)
        configuration.snapshotWidth = NSNumber(value: Double(job.width))
        configuration.afterScreenUpdates = true
        guard let image = try? await web.takeSnapshot(configuration: configuration) else { return .failed("It couldn't be drawn.") }
        return .drawn(image)
    }

    // MARK: WKNavigationDelegate

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
        for waiter in waiting { waiter.resume() }
    }
}
