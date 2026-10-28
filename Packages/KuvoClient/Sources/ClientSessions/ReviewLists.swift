import Foundation
import OpenCodeKit

/// "/review"'s lists over the message field, as both apps show them: What to review (and the commit
/// or folder it starts with; or your own words for it, the list closed), then Look for, whose pick
/// starts the review. Each row says how much
/// it reads, from what the box measured, and is found by the words it writes as they're typed.
public struct ReviewList: Equatable, Sendable {
    public struct Row: Identifiable, Equatable, Sendable {
        public enum Pick: Equatable, Sendable {
            /// Its words written after what's there, for the next list.
            case write(String)
            /// Its words written (none for anything wrong), and the review starts.
            case start(String)
            /// Nothing written: the list closes for words of your own.
            case ownWords
        }

        public let id: String
        /// An SF Symbol.
        public let symbol: String
        public let title: String
        /// How much it reads, or what it is ("3 files", "pick where to start"); nil while it's measured.
        public var note: String?
        /// The note says it takes a while.
        public var warns = false
        public let pick: Pick
        /// Words that find it as they're typed.
        var words: [String] = []
    }

    public let title: String
    public let rows: [Row]

    /// What the box said about the conversation's folder.
    public struct Known: Equatable, Sendable {
        public var choices: ReviewChoices?
        /// The changes not committed yet's, the branch's and the whole project's.
        public var uncommitted: ReviewSize?
        public var branch: ReviewSize?
        public var project: ReviewSize?
        /// Every size asked for has come (or can't be told): one still missing is being measured.
        public var measured: Bool
        /// False for a box from before scopes, which reads only the changes not committed yet.
        public var readsScopes = true

        public init(choices: ReviewChoices? = nil, uncommitted: ReviewSize? = nil, branch: ReviewSize? = nil, project: ReviewSize? = nil, measured: Bool = true) {
            self.choices = choices
            self.uncommitted = uncommitted
            self.branch = branch
            self.project = project
            self.measured = measured
        }

        /// A size's words, or "…" while it's measured.
        func note(_ size: ReviewSize?, _ words: (ReviewSize) -> String) -> String? {
            size.map(words) ?? (measured ? nil : "…")
        }
    }

    /// The list for what's being typed; nil when nothing in it is what's typed, or the box reads
    /// only the changes not committed yet.
    public static func make(_ asking: ReviewCommand.Asking, known: Known, now: Date = .now) -> ReviewList? {
        guard known.readsScopes else { return nil }
        let list: ReviewList
        switch asking {
        case .what(let typed): list = ReviewList(title: "What to review", rows: what(known).filter { $0.isFound(by: typed) })
        case .commit(let typed): list = ReviewList(title: "Start with", rows: commits(known, typed: typed, now: now))
        case .folder(let typed): list = ReviewList(title: "Folder", rows: folders(known, typed: typed))
        case .lookFor(let typed): list = ReviewList(title: "Look for", rows: lookFor.filter { $0.isFound(by: typed) })
        }
        return list.rows.isEmpty ? nil : list
    }

    private static func what(_ known: Known) -> [Row] {
        let choices = known.choices
        let repository = choices?.repository != false
        var rows: [Row] = []
        if repository {
            rows.append(Row(id: "uncommitted", symbol: "plus.forwardslash.minus", title: "Changes not committed yet",
                            note: known.note(known.uncommitted) { $0.files == 0 ? "nothing to review" : files($0.files) },
                            pick: .write(ReviewCommand.phrase(.uncommitted) + " "), words: [ReviewCommand.phrase(.uncommitted), "uncommitted"]))
            if let branch = choices?.branch {
                rows.append(Row(id: "branch", symbol: "arrow.triangle.branch", title: "This branch against \(branch.base)",
                                note: known.branch.map { counted(branch.commits, "commit") + " · " + size($0).text } ?? counted(branch.commits, "commit"),
                                warns: known.branch.map { size($0).warns } ?? false,
                                pick: .write(ReviewCommand.phrase(.branch(base: nil)) + " "), words: [ReviewCommand.phrase(.branch(base: nil)), "branch"]))
            }
            if choices?.commits.isEmpty != true {
                rows.append(Row(id: "commits", symbol: "clock.arrow.circlepath", title: "Commits…", note: "pick where to start",
                                pick: .write("since "), words: ["since ", "commits"]))
            }
        }
        let top = (choices?.folders ?? []).filter { !$0.path.contains("/") }.map(\.path)
        if choices == nil || !top.isEmpty {
            rows.append(Row(id: "folder", symbol: "folder", title: "A folder…",
                            note: top.isEmpty ? nil : top.prefix(3).joined(separator: ", ") + (top.count > 3 ? "…" : ""),
                            pick: .write("folder "), words: ["folder ", "a folder"]))
        }
        rows.append(Row(id: "project", symbol: "cube", title: "The whole project",
                        note: known.note(known.project) { size($0).text }, warns: known.project.map { size($0).warns } ?? false,
                        pick: .write(ReviewCommand.phrase(.project) + " "), words: [ReviewCommand.phrase(.project), "whole project", "project"]))
        // (Only from a box that finds the files words describe.)
        if choices?.describes == true {
            rows.append(Row(id: "described", symbol: "pencil", title: "Something else…", note: "say what to review",
                            pick: .ownWords, words: ["something else"]))
        }
        return rows
    }


