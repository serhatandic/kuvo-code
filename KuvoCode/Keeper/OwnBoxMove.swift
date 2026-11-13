import Foundation
import OpenCodeKit
import ServiceManagement
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "own-box")

/// The keeper's part in this Mac's box moving out of the app's folder into a home of its own,
/// `~/.kuvo-code` (#333 piece 5; KuvoLink's PROTOCOL.md, "Moving this Mac's box"), behind
/// `movesOwnBox`. The box decides and does every step (`kuvo-link.js rehome`, its state in
/// `updates/rehome`); the keeper does only what needs the old box stopped or the app's own identity:
///
/// 1. asks the box whether to move now (`rehome --ready`, at a quiet moment, as the box says);
/// 2. stops the old box, holding its lock, so the app starts none meanwhile;
/// 3. copies the app's Keychain items for the box's helper (`KeychainMove`), and has the helper read
///    them back (`keys check`);
/// 4. runs the move (`rehome --release`);
/// 5. moved: puts the helper's launch agent in place and has launchd start it (the box runs in its
///    home from then on), deletes the Keychain's originals and unregisters its own launch agent,
///    settling each the box says it owes (`--settled`), and retires;
/// 6. not moved: has the helper take its copies away again, and starts the old box as it was.
///
/// After a crash at any step, the next keeper finishes it before anything else (`settle`), writing
/// nothing in the app's folder first: a move stopped part way, back or on (`rehome --resume`); one
/// that's done, what's owed and its retiring; copies made for a move that never ran, taken away.
@MainActor
final class OwnBoxMove {
    /// What only the app's own program does for the move: its Keychain items and its launch agent
    /// (tests' stand-ins: never your Keychain or launchd).
    struct Identity {
        /// The app's Keychain items copied under the helper's names, trusting only the helper,
        /// journaled first (`KeychainMove.copy`).
        var copyKeys: () throws -> Void
        /// Whether copies are there for a move that hasn't finished (the journal `copying` or `copied`).
        var copiesLeft: () -> Bool
        /// One of the helper's own short runs on the box's keys (`keys check|uncopy|clear`): nil
        /// once done, else why not. Only a program an item names may read it or take it away.
        var helper: (_ keys: String) async -> String?
        /// The Keychain's originals taken away, once the move can't go back (`deleteOriginals`).
        var deleteOriginals: () throws -> Void
        /// Its own launch agent unregistered (`SMAppService`): nil once done, else why not.
        var unregister: () async -> String?
    }

    /// What the keeper does next.
    enum Next: Equatable {
        /// Start the box in the app's folder, as it was (nothing moved, or it went back).
        case startOld
        /// It moved: everything owed is done, and the keeper goes for good.
        case retire
        /// Start nothing: a move holds on (stuck part way, another holds its lock, or what's owed
        /// can't be done yet), looked at again later.
        case wait
    }

    /// The machines' folder's name in `home` (`.kuvo-code`, a test's own), the home folder it's in,
    /// the app's own box (`<app folder>/box`) and its engine's data.
    let root: String
    let home: URL
    let appBox: URL
    let engineData: URL
    var folder: URL { home.appending(path: root, directoryHint: .isDirectory) }
    /// The engine whose Bun runs the box's CLI: the app's, or once it has moved, the box's.
    let engine: () async -> URL?
    /// The box's CLI this app brings (`kuvo-link.js`).
    let script: URL?
    /// The app's bundle ID and version, as the box's served record says them.
    let appID: String
    let appVersion: String
    /// Keep This Mac Awake off in the app.
    let keepsAwakeOff: () -> Bool
    let identity: Identity
    /// The box's own files for its new home (with the helper), made in a folder of their own, which
    /// is removed once the move's done with it.
    let release: () throws -> URL
    /// More the box's CLI is run with (a test's stand-ins for launchctl).
    var environment: [String: String] = [:]

    #if DEBUG
    /// Tests: the keeper stopped at one of its own steps, as a kill would: nothing after it done,
    /// nothing undone.
    nonisolated(unsafe) static var stopsAt: Step?
    #endif

