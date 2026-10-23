import AppKit
import Foundation
import OpenCodeKit

/// Where a computer keeps the skills you add and write, each its own: this Mac's skills folder,
/// or a machine's, in its engine's config folder there (`~/.kuvo-code/config/opencode/skills`),
/// reached over SSH. Its engine finds a skill there within a moment.
enum SkillsPlace {
    case mac(URL)
    case machine(SSHConnection)

    /// The folder, as its engine names the skills in it: a machine's as it says, once asked.
    func path() async -> String? {
        switch self {
        case .mac(let folder): return folder.path
        case .machine(let connection):
            let output = try? await connection.run(RemoteEngineInstaller.script("printf '%s' \"$K/config/opencode/skills\""))
            return output?.split(separator: "\n").last.map(String.init)
        }
    }

    /// Skills installed from GitHub, by their folder's name, with where they came from.
    func installed() async -> [String: SkillLibrary.Source] {
        switch self {
        case .mac(let folder): return SkillLibrary.installed(in: folder)
        case .machine(let connection):
            let script = RemoteEngineInstaller.script("""
                for f in "$K"/config/opencode/skills/*/\(SkillLibrary.sourceFile); do
                  [ -f "$f" ] && printf '%s\\t%s\\n' "$(basename "$(dirname "$f")")" "$(tr -d '\\n' <"$f")"
                done
                true
                """)
            guard let output = try? await connection.run(script) else { return [:] }
            var installed: [String: SkillLibrary.Source] = [:]
            for line in output.split(separator: "\n") {
                let parts = line.split(separator: "\t", maxSplits: 1).map(String.init)
                guard parts.count == 2, let source = try? JSONSerialization.jsonObject(with: Data(parts[1].utf8)) as? [String: String],
                      let repository = source["repository"] else { continue }
                installed[parts[0]] = SkillLibrary.Source(repository: repository, path: source["path"] ?? "")
            }
            return installed
        }
    }

    /// Whether a skill has a folder here already.
    func exists(_ name: String) async -> Bool {
        switch self {
        case .mac(let folder): return FileManager.default.fileExists(atPath: folder.appending(path: name).path)
        case .machine(let connection):
            let output = try? await connection.run(RemoteEngineInstaller.script("[ -e \"$K/config/opencode/skills/\"\(SSHConnection.quoted(name)) ] && echo yes || echo no"))
            return output?.contains("yes") == true
        }
    }

    /// A skill's SKILL.md, as it's written.
    func read(_ name: String) async -> String? {
        switch self {
        case .mac(let folder): return try? String(contentsOf: Self.file(name, in: folder), encoding: .utf8)
        case .machine(let connection):
            let file = FileManager.default.temporaryDirectory.appending(path: "kuvo-skill-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: file) }
            guard (try? await connection.run(RemoteEngineInstaller.script("cat \"$K/config/opencode/skills/\"\(SSHConnection.quoted(name))/SKILL.md"), output: file)) != nil else { return nil }
            return try? String(contentsOf: file, encoding: .utf8)
        }
    }

    /// Writes a skill's SKILL.md, making its folder.
    func write(_ name: String, _ text: String) async throws {
        switch self {
        case .mac(let folder):
            let file = Self.file(name, in: folder)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: file, options: .atomic)
        case .machine(let connection):
            let file = FileManager.default.temporaryDirectory.appending(path: "kuvo-skill-\(UUID().uuidString)")
            try Data(text.utf8).write(to: file)
            defer { try? FileManager.default.removeItem(at: file) }
            try await connection.run(RemoteEngineInstaller.script("""
                d="$K/config/opencode/skills/"\(SSHConnection.quoted(name))
                mkdir -p "$d" && cat >"$d/SKILL.md.new" && mv -f "$d/SKILL.md.new" "$d/SKILL.md"
                """), input: file)
        }
    }

    /// Puts a skill's folder away: in the Trash on this Mac, in Kuvo Code's own trash on a
    /// machine, kept there 30 days.
    func remove(_ name: String) async throws {
        switch self {
        case .mac(let folder): try FileManager.default.moveToTrash(folder.appending(path: name))
        case .machine(let connection):
            try await connection.run(RemoteEngineInstaller.script("""
                d="$K/config/opencode/skills/"\(SSHConnection.quoted(name))
                [ -e "$d" ] || exit 0
                t="$K/trash/skills/"\(SSHConnection.quoted(name))"-$(date +%s)"
                # Dated now: moving it kept its own date, and an old one would go at once.
                mkdir -p "$K/trash/skills" && mv "$d" "$t" && touch "$t"
                find "$K/trash/skills" -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf {} + 2>/dev/null
                true
                """))
        }
    }

    /// Installs a skill from GitHub, fetched here and put in place there.
    func install(_ skill: SkillLibrary.RemoteSkill) async throws {
        switch self {
        case .mac(let folder): try await SkillLibrary.install(skill, into: folder)
        case .machine(let connection):
            if await exists(skill.name) { throw SkillLibrary.Failure.taken(skill.name) }
            let staging = try await SkillLibrary.stage(skill)
            let archive = FileManager.default.temporaryDirectory.appending(path: "kuvo-skill-\(UUID().uuidString).tar")
            defer {
                try? FileManager.default.removeItem(at: staging)
                try? FileManager.default.removeItem(at: archive)
            }
            try await Self.tar(staging, into: archive)
            // Unpacked beside it, then moved into place whole, so the engine never finds half of it.
            try await connection.run(RemoteEngineInstaller.script("""
                d="$K/config/opencode/skills/"\(SSHConnection.quoted(skill.name))
                [ -e "$d" ] && { echo "taken" >&2; exit 3; }
                t="$d.kuvo-new"; rm -rf "$t"; mkdir -p "$t" && tar -xf - -C "$t" && mv "$t" "$d"
                """), input: archive)
        }
    }

    private static func file(_ name: String, in folder: URL) -> URL {
        folder.appending(path: name).appending(path: "SKILL.md")
    }

    @concurrent private static func tar(_ folder: URL, into archive: URL) async throws {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/tar")
        // Plain ustar, without the Mac's extended attributes, for GNU tar there.
        process.arguments = ["--no-mac-metadata", "--format", "ustar", "-cf", archive.path, "-C", folder.path, "."]
        process.environment = ["COPYFILE_DISABLE": "1"]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
}

extension AppModel {
    /// Where `box` keeps the skills you add and write.
    func skills(on box: SidebarBox) -> SkillsPlace {
        guard let machine = box.machine else { return .mac(skillsFolder) }
        return .machine(SSHConnection(destination: machine))
    }
}
