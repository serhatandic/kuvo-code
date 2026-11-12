import Foundation
import OpenCodeKit

/// Wake-ups and watches, for any conversation that keeps them: a bot's, a session's or a chat's.
/// Its agent schedules one with `kuvo-wake` (see `Wakes`), which keeps it in the conversation's
/// folder: a bot's own, or for a session `wakes/<its ID>` in Kuvo Code's folder (on a machine, in
/// `~/.kuvo-code/wakes`). When one comes due, its note goes to the conversation as a message, sent
/// by the computer it lives on with `kuvo-wake fire`: this Mac's box, a machine's keeper. This
/// shows them as each box keeps them (`kuvo/wakes`), and changes them through its routes.
@MainActor @Observable
final class WakeUps {
    /// A conversation that keeps wake-ups, and where they're kept.
    struct Owner: Hashable {
        /// What its wake-ups are listed by here: a bot's ID, or the session's.
        var key: String
        /// Its folder, as the engine where it lives knows it (on a machine, a session's starts
        /// with `$HOME/`).
        var folder: String
        var machine: String?
        var session: String
        /// Where it works, the app's way of writing it: its tools are waited for before it wakes.
        var directory: String
        /// It runs with the coding agents, whose tools aren't the engine's to wait for.
        var agents = false
        var isBot: Bool
    }

    /// Each conversation's waiting wake-ups, as last read, by its key.
    private(set) var wakes: [String: [Wakes.Pending]] = [:]
    /// Each conversation's watches, as last read.
    private(set) var watches: [String: [Wakes.Watch]] = [:]
    /// Those whose wake-ups you paused (a session's, while it's archived): they wait until resumed.
    private(set) var paused: Set<String> = []
    @ObservationIgnored weak var app: AppModel?

    /// The wake-up command on this Mac.
    static var command: URL { AppInfo.supportDirectory.appending(path: "bin/kuvo-wake") }
    /// The wake-up command on a machine.
    static var machineCommand: String { "$HOME/\(RemoteEngineInstaller.root)/bin/kuvo-wake" }
    /// This Mac's sessions' folders, by session (`KUVO_WAKES`).
    static var root: URL { AppInfo.supportDirectory.appending(path: "wakes") }
    /// A machine's, as its engine knows them.
    static var machineRoot: String { "$HOME/\(RemoteEngineInstaller.root)/wakes" }

    enum Failure: LocalizedError {
        case notConnected(String)
        case tooSoon
        case tooMany
        /// Wake Up Now, for one that went meanwhile (at its time, or canceled).
        case notWaiting
        var errorDescription: String? {
            switch self {
            case .notConnected(let machine): "\(machine) isn’t connected. Connect to it, then try again."
            case .tooSoon: "Pick a time at least a minute from now."
            case .tooMany: "There are \(Wakes.limit) wake-ups waiting already. Cancel some first."
            case .notWaiting: "This wake-up isn’t waiting any more."
            }
        }
    }

    // MARK: Whose

    /// A session's (or a chat's), wherever it runs.
    static func owner(of session: Session) -> Owner {
        let id = session.id
        let directory = session.location.directory
        let machine = RemoteFolder.machine(of: directory)
        let folder = machine == nil ? root.appending(path: id).path : machineRoot + "/" + id
        return Owner(key: id, folder: folder, machine: machine, session: id, directory: directory,
                     agents: OutsideAgents.isAgentSession(session), isBot: false)
    }

    /// A folder in a script for its machine: a session's from `$HOME`, which the shell fills in.
    nonisolated static func shell(_ path: String) -> String {
        path.hasPrefix("$HOME/") ? "\"$HOME\"/" + SSHConnection.quoted(String(path.dropFirst("$HOME/".count))) : SSHConnection.quoted(path)
    }

    // MARK: Reading

    /// A conversation's wake-ups, watches and pause, as its box lists them (`kuvo/wakes/<session>`).
    private struct Listed: Decodable {
        struct Wake: Decodable { var id: String; var note: String }
        struct Watch: Decodable { var letters: String; var every: String; var check: String; var note: String }
        var wakes: [Wake]
        var watches: [Watch]?
        var paused: Bool?
    }

