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

    /// A vault item's site shows its service's mark, however the site is written.
    @Test func aSiteShowsItsServicesMark() {
        #expect(BrandMark.id(forSite: "github.com") == "github")
        #expect(BrandMark.id(forSite: "https://dashboard.stripe.com/login?next=/") == "stripe")
        #expect(BrandMark.id(forSite: "www.Figma.com") == "figma")
        #expect(BrandMark.id(forSite: "mail.google.com") == "gmail")
        #expect(BrandMark.id(forSite: "accounts.google.com") == "google")
        #expect(BrandMark.id(forSite: "twitter.com") == "x")
        #expect(BrandMark.id(forSite: "localhost:3000") == nil)
        #expect(BrandMark.id(forSite: "my-bank.example") == nil)
        #expect(BrandMark.id(forSite: "") == nil)
        // A maker's console under its own short domain, not another service's mark.
        #expect(BrandMark.id(forSite: "console.x.ai") == "xai")
        #expect(BrandMark.id(forSite: "z.ai") == "zai")
        // Someone's own site on a host's domain is theirs, not the host's.
        for site in ["me.github.io", "shop.vercel.app", "abc123.supabase.co", "blog.netlify.app", "app.pages.dev"] {
            #expect(BrandMark.id(forSite: site) == nil, "\(site) shows its host's mark")
        }
        #expect(BrandMark.id(forSite: "vercel.com") == "vercel")
        #expect(BrandMark.id(forSite: "supabase.com") == "supabase")
        for id in BrandMark.sites.values { #expect(BrandMark.has(id), "\(id) has no mark") }
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
