import Foundation
import Testing
@testable import KuvoCode

/// An agent on this Mac and one on a machine get the same browser tools, told the same, and read
/// pages the same way. The machines' come from the box's sources (`box/src/browser`, built
/// into `kuvo-browser.js` by `scripts/build-browser.sh`); this Mac's panel still has copies of its
/// own (`BrowserTools`, `BrowserAgent`) until its agents browse in its box's browser (#693), so a
/// change to one that isn't made to the other fails here.
@MainActor
struct BrowserToolsOnBoxTests {
    /// What the app's `kuvo-browser.js` gives agents: its tools, instructions and page scripts.
    private func built() throws -> [String: Any] {
        let text = MachineBrowserInstaller.helper.text
        let prefix = "const CONFIG = "
        let line = try #require(text.split(separator: "\n").first { $0.hasPrefix(prefix) })
        let json = try #require(line.dropFirst(prefix.count).dropLast().data(using: .utf8))
        return try #require(try JSONSerialization.jsonObject(with: json) as? [String: Any])
    }

    /// `value` as JSON, its keys in order, to compare as models are given it.
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
    }

    @Test func aMachinesAgentGetsThePanelsToolsAndWords() throws {
        let config = try built()
        #expect(!MachineBrowserInstaller.helper.hash.isEmpty)
        #expect(try json(config["tools"] as Any) == json(BrowserTools.definitions))
        #expect(config["instructions"] as? String == BrowserTools.instructions(machine: true, vault: false))
        #expect(config["vaultInstructions"] as? String == BrowserTools.vaultInstructions)
    }

    @Test func aMachinesAgentReadsAndActsOnPagesAsThePanelsDoes() throws {
        let scripts = try #require(try built()["scripts"] as? [String: String])
        let panel: [String: String] = [
            "snapshot": BrowserAgent.snapshotScript,
            "handlers": BrowserAgent.handlersScript,
            "find": BrowserAgent.findElement,
            "click": BrowserAgent.clickScript,
            "type": BrowserAgent.typeScript,
            "select": BrowserAgent.selectScript,
            "press": BrowserAgent.pressScript,
            "fieldKind": BrowserAgent.fieldKindScript,
            "fileInput": BrowserAgent.fileInputScript,
            "rect": BrowserAgent.rectScript,
            "fill": BrowserAgent.fillScript,
            "mask": BrowserAgent.maskScript,
            "printMask": BrowserAgent.printMaskScript,
            "unmask": BrowserAgent.unmaskScript,
            "printUnmask": BrowserAgent.printUnmaskScript,
        ]
        #expect(Set(scripts.keys) == Set(panel.keys))
        for (name, script) in panel {
            #expect(scripts[name] == script, "\(name) differs from BrowserAgent's")
        }
    }
}
