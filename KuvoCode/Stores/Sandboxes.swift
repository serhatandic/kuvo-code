import ClientSandbox
import Foundation
import OpenCodeKit

/// The commands each computer's agents ask to run outside its sandbox (KuvoLink's PROTOCOL.md,
/// "Sandbox"), as the Mac app shows and answers them: what its box lists, by box (`BoxClient.mac`,
/// or a machine's id).
@MainActor
@Observable
final class Sandboxes {
    static let shared = Sandboxes()

    /// Each box's open asks, oldest first.
    private(set) var asks: [String: [SandboxAsk]] = [:]
    /// Asks being answered here: their cards wait, and a second click is left alone.
    private(set) var answering: Set<String> = []
    /// Why an answer didn't go through, by ask: its card says so, to try again.
    private(set) var failures: [String: String] = [:]
    /// Boxes whose asks have been heard since they were last reached: until then, what they ask is
    /// unknown, not nothing.
    private(set) var heard: Set<String> = []
    /// Reaches a box (`AppModel.box`), set as the app starts.
    @ObservationIgnored var client: (String) -> BoxClient? = { _ in nil }
    /// Asks answered here: closed on their box, so a list it sent before the answer doesn't bring
    /// them back.
    @ObservationIgnored private var answered: Set<String> = []
    /// Boxes asking you, once, to restart their agents started before the sandbox was on: a card
    /// in each of their conversations, until it's answered here or elsewhere.
    private(set) var restarting: Set<String> = []
    /// Boxes whose restart is being answered here, or was: the card's gone, whatever the box still
    /// lists until it hears.
    @ObservationIgnored private var restartAnswered: Set<String> = []
    /// Why the answer to a box's restart didn't go through.
    private(set) var restartFailures: [String: String] = [:]
    /// Each conversation's commands whose asks were seen open and then closed (answered here or
    /// elsewhere), by box and conversation: only those may be running outside the sandbox.
    private(set) var released: [String: Set<String>] = [:]
    /// How Auto's reviewer takes up asks to work outside a folder, by box and ask.
    private(set) var reviews: [String: [String: AskReview]] = [:]
    /// Boxes whose word on them is whole (`sandbox.reviews.whole`): one they haven't listed isn't
    /// yours yet. This Mac's box is this app's version; a machine's says so in its `kuvo/info`.
    private(set) var listAll: Set<String> = [BoxClient.mac]
    /// Boxes that list the asks their reviewer took up to their end (`sandbox.reviews.settled`):
    /// answered or gone, so nothing of them is kept here. This Mac's box is this app's version; a
    /// machine's says so in its `kuvo/info`.
    private(set) var settling: Set<String> = [BoxClient.mac]
    /// Machines whose `kuvo/info` was read for it on this connection.
    @ObservationIgnored private var featuresRead: Set<String> = []
    /// Told when its box lists an ask as yours (one held back meanwhile), for its notification;
    /// nil when every one held back is to be looked at again (a box whose word isn't whole).
    @ObservationIgnored var onYours: ((String?) -> Void)?
    /// Told when its box lists an ask its reviewer took up as over (answered or gone), so nothing
    /// says it waits on you, though its answer or its run's end wasn't heard here.
    @ObservationIgnored var onOver: ((String) -> Void)?

    /// A conversation's open asks, on its box.
    func asks(for session: String, on box: String) -> [SandboxAsk] {
        #if DEBUG
        if let demo = Self.demo { return demo.map { var ask = $0; ask.session = session; return ask }.filter { !answered.contains($0.id) } }
        #endif
        return (asks[box] ?? []).filter { $0.session == session }
    }

