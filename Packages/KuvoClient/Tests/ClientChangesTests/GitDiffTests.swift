import ClientChanges
import Foundation
import Testing

/// A project's changes as both apps list them from git's diff (a box's `kuvo/git/changes`, the
/// Mac's own git): each file with its lines and their numbers, renamed, new or gone, named as git
/// quotes odd names, new files git doesn't know yet, and the long unchanged stretches folded.
struct GitDiffTests {
    /// git's diff with whole files as context (`-U100000`), as a box sends it.
    private let patch = """
    diff --git a/src/theme.ts b/src/theme.ts
    index 1111111..2222222 100644
    --- a/src/theme.ts
    +++ b/src/theme.ts
    @@ -1,12 +1,12 @@
     export const theme = {
    -  mode: "light",
    +  mode: preferred(),
       accent: "#0a84ff",
       radius: 8,
       spacing: 4,
       font: "system",
       size: 15,
       weight: 400,
       line: 1.4,
       shadow: true,
       border: 1,
     };
    diff --git a/old name.md b/docs/new name.md
    similarity 90%
    rename from old name.md
    rename to docs/new name.md
    index 3333333..4444444 100644
    --- a/old name.md
    +++ b/docs/new name.md
    @@ -1,2 +1,2 @@
     # Notes
    -draft
    +final
    diff --git "a/caf\\303\\251 \\"menu\\".txt" "b/caf\\303\\251 \\"menu\\".txt"
    deleted file mode 100644
    index 5555555..0000000
    --- "a/caf\\303\\251 \\"menu\\".txt"
    +++ /dev/null
    @@ -1 +0,0 @@
    -espresso
    diff --git a/public/logo.png b/public/logo.png
    index 6666666..7777777 100644
    Binary files a/public/logo.png and b/public/logo.png differ

    """

