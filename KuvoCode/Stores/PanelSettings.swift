import Foundation
import OpenCodeKit

/// The side panel's settings, kept in UserDefaults under these keys (Settings › Panel).
nonisolated enum PanelSettings {
    /// The new tab page lists the tools (Changes, Terminal, Files).
    static let showsTools = "panel.newTab.showsTools"
    /// The new tab page suggests sites the browser visits often.
    static let showsSuggestions = "panel.newTab.showsSuggestions"
    /// How many sites it suggests.
    static let suggestionCount = "panel.newTab.suggestionCount"
    /// The tab a project's panel starts with: Changes, or a new tab.
    static let startsWith = "panel.startsWith"
    /// The panel comes forward when the agent starts browsing.
    static let revealsForAgent = "panel.revealsForAgent"
    /// A tab an agent opened that you never looked at closes itself a while after its last use
    /// (`Utilities.tidyAgentTabs`), here and in your machines' browsers.
    static let tidiesAgentTabs = "panel.tidiesAgentTabs"

    enum Start: String, CaseIterable {
        case changes, newTab
        var title: String { self == .changes ? "Changes" : "New Tab" }
    }

    /// A Bool setting that's on unless it was turned off.
    static func isOn(_ key: String) -> Bool {
        UserDefaults.standard.object(forKey: key) as? Bool ?? true
    }
}

/// Where the address field sends anything that isn't an address.
nonisolated enum SearchEngine: String, CaseIterable {
    case google, duckDuckGo, bing, brave, kagi, ecosia

    static let key = "browser.searchEngine"

    static var current: SearchEngine {
        UserDefaults.standard.string(forKey: key).flatMap(SearchEngine.init) ?? .google
    }

    var title: String {
        switch self {
        case .google: "Google"
        case .duckDuckGo: "DuckDuckGo"
        case .bing: "Bing"
        case .brave: "Brave Search"
        case .kagi: "Kagi"
        case .ecosia: "Ecosia"
        }
    }

    func url(for query: String) -> URL? {
        let base = switch self {
        case .google: "https://www.google.com/search"
        case .duckDuckGo: "https://duckduckgo.com/"
        case .bing: "https://www.bing.com/search"
        case .brave: "https://search.brave.com/search"
        case .kagi: "https://kagi.com/search"
        case .ecosia: "https://www.ecosia.org/search"
        }
        var components = URLComponents(string: base)
        components?.percentEncodedQueryItems = [URLQueryItem(name: "q", value: query).formEscaped]
        return components?.url
    }
}
