import Foundation
import Testing
import ClientText

/// `#243` in a message names Work Queue item 243, drawn as a chip; another's number (a PR, an
/// issue, a step), code, links and web addresses never are.
@Suite struct WorkItemRefsTests {
    @Test(arguments: [
        ("Picked up #243 and #12.", [243, 12]),
        ("#7 first", [7]),
        ("(#243) [#5] {#6} \"#8\" '#9' a/#10, b,#11 – #12 -#13", [243, 5, 6, 8, 9, 10, 11, 12, 13]),
        ("Line one\n#44 on the next", [44]),
        ("PR #12, pr#13, MR #14, pull request #15, Issue #16, step #17, Step#18", []),
        ("the #1 reason, not a#2, #3a, #4_x, #1234567, #0", [1]),
        ("`#5` and ``#6 `x` `` but #7", [7]),
        ("```\n#8\n```\n#9", [9]),
        ("```swift\nlet a = 1 // #10, still writing", []),
        ("[see #11](https://example.com) and ![#12](a.png), but #13", [13]),
        ("https://github.com/a/b/issues/1#issuecomment-2 and www.example.com/#14 then #15", [15]),
        ("gh:owner/repo#12 and jira:KEY-12 aren't ours; #16 is", [16]),
        ("stepped #19, preprocess #20", [19, 20]),
    ])
    func found(text: String, numbers: [Int]) {
        #expect(WorkItemRefs.find(in: text).map(\.number) == numbers)
    }

    @Test(arguments: ["the #1 Google result", "to #1 on Google", "ranked #1", "#1 spot", "#1 on Google", "We’re #1 on Google", "it hit #1 in search", "#1 Google result", "rank #1", "number #1", "#1 result", "#1 place", "#1 position"])
    func ordinalsStayPlain(text: String) {
        #expect(WorkItemRefs.refs(in: text).isEmpty)
    }

    @Test func chipsRequireConversationVisibility() {
        let global = ["1": "Unrelated bot's item", "243": "Our item"]
        let ours = ["243": "Our item"]
        #expect(WorkItemRefs.chipRefs(in: "see #243", known: global, visible: ours) == ours)
        #expect(WorkItemRefs.chipRefs(in: "#243", known: global, visible: [:]).isEmpty)
        #expect(WorkItemRefs.chipRefs(in: "#1", known: global, visible: ours).isEmpty)
        #expect(WorkItemRefs.chipRefs(in: "the #1 Google result", known: global, visible: global).isEmpty)
        #expect(WorkItemRefs.chipRefs(in: "#243 then the #243 result", known: global, visible: ours) == ours)
    }

    @Test(arguments: ["Linked to #243", "Added a note to #243", "Look at #243", "Fix the #243 bug", "Moved it to\n#243", "to #243", "at #243", "the #243", "ranked #243", "#243 result"])
    func realReferencesSurvive(text: String) {
        #expect(WorkItemRefs.chipRefs(in: text, known: [:], visible: ["243": "ours"])["243"] == "ours")
    }

    @Test func aReasonRequiresVisibility() {
        #expect(WorkItemRefs.chipRefs(in: "the #1 reason", known: ["1": "other"], visible: [:]).isEmpty)
        #expect(WorkItemRefs.chipRefs(in: "the #1 reason", known: [:], visible: ["1": "ours"])["1"] == "ours")
    }

    @Test func eachRangeIsTheWrittenReference() {
        let text = "Fix #243 now"
        let found = WorkItemRefs.find(in: text)
        #expect(found.map { String(text[$0.range]) } == ["#243"])
    }

    @Test func numbersComeOnceInOrder() {
        #expect(WorkItemRefs.numbers(in: "#3 then #1 then #3") == [3, 1])
    }

    @Test func aChipsLinkNamesItsItem() {
        let link = WorkItemRefs.link(243)
        #expect(link.absoluteString == "kuvo-item://243")
        #expect(WorkItemRefs.number(in: link) == 243)
        #expect(WorkItemRefs.number(in: URL(string: "kuvo-agent://243")!) == nil)
        #expect(WorkItemRefs.number(in: URL(string: "https://243")!) == nil)
    }

    @Test(arguments: [
        ("Picked up gh:kuvo-test/app#12 after #3.", ["gh:kuvo-test/app#12", "3"]),
        ("(gh:a/b.c#1) and gh:my-org/my_repo#20, x gh:o/r#5", ["gh:a/b.c#1", "gh:my-org/my_repo#20", "gh:o/r#5"]),
        ("`gh:o/r#1` and [gh:o/r#2](https://x.y) and https://github.com/o/r/issues/3", []),
        ("agh:o/r#1 gh:o/r#2x gh:o/r#", []),
        ("gh:o/r-#12 and #3", ["gh:o/r-#12", "3"]),
        ("gh:ada_kuvo/app#7", ["gh:ada_kuvo/app#7"]),
    ])
    func issuesAndPullRequestsAreFoundByTheirRefs(text: String, refs: [String]) {
        #expect(WorkItemRefs.findRefs(in: text).map(\.ref) == refs)
        #expect(WorkItemRefs.findRefs(in: text).map { String(text[$0.range]) } == refs.map { $0.hasPrefix("gh:") ? $0 : "#" + $0 })
    }

    @Test func aChipOfAnIssueLinksToIt() {
        let link = WorkItemRefs.link(ref: "gh:kuvo-test/app#12")
        #expect(WorkItemRefs.ref(in: link) == "gh:kuvo-test/app#12")
        #expect(WorkItemRefs.number(in: link) == nil)
        #expect(WorkItemRefs.ref(in: WorkItemRefs.link(ref: "243")) == "243")
        #expect(WorkItemRefs.link(ref: "243").absoluteString == "kuvo-item://243")
        #expect(WorkItemRefs.refs(in: "gh:o/r#1 #2 gh:o/r#1") == ["gh:o/r#1", "2"])
    }

    @Test func aToolCallOnAnIssueNamesItAsItsChipDoes() {
        #expect(WorkQueueWords.summary("queue_add", item: nil, title: nil, to: nil, category: nil, undo: false, add: nil, isActive: false, issue: "gh:kuvo-test/app#12") == "Added app#12 to the Work Queue")
        #expect(WorkQueueWords.summary("queue_update", item: "#182", title: nil, to: nil, category: nil, undo: false, add: nil, isActive: true, issue: "https://github.com/kuvo-test/app/pull/57") == "Linking #182 to app#57")
        #expect(WorkQueueWords.summary("queue_update", item: "gh:kuvo-test/app#12", title: nil, to: nil, category: nil, undo: false, add: nil, isActive: false) == "Updated app#12")
        #expect(WorkQueueWords.shownRef("#12") == nil)
    }
}

