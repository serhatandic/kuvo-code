import ClientDesign
import KuvoLink
import SwiftUI

extension View {
    /// Branch Backups for the repository `folder` is in, as the app names the folder (a machine's
    /// starts `ssh://`), read and taken back through the box it's on.
    func branchBackupsSheet(isPresented: Binding<Bool>, folder: String) -> some View {
        modifier(BranchBackupsPresenter(isPresented: isPresented, folder: folder))
    }
}

private struct BranchBackupsPresenter: ViewModifier {
    @Binding var isPresented: Bool
    let folder: String
    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $isPresented) {
                let remote = RemoteFolder.parse(folder)
                BranchBackupsSheet(folder: remote?.path ?? folder, box: BranchBackupsSheet.box(remote?.machine ?? BoxClient.thisMac, app: app))
            }
            .closesWhenKept($isPresented)
    }
}

/// A repository's branch backups, newest first, each with what taking it back would bring back
/// now, and Take Back. Taken as each agent turn starts and ends; taking one back never moves a
/// branch you have.
struct BranchBackupsSheet: View {
    @State private var backups: BranchBackups
    @Environment(\.dismiss) private var dismiss

    /// `folder`: as its box names it (on a machine, the path there).
    init(folder: String, box: BoxClient) {
        _backups = State(initialValue: BranchBackups(box: box, folder: folder))
    }

    private var listing: BranchBackups.Listing? {
        if case .listed(let listing) = backups.shown { listing } else { nil }
    }

    /// The repository's name, or the folder's before one is known.
    private var name: String {
        ((listing?.repository ?? backups.folder) as NSString).lastPathComponent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            notes
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .buttonStyle(.glass)
                    .controlSize(.large)
            }
            .padding(.horizontal, 28)
            .padding(.top, 14)
            .padding(.bottom, 24)
        }
        .frame(width: 520, height: 520)
        .animation(.ui, value: backups.outcome)
        .task {
            await backups.load()
            #if DEBUG
            // KUVO_DEMO_BRANCH_BACKUPS=restored or gone-restored: the first one with something to
            // bring back taken back, as if Take Back was pressed.
            if ProcessInfo.processInfo.environment["KUVO_DEMO_BRANCH_BACKUPS"]?.hasSuffix("restored") == true, let listing,
               let first = listing.backups.first(where: { BranchBackups.bringsBack($0, exists: listing.exists) }) {
                await backups.takeBack(first)
            }
            #endif
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Branch Backups")
                .font(.title2.weight(.bold))
                .accessibilityAddTraits(.isHeader)
            Text("\(name) · taken as each turn started and ended. Taking one back never moves a branch you have.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 28)
        .padding(.top, 24)
        .padding(.bottom, 14)
    }

    /// The repository's `.git` gone, and what the last Take Back did.
    @ViewBuilder private var notes: some View {
        let isGone = listing.map { $0.repository != nil && !$0.exists && !$0.backups.isEmpty } ?? false
        if isGone || backups.outcome != nil {
            VStack(alignment: .leading, spacing: 10) {
                if isGone {
                    note("\(name)’s .git is gone. Take Back makes it again around the files as they are.", symbol: "exclamationmark.triangle.fill", tint: .orange)
                }
                switch backups.outcome {
                case .restored(let words, let missed):
                    note(words + (missed.isEmpty ? "" : "\nDidn’t come back: " + missed.joined(separator: "; ")), symbol: "checkmark.circle.fill", tint: .green)
                case .failed(let message):
                    note("Couldn’t take it back. \(message)", symbol: "xmark.octagon.fill", tint: .red)
                case nil:
                    EmptyView()
                }
            }
            .padding(.horizontal, 28)
            .padding(.bottom, 14)
            .transition(.opacity)
        }
    }

    private func note(_ words: String, symbol: String, tint: Color) -> some View {
        Label {
            Text(words)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(tint)
        }
        .font(.callout)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var content: some View {
        switch backups.shown {
        case .loading:
            Spinner(size: 16)
                .accessibilityLabel("Loading")
        case .failed(let message):
            centered("Couldn’t read the backups", message) {
                Button("Try Again") { Task { await backups.load() } }
                    .buttonStyle(.glass)
            }
        case .listed(let listing) where listing.repository == nil:
            centered("No backups here yet", "Backups are taken of a git repository as each turn starts and ends.")
        case .listed(let listing) where listing.backups.isEmpty:
            centered("No backups yet", "Backups are taken as each turn starts and ends.")
        case .listed(let listing):
            rows(listing)
        }
    }

    private func centered(_ title: String, _ message: String, @ViewBuilder action: () -> some View = { EmptyView() }) -> some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.headline)
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            action()
                .padding(.top, 4)
        }
        .padding(.horizontal, 40)
        .padding(.bottom, 20)
    }

    private func rows(_ listing: BranchBackups.Listing) -> some View {
        // The first one with something to bring back is the one you most likely want.
        let first = listing.backups.first { BranchBackups.bringsBack($0, exists: listing.exists) }?.id
        let now = Date.now
        return ScrollView {
            WellGroup {
                ForEach(Array(listing.backups.enumerated()), id: \.element.id) { index, backup in
                    if index > 0 { WellDivider() }
                    BackupRow(backup: backup, exists: listing.exists, now: now, isProminent: backup.id == first,
                              isRestoring: backups.restoring == backup.id, isBusy: backups.restoring != nil) {
                        Task {
                            await backups.takeBack(backup)
                        }
                    }
                }
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 2)
        }
        .scrollBounceBehavior(.basedOnSize)
        .fadingScrollEdges()
    }

    /// This Mac's box, or a machine's; a stand-in with sample backups in a demo copy
    /// (`KUVO_DEMO_BRANCH_BACKUPS`).
    static func box(_ id: String, app: AppModel) -> BoxClient {
        #if DEBUG
        if let sample = ProcessInfo.processInfo.environment["KUVO_DEMO_BRANCH_BACKUPS"] { return DemoBackups.box(sample) }
        #endif
        return app.box(id)
    }
}

