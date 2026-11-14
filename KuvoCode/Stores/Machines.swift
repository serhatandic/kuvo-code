import ClientDesign
import ClientSessions
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
    /// Its name here: this Mac's own box goes by this Mac's.
    var name: String { isThisMac ? PhoneLink.computerName : destination }
    /// This Mac's own box, already in its home folder, which the app attached to in place
    /// (`SSHConnection.thisMac`): reached with no SSH, never saved with your machines, and never
    /// removed, stopped or signed out of from here.
    var isThisMac: Bool { destination == SSHConnection.thisMac }
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
    private(set) var state = AppModel.EngineState.preparing {
        didSet {
            switch state {
            case .preparing, .failed: step = nil
            default: break
            }
        }
    }
    /// Where a connection under way is: what the loaders that show it say, with how far.
    private(set) var step: Step?
    private(set) var api: OpenCodeAPI?
    /// False while the live event feed is down.
    private(set) var isLive = false
    /// Waiting to try again by itself, after the connection dropped.
    var isRetrying = false
    /// The tries to connect again under way (`AppModel.retry`), and which round of them it is: a
    /// round started over (the Mac woke) or ended (Disconnect) leaves the flag to the next one.
    @ObservationIgnored var retryLoop: Task<Void, Never>?
    @ObservationIgnored var retryRound = 0
    /// How its last failure may pass, for trying again.
    private(set) var failureKind = FailureKind.away
    /// Its last failure may pass by itself, so trying again is worth it; not one trying again
    /// won't change (its key refused, a changed host key, a system the engine doesn't run on),
    /// which is said at once, with Try Again.
    var failureMayPass: Bool { failureKind != .lasting }
    /// It was connected since the app opened: a machine that works, so what goes wrong while it
    /// comes back (it's restarting, its engine coming up) passes, but for what never would.
    @ObservationIgnored private var wasConnected = false
    /// Its last try didn't get an answer (`away`): one that answers now is on its way back too,
    /// though it wasn't connected since the app opened (the app opened as it restarted, #285).
    @ObservationIgnored private var lastTryAway = false
    /// How long it's answered without coming up (`comingBack`), in seconds waited between tries,
    /// over every round of tries, so a wake or Connect Now doesn't start it over; nil once it
    /// didn't answer, or connected.
    @ObservationIgnored var comingBackWaited: Int?

    enum FailureKind {
        /// It didn't answer (the network, the machine away or restarting, waiting to be unlocked):
        /// tried for as long as it takes.
        case away
        /// It answered, but didn't take this Mac's key or its engine didn't come up, on a machine
        /// that was connected a moment ago: it may be on its way back (restarting), so tried for
        /// a while, then said.
        case comingBack
        /// Trying again won't change it: said at once.
        case lasting
    }
    /// Disconnect was pressed (here or from a phone): it isn't connected again by itself, as this
    /// Mac's engine starts again, until it's connected.
    var isDisconnected = false
    // COMPAT(0.7 engine-stop): an engine an older Mac stopped. Goes 3 months after 0.8.0.
    /// Its engine is stopped on purpose (Stop, here or from anywhere): it stays so until Start.
    private(set) var isStopped = false
    /// It started with this Mac's settings just now, having none of its own: your accounts go
    /// too, once (`AppModel.syncSignIns`).
    @ObservationIgnored var seededNow = false
    // COMPAT(0.7 engine-stop): Start pressed, for an engine an older Mac stopped. Goes 3 months after 0.8.0.
    /// Start was pressed here: the next connection starts it if it's stopped, until one does (one
    /// that fails, the machine away, carries it to Try Again), or it's stopped or disconnected.
    var startWanted = false
    /// Make This Mac Its Home: the next start takes the engine another Mac started there, starting
    /// it again as this Mac's.
    var takingHome = false
    /// Make This Mac Its Home under way: the Mac it's moving from. Kept here, not in Settings, so a
    /// move the phone asked for shows too, and one goes on with Settings closed.
    var movingHomeFrom: OtherMac?
    /// Why the last move asked for in Settings didn't work, until it's been seen.
    var homeFailure: String?
    /// The box there was set up by a newer Kuvo Code than this app (`BoxVersion`): its engine and
    /// files are left as they are.
    private(set) var boxIsNewer = false
    let catalog = Catalog()
    /// Its engine's settings, its own, through its box (`BoxSettings`): read as it's started, and
    /// again as they change there.
    let config: EngineConfig
    /// The coding agents there: the agents bridge beside its engine, through the same tunnel.
    let agents: OutsideAgents
    // COMPAT(0.7 engine-stop): an older Mac's engine may run without the agents bridge. Goes 3 months after 0.8.0.
    /// Its engine started with the agents bridge beside it (an older one didn't).
    var hasAgentsBridge: Bool { server?.agentsEndpoint != nil }
    /// Its browser, which its agents browse with, shown live in the panel.
    let browser: MachineBrowser

    @ObservationIgnored private var server: RemoteServer?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var isStopping = false
    /// The connection while it's up, which what runs for it runs in (`MachineConnection`).
    @ObservationIgnored private(set) var activeConnection: MachineConnection?
    /// It left this Mac (removed, or found to be another machine here): it never connects again.
    @ObservationIgnored private(set) var isRetired = false
    /// Starts over begun (`AppModel.restartEngine`), so a Connect meanwhile ends the one under way.
    @ObservationIgnored var restarts = 0
    /// Copying its sign-ins, now or last: the next waits for it.
    @ObservationIgnored var signInTurn: Task<Void, Never>?
    /// Events for the stores that span every machine (sessions); the catalog takes its own.
    @ObservationIgnored var onEvent: (ServerEvent) -> Void = { _ in }
    /// The feed came back after a gap: whatever it missed has to be read again.
    @ObservationIgnored var onReconnect: () async -> Void = {}
    /// The connection closed without being asked to (the machine restarted, the network went).
    @ObservationIgnored var onExit: () -> Void = {}
    /// Stopped, then started from elsewhere (a phone, another Mac): connect to it.
    @ObservationIgnored var onStartedElsewhere: () -> Void = {}
    // COMPAT(0.7 engine-stop): watching an engine an older Mac stopped, for a start from elsewhere. Goes 3 months after 0.8.0.
    @ObservationIgnored private var stoppedWatch: Task<Void, Never>?
    private let log = Logger(subsystem: "run.kuvo.code", category: "machine")

    init(machine: Machine) {
        self.machine = machine
        browser = MachineBrowser(machine: machine)
        agents = OutsideAgents(machine: machine.id)
        catalog.outsideAgents = agents
        catalog.machine = machine.id
        // (The box attached in place: over its server where it can be, `OwnBoxHome`.)
        let box = machine.isThisMac ? OwnBoxHome.client : BoxClient(box: machine.id, transport: MachineBoxTransport(connection: machine.connection))
        catalog.box = box
        // This Mac's own box, moved into a home of its own: its settings file there, to open.
        config = EngineConfig(remote: BoxSettings(client: box), file: machine.isThisMac && OwnBoxHome.hasMoved ? OwnBoxHome.folder.map { EngineFolders(root: $0).configFile } : nil)
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
    /// The update gate this app holds boxes at (`BoxGates`, #679): set by the app.
    @ObservationIgnored var gates: BoxGates?

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
        // COMPAT(0.7 engine-stop): `stopped`. Goes 3 months after 0.8.0.
        case notConnected, connecting, reconnecting, installing, connected, failed, stopped

        /// It's getting there by itself (a spinner), nothing to do.
        var isUnderWay: Bool { [.connecting, .reconnecting, .installing].contains(self) }
    }

    var connection: Connection {
        switch state {
        case .preparing: isStopped ? .stopped : .notConnected
        // At 0 it's only checking the engine it has, until it downloads or copies one.
        case .downloading(let progress) where progress > 0: .installing
        case .downloading, .starting: step?.isInstalling == true ? .installing : isRetrying ? .reconnecting : .connecting
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
        case .installing: (step?.words ?? "Installing the engine") + "…"
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
        case .installing: step?.isCopying == true ? "Copying the engine to \(name)…" : "Installing the engine on \(name)…"
        case .connected: "Connected to \(name)"
        case .failed: "Couldn’t connect to \(name)"
        case .stopped: "\(name)’s engine is stopped"
        }
    }

    /// A connection under way, step by step: what it's doing and how far, for its loaders (and a
    /// phone's, `kuvo/machines`).
    enum Step: Equatable {
        case checking
        /// The engine's package, to this Mac (kept for the next machine), a share of it.
        case downloading(fraction: Double)
        /// The package, to the machine, bytes of its size.
        case copying(sent: Int64, total: Int64)
        /// Its engine (and what starts with it) set up there and started.
        case starting
        /// Up: its sessions being read.
        case reading
        /// Its box, older than this app needs, being brought up to date (`BoxGates`, #679).
        case updating

        /// As `kuvo/machines` names it.
        var name: String {
            switch self {
            case .checking: "checking"
            case .downloading: "downloading"
            case .copying: "copying"
            case .starting: "starting"
            case .reading: "reading"
            case .updating: "updating"
            }
        }

        /// In a few words, for a row: "Copying the engine", as a phone says it too.
        var words: String { MachineWords.step(name) ?? "Connecting" }

        /// Under a heading that names the machine: "Copying the engine to devbox".
        func line(_ name: String) -> String {
            switch self {
            case .checking: "Checking \(name)"
            case .copying: "Copying the engine to \(name)"
            case .starting: "Starting the engine on \(name)"
            case .updating: "Updating Kuvo Code on \(name)"
            default: words
            }
        }

        /// How far, where it can say.
        var fraction: Double? {
            switch self {
            case .downloading(let fraction): fraction
            case .copying(let sent, let total) where total > 0: Double(sent) / Double(total)
            default: nil
            }
        }

        var isInstalling: Bool {
            switch self {
            case .downloading, .copying: true
            default: false
            }
        }

        var isCopying: Bool {
            if case .copying = self { return true }
            return false
        }
    }

    /// How far its engine's copy to it has come, while it's being copied there: what its ring
    /// fills to (one bar, the copy's; a download to this Mac first only turns).
    var installProgress: Double? { connection == .installing && step?.isCopying == true ? step?.fraction : nil }

    /// Its status in a row, with how far where there's a number to tell ("Copying the engine · 41
    /// of 98 MB").
    var statusDetail: String {
        guard connection == .installing, let step else { return statusText }
        return switch step {
        case .copying(let sent, let total): MachineWords.installing(step: step.name, sent: sent, total: total) ?? statusText
        case .downloading(let fraction): MachineWords.installing(step: step.name, fraction: fraction) ?? statusText
        default: statusText
        }
    }

    /// What Settings › Machines offers to do with it now, and a phone with it.
    enum Offer: String {
        case disconnect
        // COMPAT(0.7 engine-stop): Start, the offer for an engine an older Mac stopped. Goes 3 months after 0.8.0.
        /// Its engine was stopped by a Mac with an older Kuvo Code (there's no Stop any more).
        case start
        case connect, connectNow
    }

    var offer: Offer? {
        // This Mac's own box, attached in place (#333): never disconnected (it's the window's) and
        // never started from the app (it starts on its own), so only Connect, when it's lost.
        if machine.isThisMac {
            return switch state {
            case .failed, .preparing: isRetrying ? .connectNow : .connect
            default: nil
            }
        }
        return switch state {
        case .ready: .disconnect
        // COMPAT(0.7 engine-stop): Start. Goes 3 months after 0.8.0.
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
        var seed: () async throws -> MachineBox.Seed = { .init(settings: [:], keys: [:]) }
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
    /// This Mac's name as the launch notes keep it: without braces, quotes or backslashes, which the
    /// machine's keeper reads the notes past.
    static var noteName: String { PhoneLink.computerName.filter { !"{}\"\\".contains($0) } }

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
        // (This Mac's own box, attached in place, runs as it is: never started again from here.)
        guard !machine.isThisMac, let engine = server?.engine else { return false }
        // COMPAT(0.7 engine-stop): an engine an older Mac started, with its settings. Goes 3 months after 0.8.0.
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

    /// The engine there is newer than this app's (another Mac's, which this one mustn't put back).
    var engineIsNewer: Bool {
        server.map { $0.engine.version.compare(OpenCodeEngine.version, options: .numeric) == .orderedDescending } ?? false
    }

    /// Another Mac, which runs the engine there: by the name its start noted, where it did.
    struct OtherMac: Equatable { var name: String? }

    /// Who else uses it, as its box last said: your other Macs (by name) and how many phones
    /// reach it. What Uninstall would stop it for. Nil until read.
    struct AlsoUsedBy: Equatable {
        var macs: [String]
        var phones: Int
        var isEmpty: Bool { macs.isEmpty && phones == 0 }
    }
    var alsoUsedBy: AlsoUsedBy?
    /// Which version its pieces run, as its box last said (`kuvo/info`'s `pieces`): a line shows
    /// under it while one runs an older version than its files. Nil until read, or from a box from
    /// before it said.
    var pieces: MachinePieces?

    /// The Mac that runs the engine there, when it's another one.
    var otherMac: OtherMac? { isAnotherMacsEngine ? OtherMac(name: server?.engine.notes["macName"]) : nil }

    // COMPAT(0.7 engine-stop): an engine an older Mac started (no `notes.box`). Goes 3 months after 0.8.0.
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
    /// The connection it made, which ends when it closes; nil when it made none.
    @discardableResult
    func start(_ launch: Launch, cache: URL) async -> MachineConnection? {
        // Once at a time.
        switch state {
        case .preparing, .failed: break
        case .downloading, .starting, .ready: return nil
        }
        // One that left this Mac, from a retry or a start over that came after, or one
        // disconnected: nothing goes there.
        guard !isRetired, !isDisconnected else { return nil }
        isStopping = false
        // Disconnect, Remove, Connect Now or a newer attempt ends this one before its next step:
        // asked before each script that goes there, so nothing more does once it's cut off.
        let attempt = connections
        let check = { if !self.isCurrent(attempt) { throw Superseded() } }
        let wanted = stillWanted()
        #if DEBUG
        if let standIn = Self.standIn {
            state = .starting
            let api: OpenCodeAPI?
            do {
                api = try await standIn(machine)
            } catch {
                guard isCurrent(attempt) else { return nil }
                failed(error)
                return nil
            }
            guard isCurrent(attempt) else { return nil }
            guard let api else {
                failureKind = .away
                lastTryAway = true
                state = .failed("Couldn’t reach \(machine.name).")
                return nil
            }
            do {
                try await bringUpToDate(asItIs: machine.isThisMac, check: { if !self.isCurrent(attempt) { throw Superseded() } })
            } catch {
                guard isCurrent(attempt) else { return nil }
                failed(error)
                return nil
            }
            self.api = api
            catalog.api = api
            startWanted = false
            return connected()
        }
        #endif
        // A stand-in (a name under `.invalid`, a demo copy's) is never contacted.
        guard !machine.connection.isNeverContacted else {
            failureKind = .lasting
            state = .failed("Couldn’t reach \(machine.name).")
            return nil
        }
        var attached: RemoteServer?
        do {
            // What goes there to set it up, every script asking first that it's still wanted
            // (`SSHConnection.sendsWhile`), so nothing more does once it's cut off: none of the
            // steps' own probes, a seed with your keys, a launch. (Only these steps: what runs for
            // the connection after has its own end.) Nil: its engine was stopped on purpose.
            let ready = try await SSHConnection.$sendsWhile.withValue((machine.id, wanted)) { () async throws -> RemoteServer? in
                state = .starting
                step = .checking
                // At whichever of its addresses answers.
                await reach()
                try check()
                let connection = machine.connection
                // A box a newer Kuvo Code set up (it updated itself, or another Mac's newer app did):
                // what's there runs as it is, and nothing of this app's goes over it.
                boxIsNewer = BoxVersion.isNewer(try await BoxVersion.read(on: connection))
                try check()
                // This Mac's own box, attached in place, is used as it is too: the Mac that set it up
                // keeps it, and nothing the app would start there (its engine, its keeper) ever runs
                // as Kuvo Code's, under its privacy permissions, rather than as the box's own.
                let asItIs = boxIsNewer || machine.isThisMac
                // COMPAT(0.7 files): `run/mac-installing` while this app puts its files there. Goes 3 months after 0.8.0.
                // What follows puts this app's files there: the box doesn't take them for an older Mac's.
                if !asItIs { try? await BoxVersion.installing(on: connection) }
                try check()
                // The box's own tool and keeper first, which what follows counts on.
                if !machine.isThisMac { try await RemoteServer.installBoot(on: connection) }
                try check()
                var found = try await RemoteServer.find(on: connection)
                try check()
                let starting = startWanted
                // COMPAT(0.7 engine-stop): an engine an older Mac stopped stays down until Start. Goes 3 months after 0.8.0.
                if found == .stopped, !starting {
                    if !asItIs { try? await BoxVersion.notInstalling(on: connection) }
                    return nil
                }
                isStopped = false
                // A newer box's engine isn't running: its own keeper starts the one it has. (This
                // Mac's own box's keeper was seen running as the app attached.)
                if asItIs, found.engine == nil {
                    // COMPAT(0.7 engine-stop): a newer box found stopped is started. Goes 3 months after 0.8.0.
                    if found == .stopped, !machine.isThisMac { try await RemoteServer.startEngine(on: connection) }
                    for _ in 0..<15 where found.engine == nil {
                        try await Task.sleep(for: .seconds(2))
                        try check()
                        found = try await RemoteServer.find(on: connection)
                    }
                    guard found.engine != nil else { throw machine.isThisMac ? OwnBoxDown() : NewerBox() }
                }
                var engine = found.engine
                let isNewer = engine.map { $0.version.compare(OpenCodeEngine.version, options: .numeric) == .orderedDescending } ?? false
                var updates = !asItIs && engine?.version != OpenCodeEngine.version && !(isNewer && engine.map(isAnotherMacs) == true)
                // An engine of another version still at work (a session left running when the app
                // quit or updated): kept, with its work, until a connection finds it with none.
                var busy: RemoteServer?
                // (One that can't be reached to ask is updated, as before.)
                try check()
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
                try check()
                if updates {
                    state = .downloading(progress: 0)
                    try await RemoteEngineInstaller(connection: connection, cache: cache).install(progress: { progress in
                        Task { @MainActor in
                            guard case .downloading = self.state else { return }
                            switch progress {
                            case .downloading(let fraction):
                                self.state = .downloading(progress: fraction)
                                self.step = .downloading(fraction: fraction)
                            case .copying(let sent, let total):
                                self.step = .copying(sent: sent, total: total)
                            }
                        }
                    })
                    try check()
                    state = .starting
                }
                step = .starting
                // Its own settings, a box of its own: made so once (from what it runs with, or this
                // Mac's on one with none), then read, for what its engine starts with.
                if !machine.isThisMac { try await MachineBox.install(on: connection) }
                try check()
                var launch = launch
                // COMPAT(0.7 settings): the settings an older Mac's start left, made the box's own. Goes 3 months after 0.8.0.
                // (This Mac's own box keeps its keys: none of the app's go into it.)
                let box = try await MachineBox.adopt(on: connection, seed: machine.isThisMac ? { .init(settings: [:], keys: [:]) } : launch.seed)
                config.took(box.settings)
                launch.boxEnvironment = launch.fromBox(config.settings)
                if box.seeded { seededNow = true }
                try check()
                // The browser tools' helper, and the agents bridge, which an engine starts with.
                if !machine.isThisMac {
                    try await MachineBrowserInstaller.installHelper(launch.helper, on: connection)
                    try check()
                    if let agents = launch.agents { try await Self.installAgents(agents, on: connection) }
                }
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
                // COMPAT(0.7 engine-stop): an older Mac's engine started over once nothing runs. Goes 3 months after 0.8.0.
                // Taken from another Mac (Make This Mac Its Home): this Mac's from now on.
                let takes = takingHome && isAnotherMacs(server.engine)
                if !asItIs, takes || isOlderMacs(server.engine) || server.engine.notes["settings"] != launch.fingerprint && !isAnotherMacs(server.engine), (try? await api.activeSessions())?.isEmpty == true {
                    takingHome = false
                    // Started with older settings (or an older Mac's), and nothing to interrupt: start it over.
                    try check()
                    server.disconnect()
                    attached = nil
                    let replaced = try await launchEngine(launch, replace: server.engine.pid)
                    try check()
                    server = try await attach(replaced, launch)
                    attached = server
                    try check()
                }
                try check()
                // COMPAT(0.7 files): the marks of this app's tools, for `bin/.own`. Goes 3 months after 0.8.0.
                // What this app put there runs: the box is this version's.
                if !asItIs {
                    var marks = ["kuvo-browser.js": "// kuvo-browser \(launch.helper.hash)"]
                    if let agents = launch.agents { marks["kuvo-agents.js"] = "// kuvo-agents \(agents.hash)" }
                    try? await BoxVersion.mark(on: connection, marks: marks)
                }
                // The update gate (#679): what's there now has everything this app needs, or it
                // isn't used at all (nothing falls back to an older box's way).
                do {
                    try await bringUpToDate(asItIs: asItIs, check: check)
                } catch {
                    server.disconnect()
                    attached = nil
                    throw error
                }
                return server
            }
            // Cut off as its last step ran (marking the box): it isn't connected.
            try check()
            // COMPAT(0.7 engine-stop): an engine an older Mac stopped stays down until Start. Goes 3 months after 0.8.0.
            guard let server = ready else {
                isStopped = true
                state = .preparing
                watchWhileStopped()
                return nil
            }
            self.server = server
            let current = OpenCodeAPI(endpoint: server.endpoint, session: Self.patient, folderPrefix: RemoteFolder.prefix(for: machine.id))
            self.api = current
            catalog.api = current
            agents.connect(server.agentsEndpoint, folderPrefix: RemoteFolder.prefix(for: machine.id))
            // COMPAT(0.7 engine-stop): an older Mac's engine without the agents bridge. Goes 3 months after 0.8.0.
            // An engine started without its agents bridge (an older one): none to wait for.
            if server.agentsEndpoint == nil { catalog.forgetAgents() }
            startWanted = false
            let opened = connected()
            learnIdentity()
            // (This Mac's own box, attached in place, isn't one of your machines.)
            if !machine.isThisMac { Analytics.shared.trackOnce("machine_connected") }
            listen(to: current)
            // The browser, in the background: the machine's box sets it up the first time (its
            // download), and this follows how that goes. A browser tab in view comes back live.
            Task { await browser.prepare() }
            browser.resume()
            await catalog.refresh()
            return opened
        } catch is Superseded {
            // What it connected is its own to close; the newer attempt has the rest.
            if let attached, attached !== server { attached.disconnect() }
        } catch where !isCurrent(attempt) {
            // Failed after a newer attempt began: that one's state isn't this one's to change.
            if let attached, attached !== server { attached.disconnect() }
        // COMPAT(0.7 engine-stop): an engine an older Mac stopped. Goes 3 months after 0.8.0.
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
            failed(error)
        }
        return nil
    }

    /// A start that failed with `error`: said, and how it may pass (`FailureKind`). One that was
    /// connected since the app opened may be on its way back (restarting, its engine starting
    /// there), where nearly anything can fail for a moment, and a Mac restarting with FileVault
    /// answers only for its password until it's unlocked.
    private func failed(_ error: Error) {
        // Known to work: connected since the app opened, or not answering a moment ago.
        let works = wasConnected || lastTryAway
        failureKind = if Self.mayPass(error) || works && Self.waitsToBeUnlocked(error) {
            .away
        } else if works && !Self.neverPasses(error) {
            .comingBack
        } else {
            .lasting
        }
        lastTryAway = failureKind == .away
        state = .failed(error.localizedDescription)
    }

    /// It's up: a connection begins.
    private func connected() -> MachineConnection {
        wasConnected = true
        lastTryAway = false
        comingBackWaited = nil
        activeConnection?.end()
        let connection = MachineConnection()
        activeConnection = connection
        state = .ready
        step = .reading
        return connection
    }

    /// Its sessions have been read: its connection is all the way there.
    func sessionsRead() {
        if step == .reading { step = nil }
    }

    /// Ends what runs for the connection (`MachineConnection`), leaving it open.
    func endConnection() {
        activeConnection?.end()
        activeConnection = nil
    }

    /// It leaves this Mac: what runs for its connection ends, and it never connects again. Its
    /// connection stays open until it's closed (a machine being uninstalled is signed out through
    /// it first).
    func retire() {
        isRetired = true
        endConnection()
        updateFollow?.cancel()
        updateFollow = nil
        gates?.letGo(machine.id)
    }

    private struct Superseded: Error {}

    /// The start that began at `attempt` is still wanted: nothing disconnected or removed it since,
    /// nor began another.
    private func isCurrent(_ attempt: Int) -> Bool {
        connections == attempt && !isRetired && !isDisconnected
    }

    /// Whether what begins for it now (a start, a start over) is still wanted, each time it's
    /// asked: not once it's disconnected or removed, or connected again from the start (Connect
    /// Now), so nothing more of it goes there.
    func stillWanted() -> @Sendable () async -> Bool {
        let attempt = connections
        return { @MainActor [weak self] in self?.isCurrent(attempt) ?? false }
    }

    #if DEBUG
    /// For the app's tests: the engine a machine's connection reaches (nil: it can't be reached),
    /// in place of starting one there over SSH; or what starting it there threw. It has no live feed.
    static var standIn: ((Machine) async throws -> OpenCodeAPI?)?

    /// A demo copy's stand-in machine (`DemoMachines`), shown as `status` says, as if its
    /// connection had got there: nothing is started or sent anywhere.
    func showStandIn(_ status: String) {
        isRetrying = false
        isStopped = false
        isLive = false
        failureKind = .lasting
        // (The state first: some of them clear the step.)
        switch status {
        case "connected", "reading":
            state = .ready
            isLive = true
            step = status == "reading" ? .reading : nil
        case "connecting":
            state = .starting
            step = .checking
        case "starting":
            state = .starting
            step = .starting
        case "downloading":
            state = .downloading(progress: 0.35)
            step = .downloading(fraction: 0.35)
        case "copying":
            state = .downloading(progress: 0.42)
            step = .copying(sent: 41_000_000, total: 98_000_000)
        case "reconnecting":
            state = .failed("The connection to \(machine.name) was lost.")
            isRetrying = true
        case "stopped":
            state = .preparing
            isStopped = true
        case "notConnected":
            state = .preparing
            isDisconnected = true
        default:
            state = .failed(DemoMachines.failure(of: machine.name))
        }
    }
    #endif

    /// A newer box whose engine didn't come up by itself: this app won't start an older one there.
    /// This Mac's own box, attached in place, isn't running its engine: its keeper starts it, never
    /// the app.
    struct OwnBoxDown: LocalizedError {
        var errorDescription: String? { "This Mac’s box isn’t running its engine. Try again in a moment; if it stays down, log out and back in to start it again." }
    }

    struct NewerBox: LocalizedError {
        var errorDescription: String? { "This machine has a newer Kuvo Code than this Mac, and its engine didn't start. Update Kuvo Code on this Mac to start it from here." }
    }

    // MARK: The update gate (#679)

    /// Why a machine couldn't be brought up to date, in words that say what to do: its connection
    /// fails with them, and it isn't used.
    struct CouldntUpdate: LocalizedError {
        var errorDescription: String?
    }

    /// The release this app carries for its computer's box (`Contents/Resources/box-release`,
    /// PROTOCOL.md "Updates"): nil in a copy built without one (a developer's). A test's own.
    nonisolated(unsafe) static var boxRelease: () -> URL? = { Bundle.main.url(forResource: "box-release", withExtension: nil) }
    /// How long it waits between looks while this Mac's box takes the release (a test's none).
    nonisolated(unsafe) static var updateLookAgain: @Sendable () async throws -> Void = { try await Task.sleep(for: .seconds(10)) }

    /// The box there, as its connection leaves it: used once it has everything this app needs
    /// (`BoxGate`), else brought up to date first (`BoxGates`). Over SSH its connection has put this
    /// app's files there already (`asItIs` false), so it does at once. This Mac's own box attached
    /// in place is offered the release the app carries (`kuvo/box/update {from}`): its connection
    /// goes on, its engine used (a session there waiting on you can be answered, which the box waits
    /// for before it updates), its box's routes held, "Updating…", and looked at again until it's
    /// taken (`followUpdate`). Anything else older than this app needs fails, saying why: nothing
    /// falls back to an older box's way. A box that couldn't say what it has (not answering just
    /// then) is used as before; what reads it later tells.
    private func bringUpToDate(asItIs: Bool, check: () throws -> Void) async throws {
        guard let box = catalog.box else { return }
        guard let features = await features(of: box) else {
            // This Mac's box attached in place that couldn't say just now: held, and asked again,
            // never let through unasked (a machine is: what reads it later tells).
            if machine.isThisMac {
                gates?.updating(machine.id, detail: nil)
                followUpdate(of: box, release: Self.boxRelease(), offered: Self.now())
            }
            return
        }
        try check()
        if BoxGate.isCurrent(features) {
            gates?.letGo(machine.id)
            return
        }
        let name = machine.isThisMac ? "this Mac" : machine.name
        func fail(_ why: String?, setUpElsewhere: Bool = true) -> CouldntUpdate {
            let words = BoxGate.Words.couldntUpdate(name, why: why, setUpElsewhere: setUpElsewhere)
            gates?.failed(machine.id, words)
            return CouldntUpdate(errorDescription: words)
        }
        gates?.updating(machine.id, detail: machine.isThisMac ? BoxGate.Words.thisMacTaking : nil)
        step = .updating
        // Its files are this app's, yet it answers as older: they didn't take (or a newer Kuvo Code
        // set it up, one without what this one needs, which this Mac leaves as it is).
        guard machine.isThisMac else {
            throw asItIs ? fail("It has another Kuvo Code that this Mac doesn’t update over") : fail("Its files didn’t take this Mac’s version", setUpElsewhere: false)
        }
        guard features.contains("box.update") else { throw fail("It’s from before Kuvo Code could update it from this Mac") }
        guard let release = Self.boxRelease() else { throw fail("This copy of Kuvo Code doesn’t carry a release to update it with") }
        if case .refused(let why) = await offer(release, to: box) { throw fail(why) }
        try check()
        // Taken at its first quiet moment: looked at again until it's there, while this connection goes on.
        followUpdate(of: box, release: release, offered: Self.now())
    }

    /// How an offer of the app's release went (`kuvo/box/update {from}`): taken in (or already
    /// there, or being taken), or refused, in the box's words.
    enum Offered: Equatable { case taken, refused(String) }

    /// Offers `release` to `box`; one refused while it updates already (its night's update, say)
    /// counts as taken: it's offered again once that's done, if it's still needed.
    private func offer(_ release: URL, to box: BoxClient) async -> Offered {
        struct Offer: Encodable { let from: String }
        guard let body = try? JSONEncoder().encode(Offer(from: release.path(percentEncoded: false))),
              let (status, data) = try? await box.send("POST", "kuvo/box/update", body: body) else { return .taken }
        if (200..<300).contains(status) { return .taken }
        if let now = await updateStatus(of: box), now.offered != nil || now.updating != nil { return .taken }
        return .refused(BoxRefusal(status: status, data: data).message)
    }

    /// What `kuvo/update` says of the box's own update (PROTOCOL.md "Updates"): the step under way,
    /// why it can't update, the release offered that waits, and how the last one went.
    struct UpdateStatus: Decodable {
        /// How taking the release offered from a folder there last failed: its own outcome, apart
        /// from the night's update.
        struct OfferFailed: Decodable { var version: String?; var at: Double?; var takenBack: Bool?; var message: String? }
        var updating: String?
        var blocked: String?
        var offered: String?
        var offerFailed: OfferFailed?
    }

    private func updateStatus(of box: BoxClient) async -> UpdateStatus? {
        try? await box.value(UpdateStatus.self, "GET", "kuvo/update")
    }

    /// Now, in ms since 1970, as the box notes its updates (a test's own).
    nonisolated(unsafe) static var now: () -> Double = { Date.now.timeIntervalSince1970 * 1000 }

    /// Following this Mac's box attached in place as it takes the release offered it: let go once
    /// it says it has all this app needs; ended with the connection. Each look also reads how its
    /// update stands: one it can't take (it's blocked, its engine is stopped on purpose, or taking
    /// the release offered failed since: `offerFailed`, never the night's) says why, in its words;
    /// an offer that's gone with no failure of its own (refused while its night's update ran) is
    /// made again. Said, it's still looked at, and goes back to updating once it can.
    @ObservationIgnored private var updateFollow: Task<Void, Never>?

    private func followUpdate(of box: BoxClient, release: URL?, offered: Double) {
        updateFollow?.cancel()
        let id = machine.id
        updateFollow = Task { [weak self] in
            var offeredAt = offered
            while !Task.isCancelled {
                do { try await Self.updateLookAgain() } catch { return }
                guard !Task.isCancelled, let self else { return }
                let info = await self.info(of: box)
                if let features = info?.features, BoxGate.isCurrent(features) {
                    self.gates?.letGo(id)
                    return
                }
                // (Not answering just now: asked again.)
                guard let info else { continue }
                let status = await self.updateStatus(of: box)
                let why: String? = if !info.features.contains("box.update") {
                    "It’s from before Kuvo Code could update it from this Mac"
                } else if release == nil {
                    "This copy of Kuvo Code doesn’t carry a release to update it with"
                } else if info.stopped {
                    "Its engine is stopped: start it to update it"
                } else if let blocked = status?.blocked {
                    blocked
                } else if let failed = status?.offerFailed, (failed.at ?? 0) >= offeredAt {
                    // Taking the release offered failed since it was offered (taken back, or before
                    // anything changed, when it stays and is tried again): its words.
                    failed.message ?? "Taking the update failed"
                } else {
                    nil
                }
                if let why {
                    self.gates?.failed(id, BoxGate.Words.couldntUpdate("this Mac", why: why))
                    continue
                }
                guard let status else { continue }
                // Its offer gone, and nothing under way: offered again.
                if status.offered == nil, status.updating == nil, let release {
                    offeredAt = Self.now()
                    if case .refused(let why) = await self.offer(release, to: box) {
                        self.gates?.failed(id, BoxGate.Words.couldntUpdate("this Mac", why: why))
                        continue
                    }
                }
                self.gates?.updating(id, detail: BoxGate.Words.thisMacTaking)
            }
        }
    }

    /// What `box` says it is (`kuvo/info`): its features (none for one from before it said: 404,
    /// 405, or no `features`), and whether its engine is stopped on purpose; nil when it couldn't
    /// say just now.
    private func info(of box: BoxClient) async -> (features: [String], stopped: Bool)? {
        struct Info: Decodable { var stopped: Bool? }
        // (Its features as the update gate reads them: `BoxFeatures.said`.)
        guard let (status, data) = try? await box.send("GET", "kuvo/info"),
              case .has(let features) = BoxFeatures.said(status: status, body: data) else { return nil }
        return (features.sorted(), (try? JSONDecoder().decode(Info.self, from: data))?.stopped == true)
    }

    /// What `box` says it has (`kuvo/info`'s `features`); nil when it couldn't say just now.
    private func features(of box: BoxClient) async -> [String]? { await info(of: box)?.features }

    private func launchEngine(_ launch: Launch, replace: Int? = nil, starting: Bool = false) async throws -> RemoteServer.Engine {
        try await RemoteServer.launch(on: machine.connection, environment: launch.environment.merging(launch.boxEnvironment) { $1 }, notes: ["settings": launch.fingerprint, "mac": Self.macID, "macName": Self.noteName, "box": BoxVersion.mine],
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
        endConnection()
        updateFollow?.cancel()
        updateFollow = nil
        // Not connected, it isn't held either: connecting again checks it anew.
        gates?.letGo(machine.id)
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

    // COMPAT(0.7 engine-stop): an engine an older Mac stopped, watched for a start from elsewhere. Goes 3 months after 0.8.0.
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

    // COMPAT(0.7 engine-stop): an engine an older Mac stopped. Goes 3 months after 0.8.0.
    private var isWaitingStopped: Bool {
        guard isStopped, case .preparing = state else { return false }
        return true
    }

    /// Closes the connection and stops everything Kuvo Code runs there, for good (the machine
    /// removed, or a demo or test copy's, which leaves nothing running). Whether it stopped.
    @discardableResult
    func shutDown() async -> Bool {
        disconnect()
        return (try? await RemoteServer.stop(on: machine.connection)) != nil
    }

    /// Signs out of every account the machine's engine has (copied from this Mac) and of its coding
    /// agents, and deletes what integrations' servers kept there (a sign-in's tokens).
    /// In its turn after a copying of sign-ins under way (which could store one after these went);
    /// none starts after it, its connection's syncs ended first (`Machines.remove`). Whether they
    /// all went.
    @discardableResult
    func forgetAccounts() async -> Bool {
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

    /// Its engine's requests through the tunnel wait as long as it's working on them: a busy
    /// machine (a heavy load) answers late, and a tunnel that's gone fails them itself (ssh's own
    /// checks), rather than URLSession's own minute calling one still under way "timed out" (#443).
    /// (Tests answer it as they answer the shared session: `waitingSession(answeredBy:)`.)
    nonisolated(unsafe) static var patient = waitingSession(answeredBy: [])

    /// A session that waits as `patient` does, `protocols` first answering what it asks.
    nonisolated static func waitingSession(answeredBy protocols: [AnyClass]) -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 600
        configuration.protocolClasses = protocols + (configuration.protocolClasses ?? [])
        return URLSession(configuration: configuration)
    }

    @ObservationIgnored private var downCheck: Task<Void, Never>?
    /// Goes up with each disconnection, so a check from an earlier connection stops.
    @ObservationIgnored private var connections = 0
    /// How long its feed may be down before it's checked (`Reach.grace`).
    @ObservationIgnored var awayDelay: Duration = Reach.grace

    /// The live feed went down. It comes back by itself after a blip, and a busy machine (a heavy
    /// load) drops it now and then and answers late: nothing says so meanwhile. But when the
    /// engine behind the tunnel is gone (restarted on another port, say) while the tunnel stays up,
    /// nothing would ever change. So KuvoClient's `Reach` decides: once it's been down through the
    /// grace and the engine doesn't answer a check in time, the connection is lost, and connecting
    /// again starts (as after the network went), with its bar over the composer.
    private func checkWhileDown(_ api: OpenCodeAPI) {
        // Once for each time it's down: the feed says so again at each of its own retries.
        guard downCheck == nil else { return }
        let connection = connections
        downCheck = Task { [weak self] in
            let delay = self?.awayDelay ?? Reach.grace
            let away = await Reach.isAway(grace: delay, isBack: {
                guard let self else { return true }
                return self.isLive || self.state != .ready || self.connections != connection
            }, check: {
                // Only the engine's own answer counts: a tunnel whose far end is gone still takes
                // the connection and then fails it, and an engine started again behind it with
                // another password refuses this one (401).
                do {
                    _ = try await api.info()
                    return true
                } catch let error as ServerError {
                    return error.status != 401
                } catch {
                    return false
                }
            })
            // The feed came back meanwhile (which cancels this): nothing was lost.
            guard let self, !Task.isCancelled, connections == connection else { return }
            downCheck = nil
            guard away, !isLive, state == .ready else { return }
            log.error("\(self.machine.destination, privacy: .public)'s engine stopped answering through its tunnel")
            connectionLost("The connection to \(machine.name) was lost.")
        }
    }

    /// The connection is gone without being asked to (its tunnel ended, or its engine stopped
    /// answering through it): say so, and let the app connect again.
    func connectionLost(_ reason: String) {
        disconnect()
        failureKind = .away
        lastTryAway = true
        state = .failed(reason)
        onExit()
    }

    /// Whether `error` may pass by itself: SSH not getting through (255, on a command or the
    /// engine's tunnel), but for its key or the machine's turned away; a download, or the engine
    /// taking too long.
    static func mayPass(_ error: Error) -> Bool {
        switch error {
        case RemoteEngineError.ssh(255, let message), RemoteEngineError.exited(255, let message):
            !isTurnedAway(message)
        case RemoteEngineError.timedOut, is URLError: true
        default: false
        }
    }

    /// Whether `error` never passes by itself, on a machine that worked a moment ago: its host
    /// key changed, a system the engine doesn't run on. Anything else can be the machine
    /// restarting, for a while: its engine failing to start, a command cut off, a newer box's
    /// engine not up yet, and this Mac's key turned away (a Mac starting up answers SSH before
    /// it reads your keys: #285).
    static func neverPasses(_ error: Error) -> Bool {
        switch error {
        case RemoteEngineError.ssh(255, let message), RemoteEngineError.exited(255, let message):
            ["Host key verification failed", "REMOTE HOST IDENTIFICATION HAS CHANGED"].contains { message.localizedCaseInsensitiveContains($0) }
        case RemoteEngineError.unsupportedPlatform, RemoteEngineError.needsDeveloperTools, RemoteEngineError.needsNewerMacOS,
             RemoteEngineError.thisMac:
            true
        // Brought up to date it wasn't (#679): trying again on its own changes nothing.
        case is MachineEngine.CouldntUpdate: true
        default: false
        }
    }

    /// Whether SSH was turned away by a machine that takes no keys just now, only a password: a Mac
    /// restarted with FileVault answers so until someone unlocks it, then takes this Mac's key.
    static func waitsToBeUnlocked(_ error: Error) -> Bool {
        guard case RemoteEngineError.ssh(255, let message) = error,
              let methods = message.firstMatch(of: /Permission denied \(([^)]*)\)/)?.1 else { return false }
        return !methods.localizedCaseInsensitiveContains("publickey")
    }

    /// What SSH says when the machine was reached and turned this Mac away (its key, its host key).
    private static func isTurnedAway(_ message: String) -> Bool {
        ["Host key verification failed", "Permission denied", "Too many authentication failures", "REMOTE HOST IDENTIFICATION HAS CHANGED"]
            .contains { message.localizedCaseInsensitiveContains($0) }
    }

    private func exited(status: Int32) {
        // Not yet connected: the start that's under way says what went wrong, in its own words.
        guard !isStopping, server != nil else { return }
        let output = server?.recentOutput.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        log.error("\(self.machine.destination, privacy: .public) closed with status \(status): \(output, privacy: .public)")
        connectionLost("The connection to \(machine.name) was lost.\(output.isEmpty ? "" : "\n\n" + String(output.suffix(400)))")
    }
}

/// The machines you've added, and their engines.
@Observable
final class Machines {
    private(set) var list: [Machine]
    private(set) var engines: [String: MachineEngine] = [:]
    /// The file was there as this started and couldn't be read: not an empty list, so what's written
    /// next goes beside it, never over it.
    @ObservationIgnored private(set) var fileDidntRead: Bool

    /// The list, in this Mac's box's folder (in the app's, or its home once it has moved,
    /// `OwnBoxHome`): this writes it and the box only reads it, so the box can say what your machines
    /// are with the app closed (`kuvo/machines`), and there's one list.
    nonisolated static var file: URL { OwnBoxHome.file("machines.json", inSupport: "box/machines.json") }
    /// Where it was before it had a file, and where an older version keeps its own, which sees nothing
    /// of the file: what's here joins the file's. Never removed before the list is known to be safe.
    nonisolated private static let key = "machines"
    /// The whole list, where it stays while the file can't be written, until the next launch can.
    nonisolated private static let unsavedKey = "machines.unsaved"

    /// Whether you have machines, as Kuvo Code keeps them (for this Mac's keeper, which keeps no
    /// list of its own: with machines, this Mac's box meets them at the relay). One that can't be
    /// read may well have some.
    nonisolated static var anySaved: Bool {
        for key in [unsavedKey, key] {
            if let data = UserDefaults.standard.data(forKey: key), let list = try? JSONSerialization.jsonObject(with: data) as? [Any], !list.isEmpty { return true }
        }
        return switch readFile() {
        case .none: false
        case .list(let list): !list.isEmpty
        case .unreadable: true
        }
    }

    init() {
        let saved = Self.load()
        list = saved.list
        fileDidntRead = saved.fileDidntRead
        #if DEBUG
        // KUVO_DEMO_MACHINE: stand-ins beside yours, never saved with them (`DemoMachines`).
        list += DemoMachines.list.filter { standIn in !list.contains { $0.id == standIn.id } }.map { Machine(destination: $0.id) }
        #endif
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
        # Stopped first (marked off), if it isn't already: its way to stop goes next.
        \(RemoteServer.stopCommand)
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
            if [ -x "$L" ] && [ -f "$K/bin/kuvo-link.js" ]; then (cd "$K" && KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$L" --config=/dev/null --no-env-file "$K/bin/kuvo-link.js" leave '\(key)') >/dev/null 2>&1 || true; fi

            """
        } ?? ""
        return leave + """
        rm -rf "$K/keys" "$K/box/keys" "$K/box/bot-keys"
        # COMPAT(0.7 keeper): the keeper copies go with it. Goes 3 months after 0.8.0.
        rm -f "$K/run/launch.env" "$K/run/launch.notes" "$K/bin/kuvo-start" "$K/bin/.kuvo-start-keeper" "$K/bin/kuvo-launch" "$K/bin/.kuvo-launch-keeper" "$K/bin/.kuvo-boot" "$K/bin/kuvo-setsid" "$K/run/awake.pid"
        \(RemoteServer.rebootCrontabRemoval)
        # What macOS keeps of the browser outside its folder, in the account's preferences.
        if [ "$(uname -s)" = Darwin ] && [ -d "$K/browser" ]; then defaults delete com.google.chrome.for.testing LastRunAppBundlePath >/dev/null 2>&1; fi
        """
    }

    /// Signs the coding agents there out: their sign-ins' files, under `$K` (their conversations
    /// stay, as the engine's sessions do), and on a Mac Claude Code's Anthropic Console sign-ins, which
    /// it keeps in that Mac's Keychain, each named after its folder (a Keychain that's locked keeps them).
    static let agentsSignOut = """
        [ -d "$K/agents" ] && find "$K/agents" -path "$K/agents/runtime" -prune -o \\( -name .credentials.json -o -name auth.json -o -name 'auth.json.*' -o -name acp_token.json -o -name 'acp_token.json.*' -o -name 'oauth-token.json*' -o -path "$K/agents/claude/tokens/*" \\) -type f -exec rm -f {} + 2>/dev/null
        if [ "$(uname -s)" = Darwin ]; then
          for d in "$K/agents/claude/home" "$K/agents/claude/console" "$K"/agents/claude/accounts/*; do
            [ -d "$d" ] && security delete-generic-password -s "Claude Code-credentials-$(printf %s "$d" | shasum -a 256 | cut -c1-8)" >/dev/null 2>&1 </dev/null
          done
        fi
        true
        """

    func engine(_ id: String?) -> MachineEngine? {
        id.flatMap { engines[$0] }
    }

    /// This Mac's own box, attached in place (`Machine.isThisMac`): first among them, never saved
    /// (it's no machine of yours: the list is those its box meets).
    @discardableResult
    func attachHere() -> MachineEngine {
        if let engine = engines[SSHConnection.thisMac] { return engine }
        let machine = Machine(destination: SSHConnection.thisMac)
        list.insert(machine, at: 0)
        let engine = makeEngine(machine)
        engines[machine.id] = engine
        return engine
    }

    /// This Mac's own box isn't here any more (the app runs its own now): it's no longer listed,
    /// and its connection ends. Nothing is run there or removed from it.
    func detachHere() {
        guard let engine = engines.removeValue(forKey: SSHConnection.thisMac) else { return }
        engine.retire()
        engine.disconnect()
        list.removeAll { $0.id == SSHConnection.thisMac }
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
        engine.gates = gates
        return engine
    }

    // MARK: One computer, several addresses

    /// A machine folded into another, being the same computer at another address: its name, and
    /// the other's. The app moves what it kept under the first (its projects, its bots).
    /// The boxes held for their update (#679), this Mac's own and its machines': one for the app.
    let gates = BoxGates()

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
        engines[duplicate]?.retire()
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
        // This Mac's own box isn't one of yours to remove from here: it runs this Mac.
        guard id != SSHConnection.thisMac else { return }
        // Nothing more goes there for its connection, nor does it connect again.
        engines[id]?.retire()
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
                        let stopped = await engine.shutDown()
                        // What it kept to work on its own goes too: its keys, how it starts after
                        // a restart, and the crontab line that does it. Not before it's stopped:
                        // its stop goes by how it starts.
                        let leftovers = Self.leftoversScript
                        let tidied = stopped ? await Task.detached { RemoteShell.run(leftovers, on: id) }.value != nil : false
                        self?.removing.remove(id)
                        // What didn't go, the next time it answers. One still running is stopped
                        // then too: without how it starts, nothing else ever would.
                        if !forgotten || !stopped { self?.runLater(Self.removalScript, on: id) } else if !tidied { self?.runLater(Self.leftoversScript, on: id) }
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
        var list = list.filter { !$0.isThisMac }
        #if DEBUG
        list.removeAll { DemoMachines.standIn($0.id) != nil }
        #endif
        if Self.store(list, besideFile: fileDidntRead) { fileDidntRead = false }
    }

    private enum SavedFile {
        /// No file: none added yet.
        case none
        case list([Machine])
        /// There, and it wouldn't read (from a newer version, damaged, or not now): not the same as none.
        case unreadable
    }

    nonisolated private static func readFile() -> SavedFile {
        do {
            return .list(try JSONDecoder().decode([Machine].self, from: Data(contentsOf: file)))
        } catch CocoaError.fileReadNoSuchFile, CocoaError.fileNoSuchFile {
            return .none
        } catch {
            return .unreadable
        }
    }

    /// Writes the list to its file, and takes it out of the settings only once it reads back whole. A
    /// file that won't read (or, `besideFile`, wouldn't as this started) is set aside first, never
    /// written over. Where any of that fails, the list stays in the settings, whole, so it's never lost.
    @discardableResult
    nonisolated private static func store(_ list: [Machine], besideFile: Bool = false) -> Bool {
        let wontRead = switch readFile() {
        case .none: false
        case .list(let there): besideFile && there != list
        case .unreadable: true
        }
        if !wontRead || JSONFile.setAside(file, because: "a list was about to be saved over it"), write(list) {
            for key in [key, unsavedKey] { UserDefaults.standard.removeObject(forKey: key) }
            return true
        }
        Logger(subsystem: "run.kuvo.code", category: "machine").error("The machines' file couldn't be written, so they stay in the settings for now")
        if let data = try? JSONEncoder().encode(list) {
            UserDefaults.standard.set(data, forKey: unsavedKey)
            UserDefaults.standard.removeObject(forKey: key)
        }
        return false
    }

    /// Whether the file holds `list` now, read back. Only you can read it.
    nonisolated private static func write(_ list: [Machine]) -> Bool {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(list).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch {
            return false
        }
        if case .list(let written) = readFile() { return written == list }
        return false
    }

    /// As it stands, moved to the file where the settings still hold any of it: a list that couldn't
    /// be written stands in for the file's, and an older version's machines join whichever that is
    /// (going back to one and forward again finds them all).
    nonisolated private static func load() -> (list: [Machine], fileDidntRead: Bool) {
        let unsaved = fromSettings(unsavedKey), older = fromSettings(key), file = readFile()
        var list = unsaved ?? []
        if unsaved == nil, case .list(let there) = file { list = there }
        list += (older ?? []).filter { machine in !list.contains { $0.id == machine.id } }
        if unsaved != nil || older != nil {
            store(list)
            return (list, false)
        }
        if case .unreadable = file {
            Logger(subsystem: "run.kuvo.code", category: "machine").error("The machines' file couldn't be read: it's left as it is, and set aside before anything is saved")
            return ([], true)
        }
        return (list, false)
    }

    /// The list a setting holds. One that won't read (a newer version's, or damaged) is set aside, as
    /// Kuvo Code's files are (`JSONFile`).
    nonisolated private static func fromSettings(_ key: String) -> [Machine]? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        if let list = try? JSONDecoder().decode([Machine].self, from: data) { return list }
        UserDefaults.standard.set(data, forKey: "\(unreadableKey)\(key == unsavedKey ? "-unsaved" : "")-\(Int(Date.now.timeIntervalSince1970))")
        UserDefaults.standard.removeObject(forKey: key)
        Logger(subsystem: "run.kuvo.code", category: "machine").error("The machines in the settings couldn't be read and were set aside")
        return nil
    }

    /// For this Mac's keeper as it starts, before the box does: the list out of the settings, as the
    /// app does it, for a box that may answer before the app has ever opened again (an update's).
    nonisolated static func moveFromSettings() {
        _ = load()
    }

    /// Where machines that wouldn't read are kept, followed by when.
    nonisolated static let unreadableKey = "machines.unreadable"
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
        // This Mac's own box: the page comes back to this Mac's localhost, where its agent is.
        guard !Machine(destination: machine).connection.isLocal else { return }
        problem = nil
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/ssh")
        // (Not the shared connection: this one's forward ends with it.) What runs there reads this
        // app's end of a pipe, so it ends as the connection does, as the engine's tunnel does.
        process.arguments = Machine(destination: machine).connection.arguments(
            running: "cat >/dev/null", extra: ["-o", "ExitOnForwardFailure=yes", "-L", "\(port):localhost:\(port)"], shared: false)
        process.standardInput = Pipe.unshared()
        process.standardOutput = FileHandle.nullDevice
        // What it says, read as it comes (never to its end once it's gone: see `ChildProcess`).
        let errors = Pipe.unshared()
        process.standardError = errors
        let said = LogTail()
        errors.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                said.close()
            } else {
                said.append(data)
            }
        }
        process.terminationHandler = { [weak self] ended in
            // Ended by itself right away: the port taken here, or the machine out of reach.
            guard ended.terminationReason == .exit, ended.terminationStatus != 0 else { return }
            Task { @MainActor in
                await said.closed(within: .seconds(1))
                guard let self, self.process === ended else { return }
                self.problem = Self.problem(said.text, port: port, machine: machine)
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
    /// Runs `script` with `sh` on `machine`: its output, or nil when it (or SSH) fails. Off the
    /// main thread (it waits). SSH notices a machine gone away by itself; one whose command is
    /// still going after five minutes is stuck (these are short: a listing, a file read), and
    /// stopped, rather than holding up what asked for ever.
    static func run(_ script: String, on machine: String) -> Data? {
        #if DEBUG
        if !SSHConnection(destination: machine).isLocal, let standIn = SSHConnection.standIn { return standIn(SSHConnection(destination: machine).address, script).map { Data($0.utf8) } }
        #endif
        let started = SSHConnection(destination: machine).invocation(running: script)
        guard let result = try? ChildProcess.runBlocking(started.executable, started.arguments, environment: started.environment, directory: started.directory,
                                                         errors: .discard, limit: .seconds(300)),
              result.succeeded else { return nil }
        return result.output
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
    /// A folder's entries on a machine, or why they couldn't be read.
    static func list(_ url: URL) -> Result<[(name: String, isDirectory: Bool)], FolderFailure> {
        guard let (machine, path) = RemoteFolder.parse(url) else { return .failure(.missing) }
        let script = FolderFailure.checking(path, then: listing)
        return FolderFailure.checked(run(script, on: machine), machine: machine).map(entries)
    }

    /// Lists the current folder, a link by what it leads to, in what both systems' `find` understand
    /// (macOS's has no `-printf`): a kind, a tab and a path, each ended by a NUL. `{ }`, as what's
    /// around it sends stderr away from all of it.
    static let listing = #"{ find -L . -mindepth 1 -maxdepth 1 -type d -exec printf 'd\t%s\0' {} + ; find -L . -mindepth 1 -maxdepth 1 ! -type d -exec printf 'f\t%s\0' {} + ; }"#

    /// What `listing` printed.
    static func entries(_ data: Data) -> [(name: String, isDirectory: Bool)] {
        String(decoding: data, as: UTF8.self).split(separator: "\0").compactMap { line in
            let parts = line.split(separator: "\t", maxSplits: 1)
            guard parts.count == 2 else { return nil }
            return (relative(parts[1]), parts[0] == "d")
        }
    }

    private static func relative(_ found: Substring) -> String {
        String(found.hasPrefix("./") ? found.dropFirst(2) : found)
    }

    /// Up to `limit` bytes of a file on a machine.
    static func read(_ url: URL, limit: Int) -> Data? {
        guard let (machine, path) = RemoteFolder.parse(url) else { return nil }
        return run("head -c \(limit) -- \(SSHConnection.quoted(path))", on: machine)
    }

    /// Whether anything (a link too, even a broken one) is at a path on a machine; nil when it
    /// can't be asked.
    static func exists(_ url: URL) -> Bool? {
        guard let (machine, path) = RemoteFolder.parse(url) else { return nil }
        let quoted = SSHConnection.quoted(path)
        guard let data = run("if [ -e \(quoted) ] || [ -L \(quoted) ]; then echo yes; else echo no; fi", on: machine) else { return nil }
        return String(decoding: data, as: UTF8.self).hasPrefix("yes")
    }
}
