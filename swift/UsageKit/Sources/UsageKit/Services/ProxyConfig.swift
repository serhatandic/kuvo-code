import Foundation
import Network

/// Optional proxy routing for provider HTTP requests — the same contract as the original app
/// (docs/proxy.md): `~/.openusage/config.json` containing
/// `{"proxy": {"enabled": true, "url": "socks5://127.0.0.1:10808"}}`.
///
/// Loaded once at startup; restart the app after editing the file. Missing, disabled, invalid, or
/// unreadable config leaves proxying off. Credentials may be embedded in the URL
/// (`http://user:pass@host:port`). Loopback hosts always bypass the proxy.
struct ProxyConfig: Equatable, Sendable {
    enum Scheme: String, Equatable, Sendable {
        case socks5
        case http
        case https

        var defaultPort: UInt16 {
            switch self {
            case .socks5: return 1080
            case .http: return 80
            case .https: return 443
            }
        }
    }

    var scheme: Scheme
    var host: String
    var port: UInt16
    var username: String?
    var password: String?

    static var configPath: String { HostApp.supportDirectory.appendingPathComponent("proxy.json").path }

    /// The app-wide proxy, read from disk exactly once (first use).
    static let current: ProxyConfig? = load(
        text: try? String(
            contentsOfFile: NSString(string: configPath).expandingTildeInPath,
            encoding: .utf8
        )
    )

    /// Parses config-file text. `nil` unless `proxy.enabled == true` with a valid socks5/http/https
    /// URL — the silent-disable behavior the original documents.
    static func load(text: String?) -> ProxyConfig? {
        guard let text,
              let data = text.data(using: .utf8),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let proxy = root["proxy"] as? [String: Any],
              proxy["enabled"] as? Bool == true,
              let urlString = proxy["url"] as? String,
              let url = URL(string: urlString),
              let schemeRaw = url.scheme?.lowercased(),
              let scheme = Scheme(rawValue: schemeRaw),
              let host = url.host(), !host.isEmpty
        else { return nil }

        return ProxyConfig(
            scheme: scheme,
            host: host,
            port: url.port.flatMap { UInt16(exactly: $0) } ?? scheme.defaultPort,
            username: url.user(percentEncoded: false),
            password: url.password(percentEncoded: false)
        )
    }

    /// The Network-framework proxy this config describes, with loopback always excluded.
    func proxyConfiguration() -> ProxyConfiguration {
        let endpoint = NWEndpoint.hostPort(host: .init(host), port: .init(rawValue: port)!)
        var configuration: ProxyConfiguration
        switch scheme {
        case .socks5:
            configuration = ProxyConfiguration(socksv5Proxy: endpoint)
        case .http:
            configuration = ProxyConfiguration(httpCONNECTProxy: endpoint, tlsOptions: nil)
        case .https:
            configuration = ProxyConfiguration(httpCONNECTProxy: endpoint, tlsOptions: NWProtocolTLS.Options())
        }
        if let username, let password {
            configuration.applyCredential(username: username, password: password)
        }
        configuration.excludedDomains = ["localhost", "127.0.0.1", "::1"]
        return configuration
    }
}