/// One backup: when, what taking it back brings back now, and Take Back.
private struct BackupRow: View {
    let backup: BranchBackups.Backup
    let exists: Bool
    let now: Date
    let isProminent: Bool
    let isRestoring: Bool
    /// Another one is being taken back.
    let isBusy: Bool
    let takeBack: () -> Void

    private var when: String { BranchBackups.when(backup.date, now: now) }
    private var bringsBack: Bool { BranchBackups.bringsBack(backup, exists: exists) }

    /// The detail, with branches deleted since in orange.
    private var detail: AttributedString {
        var line = AttributedString()
        for (index, part) in BranchBackups.detail(backup, exists: exists, shortened: true).enumerated() {
            if index > 0 { line += AttributedString(" · ") }
            var piece = AttributedString(part.text)
            if part.warns { piece.foregroundColor = .orange }
            line += piece
        }
        return line
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(when)
                    .monospacedDigit()
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(when). \(BranchBackups.detailLine(backup, exists: exists))")
            .help(backup.head.isEmpty ? BranchBackups.detailLine(backup, exists: exists)
                  : "On \(backup.head) then. \(BranchBackups.detailLine(backup, exists: exists))")
            Spacer(minLength: 8)
            Button(action: takeBack) {
                HStack(spacing: 6) {
                    if isRestoring { Spinner(size: 12) }
                    Text("Take Back")
                }
            }
            .buttonStyle(isProminent && !isBusy ? AnyPrimitiveButtonStyle(.glassProminent) : AnyPrimitiveButtonStyle(.glass))
            .disabled(!bringsBack || isBusy)
            .accessibilityLabel(isRestoring ? "Taking Back" : "Take Back")
            .accessibilityHint(bringsBack ? "The backup from \(when)" : "Nothing to bring back")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(minHeight: 52)
    }
}

#if DEBUG
/// Sample backups for a demo copy, without a box: `KUVO_DEMO_BRANCH_BACKUPS` = `listed` (some to
/// bring back, many rows), `gone` (the repository's `.git` gone), `empty`, `none` (no repository),
/// `failed`, or `old` (a box from before backups); `restored` and `gone-restored`, `listed` and
/// `gone` with one taken back. Take Back answers as a box would.
nonisolated enum DemoBackups {
    @MainActor static func box(_ sample: String) -> BoxClient {
        BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            let (status, body) = answer(sample, request)
            return AsyncThrowingStream { continuation in
                Task {
                    try? await Task.sleep(for: .milliseconds(request.method == "POST" ? 900 : 300))
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(Data(body.utf8)))
                    continuation.finish()
                }
            }
        })
    }

    private static func answer(_ sample: String, _ request: LinkRequest) -> (Int, String) {
        if request.method == "POST" {
            return sample.hasPrefix("gone")
                ? (200, #"{"remade": true, "branches": [{"name": "main", "as": "main"}, {"name": "feature/search", "as": "feature/search"}], "stashes": 2}"#)
                : (200, #"{"remade": false, "branches": [{"name": "feature/search-results-with-a-much-longer-name", "as": "feature/search-results-with-a-much-longer-name"}, {"name": "main", "as": "main-restored-20261103-1432"}], "stashes": 1}"#)
        }
        let now = Date.now.timeIntervalSince1970 * 1000
        let hour = 3_600_000.0
        func backup(_ id: Int, _ hours: Double, gone: [String] = [], moved: [String] = [], stashesGone: Int = 0) -> String {
            #"{"id": "b\#(id)", "at": \#(now - hours * hour), "head": "main", "branches": 6, "stashes": 2, "gone": \#(list(gone)), "moved": \#(list(moved)), "stashesGone": \#(stashesGone)}"#
        }
        func list(_ names: [String]) -> String { "[" + names.map { "\"\($0)\"" }.joined(separator: ", ") + "]" }
        switch sample {
        case "failed": return (500, #"{"message": "fatal: not a git repository (or any of the parent directories): .git"}"#)
        case "old": return (404, #"{"message": "Not found."}"#)
        case "none": return (200, #"{"repository": null, "exists": false, "backups": []}"#)
        case "empty": return (200, #"{"repository": "/Users/me/kuvo-ai", "exists": true, "backups": []}"#)
        case "gone", "gone-restored": return (200, #"{"repository": "/Users/me/kuvo-ai", "exists": false, "backups": [\#(backup(1, 0.2)), \#(backup(2, 3))]}"#)
        default:
            let rows = [backup(1, 0.1), backup(2, 0.5, gone: ["feature/search-results-with-a-much-longer-name"], moved: ["main"], stashesGone: 1),
                        backup(3, 2, gone: ["feature/search-results-with-a-much-longer-name", "fix/flaky-timer", "spike/parser"], moved: ["main"], stashesGone: 2),
                        backup(4, 26, moved: ["main"]), backup(5, 50, stashesGone: 1)]
                + (6..<16).map { backup($0, Double($0) * 30) }
            return (200, #"{"repository": "/Users/me/kuvo-ai", "exists": true, "backups": [\#(rows.joined(separator: ", "))]}"#)
        }
    }
}
#endif
