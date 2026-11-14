import ClientText
import Testing

/// What an ask to work outside the project shows of where: the folder as people know it, not the
/// engine's pattern ("/Users/me/other-project/*"), and words VoiceOver reads without "slash star".
struct OutsideFoldersTests {
    private let home = "/Users/me"

    @Test func aFolderTheEngineAsksAboutShowsAsTheFolderWithTildeForHome() {
        #expect(OutsideFolders.shown("/Users/me/other-project/*", home: home) == "~/other-project")
        #expect(OutsideFolders.spoken("/Users/me/other-project/*", home: home) == "Home, other-project")
        #expect(OutsideFolders.shown("/Users/me/Developer/api/**", home: home + "/") == "~/Developer/api")
        #expect(OutsideFolders.shown("/Users/me/*", home: home) == "~")
        #expect(OutsideFolders.spoken("/Users/me/*", home: home) == "Home")
    }

    @Test func aFileTheBridgeAsksAboutShowsWhole() {
        #expect(OutsideFolders.shown("/Users/me/notes/a.md", home: home) == "~/notes/a.md")
        #expect(OutsideFolders.spoken("/Users/me/notes/a.md", home: home) == "Home, notes, a.md")
    }

    @Test func foldersElsewhereAndEverythingSayWhatTheyAre() {
        #expect(OutsideFolders.shown("/opt/data/*", home: home) == "/opt/data")
        #expect(OutsideFolders.spoken("/opt/data/*", home: home) == "opt, data")
        // Another user's home isn't yours; nor is a machine's, whose home isn't known.
        #expect(OutsideFolders.shown("/Users/meg/notes/*", home: home) == "/Users/meg/notes")
        #expect(OutsideFolders.shown("/home/me/notes/*", home: nil) == "/home/me/notes")
        #expect(OutsideFolders.shown("/*", home: home) == "/")
        #expect(OutsideFolders.spoken("/*", home: home) == "The whole disk")
        #expect(OutsideFolders.shown("*", home: home) == "Any folder")
        #expect(OutsideFolders.shown("~/notes/*", home: nil) == "~/notes")
        #expect(OutsideFolders.spoken("~/notes/*", home: nil) == "Home, notes")
        // Only "everything in it" goes: another star means another thing.
        #expect(OutsideFolders.shown("/Users/me/proj*", home: home) == "~/proj*")
    }
}
