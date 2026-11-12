import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// This Mac's box answers everything but the app's own routes (`PhoneLink.appRoutes`, the box's
/// `MAC_APP_ROUTES`): what the app asks of it too, as a phone does, with nothing to list when a box
/// route is added. (What a phone gets with the app closed: the bridge's mac-link and mac-restart
/// tests.) This Mac's box is the real one, its engine a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BoxFirstTests {
    let engine = StubEngine(port: 48_207)

    @Test func theAppsOwnRequestsReachItsBoxForAllButItsOwnRoutes() async throws {
        let box = try await TestBox(engine: engine.url)
        defer {
            box.stop()
            engine.stop()
        }
        let client = box.client(engine: engine.url)

        // What this Mac is, as its box says it for the app and its phones alike.
        struct Info: Decodable { var kind: String; var name: String; var app: String; var engine: String; var chats: String; var features: [String] }
        let info = try await client.value(Info.self, "GET", "kuvo/info")
        #expect(info.kind == "mac")
        #expect(info.app == AppInfo.version)
        #expect(info.engine == "2.0.32", "the one running")
        #expect(info.chats == Workspace.chatsFolder)
        for feature in ["machines", "hosts", "mac", "claude-code", "usage", "sandbox.asks", "autopilot"] { #expect(info.features.contains(feature), "\(feature)") }
        #expect(!info.features.contains("update") && !info.features.contains("engine.start"), "a machine's own")

        // Routes no list named before: its news as it tells it (the Mac shows it as it's worded
        // there), and its sandbox.
        struct Told: Decodable { var telling: Bool }
        #expect(try await client.value(Told.self, "GET", "kuvo/notices").telling)
        #expect(try await client.send("GET", "kuvo/sandbox").status == 200)

        // The app's own stay its own: with no PhoneLink to answer them here, they say so, rather
        // than reach the box (which would say it has no such route).
        #expect(try await client.send("GET", "kuvo/hosts").status == 503)
        #expect(try await client.send("GET", "kuvo/usage").status == 503)
        // And one no box has, the box's to say.
        #expect(try await client.send("GET", "kuvo/nothing-here").status == 404)
    }

    /// Settings › Agents' and Commands' From Claude Code on this Mac: its own ~/.claude, as its box
    /// lists it (every box lists its own), with nothing read in the app.
    @Test func thisMacsOwnClaudeCodeIsItsBoxs() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "box-first-home-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: home.appending(path: ".claude/agents"), withIntermediateDirectories: true)
        try Data("---\nname: Reviewer\ndescription: Reviews code\n---\nReview it.\n".utf8).write(to: home.appending(path: ".claude/agents/reviewer.md"))
        let box = try await TestBox(engine: engine.url, environment: ["HOME": home.path])
        defer {
            box.stop()
            engine.stop()
        }
        let client = box.client(engine: engine.url)
        #expect(try await client.send("GET", "kuvo/claude-code").status == 200)
        let listed = await ClaudeCodeImports.read(for: client, others: [])
        #expect(listed.agents.map(\.path) == [["agents", "reviewer"]])
        #expect(listed.agents.first?.name == "Reviewer")
        #expect(listed.agents.first?.settings == .object(["mode": .string("subagent"), "description": .string("Reviews code"), "system": .string("Review it.")]))
    }
}
