import Foundation
import Testing
@testable import OpenCodeKit

/// Runs against a real opencode binary. Skipped unless OPENCODE_TEST_BINARY points at one:
///
///     OPENCODE_TEST_BINARY=/path/to/opencode swift test --filter LiveServerTests
@Suite(.enabled(if: ProcessInfo.processInfo.environment["OPENCODE_TEST_BINARY"] != nil))
struct LiveServerTests {
    @Test func startsAndAnswersInfo() async throws {
        let binary = URL(filePath: ProcessInfo.processInfo.environment["OPENCODE_TEST_BINARY"]!)
        let root = FileManager.default.temporaryDirectory.appending(path: "opencodekit-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let folders = EngineFolders(root: root)
        let server = try await ServerProcess.start(executable: binary, folders: folders, environment: ProcessInfo.processInfo.environment)
        defer { server.stop() }

        let client = HTTPClient(endpoint: server.endpoint)
        struct Info: Decodable { var version: String; var pid: Int }
        // The server answers 503 while it boots.
        var info: Info?
        for _ in 0..<100 where info == nil {
            info = try? await client.send(client.request("GET", "api/info"), as: Info.self)
            if info == nil { try await Task.sleep(for: .milliseconds(100)) }
        }
        #expect(info?.version == OpenCodeEngine.version)
    }

    /// The commands it runs get the folders it was started with back, not its own: `gh` and the
    /// like find their sign-ins.
    @Test func commandsGetTheirOwnFolders() async throws {
        let binary = URL(filePath: ProcessInfo.processInfo.environment["OPENCODE_TEST_BINARY"]!)
        let root = FileManager.default.temporaryDirectory.appending(path: "opencodekit-commands-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let project = root.appending(path: "project")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        var environment = ProcessInfo.processInfo.environment
        environment["XDG_CONFIG_HOME"] = "/own/config"
        environment.removeValue(forKey: "XDG_DATA_HOME")
        // The settings Kuvo Code gives the engine, with keys in them: not for commands.
        environment["OPENCODE_CONFIG_CONTENT"] = #"{"mcp":{"servers":{}}}"#
        // Started in your tmux: a command's tmux would open its windows there.
        environment["TMUX"] = "/private/tmp/tmux-501/default,1234,0"
        let folders = EngineFolders(root: root.appending(path: "engine"))
        let server = try await ServerProcess.start(executable: binary, folders: folders, environment: environment)
        defer { server.stop() }
        let api = OpenCodeAPI(endpoint: server.endpoint)
        let session = try await api.createSession(directory: project.path)
        try await api.runShell(session: session.id, command: #"printf '%s|%s|%s|%s|%s' "${XDG_CONFIG_HOME-unset}" "${XDG_DATA_HOME-unset}" "${KUVO_OWN_XDG_CONFIG_HOME-unset}" "${OPENCODE_CONFIG_CONTENT-unset}" "${TMUX-unset}" >seen"#)
        let seen = project.appending(path: "seen")
        for _ in 0..<100 where !FileManager.default.fileExists(atPath: seen.path) { try await Task.sleep(for: .milliseconds(100)) }
        #expect(try String(contentsOf: seen, encoding: .utf8) == "/own/config|unset|unset|unset|unset")
        // The engine itself keeps its own.
        #expect(FileManager.default.fileExists(atPath: folders.dataDirectory.path))
    }

    @Test func createsAndRemovesWorktrees() async throws {
        let binary = URL(filePath: ProcessInfo.processInfo.environment["OPENCODE_TEST_BINARY"]!)
        let root = FileManager.default.temporaryDirectory.appending(path: "opencodekit-worktrees-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let repository = root.appending(path: "repo")
        try FileManager.default.createDirectory(at: repository, withIntermediateDirectories: true)
        try "hello\n".write(to: repository.appending(path: "README.md"), atomically: true, encoding: .utf8)
        for arguments in [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]] {
            let git = Process()
            git.executableURL = URL(filePath: "/usr/bin/git")
            git.arguments = arguments
            git.currentDirectoryURL = repository
            try git.run()
            git.waitUntilExit()
        }

        let server = try await ServerProcess.start(executable: binary, folders: EngineFolders(root: root.appending(path: "engine")), environment: ProcessInfo.processInfo.environment)
        defer { server.stop() }
        let api = OpenCodeAPI(endpoint: server.endpoint)
        let location = try await api.location(directory: repository.path)
        // The engine names folders by their real path (/private/var/…).
        #expect(location.project.canonical.hasSuffix(repository.path))

        try await api.setSetupCommand(project: location.project.id, "touch set-up")
        #expect(try await api.projects().first { $0.id == location.project.id }?.commands?.start == "touch set-up")

        let worktree = try await api.createWorktree(project: location.project.id)
        #expect(FileManager.default.fileExists(atPath: worktree + "/README.md"))
        #expect(FileManager.default.fileExists(atPath: worktree + "/set-up"))
        #expect(try await api.location(directory: worktree).project.id == location.project.id)

        // The setup command's file isn't committed, so only a forced removal goes through.
        await #expect(throws: ServerError.self) { try await api.removeWorktree(project: location.project.id, directory: worktree, force: false) }
        try await api.removeWorktree(project: location.project.id, directory: worktree, force: true)
        #expect(!FileManager.default.fileExists(atPath: worktree))
    }

    /// A sign-in to an MCP server, copied whole from one engine to another (as the app does
    /// between this Mac's and a machine's), is the other's active one.
    @Test func copiesSignInsBetweenEngines() async throws {
        let binary = URL(filePath: ProcessInfo.processInfo.environment["OPENCODE_TEST_BINARY"]!)
        let root = FileManager.default.temporaryDirectory.appending(path: "opencodekit-signins-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        var environment = ProcessInfo.processInfo.environment
        // Nothing listens there; it only has to need a sign-in.
        environment["OPENCODE_CONFIG_CONTENT"] = #"{"mcp":{"service":{"type":"remote","url":"http://127.0.0.1:9/mcp"}}}"#
        let one = try await ServerProcess.start(executable: binary, folders: EngineFolders(root: root.appending(path: "one")), environment: environment)
        defer { one.stop() }
        let other = try await ServerProcess.start(executable: binary, folders: EngineFolders(root: root.appending(path: "other")), environment: environment)
        defer { other.stop() }
        let from = OpenCodeAPI(endpoint: one.endpoint), to = OpenCodeAPI(endpoint: other.endpoint)
        func integration(_ api: OpenCodeAPI) async throws -> String? {
            for _ in 0..<100 {
                if let id = try? await api.mcpServers().first(where: { $0.name == "service" })?.integrationID { return id }
                try await Task.sleep(for: .milliseconds(100))
            }
            return nil
        }
        let source = try #require(try await integration(from)), target = try #require(try await integration(to))
        // Named after the server, so the same on both (which signing out on both relies on).
        #expect(source == target)

        let made: JSONValue = .object([
            "type": .string("oauth"), "methodID": .string("oauth"), "refresh": .string("test-refresh"), "access": .string("test-access"),
            "expires": .number(4_102_444_800_000), "metadata": .object(["serverUrl": .string("http://127.0.0.1:9/mcp")]),
        ])
        try await from.storeCredential(CredentialEntry(id: "", integrationID: source, label: "service", active: true, value: made), for: source)
        let entry = try #require(try await from.credentialEntries().first { $0.integrationID == source })
        #expect(entry.isOAuth && entry.active && entry.expires == 4_102_444_800_000)

        try await to.storeCredential(entry, for: target)
        let copy = try #require(try await to.credentialEntries().first { $0.integrationID == target })
        #expect(copy.active && copy.value["refresh"]?.string == "test-refresh" && copy.value["access"]?.string == "test-access" && copy.expires == entry.expires)
    }
}
