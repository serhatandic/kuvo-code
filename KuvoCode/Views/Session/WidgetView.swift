import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI
import WebKit

/// What an agent made for you with show_widget: a page of its own (a chart, a diagram, a small
/// app, a game, choices to click), live in the conversation, in place of the call. Its script can
/// answer the agent for you, with `kuvo.send(text)`, when you click something in it.
struct WidgetCard: View {
    /// A call of show_widget, whichever engine's.
    static func isWidget(_ call: Message.ToolCall) -> Bool {
        call.name == "kuvo-browser_" + BrowserTools.showWidget
    }

    /// Its title in arguments still being written (partial JSON), once it's all there.
    static func title(inPartial input: String) -> String? {
        guard let match = input.firstMatch(of: /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/) else { return nil }
        let raw = String(match.1)
        return (try? JSONDecoder().decode(String.self, from: Data("\"\(raw)\"".utf8))) ?? raw
    }

    let call: Message.ToolCall
    /// Sends what the page wrote back, as your message.
    let send: (String) -> Void
    @State private var height: CGFloat

    /// Each page's height when last drawn, by call. The conversation makes a row again when you
    /// scroll back to it, and a page coming back short, then growing, would push everything
    /// under it down as you scroll.
    private static var heights: [String: CGFloat] = [:]

    init(call: Message.ToolCall, send: @escaping (String) -> Void) {
        self.call = call
        self.send = send
        _height = State(initialValue: Self.heights[call.id] ?? 0)
    }
    @State private var isHovering = false
    /// The pointer's on its pill, which is outside the page.
    @State private var isOnPill = false
    /// Its page didn't load, or stopped: one line in its place, and a way to try again.
    @State private var failed = false
    @State private var attempt = 0
    @Environment(\.colorScheme) private var scheme
    @Environment(\.cardIsFocused) private var cardIsFocused
    @Environment(\.showWidgetLarge) private var showLarge

    /// Over its conversation's card, as the panel grows over the window.
    private func openLarge(html: String, title: String?) {
        showLarge?(LargeWidget(id: call.id, html: html, title: title, send: answer(from: title)))
    }

    /// What the page writes back, sent with which widget it came from (`WidgetAnswer`).
    private func answer(from title: String?) -> (String) -> Void {
        { [send] text in send(WidgetAnswer.message(text, from: title)) }
    }

    private static let shape = RoundedRectangle(cornerRadius: 12)
    #if DEBUG
    private static var openedLarge = false
    #endif

    var body: some View {
        // One card while it's written and once it's done, so the page carries on from its draft.
        if case .failed = call.state {
            ToolCallView(call: call, directory: "")
        } else if let content {
            card(html: content.html, title: content.title, draft: content.draft)
        } else if case .streaming(let input) = call.state {
            HStack(spacing: 8) {
                Spinner(size: 12)
                // Its name once the agent has written it; till then, words of its own.
                if let title = Self.title(inPartial: input) {
                    ShimmerText(text: "Making “\(title)”…")
                } else {
                    MakingWords()
                }
                if let size = Self.written(input.utf8.count) {
                    Text(size)
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                }
            }
            .font(.callout)
            .frame(maxWidth: .infinity, minHeight: 64)
            .background(Surface.well(scheme), in: Self.shape)
        }
    }

