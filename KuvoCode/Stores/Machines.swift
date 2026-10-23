import CryptoKit
import Foundation
import OpenCodeKit
import os

/// Another computer whose engine Kuvo Code runs over SSH (a home server, a VPS), next to this
/// Mac's: a host from `~/.ssh/config` or `user@host`. Its projects are folders on it.
nonisolated struct Machine: Codable, Hashable, Identifiable {
    var destination: String
    /// The same computer's other addresses (its name on the local network and over Tailscale,
    /// say): whichever answers is used, under `destination`, its name here.
    var otherAddresses: [String]?
    /// What the computer calls itself, kept in Kuvo Code's folder there, once read: two
    /// addresses that reach the same one are one machine.
    var identity: String?
    /// The address that answered last, tried first next time (after a relaunch too).
    var reachedAt: String?

    var id: String { destination }
    var name: String { destination }
    /// Every address it has, its name first.
    var addresses: [String] { [destination] + (otherAddresses ?? []) }
    /// To it, at the address in use (see `SSHConnection.route`).
    var connection: SSHConnection { SSHConnection(destination: destination) }

    /// The computer at `address` as it calls itself: a name made once, in Kuvo Code's folder there
    /// (an account's own, as that folder is), the same whichever address reaches it. Nil when it
    /// can't be asked. Two connections asking at once for the first time get the same one: each
    /// writes its own, and only the first to link it in place counts.
    static func identity(at address: String) async -> String? {
        guard let output = try? await SSHConnection.direct(address).run(identityScript) else { return nil }
        let identity = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return identity.count == 32 && identity.allSatisfy(\.isHexDigit) ? identity : nil
    }

    static var identityScript: String {
        """
            F="$HOME/\(RemoteEngineInstaller.root)/machine-id"
            if [ ! -s "$F" ]; then
              mkdir -p "${F%/*}" || exit 1
              T="$F.$$"
              (umask 077; od -An -N16 -tx1 /dev/urandom | tr -d ' \\n' >"$T") || exit 1
              ln "$T" "$F" 2>/dev/null || [ -s "$F" ] || mv -f "$T" "$F"
              rm -f "$T"
            fi
            cat "$F"
            """
    }
}

/// One machine's engine: installed and started over SSH when Kuvo Code connects (or found still
/// running there from before), with its own catalog (agents, commands and models can differ
/// there), and its live events.
@Observable
final class MachineEngine {
    private(set) var machine: Machine
    private(set) var state = AppModel.EngineState.preparing
    private(set) var api: OpenCodeAPI?
    /// False while the live event feed is down.
    private(set) var isLive = false
    /// Waiting to try again by itself, after the connection dropped.
    var isRetrying = false
    /// Its engine is stopped on purpose (Stop, here or from anywhere): it stays so until Start.
    private(set) var isStopped = false
    /// It started with this Mac's settings just now, having none of its own: your accounts go
    /// too, once (`AppModel.syncSignIns`).
    @ObservationIgnored var seededNow = false
    /// Start was pressed here: the next connection starts it if it's stopped, until one does (one
    /// that fails, the machine away, carries it to Try Again), or it's stopped or disconnected.
    var startWanted = false
    /// The box there was set up by a newer Kuvo Code than this app (`BoxVersion`): its engine and
    /// files are left as they are.
    private(set) var boxIsNewer = false
    let catalog = Catalog()
    /// Its engine's settings, its own (`MachineBox`): read as it's started, and again as they
    /// change there.
    let config: EngineConfig
    /// The coding agents there: the agents bridge beside its engine, through the same tunnel.
    let agents: OutsideAgents
    /// Its engine started with the agents bridge beside it (an older one didn't).
    var hasAgentsBridge: Bool { server?.agentsEndpoint != nil }
    /// Its browser, which its agents browse with, shown live in the panel.
    let browser: MachineBrowser

    @ObservationIgnored private var server: RemoteServer?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var isStopping = false
    /// Keeps its sign-ins in step with this Mac's while it's connected (`AppModel.syncSignIns`).
    @ObservationIgnored var signInSync: Task<Void, Never>?
    @ObservationIgnored var signInNudge: Task<Void, Never>?
    /// Copying its sign-ins, now or last: the next waits for it.
    @ObservationIgnored var signInTurn: Task<Void, Never>?
    /// Starts it over with this Mac's settings once they've changed (`AppModel.keepSettingsCurrent`).
    @ObservationIgnored var settingsUpdate: Task<Void, Never>?
    /// Your personalities met with its copy, a moment after one changes elsewhere.
    @ObservationIgnored var personalitiesSync: Task<Void, Never>?
    /// Keeps its agents' list of everyone current, and brings their messages for agents
    /// elsewhere (`AgentMail`).
    @ObservationIgnored var agentSync: Task<Void, Never>?
    /// Events for the stores that span every machine (sessions); the catalog takes its own.
    @ObservationIgnored var onEvent: (ServerEvent) -> Void = { _ in }
    /// The feed came back after a gap: whatever it missed has to be read again.
    @ObservationIgnored var onReconnect: () async -> Void = {}
    /// The connection closed without being asked to (the machine restarted, the network went).
    @ObservationIgnored var onExit: () -> Void = {}
    /// Stopped, then started from elsewhere (a phone, another Mac): connect to it.
    @ObservationIgnored var onStartedElsewhere: () -> Void = {}
    @ObservationIgnored private var stoppedWatch: Task<Void, Never>?
    private let log = Logger(subsystem: "run.kuvo.code", category: "machine")

    init(machine: Machine) {
        self.machine = machine
        browser = MachineBrowser(machine: machine)
        agents = OutsideAgents(machine: machine.id)
        catalog.outsideAgents = agents
        catalog.machine = machine.id
        config = EngineConfig(remote: MachineBox.Store(connection: machine.connection))
    }

    /// The machine as it's kept now: another address, or what it calls itself, learned.
    func update(_ machine: Machine) {
        guard machine.id == self.machine.id, machine != self.machine else { return }
        self.machine = machine
    }

    /// What the computer calls itself, as first read (see `Machine.identity`): the app keeps it,
    /// and tells one machine reached at two addresses from two.
    @ObservationIgnored var onIdentity: (String) -> Void = { _ in }
    /// Another of its addresses answered: the app keeps it, to try first next time.
    @ObservationIgnored var onReached: (String) -> Void = { _ in }

    /// Of its addresses, the one that answers as this computer, the one in use (or that answered
    /// last) first: its connections go there from now on. One that answers as another computer (a
    /// local name handed to another one since) isn't used. None answering as it, but its name
    /// answering: the computer there calls itself something new (its Kuvo Code folder was made
    /// again), and is still this machine. With one address, nothing to choose.
    func reach() async {
        let addresses = machine.addresses
        guard addresses.count > 1 else {
            // (Removed and added again at one address: not where it was reached before.)
            SSHConnection.route(machine.id, to: nil)
            return
        }
        let routed = machine.connection.address
        let first = routed != machine.destination ? routed : machine.reachedAt.flatMap { addresses.contains($0) ? $0 : nil } ?? routed
        var atName: String?
        for address in [first] + addresses.filter({ $0 != first }) {
            guard let identity = await Machine.identity(at: address) else { continue }
            if let known = machine.identity, known != identity {
                if address == machine.destination { atName = identity }
                continue
            }
            settle(at: address, identity: identity)
            return
        }
        // Nowhere it answers as itself: at its name, as a machine with one address would be.
        SSHConnection.route(machine.id, to: nil)
        if let atName { settle(at: machine.destination, identity: atName) }
    }

