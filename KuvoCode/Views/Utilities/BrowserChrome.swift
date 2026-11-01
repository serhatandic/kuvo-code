import AppKit
import ClientDesign
import ClientText
import SwiftUI

// What's around a page in the panel's browser, the same for this Mac's pages and a machine's:
// back, forward and reload; the address; the toolbar's actions and More menu; and the bars under
// it for a page's question and the latest download.

/// Back, forward, and reload (stop while it loads).
struct BrowserNavigation: View {
    let canGoBack: Bool
    let canGoForward: Bool
    let isLoading: Bool
    let canReload: Bool
    let back: () -> Void
    let forward: () -> Void
    let reloadOrStop: () -> Void

    var body: some View {
        BrowserToolbarGroup {
            Button(action: back) { Label("Back", systemImage: "arrow.left") }
                .disabled(!canGoBack)
                .help("Back")
            Button(action: forward) { Label("Forward", systemImage: "arrow.right") }
                .disabled(!canGoForward)
                .help("Forward")
            Divider().frame(height: 16).padding(.horizontal, 2)
            Button(action: reloadOrStop) {
                Label(isLoading ? "Stop" : "Reload", systemImage: isLoading ? "xmark" : "arrow.clockwise")
            }
            .disabled(!canReload)
            .help(isLoading ? "Stop" : "Reload")
        }
    }
}

/// A row of the toolbar's buttons, in its capsule.
struct BrowserToolbarGroup<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 0) { content }
            .buttonStyle(ToolbarGroupStyle())
            .padding(.horizontal, 3)
            .frame(height: 34)
            .background(Color.primary.opacity(0.06), in: .capsule)
    }
}

/// The address: the site while browsing, the whole address while you edit it, and a line along
/// its foot while the page loads (as far as it's got, when that's known).
struct BrowserAddressField: View {
    @Binding var address: String
    var editing: FocusState<Bool>.Binding
    let isSecure: Bool
    /// Loading: how far, or nil when only that it is.
    let isLoading: Bool
    var progress: Double?
    var help: String?
    let submit: () -> Void

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: isSecure && !editing.wrappedValue ? "lock.fill" : "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
            TextField("Search or enter a URL", text: $address)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .focused(editing)
                .onSubmit(submit)
                // The line along its foot, in words; on the label, as the value is what's typed.
                .accessibilityLabel(isLoading ? "Address, loading" : "Address")
        }
        .padding(.horizontal, 14)
        .frame(height: 34)
        .background(Color.primary.opacity(0.06), in: .capsule)
        .overlay(alignment: .bottom) {
            LoadingEdge(isLoading: isLoading, progress: progress)
                .padding(.horizontal, 16)
        }
        .contentShape(.capsule)
        .onTapGesture { editing.wrappedValue = true }
        .help(help ?? "")
    }

    /// What it shows for `url`: the host while browsing ("google.com"), the full address while
    /// editing.
    static func display(_ url: URL?, editing: Bool) -> String {
        guard let url else { return "" }
        if editing { return url.absoluteString }
        return url.host()?.replacingOccurrences(of: "www.", with: "") ?? url.absoluteString
    }
}

/// The toolbar's More menu: the address, reloading, zoom and the browser's settings.
struct BrowserMoreMenu: View {
    let url: URL?
    let canReload: Bool
    let reload: () -> Void
    let zoom: (_ by: Int) -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        Menu {
            Button("Copy Address") { if let url { Clipboard.copy(url.absoluteString) } }
                .disabled(url == nil)
            Button("Reload Page", action: reload)
                .disabled(!canReload)
            Divider()
            Button("Actual Size") { zoom(0) }
            Button("Zoom In") { zoom(1) }
            Button("Zoom Out") { zoom(-1) }
            Divider()
            Button("Browser Settings…") { app.openSettings(.browser) }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("More")
    }
}

/// The page zoomed in or out: how far, and a click back to actual size.
struct BrowserZoomChip: View {
    let zoom: CGFloat
    let reset: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: reset) {
            Text("\(Int((zoom * 100).rounded()))%")
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .foregroundStyle(isHovering ? .primary : .secondary)
                .fixedSize()
                .padding(.horizontal, 8)
                .frame(height: 28)
                .background(isHovering ? Color.primary.opacity(0.08) : .clear, in: .capsule)
                .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .onHover { isHovering = $0 }
        .help("Back to actual size (zoom with ⌘+ and ⌘−, or pinch)")
    }
}

/// A bar under the toolbar, in a well.
struct BrowserBar<Content: View>: View {
    var padding: EdgeInsets = EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12)
    @ViewBuilder let content: Content
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        content
            .controlSize(.small)
            .padding(padding)
            .background(Surface.well(scheme), in: .rect(cornerRadius: 10))
            .padding(.horizontal, 10)
            .padding(.bottom, 8)
    }
}