    /// The box a conversation lives on: a machine's only while it's connected, so what can't
    /// reach it says so by its name.
    private func box(of owner: Owner) throws -> BoxClient {
        guard let app else { throw Failure.notConnected(owner.machine ?? "This Mac") }
        if let machine = owner.machine {
            guard let engine = app.machines.engine(machine), engine.isReady else { throw Failure.notConnected(app.machines.engine(machine)?.machine.name ?? machine) }
        }
        return app.box(owner.machine ?? BoxClient.mac)
    }

    /// Whether a conversation (by its key) lives on this Mac: a bot here, or a session that isn't a
    /// machine's. One moved to a machine is that machine's to say, whatever its old folder here says.
    private func livesHere(_ key: String) -> Bool {
        guard let app else { return false }
        if let bot = app.bots.bot(key) { return bot.machine == nil }
        guard let session = app.workspace.session(key) else { return true }
        return RemoteFolder.machine(of: session.location.directory) == nil
    }

    private static func route(_ owner: Owner, _ action: String? = nil) -> String {
        "kuvo/wakes/" + (owner.session.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? owner.session) + (action.map { "/" + $0 } ?? "")
    }

    /// Reads a conversation's waiting wake-ups and watches, and whether they're paused.
    func read(_ owner: Owner) async {
        guard !owner.session.isEmpty, let box = try? box(of: owner), let listed = try? await box.value(Listed.self, "GET", Self.route(owner)) else { return }
        take(listed, for: owner.key)
    }

    private func take(_ listed: Listed, for key: String) {
        let found = listed.wakes.compactMap { Wakes.Pending(id: $0.id, note: $0.note) }.sorted { $0.due < $1.due }
        if wakes[key] != found { wakes[key] = found }
        let watching = (listed.watches ?? []).map { Wakes.Watch(letters: $0.letters, every: $0.every, check: $0.check, note: $0.note) }
        if watches[key] != watching { watches[key] = watching }
        notePaused(key, listed.paused == true)
    }

    /// The conversations each followed box listed last, by key.
    @ObservationIgnored private var followed: [String: Set<String>] = [:]

    /// This Mac's wake-ups and watches as its box keeps them, from now on (`kuvo/wakes/events`): one
    /// added, sent at its time, canceled or paused, by an agent, a phone or here, shows as it happens.
    /// The box attached in place (`box`), which answers once a read, is read again now and then
    /// instead, as slowly as a machine's things are: its bots' too, which a machine's aren't.
    func follow(on box: String = BoxClient.mac) async {
        struct Line: Decodable {
            struct Entry: Decodable { var session: String; var wakes: [Listed.Wake]; var watches: [Listed.Watch]; var paused: Bool }
            var sessions: [Entry]
        }
        while !Task.isCancelled {
            if let app {
                do {
                    for try await data in app.box(box).follow("kuvo/wakes/events") {
                        guard let line = try? JSONDecoder().decode(Line.self, from: data) else { continue }
                        var keys: Set<String> = []
                        for entry in line.sessions {
                            let key = app.bots.bot(forSession: entry.session).map(\.id) ?? entry.session
                            guard lives(key, on: box) else { continue }
                            keys.insert(key)
                            take(Listed(wakes: entry.wakes, watches: entry.watches, paused: entry.paused), for: key)
                        }
                        for key in followed[box, default: []].subtracting(keys) where lives(key, on: box) { forget(key: key) }
                        followed[box] = keys
                    }
                } catch {}
            }
            // The box started again, or isn't up yet: followed again in a moment.
            try? await Task.sleep(for: BoxClient.streams(box) ? .seconds(2) : BoxClient.readAgainAfter)
        }
    }

    /// Whether a conversation (by its key) that `box` lists is its to say: on the app's own, one
    /// that lives here (`livesHere`); on any other (the box attached in place), likewise, one whose
    /// bot or session is still on that box. One moved to a machine is that machine's to say.
    private func lives(_ key: String, on box: String) -> Bool {
        guard box != BoxClient.mac else { return livesHere(key) }
        guard let app else { return false }
        if let bot = app.bots.bot(key) { return bot.machine == box }
        guard let session = app.workspace.session(key) else { return true }
        return RemoteFolder.machine(of: session.location.directory) == box
    }

    // MARK: Changing them