    private func settle(at address: String, identity: String) {
        SSHConnection.route(machine.id, to: address)
        if machine.identity != identity { onIdentity(identity) }
        if machine.reachedAt != address { onReached(address) }
    }

    /// What it calls itself, read once it's connected (with several addresses, `reach` read it):
    /// new if its Kuvo Code folder there was made again, so its other addresses are still known
    /// as its own.
    private func learnIdentity() {
        guard machine.identity == nil || machine.addresses.count == 1 else { return }
        let address = machine.connection.address
        Task { [weak self] in
            guard let identity = await Machine.identity(at: address), identity != self?.machine.identity else { return }
            self?.onIdentity(identity)
        }
    }

    var isReady: Bool { state == .ready }
    /// The engine's version running there (a newer box's may be newer than this app's).
    var engineVersion: String? { server?.engine.version }

    /// Where its connection is, as every view says it.
    enum Connection: String, Equatable {
        case notConnected, connecting, reconnecting, installing, connected, failed, stopped

        /// It's getting there by itself (a spinner), nothing to do.
        var isUnderWay: Bool { [.connecting, .reconnecting, .installing].contains(self) }
    }

    var connection: Connection {
        switch state {
        case .preparing: isStopped ? .stopped : .notConnected
        // At 0 it's only checking the engine it has.
        case .downloading(let progress) where progress > 0: .installing
        case .downloading, .starting: isRetrying ? .reconnecting : .connecting
        // Up, with its feed down for a moment.
        case .ready: isLive ? .connected : .reconnecting
        case .failed: isRetrying ? .reconnecting : .failed
        }
    }

    /// Where its engine is, in a few words, for menus and lists.
    var statusText: String {
        switch connection {
        case .notConnected: "Not connected"
        case .connecting: "Connecting…"
        case .reconnecting: "Reconnecting…"
        case .installing: "Installing the engine…"
        case .connected: "Connected"
        case .failed: "Couldn’t connect"
        case .stopped: "Stopped"
        }
    }

    /// The same, naming it, for where it stands on its own.
    var statusTitle: String { statusTitle(connection) }

    /// `connection`'s words, naming it.
    func statusTitle(_ connection: Connection) -> String {
        let name = machine.name
        return switch connection {
        case .notConnected: "\(name) isn’t connected"
        case .connecting: "Connecting to \(name)…"
        case .reconnecting: "Reconnecting to \(name)…"
        case .installing: "Installing the engine on \(name)…"
        case .connected: "Connected to \(name)"
        case .failed: "Couldn’t connect to \(name)"
        case .stopped: "\(name)’s engine is stopped"
        }
    }

    /// What Settings › Machines offers to do with it now, and a phone with it.
    enum Offer: String {
        case disconnect
        /// Its engine was stopped by a Mac with an older Kuvo Code (there's no Stop any more).
        case start
        case connect, connectNow
    }

    var offer: Offer? {
        switch state {
        case .ready: .disconnect
        case .preparing where isStopped: .start
        case .failed, .preparing: isRetrying ? .connectNow : .connect
        default: nil
        }
    }

    /// Why it couldn't connect, when it couldn't.
    var failure: String? {
        if case .failed(let reason) = state { return reason }
        return nil
    }

    /// What a new engine on the machine gets from this Mac.
    struct Launch {
        /// What this Mac starts it with, as environment variables: never its settings or keys,
        /// which are its own (`MachineBox`), but its time zone, its name, and the browser tools.
        var environment: [String: String]
        /// The browser helper the engine runs for the browser tools (`kuvo-browser.js`).
        var helper: (text: String, hash: String)
        /// The agents bridge that starts beside it (`kuvo-agents.js`), for the coding agents there.
        var agents: (text: String, hash: String)?
        /// What a machine with no settings yet gets (this Mac's), asked for only then.
        var seed: () async -> MachineBox.Seed = { .init(settings: [:], keys: [:]) }
        /// What it starts with from its own settings: its integrations' sites, for the browser
        /// tools. Filled in as it starts (`boxEnvironment`).
        var fromBox: ([String: JSONValue]) -> [String: String] = { _ in [:] }
        var boxEnvironment: [String: String] = [:]

