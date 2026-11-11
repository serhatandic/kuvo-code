import ClientSessions
import Foundation
import Testing

/// The line under a machine while one of its pieces runs an older version than its files, from
/// what its box says (`kuvo/info`'s `pieces`, in the shape the box answers it).
struct MachinePiecesTests {
    private func pieces(_ json: String) throws -> MachinePieces {
        try JSONDecoder().decode(MachinePieces.self, from: Data(json.utf8))
    }

    private let current = #""link":{"running":"0.9.212","current":"0.9.212","behind":false},"engine":{"running":"2.2.5","current":"2.2.5","behind":false}"#

    @Test func allOnTheirFilesVersionSaysNothing() throws {
        let said = try pieces(#"{"# + current + #","agents":{"running":"aa","current":"aa","behind":false,"renewal":null,"waits":null}}"#)
        #expect(said.line == nil)
    }

    // A Mac brought a newer bridge while its sessions work: it waits for a quiet moment.
    @Test func aNewerBridgeWaitingForAQuietMoment() throws {
        let said = try pieces(#"{"# + current + #","agents":{"running":"aa","current":"bb","behind":true,"renewal":{"since":1794400000000,"holding":false},"waits":"quiet"}}"#)
        #expect(said.line == "Its coding agents move to a new version once nothing runs there.")
    }

    // It found none in time: new messages wait for the turns under way.
    @Test func aNewerBridgeHoldingNewMessages() throws {
        let said = try pieces(#"{"# + current + #","agents":{"running":"aa","current":"bb","behind":true,"renewal":{"since":1794400000000,"holding":true},"waits":"holding"}}"#)
        #expect(said.line == "Its coding agents are moving to a new version: new messages wait until the turns under way finish.")
    }

    // The bridge running is from before bridges made way by themselves (it says no build): it takes
    // the new one only when its engine starts again.
    @Test func anOlderBridgeThatDoesntMakeWayByItself() throws {
        let said = try pieces(#"{"# + current + #","agents":{"running":null,"current":"bb","behind":true,"renewal":null,"waits":"restart"}}"#)
        #expect(said.line == "Its coding agents run an older version until its engine next starts.")
    }

    // A bundle that came with a newer engine, which a Mac kept from starting while sessions worked:
    // it waits for that engine, not a quiet moment (the box says so; before, the line said it would
    // move once nothing ran, which it wouldn't).
    @Test func aNewerBridgeWaitingForItsEngine() throws {
        let said = try pieces(#"{"# + current + #","agents":{"running":"aa","current":"bb","behind":true,"renewal":{"since":1794400000000,"holding":false},"waits":"engine"}}"#)
        #expect(said.line == "Its coding agents move to a new version with its new engine.")
    }

    @Test func theEngineAndTheLinkBehindToo() throws {
        let said = try pieces(#"{"link":{"running":"0.9.211","current":"0.9.212","behind":true},"engine":{"running":"2.2.5","current":"2.2.6","behind":true},"agents":{"running":"aa","current":"aa","behind":false,"renewal":null,"waits":null}}"#)
        #expect(said.line == "Its engine runs an older version until it next starts. Its link to your phones and computers runs an older version until it next starts.")
    }
}
