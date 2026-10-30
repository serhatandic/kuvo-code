import ClientSandbox
import Foundation
import KuvoLink
import OpenCodeKit
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
                continuation.yield(.body(Data(status == 200 ? "{}".utf8 : #"{"message": "The command's folder is gone."}"#.utf8)))
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
        #expect(sandboxes.failures["sask_1"] == "The command's folder is gone.", "its card says why, in its computer's words")
        #expect(app.workspace.needsAttention("ses_scout"))
    }

    @Test func aMachineRemovedTakesItsAsksWithIt() {
        #expect(sandboxes.stoppedCommands(for: "ses_scout", on: "lokum") == nil, "not heard yet: unknown, not nothing")
        sandboxes.take([ask], from: "lokum")
        #expect(app.workspace.needsAttention("ses_scout"))
        sandboxes.forget("lokum")
        #expect(sandboxes.asks(for: "ses_scout", on: "lokum").isEmpty)
        #expect(sandboxes.stoppedCommands(for: "ses_scout", on: "lokum") == nil)
        #expect(!app.workspace.needsAttention("ses_scout"))
    }

    /// The `sandbox_ask` row says what's happening to its command: asked while its ask is open,
    /// running once you allowed it, then how it ran, and never "Ran" for one that didn't.
    @Test func theAskRowSaysWhatHappenedToItsCommand() throws {
        let input: [String: Any] = ["command": "npm run build:icons", "why": "Its renders cache."]
        #expect(try words(input, running: true, stopped: []) == "Running `npm run build:icons` outside the sandbox", "allowed, it runs in the same call")
        #expect(try words(input, running: true, stopped: ["npm run build:icons"]) == "Asking to run `npm run build:icons` outside the sandbox")
        #expect(try words(input, running: true, stopped: nil) == "Asking to run `npm run build:icons` outside the sandbox", "its box not heard yet: never said to be running")
        #expect(try words(input, failed: "Ran outside the sandbox · Allowed once\n\nnpm ERR!\n\nIt ended with 1.") == "Ran `npm run build:icons`")
        #expect(try words(input, output: "Ran outside the sandbox · Allowed once\n\nIt ended with 0.") == "Ran `npm run build:icons`")
        #expect(try words(input, output: "The user said no: don't run it.") == "Didn’t run `npm run build:icons`")
        #expect(try words(input, output: "Nobody answered in time, so it didn't run.") == "Didn’t run `npm run build:icons`")
        #expect(try words(input, output: "Say why the task needs it.") == "Asked to run `npm run build:icons` outside the sandbox", "a call the box refused ran nothing")
        #expect(ToolCallView.sandboxOutcome("Ran outside the sandbox · Always for this: from now on…") == "Ran outside the sandbox · Always for this")
        #expect(ToolCallView.sandboxOutcome("Nobody answered in time, so it didn't run.") == "No answer", "not “You said no”")
    }

    private func words(_ input: [String: Any], running: Bool = false, stopped: Set<String>? = [], output: String = "", failed: String? = nil) throws -> String {
        let state: [String: Any] = running ? ["status": "running", "input": input]
            : failed.map { ["status": "error", "input": input, "error": ["type": "tool", "message": $0]] }
            ?? ["status": "completed", "input": input, "content": [["type": "text", "text": output]], "metadata": [:]]
        let message: [String: Any] = ["id": "m", "type": "assistant", "agent": "build", "time": ["created": 1], "model": ["id": "m", "providerID": "p"],
                                      "content": [["type": "tool", "id": "c", "name": "kuvo-browser_sandbox_ask", "executed": true, "state": state]]]
        let decoded = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: message))
        guard case .assistant(let assistant) = decoded, case .tool(let call)? = assistant.content.first else { throw TestFailure("no tool call") }
        if let failed { guard case .failed = call.state else { throw TestFailure("not failed: \(failed)") } }
        return ToolCallView.summary(of: call, in: "/Users/me/kuvo-ai", stopped: stopped)
    }
}
