import Foundation

/// One changed file, read from git's diff: every line it shows, with its numbers on each side.
/// Git is asked for the whole file as context (a box's `kuvo/git/changes`, the Mac's own git), so
/// unchanged stretches fold and open again without another read.
public struct PatchFile: Identifiable, Hashable, Sendable {
    public enum Status: Sendable { case added, deleted, modified, renamed }

    /// Relative to the repository.
    public var path: String
    public var oldPath: String?
    public var status: Status
    public var isBinary = false
    /// Too big to read line by line (a new file of a few megabytes); shown like a binary one.
    public var isTooBig = false
    /// A folder with a repository of its own (a nested repository, a new submodule), listed as one
    /// new file.
    public var isFolder = false
    public var lines: [DiffLine] = []
    /// A new file git doesn't know yet, listed by its name: its lines come from reading it
    /// (`DiffParser.fill`).
    public var unread = false
    /// What git names its two sides by (its `index` line), or a new file's hash where it was
    /// listed: it changes as the file does, where its lines may not (a picture's).
    public var index: String?

    public var id: String { path }
    public var additions: Int { lines.count { $0.kind == .added } }
    public var deletions: Int { lines.count { $0.kind == .removed } }

    public init(path: String, oldPath: String? = nil, status: Status) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
    }
}

public struct DiffLine: Hashable, Sendable {
    public enum Kind: Sendable { case context, added, removed }
    public var kind: Kind
    public var oldNumber: Int?
    public var newNumber: Int?
    public var text: String
    /// Unchanged lines git left out between two hunks (only with very long files).
    public var gapBefore = false

    public init(kind: Kind, oldNumber: Int? = nil, newNumber: Int? = nil, text: String, gapBefore: Bool = false) {
        self.kind = kind
        self.oldNumber = oldNumber
        self.newNumber = newNumber
        self.text = text
        self.gapBefore = gapBefore
    }
}

public enum DiffParser {
    /// A project's changes as both apps list them: git's diff (`patch`) and the new files git
    /// doesn't know (`untracked`, a repository inside this one ending in "/"), one file each,
    /// ordered as Finder orders names. New files' lines aren't in the diff: they're `unread`.
    public static func listed(patch: String, untracked: [String]) -> [PatchFile] {
        // A file that changed kind (a file now a link, or back) comes as two, gone and new: one
        // here, changed, so Discard puts it back rather than throwing the new one away.
        var seen: [String: Int] = [:]
        var files: [PatchFile] = []
        for file in parse(patch) {
            guard let i = seen[file.path] else { seen[file.path] = files.count; files.append(file); continue }
            files[i].status = .modified
            files[i].lines += file.lines
            files[i].isBinary = files[i].isBinary || file.isBinary
            files[i].isFolder = files[i].isFolder || file.isFolder
            files[i].isTooBig = files[i].isTooBig || file.isTooBig
            if files[i].isTooBig { files[i].lines = [] }
        }
        for path in untracked where seen[path] == nil {
            seen[path] = files.count
            var file = PatchFile(path: path, status: .added)
            // git names a repository inside this one by its folder: "web/".
            file.isFolder = path.hasSuffix("/")
            file.unread = !file.isFolder
            files.append(file)
        }
        return files.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }

    /// A new file's lines from its bytes (`data`, nil when it couldn't be read): binary when they
    /// aren't text, too big past what's read through.
    public static func fill(_ file: inout PatchFile, with data: Data?) {
        file.unread = false
        guard let data, !data.contains(0),
              let text = String(data: data, encoding: .utf8) else {
            file.isBinary = true
            return
        }
        var lines = lines(of: text).map(String.init)
        if lines.last == "" { lines.removeLast() }
        // Too big to read through, as a changed one is.
        if lines.count > maxLines || lines.contains(where: { $0.utf8.count > maxLineLength }) {
            file.isTooBig = true
            return
        }
        file.lines = lines.enumerated().map { DiffLine(kind: .added, newNumber: $0 + 1, text: $1) }
    }

