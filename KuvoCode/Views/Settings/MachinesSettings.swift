import ClientDesign
import SwiftUI

/// Machines: Linux servers whose engine Kuvo Code runs over SSH, for projects on them. Each can
/// be connected again, disconnected or removed.
struct MachinesSettings: View {
    @Environment(AppModel.self) private var app
    @State private var showsAdd = false
    @State private var removing: Machine?
    /// Two machines you said were one computer, which said they're two.
    @State private var notSame: (String, String)?
    /// A machine another Mac runs, to make this Mac its home once you say so.
    @State private var takingHome: MachineEngine?
    /// The machines being moved to this Mac now, with the Mac each is moving from.
    @State private var movingHome: [String: String] = [:]
    /// Why one couldn't be moved here.
    @State private var homeFailure: String?

    /// What keeps a machine from being reached, in a line, and why below it, read as one by
    /// VoiceOver. `again`: it can be set up again now (it's connected), with Set Up Again, its own
    /// control below them.
    private func problem(_ line: String, why: String, again engine: MachineEngine? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(line)
                    Text(why)
                        .font(.caption)
                }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
                if let engine, engine.isReady {
                    if app.phoneLink.settingUpNow.contains(engine.machine.id) {
                        Spinner(size: 12)
                            .accessibilityLabel("Setting it up")
                    } else {
                        Button("Set Up Again") { Task { await app.phoneLink.sync(engine, asked: true) } }
                            .buttonStyle(TextButtonStyle(outset: true))
                            .fixedSize()
                    }
                }
            }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }

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
        // KUVO_DEMO_ADD_MACHINE: Add a Machine, open. KUVO_DEMO_REMOVE_MACHINE=<id>: its Remove
        // dialog, open.
        .task {
            if ProcessInfo.processInfo.environment["KUVO_DEMO_ADD_MACHINE"] != nil {
                try? await Task.sleep(for: .seconds(1))
                showsAdd = true
            }
            // KUVO_DEMO_MAKE_HOME=<id>: once it's connected, makes this Mac its home, as the button
            // does once you've said so (to try a move between two demo copies).
            if let id = ProcessInfo.processInfo.environment["KUVO_DEMO_MAKE_HOME"], let engine = app.machines.engine(id) {
                while !engine.isReady, !Task.isCancelled { try? await Task.sleep(for: .seconds(1)) }
                if !Task.isCancelled { makeHome(engine) }
            }
            if let id = ProcessInfo.processInfo.environment["KUVO_DEMO_REMOVE_MACHINE"] {
                try? await Task.sleep(for: .seconds(1))
                removing = app.machines.list.first { $0.id == id }
            }
        }
        #endif
        .alert("\(notSame?.0 ?? "") and \(notSame?.1 ?? "") are two computers", isPresented: Binding(get: { notSame != nil }, set: { if !$0 { notSame = nil } })) {
            Button("OK") { notSame = nil }
        } message: {
            Text("Each told Kuvo Code its own name when it connected, and they differ, so they stay two machines.")
        }
        .confirmationDialog("Make This Mac \(takingHome?.machine.name ?? "")’s Home?", isPresented: Binding(get: { takingHome != nil }, set: { if !$0 { takingHome = nil } }), presenting: takingHome) { engine in
            Button("Make This Mac Its Home") { makeHome(engine) }
        } message: { engine in
            let home = Self.anotherMac(engine) ?? "Another Mac"
            Text("\(home == "Another Mac" ? "The Mac that runs it" : home) stops running \(engine.machine.name) and this Mac runs it from now on, with this Mac’s accounts. Its sessions, bots and settings stay on \(engine.machine.name), and \(home == "Another Mac" ? "that Mac" : home) still shows them.")
        }
        .alert("\(homeFailure == nil ? "" : "Couldn’t Make This Mac Its Home")", isPresented: Binding(get: { homeFailure != nil }, set: { if !$0 { homeFailure = nil } })) {
            Button("OK") { homeFailure = nil }
        } message: {
            Text(homeFailure ?? "")
        }
        .confirmationDialog("Remove \(removing?.name ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { machine in
            Button("Remove", role: .destructive) { app.removeMachine(machine.id) }
            Button("Uninstall from \(machine.name)", role: .destructive) { app.removeMachine(machine.id, uninstall: true) }
        } message: { machine in
            Text("Remove takes it off this Mac; it keeps running, with its sessions, bots, sign-ins and keys\(PhoneLink.isEnabled ? ", and your phones keep it" : ""). Uninstall also stops it there and deletes its sign-ins and keys.")
        }
    }

    /// The Mac that runs it, by its name ("Another Mac" when its start didn't say), when it's not
    /// this one; nil when this Mac runs it.
    static func anotherMac(_ engine: MachineEngine) -> String? {
        #if DEBUG
        // KUVO_DEMO_MACHINE_HOME=<machine>|<Mac>: shown as that Mac's, for a look at the page.
        if let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_MACHINE_HOME"]?.split(separator: "|").map(String.init), demo.first == engine.machine.id {
            return demo.count > 1 ? demo[1] : "Another Mac"
        }
        #endif
        return engine.isAnotherMacsEngine ? engine.homeName ?? "Another Mac" : nil
    }

    /// Another Mac runs it: what that means here, and the way to run it from this Mac instead.
    private func anotherMacRuns(_ engine: MachineEngine, home: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(home) runs it: its agents are reached from there.")
                    Text("Agents on this Mac’s computers can’t write to them, and this Mac’s group chats can’t name them.")
                        .font(.caption)
                }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
                if movingHome[engine.machine.id] != nil {
                    HStack(spacing: 6) {
                        Spinner(size: 12)
                        Text("Starting it from this Mac…")
                    }
                    .accessibilityElement(children: .combine)
                } else {
                    Button("Make This Mac Its Home…") { takingHome = engine }
                        .buttonStyle(TextButtonStyle(outset: true))
                        // A way out, in the accent: not the grey of the lines above it.
                        .foregroundStyle(.tint)
                        .fixedSize()
                }
            }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }

    private func makeHome(_ engine: MachineEngine) {
        let id = engine.machine.id
        movingHome[id] = Self.anotherMac(engine) ?? "Another Mac"
        Task {
            let why = await app.makeHome(engine)
            movingHome[id] = nil
            homeFailure = why
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
                    MachineStatus(engine: engine, namesHome: true)
                    // Set up for your phones and other computers: one that couldn't finish says so.
                    // A line, the reason behind it below, and Set Up Again while it’s connected
                    // (connecting sets it up too).
                    if let why = app.phoneLink.setupFailed[engine.machine.id] {
                        problem("Your phones and other computers can’t reach it yet.", why: why, again: engine)
                    } else if let home = movingHome[engine.machine.id] ?? (engine.isReady ? Self.anotherMac(engine) : nil) {
                        anotherMacRuns(engine, home: home)
                    } else if let (line, why) = app.phoneLink.peerProblem(of: engine.machine.id) {
                        problem(line, why: why, again: app.phoneLink.machineIsAnotherMacs(engine.machine.id) ? nil : engine)
                    }
                }
            }
            .settingsText()
            HStack {
                switch engine.offer {
                case .disconnect:
                    Button("Disconnect") { app.disconnect(engine) }
                        .help("Close this Mac’s connection; \(engine.machine.name) keeps running on its own")
                // COMPAT(0.7 engine-stop): Start. Goes 3 months after 0.8.0.
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

