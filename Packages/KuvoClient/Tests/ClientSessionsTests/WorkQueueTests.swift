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
            item(6, "Also next", "next", order: 3),
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

    // MARK: A session's view, and one item

    /// A session's own view, as the box sends it: its own items, and a lead's it's linked to.
    static let sessionView: WorkQueueView = {
        let lead = item(551, "All includes Done", "next", owner: "ses_lead", inProgress: true, note: "Box tests pass")
            .replacingOccurrences(of: #""session":"ses_child","title":"Sign-in""#, with: ##""session":"ses_worker","title":"#551 All includes Done""##)
        let idle = item(552, "Rows and page", "later", owner: "ses_lead")
            .replacingOccurrences(of: #""session":"ses_child","title":"Sign-in""#, with: ##""session":"ses_worker","title":"#552""##)
        let json = """
        {"owner":"ses_worker","categories":[{"id":"next","name":"Next","builtIn":true},{"id":"later","name":"Later","builtIn":true},{"id":"parked","name":"Parked","builtIn":true},{"id":"done","name":"Done","builtIn":true}],
         "items":[\(lead),\(idle),\(item(7, "Its own", "next", owner: "ses_worker")),\(item(8, "Its own at work", "later", owner: "ses_worker", inProgress: true))],
         "owners":[{"owner":"ses_lead","kind":"bot","title":"Kuvo Foreman","bot":{"id":"bot_1","name":"Kuvo Foreman"}},{"owner":"ses_worker","kind":"session","title":"#551"}],
         "removed":[]}
        """
        return try! JSONDecoder().decode(WorkQueueView.self, from: Data(json.utf8))
    }()

    @Test func aSessionsViewListsWhatItWorksOnFirstOnceWhoeversItIs() {
        let sections = WorkQueue.sections(Self.sessionView)
        #expect(sections.map(\.name) == ["Working on", "In progress", "Next", "Later", "Parked", "Done"])
        #expect(sections.map { $0.items.map(\.name) } == [["#551", "#552"], ["#8"], ["#7"], [], [], []], "each once: a lead's item isn't in its category too")
        #expect(WorkQueue.items(Self.sessionView, .inProgress).map(\.name) == ["#551", "#8"])
        #expect(WorkQueue.items(Self.sessionView, .all).map(\.name) == ["#551", "#552", "#8", "#7"])
        #expect(WorkQueue.eyebrow(of: Self.sessionView.items[0], in: Self.sessionView) == ["Kuvo Foreman"])
        // A lead's own view, and All, have no Working on.
        #expect(!WorkQueue.sections(Self.view).contains { $0.id == WorkQueue.workingOnID })
        var all = Self.sessionView
        all.owner = WorkQueueView.all
        #expect(WorkQueue.sections(all).first?.name == "In progress")
    }

    @Test func anItemAtWorkSaysInProgressOnlyAndItsCategoryOnlyWhenNoOneIs() {
        let now = Date(timeIntervalSince1970: 3)
        let (atWork, idle) = (Self.sessionView.items[0], Self.sessionView.items[1])
        #expect(WorkQueue.status(of: atWork) == .inProgress)
        #expect(WorkQueue.properties(of: atWork, in: Self.sessionView, now: now).map(\.words) == ["Kuvo Foreman’s queue", "Added just now"], "never In Next beside In progress")
        #expect(WorkQueue.status(of: idle) == nil)
        #expect(WorkQueue.properties(of: idle, in: Self.sessionView, now: now).map(\.words) == ["In Later", "Kuvo Foreman’s queue", "Added just now"])
        #expect(WorkQueue.properties(of: idle, in: Self.sessionView, now: now).last?.help == "Added just now by you. Updated just now by Sign-in.")
    }

    @Test func doneDeletedAndClosedOnGitHubAreSaidOnce() throws {
        let json = """
        {"owner":"ses_lead","categories":[{"id":"next","name":"Next","builtIn":true},{"id":"later","name":"Later","builtIn":true},{"id":"done","name":"Done","builtIn":true}],"owners":[],
         "items":[{"id":"wqi_1","source":{"kind":"github-pr","ref":"gh:kuvo/app#57","name":"app#57"},"seen":{"state":"merged","at":5},"keptIn":"later","closesOn":"github","owner":"ses_lead","title":"Keep the name","category":"done","order":1,"inProgress":false,"sessions":[],"noteCount":0,"fileCount":0,"linkCount":0,"computer":{"key":"k","name":"lab","kind":"machine"},"created":{"at":1,"by":{"user":true}},"updated":{"at":1,"by":{"user":true}}},
                  {"id":"wqi_2","number":5,"owner":"ses_lead","title":"Shipped","category":"done","doneAt":1,"order":2,"inProgress":false,"sessions":[],"noteCount":0,"fileCount":0,"linkCount":0,"created":{"at":1,"by":{"user":true}},"updated":{"at":1,"by":{"user":true}}}],
         "removed":[{"id":"wqi_3","number":6,"owner":"ses_lead","title":"Gone","category":"next","order":3,"inProgress":false,"sessions":[],"noteCount":0,"fileCount":0,"linkCount":0,"created":{"at":1,"by":{"user":true}},"updated":{"at":1,"by":{"user":true}},"removed":{"at":1,"by":{"user":true}}}]}
        """
        let view = try JSONDecoder().decode(WorkQueueView.self, from: Data(json.utf8))
        let now = Date(timeIntervalSince1970: 0)
        #expect(WorkQueue.properties(of: view.items[0], in: view, now: now).map(\.words) == ["Merged on GitHub", "Untitled session’s queue", "On lab", "Added just now"])
        #expect(WorkQueue.properties(of: view.items[0], in: view, now: now).first?.help == "If it’s reopened there, it’s back in Later.")
        #expect(WorkQueue.properties(of: view.items[1], in: view, now: now).first?.words == "Done")
        #expect(WorkQueue.status(of: view.removed[0]) == .deleted)
        #expect(WorkQueue.properties(of: view.removed[0], in: view, now: now).first?.words == "Untitled session’s queue", "Deleted, not In Next too")
    }

    @Test func theCardSaysWhetherASessionIsAtWorkAndWhatItSaid() {
        let card = WorkQueue.sessionCard(for: Self.sessionView.items[0])
        #expect(card?.working == true)
        #expect(card?.heading == "Session at work")
        #expect(card?.note == "Box tests pass")
        #expect(card?.sessions.map(WorkQueue.sessionName) == ["#551 All includes Done"])
        let idle = WorkQueue.sessionCard(for: Self.sessionView.items[1])
        #expect(idle?.heading == "No session at work")
        #expect(idle?.note == nil, "never “… is at work on it”")
        #expect(WorkQueue.progressNote(Self.sessionView.items[1]) == nil)
    }

    @Test func activityIsNotesAndWhatTheBoxKeptOldestFirst() throws {
        let json = """
        {"id":"wqi_1","number":243,"owner":"ses_b","title":"T","category":"done","doneAt":9000,"order":1,"inProgress":false,"sessions":[],"noteCount":2,"fileCount":0,"linkCount":0,"created":{"at":1000,"by":{"session":"ses_lead","name":"Kuvo Foreman"}},"updated":{"at":9000,"by":{"session":"ses_b","name":"Sign-in"}},
         "body":"","notes":[{"at":5000,"by":{"session":"ses_b","name":"Sign-in"},"text":"Halfway."},{"at":2000,"by":{"user":true},"text":"Use the new endpoint."}],"files":[],"links":[],"handed":[{"from":"ses_lead","to":"ses_b","at":3000}]}
        """
        let detail = try JSONDecoder().decode(WorkItemDetail.self, from: Data(json.utf8))
        let view = WorkQueueView(owner: "ses_lead", owners: try JSONDecoder().decode([WorkOwner].self, from: Data(#"[{"owner":"ses_lead","kind":"bot","title":"Kuvo Foreman","bot":{"id":"bot_1","name":"Kuvo Foreman"}},{"owner":"ses_b","kind":"session","title":"Sign-in"}]"#.utf8)))
        let lines = WorkQueue.activity(of: detail, in: view)
        #expect(lines.map { "\($0.whoWords) \($0.what)" } == ["Kuvo Foreman added the item", "You left a note", "Kuvo Foreman handed it to Sign-in", "Sign-in left a note", "Sign-in marked it done"])
        #expect(lines[1].text == "Use the new endpoint.")
    }

    @Test func aRowsTimeIsShort() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(WorkQueue.shortAgo(now.addingTimeInterval(-20), now: now) == "now")
        #expect(WorkQueue.shortAgo(now.addingTimeInterval(-12 * 60), now: now) == "12m")
        #expect(WorkQueue.shortAgo(now.addingTimeInterval(-3 * 3600), now: now) == "3h")
        #expect(WorkQueue.shortAgo(now.addingTimeInterval(-2 * 86_400), now: now) == "2d")
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

    @Test func whoAChangeIsFromNeverTurnsSomeoneElseIntoYou() throws {
        let stamps = try JSONDecoder().decode([WorkStamp].self, from: Data("""
        [{"at":1,"by":{"user":true}},{"at":2,"by":{"session":"ses_a","name":"Mira"}},{"at":3,"by":{"source":"github","name":"octocat"}},{"at":4,"by":{"source":"linear"}}]
        """.utf8))
        #expect(stamps.map(\.by.words) == ["you", "Mira", "octocat", "linear"])
    }

    @Test func oneRefThisClientCantReadLeavesTheOthersChips() throws {
        let refs = try JSONDecoder().decode(WorkRefs.self, from: Data("""
        {"refs":{"243":{"id":"wqi_1","number":243,"title":"Panel","category":"next","inProgress":false,"owner":"ses_a"},
                 "gh:owner/repo#12":{"id":"wqi_2","source":{"kind":"github","ref":"gh:owner/repo#12"},"title":"Login loops","category":"later","inProgress":true},
                 "500":{"id":"wqi_3","number":500,"title":"Far","category":"next","inProgress":false,"owner":"ses_far","computer":{"key":"k","name":"lab","kind":"machine","id":"lab"}},
                 "9":null,
                 "77":{"id":7}}}
        """.utf8))
        #expect(refs.refs["243"]??.title == "Panel")
        #expect(refs.refs["gh:owner/repo#12"]??.owner == nil, "an outside ref may have no owner")
        #expect(refs.refs["500"]??.computer?.name == "lab")
        #expect(refs.refs["9"] != nil && refs.refs["9"]! == nil)
        #expect(refs.refs["77"]! == nil, "one it can't read is as one the box doesn't know")
    }

    @Test func anItemFromAnOutsideSourceIsNamedByItsRefAndOneElsewhereSaysWhere() throws {
        let json = """
        {"owner":"all","categories":[{"id":"next","name":"Next","builtIn":true}],"owners":[],"removed":[],
         "items":[{"id":"wqi_1","number":250,"source":{"kind":"github","ref":"gh:owner/repo#12"},"owner":"ses_a","title":"Login loops","category":"next","order":1,"inProgress":false,"sessions":[],"noteCount":0,"fileCount":0,"linkCount":0,"created":{"at":1,"by":{"user":true}},"updated":{"at":1,"by":{"user":true}}},
                  {"id":"wqi_2","number":500,"owner":"ses_far","title":"Far","category":"next","order":2,"inProgress":false,"sessions":[],"noteCount":0,"fileCount":0,"linkCount":0,"computer":{"key":"k","name":"lab","kind":"machine","id":"lab"},"handing":{"to":"ses_b","name":"Wren"},"created":{"at":1,"by":{"user":true}},"updated":{"at":1,"by":{"user":true}}}],
         "computers":[{"key":"k","name":"lab","kind":"machine","id":"lab","at":5000}]}
        """
        let view = try JSONDecoder().decode(WorkQueueView.self, from: Data(json.utf8))
        #expect(view.items.map(\.name) == ["repo#12", "#500"], "its old number is never shown; an older box's ref, shown without its prefix and owner")
        #expect(view.items.map(\.written) == ["gh:owner/repo#12", "#500"])
        #expect(view.items.map { WorkQueue.computerName(of: $0) } == [nil, "lab"])
        #expect(view.items[1].handing?.name == "Wren")
        #expect(view.computers.first?.date == Date(timeIntervalSince1970: 5))
        // A box from before piece 3 says nothing of other computers.
        let older = try JSONDecoder().decode(WorkQueueView.self, from: Data(#"{"owner":"all","categories":[],"items":[],"owners":[],"removed":[]}"#.utf8))
        #expect(older.computers.isEmpty)
    }

    @Test func anIssueClosedOnGitHubIsDoneWhereItWasKeptAndOnlyGitHubMovesItInOrOut() throws {
        let json = """
        {"owner":"ses_lead","categories":[{"id":"next","name":"Next","builtIn":true},{"id":"later","name":"Later","builtIn":true},{"id":"parked","name":"Parked","builtIn":true},{"id":"done","name":"Done","builtIn":true}],"owners":[],"removed":[],
         "items":[{"id":"wqi_1","source":{"kind":"github","ref":"gh:kuvo/app#12","url":"https://github.com/kuvo/app/issues/12","name":"app#12"},"seen":{"state":"not_planned","at":5},"keptIn":"later","struck":true,"closesOn":"github","owner":"ses_lead","title":"Upload retries","category":"done","order":1,"inProgress":false,"sessions":[],"noteCount":0,"fileCount":0,"linkCount":0,"created":{"at":1,"by":{"user":true}},"updated":{"at":1,"by":{"user":true}}},
                  {"id":"wqi_2","source":{"kind":"github-pr","ref":"gh:kuvo/app#57","name":"app#57"},"seen":{"state":"open","at":5},"closesOn":"github","owner":"ses_lead","title":"Keep the name","category":"next","order":2,"inProgress":false,"sessions":[],"noteCount":0,"fileCount":0,"linkCount":0,"created":{"at":1,"by":{"user":true}},"updated":{"at":1,"by":{"user":true}}}]}
        """
        let view = try JSONDecoder().decode(WorkQueueView.self, from: Data(json.utf8))
        let (closed, open) = (view.items[0], view.items[1])
        #expect(closed.isDone && closed.keptIn == "later" && closed.isStruck)
        #expect([closed.name, open.name] == ["app#12", "app#57"])
        #expect([closed.spokenName, open.spokenName] == ["GitHub issue app#12", "GitHub pull request app#57"])
        #expect(closed.brand == "github")
        #expect(WorkQueue.moveTargets(for: closed, in: view.categories).isEmpty, "closed on GitHub: it stays Done until it's reopened there")
        #expect(!WorkQueue.canMove(closed))
        #expect(WorkQueue.moveTargets(for: open, in: view.categories).map(\.id) == ["later", "parked"], "never into Done")
        #expect(WorkRef(closed).name == "app#12" && WorkRef(closed).isStruck)
    }
}
