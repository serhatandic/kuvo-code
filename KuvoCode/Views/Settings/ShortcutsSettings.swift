import SwiftUI

/// Every keyboard shortcut, by where it's used, with a search field.
struct ShortcutsSettings: View {
    @State private var search = ""

    private struct Shortcut: Identifiable {
        let keys: [String]
        let title: String
        var id: String { title }
    }

    private static let groups: [(title: String, shortcuts: [Shortcut])] = [
        ("General", [
            Shortcut(keys: ["⌘", "K"], title: "Command palette"),
            Shortcut(keys: ["⌘", "N"], title: "New session"),
            Shortcut(keys: ["⌥", "⌘", "N"], title: "New chat"),
            Shortcut(keys: ["⇧", "⌘", "N"], title: "New project"),
            Shortcut(keys: ["⌘", "O"], title: "Open a folder as a project"),
            Shortcut(keys: ["⇧", "⌘", "O"], title: "Open Quickly: a project file by name"),
            Shortcut(keys: ["⇧", "⌘", "K"], title: "Accounts"),
            Shortcut(keys: ["⌘", ","], title: "Settings"),
        ]),
        ("Sessions", [
            Shortcut(keys: ["⌘", "."], title: "Stop the agent (or Esc in the composer)"),
            Shortcut(keys: ["⌘", "F"], title: "Find in the conversation"),
            Shortcut(keys: ["⌥", "⌘", "1"], title: "Build mode"),
            Shortcut(keys: ["⌥", "⌘", "2"], title: "Plan mode"),
        ]),
        ("Tabs and Window", [
            Shortcut(keys: ["⌘", "W"], title: "Close the session tab"),
            Shortcut(keys: ["⇧", "⌘", "W"], title: "Close the window"),
            Shortcut(keys: ["⇧", "⌘", "T"], title: "Reopen the tab you closed last"),
            Shortcut(keys: ["⌃", "Tab"], title: "Next session tab"),
            Shortcut(keys: ["⌃", "⇧", "Tab"], title: "Previous session tab"),
            Shortcut(keys: ["⌘", "1 – 8"], title: "That session tab"),
            Shortcut(keys: ["⌘", "9"], title: "The last session tab"),
            Shortcut(keys: ["⌘", "0"], title: "Show or hide the sidebar"),
            Shortcut(keys: ["⌥", "⌘", "T"], title: "Show or hide the tab bar"),
        ]),
        ("Side Panel", [
            Shortcut(keys: ["⌥", "⌘", "0"], title: "Show or hide the panel"),
            Shortcut(keys: ["⌥", "⌘", "I"], title: "Changes"),
            Shortcut(keys: ["⌥", "⌘", "F"], title: "Files"),
            Shortcut(keys: ["⌃", "`"], title: "New terminal"),
            Shortcut(keys: ["⌃", "⇧", "`"], title: "New terminal tab"),
            Shortcut(keys: ["⌘", "R"], title: "Run the project’s run command"),
            Shortcut(keys: ["⌥", "⌘", "B"], title: "New browser tab"),
            Shortcut(keys: ["⌘", "+ / −"], title: "Zoom a machine's page in or out"),
        ]),
        ("Composer", [
            Shortcut(keys: ["Return"], title: "Send"),
            Shortcut(keys: ["⌘", "Return"], title: "Queue for after the agent is done"),
            Shortcut(keys: ["⇧", "Return"], title: "New line"),
            Shortcut(keys: ["↑"], title: "In an empty composer: the last waiting message, then what you sent before"),
            Shortcut(keys: ["/"], title: "At the start: a command"),
            Shortcut(keys: ["!"], title: "At the start: run a shell command"),
            Shortcut(keys: ["@"], title: "Mention a file"),
        ]),
        ("Model Picker", [
            Shortcut(keys: ["⌘", "1 – 9"], title: "That model in the list"),
            Shortcut(keys: ["⌥", "↑ / ↓"], title: "The provider above or below"),
            Shortcut(keys: ["← / →"], title: "On the effort: lower or higher"),
        ]),
    ]

    var body: some View {
        ScrollingSettingsForm {
            Section {
                SettingsSearchRow(text: $search, prompt: "Search shortcuts")
            }
            let groups = Self.groups.map { group in
                (group.title, group.shortcuts.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.keys.joined().localizedCaseInsensitiveContains(search) })
            }.filter { !$0.1.isEmpty }
            if groups.isEmpty {
                Section { Text("No shortcut matches “\(search)”.").foregroundStyle(.secondary) }
            }
            ForEach(groups, id: \.0) { title, shortcuts in
                Section(title) {
                    ForEach(shortcuts) { shortcut in
                        LabeledContent(shortcut.title) {
                            HStack(spacing: 4) {
                                ForEach(shortcut.keys, id: \.self) { KeyCap(key: $0) }
                            }
                        }
                    }
                }
            }
            Section {
                Text("To change a menu command’s shortcut, use System Settings › Keyboard › Keyboard Shortcuts › App Shortcuts.")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// A key, drawn as a small cap.
private struct KeyCap: View {
    let key: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Text(key)
            .font(.system(size: 12, weight: .medium, design: .rounded))
            .padding(.horizontal, 7)
            .frame(minWidth: 24, minHeight: 22)
            .background(Surface.well(scheme), in: .rect(cornerRadius: 6))
            .overlay { RoundedRectangle(cornerRadius: 6).strokeBorder(Surface.wellBorder(scheme), lineWidth: 1) }
    }
}
