import Foundation
import Testing
@testable import KuvoCode

/// "&" in a composer names another conversation (a bot or a session): the list opens as you type
/// a name, the best matches first, picking one writes its name, and the names in a message are
/// found as written, whole, for your bubble to color. (Who they are, the agent is told by its box:
/// protocol/vectors/message-parts.json.)
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

    /// Picking one writes its name, and a message naming it says which was picked, for its box to
    /// name that one where another has the same name (`MessageParts.Sending.named`).
    @Test func pickingOneWritesItsName() {
        let picked = AgentReferences.insert(agent("Fix login", "s2"), into: "Ask &fi")
        #expect(picked == "Ask &Fix login ")
        #expect(AgentReferences.picked(in: picked + "now").contains("s2"))
        #expect(!AgentReferences.picked(in: "Ask nobody").contains("s2"))
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
}