    /// A picture the agent made again reads as changed, though git says the same of it ("Binary
    /// files … differ"): what shows it (its two sides on the phone) reads them again.
    @Test func aPictureMadeAgainReadsAsChanged() throws {
        let before = try #require(DiffParser.listed(patch: patch, untracked: []).first { $0.path == "public/logo.png" })
        let again = try #require(DiffParser.listed(patch: patch.replacingOccurrences(of: "6666666..7777777", with: "6666666..8888888"), untracked: [])
            .first { $0.path == "public/logo.png" })
        #expect(before.isBinary && again.isBinary)
        #expect(before != again)
    }

    @Test func eachFileListsWithItsLinesAndTheirNumbersOnEachSide() throws {
        let files = DiffParser.listed(patch: patch, untracked: [])
        #expect(files.map(\.path) == ["café \"menu\".txt", "docs/new name.md", "public/logo.png", "src/theme.ts"])

        let theme = try #require(files.last)
        #expect(theme.status == .modified && theme.additions == 1 && theme.deletions == 1)
        #expect(theme.lines[1] == DiffLine(kind: .removed, oldNumber: 2, text: "  mode: \"light\","))
        #expect(theme.lines[2] == DiffLine(kind: .added, newNumber: 2, text: "  mode: preferred(),"))
        #expect(theme.lines[3].oldNumber == 3 && theme.lines[3].newNumber == 3)

        let renamed = files[1]
        #expect(renamed.status == .renamed && renamed.oldPath == "old name.md")
        #expect(files[0].status == .deleted && files[0].deletions == 1)
        #expect(files[2].isBinary && files[2].lines.isEmpty)
    }

    /// A line whose words start with a mark that joins what's before it (an accent, a vowel sign,
    /// a joiner) is read as any line, its numbers and those after it right.
    @Test func aLineStartingWithAJoiningMarkIsReadAsAnyLine() throws {
        let patch = """
        diff --git a/words.txt b/words.txt
        --- a/words.txt
        +++ b/words.txt
        @@ -1,4 +1,4 @@
         \u{301}accent
        -\u{93E}sign
        +\u{200D}joined
         end
        """
        let lines = try #require(DiffParser.parse(patch).first).lines
        #expect(lines.map(\.kind) == [.context, .removed, .added, .context])
        #expect(lines.map(\.text) == ["\u{301}accent", "\u{93E}sign", "\u{200D}joined", "end"])
        #expect(lines[3].oldNumber == 3 && lines[3].newNumber == 3)
    }

    /// A hunk that says it starts where no file's lines are (as big as numbers go) is read without
    /// trouble, on either kind of diff.
    @Test func aHunkStartingAsFarAsNumbersGoIsReadSafely() throws {
        for header in ["diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -9223372036854775807,2 +9223372036854775807,2 @@",
                       "diff --cc x\n--- a/x\n+++ b/x\n@@@ -9223372036854775807,2 -9223372036854775807,2 +9223372036854775807,2 @@@"] {
            let marks = header.hasPrefix("diff --cc") ? "  " : " "
            let lines = try #require(DiffParser.parse(header + "\n\(marks)one\n\(marks)two\n").first).lines
            #expect(lines.map(\.text) == ["one", "two"])
        }
    }

    @Test func newFilesGitDoesntKnowAreListedToBeRead() throws {
        var files = DiffParser.listed(patch: patch, untracked: ["src/hooks/useColorScheme.ts", "vendor/web/", "src/theme.ts"])
        // One the diff has already isn't listed twice.
        #expect(files.count { $0.path == "src/theme.ts" } == 1)
        let new = try #require(files.firstIndex { $0.path == "src/hooks/useColorScheme.ts" })
        #expect(files[new].status == .added && files[new].unread)
        // A repository inside this one is named by its folder, and has nothing to read.
        let nested = try #require(files.first { $0.path == "vendor/web/" })
        #expect(nested.isFolder && !nested.unread)

        DiffParser.fill(&files[new], with: Data("export function useColorScheme() {\n  return \"dark\"\n}\n".utf8))
        #expect(!files[new].unread && files[new].additions == 3)
        #expect(files[new].lines.last == DiffLine(kind: .added, newNumber: 3, text: "}"))

        var picture = PatchFile(path: "icon.png", status: .added)
        DiffParser.fill(&picture, with: Data([0x89, 0x50, 0x4E, 0x47, 0x00]))
        #expect(picture.isBinary)
    }

    @Test func aFileThatChangedKindIsOneChangedFile() {
        // A file now a link comes as two: gone, and new.
        let kind = """
        diff --git a/run.sh b/run.sh
        deleted file mode 100755
        --- a/run.sh
        +++ /dev/null
        @@ -1 +0,0 @@
        -echo hi
        diff --git a/run.sh b/run.sh
        new file mode 120000
        --- /dev/null
        +++ b/run.sh
        @@ -0,0 +1 @@
        +scripts/run.sh
        """
        let files = DiffParser.listed(patch: kind, untracked: [])
        #expect(files.count == 1)
        #expect(files.first?.status == .modified)
        #expect(files.first?.additions == 1 && files.first?.deletions == 1)
    }

    @Test func longUnchangedStretchesFoldAroundEachChangeAndOpen() throws {
        let theme = try #require(DiffParser.parse(patch).first)
        let rows = DiffFolding.rows(for: theme.lines, expanded: [], file: theme.path)
        // The first line, the change, three lines after it, then the rest folded.
        guard case .fold(let folded) = rows[6].kind else { Issue.record("no fold after the change's lines"); return }
        #expect(folded == 6..<13)
        #expect(rows.count == 7)

        let opened = DiffFolding.rows(for: theme.lines, expanded: [rows[6].id], file: theme.path)
        #expect(opened.count == theme.lines.count)
    }

    @Test func aNewFileListedTwiceShowsOnce() {
        let files = DiffParser.listed(patch: "", untracked: ["notes.md", "notes.md"])
        #expect(files.map(\.path) == ["notes.md"])
    }

    @Test func linesGitLeftOutBetweenTwoChangesShowAsAGapThatDoesntOpen() throws {
        let twoHunks = """
        diff --git a/long.txt b/long.txt
        --- a/long.txt
        +++ b/long.txt
        @@ -1,2 +1,2 @@
        -one
        +One
         two
        @@ -500,2 +500,2 @@
         four hundred ninety-nine
        -five hundred
        +Five hundred
        """
        let file = try #require(DiffParser.parse(twoHunks).first)
        #expect(file.lines[3].gapBefore && file.lines[3].oldNumber == 500)
        let rows = DiffFolding.rows(for: file.lines, expanded: [], file: file.path)
        guard case .gap = rows[3].kind else { Issue.record("no gap between the hunks"); return }
        #expect(rows.count == file.lines.count + 1)
    }

    @Test func aFileTooBigToReadThroughIsNamedWithoutItsLines() throws {
        let lines = (0...DiffParser.maxLines).map { "+line \($0)" }.joined(separator: "\n")
        let big = "diff --git a/data.csv b/data.csv\nnew file mode 100644\n--- /dev/null\n+++ b/data.csv\n@@ -0,0 +1,\(DiffParser.maxLines + 1) @@\n" + lines
        let file = try #require(DiffParser.parse(big).first)
        #expect(file.isTooBig && file.lines.isEmpty && file.status == .added)

        var minified = PatchFile(path: "app.min.js", status: .added)
        DiffParser.fill(&minified, with: Data(String(repeating: "x", count: DiffParser.maxLineLength + 1).utf8))
        #expect(minified.isTooBig && minified.lines.isEmpty)
    }

    @Test func aNewFileWithWindowsLineEndingsReadsLineByLine() {
        var file = PatchFile(path: "README.txt", status: .added)
        DiffParser.fill(&file, with: Data("one\r\ntwo\r\n".utf8))
        #expect(file.lines.map(\.text) == ["one", "two"])
    }
}
