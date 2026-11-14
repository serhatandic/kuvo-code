import XCTest
@testable import UsageKit

/// Covers the `~/.openusage/config.json` proxy contract (ported from the original's docs/proxy.md):
/// enabled + valid URL parses; everything else silently disables.
final class ProxyConfigTests: XCTestCase {
    func testParsesEnabledSocks5Proxy() {
        let config = ProxyConfig.load(text: #"{"proxy":{"enabled":true,"url":"socks5://127.0.0.1:10808"}}"#)

        XCTAssertEqual(config?.scheme, .socks5)
        XCTAssertEqual(config?.host, "127.0.0.1")
        XCTAssertEqual(config?.port, 10808)
        XCTAssertNil(config?.username)
    }

    func testParsesAuthenticatedHTTPProxy() {
        let config = ProxyConfig.load(text: #"{"proxy":{"enabled":true,"url":"http://user:pass@proxy.example.com:8080"}}"#)

        XCTAssertEqual(config?.scheme, .http)
        XCTAssertEqual(config?.host, "proxy.example.com")
        XCTAssertEqual(config?.port, 8080)
        XCTAssertEqual(config?.username, "user")
        XCTAssertEqual(config?.password, "pass")
    }

    func testMissingPortFallsBackToSchemeDefault() {
        XCTAssertEqual(ProxyConfig.load(text: #"{"proxy":{"enabled":true,"url":"socks5://host"}}"#)?.port, 1080)
        XCTAssertEqual(ProxyConfig.load(text: #"{"proxy":{"enabled":true,"url":"https://host"}}"#)?.port, 443)
    }

    func testDisabledMissingOrInvalidConfigTurnsProxyOff() {
        XCTAssertNil(ProxyConfig.load(text: #"{"proxy":{"enabled":false,"url":"socks5://127.0.0.1:1080"}}"#))
        XCTAssertNil(ProxyConfig.load(text: #"{"proxy":{"enabled":true,"url":"ftp://127.0.0.1:21"}}"#)) // unsupported scheme
        XCTAssertNil(ProxyConfig.load(text: #"{"proxy":{"enabled":true}}"#))                            // no url
        XCTAssertNil(ProxyConfig.load(text: "not json"))
        XCTAssertNil(ProxyConfig.load(text: nil))                                                       // no config file
        XCTAssertNil(ProxyConfig.load(text: "{}"))
    }
}