        /// Changes when what this Mac starts it with does, so an engine started with older
        /// things is started over the next time it's idle: the launch script's, the watchdog's,
        /// the browser helper's and the agents bridge's versions too. (The launch script's goes
        /// up when what it sets up changes: its folders, `kuvo-npx`, the commands' plugin, where
        /// its settings are.) Not its own settings, which it reloads as they change.
        var fingerprint: String {
            let text = environment.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "\n") + "\nlaunch=12\nwatchdog=groups\nbrowser=\(helper.hash)\nagents=\(agents?.hash ?? "none")"
            return SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        }
    }

    /// This Mac, as the engines it starts on machines note it.
    static let macID: String = {
        let key = "machineClientID"
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: key)
        return id
    }()

    /// This Mac started the engine running there with other settings than `launch`'s, or an older
    /// Mac did, with its own.
    func isBehind(_ launch: Launch) -> Bool {
        guard let engine = server?.engine else { return false }
        if isOlderMacs(engine) { return !boxIsNewer }
        guard !isAnotherMacs(engine) else { return false }
        return engine.notes["settings"] != launch.fingerprint
    }

    /// Whether another Mac started this engine (engines from before Macs were noted count as
    /// this one's).
    /// The engine there is another Mac's, which uses it too: it keeps it, and the accounts in it.
    var isAnotherMacsEngine: Bool { server.map { isAnotherMacs($0.engine) } ?? false }

    private func isAnotherMacs(_ engine: RemoteServer.Engine) -> Bool {
        engine.notes["mac"].map { $0 != Self.macID } ?? false
    }

    /// Started by a Kuvo Code from before boxes kept their own settings (0.7 and before, on this
    /// Mac or another), with that Mac's: replaced as this Mac's own older ones are, once nothing's
    /// running, so the box's run.
    private func isOlderMacs(_ engine: RemoteServer.Engine) -> Bool {
        engine.notes["box"] == nil
    }

    /// Connects to the machine's engine: the one already running there (from an earlier launch,
    /// maybe still working on something), or a new one, installed first if needed. One this Mac
    /// started with an older version, or older settings while nothing is running, is
    /// replaced, in the same start. One another Mac started is used as it is, unless it's an older
    /// version: two Macs with different settings would otherwise take turns starting it over, each
    /// dropping the other's connection, and an older app would put back an older engine. One
    /// stopped on purpose stays stopped (`isStopped`), unless Start was pressed (`startWanted`).
    func start(_ launch: Launch, cache: URL) async {
        // Once at a time.
        switch state {
        case .preparing, .failed: break
        case .downloading, .starting, .ready: return
        }
        isStopping = false
        // Disconnecting (Connect Now) or a newer attempt ends this one at its next step.
        let attempt = connections
        let check = { if self.connections != attempt { throw Superseded() } }
        var attached: RemoteServer?
        do {
            state = .starting
            // At whichever of its addresses answers.
            await reach()
            try check()
            let connection = machine.connection
            // A box a newer Kuvo Code set up (it updated itself, or another Mac's newer app did):
            // what's there runs as it is, and nothing of this app's goes over it.
            boxIsNewer = BoxVersion.isNewer(try await BoxVersion.read(on: connection))
            try check()
            // What follows puts this app's files there: the box doesn't take them for an older Mac's.
            if !boxIsNewer { try? await BoxVersion.installing(on: connection) }
            // The box's own tool and keeper first, which what follows counts on.
            try await RemoteServer.installBoot(on: connection)
            var found = try await RemoteServer.find(on: connection)
            try check()
            let starting = startWanted
            if found == .stopped, !starting {
                if !boxIsNewer { try? await BoxVersion.notInstalling(on: connection) }
                isStopped = true
                state = .preparing
                watchWhileStopped()
                return
            }
            isStopped = false
            // A newer box's engine isn't running: its own keeper starts the one it has.
            if boxIsNewer, found.engine == nil {
                if found == .stopped { try await RemoteServer.startEngine(on: connection) }
                for _ in 0..<15 where found.engine == nil {
                    try await Task.sleep(for: .seconds(2))
                    try check()
                    found = try await RemoteServer.find(on: connection)
                }
                guard found.engine != nil else { throw NewerBox() }
            }
            var engine = found.engine
            let isNewer = engine.map { $0.version.compare(OpenCodeEngine.version, options: .numeric) == .orderedDescending } ?? false
            var updates = !boxIsNewer && engine?.version != OpenCodeEngine.version && !(isNewer && engine.map(isAnotherMacs) == true)
            // An engine of another version still at work (a session left running when the app
            // quit or updated): kept, with its work, until a connection finds it with none.
            var busy: RemoteServer?
            // (One that can't be reached to ask is updated, as before.)
            if updates, let old = engine, let probe = try? await attach(old, launch) {
                attached = probe
                try check()
                let api = OpenCodeAPI(endpoint: probe.endpoint, folderPrefix: RemoteFolder.prefix(for: machine.id))
                if (try? await api.activeSessions())?.isEmpty == false {
                    busy = probe
                    updates = false
                } else {
                    probe.disconnect()
                    attached = nil
                }
            }
            if updates {
                state = .downloading(progress: 0)
                try await RemoteEngineInstaller(connection: connection, cache: cache).install { progress in
                    Task { @MainActor in
                        if case .downloading = self.state { self.state = .downloading(progress: progress) }
                    }
                }
                try check()
                state = .starting
            }
            // Its own settings, a box of its own: made so once (from what it runs with, or this
            // Mac's on one with none), then read, for what its engine starts with.
            try await MachineBox.install(on: connection)
            var launch = launch
            let box = try await MachineBox.adopt(on: connection, seed: launch.seed)
            config.took(box.settings)
            // As Kuvo Code brings this Mac's up to date as its engine starts: its integrations as
            // they're set up now, its servers' tools plain tools (not a newer box's, which knows
            // newer ones).
            if !boxIsNewer {
                Integrations.upgrade(config, on: machine.id)
                MCPSettings.upgrade(config)
            }
            launch.boxEnvironment = launch.fromBox(config.settings)
            if box.seeded { seededNow = true }
            try check()
            // The browser tools' helper, and the agents bridge, which an engine starts with.
            try await MachineBrowserInstaller.installHelper(launch.helper, on: connection)
            if let agents = launch.agents { try await Self.installAgents(agents, on: connection) }
            try check()
            let running: RemoteServer.Engine
            // One of another version is replaced in the same start, so its keeper starts no other.
            if let engine, !updates { running = engine } else { running = try await launchEngine(launch, replace: engine?.pid, starting: starting) }
            try check()
            var server: RemoteServer
            if let busy { server = busy } else { server = try await attach(running, launch) }
            attached = server
            try check()
            let api = OpenCodeAPI(endpoint: server.endpoint, folderPrefix: RemoteFolder.prefix(for: machine.id))
            if !boxIsNewer, isOlderMacs(server.engine) || server.engine.notes["settings"] != launch.fingerprint && !isAnotherMacs(server.engine), (try? await api.activeSessions())?.isEmpty == true {
                // Started with older settings (or an older Mac's), and nothing to interrupt: start it over.
                try check()
                server.disconnect()
                attached = nil
                server = try await attach(launchEngine(launch, replace: server.engine.pid), launch)
                attached = server
                try check()
            }
            try check()
            // What this app put there runs: the box is this version's.
            if !boxIsNewer {
                var marks = ["kuvo-browser.js": "// kuvo-browser \(launch.helper.hash)"]
                if let agents = launch.agents { marks["kuvo-agents.js"] = "// kuvo-agents \(agents.hash)" }
                try? await BoxVersion.mark(on: connection, marks: marks)
            }
            self.server = server
            let current = OpenCodeAPI(endpoint: server.endpoint, folderPrefix: RemoteFolder.prefix(for: machine.id))
            self.api = current
            catalog.api = current
            agents.connect(server.agentsEndpoint, folderPrefix: RemoteFolder.prefix(for: machine.id))
            // An engine started without its agents bridge (an older one): none to wait for.
            if server.agentsEndpoint == nil { catalog.forgetAgents() }
            startWanted = false
            state = .ready
            learnIdentity()
            Analytics.shared.trackOnce("machine_connected")
            listen(to: current)
            // The browser, in the background: the first time, a download and an upload. A browser
            // tab in view comes back live.
            Task { await browser.prepare() }
            browser.resume()
            await catalog.refresh()
        } catch is Superseded {
            // What it connected is its own to close; the newer attempt has the rest.
            if let attached, attached !== server { attached.disconnect() }
        } catch where connections != attempt {
            // Failed after a newer attempt began: that one's state isn't this one's to change.
            if let attached, attached !== server { attached.disconnect() }
        } catch RemoteEngineError.stopped {
            // Stopped from elsewhere as this connected.
            if let attached, attached !== server { attached.disconnect() }
            isStopped = true
            state = .preparing
            watchWhileStopped()
        } catch {
            log.error("\(self.machine.destination, privacy: .public) didn't start: \(error.localizedDescription, privacy: .public)")
            server?.disconnect()
            server = nil
            state = .failed(error.localizedDescription)
        }
    }

    private struct Superseded: Error {}

    /// A newer box whose engine didn't come up by itself: this app won't start an older one there.
    struct NewerBox: LocalizedError {
        var errorDescription: String? { "This machine has a newer Kuvo Code than this Mac, and its engine didn't start. Update Kuvo Code on this Mac to start it from here." }
    }

    private func launchEngine(_ launch: Launch, replace: Int? = nil, starting: Bool = false) async throws -> RemoteServer.Engine {
        try await RemoteServer.launch(on: machine.connection, environment: launch.environment.merging(launch.boxEnvironment) { $1 }, notes: ["settings": launch.fingerprint, "mac": Self.macID, "box": BoxVersion.mine],
                                      withAgents: launch.agents != nil, replace: replace, start: starting)
    }

    /// `kuvo-agents.js` as it goes to a machine: the bundle, with a last line naming its contents,
    /// to tell whether a machine has it. (Its first line is Bun's.)
    static let agentsBridge: (text: String, hash: String)? = {
        guard let url = Bundle.main.url(forResource: "kuvo-agents", withExtension: "js"),
              let text = try? String(contentsOf: url, encoding: .utf8), !text.isEmpty else { return nil }
        let hash = SHA256.hash(data: Data(text.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        return (text + "\n// kuvo-agents \(hash)\n", hash)
    }()

    /// Puts the agents bridge in the machine's `~/.kuvo-code/bin`, unless it has this one already.
    static func installAgents(_ bridge: (text: String, hash: String), on connection: SSHConnection) async throws {
        let path = "$HOME/\(RemoteEngineInstaller.root)/bin/kuvo-agents.js"
        let last = try await connection.run("tail -n 1 \"\(path)\" 2>/dev/null || true")
        guard last.trimmingCharacters(in: .whitespacesAndNewlines) != "// kuvo-agents \(bridge.hash)" else { return }
        let file = FileManager.default.temporaryDirectory.appending(path: "kuvo-agents-\(UUID().uuidString).js")
        try Data(bridge.text.utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        try await connection.run(BoxVersion.guardScript + "\n" + """
            set -e
            mkdir -p "$HOME/\(RemoteEngineInstaller.root)/bin"
            cat >"\(path).new"
            mv -f "\(path).new" "\(path)"
            """, input: file)
    }

    private func attach(_ engine: RemoteServer.Engine, _ launch: Launch) async throws -> RemoteServer {
        try await RemoteServer.attach(to: engine, on: machine.connection) { status in
            Task { @MainActor in self.exited(status: status) }
        }
    }

    /// Closes the connection. The engine keeps running on the machine.
    func disconnect() {
        isStopping = true
        downCheck?.cancel()
        downCheck = nil
        connections += 1
        eventTask?.cancel()
        eventTask = nil
        stoppedWatch?.cancel()
        stoppedWatch = nil
        server?.disconnect()
        server = nil
        api = nil
        catalog.api = nil
        agents.disconnect()
        catalog.forgetAgents(untilBack: true)
        isLive = false
        state = .preparing
    }

    /// While it's stopped, each minute: started from elsewhere (a phone, another Mac), it connects.
    private func watchWhileStopped() {
        stoppedWatch?.cancel()
        let connection = machine.connection
        stoppedWatch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled, self?.isWaitingStopped == true else { return }
                guard case .running? = try? await RemoteServer.find(on: connection) else { continue }
                guard !Task.isCancelled, let self, self.isWaitingStopped else { return }
                self.onStartedElsewhere()
                return
            }
        }
    }

    private var isWaitingStopped: Bool {
        guard isStopped, case .preparing = state else { return false }
        return true
    }

    /// Closes the connection and stops everything Kuvo Code runs there, for good (the machine
    /// removed, or a demo or test copy's, which leaves nothing running).
    func shutDown() async {
        disconnect()
        try? await RemoteServer.stop(on: machine.connection)
    }

    /// Signs out of every account the machine's engine has (copied from this Mac) and of its coding
    /// agents, and deletes what integrations' servers kept there (a sign-in's tokens).
    /// In its turn after a copying of sign-ins under way (which could store one after these went),
    /// and with no more after it. Whether they all went.
    @discardableResult
    func forgetAccounts() async -> Bool {
        signInSync?.cancel()
        signInSync = nil
        let previous = signInTurn
        let turn = Task { [weak self] () -> Bool in
            await previous?.value
            guard let self, let api else { return false }
            guard let credentials = try? await api.credentials() else { return false }
            var removed = true
            for credential in credentials where (try? await api.removeCredential(credential.id)) == nil { removed = false }
            // What integrations kept there, and the coding agents' sign-ins.
            let script = "K=\"$HOME/\(RemoteEngineInstaller.root)\"\nrm -rf \"$K/integrations\"\n" + Machines.agentsSignOut
            let machine = machine.id
            let cleared = await Task.detached { RemoteShell.run(script, on: machine) }.value != nil
            return removed && cleared
        }
        signInTurn = Task { _ = await turn.value }
        return await turn.value
    }

    private func listen(to api: OpenCodeAPI) {
        // One feed at a time: two would tell every event twice.
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            for await update in api.events.updates() {
                guard let self else { return }
                switch update {
                case .connected:
                    let wasLive = isLive
                    isLive = true
                    downCheck?.cancel()
                    downCheck = nil
                    if !wasLive {
                        // Its models apart from this loop; its sessions in it, so the events that
                        // come meanwhile apply after the refresh rather than being overwritten by
                        // what it read before them.
                        Task { [weak self] in await self?.catalog.refresh() }
                        await onReconnect()
                    }
                case .disconnected:
                    isLive = false
                    checkWhileDown(api)
                case .event(let event):
                    // Its settings changed there (from here, a phone, another Mac, by hand).
                    if event.type == "config.updated" { config.reload() }
                    catalog.handle(event)
                    onEvent(event)
                }
            }
        }
    }

    @ObservationIgnored private var downCheck: Task<Void, Never>?
    /// Goes up with each disconnection, so a check from an earlier connection stops.
    @ObservationIgnored private var connections = 0

    /// The live feed went down. It comes back by itself after a blip; but when the engine behind
    /// the tunnel is gone (restarted on another port, say) while the tunnel stays up, nothing
    /// would ever change. So a few seconds on, ask the engine; not answering, the connection is
    /// lost, and connecting again starts (as after the network went).
    private func checkWhileDown(_ api: OpenCodeAPI) {
        // Once for each time it's down: the feed says so again at each of its own retries.
        guard downCheck == nil else { return }
        let connection = connections
        downCheck = Task { [weak self] in
            for wait in [6, 10, 20, 30] {
                try? await Task.sleep(for: .seconds(wait))
                guard let self, !Task.isCancelled, !isLive, state == .ready, connections == connection else { return }
                let answered = await withTaskGroup(of: Bool.self) { group in
                    group.addTask { (try? await api.info()) != nil }
                    group.addTask { try? await Task.sleep(for: .seconds(5)); return false }
                    let first = await group.next() ?? false
                    group.cancelAll()
                    return first
                }
                // The feed came back meanwhile (which cancels this): nothing was lost.
                guard !Task.isCancelled else { return }
                guard !answered else { continue }
                log.error("\(self.machine.destination, privacy: .public)'s engine stopped answering through its tunnel")
                lost("The connection to \(machine.name) was lost.")
                return
            }
            // It answered every time: the next time the feed goes down, check again.
            if let self, connections == connection { downCheck = nil }
        }
    }

    /// The connection is gone: say so, and let the app connect again.
    private func lost(_ reason: String) {
        disconnect()
        state = .failed(reason)
        onExit()
    }

    private func exited(status: Int32) {
        // Not yet connected: the start that's under way says what went wrong, in its own words.
        guard !isStopping, server != nil else { return }
        let output = server?.recentOutput.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        log.error("\(self.machine.destination, privacy: .public) closed with status \(status): \(output, privacy: .public)")
        lost("The connection to \(machine.name) was lost.\(output.isEmpty ? "" : "\n\n" + String(output.suffix(400)))")
    }
}

