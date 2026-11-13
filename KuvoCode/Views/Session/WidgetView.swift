import AppKit
import ClientDesign
import ClientText
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
    /// Sends what the page wrote back, as your message, with the title of the widget it came from
    /// ("" for none).
    let send: (String, String) -> Void
    @State private var height: CGFloat

    /// Each page's height when last drawn, by call. The conversation makes a row again when you
    /// scroll back to it, and a page coming back short, then growing, would push everything
    /// under it down as you scroll.
    private static var heights: [String: CGFloat] = [:]

    init(call: Message.ToolCall, send: @escaping (String, String) -> Void) {
        self.call = call
        self.send = send
        _height = State(initialValue: Self.heights[call.id] ?? 0)
    }
    /// Its page didn't load, or stopped: one line in its place, and a way to try again.
    @State private var failed = false
    @State private var attempt = 0
    @Environment(\.colorScheme) private var scheme

    /// What the page writes back, sent with which widget it came from: its box (or a group chat's)
    /// says so to the agent.
    private func answer(from title: String?) -> (String) -> Void {
        { [send] text in send(text, title ?? "") }
    }

    private static let shape = RoundedRectangle(cornerRadius: 12)

    var body: some View {
        // One card while it's written and once it's done, so the page carries on from its draft.
        if case .failed = call.state {
            ToolCallView(call: call, directory: "")
        } else if let content {
            card(html: content.html, title: content.title, isDraft: content.draft != nil)
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

    /// The page itself, part of the reply, as the agent made it: no frame, no caption, and nothing
    /// over it or around it. A widget is final as shown, made for the width it's at, so it can't be
    /// opened larger or copied. Its name is what VoiceOver calls it. `isDraft`: still being written.
    private func card(html: String, title: String?, isDraft: Bool) -> some View {
        page(html: html, title: title, isDraft: isDraft)
            // Something new to show gets a try of its own.
            .onChange(of: html) { failed = false }
    }

    @ViewBuilder private func page(html: String, title: String?, isDraft: Bool) -> some View {
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
            WidgetPage(html: html, accent: NSColor.controlAccentColor, height: $height,
                       isDraft: isDraft, send: answer(from: title), failed: { failed = true })
                .id(attempt)
                .frame(height: max(height, 60))
                .onChange(of: height) { if height > 0 { Self.heights[call.id] = height } }
                .clipShape(Self.shape)
                // The page is read in it; its name is the widget's.
                .accessibilityElement(children: .contain)
                .accessibilityLabel(WidgetAnswer.name(title))
                .accessibilityValue(isDraft ? "Being made" : "")
        }
    }
}

/// Over a message a widget sent for you: which widget it came from.
struct WidgetAnswerChip: View {
    let title: String