/// The page asked for a passkey, which this browser can't use yet: what to do instead. You close
/// it, or it goes when you leave the site.
struct PasskeyBar: View {
    let close: () -> Void

    var body: some View {
        BrowserBar {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "info.circle")
                    .foregroundStyle(.secondary)
                Text(PasskeyWords.note)
                    .font(.system(size: 12.5))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 18, height: 18)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .clickablePointer()
                .foregroundStyle(.secondary)
                .help("Close")
                .accessibilityLabel("Close")
            }
            .accessibilityElement(children: .contain)
        }
    }
}

/// The page asks something (an alert, a confirmation, a question, whether to leave it): answer
/// it here.
struct BrowserDialogBar: View {
    let message: String
    /// It takes a line of text.
    let asks: Bool
    /// Only OK, nothing to turn down.
    let isAlert: Bool
    var okTitle = "OK"
    let defaultText: String
    let answer: (_ accept: Bool, _ text: String?) -> Void
    @State private var text = ""

    var body: some View {
        BrowserBar(padding: EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12)) {
            VStack(alignment: .leading, spacing: 8) {
                Text(message.isEmpty ? "The page asks to continue." : message)
                    .font(.system(size: 13))
                    .textSelection(.enabled)
                    .lineLimit(6)
                if asks {
                    TextField("", text: $text)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { answer(true, text) }
                }
                HStack {
                    Spacer()
                    if !isAlert {
                        Button("Cancel") { answer(false, nil) }
                            .keyboardShortcut(.cancelAction)
                    }
                    Button(okTitle) { answer(true, asks ? text : nil) }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .onAppear { text = defaultText }
    }
}

/// The latest download: its name, how it's going or where it is, what you can do with it, and a
/// way to hide it.
struct BrowserDownloadBar<Detail: View, Actions: View>: View {
    let name: String
    let symbol: String
    /// Under way: the symbol in the accent color.
    var isRunning = false
    /// Hiding it waits until it's done.
    var canHide = true
    let hide: () -> Void
    @ViewBuilder let detail: Detail
    @ViewBuilder let actions: Actions

    var body: some View {
        BrowserBar {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .foregroundStyle(isRunning ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                VStack(alignment: .leading, spacing: 3) {
                    Text(name)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    detail
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                actions
                Button(action: hide) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .frame(width: 18, height: 18)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .clickablePointer()
                .foregroundStyle(.secondary)
                .disabled(!canHide)
                .accessibilityLabel("Hide")
                .help("Hide")
            }
        }
    }
}

/// A page loading, along the address field's lower edge: the line rushes to where the page says it
/// is, slows as it gets near, never goes back, and when the page is in it finishes and fades.
/// Without a figure from the page it eases most of the way and waits there. Each load draws a
/// line of its own, from nothing, even one that starts while the last one's line is still fading.
private struct LoadingEdge: View {
    let isLoading: Bool
    let progress: Double?
    /// Which load the line is for.
    @State private var load = 0
    @State private var isVisible = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        LoadingLine(isLoading: isLoading, progress: progress, still: reduceMotion)
            .id(load)
            .opacity(isVisible ? 1 : 0)
            .allowsHitTesting(false)
            // The address field says it's loading.
            .accessibilityHidden(true)
            .onChange(of: isLoading, initial: true) { _, loading in
                if loading {
                    // A new line at once, over whatever the last one was doing.
                    var now = Transaction()
                    now.disablesAnimations = true
                    withTransaction(now) {
                        load += 1
                        isVisible = true
                    }
                } else if isVisible {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3).delay(0.25)) { isVisible = false }
                }
            }
    }
}

/// One load's line, which starts empty.
private struct LoadingLine: View {
    let isLoading: Bool
    let progress: Double?
    let still: Bool
    @State private var shown = 0.0

    var body: some View {
        GeometryReader { proxy in
            Capsule().fill(.tint)
                .frame(width: proxy.size.width * shown, height: 2)
        }
        .frame(height: 2)
        .onAppear(perform: advance)
        .onChange(of: progress) { advance() }
        .onChange(of: isLoading) { _, loading in
            if !loading { withAnimation(still ? nil : .easeOut(duration: 0.2)) { shown = 1 } }
        }
    }

    private func advance() {
        guard isLoading else { return }
        let target = max(shown, progress.map { min(0.92, max($0, 0.15)) } ?? 0.7)
        withAnimation(still ? nil : .easeOut(duration: progress == nil ? 3 : 0.4)) { shown = target }
    }
}
