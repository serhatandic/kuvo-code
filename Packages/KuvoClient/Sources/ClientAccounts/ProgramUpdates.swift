import Foundation
import OpenCodeKit

/// How a coding agent's program's update stands on its computer, as its box keeps it for every
/// client (`metadata.programUpdate`, KuvoLink's PROTOCOL.md, "Installing and updating an agent's
/// program"): the same on every account with that program. Both apps draw it; neither keeps one.
public struct ProgramUpdate: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case updating
        /// Updated just now, to this version.
        case updated(String)
        /// Asked to update, it was already on the newest, this version.
        case current(String)
        /// Why it couldn't be updated, in the installer's words.
        case failed(String)
    }

    public var state: State
    /// The program (`metadata.agent`: `claude`, `codex`…) and when its box last changed this: one
    /// outcome told from the next, for what a client says once.
    public var id: String

    public init(state: State, id: String) {
        self.state = state
        self.id = id
    }
}

extension Integration {
    /// Its program's update, as its box says it; nil when there's none to tell (or the box is from
    /// before it said so).
    public var programUpdate: ProgramUpdate? {
        guard let update = metadata?["programUpdate"]?.object, let at = update["at"]?.number else { return nil }
        let id = "\(metadata?["agent"]?.string ?? self.id)@\(Int(at))"
        switch update["state"]?.string {
        case "updating": return ProgramUpdate(state: .updating, id: id)
        case "updated": return update["version"]?.string.map { ProgramUpdate(state: .updated($0), id: id) }
        case "current": return update["version"]?.string.map { ProgramUpdate(state: .current($0), id: id) }
        case "failed": return ProgramUpdate(state: .failed(update["message"]?.string ?? "It didn’t update."), id: id)
        default: return nil
        }
    }

    /// Its program is updating now, as its box says.
    public var isUpdatingProgram: Bool { programUpdate?.state == .updating }

    /// Update All updates its program, as its box picks it (`metadata.updateAll`).
    public var isInUpdateAll: Bool { metadata?["updateAll"]?.bool == true }
}

extension OpenCodeAPI {
    /// Update All on a computer, as its agents bridge picks it; answered as the updates start
    /// (each account says how its program's goes). The programs it started.
    @discardableResult
    public func updateAllPrograms() async throws -> [String] {
        try await client.send(try client.request("POST", "api/kuvo/updates", body: [String: String]()), as: DataEnvelope<Updating>.self).data.updating
    }

    /// Updates `provider`'s program through the installer that owns it, answered as it starts.
    public func updateProgram(_ provider: String) async throws {
        let id = provider.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.@"))) ?? provider
        _ = try await client.send(try client.request("POST", "api/kuvo/updates/\(id)"), as: DataEnvelope<Updating>.self)
    }
}

private nonisolated struct Updating: Decodable, Sendable {
    var updating: [String]
}
