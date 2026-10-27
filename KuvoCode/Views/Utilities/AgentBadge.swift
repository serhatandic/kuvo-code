import ClientDesign
import SwiftUI

/// Over a page an agent is browsing: who it is, and Take Over, to have the page to yourself while
/// its browser steps wait. Taken over, it says so, with Hand Back.
struct AgentBadge: View {
    /// The session browsing: a bot's is named, with its face.
    let session: String?
    let isHeld: Bool
    let takeOver: (Bool) -> Void
    @Environment(Bots.self) private var bots

    var body: some View {
        let bot = bots.bot(actingAs: session)
        HStack(spacing: 7) {
            if isHeld {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text("You have control")
                    .font(.system(size: 12, weight: .medium))
            } else {
                if let bot {
                    // Still: the bot moves where it works, in the sidebar and its conversation.
                    BotAvatar(look: bot.look, size: 16, animates: false)
                } else {
                    Spinner(size: 11)
                }
                Text(bot.map { "\($0.name) is browsing" } ?? "Agent is browsing")
                    .font(.system(size: 12, weight: .medium))
            }
            Button(isHeld ? "Hand Back" : "Take Over") { takeOver(!isHeld) }
                .buttonStyle(TextButtonStyle(outset: true))
                .font(.system(size: 12, weight: .semibold))
                .help(isHeld
                      ? "Let \(bot?.name ?? "the agent") go on in this page; it’s told what changed"
                      : "Have the page to yourself: \(bot?.name ?? "the agent")’s browser steps wait until you hand it back")
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .padding(.vertical, 4)
        .glassEffect(.regular, in: .capsule)
    }
}
