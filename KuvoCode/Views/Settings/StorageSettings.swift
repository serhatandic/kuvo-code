import AppKit
import ClientDesign
import KuvoLink
import OpenCodeKit
import SwiftUI

/// Storage: what Kuvo Code keeps on this Mac, by kind, as a bar, and the room you can get back.
struct StorageSettings: View {
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    @Environment(\.accent) private var accent
    @State private var report: StorageReport?
    @State private var cleaningUp = false
    @State private var confirmingLogs = false
    @State private var confirmingDownloads = false
    /// What this Mac's box keeps of what agents made, as it says (`kuvo/artifacts/storage`).
    @State private var made: ArtifactStorage?
    @State private var madeFailure: String?
    @State private var confirmingOlder = false
    /// A smaller budget than older versions take now, waiting for your yes: it clears some.
    @State private var lowering: Double?
    /// Whose: this Mac's box, or a machine's (each keeps its own).
    @State private var madeBox = BoxClient.thisMac

    var body: some View {
        ScrollingSettingsForm {
            Section {
                if let report {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(alignment: .firstTextBaseline) {
                            Text("\(Self.format(report.total)) used by Kuvo Code")
                                .font(.headline)
                            Spacer()
                            Button("Refresh") { Task { await load() } }
                        }
                        let shown = report.shown
                        StorageBar(kinds: shown, total: report.total)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), alignment: .leading)], alignment: .leading, spacing: 10) {
                            ForEach(Array(shown.enumerated()), id: \.element.id) { index, kind in
                                HStack(alignment: .firstTextBaseline, spacing: 7) {
                                    Circle().fill(StorageReport.color(kind, at: index, of: shown.count, accent: accent)).frame(width: 8, height: 8)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(kind.title)
                                        Text(Self.format(kind.size))
                                            .font(.callout)
                                            .foregroundStyle(.secondary)
                                            .monospacedDigit()
                                    }
                                }
                                .help(kind.id == .other ? report.otherDetail : kind.detail)
                            }
                        }
                        Button {
                            NSWorkspace.shared.activateFileViewerSelecting([AppInfo.supportDirectory])
                        } label: {
                            Text((AppInfo.supportDirectory.path as NSString).abbreviatingWithTildeInPath)
                                .font(.callout.monospaced())
                        }
                        .buttonStyle(TextButtonStyle(outset: true))
                        .help("Show in Finder")
                    }
                    .padding(.vertical, 6)
                } else {
                    HStack(spacing: 8) {
                        Spinner(size: 16)
                        Text("Adding it up…").foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                }
            } header: {
                Text("This Mac")
            } footer: {
                // Each machine keeps its own, which this page can't measure yet.
                if !app.machines.list.isEmpty {
                    Text(Self.machinesNote)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                LabeledContent {
                    Button("Review…") { cleaningUp = true }
                } label: {
                    Text("Clean up old sessions")
                    Text("Delete sessions you haven’t used in a while, with their messages and undo snapshots.")
                }
                LabeledContent {
                    Button("Manage") { app.settingsTabs.show(.archived) }
                } label: {
                    Text("Archived sessions")
                    Text(archivedCount == 0 ? "None." : "\(archivedCount.counting("session")), out of the sidebar but still taking room.")
                }
                LabeledContent {
                    Button("Manage") { app.settingsTabs.show(.worktrees) }
                } label: {
                    Text("Worktrees")
                    Text("Sessions’ own copies of a project, on a branch.")
                }
                LabeledContent {
                    Button("Manage") { app.settingsTabs.show(.browser) }
                } label: {
                    Text("Website data")
                    Text("What sites keep in the panel’s browser.")
                }
            } header: {
                Text("Sessions and Projects")
            }

            Section {
                // (This Mac's box first, attached in place too, then the machines.)
                let machines = app.machines.list.filter { !$0.isThisMac }
                if !machines.isEmpty {
                    Picker("Computer", selection: $madeBox) {
                        Text("This Mac").tag(BoxClient.thisMac)
                        ForEach(machines) { machine in Text(machine.name).tag(machine.id) }
                    }
                    .onChange(of: madeBox) { made = nil; madeFailure = nil; Task { await loadMade() } }
                }
                if let made {
                    LabeledContent {
                        Text(Self.format(Int64(made.copies)))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    } label: {
                        Text("Copies of what agents made")
                        Text("Each version of the files agents write or change, so you can see what changed and put one back. Never what looks like a secret, and only the changes for code git keeps.")
                    }
                    Picker(selection: Binding(get: { Self.budgetChoice(made.budget) }, set: { budget in
                        // Less than older versions take now clears some of them: asked first.
                        if budget < made.older { lowering = budget } else { Task { await setBudget(budget) } }
                    })) {
                        ForEach(Self.budgets, id: \.self) { Text(Self.format(Int64($0))).tag($0) }
                    } label: {
                        Text("Older versions keep up to")
                        Text("Past it, the oldest go first. The newest version of each file, memory, skills and what’s kept always stay.")
                    }
                    LabeledContent {
                        Button("Clear…") { confirmingOlder = true }
                            .disabled(made.older == 0)
                    } label: {
                        Text("Older versions")
                        Text(made.older == 0 ? "None kept." : "\(Self.format(Int64(made.older))) now.")
                    }
                    if made.low {
                        Label("The disk is nearly full, so only the newest version of each file keeps a copy until \(Self.format(Int64(made.floor))) is free again.", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                            .font(.callout)
                    }
                } else if madeFailure == nil {
                    HStack(spacing: 8) {
                        Spinner(size: 14)
                        Text("Adding it up…").foregroundStyle(.secondary)
                    }
                }
                if let madeFailure {
                    Label(madeFailure, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                        .font(.callout)
                }
            } header: {
                Text("What Agents Made")
            }

            Section {
                LabeledContent {
                    Button("Delete…") { confirmingLogs = true }
                        .disabled((report?.size(of: .logs) ?? 0) == 0)
                } label: {
                    Text("Logs")
                    Text("What the engine and the app wrote down while running, for troubleshooting.")
                }
                LabeledContent {
                    Button("Delete…") { confirmingDownloads = true }
                        .disabled((report?.linuxEngine ?? 0) == 0 || machineInstalling)
                } label: {
                    Text("Downloads for machines")
                    Text(machineInstalling ? "A machine is being set up with them now." : "The engine and browser for machines, kept to set up another machine without downloading them again.")
                }
            } header: {
                Text("Files You Can Delete")
            }
        }
        .task { await load() }
        .settingsDetail(isPresented: $cleaningUp, title: "Clean Up Old Sessions", onDismiss: { Task { await load() } }) {
            OldSessions { cleaningUp = false }
        }
        .confirmationDialog("Keep less of older versions?", isPresented: Binding(get: { lowering != nil }, set: { if !$0 { lowering = nil } }), presenting: lowering) { budget in
            Button("Keep up to \(Self.format(Int64(budget)))", role: .destructive) { Task { await setBudget(budget) } }
        } message: { _ in
            Text("Older versions take \(Self.format(Int64(made?.older ?? 0))) now, so the oldest of their copies go until they fit. The newest version of each file, memory, skills and what’s kept stay.")
        }
        .confirmationDialog("Clear older versions?", isPresented: $confirmingOlder) {
            Button("Clear", role: .destructive) { Task { await clearOlder() } }
        } message: {
            Text("Their copies go; each stays listed, without one. The newest version of each file, memory, skills and what’s kept stay.")
        }
        .confirmationDialog("Delete the logs?", isPresented: $confirmingLogs) {
            Button("Delete", role: .destructive) {
                Task {
                    await Task.detached { StorageReport.deleteLogs() }.value
                    await load()
                }
            }
        } message: {
            Text("New ones start right away. Your sessions aren’t affected.")
        }
        .confirmationDialog("Delete the downloads for machines?", isPresented: $confirmingDownloads) {
            Button("Delete", role: .destructive) {
                let folders = [StorageReport.linuxEngineFolder, StorageReport.oldBrowserFolder]
                Task {
                    // Often hundreds of MB: not on the main thread.
                    await Task.detached { for folder in folders { try? FileManager.default.removeItem(at: folder) } }.value
                    await load()
                }
            }
        } message: {
            Text("Machines you’ve added keep their engine and browser. A new one downloads them again.")
        }
    }

    static let machinesNote = "Only this Mac. A machine’s sessions and logs aren’t shown here yet."

    /// A machine being set up reads the downloads meanwhile: they stay until it's done.
    private var machineInstalling: Bool {
        app.machines.engines.values.contains { engine in
            engine.connection == .installing
        }
    }

    private var archivedCount: Int {
        workspace.sessions.filter { Workspace.isArchived($0) && !RemoteFolder.isRemote($0.location.directory) }.count
    }

    /// The budgets to pick from for older versions.
    static let budgets: [Double] = [256, 512, 1024, 2048, 5120, 10240].map { $0 * 1024 * 1024 }

    /// The one shown for `budget`: the nearest (one set elsewhere may be between).
    static func budgetChoice(_ budget: Double) -> Double {
        budgets.min { abs($0 - budget) < abs($1 - budget) } ?? budget
    }

    /// What `madeBox` keeps, unless another computer was picked meanwhile; a problem said so far
    /// stays (`keepsFailure`), for a Clear that didn't work.
    private func loadMade(keepsFailure: Bool = false) async {
        let asked = madeBox
        do {
            let storage = try await app.box(asked).value(ArtifactStorage.self, "GET", "kuvo/artifacts/storage")
            guard asked == madeBox else { return }
            made = storage
            if !keepsFailure { madeFailure = nil }
        } catch {
            guard asked == madeBox else { return }
            if made == nil { madeFailure = error.localizedDescription }
        }
    }

    private func setBudget(_ budget: Double) async {
        struct Budget: Encodable { var budget: Double }
        do {
            made = try await app.box(madeBox).value(ArtifactStorage.self, "POST", "kuvo/artifacts/storage", body: Budget(budget: budget))
            madeFailure = nil
        } catch {
            madeFailure = error.localizedDescription
        }
    }

    private func clearOlder() async {
        madeFailure = nil
        do {
            let (status, data) = try await app.box(madeBox).send("POST", "kuvo/artifacts/storage/clear", body: Data("{}".utf8))
            if !(200..<300).contains(status) { madeFailure = BoxRefusal(status: status, data: data).message }
        } catch {
            madeFailure = error.localizedDescription
        }
        await loadMade(keepsFailure: true)
    }

    /// This Mac's measured beside what agents made on the picked computer: a machine slow to
    /// answer, or away, doesn't hold this Mac's numbers back.
    private func load() async {
        async let madeLoaded: Void = loadMade()
        let worktrees = Array(Set(workspace.worktrees.values.map(\.root))).filter { !RemoteFolder.isRemote($0) }
        report = await Task.detached { StorageReport.measure(worktrees: worktrees) }.value
        await madeLoaded
    }

    static func format(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

/// The parts of the total, side by side in one bar.
private struct StorageBar: View {
    let kinds: [StorageReport.Kind]
    let total: Int64
    @Environment(\.accent) private var accent

    var body: some View {
        GeometryReader { proxy in
            HStack(spacing: 2) {
                ForEach(Array(kinds.enumerated()), id: \.element.id) { index, kind in
                    StorageReport.color(kind, at: index, of: kinds.count, accent: accent)
                        .frame(width: max(3, proxy.size.width * CGFloat(kind.size) / CGFloat(max(total, 1)) - 2))
                }
                Spacer(minLength: 0)
            }
        }
        .frame(height: 14)
        .background(.quaternary)
        .clipShape(.capsule)
        // Each part is listed beside it, with its size.
        .accessibilityHidden(true)
    }
}

/// What Kuvo Code keeps on this Mac, measured.
nonisolated struct StorageReport: Sendable {
    enum KindID: String, Sendable { case sessions, snapshots, logs, engine, agents, worktrees, browser, attachments, other }

    struct Kind: Identifiable, Sendable {
        let id: KindID
        let size: Int64

        var title: String {
            switch id {
            case .sessions: "Sessions"
            case .snapshots: "Undo snapshots"
            case .logs: "Logs"
            case .engine: "Engine"
            case .agents: "Coding agents"
            case .worktrees: "Worktrees"
            case .browser: "Browser"
            case .attachments: "Attachments"
            case .other: "Other"
            }
        }

        var detail: String {
            switch id {
            case .sessions: "Your sessions’ messages, and your accounts and settings."
            case .snapshots: "Copies of files the agent changed, so Undo From Here can put them back."
            case .logs: "What the engine and the app wrote down while running."
            case .engine: "The opencode engine, and its builds for machines."
            case .agents: "Claude Code, Codex and the other coding agents, installed the first time each is used."
            case .worktrees: "Sessions’ own copies of a project."
            case .browser: "The panel browser’s website data and history."
            case .attachments: "Files you pasted into messages."
            case .other: "Caches, command output, your bots’ and chats’ folders, and the usage menu’s files."
            }
        }

    }

    /// What the page lists, largest first: none that's empty, and any under 1% of the total in
    /// Other, which comes last.
    var shown: [Kind] {
        let total = max(self.total, 1)
        let parts = kinds.filter { $0.id != .other && $0.size > 0 }
        let other = size(of: .other) + folded.reduce(0) { $0 + $1.size }
        let large = parts.filter { Double($0.size) / Double(total) >= 0.01 }.sorted { $0.size > $1.size }
        return large + (other > 0 ? [Kind(id: .other, size: other)] : [])
    }

    /// The kinds too small to show on their own, counted in Other.
    var folded: [Kind] {
        let total = max(self.total, 1)
        return kinds.filter { $0.id != .other && $0.size > 0 && Double($0.size) / Double(total) < 0.01 }
    }

    /// Other's tooltip, naming the kinds it took in.
    var otherDetail: String {
        let other = Kind(id: .other, size: 0).detail
        let names = folded.map(\.title).formatted(.list(type: .and))
        return folded.isEmpty ? other : "\(other) Also \(names), too small to show apart."
    }

    /// One ramp of the accent, deepest for the largest; Other in gray.
    static func color(_ kind: Kind, at index: Int, of count: Int, accent: Color) -> Color {
        if kind.id == .other { return Color.secondary.opacity(0.5) }
        let steps = max(count - 1, 1)
        return accent.opacity(1 - 0.65 * Double(index) / Double(steps))
    }

    let kinds: [Kind]
    let linuxEngine: Int64

    var total: Int64 { kinds.reduce(0) { $0 + $1.size } }

    func size(of id: KindID) -> Int64 { kinds.first { $0.id == id }?.size ?? 0 }

    static var support: URL { AppInfo.supportDirectory }
    static var engineData: URL { support.appending(path: "opencode/data/opencode") }
    static var linuxEngineFolder: URL { support.appending(path: "engine-linux") }
    /// Where this Mac put the browser together for machines before their boxes set it up
    /// themselves: removed once (`MachineBrowser`), and meanwhile shown and deleted with the
    /// downloads for machines.
    static var oldBrowserFolder: URL { support.appending(path: "browser-linux") }
    static var appLogs: URL { URL.libraryDirectory.appending(path: "Logs/\(AppInfo.name)") }

    static func measure(worktrees: [String]) -> StorageReport {
        let home = URL.libraryDirectory
        let bundleID = Bundle.main.bundleIdentifier ?? "run.kuvo.code"
        // What's in the data folder and none of the kinds below is Other, so they add up to all of
        // it, whatever is added there.
        let data = support.standardizedFileURL.path(percentEncoded: false)
        var inData: Int64 = 0
        func size(of url: URL) -> Int64 {
            let bytes = Self.size(of: url)
            if url.standardizedFileURL.path(percentEncoded: false).hasPrefix(data.hasSuffix("/") ? data : data + "/") { inData += bytes }
            return bytes
        }
        let sessions = ["opencode.db", "opencode.db-wal", "opencode.db-shm"].reduce(Int64(0)) { $0 + size(of: engineData.appending(path: $1)) }
            + size(of: support.appending(path: "opencode/config"))
        let snapshots = size(of: engineData.appending(path: "snapshot"))
        let logs = size(of: engineData.appending(path: "log")) + size(of: appLogs)
        let linux = size(of: linuxEngineFolder) + size(of: oldBrowserFolder)
        let engine = size(of: support.appending(path: "engine")) + linux
        let agents = size(of: support.appending(path: "agents"))
        let trees = worktrees.reduce(Int64(0)) { $0 + size(of: URL(filePath: $1)) }
        let browser = size(of: home.appending(path: "WebKit/\(bundleID)")) + size(of: home.appending(path: "HTTPStorages/\(bundleID)"))
            + size(of: support.appending(path: "Browser"))
        let attachments = size(of: support.appending(path: "Attachments"))
        let other = max(0, Self.size(of: support) - inData) + size(of: home.appending(path: "Caches/\(bundleID)"))
        return StorageReport(kinds: [
            Kind(id: .sessions, size: sessions),
            Kind(id: .snapshots, size: snapshots),
            Kind(id: .worktrees, size: trees),
            Kind(id: .engine, size: engine),
            Kind(id: .agents, size: agents),
            Kind(id: .browser, size: browser),
            Kind(id: .attachments, size: attachments),
            Kind(id: .logs, size: logs),
            Kind(id: .other, size: other),
        ], linuxEngine: linux)
    }

    /// The space a file or folder takes on disk.
    static func size(of url: URL) -> Int64 {
        let keys: Set<URLResourceKey> = [.totalFileAllocatedSizeKey, .isRegularFileKey]
        guard let values = try? url.resourceValues(forKeys: keys) else { return 0 }
        if values.isRegularFile == true { return Int64(values.totalFileAllocatedSize ?? 0) }
        guard let walker = FileManager.default.enumerator(at: url, includingPropertiesForKeys: Array(keys)) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in walker {
            guard let values = try? file.resourceValues(forKeys: keys), values.isRegularFile == true else { continue }
            total += Int64(values.totalFileAllocatedSize ?? 0)
        }
        return total
    }

    /// The engine's logs but the one it's writing, and the app's.
    static func deleteLogs() {
        let fm = FileManager.default
        let engineLogs = (try? fm.contentsOfDirectory(at: engineData.appending(path: "log"), includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let newest = engineLogs.max { a, b in
            ((try? a.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast)
                < ((try? b.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast)
        }
        for log in engineLogs where log != newest { try? fm.removeItem(at: log) }
        // The one being written is emptied rather than removed, so the engine keeps writing to it.
        if let newest, let handle = try? FileHandle(forWritingTo: newest) {
            try? handle.truncate(atOffset: 0)
            try? handle.close()
        }
        // The usage item's own log is open too: emptied, the rest removed.
        for log in (try? fm.contentsOfDirectory(at: appLogs, includingPropertiesForKeys: nil)) ?? [] {
            if log.lastPathComponent == "Usage.log", let handle = try? FileHandle(forWritingTo: log) {
                try? handle.truncate(atOffset: 0)
                try? handle.close()
            } else {
                try? fm.removeItem(at: log)
            }
        }
    }
}

/// Picking sessions to delete by how long they've gone unused, with what that would take: in the
/// page's place.
private struct OldSessions: View {
    let done: () -> Void
    @Environment(Workspace.self) private var workspace
    @State private var days = 90
    @State private var keepsPinned = true
    @State private var isDeleting = false
    /// Why some couldn't be deleted, the last time: they stay listed.
    @State private var failure: String?

    /// This Mac's sessions unused for the chosen time (`Workspace.oldSessions`).
    private var old: [Session] {
        workspace.oldSessions(unusedSince: (Date.now.timeIntervalSince1970 - Double(days) * 86_400) * 1000, keepsPinned: keepsPinned)
    }

    var body: some View {
        SettingsDetailPage {
            Section {
                Picker("Unused for more than", selection: $days) {
                    ForEach([30, 90, 180, 365], id: \.self) { Text($0 == 365 ? "a year" : "\($0) days").tag($0) }
                }
                Toggle("Keep pinned sessions", isOn: $keepsPinned)
            }
            Section {
                if old.isEmpty {
                    Text("None unused for that long.").foregroundStyle(.secondary)
                }
                ForEach(old.prefix(200)) { session in
                    LabeledContent {
                        Text(Date(timeIntervalSince1970: session.time.updated / 1000), format: .relative(presentation: .named))
                            .foregroundStyle(.secondary)
                    } label: {
                        Text(session.title ?? "New Session")
                        Text(workspace.projectName(of: session))
                    }
                }
            } header: {
                Text(old.isEmpty ? "Sessions" : old.count.counting("Session"))
            } footer: {
                Text("Deleting can’t be undone.")
                    .foregroundStyle(.secondary)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 10) {
                if let failure {
                    Text(failure)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                EditorFooter(primary: old.isEmpty ? "Delete Sessions" : "Delete " + old.count.counting("Session"), canDoPrimary: !old.isEmpty && !isDeleting, onPrimary: delete,
                             isDestructive: true, onCancel: done, working: isDeleting ? "Deleting…" : nil)
            }
        }
    }

    /// Back to Storage once they're all gone; any that couldn't be stay listed here, and why is said.
    private func delete() {
        isDeleting = true
        failure = nil
        let ids = old.map(\.id)
        Task {
            var failed: [Error] = []
            for id in ids {
                do { try await workspace.delete(id) } catch { failed.append(error) }
            }
            isDeleting = false
            if let first = failed.first {
                failure = "Couldn’t delete \(failed.count.counting("session")): \(first.localizedDescription)"
            } else {
                done()
            }
        }
    }
}