    /// Every file in `git diff` output.
    public static func parse(_ patch: String) -> [PatchFile] {
        var files: [PatchFile] = []
        var current: PatchFile?
        var oldLine = 0, newLine = 0, sawHunk = false
        // Set when git left unchanged lines out before the next line (between hunks).
        var pendingGap = false

        func finish() { if let current { files.append(current) } }

        // How many sides a line's marks are for: two in a conflicted file's combined diff.
        var sides = 1
        for raw in lines(of: patch) {
            let line = String(raw)
            if line.hasPrefix("diff --git ") || line.hasPrefix("diff --cc ") {
                finish()
                let combined = line.hasPrefix("diff --cc ")
                let path = combined ? self.path(line.dropFirst("diff --cc ".count)) : pathFromHeader(line)
                current = PatchFile(path: path, status: .modified)
                sides = combined ? 2 : 1
                sawHunk = false
                continue
            }
            guard var file = current else { continue }
            defer { current = file }
            if line.hasPrefix("@@") {
                let numbers = sides > 1 ? combinedHunkStarts(line) : hunkStarts(line)
                oldLine = numbers.old
                newLine = numbers.new
                pendingGap = sawHunk || (numbers.old > 1 && numbers.new > 1)
                sawHunk = true
                continue
            }
            if !sawHunk {
                if line.hasPrefix("new file mode") { file.status = .added; file.isFolder = line.hasSuffix(" 160000") }
                else if line.hasPrefix("deleted file mode") { file.status = .deleted }
                else if line.hasPrefix("rename from ") { file.oldPath = path(line.dropFirst("rename from ".count)); file.status = .renamed }
                else if line.hasPrefix("rename to ") { file.path = path(line.dropFirst("rename to ".count)) }
                else if line.hasPrefix("Binary files ") { file.isBinary = true }
                else if line.hasPrefix("index ") { file.index = String(line.dropFirst("index ".count).prefix { $0 != " " }) }
                continue
            }
            // Its marks are the line's first scalars, not its first characters: a line whose words
            // start with a mark that joins what's before it (an accent, a vowel sign) makes one
            // character with them.
            let scalars = line.unicodeScalars
            guard let first = scalars.first else { continue }
            var parsed: DiffLine
            if sides > 1 {
                // "++", " +", "- " …: a mark for each side, the file as it is after them.
                let marks = scalars.prefix(sides)
                guard marks.count == sides, marks.allSatisfy({ "+- ".unicodeScalars.contains($0) }) else { continue }
                let text = String(String.UnicodeScalarView(scalars.dropFirst(sides)))
                if marks.contains("-") { parsed = DiffLine(kind: .removed, oldNumber: oldLine, text: text); oldLine += 1 }
                else if marks.contains("+") { parsed = DiffLine(kind: .added, newNumber: newLine, text: text); newLine += 1 }
                else { parsed = DiffLine(kind: .context, oldNumber: oldLine, newNumber: newLine, text: text); oldLine += 1; newLine += 1 }
            } else {
                let text = String(String.UnicodeScalarView(scalars.dropFirst()))
                switch first {
                case "+": parsed = DiffLine(kind: .added, newNumber: newLine, text: text); newLine += 1
                case "-": parsed = DiffLine(kind: .removed, oldNumber: oldLine, text: text); oldLine += 1
                case " ": parsed = DiffLine(kind: .context, oldNumber: oldLine, newNumber: newLine, text: text); oldLine += 1; newLine += 1
                default: continue  // "\ No newline at end of file"
                }
            }
            if pendingGap { parsed.gapBefore = true; pendingGap = false }
            file.lines.append(parsed)
        }
        finish()
        // A big file with a few changes (a lock file, a page with a picture in it): its changes with
        // some lines around them. One too big to read through even so (a huge or minified one, a
        // new one of a few megabytes): named, not shown.
        for index in files.indices where isTooBig(files[index].lines) {
            let trimmed = aroundChanges(files[index].lines)
            if isTooBig(trimmed) {
                files[index].lines = []
                files[index].isTooBig = true
            } else {
                files[index].lines = trimmed
            }
        }
        return files
    }

