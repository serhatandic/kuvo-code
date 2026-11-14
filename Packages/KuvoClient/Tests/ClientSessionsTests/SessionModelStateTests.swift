import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// What a conversation's model button, Send and a sign-in card show, from what its box says of its
/// model (`kuvo/sessions/models`), as the box answers it: the Mac and the phone draw the same from
/// it (#572: each decided for itself before, and they disagreed on the same conversation), and since
/// #668 the box words it too, so neither decides it nor says it differently.
struct SessionModelStateTests {
    private func state(_ json: String) throws -> SessionModelState {
        try JSONDecoder().decode(SessionModelState.self, from: Data(json.utf8))
    }

    /// Every case of Packages/KuvoLink/Vectors/model-readiness.json, which the box words and gpui
    /// draws too: what the box says, read as it answers it (its facts and words together), drawn as
    /// it says: the refusal shown as it is, "Choose a Model" only where it says to choose, and the
    /// action's words on a sign-in card.
    @Test func drawsWhatTheBoxSaysForEveryCase() throws {
        let file = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../KuvoLink/Vectors/model-readiness.json").standardized
        let vectors = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let cases = try #require(vectors["cases"] as? [[String: Any]])
        #expect(cases.count >= 10)
        for each in cases {
            let about = each["about"] as? String ?? ""
            var answer = try #require(each["state"] as? [String: Any])
            let readiness = try #require(each["readiness"] as? [String: Any])
            answer.merge(readiness) { _, said in said }
            let said = try JSONDecoder().decode(SessionModelState.self, from: JSONSerialization.data(withJSONObject: answer))
            #expect(said.refusal == readiness["refusal"] as? String, "\(about)")
            #expect(said.namesModel == (readiness["choose"] as? Bool != true), "\(about)")
            #expect(ComposerSend(ready: true, text: "Fix the build", hasModel: said.namesModel) == (said.choose ? .chooseModel : .send), "\(about)")
            let action = readiness["action"] as? [String: Any]
            #expect(said.action?.label == action?["label"] as? String, "\(about)")
            #expect(said.action?.help == action?["help"] as? String, "\(about)")
            // A sign-in card for its account says what its button does, as the box words it.
            if let account = said.account, said.needsAccount {
                #expect(said.signInHelp(account.id) == action?["help"] as? String, "\(about)")
            }
        }
    }

    /// Signed out, or a key missing: the button keeps the model's name, and a message on it says
    /// what to do instead of going; the card's button says what it does.
    @Test func anAccountThatNeedsSomethingSaysWhat() throws {
        let out = try state(#"{"model":{"providerID":"github-copilot","id":"gpt-5.5"},"name":"GPT-5.5","runs":false,"missing":"signIn","account":{"id":"github-copilot","name":"GitHub Copilot"},"refusal":"GPT-5.5 needs a sign-in to GitHub Copilot: sign in, or choose another model.","action":{"do":"signIn","label":"Sign In","help":"Sign in to GitHub Copilot"}}"#)
        #expect(out.namesModel)
        #expect(out.needsAccount)
        #expect(out.signInHelp("anthropic") == nil, "another account's card says its own")
        #expect(out.cardButton(for: ModelRef(id: "gpt-5.5", providerID: "github-copilot"), ended: true) == "Sign In Again")
        #expect(out.cardButton(for: ModelRef(id: "gpt-5.5", providerID: "github-copilot"), ended: false) == "Sign In")

        let xai = try state(#"{"model":{"providerID":"xai","id":"grok-4.7"},"runs":false,"missing":"key","account":{"id":"xai","name":"xAI"},"refusal":"…","action":{"do":"addKey","label":"Add Key","help":"Add an xAI key"}}"#)
        let grok = ModelRef(id: "grok-4.7", providerID: "xai")
        #expect(xai.cardButton(for: grok, ended: true) == "Add Key", "a key, even where a sign-in ended")
        #expect(xai.cardButton(for: ModelRef(id: "opus", providerID: "claude-code"), ended: true) == nil, "a card about another account: the app's own words")
        #expect(xai.cardButton(for: ModelRef(id: "grok-4.5", providerID: "xai"), ended: false) == nil, "a turn that failed on another model than the conversation's now: the app's own words")
    }

    /// A model gone from its provider's list: the button asks for another, Send waits for one, and
    /// there's nothing to sign in to.
    @Test func aModelGoneAsksForAnother() throws {
        let gone = try state(#"{"model":{"providerID":"claude-code","id":"claude-opus-4-1"},"runs":false,"missing":"gone","account":{"id":"claude-code","name":"Claude Code"},"refusal":"…","choose":true,"action":{"do":"choose","label":"Choose a Model","help":"Choose another model"}}"#)
        #expect(!gone.namesModel)
        #expect(ComposerSend(ready: true, text: "Fix the build", hasModel: gone.namesModel) == .chooseModel)
        #expect(gone.signInHelp("claude-code") == nil, "nothing to sign in to")
        #expect(!gone.needsAccount)
        #expect(gone.cardButton(for: ModelRef(id: "claude-opus-4-1", providerID: "claude-code"), ended: false) == nil)
    }

    /// What the box says is of the model it was asked about: once another is picked, until it's
    /// asked again, it's not this one's.
    @Test func itIsSaidOfTheModelItNames() throws {
        let gone = try state(#"{"model":{"providerID":"claude-code","id":"claude-opus-4-1"},"runs":false,"missing":"gone","choose":true}"#)
        #expect(gone.isAbout(ModelRef(id: "claude-opus-4-1", providerID: "claude-code", variant: "high")))
        #expect(!gone.isAbout(ModelRef(id: "claude-opus-5-5", providerID: "claude-code")))
        #expect(gone.isAbout(nil), "a session with no model of its own runs on the one the box names")
    }

    /// A newer box's words this one doesn't know: read, and shown as it says them.
    @Test func wordsFromANewerBoxAreReadWithoutBreaking() throws {
        let newer = try state(#"{"model":{"providerID":"x","id":"y"},"runs":false,"missing":"paused","refusal":"y is paused: try again later.","action":{"do":"wait","label":"Wait","help":"Wait for it"},"future":1}"#)
        #expect(newer.missing == .other("paused"))
        #expect(newer.namesModel)
        #expect(newer.refusal == "y is paused: try again later.")
        #expect(newer.action?.kind == .other("wait"))
        #expect(!newer.needsAccount)
        let answer = try JSONDecoder().decode(SessionModelStates.self, from: Data(#"{"sessions":{"ses_a":{"model":null,"runs":false,"missing":"model","choose":true}}}"#.utf8))
        #expect(answer.sessions["ses_a"]?.missing == .model)
        #expect(SessionModelState.path(["ses_a", "ses_b"]) == "kuvo/sessions/models?sessions=ses_a,ses_b")
    }
}
