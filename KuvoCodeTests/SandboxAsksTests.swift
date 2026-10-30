import ClientSandbox
import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// A command the sandbox stopped, which its agent asks to run outside it (PROTOCOL.md, "Sandbox"),
/// as this Mac shows and answers it: the conversation waits on you in the sidebar and the Dock while
/// its box asks, wherever you are in the app; your answer goes to its box and the card goes, and a
/// list the box sent before the answer doesn't bring it back; one answered meanwhile on a phone is
/// gone, not an error; one that can't be answered stays. The box is stood in for at its routes.
@MainActor
@Suite(.serialized) struct SandboxAsksTests {
    let app = AppModel()
    let sandboxes = Sandboxes()

    init() {
        TestEnvironment.prepare()
        sandboxes.onChange = { [app] sessions in app.workspace.askingOutsideSandbox = sessions }
    }

    private let ask = SandboxAsk(id: "sask_1", at: 1, session: "ses_scout", botName: "Scout", project: "/Users/me/kuvo-ai", command: "./scripts/install-hooks.sh",
                                 why: "Installing the repo’s hooks.", stopped: [SandboxStop(kind: .write, path: "/Users/me/.zshrc")], always: .init(path: "/Users/me/.zshrc"))

    /// A box that answers each answer with `status`, keeping what it was sent.
    private func box(answering status: Int) -> (BoxClient, Sent) {
        let sent = Sent()
        let client = BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            sent.add(request)
            return AsyncThrowingStream { continuation in
                continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data(status == 200 ? "{}".utf8 : #"{"error": "no"}"#.utf8)))
                continuation.finish()
            }
        })
        sandboxes.client = { $0 == BoxClient.mac ? client : nil }
        return (client, sent)
    }

    nonisolated final class Sent: @unchecked Sendable {
        private let lock = NSLock()
        private var requests: [LinkRequest] = []
        func add(_ request: LinkRequest) { lock.withLock { requests.append(request) } }
        var all: [LinkRequest] { lock.withLock { requests } }
    }

    @Test func anAskWaitsOnYouInTheSidebarUntilYouAnswerItAndAnEarlierListDoesntBringItBack() async throws {
        let (_, sent) = box(answering: 200)
        sandboxes.take([ask], from: BoxClient.mac)
        #expect(sandboxes.asks(for: "ses_scout", on: BoxClient.mac).map(\.id) == ["sask_1"])
        #expect(app.workspace.needsAttention("ses_scout"), "the conversation waits on you in the sidebar, open or not")
        #expect(app.workspace.waitingCount == 1, "and in the Dock's count")
        #expect(sandboxes.stoppedCommands(for: "ses_scout", on: BoxClient.mac) == ["./scripts/install-hooks.sh"], "its command's row is marked stopped")

        try await sandboxes.answer(ask, .always, on: BoxClient.mac)
        let answer = try #require(sent.all.last)
        #expect(answer.method == "POST" && answer.path == "kuvo/sandbox/asks/sask_1")
        #expect((try JSONSerialization.jsonObject(with: answer.body) as? [String: String])?["answer"] == "always")
        #expect(sandboxes.asks(for: "ses_scout", on: BoxClient.mac).isEmpty)
        #expect(!app.workspace.needsAttention("ses_scout"))

        // What the box listed just before it heard the answer.
        sandboxes.take([ask], from: BoxClient.mac)
        #expect(sandboxes.asks(for: "ses_scout", on: BoxClient.mac).isEmpty, "an answered ask doesn't come back")
        #expect(!app.workspace.needsAttention("ses_scout"))
    }

    @Test func anAskAnsweredOnAPhoneMeanwhileIsGoneNotAnError() async throws {
        _ = box(answering: 404)
        sandboxes.take([ask], from: BoxClient.mac)
        try await sandboxes.answer(ask, .once, on: BoxClient.mac)
        #expect(sandboxes.asks(for: "ses_scout", on: BoxClient.mac).isEmpty)
        #expect(!app.workspace.needsAttention("ses_scout"))
    }

    @Test func anAnswerThatDidntGoThroughLeavesTheCardToTryAgain() async throws {
        _ = box(answering: 500)
        sandboxes.take([ask], from: BoxClient.mac)
        await #expect(throws: BoxRefusal.self) { try await sandboxes.answer(ask, .once, on: BoxClient.mac) }
        #expect(sandboxes.asks(for: "ses_scout", on: BoxClient.mac).map(\.id) == ["sask_1"])
        #expect(app.workspace.needsAttention("ses_scout"))
    }

    @Test func aMachineRemovedTakesItsAsksWithIt() {
        sandboxes.take([ask], from: "lokum")
        #expect(app.workspace.needsAttention("ses_scout"))
        sandboxes.forget("lokum")
        #expect(sandboxes.asks(for: "ses_scout", on: "lokum").isEmpty)
        #expect(!app.workspace.needsAttention("ses_scout"))
    }

    /// The `sandbox_ask` row, once answered, says how its command ran, from what the box answered.
    @Test func theAskRowSaysHowItsCommandRan() {
        #expect(ToolCallView.sandboxOutcome("Ran outside the sandbox · Allowed once\n\nInstalled.") == "Ran outside the sandbox · Allowed once")
        #expect(ToolCallView.sandboxOutcome("Ran outside the sandbox · Always for this: /Users/me/.zshrc\n\nok") == "Ran outside the sandbox · Always for this")
        #expect(ToolCallView.sandboxOutcome("The user said no: run it in the sandbox instead.") == "You said no")
        #expect(ToolCallView.sandboxOutcome("Installed.") == nil)
    }
}
