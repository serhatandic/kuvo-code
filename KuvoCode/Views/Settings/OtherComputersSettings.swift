import SwiftUI

/// On Settings › Permissions, under the sandbox: whether your other computers' bots and agents may
/// start sessions on this computer, as its box keeps it (`kuvo/approval`'s `otherComputers`: off on
/// the Mac with the app until you turn it on, on for a machine). The box enforces it; this only
/// shows it and changes it. A box from before it says so instead. Read by the page as it opens and
/// as the computer connects (`PermissionsSettings`); until then, nothing shows.
struct OtherComputersSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Workspace.self) private var workspace
    /// Why the last change didn't go through.
    @State private var failure: String?
    /// A change on its way: the switch waits.
    @State private var changing = false

    private var id: String { box.machine ?? BoxClient.mac }

    var body: some View {
        let name = app.name(of: box)
        if let here = workspace.approvalsHere[id] {
            if let allowed = here.otherComputers {
                Section {
                    Toggle(isOn: Binding(get: { allowed }, set: { change(to: $0) })) {
                        Text("Let your other computers start work here")
                        Text("Their bots and agents can start sessions on \(name).")
                    }
                    .disabled(changing)
                } header: {
                    Text("Your Other Computers")
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("At your own risk: a lost computer or a leaked key could start work here too. Full Access still has to be allowed on \(name) once.")
                            .foregroundStyle(.secondary)
                        if let failure {
                            Text(failure).foregroundStyle(.red)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Section("Your Other Computers") {
                    Text("Starting work here from your other computers needs a newer Kuvo Code on \(name).")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func change(to on: Bool) {
        changing = true
        Task {
            defer { changing = false }
            do {
                try await workspace.allowOtherComputers(on, onBox: id)
                failure = nil
            } catch {
                failure = "Couldn’t change it: \(error.localizedDescription)"
            }
        }
    }
}
