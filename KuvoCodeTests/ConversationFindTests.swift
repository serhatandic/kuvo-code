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

    /// What the box told a bot (its goal started) is no bubble of yours, nor a pill: nothing shows of
    /// it in the conversation (the next reply's footer says the goal started), and Find and a copy
    /// don't read the words only the bot got.
    @Test func whatTheBoxToldTheBotIsALineNotYours() throws {
        let json: [String: Any] = ["id": "msg_1", "type": "user", "time": ["created": 1],
                                   "text": "[Goal started] The user approved the plan. Work through it now: 1. Read 2. Write\nSpend nothing.",
                                   "metadata": ["kuvo": ["note": ["from": "Goal", "line": "Goal started"]]]]
        guard case .user(let message) = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: json)) else {
            Issue.record("not a user message"); return
        }
        #expect(Row.messages(message).isEmpty)
        let waiting = Transcript.Pending(id: "msg_2", text: "[Not now] The user didn't start this goal. Don't start its work.", delivery: .queue, isLocal: false)
        #expect(Row.waiting(waiting).isEmpty)
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

    /// "/review" sent with your words under a quote, searched for "review": stepping to the last
    /// place marks it, in the words the keyword's drawn in front of, as the bubble counts its places
    /// as Find does.
    @Test func thePlaceYoureOnBehindAKeywordIsTheOneMarked() async throws {
        let text = "> Should we review this?\n\nReview the tests"
        let find = await found("review", in: [.init(id: "you-1", parts: UserBubble.findParts(text, keyword: "/review").map(ConversationFind.Part.plain))])
        find.step(-1)
        let marks = try #require(UserBubble.findMarks(find.highlight(for: "you-1"), in: text, keyword: "/review"))
        var drawn = MessageMentions.keyword("/review", before: AttributedString("Review the tests"))
        FindText.mark(&drawn, marks[1])
        #expect(find.places.count == 3)
        #expect(marks[0].current == nil)
        #expect(placeColors(in: drawn) == [FindText.place, FindText.currentPlace])
    }

    /// A group chat's "@Name" is drawn with the bot's face in the "@"'s place: Find, which reads it
    /// as written, marks it where it finds it, as the place you're on.
    @Test func aGroupChatsNameDrawnWithAFaceIsMarkedWhereFound() async throws {
        let reply = "Ask @Scout about the deploy."
        let find = await found("@scout", in: [.init(id: "gm-1", parts: [.markdown(reply)])])
        let scout = Bot(id: "bot_scout", name: "Scout", job: "", instructions: "", jobInMemory: true, look: BotLook(color: .mint, shape: .round, face: .calm),
                        machine: nil, project: nil, folder: "/bots/bot_scout", sessionID: "ses_scout", created: .now, model: nil, personality: nil)
        let drawn = try FileLinkingParser(folders: { [] }, mentions: [scout], highlight: find.highlight(for: "gm-1")).attributedString(for: reply)
        #expect(find.places.count == 1)
        #expect(placeColors(in: drawn) == [FindText.currentPlace])
    }

    /// A long message (a pasted log) of many runs, bold and links among them: each place is
    /// marked, the one you're on orange, and its words and links stay as they were.
    @Test func everyPlaceInALongMessageIsMarked() {
        var text = AttributedString()
        for line in 0..<300 {
            var bold = AttributedString("Config \(line): ")
            bold.inlinePresentationIntent = .stronglyEmphasized
            var link = AttributedString("the config docs")
            link.link = URL(string: "https://example.com/\(line)")
            text += bold + link + AttributedString(", then more config.\n")
        }
        var marked = text
        FindText.mark(&marked, FindHighlight(query: "config", current: 451))
        let places = placeColors(in: marked)
        #expect(places.count == 900)
        #expect(places.firstIndex(of: FindText.currentPlace) == 451)
        #expect(places.count { $0 == FindText.currentPlace } == 1)
        #expect(String(marked.characters) == String(text.characters))
        #expect(marked.runs[\.link].compactMap(\.0) == text.runs[\.link].compactMap(\.0))
        #expect(marked.runs[\.inlinePresentationIntent].compactMap(\.0).count == 300)
    }

    /// The places marked in `text`, as drawn.
    private func marks(in text: AttributedString) -> Int {
        placeColors(in: text).count
    }

    /// The color each place marked in `text` is drawn in, in order.
    private func placeColors(in text: AttributedString) -> [Color] {
        var colors: [Color] = []
        var inMark = false
        for run in text.runs {
            let color = run.swiftUI.backgroundColor.flatMap { [FindText.place, FindText.currentPlace].contains($0) ? $0 : nil }
            if let color, !inMark { colors.append(color) }
            inMark = color != nil
        }
        return colors
    }
}
