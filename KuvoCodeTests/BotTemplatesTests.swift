import Foundation
import Testing
@testable import KuvoCode

/// New Bot's templates: a personality a template names is one of the presets, so it comes along,
/// and each template is its own. (Its first message, which its box types in for you, is the bridge's
/// to word: bots-mac.test.js.)
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
}
