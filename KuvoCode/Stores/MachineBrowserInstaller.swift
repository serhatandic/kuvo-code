import AppKit
import CryptoKit
import Foundation
import OpenCodeKit

/// What went wrong talking to a machine's browser.
nonisolated enum MachineBrowserError: LocalizedError {
    case browser(String)

    var errorDescription: String? {
        switch self {
        case .browser(let message): message
        }
    }
}

/// The browser on a machine: its box sets it up itself, from Google's Chrome for Testing, and keeps
/// it up to date with its own updates (KuvoLink's PROTOCOL.md, "The browser on a machine"). This Mac
/// only asks how it stands (`kuvo/browser`), and puts the helper the engine and the panel talk to,
/// `kuvo-browser.js`, in `~/.kuvo-code/bin`.
nonisolated enum MachineBrowserInstaller {
    static var helperPath: String { "$HOME/\(RemoteEngineInstaller.root)/bin/kuvo-browser.js" }
    /// How the browser stands on a machine, as its box says (`kuvo/browser`).
    struct Status: Decodable, Equatable {
        /// `missing`, `checking`, `downloading`, `installing`, `ready` or `failed`.
        var state: String
        /// The version in use, if any: an older one works while a newer one is set up.
        var installed: String?
        /// While downloading, from 0 to 1.
        var progress: Double?
        var message: String?

        var isUnderWay: Bool { ["checking", "downloading", "installing"].contains(state) }
    }

    /// Asks the machine's box how its browser stands, after having it set the browser up (`start`)
    /// when it isn't ready: after a failure, it waits as long as the box says, unless asked `now`
    /// (you asked to try again). Nil when the box doesn't know `kuvo/browser` (an older one, which
    /// the browser's own helper sets it up for when it's first used).
    static func status(start: Bool, now: Bool = false, on connection: SSHConnection) async throws -> Status? {
        let (code, data) = try await MachineBox.route(start ? "POST" : "GET", "kuvo/browser", body: start ? ["now": now] : nil, on: connection)
        guard (200..<300).contains(code) else { return nil }
        return try? JSONDecoder().decode(Status.self, from: data)
    }
}

// MARK: - The helper

extension MachineBrowserInstaller {
    /// `kuvo-browser.js` as it goes to a machine: the browsing scripts and tools the panel's
    /// browser uses, filled in. Its first line names its contents, to tell whether a machine has it.
    @MainActor static let helper: (text: String, hash: String) = {
        guard let url = Bundle.main.url(forResource: "kuvo-browser", withExtension: "js"),
              let template = try? String(contentsOf: url, encoding: .utf8) else { return ("", "") }
        let config: [String: Any] = [
            "scripts": [
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
            ],
            "tools": BrowserTools.definitions,
            "instructions": BrowserTools.instructions(machine: true, vault: false),
            "vaultInstructions": BrowserTools.vaultInstructions,
            "version": AppInfo.version,
        ]
        let json = (try? JSONSerialization.data(withJSONObject: config, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        let marker = #"/*KUVO_CONFIG*/ { scripts: {}, tools: [], instructions: "", version: "dev" }"#
        let body = template.replacingOccurrences(of: marker, with: json)
        let hash = SHA256.hash(data: Data(body.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        return ("// kuvo-browser \(hash)\n" + body, hash)
    }()

    /// Puts the helper on the machine, unless it has this one already.
    static func installHelper(_ helper: (text: String, hash: String), on connection: SSHConnection) async throws {
        let first = try await connection.run("head -n 1 \"\(helperPath)\" 2>/dev/null || true")
        guard first.trimmingCharacters(in: .whitespacesAndNewlines) != "// kuvo-browser \(helper.hash)" else { return }
        let file = FileManager.default.temporaryDirectory.appending(path: "kuvo-browser-\(UUID().uuidString).js")
        try Data(helper.text.utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        try await connection.run(BoxVersion.guardScript + "\n" + """
            set -e
            mkdir -p "$HOME/\(RemoteEngineInstaller.root)/bin"
            cat >"\(helperPath).new"
            mv -f "\(helperPath).new" "\(helperPath)"
            """, input: file)
    }

    /// The command that runs the helper on a machine, with the engine's own runtime: this
    /// version's, or the one there (a newer one another Mac put there). It gets the engine's
    /// folders in `~/.kuvo-code`, so the runtime's cache lands there, not in the user's home.
    static func command(_ mode: String) -> String {
        """
        K="$HOME/\(RemoteEngineInstaller.root)"; E="$K/engine/\(OpenCodeEngine.version)/opencode"; \
        [ -x "$E" ] || E="\(RemoteEngineInstaller.newestEngine)"; \
        XDG_DATA_HOME="$K/data" XDG_CONFIG_HOME="$K/config" XDG_STATE_HOME="$K/state" XDG_CACHE_HOME="$K/cache" \
        BUN_INSTALL="$K/cache/bun" KUVO_HOME="$K" KUVO_LANG="\(languages)" BUN_BE_BUN=1 exec "$E" --config=/dev/null --no-env-file "\(helperPath)" \(mode)
        """
    }

    /// This Mac's preferred languages, for the browser there to ask sites for, as yours does:
    /// "en-GB,en,tr-TR,tr".
    static var languages: String {
        var tags: [String] = []
        for language in Locale.preferredLanguages {
            let tag = language.replacingOccurrences(of: "_", with: "-")
            guard tag.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { continue }
            for candidate in [tag, String(tag.prefix { $0 != "-" })] where !tags.contains(candidate) { tags.append(candidate) }
        }
        return tags.prefix(6).joined(separator: ",")
    }

    /// The machine's engine's config entry for the browser tools: the helper, as a local MCP
    /// server, under the same name as the panel's browser tools on this Mac; with the sites of
    /// the integrations added there, which it sends the agent away from, to their tools.
    @MainActor static func engineConfig(sites: [Integrations.Site]) -> [String: Any] {
        // Sorted: JSONEncoder writes a struct's keys in another order almost every time, and the
        // engine is started over whenever what it started with reads differently.
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let encoded = (try? encoder.encode(sites)).map { String(decoding: $0, as: UTF8.self) } ?? "[]"
        return ["mcp": ["servers": ["kuvo-browser": [
            "type": "local",
            "command": ["sh", "-c", command("mcp")],
            "environment": ["KUVO_SEARCH": searchTemplate, "KUVO_INTEGRATION_SITES": encoded, "KUVO_PAPER": paper],
            // Plain tools, so every model calls them directly.
            "codemode": false,
            // A tool that asks you (to sign in, for a code) waits for you.
            "timeout": ["execution": BrowserTools.executionTimeout],
        ] as [String: Any]]]]
    }

    /// The paper this Mac prints on, for PDFs a machine's browser saves: US Letter or A4.
    static var paper: String {
        NSPrintInfo.shared.paperSize.width < 600 ? "a4" : "letter"
    }

    /// The search engine chosen in Settings, with `%s` for the words.
    static var searchTemplate: String {
        SearchEngine.current.url(for: "KUVOQUERY")?.absoluteString.replacingOccurrences(of: "KUVOQUERY", with: "%s") ?? "https://www.google.com/search?q=%s"
    }
}