    private static func commits(_ known: Known, typed: String, now: Date) -> [Row] {
        let typed = typed.lowercased()
        let commits = (known.choices?.commits ?? []).filter { typed.isEmpty || $0.id.hasPrefix(typed) || $0.title.lowercased().contains(typed) }
        return commits.prefix(8).map { commit in
            Row(id: commit.id, symbol: "clock.arrow.circlepath", title: commit.title.isEmpty ? commit.short : commit.title,
                note: commit.short + " · " + commit.date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)),
                pick: .write(ReviewCommand.phrase(.commits(from: commit.short + "^", to: nil)) + " "))
        }
    }

    private static func folders(_ known: Known, typed: String) -> [Row] {
        let typed = typed.lowercased()
        let all = known.choices?.folders ?? []
        let starting = all.filter { typed.isEmpty || $0.path.lowercased().hasPrefix(typed) }
        let containing = typed.isEmpty ? [] : all.filter { !$0.path.lowercased().hasPrefix(typed) && $0.path.lowercased().contains(typed) }
        return (starting + containing).prefix(8).map { folder in
            Row(id: folder.path, symbol: "folder", title: folder.path, note: files(folder.files),
                pick: .write(ReviewCommand.phrase(.folder(folder.path)) + " "))
        }
    }

    private static let lookFor: [Row] = [
        Row(id: "anything", symbol: "magnifyingglass", title: "Anything wrong", note: "bugs first, then risks", pick: .start(""), words: ["anything wrong"]),
        Row(id: "security", symbol: "lock", title: "Security", note: "injection, secrets, sign-in, leaks",
            pick: .start(ReviewCommand.phrase(.security)), words: [ReviewCommand.phrase(.security), "security"]),
        Row(id: "performance", symbol: "bolt", title: "Performance", note: "slow paths, waste, growth",
            pick: .start(ReviewCommand.phrase(.performance)), words: [ReviewCommand.phrase(.performance), "performance"]),
        Row(id: "accessibility", symbol: "accessibility", title: "Accessibility", note: "labels, keyboard, contrast, text size",
            pick: .start(ReviewCommand.phrase(.accessibility)), words: [ReviewCommand.phrase(.accessibility), "accessibility"]),
        Row(id: "else", symbol: "pencil", title: "Something else…", note: "say what to look at", pick: .write("for "), words: ["something else"]),
    ]

    /// "312 files · read in 9 parts, takes a while": more than a couple of parts is long.
    private static func size(_ size: ReviewSize) -> (text: String, warns: Bool) {
        let text = files(size.files)
        if size.parts >= 3 { return (text + " · read in \(size.parts) parts, takes a while", true) }
        if size.parts == 2 { return (text + " · read in 2 parts", false) }
        return (text, false)
    }

    private static func files(_ count: Int) -> String { counted(count, "file") }

    private static func counted(_ count: Int, _ word: String) -> String {
        count == 1 ? "1 \(word)" : "\(count.formatted()) \(word)s"
    }
}

extension ReviewList {
    /// What "/review" still needs before it can be read, said as the composer says it; nil when
    /// nothing.
    public static func unfinished(_ command: ReviewCommand) -> String? {
        guard command.scope == nil else { return nil }
        switch command.asking {
        case .commit(""): return "Write the commit to start with after “since”."
        case .folder(""): return "Write the folder to review after “folder”."
        default: return nil
        }
    }