    /// How much is written, once there's something to count ("12 KB"): nothing for the first bytes.
    static func written(_ bytes: Int) -> String? {
        bytes < 1024 ? nil : ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// What there is to show: while it's written, what's come so far (once there's something to
    /// see), with how much has come; then the page.
    private var content: (html: String, title: String?, draft: Int?)? {
        switch call.state {
        case .streaming(let input):
            guard let html = Self.html(inPartial: input), html.count > 120 else { return nil }
            return (html, Self.title(inPartial: input), input.utf8.count)
        case .running(let input, _), .completed(let input, _, _):
            guard let html = input["html"]?.string, !html.isEmpty else { return nil }
            return (html, input["title"]?.string, nil)
        case .failed:
            return nil
        }
    }

    /// The page's HTML in arguments still being written (partial JSON): what's there so far.
    static func html(inPartial input: String) -> String? {
        guard let start = input.range(of: #""html"\s*:\s*""#, options: .regularExpression) else { return nil }
        var html = ""
        var characters = input[start.upperBound...].makeIterator()
        while let character = characters.next() {
            switch character {
            case "\"": return html
            case "\\":
                guard let escaped = characters.next() else { return html }
                switch escaped {
                case "n": html.append("\n")
                case "t": html.append("\t")
                case "r": html.append("\r")
                case "b", "f": break
                case "u":
                    var hex = ""
                    for _ in 0..<4 { if let digit = characters.next() { hex.append(digit) } }
                    if hex.count == 4, let value = UInt32(hex, radix: 16), let scalar = Unicode.Scalar(value) { html.unicodeScalars.append(scalar) }
                default: html.append(escaped)
                }
            default: html.append(character)
            }
        }
        return html
    }

    /// The page itself, part of the reply: no frame, no caption. Open Larger and Copy come in a
    /// small pill at its corner while the pointer's over it; while it's written, the pill shows
    /// that instead. Its name is the larger view's title, and what VoiceOver calls it.
    /// `draft`: still being written, this many bytes so far.
    private func card(html: String, title: String?, draft: Int? = nil) -> some View {
        page(html: html, title: title, draft: draft)
            // Something new to show gets a try of its own.
            .onChange(of: html) { failed = false }
    }

    @ViewBuilder private func page(html: String, title: String?, draft: Int?) -> some View {
        if failed {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle")
                Text("“\(WidgetAnswer.name(title))” couldn't show.")
                Button("Try Again") {
                    failed = false
                    attempt += 1
                }
                .buttonStyle(TextButtonStyle())
            }
            .font(.callout)
            .foregroundStyle(.secondary)
        } else {
            WidgetPage(html: html, accent: NSColor.controlAccentColor, height: $height, isDraft: draft != nil,
                       send: answer(from: title), failed: { failed = true })
                .id(attempt)
                .frame(height: max(height, 60))
                .onChange(of: height) { if height > 0 { Self.heights[call.id] = height } }
                .clipShape(Self.shape)
                .overlay(alignment: .topTrailing) { corner(html: html, title: title, draft: draft) }
                .onHover { hovering in withAnimation(.easeOut(duration: 0.12)) { isHovering = hovering } }
                // The page is read in it; its name and its actions are the widget's.
                .accessibilityElement(children: .contain)
                .accessibilityLabel(WidgetAnswer.name(title))
                .accessibilityValue(draft != nil ? "Being made" : "")
                .accessibilityActions {
                    if draft == nil {
                        if showLarge != nil { Button("Open Larger") { openLarge(html: html, title: title) } }
                        Button("Copy Its HTML") { Clipboard.copy(html) }
                    }
                }
                #if DEBUG
                // KUVO_DEMO_WIDGET_LARGE: the first widget shown opens larger.
                .onAppear {
                    guard ProcessInfo.processInfo.environment["KUVO_DEMO_WIDGET_LARGE"] != nil, !Self.openedLarge else { return }
                    Self.openedLarge = true
                    Task {
                        try? await Task.sleep(for: .seconds(2))
                        openLarge(html: html, title: title)
                    }
                }
                #endif
        }
    }

    /// The pill just over the page's top corner, off the page, where a page keeps its own
    /// controls: how much is written while it's made; then, on hover, Open Larger and Copy.
    @ViewBuilder private func corner(html: String, title: String?, draft: Int?) -> some View {
        let pill = Capsule()
        Group {
            if let draft {
                HStack(spacing: 5) {
                    Spinner(size: 10)
                    if let size = Self.written(draft) {
                        Text(size)
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                    }
                }
                .font(.caption)
                .padding(.horizontal, 8)
                .frame(minHeight: 24)
            } else {
                HStack(spacing: 0) {
                    // Only where there's a card for it to cover.
                    if showLarge != nil {
                        MessageActionButton(symbol: "arrow.up.left.and.arrow.down.right", help: "Open Larger") { openLarge(html: html, title: title) }
                    }
                    CopyButton(text: html, help: "Copy Its HTML")
                }
                .padding(.horizontal, 2)
            }
        }
        .background(Surface.cardFill(scheme, focused: cardIsFocused), in: pill)
        .overlay(pill.strokeBorder(Color.primary.opacity(0.1), lineWidth: 1))
        .shadow(color: .black.opacity(scheme == .dark ? 0.3 : 0.08), radius: 4, y: 1)
        .padding(.trailing, 6)
        .alignmentGuide(.top) { $0[.bottom] + 4 }
        .onHover { isOnPill = $0 }
        .opacity(draft != nil || isHovering || isOnPill ? 1 : 0)
        // Out of reach while they're hidden, Tab's too; VoiceOver has them as the widget's actions.
        .disabled(draft == nil && !isHovering && !isOnPill)
        .accessibilityHidden(true)
    }
}

/// Over a message a widget sent for you: which widget it came from.
struct WidgetAnswerChip: View {
    let title: String

