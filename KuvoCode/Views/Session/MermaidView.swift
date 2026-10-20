import AppKit
import WebKit

/// A Mermaid diagram in a document (a Markdown file's preview): drawn by Mermaid, which the app
/// carries (`mermaid.min.js`), in a web view that reaches nothing. A button swaps it for its code,
/// and a diagram Mermaid can't read shows as code, with what's wrong with it.
final class MermaidView: NSView, WKScriptMessageHandler {
    var cardIsFocused = true { didSet { code.cardIsFocused = cardIsFocused } }
    /// Called when the height it needs changes (the diagram was drawn, or failed).
    var onHeightChange: () -> Void = {}

    private let web: MermaidWebView
    private let code = ReplyCodeView()
    private let problem = NSTextField(wrappingLabelWithString: "")
    private let toggle = NSButton(title: "", target: nil, action: nil)

    private var shown: (source: String, dark: Bool)?
    private var isReady = false
    private var error: String?
    private var showsCode = false
    /// How tall the diagram is, as the page last said.
    private var diagramHeight: CGFloat = 0
    /// How wide the page was when the diagram was drawn: some diagrams (a Gantt chart) are drawn
    /// for the width they have, so they're drawn again, a moment after it changes.
    private var drawnWidth: CGFloat = 0
    private var redraw: DispatchWorkItem?

    private static let bar: CGFloat = 22
    private static let placeholder: CGFloat = 60

    override var isFlipped: Bool { true }

    init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        web = MermaidWebView(frame: .zero, configuration: configuration)
        super.init(frame: .zero)
        configuration.userContentController.add(WeakHandler(self), name: "mermaid")
        web.setValue(false, forKey: "drawsBackground")
        web.allowsMagnification = false
        problem.font = .systemFont(ofSize: 12)
        problem.textColor = .systemRed
        problem.isHidden = true
        toggle.isBordered = false
        toggle.font = .systemFont(ofSize: 11, weight: .medium)
        toggle.contentTintColor = .tertiaryLabelColor
        toggle.target = self
        toggle.action = #selector(toggleCode)
        addSubview(web)
        addSubview(code)
        addSubview(problem)
        addSubview(toggle)
        code.isHidden = true
        if let page = Bundle.main.url(forResource: "mermaid-page", withExtension: "html") {
            web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        }
        updateParts()
    }

    required init?(coder: NSCoder) { nil }

    func show(source: String, style: ReplyDocument.Style) {
        guard shown?.source != source || shown?.dark != style.dark else { return }
        let sourceChanged = shown?.source != source
        shown = (source, style.dark)
        if sourceChanged {
            error = nil
            showsCode = false
            diagramHeight = 0
        }
        code.show(code: source, language: "mermaid", marks: [], style: style)
        updateParts()
        draw()
    }

    private func draw() {
        redraw?.cancel()
        // Not before it has its width (a diagram drawn into none comes out squeezed).
        guard isReady, let shown, web.frame.width > 0 else { return }
        drawnWidth = web.frame.width
        web.callAsyncJavaScript("await draw(code, dark)", arguments: ["code": shown.source, "dark": shown.dark], in: nil, in: .page, completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if body["ready"] != nil {
            isReady = true
            draw()
        } else if let message = body["error"] as? String {
            error = message
            changed()
        } else if body["drawn"] != nil {
            error = nil
            changed()
        } else if let height = body["height"] as? Double {
            let value = CGFloat(height)
            guard value != diagramHeight else { return }
            diagramHeight = value
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
        web.isHidden = isShowingCode
        problem.isHidden = error == nil
        problem.stringValue = error.map { "Mermaid can't draw this: \($0)" } ?? ""
        toggle.isHidden = error != nil
        toggle.title = showsCode ? "Diagram" : "Code"
        toggle.sizeToFit()
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
        toggle.frame = CGRect(x: width - toggle.frame.width, y: (Self.bar - toggle.frame.height) / 2, width: toggle.frame.width, height: toggle.frame.height)
        if isShowingCode {
            let problemHeight = problemHeight(for: width)
            problem.frame = CGRect(x: 0, y: 0, width: width, height: problemHeight > 0 ? problemHeight - 8 : 0)
            let top = error != nil ? problemHeight : Self.bar
            code.frame = CGRect(x: 0, y: top, width: width, height: code.height(for: width))
        } else {
            web.frame = CGRect(x: 0, y: Self.bar, width: width, height: max(0, bounds.height - Self.bar))
            if isReady, shown != nil, abs(width - drawnWidth) > 1 {
                redraw?.cancel()
                let work = DispatchWorkItem { [weak self] in self?.draw() }
                redraw = work
                DispatchQueue.main.asyncAfter(deadline: .now() + (drawnWidth == 0 ? 0 : 0.25), execute: work)
            }
        }
    }
}

/// Scrolling over a diagram goes to the document around it.
private final class MermaidWebView: WKWebView {
    override func scrollWheel(with event: NSEvent) {
        nextResponder?.scrollWheel(with: event)
    }
}

/// Passes the page's messages on without keeping its owner alive (the web view keeps its handlers).
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
