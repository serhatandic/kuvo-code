import ClientDesign
import SwiftUI
import Testing

/// A command's output in a conversation, colored as a terminal shows it: a search's files, line
/// numbers and what it found; a diff's lines; errors and warnings. Read back here as which words
/// got which color.
@MainActor
@Suite struct TerminalColorsTests {
    enum Paint: Equatable { case file, number, found, heading, added, removed, error, warning }

    /// Each colored stretch of `output`, with what its color says it is.
    private func painted(_ output: String, command: String) -> [(text: String, paint: Paint)] {
        let colored = TerminalColors.colored(output, command: command, dark: true)
        func color(_ type: String) -> Color? { CodeColors.color(for: type, dark: true) }
        var found: [(text: String, paint: Paint)] = []
        for run in colored.runs {
            guard let foreground = run.foregroundColor else { continue }
            let text = String(colored[run.range].characters)
            let bold = run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
            let paint: Paint? = foreground == color("keyword") ? (bold ? .heading : .file)
                : foreground == color("number") ? .number
                : foreground == color("string") ? .found
                : foreground == color("inserted") ? .added
                : foreground == color("deleted") ? .removed
                : nil
            if let paint { found.append((text, paint)) }
        }
        return found
    }

    private func texts(_ paint: Paint, in output: String, command: String) -> [String] {
        painted(output, command: command).filter { $0.paint == paint }.map(\.text)
    }

    /// A search's output whose numbers are as big as numbers go is colored like any other.
    @Test func theBiggestLineNumberIsReadLikeAnyOther() {
        let output = "9223372036854775807:let x = foo()\n12:foo()\n"
        #expect(texts(.number, in: output, command: "rg -n foo").contains("12"))
    }

    @Test func ripgrepsHeadingsNumbersAndMatches() {
        let output = "src/app.swift\n12:let x = foo()\n14:  foo()\n\nREADME.md\n3:foo bar\n"
        let command = "rg -n foo"
        #expect(texts(.heading, in: output, command: command) == ["src/app.swift", "README.md"])
        #expect(texts(.number, in: output, command: command) == ["12", "14", "3"])
        #expect(texts(.found, in: output, command: command) == ["foo", "foo", "foo"])
    }

    /// grep's context lines name a file with dashes ("path-13-"); a file with dashes and numbers of
    /// its own (a date) is still the whole name.
    @Test func contextLinesOfAFileWithADateInItsName() {
        let output = "logs/2026-10-20.sql:12:SELECT foo FROM t\nlogs/2026-10-20.sql-13-WHERE x = 1\n"
        let command = "grep -n -C1 foo logs/"
        #expect(texts(.file, in: output, command: command) == ["logs/2026-10-20.sql", "logs/2026-10-20.sql"])
        #expect(texts(.number, in: output, command: command) == ["12", "13"])
        #expect(texts(.found, in: output, command: command) == ["foo"])
    }

    /// The pattern is the search's own: one given with -e or after --, even one that starts like
    /// an option.
    @Test(arguments: [
        ("grep -rn -e -v src", "-v"),
        ("rg -- --verbose", "--verbose"),
        ("grep --regexp=TODO -r .", "TODO"),
        ("rg -i -g '*.swift' todo", "TODO"),
    ])
    func findsWhatTheSearchLookedFor(command: String, word: String) {
        let output = "a.swift:1:x \(word) y\n"
        #expect(texts(.found, in: output, command: command) == [word])
    }

    /// A search for what doesn't match finds nothing to mark.
    @Test func invertedSearchMarksNothing() {
        #expect(texts(.found, in: "a.txt:1:bar\n", command: "grep -v foo a.txt").isEmpty)
    }

    @Test func diffLines() {
        let output = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n"
        #expect(texts(.removed, in: output, command: "git diff") == ["-old"])
        #expect(texts(.added, in: output, command: "git diff") == ["+new"])
    }

    @Test func errorsAndWarnings() {
        let output = "Compiling…\nerror: cannot find 'x' in scope\nwarning: unused variable\nDone\n"
        let painted = painted(output, command: "swift build")
        #expect(painted.map(\.text) == ["error: cannot find 'x' in scope", "warning: unused variable"])
    }

    /// A big search's output colors quickly: thousands of lines over hundreds of files once took
    /// seconds, with the app stuck.
    @Test func aBigSearchIsQuick() {
        var lines: [String] = []
        for file in 0..<500 {
            for line in 0..<4 { lines.append("src/module-\(file)/2026-10-\(file % 28 + 1)-file.ts-\(line + 10)-const value = needle + \(line)") }
        }
        let output = lines.joined(separator: "\n")
        let started = ContinuousClock.now
        _ = TerminalColors.colored(output, command: "grep -rn -C2 needle src/", dark: true)
        #expect(ContinuousClock.now - started < .seconds(1))
    }
}
