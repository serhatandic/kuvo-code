import AppKit
import CryptoKit
import Foundation
import KuvoLink
import OpenCodeKit
import os
import UsageKit
import Security
import SystemConfiguration

/// Kuvo Code for iPhone's way in: this Mac answers the phones you've paired, through the relay,
/// passing what they ask to its engine. Everything between them is encrypted end to end
/// (`Packages/KuvoLink`); the relay only passes bytes along.
///
/// Off until the phone app is out: `defaults write run.kuvo.code phoneLink -bool true`, or
/// KUVO_DEMO_PHONE=1, turns it on, with Settings › Phone.
@Observable
final class PhoneLink {
    static var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: "phoneLink") || ProcessInfo.processInfo.environment["KUVO_DEMO_PHONE"] != nil
    }

    /// The relay your computers and phones meet at. `defaults write run.kuvo.code phoneLink.relay
    /// wss://…` points elsewhere (a relay of your own, or one for tests).
    static let defaultRelay = URL(string: "wss://kuvolink.porigam.com.tr")!

    /// A paired phone: its key, name, when it paired, where it is and its pairing.
    typealias Phone = PairedPhones.Phone

    enum Status: Equatable {
        case off, connecting, connected
        case failed(String)
    }

    /// The phones you've paired, and the ones removed (from here or from a phone), which stay out
    /// until they're paired again (`PairedPhones`).
    private(set) var paired = PairedPhones()
    var phones: [Phone] { paired.phones }
    /// Your machines' bridges, which phones reach directly (with the Mac closed), by machine:
    /// what `kuvo/hosts` tells a phone.
    private(set) var machineHosts: [String: MachineHost] = [:]
    /// The machines that are connected now, for putting the bridge on them; set by AppModel.
    @ObservationIgnored var readyMachines: () -> [MachineEngine] = { [] }
    /// Your bots, for `kuvo/bots`: the phone draws and describes each as the Mac does; set by
    /// AppModel.
    @ObservationIgnored weak var bots: Bots?
    /// What agents ask you for while they browse, for `kuvo/asks`: a phone answers them as the
    /// cards in the window do; set by AppModel.
    @ObservationIgnored weak var browserAsks: BrowserAsks?
    /// Your sessions, for stopping a command an agent left running (`kuvo/shell/<id>/stop`); set
    /// by AppModel.
    @ObservationIgnored weak var workspace: Workspace?
    /// A machine's name, by its id, for where an ask's browser runs; set by AppModel.
    @ObservationIgnored var machineName: (String) -> String? = { _ in nil }
    /// The agents bridge (Claude Code, Codex…), for `kuvo/agents/api/…`; set by AppModel.
    @ObservationIgnored var agents: OutsideAgents?
    /// Starts this Mac's engine over, as Settings › Engine's Restart does; set by AppModel.
    @ObservationIgnored var restartEngine: () -> Void = {}
    /// When the engine running now came up, for `kuvo/info`; set by AppModel.
    @ObservationIgnored var engineStarted: () -> Date? = { nil }

    struct MachineHost: Codable, Hashable {
        var name: String
        var address: String
        var key: String
        /// Its engine is another Mac's, which gives it its settings, as it was when it last
        /// connected (nil from before this was kept).
        var anotherMac: Bool?
        /// Its bridge talks to your other computers itself (PROTOCOL.md, "Peers"): it takes their
        /// lists and letters by mail.
        var peers: Bool?
        /// The key its documents are signed with (PROTOCOL.md, "Documents"), from its setup.
        var sign: String?
    }

    /// What's kept in phone-link.json.
    private struct Saved: Codable {
        var phones: [Phone] = []
        var removed: [PairedPhones.Removal] = []
        var machines: [String: MachineHost] = [:]
        /// Removals this Mac's box hasn't taken yet (`removePhones`).
        var toRemove: [PairedPhones.Entry] = []

        init(phones: [Phone] = [], removed: [PairedPhones.Removal] = [], machines: [String: MachineHost] = [:],
             toRemove: [PairedPhones.Entry] = []) {
            self.phones = phones
            self.removed = removed
            self.machines = machines
            self.toRemove = toRemove
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            phones = try container.decodeIfPresent([Phone].self, forKey: .phones) ?? []
            removed = try container.decodeIfPresent([PairedPhones.Removal].self, forKey: .removed) ?? []
            machines = try container.decodeIfPresent([String: MachineHost].self, forKey: .machines) ?? [:]
            toRemove = try container.decodeIfPresent([PairedPhones.Entry].self, forKey: .toRemove) ?? []
        }
    }
    /// How this Mac's link stands, as its box says (`kuvo/link/status`).
    private(set) var status = Status.off
    /// The link a phone pairs with, while Settings › Phone shows it: good for ten minutes, once.
    /// This Mac's box makes it, and lets the phone in.
    private(set) var pairing: PairingLink?
    /// Why a pairing link couldn't be made just now, shown where it would be.
    private(set) var pairingProblem: String?
    /// Why a phone you removed is still let in for now, shown in Settings › Phone until this Mac's
    /// box takes the removal.
    private(set) var removalProblem: String?
    /// Phones removed here or on a machine that this Mac's box hasn't taken off yet: kept (in
    /// phone-link.json) and sent again until it does, and left out of what's shown meanwhile.
    @ObservationIgnored private var toRemove: [PairedPhones.Entry] = []

    var relay: URL {
        UserDefaults.standard.string(forKey: "phoneLink.relay").flatMap(URL.init(string:)) ?? Self.defaultRelay
    }

    /// This Mac's key and relay secret, from the Keychain, made the first time the link is on
    /// (with it off, Kuvo Code keeps nothing for it).
    @ObservationIgnored private lazy var identity: (key: LinkKey, secret: RelaySecret) = Self.loadIdentity()
    private var key: LinkKey { identity.key }
    private var secret: RelaySecret { identity.secret }
    /// This Mac's box, which holds the relay connection (`BoxProcess`); set by AppModel.
    @ObservationIgnored var box: () -> BoxClient? = { nil }
    /// Following the link's state and its phones, as the box keeps them.
    @ObservationIgnored private var running: Task<Void, Never>?
    @ObservationIgnored private var endpoint: ServerEndpoint?
    private let log = Logger(subsystem: "run.kuvo.code", category: "phone")
    /// Pushes not yet handed to the relay, which quitting waits for (see `flushBeforeQuit`).
    @ObservationIgnored let delivering = OSAllocatedUnfairLock(initialState: 0)

    /// Where the phones and machines are kept: phone-link.json (a test's own, for a test).
    private let savedFile: URL

    /// `file`, `identity` and `signing`: a test's own, kept apart from the app's file and Keychain
    /// (one giving an identity and no signing key gets a new one).
    init(file: URL? = nil, identity: (key: LinkKey, secret: RelaySecret)? = nil, signing: Documents.SigningKey? = nil) {
        savedFile = file ?? AppInfo.supportDirectory.appending(path: "phone-link.json")
        let saved = (try? JSONDecoder().decode(Saved.self, from: Data(contentsOf: savedFile))) ?? Saved()
        // Only what names a phone (an earlier build kept anything a document named).
        toRemove = saved.toRemove.filter { PairedPhones.fits($0, macs: []) }
        paired = Self.without(toRemove, PairedPhones(phones: saved.phones, removed: saved.removed))
        machineHosts = saved.machines
        if let identity {
            self.identity = identity
            self.signing = signing ?? Documents.SigningKey()
        }
    }

    /// The Keychain wouldn't give out this Mac's key or secret this launch.
    private static var unreadable = false

    /// This Mac's own key and secret, as your phones and machines know them (not a stand-in).
    private var hasIdentity: Bool {
        _ = identity
        return !Self.unreadable
    }

    /// The key this Mac signs its documents with (PROTOCOL.md, "Documents"), from the Keychain beside
    /// the others, made the first time.
    @ObservationIgnored private lazy var signing: Documents.SigningKey = Self.kept("sign", read: { try? Documents.SigningKey(rawRepresentation: $0) },
                                                                              make: Documents.SigningKey.init, bytes: \.rawRepresentation)

    private static func loadIdentity() -> (key: LinkKey, secret: RelaySecret) {
        (kept("key", read: { try? LinkKey(rawRepresentation: $0) }, make: LinkKey.init, bytes: \.rawRepresentation),
         kept("secret", read: RelaySecret.init(bytes:), make: RelaySecret.init, bytes: \.bytes))
    }

    /// One of them from the Keychain, made the first time. One the Keychain won't give out (you
    /// said no when it asked) isn't replaced, and the link stays off (`unreadable`): your phones
    /// and other computers would take a stand-in for another Mac. It's tried again next launch.
    private static func kept<T>(_ account: String, read: (Data) -> T?, make: () -> T, bytes: (T) -> Data) -> T {
        do {
            if let data = try keychain(account), let value = read(data) { return value }
        } catch {
            Logger(subsystem: "run.kuvo.code", category: "phone").error("Couldn’t read the phone link’s \(account, privacy: .public) from the Keychain: \(error.localizedDescription, privacy: .public)")
            unreadable = true
            return make()
        }
        let value = make()
        setKeychain(bytes(value), for: account)
        return value
    }

    /// This Mac's name, as Sharing settings has it.
    static var computerName: String {
        (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? "Mac"
    }

    /// Whether you have machines: with them, this Mac meets them at the relay (and they each
    /// other), phone or not. Set by the app.
    @ObservationIgnored var hasMachines: () -> Bool = { false }

    // COMPAT(beta.1 mac-letters): letters an earlier Kuvo Code kept, handed to the box. Goes 3 months after 0.8.0.
    /// What an earlier Kuvo Code kept of your agents' letters, handed to this Mac's box before it
    /// meets your other computers. Set by the app (`AgentMail.handOver`).
    @ObservationIgnored var handOver: (BoxClient) async -> Void = { _ in }

    /// This Mac connects to the relay: for your phones, or for your other computers. A Mac on its
    /// own, without the phone link, makes no connection.
    var relayWanted: Bool { Self.isEnabled || hasMachines() }


    /// This Mac's link, held by its box (KuvoLink's PROTOCOL.md, "This Mac's box: the relay"): told
    /// whether it's wanted, and followed (how it stands, and the phones it keeps), from now on.
    /// `endpoint`: this Mac's engine, for what a phone asks of it through the app.
    func start(endpoint: ServerEndpoint) {
        self.endpoint = endpoint
        guard running == nil else { return }
        running = Task { [weak self] in await self?.follow() }
        #if DEBUG
        showRemovalForDemo()
        #endif
    }

    #if DEBUG
    /// KUVO_DEMO_PHONE_PAIR=<file>: once the box has been told of the link (the first time), a
    /// pairing code, its link written to that file, for pairing a simulator (or a test) without a
    /// camera or the window. The phone gets in once the box is on the relay.
    @ObservationIgnored private var pairedForDemo = false

    /// KUVO_DEMO_PHONE_REMOVING: Settings › Phone as when a phone's removal waits for the box.
    /// KUVO_DEMO_MACHINE_SETUP_FAILED=<machine>: Settings › Machines as when that machine
    /// couldn't be set up for your phones and other computers.
    func showRemovalForDemo() {
        let environment = ProcessInfo.processInfo.environment
        if environment["KUVO_DEMO_PHONE_REMOVING"] != nil { removalProblem = Self.removalWaiting }
        if let failed = environment["KUVO_DEMO_MACHINE_SETUP_FAILED"] { setupFailed[failed] = Self.setupWhy("Its SSH connection closed.", asked: false) }
    }

    private func pairForDemo() {
        guard !pairedForDemo, let file = ProcessInfo.processInfo.environment["KUVO_DEMO_PHONE_PAIR"] else { return }
        pairedForDemo = true
        Task { [weak self] in
            guard let self, pairing == nil else { return }
            await beginPairing()
            try? pairing?.url.absoluteString.write(toFile: file, atomically: true, encoding: .utf8)
        }
    }
    #endif

    /// No longer followed (the app quitting). The box holds its link on until it stops too.
    func stop() {
        running?.cancel()
        running = nil
    }

    /// What this Mac's box is told of its link: whether the phone link is on, whether there are
    /// machines to meet, the relay, and how it's named to your phones.
    private var linkConfig: Data {
        // (What it answers, for its agents' mail to your other computers: `features`.)
        let config: [String: Any] = ["phones": Self.isEnabled, "machines": hasMachines(), "relay": relay.absoluteString,
                                     "name": Self.computerName, "app": AppInfo.version, "features": Self.features]
        return (try? JSONSerialization.data(withJSONObject: config)) ?? Data()
    }

    /// Follows this Mac's box: tells it what's wanted of its link, and follows how its link stands
    /// and its phones. Each time the box comes back (started again, it knows nothing of what it was
    /// told), it's told again.
    /// Its phones are followed only once what was removed meanwhile is the box's: its first word
    /// would otherwise stand for your phones.
    private func follow() async {
        var missed = 0
        while !Task.isCancelled {
            if let client = box() { await handOver(client) }
            if let client = box(),
               (try? await client.send("PUT", "kuvo/link/config", body: linkConfig))?.status == 200,
               await tellPeers(client), await sendRemovals(client) {
                missed = 0
                // Told: your machines are set up with what it keeps (one that couldn't be before).
                syncMachines()
                #if DEBUG
                pairForDemo()
                #endif
                let phones = Task { [weak self] in
                    do {
                        for try await line in client.follow("kuvo/link/phones/events") { self?.followed(phones: line) }
                    } catch {}
                }
                do {
                    for try await line in client.follow("kuvo/link/status/events") { followed(status: line) }
                } catch {}
                phones.cancel()
            }
            guard !Task.isCancelled else { return }
            // Starting, or starting again: still coming for a few tries, then said.
            missed += 1
            status = missed < Self.graceTries ? (relayWanted ? .connecting : .off)
                : .failed("Kuvo Code’s background service on this Mac, which holds the link to your phones and machines, isn’t answering. It’s being started again.")
            try? await Task.sleep(for: .seconds(2))
        }
    }

    /// Tries of the box (two seconds apart) before Settings › Phone says it isn't answering.
    static let graceTries = 4

    private func followed(status line: Data) {
        struct Said: Decodable { var state: String; var reason: String? }
        guard let said = try? JSONDecoder().decode(Said.self, from: line) else { return }
        status = switch said.state {
        case "connected": .connected
        case "connecting": .connecting
        case "failed": .failed(said.reason ?? "This Mac’s link stopped.")
        default: .off
        }
    }

    /// The phones as the box keeps them, kept here too (what your machines are told); a change here
    /// goes to your machines.
    private func followed(phones line: Data) {
        struct Kept: Decodable {
            struct Phone: Decodable { var key: String; var name: String?; var added: Double?; var address: String?; var pairing: String? }
            var phones: [Phone]
            var removed: [PairedPhones.Removal]
            var pairing: Bool?
        }
        guard let kept = try? JSONDecoder().decode(Kept.self, from: line) else { return }
        let now = Self.without(toRemove, PairedPhones(phones: kept.phones.map {
            Phone(key: $0.key, name: $0.name ?? "", added: Date(timeIntervalSince1970: $0.added ?? 0), address: $0.address, pairing: $0.pairing ?? "")
        }, removed: kept.removed))
        // The link shown was used, or ran out: it's done.
        if kept.pairing == false { pairing = nil }
        guard now != paired else { return }
        paired = now
        save()
        syncMachines()
    }

    /// Tells this Mac's box who your machines are, as it starts. False: it didn't take it, so it's
    /// told again.
    private func tellPeers(_ client: BoxClient) async -> Bool {
        guard let body = peersBody() else { return true }
        return (try? await client.send("PUT", "kuvo/link/peers", body: body))?.status == 200
    }

    /// A machine added or removed: with the first, this Mac's box meets your machines at the relay
    /// (and they each other); with the last gone (and no phone link), it stops. The others hear who
    /// their peers are now.
    func machinesChanged() {
        if let client = box() {
            let config = linkConfig
            Task { _ = try? await client.send("PUT", "kuvo/link/config", body: config) }
        }
        syncMachines()
        peersChanged()
    }

    /// Shows a pairing link (as a QR code) for a phone to scan, made by this Mac's box: one of its
    /// own, apart from one a phone asks for, so neither ends the other.
    func beginPairing() async {
        pairingProblem = nil
        pairingRound += 1
        let round = pairingRound
        struct Made: Decodable { var link: String }
        guard let client = box() else {
            pairingProblem = "Kuvo Code’s background service on this Mac isn’t running. Try again in a moment."
            return
        }
        // The last one shown ended first, so its end never ends this one.
        await endingPairing?.value
        do {
            let made = try await client.value(Made.self, "POST", "kuvo/phones/pair")
            // Closed (or another begun) meanwhile: not shown, and ended on the box too.
            guard round == pairingRound else {
                if let made = URL(string: made.link).flatMap(PairingLink.init) { endOnBox(client, made) }
                return
            }
            pairing = URL(string: made.link).flatMap(PairingLink.init)
            if pairing == nil { pairingProblem = "This Mac’s link made a pairing code this version can’t show." }
        } catch {
            guard round == pairingRound else { return }
            pairingProblem = error.localizedDescription
        }
    }

    func endPairing() {
        pairingProblem = nil
        pairingRound += 1
        guard pairing != nil else { return }
        let ended = pairing
        pairing = nil
        guard let client = box(), let ended else { return }
        endOnBox(client, ended)
    }

    /// Ends Settings › Phone's pairing link `link` on this Mac's box, that one alone (a newer one
    /// stays), after any ended before.
    private func endOnBox(_ client: BoxClient, _ link: PairingLink) {
        let previous = endingPairing
        let path = "kuvo/phones/pair?token=" + link.token.base64URL
        endingPairing = Task {
            await previous?.value
            _ = try? await client.send("DELETE", path)
        }
    }

    /// Each pairing link asked for or closed: one that comes after it was closed isn't shown.
    @ObservationIgnored private var pairingRound = 0
    @ObservationIgnored private var endingPairing: Task<Void, Never>?

    /// Once the pairing links ended so far have ended on the box.
    func pairingEnded() async { await endingPairing?.value }

    /// Removes a phone you've paired (Settings › Phone): here and on your machines, for good, until
    /// it's paired again. This Mac's box takes it off, and ends what it has open.
    func remove(_ phone: Phone) {
        removePhones([.init(key: phone.key, pairing: phone.pairing)])
    }

    /// `entries` taken off this Mac's phones, as the Mac takes them off (Settings › Phone, or a
    /// removal one of your machines' documents brought): gone from what's shown at once, and kept
    /// until this Mac's box has taken them off too (which ends what they have open), tried again
    /// until it does.
    private func removePhones(_ entries: [PairedPhones.Entry]) {
        // Only what names a phone (a document can name anything): the box refuses the rest.
        // (This Mac's own key the box turns away itself: reading it here could make the link's keys.)
        let new = entries.filter { PairedPhones.fits($0, macs: []) && !toRemove.contains($0) }
        guard !new.isEmpty else { return }
        toRemove = Array((toRemove + new).suffix(PairedPhones.mostKept))
        paired = Self.without(toRemove, paired)
        save()
        guard removing == nil else { return }
        removing = Task { [weak self] in
            var missed = 0
            while let self, !Task.isCancelled, !toRemove.isEmpty {
                if let client = box(), await sendRemovals(client) { break }
                // Said only once the box has had a moment (it may just be starting), as the status.
                missed += 1
                if missed >= Self.graceTries { removalProblem = Self.removalWaiting }
                try? await Task.sleep(for: .seconds(2))
            }
            self?.removing = nil
        }
    }

    @ObservationIgnored private var removing: Task<Void, Never>?

    private static let removalWaiting = "Kuvo Code’s background service on this Mac isn’t answering, so the phone you removed can still reach this Mac. It’s removed as soon as the service is back."

    /// Once this Mac's box has taken the removals handed to it so far.
    func removalsTaken() async { await removing?.value }

    /// Hands this Mac's box the removals it hasn't taken yet; true once it has them all.
    private func sendRemovals(_ client: BoxClient) async -> Bool {
        let sending = toRemove
        guard !sending.isEmpty else { return true }
        guard let body = try? JSONSerialization.data(withJSONObject: ["phones": sending.map { ["key": $0.key, "pairing": $0.pairing as Any] }]),
              let status = (try? await client.send("POST", "kuvo/phones/remove", body: body))?.status else { return false }
        // Refused (one that names no phone, kept by an older version): let go, or it would hold
        // up the link for good.
        if status == 400 { log.error("This Mac's box refused \(sending.count, privacy: .public) phone removals, which were let go.") }
        guard status == 200 || status == 400 else { return false }
        toRemove.removeAll { sending.contains($0) }
        if toRemove.isEmpty { removalProblem = nil }
        save()
        return toRemove.isEmpty
    }

    /// `phones` without those named in `removals` (a removal without a pairing names every pairing
    /// of its phone).
    private static func without(_ removals: [PairedPhones.Entry], _ phones: PairedPhones) -> PairedPhones {
        guard !removals.isEmpty else { return phones }
        var left = phones
        left.phones.removeAll { phone in removals.contains { $0.key == phone.key && ($0.pairing == nil || $0.pairing == phone.pairing) } }
        return left
    }

    // MARK: Machines

    /// Puts the bridge on each connected machine, with the phones you've paired now.
    func syncMachines() {
        for engine in readyMachines() { Task { await sync(engine) } }
    }

    /// Puts the bridge (`kuvo-link.js`) on `engine`'s machine, in `~/.kuvo-code/bin`, with the
    /// phones you've paired and the relay, so they reach it directly, with this Mac closed too.
    /// The machine keeps its own keys and tells this Mac only its address and public key. With
    /// no phones, the bridge stops there. One at a time for each machine (a connecting machine's,
    /// and the one after this Mac's box is told its settings, would run into each other there).
    /// `asked`: you asked (Set Up Again), so what keeps it from being set up now is said too.
    func sync(_ engine: MachineEngine, asked: Bool = false) async {
        guard relayWanted, engine.isReady, hasIdentity else {
            setupFailed[engine.machine.id] = nil
            return
        }
        let id = engine.machine.id, previous = settingUp[id]
        let mine = Task { [weak self] in
            await previous?.value
            await self?.setUp(engine, asked: asked)
        }
        settingUp[id] = mine
        settingUpNow.insert(id)
        await mine.value
        if settingUp[id] == mine {
            settingUp[id] = nil
            settingUpNow.remove(id)
        }
    }

    @ObservationIgnored private var settingUp: [String: Task<Void, Never>] = [:]
    /// The machines being set up for your phones and other computers now (Settings › Machines).
    private(set) var settingUpNow: Set<String> = []

    private func setUp(_ engine: MachineEngine, asked: Bool) async {
        let machine = engine.machine
        let folder = FileManager.default.temporaryDirectory.appending(path: Bundle.main.bundleIdentifier ?? "run.kuvo.code").appending(path: "phone-link-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let script = try Bridge.script
            let hash = SHA256.hash(data: script).map { String(format: "%02x", $0) }.joined()
            let scriptFile = folder.appending(path: Bridge.fileName)
            try script.write(to: scriptFile)
            try await machine.connection.run(BoxVersion.guardScript + "\n" + RemoteEngineInstaller.script("""
                f="$K/bin/\(Bridge.fileName)"
                if [ "\(RemoteEngineInstaller.sumOfFile)" = "\(hash)" ]; then cat >/dev/null; else cat >"$f.new" && mv -f "$f.new" "$f"; fi
                """), input: scriptFile)

            struct Setup: Encodable {
                var relay: String
                var name: String
                /// This Mac's key, whose mail the machine opens, and the key its documents are signed
                /// with (PROTOCOL.md, "Documents"), which only setup gives, over SSH.
                var mac: String
                var macSign: String
                /// This Mac's documents, and those it has of your other machines.
                var docs: [Documents.Envelope]
                /// The machine's name here, for its agents to say where they are.
                var id: String
                // COMPAT(0.7 visits): this Mac leaves a newer box as it is; older ones don't say so. Goes 3 months after 0.8.0.
                /// This Mac never puts its own files over a newer box's (`BoxVersion`): the box may
                /// update itself once every Mac it sees does.
                var tolerates = 1
                /// This Mac's ID, as its engine launches there name it.
                var macID = MachineEngine.macID
                /// This Mac's name, for saying who else uses the machine.
                var macName = PhoneLink.computerName
            }
            let settings = folder.appending(path: "setup.json")
            // This Mac's keys and documents, as its box keeps them (a box starting, or not told
            // its settings yet, a moment later).
            struct Given: Decodable { var mac: String; var macSign: String; var docs: [Documents.Envelope] }
            // (Not up, or not told its settings yet, as it starts: it sets your machines up once it
            // is, `follow`. Said, when you asked.)
            let starting = "This Mac’s background service isn’t running yet, so it couldn’t be set up. Try again in a moment."
            guard let client = box() else {
                if asked { setupFailed[machine.id] = starting }
                return
            }
            // One set up before (removed since, say): no longer one this Mac removed.
            let again = machineHosts[machine.id].map { "?key=" + $0.key } ?? ""
            let given: Given
            do {
                given = try await client.value(Given.self, "GET", "kuvo/link/setup" + again)
            } catch let refusal as BoxRefusal where refusal.status == 503 {
                if asked { setupFailed[machine.id] = starting }
                return
            }
            try JSONEncoder().encode(Setup(relay: relay.absoluteString, name: machine.name, mac: given.mac, macSign: given.macSign,
                                           docs: given.docs, id: machine.id)).write(to: settings)
            let output = try await machine.connection.run(RemoteEngineInstaller.script("""
                KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$E" --config=/dev/null --no-env-file "$K/bin/\(Bridge.fileName)" setup
                """), input: settings)
            struct Answer: Decodable { var address: String?; var key: String?; var peers: Bool?; var sign: String?; var docs: [Documents.Envelope]? }
            let answer = try? JSONDecoder().decode(Answer.self, from: Data(output.utf8))
            // Removed or uninstalled meanwhile (or merged into another): not named to your phones
            // and other computers again.
            if engine.isRetired { return }
            if let machines = bots?.app?.machines, machines.engine(machine.id) !== engine { return }
            let before = machineHosts[machine.id]
            if let address = answer?.address, let key = answer?.key {
                machineHosts[machine.id] = MachineHost(name: machine.name, address: address, key: key, anotherMac: engine.isAnotherMacsEngine, peers: answer?.peers,
                                                       sign: answer?.sign.flatMap { $0.wholeMatch(of: /[A-Za-z0-9_-]{43}/) != nil ? $0 : nil })
            } else {
                machineHosts[machine.id] = nil
            }
            save()
            // A machine new here (or at a new address, or newly talking to other computers): this
            // Mac's box names it, and your others hear it's one of theirs.
            if machineHosts[machine.id] != before { peersChanged() }
            // What it has of documents (its own, signed with the key it just gave over SSH), to this
            // Mac's box, once it knows the machine.
            if let key = answer?.key, let docs = answer?.docs, !docs.isEmpty,
               let body = try? JSONSerialization.data(withJSONObject: ["from": key, "docs": ["give": docs.map(\.json)]]) {
                toBox("kuvo/link/docs", body, using: client)
            }
            setupFailed[machine.id] = nil
        } catch {
            log.error("Couldn't set up the phone link on a machine: \(error.localizedDescription, privacy: .public)")
            setupFailed[machine.id] = Self.setupWhy(error.localizedDescription, asked: asked)
        }
    }

    /// The machines that couldn't be set up for your phones and other computers just now, and why,
    /// for Settings › Machines; tried again when each next connects.
    private(set) var setupFailed: [String: String] = [:]

    /// Why a machine couldn't be set up, from what went wrong (its first line).
    static func setupWhy(_ error: String, asked: Bool) -> String {
        var what = error.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        if what.count > 160 { what = String(what.prefix(159)) + "…" }
        if what.isEmpty { what = "Kuvo Code couldn’t reach it." }
        if !".!?…".contains(what.last!) { what += "." }
        return asked ? "Set Up Again didn’t work. \(what)" : "Kuvo Code couldn’t set it up for them. \(what) It tries again when it next connects."
    }

    /// A machine removed: nothing more to say of setting it up.
    func machineRemoved(_ id: String) {
        setupFailed[id] = nil
    }

    /// Your machines as this Mac's box names them in its peers document (PROTOCOL.md, "Peers"): those
    /// whose bridge signs its own documents and whose engine is this Mac's (another Mac's machines
    /// are that Mac's to tell), with the conversations being moved. The box signs it, meets your
    /// machines' documents and mails them; a machine no longer here is one this Mac removed, which
    /// the box tells to let it go.
    /// `removed`: the keys of machines you removed (one just missing from the list, as one that
    /// couldn't be set up just now is, isn't).
    func peersChanged(removed: [String] = []) {
        guard let body = peersBody(removed: removed) else { return }
        toBox("kuvo/link/peers", body, method: "PUT")
    }

    /// What `peersChanged` tells the box; none while there's no link to your machines (nothing's
    /// made for it then).
    private func peersBody(removed: [String] = []) -> Data? {
        guard relayWanted, hasIdentity else { return nil }
        struct Peer: Encodable { var key: String; var sign: String; var address: String; var name: String; var id: String }
        // COMPAT(beta.1 mac-moves): `moved`, none: the boxes that move conversations say where they went. Goes when 0.8.0 ships.
        struct Moved: Encodable { var session: String; var key: String }
        struct Body: Encodable { var peers: [Peer]; var moved: [Moved]; var removed: [String] }
        // Only whole records (one that isn't would be left out by the box anyway).
        let base64URL = /[A-Za-z0-9_-]+/
        let peers = documentMachines.compactMap { id, host -> Peer? in
            guard let sign = host.sign, [host.key, sign, host.address].allSatisfy({ $0.wholeMatch(of: base64URL) != nil }),
                  host.key.count == 43, sign.count == 43, host.address.count == 22 else { return nil }
            return Peer(key: host.key, sign: sign, address: host.address, name: host.name, id: id)
        }
        return try? JSONEncoder().encode(Body(peers: peers, moved: [], removed: removed))
    }

    /// This Mac's public key, as your machines know it (none while the Keychain won't give it out).
    var macKey: String? {
        hasIdentity ? key.publicBytes.base64URL : nil
    }

    /// A machine's link key, as your computers name it (one whose bridge talks to them itself).
    func key(of machine: String) -> String? {
        talksToPeers(machine) ? machineHosts[machine]?.key : nil
    }

    #if DEBUG
    /// A test's machine, as if it was set up for your computers: its box's key, and its bridge
    /// talking to them itself.
    func standIn(machine: String, key: String, address: String = "") {
        machineHosts[machine] = MachineHost(name: machine, address: address, key: key, peers: true)
    }
    #endif

    /// Whether `machine`'s bridge talks to your other computers itself (it makes its own list of
    /// agents, and sends its agents' letters).
    func talksToPeers(_ machine: String) -> Bool {
        machineHosts[machine]?.peers == true && machineHosts[machine]?.anotherMac != true
    }

    /// Whether another Mac runs `machine`'s engine (this Mac leaves it to that Mac).
    func machineIsAnotherMacs(_ machine: String) -> Bool {
        #if DEBUG
        if let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_MACHINE_NOT_PEER"]?.split(separator: "|").map(String.init), demo.first == machine {
            return demo.last == "another"
        }
        #endif
        return machineHosts[machine]?.anotherMac == true
    }

    /// Why agents on your other computers can't reach `machine`'s, nor this Mac's group chats name
    /// them, for Settings › Machines: a line, and the reason behind it; nil when they can, or it's
    /// not set up yet, or it couldn't be (`setupFailed` says so).
    func peerProblem(of machine: String) -> (line: String, why: String)? {
        var anotherMac = machineHosts[machine]?.anotherMac == true
        #if DEBUG
        // KUVO_DEMO_MACHINE_NOT_PEER=<machine>[|another]: Settings › Machines as when that machine's
        // agents can't be reached (its bridge out of date, or another Mac runs its engine).
        if let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_MACHINE_NOT_PEER"]?.split(separator: "|").map(String.init), demo.first == machine {
            anotherMac = demo.last == "another"
        } else {
            guard relayWanted, machineHosts[machine] != nil, !talksToPeers(machine), setupFailed[machine] == nil else { return nil }
        }
        #else
        guard relayWanted, machineHosts[machine] != nil, !talksToPeers(machine), setupFailed[machine] == nil else { return nil }
        #endif
        if anotherMac {
            return ("Another Mac runs it: its agents are reached from there.",
                    "Agents on that Mac and its machines can write to them. Agents on this Mac’s computers can’t, and this Mac’s group chats can’t name them.")
        }
        return ("Its agents can’t be reached from your other computers.",
                "Its bridge is out of date, so this Mac’s group chats can’t name them either. Setting it up again updates it.")
    }

    /// A machine you removed: phones stop being told about it, and this Mac's box tells it to let
    /// this Mac go (`peersChanged`).
    func forget(machine id: String) {
        setupFailed[id] = nil
        guard let host = machineHosts.removeValue(forKey: id) else { return }
        save()
        // Removed, said so (not just missing): unless it's still one of this Mac's, under another name.
        peersChanged(removed: machineHosts.values.contains { $0.key == host.key } ? [] : [host.key])
    }

    // MARK: Documents

    /// The machines that take this Mac's documents: those whose bridge signs its own, and whose
    /// engine is this Mac's (another Mac's machines are that Mac's to tell).
    private var documentMachines: [(id: String, host: MachineHost)] {
        machineHosts.filter { $0.value.sign != nil && $0.value.anotherMac != true && $0.value.peers == true }
            .sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    // MARK: Answering

    /// What this Mac answers a paired phone's request with: Kuvo's own routes (`kuvo/…`), the
    /// coding agents' bridge's (`kuvo/agents/…`, at `agents`) and the engine's (at `base`).
    /// `asking`: the phone's key.
    nonisolated static func respond(to request: LinkRequest, link: PhoneLink?, engine base: URL, password: String?,
                                    agents: OutsideAgents.Address?, asking: Data? = nil) -> AsyncThrowingStream<LinkResponsePart, Error> {
        // (A phone's requests to the engine and the coding agents' bridge are this Mac's box's, which
        // tells the agent who a message names with "&" and that it's from the phone, as every box
        // does: `nameAgents` in kuvo-link.js.)
        guard request.path.hasPrefix("kuvo/") else { return EngineRoutes.forward(request, to: base, password: password) }
        // Which route answers, by its path alone: a query string never changes it (as on a machine).
        // Those that read the query get the request whole; the rest, its route.
        let route = request.path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? request.path
        // An area that's moved onto this Mac's box: answered there, as a machine's box answers it.
        if Self.movedToBox(route) {
            guard let box = Self.box.withLock({ $0 }) else { return Self.boxUnavailable() }
            let base = box.url.absoluteString.hasSuffix("/") ? box.url : URL(string: box.url.absoluteString + "/")!
            // The app's own requests (no phone asking) say so: they aren't a phone using the box.
            let forwarded = EngineRoutes.forward(request, to: base, password: box.password, session: Self.boxSession, adding: asking == nil ? ["x-kuvo-from": "app"] : [:],
                                                 allowing: { path, _ in path.hasPrefix("kuvo/") })
            // A change to a conversation's wake-ups, or to your personalities: what the app shows
            // of them (and `kuvo/bots` and its templates list) has it before the answer goes back,
            // so what's read next agrees.
            let parts = route.split(separator: "/").map(String.init)
            let method = request.method.uppercased()
            let follow: (@MainActor () async -> Void)?
            if method == "POST", parts.count >= 3, parts[1] == "wakes", let session = parts[2].removingPercentEncoding {
                follow = { await link?.wakesChanged(session) }
            } else if method != "GET", parts.count >= 2, parts[1] == "personalities" {
                // (The app's own change reads it again after this too, and finds nothing new.)
                follow = { await Personalities.shared.refresh() }
            } else {
                follow = nil
            }
            guard let follow else { return forwarded }
            return AsyncThrowingStream { continuation in
                let task = Task {
                    do {
                        var answer: [LinkResponsePart] = []
                        for try await part in forwarded { answer.append(part) }
                        await follow()
                        for part in answer { continuation.yield(part) }
                        continuation.finish()
                    } catch {
                        continuation.finish(throwing: error)
                    }
                }
                continuation.onTermination = { _ in task.cancel() }
            }
        }
        var routed = request
        routed.path = route
        // Settings › Machines: this Mac's machines. Adding a machine checks it first: the phone
        // going stops that (and nothing else, which would leave a removal half done).
        if route == "kuvo/machines/events", request.method.uppercased() == "GET" { return Self.following { link?.machinesJSON() } }
        if route == "kuvo/machines" || route.hasPrefix("kuvo/machines/") {
            return AsyncThrowingStream { continuation in
                let task = Task { @MainActor in
                    let (status, body) = await link?.answerMachines(request) ?? (503, Data())
                    Self.sendJSON(status, body, to: continuation)
                }
                if route == "kuvo/machines" { continuation.onTermination = { _ in task.cancel() } }
            }
        }
        // Settings › Agents' and Commands' From Claude Code: this Mac's ~/.claude, read here.
        if route == "kuvo/claude-code" {
            // `?machine=<id>`: named and said to be there as that machine's pages have them.
            let machine = URLComponents(string: request.path)?.queryItems?.first { $0.name == "machine" }?.value
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let (status, body) = request.method.uppercased() == "GET" ? await link?.claudeCodeJSON(for: machine) ?? (503, Data()) : (405, Data("{}".utf8))
                    Self.sendJSON(status, body, to: continuation)
                }
            }
        }
        // Settings › General's While Agents Work: whether it's kept awake now can be the keeper's
        // to say.
        if route == "kuvo/mac" {
            return AsyncThrowingStream { [routed] continuation in
                Task { @MainActor in
                    let (status, body) = await link?.answerMac(routed) ?? (503, Data())
                    Self.sendJSON(status, body, to: continuation)
                }
            }
        }
        if route == "kuvo/asks/events" { return Self.following { link?.asksJSON() } }
        // A sign-in answered from a phone is kept in this Mac's vault before the answer goes back.
        if route.hasPrefix("kuvo/asks/"), request.method.uppercased() == "POST" {
            let id = String(route.dropFirst("kuvo/asks/".count))
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let (status, body) = await link?.answerAsk(id, with: request.body) ?? (503, Data())
                    Self.sendJSON(status, body, to: continuation)
                }
            }
        }
        // Open while the panel comes up (it takes a moment after the app starts), so the phone hears
        // it the moment it's there.
        if route == "kuvo/usage/events" { return Self.following(waits: true) { link?.usageJSON() } }
        return AsyncThrowingStream { [routed] continuation in
            Task { @MainActor in
                let (status, body) = link?.answer(routed) ?? (503, Data())
                Self.sendJSON(status, body, to: continuation)
            }
        }
    }

    // MARK: This Mac's box's link

    /// This Mac's keys, for its box's link (asked through the host interface): its link key, relay
    /// secret and signing key, as your phones and machines know this Mac. None while the link isn't
    /// wanted (nothing's made for it then), or the Keychain won't give them out.
    func boxIdentity() -> [String: String]? {
        guard relayWanted, hasIdentity else { return nil }
        // Read before the check: one the Keychain won't give out isn't stood in for.
        let sign = signing.rawRepresentation.base64URL
        guard !Self.unreadable else { return nil }
        return ["key": key.rawRepresentation.base64URL, "secret": secret.bytes.base64URL, "sign": sign]
    }

    /// That it's this Mac asking a machine it set up for its vault's key (PROTOCOL.md, "Vault"):
    /// its link key, the time, and its signing key's signature of both and the machine's id here.
    func vaultProof(machine: String) -> [String: Any]? {
        guard hasIdentity else { return nil }
        let at = Int(Date().timeIntervalSince1970 * 1000)
        // Once only: the machine takes each nonce once.
        let nonce = Data((0..<18).map { _ in UInt8.random(in: 0...255) }).base64URL
        guard let signature = try? signing.signature(for: Data("kuvo-vault-key\u{0}\(machine)\u{0}\(at)\u{0}\(nonce)".utf8)) else { return nil }
        return ["mac": key.publicKey.rawRepresentation.base64URL, "at": at, "nonce": nonce, "proof": signature.base64URL]
    }

    /// This Mac's proof, for one request to a machine's vault, instead of its unlock key (which goes
    /// only to unlock it): its signing key's signature of `kuvo-vault-request\0<machine>\0<at>\0<nonce>
    /// \0<METHOD>\0<path>\0<sha256 of the body, hex>`, base64url JSON (`x-kuvo-vault-proof`).
    func vaultRequestProof(machine: String, method: String, path: String, body: Data) -> String? {
        guard hasIdentity else { return nil }
        let at = Int(Date().timeIntervalSince1970 * 1000)
        let nonce = Data((0..<18).map { _ in UInt8.random(in: 0...255) }).base64URL
        let hash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        guard let signature = try? signing.signature(for: Data("kuvo-vault-request\u{0}\(machine)\u{0}\(at)\u{0}\(nonce)\u{0}\(method.uppercased())\u{0}\(path)\u{0}\(hash)".utf8)),
              let json = try? JSONSerialization.data(withJSONObject: ["mac": key.publicKey.rawRepresentation.base64URL, "at": at, "nonce": nonce, "proof": signature.base64URL]) else { return nil }
        return json.base64URL
    }

    /// What a phone asks of this Mac that its box hands the app (the Mac's own routes, and those
    /// that haven't moved to the box yet), answered as it was: `phone`, the phone's key.
    func answerForBox(_ request: LinkRequest, phone: Data?) -> AsyncThrowingStream<LinkResponsePart, Error> {
        // The engine not up yet (the app's starting): its routes say so, as a machine's do.
        guard let endpoint else {
            return Self.respond(to: request, link: self, engine: URL(string: "http://127.0.0.1:9/")!, password: nil, agents: agents?.address, asking: phone ?? Data())
        }
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url : URL(string: endpoint.url.absoluteString + "/")!
        return Self.respond(to: request, link: self, engine: base, password: endpoint.password, agents: agents?.address, asking: phone ?? Data())
    }

    // MARK: Notifications

    /// Sends `notice`, about what only the app knows (an ask from its panel's browser: this Mac's
    /// box makes the notices about your sessions and chats itself, as a machine's does), to this
    /// Mac's box, which holds it with its own while you're at a computer (PROTOCOL.md
    /// "kuvo/attention") and sends it to your phones.
    func push(_ notice: Notice) {
        guard Self.isEnabled, let data = try? notice.encoded(), let object = try? JSONSerialization.jsonObject(with: data),
              let body = try? JSONSerialization.data(withJSONObject: ["notice": object]) else { return }
        toBox("kuvo/attention/notice", body)
    }

    /// Hears from `notifier` what goes to your phones, and what's been answered (which, held, then
    /// never goes).
    func listen(to notifier: Notifier) {
        notifier.toPhones = { [weak self] in self?.push($0) }
        notifier.answeredForPhones = { [weak self] id in
            guard Self.isEnabled, let body = try? JSONSerialization.data(withJSONObject: ["id": id]) else { return }
            self?.toBox("kuvo/attention/answered", body)
        }
    }

    /// What's said to this Mac's box of your phones' notices, one after another, in the order it was
    /// said (a newer word never comes before an older one), counted until it's there.
    @ObservationIgnored private var toldBox: Task<Void, Never>?

    /// Once what's been said to this Mac's box so far is there.
    func saidToBox() async { await toldBox?.value }

    private func toBox(_ path: String, _ body: Data, method: String = "POST", using given: BoxClient? = nil) {
        guard let client = given ?? box() else { return }
        let previous = toldBox, delivering = delivering
        delivering.withLock { $0 += 1 }
        toldBox = Task.detached {
            await previous?.value
            _ = try? await client.send(method, path, body: body)
            delivering.withLock { $0 -= 1 }
        }
    }

    /// You're using Kuvo Code on this Mac, with `sessions` on its screen and `shown` in its own
    /// notifications just now, or not any more (nil) (`Attention`): this Mac's box hears it (as
    /// "mac"), and tells each of your machines by mail, so notices for your phones wait a little
    /// there too, and one you saw here doesn't go (PROTOCOL.md, "kuvo/attention"). Each
    /// notification shown goes to the box whose news it was alone (`elsewhere`, a machine's, by its id).
    func attend(_ sessions: [String]?, shown: [Attention.Shown] = []) {
        guard Self.isEnabled else { return }
        let seconds = sessions == nil ? 0 : Attention.lease
        let words = { (shown: [Attention.Shown]) in
            shown.map { each -> [String: Any] in
                var entry: [String: Any] = ["session": each.session, "ask": each.ask]
                if let request = each.request { entry["request"] = request }
                return entry
            }
        }
        var elsewhere: [String: Any] = [:]
        for (machine, each) in Dictionary(grouping: shown.filter { $0.machine != nil }, by: { $0.machine ?? "" }) { elsewhere[machine] = words(each) }
        if let body = try? JSONSerialization.data(withJSONObject: ["for": seconds, "sessions": sessions ?? [], "shown": words(shown.filter { $0.machine == nil }),
                                                                   "elsewhere": elsewhere]) {
            toBox("kuvo/attention", body)
        }
    }

    /// As the app quits: not in use any more, so what's held goes now and your machines send theirs,
    /// waited for a moment so this Mac's box has heard (it sends what's left before it goes).
    func flushBeforeQuit() {
        attend(nil)
        let delivering = delivering
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            for _ in 0..<30 {
                if delivering.withLock({ $0 == 0 }) { break }
                try? await Task.sleep(for: .milliseconds(50))
            }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 2)
    }

    /// The areas that have moved onto this Mac's box (`BoxProcess`), by their routes: a phone's
    /// requests and the app's own (`BoxClient`) go there.
    nonisolated static let boxRoutes = ["kuvo/projects", "kuvo/worktrees", "kuvo/plugins", "kuvo/folders", "kuvo/programs", "kuvo/providers", "kuvo/wakes", "kuvo/config", "kuvo/mcp/catalog", "kuvo/skills", "kuvo/skill-library", "kuvo/skill-trash", "kuvo/integrations", "kuvo/keys", "kuvo/bots", "kuvo/personalities",
                                                  "kuvo/phones", "kuvo/link", "kuvo/attention", "kuvo/accounts/ended", "kuvo/accounts/refreshable", "kuvo/accounts/credentials", "kuvo/accounts/found", "kuvo/file", "kuvo/sign-in/return", "kuvo/named", "kuvo/groups", "kuvo/artifacts", "kuvo/search", "kuvo/git", "kuvo/agent-tools", "kuvo/moves", "kuvo/work", "kuvo/work-queue", "kuvo/vault", "kuvo/approval"]
    /// Where this Mac's box is reached while it runs.
    nonisolated static let box = OSAllocatedUnfairLock<ServerEndpoint?>(initialState: nil)
    /// Connections of its own to this Mac's box, plenty of them: the streams that follow it
    /// (projects, worktrees) hold theirs open, and many requests at once (a phone reading a big
    /// collection) never hold up another (adding a skill). Kept in memory only.
    nonisolated static let boxSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = 64
        return URLSession(configuration: configuration)
    }()

    /// One of this Mac's own answers, as JSON: what it says, or `{}` for a refusal that says nothing,
    /// as a machine's box answers (PROTOCOL.md, "Messages in a session").
    nonisolated private static func sendJSON(_ status: Int, _ body: Data, to continuation: AsyncThrowingStream<LinkResponsePart, Error>.Continuation) {
        continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
        continuation.yield(.body(status >= 400 && body.isEmpty ? Data("{}".utf8) : body))
        continuation.finish()
    }

    nonisolated private static func boxUnavailable() -> AsyncThrowingStream<LinkResponsePart, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.head(status: 503, headers: ["content-type": "application/json"]))
            continuation.yield(.body(Self.message("Kuvo Code’s background service on this Mac isn’t running. Try again in a moment.")))
            continuation.finish()
        }
    }

    /// The routes of a computer's group chats a client takes (PROTOCOL.md, `kuvo/groups`), as a
    /// machine's link checks them.
    nonisolated private static let groupRoute = #"\Akuvo/groups(?:/(?:events|joinable|grp_[a-z0-9]+(?:/(?:events|stop|keep-going|viewed|undo|start))?))?\z"#

    /// What this Mac answers, one name per route or group of routes a client might check
    /// (PROTOCOL.md, "Features"): what a machine's bridge has too (its `FEATURES`, but
    /// `engine.start`, `update` and `browser`), and the Mac's own. `usage` is added while the usage panel is.
    static let features = [
        "accounts.credentials", "accounts.found", "accounts.refresh", "agents", "artifacts", "asks", "attention", "bots", "bots.edit", "bots.events", "bots.job", "bots.keys", "bots.make", "branch", "btw", "btw.threads", "config", "config.apply", "engine.restart",
        "file", "folders", "folders.files", "git", "git.changes.count", "git.merge", "git.pull-request", "git.pull-request.draft", "git.push", "goals", "groups", "groups.delete", "groups.edit", "groups.joinable", "groups.make", "groups.seats", "handoff", "integrations", "keys", "mcp.catalog", "moves", "moves.agents", "moves.check",
        "named", "personalities", "phones", "phones.pair", "plugins.search", "programs", "projects", "providers.models", "reviews", "reviews.parts", "reviews.scopes", "search", "sessions.agents", "sessions.glance", "shell.stop", "sign-in.return", "skills",
        "personalities.events", "skills.trash", "sandbox", "sandbox.check", "sandbox.asks", "sandbox.reviews.whole", "vault", "wakes", "wakes.edit", "wakes.events", "worktrees", "worktrees.events", "worktrees.where",
        "agent-tools", "sessions.start", "letters-read", "work.elsewhere", "queue", "queue.waits", "work", "work.projects", "work.goals", "work.goals.apps", "work.goals.projects", "work.unanswering", "autopilot", "approval", "approval.reviewer", "git.backups", "approval.fullAccess", "approval.held", "approval.default", "approval.seen", "approval.stopped", "limits", "work-queue", "work-queue.elsewhere",
        // The Mac's own.
        "accounts.ended", "claude-code", "hosts", "mac", "machines",
    ]

    /// Kuvo's own routes, beside the engine's.
    private func answer(_ request: LinkRequest) -> (Int, Data) {
        /// `chats`: the folder of conversations of no project, which the phone lists as Chats.
        /// `agents`: the outside agents' bridge is up, at `kuvo/agents/api/…`.
        struct Info: Encodable {
            var kind = "mac"; var name: String; var app: String; var engine: String; var chats: String
            var agents = false
            /// When the engine running now came up, in seconds since 1970: a restart changes it
            /// (null while none runs).
            @SentAsNull var started: Double? = nil
            /// Integrations' names by their MCP server's, for what a server asks.
            var integrations = Dictionary(uniqueKeysWithValues: Integrations.all.map { ($0.id, $0.title) })
            /// What this Mac answers (PROTOCOL.md, "Features"), which a client checks rather than versions.
            var features: [String]
        }
        struct Hosts: Encodable {
            /// `machine`: its id, as bots name theirs. `anotherMac`: its engine is another Mac's,
            /// which gives it its settings, so this Mac's (`kuvo/config`) don't reach it (as it
            /// was when it last connected). `removed`: this Mac removed it (it runs on there), so
            /// a phone may forget it.
            struct Host: Encodable {
                var kind = "machine"; var name: String; var address: String; var key: String; var relay: String
                var machine: String; var anotherMac: Bool; var removed: Bool
            }
            var hosts: [Host]
        }
        let encoder = JSONEncoder()
        // A list is read (GET, or HEAD), as a machine's bridge has it: anything else is 405.
        if request.path == "kuvo/asks", !["GET", "HEAD"].contains(request.method.uppercased()) {
            return (405, Data("{}".utf8))
        }
        switch request.path {
        case "kuvo/info":
            var info = Info(name: Self.computerName, app: AppInfo.version, engine: OpenCodeEngine.version, chats: Workspace.chatsFolder,
                            features: (Self.features + (usageJSON() == nil ? [] : ["usage"])).sorted())
            info.agents = agents?.api != nil
            info.started = engineStarted()?.timeIntervalSince1970
            return (200, (try? encoder.encode(info)) ?? Data())
        case "kuvo/hosts":
            let machines = bots?.app?.machines
            let hosts = machineHosts.sorted { $0.value.name < $1.value.name }.map { id, host in
                // (With a list that wouldn't read, none is known to be removed: a phone would forget it.)
                Hosts.Host(name: host.name, address: host.address, key: host.key, relay: relay.absoluteString, machine: id, anotherMac: host.anotherMac ?? false,
                           removed: machines?.engine(id) == nil && machines?.fileDidntRead != true)
            }
            return (200, (try? encoder.encode(Hosts(hosts: hosts))) ?? Data())
        case let path where path.hasPrefix("kuvo/hosts/") && request.method.uppercased() == "DELETE":
            // A machine this Mac removed, forgotten for your phones too (one it still has is
            // removed in Settings › Machines).
            let id = String(path.dropFirst("kuvo/hosts/".count)).removingPercentEncoding ?? ""
            guard machineHosts[id] != nil else { return (404, Data("{}".utf8)) }
            if bots?.app?.machines.engine(id) != nil { return (409, Self.message("It's one of this Mac's machines: remove it in Settings › Machines.")) }
            forget(machine: id)
            // Your other machines stop counting it among their peers.
            machinesChanged()
            return (200, Data("{}".utf8))
        case "kuvo/asks":
            return (200, asksJSON())
        case "kuvo/usage":
            guard let usage = usageJSON() else { return (404, Data()) }
            return (200, usage)
        case "kuvo/usage/refresh" where request.method.uppercased() == "POST":
            #if DEBUG
            if Self.usageSample { return (200, Data("{}".utf8)) }
            #endif
            return UsageMenuBar.shared.refreshAll() ? (200, Data("{}".utf8)) : (404, Data())
        case let path where path.hasPrefix("kuvo/asks/"):
            return (405, Data("{}".utf8))
        case "kuvo/engine/restart" where request.method.uppercased() == "POST":
            // Answered first: the restart takes the link down with the engine, and the phone sees
            // this Mac come back (`kuvo/info` answers again).
            let restart = restartEngine
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                restart()
            }
            return (202, Data("{}".utf8))
        default:
            return (404, Data())
        }
    }

    nonisolated static func message(_ text: String) -> Data {
        (try? JSONEncoder().encode(["message": text])) ?? Data()
    }

    /// A route's answer, its keys sorted.
    nonisolated static func json(_ value: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    // MARK: Asks

    /// What agents ask you for while they browse, waiting now: a sign-in (with the fields the
    /// page has, and the accounts Passwords keeps for the site, never their passwords), a code,
    /// or a step only you can do.
    private func asksJSON() -> Data {
        struct Listed: Encodable {
            struct Ask: Encodable {
                var id: String
                var kind: String
                /// The page's own site.
                var host: String
                /// The machine whose browser it is, by name; none for this Mac's.
                var machine: String?
                /// That machine's box, by its link address (as `kuvo/hosts` gives it), when your
                /// phones can reach it: the ask is its own, and its answer goes there too.
                var box: String?
                var session: String?
                var asker: String?
                var username: Bool?
                var password: Bool?
                var saved: [String]?
                /// Whether what's typed is kept in Passwords unless you say otherwise.
                var offersToSave: Bool?
                var prompt: String?
                var instruction: String?
                /// The site asked for a passkey, which the browser can't use yet.
                var passkey: Bool?
            }
            var asks: [Ask]
        }
        let asks = (browserAsks?.asks ?? []).map { ask in
            let box = ask.machine.flatMap { machineHosts[$0]?.address }.flatMap { $0.isEmpty ? nil : $0 }
            var listed = Listed.Ask(id: ask.id, kind: "", host: ask.host, machine: ask.machine.map { machineName($0) ?? $0 }, box: box, session: ask.session, asker: ask.asker)
            if ask.passkey { listed.passkey = true }
            switch ask.kind {
            case .signIn(let username, let password):
                listed.kind = "signIn"
                listed.username = username
                listed.password = password
                let saved = Passwords.logins(for: ask.host).map(\.account)
                listed.saved = saved
                listed.offersToSave = BrowserAsks.isSecure(ask.host) && saved.isEmpty && Passwords.offersToSave && !Passwords.neverSites.contains(ask.host)
            case .code(let prompt):
                listed.kind = "code"
                listed.prompt = prompt
            case .action(let instruction):
                listed.kind = "action"
                listed.instruction = instruction
            }
            return listed
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return (try? encoder.encode(Listed(asks: asks))) ?? Data()
    }

    /// A phone's answer, as the card's: a sign-in typed there or one of the site's saved ones,
    /// which this Mac fills in itself, kept in the vault and let agents sign in on their own as the
    /// card would (over https only); a code; done; or no.
    private func answerAsk(_ id: String, with body: Data) async -> (Int, Data) {
        struct Given: Decodable {
            var answer: String
            var username: String?
            var password: String?
            /// An account the vault keeps for the site: its password, from here.
            var saved: String?
            var save: Bool?
            /// Let agents sign in here on their own. The phone asks for your Face ID first when
            /// it's a saved account's.
            var agents: Bool?
            var code: String?
        }
        guard let asks = browserAsks, let ask = asks.asks.first(where: { $0.id == id }) else { return (404, Data()) }
        guard let given = try? JSONDecoder().decode(Given.self, from: body) else { return (400, Data()) }
        switch (given.answer, ask.kind) {
        case ("signIn", .signIn):
            let host = ask.host
            let username: String?, password: String?, savedPassword: String?
            if let account = given.saved {
                // Said, and the card left up: a 404 would tell the phone it was answered.
                guard let login = Passwords.logins(for: host).first(where: { $0.account == account }) else {
                    return (422, Self.message("No password is saved for \(account.isEmpty ? host : account) any more. Type it instead."))
                }
                guard let saved = Passwords.password(for: login) else {
                    return (422, Self.message("The saved password for \(host) couldn’t be read. Type it instead."))
                }
                (username, password, savedPassword) = (account.isEmpty ? nil : account, saved, saved)
            } else {
                username = given.username.flatMap { $0.isEmpty ? nil : $0 }
                password = given.password.flatMap { $0.isEmpty ? nil : $0 }
                // A saved account's password typed anew is kept too, as the card keeps it.
                savedPassword = Passwords.logins(for: host).first { $0.account == (username ?? "") }.flatMap(Passwords.password(for:))
                guard username != nil || password != nil else { return (400, Data()) }
            }
            asks.answer(id, .signIn(username: username, password: password))
            if let failure = await BrowserAsks.keep(host: host, account: username ?? "", password: password ?? "", saving: given.save == true,
                                                    savedPassword: savedPassword, allowAgents: given.agents == true) {
                if let session = ask.session { workspace?.model(for: session)?.failure = failure }
                return (200, Self.message(failure))
            }
            return (200, Data("{}".utf8))
        case ("code", .code):
            guard let code = given.code?.trimmingCharacters(in: .whitespaces), !code.isEmpty else { return (400, Data()) }
            asks.answer(id, .code(code))
        case ("done", .action):
            asks.answer(id, .done)
        case ("declined", _):
            asks.answer(id, .declined)
        default:
            return (400, Data())
        }
        return (200, Data("{}".utf8))
    }

    // MARK: Usage

    /// The menu bar's usage panel, as its Bars view lists it; nil while it isn't running (a phone
    /// then hides Usage).
    private func usageJSON() -> Data? {
        #if DEBUG
        if Self.usageSample { return Data(Self.sampleUsage.utf8) }
        #endif
        return usagePanel()
    }

    /// What the panel reports (a test's panel in its place: the real one puts an item in the menu bar).
    var usagePanel: @MainActor () -> Data? = { UsageMenuBar.shared.phoneUsage() }

    #if DEBUG
    /// KUVO_DEMO_USAGE=sample: the usage tracker stays out (as with `off`), and phones get these
    /// numbers instead of your accounts'.
    static var usageSample: Bool { ProcessInfo.processInfo.environment["KUVO_DEMO_USAGE"] == "sample" }

    private static var sampleUsage: String {
        let now = Int(Date.now.timeIntervalSince1970)
        // The providers' own marks, as the real panel sends them.
        let icon = { (id: String) in UsageMenuBar.phoneMark(for: id).map { #""icon":"\#($0)","iconIsTemplate":true,"# } ?? "" }
        return """
        {"providers":[\
        {"id":"claude",\(icon("claude"))"name":"Claude","plan":"Max","color":"#DE7356","refreshed":\(now - 40),"lines":[\
        {"type":"progress","label":"Session","used":42,"limit":100,"format":{"kind":"percent"},"resetsAt":\(now + 7_200),"periodDurationMs":18000000},\
        {"type":"progress","label":"Weekly","used":67,"limit":100,"format":{"kind":"percent"},"resetsAt":\(now + 259_200),"periodDurationMs":604800000}]},\
        {"id":"codex",\(icon("codex"))"name":"Codex","plan":"Pro","color":"#10A37F","refreshed":\(now - 95),"lines":[\
        {"type":"progress","label":"Session","used":18,"limit":100,"format":{"kind":"percent"},"resetsAt":\(now + 12_600),"periodDurationMs":18000000},\
        {"type":"text","label":"Credits","value":"$12.40"}]},\
        {"id":"cursor",\(icon("cursor"))"name":"Cursor","color":"#13120A","refreshed":\(now - 900),"notice":"Not logged in. Sign in to Cursor to see its usage.","stale":true,"lines":[\
        {"type":"badge","label":"Error","text":"Not logged in"}]}],\
        "refreshing":false,"refreshed":\(now - 40)}
        """
    }
    #endif

    // MARK: Bots

    /// A conversation's wake-ups as its box has them now, for what the app shows of them.
    func wakesChanged(_ session: String) async {
        guard let app = bots?.app else { return }
        if let bot = app.bots.bot(forSession: session) {
            await app.wakeUps.read(bot.wakeOwner)
        } else if let found = app.workspace.session(session) {
            await app.wakeUps.read(WakeUps.owner(of: found))
        }
    }

    /// Whether a route is answered by this Mac's box: an area that's moved there (`boxRoutes`).
    nonisolated static func movedToBox(_ route: String) -> Bool {
        boxRoutes.contains { route == $0 || route.hasPrefix($0 + "/") }
            // A session started with a task, a session's queue, its approval, its reviewer's decisions, its Autopilot,
            // carrying it on with the coding agents, and sessions at a glance.
            || route == "kuvo/sessions" || route.wholeMatch(of: /kuvo\/sessions\/(queues\/events|glance(\/events)?|[^\/]+\/(stop|approval|decisions|autopilot(\/asked)?|queue(\/.+)?|agents))/) != nil
            // A plan signed out (`kuvo/accounts/<id>/forget`), a provider's models asked of again
            // (`kuvo/accounts/<id>/refresh`), and a command stopped (`kuvo/shell/<id>/stop`): the box's too.
            || Self.oneOf(route, "kuvo/accounts/", "/forget") || Self.oneOf(route, "kuvo/accounts/", "/refresh") || Self.oneOf(route, "kuvo/shell/", "/stop")
    }

    /// Whether `route` is `<start><one part><end>`.
    nonisolated private static func oneOf(_ route: String, _ start: String, _ end: String) -> Bool {
        route.hasPrefix(start) && route.hasSuffix(end) && route.count > start.count + end.count
            && !route.dropFirst(start.count).dropLast(end.count).contains("/")
    }

    /// A response that doesn't end: `current()` now, as a line of JSON, and again each time it
    /// changes, until the phone stops reading. 404 when there's nothing to follow (no such chat), as
    /// reading it once answers; `waits`, it's something that comes later: open meanwhile, with
    /// an empty line and then nothing until it does.
    nonisolated private static func following(waits: Bool = false, _ current: @escaping @MainActor () -> Data?) -> AsyncThrowingStream<LinkResponsePart, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { @MainActor in
                guard waits || current() != nil else {
                    continuation.yield(.head(status: 404, headers: [:]))
                    continuation.finish()
                    return
                }
                continuation.yield(.head(status: 200, headers: ["content-type": "application/x-ndjson"]))
                // An empty line when it has nothing yet: what passes it on holds the head back
                // until the first bytes, and the phone hears the app's there.
                if waits, current() == nil { continuation.yield(.body(Data("\n".utf8))) }
                var last: Data?
                while !Task.isCancelled {
                    let now = current()
                    guard now != nil || waits else { break }
                    if let now, now != last {
                        continuation.yield(.body(now + Data("\n".utf8)))
                        last = now
                    }
                    await changed(current)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Returns once what `current` reads changes, or after half a minute.
    private static func changed(_ current: @escaping @MainActor () -> Data?) async {
        final class Once: @unchecked Sendable {
            var continuation: CheckedContinuation<Void, Never>?
            func resume() {
                continuation?.resume()
                continuation = nil
            }
        }
        let once = Once()
        await withCheckedContinuation { continuation in
            once.continuation = continuation
            withObservationTracking { _ = current() } onChange: {
                Task { @MainActor in once.resume() }
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(30))
                once.resume()
            }
        }
    }

    /// Kept in phone-link.json.
    private func save() {
        let saved = Saved(phones: paired.phones, removed: paired.removed, machines: machineHosts, toRemove: toRemove)
        try? JSONEncoder().encode(saved).write(to: savedFile, options: .atomic)
    }

    // MARK: Keychain

    static var keychainService: String { (Bundle.main.bundleIdentifier ?? "run.kuvo.code") + ".phone-link" }
    private static var service: String { keychainService }

    /// The item, or nil when there's none; throws when the Keychain can't be read.
    private static func keychain(_ account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        var result: CFTypeRef?
        let status = Keychain.copyMatching(query, &result)
        switch status {
        case errSecSuccess: return result as? Data
        case errSecItemNotFound: return nil
        default: throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    private static func setKeychain(_ data: Data, for account: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if Keychain.update(base, [kSecValueData as String: data]) != errSecItemNotFound { return }
        var item = base
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "Kuvo Code phone link"
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        Keychain.add(item)
    }
}
