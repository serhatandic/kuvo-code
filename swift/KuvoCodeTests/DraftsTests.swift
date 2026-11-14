import Foundation
import Testing
@testable import KuvoCode

/// What you've written in a composer and not sent is kept: across a relaunch, and when a message
/// doesn't go (or the app quits while it's going), it's back in its composer whole, with its
/// files and comments on the changes, ahead of what you wrote since.
@MainActor
@Suite struct DraftsTests {
    let suite = "run.kuvo.code.tests.drafts-\(UUID().uuidString)"
    let defaults: UserDefaults
    let key = "ses_test"
    let comment = ReviewComment(file: "App.swift", line: 12, side: .new, snippet: "let x = 1", text: "Rename x")
    let file: URL

    init() throws {
        TestEnvironment.prepare()
        defaults = UserDefaults(suiteName: suite)!
        let folder = AppInfo.testRoot.appending(path: "Drafts/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        file = folder.appending(path: "screenshot.png")
        try Data([1, 2, 3]).write(to: file)
    }

    /// The app started again, reading what the last one kept.
    private func relaunched() -> Drafts { Drafts(defaults: defaults) }

    private func clean() { defaults.removePersistentDomain(forName: suite) }

    @Test func aDraftSurvivesARelaunch() {
        defer { clean() }
        let drafts = relaunched()
        var draft = drafts[key]
        draft.text = "Half-written thought"
        draft.files = [file]
        draft.comments = [comment]
        drafts[key] = draft
        drafts.saveNow()
        let again = relaunched()[key]
        #expect(again.text == "Half-written thought")
        #expect(again.files == [file])
        #expect(again.comments.map(\.text) == ["Rename x"])
    }

    /// A message that didn't go comes back whole, before what you wrote meanwhile.
    @Test func aMessageThatDidntGoComesBackWhole() {
        defer { clean() }
        let drafts = relaunched()
        var draft = Drafts.Draft(text: "Fix this", files: [file])
        draft.comments = [comment]
        drafts[key] = draft
        let (id, _) = drafts.takeOut(key)
        #expect(drafts[key].isEmpty)
        drafts[key] = Drafts.Draft(text: "and also that")
        drafts.putBack(id)
        #expect(drafts[key].text == "Fix this\n\nand also that")
        #expect(drafts[key].files == [file])
        #expect(drafts[key].comments.map(\.text) == ["Rename x"])
    }

    /// Quit (or a crash) while a message was on its way: it's back in its composer next time.
    @Test func aMessageOnItsWayAtQuitIsBackNextTime() {
        defer { clean() }
        let drafts = relaunched()
        var draft = Drafts.Draft(text: "Deploy it")
        draft.comments = [comment]
        drafts[key] = draft
        _ = drafts.takeOut(key)
        let again = relaunched()[key]
        #expect(again.text == "Deploy it")
        #expect(again.comments.map(\.text) == ["Rename x"])
    }

    @Test func aSentMessageIsntKept() {
        defer { clean() }
        let drafts = relaunched()
        drafts[key] = Drafts.Draft(text: "Ship it")
        let (id, _) = drafts.takeOut(key)
        drafts.sent(id)
        #expect(relaunched()[key].isEmpty)
    }

    /// An attached file deleted since isn't put back.
    @Test func aDeletedAttachmentIsDropped() throws {
        defer { clean() }
        let drafts = relaunched()
        drafts[key] = Drafts.Draft(text: "See attached", files: [file])
        drafts.saveNow()
        try FileManager.default.removeItem(at: file)
        let again = relaunched()[key]
        #expect(again.text == "See attached")
        #expect(again.files.isEmpty)
    }
}
