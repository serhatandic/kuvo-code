import Foundation

/// Where a provider's key comes from, for those whose key isn't pay-as-you-go but comes with a
/// subscription you already have (or from a console that isn't the obvious one): what it is, and
/// the page that has it.
///
/// Any provider the engine lists as a plan (`zai-coding-plan`, `xiaomi-token-plan-ams`, …) gets
/// one, named as the engine names it, so a plan the engine adds tomorrow says so too. The table
/// below only adds what the engine doesn't know: the page that has the key, as the provider's own
/// docs link it, and a name where the maker's differs from the engine's.
public struct KeyPage: Equatable, Sendable {
    /// The subscription the key comes with; nil for a key of its own.
    public var plan: String?
    /// Where you get it, as a place you'd recognize; nil when that's only in the provider's docs.
    public var source: String?
    /// The page that has the key, or the docs that say where it is (`opensDocs`).
    public var url: URL?
    public var opensDocs: Bool

    /// The line beside the key's field, like "Your OpenCode Go subscription's key, from your
    /// OpenCode console."
    public var line: String {
        let whose = plan.map { "Your \($0) subscription's key" } ?? "Your key"
        return source.map { "\(whose), from \($0)." } ?? "\(whose)."
    }

    /// The link after the line.
    public var linkTitle: String { opensDocs ? "How to Get It" : "Get Your Key" }

    /// The line as the key's field shows it, with the link at its end when there is one.
    public var linkedLine: AttributedString {
        guard let url else { return AttributedString(line) }
        var link = AttributedString(linkTitle)
        link.link = url
        return AttributedString(line + " ") + link
    }

    /// What VoiceOver reads for the line, as one element that opens the link: the line, and the
    /// link's title when there is one.
    public var spokenLine: String { url == nil ? line : "\(line) \(linkTitle)" }

    /// The page for an engine's provider, given the name the engine lists it by and the docs its
    /// catalog links, if any; nil for a provider whose key is an ordinary one. A plan the table
    /// doesn't know links its docs.
    public static func page(for providerID: String, name: String, docs: URL? = nil) -> KeyPage? {
        let known = pages[providerID]
        guard known != nil || isPlan(providerID) else { return nil }
        let plan: String? = switch known?.plan ?? .engine {
        case .engine: planName(name)
        case .named(let named): named
        case .keyOfItsOwn: nil
        }
        guard let known else {
            // Only a web page: anything else from a catalog would be a dead link.
            let docs = docs.flatMap { ["http", "https"].contains($0.scheme?.lowercased() ?? "") ? $0 : nil }
            return KeyPage(plan: plan, source: nil, url: docs, opensDocs: docs != nil)
        }
        return KeyPage(plan: plan, source: known.source, url: known.url, opensDocs: known.opensDocs)
    }

    /// Whether the engine's provider is a subscription used with a key: its id has "plan" as a
    /// word (`kimi-code-plan-global`, `stepfun-step-plan`).
    public static func isPlan(_ providerID: String) -> Bool {
        providerID.split(separator: "-").contains("plan")
    }

    /// The engine's name without the region or site it adds ("MiniMax Token Plan (minimax.io)").
    static func planName(_ name: String) -> String {
        guard name.hasSuffix(")"), let open = name.lastIndex(of: "(") else { return name }
        let trimmed = name[..<open].trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? name : trimmed
    }

    private enum Plan { case engine, named(String), keyOfItsOwn }

    private struct Known {
        var plan: Plan = .engine
        var source: String?
        var url: URL
        var opensDocs = false

        init(plan: Plan = .engine, source: String? = nil, url: StaticString, opensDocs: Bool = false) {
            self.plan = plan
            self.source = source
            self.url = URL(string: "\(url)")!
            self.opensDocs = opensDocs
        }
    }

    // Each page is the one the provider's own docs link for the key (read 2026-11-01). Where the
    // docs name no page, they're the link.
    private static let pages: [String: Known] = [
        "opencode-go": Known(source: "your OpenCode console", url: "https://opencode.ai/console"),
        "opencode": Known(plan: .keyOfItsOwn, source: "your OpenCode console", url: "https://opencode.ai/console"),
        "zai-coding-plan": Known(plan: .named("GLM Coding Plan"), source: "your Z.ai account", url: "https://z.ai/manage-apikey/apikey-list"),
        "zhipuai-coding-plan": Known(plan: .named("GLM Coding Plan"), source: "your BigModel account", url: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys"),
        // Kimi's docs serve both sites, and send both to kimi.com's console.
        "kimi-code-plan-global": Known(source: "the Kimi Code console", url: "https://www.kimi.com/code/console"),
        "kimi-code-plan-cn": Known(source: "the Kimi Code console", url: "https://www.kimi.com/code/console"),
        "minimax-coding-plan": Known(source: "your MiniMax console", url: "https://platform.minimax.io/console/plan"),
        "minimax-cn-coding-plan": Known(source: "your MiniMax console", url: "https://platform.minimax.cn/console/plan"),
        "alibaba-coding-plan": Known(source: "Model Studio", url: "https://modelstudio.console.alibabacloud.com/ap-southeast-1/subscription/coding-plan"),
        "alibaba-coding-plan-cn": Known(source: "Model Studio", url: "https://bailian.console.aliyun.com/cn-beijing/subscription/coding-plan"),
        "alibaba-token-plan": Known(source: "Model Studio", url: "https://modelstudio.console.alibabacloud.com/ap-southeast-1/subscription/token-plan"),
        "alibaba-token-plan-cn": Known(source: "Model Studio", url: "https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan"),
        "tencent-coding-plan": Known(source: "TokenHub", url: "https://console.cloud.tencent.com/tokenhub/codingplan"),
        "tencent-token-plan": Known(source: "TokenHub", url: "https://console.cloud.tencent.com/tokenhub/tokenplan/common"),
        "volcengine-coding-plan": Known(source: "the Ark console", url: "https://ark.volcengine.com/region:cn-beijing/apikey"),
        "stepfun-step-plan": Known(source: "your StepFun account", url: "https://platform.stepfun.com/interface-key"),
        "stepfun-ai-step-plan": Known(source: "your StepFun account", url: "https://platform.stepfun.ai/interface-key"),
        "xiaomi-token-plan-cn": Known(url: "https://platform.xiaomimimo.com/#/docs", opensDocs: true),
        "xiaomi-token-plan-ams": Known(url: "https://platform.xiaomimimo.com/#/docs", opensDocs: true),
        "xiaomi-token-plan-sgp": Known(url: "https://platform.xiaomimimo.com/#/docs", opensDocs: true),
        "kuae-cloud-coding-plan": Known(url: "https://docs.mthreads.com/kuaecloud/kuaecloud-doc-online/coding_plan/", opensDocs: true),
        "umans-ai-coding-plan": Known(url: "https://app.umans.ai/offers/code/docs", opensDocs: true),
        "scnet-token-plan": Known(url: "https://www.scnet.cn/ac/openapi/doc/2.0/moduleapi/plans/token-plan.html", opensDocs: true),
    ]
}
