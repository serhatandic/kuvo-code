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
}
