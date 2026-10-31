import Foundation

/// Where a provider's key comes from, for those whose key isn't pay-as-you-go but comes with a
/// subscription you already have (or from a console that isn't the obvious one): what it is, and
/// the page that has it. Each page is the one the provider's own docs send you to.
public struct KeyPage: Equatable, Sendable {
    /// The subscription the key comes with, as its maker names it; nil for a key of its own.
    public var plan: String?
    /// Where you get it, as a place you'd recognize.
    public var source: String
    public var url: URL

    /// The line beside the key's field, like "Your Go subscription's key, from your OpenCode
    /// console."
    public var line: String {
        if let plan { return "Your \(plan) subscription's key, from \(source)." }
        return "Your key, from \(source)."
    }

    /// The page for an engine's provider, if it's one of these.
    public static func page(for providerID: String) -> KeyPage? {
        pages[providerID]
    }

    private static let pages: [String: KeyPage] = [
        "opencode-go": KeyPage(plan: "Go", source: "your OpenCode console", url: "https://opencode.ai/console"),
        "opencode": KeyPage(plan: nil, source: "your OpenCode console", url: "https://opencode.ai/console"),
        "zai-coding-plan": KeyPage(plan: "GLM Coding Plan", source: "your Z.ai account", url: "https://z.ai/manage-apikey/apikey-list"),
        "zhipuai-coding-plan": KeyPage(plan: "GLM Coding Plan", source: "your BigModel account", url: "https://bigmodel.cn/apikey/coding-plan-per"),
        "kimi-code-plan-cn": KeyPage(plan: "Kimi", source: "the Kimi Code console", url: "https://www.kimi.com/code/console"),
        "minimax-coding-plan": KeyPage(plan: "MiniMax M Plan", source: "your MiniMax console", url: "https://platform.minimax.io/console/plan"),
        "minimax-cn-coding-plan": KeyPage(plan: "MiniMax M Plan", source: "your MiniMax console", url: "https://platform.minimax.cn/console/plan"),
        "alibaba-coding-plan": KeyPage(plan: "Coding Plan", source: "Model Studio's Coding Plan page", url: "https://modelstudio.console.alibabacloud.com/ap-southeast-1/subscription/coding-plan"),
        "alibaba-coding-plan-cn": KeyPage(plan: "Coding Plan", source: "Model Studio's Coding Plan page", url: "https://bailian.console.aliyun.com/cn-beijing/subscription/coding-plan"),
    ]
}

extension KeyPage {
    fileprivate init(plan: String?, source: String, url: StaticString) {
        self.init(plan: plan, source: source, url: URL(string: "\(url)")!)
    }
}
