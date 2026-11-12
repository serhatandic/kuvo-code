import ClientSessions
import Foundation
import Observation

/// Bots' work as their boxes tell it (`kuvo/work`, PROTOCOL.md "Work"): the sessions each runs,
/// where each stands, the asks it answered and what it started today. Read for a bot whose
/// conversation shows its work, and again as its sessions change, on this Mac or a machine alike.
@MainActor @Observable
final class BotWork {
    @ObservationIgnored weak var app: AppModel?
    /// Each bot's, by its id, as last read.
    private(set) var reports: [String: BotWorkReport] = [:]
    /// Boxes that don't tell bots' work (from before bots ran sessions), by their ids: not asked
    /// again until the app opens again (one that updates meanwhile is read then).
    private(set) var older: Set<String> = []
    /// The box a bot lives on, by its id ("mac", or a machine's): the app's (a test's own).
    @ObservationIgnored var boxes: ((String) -> BoxClient)?

    private func box(of bot: Bot) -> BoxClient? {
        boxes?(bot.box) ?? app?.box(bot.box)
    }

    /// The bot's work as it stands now, for the bar over its composer: its box's report, each of its
    /// sessions at work or not as this Mac knows from its box since (`AtWork`), so the bar counts
    /// what the bot's row and face go by.
    func report(of bot: Bot) -> BotWorkReport? {
        guard let report = reports[bot.id] else { return nil }
        #if DEBUG
        if Self.demoBot == bot.name { return report }
        #endif
        guard let workspace = app?.workspace else { return report }
        return report.standing(working: workspace.isWorking, asking: workspace.needsAttention)
    }

    /// Whether the box a bot lives on runs its work (one from before doesn't).
    func runsWork(_ bot: Bot) -> Bool { !older.contains(bot.box) }

    /// The bot's work, read again from its box: one read at a time for each bot, each caller's done
    /// once a read that started after it asked is in. A read isn't let go when the one who asked
    /// stops waiting (the bar's read starts again as each of the bot's sessions changes), so with
    /// many changing, the report still keeps up, and an older answer never comes in after a newer
    /// one.
    func read(_ bot: Bot) async {
        readsWanted[bot.id, default: 0] += 1
        let wanted = readsWanted[bot.id] ?? 0
        while (readsDone[bot.id] ?? 0) < wanted, !Task.isCancelled {
            await reading(bot).value
        }
    }

    /// How long a read may take before it's let go.
    static let readLimit: Duration = .seconds(60)

    /// Reads asked for and read, by bot, and the read under way.
    @ObservationIgnored private var readsWanted: [String: Int] = [:]
    @ObservationIgnored private var readsDone: [String: Int] = [:]
    @ObservationIgnored private var reads: [String: Task<Void, Never>] = [:]

    private func reading(_ bot: Bot) -> Task<Void, Never> {
        if let reading = reads[bot.id] { return reading }
        let task = Task { [weak self] in
            while let self, (self.readsDone[bot.id] ?? 0) < (self.readsWanted[bot.id] ?? 0) {
                let wanted = self.readsWanted[bot.id] ?? 0
                // (One that hangs, a machine's over SSH, is let go after a while, so the next can go.)
                let read = Task { await self.readNow(bot) }
                let limit = Task {
                    try? await Task.sleep(for: BotWork.readLimit)
                    read.cancel()
                }
                await read.value
                limit.cancel()
                self.readsDone[bot.id] = wanted
            }
            self?.reads[bot.id] = nil
        }
        reads[bot.id] = task
        return task
    }

