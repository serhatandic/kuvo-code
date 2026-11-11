import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// Which project a session shows under, the same on the Mac and the phone (#311): as its box files
/// its folder, else as the session itself says it was filed when it was made, while it's still in
/// that folder; never as a project named after a new worktree or another folder of a project.
struct SessionProjectTests {
    private func session(in folder: String, filed: (folder: String, project: String)? = nil) throws -> Session {
        let metadata = filed.map { #"{"kuvo": {"filed": {"folder": "\#($0.folder)", "project": "\#($0.project)"}}}"# } ?? "{}"
        let json = #"{"id": "ses_1", "projectID": "p", "title": "t", "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "time": {"created": 1, "updated": 2}, "location": {"directory": "\#(folder)"}, "metadata": \#(metadata)}"#
        return try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private let project = "/Users/me/kuvo-ai", tree = "/Users/me/.kuvo-code/worktrees/proud-eagle-2", web = "/Users/me/kuvo-web"

    @Test func aNewWorktreeSessionIsItsProjectsBeforeItsBoxListsTheWorktree() throws {
        let made = try session(in: tree, filed: (tree, project))
        #expect(SessionProject.project(of: made, folder: tree) { _ in nil } == project)
        // Once its box lists it, as it says.
        #expect(SessionProject.project(of: made, folder: tree) { $0 == tree ? project : nil } == project)
    }

    @Test func theBoxsWordWinsAndASessionMovedSinceGoesByWhereItIs() throws {
        let moved = try session(in: "/Users/me/notes", filed: (tree, project))
        #expect(SessionProject.project(of: moved, folder: "/Users/me/notes") { _ in nil } == "/Users/me/notes")
        let listed = try session(in: web, filed: (web, "/Users/me/other"))
        #expect(SessionProject.project(of: listed, folder: web) { $0 == web ? project : nil } == project)
    }

    @Test func aMarksProjectIsFiledAsItsBoxFilesThatFolder() throws {
        // Made in a worktree of one of a project's other folders: that project's.
        let made = try session(in: tree, filed: (tree, web))
        #expect(SessionProject.project(of: made, folder: tree) { $0 == web ? project : nil } == project)
        // One with no mark, in a folder its box doesn't name: its own.
        #expect(SessionProject.project(of: try session(in: web), folder: web) { _ in nil } == web)
    }
}
