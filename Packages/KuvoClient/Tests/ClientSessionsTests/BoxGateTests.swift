import ClientSessions
import Foundation
import Testing

/// The update gate (#679): which boxes a client uses as they are, and which it brings up to date
/// first. Checked against what both boxes say they answer (the route scenario
/// `Vectors/routes/features.json`, written from the box's own lists), so a name the gate needs
/// that no box answers (renamed, or never added) would hold every computer forever and fails here.
struct BoxGateTests {
    /// What a box of this version says it answers in `kuvo/info`: a Mac's and a machine's.
    private static func boxFeatures() throws -> (mac: [String], machine: [String]) {
        let file = URL(filePath: #filePath).deletingLastPathComponent()
            .appending(path: "../../../KuvoLink/Vectors/routes/features.json").standardized
        let scenario = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        let step = ((scenario?["scenarios"] as? [[String: Any]])?.first?["steps"] as? [[String: Any]])?.first
        let expect = step?["expect"] as? [String: Any]
        func listed(_ kind: String) -> [String] {
            let features = ((expect?[kind] as? [String: Any])?["json"] as? [String: Any])?["features"]
            if let list = features as? [String] { return list }
            return (features as? [String: Any])?["<includes>"] as? [String] ?? []
        }
        return (listed("mac"), listed("machine"))
    }

    @Test func aBoxOfThisVersionIsUsedAsItIs() throws {
        let (mac, machine) = try Self.boxFeatures()
        #expect(!mac.isEmpty && !machine.isEmpty)
        #expect(BoxGate.missing(mac) == [])
        #expect(BoxGate.missing(machine) == [])
    }

    // A box from before #668 lists its features but not its sessions: held for its update.
    @Test func aBoxFromBeforeSessionListsIsHeld() throws {
        let older = try Self.boxFeatures().machine.filter { $0 != "sessions.list" }
        #expect(!BoxGate.isCurrent(older))
        #expect(BoxGate.missing(older) == ["sessions.list"])
    }

    // A 0.7 bridge answers no features at all (or no `kuvo/info`): every name is missing.
    @Test func aBoxThatNamesNothingLacksEverything() {
        #expect(BoxGate.missing([String]()) == BoxGate.required)
    }

    // While it's held, only what says what it is and what updates it goes through.
    @Test func aHeldBoxIsAskedOnlyAboutItsUpdate() {
        #expect(BoxGate.isAllowed("kuvo/info"))
        #expect(BoxGate.isAllowed("kuvo/update"))
        #expect(BoxGate.isAllowed("kuvo/box/update"))
        #expect(!BoxGate.isAllowed("kuvo/sessions/list?since=1"))
        #expect(!BoxGate.isAllowed("kuvo/git/branches"))
        #expect(!BoxGate.isAllowed("kuvo/info/extra"))
    }
}
