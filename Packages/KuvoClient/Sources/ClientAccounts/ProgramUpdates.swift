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
    public var isInUpdateAll: Bool {
        guard let metadata else { return false }
        if let picked = metadata["updateAll"]?.bool { return picked }
        // COMPAT(0.7 update-answer): a box from before it picked them, by what it says of its version. Goes 3 months after 0.8.0.
        return metadata["outdated"]?.bool == true && metadata["updates"]?.bool == true && (metadata["accountID"]?.string ?? "default") == "default"
    }
}

/// Why an update couldn't be asked for, or (a box from before `kuvo/updates`) didn't work.
public struct ProgramUpdateFailure: LocalizedError, Sendable {
    public var message: String
    public var errorDescription: String? { message }
}

extension OpenCodeAPI {
    /// Update All on a computer, as its agents bridge picks it; answered as the updates start
    /// (each account says how its program's goes). `accounts`: its coding agents' accounts as last
    /// read, for a box from before it picked them.
    public func updateAllPrograms(_ accounts: [Integration]) async throws {
        do {
            _ = try await client.send(try client.request("POST", "api/kuvo/updates", body: [String: String]()), as: DataEnvelope<Updating>.self)
        } catch let refused as ServerError where refused.status == 404 {
            // COMPAT(0.7 update-answer): a box from before `kuvo/updates`, each asked on its own. Goes 3 months after 0.8.0.
            let failures = await withTaskGroup(of: String?.self) { group in
                for account in accounts where account.isInUpdateAll {
                    group.addTask {
                        do { try await updateProgramAnswered(account.id); return nil } catch { return error.localizedDescription }
                    }
                }
                return await group.reduce(into: [String]()) { if let failure = $1 { $0.append(failure) } }
            }
            if !failures.isEmpty { throw ProgramUpdateFailure(message: failures.joined(separator: "\n\n")) }
        }
    }

    /// Updates `provider`'s program through the installer that owns it, answered as it starts.
    public func updateProgram(_ provider: String) async throws {
        do {
            _ = try await client.send(try client.request("POST", "api/kuvo/updates/\(Self.escaped(provider))"), as: DataEnvelope<Updating>.self)
        } catch let refused as ServerError where refused.status == 404 {
            // COMPAT(0.7 update-answer): a box from before `kuvo/updates`. Goes 3 months after 0.8.0.
            try await updateProgramAnswered(provider)
        }
    }

    /// How its update went, seen (`at`, that outcome only): its box forgets it for every client.
    public func sawProgramUpdate(_ provider: String, at: Int) async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/updates/\(Self.escaped(provider))", query: ["at": String(at)]), as: Empty.self)
    }

    /// COMPAT(0.7 update-answer): an update answered once it's done, by a box from before `kuvo/updates`; what went wrong thrown. Goes 3 months after 0.8.0.
    private func updateProgramAnswered(_ provider: String) async throws {
        nonisolated struct Answer: Decodable, Sendable { var updated: Bool; var version: String?; var message: String? }
        var request = try client.request("POST", "api/integration/\(Self.escaped(provider))/update")
        request.timeoutInterval = 15 * 60
        let answer = try await client.send(request, as: DataEnvelope<Answer>.self).data
        if !answer.updated, let message = answer.message { throw ProgramUpdateFailure(message: message) }
    }

    private static func escaped(_ provider: String) -> String {
        provider.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.@"))) ?? provider
    }
}

private nonisolated struct Updating: Decodable, Sendable {
    var updating: [String]
}
