import OpenCodeKit
import SwiftUI

/// Archived sessions: out of the sidebar, still searchable; brought back or deleted here.
struct ArchivedSessionsSettings: View {
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    @State private var search = ""
    @State private var deleting: [String]?

    private var archived: [Session] {
        workspace.sessions
            // On a machine that's away, they wait for it: deleting or unarchiving needs it.
            .filter { Workspace.isArchived($0) && $0.parentID == nil && workspace.waitingMachine(for: $0.id) == nil }
            .filter { search.isEmpty || ($0.title ?? "").localizedCaseInsensitiveContains(search) || workspace.projectName(of: $0).localizedCaseInsensitiveContains(search) || machineName($0.location.directory)?.localizedCaseInsensitiveContains(search) == true }
            .sorted { $0.time.updated > $1.time.updated }
    }

    /// By project (its folder: two of the same name, on this Mac and a machine, say, are two), the
    /// most recently used first.
    private var byProject: [(directory: String, sessions: [Session])] {
        // (Chats by their folder: one on this Mac and one a machine's are two.)
        let groups = Dictionary(grouping: archived) { workspace.listedProject(of: $0) ?? $0.location.directory }
        return groups.map { ($0.key, $0.value) }.sorted { ($0.sessions.first?.time.updated ?? 0) > ($1.sessions.first?.time.updated ?? 0) }
    }

    /// The machine a project is on, by name; nil for this Mac's.
    private func machineName(_ directory: String) -> String? {
        RemoteFolder.machine(of: directory).map { app.machines.engine($0)?.machine.name ?? $0 }
    }

    var body: some View {
        ScrollingSettingsForm {
            Section {
                SettingsSearchRow(text: $search, prompt: "Search archived sessions")
            } header: {
                HStack {
                    Spacer()
                    Button("Delete All…", role: .destructive) { deleting = archived.map(\.id) }
                        .disabled(archived.isEmpty)
                }
            }
            if archived.isEmpty {
                Section {
                    Text(search.isEmpty ? "None yet. Right-click a session in the sidebar and choose Archive to put it away." : "No archived session matches “\(search)”.")
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(byProject, id: \.directory) { group in
                Section {
                    ForEach(group.sessions) { session in
                        LabeledContent {
                            HStack(spacing: 6) {
                                Button("Unarchive") { Task { await workspace.setArchived(session.id, false) } }
                                Button {
                                    deleting = [session.id]
                                } label: {
                                    Image(systemName: "trash")
                                }
                                .buttonStyle(IconButtonStyle(width: 28, height: 24))
                                .accessibilityLabel("Delete")
                                .help("Delete")
                            }
                        } label: {
                            Text(session.title ?? "New Session")
                            Text(Date(timeIntervalSince1970: session.time.updated / 1000), format: .dateTime.day().month(.abbreviated).year().hour().minute())
                        }
                    }
                } header: {
                    HStack {
                        Label(group.sessions.first.map { workspace.projectName(of: $0) } ?? workspace.projectName(group.directory), systemImage: "folder")
                            .lineLimit(1)
                            .layoutPriority(1)
                        // Which machine it's on, as the sidebar says it.
                        if let machine = machineName(group.directory) {
                            HStack(spacing: 4) {
                                Image(systemName: "server.rack")
                                    .font(.system(size: 9, weight: .semibold))
                                Text(machine)
                                    .lineLimit(1)
                            }
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(group.sessions.count.counting("session"))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .confirmationDialog(deleting?.count == 1 ? "Delete this session?" : "Delete \(deleting?.count ?? 0) sessions?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Delete", role: .destructive) {
                let ids = deleting ?? []
                Task {
                    // Any that couldn't go stay listed; why, once, for the first.
                    var failure: Error?
                    for id in ids {
                        do { try await workspace.delete(id) } catch { failure = failure ?? error }
                    }
                    if let failure { Modal.show(failure) }
                }
            }
        } message: {
            Text("Their messages and undo snapshots go too. This can’t be undone.")
        }
    }
}
