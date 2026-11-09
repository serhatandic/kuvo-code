import SwiftUI

/// On Settings › Permissions, under the sandbox: whether your other computers' bots and agents may
/// start sessions on this computer, as its box keeps it (`kuvo/approval`'s `otherComputers`: off on
/// the Mac with the app until you turn it on, on for a machine). The box enforces it; this only
/// shows it and changes it. A box from before it says so instead. Read by the page as it opens and
/// each time the computer connects (`PermissionsSettings`, into `reading`); while it isn't
/// connected, or until it's read again, no switch, so what it said before never shows as now.
struct OtherComputersSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Workspace.self) private var workspace
    /// How the page's read of it went since the computer last connected.
    let reading: Reading
    /// Why the last change didn't go through (the page clears it as it reads again).
    @Binding var failure: String?
    /// Reads it again, where it couldn't be read.
    let tryAgain: () -> Void
    /// A change on its way: the switch waits.
    @State private var changing = false

    enum Reading: Equatable { case reading, read, failed(String) }

    private var id: String { box.machine ?? BoxClient.mac }

    var body: some View {
        let name = app.name(of: box)
        if !app.isReady(box) {
            // Away, or still connecting: what it said before may not be so now, so no switch.
            Section {
                Text("Whether your other computers can start work on \(name) shows once it’s connected.")
                    .foregroundStyle(.secondary)
            } header: {
                Text("Your Other Computers")
            }
        } else if case .failed(let why) = reading {
            Section {
                HStack(alignment: .firstTextBaseline) {
                    Text("Couldn’t read whether your other computers can start work on \(name). \(why)")
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Try Again", action: tryAgain).controlSize(.small)
                }
            } header: {
                Text("Your Other Computers")
            }
        } else if reading == .read, let here = workspace.approvalsHere[id] {
            if let allowed = here.otherComputers {
                Section {
                    let title = "Let your other computers start work here"
                    let detail = "Their bots and agents can start sessions on \(name)."
                    LabeledContent {
                        HStack(spacing: 8) {
                            // (The switch goes over once its box says so: meanwhile, a sign it's on its way.)
                            if changing { ProgressView().controlSize(.small).accessibilityHidden(true) }
                            Toggle(title, isOn: Binding(get: { allowed }, set: { change(to: $0) }))
                                .toggleStyle(.switch)
                                .labelsHidden()
                                .disabled(changing)
                                .accessibilityHint(detail)
                        }
                    } label: {
                        Text(title)
                        Text(detail)
                    }
                } header: {
                    Text("Your Other Computers")
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        // (A footer's own color, as Also Allowed's above it.)
                        Text("At your own risk: a lost computer or a leaked key could start work here too. Full Access still has to be allowed on \(name) once.")
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
        } else {
            // Being read: its place kept, so the page doesn't jump when it comes.
            Section {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Reading…")
                }
                .foregroundStyle(.secondary)
            } header: {
                Text("Your Other Computers")
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
                let why = error is CancellationError ? "\(app.name(of: box)) isn’t connected." : error.localizedDescription
                failure = "Couldn’t change it: \(why)"
                // (The switch only goes back: said out loud too.)
                AccessibilityNotification.Announcement(failure ?? "").post()
            }
        }
    }
}
