import Foundation
import OpenCodeKit

/// The one way anything but you sends to a conversation: wake-ups and watches, agents' letters, a
/// notification's Reply, a group chat's turns and the parts of its work. (What you type goes from
/// the composer, which keeps it while the conversation moves.)
///
/// While a move to another computer has the conversation (`Moves`), nothing reaches it: what's
/// sent waits, and goes once the move is over, on the engine it lives on then: where it went, or
/// where it was if the move failed or was taken back. What's kept to be sent again anyway (a
/// wake-up's file, which goes along with its folder; a letter waiting for its machine) doesn't
/// wait: it's left for its next try. One whose move was cut short (the app quit) takes nothing
/// until that's finished, when both computers are there.
enum Deliveries {
    /// Asked for a conversation whose engine isn't there once it's its turn.
    struct Unreachable: LocalizedError {
        var errorDescription: String? { "Its engine isn’t connected." }
    }

    /// Sends `text` to `session`, on `api` as it is once nothing holds it (asked then). `later`:
    /// it doesn't wait, as it's kept to be tried again. Whether it went: not when it's left for
    /// later. One whose move was cut short throws `Moves.Failure.moving` until that's finished.
    @discardableResult
    static func send(_ text: String, to session: String, id: String = Identifier.message(), delivery: InboxItem.Delivery,
                     later: Bool = false, on api: @autoclosure () -> OpenCodeAPI?) async throws -> Bool {
        if later {
            guard !Moves.isFrozen(session) else { return false }
        } else {
            try await settled(session)
        }
        guard let api = api() else { throw Unreachable() }
        try await api.prompt(session: session, id: id, text: text, delivery: delivery)
        return true
    }

    /// Once no move under way has any of `ids` (a conversation, a bot): at once when none has.
    /// Throws `Moves.Failure.moving` for one whose move was cut short, until that's finished, and
    /// if the task waiting is cancelled.
    static func settled(_ ids: String...) async throws {
        while ids.contains(where: Moves.frozen.contains) {
            let key = UUID()
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (going: CheckedContinuation<Void, Error>) in
                    if Task.isCancelled { going.resume(throwing: CancellationError()) } else { waiting[key] = (ids, going) }
                }
            } onCancel: {
                Task { @MainActor in waiting.removeValue(forKey: key)?.going.resume(throwing: CancellationError()) }
            }
        }
        if ids.contains(where: Moves.isFrozen) { throw Moves.Failure.moving }
    }

    /// What waits for moves, by the IDs it waits for.
    private static var waiting: [UUID: (ids: [String], going: CheckedContinuation<Void, Error>)] = [:]

    /// A move let some go (`Moves`): what waited for only those goes now.
    static func movesChanged() {
        for (key, waiter) in waiting where !waiter.ids.contains(where: Moves.frozen.contains) {
            waiting.removeValue(forKey: key)?.going.resume()
        }
    }
}