    var body: some View {
        Label(WidgetAnswer.name(title), systemImage: "sparkles.rectangle.stack")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background(Color.primary.opacity(0.06), in: .capsule)
            .frame(maxWidth: 420, alignment: .trailing)
            .help("Sent by clicking in what the agent made")
    }
}

extension EnvironmentValues {
    /// Sends text to the agent of the conversation in view, as your message (a widget's
    /// `kuvo.send`).
    @Entry var answerAgent: (String) -> Void = { _ in }
    /// Shows a widget large, over the card of the conversation it's in (`largeWidgetHost`).
    @Entry var showWidgetLarge: ((LargeWidget) -> Void)? = nil
}

/// A widget shown large, over its conversation.
struct LargeWidget: Equatable {
    let id: String
    let html: String
    let title: String?
    let send: (String) -> Void

    static func == (a: LargeWidget, b: LargeWidget) -> Bool { a.id == b.id && a.html == b.html }
}

extension View {
    /// Where a widget opened larger shows: over this, the conversation's part of its card.
    func largeWidgetHost() -> some View {
        modifier(LargeWidgetHost())
    }
}

private struct LargeWidgetHost: ViewModifier {
    @State private var large: LargeWidget?

    func body(content: Content) -> some View {
        content
            .environment(\.showWidgetLarge) { widget in withAnimation(.ui) { large = widget } }
            .overlay {
                if let large {
                    LargeWidgetView(widget: large) { withAnimation(.ui) { self.large = nil } }
                        .transition(.opacity.combined(with: .scale(0.985)))
                }
            }
            // Over all of the card's content: its header doesn't fade the widget's own.
            .preference(key: CardTopIsFixed.self, value: large != nil)
    }
}

/// The widget over the whole conversation, with its name, a way back, and its HTML to copy. What
/// it writes back goes to the agent, and the conversation comes back to show it.
private struct LargeWidgetView: View {
    let widget: LargeWidget
    let close: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles.rectangle.stack")
                    .foregroundStyle(.tint)
                Text(WidgetAnswer.name(widget.title))
                    .fontWeight(.medium)
                    .lineLimit(1)
                Spacer(minLength: 8)
                CopyButton(text: widget.html, help: "Copy Its HTML")
                MessageActionButton(symbol: "arrow.down.right.and.arrow.up.left", help: "Back to the Conversation (Esc)", action: close)
                    .accessibilityLabel("Back to the Conversation")
            }
            .font(.callout)
            .padding(.leading, 14)
            .padding(.trailing, 8)
            .frame(height: 36)
            Divider()
            if failed {
                VStack(spacing: 8) {
                    Text("It couldn't show.")
                        .foregroundStyle(.secondary)
                    Button("Try Again") {
                        failed = false
                        attempt += 1
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                WidgetPage(html: widget.html, accent: NSColor.controlAccentColor, height: .constant(0), scrollsInside: true,
                           send: { text in
                               close()
                               widget.send(text)
                           }, failed: { failed = true })
                    .id(attempt)
            }
        }
        .background(Surface.cardFill(scheme, focused: true))
        .background {
            Button("Back to the Conversation", action: close)
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
    }
}

/// Words that change while a widget is on its way and its name isn't written yet.
private struct MakingWords: View {
    static let words = [
        "Sketching", "Tinkering", "Doodling", "Conjuring", "Noodling", "Assembling", "Whittling",
        "Concocting", "Fiddling", "Brewing", "Daydreaming", "Arranging", "Polishing", "Rigging",
    ]
    @State private var index = Int.random(in: 0..<MakingWords.words.count)

