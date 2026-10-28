import Foundation
import Testing
@testable import OpenCodeKit

// A conversation's side questions as the box keeps them, read as side threads: follow-ups with the
// question that started them, in the order the threads were started; one from before threads is a
// thread of its own.
@Test func sideQuestionsReadAsTheirThreads() throws {
    let kept = #"""
    [{"id": "btw_old", "session": "s", "question": "Old?", "state": "answered", "answer": "Yes.", "asked": 1},
     {"id": "btw_1", "session": "s", "thread": "btw_1", "question": "Which event?", "state": "answered", "answer": "blur.", "asked": 2},
     {"id": "btw_2", "session": "s", "thread": "btw_2", "question": "Regex?", "state": "answering", "asked": 3},
     {"id": "btw_3", "session": "s", "thread": "btw_1", "question": "Which browsers?", "state": "answering", "asked": 4}]
    """#
    let threads = SideThread.threads(try JSONDecoder().decode([SideQuestion].self, from: Data(kept.utf8)))
    #expect(threads.map(\.id) == ["btw_old", "btw_1", "btw_2"])
    #expect(threads[1].questions.map(\.question) == ["Which event?", "Which browsers?"])
    #expect(threads[1].latest.state == .answering)
}
