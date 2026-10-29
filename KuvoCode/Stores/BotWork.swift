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
    /// Bots whose box doesn't tell its work (an older one): not asked again.
    @ObservationIgnored private var unknown: Set<String> = []
    /// The box a bot lives on, by its id ("mac", or a machine's): the app's (a test's own).
    @ObservationIgnored var boxes: ((String) -> BoxClient)?

    private func box(of bot: Bot) -> BoxClient? {
        let id = bot.machine ?? BoxClient.mac
        return boxes?(id) ?? app?.box(id)
    }

    /// The bot's work, read again from its box.
    func read(_ bot: Bot) async {
        #if DEBUG
        // KUVO_DEMO_BOT_WORK=<bot's name>: its work, a sample, for a look at the bar and its list.
        if ProcessInfo.processInfo.environment["KUVO_DEMO_BOT_WORK"] == bot.name {
            reports[bot.id] = Self.sample(bot)
            return
        }
        #endif
        guard !unknown.contains(bot.id), let box = box(of: bot) else { return }
        guard let (status, data) = try? await box.send("GET", "kuvo/work?bot=\(bot.id)") else { return }
        if status == 404, (try? JSONDecoder().decode([String: String].self, from: data))?["message"] == nil {
            // A box from before bots ran sessions: no such route.
            unknown.insert(bot.id)
            return
        }
        guard status == 200, let report = try? JSONDecoder().decode(BotWorkReport.self, from: data), report != reports[bot.id] else { return }
        reports[bot.id] = report
    }

    /// Every session of the bot's work stopped, on its box; its work read again.
    func stopAll(_ bot: Bot) async throws {
        guard let box = box(of: bot) else { return }
        let (status, data) = try await box.send("POST", "kuvo/bots/\(bot.id)/stop-all")
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        await read(bot)
    }

    /// The limits you set for a bot, kept on its box (`PATCH kuvo/bots/<id>`); nil for none.
    func setLimits(_ limits: WorkLimits?, for bot: Bot) async throws {
        guard let box = box(of: bot) else { return }
        struct Change: Encodable {
            struct Work: Encodable { var limits: WorkLimits? }
            var work: Work
        }
        let body = try JSONEncoder().encode(Change(work: .init(limits: limits?.isEmpty == false ? limits : nil)))
        let (status, data) = try await box.send("PATCH", "kuvo/bots/\(bot.id)", body: body)
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        await read(bot)
    }

    #if DEBUG
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

    func forget(_ bot: String) {
        reports[bot] = nil
        unknown.remove(bot)
    }
}