    private static func isTooBig(_ lines: [DiffLine]) -> Bool {
        lines.count > maxLines || lines.contains { $0.text.utf8.count > maxLineLength }
    }

    /// The changed lines with up to `aroundChange` unchanged ones each side, without unchanged lines
    /// too long to show; what's left out shows as a gap.
    private static func aroundChanges(_ lines: [DiffLine]) -> [DiffLine] {
        let changed = lines.indices.filter { lines[$0].kind != .context }
        var keep = Set<Int>()
        for index in changed {
            keep.formUnion(max(0, index - aroundChange)...min(lines.count - 1, index + aroundChange))
        }
        var kept: [DiffLine] = []
        var skipped = false
        for index in lines.indices {
            var line = lines[index]
            guard keep.contains(index), line.kind != .context || line.text.utf8.count <= maxLineLength else {
                skipped = true
                continue
            }
            if skipped { line.gapBefore = true }
            skipped = false
            kept.append(line)
        }
        return kept
    }

    /// How many unchanged lines show each side of a change in a file too big to show whole.
    static let aroundChange = 20

    public static let maxLines = 20_000
    public static let maxLineLength = 20_000

    /// Text's lines, ending at "\n" or "\r\n" (which Swift counts as one character, so a split
    /// at "\n" alone left a file with Windows line endings in one piece).
    public static func lines(of text: String) -> [Substring] {
        text.split(omittingEmptySubsequences: false) { $0 == "\n" || $0 == "\r\n" }
    }

    /// "diff --git a/x b/x" → "x": the b side. A name git quotes ("a/say \"hi\".txt", one with a
    /// tab or a backslash) is read as git wrote it; one with " b/" in it ("Plan b/notes.md") by
    /// both sides being the same. (A rename's own lines name its paths.)
    public static func pathFromHeader(_ line: String) -> String {
        let rest = line.dropFirst("diff --git ".count)
        if rest.hasPrefix("\""), let (first, end) = unquoted(rest) {
            let second = rest[end...].drop { $0 == " " }
            let path = second.hasPrefix("\"") ? unquoted(second)?.text ?? String(second) : String(second)
            return path.hasPrefix("b/") ? String(path.dropFirst(2)) : first.hasPrefix("a/") ? String(first.dropFirst(2)) : path
        }
        if rest.hasSuffix("\""), let range = rest.range(of: " \"b/", options: .backwards), let (path, _) = unquoted(rest[rest.index(after: range.lowerBound)...]) {
            return String(path.dropFirst(2))
        }
        // "a/X b/X": X is half of what's left.
        let half = (rest.count - 5) / 2
        if rest.count % 2 == 1, half > 0, rest.hasPrefix("a/"), rest.dropFirst(2).prefix(half) == rest.suffix(half), rest.dropFirst(2 + half).hasPrefix(" b/") {
            return String(rest.suffix(half))
        }
        if let range = rest.range(of: " b/", options: .backwards) {
            return String(rest[range.upperBound...])
        }
        return String(rest)
    }

    /// A path from a line git may have quoted ("rename to", "diff --cc"): as it is, or unquoted.
    public static func path(_ text: some StringProtocol) -> String {
        text.hasPrefix("\"") ? unquoted(text)?.text ?? String(text) : String(text)
    }

