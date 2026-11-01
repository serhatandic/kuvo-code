import Foundation
import Testing
import ClientAccounts

/// Connecting a subscription that's used with a key: the key's field says which subscription the
/// key comes with, and links the page that has it. The same line on the Mac and the phone.
@Suite struct KeyPagesTests {
    /// Every plan the engine's catalog lists (models.dev, 2026-11-01), as the engine names it,
    /// and the name the line should give it.
    private let plans: [(id: String, engineName: String, plan: String)] = [
        ("opencode-go", "OpenCode Go", "OpenCode Go"),
        ("zai-coding-plan", "Z.AI Coding Plan", "GLM Coding Plan"),
        ("zhipuai-coding-plan", "Zhipu AI Coding Plan", "GLM Coding Plan"),
        ("kimi-code-plan-global", "Kimi For Coding (kimi.ai)", "Kimi For Coding"),
        ("kimi-code-plan-cn", "Kimi For Coding (kimi.com)", "Kimi For Coding"),
        ("minimax-coding-plan", "MiniMax Token Plan (minimax.io)", "MiniMax Token Plan"),
        ("minimax-cn-coding-plan", "MiniMax Token Plan (minimax.cn)", "MiniMax Token Plan"),
        ("alibaba-coding-plan", "Alibaba Coding Plan", "Alibaba Coding Plan"),
        ("alibaba-coding-plan-cn", "Alibaba Coding Plan (China)", "Alibaba Coding Plan"),
        ("alibaba-token-plan", "Alibaba Token Plan", "Alibaba Token Plan"),
        ("alibaba-token-plan-cn", "Alibaba Token Plan (China)", "Alibaba Token Plan"),
        ("tencent-coding-plan", "Tencent Coding Plan (China)", "Tencent Coding Plan"),
        ("tencent-token-plan", "Tencent Token Plan", "Tencent Token Plan"),
        ("volcengine-coding-plan", "Volcengine Ark Coding Plan", "Volcengine Ark Coding Plan"),
        ("stepfun-step-plan", "StepFun Step Plan (China)", "StepFun Step Plan"),
        ("stepfun-ai-step-plan", "StepFun Step Plan (Global)", "StepFun Step Plan"),
        ("xiaomi-token-plan-cn", "Xiaomi Token Plan (China)", "Xiaomi Token Plan"),
        ("xiaomi-token-plan-ams", "Xiaomi Token Plan (Europe)", "Xiaomi Token Plan"),
        ("xiaomi-token-plan-sgp", "Xiaomi Token Plan (Singapore)", "Xiaomi Token Plan"),
        ("kuae-cloud-coding-plan", "KUAE Cloud Coding Plan", "KUAE Cloud Coding Plan"),
        ("umans-ai-coding-plan", "Umans AI Coding Plan", "Umans AI Coding Plan"),
        ("scnet-token-plan", "SCNet Token Plan", "SCNet Token Plan"),
    ]

    @Test func everyPlanSaysWhichSubscriptionItsKeyComesWith() {
        for entry in plans {
            let page = KeyPage.page(for: entry.id, name: entry.engineName)
            #expect(page?.plan == entry.plan, "\(entry.id)")
            #expect(page?.line.hasPrefix("Your \(entry.plan) subscription's key") == true, "\(entry.id)")
            #expect(page?.url != nil, "\(entry.id) links where its key is")
        }
    }

    @Test func linesReadAsSentences() {
        #expect(KeyPage.page(for: "opencode-go", name: "OpenCode Go")?.line == "Your OpenCode Go subscription's key, from your OpenCode console.")
        #expect(KeyPage.page(for: "minimax-coding-plan", name: "MiniMax Token Plan (minimax.io)")?.line == "Your MiniMax Token Plan subscription's key, from your MiniMax console.")
        // OpenCode Zen's key is a key of its own, from the same console.
        #expect(KeyPage.page(for: "opencode", name: "OpenCode Zen")?.line == "Your key, from your OpenCode console.")
        // Where only the docs say where the key is, the link says it opens them.
        let xiaomi = KeyPage.page(for: "xiaomi-token-plan-ams", name: "Xiaomi Token Plan (Europe)")
        #expect(xiaomi?.line == "Your Xiaomi Token Plan subscription's key.")
        #expect(xiaomi?.linkTitle == "How to Get It")
        #expect(KeyPage.page(for: "zai-coding-plan", name: "Z.AI Coding Plan")?.linkTitle == "Get Your Key")
    }

    @Test func aPlanTheEngineAddsLaterStillSaysSo() {
        // Its catalog links its docs: they're the link, and say they're docs.
        let docs = URL(string: "https://acme.example/docs/coding-plan")!
        let linked = KeyPage.page(for: "acme-coding-plan-eu", name: "Acme Coding Plan (Europe)", docs: docs)
        #expect(linked?.line == "Your Acme Coding Plan subscription's key.")
        #expect(linked?.url == docs)
        #expect(linked?.linkTitle == "How to Get It")
        // No docs either: the line alone.
        let page = KeyPage.page(for: "acme-coding-plan-eu", name: "Acme Coding Plan (Europe)")
        #expect(page?.line == "Your Acme Coding Plan subscription's key.")
        #expect(page?.url == nil)
        // Docs that aren't a web page aren't a link.
        let odd = KeyPage.page(for: "acme-coding-plan-eu", name: "Acme Coding Plan", docs: URL(string: "javascript:alert(1)"))
        #expect(odd?.url == nil)
        #expect(odd?.line == "Your Acme Coding Plan subscription's key.")
    }

    @Test func theLineShowsAndReadsItsLinkOnlyWhenThereIsOne() throws {
        let zai = try #require(KeyPage.page(for: "zai-coding-plan", name: "Z.AI Coding Plan"))
        let shown = zai.linkedLine
        #expect(String(shown.characters) == "Your GLM Coding Plan subscription's key, from your Z.ai account. Get Your Key")
        let linked = shown.runs.compactMap { run in run.link.map { (String(shown[run.range].characters), $0) } }
        #expect(linked.map(\.0) == ["Get Your Key"])
        #expect(linked.map(\.1) == [zai.url])
        #expect(zai.spokenLine == "Your GLM Coding Plan subscription's key, from your Z.ai account. Get Your Key")

        // No link: VoiceOver still reads the line, and nothing in it is a link.
        let bare = try #require(KeyPage.page(for: "acme-coding-plan", name: "Acme Coding Plan"))
        #expect(String(bare.linkedLine.characters) == "Your Acme Coding Plan subscription's key.")
        #expect(bare.linkedLine.runs.allSatisfy { $0.link == nil })
        #expect(bare.spokenLine == "Your Acme Coding Plan subscription's key.")
    }

    @Test func aKnownPageWinsOverTheCatalogsDocs() {
        let page = KeyPage.page(for: "zai-coding-plan", name: "Z.AI Coding Plan", docs: URL(string: "https://docs.z.ai/devpack/overview"))
        #expect(page?.url?.absoluteString == "https://z.ai/manage-apikey/apikey-list")
        #expect(page?.linkTitle == "Get Your Key")
    }

    @Test func anOrdinaryKeyHasNoLine() {
        #expect(KeyPage.page(for: "anthropic", name: "Anthropic") == nil)
        #expect(KeyPage.page(for: "openrouter", name: "OpenRouter") == nil)
        #expect(KeyPage.page(for: "explainer", name: "Explainer") == nil)
    }
}