    #if DEBUG
    /// KUVO_DEMO_SANDBOX_ASK: sample asks over every conversation's composer, for a look at the
    /// card, comma-separated: `write` (a Mac's, with Always), `linux` (a machine's error), `long` (a
    /// long command and path), `app` (not a file), `waiting` (a bot's, 12 minutes on).
    static let demo: [SandboxAsk]? = ProcessInfo.processInfo.environment["KUVO_DEMO_SANDBOX_ASK"].map { kinds in
        let now = Date().timeIntervalSince1970 * 1000
        let home = NSHomeDirectory()
        return kinds.split(separator: ",").map(String.init).enumerated().compactMap { index, kind in
            let id = "demo_\(index)"
            switch kind {
            // (Always only where the box would give it: never a file it keeps closed, like ~/.zshrc.)
            case "write": return SandboxAsk(id: id, at: now, botName: "Scout", project: home + "/kuvo-ai", command: "npm run build:icons",
                                            why: "The icon tool caches its renders in its own folder.", stopped: [SandboxStop(kind: .write, path: home + "/Library/Caches/icon-gen/renders.db")],
                                            always: .init(path: home + "/Library/Caches/icon-gen"))
            case "waiting": return SandboxAsk(id: id, at: now - 12 * 60_000, botName: "Scout", project: home + "/kuvo-ai", command: "./scripts/install-hooks.sh",
                                              why: "Installing the repo’s hooks, as the README asks.", stopped: [SandboxStop(kind: .write, path: home + "/.zshrc")])
            case "linux": return SandboxAsk(id: id, at: now, botName: "Scout", project: "/home/me/kuvo-ai", command: "./scripts/install-hooks.sh",
                                            why: "Installing the repo’s hooks, as the README asks.", error: "/home/me/.zshrc: Permission denied", machine: "devbox")
            case "long": return SandboxAsk(id: id, at: now, sessionName: "Release the beta", project: home + "/kuvo-ai",
                                           command: "bundle exec fastlane ios beta --env production skip_waiting_for_build_processing:true changelog:\"Fixes the composer, the sidebar and the usage panel\" && ./scripts/notify-team.sh --channel releases",
                                           why: "Fastlane keeps its logs and the build’s metadata in its own folder in your Library, which the sandbox doesn’t let commands write.",
                                           stopped: [SandboxStop(kind: .write, path: home + "/Library/Logs/fastlane/gym/KuvoCodeMobile-KuvoCodeMobile.log")],
                                           always: .init(path: home + "/Library/Logs/fastlane"))
            case "app": return SandboxAsk(id: id, at: now, botName: "Pixel", project: home + "/kuvo-ai", command: "open -a Simulator",
                                          why: "To see the new screen on the simulator.", stopped: [SandboxStop(kind: .app)])
            default: return nil
            }
        }
    }
    #endif

    /// The commands a conversation's open asks are about, which their rows mark stopped; nil
    /// before its box's asks are heard (the app just opened, or the machine's connecting).
    func stoppedCommands(for session: String, on box: String) -> Set<String>? {
        #if DEBUG
        if Self.demo != nil { return Set(asks(for: session, on: box).map(\.command)) }
        #endif
        guard heard.contains(box) else { return nil }
        return Set(asks(for: session, on: box).map(\.command))
    }

    /// The commands a conversation's asks were seen open for and no longer are: allowed (or
    /// refused) and so, while their step goes on, running. One whose ask hasn't been listed yet
    /// isn't among them: its step still asks.
    func releasedCommands(for session: String, on box: String) -> Set<String> {
        released[Self.key(session, on: box)] ?? []
    }

    /// A conversation's key among every box's.
    private static func key(_ session: String, on box: String) -> String { box + "\n" + session }

    private struct Nothing: Decodable {}