/// The machines you've added, and their engines.
@Observable
final class Machines {
    private(set) var list: [Machine] = Machines.load()
    private(set) var engines: [String: MachineEngine] = [:]

    private static let key = "machines"

    init() {
        for machine in list { engines[machine.id] = makeEngine(machine) }
        // What waits for a machine to answer: tried a little after launch, then every 15 minutes.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            while !Task.isCancelled {
                await self?.runWaiting()
                try? await Task.sleep(for: .seconds(900))
            }
        }
    }

    // MARK: Clean-ups that wait

    /// Clean-ups for machines that couldn't be reached when they were due (one removed, a bot
    /// deleted, an integration removed), by machine: scripts run there, in order, the next time it
    /// answers. One removed's are marked, to drop if it's added again.
    private static let waitingKey = "machines.waiting"
    static let removalMark = "# Kuvo Code: removed\n"

    private static var waiting: [String: [String]] {
        get { UserDefaults.standard.dictionary(forKey: waitingKey) as? [String: [String]] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: waitingKey) }
    }

    /// When each machine's first waiting clean-up was queued: one that hasn't answered in 30 days
    /// is given up on.
    private static let waitingSinceKey = "machines.waitingSince"

    private static var waitingSince: [String: Date] {
        get { UserDefaults.standard.dictionary(forKey: waitingSinceKey) as? [String: Date] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: waitingSinceKey) }
    }

    /// The mark on an integration's clean-up, to drop if it's added again.
    static func integrationMark(_ id: String) -> String { "# Kuvo Code: integration \(id)\n" }

    /// The integration a waiting script was marked with, if any.
    static func integration(markedIn script: String) -> String? {
        let prefix = "# Kuvo Code: integration "
        guard script.hasPrefix(prefix), let end = script.firstIndex(of: "\n") else { return nil }
        return String(script[script.index(script.startIndex, offsetBy: prefix.count)..<end])
    }

    /// Runs `script` on the machine the next time it answers (tried at once too).
    func runLater(_ script: String, on machine: String) {
        Self.waiting[machine, default: []].append(script)
        // Given up on 30 days after the last thing queued or run there, not the first.
        Self.waitingSince[machine] = .now
        Task { [weak self] in await self?.runWaiting(only: machine) }
    }

    /// Drops the clean-ups marked `mark` (whatever they were for came back), on every machine.
    func dropWaiting(marked mark: String, on machine: String) {
        guard let scripts = Self.waiting[machine] else { return }
        let kept = scripts.filter { !$0.hasPrefix(mark) }
        if kept.count != scripts.count { setWaiting(kept, on: machine) }
    }

    private func setWaiting(_ scripts: [String], on machine: String) {
        Self.waiting[machine] = scripts.isEmpty ? nil : scripts
        if scripts.isEmpty { Self.waitingSince[machine] = nil }
    }

    @ObservationIgnored private var runningWaiting = false
    /// Machines a removal is running on now.
    @ObservationIgnored private var removing: Set<String> = []

    /// Until no removal runs on the machine (a minute at most): one added again starts after it.
    func waitForRemoval(of machine: String) async {
        for _ in 0..<240 where removing.contains(machine) { try? await Task.sleep(for: .milliseconds(250)) }
    }
    /// Machines asked for while a pass ran, for one more after it.
    @ObservationIgnored private var askedWhileRunning: Set<String?> = []

    /// Runs what waits, each machine's in order, for the machines that answer (`only` one, when
    /// it just connected). The queue is read afresh for each, as it can change meanwhile, and only
    /// the one that ran leaves it. A removal for a machine added again is dropped, never run.
    func runWaiting(only: String? = nil) async {
        guard !runningWaiting else {
            askedWhileRunning.insert(only)
            return
        }
        runningWaiting = true
        await runWaitingPass(only: only)
        // What was asked for meanwhile (a machine that just connected), once more.
        while !askedWhileRunning.isEmpty {
            let asked = askedWhileRunning
            askedWhileRunning = []
            if asked.contains(nil) {
                await runWaitingPass(only: nil)
            } else {
                for machine in asked.compactMap({ $0 }) { await runWaitingPass(only: machine) }
            }
        }
        runningWaiting = false
    }

    private func runWaitingPass(only: String?) async {
        for machine in Self.waiting.keys where only == nil || only == machine {
            if let since = Self.waitingSince[machine], since.timeIntervalSinceNow < -30 * 86_400 {
                setWaiting([], on: machine)
                continue
            }
            while let script = Self.waiting[machine]?.first {
                let listed = list.contains { $0.id == machine }
                let removal = script.hasPrefix(Self.removalMark)
                // An integration's removal, added back there since (from a phone, with this Mac
                // away): what it has now stays.
                let addedBack = Self.integration(markedIn: script).map { id in
                    engines[machine].map { $0.config.isLoaded && $0.config.value(at: MCPSettings.path + [id]) != nil } ?? false
                } ?? false
                if !(removal && listed) && !addedBack {
                    // A removal under way: one added again meanwhile waits for it to end (see
                    // `waitForRemoval`) rather than starting while it signs out and stops.
                    if removal { removing.insert(machine) }
                    let ran = (try? await Machine(destination: machine).connection.run(script)) != nil
                    if removal { removing.remove(machine) }
                    guard ran else { break }
                }
                var left = Self.waiting[machine] ?? []
                if let index = left.firstIndex(of: script) { left.remove(at: index) }
                setWaiting(left, on: machine)
                if !left.isEmpty { Self.waitingSince[machine] = .now }
            }
        }
    }

    /// What removing a machine does there, without its engine: stops it (its bots stop waking),
    /// signs out of the accounts it had (in its own database, with its own runtime) and of its
    /// coding agents, and deletes what integrations kept there. Its sessions stay.
    static var removalScript: String {
        removalMark + """
        K="$HOME/\(RemoteEngineInstaller.root)"
        # Another Mac's engine there now: left to it, with what's in it.
        case "$(cat "$K/run/engine.json" 2>/dev/null)" in *'"mac":"\(MachineEngine.macID)"'*) ;; *'"mac":"'*) exit 0 ;; esac
        \(RemoteServer.stopCommand)
        sleep 1
        E=$(ls -d "$K"/engine/*/opencode 2>/dev/null | tail -n 1)
        if [ -x "$E" ] && [ -f "$K/data/opencode/opencode.db" ]; then
          KUVO_DB="$K/data/opencode/opencode.db" BUN_BE_BUN=1 "$E" -e 'const { Database } = require("bun:sqlite"); const db = new Database(process.env.KUVO_DB); db.run("DELETE FROM credential"); db.close()' || exit 1
        fi
        rm -rf "$K/integrations"
        \(leftovers)
        \(agentsSignOut)
        """
    }

    /// What a machine keeps to work on its own (`RemoteServer.launchScript`), which goes when you
    /// remove it: its keys, how its engine starts again after a restart, and the crontab line that
    /// does it (Kuvo Code's own folder's only).
    /// A removal's, as `removalScript` is: one waiting for the machine is dropped if you add it
    /// again, and leaves another Mac's engine there with what it has.
    static var leftoversScript: String {
        removalMark + """
        K="$HOME/\(RemoteEngineInstaller.root)"
        case "$(cat "$K/run/engine.json" 2>/dev/null)" in *'"mac":"\(MachineEngine.macID)"'*) ;; *'"mac":"'*) exit 0 ;; esac
        \(leftovers)
        true
        """
    }

    /// This Mac's key on your machines' bridges (`PhoneLink.macKey`), for a machine you remove to
    /// stop counting it among its Macs. Set by the app.
    static var linkKey: () -> String? = { nil }

    private static var leftovers: String {
        // Its bridge no longer counts this Mac among its Macs, nor the peers it gave (PROTOCOL.md,
        // "Peers"); another Mac's stay.
        let leave = linkKey().map { key in
            """
            L=$(ls -d "$K"/engine/*/opencode 2>/dev/null | tail -n 1)
            if [ -x "$L" ] && [ -f "$K/bin/kuvo-link.js" ]; then (cd "$K" && KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$L" "$K/bin/kuvo-link.js" leave '\(key)') >/dev/null 2>&1 || true; fi

            """
        } ?? ""
        return leave + """
        rm -rf "$K/keys" "$K/box/keys"
        rm -f "$K/run/launch.env" "$K/run/launch.notes" "$K/bin/kuvo-start" "$K/bin/.kuvo-start-keeper" "$K/bin/kuvo-launch" "$K/bin/.kuvo-boot"
        \(RemoteServer.rebootCrontabRemoval)
        """
    }

    /// Signs the coding agents there out: their sign-ins' files, under `$K` (their conversations
    /// stay, as the engine's sessions do).
    static let agentsSignOut = """
        [ -d "$K/agents" ] && find "$K/agents" -path "$K/agents/runtime" -prune -o \\( -name .credentials.json -o -name auth.json -o -name 'auth.json.*' -o -name acp_token.json -o -name 'acp_token.json.*' -o -name 'oauth-token.json*' \\) -type f -exec rm -f {} + 2>/dev/null
        true
        """

    func engine(_ id: String?) -> MachineEngine? {
        id.flatMap { engines[$0] }
    }

    @discardableResult
    func add(_ destination: String) -> MachineEngine {
        let machine = Machine(destination: destination.trimmingCharacters(in: .whitespaces))
        if let engine = engines[machine.id] { return engine }
        // Added again: not to be signed out of and stopped as one removed.
        if let waiting = Self.waiting[machine.id] {
            setWaiting(waiting.filter { !$0.hasPrefix(Self.removalMark) }, on: machine.id)
        }
        list.append(machine)
        Analytics.shared.track("machine_added")
        let engine = makeEngine(machine)
        engines[machine.id] = engine
        save()
        return engine
    }

    private func makeEngine(_ machine: Machine) -> MachineEngine {
        let engine = MachineEngine(machine: machine)
        engine.onIdentity = { [weak self] identity in self?.note(identity, of: machine.id) }
        engine.onReached = { [weak self] address in self?.noteReached(address, of: machine.id) }
        return engine
    }

    // MARK: One computer, several addresses

    /// A machine folded into another, being the same computer at another address: its name, and
    /// the other's. The app moves what it kept under the first (its projects, its bots).
    @ObservationIgnored var onFolded: (_ address: String, _ machine: String) -> Void = { _, _ in }
    /// The last machine folded into another, to say so in Settings › Machines.
    private(set) var folded: (address: String, machine: String)?

    /// The machine already here that the computer at `address` is, if it's one of them.
    func machine(calling identity: String) -> Machine? {
        list.first { $0.identity == identity }
    }

    /// What `machine` calls itself, read: kept, and if another machine here is the same computer,
    /// the one added later becomes one of the other's addresses.
    func note(_ identity: String, of machine: String) {
        guard let index = list.firstIndex(where: { $0.id == machine }) else { return }
        if list[index].identity != identity {
            list[index].identity = identity
            engines[machine]?.update(list[index])
            save()
        }
        // The one added first stays; any other is one of its addresses.
        let same = list.filter { $0.identity == identity }
        guard let first = same.first else { return }
        for other in same.dropFirst() { fold(other.id, into: first.id) }
    }

    /// `machine` answered at `address`: tried first next time.
    func noteReached(_ address: String, of machine: String) {
        guard let index = list.firstIndex(where: { $0.id == machine }), list[index].reachedAt != address else { return }
        list[index].reachedAt = address
        engines[machine]?.update(list[index])
        save()
    }

    /// You say `machine` is the same computer as `other` (one of them can't be reached to ask):
    /// it becomes one of `other`'s addresses. Not when they've said they're two computers.
    @discardableResult
    func sameComputer(_ machine: String, as other: String) -> Bool {
        guard let one = list.first(where: { $0.id == machine }), let two = list.first(where: { $0.id == other }), one.id != two.id else { return false }
        if let a = one.identity, let b = two.identity, a != b { return false }
        fold(machine, into: other)
        return true
    }

    /// Says in Settings › Machines that `address`, added as a machine, was one already here.
    func noteAdded(_ address: String, to machine: String) {
        folded = (address, machine)
    }

    /// `address` reaches `machine` too: tried when the one in use doesn't answer.
    func addAddress(_ address: String, to machine: String) {
        guard let index = list.firstIndex(where: { $0.id == machine }), !list[index].addresses.contains(address) else { return }
        list[index].otherAddresses = (list[index].otherAddresses ?? []) + [address]
        engines[machine]?.update(list[index])
        save()
    }

    /// No longer tries `address` for `machine` (not its name, which every other is an address of).
    func removeAddress(_ address: String, from machine: String) {
        guard let index = list.firstIndex(where: { $0.id == machine }), address != machine else { return }
        list[index].otherAddresses?.removeAll { $0 == address }
        if list[index].otherAddresses?.isEmpty == true { list[index].otherAddresses = nil }
        if list[index].reachedAt == address { list[index].reachedAt = nil }
        if SSHConnection(destination: machine).address == address { SSHConnection.route(machine, to: nil) }
        engines[machine]?.update(list[index])
        save()
    }

    /// `duplicate` is `machine`, reached at another address: one machine from now on, under
    /// `machine`'s name, with `duplicate`'s addresses among its own. Nothing there is signed out
    /// or stopped, as removing it would: the engine it reached is `machine`'s.
    func fold(_ duplicate: String, into machine: String) {
        guard duplicate != machine, let other = list.first(where: { $0.id == duplicate }), let index = list.firstIndex(where: { $0.id == machine }) else { return }
        var merged = list[index]
        var addresses = merged.otherAddresses ?? []
        for address in other.addresses where address != merged.destination && !addresses.contains(address) { addresses.append(address) }
        merged.otherAddresses = addresses.isEmpty ? nil : addresses
        merged.identity = merged.identity ?? other.identity
        list[index] = merged
        engines[machine]?.update(merged)
        // Its connection goes; the engine there goes on, as this one's.
        engines[duplicate]?.browser.reset()
        engines[duplicate]?.disconnect()
        engines[duplicate] = nil
        list.removeAll { $0.id == duplicate }
        SSHConnection.route(duplicate, to: nil)
        // What waited for it waits for this one, but a removal: nothing was removed.
        if let scripts = Self.waiting[duplicate] {
            setWaiting([], on: duplicate)
            let kept = scripts.filter { !$0.hasPrefix(Self.removalMark) }
            if !kept.isEmpty { Self.waiting[machine, default: []] += kept }
        }
        save()
        folded = (duplicate, machine)
        onFolded(duplicate, machine)
    }

    /// Takes a machine off this Mac. It keeps running there as a box of its own, with its
    /// sessions, bots, sign-ins and keys, for your phones and for when you add it again;
    /// `uninstall` also stops its engine there and deletes the sign-ins and keys it keeps, and how
    /// it starts after a restart (its sessions stay, for when it's added again).
    func remove(_ id: String, uninstall: Bool) {
        if !uninstall {
            engines[id]?.disconnect()
        } else if let engine = engines[id] {
            if engine.isReady {
                // Another Mac's engine: it goes on for that Mac, with what's in it (whose accounts
                // are whose can't be told there).
                if engine.isAnotherMacsEngine {
                    engine.disconnect()
                } else {
                    // A removal under way: added again meanwhile, it waits (see `waitForRemoval`).
                    removing.insert(id)
                    Task { [weak self] in
                        let forgotten = await engine.forgetAccounts()
                        await engine.shutDown()
                        // What it kept to work on its own goes too: its keys, how it starts after
                        // a restart, and the crontab line that does it.
                        let leftovers = Self.leftoversScript
                        let tidied = await Task.detached { RemoteShell.run(leftovers, on: id) }.value != nil
                        self?.removing.remove(id)
                        // What didn't go, the next time it answers.
                        if !forgotten { self?.runLater(Self.removalScript, on: id) } else if !tidied { self?.runLater(Self.leftoversScript, on: id) }
                    }
                }
            } else {
                // A start under way ends here; what it got to, and an engine there from before,
                // go the next time the machine answers.
                engine.disconnect()
                runLater(Self.removalScript, on: id)
            }
        }
        engines[id] = nil
        list.removeAll { $0.id == id }
        save()
    }

    private func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: Self.key)
    }

    private static func load() -> [Machine] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        do {
            return try JSONDecoder().decode([Machine].self, from: data)
        } catch {
            // One that won't read (a newer version's, or damaged) is set aside, as Kuvo Code's
            // files are (`JSONFile`), before adding a machine writes over it; once, however many
            // launches find it there.
            let aside = UserDefaults.standard.dictionaryRepresentation().filter { $0.key.hasPrefix(unreadableKey) }
            if !aside.values.contains(where: { $0 as? Data == data }) {
                UserDefaults.standard.set(data, forKey: "\(unreadableKey)-\(Int(Date.now.timeIntervalSince1970))")
            }
            Logger(subsystem: "run.kuvo.code", category: "machine").error("The machines couldn't be read and were set aside: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    /// Where machines that wouldn't read are kept, followed by when.
    static let unreadableKey = "machines.unreadable"
}

/// A sign-in to an agent on a machine whose page sends your browser back to `localhost` there
/// (Claude Code's, Codex's, Grok's): that port, forwarded from this Mac to the machine over SSH
/// while the sign-in runs (a quarter of an hour at most), so the page reaches the agent there.
@MainActor @Observable final class SignInForward {
    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var timeout: Task<Void, Never>?
    /// Its port couldn't be forwarded (something on this Mac has it): why, to say beside the sign-in.
    private(set) var problem: String?

    /// Why the forward ended, from what ssh said: the port taken on this Mac, or the machine out
    /// of reach (its own words, last line).
    nonisolated static func problem(_ said: String, port: Int, machine: String) -> String {
        if said.range(of: #"(?i)address already in use|cannot listen to port|port forwarding failed|bind \[|bind: "#, options: .regularExpression) != nil {
            return "Something on this Mac is using port \(port), where the sign-in page comes back, so it can't reach \(machine). Quit what uses it (another sign-in, say), then try again."
        }
        let last = said.split(whereSeparator: \.isNewline).last.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        return "The sign-in page can't come back to \(machine): it couldn't be reached" + (last.isEmpty ? "." : " (\(last)).") + " Check that it's connected, then try again."
    }

    /// Forwards the port that `url`'s `redirect_uri` names on localhost, if it names one.
    func start(for url: URL, on machine: String) {
        guard let port = Self.callbackPort(in: url) else { return }
        stop()
        problem = nil
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/ssh")
        // (Not the shared connection: this one's forward ends with it.) What runs there reads this
        // app's end of a pipe, so it ends as the connection does, as the engine's tunnel does.
        process.arguments = Machine(destination: machine).connection.arguments(
            running: "cat >/dev/null", extra: ["-o", "ExitOnForwardFailure=yes", "-L", "\(port):localhost:\(port)"], shared: false)
        process.standardInput = Pipe.unshared()
        process.standardOutput = FileHandle.nullDevice
        let errors = Pipe()
        process.standardError = errors
        process.terminationHandler = { [weak self] ended in
            // Ended by itself right away: the port taken here, or the machine out of reach.
            guard ended.terminationReason == .exit, ended.terminationStatus != 0 else { return }
            let said = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            Task { @MainActor in
                guard let self, self.process === ended else { return }
                self.problem = Self.problem(said, port: port, machine: machine)
                self.process = nil
            }
        }
        guard (try? process.run()) != nil else { return }
        self.process = process
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(900))
            if !Task.isCancelled { self?.stop() }
        }
    }

    func stop() {
        timeout?.cancel()
        timeout = nil
        process?.terminationHandler = nil
        if process?.isRunning == true { process?.terminate() }
        process = nil
    }

    /// The port a sign-in page sends your browser back to on `localhost`, if it does.
    nonisolated static func callbackPort(in url: URL) -> Int? {
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let redirect = items.first(where: { $0.name == "redirect_uri" })?.value,
              let target = URL(string: redirect), ["localhost", "127.0.0.1"].contains(target.host ?? ""),
              let port = target.port, port > 1024 else { return nil }
        return port
    }
}

