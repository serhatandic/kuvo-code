import Foundation
import Testing
@testable import OpenCodeKit

// "/review with <model> <what to look at>": who reads it is the longest of the conversation's
// models whose name it starts with, the one picked before of two named alike, and the rest is what
// to look at; words naming none yet are what "Who reads it" looks for.

private let flash = ReviewCommand.Reader(name: "DeepSeek V4.1 Flash", ref: ModelRef(id: "v4.1-flash", providerID: "deepseek"))
private let claude = ReviewCommand.Reader(name: "Claude", ref: ModelRef(id: "claude", providerID: "x"))
private let sonnet = ReviewCommand.Reader(name: "Claude Sonnet 4.5", ref: ModelRef(id: "sonnet-4.5", providerID: "anthropic"))
private let copilotSonnet = ReviewCommand.Reader(name: "Claude Sonnet 4.5", ref: ModelRef(id: "claude-sonnet-4.5", providerID: "github-copilot"))
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
}

@Test func withoutWithItsTheConversationsOwnModelAndAllOfItIsWhatToLookAt() {
    let command = ReviewCommand(" the pause handling", readers: readers)
    #expect(command.reader == nil)
    #expect(command.focus == "the pause handling")
    #expect(command.searching == nil)
    // "without" isn't "with".
    #expect(ReviewCommand(" without the tests", readers: readers).focus == "without the tests")
}

@Test func withAndWordsNamingNoneYetAreLookedFor() {
    #expect(ReviewCommand(" with deep", readers: readers).searching == "deep")
    #expect(ReviewCommand(" with ", readers: readers).searching == "")
    #expect(ReviewCommand(" with", readers: readers).searching == "")
    #expect(ReviewCommand(" with deep", readers: readers).reader == nil)
}