    /// The keeper's own steps in a move, for a test to stop it at.
    enum Step: String, Sendable {
        case stopped, copied, checked, moved, helperLoaded, originalsDeleted
    }

    init(root: String, home: URL, appBox: URL, engineData: URL, engine: @escaping () async -> URL?, script: URL?, appID: String, appVersion: String,
         keepsAwakeOff: @escaping () -> Bool, identity: Identity, release: @escaping () throws -> URL) {
        self.root = root
        self.home = home
        self.appBox = appBox
        self.engineData = engineData
        self.engine = engine
        self.script = script
        self.appID = appID
        self.appVersion = appVersion
        self.keepsAwakeOff = keepsAwakeOff
        self.identity = identity
        self.release = release
    }

    /// This Mac's, with `movesOwnBox` on (else nil, and nothing about it changes): the real
    /// `~/.kuvo-code` for the real app alone (a copy's own folder, `Here.root`; none, none).
    static func forThisMac() -> OwnBoxMove? {
        guard AppModel.movesOwnBox, let root = Here.root else { return nil }
        let support = AppInfo.supportDirectory
        let home = AppModel.hereHome
        let folder = home.appending(path: root, directoryHint: .isDirectory)
        return OwnBoxMove(
            root: root, home: home, appBox: BoxProcess.home, engineData: AppModel.engineFolders.dataDirectory,
            engine: {
                if let override = AppModel.engineOverride { return URL(filePath: override) }
                // (Checking its signature reads all of it, a second or so: off the main thread.)
                return await Task.detached {
                    if let installed = EngineInstaller(root: support.appending(path: "engine")).installed() { return installed }
                    // (Moved, the engine went with the box: still the build Kuvo Code pins.)
                    let moved = folder.appending(path: "engine/\(OpenCodeEngine.version)/opencode")
                    return EngineInstaller.isPinnedBuild(moved) ? moved : nil
                }.value
            },
            script: BoxProcess.script, appID: AppInfo.bundleID, appVersion: AppInfo.version,
            keepsAwakeOff: { !Awake.isOn }, identity: .live(folder: folder), release: { try OwnBoxMove.makeRelease(root: root) })
    }

    // MARK: The box's CLI

    /// What the box's CLI said: its exit status (nil: it didn't end by itself) and its last line's JSON.
    struct Said {
        var status: Int32?
        var answer: [String: Any]
        var errors: String

        var result: String? { answer["result"] as? String }
        var status_: [String: Any] { answer["status"] as? [String: Any] ?? [:] }
    }

