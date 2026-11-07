import Foundation
import OpenCodeKit

/// How a server of this Mac's box that couldn't start (the engine, the coding agents' bridge) is
/// tried again by itself: with the waits a machine's keeper has between starts that keep failing
/// (`bin/kuvo-start`), and then no more, for you to see why. Only what another try can help: a
/// program that isn't there fails the same way each time. What you ask for (Try Again, Restart)
/// starts it at once, whatever this has left.
struct StartRetries {
    /// How long to wait, in seconds, before each try after the first.
    static let waits = [15, 30, 60, 120, 300, 600]
    /// Said after why it failed, as long as it's tried again.
    static let note = "Trying again by itself."

    private var tried = 0

    /// How long to wait before the next try; nil once there are no more.
    mutating func next() -> Int? {
        guard tried < Self.waits.count else { return nil }
        defer { tried += 1 }
        return Self.waits[tried]
    }

    /// It started, or you asked: the waits begin again.
    mutating func reset() { tried = 0 }

    /// Why it failed, saying it's tried again: in its first paragraph, which is what a client is
    /// told (`BoxProcess.engineGaveUp`), before what the server wrote.
    static func noted(_ reason: String) -> String {
        guard let end = reason.range(of: "\n\n") else { return reason + " " + note }
        return reason[..<end.lowerBound] + " " + note + reason[end.lowerBound...]
    }

    /// Whether another try could go differently. One that started and stopped, took too long, or
    /// couldn't be reached can (the Mac was busy, its database was held, the network was down);
    /// one that can't be run, a download that was refused or damaged, or a folder that can't be
    /// made fails the same way again.
    static func canHelp(_ error: any Error) -> Bool {
        switch error {
        case ServerProcessError.exited(let status, _):
            // The system's words for a program it can't run, or can't find.
            return status != 126 && status != 127
        case ServerProcessError.timedOut:
            return true
        case EngineInstallError.serverAnswered(let status):
            return status >= 500 || status == 408 || status == 429
        case is ServerError:
            return true
        case let error as URLError:
            return error.code != .cancelled && !["disk", "tls"].contains(EngineInstallError.kind(of: error))
        default:
            return false
        }
    }

    /// Waits between tries as they're asked to (each test's own clock).
    static func wait(_ seconds: Int) async {
        try? await Task.sleep(for: .seconds(seconds))
    }
}
