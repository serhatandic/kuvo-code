import Foundation
import Testing
@testable import OpenCodeKit

// "/review with <model> <what to look at>": who reads it is the longest of the conversation's
// models whose name it starts with, the one picked before of two named alike, and the rest is what
// to look at; words naming none yet are what "Who reads it" looks for.

private let flash = ReviewCommand.Reader(name: "DeepSeek V4.1 Flash", ref: ModelRef(id: "v4.1-flash", providerID: "deepseek"), provider: "DeepSeek")
private let claude = ReviewCommand.Reader(name: "Claude", ref: ModelRef(id: "claude", providerID: "x"), provider: "X")
private let sonnet = ReviewCommand.Reader(name: "Claude Sonnet 4.5", ref: ModelRef(id: "sonnet-4.5", providerID: "anthropic"), provider: "Anthropic")
private let copilotSonnet = ReviewCommand.Reader(name: "Claude Sonnet 4.5", ref: ModelRef(id: "claude-sonnet-4.5", providerID: "github-copilot"), provider: "GitHub Copilot")
private let readers = [flash, claude, sonnet, copilotSonnet]

@Test func whoReadsItAndWhatToLookAtAreReadApart() {
    let command = ReviewCommand(" with DeepSeek V4.1 Flash the pause handling", readers: readers)
    #expect(command.reader == flash)
    #expect(command.focus == "the pause handling")
    #expect(command.readerLength == " with DeepSeek V4.1 Flash".utf16.count)
    // Written in any case, and alone.
    #expect(ReviewCommand(" WITH deepseek v4.1 flash", readers: readers).reader == flash)
}

@Test func theLongestNameItStartsWithReadsItAndOfTwoAlikeTheOnePickedBefore() {
    #expect(ReviewCommand(" with Claude Sonnet 4.5 the tests", readers: readers).reader == sonnet)
    #expect(ReviewCommand(" with Claude the tests", readers: readers).reader == claude)
    #expect(ReviewCommand(" with Claude Sonnet 4.5", readers: readers, preferring: copilotSonnet.ref).reader == copilotSonnet)
    // A name is a whole word: "Claudette" isn't Claude.
    #expect(ReviewCommand(" with Claudette", readers: readers).reader == nil)
    // Still being typed, the longer names it starts are offered.
    #expect(ReviewCommand.longer(than: " with Claude", readers: readers) == [sonnet, copilotSonnet])
    #expect(ReviewCommand.longer(than: " with Claude ", readers: readers).isEmpty)
}

@Test func withoutWithItsTheConversationsOwnModelAndAllOfItIsWhatToLookAt() {
    let command = ReviewCommand(" the pause handling", readers: readers)
    #expect(command.reader == nil)
    #expect(command.focus == "the pause handling")
    #expect(command.searching == nil)
    // "without" isn't "with".
    #expect(ReviewCommand(" without the tests", readers: readers).focus == "without the tests")
}

@Test func withAndWordsThatCanBeNoModelAreWhatToLookAt() {
    let command = ReviewCommand(" with an eye on error handling", readers: readers)
    #expect(command.reader == nil)
    #expect(command.searching == nil)
    #expect(command.focus == "with an eye on error handling")
}

@Test func aSearchFindsAModelByItsNameOrWhoServesIt() {
    #expect(ReviewCommand.search("copilot sonnet", in: readers) == [copilotSonnet])
    #expect(ReviewCommand.search("sonnet", in: readers) == [sonnet, copilotSonnet])
    #expect(ReviewCommand(" with copilot son", readers: readers).searching == "copilot son")
}

@Test func withAndWordsNamingNoneYetAreLookedFor() {
    #expect(ReviewCommand(" with deep", readers: readers).searching == "deep")
    #expect(ReviewCommand(" with ", readers: readers).searching == "")
    #expect(ReviewCommand(" with", readers: readers).searching == "")
    #expect(ReviewCommand(" with deep", readers: readers).reader == nil)
}

