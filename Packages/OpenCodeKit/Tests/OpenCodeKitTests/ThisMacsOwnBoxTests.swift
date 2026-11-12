import Foundation
import Network
import Testing
@testable import OpenCodeKit

/// This Mac's own box, attached in place (#183): the app reaches it as a machine, by
/// `SSHConnection.thisMac`, and what would go over SSH runs here, from its home folder (a test's
/// own), as sshd would run it, with nothing of the app's own around it.
@Suite struct ThisMacsOwnBoxTests {
    let connection = SSHConnection(destination: SSHConnection.thisMac)

    private func withHome<T>(_ body: (URL) async throws -> T) async throws -> T {
        let home = URL(filePath: NSTemporaryDirectory()).appending(path: "kuvo-own-box-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        return try await SSHConnection.$scopedHome.withValue(home.path) { try await body(home) }
    }

    @Test func aScriptRunsHereFromItsHomeFolderAsWritten() async throws {
        try await withHome { home in
            // What a script holds reaches the shell as written, as it does over SSH.
            let tricky = "it's \"$(whoami)\" `id` back\\slash $HOME"
            let said = try await connection.run("""
                printf '%s\\n' "$HOME" "$([ "$(pwd -P)" = "$(cd "$HOME" && pwd -P)" ] && echo home)" \(SSHConnection.quoted(tricky))
                touch made-here
                """)
            #expect(said == home.path + "\nhome\n" + tricky + "\n")
            #expect(FileManager.default.fileExists(atPath: home.appending(path: "made-here").path))
        }
    }

    @Test func itSeesOnlyWhatACommandOverSSHWould() async throws {
        try await withHome { _ in
            setenv("KUVO_OWN_BOX_PROBE", "the app's", 1)
            defer { unsetenv("KUVO_OWN_BOX_PROBE") }
            let said = try await connection.run(#"printf '%s|%s|%s|%s\n' "${KUVO_OWN_BOX_PROBE-none}" "$PATH" "$USER" "${XDG_CONFIG_HOME-none}""#)
            #expect(said == "none|/usr/bin:/bin:/usr/sbin:/sbin|\(NSUserName())|none\n")
        }
    }

    @Test func whatsSentGoesInAndWhatItPrintsCanGoToAFile() async throws {
        try await withHome { home in
            let input = home.appending(path: "in")
            try Data("sent\n".utf8).write(to: input)
            #expect(try await connection.run("tr a-z A-Z", input: input) == "SENT\n")
            let output = home.appending(path: "out")
            try await connection.run("printf 'as it is'", output: output)
            #expect(try String(contentsOf: output, encoding: .utf8) == "as it is")
        }
    }

    @Test func aScriptThatFailsSaysSoAsOverSSH() async throws {
        try await withHome { _ in
            await #expect(throws: RemoteEngineError.self) { try await connection.run("echo no >&2; exit 3") }
            do {
                try await connection.run("echo no >&2; exit 3")
            } catch RemoteEngineError.ssh(let status, let message) {
                #expect(status == 3)
                #expect(message.contains("no"))
            }
        }
    }

    /// The check that refuses this Mac in this account as a machine lets its own box through.
    @Test func itsOwnBoxIsntRefusedAsThisMac() throws {
        let answer = "Darwin arm64\ntools\nmacos 15.0\ncomputer \(ThisMac.identifier) \(getuid())\n"
        let cache = URL(filePath: NSTemporaryDirectory())
        let checked = { (connection: SSHConnection) in
            RemoteEngineInstaller.$scopedRoot.withValue(".kuvo-code") { Result { try RemoteEngineInstaller(connection: connection, cache: cache).checked(answer).release } }
        }
        #expect(throws: RemoteEngineError.self) { try checked(SSHConnection(destination: "mac.example")).get() }
        #expect(try checked(connection).get() == EngineRelease.darwin(machine: "arm64"))
    }

    @Test func itsNeverAStandInNorRoutedElsewhere() {
        SSHConnection.route(SSHConnection.thisMac, to: "elsewhere.example")
        #expect(connection.address == SSHConnection.thisMac)
        #expect(!connection.isStandIn)
        #expect(connection.invocation(running: "true").executable != "/usr/bin/ssh")
        #expect(SSHConnection(destination: "mac.example").invocation(running: "true").executable == "/usr/bin/ssh")
    }

    /// Looking for its engine only reads: its keeper is launchd's, never one the app would start (it
    /// would run as Kuvo Code's), and whether it's off is its Mac's to say.
    @Test func lookingForItsEngineStartsNothing() async throws {
        try await withHome { home in
            try await RemoteEngineInstaller.$scopedRoot.withValue(".kuvo-code-test") {
                let box = home.appending(path: ".kuvo-code-test")
                try FileManager.default.createDirectory(at: box.appending(path: "bin"), withIntermediateDirectories: true)
                try FileManager.default.createDirectory(at: box.appending(path: "run"), withIntermediateDirectories: true)
                try "touch \"$HOME/started\"\n".write(to: box.appending(path: "bin/kuvo-start"), atomically: true, encoding: .utf8)
                try Data().write(to: box.appending(path: "run/off"))
                #expect(try await RemoteServer.find(on: connection) == .none)
                #expect(!FileManager.default.fileExists(atPath: home.appending(path: "started").path), "its keeper isn't started from here")
                #expect(FileManager.default.fileExists(atPath: box.appending(path: "run/off").path))
            }
        }
    }

    /// The account's crontab and launch agents are written only from the account's own home: a box in
    /// a home of its own (a test's), run here, never adds to them.
    @Test func theAccountsStartAtLoginIsOnlyWrittenFromItsOwnHome() async throws {
        try await withHome { home in
            let gated = RemoteServer.accountsOwnHome("echo written")
            #expect(try await connection.run(gated).isEmpty)
            let own = try await SSHConnection.$scopedHome.withValue(NSHomeDirectory()) { try await connection.run(gated) }
            #expect(own == "written\n")
        }
    }

    /// Its engine is reached at its own port on this Mac, with nothing in between.
    @Test func itsEngineIsReachedAtItsOwnPort() async throws {
        let engine = try Engine.answering()
        defer { engine.listener.cancel() }
        let found = RemoteServer.Engine(pid: 1, port: engine.port, password: "secret", version: "1", notes: [:],
                                        agents: .init(port: 45_678, password: "agents"))
        let server = try await RemoteServer.attach(to: found, on: connection, timeout: .seconds(10))
        #expect(server.endpoint.url.absoluteString == "http://127.0.0.1:\(engine.port)")
        #expect(server.agentsEndpoint?.url.absoluteString == "http://127.0.0.1:45678")
        #expect(server.isConnected)
        server.disconnect()
        #expect(server.isConnected)
    }

    /// An engine stand-in on this Mac: answers every request with its info.
    private struct Engine {
        let listener: NWListener
        let port: Int

        static func answering() throws -> Engine {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
            let listener = try NWListener(using: parameters)
            let ready = DispatchSemaphore(value: 0)
            listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
            listener.newConnectionHandler = { connection in
                connection.start(queue: .global())
                // (The handlers hold the connection until it's answered.)
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { _, _, _, _ in
                    let body = #"{"version":"1"}"#
                    let answer = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                    connection.send(content: Data(answer.utf8), completion: .contentProcessed { _ in connection.cancel() })
                }
            }
            listener.start(queue: .global())
            ready.wait()
            guard let port = listener.port?.rawValue else { throw POSIXError(.EADDRNOTAVAIL) }
            return Engine(listener: listener, port: Int(port))
        }
    }
}