    /// `kuvo-link.js <arguments>`, this app's own, by the engine's Bun, as `here` is asked: with
    /// `KUVO_HOME` the app's own box's folder, or (`ofHome`) the box's home.
    func box(_ arguments: [String], ofHome: Bool = false, limit: Duration = .seconds(120)) async -> Said? {
        guard let engine = await engine(), let script else {
            log.error("The box's CLI can't run: \(self.script == nil ? "its script is missing" : "no engine", privacy: .public)")
            return nil
        }
        var env = ["HOME": home.path(percentEncoded: false), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "BUN_BE_BUN": "1", "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
                   "KUVO_HOME": ofHome ? folder.path(percentEncoded: false) : appBox.path(percentEncoded: false),
                   "KUVO_ENGINE_DATA": engineData.path(percentEncoded: false), "KUVO_APP_VERSION": appVersion,
                   "TMPDIR": FileManager.default.temporaryDirectory.path(percentEncoded: false)]
        env.merge(environment) { $1 }
        do {
            let result = try await ChildProcess.run(engine.path(percentEncoded: false), ["run", "--config=/dev/null", "--no-env-file", script.path(percentEncoded: false)] + arguments,
                                                    environment: env, directory: home, limit: limit, cancellable: false)
            let line = result.outputText.split(separator: "\n").last.map(String.init) ?? ""
            let answer = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] ?? [:]
            let ended = !result.timedOut && result.reason == .exit
            if !ended || answer.isEmpty {
                log.error("kuvo-link.js \(arguments.first ?? "", privacy: .public) \(arguments.dropFirst().first ?? "", privacy: .public) didn't answer (\(result.status)): \(result.errorText.suffix(300), privacy: .public)")
            }
            return Said(status: ended ? result.status : nil, answer: answer, errors: result.errorText)
        } catch {
            log.error("The box's CLI didn't run: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func rehome(_ arguments: [String], limit: Duration = .seconds(120)) async -> Said? {
        await box(["rehome", root] + arguments, limit: limit)
    }

    // MARK: Asked

    /// Whether the box says to move now (or to finish one), asked with the old box running.
    func isDue(release: URL? = nil) async -> Bool {
        guard let said = await rehome(["--ready"] + (release.map { ["--release", $0.path(percentEncoded: false)] } ?? [])) else { return false }
        let how = said.answer["how"] as? String
        if said.answer["ready"] as? Bool != true, let why = said.answer["why"] as? String { log.info("Not moving yet: \(why, privacy: .public)") }
        return said.answer["ready"] as? Bool == true && (how == "move" || how == "resume")
    }

    /// The box's own files for its home, made once the box says to move now, and checked by the box
    /// with them (its helper among them: never moved where nothing would start it), all with the old
    /// box running: nil while it isn't time (nothing counted), or the release couldn't be made
    /// (counted as a try). The move removes it once it's done with it.
    func due() async -> URL? {
        guard await isDue() else { return nil }
        let release: URL
        do {
            release = try self.release()
        } catch {
            await gaveUp("The box's files for its home weren't made: \(error.localizedDescription)")
            return nil
        }
        guard await isDue(release: release) else {
            try? FileManager.default.removeItem(at: release)
            return nil
        }
        return release
    }

    /// The move's state as the box keeps it (`state.json`), as the files say without asking the box
    /// (no engine to run its CLI yet): whether one is under way or done.
    private var underWayOnDisk: Bool {
        let rehome = folder.appending(path: "updates/rehome")
        guard let data = try? Data(contentsOf: rehome.appending(path: "journal.json")) else {
            return FileManager.default.fileExists(atPath: rehome.appending(path: "journal.json").path(percentEncoded: false))
        }
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["step"] as? String != "done"
    }

    private var movedOnDisk: Bool {
        guard let data = try? Data(contentsOf: folder.appending(path: "updates/rehome/state.json")),
              let state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        return state["state"] as? String == "done" && state["way"] as? String == "move"
    }

    // MARK: Settling

    /// What a keeper does as it starts, before it writes anything in the app's folder: a move stopped
    /// part way finished (back or on), one that's done finished off (what's owed, then it retires),
    /// and copies of the app's keys for a move that never ran taken away. Then what's next.
    func settle() async -> Next {
        guard let said = await rehome(["--status"]), said.status == 0, !said.answer.isEmpty else {
            // (Its CLI can't run yet, no engine, or it didn't answer: a move the files say is under
            // way or done, or a box there, waits for it; nothing starts meanwhile.)
            return underWayOnDisk || movedOnDisk || OwnBoxHome.kind(in: folder) == "mac" ? .wait : .startOld
        }
        let state = said.answer["state"] as? String
        // (A journal there, read or not, is a move under way: the box says `moving` or `clearing`.)
        if state == "moving" || state == "clearing" { return await resume() }
        if state == "done", said.answer["way"] as? String == "move" { return await finish(owed: said.answer["owed"] as? [String] ?? []) }
        // A new Mac's box made there, with nothing moved, as the box says: its helper starts it,
        // never this keeper (switched off in Login Items, its helper stays off).
        if state == nil {
            // (One that can't say: nothing started meanwhile, rather than a second box.)
            guard let made = await rehome(["--new", "--check"])?.answer["made"] as? Bool else { return .wait }
            if made { return await finish(owed: [], helperOnlyIfMissing: true) }
        }
        return await wentBack()
    }

    /// A move stopped part way, finished by the box (`--resume`): back before it cleared the old
    /// place, on from there.
    private func resume() async -> Next {
        log.notice("A move of this Mac's box stopped part way: finishing it")
        guard let said = await rehome(["--resume"], limit: .seconds(8 * 3600)) else { return .wait }
        return await after(said)
    }

    /// Why the move holds on, as the box last said it (stuck part way, or another holding its lock).
    private(set) var holdsOnBecause: String?

    /// How a move under way stands for the app while the keeper can't say (none runs): why it holds
    /// on where it went wrong part way, "" while it just moves, nil with none under way.
    func movingNow() async -> String? {
        guard let said = await rehome(["--status"]), said.status == 0 else { return underWayOnDisk ? "" : nil }
        guard ["moving", "clearing"].contains(said.answer["state"] as? String ?? "") else { return nil }
        return (said.answer["failed"] as? [String: Any])?["message"] as? String ?? ""
    }

    /// What the box's `rehome` said it did, acted on.
    private func after(_ said: Said) async -> Next {
        let next = await acted(said)
        if next != .wait { holdsOnBecause = nil }
        return next
    }

    private func acted(_ said: Said) async -> Next {
        switch said.result {
        case "done":
            return await finish(owed: said.status_["owed"] as? [String] ?? [])
        case "failed", "refused", "nothing":
            if let message = said.answer["message"] as? String { log.notice("This Mac's box didn't move: \(message, privacy: .public)") }
            // (A move that never was, or went back: the box where it was; moved already, finished off.)
            if said.status_["state"] as? String == "done", said.status_["way"] as? String == "move" {
                return await finish(owed: said.status_["owed"] as? [String] ?? [])
            }
            return await wentBack()
        case "back":
            // (Moved back, Move Back: the box is in the app's folder again, as it was.)
            return await wentBack()
        case "stuck", "waits":
            holdsOnBecause = said.answer["message"] as? String
            log.error("This Mac's box's move holds on: \(self.holdsOnBecause ?? "", privacy: .public)")
            return .wait
        default:
            // (Cut off, or what it said can't be read: as the box has it now.)
            return said.status == nil || said.answer.isEmpty ? await settleAgain() : .wait
        }
    }

    /// Once more, after a `rehome` that didn't say how it ended (stopped part way): never in a loop.
    private var settledAgain = false
    private func settleAgain() async -> Next {
        guard !settledAgain else { return .wait }
        settledAgain = true
        defer { settledAgain = false }
        return await settle()
    }

    /// Not moved (never, or gone back): copies of the app's keys a try made, taken away by the
    /// helper (the originals were never touched); the old box starts as it was.
    private func wentBack() async -> Next {
        if identity.copiesLeft(), let why = await identity.helper("uncopy") {
            // (They stay, harmless: the next try takes them away first.)
            log.error("The copies of this Mac's keys weren't taken away: \(why, privacy: .public)")
        }
        return .startOld
    }

    /// Moved: what the box says the app's program still owes, done, each settled once it is, then
    /// this keeper unregistered (whatever's owed: launchd starting it again would only retire it
    /// again). The helper starts the box first, so it runs again as soon as it can.
    private func finish(owed: [String], helperOnlyIfMissing: Bool = false) async -> Next {
        guard await helperRuns(onlyIfMissing: helperOnlyIfMissing) else { return .wait }
        if stop(.helperLoaded) { return .wait }
        if owed.contains("keychain") {
            do {
                try identity.deleteOriginals()
            } catch {
                // (Locked, say: tried again later. The box runs meanwhile, from the helper's copies.)
                log.error("Kuvo Code's own copies of this Mac's keys weren't deleted: \(error.localizedDescription, privacy: .public)")
                return .wait
            }
            if stop(.originalsDeleted) { return .wait }
            guard await settled("keychain") else { return .wait }
        }
        // (Said before it goes, as unregistering ends this process: one that fails is tried again,
        // from the next start, which unregisters whatever's owed.)
        if owed.contains("agent") { guard await settled("agent") else { return .wait } }
        if let why = await identity.unregister() {
            log.error("The keeper's launch agent wasn't unregistered: \(why, privacy: .public)")
            return .wait
        }
        log.notice("This Mac's box runs in its own home now: the keeper retires")
        return .retire
    }

    /// What's owed, settled with the box: whether it says so (or it wasn't owed any more).
    private func settled(_ what: String) async -> Bool {
        guard let said = await rehome(["--settled", what]), said.status == 0 else {
            log.error("The box wasn't told \(what, privacy: .public) is settled: tried again later")
            return false
        }
        return !((said.status_["owed"] as? [String])?.contains(what) ?? true)
    }

    /// A try given up on before the box's move began, counted by the box as its own refusals are,
    /// so it waits before the next (and after three, for Move Now).
    private func gaveUp(_ why: String) async {
        log.error("This Mac's box didn't move: \(why, privacy: .public)")
        _ = await rehome(["--failed", why])
    }

    /// The helper's launch agent in place and loaded, so launchd starts the box in its home now and
    /// at each login: whether it is. One loaded already is left running; `onlyIfMissing`, one in
    /// place at all is left as it is (switched off in Login Items, it stays off).
    private func helperRuns(onlyIfMissing: Bool = false) async -> Bool {
        if let status = await box(["helper", "status"], ofHome: true), status.answer["agent"] as? Bool == true {
            if onlyIfMissing { return true }
            // Loaded already: started if it isn't running (one that found the box moving went, and
            // launchd leaves it so), left as it is if it is.
            if status.answer["loaded"] as? Bool == true {
                guard let said = await box(["helper", "start"], ofHome: true), said.status == 0 else {
                    log.error("Kuvo Code Box wasn't started for this Mac's box: tried again later")
                    return false
                }
                return true
            }
        }
        guard let said = await box(["helper", "install", "--load", "--app", appID], ofHome: true), said.status == 0 else {
            log.error("Kuvo Code Box wasn't started for this Mac's box: tried again later")
            return false
        }
        return true
    }

    // MARK: A new Mac

    /// A new Mac's box (no box of the app's ever ran in its folder, and none in its home), made in
    /// its home of its own from the start by the box (`rehome --new`), with nothing to move, and its
    /// helper's launch agent put in place and loaded, so it runs there now and at each login. The
    /// app's, as it opens. Whether this Mac's box is in its home now, its helper there to start it.
    func makeNew() async -> Bool {
        // The box says whether it's made already, or could be now (never while a move's under way,
        // whose kind it writes before it's done), before its files are made for it.
        guard let asked = await rehome(["--new", "--check"]), let made = asked.answer["made"] as? Bool else { return false }
        // (As the box says it, once it has: never cleared while it's asked.)
        BackgroundWork.boxStartsOnItsOwn = made
        // Made already (a start cut short before its helper was put in place: put there now; one in
        // place is left as it is, switched off in Login Items say).
        if made { return await helperRuns(onlyIfMissing: true) }
        guard asked.answer["ready"] as? Bool == true else { return false }
        let release: URL
        do {
            release = try self.release()
        } catch {
            log.error("The box's files for its home weren't made: \(error.localizedDescription, privacy: .public)")
            return false
        }
        defer { try? FileManager.default.removeItem(at: release) }
        guard let said = await rehome(["--new", "--release", release.path(percentEncoded: false)] + (keepsAwakeOff() ? ["--keeps-awake", "off"] : [])),
              said.result == "done" || said.result == "nothing" else { return false }
        log.notice("This Mac's box is made in its own home")
        BackgroundWork.boxStartsOnItsOwn = true
        return await helperRuns()
    }

    // MARK: Moving

    /// The move with `release` (`due`), the old box stopped (its lock still held): what's next.
    func move(_ release: URL) async -> Next {
        defer { try? FileManager.default.removeItem(at: release) }
        holdsOnBecause = nil
        if stop(.stopped) { return .wait }
        // Copies an earlier try left, taken away first: a copy starts afresh.
        if identity.copiesLeft(), let why = await identity.helper("uncopy") {
            await gaveUp("An earlier try's copies of this Mac's keys couldn't be taken away: \(why)")
            return .startOld
        }
        do {
            do {
                try identity.copyKeys()
            } catch KeychainMove.Failure.leftovers(let item) {
                // Left by a box removed or set aside: taken away where the app has its own, once.
                log.notice("Items an earlier box left under the helper's names (\(item, privacy: .public)): taken away first")
                if let why = await identity.helper("clear") { throw KeychainMove.Failure.journal(why) }
                try identity.copyKeys()
            }
        } catch {
            await gaveUp("This Mac's keys weren't copied for its box: \(error.localizedDescription)")
            return await wentBack()
        }
        if stop(.copied) { return .wait }
        if let why = await identity.helper("check") {
            await gaveUp("Kuvo Code Box couldn't read its copies of this Mac's keys: \(why)")
            return await wentBack()
        }
        if stop(.checked) { return .wait }
        log.notice("Moving this Mac's box into its own home")
        guard let said = await rehome(["--release", release.path(percentEncoded: false)] + (keepsAwakeOff() ? ["--keeps-awake", "off"] : []),
                                      limit: .seconds(8 * 3600)) else { return await wentBack() }
        if stop(.moved) { return .wait }
        return await after(said)
    }

    /// Whether a test stops the keeper here.
    private func stop(_ step: Step) -> Bool {
        #if DEBUG
        if Self.stopsAt == step {
            log.notice("Stopped at \(step.rawValue, privacy: .public), as a test asks")
            return true
        }
        #endif
        return false
    }

    // MARK: One keeper at a time

    /// Held by the keeper that settles or moves this Mac's box, for as long as it runs (a second, the
    /// app kickstarting it while launchd has, goes): in the app's caches, never the box's folder in
    /// the app's, which a moved box's keeper mustn't make again. Its descriptor, or nil while another
    /// holds it.
    static func takeLock() -> Int32? {
        // (The tests' own, in their folder.)
        let folder = AppInfo.isHostingTests ? AppInfo.testRoot : URL.cachesDirectory.appending(path: AppInfo.bundleID, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let lock = open(folder.appending(path: "keeper-move.lock").path(percentEncoded: false), O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard lock >= 0 else { return nil }
        guard flock(lock, LOCK_EX | LOCK_NB) == 0 else {
            close(lock)
            return nil
        }
        return lock
    }

    // MARK: The real thing

    /// The box's own files for its home, as a release brings them (`BoxRelease`, as the release
    /// workflow writes them), with the helper this app carries, in the app's temporary folder.
    static func makeRelease(root: String) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "kuvo-box-release-\(UUID().uuidString)", directoryHint: .isDirectory)
        do {
            try RemoteEngineInstaller.$scopedRoot.withValue(root) { try BoxRelease.write(to: folder) }
            let helper = BoxHelperBundle.bundled(in: Bundle.main.bundleURL)
            if FileManager.default.fileExists(atPath: helper.path(percentEncoded: false)) {
                try FileManager.default.copyItem(at: helper, to: BoxHelperBundle.installed(in: folder))
            }
            return folder
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
    }
}

extension OwnBoxMove.Identity {
    /// The app's own: its Keychain items (this program is in each original's list), the helper it
    /// carries (`Contents/Helpers`, which the copies trust and whose short runs check and take them
    /// away), and its own launch agent.
    @MainActor static func live(folder: URL) -> Self {
        let move = KeychainMove(home: folder, app: AppInfo.bundleID, helper: BoxHelperBundle.helperID(ofApp: AppInfo.bundleID))
        let helper = BoxHelperBundle.bundled(in: Bundle.main.bundleURL)
        return Self(
            copyKeys: { try move.copy(trusting: helper) },
            copiesLeft: { [.copying, .copied].contains((try? move.journal())?.state) },
            helper: { keys in
                do {
                    let result = try await ChildProcess.run(BoxHelperBundle.executable(of: helper).path(percentEncoded: false), ["keys", keys, "--home", folder.path(percentEncoded: false)],
                                                            limit: .seconds(60), cancellable: false)
                    return result.succeeded ? nil : (result.errorText.isEmpty ? result.outputText : result.errorText).trimmingCharacters(in: .whitespacesAndNewlines)
                } catch {
                    return error.localizedDescription
                }
            },
            deleteOriginals: { try move.deleteOriginals() },
            unregister: {
                let service = SMAppService.agent(plistName: BackgroundWork.plistName)
                do {
                    try await service.unregister()
                    return nil
                } catch {
                    // (Gone already, taken away in Login Items say: done.)
                    return service.status == .notRegistered || service.status == .notFound ? nil : error.localizedDescription
                }
            })
    }
}
