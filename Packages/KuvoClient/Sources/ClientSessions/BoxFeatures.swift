import Foundation
import Observation

/// What each box says it has (`kuvo/info`'s `features`, PROTOCOL.md "Features"): a client's one
/// reader of them, with one cache and one rule for an answer that can't tell (`said`).
///
/// The update gate (`BoxGate`) holds a box until it has every name in `BoxGate.required`, and a box
/// with those has every name that came before them, so nothing here is asked about those: a client
/// asks only of names newer than the gate (and of a kind's own names, `update` or `engine.start`).
/// What it reads tells the gate too (`onSaid`), as every `kuvo/info` answer does.
@MainActor @Observable
public final class BoxFeatures {
    /// What a box answered `GET kuvo/info` with; it throws where the box wasn't reached.
    public typealias Ask = @MainActor (_ box: String) async throws -> (status: Int, body: Data)

    /// What a `kuvo/info` answer says of a box's features.
    public enum Said: Equatable, Sendable {
        /// What it has: none for a box from before it said (no `kuvo/info`, or no `features`).
        case has(Set<String>)
        /// It couldn't tell just now (not reached, refused, or not read): nothing is assumed, old
        /// or new, and it's asked again the next time.
        case cantTell
    }

    /// The rule, as the update gate has it (PROTOCOL.md, "The update gate"): an answer with its
    /// features says them; one without `features` (a box from before it said) and a 404 or 405
    /// (a box from before `kuvo/info`) say none, so the gate holds it; any other answer can't tell.
    public nonisolated static func said(status: Int, body: Data) -> Said {
        if status == 404 || status == 405 { return .has([]) }
        struct Info: Decodable { var features: [String]? }
        guard (200..<300).contains(status), let info = try? JSONDecoder().decode(Info.self, from: body) else { return .cantTell }
        return .has(Set(info.features ?? []))
    }

    /// Each box's features, by box, as it last said them: kept until it's read again or forgotten.
    public private(set) var known: [String: Set<String>] = [:]

    /// Told each time a box says what it has, read here or taken from another read: the update
    /// gate's check (`BoxGate.isCurrent`). Never told what couldn't tell.
    @ObservationIgnored public var onSaid: (_ box: String, _ features: Set<String>) -> Void = { _, _ in }

    @ObservationIgnored private let ask: Ask
    @ObservationIgnored private let hasEverything: (String) -> Bool
    /// The read under way, by box: whoever asks meanwhile waits for it, rather than asking again.
    @ObservationIgnored private var reads: [String: (id: Int, task: Task<Said, Never>)] = [:]
    @ObservationIgnored private var lastRead = 0

    /// `ask`: how a box is asked (`GET kuvo/info`). `hasEverything`: boxes known to have every name
    /// this client asks of, never asked (a Mac's own box, of the app's own version).
    public init(hasEverything: @escaping (String) -> Bool = { _ in false }, ask: @escaping Ask) {
        self.ask = ask
        self.hasEverything = hasEverything
    }

    /// Whether `box` has `feature`, as it said; read once where it hasn't said yet. Nil where it
    /// can't tell now: asked again the next time.
    public func has(_ feature: String, on box: String) async -> Bool? {
        assert(!BoxGate.required.contains(feature), "\(feature) is the update gate's: a box that isn't held has it")
        if hasEverything(box) { return true }
        return await features(of: box)?.contains(feature)
    }

    /// Whether `box` has `feature`, as it last said, without asking it: nil until it has said.
    public func knows(_ feature: String, on box: String) -> Bool? {
        if hasEverything(box) { return true }
        return known[box]?.contains(feature)
    }

    /// What `box` has, as it said: read once where it hasn't said yet. Nil where it can't tell now.
    public func features(of box: String) async -> Set<String>? {
        if let said = known[box] { return said }
        guard case .has(let features) = await read(box) else { return nil }
        return features
    }

    /// What `box` says it has now, asked again whatever it said before (a box that may have been
    /// updated meanwhile). What it said before is kept until it says again; one that can't tell
    /// now keeps it too.
    @discardableResult
    public func readAgain(_ box: String) async -> Said {
        reads[box] = nil
        return await read(box)
    }

    /// What another read of `box`'s `kuvo/info` found (one that reads more than its features),
    /// kept as if read here.
    public func take(_ said: Said, for box: String) {
        // (Newer than any read under way, which is left to end without being kept.)
        reads[box] = nil
        keep(said, for: box)
    }

    /// Forgets what `box` said (it's gone, or connects again): what asks next reads it again.
    public func forget(_ box: String) {
        reads[box] = nil
        if known[box] != nil { known[box] = nil }
    }

    private func read(_ box: String) async -> Said {
        if let reading = reads[box] { return await reading.task.value }
        lastRead += 1
        let id = lastRead
        let ask = ask
        let task = Task { @MainActor in
            do {
                let (status, body) = try await ask(box)
                return Self.said(status: status, body: body)
            } catch {
                return .cantTell
            }
        }
        reads[box] = (id, task)
        let said = await task.value
        // Kept only if nothing newer came meanwhile (read again, taken, or forgotten).
        guard reads[box]?.id == id else { return said }
        reads[box] = nil
        keep(said, for: box)
        return said
    }

    private func keep(_ said: Said, for box: String) {
        guard case .has(let features) = said else { return }
        if known[box] != features { known[box] = features }
        // (The gate letting a box go may have it forgotten here at once, and read again next.)
        onSaid(box, features)
    }
}