    var body: some View {
        Label(WidgetAnswer.name(title), systemImage: "hand.tap.fill")
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
    /// `kuvo.send`), with the title of the widget it came from ("" for none).
    @Entry var answerAgent: (String, String) -> Void = { _, _ in }
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
struct WidgetPage: NSViewRepresentable {
    let html: String
    let accent: NSColor
    @Binding var height: CGFloat
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
        content.addUserScript(WKUserScript(source: Self.watchesScheme, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Apart from the page's own scripts, so it measures a draft drawn without them too; and
        // the only way to the app: the page itself has none, so what it sends goes through
        // `forward`, which a click of yours lets through.
        content.add(WeakHandler(context.coordinator), contentWorld: .defaultClient, name: "kuvo")
        content.addUserScript(WKUserScript(source: Self.forward, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
        content.addUserScript(WKUserScript(source: Self.measure, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        content.addUserScript(WKUserScript(source: Self.pressable, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
        content.addUserScript(WKUserScript(source: Self.schemeChanged, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
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
        coordinator.show(Self.page(html, accent: accent), draft: isDraft)
    }

    /// Libraries from the usual places, pictures from anywhere; nothing it can send to.
    private static let policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com; font-src https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net data:; img-src data: blob: https:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'"

    /// The look a page starts from, Kuvo Code's: its text, buttons, fields, tables and headings,
    /// and colors to draw with by name (`--kuvo-1`…`--kuvo-6` for a chart's series, `--kuvo-good`,
    /// `--kuvo-bad`), in light and dark, as plain colors a script can read and draw a canvas
    /// with. Each rule counts for nothing against the page's own
    /// (`:where`), so whatever it styles itself looks as it says. The same on the Mac and the
    /// phone (kuvo-ai's and kuvo-code-ios's WidgetView): keep the two in step.
    static let starter = """
    :root {
      color-scheme: light dark; accent-color: var(--kuvo-accent);
      --kuvo-text: #000; --kuvo-secondary: rgb(0 0 0 / .62); --kuvo-tertiary: rgb(0 0 0 / .4);
      --kuvo-fill: rgb(0 0 0 / .05); --kuvo-fill-strong: rgb(0 0 0 / .1); --kuvo-line: rgb(0 0 0 / .12);
      --kuvo-radius: 8px;
      --kuvo-1: #007AFF; --kuvo-2: #FF9500; --kuvo-3: #34C759; --kuvo-4: #AF52DE; --kuvo-5: #FF2D55; --kuvo-6: #5AC8FA;
      --kuvo-good: #34C759; --kuvo-bad: #FF3B30; --kuvo-warn: #FF9500;
    }
    @media (prefers-color-scheme: dark) { :root {
      --kuvo-text: #fff; --kuvo-secondary: rgb(255 255 255 / .62); --kuvo-tertiary: rgb(255 255 255 / .4);
      --kuvo-fill: rgb(255 255 255 / .05); --kuvo-fill-strong: rgb(255 255 255 / .1); --kuvo-line: rgb(255 255 255 / .12);
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
    /// with the policy above, and the window's look to start from. Its words line up with the reply's.
    static func page(_ html: String, accent: NSColor) -> String {
        // In both looks, so the page stays the same page when the look changes (`followsScheme`).
        // High contrast, as the Mac is set.
        let contrast = NSApp?.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua])?.rawValue.contains("HighContrast") == true
        func hex(_ look: NSAppearance.Name) -> String {
            var hex = "#0A84FF"
            NSAppearance(named: look)?.performAsCurrentDrawingAppearance {
                if let color = accent.usingColorSpace(.sRGB) { hex = String(format: "#%02X%02X%02X", Int(color.redComponent * 255), Int(color.greenComponent * 255), Int(color.blueComponent * 255)) }
            }
            return hex
        }
        let head = """
        <meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="\(policy)">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
        :root { --kuvo-accent: \(hex(contrast ? .accessibilityHighContrastAqua : .aqua)); }
        @media (prefers-color-scheme: dark) { :root { --kuvo-accent: \(hex(contrast ? .accessibilityHighContrastDarkAqua : .darkAqua)); } }
        \(starter)
        body { font: 13px/1.45 -apple-system, BlinkMacSystemFont, sans-serif; color: CanvasText; padding: 4px 2px; box-sizing: border-box; }
        </style>
        """
        // Where its own markup starts, past space and comments: an <html> or <head> in a comment
        // or a script's string further on is no place for the policy.
        var start = html.startIndex
        while true {
            start = html[start...].firstIndex { !$0.isWhitespace && $0 != "\u{FEFF}" } ?? html.endIndex
            guard html[start...].hasPrefix("<!--"), let close = html.range(of: "-->", range: html.index(start, offsetBy: 4)..<html.endIndex) else { break }
            start = close.upperBound
        }
        let opening = html[start...].prefix(10).lowercased()
        // A whole page's doctype comes first, then the app's look: before it, the page would be
        // laid out the old way, as one without a doctype is.
        if opening.hasPrefix("<!doctype"), let end = html[start...].firstIndex(of: ">") {
            var page = html
            page.insert(contentsOf: head, at: html.index(after: end))
            return page
        }
        // A whole page without one, laid out the old way as its maker wrote it.
        if ["<html", "<head"].contains(where: { opening.hasPrefix($0) && opening.dropFirst(5).first.map { $0 == ">" || $0.isWhitespace } ?? false }) {
            return head + (html.first == "\u{FEFF}" ? String(html.dropFirst()) : html)
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

    /// How the page's scripts take light and dark, marked on the page for `followsScheme`: each
    /// scheme they read it in (the scheme itself, or colors as they're drawn with, as a chart
    /// does), and whether they listen for it to change, drawing again then themselves.
    private static let watchesScheme = """
    (() => {
      const scheme = query => /prefers-color-scheme/.test(query);
      const lists = MediaQueryList.prototype;
      const matches = Object.getOwnPropertyDescriptor(lists, "matches");
      const dark = matchMedia("(prefers-color-scheme: dark)");
      // Each set only when it changes: a chart reads styles on every move of the pointer.
      const follows = query => { const root = document.documentElement; if (scheme(query) && root && !root.hasAttribute("data-kuvo-follows-scheme")) root.setAttribute("data-kuvo-follows-scheme", ""); };
      // Every scheme read in, kept: a chart drawn light that reads again once it's dark (a
      // tooltip, an animation) still drew light.
      const reads = () => {
        const root = document.documentElement, now = matches.get.call(dark) ? "dark" : "light";
        const read = root?.getAttribute("data-kuvo-reads-scheme");
        if (root && !read?.split(" ").includes(now)) root.setAttribute("data-kuvo-reads-scheme", read ? read + " " + now : now);
      };
      const add = lists.addEventListener, addListener = lists.addListener;
      lists.addEventListener = function (type, ...rest) { if (type === "change") follows(this.media); return add.call(this, type, ...rest); };
      lists.addListener = function (...rest) { follows(this.media); return addListener.apply(this, rest); };
      const onchange = Object.getOwnPropertyDescriptor(lists, "onchange");
      if (onchange?.set) Object.defineProperty(lists, "onchange", { ...onchange, set(value) { follows(this.media); onchange.set.call(this, value); } });
      Object.defineProperty(lists, "matches", { ...matches, get() { if (scheme(this.media)) reads(); return matches.get.call(this); } });
      const computed = window.getComputedStyle;
      window.getComputedStyle = function (...rest) { reads(); return computed.apply(this, rest); };
    })();
    """

    /// Whether the page is right in the scheme it's in now: its CSS follows by itself, so only
    /// scripts that read another scheme as they drew (a chart's labels, in dark grey on what's
    /// now dark) and don't draw again by themselves need it loaded again. One that only reacts to
    /// you (a slider, a regex to try) keeps what you did in it. Asked apart from the page's
    /// scripts, which can't change what it says.
    static let followsScheme = """
    (() => {
      const root = document.documentElement, read = root?.getAttribute("data-kuvo-reads-scheme");
      if (!read || root.hasAttribute("data-kuvo-follows-scheme")) return true;
      const now = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      return read.split(" ").every(scheme => scheme === now);
    })()
    """

    /// Tells the app when the page's light and dark has changed: once the page has it, not as the
    /// Mac switches, so `followsScheme` compares with the look the page is in.
    private static let schemeChanged = #"matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => window.webkit.messageHandlers.kuvo.postMessage({ type: "scheme" }));"#

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

    /// Its height, whenever it changes: what's on it, however tall the view is now, so it gets
    /// shorter again too. That's the page's own box, what's in its body, each of the body's own
    /// children and words wherever they're placed, with what spills out of them, and the layers
    /// placed against the page (only those, on a page without a doctype, which fills its view
    /// however little is on it). Not what's fixed to the window (a toast waiting below it), which
    /// is measured against the view and would grow it with each measure. It's measured again
    /// when the page's box changes and when anything on it does (a chart drawn in a page that
    /// fills its window), and sent only when it changed. The same as the phone's.
    static let measure = """
    (() => {
      const measure = () => {
        const old = document.compatMode === "BackCompat";
        let height = old ? 0 : document.documentElement.getBoundingClientRect().height;
        const body = document.body;
        if (!body) return Math.ceil(height);
        if (!old) height = Math.max(height, body.getBoundingClientRect().top + window.scrollY + body.scrollHeight);
        let bottom = 0;
        // Layers placed against the page itself from inside a wrapper (a dropdown, a game's
        // canvas), which no box around them takes in. Not a closed menu's, hidden, or anything
        // under what's hidden, placed itself or a drawing, which can't be placed against the page.
        const layers = parent => {
          for (const node of parent.children) {
            if (node instanceof SVGSVGElement || node.offsetParent === null) continue;
            if (node.offsetParent === body) {
              const style = getComputedStyle(node);
              if (style.position === "absolute" && style.visibility !== "hidden") {
                const box = node.getBoundingClientRect();
                if (box.height > 0) bottom = Math.max(bottom, box.bottom);
              }
              if (style.position !== "static") continue;
            }
            layers(node);
          }
        };
        for (const node of body.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            const range = document.createRange();
            range.selectNodeContents(node);
            const box = range.getBoundingClientRect();
            if (box.height > 0) bottom = Math.max(bottom, box.bottom);
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const style = getComputedStyle(node);
            if (style.position === "fixed" || (style.position === "absolute" && style.visibility === "hidden")) continue;
            const box = node.getBoundingClientRect();
            if (box.height > 0) bottom = Math.max(bottom, box.bottom + Math.max(0, parseFloat(style.marginBottom)));
            // What spills out of it, unless it scrolls or is clipped inside it.
            if (style.overflowY === "visible") bottom = Math.max(bottom, box.top + node.scrollHeight);
            if (style.position === "static") layers(node);
          }
        }
        if (bottom > 0) {
          bottom += window.scrollY;
          if (old) {
            const style = getComputedStyle(body);
            bottom += parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth) + parseFloat(style.marginBottom);
          }
        }
        return Math.ceil(Math.max(height, bottom));
      };
      // What follows the window (a wrapper of 100vh, a sheet placed against its bottom) asks for
      // as much more than the window again once given it: then the widget keeps the height it
      // has. It's told by measures taken as the window changes, before anything else does: twice
      // in a row as much more, so content that grows as much as the window just did still shows.
      let last, seen, follows, times = 0;
      const same = (one, other) => other !== undefined && Math.abs(one - other) <= 1;
      const report = () => {
        const height = measure();
        const view = { width: innerWidth, height: innerHeight, more: height - innerHeight };
        if (!seen || view.width !== seen.width || view.more <= 0) { follows = undefined; times = 0; }
        else if (view.height !== seen.height) {
          times = same(view.more, seen.more) ? times + 1 : 0;
          if (times >= 2) follows = view.more;
        }
        seen = view;
        if (height === last || same(view.more, follows)) return;
        last = height;
        window.webkit.messageHandlers.kuvo.postMessage({ type: "height", value: height });
      };
      window.addEventListener("resize", report);
      new ResizeObserver(report).observe(document.documentElement);
      new MutationObserver(report).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      window.addEventListener("load", report);
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
        /// What's shown is a draft: no scripts.
        private(set) var isDraft = false
        private var lastDraft = Date.distantPast
        private var waitingDraft: Task<Void, Never>?
        /// Loading again with a height already (scrolled back to, or finished after its draft),
        /// it keeps that height and only grows until it's loaded, and a moment more: a page draws
        /// in steps (its libraries coming first), and coming in short would move the
        /// conversation under it.
        private var keepsHeightUntil = Date.distantPast
        /// The load under way, and its height set once it's settled.
        private var navigation: WKNavigation?
        private var settling: Task<Void, Never>?
        private var measured: CGFloat?
        /// When the page last sent a message, for one a click.
        private var lastSent: Date?

        /// Loads `page`: the finished one at once, a draft at most twice a second (the last
        /// one coming once it's had its turn).
        func show(_ page: String, draft: Bool) {
            // Finished as its last draft was: the same page again, with its scripts this time.
            if loaded == page, !draft, isDraft {
                waitingDraft?.cancel()
                return load(page, draft: false)
            }
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
            settling?.cancel()
            navigation = view?.loadHTMLString(page, baseURL: nil)
            if (height?.wrappedValue ?? 0) > 0 { keepsHeightUntil = .distantFuture }
        }

        /// The page's look changed (the Mac's, or back in a window after it changed while it was
        /// away): a finished page that drew itself in the other one (a chart's labels
        /// in dark grey on what's now dark) loads again, at the height it has. A draft's CSS follows
        /// by itself.
        private func lookChanged() {
            guard loaded != nil, !isDraft else { return }
            view?.evaluateJavaScript(WidgetPage.followsScheme, in: nil, in: .defaultClient) { [weak self] result in
                guard let self, !isDraft, case .success(let follows as Bool) = result, !follows, let loaded else { return }
                load(loaded, draft: false)
            }
        }

        /// Loaded: what it measures a moment later stands, shorter too.
        private func settle() {
            guard keepsHeightUntil == .distantFuture else { return }
            keepsHeightUntil = .now.addingTimeInterval(1.5)
            settling = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(1.6))
                guard !Task.isCancelled, let self, let measured, let height, abs(height.wrappedValue - measured) > 0.5 else { return }
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
                view?.fits = fits
                let new = min(CGFloat(value), WidgetPage.tallest)
                measured = new
                let current = height?.wrappedValue ?? 0
                if keepsHeightUntil > .now, new < current { return }
                if abs(current - new) > 0.5 { height?.wrappedValue = new }
            case "scheme":
                lookChanged()
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

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if navigation === self.navigation { settle() }
            #if DEBUG
            snapshot(webView)
            #endif
        }

        #if DEBUG
        /// KUVO_DEMO_WIDGET_SNAPSHOTS=<folder>: each page, once drawn, as a picture there (a
        /// background copy's window doesn't draw web pages, so they can't be captured).
        private func snapshot(_ webView: WKWebView) {
            guard let folder = ProcessInfo.processInfo.environment["KUVO_DEMO_WIDGET_SNAPSHOTS"] else { return }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1.5))
                let configuration = WKSnapshotConfiguration()
                guard let image = try? await webView.takeSnapshot(configuration: configuration),
                      let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
                let name = "widget-\(abs((loaded ?? "").hashValue) % 100_000)-\(webView.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? "dark" : "light").png"
                try? png.write(to: URL(filePath: folder).appending(path: name))
            }
        }
        #endif

        /// Its own page loads (a draft without its scripts), and a link to a place on it (`#details`,
        /// a tab) goes there; a link you click goes to your browser instead, one for each click.
        /// One the page goes to by itself, without your click (its script clicking a link counts as
        /// by itself), goes nowhere.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
            // By its address as written: Foundation finds no fragment in `about:blank#details`.
            func page(_ url: URL?) -> String? { url?.absoluteString.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) }
            let onThePage = action.request.url?.absoluteString.contains("#") == true && page(action.request.url) == page(webView.url)
            if !onThePage, action.navigationType == .linkActivated || (action.targetFrame?.isMainFrame == true && action.request.url?.scheme.map(["http", "https"].contains) == true) {
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
            navigation = webView.loadHTMLString(loaded, baseURL: nil)
            if (height?.wrappedValue ?? 0) > 0 { keepsHeightUntil = .distantFuture }
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

