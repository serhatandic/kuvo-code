import CryptoKit
import Foundation
import KuvoLink
import OpenCodeKit

/// What a machine runs, as a release for boxes to update themselves with (PROTOCOL.md, "Updates"):
/// every file this version puts in a machine's `~/.kuvo-code` that's the same on every machine,
/// and `box.json`, saying what's there and which engine goes with it. The release workflow writes
/// it (`--write-box-files <folder>`), packs it, and signs a manifest naming the pack.
enum BoxRelease {
    struct Manifest: Encodable {
        struct Engine: Encodable { var url: String; var integrity: String }
        var version: String
        /// The engine's version, and its Linux builds by `uname -m`'s kinds.
        var engine: String
        var linux: [String: Engine]
        /// Each file, by its path in `~/.kuvo-code`, with its SHA-256.
        var files: [String: String]
    }

    @MainActor static func write(to folder: URL) throws {
        let fm = FileManager.default
        try BoxFiles.write(into: folder)
        let bin = folder.appending(path: "bin")
        let link = bin.appending(path: Bridge.fileName)
        try Bridge.script.write(to: link)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: link.path)
        try MachineBox.catalogJSON().write(to: bin.appending(path: "mcp-catalog.json"))
        try MachineBox.integrationsJSON().write(to: bin.appending(path: "integrations.json"))
        // What a box makes bots with, when it's newer than what a Mac gave it.
        try JSONEncoder().encode(Bots.releaseKit()).write(to: bin.appending(path: "bot-kit.json"))
        try Data(MachineBrowserInstaller.helper.text.utf8).write(to: bin.appending(path: "kuvo-browser.js"))
        // Never a release without it: a box would keep its old one beside a new engine.
        guard let agents = MachineEngine.agentsBridge else { throw CocoaError(.fileNoSuchFile) }
        try Data(agents.text.utf8).write(to: bin.appending(path: "kuvo-agents.js"))
        try Data(AppInfo.version.utf8).write(to: bin.appending(path: "box-version"))
        var files: [String: String] = [:]
        let base = folder.standardizedFileURL.path + "/"
        for case let file as URL in fm.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey]) ?? FileManager.DirectoryEnumerator() {
            guard (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            let data = try Data(contentsOf: file)
            files[String(file.standardizedFileURL.path.dropFirst(base.count))] = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        }
        var linux: [String: Manifest.Engine] = [:]
        for kind in ["x86_64", "aarch64"] {
            if let release = EngineRelease.linux(machine: kind) { linux[kind] = .init(url: release.tarball.absoluteString, integrity: release.integrity) }
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        try encoder.encode(Manifest(version: AppInfo.version, engine: OpenCodeEngine.version, linux: linux, files: files)).write(to: folder.appending(path: "box.json"))
    }
}
