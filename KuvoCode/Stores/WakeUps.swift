import Foundation
import OpenCodeKit
import os

/// Wake-ups and watches, for any conversation that keeps them: a bot's, a session's or a chat's.
/// Its agent schedules one with `kuvo-wake` (see `Wakes`), which keeps it in the conversation's
/// folder: a bot's own, or for a session `wakes/<its ID>` in Kuvo Code's folder (on a machine, in
/// `~/.kuvo-code/wakes`). When one comes due, its note goes to the conversation as a message: on
/// this Mac the app sends it while it runs; on a machine, the engine's watchdog does.
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
    /// Done before each round of wake-ups, the first at launch (the bots' jobs and instructions).
    @ObservationIgnored var beforeRound: ((_ first: Bool) async -> Void)?
    @ObservationIgnored private var waking: Task<Void, Never>?
    private let log = Logger(subsystem: "run.kuvo.code", category: "wakes")

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
        case noWake
        /// Wake Up Now couldn't read a machine's wake-up whole, to send it as its time would.
        case unreadWake(String)
        /// Wake Up Now sent it, but couldn't take it off the schedule: it comes at its time too.
        case wakeStays(String)
        var errorDescription: String? {
            switch self {
            case .notConnected(let machine): "\(machine) isn’t connected. Connect to it, then try again."
            case .tooSoon: "Pick a time at least a minute from now."
            case .tooMany: "There are \(Wakes.limit) wake-ups waiting already. Cancel some first."
            case .noWake: "Couldn’t add the wake-up. Check that the machine is connected, then try again."
            case .unreadWake(let machine): "Couldn’t read the wake-up on \(machine). Check that it’s connected, then try again."
            case .wakeStays(let reason): "It woke up, but the wake-up couldn’t be cancelled, so it comes at its time too. \(reason)"
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

    /// The conversations whose wake-ups this Mac sends: its bots, and its sessions that keep some.
    private func localOwners() -> [Owner] {
        guard let app else { return [] }
        var owners = app.bots.list.filter { $0.machine == nil }.map(\.wakeOwner)
        let folders = (try? FileManager.default.contentsOfDirectory(atPath: Self.root.path)) ?? []
        for id in folders where id.hasPrefix("ses_") {
            let folder = Self.root.appending(path: id)
            guard FileManager.default.fileExists(atPath: folder.appending(path: "session").path) else { continue }
            if let session = app.workspace.session(id) {
                let owner = Self.owner(of: session)
                // Moved (a chat into a project, a session to a worktree): its watches' checks run there now.
                let file = folder.appending(path: "directory")
                if (try? String(contentsOf: file, encoding: .utf8)) != owner.directory { try? Data(owner.directory.utf8).write(to: file) }
                owners.append(owner)
            } else {
                // Not listed (yet): where its folder says it works, and whether it's a coding agent's.
                let directory = (try? String(contentsOf: folder.appending(path: "directory"), encoding: .utf8)) ?? Workspace.chatsFolder
                let via = try? String(contentsOf: folder.appending(path: "via"), encoding: .utf8)
                owners.append(Owner(key: id, folder: folder.path, machine: nil, session: id, directory: directory, agents: via == "bridge", isBot: false))
            }
        }
        return owners
    }

    /// What a conversation runs on: a bot's as its bot does, a session's as it does (a coding
    /// agent's not listed yet, the agents' bridge).
    func api(for owner: Owner) -> OpenCodeAPI? {
        if owner.isBot, let bot = app?.bots.bot(owner.key) { return app?.bots.api(for: bot) }
        if owner.agents, app?.workspace.session(owner.session) == nil { return app?.workspace.agents?.api }
        return app?.workspace.api(forSession: owner.session)
    }

    /// Whose wake-ups a session's folder holds when it's a subagent's (its kuvo-wake named it):
    /// the conversation that started it, a bot's own folder if it's a bot's; nil for one of its own.
    private func adopter(of id: String) async -> Owner? {
        guard let app else { return nil }
        let via = try? String(contentsOf: Self.root.appending(path: id).appending(path: "via"), encoding: .utf8)
        let root = await root(of: id, agents: via == "bridge")
        guard root != id else { return nil }
        if let bot = app.bots.bot(forSession: root) { return bot.wakeOwner }
        return app.workspace.session(root).map(Self.owner(of:))
    }

    /// Each session's parent as its engine said (nil: one of its own), asked once a run.
    @ObservationIgnored private var parentsAsked: [String: String?] = [:]

    /// The conversation a session is part of: as this run has heard (`Workspace.root(of:)`), or,
    /// for one not listed that it hasn't (a subagent's, after a launch), as its engine says.
    private func root(of id: String, agents: Bool) async -> String {
        guard let app else { return id }
        var id = app.workspace.root(of: id)
        for _ in 0..<5 where app.workspace.session(id) == nil {
            if parentsAsked[id] == nil {
                let api = agents ? app.workspace.agents?.api : app.workspace.api
                guard let session = try? await api?.session(id) else { break }
                parentsAsked[id] = .some(session.parentID)
            }
            guard let parent = parentsAsked[id] ?? nil else { break }
            id = app.workspace.root(of: parent)
        }
        return id
    }

    /// Moves a subagent's wake-ups and watches into the folder of the conversation that started
    /// it, so they wake that one, show in its bar, and go with it.
    private func adoptStrays() async {
        let manager = FileManager.default
        for id in (try? manager.contentsOfDirectory(atPath: Self.root.path)) ?? [] where id.hasPrefix("ses_") {
            guard let to = await adopter(of: id), to.machine == nil else { continue }
            let from = Self.root.appending(path: id).path
            try? await makeFolder(of: to)
            for kind in ["wakes", "watches"] {
                let source = (from as NSString).appendingPathComponent(kind)
                let target = Self.path(to, kind)
                try? manager.createDirectory(atPath: target, withIntermediateDirectories: true)
                for name in (try? manager.contentsOfDirectory(atPath: source)) ?? [] {
                    try? manager.moveItem(atPath: (source as NSString).appendingPathComponent(name), toPath: (target as NSString).appendingPathComponent(name))
                }
            }
            try? manager.removeItem(atPath: from)
            forget(key: id)
            await read(to)
        }
    }

    /// Whether a send failed as the conversation is gone from its engine: its folder goes (a
    /// session's), rather than its wake-ups being tried for ever. Not one the agents' bridge has,
    /// which its folder didn't say: its from now on.
    private func gone(_ error: Error, _ owner: Owner) async -> Bool {
        guard (error as? ServerError)?.status == 404, !owner.isBot, owner.machine == nil else { return false }
        if !owner.agents {
            guard let bridge = app?.workspace.agents?.api else { return false }
            if (try? await bridge.session(owner.session)) != nil {
                try? Data("bridge".utf8).write(to: URL(filePath: Self.path(owner, "via")))
                return false
            }
        }
        forget(sessionID: owner.session)
        log.info("\(owner.key, privacy: .public) is gone: its wake-ups went with it")
        return true
    }

    /// A folder in a script for its machine: a session's from `$HOME`, which the shell fills in.
    nonisolated static func shell(_ path: String) -> String {
        path.hasPrefix("$HOME/") ? "\"$HOME\"/" + SSHConnection.quoted(String(path.dropFirst("$HOME/".count))) : SSHConnection.quoted(path)
    }

    private static func path(_ owner: Owner, _ parts: String...) -> String {
        parts.reduce(owner.folder) { ($0 as NSString).appendingPathComponent($1) }
    }

    // MARK: Reading

    /// Reads a conversation's waiting wake-ups and watches, and whether they're paused.
    func read(_ owner: Owner) async {
        guard let machine = owner.machine else {
            let found = Self.localWakes(of: owner)
            if wakes[owner.key] != found { wakes[owner.key] = found }
            let watching = Self.localWatches(of: owner)
            if watches[owner.key] != watching { watches[owner.key] = watching }
            notePaused(owner.key, FileManager.default.fileExists(atPath: Self.pauseFile(of: owner)))
            return
        }
        let folder = Self.shell(Self.path(owner, "wakes"))
        let watching = Self.shell(Self.path(owner, "watches"))
        // One line each: the file's name, a tab, the note on one line; "paused" first if it is;
        // then each watch, after "watch" and a tab: its letters, how often, its check and note.
        let one = "tr '\\t\\n' '  '"
        let script = "[ -e \(Self.shell(Self.pauseFile(of: owner))) ] && echo paused; for f in \(folder)/*; do [ -f \"$f\" ] && printf '%s\\t%s\\n' \"${f##*/}\" \"$(tr '\\n' ' ' <\"$f\" | head -c 400)\"; done; for w in \(watching)/*/; do [ -f \"${w}check\" ] && l=${w%/} && printf 'watch\\t%s\\t%s\\t%s\\t%s\\n' \"${l##*/}\" \"$(cat \"${w}every\")\" \"$(\(one) <\"${w}check\" | head -c 300)\" \"$(\(one) <\"${w}note\" | head -c 400)\"; done; true"
        let output = await Task.detached { RemoteShell.run(script, on: machine) }.value
        guard let output else { return }
        var lines = String(decoding: output, as: UTF8.self).split(separator: "\n")
        notePaused(owner.key, lines.first == "paused")
        if lines.first == "paused" { lines.removeFirst() }
        let found = lines.filter { $0.hasPrefix("watch\t") }.compactMap { line -> Wakes.Watch? in
            let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            return parts.count >= 5 ? Wakes.Watch(letters: parts[1], every: parts[2], check: parts[3], note: parts[4]) : nil
        }
        if watches[owner.key] != found { watches[owner.key] = found }
        lines.removeAll { $0.hasPrefix("watch\t") }
        let pending = lines.compactMap { line in
            let parts = line.split(separator: "\t", maxSplits: 1).map(String.init)
            return parts.first.flatMap { Wakes.Pending(id: $0, note: parts.count > 1 ? parts[1] : "") }
        }
        .sorted { $0.due < $1.due }
        if wakes[owner.key] != pending { wakes[owner.key] = pending }
    }

    private static func localWakes(of owner: Owner) -> [Wakes.Pending] {
        let folder = path(owner, "wakes")
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []
        return names.compactMap { name in
            let note = (try? String(contentsOfFile: (folder as NSString).appendingPathComponent(name), encoding: .utf8)) ?? ""
            return Wakes.Pending(id: name, note: note)
        }
        .sorted { $0.due < $1.due }
    }

    private static func localWatches(of owner: Owner) -> [Wakes.Watch] {
        let folder = path(owner, "watches")
        let read = { (watch: String, file: String) in
            (try? String(contentsOfFile: ((folder as NSString).appendingPathComponent(watch) as NSString).appendingPathComponent(file), encoding: .utf8)) ?? ""
        }
        return ((try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []).sorted().compactMap { letters in
            let check = read(letters, "check")
            return check.isEmpty ? nil : Wakes.Watch(letters: letters, every: read(letters, "every"), check: check, note: read(letters, "note"))
        }
    }

    // MARK: Changing them

    /// A session's folder, made as kuvo-wake makes it, for a wake-up you add before its agent made
    /// one: its session, where it works, and for a coding agent's, that its wake-ups go through the
    /// agents' bridge (`via`). A bot's is made with it. An archived session's is held from the
    /// start, as its wake-ups would be had it had some when it was archived.
    private func makeFolder(of owner: Owner) async throws {
        guard !owner.isBot else { return }
        let directory = RemoteFolder.parse(owner.directory)?.path ?? owner.directory
        let archived = app?.workspace.session(owner.session).map(Workspace.isArchived) == true
        if let machine = owner.machine {
            let folder = Self.shell(owner.folder)
            let via = owner.agents ? " && printf bridge >\(folder)/via" : ""
            let held = archived ? " && printf \(Self.archivedHold) >\(Self.shell(Self.pauseFile(of: owner)))" : ""
            let script = "[ -f \(folder)/session ] || { (umask 077; mkdir -p \(folder)) && printf '%s' \(SSHConnection.quoted(owner.session)) >\(folder)/session && printf '%s' \(SSHConnection.quoted(directory)) >\(folder)/directory\(via)\(held); }"
            guard await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value != nil else { throw Failure.notConnected(machine) }
            return
        }
        let manager = FileManager.default
        guard !manager.fileExists(atPath: Self.path(owner, "session")) else { return }
        try manager.createDirectory(atPath: owner.folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try Data(owner.session.utf8).write(to: URL(filePath: Self.path(owner, "session")))
        try Data(directory.utf8).write(to: URL(filePath: Self.path(owner, "directory")))
        if owner.agents { try Data("bridge".utf8).write(to: URL(filePath: Self.path(owner, "via"))) }
        if archived { try await setPaused(true, owner, byArchiving: true) }
    }

    /// A wake-up you add: at `due`, `note` arrives in the conversation, and again at each repeat.
    /// One on weekdays starts on a weekday.
    func add(to owner: Owner, at due: Date, every: Wakes.Repeat?, note: String) async throws {
        // Moving to another computer: its folder here is about to go (`Moves`).
        if Moves.isFrozen(owner.key) || Moves.isFrozen(owner.session) { throw Moves.Failure.moving }
        let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard due > .now.addingTimeInterval(60) else { throw Failure.tooSoon }
        guard (wakes[owner.key]?.count ?? 0) < Wakes.limit else { throw Failure.tooMany }
        try await makeFolder(of: owner)
        if let machine = owner.machine {
            // Its own kuvo-wake, which knows the machine's clock and its weekends.
            let repeating = every.map { "--every \($0.text) " } ?? ""
            let script = "\"\(Self.machineCommand)\" \(Self.shell(owner.folder)) add \(Int(due.timeIntervalSince1970)) \(repeating)\(SSHConnection.quoted(note))"
            guard await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value != nil else { throw Failure.noWake }
            await read(owner)
            return
        }
        var due = due
        let calendar = Calendar.current
        while every == .weekdays, Wakes.isWeekend(due, calendar: calendar), let next = calendar.date(byAdding: .day, value: 1, to: due) { due = next }
        let folder = Self.path(owner, "wakes")
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let file = (folder as NSString).appendingPathComponent(Wakes.name(due: due, every: every))
        guard FileManager.default.createFile(atPath: file, contents: Data(note.utf8)) else { throw Failure.noWake }
        wakes[owner.key] = Self.localWakes(of: owner)
        Analytics.shared.track(owner.isBot ? "bot_wake_added" : "session_wake_added", ["repeats": every != nil])
    }

    /// Cancels a wake-up by its letters, which a repeating one keeps as its time moves on (it may
    /// have come back since it was listed). On a machine that can't be reached, it stays, and
    /// this says so.
    func cancel(_ wake: Wakes.Pending, of owner: Owner) async throws {
        if Moves.isFrozen(owner.key) || Moves.isFrozen(owner.session) { throw Moves.Failure.moving }
        let letters = wake.letters
        // As kuvo-wake names them; anything else isn't one of its wake-ups (or safe in a command).
        guard !letters.isEmpty, letters.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return }
        let folder = Self.path(owner, "wakes")
        if let machine = owner.machine {
            let base = Self.shell(folder)
            guard await Task.detached(operation: { RemoteShell.run("rm -f \(base)/*-\(letters) \(base)/*-\(letters)-*", on: machine) }).value != nil else {
                throw Failure.notConnected(machine)
            }
        } else {
            for name in (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? [] where Wakes.Pending(id: name, note: "")?.letters == letters {
                try? FileManager.default.removeItem(atPath: (folder as NSString).appendingPathComponent(name))
            }
        }
        wakes[owner.key]?.removeAll { $0.letters == letters }
    }

    /// Stops a watch. On a machine that can't be reached, it stays, and this says so.
    func cancel(_ watch: Wakes.Watch, of owner: Owner) async throws {
        if Moves.isFrozen(owner.key) || Moves.isFrozen(owner.session) { throw Moves.Failure.moving }
        let letters = watch.letters
        guard !letters.isEmpty, letters.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return }
        let folder = Self.path(owner, "watches", letters)
        if let machine = owner.machine {
            let script = "rm -rf \(Self.shell(folder))"
            guard await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value != nil else {
                throw Failure.notConnected(machine)
            }
        } else {
            try? FileManager.default.removeItem(atPath: folder)
        }
        watches[owner.key]?.removeAll { $0.letters == letters }
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
    /// prints. It's stopped after `stopAfter` seconds (each check stops itself after a minute).
    private func run(_ arguments: [String], stopAfter: TimeInterval, adding: [String: String] = [:]) async -> String {
        await runWithStatus(arguments, stopAfter: stopAfter, adding: adding, errors: false).output
    }

    /// As `run`, with what it says went wrong after what it printed, and how it exited.
    private func runWithStatus(_ arguments: [String], stopAfter: TimeInterval, adding: [String: String] = [:], errors: Bool = true) async -> (output: String, status: Int32) {
        var environment = app?.shellEnvironment ?? ProcessInfo.processInfo.environment
        environment["KUVO_BOTS"] = Bots.root.path
        environment["KUVO_WAKES"] = Self.root.path
        environment.merge(adding) { _, new in new }
        let arguments = [Self.command.path] + arguments
        return await Task.detached { () -> (String, Int32) in
            let process = Process()
            process.executableURL = URL(filePath: "/bin/sh")
            process.arguments = arguments
            process.environment = environment
            process.standardInput = FileHandle.nullDevice
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = errors ? pipe : FileHandle.nullDevice
            guard (try? process.run()) != nil else { return ("", -1) }
            let stop = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + stopAfter, execute: stop)
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            stop.cancel()
            return (String(decoding: data, as: UTF8.self), process.terminationStatus)
        }.value
    }

    // MARK: The agent's tools

    /// The wake-up tools' calls from this Mac's conversations (`BrowserTools.wakeTools`): for the
    /// conversation `caller` is part of (a subagent's, the one that started it; a bot's, the bot's
    /// folder), through kuvo-wake, as a machine's run there. Never a group chat's seat: meetings
    /// are the chat's.
    func call(_ name: String, arguments: [String: Any], caller: String?) async -> (text: String, isError: Bool) {
        guard let app, let caller else { return ("This needs a conversation of its own.", true) }
        let root = app.workspace.root(of: caller)
        if app.workspace.seats.contains(root) || app.workspace.seats.contains(caller) {
            return ("Not from a group chat: a chat can meet on a schedule instead (its editor's Meets on a Schedule).", true)
        }
        let owner: Owner
        if let bot = app.bots.bot(forSession: root) {
            owner = bot.wakeOwner
        } else if let session = app.workspace.session(root) {
            owner = Self.owner(of: session)
        } else {
            return ("Kuvo Code doesn't know this conversation yet. Try again in a moment.", true)
        }
        func given(_ key: String) -> String? {
            (arguments[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        }
        // A watch runs a command whenever it's due: in Ask First, only once you've been asked (the
        // engine asks for the tool in a conversation made since it does; not for one from before,
        // nor through the coding agents' bridge).
        if name == "watch_for_change" {
            let calling = app.workspace.session(caller)
            var rules = calling?.permissions
            if calling == nil, let api = app.workspace.api(forSession: caller) { rules = (try? await api.session(caller))?.permissions }
            let agents = calling.map(OutsideAgents.isAgentSession) ?? owner.agents
            if ToolApproval.watchWentUnasked(rules, agents: agents) { return (ToolApproval.watchAsCommand, true) }
        }
        var verb: [String]
        switch name {
        case "schedule_wake_up":
            guard let when = given("when") else { return ("Say when (when): +20m, +2h, +1d, or a time like 2026-10-21T09:00.", true) }
            guard let note = given("note") else { return ("Add a note for yourself (note): what to do when you wake up.", true) }
            verb = ["add", when] + (given("every").map { ["--every", $0] } ?? []) + [note]
        case "watch_for_change":
            guard let every = given("every"), let check = given("check"), let note = given("note") else {
                return ("Give how often (every), the check (a shell command) and a note for when it changes.", true)
            }
            verb = ["watch", every, check, note]
        case "list_wake_ups":
            verb = ["list"]
        case "cancel_wake_up":
            guard let id = given("id") else { return ("Say which one (id), from list_wake_ups.", true) }
            verb = ["cancel", id]
        default:
            return ("Unknown tool \(name).", true)
        }
        // A session's folder, made as it works in its own folder, before its first one.
        if !owner.isBot, name == "schedule_wake_up" || name == "watch_for_change" {
            do { try await makeFolder(of: owner) } catch { return ("Couldn't keep it: \(error.localizedDescription)", true) }
        } else if !owner.isBot, !FileManager.default.fileExists(atPath: owner.folder) {
            return (name == "list_wake_ups" ? "No wake-ups scheduled." : "No wake-up \"\(given("id") ?? "")\". See list_wake_ups.", name != "list_wake_ups")
        }
        try? Self.installCommand()
        let (output, status) = await runWithStatus([owner.folder] + verb, stopAfter: 30, adding: ["KUVO_WAKE_TOOL": "1"])
        await read(owner)
        if status == 0, name == "schedule_wake_up" || name == "watch_for_change" {
            Analytics.shared.track(owner.isBot ? "bot_wake_added" : "session_wake_added", ["repeats": name == "watch_for_change" || given("every") != nil, "by": "agent"])
        }
        let text = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return (text.isEmpty ? (status == 0 ? "Done." : "That didn't work.") : text, status != 0)
    }

    // MARK: Pausing

    /// A file in the conversation's folder that, while it's there, holds its wake-ups: on this
    /// Mac, and on a machine, where the watchdog skips it.
    static func pauseFile(of owner: Owner) -> String {
        path(owner, "paused")
    }

    /// What the pause file says when archiving held the wake-ups, not you: bringing the session
    /// back takes only that hold away. Yours says `ownHold`; an empty one is from before they
    /// said (0.6.3 and earlier), most likely archiving's, and goes too.
    private static let archivedHold = "archived"
    private static let ownHold = "paused"

    /// Holds a conversation's wake-ups until you resume them; then those that came due meanwhile
    /// go. On a machine that can't be reached, nothing changes, and this says so. A session's
    /// with none has nothing to hold. `byArchiving`: held while the session is archived, which
    /// leaves a hold of yours as it is, and lets go of only its own.
    func setPaused(_ pause: Bool, _ owner: Owner, byArchiving: Bool = false) async throws {
        // Held by a move under way (`Moves`), which lets them go once it's there.
        if Moves.isFrozen(owner.key) || Moves.isFrozen(owner.session) { throw Moves.Failure.moving }
        let file = Self.pauseFile(of: owner)
        var isPaused = pause
        if let machine = owner.machine {
            // A machine's kuvo-wake from before pausing would send them anyway.
            if pause, let engine = app?.machines.engine(machine) { try? await Wakes.install(on: engine.machine.connection) }
            let folder = Self.shell(owner.folder), paused = Self.shell(file)
            let script = switch (pause, byArchiving) {
            case (true, false): "[ ! -d \(folder) ] || printf \(Self.ownHold) > \(paused)"
            // A move's hold left by one cut short (`Moves`) becomes archiving's: lifting it then
            // doesn't let them go.
            case (true, true): "[ ! -d \(folder) ] || { [ -e \(paused) ] && [ \"$(cat \(paused) 2>/dev/null)\" != \(Moves.hold) ]; } || printf \(Self.archivedHold) > \(paused)"
            case (false, false): "rm -f \(paused)"
            case (false, true): "case \"$(cat \(paused) 2>/dev/null)\" in \(Self.archivedHold)|'') rm -f \(paused);; esac; [ -e \(paused) ] && echo held || true"
            }
            guard let output = await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value else { throw Failure.notConnected(machine) }
            if !pause, byArchiving { isPaused = String(decoding: output, as: UTF8.self).hasPrefix("held") }
        } else if pause {
            guard owner.isBot || FileManager.default.fileExists(atPath: owner.folder) else { return }
            let held = FileManager.default.contents(atPath: file).map { String(decoding: $0, as: UTF8.self) }
            if !(byArchiving && held != nil && held != Moves.hold) {
                FileManager.default.createFile(atPath: file, contents: Data((byArchiving ? Self.archivedHold : Self.ownHold).utf8))
            }
        } else if byArchiving, let held = FileManager.default.contents(atPath: file), !held.isEmpty, String(decoding: held, as: UTF8.self) != Self.archivedHold {
            // Yours: it stays.
            isPaused = true
        } else {
            try? FileManager.default.removeItem(atPath: file)
        }
        notePaused(owner.key, isPaused)
    }

    private func notePaused(_ key: String, _ isPaused: Bool) {
        if isPaused, !paused.contains(key) { paused.insert(key) }
        if !isPaused, paused.contains(key) { paused.remove(key) }
    }

    /// Wake-ups being sent with Wake Up Now, by owner and wake-up.
    @ObservationIgnored private var wakingNow: Set<String> = []

    /// Sends a waiting wake-up now rather than at its time (to see the job run), on this Mac or
    /// its machine; one that doesn't repeat is then done.
    func wakeNow(_ wake: Wakes.Pending, of owner: Owner) async throws {
        if Moves.isFrozen(owner.key) || Moves.isFrozen(owner.session) { throw Moves.Failure.moving }
        // Once: not again while it's on its way (waiting for the folder's tools can take a
        // while), nor, for one that doesn't repeat, once it's gone (sent, or cancelled).
        let key = owner.key + "/" + wake.id
        guard !wakingNow.contains(key) else { return }
        if owner.machine == nil, !FileManager.default.fileExists(atPath: Self.path(owner, "wakes", wake.id)) { return }
        wakingNow.insert(key)
        defer { wakingNow.remove(key) }
        guard let api = api(for: owner) else {
            if owner.agents { throw OutsideAgents.Failure.notRunning(app?.workspace.agents(forFolder: owner.directory)?.failure) }
            throw Failure.notConnected(owner.machine ?? "This Mac's engine")
        }
        if !owner.agents { await api.waitForTools(in: owner.directory) }
        var note = wake.note
        // A machine's are listed cut short, on one line: the whole note, as its time would send it.
        if let machine = owner.machine {
            let file = Self.shell(Self.path(owner, "wakes", wake.id))
            let output = await Task.detached { RemoteShell.run("cat \(file)", on: machine) }.value
            // Not the shortened line in its place: the agent would act on half its note.
            guard let output, case let whole = String(decoding: output, as: UTF8.self), !whole.isEmpty else { throw Failure.unreadWake(machine) }
            note = whole
        }
        try await api.prompt(session: owner.session, id: Identifier.message(), text: Wakes.marker + note, delivery: .queue)
        if wake.every == nil {
            do { try await cancel(wake, of: owner) } catch { throw Failure.wakeStays(error.localizedDescription) }
        }
    }

    /// A session's wake-ups wait while it's archived, and come back with it.
    func archived(_ session: Session, _ isArchived: Bool) async {
        let owner = Self.owner(of: session)
        if owner.machine == nil, !FileManager.default.fileExists(atPath: owner.folder) { return }
        try? await setPaused(isArchived, owner, byArchiving: true)
    }

    /// A conversation that carries on in another session (moved to the coding agents): its
    /// wake-ups and watches go with it, held still if you'd held them, rather than staying with
    /// the old one, which goes to Archived and holds them there.
    static func carry(from old: Session, to new: Session) async {
        let from = owner(of: old), to = owner(of: new)
        guard from.folder != to.folder, from.machine == to.machine else { return }
        let directory = RemoteFolder.parse(to.directory)?.path ?? to.directory
        if let machine = from.machine {
            let source = shell(from.folder), target = shell(to.folder)
            let via = to.agents ? "printf bridge >\(target)/via" : "rm -f \(target)/via"
            let script = "[ -f \(source)/session ] && [ ! -e \(target) ] && mv \(source) \(target) && printf '%s' \(SSHConnection.quoted(to.session)) >\(target)/session && printf '%s' \(SSHConnection.quoted(directory)) >\(target)/directory && \(via); true"
            _ = await Task.detached { RemoteShell.run(script, on: machine) }.value
            return
        }
        let manager = FileManager.default
        guard manager.fileExists(atPath: path(from, "session")), !manager.fileExists(atPath: to.folder),
              (try? manager.moveItem(atPath: from.folder, toPath: to.folder)) != nil else { return }
        try? Data(to.session.utf8).write(to: URL(filePath: path(to, "session")))
        try? Data(directory.utf8).write(to: URL(filePath: path(to, "directory")))
        if to.agents { try? Data("bridge".utf8).write(to: URL(filePath: path(to, "via"))) } else { try? manager.removeItem(atPath: path(to, "via")) }
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

    // MARK: Sending them

    /// Sends this Mac's wake-ups as they come due, while the app runs; ones missed while it wasn't
    /// running go as soon as it is. (A machine's engine sends its own.)
    func start() {
        guard waking == nil else { return }
        try? Self.installCommand()
        waking = Task { [weak self] in
            var first = true
            while !Task.isCancelled {
                await self?.beforeRound?(first)
                first = false
                self?.watchDue()
                await self?.wakeDue()
                // On time: up to the next one due here, at most 20 seconds (5 at least while the
                // engine isn't up, as nothing can go).
                let next = self?.nextLocalWake().map { $0.timeIntervalSinceNow } ?? 20
                let least = self?.app?.api == nil ? 5.0 : 0.5
                try? await Task.sleep(for: .seconds(min(20, max(least, next))))
            }
        }
    }

    /// Wake-ups on this Mac that didn't go, by owner and file: when to try again, and how many
    /// times in a row they failed, so one that keeps failing is tried less and less often.
    @ObservationIgnored private var retries: [String: (at: Date, failures: Int)] = [:]
    /// How long a wake-up that has nowhere to go waits before it's tried again.
    static let unreachableRetry: TimeInterval = 30

    /// Sends this Mac's wake-ups that have come due: a round of `start`'s.
    func wakeDue() async {
        await adoptStrays()
        for owner in localOwners() where !FileManager.default.fileExists(atPath: Self.pauseFile(of: owner)) {
            let pending = Self.localWakes(of: owner)
            let due = pending.filter { $0.due <= .now && retries[owner.key + "/" + $0.id].map { $0.at <= .now } != false }
            if !due.isEmpty, let api = api(for: owner) {
                if !owner.agents { await api.waitForTools(in: owner.directory) }
                for wake in due { await send(wake, of: owner, api: api) }
            } else if !due.isEmpty, app?.api != nil {
                // Where it runs can't be reached while the engine is up (the coding agents' bridge
                // is down): tried again in a while, rather than every half second meanwhile.
                for wake in due {
                    let key = owner.key + "/" + wake.id
                    retries[key] = (Date.now.addingTimeInterval(Self.unreachableRetry), retries[key]?.failures ?? 0)
                }
            }
            let left = Self.localWakes(of: owner)
            if wakes[owner.key] != left { wakes[owner.key] = left }
            for key in retries.keys where key.hasPrefix(owner.key + "/") && !left.contains(where: { owner.key + "/" + $0.id == key }) {
                retries[key] = nil
            }
        }
    }

    private func send(_ wake: Wakes.Pending, of owner: Owner, api: OpenCodeAPI) async {
        // Moving to another computer: it comes there, at its time.
        guard !Moves.isFrozen(owner.session), !Moves.isFrozen(owner.key) else { return }
        let key = owner.key + "/" + wake.id
        do {
            // One that repeats and still waits from last time (busy, or waiting on you) isn't
            // queued again: it just comes back at its next time.
            let text = Wakes.marker + wake.note
            var waiting = false
            if wake.every != nil, let queued = try? await api.inbox(session: owner.session) { waiting = queued.contains { $0.text == text } }
            if !waiting {
                try await api.prompt(session: owner.session, id: Identifier.message(), text: text, delivery: .queue)
                Analytics.shared.track(owner.isBot ? "bot_wakeup_ran" : "session_wakeup_ran", ["kind": "wake", "repeats": wake.every != nil])
            }
            retries[key] = nil
            // Sent: one that repeats comes back at its next time; others are done.
            let folder = Self.path(owner, "wakes") as NSString
            if let next = wake.nextID() {
                try? FileManager.default.moveItem(atPath: folder.appendingPathComponent(wake.id), toPath: folder.appendingPathComponent(next))
            } else {
                try? FileManager.default.removeItem(atPath: folder.appendingPathComponent(wake.id))
            }
        } catch {
            if await gone(error, owner) { return }
            // Again in a minute, then 2, 4… up to half an hour.
            let failures = (retries[key]?.failures ?? 0) + 1
            retries[key] = (.now.addingTimeInterval(min(1800, 60 * pow(2, Double(failures - 1)))), failures)
            log.error("A wake-up for \(owner.key, privacy: .public) didn't go: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// When the next wake-up on this Mac can go: not a paused one's, and one that didn't go at
    /// its next try.
    private func nextLocalWake() -> Date? {
        localOwners().filter { !FileManager.default.fileExists(atPath: Self.pauseFile(of: $0)) }
            .flatMap { owner in (wakes[owner.key] ?? []).map { wake in max(wake.due, retries[owner.key + "/" + wake.id]?.at ?? wake.due) } }
            .min()
    }

    /// This Mac's watches, run while the app does, beside the wake-ups (so a slow check never
    /// holds one up): what changed wakes the conversation, and one that can't go is tried again
    /// at its next check.
    @ObservationIgnored private var watching: Task<Void, Never>?

    private func watchDue() {
        guard watching == nil, app != nil else { return }
        watching = Task { [weak self] in
            guard let self else { return }
            for owner in localOwners() where !FileManager.default.fileExists(atPath: Self.pauseFile(of: owner)) {
                guard FileManager.default.fileExists(atPath: Self.path(owner, "watches")), let api = api(for: owner) else { continue }
                for letters in Wakes.changedWatches(in: await run([owner.folder, "check"], stopAfter: 300)) {
                    guard let message = Wakes.watchMessage(letters, inBot: owner.folder) else { continue }
                    if !owner.agents { await api.waitForTools(in: owner.directory) }
                    // Moving to another computer: what it saw goes there, with its watch.
                    guard !Moves.isFrozen(owner.session), !Moves.isFrozen(owner.key) else { continue }
                    do {
                        try await api.prompt(session: owner.session, id: Identifier.message(), text: Wakes.marker + message, delivery: .queue)
                        Wakes.watchDelivered(letters, inBot: owner.folder)
                        Analytics.shared.track(owner.isBot ? "bot_wakeup_ran" : "session_wakeup_ran", ["kind": "watch", "repeats": true])
                    } catch {
                        if await gone(error, owner) { break }
                        log.error("A watch's wake-up for \(owner.key, privacy: .public) didn't go: \(error.localizedDescription, privacy: .public)")
                    }
                }
            }
            watching = nil
        }
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

    /// Gives a machine this copy's kuvo-wake, once a run of the app (an engine started before has
    /// an older one, which its watchdog runs), and your time zone for its sessions' wake-ups, in
    /// the folder above theirs, whenever it changes.
    func share(with engine: MachineEngine) async {
        let machine = engine.machine.id
        let zone = TimeZone.current.identifier
        guard shared[machine] != zone else { return }
        try? await Wakes.install(on: engine.machine.connection)
        let root = Self.shell(Self.machineRoot)
        var script = "mkdir -p \(root) && printf '%s' \(SSHConnection.quoted(zone)) >\(root)/timezone"
        if let rules = Self.zoneRules(zone) {
            script += " && { printf '%s' \(SSHConnection.quoted(rules.base64EncodedString())) | base64 -d >\(root)/zoneinfo 2>/dev/null || rm -f \(root)/zoneinfo; }"
        }
        if await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value != nil { shared[machine] = zone }
        await readSessions(on: machine)
    }

    /// The wake-ups of a machine's sessions that keep some, read as it connects: the sidebar's
    /// signs, and the phone's Now and Cancel, have them without their conversations being opened.
    private func readSessions(on machine: String) async {
        let script = "for f in \(Self.shell(Self.machineRoot))/ses_*/session; do [ -f \"$f\" ] && cat \"$f\" && echo; done; true"
        guard let output = await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value else { return }
        for id in String(decoding: output, as: UTF8.self).split(separator: "\n").map(String.init) where id.hasPrefix("ses_") {
            if let session = app?.workspace.session(id), RemoteFolder.machine(of: session.location.directory) == machine { await read(Self.owner(of: session)) }
        }
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
