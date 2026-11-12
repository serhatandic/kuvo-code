import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// What a conversation's model button, Send and a sign-in card show, from what its box says of its
/// model (`kuvo/sessions/models`), as the box answers it: the Mac and the phone draw the same from
/// it (#572: each decided for itself before, and they disagreed on the same conversation).
struct SessionModelStateTests {
    private func state(_ json: String) throws -> SessionModelState {
        try JSONDecoder().decode(SessionModelState.self, from: Data(json.utf8))
    }

    @Test func aModelThatRunsIsNamedAndSends() throws {
        let fine = try state(#"{"model":{"providerID":"claude-code","id":"default"},"name":"Opus 5.5","runs":true}"#)
        #expect(fine.namesModel)
        #expect(fine.refusal(accounts: "Settings › Accounts") == nil)
        #expect(ComposerSend(ready: true, text: "Fix the build", hasModel: fine.namesModel) == .send)
    }

    /// Signed out, or a key missing: the button keeps the model's name, and a message on it says
    /// what to do instead of going; the card's Sign In says what it does.
    @Test func anAccountThatNeedsSomethingSaysWhat() throws {
        let out = try state(#"{"model":{"providerID":"github-copilot","id":"gpt-5.5"},"name":"GPT-5.5","runs":false,"missing":"signIn","account":{"id":"github-copilot","name":"GitHub Copilot"}}"#)
        #expect(out.namesModel)
        #expect(out.refusal(there: " on Studio Mac", accounts: "Accounts") == "GPT-5.5 needs a sign-in on Studio Mac: sign in to GitHub Copilot in Accounts, or choose another model.")
        #expect(out.signInHelp("github-copilot") == "Sign in to GitHub Copilot")
        #expect(out.signInHelp("anthropic") == nil, "another account's card says its own")

        let key = try state(#"{"model":{"providerID":"deepseek","id":"deepseek-chat"},"name":"DeepSeek Chat","runs":false,"missing":"key","account":{"id":"deepseek","name":"DeepSeek"}}"#)
        #expect(key.refusal(accounts: "Settings › Accounts") == "DeepSeek Chat needs a DeepSeek key: add one in Settings › Accounts, or choose another model.")
        #expect(key.signInHelp("deepseek") == "Add a DeepSeek key")

        let install = try state(#"{"model":{"providerID":"cursor","id":"composer-2"},"runs":false,"missing":"install","account":{"id":"cursor","name":"Cursor"}}"#)
        #expect(install.namesModel)
        #expect(install.refusal(accounts: "Accounts", shownName: "Composer 2") == "Composer 2 needs Cursor installed: install it in Accounts, or choose another model.")
        #expect(install.accountStep(for: "cursor")?.title == "Install")
        #expect(out.accountStep(for: "github-copilot")?.title == "Sign In")
        #expect(out.cardButton(for: ModelRef(id: "gpt-5.5", providerID: "github-copilot"), ended: true) == "Sign In Again")
        #expect(install.cardButton(for: ModelRef(id: "composer-2", providerID: "cursor"), ended: false) == "Install")
    }

    /// The engine's xAI model with no key, while a SuperGrok plan is signed in to through Grok: a
    /// key, or a model under Grok, never "sign in to Grok" (#338's leftover: the card's Sign In said
    /// to sign in to the plan, while it opens the key sheet).
    @Test func aPlanThatGoesThroughItsAgentSaysAKeyOrItsAgentsModels() throws {
        let xai = try state(#"{"model":{"providerID":"xai","id":"grok-4.7"},"name":"Grok 4.7","runs":false,"missing":"key","account":{"id":"xai","name":"xAI"},"plan":{"name":"SuperGrok","agent":"Grok","provider":"grok-cli"}}"#)
        #expect(xai.refusal(there: " on devbox", accounts: "Accounts") == "Grok 4.7 needs an xAI key on devbox: add one in Accounts, or choose another model (with a SuperGrok plan, one under Grok).")
        #expect(xai.signInHelp("xai", there: " on devbox") == "Add an xAI key on devbox (with a SuperGrok plan, choose a model under Grok instead)")
        // Its card's button says what it does: it opens the key sheet.
        #expect(xai.accountStep(for: "xai")?.title == "Add Key")
        #expect(xai.accountStep(for: "grok-cli") == nil, "another account's card is its own")
        let grok = ModelRef(id: "grok-4.7", providerID: "xai")
        #expect(xai.cardButton(for: grok, ended: false) == "Add Key")
        #expect(xai.cardButton(for: grok, ended: true) == "Add Key", "a key, even where a sign-in ended")
        #expect(xai.cardButton(for: ModelRef(id: "opus", providerID: "claude-code"), ended: true) == nil, "a card about another account: the app's own words")
        #expect(xai.cardButton(for: ModelRef(id: "grok-4.5", providerID: "xai"), ended: false) == nil, "a turn that failed on another model than the conversation's now: the app's own words")
    }

    /// A model gone from its provider's list (a coding agent's dropped while it's signed in, #338's
    /// leftover): the button asks for another, and Send waits for one, rather than sending it to fail.
    @Test func aModelGoneAsksForAnother() throws {
        let gone = try state(#"{"model":{"providerID":"claude-code","id":"claude-opus-4-1"},"runs":false,"missing":"gone","account":{"id":"claude-code","name":"Claude Code"}}"#)
        #expect(!gone.namesModel)
        #expect(ComposerSend(ready: true, text: "Fix the build", hasModel: gone.namesModel) == .chooseModel)
        #expect(gone.refusal(accounts: "Accounts", shownName: "Opus 4.1") == "Opus 4.1 is no longer among Claude Code’s models: choose another model.")
        #expect(gone.signInHelp("claude-code") == nil, "nothing to sign in to")
        #expect(gone.accountStep == nil)
        let none = try state(#"{"model":null,"runs":false,"missing":"model"}"#)
        #expect(!none.namesModel)
    }

    /// What the box says is of the model it was asked about: once another is picked, until it's
    /// asked again, it's not this one's.
    @Test func itIsSaidOfTheModelItNames() throws {
        let gone = try state(#"{"model":{"providerID":"claude-code","id":"claude-opus-4-1"},"runs":false,"missing":"gone"}"#)
        #expect(gone.isAbout(ModelRef(id: "claude-opus-4-1", providerID: "claude-code", variant: "high")))
        #expect(!gone.isAbout(ModelRef(id: "claude-opus-5-5", providerID: "claude-code")))
        #expect(gone.isAbout(nil), "a session with no model of its own runs on the one the box names")
    }

    /// A newer box's word this one doesn't know: the model's name, and a message on it refused.
    @Test func aWordFromANewerBoxRefusesWithoutBreaking() throws {
        let newer = try state(#"{"model":{"providerID":"x","id":"y"},"runs":false,"missing":"paused","future":1}"#)
        #expect(newer.missing == .other("paused"))
        #expect(newer.namesModel)
        #expect(newer.refusal(accounts: "Accounts") == "y can’t run now: choose another model.")
        let answer = try JSONDecoder().decode(SessionModelStates.self, from: Data(#"{"sessions":{"ses_a":{"model":null,"runs":false,"missing":"model"}}}"#.utf8))
        #expect(answer.sessions["ses_a"]?.missing == .model)
        #expect(SessionModelState.path(["ses_a", "ses_b"]) == "kuvo/sessions/models?sessions=ses_a,ses_b")
        let xiaomi = SessionModelState(model: ModelRef(id: "mimo", providerID: "xiaomi"), runs: false, missing: .key, account: .init(id: "xiaomi", name: "Xiaomi"))
        #expect(xiaomi.signInHelp("xiaomi") == "Add a Xiaomi key")
    }
}
