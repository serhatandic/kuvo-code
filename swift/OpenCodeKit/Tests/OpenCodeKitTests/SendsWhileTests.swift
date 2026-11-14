import Foundation
import Testing
@testable import OpenCodeKit

/// A machine's connect cut off (removed, disconnected): no script of its starts there after, by
/// either way of running one, while another machine's scripts go on. The machines are under
/// `.invalid`, which nothing reaches: a script let through fails as SSH to one does (or another
/// suite's stand-in answers it), never as one refused.
@Suite struct SendsWhileTests {
    let machine = SSHConnection(destination: "sends-while.invalid")
    let other = SSHConnection(destination: "sends-while-other.invalid")
    let output = FileManager.default.temporaryDirectory.appending(path: "sends-while-\(UUID().uuidString)")

    @Test func noScriptStartsOnceItsMachineIsNoLongerWanted() async {
        defer { try? FileManager.default.removeItem(at: output) }
        await SSHConnection.$sendsWhile.withValue((machine.destination, { false })) {
            await #expect(throws: CancellationError.self) { try await machine.run("true") }
            await #expect(throws: CancellationError.self) { try await machine.run("true", output: output) }
            #expect(!FileManager.default.fileExists(atPath: output.path), "nothing was started to write it")
            // Another machine's, from a task begun meanwhile: let through.
            #expect(await !isRefused { try await other.run("true") })
        }
    }

    @Test func scriptsGoWhileItsWanted() async {
        await SSHConnection.$sendsWhile.withValue((machine.destination, { true })) {
            #expect(await !isRefused { try await machine.run("true") })
        }
    }

    private func isRefused(_ run: () async throws -> String) async -> Bool {
        do { _ = try await run() } catch is CancellationError { return true } catch {}
        return false
    }
}
