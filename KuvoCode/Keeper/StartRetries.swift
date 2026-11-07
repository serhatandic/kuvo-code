import Foundation
import OpenCodeKit

/// How a server of this Mac's box that couldn't start or keeps stopping (the box itself, the engine,
/// the coding agents' bridge) is tried again by itself: with the waits a machine's keeper has
/// (`bin/kuvo-start`), and at the longest for good, so a failure in the night doesn't leave it down
/// until someone clicks. Only what another try can help: a program that isn't there fails the same
/// way each time. What you ask for (Try Again, Restart) starts it at once, and a stop calls it off.
@MainActor final class StartRetries {
    /// How long to wait, in seconds, before each try after the first; the last for good after that.
    nonisolated static let waits = [15, 30, 60, 120, 300, 600]
    /// In place of that last one, after a try that took too long while macOS was asking you
    /// something: each try may bring the question back, and a question nobody's there to answer
    /// shouldn't come back every few minutes all night. Never no more tries: what looks like asking
    /// may be another app's question, and then this is all that brings the server back.
    nonisolated static let askedWait = 3600
    /// Up for this long, in seconds, it's running as it should: the waits begin again the next time
    /// it stops (as `bin/kuvo-start`).
    nonisolated static let steadyAfter: TimeInterval = 600
    /// Said after why it failed, as long as it's tried again.
    nonisolated static let note = "Trying again by itself."
    /// And before that, when macOS was asking you something as it failed.
    nonisolated static let askedNote = "macOS was asking you something, which may be holding it up."

    /// How it waits between tries (a test's moves on as it says).
    var clock: (Int) async -> Void = StartRetries.wait
    /// What macOS is asking, as this Mac's box looks (`MacBoxRunner`).
    var asking: SystemAsking?

    private var tried = 0
    /// Its last try took too long while macOS asked.
    private var lastHeld = false
    /// The next try, waiting its turn.
    private var turn: UUID?
    private var sleeper: Task<Void, Never>?

    /// Whether a try is waiting its turn.
    var isWaiting: Bool { turn != nil }
    /// Whether it's among the waits: it isn't started again at once until it has run as it should.
    var isBackingOff: Bool { tried > 0 }

    /// How long to wait before the next try. `asked`: the last took too long while macOS asked.
    func next(asked: Bool = false) -> Int {
        defer { tried = min(tried + 1, Self.waits.count) }
        guard tried < Self.waits.count else { return asked ? Self.askedWait : Self.waits[Self.waits.count - 1] }
        return Self.waits[tried]
    }

    /// You asked: the waits begin again.
    func reset() { tried = 0 }

    /// It was up for that long, and stopped.
    func stopped(ranFor seconds: TimeInterval) {
        if seconds >= Self.steadyAfter { tried = 0 }
    }

    /// Whether a try begun at `began` that ended in `cause` was held up by macOS asking you
    /// something, as far as anyone can tell: it took too long, with a question open at some point
    /// meanwhile. (Told to go, a server takes its question with it, so what's open now isn't enough.)
    func wasAsked(_ cause: any Error, since began: ContinuousClock.Instant) -> Bool {
        lastHeld = false
        guard Self.tookTooLong(cause), let asking else { return false }
        // Before this look too: told to go, its question may be gone by now, and that's no answer.
        if asking.asked(since: began) { asking.heldTryEnded() }
        _ = asking.look()
        lastHeld = asking.asked(since: began)
        guard lastHeld else { return false }
        asking.heldTryEnded()
        return true
    }

    /// Up, after a try begun at `began`: a question open meanwhile was answered, or wasn't holding it
    /// up, so whatever waits on one tries now. So too after the last try was held up by one: this
    /// one's may have been answered between looks.
    func cameUp(since began: ContinuousClock.Instant) {
        defer { lastHeld = false }
        guard let asking, lastHeld || asking.asked(since: began) else { return }
        asking.answered()
    }

    /// `go` once its time comes (`after` seconds; at once for nil), unless called off first; and,
    /// with `orAnswered`, as soon as the question it may have been held by is answered, which macOS
    /// remembers, so the next try gets through.
    func schedule(after wait: Int?, orAnswered: Bool = false, _ go: @escaping () async -> Void) {
        callOff()
        let turn = UUID()
        self.turn = turn
        let clock = clock
        sleeper = Task { [weak self] in
            if let wait { await clock(wait) }
            guard let self, self.turn == turn else { return }
            // (Past its wait: this is the start now, and calling it off mustn't reach into it.)
            self.turn = nil
            self.sleeper = nil
            await go()
        }
        guard orAnswered else { return }
        asking?.whenAnswered(by: self) { [weak self] in
            guard let self, self.turn == turn else { return }
            self.turn = nil
            self.sleeper?.cancel()
            self.sleeper = nil
            Task { await go() }
        }
    }

