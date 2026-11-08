import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Deleting what's in view while the sidebar shows a machine's page (#318): its bot, a session
/// there, its last chat. The next tab on that machine comes into view, or none once nothing's open
/// there; the sidebar stays on that machine's page, never sliding to another computer's for it,
/// though tabs of this Mac's sit beside. The machine is connected as the app connects one; both
/// engines and the machine's box are stand-ins, and SSH answers nothing.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct DeletingOnAMachineTests {
    let app = AppModel()
    let mac = StubEngine(port: 47911)
    let mini = StubEngine(port: 47912, alongside: true)
    let machine = "mini-\(UUID().uuidString.prefix(8).lowercased()).invalid"
    var tabs: WindowTabs { app.tabs }

    init() {
        app.standIn(engine: mac.api)
        app.workspace.api = mac.api
        SSHConnection.standIn = { _, _ in nil }
        let api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: mini.url)!, password: "test"), folderPrefix: RemoteFolder.prefix(for: machine))
        MachineEngine.standIn = { [machine] in $0.id == machine ? api : nil }
        mini.on("GET", "/api/mcp", json: ["location": ["directory": "/"], "data": []])
        mini.on("GET", "/api/credential", json: ["data": []])
    }

    private func done() {
        for machine in app.machines.list { app.removeMachine(machine.id) }
        SSHConnection.standIn = nil
        MachineEngine.standIn = nil
        UserDefaults.standard.removeObject(forKey: SidebarBox.inViewKey)
        try? FileManager.default.removeItem(at: Bots.file)
        mac.stop()
    }

    @Test func deletingWhatsInViewOnAMachineKeepsTheSidebarThere() async throws {
        defer { done() }
        let kept = "/home/me/\(RemoteEngineInstaller.root)"
        mac.list(["ses_mac_a", "ses_mac_b"].map { StubEngine.session($0, title: $0, directory: "/tmp/kuvo-tests-deleting-on-a-machine") })
        mini.list([
            StubEngine.session("ses_mini_chat", title: "Trip plans", directory: kept + "/chats"),
            StubEngine.session("ses_mini_a", title: "Fix the build", directory: "/srv/app"),
            StubEngine.session("ses_mini_b", title: "Release notes", directory: "/srv/app"),
            StubEngine.session("ses_tempbot", title: "Temp", directory: kept + "/bots/bot_temp000001"),
        ])
        for id in ["ses_mini_chat", "ses_mini_a", "ses_mini_b", "ses_tempbot"] { mini.on("DELETE", "/api/session/\(id)", json: [:]) }
        // Its bot, as its box lists it, until it's deleted there.
        let deleted = Guarded(false)
        let temp = #"{"id":"bot_temp000001","session":"ses_tempbot","name":"Temp","look":{"color":"sky","shape":"round","face":"calm"},"folder":"\#(kept)/bots/bot_temp000001"}"#
        app.bots.boxes = { [machine] box in
            BoxClient(box: box, transport: LocalBox { request in
                AsyncThrowingStream { reply in
                    if request.method == "DELETE" { deleted.withLock { $0 = true } }
                    let listed = box == machine && !deleted.withLock { $0 } ? temp : ""
                    reply.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                    reply.yield(.body(Data((request.method == "DELETE" ? "{}" : #"{"bots":[\#(listed)]}"#).utf8)))
                    reply.finish()
                }
            })
        }
        await app.workspace.refresh()
        let engine = app.machines.add(machine)
        app.workspace.machines = Set(app.machines.list.map(\.id))
        await app.connect(engine).value
        await app.bots.refresh(machine)
        let bot = try #require(app.bots.bot("bot_temp000001"))
        #expect(bot.machine == machine)
        #expect(app.workspace.session("ses_mini_a") != nil && app.workspace.session("ses_mac_a") != nil)

        // This Mac's tabs between the machine's, the bot's in view, and the sidebar on the machine.
        for id in ["ses_mini_b", "ses_mini_chat", "ses_mac_a", "ses_mini_a", "ses_tempbot", "ses_mac_b"] { tabs.open(.session(id)) }
        tabs.open(.session("ses_tempbot"))
        UserDefaults.standard.set(machine, forKey: SidebarBox.inViewKey)
        #expect(sidebarShows == .machine(machine))

        // Delete Bot… (Edit Bot's).
        try await app.bots.delete(bot)
        // (As the window does when the list changes.)
        tabs.dropClosed()
        #expect(keys == ["ses_mini_b", "ses_mini_chat", "ses_mac_a", "ses_mini_a", "ses_mac_b"], "\(keys)")
        #expect(tabs.selection == .session("ses_mini_a"), "the machine's tab nearest it, past this Mac's: \(String(describing: tabs.selection))")
        #expect(sidebarShows == .machine(machine))

        // A session there (the sidebar's Delete), then its last two (from your phone, say): gone
        // in one go.
        try await app.workspace.delete("ses_mini_a")
        tabs.dropClosed()
        #expect(tabs.selection == .session("ses_mini_chat"), "\(String(describing: tabs.selection))")
        #expect(sidebarShows == .machine(machine))

        try await app.workspace.delete("ses_mini_chat")
        try await app.workspace.delete("ses_mini_b")
        tabs.dropClosed()
        #expect(keys == ["ses_mac_a", "ses_mac_b"], "this Mac's tabs stay open: \(keys)")
        #expect(tabs.selection == nil, "nothing's left open on the machine: \(String(describing: tabs.selection))")

        // With none in view, ⌘W closes nothing (the window stays, and its terminals with it), and
        // ⌃Tab starts from the first tab.
        #expect(tabs.closeInView(), "the window isn't closed")
        #expect(keys == ["ses_mac_a", "ses_mac_b"])
        tabs.cycle(by: 1)
        #expect(tabs.selection == .session("ses_mac_a"))
    }

    private var keys: [String] { tabs.keys.map(\.text) }

    /// The page the sidebar shows once the tab in view has come into view: the tab's computer's,
    /// which it slides to (`SidebarView`), or the one it showed for a tab on none.
    private var sidebarShows: SidebarBox {
        if let shown = tabs.selection.flatMap(tabs.box(of:)), app.boxes.contains(shown) { return shown }
        return app.boxInView
    }
}
