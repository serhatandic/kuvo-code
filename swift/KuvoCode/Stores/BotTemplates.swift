import ClientDesign
import Foundation
import KuvoLink

/// Bots to start from when making one: a name, a look and a personality that fit, and a job, which
/// the box makes the bot with types in its new conversation for you to change and send. Worded
/// with what a box makes its bots with (`BotWords`), so every box offers the same ones.
struct BotTemplate: Identifiable {
    let id: String
    let name: String
    let job: String
    let instructions: String
    let look: BotLook
    /// A preset's ID, from `Personalities.presets`.
    let personality: String?
    /// It works on a project's code, so it's best made in one.
    var wantsProject = false

    static let all: [BotTemplate] = BotWords.shipped.templates.map { template in
        BotTemplate(id: template.id, name: template.name, job: template.job, instructions: template.instructions,
                    look: BotLook(color: BotLook.Tint(rawValue: template.look.color) ?? .graphite, shape: BotLook.Form(rawValue: template.look.shape) ?? .round,
                                  face: BotLook.Face(rawValue: template.look.face) ?? .calm),
                    personality: template.personality, wantsProject: template.wantsProject)
    }
}
