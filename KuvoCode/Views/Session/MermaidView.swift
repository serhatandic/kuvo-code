import AppKit
import WebKit

/// A document block owns its presentation; the renderer shares the expensive WebKit page.
final class MermaidView: NSView {
    var onResize: () -> Void = {}
    var cardIsFocused = true { didSet { sourceView.cardIsFocused = cardIsFocused } }

    private let sourceView = ReplyCodeView()
    private let imageView = NSImageView()
    private let messageView = NSTextField(wrappingLabelWithString: "")
    private let modeButton = ReplyChipButton(title: "Code", widest: "Diagram")
    private var content: String = ""
    private var appearance: ReplyDocument.Style?
    private var failure: String?
    private var sourceSelected = false
    private var requestedWidth: CGFloat = -1
    private var revision = UUID()
    private var renderTask: Task<Void, Never>?
    private var resizeWork: DispatchWorkItem?

    override var isFlipped: Bool { true }
    private var displaysSource: Bool { sourceSelected || failure != nil }

    init() {
        super.init(frame: .zero)
        imageView.imageAlignment = .alignTop
        imageView.imageScaling = .scaleProportionallyDown
        imageView.setAccessibilityLabel("Diagram")
        messageView.isSelectable = true
        messageView.textColor = .systemRed
        messageView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        modeButton.target = self
        modeButton.action = #selector(changeMode)
        [imageView, sourceView, messageView, modeButton].forEach(addSubview)
        refreshVisibility()
    }

    required init?(coder: NSCoder) { return nil }

    deinit { renderTask?.cancel(); resizeWork?.cancel() }

    func present(_ source: String, style: ReplyDocument.Style) {
        guard content != source || appearance != style else { return }
        let needsImage = content != source || appearance?.dark != style.dark
        if content != source {
            sourceSelected = false
            failure = nil
            imageView.image = nil
        }
        content = source
        appearance = style
        sourceView.show(code: source, language: "mermaid", marks: [], style: style)
        if needsImage {
            revision = UUID()
            requestedWidth = -1
            renderTask?.cancel()
        }
        refreshVisibility()
        invalidateSize()
    }

    func measure(at width: CGFloat) -> CGFloat {
        if let appearance, abs(requestedWidth - width) > 1,
           let saved = MermaidRenderer.shared.known(content, dark: appearance.dark, width: width) {
            requestedWidth = width
            renderTask?.cancel()
            switch saved {
            case .drawn(let image): imageView.image = image; failure = nil
            case .failed(let explanation): failure = explanation
            }
            refreshVisibility()
        }
        if displaysSource {
            return sourceView.height(for: width) + (failure == nil ? 22 : messageHeight(at: width))
        }
        guard let image = imageView.image else { return 82 }
        let scale = min(1, width / max(1, image.size.width))
        return 22 + ceil(image.size.height * scale)
    }

    private func messageHeight(at width: CGFloat) -> CGFloat {
        messageView.preferredMaxLayoutWidth = width
        return ceil(messageView.sizeThatFits(NSSize(width: width, height: .greatestFiniteMagnitude)).height) + 8
    }

    private func refreshVisibility() {
        sourceView.isHidden = !displaysSource
        imageView.isHidden = displaysSource
        messageView.isHidden = failure == nil
        messageView.stringValue = failure.map { "Mermaid can't draw this:\n" + $0 } ?? ""
        modeButton.isHidden = failure != nil
        modeButton.show(title: sourceSelected ? "Diagram" : "Code")
        modeButton.toolTip = sourceSelected ? "Show Diagram" : "Show Code"
        modeButton.setAccessibilityLabel(modeButton.toolTip)
    }

    private func invalidateSize() {
        needsLayout = true
        invalidateIntrinsicContentSize()
        onResize()
    }

    @objc private func changeMode() {
        sourceSelected.toggle()
        refreshVisibility()
        invalidateSize()
    }

    override func layout() {
        super.layout()
        let available = bounds.width
        let buttonSize = modeButton.fittingSize
        modeButton.frame = NSRect(x: available - buttonSize.width, y: (22 - buttonSize.height) / 2, width: buttonSize.width, height: buttonSize.height)
        let sourceTop = failure == nil ? 22 : messageHeight(at: available)
        messageView.frame = NSRect(x: 0, y: 0, width: available, height: max(0, sourceTop - 8))
        sourceView.frame = NSRect(x: 0, y: sourceTop, width: available, height: sourceView.height(for: available))
        imageView.frame = NSRect(x: 0, y: 22, width: available, height: max(0, bounds.height - 22))
        guard !displaysSource, available > 0, abs(requestedWidth - available) > 1, appearance != nil else { return }
        resizeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.requestImage() }
        resizeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (requestedWidth < 0 ? 0 : 0.25), execute: work)
    }

    private func requestImage() {
        guard let appearance, bounds.width > 0 else { return }
        requestedWidth = bounds.width
        renderTask?.cancel()
        let source = content, width = requestedWidth, token = revision
        renderTask = Task { [weak self] in
            let result = await MermaidRenderer.shared.render(source, dark: appearance.dark, width: width)
            guard let self, !Task.isCancelled, token == revision, let result else { return }
            switch result {
            case .drawn(let image): imageView.image = image; failure = nil
            case .failed(let explanation): failure = explanation
            }
            refreshVisibility()
            invalidateSize()
        }
    }
}

/// Serializes access to Mermaid's global configuration and keeps completed snapshots bounded.
@MainActor
final class MermaidRenderer: NSObject, WKNavigationDelegate {
    static let shared = MermaidRenderer()
    enum Outcome { case drawn(NSImage), failed(String) }