    private func readNow(_ bot: Bot) async {
        #if DEBUG
        // KUVO_DEMO_BOT_WORK=<bot's name>: its work, a sample, for a look at the bar and its list.
        if ProcessInfo.processInfo.environment["KUVO_DEMO_BOT_WORK"] == bot.name {
            reports[bot.id] = Self.sample(bot)
            return
        }
        // KUVO_DEMO_BOT_ASK=<bot's name>: it asks to make a project, the first time on its computer;
        // KUVO_DEMO_MADE_BY=<bot's name>: your first project is one it made.
        let environment = ProcessInfo.processInfo.environment
        if environment["KUVO_DEMO_BOT_ASK"] == bot.name {
            app?.botAsks.demo = [WorkAsk(id: "wak_demo", action: .makeProject, session: bot.sessionID, name: bot.name, bot: bot.id, project: "Tidepool", folderName: "tidepool",
                                         folder: nil, suggested: NSHomeDirectory() + "/Developer", at: Date.now.timeIntervalSince1970 * 1000)]
        }
        // KUVO_DEMO_GOAL=<bot's name>:<kind>: its goal, a sample (`GoalPlans.demo(for:)`).
        if app?.goalPlans.demo == nil { app?.goalPlans.demo(for: bot) }
        if environment["KUVO_DEMO_MADE_BY"] == bot.name, let first = app?.workspace.projects.first {
            app?.workspace.noteMadeBy(first.directory, .init(bot: bot.id, name: bot.name))
        }
        #endif
        guard runsWork(bot), let box = box(of: bot) else { return }
        guard let (status, data) = try? await box.send("GET", "kuvo/work?bot=\(bot.id)") else { return }
        if status == 404 || status == 403 || status == 405 {
            // A box from before bots ran sessions says nothing; one that doesn't have the bot (it
            // moved, or went) says so, and what it said of it before is gone.
            if (try? JSONDecoder().decode([String: String].self, from: data))?["message"] == nil { older.insert(bot.box) }
            reports[bot.id] = nil
            return
        }
        guard status == 200, let report = try? JSONDecoder().decode(BotWorkReport.self, from: data), report != reports[bot.id] else { return }
        reports[bot.id] = report
        // Something it asks you that this Mac hasn't heard of yet (a machine's are asked for only
        // now and then): read now.
        if let asks = app?.botAsks, report.asks.contains(where: { ask in !asks.asks(for: ask.session).contains { $0.ask.id == ask.id } }) {
            await asks.read(bot.box)
        }
        // A project it made on a machine since its projects were read there: read again (on its
        // own, so the next read of its work never waits on it).
        if let machine = bot.machine, let workspace = app?.workspace,
           report.projects.contains(where: { !workspace.folders.contains(RemoteFolder.folder($0.directory, on: machine)) }) {
            Task { await workspace.loadProjects(on: machine) }
        }
    }

    /// A machine connected and ready, whose work can be followed (a test's own answer).
    @ObservationIgnored var connected: ((String) -> Bool)?

    /// The bot's work, read again each time its box says it changed (`kuvo/work/events`: a session
    /// of it started, at work, asking or done), until the task following it ends. What this Mac
    /// sees of the sessions alone misses some: one in a folder it doesn't show, or one whose task
    /// reached it after it was read. A machine's while it's connected.
    func follow(_ bot: Bot) async {
        struct Line: Decodable { var changed: [String: Double] }
        let onThisMac = bot.box == BoxClient.mac
        while !Task.isCancelled {
            if onThisMac || connected?(bot.box) ?? (app?.machines.engine(bot.box)?.isReady == true), runsWork(bot), let client = box(of: bot) {
                // Each stream's first line is read, so what changed while it wasn't followed is
                // too, though the box may not have noted it (it restarted meanwhile).
                var seen: Double?
                do {
                    for try await data in client.follow("kuvo/work/events") {
                        guard let at = (try? JSONDecoder().decode(Line.self, from: data))?.changed[bot.id], at != seen else { continue }
                        seen = at
                        await read(bot)
                    }
                } catch {}
            }
            // The box started again, or the machine went away: followed again in a moment.
            try? await Task.sleep(for: .seconds(onThisMac ? 2 : 30))
        }
    }

    /// Every session of the bot's work stopped, on its box; its work read again.
    func stopAll(_ bot: Bot) async throws {
        guard let box = box(of: bot) else { return }
        let (status, data) = try await box.send("POST", "kuvo/bots/\(bot.id)/stop-all")
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        await read(bot)
    }

    /// One session of the bot's work stopped (what waits for it held, as Stop does); its work read
    /// again.
    func stop(_ session: String, of bot: Bot) async throws {
        guard let box = box(of: bot) else { return }
        let (status, data) = try await box.send("POST", "kuvo/sessions/\(session)/stop")
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        await read(bot)
    }

