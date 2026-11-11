import ClientDesign
import SwiftUI

/// Machines: Macs and Linux servers whose engine Kuvo Code runs over SSH, for projects on them. Each can
/// be connected again, disconnected or removed.
struct MachinesSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.isEnabled) private var isEnabled
    @State private var showsAdd = false
    @State private var removing: Machine?
    /// Two machines you said were one computer, which said they're two.
    @State private var notSame: (String, String)?
    /// A machine another Mac runs, to make this Mac its home once you say so.
    @State private var takingHome: MachineEngine?

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
        // Asked for from the sidebar: taken by the Machines page in view, not one kept in a tab
        // behind it (those are disabled).
        .onChange(of: app.addsMachine && isEnabled, initial: true) { _, adds in
            guard adds else { return }
            app.addsMachine = false
            showsAdd = true
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
                // Once it's up, as you'd open it (it says who else uses it then), or after a while.
                for _ in 0..<60 where app.machines.engine(id)?.isReady == false { try? await Task.sleep(for: .seconds(1)) }
                if let machine = app.machines.list.first(where: { $0.id == id }) { askToRemove(machine) }
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
            let home = Self.otherMac(engine)?.name
            Text("\(home ?? "The Mac that runs it") stops running \(engine.machine.name) and this Mac runs it from now on, with this Mac’s accounts: models signed in only on \(home ?? "that Mac") won’t be there. Its sessions, bots and settings stay on \(engine.machine.name), and \(home ?? "that Mac") still shows them.")
        }
        .alert("Couldn’t Make This Mac Its Home", isPresented: Binding(get: { failedHome != nil }, set: { if !$0 { failedHome?.homeFailure = nil } })) {
            Button("OK") { failedHome?.homeFailure = nil }
        } message: {
            Text(failedHome?.homeFailure ?? "")
        }
        .confirmationDialog("Remove \(removing?.name ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { machine in
            let words = Self.removal(of: machine.name, engine: app.machines.engine(machine.id), phones: PhoneLink.isEnabled)
            Button("Remove") { app.removeMachine(machine.id) }
                .keyboardShortcut(.defaultAction)
            if let uninstall = words.uninstall {
                Button(uninstall, role: .destructive) { app.removeMachine(machine.id, uninstall: true) }
            }
        } message: { machine in
            Text(Self.removal(of: machine.name, engine: app.machines.engine(machine.id), phones: PhoneLink.isEnabled).message)
        }
    }

    /// Remove's dialog, once who else uses it is read afresh (a dialog doesn't change once it's
    /// up): a moment at most, then with what was read last, or saying Uninstall would stop it for
    /// anyone. One that isn't connected opens at once.
    private func askToRemove(_ machine: Machine) {
        guard let engine = app.machines.engine(machine.id), engine.isReady else {
            removing = machine
            return
        }
        let app = app
        Task {
            // (The read is let go when the moment's up: it only reads.)
            await withTaskGroup(of: Void.self) { group in
                group.addTask { await app.readAlsoUsedBy(engine) }
                group.addTask { try? await Task.sleep(for: .seconds(1.5)) }
                await group.next()
                group.cancelAll()
            }
            removing = machine
        }
    }

    /// What Remove's dialog says, and Uninstall's button (nil: not offered). Uninstall stops it
    /// for whoever else uses it too, so they're named first; one another Mac runs is uninstalled
    /// from there. `device`: where Remove takes it off ("this Mac", or a Mac's name on a phone).
    static func removal(of name: String, engine: MachineEngine?, phones: Bool, device: String = "this Mac") -> (message: String, uninstall: String?) {
        removal(of: name, home: engine.flatMap(otherMac).map { $0.name ?? "Another Mac" }, alsoUsedBy: engine?.alsoUsedBy, phones: phones, device: device)
    }

    static func removal(of name: String, home: String?, alsoUsedBy: MachineEngine.AlsoUsedBy?, phones: Bool, device: String = "this Mac") -> (message: String, uninstall: String?) {
        MachineWords.removal(of: name, home: home, otherMacs: alsoUsedBy?.macs, phones: alsoUsedBy?.phones ?? 0, phonesKeepIt: phones, device: device)
    }

    /// The Mac that runs it, when it's not this one.
    static func otherMac(_ engine: MachineEngine) -> MachineEngine.OtherMac? {
        #if DEBUG
        // KUVO_DEMO_MACHINE_HOME=<machine>|<Mac>: shown as that Mac's, for a look at the page.
        if let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_MACHINE_HOME"]?.split(separator: "|").map(String.init), demo.first == engine.machine.id {
            return .init(name: demo.count > 1 ? demo[1] : nil)
        }
        #endif
        return engine.otherMac
    }

    /// A machine whose move here, asked for in Settings, didn't work: to say why.
    private var failedHome: MachineEngine? {
        app.machines.list.lazy.compactMap { app.machines.engine($0.id) }.first { $0.homeFailure != nil }
    }

    /// Another Mac runs it: what that means here, and the way to run it from this Mac instead.
    private func anotherMacRuns(_ engine: MachineEngine, home: MachineEngine.OtherMac) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(home.name ?? "Another Mac") runs it: its agents are reached from there.")
                    Text("Agents on this Mac’s computers can’t write to them, and this Mac’s group chats can’t name them.")
                        .font(.caption)
                }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
                if engine.movingHomeFrom != nil {
                    HStack(spacing: 6) {
                        Spinner(size: 12)
                        Text("Starting it from this Mac…")
                    }
                    .accessibilityElement(children: .combine)
                } else if engine.boxIsNewer || engine.engineIsNewer {
                    Text("A newer Kuvo Code runs it. Update Kuvo Code on this Mac to run it from here.")
                        .fixedSize(horizontal: false, vertical: true)
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

    /// Moves it here, and keeps why not on the machine: it's said once Settings shows again.
    private func makeHome(_ engine: MachineEngine) {
        engine.homeFailure = nil
        Task { engine.homeFailure = await app.makeHome(engine) }
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
                    } else if let home = engine.movingHomeFrom ?? (engine.isReady ? Self.otherMac(engine) : nil) {
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
                Button("Remove…") { askToRemove(engine.machine) }
            }
        }
        .heldContextMenu {
            for address in engine.machine.otherAddresses ?? [] {
                HeldRow.button("Stop Using \(address)") { app.machines.removeAddress(address, from: engine.machine.id) }
            }
            // The same computer at another address, when one of them can't be reached to tell.
            let others = app.machines.list.filter { $0.id != engine.machine.id }
            if !others.isEmpty {
                HeldRow.submenu("Same Computer As") {
                    for other in others {
                        HeldRow.button(other.name) {
                            if !app.machines.sameComputer(engine.machine.id, as: other.id) { notSame = (engine.machine.name, other.name) }
                        }
                    }
                }
            }
        }
    }
}

