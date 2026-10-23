import OpenCodeKit
import SwiftUI

/// Adding a machine: an SSH host this Mac can reach with its keys, checked before it's kept. In a
/// Settings page's place it's a grouped form, as Settings are; in an editor in the window (a bot's,
/// a project's), wells, as the editor's are.
struct MachineForm: View {
    enum Style { case settings, editor }

    var style: Style = .editor
    /// Called with the machine once it's added and connecting.
    var added: (String) -> Void = { _ in }
    let cancel: () -> Void

    @Environment(AppModel.self) private var app
    @State private var destination = ""
    @State private var hosts: [String] = []
    @State private var isChecking = false
    /// The check of the machine under way: Cancel (or leaving) stops it, so it isn't added after.
    @State private var checking: Task<Void, Never>?
    @State private var failure: String?
    @FocusState private var isFocused: Bool

    static let about = "A Linux server you reach with SSH, like a home server or a VPS. Its projects open next to this Mac’s, and their sessions run there."
    private static let how = "Kuvo Code connects with your SSH keys and agent, and installs its engine in ~/.kuvo-code there."

    var body: some View {
        Group {
            switch style {
            case .settings: settingsForm
            case .editor: editorForm
            }
        }
        .onAppear { isFocused = true }
        // Gone back from (Back, Escape in Settings): a check under way adds nothing.
        .onDisappear { checking?.cancel() }
        .task { hosts = await Task.detached { SSHConfig.hosts() }.value }
        .onChange(of: destination) { failure = nil }
    }

    private var settingsForm: some View {
        SettingsDetailPage {
            Section {
                SettingsTextRow(title: "SSH host") {
                    TextField("SSH host", text: $destination, prompt: Text(verbatim: "my-server or user@host"))
                        .autocorrectionDisabled()
                        .focused($isFocused)
                        .onSubmit(add)
                }
                ForEach(suggestions, id: \.self) { host in
                    Button { destination = host } label: {
                        Label(host, systemImage: "arrow.turn.down.right")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .contentShape(.rect)
                    }
                    .buttonStyle(ListRowButtonStyle(isSelected: false))
                    .padding(.horizontal, -6)
                }
            } footer: {
                note
            }
        } footer: {
            buttons(escapes: false)
        }
    }

    private var editorForm: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(Self.about)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 8) {
                WellGroup(isActive: isFocused) {
                    WellRow(isActive: isFocused) {
                        Image(systemName: "server.rack")
                    } content: {
                        TextField("SSH host", text: $destination, prompt: Text(verbatim: "my-server or user@host"))
                            .textFieldStyle(.plain)
                            .autocorrectionDisabled()
                            .focused($isFocused)
                            .onSubmit(add)
                    }
                    ForEach(suggestions, id: \.self) { host in
                        WellDivider()
                        Button { destination = host } label: {
                            WellRow {
                                Image(systemName: "arrow.turn.down.right")
                                    .font(.system(size: 12, weight: .medium))
                            } content: {
                                Text(host)
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(WellRowButtonStyle())
                    }
                }
                .font(.system(size: 15))
                note
                    .font(.callout)
            }
            buttons(escapes: true)
        }
    }

    /// Why it couldn't connect, or how it will.
    @ViewBuilder private var note: some View {
        if let failure {
            Text(failure)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        } else {
            Text(Self.how)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// In an editor in the window, Escape is its Cancel; in Settings, it's the page's way back.
    private func buttons(escapes: Bool) -> some View {
        EditorFooter(primary: "Add Machine", canDoPrimary: !trimmed.isEmpty, onPrimary: add, onCancel: { checking?.cancel(); cancel() }, cancelsOnEscape: escapes,
                     working: isChecking ? "Connecting…" : nil)
    }

    private var trimmed: String { destination.trimmingCharacters(in: .whitespaces) }

    /// Hosts from `~/.ssh/config` that match what's typed, leaving out the ones added already (as
    /// a machine, or one of a machine's addresses).
    private var suggestions: [String] {
        let added = Set(app.machines.list.flatMap(\.addresses))
        let matches = hosts.filter { !added.contains($0) && $0 != trimmed && (trimmed.isEmpty || $0.localizedCaseInsensitiveContains(trimmed)) }
        return Array(matches.prefix(4))
    }

    private func add() {
        let destination = trimmed
        guard !destination.isEmpty, !isChecking else { return }
        isChecking = true
        failure = nil
        checking = Task {
            defer { isChecking = false }
            do {
                added(try await app.addMachine(checking: destination).id)
            } catch {
                if !Task.isCancelled { failure = error.localizedDescription }
            }
        }
    }
}

extension MachineForm {
    /// Why a destination can't name a machine here, or nil: a host, or user@host, as `ssh` takes
    /// one, or a Host from ~/.ssh/config.
    static func problem(with destination: String) -> String? {
        let fits = !destination.hasPrefix("-") && destination.rangeOfCharacter(from: CharacterSet(charactersIn: "/:").union(.whitespacesAndNewlines)) == nil
        return fits ? nil : "Give a host name, or user@host. For a port or an IPv6 address, add a Host for the machine to ~/.ssh/config and give its name."
    }
}

/// The hosts named in `~/.ssh/config` (and the files it includes), without patterns. `home` is
/// whose (a test's own).
nonisolated enum SSHConfig {
    static func hosts(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [String] {
        var hosts: [String] = []
        var seen = Set<String>()
        func read(_ url: URL, depth: Int) {
            guard depth < 4, let text = try? String(contentsOf: url, encoding: .utf8) else { return }
            for line in text.split(whereSeparator: \.isNewline) {
                let words = line.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "=" }).map(String.init)
                guard let keyword = words.first?.lowercased(), !keyword.hasPrefix("#") else { continue }
                if keyword == "host" {
                    // Up to a comment (Host box # home server).
                    for host in words.dropFirst().prefix(while: { !$0.hasPrefix("#") }) where !host.contains(where: { "*?!".contains($0) }) && seen.insert(host).inserted {
                        hosts.append(host)
                    }
                } else if keyword == "include" {
                    for pattern in words.dropFirst().prefix(while: { !$0.hasPrefix("#") }) {
                        let path = pattern.hasPrefix("~/") ? home.appending(path: String(pattern.dropFirst(2))).path
                            : pattern.hasPrefix("/") ? pattern : home.appending(path: ".ssh/" + pattern).path
                        for match in glob(path) { read(URL(filePath: match), depth: depth + 1) }
                    }
                }
            }
        }
        read(home.appending(path: ".ssh/config"), depth: 0)
        return hosts
    }

    private static func glob(_ pattern: String) -> [String] {
        var result = glob_t()
        defer { globfree(&result) }
        guard Darwin.glob(pattern, 0, nil, &result) == 0 else { return [] }
        return (0..<Int(result.gl_pathc)).compactMap { result.gl_pathv[$0].map { String(cString: $0) } }
    }
}
