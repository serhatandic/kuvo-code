import Foundation
import Testing
@testable import KuvoCode

/// Bots and group chats: a bot's job as its memory keeps it, and who does what when a lead splits
/// the work in a group chat, and when a bot passes.
@Suite struct BotsTests {
    // MARK: A bot's job, in its memory

    /// The whole job section, its own sub-headings and code included, up to the next section.
    @Test func theJobIsTheWholeSection() throws {
        let memory = """
        # Ci's memory

        ## Job
        Keeps CI green.

        ### Rules
        Never push to main.
        ```sh
        # run the tests first
        swift test
        ```
        #1 priority: flaky tests

        ## Notes
        The runner is slow on Mondays.
        """
        let job = try #require(Bots.job(inMemory: memory))
        #expect(job.line == "Keeps CI green")
        #expect(job.section.contains("Never push to main."))
        #expect(job.section.contains("swift test"))
        #expect(job.section.contains("#1 priority: flaky tests"))
        #expect(!job.section.contains("slow on Mondays"))
    }

    @Test(arguments: ["## Job", "# Job", "## My job", "## Job — what I do", "## Job: keeps CI green"])
    func headingsThatNameTheJob(heading: String) {
        #expect(Bots.job(inMemory: "# Memory\n\n\(heading)\nKeeps CI green\n") != nil)
    }

    /// A job written in its heading is the job: the bot isn't told it has none and asked again.
    @Test func aJobInItsHeading() throws {
        let inline = try #require(Bots.job(inMemory: "# Memory\n\n## Job: Keeps CI green\nWatch main; fix what breaks.\n\n## Notes\nx\n"))
        #expect(inline.line == "Keeps CI green")
        #expect(inline.section.contains("Keeps CI green") && inline.section.contains("Watch main"))
        let alone = try #require(Bots.job(inMemory: "# Memory\n\n## Job — Sends a morning digest\n\n## Notes\nx\n"))
        #expect(alone.line == "Sends a morning digest")
        // A heading that only names the section: the job is what's under it.
        let named = try #require(Bots.job(inMemory: "# Memory\n\n## Job — what I do\nKeeps CI green\n"))
        #expect(named.line == "Keeps CI green")
        #expect(!named.section.contains("what I do"))
    }

    @Test(arguments: ["## Job log", "## Job history", "## Jobs done"])
    func headingsThatDont(heading: String) {
        #expect(Bots.job(inMemory: "# Memory\n\n\(heading)\nRan the build\n") == nil)
    }

    @Test func aJobWrittenInEditBotReadsBack() throws {
        let memory = Bots.addingJob("Keeps CI green.", details: "Watch the main branch.\nFix what breaks.", to: Bots.blankMemory("Ci"))
        let job = try #require(Bots.job(inMemory: memory))
        #expect(job.line == "Keeps CI green")
        #expect(job.section.contains("Fix what breaks."))
        #expect(Bots.job(inMemory: Bots.blankMemory("Ci")) == nil)
    }

    /// Details from Edit Bot go into the job section the bot wrote, even one with nothing under its
    /// heading yet, and before the next section.
    @Test(arguments: ["## Job\n\n## Notes\nOld note\n", "## Job\nKeeps CI green\n\n## Notes\nOld note\n", "## Job\n"])
    func detailsGoIntoTheJobSection(sections: String) throws {
        let memory = Bots.addingDetails("Watch the main branch.", toJobIn: "# Ci's memory\n\n" + sections)
        let job = try #require(Bots.job(inMemory: memory))
        #expect(job.section.contains("Watch the main branch."))
        if sections.contains("Old note") { #expect(memory.contains("## Notes\nOld note")) }
    }
}
