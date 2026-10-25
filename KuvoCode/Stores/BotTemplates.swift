import Foundation

/// Bots to start from when making one: a name, a look and a personality that fit, and a job, which
/// the box makes the bot with types in its new conversation for you to change and send.
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

    static let all: [BotTemplate] = [
        BotTemplate(
            id: "news",
            name: "Herald",
            job: "Sends you a morning news digest",
            instructions: """
            Every morning at 8, read the latest news on the topics in your memory (the first time, ask me which topics) in the browser, from sources worth trusting. Send me a short digest: the five things that matter most, a line each, with links. Leave out what you've already told me about, and keep the topics and what you've sent in your memory.
            """,
            look: BotLook(color: .sky, shape: .round, face: .happy),
            personality: "preset.straight"
        ),
        BotTemplate(
            id: "brief",
            name: "Compass",
            job: "Plans your day each morning",
            instructions: """
            Every weekday at 8, look at today's calendar and the mail that came in since your last brief, with the calendar and mail tools I connected in Settings › Integrations. Only for what I haven't connected, use the browser, where I'm signed in, and ask with the sign-in card if I'm not. Send me a brief: today's meetings with their times and what to prepare for each, then up to five messages that need me, a line each. Keep what you've told me in your memory so you don't repeat it. Never send, accept, decline or delete anything without asking.
            """,
            look: BotLook(color: .indigo, shape: .round, face: .bright),
            personality: "preset.pragmatist"
        ),
        BotTemplate(
            id: "inbox",
            name: "Courier",
            job: "Keeps your inbox under control",
            instructions: """
            At 9, 13 and 17 on weekdays, go through new mail with the mail tools I connected in Settings › Integrations, or in the browser only if I haven't connected my mail. Tell me only about what needs me: a line each, who it's from and what they want, with a draft reply for the ones I'd likely answer, for me to check. Learn what I tell you to skip and keep it in your memory. Never send, archive or delete anything without asking.
            """,
            look: BotLook(color: .orange, shape: .pebble, face: .curious),
            personality: "preset.straight"
        ),
        BotTemplate(
            id: "social",
            name: "Echo",
            job: "Keeps up with your mentions",
            instructions: """
            Twice a day, check my mentions and messages on the social sites I name (the first time, ask which), in the browser, where I'm signed in. Tell me about the ones worth answering, a line each with a link, and suggest a reply for each. Keep what you've shown me in your memory, so each round has only what's new. Never post, reply, like or follow anything without asking.
            """,
            look: BotLook(color: .pink, shape: .bloom, face: .happy),
            personality: "preset.cheerful"
        ),
        BotTemplate(
            id: "watcher",
            name: "Lookout",
            job: "Tells you when a page changes",
            instructions: """
            Watch the pages I give you, and tell me briefly when something that matters changes (a new post, a price, a status, an opening), with a link. For a page whose content you can read without a browser, set a watch that prints just the part that matters, so you only wake up when it changes. Check the others in the browser every hour, keep what you last saw in your memory to compare against, and say nothing when nothing changed. If a page needs me to sign in, ask with the sign-in card.
            """,
            look: BotLook(color: .amber, shape: .gem, face: .curious),
            personality: "preset.pragmatist"
        ),
        BotTemplate(
            id: "research",
            name: "Sage",
            job: "Researches questions and writes them up",
            instructions: """
            When I ask a question, research it on the web: read several good sources, check their claims against each other, and write a short report in your folder with what you found, how sure you are and the sources. Answer me in a few lines and say where the report is. Ask before spending more than half an hour on one question.
            """,
            look: BotLook(color: .violet, shape: .bloom, face: .calm),
            personality: "preset.skeptic"
        ),
        BotTemplate(
            id: "ci",
            name: "Keeper",
            job: "Keeps the build green",
            instructions: """
            Every hour, build this project and run its tests. If it uses GitHub Actions and gh is signed in, also set a watch on its latest run's result, so you wake up as soon as it changes. When something fails, find out why, fix it on a branch of its own, and tell me what broke and what you changed. Never push to the main branch or merge without asking.
            """,
            look: BotLook(color: .mint, shape: .squircle, face: .calm),
            personality: "preset.perfectionist",
            wantsProject: true
        ),
        BotTemplate(
            id: "review",
            name: "Lens",
            job: "Reviews changes before they ship",
            instructions: """
            Review this project's changes before they ship. When I ask, read what changed against the main branch (or a pull request, with gh if it's signed in), and check it for bugs, missing tests, security problems and anything that doesn't fit how the code around it is written. If gh is signed in, also set a watch on the project's open pull requests, so you wake up when a new one appears and review it. Report what you found, the most important first, each with its file and line and a fix to make, and say plainly when something looks good. Don't change the code yourself unless I ask.
            """,
            look: BotLook(color: .lime, shape: .pebble, face: .curious),
            personality: "preset.mentor",
            wantsProject: true
        ),
        BotTemplate(
            id: "standup",
            name: "Tally",
            job: "Sends a morning standup",
            instructions: """
            Every weekday at 9, look at what changed in this project since your last summary (commits, branches, open pull requests if gh is signed in) and send me a standup: what got done, what's in progress, and anything that looks stuck or risky. Keep it under ten lines.
            """,
            look: BotLook(color: .coral, shape: .round, face: .wink),
            personality: "preset.cheerful",
            wantsProject: true
        ),
    ]
}
