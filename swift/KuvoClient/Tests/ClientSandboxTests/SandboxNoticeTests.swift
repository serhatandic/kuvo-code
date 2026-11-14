import ClientSandbox
import Foundation
import Testing

/// What Settings › Permissions says of a computer's sandbox, from what its box answers: a quiet line
/// when it's on, and when it isn't, why and the one button that fixes it, the same on both apps.
struct SandboxNoticeTests {
    private func state(_ json: String) throws -> SandboxState {
        try JSONDecoder().decode(SandboxState.self, from: Data(json.utf8))
    }

    @Test func onIsAQuietLineAndAnythingElseSaysWhyWithItsFix() throws {
        let on = try state(#"{"on": true, "able": true, "agents": false}"#).notice
        #expect(on.look == .on && on.title == nil && on.buttons.isEmpty)

        let failed = try state(#"{"on": false, "reason": "checkFailed", "check": "readsOwn", "action": "retry", "route": "kuvo/sandbox/check", "failures": 1}"#).notice
        #expect(failed.look == .needsYou)
        #expect(failed.title == "The sandbox’s check failed")
        #expect(failed.detail.contains("could still read Kuvo Code’s files"))
        #expect(failed.buttons.map(\.title) == ["Try Again"])
        let again = try state(#"{"on": false, "reason": "checkFailed", "check": "writesOwn", "failures": 3}"#).notice
        #expect(again.title == "The sandbox’s check failed again")
        #expect(again.buttons.map(\.action) == [.check, .report], "Report a Problem joins once it fails again")
        // A Linux machine's check that found a command could reach your login's services.
        #expect(try state(#"{"on": false, "reason": "checkFailed", "check": "services", "failures": 1}"#).notice.detail.contains("could still reach your login’s services"))

        #expect(try state(#"{"on": false, "reason": "plugin", "action": "fix"}"#).notice.buttons == [.init(title: "Fix It", action: .check)])
        #expect(try state(#"{"on": false, "reason": "waiting", "action": "restartEngine"}"#).notice.buttons == [.init(title: "Restart Engine…", action: .restartEngine(asking: true))])
        #expect(try state(#"{"on": false, "reason": "engineDown", "action": "restartEngine"}"#).notice.buttons == [.init(title: "Restart Engine", action: .restartEngine(asking: false))])
        let checking = try state(#"{"on": false, "reason": "checking"}"#).notice
        #expect(checking.look == .checking && checking.buttons.isEmpty)
    }

    @Test func aComputerThatCantHaveItSaysWhatItNeeds() throws {
        let linux = try state(#"{"on": false, "able": false, "reason": "kernel", "action": "help", "needs": "Linux 5.13", "why": "Linux 5.10 can't sandbox commands: it needs Landlock (Linux 5.13 or later, with it on)."}"#).notice
        #expect(linux.title == "Linux 5.10 can’t sandbox commands")
        #expect(linux.detail.contains("Linux 5.13 or later"))
        #expect(linux.buttons.map(\.action) == [.help])
        #expect(try state(#"{"on": false, "able": false, "reason": "macos", "action": "softwareUpdate"}"#).notice.buttons.map(\.action) == [.softwareUpdate])
        // A Linux machine whose commands can't have a namespace of their own, from a box that
        // doesn't run without one.
        let namespaces = try state(#"{"on": false, "able": false, "reason": "namespaces", "action": "help", "needs": "user namespaces", "why": "This machine doesn't let commands have a namespace of their own."}"#)
        #expect(namespaces.reason == .namespaces)
        #expect(namespaces.notice.title == "This machine can’t sandbox commands")
        #expect(namespaces.notice.detail.contains("until it allows user namespaces"))
        #expect(namespaces.notice.buttons.map(\.action) == [.help])
        #expect(try state(#"{"on": false, "able": false, "reason": "namespaces", "action": "help", "needs": "util-linux"}"#).notice.detail.contains("until it has util-linux"))
    }

    @Test func aMachineWhereItCantKeepCommandsFromYourServicesSaysSo() throws {
        // (A Linux machine whose commands can't have a namespace of their own: on, with a gap.)
        let without = try state(#"{"on": true, "able": true, "agents": true, "gaps": ["services"], "needs": "user namespaces"}"#).notice
        #expect(without.look == .needsYou, "not the green line that says all's well")
        #expect(without.title == "Commands can still reach your login’s services")
        #expect(without.detail.contains("Until it allows user namespaces, agents don’t use your vault here and goals don’t run on their own"))
        #expect(without.buttons.map(\.action) == [.help])
        #expect(try state(#"{"on": true, "able": true, "agents": true, "gaps": ["services"], "needs": "util-linux"}"#).notice.detail.contains("Until it has util-linux"))
        // A gap a newer box adds reads as none.
        #expect(try state(#"{"on": true, "able": true, "agents": true, "gaps": ["later"]}"#).notice.detail.contains("can’t read your keys"))
    }

    @Test func aReasonFromANewerBoxShowsItsOwnWords() throws {
        let newer = try state(#"{"on": false, "reason": "somethingNew", "why": "Its new part isn't ready.", "route": "kuvo/sandbox/check"}"#).notice
        #expect(newer.look == .needsYou)
        #expect(newer.detail == "Its new part isn't ready.")
        #expect(newer.buttons.map(\.action) == [.check])
        // Its button does what the route it names does, or there's none.
        let restarts = try state(#"{"on": false, "reason": "somethingNew", "route": "POST kuvo/engine/restart"}"#).notice
        #expect(restarts.buttons.map(\.action) == [.restartEngine(asking: true)])
        let unknown = try state(#"{"on": false, "reason": "somethingNew", "route": "POST kuvo/sandbox/somethingElse"}"#).notice
        #expect(unknown.buttons.isEmpty)
    }
}
