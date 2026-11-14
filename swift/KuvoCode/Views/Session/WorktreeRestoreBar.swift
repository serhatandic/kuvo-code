import ClientDesign
import OpenCodeKit
import SwiftUI

/// Over the composer of a session whose worktree its box removed once its sessions were archived:
/// Restore brings it back (with the changes it saved), Continue moves the session to its project's
/// own folder.
struct WorktreeRestoreBar: View {
    let session: Session
    let worktree: Workspace.RestorableWorktree
    let failed: (String) -> Void
    @Environment(Workspace.self) private var workspace
    @State private var isBusy = false
    @State private var confirmingContinue = false

    private var projectName: String { workspace.projectName(worktree.project) }

    private var detail: String? {
        guard worktree.restorable else { return nil }
        return worktree.saved ? "Restore brings it back with your changes." : "Restore brings it back."
    }

    var body: some View {
        // In a narrow window the buttons go under the words rather than squeezing them.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                words
                Spacer(minLength: 8)
                buttons
            }
            VStack(alignment: .leading, spacing: 8) {
                words
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    buttons
                }
            }
        }
        .disabled(isBusy)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .alert("Continue in \(projectName)?", isPresented: $confirmingContinue) {
            Button("Continue") { continueInProject() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The changes saved with its worktree are deleted.")
        }
    }

    private var words: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.uturn.backward.circle")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text("Its worktree was removed.")
                    .font(.system(size: 13, weight: .medium))
                if let detail {
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder private var buttons: some View {
        if isBusy {
            Spinner(size: 13)
                .accessibilityElement()
                .accessibilityLabel(worktree.restorable ? "Restoring its worktree" : "Moving the session")
        }
        if !OutsideAgents.isAgentSession(session) {
            Button("Continue in \(projectName)") {
                // What was saved with the worktree goes once no session is left there.
                if worktree.saved { confirmingContinue = true } else { continueInProject() }
            }
            .buttonStyle(.glass)
            .lineLimit(1)
            // A long project name keeps its start and end.
            .truncationMode(.middle)
            .help("Work in \(projectName)’s own folder from now on")
        }
        if worktree.restorable {
            Button("Restore") { act(failing: "Couldn’t restore its worktree.") { try await workspace.restoreWorktree(worktree.folder) } }
                .buttonStyle(.glassProminent)
                .help("Bring back its worktree on \(worktree.branch)")
        }
    }

    private func continueInProject() {
        act(failing: nil) { try await workspace.continueInProject(session.id) }
    }

    /// `work`, with why it failed over the composer: after `failing`, when it says what didn't happen.
    private func act(failing: String?, _ work: @escaping () async throws -> Void) {
        isBusy = true
        Task {
            defer { isBusy = false }
            do { try await work() } catch {
                failed([failing, error.localizedDescription].compactMap { $0 }.joined(separator: " "))
                // What the box has now: one restored or gone meanwhile (from a phone) shows as it is.
                await workspace.takeWorktrees(from: Workspace.box(of: worktree.root))
            }
        }
    }
}
