import ClientDesign
import Foundation
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
}
