import AppKit
import CryptoKit
import Foundation
import KuvoLink
import OpenCodeKit
import os
import UsageKit
import Security
import UniformTypeIdentifiers
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
    static let pairingTime: Duration = .seconds(600)

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
    /// This Mac's side of the documents your computers copy between them (PROTOCOL.md, "Documents").
    @ObservationIgnored private(set) var documents = MacDocuments()
    @ObservationIgnored private var assembler = Documents.Assembler()
    /// Personalities a machine's view changed here: their bots are told. Set by AppModel.
    @ObservationIgnored var tookPersonalities: (Set<String>) -> Void = { _ in }
    /// The machines that are connected now, for putting the bridge on them; set by AppModel.
    @ObservationIgnored var readyMachines: () -> [MachineEngine] = { [] }
    /// Your bots, for `kuvo/bots`: the phone draws and describes each as the Mac does; set by
    /// AppModel.
    @ObservationIgnored weak var bots: Bots?
    /// Every conversation's wake-ups and watches, for `kuvo/wakes`; set by AppModel.
    @ObservationIgnored weak var wakeUps: WakeUps?
    /// What agents ask you for while they browse, for `kuvo/asks`: a phone answers them as the
    /// cards in the window do; set by AppModel.
    @ObservationIgnored weak var browserAsks: BrowserAsks?
    /// Your group chats, for `kuvo/groups`: a phone reads and writes in them as the window does;
    /// set by AppModel.
    @ObservationIgnored weak var groups: GroupChats?
    /// Your sessions, for stopping a command an agent left running (`kuvo/shell/<id>/stop`); set
    /// by AppModel.
    @ObservationIgnored weak var workspace: Workspace?
    /// A machine's name, by its id, for where an ask's browser runs; set by AppModel.
    @ObservationIgnored var machineName: (String) -> String? = { _ in nil }
    /// The agents bridge (Claude Code, Codex…), for `kuvo/agents/api/…`; set by AppModel.
    @ObservationIgnored var agents: OutsideAgents?
    /// Plans whose sign-in ended (the service refused it), for `kuvo/accounts/ended`, and
    /// Disconnect as Settings › Accounts does it (here and on your machines); set by AppModel.
    @ObservationIgnored var endedSignIns: () -> [String] = { [] }
    /// (Whether it was one of your plans: nothing else is signed out.)
    @ObservationIgnored var forgetSignIn: (String) -> Bool = { _ in false }
    /// Whether a group chat or a bot is on its way to another computer; set by AppModel.
    @ObservationIgnored var isMoving: (String) -> Bool = { Moves.isFrozen($0) }
    /// This Mac's engine settings, for `kuvo/config` and `kuvo/mcp/catalog`; set by AppModel.
    @ObservationIgnored weak var engineConfig: EngineConfig?
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
        var documents = MacDocuments()

        init(phones: [Phone] = [], removed: [PairedPhones.Removal] = [], machines: [String: MachineHost] = [:], documents: MacDocuments = MacDocuments()) {
            self.phones = phones
            self.removed = removed
            self.machines = machines
            self.documents = documents
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            phones = try container.decodeIfPresent([Phone].self, forKey: .phones) ?? []
            removed = try container.decodeIfPresent([PairedPhones.Removal].self, forKey: .removed) ?? []
            machines = try container.decodeIfPresent([String: MachineHost].self, forKey: .machines) ?? [:]
            documents = try container.decodeIfPresent(MacDocuments.self, forKey: .documents) ?? MacDocuments()
        }
    }
    private(set) var status = Status.off
    /// The link a phone pairs with, while Settings › Phone shows it: good for ten minutes, once.
    private(set) var pairing: PairingLink?
    @ObservationIgnored private var pairingEnds = ContinuousClock.now
    /// A link a paired phone asked for, for another phone (`kuvo/phones/pair`): apart from the one
    /// Settings › Phone shows, so neither ends the other. Good for as long, once.
    @ObservationIgnored private var askedPairing: (link: PairingLink, ends: ContinuousClock.Instant)?

    var relay: URL {
        UserDefaults.standard.string(forKey: "phoneLink.relay").flatMap(URL.init(string:)) ?? Self.defaultRelay
    }

    /// This Mac's key and relay secret, from the Keychain, made the first time the link is on
    /// (with it off, Kuvo Code keeps nothing for it).
    @ObservationIgnored private lazy var identity: (key: LinkKey, secret: RelaySecret) = Self.loadIdentity()
    private var key: LinkKey { identity.key }
    private var secret: RelaySecret { identity.secret }
    @ObservationIgnored private var server: LinkServer?
    @ObservationIgnored private var running: Task<Void, Never>?
    @ObservationIgnored private var endpoint: ServerEndpoint?
    private let log = Logger(subsystem: "run.kuvo.code", category: "phone")
    /// Notices for your phones, held while you're at a computer (PROTOCOL.md, "kuvo/attention"); a
    /// test gives it its own clock, and takes what it sends.
    @ObservationIgnored lazy var hold = NoticeHold { [weak self] notice in self?.deliver(notice) ?? true }
    /// Pushes not yet handed to the relay, which quitting waits for (see `flushBeforeQuit`).
    @ObservationIgnored let delivering = OSAllocatedUnfairLock(initialState: 0)

    /// Where the phones and machines are kept: phone-link.json (a test's own, for a test).
    private let savedFile: URL

    /// `file`, `identity` and `signing`: a test's own, kept apart from the app's file and Keychain
    /// (one giving an identity and no signing key gets a new one).
    init(file: URL? = nil, identity: (key: LinkKey, secret: RelaySecret)? = nil, signing: Documents.SigningKey? = nil) {
        savedFile = file ?? AppInfo.supportDirectory.appending(path: "phone-link.json")
        let saved = (try? JSONDecoder().decode(Saved.self, from: Data(contentsOf: savedFile))) ?? Saved()
        paired = PairedPhones(phones: saved.phones, removed: saved.removed)
        machineHosts = saved.machines
        documents = saved.documents
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

    /// This Mac connects to the relay: for your phones, or for your other computers. A Mac on its
    /// own, without the phone link, makes no connection.
    var relayWanted: Bool { Self.isEnabled || hasMachines() }

    /// Where each conversation being moved lives now (nil: this Mac), by machine. Set by the app
    /// (`Moves.livePlaces`).
    @ObservationIgnored var movedSessions: () -> [String: String?] = { [:] }

    /// Mail from one of your machines (PROTOCOL.md, "Peers"), opened: which machine, and what it
    /// said. Set by the app (AgentMail).
    @ObservationIgnored var onMail: (_ machine: String, _ payload: [String: Any]) -> Void = { _, _ in }

    /// Starts answering phones and your machines, through this Mac's engine at `endpoint`, once
    /// it's ready.
    func start(endpoint: ServerEndpoint) {
        self.endpoint = endpoint
        guard relayWanted, running == nil, hasIdentity else { return }
        server = makeServer(endpoint: endpoint)
        running = Task { await run() }
        #if DEBUG
        pairForDemo()
        #endif
    }

    #if DEBUG
    /// KUVO_DEMO_PHONE_PAIR=<file>: once the relay answers, a pairing code, its link written to
    /// that file, for pairing a simulator (or a test) without a camera or the window.
    private func pairForDemo() {
        guard let file = ProcessInfo.processInfo.environment["KUVO_DEMO_PHONE_PAIR"] else { return }
        Task { [weak self] in
            for _ in 0..<60 where self?.status != .connected { try? await Task.sleep(for: .milliseconds(500)) }
            guard let self, pairing == nil else { return }
            beginPairing()
            try? pairing?.url.absoluteString.write(toFile: file, atomically: true, encoding: .utf8)
        }
    }
    #endif

    func stop() {
        let server = server, running = running
        self.running = nil
        self.server = nil
        status = .off
        // Phones hear their sessions end (see `LinkServer.closeAll`); the relay connection goes
        // once that's on its way.
        Task {
            await server?.closeAll()
            try? await Task.sleep(for: .milliseconds(300))
            running?.cancel()
        }
    }

    private func restart() {
        guard let endpoint else { return }
        stop()
        start(endpoint: endpoint)
    }

    /// A machine added or removed: with the first, this Mac meets it at the relay; with the last
    /// gone (and no phone link), it stops. The others hear who their peers are now.
    func machinesChanged() {
        if relayWanted, running == nil, let endpoint {
            start(endpoint: endpoint)
        } else if !relayWanted, running != nil {
            stop()
        }
        syncMachines()
        Task { await tellMachines() }
    }

    /// Shows a pairing link (as a QR code) for a phone to scan.
    func beginPairing() {
        pairing = PairingLink(relay: relay, host: secret.address, key: key.publicBytes, name: Self.computerName)
        pairingEnds = .now + Self.pairingTime
    }

    func endPairing() {
        pairing = nil
    }

    /// Removes a phone you've paired (Settings › Phone): here and on your machines, for good, until
    /// it's paired again.
    func remove(_ phone: Phone) {
        let mac = key.publicBytes.base64URL
        removePhones([.init(key: phone.key, pairing: phone.pairing)], by: mac)
    }

    /// `entries` removed by `sender`, this Mac or a phone paired with it: as `PairedPhones` has it
    /// (never this Mac, and for good). Their sessions end, and your machines hear of it. False,
    /// changing nothing, when that isn't allowed.
    @discardableResult
    private func removePhones(_ entries: [PairedPhones.Entry], by sender: String) -> Bool {
        let before = Set(paired.phones.map(\.key))
        guard paired.remove(entries, by: sender, macs: [key.publicBytes.base64URL]) else { return false }
        save()
        // Once the answer's on its way: a phone that removed itself gets it too.
        let gone = before.subtracting(paired.phones.map(\.key)).compactMap { Data(base64URL: $0) }
        Task { [server] in
            try? await Task.sleep(for: .milliseconds(200))
            for key in gone { await server?.forget(phone: key) }
        }
        syncMachines()
        Task { await tellMachines() }
        return true
    }

    /// `kuvo/phones`: the phones paired with this Mac (`you`, the one asking); `kuvo/phones/remove`
    /// (POST, `{"phones": [{key, pairing}]}`): a phone removes others (a lost one, say) or itself;
    /// `kuvo/phones/pair`: POST, a link for another phone to pair with, as Settings › Phone shows
    /// one; DELETE ends it, as Done does there.
    func answerPhones(_ request: LinkRequest, asking: Data?) -> (Int, Data) {
        let encoder = JSONEncoder()
        let me = asking?.base64URL
        if request.path == "kuvo/phones/pair" {
            if request.method.uppercased() == "DELETE" {
                askedPairing = nil
                return (200, Data("{}".utf8))
            }
            guard request.method.uppercased() == "POST" else { return (405, Data("{}".utf8)) }
            // (Its keys are made only once the link is on.)
            guard Self.isEnabled, hasIdentity else { return (409, Self.message("The phone link is off on this Mac.")) }
            let asked = PairingLink(relay: relay, host: secret.address, key: key.publicBytes, name: Self.computerName)
            askedPairing = (asked, .now + Self.pairingTime)
            let ends = Date.now.addingTimeInterval(Double(Self.pairingTime.components.seconds))
            return (200, Self.json(["link": asked.url.absoluteString, "ends": ends.timeIntervalSince1970]))
        }
        if request.path == "kuvo/phones" {
            struct Listed: Encodable { var key: String; var name: String; var added: Double; var pairing: String; var you: Bool }
            let listed = paired.phones.map { Listed(key: $0.key, name: $0.name, added: $0.added.timeIntervalSince1970, pairing: $0.pairing, you: $0.key == me) }
            return (200, (try? encoder.encode(["phones": listed])) ?? Data())
        }
        guard request.method.uppercased() == "POST" else { return (405, Data("{}".utf8)) }
        struct Given: Decodable { var phones: [PairedPhones.Entry] }
        guard let me, let given = try? JSONDecoder().decode(Given.self, from: request.body), removePhones(given.phones, by: me) else {
            return (400, (try? encoder.encode(["message": "Only phones paired here can be removed, and never your Mac."])) ?? Data())
        }
        return (200, Data("{}".utf8))
    }

    // MARK: Machines

    /// Puts the bridge on each connected machine, with the phones you've paired now.
    func syncMachines() {
        for engine in readyMachines() { Task { await sync(engine) } }
    }

    /// Puts the bridge (`kuvo-link.js`) on `engine`'s machine, in `~/.kuvo-code/bin`, with the
    /// phones you've paired and the relay, so they reach it directly, with this Mac closed too.
    /// The machine keeps its own keys and tells this Mac only its address and public key. With
    /// no phones, the bridge stops there.
    func sync(_ engine: MachineEngine) async {
        guard relayWanted, engine.isReady, hasIdentity else { return }
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
                if [ "$(sha256sum "$f" 2>/dev/null | cut -c1-64)" = "\(hash)" ]; then cat >/dev/null; else cat >"$f.new" && mv -f "$f.new" "$f"; fi
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
                /// This Mac never puts its own files over a newer box's (`BoxVersion`): the box may
                /// update itself once every Mac it sees does.
                var tolerates = 1
                /// This Mac's ID, as its engine launches there name it.
                var macID = MachineEngine.macID
            }
            let settings = folder.appending(path: "setup.json")
            // Set up again: no longer one this Mac removed.
            if let known = machineHosts[machine.id]?.key { documents.added(machine: known) }
            try JSONEncoder().encode(Setup(relay: relay.absoluteString, name: machine.name, mac: key.publicBytes.base64URL, macSign: Documents.origin(of: signing),
                                           docs: allDocuments(), id: machine.id)).write(to: settings)
            let output = try await machine.connection.run(RemoteEngineInstaller.script("""
                KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$E" "$K/bin/\(Bridge.fileName)" setup
                """), input: settings)
            struct Answer: Decodable { var address: String?; var key: String?; var peers: Bool?; var sign: String?; var docs: [Documents.Envelope]? }
            let answer = try? JSONDecoder().decode(Answer.self, from: Data(output.utf8))
            let before = machineHosts[machine.id]
            if let address = answer?.address, let key = answer?.key {
                machineHosts[machine.id] = MachineHost(name: machine.name, address: address, key: key, anotherMac: engine.isAnotherMacsEngine, peers: answer?.peers,
                                                       sign: answer?.sign.flatMap { $0.wholeMatch(of: /[A-Za-z0-9_-]{43}/) != nil ? $0 : nil })
                documents.added(machine: key)
            } else {
                machineHosts[machine.id] = nil
            }
            save()
            // What it has of documents (its own, signed with the key it just gave over SSH).
            if let docs = answer?.docs, !docs.isEmpty { takeDocuments(["give": docs.map(\.json)], from: machine.id) }
            // A machine new here (or at a new address, or newly talking to other computers): your
            // others hear it's one of theirs.
            let now = machineHosts[machine.id]
            if now != before { Task { await tellMachines() } }
        } catch {
            log.error("Couldn't set up the phone link on a machine: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// A conversation being moved, and the key of the computer it lives on now (PROTOCOL.md,
    /// "Peers"): the one it left may still list it.
    struct Moved: Encodable {
        var session: String
        var key: String
    }

    private var moved: [Moved] {
        movedSessions().compactMap { session, place in
            // On this Mac, or a machine whose link talks to other computers (others' aren't peers).
            let live: String? = if let place { machineHosts[place]?.peers == true ? machineHosts[place]?.key : nil } else { key.publicBytes.base64URL }
            return live.map { Moved(session: session, key: $0) }
        }.sorted { $0.session < $1.session }
    }

    /// One of your computers, as this Mac's peers document names it (PROTOCOL.md, "Peers").
    struct Peer: Encodable {
        var key: String
        var sign: String
        var address: String
        var name: String
        var kind: String
        /// A machine's name here, for the agents of each to say where they are.
        var id: String?
    }

    /// Tells your machines what changed of this Mac's documents (PROTOCOL.md, "Documents"): who your
    /// computers are, the phones you've paired and removed, and your personalities, through the
    /// relay, whether this Mac can reach a machine itself now or not; a machine that was off gets
    /// them as it meets the others. `ask`: this Mac just met the relay, and may have missed what they
    /// said: each gets its digest (so it gives what this Mac lacks, and asks for what it has), and
    /// tells it its agents again (PROTOCOL.md, "Peers").
    func tellMachines(ask: Bool = false) async {
        guard let server, status == .connected, hasIdentity, !machineHosts.isEmpty else { return }
        let changed = refreshDocuments().changed
        let have = ask ? documents.digest(origin: Documents.origin(of: signing)) : nil
        for (_, host) in documentMachines {
            let mails = Documents.mails(give: changed, have: have)
            for (index, docs) in mails.enumerated() {
                await send(["docs": docs], extra: ask && index == mails.count - 1 ? ["ask": "agents"] : [:], to: host, server: server)
            }
        }
    }

    /// Mails `payload` to one of your machines' bridges (one that talks to other computers
    /// itself): `offline` when it can't go now (no relay connection, or it isn't such a machine),
    /// `tooBig` for one the relay won't take.
    func mail(_ payload: [String: Any], to machine: String) async -> LinkServer.MailOutcome {
        guard let server, status == .connected, let host = machineHosts[machine], host.peers == true, host.anotherMac != true,
              let key = Data(base64URL: host.key), let bytes = Data(base64URL: host.address), let address = LinkAddress(bytes: bytes) else { return .offline }
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return .tooBig }
        return await server.mail(data, to: key, at: address)
    }

    /// This Mac's public key, as your machines know it (none while the Keychain won't give it out).
    var macKey: String? {
        hasIdentity ? key.publicBytes.base64URL : nil
    }

    /// Whether `machine`'s bridge talks to your other computers itself (it makes its own list of
    /// agents, and sends its agents' letters).
    func talksToPeers(_ machine: String) -> Bool {
        machineHosts[machine]?.peers == true && machineHosts[machine]?.anotherMac != true
    }

    /// Whether `machine`'s bridge talks to your other computers itself, and this Mac meets it at
    /// the relay now.
    func reachesByMail(_ machine: String) -> Bool {
        status == .connected && machineHosts[machine]?.peers == true && machineHosts[machine]?.anotherMac != true
    }

    /// A mail frame from the relay: opened with the key of one of your machines, or dropped.
    private func mailed(_ frame: Data) {
        for (machine, host) in machineHosts where host.anotherMac != true {
            guard let remote = Data(base64URL: host.key), let opened = try? Mail.open(frame, to: key, from: remote) else { continue }
            guard let payload = try? JSONSerialization.jsonObject(with: opened) as? [String: Any] else { return }
            if let docs = payload["docs"] as? [String: Any] { takeDocuments(docs, from: machine) }
            onMail(machine, payload)
            return
        }
    }

    /// A machine you removed: phones stop being told about it.
    func forget(machine id: String) {
        guard let host = machineHosts.removeValue(forKey: id) else { return }
        documents.removed(machine: host.key)
        documents.prune(machines: machineSigns)
        save()
        Task {
            await tellMachines()
            // It hears it too, once, while this Mac still knows where it is: it lets this Mac go.
            guard let server, status == .connected, host.sign != nil, !machineHosts.values.contains(where: { $0.key == host.key }),
                  let peers = refreshDocuments().own.first(where: { Documents.read($0)?.kind == "peers" }) else { return }
            await send(["docs": ["give": [peers.json]]], to: host, server: server)
        }
    }

    // MARK: Documents

    /// The machines that take this Mac's documents: those whose bridge signs its own, and whose
    /// engine is this Mac's (another Mac's machines are that Mac's to tell).
    private var documentMachines: [(id: String, host: MachineHost)] {
        machineHosts.filter { $0.value.sign != nil && $0.value.anotherMac != true && $0.value.peers == true }
            .sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    /// The keys your machines sign their documents with: the ones whose phones and personalities
    /// this Mac takes.
    private var machineSigns: Set<String> { Set(machineHosts.values.compactMap(\.sign)) }

    private static let canonical: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    /// Who your computers are, as this Mac says: itself and its machines, each with the key it signs
    /// with; the conversations being moved; and the machines it removed, so they let it go.
    private var peersBody: Data {
        struct Body: Encodable { var boxes: [Peer]; var moved: [Moved]; var left: [String] }
        let me = Peer(key: key.publicBytes.base64URL, sign: Documents.origin(of: signing), address: secret.address.bytes.base64URL, name: Self.computerName, kind: "mac", id: nil)
        let machines = documentMachines.map { Peer(key: $0.host.key, sign: $0.host.sign ?? "", address: $0.host.address, name: $0.host.name, kind: "machine", id: $0.id) }
        // Never one that's still one of its machines (the same computer, under another name).
        let current = Set(machineHosts.values.map(\.key))
        return (try? Self.canonical.encode(Body(boxes: [me] + machines, moved: moved, left: documents.left.filter { !current.contains($0) }))) ?? Data("{}".utf8)
    }

    /// The phones you've paired here, and every removal this Mac knows of; none while the phone link
    /// is off (the machines keep what they have).
    private var phonesBody: Data? {
        guard Self.isEnabled else { return nil }
        struct Listed: Encodable { var key: String; var name: String; var address: String?; var pairing: String }
        struct Body: Encodable { var phones: [Listed]; var removed: [PairedPhones.Removal] }
        return try? Self.canonical.encode(Body(phones: phones.map { .init(key: $0.key, name: $0.name, address: $0.address, pairing: $0.pairing) }, removed: paired.removed))
    }

    /// Your personalities as this Mac has them; none once they're past what a document holds.
    private var personalitiesBody: Data? {
        guard let body = try? Self.canonical.encode(Personalities.shared.library), body.count <= Documents.mostBody else { return nil }
        return body
    }

    /// This Mac's own documents as they are now (`own`), each with its next version where it changed
    /// (`changed`, those that did).
    @discardableResult
    private func refreshDocuments() -> (own: [Documents.Envelope], changed: [Documents.Envelope]) {
        guard hasIdentity else { return ([], []) }
        var own: [Documents.Envelope] = [], changed: [Documents.Envelope] = []
        for (kind, body) in [("peers", peersBody), ("phones", phonesBody), ("personalities", personalitiesBody)] {
            guard let body else { continue }
            let made = documents.own(kind, body: body, key: signing)
            own.append(made.envelope)
            if made.changed { changed.append(made.envelope) }
        }
        save()
        return (own, changed)
    }

    /// This Mac's own documents now, and those it keeps of your machines: what setup gives a machine.
    func allDocuments() -> [Documents.Envelope] {
        refreshDocuments().own + documents.held.values.sorted { $0.d < $1.d }
    }

    /// This Mac's digest, its own documents brought up to date first: what its agents' mail carries
    /// every ten minutes, so a machine that missed what it was given gets it then.
    func documentsDigest() -> [[Any]]? {
        guard hasIdentity else { return nil }
        refreshDocuments()
        return documents.digest(origin: Documents.origin(of: signing))
    }

    /// Mails `payload` (with `extra` beside it) to a machine.
    private func send(_ payload: [String: Any], extra: [String: Any] = [:], to host: MachineHost, server: LinkServer) async {
        var mail = payload.merging(extra) { $1 }
        mail["at"] = Int64(Date.now.timeIntervalSince1970 * 1000)
        guard let key = Data(base64URL: host.key), let bytes = Data(base64URL: host.address), let address = LinkAddress(bytes: bytes),
              let data = try? JSONSerialization.data(withJSONObject: mail) else { return }
        if await server.mail(data, to: key, at: address) != .sent { log.error("Couldn’t mail a machine this Mac’s documents") }
    }

    /// What one of your machines sent of documents (`docs`: given, in parts, or a digest): its phones
    /// document's removals taken here (a phone removed there leaves this Mac too), its view of your
    /// personalities met with this Mac's (bots with one that changed told), what's new passed on to
    /// your other machines, what changed of this Mac's own given to all of them, and for a digest,
    /// what it lacks, and this Mac's own digest when it has something newer.
    func takeDocuments(_ docs: [String: Any], from machine: String) {
        guard hasIdentity, let sender = machineHosts[machine] else { return }
        let origin = Documents.origin(of: signing)
        let machines = machineSigns
        let phonesBefore = Set(paired.phones.map(\.key))
        var given = (docs["give"] as? [Any] ?? []).prefix(64).compactMap(Documents.Envelope.init)
        if let part = docs["part"] as? [String: Any], let whole = assembler.take(part, from: sender.key) { given.append(whole) }
        var passOn: [Documents.Document] = []
        var changedPersonalities: Set<String> = []
        for envelope in given {
            guard let (doc, mine) = documents.take(envelope, machines: machines, origin: origin) else { continue }
            if doc.kind == "phones", let removals = doc.decoded(PhonesRemovals.self)?.removed {
                paired.takeRemovals(removals, macs: [key.publicBytes.base64URL])
            }
            if doc.kind == "personalities", let library = doc.decoded(Personalities.Library.self) {
                changedPersonalities.formUnion(Personalities.shared.take(library))
            }
            if !mine, doc.kind == "phones" { passOn.append(doc) }
        }
        var changed: [Documents.Envelope] = []
        var giveBack: [Documents.Envelope] = []
        var ask = false
        if let have = docs["have"] as? [[Any]] {
            var theirs: [String: (n: Int, h: String)] = [:]
            for entry in have.prefix(512) where entry.count >= 3 {
                guard let o = entry[0] as? String, let kind = entry[1] as? String, let n = entry[2] as? Int, n >= 0, n <= MacDocuments.mostCount else { continue }
                theirs["\(o) \(kind)"] = (n, entry.count > 3 ? entry[3] as? String ?? "" : "")
            }
            // One of this Mac's own further on than it knew (it lost count): its next goes past it.
            for kind in Documents.kinds { if let there = theirs["\(origin) \(kind)"] { documents.catchUp(kind, to: there.n) } }
            let refreshed = refreshDocuments()
            changed += refreshed.changed
            func behind(_ key: String, _ n: Int, _ h: String) -> Bool {
                guard let there = theirs[key] else { return true }
                return there.n < n || (there.n == n && there.h > h)
            }
            for envelope in documents.held.values.sorted(by: { $0.d < $1.d }) + refreshed.own {
                guard let doc = Documents.read(envelope), doc.origin != sender.sign, behind("\(doc.origin) \(doc.kind)", doc.n, doc.h) else { continue }
                giveBack.append(envelope)
            }
            if docs["reply"] as? Bool != true {
                for (key, there) in theirs {
                    let parts = key.split(separator: " ").map(String.init)
                    guard parts.count == 2, parts[0] != origin, machines.contains(parts[0]) else { continue }
                    let have: (n: Int, h: String)? = switch parts[1] {
                    case "personalities" where parts[0] == sender.sign: documents.views[parts[0]].map { ($0.n, $0.h) } ?? (0, "")
                    case "phones": documents.held[key].flatMap(Documents.read).map { ($0.n, $0.h) } ?? (0, "")
                    default: nil
                    }
                    if let have, have.n < there.n || (have.n == there.n && have.h > there.h) { ask = true }
                }
            }
        }
        documents.prune(machines: machineSigns)
        changed += refreshDocuments().changed
        // A phone removed elsewhere loses its sessions here too.
        let gone = phonesBefore.subtracting(paired.phones.map(\.key)).compactMap { Data(base64URL: $0) }
        if !gone.isEmpty { Task { [server] in for phone in gone { await server?.forget(phone: phone) } } }
        save()
        if !changedPersonalities.isEmpty { tookPersonalities(changedPersonalities) }
        guard let server, status == .connected else { return }
        let have = ask ? documents.digest(origin: origin) : nil
        let targets = documentMachines
        Task {
            for (id, host) in targets {
                var give = changed + passOn.filter { host.sign != $0.origin && id != machine }.map(\.envelope)
                if id == machine { give += giveBack }
                var seen = Set<String>()
                give = give.filter { seen.insert($0.d).inserted }
                for docs in Documents.mails(give: give, have: id == machine ? have : nil, reply: true) {
                    await send(["docs": docs], to: host, server: server)
                }
            }
        }
    }

    /// The removals a phones document carries.
    private struct PhonesRemovals: Decodable { var removed: [PairedPhones.Removal] }

    // MARK: Answering

    private func run() async {
        var attempt = 0
        while !Task.isCancelled, let server {
            status = .connecting
            do {
                let connection = try await WebSocketRelay.connect(to: relay, secret: secret)
                status = .connected
                attempt = 0
                // Your machines hear who's here, as soon as there's a way to tell them, and tell
                // their agents again (what they said meanwhile didn't come).
                Task { [weak self] in
                    try? await Task.sleep(for: .milliseconds(500))
                    await self?.tellMachines(ask: true)
                }
                await server.serve(connection)
                // Gone: nothing goes by mail until it's back (unless this was stopped, or another
                // connection took over meanwhile).
                if !Task.isCancelled, self.server === server { status = .connecting }
            } catch {
                status = .failed("Can’t reach the relay at \(relay.host() ?? relay.absoluteString).")
            }
            attempt += 1
            try? await Task.sleep(for: .seconds(min(60, 1 << min(attempt, 6))))
        }
    }

    private func makeServer(endpoint: ServerEndpoint) -> LinkServer {
        let hello = HostHello(kind: .mac, name: Self.computerName, app: AppInfo.version, engine: OpenCodeEngine.version)
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url : URL(string: endpoint.url.absoluteString + "/")!
        let password = endpoint.password
        let log = log
        let agents = agents?.address
        return LinkServer(key: key, hello: hello) { [weak self] key, address, hello in
            await self?.authorize(key, address, hello) ?? false
        } handle: { [weak self] request, phone in
            Self.respond(to: request, link: self, engine: base, password: password, agents: agents, asking: phone.key)
        } connect: { request, _, input in
            // Terminals: the engine's, in a project's folder.
            EngineRoutes.connect(request, to: base, password: password, input: input)
        } pushed: { _, status in
            switch status {
            case .sent: break
            // Until the phone has registered for notifications, and asked for this Mac's.
            case .noPhone: log.info("A push had no phone registered for it")
            case .notAllowed: log.info("A push wasn't from one of the phone's hosts")
            case .refused: log.error("Apple refused a push")
            }
        } confirmed: { [weak self] phone in
            Task { @MainActor in self?.confirmed(phone) }
        } mailed: { [weak self] frame, _ in
            Task { @MainActor in self?.mailed(frame) }
        }
    }

    /// What this Mac answers a paired phone's request with: Kuvo's own routes (`kuvo/…`), the
    /// coding agents' bridge's (`kuvo/agents/…`, at `agents`) and the engine's (at `base`).
    /// `asking`: the phone's key.
    nonisolated static func respond(to request: LinkRequest, link: PhoneLink?, engine base: URL, password: String?,
                                    agents: OutsideAgents.Address?, asking: Data? = nil) -> AsyncThrowingStream<LinkResponsePart, Error> {
        guard request.path.hasPrefix("kuvo/") else {
            return Self.namingAgents(in: request, by: link) { EngineRoutes.forward($0, to: base, password: password) }
        }
        // The outside agents' sessions, through their bridge, as the engine's go through it.
        if request.path.hasPrefix(Self.agentsPrefix) {
            var forwarded = request
            forwarded.path = String(request.path.dropFirst(Self.agentsPrefix.count))
            guard let bridge = agents?.endpoint else { return Self.unavailable() }
            let base = bridge.url.absoluteString.hasSuffix("/") ? bridge.url : URL(string: bridge.url.absoluteString + "/")!
            // Their accounts and Auto too; never where the engine is (the Mac says).
            return Self.namingAgents(in: forwarded, by: link) {
                EngineRoutes.forward($0, to: base, password: bridge.password, allowing: { EngineRoutes.allowsAgents($0, method: $1) })
            }
        }
        // Which route answers, by its path alone: a query string never changes it (as on a machine).
        // Those that read the query get the request whole; the rest, its route.
        let route = request.path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? request.path
        // An area that's moved onto this Mac's box: answered there, as a machine's box answers it.
        if Self.boxRoutes.contains(where: { route == $0 || route.hasPrefix($0 + "/") }) {
            guard let box = Self.box.withLock({ $0 }) else { return Self.boxUnavailable() }
            let base = box.url.absoluteString.hasSuffix("/") ? box.url : URL(string: box.url.absoluteString + "/")!
            // The app's own requests (no phone asking) say so: they aren't a phone using the box.
            return EngineRoutes.forward(request, to: base, password: box.password, adding: asking == nil ? ["x-kuvo-from": "app"] : [:],
                                        allowing: { path, _ in path.hasPrefix("kuvo/") })
        }
        var routed = request
        routed.path = route
        if route == "kuvo/file" { return Self.file(request.path) }
        // The phones paired with this Mac, removing some, and pairing another, from any of them.
        if ["kuvo/phones", "kuvo/phones/remove", "kuvo/phones/pair"].contains(route) {
            return AsyncThrowingStream { [routed] continuation in
                Task { @MainActor in
                    let (status, body) = link?.answerPhones(routed, asking: asking) ?? (503, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        // A client in use here: notices for your phones wait a little while one is.
        if route == "kuvo/attention" {
            return AsyncThrowingStream { [routed] continuation in
                Task { @MainActor in
                    let (status, body) = link?.answerAttention(routed, asking: asking) ?? (503, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        // A new bot or group chat, as New Bot and New Group Chat make them.
        if request.method.uppercased() == "POST", route == "kuvo/bots" || route == "kuvo/groups" {
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let (status, body) = await (route == "kuvo/bots" ? link?.makeBot(request.body) : link?.makeGroup(request.body)) ?? (503, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        // A bot's keys of its own, as Edit Bot shows and changes them.
        if Self.isBotKeys(request.path) {
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let (status, body) = await link?.answerBotKeys(request) ?? (503, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        // A bot changed as Edit Bot changes it, or deleted as Delete Bot… deletes it.
        if let id = Self.botID(in: route), ["PATCH", "DELETE"].contains(request.method.uppercased()) {
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let (status, body) = await (request.method.uppercased() == "PATCH" ? link?.changeBot(id, with: request.body) : link?.deleteBot(id)) ?? (503, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        // A conversation carried on with the coding agents, as picking one of their models in it does.
        if let id = Self.sessionID(in: route, then: "agents") {
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let posts = request.method.uppercased() == "POST"
                    let (status, body) = posts ? await link?.moveToAgents(id, with: request.body) ?? (503, Data()) : (405, Data("{}".utf8))
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        // Settings › Integrations: this Mac's, added and removed as the page does it.
        if route == "kuvo/integrations" || route.hasPrefix("kuvo/integrations/") {
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let (status, body) = await link?.answerIntegrations(request) ?? (503, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        // Settings › Skills: this Mac's skills, and GitHub's collections, reached from here.
        if ["kuvo/skills", "kuvo/skill-library"].contains(where: { route == $0 || route.hasPrefix($0 + "/") }) {
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let (status, body) = await link?.answerSkills(request) ?? (503, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        // Settings › Machines: this Mac's machines. Adding a machine checks it first: the phone
        // going stops that (and nothing else, which would leave a removal half done).
        if route == "kuvo/machines/events", request.method.uppercased() == "GET" { return Self.following { link?.machinesJSON() } }
        if route == "kuvo/machines" || route.hasPrefix("kuvo/machines/") {
            return AsyncThrowingStream { continuation in
                let task = Task { @MainActor in
                    let (status, body) = await link?.answerMachines(request) ?? (503, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
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
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        if route == "kuvo/asks/events" { return Self.following { link?.asksJSON() } }
        if route == "kuvo/groups/events" { return Self.following { link?.groupsJSON() } }
        if let id = Self.groupID(in: route, then: "events") { return Self.followingGroup(id, link: link) }
        // A sign-in's page that sent the browser back to this Mac, loaded here.
        if route == "kuvo/sign-in/return" {
            return AsyncThrowingStream { continuation in
                let task = Task {
                    let (status, body) = request.method.uppercased() == "POST" ? await Self.loadSignInReturn(request.body) : (405, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
                continuation.onTermination = { _ in task.cancel() }
            }
        }
        if route == "kuvo/usage/events" { return Self.following { link?.usageJSON() } }
        // A chat's name, purpose, bots or meeting changed, as Edit Group Chat changes them.
        if route.hasPrefix("kuvo/groups/"), request.method.uppercased() == "PATCH" {
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let (status, body) = await link?.changeGroup(String(route.dropFirst("kuvo/groups/".count)), with: request.body) ?? (503, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        // A chat deleted, as Delete Group Chat… deletes it.
        if request.path.hasPrefix("kuvo/groups/"), request.method.uppercased() == "DELETE" {
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let (status, body) = await link?.deleteGroup(String(request.path.split(separator: "?").first?.dropFirst("kuvo/groups/".count) ?? "")) ?? (503, Self.message("Group chats aren’t ready yet. Try again in a moment."))
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        // What a phone does in a group chat: one on a machine answers once the machine has.
        if route.hasPrefix("kuvo/groups/"), request.method.uppercased() == "POST" {
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let (status, body) = await link?.answerGroup(String(route.dropFirst("kuvo/groups/".count)), with: request.body) ?? (503, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        // This Mac's sign-ins, listed (`api/credential` has what each is signed in with too).
        if route == "kuvo/accounts/credentials" {
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let reads = ["GET", "HEAD"].contains(request.method.uppercased())
                    let (status, body) = reads ? await link?.credentialsJSON() ?? (503, Data()) : (405, Data("{}".utf8))
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        // A session's wake-ups and watches: read, or one canceled.
        if route.hasPrefix("kuvo/wakes/") {
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let (status, body) = await link?.answerWakes(request) ?? (503, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        if let id = Self.shellID(in: route), request.method.uppercased() == "POST" {
            return AsyncThrowingStream { continuation in
                Task { @MainActor in
                    let (status, body) = await link?.stopShell(id, with: request.body) ?? (503, Data())
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        }
        return AsyncThrowingStream { [routed] continuation in
            Task { @MainActor in
                let (status, body) = link?.answer(routed) ?? (503, Data())
                continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                continuation.yield(.body(body))
                continuation.finish()
            }
        }
    }

    /// A phone's session proved its own: its notifications go where it is now, for machines'
    /// bridges too.
    private func confirmed(_ phone: LinkServer.Phone) {
        let encoded = phone.key.base64URL
        guard let index = paired.phones.firstIndex(where: { $0.key == encoded }), paired.phones[index].address != phone.address.text else { return }
        paired.phones[index].address = phone.address.text
        save()
        syncMachines()
    }

    /// Lets in a phone you've paired, or one showing a pairing link's token (once, in time): the
    /// one Settings › Phone shows, or one a paired phone asked for.
    func authorize(_ key: Data, _ address: LinkAddress, _ hello: PhoneHello) -> Bool {
        // Met at the relay only for your machines: no phone comes in.
        guard Self.isEnabled else { return false }
        let encoded = key.base64URL
        // Where a paired one's notifications go changes once its session proves its own (see
        // `confirmed`): the first handshake message can be replayed from another address.
        let isPaired = phones.contains(where: { $0.key == encoded })
        // Showing the token: a pairing of its own, paired before or not (one removed on your
        // machines comes back there too).
        let shows = { (link: PairingLink?, ends: ContinuousClock.Instant) -> Bool in
            guard let link, ContinuousClock.now < ends, let token = hello.pair.flatMap({ Data(base64URL: $0) }) else { return false }
            return token.count == link.token.count && zip(token, link.token).reduce(0, { $0 | ($1.0 ^ $1.1) }) == 0
        }
        let onPage = shows(pairing, pairingEnds)
        guard onPage || shows(askedPairing?.link, askedPairing?.ends ?? .now) else { return isPaired }
        // A pairing of its own: in, whatever removed it before.
        paired.pair(Phone(key: encoded, name: String(hello.name.prefix(100)), added: .now, address: address.text, pairing: PairedPhones.newPairing()))
        save()
        Task { await tellMachines() }
        if onPage { self.pairing = nil } else { askedPairing = nil }
        syncMachines()
        log.info("Paired a phone")
        return true
    }

    // MARK: Notifications

    /// Sends `notice`, about this Mac's own sessions, chats or browser (a machine tells your phones
    /// its own), to your phones' notifications: at once, or, while you're at a computer, once it's
    /// waited a little and wasn't answered or seen meanwhile (`hold`, PROTOCOL.md "kuvo/attention").
    func push(_ notice: Notice) {
        guard Self.isEnabled else { return }
        hold.tell(notice)
    }

    /// Hears from `notifier` what goes to your phones, and what's been answered (which, held, then
    /// never goes).
    func listen(to notifier: Notifier) {
        notifier.toPhones = { [weak self] in self?.push($0) }
        notifier.answeredForPhones = { [weak self] in self?.hold.resolve($0) }
    }

    /// You're using Kuvo Code on this Mac, with `sessions` on its screen and `shown` in its own
    /// notifications just now, or not any more (nil) (`Attention`): this Mac's box hears it, and
    /// each of your machines by mail, so notices for your phones wait a little there too, and one
    /// you saw here doesn't go (PROTOCOL.md, "kuvo/attention"). Each notification shown goes to the
    /// box whose news it was alone.
    func attend(_ sessions: [String]?, shown: [NoticeHold.Shown] = []) {
        guard Self.isEnabled else { return }
        let seconds = sessions == nil ? 0 : Attention.lease
        hold.attend("mac", for: seconds, sessions: sessions ?? [], shown: shown.filter { $0.machine == nil })
        guard let server, status == .connected else { return }
        let at = Int64(Date.now.timeIntervalSince1970 * 1000)
        let delivering = delivering
        for (machine, host) in machineHosts where host.peers == true && host.anotherMac != true {
            var word: [String: Any] = ["for": seconds, "sessions": sessions ?? []]
            let theirs = shown.filter { $0.machine == machine }
            if !theirs.isEmpty {
                word["shown"] = theirs.map { each -> [String: Any] in
                    var entry: [String: Any] = ["session": each.session, "ask": each.ask]
                    if let request = each.request { entry["request"] = request }
                    return entry
                }
            }
            guard let key = Data(base64URL: host.key), let bytes = Data(base64URL: host.address), let address = LinkAddress(bytes: bytes),
                  let data = try? JSONSerialization.data(withJSONObject: ["attention": word, "at": at]) else { continue }
            delivering.withLock { $0 += 1 }
            Task.detached {
                await server.mail(data, to: key, at: address)
                delivering.withLock { $0 -= 1 }
            }
        }
    }

    /// As the app quits: not in use any more, so what's held goes now and your machines send theirs,
    /// waited for a moment so it's out before the relay connection goes.
    func flushBeforeQuit() {
        attend(nil)
        let server = server, delivering = delivering
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            for _ in 0..<30 {
                if delivering.withLock({ $0 == 0 }), await server?.isSending != true { break }
                try? await Task.sleep(for: .milliseconds(50))
            }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 2)
    }

    /// `kuvo/attention`: GET says whether a client is in use here, and how many notices wait; POST
    /// `{for, sessions?, shown?}`, a phone in use for `for` seconds (0: not any more) with those on
    /// its screen and those shown in its own notifications, answers the lease it got.
    func answerAttention(_ request: LinkRequest, asking: Data?) -> (Int, Data) {
        switch request.method.uppercased() {
        case "GET", "HEAD":
            return (200, Self.json(["inUse": hold.inUse, "held": hold.count]))
        case "POST":
            let given = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any]
            let sessions = given?["sessions"]
            guard let seconds = (given?["for"] as? NSNumber).flatMap({ Self.isBool($0) ? nil : $0.doubleValue }), seconds.isFinite, seconds >= 0,
                  sessions == nil || sessions is [String], let shown = Self.shown(given?["shown"]) else {
                return (400, Self.message("Say for how many seconds you're in use (for: 0 for not), which conversations are on your screen (sessions), and which your notifications showed (shown)."))
            }
            let granted = min(seconds, NoticeHold.longestLease)
            hold.attend("phone:\(asking?.base64URL ?? "")", for: granted, sessions: Array(((sessions as? [String]) ?? []).prefix(50)), shown: shown)
            return (200, Self.json(["for": granted]))
        default:
            return (405, Data("{}".utf8))
        }
    }

    private static func isBool(_ number: NSNumber) -> Bool { CFGetTypeID(number) == CFBooleanGetTypeID() }

    /// A client's `shown` (`[{session, ask?, request?}]`): none when it's left out, nil when it isn't that.
    private static func shown(_ value: Any?) -> [NoticeHold.Shown]? {
        guard let value else { return [] }
        guard let list = value as? [Any] else { return nil }
        var shown: [NoticeHold.Shown] = []
        for item in list {
            guard let entry = item as? [String: Any], let session = entry["session"] as? String else { return nil }
            let ask = entry["ask"], request = entry["request"]
            guard ask == nil || (ask as? NSNumber).map(isBool) == true, request == nil || request is String else { return nil }
            shown.append(NoticeHold.Shown(session: session, ask: (ask as? Bool) ?? false, request: request as? String))
        }
        return Array(shown.prefix(50))
    }

    /// `notice` to each paired phone, through the relay: false when it can't go now (no relay
    /// connection), for `hold` to try again.
    func deliver(_ notice: Notice) -> Bool {
        guard Self.isEnabled, let data = try? notice.encoded() else { return true }
        let phones = phones.compactMap { phone -> (key: Data, address: LinkAddress)? in
            guard let key = Data(base64URL: phone.key), let address = phone.address.flatMap(LinkAddress.init(text:)) else { return nil }
            return (key, address)
        }
        guard !phones.isEmpty else { return true }
        guard let server, status == .connected else { return false }
        let delivering = delivering
        delivering.withLock { $0 += 1 }
        Task.detached {
            await server.push(data, to: phones)
            delivering.withLock { $0 -= 1 }
        }
        return true
    }

    /// Where the outside agents' bridge is reached over the link.
    nonisolated static let agentsPrefix = "kuvo/agents/"

    /// A message the phone sends (`POST api/session/<id>/prompt`) says who the agents it names
    /// with "&" are, as one written here does (`AgentReferences`), before `forward` takes it on.
    /// Told by the path as it's sent (`EngineRoutes.canonical`), however the phone wrote it.
    nonisolated private static func namingAgents(in request: LinkRequest, by link: PhoneLink?,
                                                 forward: @escaping @Sendable (LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error>) -> AsyncThrowingStream<LinkResponsePart, Error> {
        let parts = (EngineRoutes.canonical(request.path) ?? "").split(separator: "?").first?.split(separator: "/") ?? []
        guard request.method.uppercased() == "POST", parts.count == 4, parts[0] == "api", parts[1] == "session", parts[3] == "prompt",
              let session = String(parts[2]).removingPercentEncoding else { return forward(request) }
        return AsyncThrowingStream { continuation in
            let task = Task { @MainActor in
                var named = request
                if var body = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any], let text = body["text"] as? String {
                    let directory = link?.workspace?.session(session)?.location.directory
                    // Who it names with "&", then that it's from the phone (see `FromPhone`).
                    let naming = text.contains(AgentReferences.trigger) ? AgentReferences.naming(in: text, excluding: session, here: directory.flatMap(RemoteFolder.machine(of:))) : text
                    body["text"] = FromPhone.adding(to: naming)
                    if let data = try? JSONSerialization.data(withJSONObject: body) { named.body = data }
                }
                do {
                    for try await part in forward(named) { continuation.yield(part) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// The areas that have moved onto this Mac's box (`BoxProcess`), by their routes: a phone's
    /// requests and the app's own (`BoxClient`) go there.
    nonisolated static let boxRoutes = ["kuvo/projects", "kuvo/worktrees"]
    /// Where this Mac's box is reached while it runs.
    nonisolated static let box = OSAllocatedUnfairLock<ServerEndpoint?>(initialState: nil)

    nonisolated private static func boxUnavailable() -> AsyncThrowingStream<LinkResponsePart, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.head(status: 503, headers: ["content-type": "application/json"]))
            continuation.yield(.body(Self.message("This Mac’s box isn’t running. Try again in a moment.")))
            continuation.finish()
        }
    }

    nonisolated private static func unavailable() -> AsyncThrowingStream<LinkResponsePart, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.head(status: 503, headers: ["content-type": "application/json"]))
            continuation.yield(.body(Data(#"{"message":"The coding agents aren't running on this Mac."}"#.utf8)))
            continuation.finish()
        }
    }

    /// What this Mac answers, one name per route or group of routes a client might check
    /// (PROTOCOL.md, "Features"): what a machine's bridge has too (its `FEATURES`, but
    /// `engine.start` and `update`), and the Mac's own. `usage` is added while the usage panel is.
    static let features = [
        "accounts.credentials", "agents", "asks", "attention", "bots", "bots.edit", "bots.keys", "bots.make", "config", "engine.restart",
        "file", "groups", "groups.delete", "groups.edit", "groups.make", "integrations", "keys", "mcp.catalog",
        "named", "personalities", "phones", "phones.pair", "projects", "sessions.agents", "shell.stop", "sign-in.return", "skills",
        "wakes", "wakes.edit", "worktrees", "worktrees.events",
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
            /// When the engine running now came up, in seconds since 1970: a restart changes it.
            var started: Double?
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
        if ["kuvo/bots", "kuvo/groups", "kuvo/named", "kuvo/asks", "kuvo/wakes", "kuvo/mcp/catalog"].contains(request.path), !["GET", "HEAD"].contains(request.method.uppercased()) {
            return (405, Data("{}".utf8))
        }
        switch request.path {
        case "kuvo/info":
            var info = Info(name: Self.computerName, app: AppInfo.version, engine: OpenCodeEngine.version, chats: Workspace.chatsFolder,
                            features: (Self.features + (usageJSON() == nil ? [] : ["usage"])).sorted())
            info.agents = agents?.api != nil
            info.started = engineStarted()?.timeIntervalSince1970
            return (200, (try? encoder.encode(info)) ?? Data())
        case "kuvo/bots":
            return (200, (try? encoder.encode(["bots": (bots?.list ?? []).map(entry)])) ?? Data())
        case "kuvo/bots/templates":
            return (200, templatesJSON())
        case "kuvo/named":
            // Who "&" can name in a message: every bot, and the recent sessions with a name.
            struct Named: Encodable {
                struct Entry: Encodable { var session: String, name: String, kind: String, machine: String?, project: String?, about: String? }
                var agents: [Entry]
            }
            let entries = AgentReferences.candidates(excluding: nil).map {
                Named.Entry(session: $0.session, name: $0.name, kind: $0.kind, machine: $0.machine, project: $0.project, about: $0.about)
            }
            return (200, (try? encoder.encode(Named(agents: entries))) ?? Data())
        case "kuvo/hosts":
            let hosts = machineHosts.sorted { $0.value.name < $1.value.name }.map { id, host in
                Hosts.Host(name: host.name, address: host.address, key: host.key, relay: relay.absoluteString, machine: id, anotherMac: host.anotherMac ?? false,
                           removed: bots?.app?.machines.engine(id) == nil)
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
        case "kuvo/wakes":
            // Every session's with a wake-up or a watch, for the marks beside it as in the sidebar:
            // its soonest wake-up (seconds since 1970) and whether it watches. Bots' come with `kuvo/bots`.
            struct Listed: Encodable {
                struct Entry: Encodable { var session: String; var next: Double?; var watching: Bool }
                var sessions: [Entry]
            }
            let wakes = wakeUps?.wakes ?? [:]
            let watches = wakeUps?.watches ?? [:]
            let keys = Set(wakes.filter { !$0.value.isEmpty }.keys).union(watches.filter { !$0.value.isEmpty }.keys).filter { bots?.bot($0) == nil }
            let entries = keys.sorted().map { key in
                Listed.Entry(session: key, next: wakes[key]?.map(\.due).min()?.timeIntervalSince1970, watching: watches[key]?.isEmpty == false)
            }
            return (200, (try? JSONEncoder().encode(Listed(sessions: entries))) ?? Data())
        case "kuvo/groups":
            return (200, groupsJSON())
        case "kuvo/accounts/ended":
            return (200, (try? JSONEncoder().encode(["providers": endedSignIns()])) ?? Data())
        case let path where path.hasPrefix("kuvo/accounts/") && path.hasSuffix("/forget") && request.method.uppercased() == "POST":
            // Disconnect, as Settings › Accounts does it: its sign-ins and keys here, and the copies on your machines.
            // Any name a plan has (one you added before their names became plain letters keeps the
            // name it was given): `forgetSignIn` signs out only your plans.
            let provider = String(path.dropFirst("kuvo/accounts/".count).dropLast("/forget".count)).removingPercentEncoding ?? ""
            guard !provider.isEmpty, !provider.contains("/") else { return (404, Data()) }
            return forgetSignIn(provider) ? (200, Data("{}".utf8)) : (404, Data())
        case "kuvo/usage":
            guard let usage = usageJSON() else { return (404, Data()) }
            return (200, usage)
        case "kuvo/usage/refresh" where request.method.uppercased() == "POST":
            #if DEBUG
            if Self.usageSample { return (200, Data("{}".utf8)) }
            #endif
            return UsageMenuBar.shared.refreshAll() ? (200, Data("{}".utf8)) : (404, Data())
        case let path where path.hasPrefix("kuvo/asks/") && request.method.uppercased() == "POST":
            return answerAsk(String(path.dropFirst("kuvo/asks/".count)), with: request.body)
        case let path where path.hasPrefix("kuvo/asks/"):
            return (405, Data("{}".utf8))
        case "kuvo/config":
            return answerConfig(request)
        case "kuvo/mac":
            return answerMac(request)
        case "kuvo/mcp/catalog":
            return catalogJSON()
        case "kuvo/personalities":
            return answerPersonalities(nil, request)
        case let path where path.hasPrefix("kuvo/personalities/"):
            return answerPersonalities(String(path.dropFirst("kuvo/personalities/".count)).removingPercentEncoding ?? "", request)
        case "kuvo/keys":
            guard request.method.uppercased() == "GET" else { return (405, Data()) }
            return (200, (try? JSONSerialization.data(withJSONObject: ["keys": IntegrationKeys.shared])) ?? Data("{}".utf8))
        case let path where path.hasPrefix("kuvo/keys/"):
            return answerKey(String(path.dropFirst("kuvo/keys/".count)).removingPercentEncoding ?? "", request)
        case let path where path.hasPrefix("kuvo/mcp/catalog/") && request.method.uppercased() == "POST":
            return addFromCatalog(String(path.dropFirst("kuvo/mcp/catalog/".count)))
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

    // MARK: Personalities

    /// `kuvo/personalities`: the personalities you made, this Mac's copy of the library (each
    /// computer keeps one, and they meet as this Mac connects to a machine). GET lists them;
    /// POST `{name, description}` makes one; PATCH `kuvo/personalities/<id>` changes its name or
    /// description, and DELETE removes it. As a machine's bridge answers them.
    private func answerPersonalities(_ id: String?, _ request: LinkRequest) -> (Int, Data) {
        struct Listed: Encodable { var personalities: [Personality] }
        let store = Personalities.shared
        let body = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
        let encoded = { (value: any Encodable) in (try? JSONEncoder().encode(value)) ?? Data("{}".utf8) }
        let plain = { (key: String) in (body[key] as? String).map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") } }
        let incomplete = Self.message("A personality needs a name and a description.")
        switch (request.method.uppercased(), id) {
        case ("GET", nil):
            return (200, encoded(Listed(personalities: store.custom)))
        case ("POST", nil):
            guard let name = plain("name"), !name.isEmpty, let description = (body["description"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !description.isEmpty else { return (400, incomplete) }
            do {
                return (200, encoded(try store.add(name: String(name.prefix(80)), description: String(description.prefix(2000)))))
            } catch {
                return (400, Self.message(error.localizedDescription))
            }
        case ("PATCH", let id?):
            guard var personality = store.custom.first(where: { $0.id == id }) else { return (404, Data()) }
            if let name = plain("name") { personality.name = String(name.prefix(80)) }
            if let description = (body["description"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) { personality.description = String(description.prefix(2000)) }
            guard !personality.name.isEmpty, !personality.description.isEmpty else { return (400, incomplete) }
            do { try store.update(personality) } catch { return (400, Self.message(error.localizedDescription)) }
            let bots = bots
            Task { await bots?.personalityChanged(id) }
            return (200, encoded(store.personality(id) ?? personality))
        case ("DELETE", let id?):
            guard let personality = store.custom.first(where: { $0.id == id }) else { return (404, Data()) }
            store.delete(personality)
            let bots = bots
            Task { await bots?.personalityChanged(id) }
            return (200, Data("{}".utf8))
        default:
            return (405, Data())
        }
    }

    // MARK: Settings

    /// `kuvo/keys/<name>`: one of this Mac's integrations' keys (`KUVO_KEY_…`, not a bot's own),
    /// in your Keychain: GET its value, PUT `{"value": …}` to set it, DELETE to remove it. The
    /// engine reads it as it next reads its settings.
    private func answerKey(_ name: String, _ request: LinkRequest) -> (Int, Data) {
        guard name.range(of: #"\AKUVO_KEY_[A-Za-z0-9_]+\z"#, options: .regularExpression) != nil, !IntegrationKeys.isBots(name) else {
            return (400, Self.message("That isn't a key's name."))
        }
        switch request.method.uppercased() {
        case "GET":
            guard let value = IntegrationKeys.value(name) else { return (404, Data()) }
            return (200, (try? JSONSerialization.data(withJSONObject: ["value": value])) ?? Data())
        case "PUT":
            guard let value = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any])?["value"] as? String, !value.isEmpty else {
                return (400, Self.message("Send {\"value\": \"…\"}."))
            }
            return IntegrationKeys.set(value, for: name) ? (200, Data("{}".utf8)) : (500, Self.message("It couldn't be saved in the Keychain."))
        case "DELETE":
            return IntegrationKeys.set(nil, for: name) ? (200, Data("{}".utf8)) : (500, Self.message("It couldn't be removed from the Keychain."))
        default:
            return (405, Data())
        }
    }

    /// `kuvo/config`: this Mac's engine settings, as Settings shows them, its own (each machine
    /// has its own, from its bridge). PATCH changes some, as Settings does, with
    /// `{"changes": [{"path": [keys…], "value": …}]}` (null removes it), and answers with them all.
    /// A change can say what it read there (`"was"`, null for nothing): changed since, nothing is
    /// changed and it answers 409. A path goes through objects only; a list is sent whole.
    private func answerConfig(_ request: LinkRequest) -> (Int, Data) {
        guard let config = engineConfig else { return (503, Data()) }
        // As the file is now, edited elsewhere or not.
        config.reload()
        if let problem = config.problem { return (409, Self.message("The engine's settings file can't be changed from here: \(problem)")) }
        switch request.method.uppercased() {
        case "GET":
            break
        case "PATCH":
            struct Change: Decodable {
                var path: [String]
                var value: JSONValue
                /// Absent: not checked; `.null`: nothing was there.
                var was: JSONValue?

                enum CodingKeys: String, CodingKey { case path, value, was }
                init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    path = try container.decode([String].self, forKey: .path)
                    value = try container.decode(JSONValue.self, forKey: .value)
                    was = container.contains(.was) ? try container.decode(JSONValue.self, forKey: .was) : nil
                }
            }
            struct Given: Decodable { var changes: [Change] }
            guard let changes = (try? JSONDecoder().decode(Given.self, from: request.body))?.changes, (1...100).contains(changes.count),
                  changes.allSatisfy({ (1...16).contains($0.path.count) && $0.path.allSatisfy { !$0.isEmpty && $0.count <= 200 } })
            else { return (400, Self.message("Send {\"changes\": [{\"path\": [keys…], \"value\": …}]}.")) }
            // Keys go through objects only: one through a list or a plain value would replace it
            // whole (every permission rule, for "permissions", "0"). A list is sent whole.
            if changes.contains(where: { change in (1..<change.path.count).contains { config.value(at: Array(change.path[..<$0])).map { $0.object == nil } ?? false } }) {
                return (400, Self.message("A path goes through objects only; send a list whole, at its own path."))
            }
            if changes.contains(where: { change in change.was.map { (config.value(at: change.path) ?? .null) != $0 } ?? false }) {
                return (409, Self.message("It changed since you read it."))
            }
            // A phone's, not one to offer other computers here: the phone offers its own. A key
            // named where another computer keeps its keys is named where this Mac keeps them.
            config.set(changes.map { (path: $0.path, value: $0.value == .null ? nil : AlsoApply.keysNamed($0.value, on: nil)) }, noted: false)
            if let problem = config.problem { return (500, Self.message(problem)) }
        default:
            return (405, Data())
        }
        return (200, Self.settingsJSON(config.settings))
    }

    private static func settingsJSON(_ settings: [String: JSONValue]) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(settings)) ?? Data("{}".utf8)
    }

    nonisolated static func message(_ text: String) -> Data {
        (try? JSONEncoder().encode(["message": text])) ?? Data()
    }

    /// A route's answer, its keys sorted.
    nonisolated static func json(_ value: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    // MARK: Files

    /// The biggest file `kuvo/file` sends.
    nonisolated static let fileLimit = 25 * 1024 * 1024

    /// `kuvo/file?uri=<file:// URI>`: a file on this Mac, as an agent's reply or tool names it: its
    /// bytes with its type; 404 with a `message` for one that isn't there (or isn't a file), 413
    /// over `fileLimit`.
    nonisolated static func file(_ path: String) -> AsyncThrowingStream<LinkResponsePart, Error> {
        AsyncThrowingStream { continuation in
            let task = Task.detached {
                let (status, type, body) = readFile(path)
                continuation.yield(.head(status: status, headers: ["content-type": type]))
                // In pieces, as the engine's bodies go.
                var start = body.startIndex
                while start < body.endIndex, !Task.isCancelled {
                    let end = body.index(start, offsetBy: 32 * 1024, limitedBy: body.endIndex) ?? body.endIndex
                    continuation.yield(.body(body.subdata(in: start..<end)))
                    start = end
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    nonisolated static func readFile(_ path: String) -> (status: Int, type: String, body: Data) {
        let json = "application/json"
        guard let uri = URLComponents(string: path)?.queryItems?.first(where: { $0.name == "uri" })?.value,
              let url = URL(string: uri), url.isFileURL else {
            return (400, json, message("That isn’t a file:// address."))
        }
        let file = url.resolvingSymlinksInPath()
        let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values?.isRegularFile == true else { return (404, json, message("That file isn’t there anymore.")) }
        guard (values?.fileSize ?? 0) <= fileLimit else { return (413, json, message("That file is too big to open here.")) }
        guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else { return (404, json, message("That file isn’t there anymore.")) }
        return (200, UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream", data)
    }

    /// `kuvo/mcp/catalog`: Settings › MCP Servers' popular servers, each with whether it's added
    /// (`integration` too when Integrations added it, and keeps it there), and `macOnly` for one
    /// that runs on this Mac alone (its Chrome), which never reaches your machines.
    private func catalogJSON() -> (Int, Data) {
        guard let config = engineConfig else { return (503, Data()) }
        struct Listed: Encodable {
            struct Entry: Encodable {
                var id: String, title: String, summary: String, access: String
                var added: Bool, integration: Bool, macOnly: Bool
            }
            var servers: [Entry]
        }
        config.reload()
        let entries = MCPCatalog.servers.map { server in
            let added = config.value(at: MCPSettings.path + [server.id]) != nil
            let access = switch server.access {
            case .signIn: "signIn"
            case .open: "open"
            case .local: "local"
            }
            return Listed.Entry(id: server.id, title: server.title, summary: server.summary, access: access, added: added,
                                integration: added && Integrations.service(server.id) != nil, macOnly: MCPCatalog.macOnly.contains(server.id))
        }
        return (200, (try? JSONEncoder().encode(Listed(servers: entries))) ?? Data())
    }

    /// `POST kuvo/mcp/catalog/<id>`: adds one of them, as its Add button does, and answers with
    /// the settings (as `kuvo/config`). One already added stays as it is.
    private func addFromCatalog(_ id: String) -> (Int, Data) {
        guard let config = engineConfig else { return (503, Data()) }
        guard let server = MCPCatalog.servers.first(where: { $0.id == id }) else { return (404, Data()) }
        config.reload()
        if let problem = config.problem { return (409, Self.message("The engine's settings file can't be changed from here: \(problem)")) }
        if config.value(at: MCPSettings.path + [server.id]) == nil { MCPCatalog.add(server, to: config) }
        if let problem = config.problem { return (500, Self.message(problem)) }
        return (200, Self.settingsJSON(config.settings))
    }

    /// `POST kuvo/sign-in/return` with `{"url"}`: where a sign-in's page sent the browser back
    /// to this Mac (an MCP server's, or a plan's that finishes here), which a phone can't load,
    /// loaded here, as the browser would have. Only this Mac's own address
    /// (`EngineRoutes.signInReturn`), and no further than it answers (a redirect isn't followed).
    /// Answers with the status it got (`{"status"}`): 2xx or 3xx, it took it.
    nonisolated private static func loadSignInReturn(_ body: Data) async -> (Int, Data) {
        struct Given: Decodable { var url: String }
        guard let given = try? JSONDecoder().decode(Given.self, from: body), let url = EngineRoutes.signInReturn(given.url) else {
            return (400, message("That isn't an address a sign-in returns to on this computer."))
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        guard let (_, response) = try? await URLSession.shared.data(for: request, delegate: StaysThere()),
              let status = (response as? HTTPURLResponse)?.statusCode else {
            return (502, message("Nothing on this computer took it. Start the sign-in again."))
        }
        return (200, (try? JSONEncoder().encode(["status": status])) ?? Data())
    }

    // MARK: Accounts

    /// `kuvo/accounts/credentials`: each sign-in this Mac's engine keeps, by its ID, with the plan
    /// it's for, its name and whether it's the one in use: the list alone (the engine's
    /// `api/credential` has what each is signed in with too).
    private func credentialsJSON() async -> (Int, Data) {
        guard let api = workspace?.api else { return (503, Data()) }
        guard let credentials = try? await api.credentials() else { return (502, Data()) }
        struct Listed: Encodable { var id: String; var integrationID: String; var label: String; var active: Bool }
        let listed = credentials.map { Listed(id: $0.id, integrationID: $0.integrationID, label: $0.label, active: $0.active) }
        return (200, (try? JSONEncoder().encode(["credentials": listed])) ?? Data())
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
                var session: String?
                var asker: String?
                var username: Bool?
                var password: Bool?
                var saved: [String]?
                /// Whether what's typed is kept in Passwords unless you say otherwise.
                var offersToSave: Bool?
                var prompt: String?
                var instruction: String?
            }
            var asks: [Ask]
        }
        let asks = (browserAsks?.asks ?? []).map { ask in
            var listed = Listed.Ask(id: ask.id, kind: "", host: ask.host, machine: ask.machine.map { machineName($0) ?? $0 }, session: ask.session, asker: ask.asker)
            switch ask.kind {
            case .signIn(let username, let password):
                listed.kind = "signIn"
                listed.username = username
                listed.password = password
                let saved = Passwords.logins(for: ask.host).map(\.account)
                listed.saved = saved
                listed.offersToSave = saved.isEmpty && Passwords.offersToSave && !Passwords.neverSites.contains(ask.host)
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

    /// A phone's answer, as the card's: a sign-in typed there (kept in Passwords if asked) or one
    /// of the site's saved ones, which this Mac fills in itself; a code; done; or no.
    private func answerAsk(_ id: String, with body: Data) -> (Int, Data) {
        struct Given: Decodable {
            var answer: String
            var username: String?
            var password: String?
            /// An account Passwords keeps for the site: its password, from here.
            var saved: String?
            var save: Bool?
            var code: String?
        }
        guard let asks = browserAsks, let ask = asks.asks.first(where: { $0.id == id }) else { return (404, Data()) }
        guard let given = try? JSONDecoder().decode(Given.self, from: body) else { return (400, Data()) }
        switch (given.answer, ask.kind) {
        case ("signIn", .signIn):
            if let account = given.saved {
                guard let login = Passwords.logins(for: ask.host).first(where: { $0.account == account }),
                      let password = Passwords.password(for: login) else { return (404, Data()) }
                asks.answer(id, .signIn(username: account.isEmpty ? nil : account, password: password))
            } else {
                let username = given.username.flatMap { $0.isEmpty ? nil : $0 }
                let password = given.password.flatMap { $0.isEmpty ? nil : $0 }
                guard username != nil || password != nil else { return (400, Data()) }
                if given.save == true, let password { _ = Passwords.save(host: ask.host, account: username ?? "", password: password) }
                asks.answer(id, .signIn(username: username, password: password))
            }
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
        return UsageMenuBar.shared.phoneUsage()
    }

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

    // MARK: Group chats

    /// A chat's bots as a phone draws them: their face and name, and where each lives.
    private struct GroupMember: Encodable {
        var id: String
        var name: String
        var look: BotLook
        var session: String
        var directory: String
        /// Its own conversation is with the coding agents.
        var agents: Bool
    }

    private func members(of group: BotGroup) -> [GroupMember] {
        group.members.compactMap { bots?.bot($0) }.map { GroupMember(id: $0.id, name: $0.name, look: $0.look, session: $0.sessionID, directory: $0.directory, agents: $0.agents == true) }
    }

    private static var groupEncoder: JSONEncoder {
        let encoder = JSONEncoder()
        // Sorted, as a stream sends what it's encoded only when the text differs, and JSONEncoder
        // writes a struct's keys in another order almost every time.
        encoder.outputFormatting = .sortedKeys
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }

    /// Your group chats as the sidebar lists them: who's in each, who's talking, whether it
    /// waits on you to keep going, and the last thing said.
    private func groupsJSON() -> Data {
        struct Listed: Encodable { var groups: [GroupEntry] }
        guard let groups else { return Data(#"{"groups":[]}"#.utf8) }
        return (try? Self.groupEncoder.encode(Listed(groups: groups.list.map { entry($0, in: groups) }))) ?? Data()
    }

    /// A chat as `kuvo/groups` lists it.
    private struct GroupEntry: Encodable {
        var id: String
        var name: String
        var purpose: String?
        var members: [GroupMember]
        var speaking: String?
        var discussing: Bool
        var paused: Bool
        var unread: Bool
        var last: GroupMessage?
        var meeting: BotGroup.Meeting?
        /// The machine it lives on (its bots' too), by id as bots name theirs; none for this Mac.
        var machine: String?
        /// On its way to another computer: what would change it waits until it's there.
        var moving: Bool
    }

    private func entry(_ group: BotGroup, in groups: GroupChats) -> GroupEntry {
        var last = groups.messages(in: group.id).last { $0.kind != .note }
        last?.steps = nil
        return GroupEntry(id: group.id, name: group.name, purpose: group.purpose, members: members(of: group),
                          speaking: groups.speaking[group.id], discussing: groups.discussing.contains(group.id),
                          paused: groups.paused.contains(group.id), unread: groups.isUnread(group), last: last, meeting: group.meeting,
                          machine: groups.machine(of: group.id), moving: isMoving(group.id))
    }

    /// One chat as it reads now: its latest messages (with what each bot did on its turn), who's
    /// talking, and whether it's under way or paused. Nil once the chat's gone.
    private func groupJSON(_ id: String) -> Data? {
        groupLines(id)?.whole
    }

    /// One chat's line, whole and without its messages (`state`), for `followingGroup`.
    struct GroupLines: Equatable {
        var messages: Data
        var state: Data
        /// `state` with its `messages` first.
        var whole: Data { Data(#"{"messages":"#.utf8) + messages + Data(",".utf8) + state.dropFirst() }
    }

    private func groupLines(_ id: String) -> GroupLines? {
        struct Chat: Encodable {
            var speaking: String?
            var discussing: Bool
            var paused: Bool
            var moving: Bool
            /// What the bot talking is doing, its last step (see `GroupActivity`).
            var activity: [GroupActivity]?
        }
        guard let groups, groups.group(id) != nil else { return nil }
        let chat = Chat(speaking: groups.speaking[id], discussing: groups.discussing.contains(id), paused: groups.paused.contains(id),
                        moving: isMoving(id), activity: groups.activity[id])
        guard let messages = try? Self.groupEncoder.encode(Array(groups.messages(in: id).suffix(300))),
              let state = try? Self.groupEncoder.encode(chat) else { return nil }
        return GroupLines(messages: messages, state: state)
    }

    // MARK: Making bots and group chats

    /// A bot as `kuvo/bots` lists it: by its session (here or on a machine), with its name, look
    /// and job, and what the Mac knows of it that its session doesn't say: paused, when it next
    /// wakes (in seconds since 1970), how many things it watches, and the personality and model
    /// Edit Bot shows for it.
    struct BotEntry: Encodable {
        var id: String, session: String, name: String, look: BotLook, machine: String?, job: String
        var paused: Bool, wakes: Double?, watching: Int
        /// Its conversation is with the coding agents: read through `kuvo/agents/api/…`.
        var agents: Bool
        /// Left out for none: the model's own way, or a bot made before bots had a model.
        var personality: String?, model: ModelRef?
    }

    private func entry(_ bot: Bot) -> BotEntry {
        BotEntry(id: bot.id, session: bot.sessionID, name: bot.name, look: bot.look, machine: bot.machine, job: bot.job,
                 paused: bots?.paused.contains(bot.id) == true,
                 wakes: bots?.wakes[bot.id]?.map(\.due).min()?.timeIntervalSince1970,
                 watching: bots?.watches[bot.id]?.count ?? 0,
                 agents: bot.agents == true,
                 personality: bot.personality, model: bot.model)
    }

    /// `kuvo/bots/templates`: what New Bot offers: its templates, the personalities (yours too),
    /// the looks, the model it starts with in each place (this Mac, `mac`, and each machine by
    /// id), and your projects, by where they are.
    private func templatesJSON() -> Data {
        struct Template: Encodable {
            var id: String, name: String, job: String, instructions: String, look: BotLook, personality: String?, wantsProject: Bool
        }
        struct Listed: Encodable {
            struct Personality: Encodable { var id: String, name: String, description: String, custom: Bool }
            struct Looks: Encodable { var colors: [String], shapes: [String], faces: [String] }
            struct Project: Encodable { var directory: String, name: String, machine: String? }
            var templates: [Template]
            var personalities: [Personality]
            var looks: Looks
            var startingModel: [String: ModelRef?]
            var projects: [Project]
        }
        let app = bots?.app
        var starting: [String: ModelRef?] = ["mac": app?.catalog.startingModel(LastModel.current, scope: .on(machine: nil))]
        for machine in app?.machines.list ?? [] {
            starting[machine.id] = app?.machines.engine(machine.id)?.catalog.startingModel(LastModel.current, scope: .on(machine: machine.id)) ?? nil
        }
        let listed = Listed(
            templates: BotTemplate.all.map { Template(id: $0.id, name: $0.name, job: $0.job, instructions: $0.instructions, look: $0.look, personality: $0.personality, wantsProject: $0.wantsProject) },
            personalities: Personalities.shared.all.map { .init(id: $0.id, name: $0.name, description: $0.description, custom: $0.isCustom) },
            looks: .init(colors: BotLook.Tint.allCases.map(\.rawValue), shapes: BotLook.Form.allCases.map(\.rawValue), faces: BotLook.Face.allCases.map(\.rawValue)),
            startingModel: starting,
            projects: (workspace?.projects ?? []).map { .init(directory: $0.directory, name: $0.name, machine: RemoteFolder.machine(of: $0.directory)) })
        return (try? JSONEncoder().encode(listed)) ?? Data()
    }

    /// `POST kuvo/bots`: a bot made as New Bot makes it, `{name, look?, personality?, model?,
    /// machine?, project?, template?}`. A project on a machine makes it there. From a template it
    /// waits for you, with the template's job as `firstMessage` for your composer; otherwise it
    /// writes first. Answers 201 `{bot, firstMessage}`; 400 for what's missing or unknown, 409
    /// while its machine isn't connected, 422 for a model that can't run there, 503 when it
    /// couldn't be made.
    func makeBot(_ body: Data) async -> (Int, Data) {
        struct Given: Decodable {
            var name: String?, look: BotLook?, personality: String?, model: ModelRef?, machine: String?, project: String?, template: String?
        }
        guard let bots, let app = bots.app else { return (503, Self.message("Bots aren’t ready yet. Try again in a moment.")) }
        guard let given = try? JSONDecoder().decode(Given.self, from: body) else { return (400, Self.message("That isn’t a bot to make.")) }
        let name = Bots.oneLine(given.name ?? "")
        guard !name.isEmpty else { return (400, Self.message("A bot needs a name.")) }
        var template: BotTemplate?
        if let id = given.template {
            guard let found = BotTemplate.all.first(where: { $0.id == id }) else { return (400, Self.message("There’s no template “\(id)”.")) }
            template = found
        }
        let personality = given.personality ?? template?.personality
        if let personality, Personalities.shared.personality(personality) == nil { return (400, Self.message("There’s no personality “\(personality)”.")) }
        // Where it lives: its project's computer, or the one picked.
        var machine = given.machine
        if let project = given.project {
            guard let found = workspace?.projects.first(where: { $0.directory == project }) else { return (400, Self.message("That project isn’t in Kuvo Code.")) }
            machine = RemoteFolder.machine(of: found.directory)
        }
        let place = machine.map { id in app.machines.list.first { $0.id == id }?.name ?? id }
        if let machine {
            guard app.machines.list.contains(where: { $0.id == machine }) else { return (400, Self.message("There’s no machine “\(machine)”.")) }
            guard app.machines.engine(machine)?.isReady == true else { return (409, Self.message("\(place ?? machine) isn’t connected. Connect to it, then try again.")) }
        } else if app.workspace.api == nil {
            return (503, Self.message("The engine isn’t running."))
        }
        if let model = given.model, let refusal = Self.refusal(of: model, on: machine, called: place, app: app) { return (422, Self.message(refusal)) }
        do {
            let bot = try await bots.create(name: name, look: given.look ?? template?.look ?? .random(), personality: personality, model: given.model, machine: machine, project: given.project)
            let first = template.map { BotTemplate.firstMessage(job: $0.job, instructions: $0.instructions) }
            if first == nil { Task { await bots.greet(bot) } }
            struct Made: Encodable {
                var bot: BotEntry
                var firstMessage: String?
                func encode(to encoder: Encoder) throws {
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode(bot, forKey: .bot)
                    try container.encode(firstMessage, forKey: .firstMessage)
                }
                enum CodingKeys: String, CodingKey { case bot, firstMessage }
            }
            return (201, (try? JSONEncoder().encode(Made(bot: entry(bot), firstMessage: first))) ?? Data())
        } catch Bots.Failure.notConnected(let machineName) {
            return (409, Self.message("\(machineName) isn’t connected. Connect to it, then try again."))
        } catch {
            return (503, Self.message(error.localizedDescription))
        }
    }

    /// Why a bot living on `machine` (nil for this Mac; `place` is its name) can't use `model`, as
    /// New Bot and Edit Bot offer models there: nil when it can.
    private static func refusal(of model: ModelRef, on machine: String?, called place: String?, app: AppModel) -> String? {
        guard ModelScope.on(machine: machine).allows(model.providerID) else { return "That model can’t run on \(place ?? "this Mac"): choose another." }
        let catalog = machine.flatMap { app.machines.engine($0)?.catalog } ?? app.catalog
        return catalog.needsSignIn(model) ? catalog.unavailable(model, on: place) : nil
    }

    /// `PATCH kuvo/bots/<id>`: its name, look, personality or model changed, as Edit Bot changes
    /// them, wherever it lives: `{name?, look?, personality?, model?}` (`personality: null` for the
    /// model's own way). A machine's bot is told once its machine is connected, as from Edit Bot.
    /// Answers 200 `{bot}`, as `kuvo/bots` lists it; 400 for an empty name, or a look or
    /// personality there isn't; 422 for a model it can't use where it lives (the one it has is
    /// kept, whatever); 404 for no such bot, 409 while it moves.
    func changeBot(_ id: String, with body: Data) async -> (Int, Data) {
        guard let bots, let app = bots.app else { return (503, Self.message("Bots aren’t ready yet. Try again in a moment.")) }
        guard var bot = bots.bot(id) else { return (404, Self.message("That bot isn’t there any more.")) }
        if isMoving(id) { return (409, Self.message(Moves.Failure.moving.localizedDescription)) }
        guard let fields = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return (400, Self.message("That isn’t a change to a bot.")) }
        /// A field as its type, from the JSON it came in.
        func decoded<Value: Decodable>(_ key: String, as type: Value.Type) -> Value? {
            guard let value = fields[key], let data = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed) else { return nil }
            return try? JSONDecoder().decode(type, from: data)
        }
        if fields["name"] != nil {
            let name = Bots.oneLine(fields["name"] as? String ?? "")
            guard !name.isEmpty else { return (400, Self.message("A bot needs a name.")) }
            bot.name = name
        }
        if fields["look"] != nil {
            guard let look = decoded("look", as: BotLook.self) else { return (400, Self.message("That isn’t a look a bot can have.")) }
            bot.look = look
        }
        if let given = fields["personality"] {
            if given is NSNull {
                bot.personality = nil
            } else {
                guard let personality = given as? String, Personalities.shared.personality(personality) != nil else {
                    return (400, Self.message("There’s no personality “\(given as? String ?? "")”."))
                }
                bot.personality = personality
            }
        }
        if fields["model"] != nil {
            guard let model = decoded("model", as: ModelRef.self) else { return (400, Self.message("That isn’t a model.")) }
            let place = bot.machine.map { machine in app.machines.list.first { $0.id == machine }?.name ?? machine }
            if model != bot.model, let refusal = Self.refusal(of: model, on: bot.machine, called: place, app: app) { return (422, Self.message(refusal)) }
            bot.model = model
        }
        await bots.update(bot)
        guard let changed = bots.bot(id) else { return (404, Self.message("That bot isn’t there any more.")) }
        return (200, (try? JSONEncoder().encode(["bot": entry(changed)])) ?? Data())
    }

    /// `POST kuvo/sessions/<id>/agents` with `{model}`: a conversation on the engine (here or on a
    /// machine) carried on with the coding agents on `model` (one of theirs, or Custom Auto), as
    /// picking it in the conversation does: a session of theirs with all of it, what was waiting
    /// and its draft; the engine's goes to Archived (a bot's takes the new one). Answers 200
    /// `{session}`, the new one; 400 for a model that isn't theirs; 404 for no such conversation;
    /// 409 for one with them already, or while it moves; 422 for a model it can't use where it
    /// is; 503 while the coding agents aren't running there.
    func moveToAgents(_ id: String, with body: Data) async -> (Int, Data) {
        guard let workspace, let app = bots?.app else { return (503, Self.message("Kuvo Code isn’t ready yet. Try again in a moment.")) }
        guard let session = workspace.session(id) else { return (404, Self.message("That conversation isn’t there any more.")) }
        if OutsideAgents.isAgentSession(session) { return (409, Self.message("It’s with the coding agents already.")) }
        if isMoving(id) { return (409, Self.message(Moves.Failure.moving.localizedDescription)) }
        struct Given: Decodable { var model: ModelRef }
        let machine = RemoteFolder.machine(of: session.location.directory)
        guard let model = (try? JSONDecoder().decode(Given.self, from: body))?.model, OutsideAgents.runsWithAgents(model, machine: machine) else {
            return (400, Self.message("That isn’t a coding agent’s model."))
        }
        let place = machine.map { machine in app.machines.list.first { $0.id == machine }?.name ?? machine }
        if let refusal = Self.refusal(of: model, on: machine, called: place, app: app) { return (422, Self.message(refusal)) }
        do {
            guard let moved = try await workspace.moveToAgents(id, model: model, opens: false) else { return (404, Self.message("That conversation isn’t there any more.")) }
            return (200, (try? JSONEncoder().encode(["session": moved.id])) ?? Data())
        } catch let failure as OutsideAgents.Failure {
            return (503, Self.message(failure.localizedDescription))
        } catch let failure as Moves.Failure {
            return (409, Self.message(failure.localizedDescription))
        } catch {
            return (502, Self.message(error.localizedDescription))
        }
    }

    /// `DELETE kuvo/bots/<id>`, as Delete Bot… deletes it: its conversation and wake-ups, and its
    /// folder to the Trash (on a machine, to Kuvo Code's trash there). Answers 200 `{}`; 404 for
    /// no such bot; 409 while it moves, or while the machine it lives on isn't connected.
    func deleteBot(_ id: String) async -> (Int, Data) {
        guard let bots else { return (503, Self.message("Bots aren’t ready yet. Try again in a moment.")) }
        guard let bot = bots.bot(id) else { return (404, Self.message("That bot isn’t there any more.")) }
        if isMoving(id) { return (409, Self.message(Moves.Failure.moving.localizedDescription)) }
        do {
            try await bots.delete(bot)
        } catch let failure as Moves.Failure {
            return (409, Self.message(failure.localizedDescription))
        } catch let failure as Bots.Failure {
            return (409, Self.message(failure.localizedDescription))
        } catch {
            return (503, Self.message(error.localizedDescription))
        }
        return (200, Data("{}".utf8))
    }

    /// The bot in `kuvo/bots/<id>` (not `kuvo/bots/templates`).
    /// `kuvo/sessions/<id>/<then>`'s session.
    nonisolated private static func sessionID(in path: String, then: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count == 4, parts[0] == "kuvo", parts[1] == "sessions", parts[3] == then else { return nil }
        return String(parts[2]).removingPercentEncoding
    }

    /// `kuvo/bots/<id>/keys`, or one integration's.
    nonisolated private static func isBotKeys(_ path: String) -> Bool {
        let parts = (path.split(separator: "?").first ?? "").split(separator: "/", omittingEmptySubsequences: false)
        return (parts.count == 4 || parts.count == 5) && parts[0] == "kuvo" && parts[1] == "bots" && parts[3] == "keys"
    }

    nonisolated private static func botID(in path: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count == 3, parts[0] == "kuvo", parts[1] == "bots", parts[2] != "templates" else { return nil }
        return String(parts[2]).removingPercentEncoding
    }

    /// A meeting as a phone sends it: `{next, every, topic}`, `next` in seconds since 1970 and
    /// `every` as kuvo-wake writes it (`1d`, `weekdays`, `1w`…; null for once).
    struct GivenMeeting: Decodable {
        var next: Double
        var every: String?
        var topic: String?

        /// As Edit Group Chat sets it up (`BotGroup.Meeting.planned`), or why it can't be.
        func planned(before: BotGroup.Meeting?) -> Result<BotGroup.Meeting, PhoneLink.Refusal> {
            var repeats: Wakes.Repeat?
            if let every {
                guard let parsed = Wakes.Repeat(every) else { return .failure(.init("“\(every)” isn’t how often a meeting can come back.")) }
                repeats = parsed
            }
            guard let meeting = BotGroup.Meeting.planned(at: Date(timeIntervalSince1970: next), every: repeats, topic: topic ?? "", before: before) else {
                return .failure(.init("That time has passed. Pick one to come."))
            }
            return .success(meeting)
        }
    }

    struct Refusal: Error {
        var message: String
        init(_ message: String) { self.message = message }
    }

    /// `POST kuvo/groups`: a group chat made as New Group Chat makes it, on this Mac, `{name,
    /// members, purpose?, meeting?}` (members by bot id; a meeting as `GivenMeeting`). Answers 201
    /// `{group}`, as `kuvo/groups` lists it; 400 without a name or two bots, or for a meeting that
    /// can't be, 404 for a bot that isn't there.
    func makeGroup(_ body: Data) async -> (Int, Data) {
        struct Given: Decodable { var name: String?, members: [String]?, purpose: String?, meeting: GivenMeeting? }
        guard let groups, let bots else { return (503, Self.message("Group chats aren’t ready yet. Try again in a moment.")) }
        guard let given = try? JSONDecoder().decode(Given.self, from: body) else { return (400, Self.message("That isn’t a group chat to make.")) }
        let name = Bots.oneLine(given.name ?? "")
        guard !name.isEmpty else { return (400, Self.message("A group chat needs a name.")) }
        var members: [String] = []
        for id in given.members ?? [] where !members.contains(id) { members.append(id) }
        guard members.count >= 2 else { return (400, Self.message("A group chat needs at least two bots.")) }
        if let missing = members.first(where: { bots.bot($0) == nil }) { return (404, Self.message("There’s no bot “\(missing)”.")) }
        var meeting: BotGroup.Meeting?
        if let given = given.meeting {
            switch given.planned(before: nil) {
            case .success(let planned): meeting = planned
            case .failure(let refusal): return (400, Self.message(refusal.message))
            }
        }
        let purpose = given.purpose?.trimmingCharacters(in: .whitespacesAndNewlines)
        let group = groups.create(name: name, purpose: purpose?.isEmpty == false ? purpose : nil, members: members, meeting: meeting)
        return (201, (try? Self.groupEncoder.encode(["group": entry(group, in: groups)])) ?? Data())
    }

    /// `PATCH kuvo/groups/<id>`: its name, purpose, bots or meeting changed, as Edit Group Chat
    /// changes them: `{name?, purpose?, members?, meeting?}`, a meeting as `GivenMeeting` (null
    /// for none, an empty purpose for none). Answers 200 `{group}`, as `kuvo/groups` lists it;
    /// 404 for no such chat, 400 for what can't be, 409 while it moves. A machine's chat is the
    /// machine's to answer: the change goes there as it came, and its answer comes back.
    func changeGroup(_ id: String, with body: Data) async -> (Int, Data) {
        guard let groups else { return (503, Self.message("Group chats aren’t ready yet. Try again in a moment.")) }
        guard !id.contains("/"), var group = groups.group(id) else { return (404, Self.message("That group chat isn’t there any more.")) }
        guard let fields = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return (400, Self.message("That isn’t a change to a group chat.")) }
        // One that lives on a machine: that machine answers it, with its rules (who can join, a
        // meeting on its clock), as it does a phone that asks it.
        if groups.machine(of: id) != nil {
            guard let asked = try? JSONDecoder().decode(JSONValue.self, from: body) else { return (400, Self.message("That isn’t a change to a group chat.")) }
            do {
                try await groups.changeThere(id, asked)
            } catch Moves.Failure.moving {
                return (409, Self.message("That chat is moving. Try again once it’s there."))
            } catch let refused as ServerError where [400, 404, 409].contains(refused.status) {
                return (refused.status, Self.message(refused.message))
            } catch {
                return (503, Self.message(error.localizedDescription))
            }
            guard let changed = groups.group(id) else { return (404, Self.message("That group chat isn’t there any more.")) }
            return (200, (try? Self.groupEncoder.encode(["group": entry(changed, in: groups)])) ?? Data())
        }
        guard let bots else { return (503, Self.message("Group chats aren’t ready yet. Try again in a moment.")) }
        if fields["name"] != nil {
            let name = Bots.oneLine(fields["name"] as? String ?? "")
            guard !name.isEmpty else { return (400, Self.message("A group chat needs a name.")) }
            group.name = name
        }
        if fields["purpose"] != nil {
            let purpose = (fields["purpose"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            group.purpose = purpose.isEmpty ? nil : purpose
        }
        if let given = fields["members"] {
            guard let list = given as? [String] else { return (400, Self.message("Those aren’t bots.")) }
            var members: [String] = []
            for member in list where !members.contains(member) { members.append(member) }
            guard members.count >= 2 else { return (400, Self.message("A group chat needs at least two bots.")) }
            // This Mac's chat can have any bot, as Edit Group Chat allows.
            if let missing = members.first(where: { bots.bot($0) == nil }) { return (404, Self.message("There’s no bot “\(missing)”.")) }
            group.members = members
        }
        if let given = fields["meeting"] {
            if given is NSNull {
                group.meeting = nil
            } else {
                guard let data = try? JSONSerialization.data(withJSONObject: given), let meeting = try? JSONDecoder().decode(GivenMeeting.self, from: data) else {
                    return (400, Self.message("That isn’t a meeting."))
                }
                switch meeting.planned(before: group.meeting) {
                case .success(let planned): group.meeting = planned
                case .failure(let refusal): return (400, Self.message(refusal.message))
                }
            }
        }
        do {
            try await groups.change(group)
        } catch Moves.Failure.moving {
            return (409, Self.message("That chat is moving. Try again once it’s there."))
        } catch {
            return (503, Self.message(error.localizedDescription))
        }
        guard let changed = groups.group(id) else { return (404, Self.message("That group chat isn’t there any more.")) }
        return (200, (try? Self.groupEncoder.encode(["group": entry(changed, in: groups)])) ?? Data())
    }

    /// `DELETE kuvo/groups/<id>`: deleted as Delete Group Chat… deletes it, wherever it lives: its
    /// messages and seats go, and its bots forget it. Answers 200 `{}`, for one gone already too;
    /// 409 while it moves, 503 when its machine can't be reached, each with a message.
    func deleteGroup(_ id: String) async -> (Int, Data) {
        guard let groups else { return (503, Self.message("Group chats aren’t ready yet. Try again in a moment.")) }
        guard !id.isEmpty, !id.contains("/") else { return (400, Self.message("That isn’t a group chat.")) }
        guard let group = groups.group(id) else { return (200, Data("{}".utf8)) }
        do {
            try await groups.deleteNow(group)
        } catch Moves.Failure.moving {
            return (409, Self.message("That chat is moving. Try again once it’s there."))
        } catch {
            return (503, Self.message(error.localizedDescription))
        }
        return (200, Data("{}".utf8))
    }

    /// What a phone does in a chat, as in the window: writes to it (`{"text"}`), stops it, lets it
    /// keep going, looks at it, takes a message of yours back (`{"message"}`, answering with
    /// what was taken, for the phone's composer), or starts the work a wrap-up split up
    /// (`{"message"}`, the wrap-up).
    private func answerGroup(_ path: String, with body: Data) async -> (Int, Data) {
        let parts = path.split(separator: "/").map(String.init)
        guard let groups, let id = parts.first, groups.group(id) != nil else { return (404, Data()) }
        struct Given: Decodable { var text: String?; var message: String? }
        let given = try? JSONDecoder().decode(Given.self, from: body)
        switch parts.dropFirst().first {
        case nil:
            guard let text = given?.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return (400, Data()) }
            // Moving, or its machine away or saying no: the phone keeps it, and says so.
            guard await groups.sendNow(text, to: id) else { return (409, Data(#"{"message":"It can't take messages right now. Try again in a moment."}"#.utf8)) }
        case "stop":
            groups.stop(id)
        case "keep-going":
            groups.keepGoing(id)
        case "viewed":
            groups.markViewed(id)
        case "undo":
            guard let message = given?.message else { return (404, Data()) }
            // Moving, or its machine away: as for what you write.
            guard !isMoving(id), groups.unreachable(id) == nil else { return (409, Data()) }
            guard let taken = await groups.undo(from: message, in: id) else { return (404, Data()) }
            return (200, (try? JSONEncoder().encode(["text": taken])) ?? Data())
        case "start":
            guard let message = given?.message, groups.messages(in: id).contains(where: { $0.id == message && $0.tasks != nil }) else { return (404, Data()) }
            groups.startWork(message, in: id)
        default:
            return (404, Data())
        }
        return (200, Data("{}".utf8))
    }

    /// The chat in `kuvo/groups/<id>/<action>`.
    /// `kuvo/shell/<id>/stop` → the engine's id of the command.
    nonisolated private static func shellID(in path: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count == 4, parts[0] == "kuvo", parts[1] == "shell", parts[3] == "stop" else { return nil }
        return String(parts[2]).removingPercentEncoding
    }

    /// `GET kuvo/wakes/<session>`: its wake-ups, watches and whether they're paused, read now;
    /// `POST kuvo/wakes/<session>` with `{"due", "every"?, "note"}` adds one; `…/cancel` with
    /// `{"wake": "<id>"}` or `{"watch": "<letters>"}` cancels one, `…/now` with `{"wake": "<id>"}`
    /// sends one now (one that repeats still comes back at its time), and `…/pause` with
    /// `{"paused"}` holds them or lets them go, as the bar over the Mac's composer does. Adding and
    /// pausing answer the list as it is then. Times are seconds since 1970.
    /// A wake-up that couldn't go or be taken back: 409 while its conversation is on its way to
    /// another computer (as a machine's bridge says it), else 503.
    nonisolated private static func status(of error: any Error) -> Int {
        if case .moving? = error as? Moves.Failure { return 409 }
        return 503
    }

    private func answerWakes(_ request: LinkRequest) async -> (Int, Data) {
        let parts = request.path.split(separator: "?").first?.split(separator: "/").map(String.init) ?? []
        guard parts.count >= 3, let session = parts[2].removingPercentEncoding, let app = AgentMail.shared.app,
              let found = app.workspace.session(session) else { return (404, Data("{}".utf8)) }
        // A bot's are in its own folder, as Edit Bot shows them.
        let owner = app.bots.bot(forSession: session)?.wakeOwner ?? WakeUps.owner(of: found)
        let wakeUps = app.wakeUps
        // As they are now: a machine session's aren't read until something asks.
        await wakeUps.read(owner)
        if parts.count == 4, parts[3] == "now", request.method.uppercased() == "POST" {
            struct Given: Decodable { var wake: String }
            guard let id = (try? JSONDecoder().decode(Given.self, from: request.body))?.wake,
                  let wake = wakeUps.wakes[owner.key]?.first(where: { $0.id == id || $0.letters == id }) else { return (404, Data("{}".utf8)) }
            do { try await wakeUps.wakeNow(wake, of: owner) } catch {
                return (Self.status(of: error), (try? JSONEncoder().encode(["message": error.localizedDescription])) ?? Data())
            }
            return (200, Data("{}".utf8))
        }
        if parts.count == 3, request.method.uppercased() == "POST" {
            struct Given: Decodable { var due: Double; var every: String?; var note: String }
            guard let given = try? JSONDecoder().decode(Given.self, from: request.body),
                  !given.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return (400, Self.message("Send when it comes (`due`, seconds since 1970) and what it says (`note`)."))
            }
            let every = given.every.flatMap(Wakes.Repeat.init)
            if given.every != nil, every == nil { return (400, Self.message("That isn’t a repeat: 30m, 2h, 1d, 1w or weekdays.")) }
            do {
                try await wakeUps.add(to: owner, at: Date(timeIntervalSince1970: given.due), every: every, note: given.note)
            } catch WakeUps.Failure.tooSoon {
                return (400, Self.message(WakeUps.Failure.tooSoon.localizedDescription))
            } catch WakeUps.Failure.tooMany {
                return (409, Self.message(WakeUps.Failure.tooMany.localizedDescription))
            } catch {
                return (Self.status(of: error), Self.message(error.localizedDescription))
            }
            await wakeUps.read(owner)
        } else if parts.count == 4, parts[3] == "pause", request.method.uppercased() == "POST" {
            struct Given: Decodable { var paused: Bool }
            guard let given = try? JSONDecoder().decode(Given.self, from: request.body) else { return (400, Self.message("Send {\"paused\": true} or false.")) }
            do { try await wakeUps.setPaused(given.paused, owner) } catch {
                return (Self.status(of: error), Self.message(error.localizedDescription))
            }
        } else if parts.count == 4, parts[3] == "cancel", request.method.uppercased() == "POST" {
            struct Given: Decodable { var wake: String?; var watch: String? }
            let given = try? JSONDecoder().decode(Given.self, from: request.body)
            do {
                if let id = given?.wake, let wake = wakeUps.wakes[owner.key]?.first(where: { $0.id == id || $0.letters == id }) {
                    try await wakeUps.cancel(wake, of: owner)
                } else if let letters = given?.watch, let watch = wakeUps.watches[owner.key]?.first(where: { $0.letters == letters }) {
                    try await wakeUps.cancel(watch, of: owner)
                } else {
                    return (404, Data("{}".utf8))
                }
            } catch {
                return (Self.status(of: error), (try? JSONEncoder().encode(["message": error.localizedDescription])) ?? Data())
            }
            return (200, Data("{}".utf8))
        } else if parts.count != 3 {
            return (404, Data("{}".utf8))
        }
        struct Listed: Encodable {
            struct Wake: Encodable { var id: String; var due: Double; var note: String; var every: String? }
            struct Watch: Encodable { var letters: String; var every: String; var check: String; var note: String }
            var wakes: [Wake]; var watches: [Watch]; var paused: Bool
        }
        let listed = Listed(wakes: (wakeUps.wakes[owner.key] ?? []).map { .init(id: $0.id, due: $0.due.timeIntervalSince1970, note: $0.note, every: $0.every?.text) },
                            watches: (wakeUps.watches[owner.key] ?? []).map { .init(letters: $0.letters, every: $0.every, check: $0.check, note: $0.note) },
                            paused: wakeUps.paused.contains(owner.key))
        return (200, (try? JSONEncoder().encode(listed)) ?? Data())
    }

    /// Stops a command an agent left running, as Stop in the bar over the composer does: found
    /// among the ones this Mac follows, or asked of the engine of `session` when given.
    private func stopShell(_ id: String, with body: Data) async -> (Int, Data) {
        struct Given: Decodable { var session: String? }
        guard let workspace else { return (503, Data()) }
        var found = workspace.shellJobs.lazy.compactMap { session, jobs in jobs.first { $0.id == id }.map { (session, $0) } }.first
        if found == nil, let session = (try? JSONDecoder().decode(Given.self, from: body))?.session, let api = workspace.api(forSession: session),
           let job = try? await api.shell(id, directory: workspace.session(session)?.location.directory), job.status == "running" {
            found = (session, job)
        }
        guard let (session, job) = found else { return (404, Data("{}".utf8)) }
        let how = await workspace.stopShellJob(job, in: session)
        return (200, Data(#"{"stopped":"\#(how)"}"#.utf8))
    }

    nonisolated private static func groupID(in path: String, then action: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count == 4, parts[0] == "kuvo", parts[1] == "groups", parts[3] == action else { return nil }
        return String(parts[2])
    }

    /// A response that doesn't end: `current()` now, as a line of JSON, and again each time it
    /// changes, until the phone stops reading. 404 when there's nothing to follow (no usage panel,
    /// no such chat), as reading it once answers.
    nonisolated private static func following(_ current: @escaping @MainActor () -> Data?) -> AsyncThrowingStream<LinkResponsePart, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { @MainActor in
                guard current() != nil else {
                    continuation.yield(.head(status: 404, headers: [:]))
                    continuation.finish()
                    return
                }
                continuation.yield(.head(status: 200, headers: ["content-type": "application/x-ndjson"]))
                var last: Data?
                while !Task.isCancelled {
                    guard let now = current() else { break }
                    if now != last {
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

    /// One chat's events (`kuvo/groups/<id>/events`), as `following` sends them, but a line whose
    /// messages are as they were (who's talking, or what they're doing, changed) leaves them out,
    /// and the phone keeps the ones it has.
    nonisolated private static func followingGroup(_ id: String, link: PhoneLink?) -> AsyncThrowingStream<LinkResponsePart, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { @MainActor in
                guard link?.groupLines(id) != nil else {
                    continuation.yield(.head(status: 404, headers: [:]))
                    continuation.finish()
                    return
                }
                continuation.yield(.head(status: 200, headers: ["content-type": "application/x-ndjson"]))
                var last: GroupLines?
                while !Task.isCancelled {
                    guard let now = link?.groupLines(id) else { break }
                    if now != last {
                        continuation.yield(.body((now.messages == last?.messages ? now.state : now.whole) + Data("\n".utf8)))
                        last = now
                    }
                    await changed { link?.groupLines(id)?.whole }
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

    private func save() {
        try? JSONEncoder().encode(Saved(phones: paired.phones, removed: paired.removed, machines: machineHosts, documents: documents)).write(to: savedFile, options: .atomic)
    }

    // MARK: Keychain

    private static var service: String { (Bundle.main.bundleIdentifier ?? "run.kuvo.code") + ".phone-link" }

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

/// Stops at the first answer an address gives, rather than following where it sends the browser
/// next (`kuvo/sign-in/return`).
nonisolated private final class StaysThere: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
