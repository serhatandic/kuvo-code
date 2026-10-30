import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Settings › Agents (D9): the agent new sessions start in, removed, turned off or made a
/// subagent only, stops being that one, rather than Settings naming one that can't start a
/// session. Another agent's change leaves it be.
@MainActor
@Suite struct AgentsSettingsTests {
    private func config() -> EngineConfig {
        EngineConfig.inMemory([
            "default_agent": .string("bug-hunter"),
            "agents": .object(["bug-hunter": .object(["mode": .string("primary")]), "reviewer": .object(["mode": .string("primary")])]),
        ])
    }

    @Test func theAgentNewSessionsStartInStopsBeingItWhenItCantStartOne() async {
        for (key, value) in [(nil, nil), ("disabled", JSONValue.bool(true)), ("mode", JSONValue.string("subagent"))] as [(String?, JSONValue?)] {
            let config = config()
            config.changeAgent("reviewer", key, to: value)
            #expect(config.value(at: ["default_agent"]) == .string("bug-hunter"), "another agent's change: \(key ?? "removed")")
            config.changeAgent("bug-hunter", key, to: value)
            #expect(await config.settled() == nil)
            #expect(config.value(at: ["default_agent"]) == nil, "\(key ?? "removed")")
        }
        let config = config()
        config.changeAgent("bug-hunter", "mode", to: .string("all"))
        #expect(config.value(at: ["default_agent"]) == .string("bug-hunter"), "still a mode too")

        // Reset to Built-In: Plan's own settings taken away, and Plan still there to start in.
        let plan = EngineConfig.inMemory(["default_agent": .string("plan"), "agents": .object(["plan": .object(["model": .string("openai/luna")])])])
        plan.changeAgent("plan", nil, to: nil)
        #expect(plan.value(at: ["agents", "plan"]) == nil)
        #expect(plan.value(at: ["default_agent"]) == .string("plan"))
    }
}