/// Where a folder is. A folder on a machine is written `ssh://<machine><path>` wherever the app
/// keys things by folder (projects, tabs, settings), so it can never pass for one of this Mac's
/// paths; its machine's engine is given the plain path.
nonisolated enum RemoteFolder {
    static let scheme = "ssh://"

    static func folder(_ path: String, on machine: String) -> String {
        scheme + machine + path
    }

    /// How a machine's folders start: what its engine's API takes off and puts back.
    static func prefix(for machine: String) -> String {
        scheme + machine
    }

    /// The machine and the path on it, for a folder on a machine.
    static func parse(_ folder: String) -> (machine: String, path: String)? {
        guard folder.hasPrefix(scheme) else { return nil }
        let rest = folder.dropFirst(scheme.count)
        guard let slash = rest.firstIndex(of: "/") else { return nil }
        return (String(rest[..<slash]), String(rest[slash...]))
    }

    static func machine(of folder: String) -> String? {
        parse(folder)?.machine
    }

    static func isRemote(_ folder: String) -> Bool {
        folder.hasPrefix(scheme)
    }
}

/// Short commands on a machine, over its shared SSH connection, for what the panel and sheets
/// read there (the engine has no file API).
nonisolated enum RemoteShell {
    /// Runs `script` with `sh` on `machine`: its output, or nil when it (or SSH) fails.
    static func run(_ script: String, on machine: String) -> Data? {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/ssh")
        process.arguments = SSHConnection(destination: machine).arguments(running: script)
        process.standardInput = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? data : nil
    }

    /// Copies `file` into `folder` under the home folder of `machine` (inside Kuvo Code's own,
    /// `~/.kuvo-code/...`): its full path there, or nil when it couldn't. The folder is made for
    /// it, and isn't used if it's there already, so a file never takes another's place. Copies
    /// there more than two weeks old go, so attachments don't pile up.
    static func upload(_ file: URL, into folder: String, on machine: String) -> String? {
        guard let input = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? input.close() }
        let parent = "\"$HOME\"/" + SSHConnection.quoted((folder as NSString).deletingLastPathComponent)
        let target = "\"$HOME\"/" + SSHConnection.quoted(folder)
        let name = SSHConnection.quoted(file.lastPathComponent)
        let script = "find \(parent) -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null; umask 077; mkdir -p \(parent) && mkdir \(target) && cat > \(target)/\(name) && cd \(target) && printf '%s/%s' \"$(pwd -P)\" \(name)"
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/ssh")
        process.arguments = SSHConnection(destination: machine).arguments(running: script)
        process.standardInput = input
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let path = String(decoding: data, as: UTF8.self)
        return process.terminationStatus == 0 && path.hasPrefix("/") ? path : nil
    }

    /// A folder typed on `machine` (`~` for its home), as the full path it is there, or nil when
    /// there's no such folder.
    static func resolve(_ typed: String, on machine: String) -> String? {
        let typed = typed.trimmingCharacters(in: .whitespaces)
        guard !typed.isEmpty else { return nil }
        let target: String
        if typed == "~" {
            target = "\"$HOME\""
        } else if typed.hasPrefix("~/") {
            target = "\"$HOME\"/" + SSHConnection.quoted(String(typed.dropFirst(2)))
        } else if typed.hasPrefix("/") {
            target = SSHConnection.quoted(typed)
        } else {
            target = "\"$HOME\"/" + SSHConnection.quoted(typed)
        }
        guard let data = run("cd \(target) && pwd -P", on: machine) else { return nil }
        let path = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return path.hasPrefix("/") ? path : nil
    }
}