    /// The line under what a review found: what it covered and who read it ("The whole project ·
    /// security · read by Claude Sonnet 4.5"), for one asked for more than today's.
    public static func footnote(_ review: Review, readerName: String?) -> String? {
        guard review.state == .done, review.scope != nil || review.focus != nil else { return nil }
        var focus: [String] = []
        if let asked = review.focus {
            // A preset, your words, or both ("security: the sign-in").
            let preset = ReviewCommand.Preset.allCases.first { asked == $0.rawValue || asked.hasPrefix($0.rawValue + ": ") }
            if let preset { focus.append(preset.rawValue) }
            let words = preset.map { asked.dropFirst($0.rawValue.count).drop { $0 == ":" || $0 == " " } }.map(String.init) ?? asked
            if !words.isEmpty { focus.append("“\(words)”") }
        }
        return ([(review.scope ?? .uncommitted).title] + focus + [readerName.map { "read by " + $0 }].compactMap(\.self)).joined(separator: " · ")
    }
}

extension ReviewList.Row {
    func isFound(by typed: String) -> Bool {
        let typed = typed.lowercased()
        return typed.isEmpty || words.contains { $0.hasPrefix(typed) } || title.lowercased().hasPrefix(typed)
    }
}

extension ReviewList.Known {
    /// Asks `api`'s box about `session`'s folder: what it offers, then how much each would read,
    /// each as it comes (`update`). What can't be told is left out.
    public static func load(session: String, api: OpenCodeAPI, update: @MainActor @Sendable (ReviewList.Known) -> Void) async {
        var known = ReviewList.Known(measured: false)
        await update(known)
        do {
            known.choices = try await api.reviewChoices(session: session)
        } catch let error as ServerError where error.status == 404 && error.message.contains("has no review") {
            // A box from before scopes, which reads "choices" as asking for the review: today's
            // review, no lists.
            known.readsScopes = false
            known.measured = true
        } catch is DecodingError {
            // The same, with a review to answer.
            known.readsScopes = false
            known.measured = true
        } catch {}
        // Left for another conversation, or "/review" gone: nothing of this one's is shown.
        if Task.isCancelled { return }
        await update(known)
        guard known.readsScopes else { return }
        let repository = known.choices?.repository != false
        let onBranch = known.choices?.branch != nil
        async let uncommitted = repository ? try? api.measureReview(session: session, scope: .uncommitted) : nil
        async let branch = onBranch ? try? api.measureReview(session: session, scope: .branch(base: nil)) : nil
        async let project = try? api.measureReview(session: session, scope: .project)
        known.uncommitted = await uncommitted
        known.branch = await branch
        if Task.isCancelled { return }
        await update(known)
        known.project = await project
        known.measured = true
        if Task.isCancelled { return }
        await update(known)
    }
}

/// A review's parts, as both apps list them in its card: each part's name and its line, which
/// says what it's doing while it reads ("Reading src/a.ts"), then what it found.
extension Review.Part {
    /// "Part 2"; "The reviewer" when it's the only one.
    public var title: String { of > 1 ? "Part \(n)" : "The reviewer" }

    /// Its line: what it's doing now, what it found, or what it will read.
    public var line: String {
        let count = fileCount ?? files.count
        let reads = count == 1 ? "1 file" : "\(count.formatted()) files"
        switch state {
        case .waiting: return reads
        case .reading: return now ?? "Starting"
        case .done: return found == 0 ? "\(reads) · found nothing" : "\(reads) · \(found) found"
        case .failed: return "Couldn’t be read"
        case .stopped: return found == 0 ? "Stopped" : "Stopped · \(found) found"
        }
    }

    /// It can be opened: it reads, or read, in a session of its own.
    public var opens: Bool { session != nil && state != .waiting }
}

extension Review {
    /// Read on a box from before parts: under way, it can't say what each part does.
    public var hasNoParts: Bool { state == .reviewing && parts == nil }
}

/// What a review's part that failed says in its own view, in the composer's place: plainly, and
/// what became of its review.
public enum ReviewPartWords {
    /// `alone`: it was the review's only part.
    public static func failed(stopped: Bool, alone: Bool) -> String {
        switch (stopped, alone) {
        case (true, false): "This part was stopped. The review went on with the others."
        case (false, false): "This part couldn’t be read. The review went on with the others."
        case (true, true): "Stopped."
        case (false, true): "The reviewer couldn’t read this, so the review couldn’t be done. Ask for it again."
        }
    }
}
