import ClientNews
import SwiftUI

/// What's New: a release's highlights, once after an update to it (and from Help › What's New),
/// each with its symbol or picture, a line on what it does, and Try It where there's somewhere to
/// go. All Changes… opens every release's notes.
struct WhatsNewSheet: View {
    let release: WhatsNew.Release
    let close: () -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("What’s New in Kuvo Code \(release.version == "Unreleased" ? AppInfo.version : release.version)")
                    .font(.title2.weight(.bold))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                Button("Close", systemImage: "xmark", action: close)
                    .buttonStyle(CardActionStyle())
                    .keyboardShortcut(.cancelAction)
                    .help("Close")
            }
            .padding(.horizontal, 28)
            .padding(.top, 24)
            .padding(.bottom, 18)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(release.highlights) { highlight in
                        HighlightRow(highlight: highlight) { tryIt(highlight) }
                    }
                }
                .padding(.horizontal, 28)
            }
            .scrollBounceBehavior(.basedOnSize)
            EditorFooter(primary: "Continue", onPrimary: close) {
                Button("All Changes…") { NSWorkspace.shared.open(AppInfo.releases) }
                    .buttonStyle(.glass)
            }
            .padding(.horizontal, 28)
            .padding(.top, 22)
            .padding(.bottom, 24)
        }
        .frame(width: 520)
        .frame(maxHeight: 640)
    }

    /// Where its Try It goes: a Settings page, or a web address.
    private func tryIt(_ highlight: WhatsNew.Highlight) {
        guard let open = highlight.open else { return }
        if open.hasPrefix("settings/"), let page = SettingsPage(rawValue: String(open.dropFirst("settings/".count))) {
            close()
            app.openSettings(page)
        } else if let url = URL(string: open), url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
    }

    /// The pages and addresses Try It can go to.
    static func canTry(_ open: String?) -> Bool {
        guard let open else { return false }
        if open.hasPrefix("settings/") { return SettingsPage(rawValue: String(open.dropFirst("settings/".count))) != nil }
        return URL(string: open)?.scheme == "https"
    }
}

/// One highlight: its picture (or its symbol, on a quiet tile), its title and line, and Try It.
private struct HighlightRow: View {
    let highlight: WhatsNew.Highlight
    let tryIt: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            picture
            VStack(alignment: .leading, spacing: 3) {
                Text(highlight.title)
                    .font(.headline)
                Text(Self.markdown(highlight.line))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if WhatsNewSheet.canTry(highlight.open) {
                    Button("Try It", action: tryIt)
                        .buttonStyle(.link)
                        .padding(.top, 2)
                        .accessibilityLabel("Try \(highlight.title)")
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var picture: some View {
        if let name = highlight.picture, let url = Bundle.main.url(forResource: name, withExtension: nil), let image = NSImage(contentsOf: url) {
            Image(nsImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 112, height: 70)
                .clipShape(.rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator))
                .accessibilityHidden(true)
        } else {
            Image(systemName: highlight.symbol)
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(.tint)
                .frame(width: 44, height: 44)
                .background(Color.accentColor.opacity(0.12), in: .rect(cornerRadius: 10))
                .accessibilityHidden(true)
        }
    }

    /// A line's own emphasis and code (`/goal`), as the changelog writes it; code a step smaller,
    /// as the conversation sets it, since the code face runs wide.
    static func markdown(_ line: String) -> AttributedString {
        guard var text = try? AttributedString(markdown: line, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) else { return AttributedString(line) }
        for run in text.runs where run.inlinePresentationIntent?.contains(.code) == true {
            text[run.range].font = .system(.callout, design: .monospaced)
        }
        return text
    }
}
