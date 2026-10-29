import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Anonymous usage never names what's yours: a provider of your own is "other", and a model is
/// named only when it's a public provider's, as the public catalog has it; one you set up (a
/// deployment, a local model, your own name for one) is "custom".
@MainActor
@Suite(.serialized) struct AnalyticsPrivacyTests {
    let catalog = Catalog()
    let config: EngineConfig

    init() async throws {
        TestEnvironment.prepare()
        config = EngineConfig.inMemory()
        // The engine's models, as it lists them: a public one, and one of yours on a public provider.
        StubWeb.start(hosts: ["127.0.0.1", "models.opencode.ai"])
        let engine = "http://127.0.0.1:47996"
        func model(_ id: String, released: Int, cost: [[String: Any]]) -> [String: Any] {
            ["id": id, "modelID": id, "providerID": "openai", "name": id, "capabilities": ["tools": true, "input": ["text"], "output": ["text"]],
             "variants": [], "time": ["released": released], "cost": cost, "status": "active", "enabled": true, "limit": ["context": 1000, "output": 100]]
        }
        let location = ["directory": "/"]
        try StubWeb.answer(engine + "/api/model", json: ["location": location, "data": [model("gpt-6-luna", released: 1_790_000_000_000, cost: [["input": 1, "output": 2]]),
                                                                                           model("my-finetune", released: 0, cost: [])]])
        for path in ["integration", "agent", "command"] { try StubWeb.answer(engine + "/api/" + path, json: ["location": location, "data": []]) }
        try StubWeb.answer(engine + "/api/model/default", json: ["location": location, "data": NSNull()])
        catalog.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: engine)!, password: "test"))
        await catalog.refresh()
        StubWeb.stop()
        Analytics.shared.catalog = catalog
    }

    @Test func aPublicModelByItsName() {
        #expect(Analytics.model(provider: "openai", model: "gpt-6-luna")["model"] as? String == "gpt-6-luna")
    }

    @Test func yoursIsCustom() {
        #expect(Analytics.model(provider: "openai", model: "my-finetune")["model"] as? String == "custom")
        #expect(Analytics.model(provider: "openai", model: "not-listed")["model"] as? String == "custom")
        // Your own name for a public one, in the settings file.
        config.set(.object(["name": .string("Luna for work")]), at: ["providers", "openai", "models", "gpt-6-luna"])
        // (Other suites make settings files too: this one is the one in use, here.)
        EngineConfig.current = config
        #expect(Analytics.model(provider: "openai", model: "gpt-6-luna")["model"] as? String == "custom")
    }

    @Test func aProviderOfYourOwnIsOther() {
        let props = Analytics.model(provider: "acme-internal-gateway", model: "secret-model")
        #expect(props["provider"] as? String == "other")
        #expect(props["model"] == nil)
        #expect(Analytics.provider(nil) == "none")
    }
}
