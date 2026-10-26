import AppKit
import Foundation
import KuvoLink

/// What agents made for one conversation, bot, group chat or project, as its box's record has it
/// (`kuvo/artifacts`), followed while it's shown: the popover on a conversation's bar reads this.
/// It keeps nothing of the box's own: only how you were looking at it (Shelf or Timeline, which
/// bot), and small pictures of what it shows.
@Observable
final class MadeThings {
    let box: BoxClient
    let scope: ArtifactScope

    enum State: Equatable {
        case loading
        case loaded
        /// The box couldn't say (it's starting, or an older one without the record), and why.
        case failed(String)
    }

    enum Mode: Hashable { case shelf, timeline }

    /// How the list is (`follow`), and the Timeline (`followTimeline`): each loads on its own.
    private(set) var state: State = .loading
    private(set) var timelineState: State = .loading
    /// The scope's artifacts, pinned first, then the latest changed.
    private(set) var artifacts: [ArtifactSummary] = []
    /// Older ones there are, past those the box sent (`more`).
    private(set) var next: String?
    /// Every version made there, newest first, and one bot's only when `only` says so.
    private(set) var entries: [ArtifactTimeline.Entry] = []
    private(set) var timelineNext: String?
    /// How you were looking at it: kept while the conversation shows, so the popover opens there again.
    var mode: Mode = .shelf
    var only: String? {
        didSet { if only != oldValue { entries = []; timelineState = .loading } }
    }
    @ObservationIgnored private var thumbnails = NSCache<NSString, NSImage>()

    /// Whether the box streams its changes: this Mac's does; a machine's, over SSH, answers once.
    private var streams: Bool { box.box == BoxClient.mac }

    init(box: BoxClient, scope: ArtifactScope) {
        self.box = box
        self.scope = scope
    }

    /// The list now, and as it changes, for as long as the caller's task runs.
    func follow() async {
        await follow(stream: ArtifactList.path(scope, events: true), once: ArtifactList.path(scope), state: \.state) { (list: ArtifactList) in
            artifacts = list.artifacts
            next = list.next
        }
    }

    /// The Timeline now (one bot's, with `only`), and as it changes.
    func followTimeline() async {
        await follow(stream: ArtifactTimeline.path(scope, by: only, events: true), once: ArtifactTimeline.path(scope, by: only), state: \.timelineState) { (timeline: ArtifactTimeline) in
            entries = timeline.entries
            timelineNext = timeline.next
        }
    }

    /// Older ones, after those shown.
    func more() async {
        guard let next, let page = try? await box.value(ArtifactList.self, "GET", ArtifactList.path(scope) + "&before=" + Self.encoded(next)) else { return }
        artifacts += page.artifacts.filter { new in !artifacts.contains { $0.id == new.id } }
        self.next = page.next
    }

    func moreTimeline() async {
        guard let timelineNext, let page = try? await box.value(ArtifactTimeline.self, "GET", ArtifactTimeline.path(scope, by: only) + "&before=" + Self.encoded(timelineNext)) else { return }
        entries += page.entries.filter { new in !entries.contains { $0.id == new.id } }
        self.timelineNext = page.next
    }

    private static func encoded(_ cursor: String) -> String {
        cursor.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? cursor
    }

    /// Each line of `stream` taken as it comes, from this Mac's box; a machine's (over SSH, which
    /// can't follow) read `once` now and every half minute. Again after a dropped connection.
    private func follow<Line: Decodable>(stream: String, once: String, state: ReferenceWritableKeyPath<MadeThings, State>, take: (Line) -> Void) async {
        while !Task.isCancelled {
            do {
                if streams {
                    for try await data in box.follow(stream) {
                        take(try JSONDecoder().decode(Line.self, from: data))
                        self[keyPath: state] = .loaded
                    }
                } else {
                    take(try await box.value(Line.self, "GET", once))
                    self[keyPath: state] = .loaded
                }
            } catch let refusal as BoxRefusal {
                // An older box, without the record: said plainly, and not asked again.
                if refusal.status == 404 {
                    self[keyPath: state] = .failed("This computer needs an update to show what its agents made.")
                    return
                }
                if self[keyPath: state] != .loaded { self[keyPath: state] = .failed(refusal.message) }
            } catch is CancellationError {
                return
            } catch {
                if self[keyPath: state] != .loaded { self[keyPath: state] = .failed(error.localizedDescription) }
            }
            try? await Task.sleep(for: .seconds(streams ? 3 : 30))
        }
    }

    /// One artifact with all its versions.
    func artifact(_ id: String) async throws -> Artifact {
        try await box.value(Artifact.self, "GET", "kuvo/artifacts/\(id)")
    }

    /// A version's bytes.
    func bytes(of id: String, version: Int) async throws -> Data {
        let (status, data) = try await box.send("GET", "kuvo/artifacts/\(id)/versions/\(version)")
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        return data
    }

    /// A picture's version, small (`side` points at most), kept once read.
    func thumbnail(of id: String, version: Int, side: CGFloat) async -> NSImage? {
        let key = "\(id)#\(version)" as NSString
        if let kept = thumbnails.object(forKey: key) { return kept }
        guard let data = try? await bytes(of: id, version: version), let image = NSImage(data: data) else { return nil }
        let small = Self.downsampled(image, side: side * 2)
        thumbnails.setObject(small, forKey: key)
        return small
    }

    private static func downsampled(_ image: NSImage, side: CGFloat) -> NSImage {
        let size = image.size
        let scale = min(1, side / max(size.width, size.height, 1))
        guard scale < 1 else { return image }
        let target = NSSize(width: size.width * scale, height: size.height * scale)
        return NSImage(size: target, flipped: false) { rect in
            image.draw(in: rect)
            return true
        }
    }

    /// What changed in `version`, since the one before it.
    func changes(of id: String, version: Int) async throws -> ArtifactChanges {
        try await box.value(ArtifactChanges.self, "GET", "kuvo/artifacts/\(id)/versions/\(version)/changes")
    }

    /// Pinned by you, or not.
    func pin(_ id: String, _ pinned: Bool) async throws {
        struct Pin: Encodable { var pinned: Bool }
        _ = try await box.value(Artifact.self, "POST", "kuvo/artifacts/\(id)/pin", body: Pin(pinned: pinned))
    }

    /// Version `version` written back to the file; what it replaces is kept as a version first.
    func restore(_ id: String, version: Int) async throws -> Artifact {
        struct Restore: Encodable { var version: Int }
        return try await box.value(Artifact.self, "POST", "kuvo/artifacts/\(id)/restore", body: Restore(version: version))
    }
}
