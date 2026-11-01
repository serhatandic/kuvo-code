@testable import ClientDesign
import Testing

/// The marks both apps draw beside providers, coding agents, integrations and MCP servers come
/// with the app: each one people see resolves to its picture, with no network, and a service with
/// no mark of its own shows a plain symbol of what it is, never nothing.
@Suite struct BrandMarkTests {
    @Test func everyBundledMarkIsInTheApp() {
        for id in BrandMark.names.union(BrandMark.aliases.keys) {
            #expect(BrandMark.platformImage(id) != nil, "\(id) has no picture in the bundle")
        }
    }

    @Test func providersAgentsAndServicesHaveTheirOwnMarks() {
        // Cursor's service answered with a stock picture; it's bundled now.
        let ids = ["cursor", "anthropic", "openai", "google", "github-copilot", "openrouter", "xai", "zai",
                   "zhipuai-coding-plan", "claude-code", "codex-cli", "opencode-go",
                   "github", "gmail", "whatsapp", "x", "cloudflare-docs", "chrome-devtools", "huggingface"]
        for id in ids {
            #expect(BrandMark.platformImage(id) != nil, "\(id) shows no mark")
        }
    }

    @Test func servicesWithoutAMarkGetASymbolOfWhatTheyAre() {
        for id in ["slack", "microsoft-365", "linkedin", "apple-calendar", "context7"] {
            #expect(BrandMark.platformImage(id) == nil)
            #expect(BrandMark.symbol(id) != nil, "\(id) would fall back to a server")
        }
        #expect(BrandMark.platformImage("some-new-provider") == nil)
        #expect(BrandMark.symbol("some-new-provider") == nil)
    }
}
