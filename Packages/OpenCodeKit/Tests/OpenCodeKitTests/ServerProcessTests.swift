import Foundation
import Testing
@testable import OpenCodeKit

struct ServerProcessTests {
    @Test func unsharedPipesCloseOnExec() {
        let pipe = Pipe.unshared()
        for handle in [pipe.fileHandleForReading, pipe.fileHandleForWriting] {
            #expect(fcntl(handle.fileDescriptor, F_GETFD) & FD_CLOEXEC != 0)
        }
    }

    /// A program started without closing what it inherits, as a terminal's shell is (forkpty,
    /// then exec), doesn't keep the engine's stdin open: the engine still exits when stopped.
    @Test func stopsWhileAnotherProgramRuns() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "opencodekit-server-\(UUID().uuidString)")
        let folders = EngineFolders(root: root.appending(path: "folders"))
        // The engine's temporary folder, made as it starts, goes too unless it was there before.
        let temporary = folders.temporary.deletingLastPathComponent()
        let hadTemporary = FileManager.default.fileExists(atPath: temporary.path)
        defer {
            try? FileManager.default.removeItem(at: root)
            if !hadTemporary { try? FileManager.default.removeItem(at: temporary) }
        }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // Says where it listens, then runs until its stdin closes, as the engine does.
        let engine = root.appending(path: "engine")
        try "#!/bin/sh\necho '{\"url\":\"http://127.0.0.1:9\"}'\n/bin/cat >/dev/null\n".write(to: engine, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)

        let (exits, exited) = AsyncStream<Int32>.makeStream()
        let server = try await ServerProcess.start(executable: engine, folders: folders, environment: [:], onExit: { exited.yield($0) })

        // posix_spawn with no file actions: every descriptor not marked close-on-exec goes along.
        var pid: pid_t = 0
        let arguments: [UnsafeMutablePointer<CChar>?] = [strdup("/bin/sleep"), strdup("30"), nil]
        defer { arguments.forEach { free($0) } }
        #expect(posix_spawn(&pid, "/bin/sleep", nil, nil, arguments, environ) == 0)
        defer {
            kill(pid, SIGKILL)
            waitpid(pid, nil, 0)
        }

        server.stop()
        // Sooner than stop's own fallback (SIGTERM after 5 seconds) would end it.
        let status = await withTaskGroup(of: Int32?.self) { group in
            group.addTask { await exits.first { _ in true } }
            group.addTask {
                try? await Task.sleep(for: .seconds(3))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        #expect(status == 0)
    }

    /// An engine that stops before it's listening says why, with what it wrote; one that stops
    /// after has its exit code.
    @Test func stoppingWhileStartingKeepsTheReason() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "opencodekit-server-\(UUID().uuidString)")
        let folders = EngineFolders(root: root.appending(path: "folders"))
        let temporary = folders.temporary.deletingLastPathComponent()
        let hadTemporary = FileManager.default.fileExists(atPath: temporary.path)
        defer {
            try? FileManager.default.removeItem(at: root)
            if !hadTemporary { try? FileManager.default.removeItem(at: temporary) }
        }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        func engine(_ name: String, _ script: String) throws -> URL {
            let file = root.appending(path: name)
            try "#!/bin/sh\n\(script)\n".write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
            return file
        }

        do {
            _ = try await ServerProcess.start(executable: try engine("failing", "echo 'Error: config is invalid' >&2; exit 3"), folders: folders, environment: [:])
            Issue.record("It started.")
        } catch let error as ServerProcessError {
            guard case .exited(let status, let output) = error else { Issue.record("\(error)"); return }
            #expect(status == 3)
            #expect(output.contains("config is invalid"))
        }

        let server = try await ServerProcess.start(executable: try engine("short", "echo '{\"url\":\"http://127.0.0.1:9\"}'; echo 'Error: gone' >&2; exit 4"), folders: folders, environment: [:])
        for _ in 0..<100 where server.exitStatus == nil || !server.recentOutput.contains("gone") { try await Task.sleep(for: .milliseconds(20)) }
        #expect(server.exitStatus == 4)
        #expect(server.recentOutput.contains("gone"))
    }
}

/// Servers that never say where they listen: the engine, the agents bridge and this Mac's box
/// each start through `ServerProcess`, so one held up must neither hold up the others nor wait
/// past its time limit.
@Suite(.timeLimit(.minutes(1))) struct SilentServerTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "opencodekit-silent-\(UUID().uuidString)")

    init() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    /// A script that runs as a server would, until its stdin closes, its output still open
    /// (`then` can redirect it).
    private func server(_ name: String, _ script: String, then: String = "") throws -> URL {
        let file = root.appending(path: name)
        try "#!/bin/sh\n\(script)\nexec /bin/cat \(then)\n".write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        return file
    }

    /// One that says nothing while it starts (a box held up) doesn't keep another from starting
    /// meanwhile. Each start used to wait for the one before it to say something or stop.
    @Test func oneThatSaysNothingDoesntHoldUpAnother() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        // It tells the test it's running, then says nothing.
        let running = root.appending(path: "running")
        #expect(mkfifo(running.path, 0o600) == 0)
        let silent = try server("silent", "echo > '\(running.path)'")
        let (exits, exited) = AsyncStream<Int32>.makeStream()
        let waiting = Task {
            try await ServerProcess.start(executable: silent, arguments: [], environment: [:], directory: root, onExit: { exited.yield($0) })
        }
        _ = await Task.detached { FileHandle(forReadingAtPath: running.path)?.readDataToEndOfFile() }.value

        let other = try await ServerProcess.start(executable: try server("other", "echo '{\"url\":\"http://127.0.0.1:9\"}'"),
                                                  arguments: [], environment: [:], directory: root)
        #expect(other.endpoint.url.absoluteString == "http://127.0.0.1:9")
        other.stop()

        // The silent one, given up on, is stopped.
        waiting.cancel()
        await #expect(throws: (any Error).self) { try await waiting.value }
        #expect(await exits.first { _ in true } != nil)
    }

    /// One that never says where it listens is stopped once its time is up, and its start says
    /// so: it used to go on waiting, and the app's start with it. Whether it keeps its output
    /// open, or closes it and goes on running.
    @Test(arguments: ["", ">/dev/null"]) func oneThatNeverAnswersIsStoppedWhenItsTimeIsUp(output: String) async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let (exits, exited) = AsyncStream<Int32>.makeStream()
        do {
            _ = try await ServerProcess.start(executable: try server("silent", "", then: output), arguments: [], environment: [:], directory: root,
                                              timeout: .milliseconds(200), onExit: { exited.yield($0) })
            Issue.record("It started.")
        } catch ServerProcessError.timedOut {
        }
        #expect(await exits.first { _ in true } != nil, "it was stopped")
    }
}