nonisolated extension RemoteFolder {
    /// A folder or file as a URL: a file URL on this Mac, `ssh://machine/path` on a machine, so
    /// what's there is never read from this Mac's disk by mistake.
    static func url(_ folder: String) -> URL {
        guard let (machine, path) = parse(folder) else { return URL(filePath: folder) }
        var components = URLComponents()
        components.scheme = "ssh"
        let parts = machine.split(separator: "@", maxSplits: 1).map(String.init)
        if parts.count == 2 { components.user = parts[0] }
        components.host = parts.last
        components.path = path
        return components.url ?? URL(filePath: path)
    }

    /// A file on a machine: the machine and the path there.
    static func parse(_ url: URL) -> (machine: String, path: String)? {
        guard url.scheme == "ssh", let host = url.host(percentEncoded: false) else { return nil }
        return ((url.user(percentEncoded: false).map { $0 + "@" } ?? "") + host, url.path(percentEncoded: false))
    }

    /// A URL as the app keys folders: its path on this Mac, `ssh://machine/path` on a machine.
    static func folder(of url: URL) -> String {
        parse(url).map { folder($0.path, on: $0.machine) } ?? url.path
    }

    /// A path the agent named (absolute, or relative to `directory`), as a URL on the machine
    /// `directory` is on.
    static func fileURL(_ path: String, in directory: String) -> URL {
        if let machine = machine(of: directory) {
            return url(path.hasPrefix("/") ? folder(path, on: machine) : directory + "/" + path)
        }
        return path.hasPrefix("/") ? URL(filePath: path) : URL(filePath: directory).appending(path: path)
    }
}

