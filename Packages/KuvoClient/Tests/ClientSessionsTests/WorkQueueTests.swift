import Foundation
import Testing
import ClientSessions

/// What both apps show of a Work Queue, from the box's view as it sends it.
@Suite struct WorkQueueTests {
    static func item(_ number: Int?, _ title: String, _ category: String, order: Double = 1, owner: String = "ses_lead", inProgress: Bool = false, note: String? = nil) -> String {
        """
        {"id":"wqi_\(number ?? 0)\(title.count)","\(number == nil ? "wanted" : "number")":\(number ?? 9),"owner":"\(owner)","title":"\(title)","category":"\(category)","order":\(order),"inProgress":\(inProgress),\(note.map { "\"progress\":{\"note\":\"\($0)\"}," } ?? "")"sessions":[{"session":"ses_child","title":"Sign-in","working":\(inProgress)}],"noteCount":0,"fileCount":0,"linkCount":0,"created":{"at":1000,"by":{"user":true}},"updated":{"at":2000,"by":{"session":"ses_child","name":"Sign-in"}}}
        """
    }

    static let view: WorkQueueView = {
        let items = [
            item(1, "Build the sign-in", "next", inProgress: true, note: "Wiring the endpoint"),
            item(2, "Write the docs", "next", order: 2),
            item(3, "Dark mode", "later", owner: "ses_child"),
            item(4, "Old idea", "parked"),
            item(5, "Shipped", "done"),
            item(6, "Odd one", "cat_gone"),
            item(nil, "Waiting", "cat_design"),
        ].joined(separator: ",")
        let json = """
        {"owner":"ses_lead","categories":[{"id":"next","name":"Next","builtIn":true},{"id":"later","name":"Later","builtIn":true},{"id":"cat_design","name":"Design","builtIn":false},{"id":"parked","name":"Parked","builtIn":true},{"id":"done","name":"Done","builtIn":true}],
         "items":[\(items)],
         "owners":[{"owner":"ses_lead","kind":"session","title":"Lead"},{"owner":"ses_child","kind":"session","title":"Sign-in","startedBy":"ses_lead"}],
         "removed":[]}
        """
        return try! JSONDecoder().decode(WorkQueueView.self, from: Data(json.utf8))
    }()

    @Test func inProgressComesFirstThenEachCategoryInTheBoxsOrder() {
        let sections = WorkQueue.sections(Self.view)
        #expect(sections.map(\.name) == ["In progress", "Next", "Later", "Design", "Parked", "Done"])
        #expect(sections.map { $0.items.map(\.name) } == [["#1"], ["#2", "#6"], ["#3"], ["New"], ["#4"], ["#5"]])
    }

    @Test func filtersKeepTheirOwn() {
        #expect(WorkQueue.items(Self.view, .inProgress).map(\.name) == ["#1"])
        #expect(WorkQueue.items(Self.view, .category("later")).map(\.name) == ["#3"])
        #expect(WorkQueue.items(Self.view, .all, showsDone: false).count == 6)
        #expect(WorkQueue.items(Self.view, .all).count == 7)
    }

    @Test func theTabCountsOpenItems() {
        #expect(WorkQueue.openCount(Self.view) == 6)
        #expect(WorkQueue.count(24) == "24 items")
        #expect(WorkQueue.count(1) == "1 item")
        #expect(WorkQueue.count(0) == "No items")
    }

    @Test func updatedSaysHowLongAgo() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(WorkQueue.updated(now.addingTimeInterval(-20), now: now) == "Updated just now")
        #expect(WorkQueue.updated(now.addingTimeInterval(-8 * 60), now: now) == "Updated 8m ago")
        #expect(WorkQueue.updated(now.addingTimeInterval(-3 * 3600), now: now) == "Updated 3h ago")
        #expect(WorkQueue.updated(now.addingTimeInterval(-2 * 86_400), now: now) == "Updated 2d ago")
    }

    @Test func anItemNotTheViewersSaysWhoseItIs() {
        let items = Self.view.items
        #expect(WorkQueue.ownerName(of: items[0], in: Self.view) == nil)
        #expect(WorkQueue.ownerName(of: items.first { $0.number == 3 }!, in: Self.view) == "Sign-in")
    }

    @Test func currentWorkIsTheAgentsNoteElseWhoIsAtWork() {
        let items = Self.view.items
        #expect(WorkQueue.currentWork(items[0]) == "Wiring the endpoint")
        #expect(WorkQueue.currentWork(items[1]) == nil)
    }

    @Test func anItemMovesToAnyOtherCategoryNeverInProgress() {
        let item = Self.view.items[0]
        #expect(WorkQueue.moveTargets(for: item, in: Self.view.categories).map(\.id) == ["later", "cat_design", "parked", "done"])
    }

    @Test func anItemWholeHasItsBodyNotesAndFiles() throws {
        let json = """
        {"id":"wqi_1","number":243,"owner":"ses_a","title":"T","category":"next","order":1,"inProgress":false,"sessions":[],"noteCount":1,"fileCount":1,"linkCount":0,"created":{"at":1,"by":{"user":true}},"updated":{"at":1,"by":{"user":true}},
         "body":"# Hi","notes":[{"at":5,"by":{"session":"ses_a","name":"Mira"},"text":"Started."}],"files":[{"name":"shot.png","size":10,"type":"image/png","at":3}],"links":[{"url":"https://x.y"}],"handed":[]}
        """
        let detail = try JSONDecoder().decode(WorkItemDetail.self, from: Data(json.utf8))
        #expect(detail.item.name == "#243")
        #expect(detail.body == "# Hi")
        #expect(detail.notes.first?.by.words == "Mira")
        #expect(detail.files.first?.isPicture == true)
    }
}
