import Foundation
import Testing
@testable import KuvoCode

/// "&" in a composer names another conversation (a bot or a session): the list opens as you type
/// a name, the best matches first, picking one writes its name, and the names in a message are
/// found as written, whole, for your bubble to color and the agent to be told who they are.
@MainActor
@Suite struct AgentReferencesTests {
    private func agent(_ name: String, _ session: String, kind: String = "session", project: String? = nil) -> AgentMail.Agent {
        AgentMail.Agent(session: session, name: name, kind: kind, project: project)
    }

    @Test(arguments: [
        ("Ask &Fix lo", "Fix lo"),
        ("&Ada", "Ada"),
        ("first line\nthen &Bo", "Bo"),
        ("&", ""),
    ])
    func theNameBeingTyped(text: String, query: String) {
        #expect(AgentReferences.query(in: text)?.query == query)
    }

    /// Not a name: "&" inside a word, a space right after it, or a name that went on to a new line.
    @Test(arguments: ["salt&pepper", "Tom & Jerry", "&Ada\nand more"])
    func notANameBeingTyped(text: String) {
        #expect(AgentReferences.query(in: text) == nil)
    }

    @Test func theBestMatchesFirst() {
        let agents = [
            agent("Release notes", "s1"), agent("Fix login", "s2"), agent("Login page polish", "s3"),
            agent("Blogging bot", "s4", kind: "bot"), agent("Ops", "s5", project: "login-service"), agent("Log", "s6"),
        ]
        // The name itself, then names starting with it, then a word starting with it, then names
        // containing it, then projects.
        #expect(AgentReferences.matches("log", in: agents).map(\.session) == ["s6", "s3", "s2", "s4", "s5"])
        // Past a space, only names that go on that way.
        #expect(AgentReferences.matches("fix l", in: agents).map(\.session) == ["s2"])
        #expect(AgentReferences.matches("", in: agents, limit: 2).map(\.session) == ["s1", "s2"])
    }

    /// A phone's message sent again (Retry, Edit) still ending with the block it had: that goes, and
    /// its agents are named afresh, rather than the old block coming back escaped into its words.
    @Test func aMessageSentAgainIsNamedOnce() throws {
        let block = try #require(AgentReferences.note(naming: [agent("Scout", "ses_x")], here: nil))
        let start = String(try #require(block.split(separator: "\n").first))
        let named = AgentReferences.naming(in: "Ask &Scout to look\n\n" + block, excluding: nil, here: nil)
        #expect(SentMessage.split(named).text == "Ask &Scout to look")
        #expect(named.components(separatedBy: start).count <= 2)
    }

    /// Who a message from a phone names, told at its end, as every box tells it: the cases this
    /// Mac and the boxes' `nameAgents` both read (`names/agent-naming.json`).
    @Test func namedAsEveryBoxNamesThem() throws {
        struct Vector: Decodable {
            struct Case: Decodable { var about: String; var message: String; var excluding: String?; var here: String?; var expected: String }
            var agents: [AgentMail.Agent]
            var cases: [Case]
        }
        let file = try #require(RouteScenarios.folder).appending(path: "names/agent-naming.json")
        let vector = try JSONDecoder().decode(Vector.self, from: Data(contentsOf: file))
        #expect(vector.cases.count >= 9)
        for each in vector.cases {
            #expect(AgentReferences.naming(in: each.message, excluding: each.excluding, here: each.here, agents: vector.agents) == each.expected, "\(each.about)")
        }
    }

    /// A message sent before the note's words changed still reads as naming its agents.
    @Test func anEarlierNoteStillReads() {
        let earlier = "Ask &Scout\n\n<named-agents>\nAgents the user named with & in this message. Read one's conversation with read_conversation, or write to it with send_message, by its address:\n- &Scout (ses_x): session, on the Mac\n</named-agents>"
        let (text, references) = AgentReferences.split(earlier)
        #expect(text == "Ask &Scout")
        #expect(references.map(\.session) == ["ses_x"])
    }

    @Test func pickingOneWritesItsName() {
        let picked = AgentReferences.insert(agent("Fix login", "s2"), into: "Ask &fi")
        #expect(picked == "Ask &Fix login ")
    }

    /// Each name as written, whole: a longer name over one it starts with, case and accents aside,
    /// not inside a word, last first.
    @Test func namesInAMessage() {
        let references = [AgentReferences.Reference(name: "Mira", session: "s1"), AgentReferences.Reference(name: "Miranda", session: "s2"),
                          AgentReferences.Reference(name: "Zoë", session: "s3")]
        let text = "Ask &Miranda and &mira, then &ZOE. Not email&Mira or &Mirage."
        let found = AgentReferences.find(in: text, references: references)
        #expect(found.map(\.reference.session) == ["s3", "s1", "s2"])
        #expect(found.map { String(text[$0.range]) } == ["&ZOE", "&mira", "&Miranda"])
    }

    /// Backspace right after a name takes all of it; anywhere else (inside it, after the space
    /// that follows, with text selected) it's an ordinary backspace.
    @Test func backspaceAfterANameTakesItWhole() {
        let references = [AgentReferences.Reference(name: "Fix login", session: "s1")]
        let text = "Ask &Fix login about it"
        let end = ("Ask &Fix login" as NSString).length
        #expect(FieldMentionStyle.name(endingAt: NSRange(location: end, length: 0), in: text, references: references) == NSRange(location: 4, length: 10))
        #expect(FieldMentionStyle.name(endingAt: NSRange(location: end - 2, length: 0), in: text, references: references) == nil)
        #expect(FieldMentionStyle.name(endingAt: NSRange(location: end + 1, length: 0), in: text, references: references) == nil)
        #expect(FieldMentionStyle.name(endingAt: NSRange(location: end, length: 3), in: text, references: references) == nil)
    }
}