    /// The try waiting its turn called off.
    func callOff() {
        asking?.forget(self)
        turn = nil
        sleeper?.cancel()
        sleeper = nil
    }

    /// Why it failed, saying it's tried again: in its first paragraph, which is what a client is
    /// told (`BoxProcess.engineGaveUp`), before what the server wrote. `asked`: it took too long
    /// while macOS was asking, which someone coming back can do something about.
    nonisolated static func noted(_ reason: String, asked: Bool = false) -> String {
        let end = reason.range(of: "\n\n")?.lowerBound ?? reason.endIndex
        let why = reason[..<end]
        // (A server's own words may have no stop of their own.)
        let stop = why.last.map { ".!?:".contains($0) } == false ? "." : ""
        return why + stop + (asked ? " " + askedNote : "") + " " + note + reason[end...]
    }

    /// Whether another try could go differently: anything but what fails the same way again. That's
    /// a program that can't be run, a download that was refused or damaged, or a folder that can't
    /// be made. What this doesn't know of is tried: a try every ten minutes costs little, and being
    /// wrong the other way leaves it down until someone clicks.
    nonisolated static func canHelp(_ error: any Error) -> Bool {
        switch error {
        case is CancellationError, is CocoaError:
            return false
        case EngineInstallError.serverAnswered(let status):
            return status >= 500 || status == 408 || status == 429
        case is EngineInstallError:
            return false
        case let error as URLError:
            return error.code != .cancelled && !["disk", "tls"].contains(EngineInstallError.kind(of: error))
        case let error as POSIXError:
            return ![POSIXErrorCode.ENOENT, .EACCES, .EPERM, .ENOEXEC, .EBADARCH, .EBADEXEC, .EBADMACHO, .ENOTDIR, .EISDIR].contains(error.code)
        default:
            return true
        }
    }

    /// A start that never got anywhere: it didn't say where it listens, or never answered there.
    nonisolated private static func tookTooLong(_ error: any Error) -> Bool {
        switch error {
        case ServerProcessError.timedOut: true
        case let error as ServerError: error.status == 503
        case let error as URLError: error.code == .timedOut
        default: false
        }
    }

    /// Waits between tries as they're asked to (each test's own clock).
    nonisolated static func wait(_ seconds: Int) async {
        try? await Task.sleep(for: .seconds(seconds))
    }
}

/// Whether macOS is asking you something, as this Mac's box looks every few seconds (it can't be
/// asked afterwards: a question may go with the server that raised it).
@MainActor final class SystemAsking {
    /// Whether a question is open now (a test's says).
    var isOpen: () -> Bool = { AppModel.systemPromptOpen }

    private var lastSeen: ContinuousClock.Instant?
    /// What goes on once a question's answered, by who's waiting, and how many looks have seen one
    /// open since the last try that was held up ended.
    private var waiting: [ObjectIdentifier: (looks: Int, go: () -> Void)] = [:]

    /// Looks now: whether one's open. One that closes after two looks have seen it open since a held
    /// try last ended counts as answered. Fewer, and it may have gone with the server told to go,
    /// with nobody seeing to it, and trying then would only raise it again.
    @discardableResult func look() -> Bool {
        if isOpen() {
            lastSeen = .now
            for who in waiting.keys { waiting[who]?.looks += 1 }
            return true
        }
        let closed = waiting.values.filter { $0.looks >= 2 }
        waiting = waiting.filter { $0.value.looks < 2 }.mapValues { (looks: 0, go: $0.go) }
        for one in closed { one.go() }
        return false
    }

    /// A try held up by one just ended, whichever server's: what's open may go with it.
    func heldTryEnded() {
        for who in waiting.keys { waiting[who]?.looks = 0 }
    }

    /// One's been answered, as a server held up by it came up: whoever waits goes now.
    func answered() {
        let all = waiting.values
        waiting = [:]
        for one in all { one.go() }
    }

    /// Whether one's been seen open since then.
    func asked(since began: ContinuousClock.Instant) -> Bool {
        lastSeen.map { $0 >= began } ?? false
    }

    /// `go` once a question open from now on is answered (at most once, the last one given).
    func whenAnswered(by who: AnyObject, _ go: @escaping () -> Void) {
        waiting[ObjectIdentifier(who)] = (looks: 0, go: go)
    }

    /// Nothing more to do when one's answered.
    func forget(_ who: AnyObject) {
        waiting[ObjectIdentifier(who)] = nil
    }
}
