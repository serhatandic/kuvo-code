import AppKit
import ClientDesign
import SwiftUI

/// What a new tab shows until you go somewhere: the panel's tools (and a way into their
/// settings), and the sites the browser visits most. Picking a tool turns this tab into it; picking a site opens it here. Both
/// sections can be turned off in Settings › Panel.
struct NewTabPage: View {
    let utilities: Utilities
    let tabID: UUID
    let directory: String?
    let environment: [String: String]
    /// Opens an address in this tab, and in a new one.
    let open: (String) -> Void
    let openInNewTab: (String) -> Void
    @AppStorage(PanelSettings.showsTools) private var showsTools = true
    @AppStorage(PanelSettings.showsSuggestions) private var showsSuggestions = true
    @AppStorage(PanelSettings.suggestionCount) private var suggestionCount = 8
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if showsTools {
                    section("Tools") {
                        // Two across when the panel has room for them, one when it doesn't.
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 10)], spacing: 10) {
                            // (A group chat has no project: no changes or files to show.)
                            if utilities.hasProject {
                                ToolCard(title: "Changes", symbol: "plus.forwardslash.minus", shortcut: "⌥⌘I") {
                                    replace { utilities.showChanges() }
                                }
                            }
                            ToolCard(title: "Terminal", symbol: "apple.terminal", shortcut: "⌃`") {
                                replace { utilities.newTerminal(in: directory, environment: environment) }
                            }
                            if utilities.hasProject {
                                ToolCard(title: "Files", symbol: "folder", shortcut: "⌥⌘F") {
                                    replace { utilities.showFiles() }
                                }
                            }
                            ToolCard(title: "Work Queue", symbol: "checklist", shortcut: "⌥⌘U") {
                                replace { utilities.showWorkQueue() }
                            }
                            ToolCard(title: "Customize…", symbol: "slider.horizontal.3", shortcut: nil) {
                                app.openSettings(.panel)
                            }
                        }
                    }
                }
                if showsSuggestions {
                    section("Suggested") {
                        let sites = utilities.history.suggestions(suggestionCount)
                        if sites.isEmpty {
                            Text("Sites you visit in the panel show up here.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        } else {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 104, maximum: 160), spacing: 8)], spacing: 8) {
                                ForEach(sites) { site in
                                    SiteTile(site: site, icon: utilities.history.icon(for: site)) {
                                        open(site.url.absoluteString)
                                    }
                                    .heldContextMenu {
                                        HeldRow.button("Open in New Tab") { openInNewTab(site.url.absoluteString) }
                                        HeldRow.divider
                                        HeldRow.button("Remove from Suggested") { withAnimation(.ui) { utilities.history.remove(site) } }
                                    }
                                }
                            }
                        }
                    }
                }
                if !showsTools && !showsSuggestions {
                    Text("Search, or enter a URL above.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(20)
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.never)
    }

    private func replace(_ open: () -> Void) {
        withAnimation(.ui) { utilities.replace(tabID, with: open) }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.system(size: 15, weight: .semibold))
            content()
        }
    }
}

/// A tool on the new tab page: its symbol and name, and its shortcut in a chip.
private struct ToolCard: View {
    let title: String
    let symbol: String
    let shortcut: String?
    let action: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            // The shortcut only when there's room for it beside the name; the name stays on
            // one line either way.
            ViewThatFits(in: .horizontal) {
                row(showsShortcut: true)
                row(showsShortcut: false)
            }
            .padding(.horizontal, 14)
            .frame(height: 48)
            .background(Color.primary.opacity(isHovering ? 0.08 : 0.045), in: .rect(cornerRadius: 12))
            .contentShape(.rect(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .onHover { isHovering = $0 }
    }

    private func row(showsShortcut: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            Text(title)
                .font(.system(size: 14))
                .lineLimit(1)
                .fixedSize()
            Spacer(minLength: 6)
            if showsShortcut, let shortcut {
                Text(shortcut)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color.primary.opacity(0.07), in: .capsule)
                    .fixedSize()
            }
        }
    }
}

/// A suggested site: its icon large (its favicon, else its mark, else a globe; never a made-up
/// letter), its name under it on up to two lines.
private struct SiteTile: View {
    let site: BrowserHistory.Site
    let icon: NSImage?
    let action: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                Group {
                    if let icon {
                        Image(nsImage: icon)
                            .resizable()
                            .interpolation(.high)
                            .clipShape(.rect(cornerRadius: 8))
                    } else {
                        let mark = BrandMark.id(forSite: site.host)
                        BrandMarkView(mark ?? "", size: 22, fallback: mark == nil ? "globe" : nil)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Color.primary.opacity(0.07), in: .rect(cornerRadius: 8))
                    }
                }
                .frame(width: 40, height: 40)
                // Two lines, so names that start alike ("GitHub - …") still tell apart.
                Text(site.title.isEmpty ? site.host : site.title)
                    .font(.system(size: 13))
                    .lineLimit(2, reservesSpace: true)
                    .multilineTextAlignment(.center)
                    .truncationMode(.tail)
            }
            .padding(.vertical, 14)
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity)
            .background(isHovering ? Color.primary.opacity(0.05) : .clear, in: .rect(cornerRadius: 12))
            .contentShape(.rect(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .onHover { isHovering = $0 }
        .help(site.url.absoluteString)
    }
}
