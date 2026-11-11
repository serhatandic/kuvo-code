import ClientSandbox
import Foundation
import Testing

/// What both apps read of a computer's sandbox, from what its box answers: its state, with the
/// words a newer box adds read as none rather than failing the page; an agent's ask and what Always
/// for This would keep; and a project's Also Allowed, asked for by its folder.
@Suite struct SandboxTests {
    /// In Auto, an ask to work outside the folder is its reviewer's: no card while it checks, nor
    /// once it allowed or held it back, only a mark on its step; one it leaves for you is yours. A
    /// box that lists them all is the whole word: one it hasn't listed isn't yours yet. From a box
    /// that doesn't, one not listed is yours at once.
    @Test func anAskAutosReviewerTakesUpIsntYours() throws {
        let line = #"{"asks":[],"reviews":[{"id":"per_1","session":"ses_a","call":"call_1","state":"checking","at":1},{"id":"per_2","session":"ses_a","state":"yours","at":2}]}"#
        let list = try JSONDecoder().decode(SandboxAsks.self, from: Data(line.utf8))
        let reviews = try #require(list.reviews)
        let outside = "external_directory"
        #expect(!AskReview.isYours(action: outside, review: reviews[0], listsAll: true), "being checked")
        #expect(reviews[0].mark == "Auto is checking…")
        #expect(AskReview.isYours(action: outside, review: reviews[1], listsAll: true), "left for you")
        #expect(reviews[1].mark == nil)
        // Who allowed it, on its step (#406).
        #expect(AskReview(id: "a", session: "s", state: .allowed, at: 1).mark == "Allowed by Auto-review")
        #expect(AskReview(id: "a", session: "s", state: .refused, at: 1).mark == "Not allowed by Auto-review")
        // Not listed yet by a box that lists them all: not yours until it says so.
        #expect(!AskReview.isYours(action: outside, review: nil, listsAll: true))
        // What the reviewer never takes up, and one not listed by a box that doesn't list them all.
        #expect(AskReview.isYours(action: "shell", review: nil, listsAll: true))
        let before = try JSONDecoder().decode(SandboxAsks.self, from: Data(#"{"asks":[]}"#.utf8))
        #expect(before.reviews == nil)
        #expect(AskReview.isYours(action: outside, review: nil, listsAll: false))
        // Its box not heard now (its link down, or starting again): one it never listed is yours, as
        // nothing would list it; what it last said of one stands.
        #expect(AskReview.isYours(action: outside, review: nil, listsAll: true, heard: false))
        #expect(!AskReview.isYours(action: outside, review: reviews[0], listsAll: true, heard: false))
    }

    @Test func aStateThatIsntOnSaysWhyAndWhatToDo() throws {
        let state = try JSONDecoder().decode(SandboxState.self, from: Data("""
        {"on":false,"why":"Its check failed: a command could write outside its folder.","able":true,"agents":false,
         "reason":"checkFailed","action":"retry","route":"POST kuvo/sandbox/check","check":"writesOwn","failures":3}
        """.utf8))
        #expect(!state.on && state.able)
        #expect(state.reason == .checkFailed && state.action == .retry && state.check == .writesOwn)
        #expect(state.route == "POST kuvo/sandbox/check" && state.failures == 3)
    }

    @Test func aNewerBoxsWordsStillLeaveItsState() throws {
        let state = try JSONDecoder().decode(SandboxState.self, from: Data("""
        {"on":false,"why":"Something new.","able":true,"agents":true,"reason":"somethingNew","action":"somethingElse","check":"another"}
        """.utf8))
        #expect(state.why == "Something new." && state.agents)
        #expect(state.reason == nil && state.action == nil && state.check == nil)
        // A box from before `sandbox.check` gives none of them.
        let older = try JSONDecoder().decode(SandboxState.self, from: Data(#"{"on":true,"able":true,"agents":false}"#.utf8))
        #expect(older.on && older.reason == nil && older.action == nil)
    }

    @Test func aBoxWithAgentsStartedBeforeItsSandboxAsksOnceToRestartThem() throws {
        let asking = try JSONDecoder().decode(SandboxState.self, from: Data(#"{"on":true,"able":true,"agents":false,"restart":true}"#.utf8))
        #expect(asking.restart == true)
        // A box that doesn't ask, or one from before it could, shows no card.
        let older = try JSONDecoder().decode(SandboxState.self, from: Data(#"{"on":true,"able":true,"agents":true}"#.utf8))
        #expect(older.restart != true)
    }

    @Test func anAskSaysWhatWasStoppedAndWhatAlwaysWouldKeep() throws {
        let asks = try JSONDecoder().decode(SandboxAsks.self, from: Data("""
        {"asks":[
          {"id":"sa_1","at":1793200000000,"session":"ses_1","sessionName":"Fix the build","bot":"bot_ship","botName":"Ship",
           "project":"/home/me/app","command":"npm install -g pnpm","why":"The build needs pnpm.",
           "stopped":[{"kind":"write","path":"/home/me/.npm-global"},{"kind":"somethingNew"}],
           "always":{"kind":"write","path":"/home/me/.npm-global"},"machine":"devbox"},
          {"id":"sa_2","at":1793200001000,"project":"/home/me/app","command":"open -a Simulator","why":"To see the app.","error":"Operation not permitted"}]}
        """.utf8))
        let first = asks.asks[0], second = asks.asks[1]
        #expect(first.asker == "Ship" && first.canAlways && first.always?.path == "/home/me/.npm-global")
        #expect(first.stopped?.map(\.kind) == [.write, .other], "a kind a newer box adds reads as other")
        #expect(second.asker == "An agent" && !second.canAlways && second.error == "Operation not permitted")
    }

    @Test func aProjectsAlsoAllowedIsAskedForByItsFolder() throws {
        // The box reads it back as the same folder, whatever is in its name.
        for folder in ["/Users/me/My App & Co", "/home/me/c++/50%?=#done"] {
            let route = SandboxRoutes.allowed(project: folder)
            let read = URLComponents(string: "http://box/" + route)?.queryItems?.first { $0.name == "project" }?.value
            #expect(read == folder)
            #expect(!route.contains("+"), "a + reads as a space")
        }
        let allowed = try JSONDecoder().decode(SandboxAllowed.self, from: Data("""
        {"allowed":[{"id":"r_1","project":"/Users/me/app","kind":"write","path":"/Users/me/.cache/thing","at":1793200000000,"by":"Studio Mac"}]}
        """.utf8))
        #expect(allowed.allowed.map(\.path) == ["/Users/me/.cache/thing"])
    }
}

/// The card's words, the same in both apps: what was stopped first, the error where the sandbox
/// can't say (a machine's), and Always's place with its home folder as ~.
@Suite struct SandboxCardWordsTests {
    private let ask = SandboxAsk(id: "sa_1", at: 1_000_000, botName: "Scout", project: "/Users/me/kuvo-ai", command: "./scripts/install-hooks.sh",
                                 why: "Installing the repo's hooks, as the README asks.",
                                 stopped: [SandboxStop(kind: .write, path: "/Users/me/.zshrc")], always: .init(path: "/Users/me/.zshrc"))

    @Test func aStoppedWriteNamesItsProjectAndAlwaysItsPlace() {
        #expect(ask.title == "Scout wants to run a command outside the sandbox")
        #expect(ask.subtitle == "The sandbox stopped it from changing a file outside kuvo-ai.")
        #expect(ask.stopped?.map { "\($0.label) \($0.detail)" } == ["Write ~/.zshrc"])
        #expect(ask.alwaysPath == "~/.zshrc")
        #expect(ask.alwaysScope == nil && ask.alwaysTitle == "Always Allow ~/.zshrc")
    }

    @Test func aBotsOwnFolderOrTheChatsAreNamedAsSuchAndAChatsAlwaysIsEveryChats() {
        var fromScout = ask
        fromScout.project = "/Users/me/.kuvo-code/bots/bot_scout/workspace"
        fromScout.owner = SandboxOwner(kind: .bot, id: "bot_scout", name: "Scout")
        #expect(fromScout.subtitle == "The sandbox stopped it from changing a file outside Scout’s folder.")
        #expect(fromScout.alwaysTitle == "Always Allow ~/.zshrc")
        #expect(fromScout.alwaysHint == "Runs it, and from now on lets Scout’s commands write in ~/.zshrc too, in the sandbox.")
        var fromChat = ask
        fromChat.botName = nil
        fromChat.project = "/home/me/.kuvo-code/chats"
        fromChat.owner = .chats
        #expect(fromChat.subtitle == "The sandbox stopped it from changing a file outside Chats.")
        #expect(fromChat.alwaysScope == "in every chat" && fromChat.alwaysTitle == "Always Allow ~/.zshrc in every chat")
        #expect(fromChat.alwaysHint == "Runs it, and from now on lets every chat’s commands write in ~/.zshrc too, in the sandbox.")
        // A box before owners: by the folder's name, as before.
        var before = fromChat
        before.owner = nil
        #expect(before.subtitle == "The sandbox stopped it from changing a file outside chats." && before.alwaysScope == nil)
    }

    @Test func aMachinesErrorIsQuotedAndThereIsNoAlways() {
        let onLinux = SandboxAsk(id: "sa_2", project: "/home/me/kuvo-ai", command: "./scripts/install-hooks.sh", why: "Hooks.",
                                 error: "/home/me/.zshrc: Permission denied", machine: "devbox")
        #expect(onLinux.subtitle == "On devbox, the sandbox stopped it with this error.")
        #expect(onLinux.asker == "An agent" && onLinux.alwaysPath == nil)
        #expect(SandboxStop.short("/home/me/.zshrc") == "~/.zshrc" && SandboxStop.short("/root/.npm") == "~/.npm" && SandboxStop.short("/opt/x") == "/opt/x")
    }

    @Test func whatIsntAFileIsSaidInWords() {
        let app = SandboxStop(kind: .app), job = SandboxStop(kind: .job)
        #expect("\(app.label): \(app.detail)" == "App: Open or talk to an app")
        #expect("\(job.label): \(job.detail)" == "Job: Start a background job")
    }

    @Test func itSaysHowLongItsBeenWaitingOnceItsAMinute() {
        #expect(ask.waiting(now: 1_000_000 + 59_000) == nil)
        #expect(ask.waiting(now: 1_000_000 + 12 * 60_000 + 5_000) == "Scout is waiting for you · 12 min")
    }
}

/// Also Allowed at a glance: every rule on a computer, grouped by whose it is, in the order both
/// apps list them, with how far each reaches.
@Suite struct AlsoAllowedTests {
    private func rule(_ id: String, _ project: String, _ path: String, owner: SandboxOwner? = nil, gone: Bool? = nil) -> SandboxRule {
        SandboxRule(id: id, project: project, path: path, owner: owner, gone: gone)
    }

    @Test func rulesAreGroupedByWhoseTheyAreProjectsFirstThenBotsThenChats() throws {
        let scout = SandboxOwner(kind: .bot, id: "bot_scout", name: "Scout"), ada = SandboxOwner(kind: .bot, id: "bot_ada", name: "Ada")
        let listed = try JSONDecoder().decode(SandboxAllowed.self, from: Data("""
        {"allowed":[
          {"id":"r1","project":"/c/chats","kind":"write","path":"/x/exports","at":1,"owner":{"kind":"chats","name":"Chats"}},
          {"id":"r2","project":"/b/bot_scout/workspace","kind":"write","path":"/x/reports","at":2,"owner":{"kind":"bot","id":"bot_scout","name":"Scout"}},
          {"id":"r3","project":"/p/web","kind":"write","path":"/x/dist","at":3,"owner":{"kind":"project","name":"web"}},
          {"id":"r4","project":"/p/kuvo-ai","kind":"write","path":"/x/cache","at":4,"owner":{"kind":"project","name":"kuvo-ai"}},
          {"id":"r5","project":"/c/chats","kind":"write","path":"/x/receipts","at":5,"owner":{"kind":"chats","name":"Chats"}},
          {"id":"r6","project":"/b/bot_ada/workspace","kind":"write","path":"/x/notes","at":6,"owner":{"kind":"bot","id":"bot_ada","name":"Ada"}},
          {"id":"r7","project":"/p/old","kind":"write","path":"/x/old","at":7,"owner":{"kind":"project","name":"old"},"gone":true}],
         "owners":[{"kind":"bot","id":"bot_ada","name":"Ada"},{"kind":"bot","id":"bot_scout","name":"Scout"},{"kind":"chats","name":"Chats"}]}
        """.utf8))
        #expect(listed.owners == [ada, scout, .chats])
        // The client's own order for its projects, most recently used first, and its names for them.
        let groups = AlsoAllowed.groups(listed.allowed, names: ["/p/kuvo-ai": "Kuvo AI"], order: ["/p/kuvo-ai", "/p/web"])
        #expect(groups.map(\.name) == ["Kuvo AI", "web", "old", "Ada", "Scout", "Chats"])
        #expect(groups.map(\.caption) == ["project", "project", "folder no longer there", "its own folder", "its own folder", "every chat"])
        #expect(groups.last?.rules.map(\.path) == ["/x/exports", "/x/receipts"], "both chats' places under the one Chats")
        #expect(groups[2].gone)
    }

    @Test func aBoxBeforeOwnersListsEachRuleByItsProjectsFolder() {
        let groups = AlsoAllowed.groups([rule("r1", "/Users/me/shop", "/x/a"), rule("r2", "/Users/me/blog", "/x/b"), rule("r3", "/Users/me/shop", "/x/c")])
        #expect(groups.map(\.name) == ["blog", "shop"])
        #expect(groups.map { $0.rules.map(\.id) } == [["r2"], ["r1", "r3"]])
        #expect(groups.allSatisfy { $0.owner.kind == .project })
    }

    @Test func whatsAddedForABotOrTheChatsSaysWhose() throws {
        #expect(SandboxOwner(kind: .bot, id: "bot_scout", name: "Scout").sent == ["kind": "bot", "id": "bot_scout"])
        #expect(SandboxOwner.chats.sent == ["kind": "chats"])
        #expect(AlsoAllowed.choosing(for: .chats) == "Choose a folder every chat may write in, still in the sandbox.")
        #expect(SandboxRoutes.allowedAll == "kuvo/sandbox/allowed?all" && SandboxRoutes.rule("al_1", all: true) == "kuvo/sandbox/allowed/al_1?all")
        let noon = Date(timeIntervalSince1970: 1_793_275_200) // 2026-10-29, midday UTC
        #expect(AlsoAllowed.detail(of: SandboxRule(id: "r", project: "/p", path: "/x", at: noon.timeIntervalSince1970 * 1000, by: "Alex’s iPhone"), locale: Locale(identifier: "en_US")) == "Can write · Oct 29, from Alex’s iPhone")
    }
}
