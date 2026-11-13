import AppKit
import ClientDesign
import ClientSessions
import SwiftUI

/// What a bot asks you before it does it (making a project, or cloning one): the permission card,
/// for the bot. Exactly what Allow does, sunk in a well; the first time on a computer, where its
/// projects go, picked here for every bot there; Deny, Always for the bot, Allow.
struct WorkAskCard: View {
    let ask: WorkAsk
    /// The box it's asked on: "mac", or a machine's id.
    let box: String
    /// What went wrong doing it (the folder taken, git failing), for the conversation to show once
    /// the card's gone: the bot is told too.
    var failed: (String) -> Void = { _ in }
    @Environment(AppModel.self) private var app
    @Environment(\.takesCardKeys) private var takesKeys
    /// Where projects go, picked as it's answered (the first time on its computer).
    @State private var picked: String?
    /// Choosing a machine's folder, in a sheet of its own.
    @State private var browsing = false
    /// The answer on its way, from this card.
    @State private var sent: WorkAskAnswer?
    @State private var failure: String?

    /// Being answered, here or on another of its cards.
    private var isAnswering: Bool { app.botAsks.answering.contains(ask.id) }

    private var onThisMac: Bool { BoxClient.isThisMac(box) }
    private var computer: String { onThisMac ? "this Mac" : app.machines.engine(box)?.machine.name ?? box }
    /// The folder projects go in: as its box has it, else the one picked here.
    private var projectsFolder: String? { ask.folder.map { ($0 as NSString).deletingLastPathComponent } ?? picked }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: ask.action == .cloneProject ? "square.and.arrow.down.on.square" : "folder.badge.plus")
                    .font(.title3)
                    .foregroundStyle(.orange)
                    .frame(width: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(WorkWords.askTitle(ask))
                        .font(.headline)
                    Text(WorkWords.askLine(ask))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            // Exactly what Allow does: where it goes, and what it is.
            VStack(alignment: .leading, spacing: 4) {
                Text(projectsFolder.map { shown(($0 as NSString).appendingPathComponent(ask.folderName)) } ?? "Pick where projects go")
                    .transcriptCodeFont()
                    .foregroundStyle(projectsFolder == nil ? .secondary : .primary)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Text(WorkWords.askDoes(ask))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .recessedWell(RoundedRectangle(cornerRadius: 10))

            if ask.needsFolder {
                folderPicker
            }

            if let failure {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .symbolRenderingMode(.multicolor)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                Button("Deny", role: .cancel) { send(.deny) }
                    .keyboardShortcut(takesKeys ? .cancelAction : nil)
                Spacer()
                if isAnswering, sent != .deny {
                    Spinner()
                        .accessibilityLabel(ask.action == .cloneProject ? "Cloning" : "Making the project")
                }
                if ask.bot != nil {
                    Button { send(.always) } label: { Text(WorkWords.always(ask)).lineLimit(1) }
                        .help("Let \(ask.name) \(WorkWords.allowed(ask.action).lowercased()) without asking from now on. Edit Bot › Work takes it back.")
                        .disabled(projectsFolder == nil)
                }
                Button("Allow") { send(.allow) }
                    .buttonStyle(.glassProminent)
                    .keyboardShortcut(takesKeys ? .defaultAction : nil)
                    .disabled(projectsFolder == nil)
            }
            .buttonStyle(.glass)
            .controlSize(.large)
            .disabled(isAnswering)
        }
        .padding(16)
        .onAppear { if picked == nil { picked = ask.suggested } }
        .closesWhenKept($browsing)
        .sheet(isPresented: $browsing) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Where Projects Go on \(computer)")
                    .font(.title2.weight(.bold))
                    .padding(.horizontal, 28)
                    .padding(.top, 24)
                BoxFolderBrowser(box: box, start: picked, primary: "Choose") { path, _ in
                    picked = path
                    browsing = false
                } cancel: {
                    browsing = false
                }
            }
            .frame(width: 520, height: 560)
        }
    }

    /// Where projects go on its computer, picked the first time: the folder offered, or another.
    private var folderPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent("Projects go in") {
                Menu {
                    if let suggested = ask.suggested, suggested != picked {
                        Button(shown(suggested)) { picked = suggested }
                        Divider()
                    }
                    Button("Choose a Folder…", action: choose)
                } label: {
                    Label(picked.map { ($0 as NSString).lastPathComponent } ?? "Choose…", systemImage: "folder")
                }
                .fixedSize()
                .help(picked.map(shown) ?? "Choose where new projects go")
                .disabled(isAnswering)
            }
            Text("For every bot on \(computer). You can change it in Settings › Worktrees.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func choose() {
        guard onThisMac else {
            browsing = true
            return
        }
        // Once the menu has closed.
        DispatchQueue.main.async {
            if let folder = ProjectsFolderPanel.choose(start: picked ?? ask.suggested) { picked = folder }
        }
    }

    /// A path as you'd find it: from `~` on this Mac.
    private func shown(_ path: String) -> String {
        onThisMac ? (path as NSString).abbreviatingWithTildeInPath : path
    }

    private func send(_ answer: WorkAskAnswer) {
        sent = answer
        failure = nil
        Task {
            do {
                // Done, or answered meanwhile elsewhere: the card goes. What failed in the doing
                // shows on the conversation.
                if let done = try await app.botAsks.answer(ask, on: box, answer, folder: picked), done.isError, answer != .deny { failed(done.text) }
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}
