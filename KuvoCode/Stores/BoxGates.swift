import ClientSessions
import Foundation
import os

/// The update gate on this Mac (#679, PROTOCOL.md "The update gate"): the boxes older than this
/// app needs (`BoxGate`), held until they're up to date. A held box is sent nothing but what says
/// what it is and what updates it (`BoxClient` refuses the rest here, with these words): no route
/// falls back to an older box's way. Each is updating, or couldn't be updated and says why.
///
/// A machine is held while its connection brings it up to date (`MachineEngine.connect`, which
/// installs this app's files, or offers this Mac's box attached in place the release the app
/// carries); this Mac's own box, while an older app's keeper still runs it (`keeperMakesWay`).
/// A box found older later (its session list says so) is held too (`foundOlder`).
@MainActor @Observable
final class BoxGates {
    enum State: Equatable {
        /// Being brought up to date; `detail`: what's waited for, where there's more to say.
        case updating(detail: String?)
        /// It couldn't be: why, and what to do.
        case failed(String)
    }

    /// The boxes held now, by id.
    private(set) var held: [String: State] = [:]

    /// A held box let go (up to date now): what follows it reads it again at once.
    @ObservationIgnored var onLetGo: (String) -> Void = { _ in }

    func state(of box: String) -> State? { held[box] }

    /// A box that said (to what reads its features) it has less than this app needs, though it was
    /// let through (it went back to an older version since, say): held. This Mac's own is updating
    /// with its keeper; a machine isn't used until it's connected again, which brings it up to
    /// date. `name`: the computer's, as it's said.
    func foundOlder(_ box: String, features: [String], name: String) {
        guard !BoxGate.isCurrent(features), held[box] == nil else { return }
        if box == BoxClient.mac {
            updating(box, detail: BoxGate.Words.thisMacFinishing)
        } else {
            failed(box, BoxGate.Words.couldntUpdate(name, why: "It answers as an older version since it connected"))
        }
    }

    /// Being brought up to date, saying what's waited for.
    func updating(_ box: String, detail: String? = nil) {
        set(box, .updating(detail: detail))
    }

    /// Couldn't be brought up to date: `words` say why and what to do.
    func failed(_ box: String, _ words: String) {
        set(box, .failed(words))
    }

    /// Up to date, or gone: what follows it reads it again.
    func letGo(_ box: String) {
        guard held.removeValue(forKey: box) != nil else { return }
        _ = Self.mirror.withLock { $0.removeValue(forKey: box) }
        onLetGo(box)
    }

    private func set(_ box: String, _ state: State) {
        held[box] = state
        let words = Self.refusalWords(state)
        Self.mirror.withLock { $0[box] = words }
    }

    // MARK: For requests, on any thread

    /// What a held box's routes answer here, by box: each box's alone, as its gates set it (the
    /// app has one `BoxGates`; a test's apps each hold boxes of their own).
    private nonisolated static let mirror = OSAllocatedUnfairLock<[String: String]>(initialState: [:])

    private nonisolated static func refusalWords(_ state: State) -> String {
        switch state {
        case .updating(let detail): [BoxGate.Words.updating, detail].compactMap(\.self).joined(separator: " ")
        case .failed(let words): words
        }
    }

    /// The refusal a request to `box` gets here instead of going there, while it's held: `503`
    /// with the gate's words (`reason: "updating"`); nil for a box that isn't, or a route that
    /// tells or brings about its update (`BoxGate.isAllowed`).
    nonisolated static func refusal(for box: String, path: String) -> BoxRefusal? {
        guard !BoxGate.isAllowed(path), let words = mirror.withLock({ $0[box] }) else { return nil }
        return BoxRefusal(status: 503, message: words, reason: reason)
    }

    /// Whether `box` is held now, from any thread.
    nonisolated static func isHeld(_ box: String) -> Bool { mirror.withLock { $0[box] != nil } }

    /// The `reason` of a held box's refusal.
    nonisolated static let reason = "updating"
}
