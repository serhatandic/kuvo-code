import SwiftUI
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// The marks of the providers, model makers, coding agents and services Kuvo Code names itself,
/// bundled so both apps draw them with no network: real marks (models.dev's, Simple Icons',
/// UsageKit's), monochrome, as templates in the ink around them, so a list reads as one icon set.
/// A service with no mark of its own gets a plain symbol of what it is (a calendar, mail), never
/// a letter. Ids are models.dev's provider ids ("anthropic", "github-copilot"), UsageKit's
/// ("claude", "cursor"), the coding agents' ("claude-code") and Kuvo Code's integrations' and MCP
/// servers' ("slack", "cloudflare-docs").
public enum BrandMark {
    /// The mark of who made a model (its family, or its id), so a Claude model served through
    /// Copilot still shows Anthropic's; else its provider's.
    public static func maker(of model: String, provider: String) -> String {
        let family = model.lowercased()
        let prefixes: [(String, String)] = [
            ("claude", "anthropic"), ("gpt", "openai"), ("o1", "openai"), ("o3", "openai"), ("o4", "openai"), ("codex", "openai"),
            ("gemini", "google"), ("gemma", "google"), ("grok", "xai"), ("kimi", "moonshotai"), ("deepseek", "deepseek"),
            ("mistral", "mistral"), ("codestral", "mistral"), ("devstral", "mistral"), ("llama", "meta"), ("glm", "zhipuai"), ("minimax", "minimax"),
        ]
        return prefixes.first { family.hasPrefix($0.0) }?.1 ?? provider
    }

    /// Whether the app comes with a mark for `id`.
    public static func has(_ id: String) -> Bool { assetName(id) != nil }

    /// The bundled mark's id for a site ("github.com", "https://dashboard.stripe.com/login"), as a
    /// vault item names it: by the site's own name, or the service it is ("mail.google.com" is
    /// Gmail). Nil for a site with no bundled mark.
    public static func id(forSite site: String) -> String? {
        var host = site.lowercased().trimmingCharacters(in: .whitespaces)
        if let scheme = host.range(of: "://") { host = String(host[scheme.upperBound...]) }
        host = String(host.prefix { $0 != "/" && $0 != ":" && $0 != "?" })
        if host.hasPrefix("www.") { host.removeFirst(4) }
        let labels = host.split(separator: ".").map(String.init)
        guard labels.count >= 2 else { return nil }
        for length in stride(from: labels.count, through: 2, by: -1) {
            if let id = sites[labels.suffix(length).joined(separator: ".")] { return id }
        }
        // A site of someone's own on a host's domain ("me.github.io") is theirs, not the host's.
        if labels.count > 2, hosts.contains(labels.suffix(2).joined(separator: ".")) { return nil }
        let name = labels[labels.count - 2]
        return has(name) ? name : nil
    }

    /// Sites named for something other than their service's mark.
    static let sites: [String: String] = [
        "mail.google.com": "gmail", "calendar.google.com": "google-calendar",
        "twitter.com": "x", "claude.ai": "claude", "chatgpt.com": "openai", "bsky.app": "bluesky",
        "ai.studio": "google", "aistudio.google.com": "google", "copilot.microsoft.com": "copilot",
        "web.telegram.org": "telegram", "t.me": "telegram", "wa.me": "whatsapp", "zoom.us": "zoom",
        "x.ai": "xai", "z.ai": "zai",
    ]

    /// Domains where people's own sites live, under a name of their own.
    static let hosts: Set<String> = [
        "github.io", "vercel.app", "supabase.co", "netlify.app", "pages.dev", "workers.dev", "web.app",
        "firebaseapp.com", "herokuapp.com", "fly.dev", "onrender.com", "gitlab.io", "hf.space",
    ]

    /// The bundled mark for `id`, if there is one.
    public static func image(_ id: String) -> Image? {
        guard let name = assetName(id) else { return nil }
        return Image(name, bundle: .module).renderingMode(.template)
    }

    #if canImport(AppKit)
    /// The bundled mark as a template image, for AppKit (menus).
    public static func platformImage(_ id: String) -> NSImage? {
        guard let name = assetName(id), let image = Bundle.module.image(forResource: name) else { return nil }
        image.isTemplate = true
        return image
    }
    #elseif canImport(UIKit)
    /// The bundled mark as a template image, for UIKit.
    public static func platformImage(_ id: String) -> UIImage? {
        assetName(id).flatMap { UIImage(named: $0, in: .module, with: nil)?.withRenderingMode(.alwaysTemplate) }
    }
    #endif

    /// A plain symbol for a service Kuvo Code names that has no mark of its own (its maker doesn't
    /// allow one, or it's a kind of thing rather than a brand).
    public static func symbol(_ id: String) -> String? { symbols[id.lowercased()] }

    /// What's drawn when nothing is known about `id`: a provider, a server.
    public static let fallbackSymbol = "server.rack"

