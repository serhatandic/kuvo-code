import ClientChanges
import ClientDesign
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Changes › This Session for a folder outside git, read from the agent's own edits: each file
/// once, showing what changed from before the agent touched it to now.
@Suite struct SessionEditsTests {
    let folder: URL
    var path: String { folder.path(percentEncoded: false) }

    init() throws {
        TestEnvironment.prepare()
        folder = AppInfo.testRoot.appending(path: "Folders/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    private func write(_ name: String, _ text: String) throws {
        try Data(text.utf8).write(to: folder.appending(path: name))
    }

    // MARK: The agent's steps, as the engine records them

    private struct Step {
        var json: [String: Any]
        static func write(_ path: String, _ content: String) -> Step {
            Step(json: ["type": "tool", "id": UUID().uuidString, "name": "write", "executed": true,
                        "state": ["status": "completed", "input": ["path": path, "content": content], "content": [], "metadata": [:]]])
        }
        /// An edit, with the engine's patch of it.
        static func edit(_ path: String, from old: [String], to new: [String], at line: Int = 1) -> Step {
            let patch = "--- a/\(path)\n+++ b/\(path)\n@@ -\(line),\(old.count) +\(line),\(new.count) @@\n"
                + old.map { "-\($0)\n" }.joined() + new.map { "+\($0)\n" }.joined()
            let file: [String: Any] = ["file": path, "patch": patch, "additions": new.count, "deletions": old.count]
            return Step(json: ["type": "tool", "id": UUID().uuidString, "name": "edit", "executed": true,
                               "state": ["status": "completed", "input": ["path": path], "content": [], "metadata": ["files": [file]]]])
        }
    }

    private func messages(_ steps: [Step]) throws -> [Message] {
        let message: [String: Any] = ["id": "msg_1", "type": "assistant", "agent": "build", "time": ["created": 1, "completed": 2],
                                      "model": ["id": "m", "providerID": "p"], "content": steps.map(\.json)]
        return try JSONDecoder().decode([Message].self, from: JSONSerialization.data(withJSONObject: [message]))
    }

    private func changes(_ steps: [Step]) throws -> [FileDiff] {
        SessionEdits.files(in: try messages(steps), directory: path)
    }

    // MARK: Scenarios

    /// Edited twice: one entry, from before the first edit to now, not the step in between.
    @Test func twoEditsShowAsOneChange() throws {
        try write("config.txt", "mode = fast\n")  // now, after both edits
        let file = try #require(try changes([
            .edit("config.txt", from: ["mode = slow"], to: ["mode = medium"]),
            .edit("config.txt", from: ["mode = medium"], to: ["mode = fast"]),
        ]).only)
        #expect(file.file == "config.txt")
        #expect(file.patch.contains("-mode = slow"))
        #expect(file.patch.contains("+mode = fast"))
        #expect(!file.patch.contains("medium"))
        #expect(file.additions == 1 && file.deletions == 1)
    }

    /// Changed and changed back: nothing to review.
    @Test func anEditPutBackIsLeftOut() throws {
        try write("a.txt", "one\n")
        let files = try changes([
            .edit("a.txt", from: ["one"], to: ["two"]),
            .edit("a.txt", from: ["two"], to: ["one"]),
        ])
        #expect(files.isEmpty)
    }

    /// Written, then edited: shown whole, as it is now.
    @Test func aWrittenFileShowsWhatsThereNow() throws {
        try write("notes.md", "# Notes\nfinal line\n")
        let file = try #require(try changes([
            .write(path + "/notes.md", "# Notes\nfirst line\n"),
            .edit(path + "/notes.md", from: ["first line"], to: ["final line"], at: 2),
        ]).only)
        #expect(file.file == "notes.md")
        #expect(file.patch.contains("+final line"))
        #expect(!file.patch.contains("first line"))
        #expect(file.additions == 2)
    }

    /// The same file named through a link (/tmp is /private/tmp) is one file.
    @Test func aFileNamedTwoWaysIsOneFile() throws {
        try write("x.txt", "b\n")
        let linked = folder.deletingLastPathComponent().appending(path: "link-\(UUID().uuidString)")
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: folder)
        defer { try? FileManager.default.removeItem(at: linked) }
        let files = try changes([
            .edit(linked.path(percentEncoded: false) + "/x.txt", from: ["a"], to: ["b"]),
            .edit(path + "/x.txt", from: ["b"], to: ["b"]),
        ])
        #expect(files.map(\.file) == ["x.txt"])
    }

    /// Changed by you since (the edits don't fit what's there): still listed, with the agent's
    /// own patches.
    @Test func aFileChangedSinceKeepsTheAgentsPatches() throws {
        try write("b.txt", "something else entirely\n")
        let file = try #require(try changes([
            .edit("b.txt", from: ["x"], to: ["y"]),
            .edit("b.txt", from: ["y"], to: ["z"]),
        ]).only)
        #expect(file.patch.contains("+y") && file.patch.contains("+z"))
        #expect(file.additions == 2)
    }

    // MARK: The Changes tab (B17)

    /// What the Changes tab lists for a folder outside git: the session's edits, each file's lines
    /// as they show (added and removed ones, with their marks).
    @MainActor
    private func listed(_ steps: [Step]) async throws -> [String: [String]] {
        let box = try await GitTestBox()
        let panel = box.changes(path)
        await panel.refresh(fallback: [], edits: try changes(steps))
        #expect(!panel.isRepository)
        return Dictionary(uniqueKeysWithValues: panel.files.map { file in
            (file.path, file.lines.compactMap { line in
                switch line.kind {
                case .added: "+" + line.text
                case .removed: "-" + line.text
                case .context: nil
                }
            })
        })
    }

    /// A folder that isn't a git repository: the Changes tab lists each file the agent changed,
    /// once, with what changed.
    @MainActor
    @Test func outsideGitTheChangesTabListsTheSessionsEdits() async throws {
        try write("config.txt", "mode = fast\n")
        try write("notes.md", "# Notes\n")
        let listed = try await listed([
            .edit("config.txt", from: ["mode = slow"], to: ["mode = medium"]),
            .write(path + "/notes.md", "# Notes\n"),
            .edit("config.txt", from: ["mode = medium"], to: ["mode = fast"]),
        ])
        #expect(listed == ["config.txt": ["-mode = slow", "+mode = fast"], "notes.md": ["+# Notes"]])
    }

    /// Edits that no longer fit the file (you changed it since) show as the agent made them, each
    /// line once: none of the patches' own headers among them.
    @MainActor
    @Test func editsThatNoLongerFitShowOnlyTheirLines() async throws {
        try write("b.txt", "something else entirely\n")
        let listed = try await listed([
            .edit("b.txt", from: ["x"], to: ["y"]),
            .edit("b.txt", from: ["y"], to: ["z"]),
        ])
        #expect(listed["b.txt"] == ["-x", "+y", "-y", "+z"])
    }

    /// Files show in the order the agent first touched them.
    @Test func filesKeepTheAgentsOrder() throws {
        try write("b.txt", "2\n")
        try write("a.txt", "2\n")
        let files = try changes([.edit("b.txt", from: ["1"], to: ["2"]), .edit("a.txt", from: ["1"], to: ["2"])])
        #expect(files.map(\.file) == ["b.txt", "a.txt"])
    }
}

private extension Array {
    var only: Element? { count == 1 ? first : nil }
}
