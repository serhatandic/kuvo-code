import ClientDesign
import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// New Bot's templates and the looks a box gives its bots, as every box words them (`BotWords`): a
/// personality a template names is one of the presets, each template is its own, and every look is
/// one this app can draw. (Its first message, which its box types in for you, is the bridge's to
/// word: bots-mac.test.js.)
@MainActor
@Suite struct BotTemplatesTests {
    @Test func eachTemplatesPersonalityComesAlong() {
        for template in BotTemplate.all {
            if let personality = template.personality {
                #expect(Personalities.presets.contains { $0.id == personality }, "\(template.name) names a personality that isn't there: \(personality)")
            }
            #expect(!template.name.isEmpty && !template.job.isEmpty)
        }
    }

    @Test func eachTemplateIsItsOwn() {
        #expect(BotTemplate.all.count > 1)
        #expect(Set(BotTemplate.all.map(\.id)).count == BotTemplate.all.count)
        #expect(Set(BotTemplate.all.map(\.name)).count == BotTemplate.all.count)
    }

    /// A bot a box makes (from a template, or picked at random there) looks the way New Bot and the
    /// sidebar draw it: the box's looks are exactly this app's.
    @Test func everyLookABoxGivesIsOneThisAppDraws() {
        let looks = BotWords.shipped.looks
        #expect(looks.colors == BotLook.Tint.allCases.map(\.rawValue))
        #expect(looks.shapes == BotLook.Form.allCases.map(\.rawValue))
        #expect(looks.faces == BotLook.Face.allCases.map(\.rawValue))
        for template in BotWords.shipped.templates {
            #expect(looks.colors.contains(template.look.color) && looks.shapes.contains(template.look.shape) && looks.faces.contains(template.look.face), "\(template.name)")
        }
        // Kuvo Code's own personalities, each with a tile.
        #expect(Personalities.presets.count == BotWords.shipped.personalities.count && Personalities.presets.allSatisfy { !$0.symbol.isEmpty })
    }
}
