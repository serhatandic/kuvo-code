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
    /// When its box last changed it (ms): what's said to have been seen
    /// (`OpenCodeAPI.sawProgramUpdate`), so a newer one is still said.
    public var at: Int
    /// The program (`metadata.agent`: `claude`, `codex`…) and `at`: one outcome told from the next.
    public var id: String

    public init(state: State, at: Int, program: String) {
        self.state = state
        self.at = at
        id = "\(program)@\(at)"
    }
}

extension Integration {
    /// Its program's update, as its box says it; nil when there's none to tell (or the box is from
    /// before it said so).
    public var programUpdate: ProgramUpdate? {
        guard let update = metadata?["programUpdate"]?.object, let at = update["at"]?.number else { return nil }
        let program = metadata?["agent"]?.string ?? id
        let state: ProgramUpdate.State
        switch update["state"]?.string {
        case "updating": state = .updating
        case "updated": guard let version = update["version"]?.string else { return nil }; state = .updated(version)
        case "current": guard let version = update["version"]?.string else { return nil }; state = .current(version)
        case "failed": state = .failed(update["message"]?.string ?? "It didn’t update.")
        default: return nil
        }
        return ProgramUpdate(state: state, at: Int(at), program: program)
    }

    /// Its program is updating now, as its box says.
    public var isUpdatingProgram: Bool { programUpdate?.state == .updating }

    /// Update All updates its program, as its box picks it (`metadata.updateAll`, said of the
    /// agent's own sign-in, once for its program).
    public var isInUpdateAll: Bool { metadata?["updateAll"]?.bool == true }
}

/// Why an update couldn't be asked for.
public struct ProgramUpdateFailure: LocalizedError, Sendable {
    public var message: String
    public var errorDescription: String? { message }
}

extension OpenCodeAPI {
    /// Update All on a computer, as its agents bridge picks it; answered as the updates start
    /// (each account says how its program's goes).
    public func updateAllPrograms() async throws {
        try await askingUpdate { _ = try await client.send(try client.request("POST", "api/kuvo/updates", body: [String: String]()), as: DataEnvelope<Updating>.self) }
    }

    /// Updates `provider`'s program through the installer that owns it, answered as it starts.
    public func updateProgram(_ provider: String) async throws {
        try await askingUpdate { _ = try await client.send(try client.request("POST", "api/kuvo/updates/\(Self.escaped(provider))"), as: DataEnvelope<Updating>.self) }
    }

    /// What the computer's coding agents say while they still run a build from before
    /// `kuvo/updates` (404): they move to its own once nothing runs there ("A new version while it
    /// works"), and no program is asked the old way meanwhile (#679).
    public static let agentsNotMovedYet = "Its coding agents haven’t moved to this version of Kuvo Code yet. They do once nothing runs there; try again then."

    private func askingUpdate(_ ask: () async throws -> Void) async throws {
        do {
            try await ask()
        } catch let refused as ServerError where refused.status == 404 {
            throw ProgramUpdateFailure(message: Self.agentsNotMovedYet)
        }
    }

    /// How its update went, seen (`at`, that outcome only): its box forgets it for every client.
    public func sawProgramUpdate(_ provider: String, at: Int) async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/updates/\(Self.escaped(provider))", query: ["at": String(at)]), as: Empty.self)
    }

    private static func escaped(_ provider: String) -> String {
        provider.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.@"))) ?? provider
    }
}

private nonisolated struct Updating: Decodable, Sendable {
    var updating: [String]
}
