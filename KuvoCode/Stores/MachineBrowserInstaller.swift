import AppKit
import CryptoKit
import Foundation
import OpenCodeKit
import Sparkle

/// The browser machines run, as `browser-runtime.json` pins it (`scripts/browser-runtime.py`):
/// Chrome for Testing for each Linux architecture, run headless, and the Enterprise Linux 8
/// packages that hold the libraries and fonts it needs, each with its checksum.
nonisolated struct BrowserRuntime: Decodable, Sendable {
    struct Download: Decodable, Sendable {
        var url: URL
        var sha256: String
        var size: Int
    }

    struct Package: Decodable, Sendable {
        var name: String
        var version: String
        var repo: String
        var path: String
        var sha256: String
        var size: Int
    }

    struct Chromium: Decodable, Sendable {
        var version: String
        var x86_64: Download
        var aarch64: Download
    }

    var chromium: Chromium
    var packages: [String: [Package]]
    /// Names this build on a machine: the Chromium version, and a hash of everything in it, so
    /// newer libraries make a new folder too.
    var id: String

    private enum CodingKeys: String, CodingKey { case chromium, packages }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        chromium = try container.decode(Chromium.self, forKey: .chromium)
        packages = try container.decode([String: [Package]].self, forKey: .packages)
        id = chromium.version
    }

    static let pinned: BrowserRuntime? = {
        guard let url = Bundle.main.url(forResource: "browser-runtime", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              var runtime = try? JSONDecoder().decode(BrowserRuntime.self, from: data) else { return nil }
        runtime.id = runtime.chromium.version + "-" + SHA256.hash(data: data).prefix(4).map { String(format: "%02x", $0) }.joined()
        return runtime
    }()

    /// The architecture's name here, from `uname -m` on the machine.
    static func architecture(_ machine: String) -> String? {
        switch machine {
        case "x86_64", "amd64": "x86_64"
        case "aarch64", "arm64": "aarch64"
        default: nil
        }
    }

    func chromium(for architecture: String) -> Download? {
        switch architecture {
        case "x86_64": chromium.x86_64
        case "aarch64": chromium.aarch64
        default: nil
        }
    }

    /// Where a package downloads from: Rocky Linux's current repositories, then its vault, which
    /// keeps every release's packages once a newer one replaces them.
    static func urls(for package: Package, architecture: String) -> [URL] {
        ["https://dl.rockylinux.org/pub/rocky/8", "https://dl.rockylinux.org/vault/rocky/8.10"].compactMap {
            URL(string: "\($0)/\(package.repo)/\(architecture)/os/\(package.path)")
        }
    }
}

nonisolated enum MachineBrowserError: LocalizedError {
    case notPinned
    case unsupported(String)
    case checksum(String)
    case download(String, Error?)
    case unpack(String)
    case browser(String)

    var errorDescription: String? {
        switch self {
        case .notPinned: "This build of Kuvo Code has no browser for machines."
        case .unsupported(let machine): "The browser runs on Linux machines with x86-64 or ARM64 processors; this one is \(machine)."
        case .checksum(let name): "The download of \(name) didn't match its checksum."
        case .download(let name, let error): "Couldn't download \(name)\(error.map { ": \($0.localizedDescription)" } ?? ".")"
        case .unpack(let output): "Couldn't put the browser together. \(output)"
        case .browser(let message): message
        }
    }
}

