import SwiftUI

/// Machines: Linux servers whose engine Kuvo Code runs over SSH, for projects on them. Each can
/// be connected again, disconnected or removed.
struct MachinesSettings: View {
    @Environment(AppModel.self) private var app
    @State private var showsAdd = false
    @State private var removing: Machine?
    /// Two machines you said were one computer, which said they're two.
    @State private var notSame: (String, String)?

    var body: some View {
        ScrollingSettingsForm {
            Section {
                if app.machines.list.isEmpty {
                    Text("None yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(app.machines.list) { machine in
                    if let engine = app.machines.engine(machine.id) { row(engine) }
                }
                Button("Add Machine…") { showsAdd = true }
            } header: {
                Text("Machines")
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    if let folded = app.machines.folded {
                        Text("\(folded.address) is \(folded.machine), reached another way, so it’s one of its addresses rather than another machine. Kuvo Code uses whichever answers.")
                    }
                    Text("Kuvo Code installs its engine in ~/.kuvo-code on each, and it keeps running there when you quit or disconnect. A machine with several addresses is added once.")
                }
                .foregroundStyle(.secondary)
            }
        }
        .settingsDetail(isPresented: $showsAdd, title: "Add a Machine") {
            MachineForm(style: .settings, added: { _ in showsAdd = false }, cancel: { showsAdd = false })
        }
        #if DEBUG
        // KUVO_DEMO_ADD_MACHINE: Add a Machine, open.
        .task {
            if ProcessInfo.processInfo.environment["KUVO_DEMO_ADD_MACHINE"] != nil {
                try? await Task.sleep(for: .seconds(1))
                showsAdd = true
            }
        }
        #endif
        .alert("\(notSame?.0 ?? "") and \(notSame?.1 ?? "") are two computers", isPresented: Binding(get: { notSame != nil }, set: { if !$0 { notSame = nil } })) {
            Button("OK") { notSame = nil }
        } message: {
            Text("Each told Kuvo Code its own name when it connected, and they differ, so they stay two machines.")
        }
        .confirmationDialog("Remove \(removing?.name ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { machine in
            Button("Remove", role: .destructive) { app.removeMachine(machine.id) }
        } message: { _ in
            Text("Its projects leave the sidebar. Its sessions and the engine stay on the machine, for when you add it again.")
        }
    }

    private func row(_ engine: MachineEngine) -> some View {
        SettingsRowLayout {
            HStack(spacing: 12) {
                Image(systemName: "server.rack")
                    .foregroundStyle(.secondary)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(engine.machine.name)
                    if let others = engine.machine.otherAddresses, !others.isEmpty {
                        Text("Also at \(others.joined(separator: ", "))")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    MachineStatus(engine: engine)
                }
            }
            .settingsText()
            HStack {
                switch engine.offer {
                case .disconnect:
                    Button("Disconnect") { app.disconnect(engine) }
                        .help("Close this Mac’s connection; \(engine.machine.name) keeps running on its own")
                case .start:
                    Button("Start Engine") { app.startEngine(engine) }
                case .connect, .connectNow:
                    Button(engine.offer == .connectNow ? "Connect Now" : "Connect") { app.connect(engine) }
                case nil:
                    EmptyView()
                }
                Button("Remove…") { removing = engine.machine }
            }
        }
        .contextMenu {
            ForEach(engine.machine.otherAddresses ?? [], id: \.self) { address in
                Button("Stop Using \(address)") { app.machines.removeAddress(address, from: engine.machine.id) }
            }
            // The same computer at another address, when one of them can't be reached to tell.
            let others = app.machines.list.filter { $0.id != engine.machine.id }
            if !others.isEmpty {
                Menu("Same Computer As") {
                    ForEach(others) { other in
                        Button(other.name) {
                            if !app.machines.sameComputer(engine.machine.id, as: other.id) { notSame = (engine.machine.name, other.name) }
                        }
                    }
                }
            }
        }
    }
}

