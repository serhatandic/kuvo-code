import ClientDesign
import Foundation
import Testing

/// A bot's look as a computer says it: one made by a newer Kuvo Code (a color, shape or face this
/// copy doesn't know) still shows, plainly, as the box itself shows a look it doesn't know, and a
/// list of bots with it in isn't lost.
@Suite struct BotLookTests {
    struct Listed: Decodable { var name: String; var look: BotLook }

    @Test func aLookFromANewerKuvoCodeShowsPlainly() throws {
        let json = #"""
        [{"name": "Ada", "look": {"color": "mint", "shape": "gem", "face": "wink"}},
         {"name": "Newer", "look": {"color": "teal", "shape": "star", "face": "dizzy"}}]
        """#
        let bots = try JSONDecoder().decode([Listed].self, from: Data(json.utf8))
        #expect(bots.map(\.name) == ["Ada", "Newer"])
        #expect(bots[0].look == BotLook(color: .mint, shape: .gem, face: .wink))
        #expect(bots[1].look == BotLook(color: .graphite, shape: .round, face: .calm))
    }
}
