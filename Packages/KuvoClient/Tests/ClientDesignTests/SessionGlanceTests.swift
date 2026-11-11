import ClientDesign
import Foundation
import Testing

/// A session's row and card at a glance, from what its box says (`kuvo/sessions/glance`): the one
/// mark a row gains, red all over while a check fails, what VoiceOver says of it, what the card's
/// age counts from, and an answer read part by part, so a newer box's word never loses the rest.
@Suite struct SessionGlanceTests {
    private func decoded(_ json: String) throws -> SessionGlances {
        try JSONDecoder().decode(SessionGlances.self, from: Data(json.utf8))
    }

    @Test func aRowGainsItsPullRequestsMarkElseItsBranchsAndNoneInTheProjectsCheckout() throws {
        let glances = try decoded("""
        {"sessions": {
          "ses_pr": {"branch": "kuvo/timer", "pull": {"number": 42, "url": "https://github.com/me/app/pull/42", "state": "open", "additions": 435, "deletions": 4, "checks": {"passed": 12, "failed": 0, "pending": 2}}},
          "ses_tree": {"branch": "kuvo/dark", "additions": 128, "deletions": 14, "account": {"name": "Claude Code", "label": "Work"}},
          "ses_home": {"account": {"name": "Anthropic"}}
        }}
        """)
        guard case .pull(let pull)? = SessionGlance.rowMark(glances.sessions["ses_pr"]) else { Issue.record("no pull request mark"); return }
        #expect(pull.number == 42 && pull.checks?.share == 12.0 / 14.0)
        #expect(SessionGlance.rowMark(glances.sessions["ses_tree"]) == .branch("kuvo/dark"))
        #expect(SessionGlance.rowMark(glances.sessions["ses_home"]) == nil)
        // Before its box has said (or one from before this), a worktree's row keeps its branch mark.
        #expect(SessionGlance.rowMark(nil, worktreeBranch: "kuvo/old") == .branch("kuvo/old"))
        #expect(SessionGlance.rowMark(nil) == nil)
    }

    @Test func aFailingCheckTurnsTheWholeMarkRedOnlyWhileItsOpen() {
        let failing = SessionGlance.Pull.Checks(passed: 13, failed: 1, pending: 0)
        #expect(SessionGlance.Pull(number: 41, state: .open, checks: failing).isFailing)
        #expect(SessionGlance.Pull(number: 41, state: .draft, checks: failing).isFailing)
        #expect(!SessionGlance.Pull(number: 41, state: .merged, checks: failing).isFailing)
        #expect(!SessionGlance.Pull(number: 41, state: .closed, checks: failing).isFailing)
        #expect(!SessionGlance.Pull(number: 41, state: .open, checks: .init(passed: 12, failed: 0, pending: 2)).isFailing)
        #expect(!SessionGlance.Pull(number: 41, state: nil).isFailing)
    }

    @Test func voiceOverSaysThePullRequestItsStateAndItsChecks() {
        #expect(SessionGlance.Pull(number: 41, state: .open, checks: .init(passed: 13, failed: 1, pending: 0)).spoken == "Pull request 41, open, a check failed")
        #expect(SessionGlance.Pull(number: 42, state: .open, checks: .init(passed: 12, failed: 0, pending: 2)).spoken == "Pull request 42, open, 12 of 14 checks passed")
        #expect(SessionGlance.Pull(number: 42, state: .draft, checks: .init(passed: 3, failed: 0, pending: 0)).spoken == "Pull request 42, a draft, all checks passed")
        #expect(SessionGlance.Pull(number: 38, state: .merged, checks: .init(passed: 14, failed: 0, pending: 0)).spoken == "Pull request 38, merged")
        #expect(SessionGlance.Pull(number: 7, state: nil).spoken == "Pull request 7")
    }

    @Test func theCardSaysTheFolderOnlyAwayFromItsHeadingAndTheComputerOnlyAcrossComputers() {
        #expect(!SessionGlance.showsFolder(underItsProject: true, isChat: false))
        #expect(SessionGlance.showsFolder(underItsProject: false, isChat: false))
        #expect(!SessionGlance.showsFolder(underItsProject: false, isChat: true))
        #expect(SessionGlance.showsComputer(acrossComputers: true))
        #expect(!SessionGlance.showsComputer(acrossComputers: false))
    }