    var body: some View {
        ShimmerText(text: Self.words[index] + "…")
            .id(index)
            .transition(.opacity)
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(2.6))
                    withAnimation(.easeInOut(duration: 0.35)) { index = (index + 1) % Self.words.count }
                }
            }
    }
}

/// The page itself: a web view of its own, with nothing kept after it closes, reaching nothing
/// but the usual places for libraries, its links opening in your browser. As tall as what's on
/// it, up to a point, then it scrolls inside.
private struct WidgetPage: NSViewRepresentable {
    let html: String
    let accent: NSColor
    @Binding var height: CGFloat
    /// It has room of its own (larger, in a sheet): it always scrolls in itself.
    var scrollsInside = false
    /// Still being written: drawn without its scripts, a couple of times a second.
    var isDraft = false
    let send: (String) -> Void
    /// It didn't load, or stopped and didn't come back.
    var failed: () -> Void = {}

    /// Taller than this, it scrolls inside.
    static let tallest: CGFloat = 760

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WidgetWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let content = configuration.userContentController
        content.addUserScript(WKUserScript(source: Self.bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Apart from the page's own scripts, so it measures a draft drawn without them too; and
        // the only way to the app: the page itself has none, so what it sends goes through
        // `forward`, which a click of yours lets through.
        content.add(WeakHandler(context.coordinator), contentWorld: .defaultClient, name: "kuvo")
        content.addUserScript(WKUserScript(source: Self.forward, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
        content.addUserScript(WKUserScript(source: Self.measure, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        content.addUserScript(WKUserScript(source: Self.pressable, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
        let view = WidgetWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        return view
    }

    func updateNSView(_ view: WidgetWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.height = $height
        coordinator.send = send
        coordinator.failed = failed
        coordinator.view = view
        coordinator.scrollsInside = scrollsInside
        if scrollsInside { view.fits = false }
        coordinator.show(Self.page(html, accent: accent, inset: scrollsInside), draft: isDraft)
    }

    /// Libraries from the usual places, pictures from anywhere; nothing it can send to.
    private static let policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com; font-src https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net data:; img-src data: blob: https:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'"

    /// The look a page starts from, Kuvo Code's: its text, buttons, fields, tables and headings,
    /// and colors to draw with by name (`--kuvo-1`…`--kuvo-6` for a chart's series, `--kuvo-good`,
    /// `--kuvo-bad`), in light and dark. Each rule counts for nothing against the page's own
    /// (`:where`), so whatever it styles itself looks as it says. The same on the Mac and the
    /// phone (kuvo-ai's and kuvo-code-ios's WidgetView): keep the two in step.
    static let starter = """
    :root {
      color-scheme: light dark; accent-color: var(--kuvo-accent);
      --kuvo-text: CanvasText;
      --kuvo-secondary: color-mix(in srgb, CanvasText 62%, transparent);
      --kuvo-tertiary: color-mix(in srgb, CanvasText 40%, transparent);
      --kuvo-fill: color-mix(in srgb, CanvasText 5%, transparent);
      --kuvo-fill-strong: color-mix(in srgb, CanvasText 10%, transparent);
      --kuvo-line: color-mix(in srgb, CanvasText 12%, transparent);
      --kuvo-radius: 8px;
      --kuvo-1: #007AFF; --kuvo-2: #FF9500; --kuvo-3: #34C759; --kuvo-4: #AF52DE; --kuvo-5: #FF2D55; --kuvo-6: #5AC8FA;
      --kuvo-good: #34C759; --kuvo-bad: #FF3B30; --kuvo-warn: #FF9500;
    }
    @media (prefers-color-scheme: dark) { :root {
      --kuvo-1: #0A84FF; --kuvo-2: #FF9F0A; --kuvo-3: #30D158; --kuvo-4: #BF5AF2; --kuvo-5: #FF375F; --kuvo-6: #64D2FF;
      --kuvo-good: #30D158; --kuvo-bad: #FF453A; --kuvo-warn: #FF9F0A;
    } }
    html, body { margin: 0; background: transparent; }
    :where(h1, h2, h3, h4) { margin: 0 0 .5em; font-weight: 600; line-height: 1.25; }
    :where(h1) { font-size: 1.3em; } :where(h2) { font-size: 1.15em; } :where(h3, h4) { font-size: 1em; }
    :where(p) { margin: 0 0 .6em; }
    :where(a) { color: var(--kuvo-accent); }
    :where(small, .muted) { color: var(--kuvo-secondary); }
    :where(code, kbd, pre) { font: .9em ui-monospace, Menlo, monospace; }
    :where(pre code) { font-size: inherit; }
    :where(hr) { border: 0; border-top: 1px solid var(--kuvo-line); margin: .8em 0; }
    :where(button, select, input, textarea) { font: inherit; color: inherit; }
    :where(button) { padding: .35em .85em; border: 0; border-radius: var(--kuvo-radius); background: var(--kuvo-fill-strong); cursor: default; }
    :where(button:hover) { background: color-mix(in srgb, CanvasText 15%, transparent); }
    :where(button:active) { background: color-mix(in srgb, CanvasText 20%, transparent); }
    :where(button.primary) { background: var(--kuvo-accent); color: #fff; }
    :where(button:disabled) { opacity: .45; }
    :where(input:not([type=checkbox], [type=radio], [type=range], [type=color]), select, textarea) {
      padding: .3em .55em; border: 1px solid var(--kuvo-line); border-radius: 6px; background: var(--kuvo-fill); }
    :where(input, select, textarea, button):focus-visible { outline: 2px solid color-mix(in srgb, var(--kuvo-accent) 60%, transparent); outline-offset: 1px; }
    :where(table) { border-collapse: collapse; font-variant-numeric: tabular-nums; }
    :where(th) { text-align: left; font-weight: 600; color: var(--kuvo-secondary); font-size: .9em; }
    :where(th, td) { padding: .4em .6em; border-bottom: 1px solid var(--kuvo-line); }
    :where(.kuvo-card) { background: var(--kuvo-fill); border-radius: 10px; padding: 12px; }
    :where(.kuvo-chip) { display: inline-flex; align-items: center; gap: .3em; padding: .15em .6em; border-radius: 999px; background: var(--kuvo-fill-strong); font-size: .9em; }
    :where(.kuvo-row) { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    """

    /// `html` as a page: a fragment in a page of its own, or a whole page as it is; either way
    /// with the policy above, and the window's look to start from.
    /// `inset`: in room of its own (larger), away from the edges; in the conversation, its words line
    /// up with the reply's.
    static func page(_ html: String, accent: NSColor, inset: Bool = false) -> String {
        let hex = accent.usingColorSpace(.sRGB).map { String(format: "#%02X%02X%02X", Int($0.redComponent * 255), Int($0.greenComponent * 255), Int($0.blueComponent * 255)) } ?? "#0A84FF"
        let head = """
        <meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="\(policy)">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
        :root { --kuvo-accent: \(hex); }
        \(starter)
        body { font: 13px/1.45 -apple-system, BlinkMacSystemFont, sans-serif; color: CanvasText; padding: \(inset ? "12px" : "4px 2px"); box-sizing: border-box; }
        </style>
        """
        if let range = html.range(of: "<head>", options: .caseInsensitive) {
            var page = html
            page.insert(contentsOf: head, at: range.upperBound)
            return page
        }
        if html.range(of: "<html", options: .caseInsensitive) != nil {
            return head + html
        }
        return "<!doctype html><html><head>\(head)</head><body>\(html)</body></html>"
    }

    /// `kuvo.send(text)`: the page writes back to the agent as you, only from a click of yours.
    /// It hands the text to `forward`, apart from the page's scripts, which checks the click: the
    /// page can't reach the app itself.
    private static let bridge = """
    window.kuvo = {
      send(text) {
        if (navigator.userActivation && !navigator.userActivation.isActive) return false;
        document.documentElement.setAttribute("data-kuvo-send", String(text));
        document.dispatchEvent(new Event("kuvo-send"));
        return true;
      },
    };
    """

    /// What the page sends, on to the app: only while a click of yours is fresh, which the page's
    /// own scripts can't make up.
    private static let forward = """
    document.addEventListener("kuvo-send", () => {
      const root = document.documentElement;
      const text = root.getAttribute("data-kuvo-send");
      root.removeAttribute("data-kuvo-send");
      if (text === null || !navigator.userActivation || !navigator.userActivation.isActive) return;
      // Spent on this one, where the browser can: the click stays "active" a few seconds.
      navigator.userActivation.consume?.();
      window.webkit.messageHandlers.kuvo.postMessage({ type: "send", text });
    });
    """

    /// Whether the focus is on a button, whenever it moves: Space presses one, and anywhere else
    /// (a field, something the page draws itself) it's typing, not a click.
    private static let pressable = """
    (() => {
      const kinds = new Set(["button", "submit", "reset", "checkbox", "radio", "image", "color"]);
      const pressable = () => {
        let element = document.activeElement;
        while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
        if (!element || element.isContentEditable) return false;
        if (element.localName === "button" || element.localName === "summary") return true;
        return element.localName === "input" && kinds.has(String(element.type || "text").toLowerCase());
      };
      const report = () => window.webkit.messageHandlers.kuvo.postMessage({ type: "pressable", value: pressable() });
      document.addEventListener("focusin", report, true);
      document.addEventListener("focusout", () => setTimeout(report), true);
    })();
    """

    /// Its height, whenever it changes.
    private static let measure = """
    (() => {
      const report = () => window.webkit.messageHandlers.kuvo.postMessage({ type: "height", value: Math.ceil(document.documentElement.scrollHeight) });
      new ResizeObserver(report).observe(document.documentElement);
      report();
    })();
    """

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var height: Binding<CGFloat>?
        var send: (String) -> Void = { _ in }
        var failed: () -> Void = {}
        weak var view: WidgetWebView?
        /// WebKit stopped its page and it hasn't drawn since (it does stop pages, to free memory): stopping again is a failure.
        private var restarted = false
        var loaded: String?
        var scrollsInside = false
        /// What's shown is a draft: no scripts.
        private(set) var isDraft = false
        private var lastDraft = Date.distantPast
        private var waitingDraft: Task<Void, Never>?
        /// Loading again with a height already (scrolled back to, or finished after its draft),
        /// it keeps that height for a moment and only grows: a page draws in steps, and
        /// coming in short would move the conversation under it.
        private var keepsHeightUntil = Date.distantPast
        private var measured: CGFloat?
        /// When the page last sent a message, for one a click.
        private var lastSent: Date?

        /// Loads `page`: the finished one at once, a draft at most twice a second (the last
        /// one coming once it's had its turn).
        func show(_ page: String, draft: Bool) {
            guard loaded != page else { return }
            waitingDraft?.cancel()
            let due = lastDraft.addingTimeInterval(0.5)
            if draft, due > .now {
                waitingDraft = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(due.timeIntervalSinceNow))
                    guard !Task.isCancelled else { return }
                    self?.load(page, draft: true)
                }
                return
            }
            load(page, draft: draft)
        }

        private func load(_ page: String, draft: Bool) {
            isDraft = draft
            if draft { lastDraft = .now }
            loaded = page
            measured = nil
            view?.loadHTMLString(page, baseURL: nil)
            guard (height?.wrappedValue ?? 0) > 0 else { return }
            keepsHeightUntil = .now.addingTimeInterval(1.5)
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(1.6))
                guard let self, let measured, let height, abs(height.wrappedValue - measured) > 0.5 else { return }
                height.wrappedValue = measured
            }
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            switch body["type"] as? String {
            case "height":
                guard let value = body["value"] as? Double else { return }
                // Drawn again: a later stop gets its own reload.
                restarted = false
                let fits = CGFloat(value) <= WidgetPage.tallest
                view?.fits = fits && !scrollsInside
                let new = min(CGFloat(value), WidgetPage.tallest)
                measured = new
                let current = height?.wrappedValue ?? 0
                if keepsHeightUntil > .now, new < current { return }
                if abs(current - new) > 0.5 { height?.wrappedValue = new }
            case "pressable":
                view?.focusPressable = body["value"] as? Bool ?? false
            case "send":
                guard let text = body["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                // One message for a click, however many the page tries in the moment it gives: only
                // just after one, and not again within it.
                guard view?.wasClicked == true, lastSent.map({ Date.now.timeIntervalSince($0) > 2 }) ?? true else { return }
                lastSent = .now
                send(String(text.prefix(4000)))
            default:
                break
            }
        }

        #if DEBUG
        /// KUVO_DEMO_WIDGET_SNAPSHOTS=<folder>: each page, once drawn, as a picture there (a
        /// background copy's window doesn't draw web pages, so they can't be captured).
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard let folder = ProcessInfo.processInfo.environment["KUVO_DEMO_WIDGET_SNAPSHOTS"] else { return }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1.5))
                let configuration = WKSnapshotConfiguration()
                guard let image = try? await webView.takeSnapshot(configuration: configuration),
                      let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
                let name = "widget-\(abs((loaded ?? "").hashValue) % 100_000).png"
                try? png.write(to: URL(filePath: folder).appending(path: name))
            }
        }
        #endif

