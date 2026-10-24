import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What goes to your phones' notifications from this Mac: news of its own browser and group
/// chats, never a machine's, which the machine tells your phones itself, Mac connected or not. So
/// a phone hears each once. The machine's name can't be reached.
@MainActor
@Suite(.serialized) struct PhoneNoticesTests {
    let machine = "box.invalid"

    init() {
        TestEnvironment.prepare()
    }

    /// The notices this Mac sends your phones while `body` runs.
    private func toPhones(_ body: () throws -> Void) rethrows -> [Notice] {
        var sent: [Notice] = []
        Notifier.shared.toPhones = { sent.append($0) }
        defer { Notifier.shared.toPhones = nil }
        try body()
        return sent
    }

    @Test func aMachinesBrowserAskGoesToPhonesFromTheMachineAlone() {
        let asks = BrowserAsks()
        let sent = toPhones {
            asks.add(BrowserAsks.Ask(id: "ask_box", kind: .code(prompt: "The code GitHub sent"), host: "github.com", machine: machine, session: nil)) { _ in }
            asks.add(BrowserAsks.Ask(id: "ask_mac", kind: .code(prompt: "The code GitHub sent"), host: "github.com", machine: nil, session: nil)) { _ in }
        }
        #expect(sent.map(\.data["ask"]) == ["ask_mac"])
    }

    @Test func aMachinesGroupChatsNewsGoesToPhonesFromTheMachineAlone() throws {
        let groups = BoxGroups()
        let met = try ServerEvent(json: JSONSerialization.data(withJSONObject: [
            "id": "evt_met", "type": "kuvo.group.met", "created": 1_792_000_000_000,
            "data": ["id": "grp_box", "name": "Standup"],
        ]))
        let sent = toPhones { groups.handle(met, machine: machine) }
        #expect(sent.isEmpty)
    }
}
