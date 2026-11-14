import ClientDesign
import Foundation
import OpenCodeKit

/// What a session's agent changed, from its own edits: for a folder outside a git repository,
/// where the engine keeps no snapshots and so has no diff of the session for the Changes tab.
nonisolated enum SessionEdits {
    /// Each file the session's edits changed, once. A file edited more than once shows the
    /// change from before its first edit to now, when it's on this Mac and the edits still fit
    /// what's there; otherwise its edits' patches one after another. One put back as it was is
    /// left out. A file the agent wrote whole shows what it wrote, as what was there before isn't
    /// known.
    static func files(in messages: [Message], directory: String) -> [FileDiff] {
        var order: [String] = []
        var changes: [String: [Change]] = [:]
        func add(_ change: Change, to name: String) {
            if changes[name] == nil { order.append(name) }
            changes[name, default: []].append(change)
        }
        for case .assistant(let step) in messages {
            for case .tool(let call) in step.content {
                guard case .completed(let input, _, let metadata) = call.state else { continue }
                if let files = try? metadata?["files"]?.decode(as: [FileDiff].self) {
                    // By the same name as a write of it, whichever way the engine names the file.
                    for var file in files where !file.patch.isEmpty {
                        file.file = relative(file.file, in: directory)
                        add(.edit(file), to: file.file)
                    }
                } else if call.name == "write", let path = input["path"]?.string ?? input["filePath"]?.string, let content = input["content"]?.string {
                    add(.write(content), to: relative(path, in: directory))
                }
            }
        }
        return order.compactMap { name in
            guard let all = changes[name] else { return nil }
            if all.contains(where: \.isWrite) {
                // Whole, from the last write on: as it is now on this Mac, or as written and
                // edited after.
                let now = RemoteFolder.isRemote(directory) ? nil : try? String(contentsOfFile: absolute(name, in: directory), encoding: .utf8)
                guard let text = now ?? afterLastWrite(all) else { return nil }
                let hunks = unifiedHunks(from: [], to: lines(of: text))
                return FileDiff(file: name, patch: "--- a/\(name)\n+++ b/\(name)\n" + hunks.text, additions: hunks.additions, deletions: 0)
            }
            let edits = all.compactMap(\.edit)
            guard let only = edits.first else { return nil }
            if edits.count == 1 { return only }
            switch combined(edits, directory: directory) {
            case .changed(let file): return file
            case .unchanged: return nil
            case nil:
                // One header, then each edit's hunks: another header after a hunk would read as
                // lines of it.
                let hunks = edits.map { edit in
                    let lines = edit.patch.components(separatedBy: "\n").drop { !$0.hasPrefix("@@") }.joined(separator: "\n")
                    return lines.hasSuffix("\n") || lines.isEmpty ? lines : lines + "\n"
                }
                return FileDiff(file: name, patch: "--- a/\(name)\n+++ b/\(name)\n" + hunks.joined(),
                                additions: edits.reduce(0) { $0 + $1.additions }, deletions: edits.reduce(0) { $0 + $1.deletions }, status: edits.last?.status)
            }
        }
    }

    private enum Change {
        case edit(FileDiff), write(String)
        var isWrite: Bool { if case .write = self { true } else { false } }
        var written: String? { if case .write(let text) = self { text } else { nil } }
        var edit: FileDiff? { if case .edit(let file) = self { file } else { nil } }
    }

    private enum Combined { case changed(FileDiff), unchanged }

    /// What the last write wrote, with the edits after it made to it (as written, when one of
    /// them doesn't fit).
    private static func afterLastWrite(_ all: [Change]) -> String? {
        guard let last = all.lastIndex(where: \.isWrite), let written = all[last].written else { return nil }
        var result = lines(of: written)
        for edit in all[(last + 1)...].compactMap(\.edit) {
            guard let applied = apply(edit.patch, to: result) else { return written }
            result = applied
        }
        return result.map { $0 + "\n" }.joined()
    }

    /// `path` from `directory`, also when one of them goes through a link (/tmp is /private/tmp).
    private static func relative(_ path: String, in directory: String) -> String {
        let base = (RemoteFolder.parse(directory)?.path ?? directory).appending("/")
        if path.hasPrefix(base) { return String(path.dropFirst(base.count)) }
        guard path.hasPrefix("/"), !RemoteFolder.isRemote(directory) else { return path }
        let resolved = URL(filePath: path).resolvingSymlinksInPath().path
        let resolvedBase = URL(filePath: directory).resolvingSymlinksInPath().path.appending("/")
        return resolved.hasPrefix(resolvedBase) ? String(resolved.dropFirst(resolvedBase.count)) : path
    }

    private static func absolute(_ name: String, in directory: String) -> String {
        name.hasPrefix("/") ? name : (directory as NSString).appendingPathComponent(name)
    }

    /// The file as it was before the first edit, worked back from how it is now through each
    /// edit's patch, last first; then the change from that to now.
    private static func combined(_ edits: [FileDiff], directory: String) -> Combined? {
        guard let first = edits.first, !RemoteFolder.isRemote(directory) else { return nil }
        // Gone (deleted since) reads as empty.
        let now = lines(of: (try? String(contentsOfFile: absolute(first.file, in: directory), encoding: .utf8)) ?? "")
        var before = now
        for edit in edits.reversed() {
            guard let undone = unapply(edit.patch, to: before) else { return nil }
            before = undone
        }
        let hunks = unifiedHunks(from: before, to: now)
        guard !hunks.text.isEmpty else { return .unchanged }
        let status: FileDiff.Status = before.isEmpty && first.status == .added ? .added
            : now.isEmpty && edits.last?.status == .deleted ? .deleted : .modified
        return .changed(FileDiff(file: first.file, patch: "--- a/\(first.file)\n+++ b/\(first.file)\n" + hunks.text,
                                 additions: hunks.additions, deletions: hunks.deletions, status: status))
    }

    static func lines(of text: String) -> [String] {
        var lines = text.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        return lines
    }

    /// `lines` with `patch` taken back out, its hunks last first, each where it says or a little
    /// above or below; nil when one doesn't fit.
    static func unapply(_ patch: String, to lines: [String]) -> [String]? {
        var result = lines
        for hunk in hunks(of: patch).reversed() {
            let start = hunk.newCount == 0 ? hunk.newStart : hunk.newStart - 1
            let fits = { (at: Int) in at >= 0 && at + hunk.new.count <= result.count && Array(result[at..<at + hunk.new.count]) == hunk.new }
            guard let at = ([start] + (1...50).flatMap { [start - $0, start + $0] }).first(where: fits) else { return nil }
            result.replaceSubrange(at..<at + hunk.new.count, with: hunk.old)
        }
        return result
    }

    /// `lines` with `patch` made to it, its hunks in order, each where it says or a little above
    /// or below; nil when one doesn't fit.
    static func apply(_ patch: String, to lines: [String]) -> [String]? {
        var result = lines
        for hunk in hunks(of: patch) {
            let start = hunk.newCount == 0 ? hunk.newStart : hunk.newStart - 1
            let fits = { (at: Int) in at >= 0 && at + hunk.old.count <= result.count && Array(result[at..<at + hunk.old.count]) == hunk.old }
            guard let at = ([start] + (1...50).flatMap { [start - $0, start + $0] }).first(where: fits) else { return nil }
            result.replaceSubrange(at..<at + hunk.old.count, with: hunk.new)
        }
        return result
    }

    private struct Hunk {
        var newStart = 0, newCount = 0
        var old: [String] = [], new: [String] = []
    }

    private static func hunks(of patch: String) -> [Hunk] {
        var hunks: [Hunk] = []
        for line in patch.components(separatedBy: "\n") {
            if line.hasPrefix("@@") {
                // "@@ -12,7 +12,9 @@": the new side's start and count (one line when it says none).
                let new = line.split(separator: " ").first { $0.hasPrefix("+") }.map { $0.dropFirst().split(separator: ",") } ?? []
                hunks.append(Hunk(newStart: Int(new.first ?? "") ?? 0, newCount: new.count > 1 ? Int(new[1]) ?? 0 : 1))
            } else if !hunks.isEmpty, let mark = line.first {
                let text = String(line.dropFirst())
                switch mark {
                case " ": hunks[hunks.count - 1].old.append(text); hunks[hunks.count - 1].new.append(text)
                case "-": hunks[hunks.count - 1].old.append(text)
                case "+": hunks[hunks.count - 1].new.append(text)
                default: break  // "\ No newline at end of file"
                }
            }
        }
        return hunks
    }

    /// The change from `old` to `new` as a unified diff's hunks, three lines around each.
    static func unifiedHunks(from old: [String], to new: [String]) -> (text: String, additions: Int, deletions: Int) {
        enum Op { case same(String), removed(String), added(String) }
        let difference = new.difference(from: old)
        var removed = Set<Int>(), inserted = Set<Int>()
        for change in difference {
            switch change {
            case .remove(let offset, _, _): removed.insert(offset)
            case .insert(let offset, _, _): inserted.insert(offset)
            }
        }
        // Each step, with where it starts on each side.
        var ops: [(op: Op, old: Int, new: Int)] = []
        var i = 0, j = 0
        while i < old.count || j < new.count {
            if i < old.count, removed.contains(i) { ops.append((.removed(old[i]), i, j)); i += 1 }
            else if j < new.count, inserted.contains(j) { ops.append((.added(new[j]), i, j)); j += 1 }
            else if i < old.count, j < new.count { ops.append((.same(old[i]), i, j)); i += 1; j += 1 }
            else { break }
        }
        let changed = ops.indices.filter { if case .same = ops[$0].op { false } else { true } }
        guard !changed.isEmpty else { return ("", 0, 0) }
        // Changes closer than both contexts share a hunk.
        var groups: [ClosedRange<Int>] = []
        for index in changed {
            if let last = groups.last, index - last.upperBound <= 6 { groups[groups.count - 1] = last.lowerBound...index }
            else { groups.append(index...index) }
        }
        var text = "", additions = 0, deletions = 0
        for group in groups {
            let range = max(0, group.lowerBound - 3)...min(ops.count - 1, group.upperBound + 3)
            var body = "", oldCount = 0, newCount = 0
            for index in range {
                switch ops[index].op {
                case .same(let line): body += " \(line)\n"; oldCount += 1; newCount += 1
                case .removed(let line): body += "-\(line)\n"; oldCount += 1; deletions += 1
                case .added(let line): body += "+\(line)\n"; newCount += 1; additions += 1
                }
            }
            let first = ops[range.lowerBound]
            let oldStart = oldCount == 0 ? first.old : first.old + 1
            let newStart = newCount == 0 ? first.new : first.new + 1
            text += "@@ -\(oldStart),\(oldCount) +\(newStart),\(newCount) @@\n" + body
        }
        return (text, additions, deletions)
    }
}