    /// The limits you set for a bot, kept on its box (`PATCH kuvo/bots/<id>`); nil for none. The
    /// bot as its box has it then is taken in, limits and all.
    func setLimits(_ limits: WorkLimits?, for bot: Bot) async throws {
        guard let box = box(of: bot) else { return }
        struct Change: Encodable {
            struct Work: Encodable { var limits: WorkLimits? }
            var work: Work
        }
        let body = try JSONEncoder().encode(Change(work: .init(limits: limits?.isEmpty == false ? limits : nil)))
        let (status, data) = try await box.send("PATCH", "kuvo/bots/\(bot.id)", body: body)
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        await app?.bots.refresh(bot.box)
        await read(bot)
    }

    /// What you let a bot do without asking ("Always"), kept on its box; none for nothing.
    func setAllowed(_ allowed: [WorkAction], for bot: Bot) async throws {
        guard let box = box(of: bot) else { return }
        struct Change: Encodable {
            struct Work: Encodable { var allowed: [WorkAction] }
            var work: Work
        }
        let (status, data) = try await box.send("PATCH", "kuvo/bots/\(bot.id)", body: try JSONEncoder().encode(Change(work: .init(allowed: allowed))))
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        await app?.bots.refresh(bot.box)
    }

    /// What's kept of a bot's work, once it's gone from here (deleted, or moved).
    func forget(_ bot: String) {
        reports[bot] = nil
    }

    #if DEBUG
    /// KUVO_DEMO_BOT_WORK: the bot whose work is the sample, shown as the sample has it.
    private static let demoBot = ProcessInfo.processInfo.environment["KUVO_DEMO_BOT_WORK"]

    /// A bot's work as a sample: three sessions at work (one asking), two done, the asks it answered.
    private static func sample(_ bot: Bot) -> BotWorkReport? {
        let now = Date.now.timeIntervalSince1970 * 1000
        let by = #"{"bot": "\#(bot.id)", "name": "\#(bot.name)"}"#
        let json = #"""
        {"bot": "\#(bot.id)", "sessions": [
          {"session": "ses_demo1", "title": "Design the onboarding screens", "folder": "/p", "project": "Tidepool", "startedBy": "ses_bot", "depth": 1, "model": {"id": "claude-fable-5-1", "providerID": "anthropic"}, "state": "working", "started": \#(now - 840000), "tokens": 182000},
          {"session": "ses_demo2", "title": "Set up Expo and CI", "folder": "/p", "project": "Tidepool", "startedBy": "ses_bot", "depth": 1, "model": {"id": "claude-sonnet-5-5", "providerID": "anthropic", "variant": "high"}, "state": "asking", "asks": "Wants to run a command: npx expo install expo-haptics", "started": \#(now - 600000), "tokens": 96000},
          {"session": "ses_demo3", "title": "Write the sign-in tests", "folder": "/p", "project": "Tidepool", "startedBy": "ses_demo2", "depth": 2, "model": {"id": "deepseek-v4", "providerID": "deepseek"}, "state": "working", "started": \#(now - 300000), "tokens": 41000},
          {"session": "ses_demo4", "title": "Plan the app", "folder": "/p", "project": "Tidepool", "startedBy": "ses_bot", "depth": 1, "mode": "plan", "state": "finished", "started": \#(now - 3600000), "tokens": 64000, "lastReply": "The plan: four screens, Expo with EAS, sign-in with Apple. Reviewers found two gaps; both are in the plan now."},
          {"session": "ses_demo5", "title": "Pick the colors", "folder": "/p", "project": "Tidepool", "startedBy": "ses_bot", "depth": 1, "state": "failed", "started": \#(now - 5400000), "tokens": 12000}
        ], "answered": [
          {"session": "ses_demo1", "ask": "per_1", "what": "Wants to run a command: npm install react-native-svg", "decision": "allow", "reason": "The plan names the icon set, which needs it.", "by": \#(by), "at": \#(now - 420000)},
          {"session": "ses_demo2", "ask": "per_2", "what": "Wants to run a command: git push origin main", "decision": "deny", "reason": "Pushing waits for you.", "by": \#(by), "at": \#(now - 240000)}
        ], "today": {"started": 5, "working": 3, "tokens": 395000}, "limits": null}
        """#
        return try? JSONDecoder().decode(BotWorkReport.self, from: Data(json.utf8))
    }
    #endif
}