// A whole-project review, as the box keeps it while it reads in parts: what it reads and how far
// along it is come through, and a scope goes to the box in its own words.
@Test func aScopedReviewReadsAsTheBoxSaysIt() throws {
    let kept = #"{"id":"rev_1","session":"ses_1","state":"reviewing","scope":{"kind":"project"},"focus":"security","progress":{"read":4,"of":9},"findings":[],"started":1}"#
    let review = try JSONDecoder().decode(Review.self, from: Data(kept.utf8))
    #expect(review.scope == .project)
    #expect(review.progress?.read == 4 && review.progress?.of == 9)
    // One of the changes not committed yet says no scope.
    let plain = try JSONDecoder().decode(Review.self, from: Data(#"{"id":"rev_2","session":"ses_1","state":"done","findings":[],"started":1}"#.utf8))
    #expect(plain.scope == nil && plain.progress == nil)

    let said = { (scope: ReviewScope) in try JSONSerialization.jsonObject(with: JSONEncoder().encode(scope)) as? [String: String] }
    #expect(try said(.branch(base: nil)) == ["kind": "branch"])
    #expect(try said(.commits(from: "abc", to: "def")) == ["kind": "commits", "from": "abc", "to": "def"])
    #expect(try said(.folder("src/auth")) == ["kind": "folder", "path": "src/auth"])
    #expect(try JSONDecoder().decode(ReviewScope.self, from: JSONEncoder().encode(ReviewScope.commits(from: "abc", to: nil))) == .commits(from: "abc", to: nil))
}

// "/review the whole project for security with Claude Sonnet 4.5 the sign-in": what it reads,
// what it looks for and who reads it, in any order, then your own words; all but your words are
// drawn with the keyword.
@Test func whatItReadsWhatItLooksForAndWhoReadsItAreReadInAnyOrder() {
    let command = ReviewCommand(" the whole project for security with Claude Sonnet 4.5 the sign-in", readers: readers)
    #expect(command.scope == .project)
    #expect(command.preset == .security)
    #expect(command.reader == sonnet)
    #expect(command.focus == "the sign-in")
    #expect(command.focusAsked == "security: the sign-in")
    #expect(command.readerLength == " the whole project for security with Claude Sonnet 4.5".utf16.count)
    #expect(command.asking == nil)

    let other = ReviewCommand(" with Claude for performance this branch", readers: readers)
    #expect(other.reader == claude && other.preset == .performance && other.scope == .branch(base: nil))
    #expect(other.focusAsked == "performance")
    // "since" a commit starts with it; a folder's path can be quoted.
    #expect(ReviewCommand(" since abc1234 for accessibility", readers: readers).scope == .commits(from: "abc1234^", to: nil))
    #expect(ReviewCommand(#" folder "My Docs" the links"#, readers: readers).scope == .folder("My Docs"))
    #expect(ReviewCommand(#" folder "My Docs" the links"#, readers: readers).focus == "the links")
    #expect(ReviewCommand.phrase(.folder("My Docs")) == #"folder "My Docs""#)
    #expect(ReviewCommand.phrase(.commits(from: "abc1234^", to: nil)) == "since abc1234")
    // Words after "for" are what to look at; with something named to read, words of your own too.
    #expect(ReviewCommand(" for the tests", readers: readers).focusAsked == "the tests")
    #expect(ReviewCommand(" for the tests", readers: readers).scopeAsked == nil)
}

// The composer's lists follow what's typed: What to review first, then Look for; a commit or a
// folder while one is typed after "since " or "folder "; your own words close them.
@Test func theListsFollowWhatsTyped() {
    #expect(ReviewCommand(" ", readers: readers).asking == .what(""))
    #expect(ReviewCommand(" the wh", readers: readers).asking == .what("the wh"))
    #expect(ReviewCommand(" changes not committed yet ", readers: readers).asking == .lookFor(""))
    #expect(ReviewCommand(" this branch for sec", readers: readers).asking == .lookFor("for sec"))
    #expect(ReviewCommand(" this branch for security ", readers: readers).asking == nil)
    // Something else… writes "for ": words of your own come after it, no list.
    #expect(ReviewCommand(" this branch for ", readers: readers).asking == nil)

    let commit = ReviewCommand(" for security since ab", readers: readers)
    #expect(commit.asking == .commit("ab"))
    #expect(commit.head == " for security ")
    #expect(ReviewCommand(" since ", readers: readers).asking == .commit(""))
    #expect(ReviewCommand(" since ", readers: readers).scope == nil)
    #expect(ReviewCommand(" folder src/au", readers: readers).asking == .folder("src/au"))
    #expect(ReviewCommand(" folder src/auth ", readers: readers).asking == .lookFor(""))

    // A model picked first: What to review still follows.
    #expect(ReviewCommand(" with Claude Sonnet 4.5 ", readers: readers).asking == .what(""))
    #expect(ReviewCommand(" this branch with ", readers: readers).searching == "")
    #expect(ReviewCommand(" this branch with ", readers: readers).head == " this branch ")
    #expect(ReviewCommand(" an eye on the tests", readers: readers).asking == nil)
    #expect(ReviewCommand.longer(than: " this branch with Claude", readers: readers) == [sonnet, copilotSonnet])
}

// Something else… in What to review: what to review in your own words, after "about", in quotes
// once its row is picked; it's the box that finds the files, so only the words go to it, and a
// review comes back with the files it found.
@Test func whatToReviewCanBeSaidInYourOwnWords() throws {
    // Words of your own, nothing named before them: what to review, sent as written, the box
    // finding its files; none of them drawn with the keyword.
    let command = ReviewCommand(" the new changes to the sign-in", readers: readers)
    #expect(command.scope == nil)
    #expect(command.described == "the new changes to the sign-in")
    #expect(command.scopeAsked == .described("the new changes to the sign-in"))
    #expect(command.focusAsked == nil)
    #expect(command.readerLength == 0)
    #expect(command.asking == nil)
    // After what to look for, or who reads it, they're what to look at, as they always were.
    let named = ReviewCommand(" for security with Claude Sonnet 4.5 the tokens", readers: readers)
    #expect(named.scopeAsked == nil)
    #expect(named.focusAsked == "security: the tokens")
    #expect(ReviewCommand(" with Claude the tokens", readers: readers).described == nil)
    // Nothing written reviews the changes not committed yet, as ever; with something named to
    // read, your words are what to look at.
    #expect(ReviewCommand(" ", readers: readers).scopeAsked == nil)
    #expect(ReviewCommand(" this branch the tokens", readers: readers).described == nil)
    #expect(ReviewCommand(" this branch the tokens", readers: readers).focusAsked == "the tokens")
    #expect(ReviewCommand.phrase(.described("the sign-in")) == "the sign-in")

    let said = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ReviewScope.described("files I touched today", paths: ["a.ts"]))) as? [String: String]
    #expect(said == ["kind": "described", "words": "files I touched today"])
    let kept = #"{"id":"rev_1","session":"ses_1","state":"done","scope":{"kind":"described","words":"the auth module","paths":["src/auth/login.ts"]},"findings":[],"started":1}"#
    let review = try JSONDecoder().decode(Review.self, from: Data(kept.utf8))
    #expect(review.scope == .described("the auth module", paths: ["src/auth/login.ts"]))
    #expect(review.scope?.title == "“the auth module”")
}

