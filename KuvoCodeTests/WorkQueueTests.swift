import ClientDesign
import ClientSessions
import ClientText
import Foundation
import KuvoLink
import OpenCodeKit
import Observation
import Testing
import Textual
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

    @Test func chipVisibilityAndTypingStayInTheirConversation() throws {
        let store = app.workQueues
        let first = try Self.listed(1, "First", order: 0, in: "ses_ours")
        let second = try Self.listed(2, "Second", order: 1, in: "ses_ours")
        store.standIn(WorkQueueView(owner: "ses_ours", items: [first, second]), for: .init(box: BoxClient.mac, owner: "ses_ours"))
        store.standIn(WorkQueueView(owner: "ses_other"), for: .init(box: BoxClient.mac, owner: "ses_other"))
        #expect(store.refs(in: "see #1", box: BoxClient.mac, owner: "ses_ours")["1"] != nil)
        #expect(store.refs(in: "#1 gh:o/r#1", box: BoxClient.mac).isEmpty)
        #expect(store.refs(in: "#1 gh:o/r#1", box: BoxClient.mac, owner: "").isEmpty)
        #expect(store.refs(in: "see #1", box: BoxClient.mac, owner: "ses_other").isEmpty)
        #expect(store.refs(in: "#1 #2", box: BoxClient.mac, owner: "ses_ours", typing: true).keys.sorted() == ["1"])
        #expect(store.refs(in: "the #1 Google result", box: BoxClient.mac, owner: "ses_ours").isEmpty)
    }

    @Test func aDraftCanChipQualifiedRefsWithoutAQueue() throws {
        let store = app.workQueues
        var item = try Self.listed(243, "Issue", order: 0, in: "ses_ours")
        item.source = WorkSource(kind: "github", ref: "gh:owner/repo#12")
        store.standIn(WorkQueueView(owner: "ses_ours", items: [item]), for: .init(box: BoxClient.mac, owner: "ses_ours"))
        #expect(store.refs(in: "#243 gh:owner/repo#12", box: BoxClient.mac).keys.sorted() == ["gh:owner/repo#12"])
        #expect(store.refs(in: "#243 gh:owner/repo#12", box: BoxClient.mac, owner: "").keys.sorted() == ["gh:owner/repo#12"])
    }

    @Test func unrelatedQueueUpdatesDoNotInvalidateNumericChips() throws {
        let store = app.workQueues
        let item = try Self.listed(243, "Ours", order: 0, in: "ses_ours")
        let key = WorkQueues.Key(box: "lab", owner: "ses_ours")
        store.standIn(WorkQueueView(owner: key.owner, items: [item]), for: key)
        @MainActor final class Changes { var called = false }
        let changes = Changes()
        withObservationTracking {
            #expect(store.refs(in: "to #243", box: key.box, owner: key.owner)["243"] != nil)
        } onChange: { MainActor.assumeIsolated { changes.called = true } }
        store.standIn(WorkQueueView(owner: "ses_other"), for: .init(box: key.box, owner: "ses_other"))
        #expect(!changes.called)
        store.standIn(WorkQueueView(owner: key.owner), for: key)
        #expect(changes.called)
        app.openWorkItem("243", box: key.box)
        #expect(store.opened[app.utilities.panelKey]?.box == "lab")
    }

    /// The box, as this Mac's app reaches it (as you, not an agent).
    private func use(_ machine: MachineTestBox) {
        let client = Self.appClient(machine, box: BoxClient.mac)
        app.workQueues.boxes = { _ in client }
    }

    private static func appClient(_ machine: MachineTestBox, box: String) -> BoxClient {
        let endpoint = machine.endpoint
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url : URL(string: endpoint.url.absoluteString + "/")!
        return BoxClient(box: box, transport: LocalBox { EngineRoutes.forward($0, to: base, password: endpoint.password, adding: ["x-kuvo-from": "app"], allowing: { path, _ in path.hasPrefix("kuvo/") }) })
    }

    /// A key or an address as boxes write them: base64url of `count` random bytes.
    private static func randomKey(_ count: Int) -> String {
        Data((0..<count).map { _ in UInt8.random(in: 0...255) }).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
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

    /// An item as its box lists it in `owner`'s queue: whose it is, and how many notes, files and
    /// links it has.
    private static func listed(_ number: Int, _ title: String, order: Double, in owner: String) throws -> WorkItem {
        let listed = item(number, title, order: order).merging(["owner": owner, "inProgress": false, "noteCount": 0, "fileCount": 0, "linkCount": 0]) { $1 }
        return try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: listed))
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

    /// #563: what you do to an item from the Mac, and an item from before, as its page's feed reads
    /// them from the box: your moves and Done, who and when, with its notes, oldest first.
    @Test func whatYouDoToAnItemShowsInItsFeedFromTheBox() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        use(machine)
        var first = Self.item(1, "First", order: 1)
        first["notes"] = [["at": 2_000, "by": ["session": "ses_lead", "name": "Lead"], "text": "From before the box kept events."]]
        try keep([first, Self.item(2, "Second", order: 2)], for: "ses_lead", on: machine)
        let key = WorkQueues.Key(box: BoxClient.mac, owner: "ses_lead")
        let following = Task { await app.workQueues.follow(key) }
        defer { following.cancel() }
        try await until { titles(key, in: "next").count == 2 }
        let store = app.workQueues
        let items = try #require(store.views[key]?.items)
        let view = try #require(store.views[key])

        // From before: its notes, no events.
        let before = try #require(await store.load(box: BoxClient.mac, item: items[0].id))
        #expect(before.events.isEmpty)
        #expect(WorkQueue.activity(of: before, in: view).map { "\($0.whoWords) \($0.what)" } == ["You added the item", "Lead left a note"])

        await store.move(items[1], to: .before(items[0]), on: BoxClient.mac)
        await store.move(items[0], to: .category("later"), on: BoxClient.mac)
        await store.move(items[0], to: .category("done"), on: BoxClient.mac)
        #expect(store.refusal == nil)
        let moved = try #require(await store.load(box: BoxClient.mac, item: items[0].id))
        #expect(moved.events.map(\.kind) == ["moved", "done"])
        #expect(moved.events.allSatisfy { $0.by == .user })
        #expect(WorkQueue.activity(of: moved, in: view).map { "\($0.whoWords) \($0.what)" } == ["You added the item", "Lead left a note", "You moved it to Later", "You marked it done"])
        let second = try #require(await store.load(box: BoxClient.mac, item: items[1].id))
        #expect(WorkQueue.activity(of: second, in: view).map { "\($0.whoWords) \($0.what)" } == ["You added the item", "You moved it to the top of Next"])
    }

    @Test func onAMachineYouActOnlyWithThisMacsProofForThatRequest() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        try keep([Self.item(1, "First", order: 1)], for: "ses_lead", on: machine)
        let store = app.workQueues
        store.boxes = { _ in machine.client }
        let key = WorkQueues.Key(box: "lab", owner: "ses_lead")
        await store.read(key)
        let item = try #require(store.views[key]?.items.first)

        // No proof to give (this Mac can't sign now): nothing is sent, and it says so.
        store.proof = { _, _, _, _ in nil }
        await store.move(item, to: .category("later"), on: "lab")
        #expect(store.refusal?.text.contains("can’t prove it’s yours") == true)

        // A proof the machine can't check (not from the Mac that set it up): refused there, in words.
        // (This test's box is reached over HTTP, not `box route`: it says only Kuvo Code can.)
        var signed: [String] = []
        store.proof = { _, method, path, _ in signed.append("\(method) \(path)"); return "bm90LWEtcHJvb2Y" }
        await store.move(item, to: .category("later"), on: "lab")
        #expect(signed == ["POST kuvo/work-queue/items/\(item.id)/move"])
        #expect(store.refusal?.text.isEmpty == false)
        await store.read(key)
        #expect(store.views[key]?.items.first?.category == "next", "nothing moved")
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

    /// #552: a session the lead put on its item, opened from the lead's queue, lists that item in its
    /// own panel, first, under Working on; the lead's own view is as it was.
    @Test func aSessionsPanelListsTheLeadsItemItWorksOnFirst() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        use(machine)
        var leads = Self.item(551, "All includes Done", order: 1)
        leads["sessions"] = [["session": "ses_worker", "since": 1]]
        try keep([leads, Self.item(552, "Not linked", order: 2)], for: "ses_lead", on: machine)
        try keep([Self.item(7, "Its own", order: 1)], for: "ses_worker", on: machine)
        let worker = WorkQueues.Key(box: BoxClient.mac, owner: "ses_worker"), lead = WorkQueues.Key(box: BoxClient.mac, owner: "ses_lead")
        await app.workQueues.read(worker)
        await app.workQueues.read(lead)

        let view = try #require(app.workQueues.views[worker])
        let sections = WorkQueue.sections(view)
        #expect(Array(sections.map(\.name).prefix(3)) == ["Working on", "In progress", "Next"])
        #expect(sections.first?.items.map(\.title) == ["All includes Done"])
        #expect(sections.first { $0.category == "next" }?.items.map(\.title) == ["Its own"], "the lead's item shows once")
        #expect(WorkQueue.openCount(view) == 2, "the tab counts it: “Work Queue · 2 items”")
        let leadsView = try #require(app.workQueues.views[lead])
        #expect(!WorkQueue.sections(leadsView).contains { $0.id == WorkQueue.workingOnID })
        #expect(leadsView.items.map(\.title) == ["All includes Done", "Not linked"])
    }

    @Test func aReferenceInAMessageIsDrawnAsItsChipOnceTheBoxKnowsItAndOpensTheItem() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        use(machine)
        try keep([Self.item(243, "Work Queue panel", order: 1)], for: "ses_lead", on: machine)
        let store = app.workQueues
        let message = "Picked up #243, not `#243` and not #9."
        // Not known yet: plain text, and the box is asked.
        #expect(store.refs(in: message, box: BoxClient.mac, owner: "ses_lead").isEmpty)
        await store.read(.init(box: BoxClient.mac, owner: "ses_lead"))
        let refs = store.refs(in: message, box: BoxClient.mac, owner: "ses_lead")
        #expect(refs.keys.sorted() == ["243"], "#9 isn't an item: it stays as written")

        let parsed = try FileLinkingParser(folders: { [] }, refs: refs).attributedString(for: message)
        let chips = parsed.runs.compactMap { $0.textual.attachment?.base as? WorkItemChipAttachment }
        #expect(chips.map(\.name) == ["#243"], "one chip: the code span stays code")
        #expect(chips.first?.title == "Work Queue panel")
        #expect(parsed.runs.compactMap(\.link).compactMap(WorkItemRefs.number(in:)) == [243])
        #expect(String(parsed.characters).contains("#9"))

        // Your own message: the same chip, its words kept as written.
        var yours = AttributedString("See #243")
        WorkItemChipAttachment.mark(&yours, refs: refs)
        #expect(yours.runs.contains { $0[WorkItemChipMark.self]?.written == "#243" && $0.link == WorkItemRefs.link(243) })
        #expect(String(yours.characters) == "See #243")

        // The agent marks it done: the chip, drawn again a while later, says so.
        store.refreshAfter = 0
        var done = Self.item(243, "Work Queue panel", category: "done", order: 1)
        done["doneAt"] = Date.now.timeIntervalSince1970 * 1000
        try keep([done], for: "ses_lead", on: machine)
        await store.read(.init(box: BoxClient.mac, owner: "ses_lead"))
        #expect(store.refs(in: message, box: BoxClient.mac, owner: "ses_lead")["243"]?.category == "done")

        // Clicked: the panel shows the Work Queue with the item open.
        app.openWorkItem("243")
        #expect(app.utilities.selected?.kind == .workQueue)
        #expect(store.opened[app.utilities.panelKey]?.number == 243)
        #expect(await store.load(box: BoxClient.mac, item: "243")?.body == "About Work Queue panel.")
    }

    @Test func anIssueInTheQueueIsNamedByItShowsGitHubsWordAndItsChipOpensIt() async throws {
        // GitHub's `gh`, standing in: it says each time it's asked, and answers nothing.
        let bin = AppInfo.testRoot.appending(path: "gh-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bin) }
        let asked = bin.appending(path: "asked")
        try "#!/bin/sh\necho asked >> '\(asked.path)'\nexit 1\n".write(to: bin.appending(path: "gh"), atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bin.appending(path: "gh").path)
        let machine = try await MachineTestBox(name: "lab", environment: ["PATH": "\(bin.path):/usr/bin:/bin"])
        defer { machine.stop() }
        use(machine)
        // An item that's GitHub's kuvo-test/app#12 (it was #250), kept in Later; GitHub said it's
        // closed, a moment ago (and GitHub isn't asked again here: its host is held off).
        var issue = Self.item(250, "Upload retries", category: "later", order: 1)
        issue["source"] = ["kind": "github", "ref": "gh:kuvo-test/app#12", "url": "https://github.com/kuvo-test/app/issues/12", "host": "github.com", "id": "I_kw12"]
        try keep([issue], for: "ses_lead", on: machine)
        let now = Date.now.timeIntervalSince1970 * 1000
        let read: [String: Any] = ["at": now, "value": ["kind": "github", "id": "I_kw12", "number": 12, "title": "Upload retries drop the file name", "url": "https://github.com/kuvo-test/app/issues/12", "state": "completed"]]
        try JSONSerialization.data(withJSONObject: ["reads": ["github.com/kuvo-test/app#12": read], "hosts": ["github.com": now + 3_600_000]])
            .write(to: machine.folder.appending(path: "run/work-queue/seen.json"))
        let key = WorkQueues.Key(box: BoxClient.mac, owner: "ses_lead")
        let store = app.workQueues
        await store.read(key)
        let item = try #require(store.views[key]?.items.first)
        #expect([item.name, item.title, item.category, item.keptIn] == ["app#12", "Upload retries drop the file name", "done", "later"])
        #expect(item.brand == "github" && item.spokenName == "GitHub issue app#12")
        let categories = try #require(store.views[key]).categories
        #expect(WorkQueue.moveTargets(for: item, in: categories).isEmpty, "Done until it's reopened on GitHub")

        // Named in a message by its ref, or by its old number: GitHub's chip either way.
        let message = "Fixed gh:kuvo-test/app#12 (was #250)."
        await store.read(.init(box: BoxClient.mac, owner: "ses_lead"))
        _ = store.refs(in: message, box: BoxClient.mac, owner: "ses_lead")
        try await until { store.refs(in: message, box: BoxClient.mac, owner: "ses_lead").count == 2 }
        let parsed = try FileLinkingParser(folders: { [] }, refs: store.refs(in: message, box: BoxClient.mac, owner: "ses_lead")).attributedString(for: message)
        let chips = parsed.runs.compactMap { $0.textual.attachment?.base as? WorkItemChipAttachment }
        #expect(chips.map(\.name) == ["app#12", "app#12"])
        #expect(chips.map(\.written) == ["gh:kuvo-test/app#12", "#250"])
        #expect(chips.allSatisfy { $0.brand == "github" && $0.mark == .done })
        #expect(parsed.runs.compactMap(\.link).compactMap(WorkItemRefs.ref(in:)) == ["gh:kuvo-test/app#12", "250"])

        // Clicked: open in the panel, read by its ref.
        app.openWorkItem("gh:kuvo-test/app#12")
        let opened = try #require(store.opened[app.utilities.panelKey])
        #expect(opened.matches(item))
        #expect(await store.load(box: BoxClient.mac, item: opened.name)?.item.id == item.id)
        #expect(!FileManager.default.fileExists(atPath: asked.path), "GitHub isn't asked while its host is held off")
    }

    /// A conversation's chips follow its queue as a glance: its box reads nothing from GitHub for
    /// them however long it's open; the Work Queue tab showing it reads GitHub for what you see
    /// (#541).
    @Test func chipsFollowTheQueueWithoutReadingGitHubAndTheTabReadsIt() async throws {
        // GitHub's `gh`, standing in: it says each time it's asked, and answers the issue retitled.
        let bin = AppInfo.testRoot.appending(path: "gh-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bin) }
        let asked = bin.appending(path: "asked")
        let retitled = #"{"data":{"p0":{"issueOrPullRequest":{"__typename":"Issue","id":"I_kw12","number":12,"title":"Retitled on GitHub","url":"https://github.com/kuvo-test/app/issues/12","state":"OPEN","stateReason":null,"closedAt":null,"body":""}}}}"#
        try "#!/bin/sh\necho asked >> '\(asked.path)'\ncat <<'EOF'\n\(retitled)\nEOF\n".write(to: bin.appending(path: "gh"), atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bin.appending(path: "gh").path)
        let machine = try await MachineTestBox(name: "lab", environment: ["PATH": "\(bin.path):/usr/bin:/bin"])
        defer { machine.stop() }
        use(machine)
        var issue = Self.item(250, "Upload retries", order: 1)
        issue["source"] = ["kind": "github", "ref": "gh:kuvo-test/app#12", "url": "https://github.com/kuvo-test/app/issues/12", "host": "github.com", "id": "I_kw12"]
        try keep([issue], for: "ses_lead", on: machine)
        // Read an hour ago: due to be read again.
        let then = Date.now.timeIntervalSince1970 * 1000 - 3_600_000
        let read: [String: Any] = ["at": then, "value": ["kind": "github", "id": "I_kw12", "number": 12, "title": "Upload retries drop the file name", "url": "https://github.com/kuvo-test/app/issues/12", "state": "open"]]
        try JSONSerialization.data(withJSONObject: ["reads": ["github.com/kuvo-test/app#12": read], "hosts": [:] as [String: Any]])
            .write(to: machine.folder.appending(path: "run/work-queue/seen.json"))
        let key = WorkQueues.Key(box: BoxClient.mac, owner: "ses_lead")

        let chips = Task { await app.workQueues.follow(key, glance: true) }
        defer { chips.cancel() }
        try await until { app.workQueues.views[key]?.items.first?.title == "Upload retries drop the file name" }
        #expect(!FileManager.default.fileExists(atPath: asked.path), "chips alone read nothing from GitHub")

        let tab = Task { await app.workQueues.follow(key) }
        defer { tab.cancel() }
        // GitHub read for what the tab shows: its word comes as a line of its own.
        try await until { app.workQueues.views[key]?.items.first?.title == "Retitled on GitHub" }
        #expect(FileManager.default.fileExists(atPath: asked.path))
    }

    /// #341: what you do to an item on another computer goes to the box the panel shows, which
    /// works out where it's kept and does it there; this Mac never sends it anywhere else itself, and
    /// shows what that box said.
    @Test func anItemOnAnotherComputerSaysWhereItIsAndWhatYouDoToItGoesToThePanelsBoxWhichSaysHowItWent() async throws {
        let studio = try await MachineTestBox(name: "studio")
        defer { studio.stop() }
        let lab = try await MachineTestBox(name: "lab")
        defer { lab.stop() }
        try keep([Self.item(500, "On the lab", order: 1)], for: "ses_far", on: lab)
        // The studio's box knows lab as one of your computers (its Mac's word), and lab told it of
        // its queue.
        // (lab as another Mac names it, by an id of its own: this Mac finds it by its key.) And a
        // Mac this one isn't.
        let mac = Self.randomKey(32), labKey = Self.randomKey(32), otherMac = Self.randomKey(32)
        let run = studio.folder.appending(path: "run")
        try FileManager.default.createDirectory(at: run.appending(path: "work-queue/peers"), withIntermediateDirectories: true)
        let peers: [[String: Any]] = [["key": mac, "address": Self.randomKey(16), "kind": "mac", "name": "Studio Mac"], ["key": labKey, "address": Self.randomKey(16), "kind": "machine", "name": "lab", "id": "lab-elsewhere"],
                                      ["key": otherMac, "address": Self.randomKey(16), "kind": "mac", "name": "Laptop"]]
        try JSONSerialization.data(withJSONObject: ["mac": mac, "macs": [mac], "legacy": [mac: ["at": 1, "peers": peers]]]).write(to: run.appending(path: "link.json"))
        var told = Self.item(500, "On the lab", order: 1)
        told["owner"] = "ses_far"
        told["inProgress"] = false
        told["noteCount"] = 0
        told["fileCount"] = 0
        told["linkCount"] = 0
        try JSONSerialization.data(withJSONObject: ["id": "wqt_told0000001", "at": Date.now.timeIntervalSince1970 * 1000, "heard": 1, "kind": "machine", "items": [told], "owners": [], "categories": []])
            .write(to: run.appending(path: "work-queue/peers/\(labKey).json"))
        var onLaptop = told
        onLaptop["id"] = "wqi_" + String(repeating: "b", count: 17) + "501"
        onLaptop["number"] = 501
        onLaptop["title"] = "On the laptop"
        try JSONSerialization.data(withJSONObject: ["id": "wqt_told0000002", "at": Date.now.timeIntervalSince1970 * 1000, "heard": 1, "kind": "mac", "items": [onLaptop], "owners": [], "categories": []])
            .write(to: run.appending(path: "work-queue/peers/\(otherMac).json"))
        // Lab takes what you do from another box; the laptop is a box from before that. And the relay
        // found nothing at lab a minute ago.
        try JSONSerialization.data(withJSONObject: [
            labKey: ["at": 1, "heard": 1, "kind": "machine", "id": "lab-elsewhere", "list": [], "features": ["work-queue", "work-queue.elsewhere", "work-queue.forward"]],
            otherMac: ["at": 1, "heard": 1, "kind": "mac", "list": [], "features": ["work-queue", "work-queue.elsewhere"]],
        ]).write(to: run.appending(path: "peer-agents.json"))
        try JSONSerialization.data(withJSONObject: [labKey: Date.now.timeIntervalSince1970 * 1000 - 60_000]).write(to: run.appending(path: "peer-reach.json"))

        let store = app.workQueues
        var asked: [String] = []
        let studioClient = Self.appClient(studio, box: BoxClient.mac), labClient = Self.appClient(lab, box: "lab")
        store.boxes = { asked.append($0); return $0 == "lab" ? labClient : studioClient }
        store.proof = { _, _, _, _ in "cHJvb2Y" }
        store.computers = { (mac: mac, machines: ["lab": labKey]) }
        let all = WorkQueues.Key(box: BoxClient.mac, owner: WorkQueueView.all)
        await store.read(all)
        let item = try #require(store.views[all]?.items.first { $0.number == 500 })
        #expect(item.computer?.name == "lab-elsewhere")
        #expect(store.views[all]?.computers.map(\.name).sorted() == ["Laptop", "lab-elsewhere"])
        #expect(store.box(of: item, in: BoxClient.mac) == "lab", "its files are read from lab, by its key, as this Mac names it")

        // Deleted from this Mac's panel: sent to this Mac's box, which says lab isn't answering.
        asked.removeAll()
        await store.delete(item, on: BoxClient.mac)
        #expect(store.refusal?.box == BoxClient.mac)
        #expect(store.refusal?.text == "lab-elsewhere isn't answering now (it may be asleep, off or offline), so nothing was changed there. Try again once it's back.")
        #expect(store.undoable == nil)
        // One on a Mac from before: that box's word, changed there.
        let laptops = try #require(store.views[all]?.items.first { $0.number == 501 })
        await store.move(laptops, to: .category("later"), on: BoxClient.mac)
        #expect(store.refusal?.text == "#501 \"On the laptop\" is on Laptop: change it there.")
        #expect(!asked.contains("lab"), "never sent to lab by this Mac itself")
        let labView = WorkQueues.Key(box: "lab", owner: "ses_far")
        await store.read(labView)
        #expect(store.views[labView]?.items.map(\.title) == ["On the lab"], "nothing changed there")

        // Its page: as lab last told this Mac's box, said so.
        let page = await store.load(box: BoxClient.mac, item: "500")
        #expect(page?.item.title == "On the lab")
        #expect(page?.told == true)
    }

    // MARK: Counts, order and dragging (#551)

    /// A queue as an import and agents leave it: places that aren't the numbers' order nor when
    /// each was made, Done items among them, and a category of the user's own.
    private func keepMixedQueue(on machine: MachineTestBox) throws {
        let queues = machine.folder.appending(path: "run/work-queue")
        try FileManager.default.createDirectory(at: queues, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["custom": [["id": "cat_design", "name": "Design"]]]).write(to: queues.appending(path: "categories.json"))
        try keep([
            Self.item(16, "Sixteen", order: 3), Self.item(6, "Six", order: 0), Self.item(13, "Thirteen", order: 3.5), Self.item(551, "New on top", order: -2),
            Self.item(1, "Shipped", category: "done", order: 0), Self.item(2, "Shipped too", category: "done", order: 1),
            Self.item(8, "Later one", category: "later", order: 0), Self.item(15, "Parked one", category: "parked", order: 0),
            Self.item(30, "Designed", category: "cat_design", order: 0),
        ], for: "ses_lead", on: machine)
    }

    @Test func allCountsDoneTooAndEveryCountOnThePanelAddsUpToIt() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        use(machine)
        try keepMixedQueue(on: machine)
        let key = WorkQueues.Key(box: BoxClient.mac, owner: WorkQueueView.all)
        await app.workQueues.read(key)
        let view = try #require(app.workQueues.views[key])
        let sections = WorkQueue.sections(view)
        // The chips: All, In progress, then each category.
        #expect(WorkQueue.allCount(view) == 9, "All is everything, Done too")
        #expect(sections.map(\.items.count).reduce(0, +) == WorkQueue.allCount(view), "In progress and the categories add up to All, each item once")
        #expect(WorkQueue.items(view, .all).count == WorkQueue.allCount(view), "and All lists every one")
        // The header and the tab: what's left to do, beside it.
        #expect(WorkQueue.openWords(WorkQueue.openCount(view)) == "7 open")
    }

    @Test func theListIsInTheBoxsOrderCategoryByCategoryWithDoneLast() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        use(machine)
        try keepMixedQueue(on: machine)
        let key = WorkQueues.Key(box: BoxClient.mac, owner: WorkQueueView.all)
        await app.workQueues.read(key)
        let view = try #require(app.workQueues.views[key])
        #expect(WorkQueue.sections(view).map(\.name) == ["In progress", "Next", "Later", "Design", "Parked", "Done"])
        #expect(WorkQueue.sections(view)[1].items.map(\.title) == ["New on top", "Six", "Sixteen", "Thirteen"], "by place, not by number or when it was made")
        #expect(WorkQueue.items(view, .all).suffix(2).map(\.title) == ["Shipped", "Shipped too"])
    }

    @Test func anItemDraggedInThePanelMovesOnTheBoxAndStaysThereReadAgain() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        use(machine)
        try keepMixedQueue(on: machine)
        let key = WorkQueues.Key(box: BoxClient.mac, owner: WorkQueueView.all)
        let store = app.workQueues
        let following = Task { await store.follow(key) }
        defer { following.cancel() }
        try await until { store.views[key] != nil }
        let next = { (view: WorkQueueView?) in view.map { WorkQueue.sections($0).first { $0.category == "next" }!.items.map(\.title) } ?? [] }

        // #13 dragged as it's written, onto the lower half of the first row of Next: after it.
        await store.drop("#13", at: WorkQueues.DropTarget(section: "next", index: 1), in: key)
        try await until { next(store.views[key]) == ["New on top", "Thirteen", "Six", "Sixteen"] }
        // #6 dragged into Later, onto the upper half of its row: before it, kept in Later now.
        await store.drop("#6", at: WorkQueues.DropTarget(section: "later", index: 0), in: key)
        try await until { store.views[key].map { WorkQueue.sections($0).first { $0.category == "later" }!.items.map(\.title) } == ["Six", "Later one"] }
        // #16 dropped on Done's name: the top of Done.
        await store.drop("#16", at: WorkQueues.DropTarget(section: "done", index: nil), in: key)
        try await until { store.views[key].map { WorkQueue.sections($0).last!.items.map(\.title) } == ["Sixteen", "Shipped", "Shipped too"] }
        #expect(store.refusal == nil)

        // Read anew (the panel opened again, here or on another client): where you put them.
        let again = AppModel()
        again.workQueues.app = again
        let client = Self.appClient(machine, box: BoxClient.mac)
        again.workQueues.boxes = { _ in client }
        await again.workQueues.read(key)
        let view = try #require(again.workQueues.views[key])
        #expect(next(view) == ["New on top", "Thirteen"])
        #expect(WorkQueue.sections(view).first { $0.category == "later" }!.items.map(\.title) == ["Six", "Later one"])
        #expect(view.items.first { $0.title == "Sixteen" }?.category == "done")
    }

    @Test func aMachineThatStopsAnsweringShowsWhatThisMacsBoxHeardFromItSaidSoNotItsOldListAsIfLive() async throws {
        let studio = try await MachineTestBox(name: "studio")
        defer { studio.stop() }
        let lab = try await MachineTestBox(name: "lab")
        try keep([Self.item(500, "On the lab", order: 1)], for: "ses_far", on: lab)
        // This Mac's own box knows lab as one of your computers, has what it told of its queue, and
        // the relay found nothing at lab a minute ago.
        let mac = Self.randomKey(32), labKey = Self.randomKey(32)
        let run = studio.folder.appending(path: "run")
        try FileManager.default.createDirectory(at: run.appending(path: "work-queue/peers"), withIntermediateDirectories: true)
        let peers: [[String: Any]] = [["key": mac, "address": Self.randomKey(16), "kind": "mac", "name": "Studio Mac"], ["key": labKey, "address": Self.randomKey(16), "kind": "machine", "name": "lab", "id": "lab"]]
        try JSONSerialization.data(withJSONObject: ["mac": mac, "macs": [mac], "legacy": [mac: ["at": 1, "peers": peers]]]).write(to: run.appending(path: "link.json"))
        var told = Self.item(500, "On the lab", order: 1)
        told.merge(["owner": "ses_far", "inProgress": true, "sessions": [["session": "ses_far", "title": "Far", "working": true]], "noteCount": 0, "fileCount": 0, "linkCount": 0]) { $1 }
        try JSONSerialization.data(withJSONObject: ["id": "wqt_told0000001", "at": Date.now.timeIntervalSince1970 * 1000 - 3_600_000, "heard": 1, "kind": "machine", "items": [told], "owners": [], "categories": []])
            .write(to: run.appending(path: "work-queue/peers/\(labKey).json"))
        try JSONSerialization.data(withJSONObject: [labKey: Date.now.timeIntervalSince1970 * 1000 - 60_000]).write(to: run.appending(path: "peer-reach.json"))
        // And an item of this Mac's own.
        try keep([Self.item(7, "On this Mac", order: 1)], for: "ses_here", on: studio)

        let store = app.workQueues
        let studioClient = Self.appClient(studio, box: BoxClient.mac), labClient = Self.appClient(lab, box: "lab")
        store.boxes = { $0 == "lab" ? labClient : studioClient }
        store.computers = { (mac: mac, machines: ["lab": labKey]) }
        // A conversation on lab: its panel follows lab's box, its own items or every one.
        let key = WorkQueues.Key(box: "lab", owner: "ses_far")
        let all = WorkQueues.Key(box: "lab", owner: WorkQueueView.all)
        let following = [Task { await store.follow(key) }, Task { await store.follow(all) }]
        defer { following.forEach { $0.cancel() } }
        try await until { store.views[key] != nil && store.views[all] != nil }
        #expect(store.fellBack.contains(key) == false)
        #expect(store.views[key]?.items.first?.computer == nil, "lab's own, live")

        // Lab is switched off: the panel shows what this Mac's box has of it, saying so, with
        // nothing in progress there.
        lab.stop()
        try await until { store.fellBack.contains(key) }
        let view = try #require(store.views[key])
        let item = try #require(view.items.first)
        #expect(item.title == "On the lab")
        #expect(item.computer?.name == "lab")
        #expect(item.inProgress == false, "nothing on a computer that's off is shown at work")
        #expect(WorkQueue.awayNote(view)?.hasPrefix("lab isn’t answering") == true)

        // Every conversation's: this Mac's own item says it's this Mac's, and what you do to it
        // goes to this Mac's box, never to lab.
        try await until { store.fellBack.contains(all) }
        let mine = try #require(store.views[all]?.items.first { $0.title == "On this Mac" })
        #expect(mine.computer != nil, "never taken for lab's")
        await store.move(mine, to: .category("later"), on: "lab")
        #expect(store.refusal == nil)
        let here = WorkQueues.Key(box: BoxClient.mac, owner: "ses_here")
        await store.read(here)
        #expect(store.views[here]?.items.first?.category == "later")
        // Its page: as this Mac's box has it.
        #expect(await store.load(box: "lab", item: "500")?.item.title == "On the lab")
    }

    @Test func aDragWhileSearchingLandsWhereTheLineWasDrawnAmongTheRowsShown() async throws {
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        use(machine)
        try keep([Self.item(1, "Alpha", order: 1), Self.item(2, "Bravo", order: 2), Self.item(3, "Charlie", order: 3)], for: "ses_lead", on: machine)
        let key = WorkQueues.Key(box: BoxClient.mac, owner: "ses_lead")
        let store = app.workQueues
        await store.read(key)
        // A search that shows Alpha and Charlie; Alpha dropped on Charlie's lower half (the second
        // row shown): after Charlie, not before it as the whole list's third place would say.
        var shown = try #require(store.views[key])
        shown.items = shown.items.filter { $0.title.localizedStandardContains("a") && $0.title != "Bravo" }
        await store.drop("#1", at: WorkQueues.DropTarget(section: "next", index: 2), in: key, shown: shown)
        await store.read(key)
        #expect(titles(key, in: "next") == ["Bravo", "Charlie", "Alpha"])
    }
}

