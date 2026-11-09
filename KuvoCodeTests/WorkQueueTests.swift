import ClientSessions
import ClientText
import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// The Work Queue in the panel (PROTOCOL.md, "The Work Queue"): a conversation's items as its box
/// keeps them, changing as agents change them; what you do to them (reorder, move to another
/// category, delete and Undo); a lead seeing what it handed on, with whose each is; and `#243` in
/// a message drawn as the item's chip, opening it in the panel. The box is the real one
/// (`kuvo-link.js serve`), reached over HTTP as the Mac's app.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(2))) struct WorkQueueTests {
    let app = AppModel()

    init() {
        TestEnvironment.prepare()
        app.workQueues.app = app
    }

    /// The box, as this Mac's app reaches it (as you, not an agent).
    private func use(_ machine: MachineTestBox) {
        let endpoint = machine.endpoint
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url : URL(string: endpoint.url.absoluteString + "/")!
        let client = BoxClient(box: BoxClient.mac, transport: LocalBox { EngineRoutes.forward($0, to: base, password: endpoint.password, adding: ["x-kuvo-from": "app"], allowing: { path, _ in path.hasPrefix("kuvo/") }) })
        app.workQueues.boxes = { _ in client }
    }

    private static func item(_ number: Int, _ title: String, category: String = "next", order: Double, note: String? = nil, handedBy: String? = nil) -> [String: Any] {
        var item: [String: Any] = [
            "id": "wqi_" + String(repeating: "a", count: 17) + String(format: "%03d", number),
            "number": number, "title": title, "body": "About \(title).", "category": category, "order": order,
            "notes": [], "files": [], "links": [], "sessions": [],
            "created": ["at": 1_000, "by": ["user": true]],
            "updated": ["at": Date.now.timeIntervalSince1970 * 1000 - 8 * 60_000, "by": ["session": "ses_lead", "name": "Lead"]],
        ]
        if let note { item["progress"] = ["note": note] }
        if let handedBy { item["handedBy"] = handedBy }
        return item
    }

    /// An owner's queue as its agents' tools leave it (`run/work-queue/queues/<owner>.json`).
    private func keep(_ items: [[String: Any]], for owner: String, on machine: MachineTestBox) throws {
        let queues = machine.folder.appending(path: "run/work-queue/queues")
        try FileManager.default.createDirectory(at: queues, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["owner": owner, "items": items]).write(to: queues.appending(path: "\(owner).json"), options: .atomic)
    }

    private func titles(_ key: WorkQueues.Key, in category: String) -> [String] {
        (app.workQueues.views[key]?.items ?? []).filter { $0.category == category }.map(\.title)
    }

    @Test func theListShowsTheConversationsItemsAndChangesAsAgentsChangeThem() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        use(machine)
        try keep([Self.item(1, "Build the sign-in", order: 1, note: "Wiring the endpoint"), Self.item(2, "Write the docs", order: 2), Self.item(3, "Dark mode", category: "later", order: 1)], for: "ses_lead", on: machine)
        let key = WorkQueues.Key(box: BoxClient.mac, owner: "ses_lead")
        let following = Task { await app.workQueues.follow(key) }
        defer { following.cancel() }
        try await until { app.workQueues.views[key] != nil }
        let view = try #require(app.workQueues.views[key])
        #expect(WorkQueue.sections(view).map(\.name) == ["In progress", "Next", "Later", "Parked", "Done"])
        #expect(titles(key, in: "next") == ["Build the sign-in", "Write the docs"])
        #expect(WorkQueue.openCount(view) == 3, "the tab says 3 items")

        // An agent adds one (its tool writes the file): it shows without asking again.
        try keep([Self.item(1, "Build the sign-in", order: 1), Self.item(2, "Write the docs", order: 2), Self.item(3, "Dark mode", category: "later", order: 1), Self.item(4, "Ship it", order: 3)], for: "ses_lead", on: machine)
        try await until { titles(key, in: "next") == ["Build the sign-in", "Write the docs", "Ship it"] }
    }

    @Test func youReorderMoveAndDeleteItemsAndUndoBringsOneBack() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        use(machine)
        try keep([Self.item(1, "First", order: 1), Self.item(2, "Second", order: 2), Self.item(3, "Third", order: 3)], for: "ses_lead", on: machine)
        let key = WorkQueues.Key(box: BoxClient.mac, owner: "ses_lead")
        let following = Task { await app.workQueues.follow(key) }
        defer { following.cancel() }
        try await until { titles(key, in: "next").count == 3 }
        let store = app.workQueues
        let items = try #require(store.views[key]?.items)

        // Third dragged above First.
        await store.move(items[2], to: .before(items[0]), on: BoxClient.mac)
        try await until { titles(key, in: "next") == ["Third", "First", "Second"] }

        // Second moved to Later.
        await store.move(items[1], to: .category("later"), on: BoxClient.mac)
        try await until { titles(key, in: "later") == ["Second"] && titles(key, in: "next") == ["Third", "First"] }

        // First deleted: gone from the list, in Recently Deleted, with Undo offered.
        await store.delete(items[0], on: BoxClient.mac)
        #expect(store.undoable?.item.title == "First")
        try await until { titles(key, in: "next") == ["Third"] && store.views[key]?.removed.map(\.title) == ["First"] }

        // Undo: back where it was.
        await store.undo()
        #expect(store.undoable == nil)
        try await until { titles(key, in: "next") == ["Third", "First"] && store.views[key]?.removed.isEmpty == true }
        #expect(store.refusal == nil)
    }

    @Test func aLeadSeesWhatItHandedOnWithWhoseItIsAndAllShowsEveryQueue() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        use(machine)
        try keep([Self.item(1, "Lead's own", order: 1)], for: "ses_lead", on: machine)
        try keep([Self.item(2, "Handed to the child", order: 2, handedBy: "ses_lead")], for: "ses_child", on: machine)
        try keep([Self.item(3, "Someone else's", order: 3)], for: "ses_other", on: machine)
        let lead = WorkQueues.Key(box: BoxClient.mac, owner: "ses_lead")
        let all = WorkQueues.Key(box: BoxClient.mac, owner: WorkQueueView.all)
        let following = [Task { await app.workQueues.follow(lead) }, Task { await app.workQueues.follow(all) }]
        defer { following.forEach { $0.cancel() } }
        try await until { app.workQueues.views[lead] != nil && app.workQueues.views[all] != nil }

        let view = try #require(app.workQueues.views[lead])
        #expect(view.items.map(\.title) == ["Lead's own", "Handed to the child"])
        let handed = try #require(view.items.last)
        #expect(handed.owner == "ses_child")
        #expect(WorkQueue.ownerName(of: handed, in: view) != nil, "it says whose it is now")
        #expect(WorkQueue.ownerName(of: view.items[0], in: view) == nil, "the lead's own says nothing")

        #expect(app.workQueues.views[all]?.items.map(\.title) == ["Lead's own", "Handed to the child", "Someone else's"])
    }

    @Test func aReferenceInAMessageIsDrawnAsItsChipOnceTheBoxKnowsItAndOpensTheItem() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        use(machine)
        try keep([Self.item(243, "Work Queue panel", order: 1)], for: "ses_lead", on: machine)
        let store = app.workQueues
        let message = "Picked up #243, not `#243` and not #9."
        // Not known yet: plain text, and the box is asked.
        #expect(store.refs(in: message, box: BoxClient.mac).isEmpty)
        try await until { store.refs[BoxClient.mac]?[243] != nil }
        let refs = store.refs(in: message, box: BoxClient.mac)
        #expect(refs.keys.sorted() == [243], "#9 isn't an item: it stays as written")

        let parsed = try FileLinkingParser(folders: { [] }, refs: refs).attributedString(for: message)
        let chips = parsed.runs.compactMap { $0.textual.attachment?.base as? WorkItemChipAttachment }
        #expect(chips.map(\.number) == [243], "one chip: the code span stays code")
        #expect(chips.first?.title == "Work Queue panel")
        #expect(parsed.runs.compactMap(\.link).compactMap(WorkItemRefs.number(in:)) == [243])
        #expect(String(parsed.characters).contains("#9"))

        // Your own message: the same chip, its words kept as written.
        var yours = AttributedString("See #243")
        WorkItemChipAttachment.mark(&yours, refs: refs)
        #expect(yours.runs.contains { $0[WorkItemChipMark.self]?.number == 243 && $0.link == WorkItemRefs.link(243) })
        #expect(String(yours.characters) == "See #243")

        // Clicked: the panel shows the Work Queue with the item open.
        app.openWorkItem(243)
        #expect(app.utilities.selected?.kind == .workQueue)
        #expect(store.opened[app.utilities.panelKey]?.number == 243)
        #expect(await store.load(box: BoxClient.mac, item: "243")?.body == "About Work Queue panel.")
    }
}