/// Puts the browser on a machine, in `~/.kuvo-code/browser`: Chromium and, beside it, every
/// library and font it needs, so nothing has to be installed on the machine itself. It's all
/// downloaded and checked on this Mac, put together here, and sent over SSH, so the machine
/// needs nothing but `sh` and `tar`, as for the engine, and never downloads code itself.
///
/// The helper the engine and the panel talk to, `kuvo-browser.js`, goes to `~/.kuvo-code/bin`.
nonisolated enum MachineBrowserInstaller {
    static var folder: String { "$HOME/\(RemoteEngineInstaller.root)/browser" }
    static var helperPath: String { "$HOME/\(RemoteEngineInstaller.root)/bin/kuvo-browser.js" }

    /// The machine's processor, as the runtime names it.
    static func architecture(on connection: SSHConnection) async throws -> String {
        let machine = try await connection.run("uname -m").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let architecture = BrowserRuntime.architecture(machine) else { throw MachineBrowserError.unsupported(machine) }
        return architecture
    }

    /// Whether the machine has a build to use: this one, or one that stays (`keeps`). This build,
    /// there but not in use (another Mac swapped it out while a browser ran from it), goes back
    /// in use without being sent again.
    static func isInstalled(_ runtime: BrowserRuntime, on connection: SSHConnection) async throws -> Bool {
        let output = try await connection.run("""
            B="\(folder)"
            has() { [ -x "$B/$1/chrome" ] || [ -x "$B/$1/chrome-headless-shell" ]; }
            current=$(readlink "$B/current" 2>/dev/null) && has "$current" && echo "current $current" && echo "by $(cat "$B/$current/kuvo-version" 2>/dev/null)"
            has "\(runtime.id)" && echo "ours"
            true
            """)
        var current: String?
        var madeBy = ""
        var hasOurs = false
        for line in output.split(separator: "\n") {
            let words = line.split(separator: " ", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            switch words.first {
            case "current": current = words.count > 1 ? words[1] : nil
            case "by": madeBy = words.count > 1 ? words[1] : ""
            case "ours": hasOurs = true
            default: break
            }
        }
        if let current, current == runtime.id || keeps(current, madeBy: madeBy, over: runtime) { return true }
        guard hasOurs else { return false }
        try await connection.run("""
            B="\(folder)"
            \(builds)
            ln -sfn "\(runtime.id)" "$B/current"
            \(clearOldBuilds(keeping: runtime.id))
            """)
        return true
    }

    /// Whether a build on a machine stays rather than this one replacing it: one with a newer
    /// Chromium, or the same Chromium put there by a newer Kuvo Code. A Mac with an older version
    /// of the app uses the browser a newer one put there, rather than swapping it back, so two Macs
    /// on different versions don't send theirs in turns. A build from before they said which Kuvo
    /// Code put them there is replaced. Kuvo Code's versions are its builds' (`AppInfo.build`),
    /// ordered as updates are, so a beta's (0.7.0b1) comes before the release (0.7.0).
    static func keeps(_ build: String, madeBy: String, over runtime: BrowserRuntime, version: String = madeBy) -> Bool {
        let theirs = build.split(separator: "-").first.map(String.init) ?? ""
        switch theirs.compare(runtime.chromium.version, options: .numeric) {
        case .orderedDescending: return true
        case .orderedAscending: return false
        case .orderedSame: return !madeBy.isEmpty && SUStandardVersionComparator.default.compareVersion(madeBy, toVersion: version) == .orderedDescending
        }
    }

    /// This copy's version, as builds are marked with it: its build's (0.7.0b1 for a beta), or
    /// for one built in Xcode (whose build is "1") its version's.
    static var madeBy: String { AppInfo.build.contains(".") ? AppInfo.build : AppInfo.version }

    /// Sends a bundle to the machine and makes it the one in use. Older builds go, unless a browser
    /// still runs from one (it moves to the new one when it next starts).
    static func send(_ bundle: URL, _ runtime: BrowserRuntime, to connection: SSHConnection) async throws {
        let version = madeBy.filter { $0.isASCII && ($0.isNumber || $0 == "." || $0 == "b") }
        try await connection.run("""
            set -e
            B="\(folder)"
            mkdir -p "$B"
            \(builds)
            rm -rf "$B/.staging"
            mkdir -p "$B/.staging"
            tar xzf - -C "$B/.staging"
            # Which Kuvo Code put it there, so an older one leaves it in place.
            echo "\(version)" >"$B/.staging/kuvo-version"
            # The same build, already running (another Mac put it there meanwhile), stays as it is.
            if running "\(runtime.id)"; then rm -rf "$B/.staging"; else rm -rf "$B/\(runtime.id)"; mv "$B/.staging" "$B/\(runtime.id)"; fi
            ln -sfn "\(runtime.id)" "$B/current"
            \(clearOldBuilds(keeping: runtime.id))
            """, input: bundle)
    }

    /// Shell for the builds in `$B`: `running <build>` says whether a browser runs from it, by its
    /// real path, which is how the browser starts, and which differs from `$B`'s where a folder on
    /// the way is a link (a home moved to another disk, say).
    private static let builds = """
        R=$(cd "$B" && pwd -P)
        running() { grep -qsF -e "$B/$1/" -e "$R/$1/" /proc/[0-9]*/cmdline 2>/dev/null; }
        """

    /// Shell that removes the builds in `$B` other than `id`, unless a browser still runs from one.
    private static func clearOldBuilds(keeping id: String) -> String {
        """
        for old in "$B"/*; do
          name=$(basename "$old")
          # Not `current` (a link to the new build), nor the new build, nor website data.
          [ -L "$old" ] || [ ! -d "$old" ] && continue
          [ "$name" = "\(id)" ] || [ "$name" = profile ] && continue
          [ -e "$old/chrome" ] || [ -e "$old/chrome-headless-shell" ] || continue
          running "$name" && continue
          rm -rf "$old"
        done
        """
    }

    // MARK: The bundle

    /// The browser for `architecture`, put together as a `.tar.gz` to unpack on a machine: from this
    /// Mac's cache when it's there and intact, else downloaded and checked first. `progress` gets
    /// the fraction downloaded.
    static func bundle(for architecture: String, runtime: BrowserRuntime, cache: URL, progress: @escaping @Sendable (Double) -> Void) async throws -> URL {
        let fm = FileManager.default
        clearLeftovers(in: cache)
        let file = cache.appending(path: "\(runtime.id)-\(architecture).tar.gz")
        let checksum = cache.appending(path: "\(runtime.id)-\(architecture).sha256")
        if fm.fileExists(atPath: file.path), let expected = try? String(contentsOf: checksum, encoding: .utf8),
           (try? sha256(of: file)) == expected.trimmingCharacters(in: .whitespacesAndNewlines) {
            return file
        }
        guard let chromium = runtime.chromium(for: architecture), let packages = runtime.packages[architecture] else {
            throw MachineBrowserError.unsupported(architecture)
        }
        try fm.createDirectory(at: cache, withIntermediateDirectories: true)
        // Named for this app's process, so a later one tells a folder left by one that quit.
        let staging = cache.appending(path: ".staging-\(getpid())-\(UUID().uuidString)")
        building.insert(staging.lastPathComponent)
        defer {
            try? fm.removeItem(at: staging)
            building.remove(staging.lastPathComponent)
        }
        let root = staging.appending(path: "root")
        let bundle = staging.appending(path: "bundle")
        for folder in [root, bundle.appending(path: "lib"), bundle.appending(path: "fonts"), bundle.appending(path: "licenses")] {
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        }

        // Downloads, by size, for the progress.
        let total = Double(chromium.size + packages.reduce(0) { $0 + $1.size })
        let done = Counter()
        let report: @Sendable (String, Int) -> Void = { name, bytes in progress(min(1, Double(done.set(name, bytes)) / total)) }

        // Chromium: its folder's files at the top of the bundle.
        let zip = try await download("Chromium", from: [chromium.url], sha256: chromium.sha256, into: staging, report: report)
        try await run("/usr/bin/unzip", ["-q", zip.path, "-d", staging.appending(path: "chromium").path])
        try? fm.removeItem(at: zip)
        guard let unpacked = try fm.contentsOfDirectory(at: staging.appending(path: "chromium"), includingPropertiesForKeys: nil).first(where: { $0.lastPathComponent.hasPrefix("chrome-") }) else {
            throw MachineBrowserError.unpack("The Chromium download has no browser in it.")
        }
        for item in try fm.contentsOfDirectory(at: unpacked, includingPropertiesForKeys: nil) {
            try fm.moveItem(at: item, to: bundle.appending(path: item.lastPathComponent))
        }

        // The packages, a few at a time, unpacked into one tree.
        try await withThrowingTaskGroup(of: URL.self) { group in
            var queue = packages[...]
            func next() {
                guard let package = queue.popFirst() else { return }
                group.addTask {
                    try await download(package.name, from: BrowserRuntime.urls(for: package, architecture: architecture), sha256: package.sha256, into: staging, report: report)
                }
            }
            for _ in 0..<6 { next() }
            while let rpm = try await group.next() {
                try await run("/usr/bin/tar", ["-xf", rpm.path, "-C", root.path])
                try? fm.removeItem(at: rpm)
                next()
            }
        }

        // Their libraries in `lib` (with the links between their names), their fonts in `fonts`.
        let libraries = root.appending(path: "usr/lib64")
        for name in (try? fm.contentsOfDirectory(atPath: libraries.path)) ?? [] where name.contains(".so") {
            try fm.moveItem(at: libraries.appending(path: name), to: bundle.appending(path: "lib/\(name)"))
        }
        let fonts = (fm.enumerator(at: root.appending(path: "usr/share/fonts"), includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? [])
            .filter { ["ttf", "otf", "ttc"].contains($0.pathExtension.lowercased()) }
        for font in fonts {
            try? fm.moveItem(at: font, to: bundle.appending(path: "fonts/\(font.lastPathComponent)"))
        }
        for name in (try? fm.contentsOfDirectory(atPath: root.appending(path: "usr/share/licenses").path)) ?? [] {
            try? fm.moveItem(at: root.appending(path: "usr/share/licenses/\(name)"), to: bundle.appending(path: "licenses/\(name)"))
        }
        try Data((runtime.chromium.version + "\n").utf8).write(to: bundle.appending(path: "chromium-version"))

        let packed = staging.appending(path: "bundle.tar.gz")
        try await run("/usr/bin/tar", ["--no-xattrs", "--no-mac-metadata", "-czf", packed.path, "-C", bundle.path, "."], environment: ["COPYFILE_DISABLE": "1"])
        try? fm.removeItem(at: file)
        try fm.moveItem(at: packed, to: file)
        try Data(try sha256(of: file).utf8).write(to: checksum)
        // Older builds aren't needed again.
        for entry in (try? fm.contentsOfDirectory(atPath: cache.path)) ?? [] where !entry.hasPrefix(runtime.id) && !entry.hasPrefix(".staging") {
            try? fm.removeItem(at: cache.appending(path: entry))
        }
        progress(1)
        return file
    }

    /// The staging folders of bundles this app is putting together now (two machines' can be at once).
    private static let building = Names()

    /// Removes the staging folders of bundles that were being put together when the app quit:
    /// those of an app no longer running, and this one's that no build here uses now.
    private static func clearLeftovers(in cache: URL) {
        let me = getpid()
        for entry in (try? FileManager.default.contentsOfDirectory(atPath: cache.path)) ?? [] where entry.hasPrefix(".staging") {
            // `.staging-<process>-<UUID>`; one named before they said whose it was is left over.
            let parts = entry.split(separator: "-")
            if parts.count > 2, let pid = pid_t(parts[1]) {
                let inUse = pid == me ? building.contains(entry) : kill(pid, 0) == 0 || errno == EPERM
                if inUse { continue }
            }
            try? FileManager.default.removeItem(at: cache.appending(path: entry))
        }
    }

    /// Downloads a file, from the first address that has it, and checks it against its checksum.
    private static func download(_ name: String, from urls: [URL], sha256 expected: String, into folder: URL, report: @escaping @Sendable (String, Int) -> Void) async throws -> URL {
        var lastError: Error?
        for url in urls {
            do {
                let (temporary, response) = try await URLSession.shared.download(from: url, delegate: DownloadProgress { report(name, $0) })
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    try? FileManager.default.removeItem(at: temporary)
                    continue
                }
                guard try sha256(of: temporary) == expected else {
                    try? FileManager.default.removeItem(at: temporary)
                    throw MachineBrowserError.checksum(name)
                }
                let file = folder.appending(path: url.lastPathComponent)
                try? FileManager.default.removeItem(at: file)
                try FileManager.default.moveItem(at: temporary, to: file)
                report(name, Int((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0))
                return file
            } catch let error as MachineBrowserError {
                throw error
            } catch {
                lastError = error
            }
        }
        throw MachineBrowserError.download(name, lastError)
    }

    static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        return try handle.digest(SHA256.self).map { String(format: "%02x", $0) }.joined()
    }

    /// This Mac's unzip or tar, unpacking or packing the browser's downloads. Each takes seconds:
    /// one still going after ten minutes is stuck, and stopped.
    private static func run(_ tool: String, _ arguments: [String], environment: [String: String] = [:]) async throws {
        let result = try await ChildProcess.run(tool, arguments, environment: ProcessInfo.processInfo.environment.merging(environment) { $1 },
                                                output: .discard, limit: .seconds(600))
        guard result.succeeded else {
            throw MachineBrowserError.unpack(result.timedOut ? "\((tool as NSString).lastPathComponent) didn’t finish in ten minutes." : result.errorText)
        }
    }

    /// Bytes downloaded so far, from downloads running at once.
    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var bytes: [String: Int] = [:]
        func set(_ name: String, _ count: Int) -> Int {
            lock.withLock {
                bytes[name] = count
                return bytes.values.reduce(0, +)
            }
        }
    }

    /// Names, from tasks running at once.
    private final class Names: @unchecked Sendable {
        private let lock = NSLock()
        private var names: Set<String> = []
        func insert(_ name: String) { lock.withLock { _ = names.insert(name) } }
        func remove(_ name: String) { lock.withLock { _ = names.remove(name) } }
        func contains(_ name: String) -> Bool { lock.withLock { names.contains(name) } }
    }

    /// Reports a download's bytes as they arrive.
    private final class DownloadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        let report: @Sendable (Int) -> Void
        private var observation: NSKeyValueObservation?

        init(report: @escaping @Sendable (Int) -> Void) {
            self.report = report
        }

        func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
            observation = task.progress.observe(\.completedUnitCount) { [report] progress, _ in
                report(Int(progress.completedUnitCount))
            }
        }
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