    private final class Cached: NSObject {
        let value: Outcome
        init(_ value: Outcome) { self.value = value }
    }
    private struct Request {
        let id: UUID
        let source: String
        let dark: Bool
        let width: CGFloat
        let finish: CheckedContinuation<Outcome?, Never>
    }
    /// All completion paths (WebKit, timeout, process termination) pass through this gate.
    private final class Completion<Value> {
        private var continuation: CheckedContinuation<Value, Never>?
        init(_ continuation: CheckedContinuation<Value, Never>) { self.continuation = continuation }
        func finish(_ value: Value) {
            let pending = continuation
            continuation = nil
            pending?.resume(returning: value)
        }
    }

    private var page: WKWebView?
    private var ready = false
    private var navigation: Completion<Bool>?
    private var pending: [Request] = []
    private var running = false
    private let snapshots = NSCache<NSString, Cached>()
    private let failures = NSCache<NSString, Cached>()

    private override init() {
        super.init()
        snapshots.countLimit = 60
        snapshots.totalCostLimit = 64 * 1024 * 1024
        failures.countLimit = 60
    }

    private func cacheKey(_ source: String, _ dark: Bool, _ width: CGFloat) -> NSString {
        return "\(Int(width.rounded())):\(dark):\(source)" as NSString
    }

    func known(_ source: String, dark: Bool, width: CGFloat) -> Outcome? {
        return failures.object(forKey: source as NSString)?.value ?? snapshots.object(forKey: cacheKey(source, dark, width))?.value
    }

    func render(_ source: String, dark: Bool, width: CGFloat) async -> Outcome? {
        guard !Task.isCancelled else { return nil }
        if let cached = known(source, dark: dark, width: width) { return cached }
        guard width.isFinite, width > 0 else { return .failed("It has nothing to show.") }
        let id = UUID()
        let result = await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                pending.append(Request(id: id, source: source, dark: dark, width: width.rounded(), finish: continuation))
                if !running {
                    running = true
                    Task { await drain() }
                }
            }
        } onCancel: {
            Task { @MainActor in
                guard let index = self.pending.firstIndex(where: { $0.id == id }) else { return }
                self.pending.remove(at: index).finish.resume(returning: nil)
            }
        }
        return Task.isCancelled ? nil : result
    }

    private func drain() async {
        while !pending.isEmpty {
            let next = pending.removeFirst()
            if let cached = known(next.source, dark: next.dark, width: next.width) {
                next.finish.resume(returning: cached)
                continue
            }
            let outcome = await snapshot(next)
            if case .drawn(let image) = outcome {
                let pixels = image.representations.first
                let cost = (pixels?.pixelsWide ?? Int(image.size.width * 2)) * (pixels?.pixelsHigh ?? Int(image.size.height * 2)) * 4
                snapshots.setObject(Cached(outcome), forKey: cacheKey(next.source, next.dark, next.width), cost: cost)
            }
            next.finish.resume(returning: outcome)
        }
        running = false
    }

    private func discardPage() {
        ready = false
        navigation?.finish(false)
        navigation = nil
        page?.navigationDelegate = nil
        page?.stopLoading()
        // WebKit has no public API to interrupt a script that stopped yielding.
        // Release its process as well as its view before the next queued diagram.
        let reset = NSSelectorFromString("_killWebContentProcessAndResetState")
        if let page, page.responds(to: reset) { _ = page.perform(reset) }
        page = nil
    }

    private func loadPage() async -> Bool {
        if ready { return true }
        guard let url = Bundle.main.url(forResource: "mermaid-page", withExtension: "html") else { return false }
        let settings = WKWebViewConfiguration()
        settings.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 600, height: 400), configuration: settings)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = self
        page = view
        let loaded = await withCheckedContinuation { continuation in
            let completion = Completion(continuation)
            navigation = completion
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { completion.finish(false) }
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        navigation = nil
        if !loaded { discardPage() }
        return loaded
    }

    private func snapshot(_ request: Request) async -> Outcome {
        guard await loadPage(), let page else { return .failed("Mermaid didn't load.") }
        page.frame.size = NSSize(width: request.width, height: 400)
        let response: [String: Any]? = await withCheckedContinuation { continuation in
            let completion = Completion(continuation)
            page.callAsyncJavaScript("return await renderDiagram(source, isDark)", arguments: ["source": request.source, "isDark": request.dark], in: nil, in: .page) { result in
                completion.finish((try? result.get()) as? [String: Any])
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { completion.finish(nil) }
        }
        guard let response else {
            let failure = Outcome.failed("It took too long to draw.")
            failures.setObject(Cached(failure), forKey: request.source as NSString)
            discardPage()
            return failure
        }
        if let error = response["error"] as? String {
            let failure = Outcome.failed(error)
            failures.setObject(Cached(failure), forKey: request.source as NSString)
            return failure
        }
        guard let height = response["height"] as? Double, height.isFinite, height > 0 else { return .failed("It has nothing to show.") }
        page.frame.size.height = height
        let options = WKSnapshotConfiguration()
        options.rect = NSRect(x: 0, y: 0, width: request.width, height: height)
        options.snapshotWidth = NSNumber(value: Double(request.width))
        options.afterScreenUpdates = true
        let image: NSImage? = await withCheckedContinuation { continuation in
            let completion = Completion(continuation)
            page.takeSnapshot(with: options) { image, _ in completion.finish(image) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { completion.finish(nil) }
        }
        return image.map(Outcome.drawn) ?? .failed("It couldn't be drawn.")
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        let allowed = Bundle.main.url(forResource: "mermaid-page", withExtension: "html")?.resolvingSymlinksInPath()
        let destination = action.request.url?.resolvingSymlinksInPath()
        decisionHandler(destination?.isFileURL == true && destination == allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        self.navigation?.finish(true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { self.navigation?.finish(false) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { self.navigation?.finish(false) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { discardPage() }
}
