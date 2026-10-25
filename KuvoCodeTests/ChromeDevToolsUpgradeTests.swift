import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Chrome DevTools as an older version of Kuvo Code added it moves to how it's offered now
/// (pinned, run through kuvo-npx, its own profile, no usage statistics), while what you chose
/// stays: a newer version, your options, your environment.
@MainActor
@Suite struct ChromeDevToolsUpgradeTests {
    let config: EngineConfig
    let path = MCPSettings.path + ["chrome-devtools"]

    init() throws {
        TestEnvironment.prepare()
        config = EngineConfig.inMemory()
    }

    private func added(_ command: [String], environment: [String: String]? = nil) {
        var server: [String: JSONValue] = ["type": .string("local"), "command": .array(command.map(JSONValue.string))]
        if let environment { server["environment"] = .object(environment.mapValues(JSONValue.string)) }
        config.set(.object(server), at: path)
    }

    /// The version Kuvo Code pins now (whatever it is): a version, not "latest" or none.
    private func isPinned(_ package: String?) -> Bool {
        package?.range(of: #"^chrome-devtools-mcp@\d+\.\d+\.\d+$"#, options: .regularExpression) != nil
    }

    private var command: [String] { config.value(at: path + ["command"])?.array?.compactMap(\.string) ?? [] }
    private var environment: [String: String] { (config.value(at: path + ["environment"])?.object ?? [:]).compactMapValues(\.string) }

    @Test func anOldUnpinnedOneIsPinnedAndRunApart() {
        added(["npx", "-y", "chrome-devtools-mcp@latest"])
        MCPCatalog.upgrade(config)
        #expect(command.first == Launcher.name)
        #expect(isPinned(command.dropFirst().first))
        #expect(Array(command.dropFirst(2)) == ["--isolated", "--no-usage-statistics"])
        #expect(environment["CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS"] == "1")
        #expect(environment[Integrations.apart] != nil)
    }

    /// 1.9 is older than 1.11 (by number, not as text).
    @Test func anOlderVersionMovesUp() {
        added(["npx", "-y", "chrome-devtools-mcp@1.9.9"])
        MCPCatalog.upgrade(config)
        #expect(isPinned(command.dropFirst().first))
        #expect(command.dropFirst().first != "chrome-devtools-mcp@1.9.9")
    }

    @Test func aNewerVersionYouChoseStays() {
        added(["npx", "-y", "chrome-devtools-mcp@1.12.3"])
        MCPCatalog.upgrade(config)
        #expect(command.dropFirst().first == "chrome-devtools-mcp@1.12.3")
    }

    @Test func yourOptionsAndEnvironmentStay() {
        added(["npx", "chrome-devtools-mcp", "--no-isolated", "--headless", "--usage-statistics=true"], environment: ["MY_VAR": "x"])
        MCPCatalog.upgrade(config)
        #expect(command.contains("--no-isolated") && !command.contains("--isolated"))
        #expect(command.contains("--headless"))
        #expect(command.contains("--usage-statistics=true") && !command.contains("--no-usage-statistics"))
        #expect(environment["MY_VAR"] == "x")
    }

    @Test func upgradingAgainChangesNothing() throws {
        added(["npx", "-y", "chrome-devtools-mcp@latest", "--headless"])
        MCPCatalog.upgrade(config)
        let once = config.settings
        MCPCatalog.upgrade(config)
        #expect(config.settings == once)
    }

    /// One you set up some other way is left alone.
    @Test func anotherServerByThatNameIsLeftAlone() {
        added(["node", "my-chrome-server.js"])
        MCPCatalog.upgrade(config)
        #expect(command == ["node", "my-chrome-server.js"])
    }
}