nonisolated extension RemoteShell {
    /// A folder's entries on a machine, or nil when it can't be read.
    static func list(_ url: URL) -> [(name: String, isDirectory: Bool)]? {
        guard let (machine, path) = RemoteFolder.parse(url),
              let data = run("cd \(SSHConnection.quoted(path)) && find . -mindepth 1 -maxdepth 1 -printf '%Y\\t%P\\0'", on: machine) else { return nil }
        return String(decoding: data, as: UTF8.self).split(separator: "\0").compactMap { line in
            let parts = line.split(separator: "\t", maxSplits: 1)
            guard parts.count == 2 else { return nil }
            return (String(parts[1]), parts[0] == "d")
        }
    }

    /// Up to `limit` bytes of a file on a machine.
    static func read(_ url: URL, limit: Int) -> Data? {
        guard let (machine, path) = RemoteFolder.parse(url) else { return nil }
        return run("head -c \(limit) -- \(SSHConnection.quoted(path))", on: machine)
    }

    /// Whether a folder (not a link to one) is at `url` on its machine; nil when it can't say.
    static func isFolder(_ url: URL) -> Bool? {
        guard let (machine, path) = RemoteFolder.parse(url) else { return nil }
        let quoted = SSHConnection.quoted(path)
        guard let data = run("if [ -d \(quoted) ] && [ ! -L \(quoted) ]; then echo yes; else echo no; fi", on: machine) else { return nil }
        return String(decoding: data, as: UTF8.self).hasPrefix("yes")
    }

    /// Whether anything (a link too, even a broken one) is at a path on a machine; nil when it
    /// can't be asked.
    static func exists(_ url: URL) -> Bool? {
        guard let (machine, path) = RemoteFolder.parse(url) else { return nil }
        let quoted = SSHConnection.quoted(path)
        guard let data = run("if [ -e \(quoted) ] || [ -L \(quoted) ]; then echo yes; else echo no; fi", on: machine) else { return nil }
        return String(decoding: data, as: UTF8.self).hasPrefix("yes")
    }

    /// Moves a file on a machine into `~/.kuvo-code/trash`, where it can still be found: nil
    /// when it went, else why not.
    static func trash(_ url: URL) -> String? {
        guard let (machine, path) = RemoteFolder.parse(url) else { return "Not on a machine." }
        let script = """
            T="$HOME/\(RemoteEngineInstaller.root)/trash/$(date +%Y%m%d-%H%M%S)-$$"
            mkdir -p "$T" && mv -- \(SSHConnection.quoted(path)) "$T/"
            """
        return run(script, on: machine) == nil ? "Couldn’t move \((path as NSString).lastPathComponent) out of the way on \(machine)." : nil
    }

    /// The files under a folder on a machine, relative to it, skipping the usual heavy folders.
    static func files(in url: URL, skipping skip: Set<String>, limit: Int) -> [String]? {
        guard let (machine, path) = RemoteFolder.parse(url) else { return nil }
        let pruned = skip.sorted().map { "-name \(SSHConnection.quoted($0))" }.joined(separator: " -o ")
        let script = "cd \(SSHConnection.quoted(path)) && find . \\( \(pruned) \\) -prune -o -type f -printf '%P\\0' | head -z -n \(limit)"
        guard let data = run(script, on: machine) else { return nil }
        return String(decoding: data, as: UTF8.self).split(separator: "\0").map(String.init)
    }
}
