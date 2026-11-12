import ClientAccounts
import Foundation
import OpenCodeKit
import Testing

/// How a coding agent's program's update stands, as its box says it on every account with it
/// (`metadata.programUpdate`), read the same on the Mac and the phone.
@Suite struct ProgramUpdatesTests {
    private func account(_ metadata: [String: Any]) throws -> Integration {
        let json: [String: Any] = ["id": "codex-cli@9a8b", "name": "Codex · Work", "methods": [], "connections": [], "metadata": metadata]
        return try JSONDecoder().decode(Integration.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test func eachOutcomeIsToldFromTheNextByItsProgramAndWhen() throws {
        let failed = try account(["agent": "codex", "programUpdate": ["state": "failed", "message": "npm: permission denied", "version": "0.163.0", "at": 1_700_000_000_123]])
        #expect(failed.programUpdate == ProgramUpdate(state: .failed("npm: permission denied"), at: 1_700_000_000_123, program: "codex"))
        #expect(failed.programUpdate?.id == "codex@1700000000123")
        let again = try account(["agent": "codex", "programUpdate": ["state": "failed", "message": "npm: permission denied", "at": 1_700_000_000_456]])
        #expect(again.programUpdate?.id != failed.programUpdate?.id, "a second failure is said too")

        #expect(try account(["agent": "codex", "programUpdate": ["state": "updating", "at": 5]]).isUpdatingProgram)
        #expect(try account(["agent": "codex", "programUpdate": ["state": "updated", "version": "0.164.0", "at": 6]]).programUpdate?.state == .updated("0.164.0"))
        #expect(try account(["agent": "codex", "programUpdate": ["state": "current", "version": "0.164.0", "at": 7]]).programUpdate?.state == .current("0.164.0"))
    }

    @Test func aStateItDoesntKnowOrNoneReadsAsNone() throws {
        #expect(try account(["agent": "codex"]).programUpdate == nil)
        #expect(try account(["agent": "codex", "programUpdate": ["state": "verifying", "at": 8]]).programUpdate == nil, "one a newer box adds")
        #expect(try account(["agent": "codex", "updateAll": true]).isInUpdateAll)
        #expect(try !account(["agent": "codex", "updateAll": false, "outdated": true, "updates": true]).isInUpdateAll, "the box picks what Update All updates")
        // A box from before it picked them: its own sign-in, by what it says of its version.
        #expect(try account(["agent": "codex", "accountID": "default", "outdated": true, "updates": true]).isInUpdateAll)
        #expect(try !account(["agent": "codex", "accountID": "9a8b", "outdated": true, "updates": true]).isInUpdateAll)
    }
}