    @Test func theCardsAgeIsSinceItAskedWhileItWaitsSinceItsLastTurnOtherwiseAndNoneWhileItWorks() {
        let asked = 1_000_000.0, idle = 2_000_000.0, updated = 3_000_000.0
        #expect(GlanceAge.since(.needsYou, asked: asked, idle: idle, updated: updated) == Date(timeIntervalSince1970: 1000))
        // Asked while its box couldn't hear: since it last changed.
        #expect(GlanceAge.since(.needsYou, asked: nil, idle: idle, updated: updated) == Date(timeIntervalSince1970: 3000))
        #expect(GlanceAge.since(.new, asked: nil, idle: idle, updated: updated) == Date(timeIntervalSince1970: 2000))
        #expect(GlanceAge.since(nil, asked: nil, idle: nil, updated: updated) == Date(timeIntervalSince1970: 3000))
        #expect(GlanceAge.since(.working, asked: nil, idle: idle, updated: updated) == nil)
        #expect(GlanceAge.since(.subagents, asked: nil, idle: idle, updated: updated) == nil)
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(GlanceAge.card(now.addingTimeInterval(-30), now: now) == "now")
        #expect(GlanceAge.card(now.addingTimeInterval(-120), now: now) == "2m ago")
        #expect(GlanceAge.card(now.addingTimeInterval(-3 * 86_400), now: now) == "3d ago")
    }

    @Test func theModelsLineSaysItsEffortAndTheAccountsOwnNameOnly() {
        #expect(SessionGlance.details(effort: "Extra", account: .init(name: "Claude Code", label: "Work")) == "Extra · Work")
        #expect(SessionGlance.details(effort: "High", account: .init(name: "Anthropic")) == "High")
        #expect(SessionGlance.details(effort: nil, account: .init(name: "Anthropic", label: " ")) == nil)
        #expect(SessionGlance.details(effort: nil, account: .init(name: "Claude Code", label: "Work")) == "Work")
    }

    @Test func theCardsFactsAndWhatVoiceOverHearsOfThem() {
        let glance = SessionGlance(branch: "timer-cycle", pull: .init(number: 42, state: .open, additions: 435, deletions: 4, checks: .init(passed: 12, failed: 0, pending: 2)),
                                   account: .init(name: "Claude Code", label: "Work"), asked: 1_000_000)
        let facts = GlanceCardFacts(glance: glance, state: .needsYou, idle: 2_000_000, updated: 3_000_000, worktreeBranch: "old-name",
                                    model: "Opus 5.5", variant: "xhigh", effortName: { $0 == "xhigh" ? "Extra" : $0 }, folder: "pomodoro")
        #expect(facts.branch == "timer-cycle")
        #expect(facts.details == "Extra · Work")
        #expect(facts.since == Date(timeIntervalSince1970: 1000))
        let spoken = facts.spoken(now: Date(timeIntervalSince1970: 1120))
        #expect(spoken.map(\.label) == ["State", "Project", "Branch", "Model", "Pull request"])
        #expect(spoken[0].value == "Needs you, 2m ago")
        #expect(spoken[4].value == "Pull request 42, open, 12 of 14 checks passed, 435 lines added, 4 removed")
        // Its box from before: the worktree's branch; the engine's own "default" effort says none.
        let older = GlanceCardFacts(glance: nil, state: nil, idle: nil, updated: 3_000_000, worktreeBranch: "kuvo/dark", model: "GPT-5.5", variant: "default", effortName: { $0 })
        #expect(older.branch == "kuvo/dark" && older.details == nil && older.stateWords == "Idle")
    }

    @Test func aNewerBoxsWordIsLeftOutNotTheRest() throws {
        let glances = try decoded("""
        {"sessions": {
          "ses_a": {"branch": "kuvo/a", "pull": {"number": 9, "url": "u", "state": "queued", "checks": {"passed": "many"}}, "account": 3, "later": true},
          "ses_b": "not a glance",
          "ses_c": {"branch": "kuvo/c"}
        }}
        """)
        #expect(glances.sessions["ses_a"]?.branch == "kuvo/a")
        #expect(glances.sessions["ses_a"]?.pull?.number == 9)
        #expect(glances.sessions["ses_a"]?.pull?.state == nil)
        #expect(glances.sessions["ses_a"]?.pull?.checks == nil)
        #expect(glances.sessions["ses_a"]?.account == nil)
        #expect(glances.sessions["ses_b"] == nil)
        #expect(glances.sessions["ses_c"]?.branch == "kuvo/c")
    }

    @Test func theRouteNamesTheSessionsOnScreenAtMostAsManyAsTheBoxTakes() {
        #expect(SessionGlances.path(["ses_a", "ses_b"], events: true) == "kuvo/sessions/glance/events?sessions=ses_a,ses_b")
        #expect(SessionGlances.path(["ses_a"], events: false) == "kuvo/sessions/glance?sessions=ses_a")
        let many = (0..<300).map { "ses_\($0)" }
        #expect(SessionGlances.path(many, events: false).split(separator: ",").count == SessionGlances.most)
    }
}
