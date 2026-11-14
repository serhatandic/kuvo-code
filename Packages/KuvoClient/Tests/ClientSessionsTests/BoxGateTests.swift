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

    // While it's held, only what says what it is and what updates it goes through, and the tool
    // calls of the work running there (so it goes on as it was).
    @Test func aHeldBoxIsAskedOnlyAboutItsUpdate() {
        #expect(BoxGate.isAllowed("kuvo/agent-tools"))
        #expect(BoxGate.isAllowed("kuvo/info"))
        #expect(BoxGate.isAllowed("kuvo/update"))
        #expect(BoxGate.isAllowed("kuvo/box/update"))
        // Its Mac's app registering with it: its agents' browser and your phones' asks go there.
        #expect(BoxGate.isAllowed("kuvo/box/app"))
        #expect(!BoxGate.isAllowed("kuvo/box/app/open"))
        #expect(!BoxGate.isAllowed("kuvo/sessions/list?since=1"))
        #expect(!BoxGate.isAllowed("kuvo/git/branches"))
        #expect(!BoxGate.isAllowed("kuvo/info/extra"))
        // What keeps work under way there going: its engine, its coding agents, a session's asks.
        #expect(BoxGate.isAllowed("api/session/ses_1/permissions/per_1"))
        #expect(BoxGate.isAllowed("kuvo/agents/api/session"))
        #expect(BoxGate.isAllowed("kuvo/sandbox/asks/ask_1"))
        #expect(BoxGate.isAllowed("kuvo/asks"))
        #expect(BoxGate.isAllowed("kuvo/sessions/ses_1/decisions"))
        #expect(!BoxGate.isAllowed("kuvo/sessions"))
        #expect(!BoxGate.isAllowed("kuvo/askslater"))
    }

    // This Mac's own box, held after an update, still holds its app's keys: the vault's proof for
    // one of your machines and a bot's kept keys are asked of it, while its projects wait.
    @Test func aHeldOwnBoxStillAnswersForItsAppsKeys() {
        #expect(BoxGate.isAllowed("kuvo/box/proof"))
        #expect(BoxGate.isAllowed("kuvo/box/kept-keys?bot=bot_1"))
        #expect(!BoxGate.isAllowed("kuvo/box/proof/extra"))
        #expect(!BoxGate.isAllowed("kuvo/box/kept-keysx"))
        #expect(!BoxGate.isAllowed("kuvo/projects"))
    }

    // A phone says who brings a machine up to date: by itself overnight only where it can.
    @Test func aMachineThatCantUpdateItselfIsntSaidTo() {
        #expect(BoxGate.Words.waiting(for: "devbox", isMac: false, updatesItself: true).contains("by itself overnight"))
        #expect(!BoxGate.Words.waiting(for: "old-box", isMac: false, updatesItself: false).contains("overnight"))
    }
}