        /// Its own page loads (a draft without its scripts); a link you click goes to your browser
        /// instead, one for each click. One the page goes to by itself, without your click (its
        /// script clicking a link counts as by itself), goes nowhere.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences, decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
            if action.navigationType == .linkActivated || (action.targetFrame?.isMainFrame == true && action.request.url?.scheme.map(["http", "https"].contains) == true) {
                if let url = action.request.url, ["http", "https"].contains(url.scheme ?? ""),
                   (webView as? WidgetWebView)?.takeClick() == true {
                    NSWorkspace.shared.open(url)
                }
                decisionHandler(.cancel, preferences)
                return
            }
            preferences.allowsContentJavaScript = !isDraft
            decisionHandler(.allow, preferences)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }

        /// Not a page replaced by the next draft, nor a link sent to your browser instead.
        private func failed(_ error: Error) {
            let error = error as NSError
            guard !(error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled), !(error.domain == "WebKitErrorDomain" && error.code == 102) else { return }
            failed()
        }

        /// Its page stopped: loaded again once, then it's a failure.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard !restarted, let loaded else { return failed() }
            restarted = true
            webView.loadHTMLString(loaded, baseURL: nil)
        }

        /// A link meant for a new window, too.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, ["http", "https"].contains(url.scheme ?? ""),
               (webView as? WidgetWebView)?.takeClick() == true {
                NSWorkspace.shared.open(url)
            }
            return nil
        }
    }
}

