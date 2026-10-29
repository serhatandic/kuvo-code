import ClientDesign
import ClientText
import Foundation
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Find in a conversation (⌘F): every place the words are, as each message shows them (a reply's
/// Markdown as drawn), case and accents aside; going through them wraps around; the place you're
/// on stays it as the reply grows; Esc closes Find before it stops anything.
@MainActor
@Suite(.serialized) struct ConversationFindTests {
    let rows: [ConversationFind.Row] = [
        .init(id: "you-1", parts: [.plain("Can you check the Café config?")]),
        .init(id: "reply-1", parts: [.markdown("The **config** is in `app.config`. See [the config docs](https://example.com/config).")]),
        .init(id: "you-2", parts: [.plain("Nothing to see here")]),
        .init(id: "reply-2", parts: [.markdown("Done: CONFIG updated.")]),
    ]

    private func found(_ query: String, in rows: [ConversationFind.Row]? = nil, find: ConversationFind = ConversationFind(), showsFirst: Bool = true) async -> ConversationFind {
        find.open(query)
        await find.look(in: rows ?? self.rows, folders: [], showsFirst: showsFirst)?.value
        return find
    }

    /// Each place, in order, as shown: a reply's link by its words, not its address.
    @Test func everyPlaceAsShown() async {
        let find = await found("config")
        #expect(find.places.map(\.row) == ["you-1", "reply-1", "reply-1", "reply-1", "reply-2"])
        #expect(find.places.map(\.number) == [0, 0, 1, 2, 0])
        #expect(find.current?.row == "you-1")
    }

    @Test func caseAndAccentsAside() async {
        #expect(await found("cafe").places.map(\.row) == ["you-1"])
        #expect(await found("CAFÉ").places.count == 1)
    }

    @Test func goingThroughWrapsAround() async {
        let find = await found("config")
        find.step(-1)
        #expect(find.current?.row == "reply-2")
        find.step(1)
        #expect(find.current?.row == "you-1")
        find.step(2)
        #expect(find.current?.row == "reply-1" && find.current?.number == 1)
    }

    /// Each row marks its own places, and only the one you're on is the current one there.
    @Test func eachRowMarksItsPlaces() async {
        let find = await found("config")
        find.step(2)
        #expect(find.highlight(for: "reply-1") == FindHighlight(query: "config", current: 1))
        #expect(find.highlight(for: "reply-2") == FindHighlight(query: "config", current: nil))
        #expect(find.highlight(for: "you-2") == nil)
    }

    /// As a reply is written, more places come; the one you're on stays it.
    @Test func thePlaceYoureOnStaysAsTheReplyGrows() async {
        let find = await found("config")
        find.step(4)
        #expect(find.current?.row == "reply-2")
        var grown = rows
        grown.insert(.init(id: "reply-1b", parts: [.markdown("Another config, and one more config.")]), at: 2)
        await find.look(in: grown, folders: [], showsFirst: false)?.value
        #expect(find.places.count == 7)
        #expect(find.current?.row == "reply-2" && find.current?.number == 0)
    }

    @Test func nothingToLookFor() async {
        let find = await found("   ")
        #expect(find.places.isEmpty)
        #expect(find.highlight(for: "you-1") == nil)
    }

    /// Esc closes an open Find first; once none is open, it's for stopping the agent.
    @Test func escClosesFindFirst() async {
        let find = await found("config")
        #expect(ConversationFind.hasOpen)
        #expect(ConversationFind.closeOpen())
        #expect(!find.isOn)
        #expect(!ConversationFind.closeOpen())
    }

    /// Find left open in a conversation you've gone from (kept, out of view) isn't Esc's: Esc in the
    /// one in view stops its agent at once.
    @Test func findOpenInAConversationOutOfViewIsntEscs() async {
        let left = await found("config")
        left.isShown = false
        #expect(!ConversationFind.hasOpen)
        #expect(!ConversationFind.closeOpen())
        #expect(left.isOn, "still open there, for going back to it")
        left.isShown = true
        #expect(ConversationFind.closeOpen())
    }

    /// A message sent with a keyword shows it in front of its words: Find counts the places in
    /// both, as many as the bubble marks, so the place you're on is the one marked.
    @Test func aKeywordInFrontOfYourWordsIsFoundAsShown() async throws {
        let json: [String: Any] = ["id": "you-1", "type": "user", "time": ["created": 1],
                                   "text": SentWithKeyword.message("Review the tests", typed: "/review")]
        guard case .user(let message) = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: json)) else {
            Issue.record("not a user message"); return
        }
        let find = await found("review", in: [.init(id: "you-1", parts: Row.user(message).findParts)])
        var drawn = MessageMentions.keyword("/review", before: AttributedString("Review the tests"))
        FindText.mark(&drawn, try #require(find.highlight(for: "you-1")))
        #expect(find.places.count == 2)
        #expect(marks(in: drawn) == find.places.count)
    }

    /// A bot's reply naming an agent with "&" draws a face in the "&"'s place, and a group chat's
    /// "@Name" too: Find, which reads them as written, marks them where it finds them.
    @Test func aNameDrawnWithAFaceIsMarkedWhereFound() async throws {
        let reply = "Ask &Ada about the config."
        let find = await found("&ada", in: [.init(id: "reply-1", parts: [.markdown(reply)])])
        let ada = MessageMentions.Agent(reference: .init(name: "Ada", session: "ses_ada"), look: nil)
        let drawn = try FileLinkingParser(folders: { [] }, agents: [ada], highlight: find.highlight(for: "reply-1")).attributedString(for: reply)
        #expect(find.places.count == 1)
        #expect(marks(in: drawn) == 1)
    }

    /// The places marked in `text`, as drawn.
    private func marks(in text: AttributedString) -> Int {
        var count = 0, inMark = false
        for run in text.runs {
            let marked = [FindText.place, FindText.currentPlace].contains(run.swiftUI.backgroundColor)
            if marked, !inMark { count += 1 }
            inMark = marked
        }
        return count
    }
}