    /// The name in a C-style quoted string at the start of `text`, as git writes one ("\"", "\\",
    /// "\t", "\303\251"), and where the string ends; nil when it isn't one.
    private static func unquoted<S: StringProtocol>(_ text: S) -> (text: String, end: S.Index)? {
        guard text.first == "\"" else { return nil }
        var bytes: [UInt8] = []
        var index = text.index(after: text.startIndex)
        while index < text.endIndex {
            let character = text[index]
            if character == "\"" { return (String(decoding: bytes, as: UTF8.self), text.index(after: index)) }
            guard character == "\\" else {
                bytes += Array(String(character).utf8)
                index = text.index(after: index)
                continue
            }
            index = text.index(after: index)
            guard index < text.endIndex else { return nil }
            let escaped = text[index]
            if let digit = escaped.wholeNumberValue, digit < 8 {
                // Three octal digits: one byte of the name's UTF-8.
                var value = 0
                var digits = 0
                while digits < 3, index < text.endIndex, let next = text[index].wholeNumberValue, next < 8 {
                    value = value * 8 + next
                    digits += 1
                    index = text.index(after: index)
                }
                bytes.append(UInt8(truncatingIfNeeded: value))
                continue
            }
            let known: [Character: UInt8] = ["a": 7, "b": 8, "t": 9, "n": 10, "v": 11, "f": 12, "r": 13, "\"": 34, "\\": 92]
            bytes.append(known[escaped] ?? Array(String(escaped).utf8).first ?? 0)
            index = text.index(after: index)
        }
        return nil
    }

    /// "@@@ -12,7 -12,8 +12,9 @@@" → (12, 12): the first side, and the file as it is.
    private static func combinedHunkStarts(_ line: String) -> (old: Int, new: Int) {
        let parts = line.split(separator: " ")
        func start(_ part: Substring?) -> Int {
            guard let part else { return 1 }
            return lineStart(part.dropFirst().split(separator: ",").first.flatMap { Int($0) })
        }
        return (start(parts.first { $0.hasPrefix("-") }), start(parts.first { $0.hasPrefix("+") }))
    }

    /// "@@ -12,7 +12,9 @@" → (12, 12).
    private static func hunkStarts(_ line: String) -> (old: Int, new: Int) {
        let parts = line.split(separator: " ")
        func start(_ part: Substring?) -> Int {
            guard let part else { return 1 }
            return lineStart(part.dropFirst().split(separator: ",").first.flatMap { Int($0) })
        }
        return (start(parts.dropFirst().first), start(parts.dropFirst(2).first))
    }

    /// A hunk's first line as its header says, kept where a file's lines can be (each line after
    /// it counts on from there).
    private static func lineStart(_ number: Int?) -> Int {
        min(max(number ?? 1, 1), Int(Int32.max))
    }
}

/// Shows each change with a few lines around it and folds the long unchanged stretches.
public enum DiffFolding {
    public static let context = 3

    public struct Row: Identifiable, Sendable {
        public enum Kind: Sendable { case line(Int), fold(Range<Int>), gap }
        public var id: String
        public var kind: Kind
    }

    /// `expanded`: the folds opened, by their rows' ids; `file` names the rows.
    public static func rows(for lines: [DiffLine], expanded: Set<String>, file: String) -> [Row] {
        var rows: [Row] = []
        var index = 0
        while index < lines.count {
            if lines[index].gapBefore { rows.append(Row(id: "\(file)#gap\(index)", kind: .gap)) }
            guard lines[index].kind == .context else {
                rows.append(Row(id: "\(file)#\(index)", kind: .line(index)))
                index += 1
                continue
            }
            // A run of unchanged lines, up to the next change (or a gap git left).
            var end = index + 1
            while end < lines.count, lines[end].kind == .context, !lines[end].gapBefore { end += 1 }
            let keepStart = index == 0 || lines[index].gapBefore ? 0 : context
            let keepEnd = end == lines.count || lines[end].gapBefore ? 0 : context
            let foldStart = index + keepStart, foldEnd = end - keepEnd
            let foldID = "\(file)#fold\(foldStart)"
            if foldEnd - foldStart > 3, !expanded.contains(foldID) {
                rows += (index..<foldStart).map { Row(id: "\(file)#\($0)", kind: .line($0)) }
                rows.append(Row(id: foldID, kind: .fold(foldStart..<foldEnd)))
                rows += (foldEnd..<end).map { Row(id: "\(file)#\($0)", kind: .line($0)) }
            } else {
                rows += (index..<end).map { Row(id: "\(file)#\($0)", kind: .line($0)) }
            }
            index = end
        }
        return rows
    }
}