    private func ask<T: Decodable>(_ type: T.Type = T.self, _ method: String, _ path: String, body: [String: Any]? = nil, on box: String) async throws -> T {
        guard let client = client(box) else { throw BoxRefusal(status: 503, message: "Kuvo Code isn't ready yet.") }
        let (status, data) = try await client.send(method, path, body: try body.map { try JSONSerialization.data(withJSONObject: $0) })
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// The conversations asking now, for their marks in the sidebar and the Dock's count.
    @ObservationIgnored var onChange: ((Set<String>) -> Void)?
    /// What's been told, so each ask is told once.
    @ObservationIgnored private var told: Set<String> = []
    /// Each box's follow now, so one that ended (a reconnect) leaves the next one's asks alone.
    @ObservationIgnored private var following: [String: UUID] = [:]

    /// Follows `box`'s asks from now on, until the task following it ends (this Mac's box stopping,
    /// a machine disconnecting or removed): this Mac's box tells each change as it's made; a
    /// machine's, reached over SSH, answers once, so it's read again every ten seconds. A box from
    /// before the sandbox's asks stops it.
    func follow(_ box: String) async {
        let me = UUID()
        following[box] = me
        while !Task.isCancelled {
            if let client = client(box) {
                do {
                    // Whether its word on the reviewer's asks is whole: read once a connection.
                    // (Counted once read: one that fails is read again on the next try.)
                    if box != BoxClient.mac, !featuresRead.contains(box) {
                        struct Info: Decodable { var features: [String]? }
                        if let info = try? await client.value(Info.self, "GET", "kuvo/info") {
                            featuresRead.insert(box)
                            takeListsAll(info.features?.contains(AskReview.listsAllFeature) == true, from: box)
                            takeSettles(info.features?.contains(AskReview.settlesFeature) == true, from: box)
                        }
                    }
                    for try await line in client.follow(SandboxRoutes.asks + "/events") {
                        guard let list = try? JSONDecoder().decode(SandboxAsks.self, from: line) else { continue }
                        take(list.asks, from: box)
                        takeRestart(list.restart == true, from: box)
                        take(reviews: list.everyReview, from: box)
                        setLive(true, box)
                    }
                    // This Mac's box tells each change as it comes: its stream over, it's not
                    // telling now. A machine's answers once, and is read again.
                    if box == BoxClient.mac { setLive(false, box) }
                } catch let refusal as BoxRefusal where [404, 405].contains(refusal.status) {
                    return
                } catch {
                    setLive(false, box)
                }
            }
            try? await Task.sleep(for: .seconds(box == BoxClient.mac ? 2 : 10))
        }
        // Gone with its connection: nothing it asks can be answered from here now. What it still
        // asks keeps its notification, and isn't told again when it's back.
        guard following[box] == me else { return }
        following[box] = nil
        featuresRead.remove(box)
        setLive(false, box)
        asks[box] = nil
        heard.remove(box)
        restarting.remove(box)
        released = released.filter { !$0.key.hasPrefix(box + "\n") }
        forgetReviews(of: box)
        changed()
    }

    /// What `box` asks now, in place of what it asked before: each new one told once, and each
    /// gone (answered here or on a phone, or no longer asked) taken off Notification Center.
    func take(_ listed: [SandboxAsk], from box: String) {
        heard.insert(box)
        let listed = listed.filter { !answered.contains($0.id) }
        let before = asks[box] ?? []
        guard listed != before else { return }
        asks[box] = listed.isEmpty ? nil : listed
        for ask in listed where !told.contains(ask.id) {
            told.insert(ask.id)
            tell(ask)
        }
        for gone in before where !listed.contains(where: { $0.id == gone.id }) {
            Notifier.shared.clear(request: gone.id)
            failures[gone.id] = nil
            if let session = gone.session { released[Self.key(session, on: box), default: []].insert(gone.command) }
        }
        changed()
    }

    private func changed() {
        onChange?(Set(asks.values.joined().compactMap(\.session)))
    }

    // Here only: the box tells your phones itself (PROTOCOL.md, "Sandbox").
    private func tell(_ ask: SandboxAsk) {
        Notifier.shared.notify(session: ask.session ?? "", title: ask.title, subtitle: ask.machine, body: ask.command + "\n“\(ask.why)”", ask: ask.id)
    }

    /// Forgets what's shown of `box` (the machine removed from this Mac).
    func forget(_ box: String) {
        for gone in asks[box] ?? [] { Notifier.shared.clear(request: gone.id) }
        asks[box] = nil
        heard.remove(box)
        live.remove(box)
        restarting.remove(box)
        forgetReviews(of: box)
        changed()
    }

    // MARK: Auto's reviewer

    /// Whether a permission its agent asks is yours to answer, as its box says (`AskReview`): its
    /// box's word alone, waiting on nothing of this app's own.
    func isYours(_ request: PermissionRequest, on box: String) -> Bool {
        // Whole only while its asks are heard: its link down, nothing reviews or lists them, and an
        // ask not listed is yours, not hidden.
        AskReview.isYours(action: request.action, review: reviews[box]?[request.id], listsAll: listAll.contains(box), heard: live.contains(box))
    }

    /// Boxes whose asks are being heard now: this Mac's while its stream runs, a machine's while
    /// its last read went through.
    private(set) var live: Set<String> = []

    func setLive(_ isLive: Bool, _ box: String) {
        guard isLive != live.contains(box) else { return }
        if isLive { live.insert(box) } else { live.remove(box) }
        // Not heard now: what was held for its word is looked at again (yours, if not listed).
        if !isLive { onYours?(nil) }
    }

    /// Whether `box`'s word on its reviewer's asks is whole (`sandbox.reviews.whole`).
    func takeListsAll(_ whole: Bool, from box: String) {
        guard whole != listAll.contains(box) else { return }
        if whole { listAll.insert(box) } else { listAll.remove(box) }
        // Not whole: what it hasn't listed is yours now.
        if !whole { onYours?(nil) }
    }

    /// Whether `box` lists the asks its reviewer took up to their end (`sandbox.reviews.settled`).
    func settles(_ box: String) -> Bool { settling.contains(box) }

    func takeSettles(_ settles: Bool, from box: String) {
        if settles { settling.insert(box) } else { settling.remove(box) }
    }

    /// An ask Auto's reviewer took up, as a box last listed it, with that box.
    func review(of id: String) -> (box: String, review: AskReview)? {
        for (box, listed) in reviews { if let review = listed[id] { return (box, review) } }
        return nil
    }

    /// What Auto did with each of `box`'s asks, by the step that asked, for its mark.
    func reviewMarks(on box: String) -> [String: AskReview] {
        Dictionary((reviews[box] ?? [:]).values.compactMap { review in review.call.map { ($0, review) } }, uniquingKeysWith: { $0.at > $1.at ? $0 : $1 })
    }

    /// How `box`'s reviewer takes up asks now (nil: a box from before, which doesn't say). Each
    /// it lists as yours now that wasn't is told (`onYours`), for its notification, and each it
    /// lists as over now (`onOver`).
    func take(reviews listed: [AskReview]?, from box: String) {
        let now = Dictionary((listed ?? []).map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        guard now != reviews[box] ?? [:] else { return }
        let before = reviews[box] ?? [:]
        reviews[box] = now.isEmpty ? nil : now
        for (id, review) in now where review.state == .yours && before[id]?.state != .yours { onYours?(id) }
        for (id, review) in now where [.answered, .gone].contains(review.state) && before[id]?.state != review.state { onOver?(id) }
    }

    private func forgetReviews(of box: String) {
        reviews[box] = nil
    }

    // MARK: Restarting the agents started before the sandbox

    #if DEBUG
    /// KUVO_DEMO_SANDBOX_RESTART=1: every box asks to restart its agents, for a look at the card.
    static let demoRestart = ProcessInfo.processInfo.environment["KUVO_DEMO_SANDBOX_RESTART"] == "1"
    #endif

    /// Whether `box` asks you to restart its agents started before its sandbox was on.
    func asksToRestart(on box: String) -> Bool {
        #if DEBUG
        if Self.demoRestart { return !restartAnswered.contains(box) }
        #endif
        return restarting.contains(box)
    }

    /// Whether `box` asks it now, as its asks say.
    func takeRestart(_ asking: Bool, from box: String) {
        if asking && !restartAnswered.contains(box) { restarting.insert(box) } else { restarting.remove(box) }
    }

    /// Your answer: restart them (each once it finishes what it’s doing) or leave them be. The box asks once,
    /// so the card goes either way, here and on your other devices.
    func answerRestart(_ restart: Bool, on box: String) async throws {
        guard restartAnswered.insert(box).inserted else { return }
        restartFailures[box] = nil
        #if DEBUG
        if Self.demoRestart { return }
        #endif
        do {
            _ = try await ask(Nothing.self, "POST", SandboxRoutes.restart, body: ["restart": restart], on: box)
            restarting.remove(box)
        } catch {
            restartAnswered.remove(box)
            restartFailures[box] = (error as? BoxRefusal)?.message ?? error.localizedDescription
            throw error
        }
    }

    /// Whether the answer to `box`'s restart is going now.
    func answeringRestart(on box: String) -> Bool {
        restartAnswered.contains(box) && restarting.contains(box)
    }

    /// Your answer: once, always (where the ask names a place) or no. One that's no longer open
    /// (answered elsewhere, or the agent stopped waiting) is gone, not an error.
    func answer(_ asked: SandboxAsk, _ answer: SandboxAnswer, on box: String) async throws {
        guard answering.insert(asked.id).inserted else { return }
        defer { answering.remove(asked.id) }
        failures[asked.id] = nil
        do {
            _ = try await ask(Nothing.self, "POST", SandboxRoutes.ask(asked.id), body: ["answer": answer.rawValue], on: box)
        } catch let refusal as BoxRefusal where refusal.status == 404 {
        } catch {
            failures[asked.id] = (error as? BoxRefusal)?.message ?? error.localizedDescription
            throw error
        }
        answered.insert(asked.id)
        take((asks[box] ?? []).filter { $0.id != asked.id }, from: box)
    }

    // MARK: Settings › Permissions

    /// Each box's sandbox as it last said, for its Permissions page.
    private(set) var states: [String: SandboxState] = [:]
    /// Why a box's sandbox couldn't be read the last time.
    private(set) var stateFailures: [String: String] = [:]
    /// Boxes too old to have a sandbox: their page says nothing of it.
    private(set) var without: Set<String> = []
    /// Boxes being checked again from here, which a second click leaves alone.
    private(set) var checking: Set<String> = []
    /// Each box's Also Allowed as it last listed it: every rule there, with whose each is, and the
    /// bots and chats a folder can be added for.
    private(set) var allowed: [String: SandboxAllowed] = [:]
    /// Each box's reads and changes of Also Allowed, numbered as they're sent, and the last whose
    /// answer shows: each answer lists every rule, so one that comes after a later one's would
    /// bring back what that one took out.
    @ObservationIgnored private var allowedSent: [String: Int] = [:]
    @ObservationIgnored private var allowedShown: [String: Int] = [:]

    private func numbered(_ box: String) -> Int {
        let number = (allowedSent[box] ?? 0) + 1
        allowedSent[box] = number
        return number
    }

    /// `box`'s answer, unless a later read's or change's shows already.
    private func took(_ answer: SandboxAllowed, on box: String, number: Int) {
        guard number > allowedShown[box] ?? 0 else { return }
        allowedShown[box] = number
        allowed[box] = answer
    }

    #if DEBUG
    /// KUVO_DEMO_SANDBOX_STATE: how every box's sandbox says it is, for a look at Settings ›
    /// Permissions: `on`, `services` (on, on a machine where it can't keep commands from your
    /// login's services), `checking`, `checkFailed`,
    /// `failedAgain`, `plugin`, `waiting`, `engineDown`, `engineMissing`, `kernel` or `macos`.
    /// KUVO_DEMO_SANDBOX_RULES=1: Also Allowed has a folder for the first project, one for the first
    /// bot and two for the chats; `empty`, none.
    static let demoState: SandboxState? = ProcessInfo.processInfo.environment["KUVO_DEMO_SANDBOX_STATE"].map { kind in
        switch kind {
        case "on": SandboxState(on: true, agents: true)
        case "services": SandboxState(on: true, agents: true, needs: "user namespaces", gaps: [.services])
        case "checkFailed": SandboxState(on: false, reason: .checkFailed, action: .retry, route: SandboxRoutes.check, check: .readsOwn, failures: 1)
        case "failedAgain": SandboxState(on: false, reason: .checkFailed, action: .retry, route: SandboxRoutes.check, check: .writesOwn, failures: 3)
        case "kernel": SandboxState(on: false, why: "Linux 5.10 can't sandbox commands: it needs Landlock (Linux 5.13 or later, with it on).", able: false, reason: .kernel, action: .help, needs: "Linux 5.13")
        default: SandboxState(on: false, reason: SandboxState.Reason(rawValue: kind) ?? .checking)
        }
    }
    static let demoRules = ProcessInfo.processInfo.environment["KUVO_DEMO_SANDBOX_RULES"]
    #endif

    /// Reads how `box`'s sandbox is now.
    func readState(_ box: String) async {
        #if DEBUG
        if let demo = Self.demoState { states[box] = demo; return }
        #endif
        do {
            states[box] = try await ask(SandboxState.self, "GET", SandboxRoutes.state, on: box)
            stateFailures[box] = nil
            without.remove(box)
        } catch let refusal as BoxRefusal where [404, 405].contains(refusal.status) {
            without.insert(box)
            states[box] = nil
        } catch is CancellationError {
        } catch {
            stateFailures[box] = (error as? BoxRefusal)?.message ?? error.localizedDescription
        }
    }

    /// Reads it again while its page is open, as the box checks it on its own and the engine comes
    /// and goes: often while it's passing on its own (being checked, the engine coming back),
    /// rarely otherwise; not at all on a box without it.
    func watchState(_ box: String) async {
        while !Task.isCancelled {
            await readState(box)
            if without.contains(box) { return }
            // A machine's goes over SSH: less often.
            try? await Task.sleep(for: .seconds(Self.passes(states[box]) ? (box == BoxClient.mac ? 4 : 10) : 30))
        }
    }

    /// Whether how it stands changes on its own soon (not read yet counts).
    private static func passes(_ state: SandboxState?) -> Bool {
        guard let state else { return true }
        if state.on { return false }
        switch state.reason {
        case .checking, .waiting, .engineDown, .engineMissing: return true
        default: return false
        }
    }

    /// Checks it again, which also puts back Kuvo Code's part in the engine where it was changed.
    func check(_ box: String) async throws {
        guard checking.insert(box).inserted else { return }
        defer { checking.remove(box) }
        do {
            states[box] = try await ask(SandboxState.self, "POST", SandboxRoutes.check, body: [:], on: box)
            stateFailures[box] = nil
        } catch {
            // Said on its page, under the button.
            stateFailures[box] = (error as? BoxRefusal)?.message ?? error.localizedDescription
            throw error
        }
    }

    /// Reads `box`'s Also Allowed: every rule there, and whom else a folder can be added for.
    func readAllowed(on box: String) async throws {
        let number = numbered(box)
        took(try await ask(SandboxAllowed.self, "GET", SandboxRoutes.allowed, on: box), on: box, number: number)
    }

    #if DEBUG
    /// KUVO_DEMO_SANDBOX_RULES's Also Allowed, for a look: its first project's and first bot's.
    func showDemo(on box: String, project: String?, bot: (id: String, name: String)?) {
        guard allowed[box] == nil else { return }
        let home = NSHomeDirectory(), at = Date().timeIntervalSince1970 * 1000, day = 86_400_000.0
        var rules: [SandboxRule] = []
        if Self.demoRules != "empty" {
            if let project {
                rules.append(SandboxRule(id: "al_1", project: project, path: home + "/Desktop/main/kuvo-web/dist", at: at - 2 * day, by: "Mac"))
            }
            if let bot {
                rules.append(SandboxRule(id: "al_2", project: home + "/bots/\(bot.id)/workspace", path: home + "/Reports/weekly", at: at, by: "Mac", owner: .init(kind: .bot, id: bot.id, name: bot.name)))
            }
            rules += [
                SandboxRule(id: "al_3", project: home + "/Chats", path: home + "/Downloads/exports", at: at - day, by: "Alex’s iPhone", owner: .chats),
                SandboxRule(id: "al_4", project: home + "/Chats", path: home + "/Library/Logs/fastlane/gym/builds/KuvoCodeMobile/archives/2026-10-29", at: at, by: "Mac", owner: .chats),
            ]
        }
        allowed[box] = SandboxAllowed(allowed: rules, owners: (bot.map { [SandboxOwner(kind: .bot, id: $0.id, name: $0.name)] } ?? []) + [.chats])
    }
    #endif

    /// Lets a project's commands write in `path` too, in the sandbox (by its folder), or a bot's own
    /// or the chats' (by `owner`); the box's words when it can't (a place it keeps closed, or too
    /// many).
    func allow(_ path: String, in project: String? = nil, for owner: SandboxOwner? = nil, on box: String) async throws {
        #if DEBUG
        if Self.demoRules != nil {
            let rule = SandboxRule(id: UUID().uuidString, project: project ?? owner?.name ?? "", path: path, at: Date().timeIntervalSince1970 * 1000, by: "Mac", owner: owner)
            allowed[box, default: SandboxAllowed(allowed: [])].allowed.append(rule)
            return
        }
        #endif
        var body: [String: Any] = ["kind": "write", "path": path]
        if let project { body["project"] = project } else if let owner { body["owner"] = owner.sent }
        let number = numbered(box)
        let now = try await ask(SandboxAllowed.self, "POST", SandboxRoutes.allowedAll, body: body, on: box)
        // (A box before owners answers its project's only: all of them read again.)
        if now.owners == nil { try await readAllowed(on: box) } else { took(now, on: box, number: number) }
    }

    /// Takes a place out of Also Allowed; one already gone counts.
    func remove(_ rule: SandboxRule, on box: String) async throws {
        #if DEBUG
        if Self.demoRules != nil { allowed[box]?.allowed.removeAll { $0.id == rule.id }; return }
        #endif
        let number = numbered(box)
        do {
            let left = try await ask(SandboxAllowed.self, "DELETE", SandboxRoutes.rule(rule.id, all: true), on: box)
            // (A box before owners answers its project's only.)
            if left.owners != nil { return took(left, on: box, number: number) }
        } catch let refusal as BoxRefusal where refusal.status == 404 {}
        allowed[box]?.allowed.removeAll { $0.id == rule.id }
    }
}
