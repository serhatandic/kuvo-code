import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// What both apps show of a bot's work: the bot a session works for, the ask a bot answered on the
/// step that asked it ("Allowed by Pixel"), its work as the box tells it, and its line in the
/// sidebar.
struct BotWorkTests {
    private func session(metadata: String) throws -> Session {
        let json = #"{"id": "ses_1", "projectID": "p", "title": "Haptics", "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "time": {"created": 1, "updated": 2}, "location": {"directory": "/p"}, "metadata": \#(metadata)}"#
        return try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    @Test func aSessionUnderABotIsMarkedWithItsBotAndShowsItsAnswersOnTheirSteps() throws {
        let session = try session(metadata: #"{"kuvo": {"startedBy": "ses_pixel", "by": {"bot": "bot_pixel", "name": "Pixel"}, "depth": 1, "answers": [{"ask": "per_1", "call": "call_1", "what": "Wants to run a command: npx expo install expo-haptics", "decision": "allow", "reason": "The plan names it.", "by": {"bot": "bot_pixel", "name": "Pixel"}, "at": 1761700000000}, {"ask": "per_2", "what": "?", "decision": "something-newer", "reason": "", "by": {"name": "x"}, "at": 1}]}}"#)
        #expect(WorksFor(session) == WorksFor(try self.session(metadata: #"{"kuvo": {"by": {"bot": "bot_pixel", "name": "Pixel"}}}"#)))
        #expect(WorksFor(session)?.name == "Pixel")
        let answer = try #require(WorkAnswer.forCall("call_1", in: session))
        #expect(answer.verdict == "Allowed by Pixel")
        #expect(answer.reason == "The plan names it.")
        #expect(WorkAnswer.on(session).count == 1, "one a newer box words differently is left out, not the lot")
        #expect(WorkAnswer.forCall("call_9", in: session) == nil)
    }

    @Test func aSessionOfYourOwnWorksForNoBot() throws {
        #expect(WorksFor(try session(metadata: #"{"kuvo": {"startedBy": "ses_lead"}}"#)) == nil)
        #expect(WorksFor(try session(metadata: "null")) == nil)
        #expect(WorkAnswer.on(try session(metadata: "null")).isEmpty)
    }

    @Test func aBotsWorkReadsAsItsBoxTellsIt() throws {
        let json = #"{"bot": "bot_pixel", "sessions": [{"session": "ses_1", "title": "Sign-in", "folder": "/p", "project": "Tidepool", "startedBy": "ses_pixel", "depth": 1, "model": {"id": "claude-sonnet-5-5", "providerID": "anthropic", "variant": "high"}, "state": "asking", "asks": "Wants to run a command: npm test", "started": 1, "tokens": 1200}, {"session": "ses_2", "title": "Plan", "folder": "/p", "startedBy": "ses_pixel", "depth": 1, "state": "finished", "started": 1, "tokens": 0, "lastReply": "Done."}], "answered": [], "today": {"started": 2, "working": 1, "tokens": 1200}, "limits": null}"#
        let report = try JSONDecoder().decode(BotWorkReport.self, from: Data(json.utf8))
        #expect(report.atWork.map(\.title) == ["Sign-in"], "one asking is still at it; one finished isn't")
        #expect(report.limits == nil)
        #expect(report.sessions[0].model?.variant == "high")
    }

    @Test func aBotsWorkIsSaidInFewWords() {
        #expect(WorkWords.asking("Wants to run a command: npx expo install expo-haptics") == "Asks to run npx expo install expo-haptics")
        #expect(WorkWords.asking("Wants to work outside the project.") == "Asks to work outside the project.")
        #expect(WorkWords.barTitle(atWork: 3, today: 5) == "3 sessions at work")
        #expect(WorkWords.barTitle(atWork: 1, today: 1) == "A session is at work")
        #expect(WorkWords.barTitle(atWork: 0, today: 5) == "5 sessions today, none at work")
        // On a goal's line, in a word.
        #expect(WorkWords.chipTitle(atWork: 2, today: 5) == "2 working")
        #expect(WorkWords.chipTitle(atWork: 0, today: 4) == "4 today")
        #expect(WorkWords.limits(WorkLimits(atOnce: 2, depth: 1)) == "Your limits: 2 at once, sessions they start: none (Edit Bot › Work)")
        #expect(WorkWords.depth(3) == "2 levels")
        #expect(WorkWords.tokens(412_300) == "412k")
        #expect(WorkWords.tokens(1_250_000) == "1.2M")
    }

    @Test func whatABotAsksReadsAsItsBoxTellsItLeavingOutWhatANewerBoxAsks() throws {
        let json = #"{"asks": [{"id": "wak_1", "action": "makeProject", "session": "ses_pixel", "name": "Pixel", "bot": "bot_pixel", "project": "Tidepool", "folderName": "tidepool", "folder": null, "suggested": "/Users/me/Developer", "at": 1}, {"id": "wak_2", "action": "buyDomain", "session": "ses_pixel", "name": "Pixel", "project": "x", "folderName": "x", "folder": null, "at": 2}]}"#
        let asks = try JSONDecoder().decode(WorkAskList.self, from: Data(json.utf8)).asks
        #expect(asks.map(\.id) == ["wak_1"], "a kind this client can't answer isn't shown")
        let ask = try #require(asks.first)
        #expect(ask.needsFolder)
        #expect(WorkWords.askTitle(ask) == "Allow making a project?")
        #expect(WorkWords.askLine(ask) == "Pixel wants to make Tidepool.")
        #expect(WorkWords.always(ask) == "Always for Pixel")
        // A bot's work has what it asks and the projects it made; a box from before, neither.
        let report = try JSONDecoder().decode(BotWorkReport.self, from: Data(#"{"bot": "bot_pixel", "sessions": [], "answered": [], "today": {"started": 0, "working": 0, "tokens": 0}, "limits": null, "asks": \#(json.dropFirst(9).dropLast()), "projects": [{"directory": "/Users/me/Developer/tidepool", "name": "Tidepool", "folders": [], "madeBy": {"bot": "bot_pixel", "name": "Pixel", "at": 1}}]}"#.utf8))
        #expect(report.asks.map(\.id) == ["wak_1"])
        #expect(report.projects.map(\.title) == ["Tidepool"])
        let older = try JSONDecoder().decode(BotWorkReport.self, from: Data(#"{"bot": "bot_pixel", "sessions": [], "answered": [], "today": {"started": 0, "working": 0, "tokens": 0}, "limits": null}"#.utf8))
        #expect(older.asks.isEmpty && older.projects.isEmpty)
    }

    /// Each row of the work bar says which account a session runs on, beside its model and before
    /// its project, as its box names it: the plan people know, then the name you gave the account.
    @Test func aSessionsRowSaysWhichAccountItRunsOnAndDropsItBeforeTheProject() throws {
        let item = { (provider: String, account: String) throws -> BotWorkReport.Item in
            let json = #"{"bot": "bot_pixel", "sessions": [{"session": "ses_1", "title": "Review #181 part 3 before merge (security)", "folder": "/p", "project": "Kuvo Code", "startedBy": "ses_pixel", "depth": 1, "model": {"id": "claude-opus-5-5", "providerID": "\#(provider)", "variant": "high"}, \#(account) "state": "working", "started": 1, "tokens": 0}], "answered": [], "today": {"started": 1, "working": 1, "tokens": 0}, "limits": null}"#
            return try #require(try JSONDecoder().decode(BotWorkReport.self, from: Data(json.utf8)).sessions.first)
        }
        // A coding agent's account you named, its own sign-in, the engine's Copilot plan, a provider
        // by its own name, and the engine's sign-in in use where it has others.
        #expect(WorkWords.about(try item("claude-code@acc1", #""account": {"name": "Claude Code", "label": "Athas"},"#), model: "Opus 5.5")
            == ["Opus 5.5 · high · Claude · Athas · Kuvo Code", "Opus 5.5 · high · Kuvo Code"])
        #expect(WorkWords.about(try item("claude-code", #""account": {"name": "Claude Code"},"#), model: "Opus 5.5").first == "Opus 5.5 · high · Claude · Kuvo Code")
        #expect(WorkWords.about(try item("codex-cli@work", #""account": {"name": "Codex", "label": "Work"},"#), model: "GPT-5.5").first == "GPT-5.5 · high · ChatGPT · Work · Kuvo Code")
        #expect(WorkWords.about(try item("github-copilot", #""account": {"name": "GitHub Copilot"},"#), model: "Opus 5.5").first == "Opus 5.5 · high · Copilot · Kuvo Code")
        #expect(WorkWords.about(try item("openrouter", #""account": {"name": "OpenRouter", "label": "Team key"},"#), model: "Opus 5.5").first == "Opus 5.5 · high · OpenRouter · Team key · Kuvo Code")
        // Custom Auto, or a box from before it said: as before.
        #expect(WorkWords.about(try item("auto", ""), model: "Auto") == ["Auto · high · Kuvo Code"])
    }

    @Test func whatABotMayDoWithoutAskingReadsEvenWhenANewerBoxNamesMore() throws {
        let allowed = try JSONDecoder().decode(WorkActions.self, from: Data(#"["makeProject", "buyDomain"]"#.utf8))
        #expect(allowed.actions == [.makeProject])
    }
}