/// Scrolling over a page that fits goes on to the conversation around it.
final class WidgetWebView: WKWebView {
    var fits = true
    private var clicked: Date?

    /// You clicked in it a moment ago: what it opens now is your doing, not the page's own.
    var wasClicked: Bool { clicked.map { Date.now.timeIntervalSince($0) < 1.5 } ?? false }

    /// Whether you clicked a moment ago, using up the click: it opens one link, not many.
    func takeClick() -> Bool {
        guard wasClicked else { return false }
        clicked = nil
        return true
    }

    override func mouseDown(with event: NSEvent) {
        clicked = .now
        super.mouseDown(with: event)
    }

    /// The focus is on one of its buttons (see `WidgetPage.pressable`).
    var focusPressable = false

    /// A key that presses a control (Space or Return on a button) is a click too, and Return in
    /// a field (sending what you typed); typing isn't, nor a key held down.
    override func keyDown(with event: NSEvent) {
        // Return and Enter; Space.
        if !event.isARepeat, [36, 76].contains(event.keyCode) || (event.keyCode == 49 && focusPressable) { clicked = .now }
        super.keyDown(with: event)
    }

    override func scrollWheel(with event: NSEvent) {
        if fits { nextResponder?.scrollWheel(with: event) } else { super.scrollWheel(with: event) }
    }
}

/// Holds the page's handler without the page holding it back.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