    /// A wake-up you add: at `due`, `note` arrives in the conversation, and again at each repeat,
    /// by the computer it lives on's own kuvo-wake (its clock, its weekends).
    func add(to owner: Owner, at due: Date, every: Wakes.Repeat?, note: String) async throws {
        // Moving to another computer: its folder here is about to go (`Moves`).
        if Moves.isFrozen(owner.key) || Moves.isFrozen(owner.session) { throw Moves.Failure.moving }
        let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard due > .now.addingTimeInterval(60) else { throw Failure.tooSoon }
        guard (wakes[owner.key]?.count ?? 0) < Wakes.limit else { throw Failure.tooMany }
        struct Adding: Encodable { var due: Int; var every: String?; var note: String }
        let listed = try await box(of: owner).value(Listed.self, "POST", Self.route(owner), body: Adding(due: Int(due.timeIntervalSince1970), every: every?.text, note: note))
        take(listed, for: owner.key)
        Analytics.shared.track(owner.isBot ? "bot_wake_added" : "session_wake_added", ["repeats": every != nil])
    }

    /// Cancels a wake-up by its letters, which a repeating one keeps as its time moves on (it may
    /// have come back since it was listed). On a computer that can't be reached, it stays, and
    /// this says so.
    func cancel(_ wake: Wakes.Pending, of owner: Owner) async throws {
        if Moves.isFrozen(owner.key) || Moves.isFrozen(owner.session) { throw Moves.Failure.moving }
        try await cancel(["wake": wake.letters], of: owner)
        wakes[owner.key]?.removeAll { $0.letters == wake.letters }
    }

    /// Stops a watch. On a computer that can't be reached, it stays, and this says so.
    func cancel(_ watch: Wakes.Watch, of owner: Owner) async throws {
        if Moves.isFrozen(owner.key) || Moves.isFrozen(owner.session) { throw Moves.Failure.moving }
        try await cancel(["watch": watch.letters], of: owner)
        watches[owner.key]?.removeAll { $0.letters == watch.letters }
    }

    private func cancel(_ which: [String: String], of owner: Owner) async throws {
        let (status, data) = try await box(of: owner).send("POST", Self.route(owner, "cancel"), body: try JSONEncoder().encode(which))
        // Gone already (sent, or canceled elsewhere): as asked.
        guard (200..<300).contains(status) || status == 404 else { throw BoxRefusal(status: status, data: data) }
    }

