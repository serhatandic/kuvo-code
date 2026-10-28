import Foundation
import OpenCodeKit

/// "/review"'s lists over the message field, as both apps show them: What to review (and the commit
/// or folder it starts with), then Look for, whose pick starts the review. Each row says how much
/// it reads, from what the box measured, and is found by the words it writes as they're typed.
public struct ReviewList: Equatable, Sendable {
    public struct Row: Identifiable, Equatable, Sendable {
        public enum Pick: Equatable, Sendable {
            /// Its words written after what's there, for the next list.
            case write(String)
            /// Its words written (none for anything wrong), and the review starts.
            case start(String)
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
    /// "1 of 2": there are two to answer.
    public let step: String?
    public let rows: [Row]

    /// What the box said about the conversation's folder.
    public struct Known: Equatable, Sendable {
        public var choices: ReviewChoices?
        /// The changes not committed yet's, the branch's and the whole project's.
        public var uncommitted: ReviewSize?
        public var branch: ReviewSize?
        public var project: ReviewSize?

        public init(choices: ReviewChoices? = nil, uncommitted: ReviewSize? = nil, branch: ReviewSize? = nil, project: ReviewSize? = nil) {
            self.choices = choices
            self.uncommitted = uncommitted
            self.branch = branch
            self.project = project
        }
    }

    /// The list for what's being typed; nil when nothing in it is what's typed.
    public static func make(_ asking: ReviewCommand.Asking, known: Known, now: Date = .now) -> ReviewList? {
        let list: ReviewList
        switch asking {
        case .what(let typed): list = ReviewList(title: "What to review", step: "1 of 2", rows: what(known).filter { $0.isFound(by: typed) })
        case .commit(let typed): list = ReviewList(title: "Start with", step: "1 of 2", rows: commits(known, typed: typed, now: now))
        case .folder(let typed): list = ReviewList(title: "Folder", step: "1 of 2", rows: folders(known, typed: typed))
        case .lookFor(let typed): list = ReviewList(title: "Look for", step: "2 of 2", rows: lookFor.filter { $0.isFound(by: typed) })
        }
        return list.rows.isEmpty ? nil : list
    }

    private static func what(_ known: Known) -> [Row] {
        let choices = known.choices
        let repository = choices?.repository != false
        var rows: [Row] = []
        if repository {
            rows.append(Row(id: "uncommitted", symbol: "plus.forwardslash.minus", title: "Changes not committed yet",
                            note: known.uncommitted.map { $0.files == 0 ? "nothing to review" : files($0.files) },
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
                        note: known.project.map { size($0).text }, warns: known.project.map { size($0).warns } ?? false,
                        pick: .write(ReviewCommand.phrase(.project) + " "), words: [ReviewCommand.phrase(.project), "whole project", "project"]))
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
        var known = ReviewList.Known()
        known.choices = try? await api.reviewChoices(session: session)
        await update(known)
        if Task.isCancelled { return }
        let repository = known.choices?.repository != false
        let onBranch = known.choices?.branch != nil
        async let uncommitted = repository ? try? api.measureReview(session: session, scope: .uncommitted) : nil
        async let branch = onBranch ? try? api.measureReview(session: session, scope: .branch(base: nil)) : nil
        async let project = try? api.measureReview(session: session, scope: .project)
        known.uncommitted = await uncommitted
        known.branch = await branch
        await update(known)
        known.project = await project
        if Task.isCancelled { return }
        await update(known)
    }
}