    /// The asset `id` is drawn with: its own, or the one it shares (a provider's regional or plan
    /// variants, a coding agent's product).
    static func assetName(_ id: String) -> String? {
        let id = id.lowercased()
        let name = aliases[id] ?? id
        return names.contains(name) ? name : nil
    }

    /// Every bundled mark, by asset name (Resources/Marks.xcassets).
    static let names: Set<String> = [
        // models.dev's provider logos (MIT)
        "ai21", "alibaba", "amazon-bedrock", "amd", "anthropic", "arcee", "azure", "baseten", "cerebras",
        "cloudflare-workers-ai", "cohere", "databricks", "deepinfra", "deepseek", "digitalocean", "fireworks-ai",
        "friendli", "github-copilot", "gitlab", "google", "google-vertex", "groq", "helicone", "huggingface",
        "inception", "io-net", "kilo", "liquid", "llmgateway", "lmstudio", "meta", "minimax", "mistral", "modal",
        "moonshotai", "nebius", "neon", "novita-ai", "nvidia", "oci", "ollama-cloud", "openai", "opencode",
        "openrouter", "ovhcloud", "perplexity", "poe", "scaleway", "siliconflow", "snowflake-cortex", "stepfun",
        "togetherai", "venice", "vercel", "volcengine", "wandb", "watsonx", "xai", "xiaomi", "zai",
        // Simple Icons (CC0)
        "asana", "atlassian", "bluesky", "calendly", "chrome", "cloudflare", "discord", "figma", "github", "gmail",
        "google-calendar", "linear", "mastodon", "notion", "reddit", "sentry", "stripe", "supabase", "telegram",
        "todoist", "whatsapp", "x", "zoom",
        // UsageKit's provider icons (MIT, from OpenUsage)
        "antigravity", "claude", "codex", "copilot", "cursor", "devin", "grok", "ollama",
    ]

    /// Ids drawn with another's mark: the same provider in another region or plan, a coding agent
    /// by its product, a service by its maker's.
    static let aliases: [String: String] = [
        "google-vertex-anthropic": "google-vertex",
        "azure-cognitive-services": "azure",
        "alibaba-cn": "alibaba", "alibaba-coding-plan": "alibaba", "alibaba-coding-plan-cn": "alibaba",
        "alibaba-token-plan": "alibaba", "alibaba-token-plan-cn": "alibaba",
        "minimax-cn": "minimax", "minimax-coding-plan": "minimax", "minimax-cn-coding-plan": "minimax",
        "moonshotai-cn": "moonshotai", "kimi-code-plan-global": "moonshotai", "kimi-code-plan-cn": "moonshotai",
        "xiaomi-token-plan-ams": "xiaomi", "xiaomi-token-plan-cn": "xiaomi", "xiaomi-token-plan-sgp": "xiaomi",
        "zai-coding-plan": "zai", "zhipuai": "zai", "zhipuai-coding-plan": "zai",
        "cloudflare-ai-gateway": "cloudflare-workers-ai",
        "perplexity-agent": "perplexity",
        "siliconflow-cn": "siliconflow",
        "stepfun-ai": "stepfun", "stepfun-step-plan": "stepfun", "stepfun-ai-step-plan": "stepfun",
        "volcengine-coding-plan": "volcengine",
        "opencode-go": "opencode",
        "claude-code": "claude", "codex-cli": "codex", "grok-cli": "grok",
        "cloudflare-docs": "cloudflare", "chrome-devtools": "chrome",
    ]

    /// Services with no mark to bundle: Microsoft, Slack, LinkedIn and Fastmail asked Simple Icons
    /// to drop theirs; the rest are kinds of things.
    static let symbols: [String: String] = [
        "apple-calendar": "calendar",
        "caldav": "calendar",
        "microsoft-365": "envelope",
        "fastmail": "envelope",
        "slack": "bubble.left.and.bubble.right",
        "linkedin": "person.2",
        "context7": "books.vertical",
    ]
}

/// A provider's or service's mark, in the ink around it: its bundled mark, else the plain symbol
/// for what it is, else `fallback`. VoiceOver passes over it: the name beside it says it.
public struct BrandMarkView: View {
    let id: String
    let size: CGFloat
    let fallback: String?

    /// `fallback`: the symbol for an id with no mark (an integration's own, so two services of a
    /// kind keep theirs apart); without one, the plain symbol for what it is, else a server's.
    public init(_ id: String, size: CGFloat, fallback: String? = nil) {
        self.id = id
        self.size = size
        self.fallback = fallback
    }

    public var body: some View {
        Group {
            if let image = BrandMark.image(id) {
                // Marks fill their whole square, symbols don't: a little smaller, so the two
                // weigh the same in a list.
                image
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .padding(size * 0.075)
            } else {
                Image(systemName: fallback ?? BrandMark.symbol(id) ?? BrandMark.fallbackSymbol)
                    .font(.system(size: size * 0.88))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