    /// Runs a watch's check now, as its own runs do (kuvo-wake's `try`: in the folder the
    /// conversation works in, for at most a minute, only what it prints), without counting it as
    /// a run: what it prints, or why a run like this one wouldn't count.
    func tryCheck(_ watch: Wakes.Watch, of owner: Owner) async -> String {
        let letters = watch.letters
        guard !letters.isEmpty, letters.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return "" }
        let output: String
        if let machine = owner.machine {
            let script = "\"\(Self.machineCommand)\" \(Self.shell(owner.folder)) try \(letters)"
            var data = await Task.detached { RemoteShell.run(script, on: machine) }.value
            // A kuvo-wake there from before `try`: this copy's, then again.
            if let old = data, Wakes.tried(String(decoding: old, as: UTF8.self)) == nil, let engine = app?.machines.engine(machine) {
                try? await Wakes.install(on: engine.machine.connection)
                data = await Task.detached { RemoteShell.run(script, on: machine) }.value
            }
            guard let data else { return "Couldn’t reach \(machine)." }
            output = String(decoding: data, as: UTF8.self)
        } else {
            try? Self.installCommand()
            output = await run([owner.folder, "try", letters], stopAfter: 75)
        }
        guard let tried = Wakes.tried(output) else { return "Couldn’t run the check. Is the watch still there?" }
        guard let skipped = tried.skipped else { return tried.output }
        let printed = tried.output.trimmingCharacters(in: .whitespacesAndNewlines)
        return "This run wouldn’t count: \(skipped). The watch skips runs like this, so they never wake \(owner.isBot ? "the bot" : "the conversation")."
            + (printed.isEmpty ? "" : "\n\n" + printed)
    }

    /// This Mac's kuvo-wake with `arguments`, in your shell's environment (with `adding`): what it
    /// prints. It's stopped after `stopAfter` seconds (each check stops itself after a minute),
    /// and what a check leaves running in the background doesn't hold it up.
    private func run(_ arguments: [String], stopAfter: TimeInterval, adding: [String: String] = [:]) async -> String {
        await runWithStatus(arguments, stopAfter: stopAfter, adding: adding, errors: false).output
    }

    /// As `run`, with what it says went wrong after what it printed, and how it exited.
    private func runWithStatus(_ arguments: [String], stopAfter: TimeInterval, adding: [String: String] = [:], errors: Bool = true) async -> (output: String, status: Int32) {
        var environment = app?.shellEnvironment ?? ProcessInfo.processInfo.environment
        environment["KUVO_BOTS"] = Bots.root.path
        environment["KUVO_WAKES"] = Self.root.path
        environment.merge(adding) { _, new in new }
        // Never stopped half way by the caller going away: it changes what's kept.
        guard let result = try? await ChildProcess.run("/bin/sh", [Self.command.path] + arguments, environment: environment,
                                                       errors: errors ? .withOutput : .discard, limit: .seconds(stopAfter),
                                                       cancellable: false) else { return ("", -1) }
        return (result.outputText, result.status)
    }

    // MARK: Pausing

    /// Holds a conversation's wake-ups until you resume them; then those that came due meanwhile
    /// go. On a computer that can't be reached, nothing changes, and this says so. A session's
    /// with none has nothing to hold. `byArchiving`: held while the session is archived, which
    /// leaves a hold of yours as it is, and lets go of only its own.
    func setPaused(_ pause: Bool, _ owner: Owner, byArchiving: Bool = false, stops: Bool = true) async throws {
        // Held by a move under way (`Moves`), which lets them go once it's there.
        if Moves.isFrozen(owner.key) || Moves.isFrozen(owner.session) { throw Moves.Failure.moving }
        // Archived, its box also stops it if it waits on you, unless it `stops` false.
        struct Pausing: Encodable { var paused: Bool?; var archived: Bool?; var stop: Bool? }
        let asked = byArchiving ? Pausing(archived: pause, stop: stops ? nil : false) : Pausing(paused: pause)
        take(try await box(of: owner).value(Listed.self, "POST", Self.route(owner, "pause"), body: asked), for: owner.key)
    }

    private func notePaused(_ key: String, _ isPaused: Bool) {
        if isPaused, !paused.contains(key) { paused.insert(key) }
        if !isPaused, paused.contains(key) { paused.remove(key) }
    }

    /// Wake-ups being sent with Wake Up Now, by owner and wake-up.
    @ObservationIgnored private var wakingNow: Set<String> = []

    /// Sends a waiting wake-up now rather than at its time (to see the job run), by the computer it
    /// lives on, as its time would; one that doesn't repeat is then done.
    func wakeNow(_ wake: Wakes.Pending, of owner: Owner) async throws {
        // Once: not again while it's on its way (waiting for the folder's tools can take a while).
        let key = owner.key + "/" + wake.id
        guard !wakingNow.contains(key) else { return }
        if Moves.isFrozen(owner.key) || Moves.isFrozen(owner.session) { throw Moves.Failure.moving }
        wakingNow.insert(key)
        defer { wakingNow.remove(key) }
        // By its letters, which a repeating one keeps as its time moves on.
        let (status, data) = try await box(of: owner).send("POST", Self.route(owner, "now"), body: try JSONEncoder().encode(["wake": wake.letters]))
        await read(owner)
        if status == 404 { throw Failure.notWaiting }
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
    }

    /// A session's wake-ups wait while it's archived, and come back with it.
    func archived(_ session: Session, _ isArchived: Bool) async {
        try? await setPaused(isArchived, Self.owner(of: session), byArchiving: true)
    }

    /// A session that's gone takes its wake-ups and watches with it; a bot's go with its folder.
    func forget(_ session: Session) {
        let owner = Self.owner(of: session)
        wakes[owner.key] = nil
        watches[owner.key] = nil
        paused.remove(owner.key)
        if let machine = owner.machine {
            let script = "rm -rf \(Self.shell(owner.folder))"
            Task.detached { _ = RemoteShell.run(script, on: machine) }
        } else {
            try? FileManager.default.removeItem(atPath: owner.folder)
        }
    }

    /// A session that's gone that isn't listed: its folder on this Mac, if it had one.
    func forget(sessionID id: String) {
        guard id.hasPrefix("ses_"), !id.contains("/") else { return }
        forget(key: id)
        try? FileManager.default.removeItem(at: Self.root.appending(path: id))
    }

    /// A bot that's gone: what was read of its wake-ups.
    func forget(key: String) {
        wakes[key] = nil
        watches[key] = nil
        paused.remove(key)
    }

    /// Puts `kuvo-wake` in the app's folder, as the engine on a machine has it.
    static func installCommand() throws {
        let data = Data(Wakes.script.utf8)
        if (try? Data(contentsOf: command)) == data { return }
        try FileManager.default.createDirectory(at: command.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: command, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: command.path)
    }

    // MARK: Machines

    /// What each machine was given: this copy's kuvo-wake, and your time zone.
    @ObservationIgnored private var shared: [String: String] = [:]
    /// Each machine's sessions that kept wake-ups when it was last read, by key.
    @ObservationIgnored private var readOn: [String: Set<String>] = [:]

    /// Gives a machine this copy's kuvo-wake, once a run of the app (an engine started before has
    /// an older one, which its watchdog runs), and your time zone for its sessions' wake-ups, in
    /// the folder above theirs, whenever it changes; and reads its sessions' wake-ups again, as it
    /// connects and each minute after (one changed there, from a phone, shows here).
    func share(with engine: MachineEngine) async {
        let machine = engine.machine.id
        let zone = TimeZone.current.identifier
        if shared[machine] != zone {
            try? await Wakes.install(on: engine.machine.connection)
            let root = Self.shell(Self.machineRoot)
            var script = "mkdir -p \(root) && printf '%s' \(SSHConnection.quoted(zone)) >\(root)/timezone"
            if let rules = Self.zoneRules(zone) {
                script += " && { printf '%s' \(SSHConnection.quoted(rules.base64EncodedString())) | base64 -d >\(root)/zoneinfo 2>/dev/null || rm -f \(root)/zoneinfo; }"
            }
            if await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value != nil { shared[machine] = zone }
        }
        // (This Mac's own box, attached in place, is followed whole, its bots' too: `follow(on:)`.)
        if !engine.machine.isThisMac { await readSessions(on: machine) }
    }

    /// The wake-ups of a machine's sessions that keep some: the sidebar's signs, and the phone's
    /// Now and Cancel, have them without their conversations being opened. One that keeps none
    /// now (all sent or canceled there) has none here either. A box lists them all in one answer;
    /// an older one only names the sessions, each read on its own.
    private func readSessions(on machine: String) async {
        struct Listing: Decodable {
            struct Entry: Decodable { var session: String; var wakes: [Listed.Wake]?; var watches: [Listed.Watch]?; var paused: Bool? }
            var sessions: [Entry]
        }
        guard let app, let listing = try? await app.box(machine).value(Listing.self, "GET", "kuvo/wakes") else { return }
        var keys: Set<String> = []
        for entry in listing.sessions {
            if let session = app.workspace.session(entry.session), RemoteFolder.machine(of: session.location.directory) == machine {
                let owner = Self.owner(of: session)
                keys.insert(owner.key)
                if let wakes = entry.wakes {
                    take(Listed(wakes: wakes, watches: entry.watches, paused: entry.paused), for: owner.key)
                } else {
                    await read(owner)
                }
            }
        }
        for key in readOn[machine, default: []].subtracting(keys) {
            if let session = app.workspace.session(key), RemoteFolder.machine(of: session.location.directory) == machine { forget(key: key) }
        }
        readOn[machine] = keys
    }

    /// A time zone's rules as this Mac has them (a TZif file, which Linux reads too), if small.
    nonisolated static func zoneRules(_ identifier: String) -> Data? {
        guard !identifier.contains(".."), let data = FileManager.default.contents(atPath: "/usr/share/zoneinfo/" + identifier),
              data.count < 16_384, data.starts(with: Data("TZif".utf8)) else { return nil }
        return data
    }
}

extension Bot {
    /// Its wake-ups' owner: its conversation, in its folder.
    var wakeOwner: WakeUps.Owner {
        WakeUps.Owner(key: id, folder: folder, machine: machine, session: sessionID, directory: directory, agents: agents == true, isBot: true)
    }
}

extension Wakes.Repeat {
    /// "every day", "every 2 hours", "on weekdays".
    var words: String {
        switch self {
        case .minutes(let n): "every \(n) min"
        case .hours(let n): n == 1 ? "every hour" : "every \(n) hours"
        case .days(let n): n == 1 ? "every day" : "every \(n) days"
        case .weeks(let n): n == 1 ? "every week" : "every \(n) weeks"
        case .weekdays: "on weekdays"
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
