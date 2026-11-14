import Foundation
import Testing
import ClientSessions

/// What an inbox lists, from the facts each conversation's sidebar mark goes by.
@Suite struct InboxTests {
    @Test func whatWaitsOnYouIsInItWhateverElseHolds() {
        #expect(Inbox.reason(needsYou: true, atWork: true, failed: true, isNew: false) == .needsYou)
        #expect(Inbox.reason(needsYou: true, atWork: false, failed: false, isNew: true) == .needsYou)
    }

    @Test func aFinishedOrFailedRunIsInItOnlyUntilYouveLooked() {
        #expect(Inbox.reason(needsYou: false, atWork: false, failed: false, isNew: true) == .finished)
        #expect(Inbox.reason(needsYou: false, atWork: false, failed: true, isNew: true) == .failed)
        // Read since: out, failed or not.
        #expect(Inbox.reason(needsYou: false, atWork: false, failed: true, isNew: false) == nil)
        #expect(Inbox.reason(needsYou: false, atWork: false, failed: false, isNew: false) == nil)
    }

    @Test func oneAtWorkAgainIsntNewsUntilItsDone() {
        #expect(Inbox.reason(needsYou: false, atWork: true, failed: false, isNew: true) == nil)
        #expect(Inbox.reason(needsYou: false, atWork: true, failed: true, isNew: true) == nil)
    }

    @Test func whatWaitsOnYouComesFirstThenTheLatestNews() {
        let entries: [(String, Inbox.Reason, Double)] = [
            ("old news", .finished, 10), ("failed", .failed, 40), ("ask", .needsYou, 5),
            ("new news", .finished, 50), ("later ask", .needsYou, 30),
        ]
        let ordered = Inbox.ordered(entries, reason: \.1, at: \.2).map(\.0)
        #expect(ordered == ["later ask", "ask", "new news", "failed", "old news"])
    }

    @Test func aWorkItemIsFoundByItsTitleOrItsNumber() {
        let items = WorkQueueTests.view.items
        let found = { (words: String) in items.filter { WorkQueue.matches($0, words) }.compactMap(\.number) }
        #expect(found("sign-in") == [1])
        #expect(found("#3") == [3])
        #expect(found("4") == [4])
        #expect(found("  ").isEmpty)
    }

    @Test func anItemTwoComputersListIsFoundOnceWhereItsKept() {
        let told = { (number: Int, title: String) in
            #"{"id":"wqi_\#(number)","number":\#(number),"owner":"ses_far","title":"\#(title)","category":"next","order":1,"inProgress":false,"sessions":[],"noteCount":0,"fileCount":0,"linkCount":0,"computer":{"key":"k","name":"lab","kind":"machine"},"created":{"at":1,"by":{"user":true}},"updated":{"at":1,"by":{"user":true}}}"#
        }
        let decode = { (json: String) in try! JSONDecoder().decode(WorkItem.self, from: Data(json.utf8)) }
        let mac = [decode(WorkQueueTests.item(1, "Sign-in", "next")), decode(told(500, "Lab's"))]
        let lab = [decode(WorkQueueTests.item(500, "Lab's", "next")), decode(told(1, "Sign-in"))]
        let other = [decode(told(600, "Elsewhere")), decode(told(500, "Lab's"))]
        let once = WorkQueue.once([("mac", mac), ("lab", lab), ("other", other)]).map { ($0.0, $0.1.compactMap(\.number)) }
        #expect(once.map(\.0) == ["mac", "lab", "other"])
        #expect(once.map(\.1) == [[1], [500], [600]])
    }
}