// A folder's path can be in curly quotes, as the field types them.
@Test func aFoldersPathCanBeInCurlyQuotes() {
    #expect(ReviewCommand(#" folder “My Docs” the links"#, readers: readers).scope == .folder("My Docs"))
}

// From review: a pick after typed words goes after a space; the short words the lists are found by
// are read too; a model named after your own words reads it; a coding agent's conversation looks
// for no model.
@Test func picksShortWordsAndAModelAfterYourWordsAreRead() {
    #expect(ReviewCommand(" for security", readers: readers).head == " for security ")
    #expect(ReviewCommand(" this branch", readers: readers).head == " this branch ")
    #expect(ReviewCommand(" project ", readers: readers).scope == .project)
    #expect(ReviewCommand(" branch for security", readers: readers).scope == .branch(base: nil))
    #expect(ReviewCommand(" uncommitted", readers: readers).scope == .uncommitted)

    let late = ReviewCommand(" for the sign-in with Claude Sonnet 4.5", readers: readers)
    #expect(late.reader == sonnet)
    #expect(late.focus == "the sign-in")
    // Coding agents: "with" is your words.
    let agent = ReviewCommand(" this branch with ", readers: [])
    #expect(agent.searching == nil)
    // "since" or "folder" sent alone: still to be written, not words to look at.
    #expect(ReviewCommand(" since", readers: readers).asking == .commit(""))
    #expect(ReviewCommand(" for security folder", readers: readers).asking == .folder(""))
    #expect(ReviewCommand(" for security folder", readers: readers).scope == nil)
}
