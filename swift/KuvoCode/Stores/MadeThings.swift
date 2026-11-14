import AppKit
import Foundation
import ImageIO
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
        didSet { if only != oldValue { entries = []; timelineNext = nil; timelinePagedOn = false; timelineState = .loading } }
    }
    @ObservationIgnored private var thumbnails = NSCache<NSString, NSImage>()
    /// Pictures that couldn't be read, not asked for again.
    @ObservationIgnored private var unreadable = Set<String>()
    /// Older pages read with Show More: kept when the first page comes again.
    @ObservationIgnored private var pagedOn = false
    @ObservationIgnored private var timelinePagedOn = false

    /// Whether the box streams its changes: this Mac's does; a machine's, over SSH, answers once.
    private var streams: Bool { BoxClient.streams(box.box) }

    init(box: BoxClient, scope: ArtifactScope) {
        self.box = box
        self.scope = scope
    }

    /// The list now, and as it changes, for as long as the caller's task runs.
    func follow() async {
        await follow(stream: ArtifactList.path(scope, events: true), once: ArtifactList.path(scope), state: \.state) { (list: ArtifactList) in
            take(list)
        }
    }

    /// The Timeline now (one bot's, with `only`), and as it changes.
    func followTimeline() async {
        await follow(stream: ArtifactTimeline.path(scope, by: only, events: true), once: ArtifactTimeline.path(scope, by: only), state: \.timelineState) { (timeline: ArtifactTimeline) in
            take(timeline)
        }
    }

    /// The first page, as it is now: with the older ones Show More read kept after it.
    private func take(_ list: ArtifactList) {
        if pagedOn {
            artifacts = list.keeping(artifacts)
        } else {
            artifacts = list.artifacts
            next = list.next
        }
    }

    private func take(_ timeline: ArtifactTimeline) {
        if timelinePagedOn {
            entries = timeline.keeping(entries)
        } else {
            entries = timeline.entries
            timelineNext = timeline.next
        }
    }

    /// The list read again now, once: after a change made here (a pin, a version put back), which a
    /// machine's box, read every half minute, would otherwise show late.
    func reread() async {
        if let list = try? await box.value(ArtifactList.self, "GET", ArtifactList.path(scope)) { take(list) }
        if timelineState == .loaded, let timeline = try? await box.value(ArtifactTimeline.self, "GET", ArtifactTimeline.path(scope, by: only)) { take(timeline) }
    }

    /// Older ones, after those shown.
    func more() async {
        guard let next, let page = try? await box.value(ArtifactList.self, "GET", ArtifactList.path(scope) + "&before=" + Self.encoded(next)) else { return }
        artifacts += page.artifacts.filter { new in !artifacts.contains { $0.id == new.id } }
        self.next = page.next
        pagedOn = true
    }

    func moreTimeline() async {
        guard let timelineNext, let page = try? await box.value(ArtifactTimeline.self, "GET", ArtifactTimeline.path(scope, by: only) + "&before=" + Self.encoded(timelineNext)) else { return }
        entries += page.entries.filter { new in !entries.contains { $0.id == new.id } }
        self.timelineNext = page.next
        timelinePagedOn = true
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
                // Asked no more (the popover closed, another bot picked): nothing went wrong.
                if Task.isCancelled { return }
                // An older box, without the record: said plainly, and asked again now and then,
                // for once it's updated.
                if refusal.status == 404 {
                    self[keyPath: state] = .failed("This computer needs an update to show what its agents made.")
                    try? await Task.sleep(for: .seconds(60))
                    continue
                }
                if self[keyPath: state] != .loaded { self[keyPath: state] = .failed(refusal.message) }
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled { return }
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

    /// A picture's version, small (`side` points at most), kept once read; nil, and not asked for
    /// again, when it can't be.
    func thumbnail(of id: String, version: Int, side: CGFloat) async -> NSImage? {
        let key = "\(id)#\(version)"
        if let kept = thumbnails.object(forKey: key as NSString) { return kept }
        guard !unreadable.contains(key) else { return nil }
        guard let data = try? await bytes(of: id, version: version) else {
            if !Task.isCancelled { unreadable.insert(key) }
            return nil
        }
        // Made small as it's read, away from the main thread: only the pixels it shows are kept.
        let pixels = side * 2
        let image = await Task.detached(priority: .utility) { () -> CGImage? in
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            return CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                                                   kCGImageSourceCreateThumbnailWithTransform: true,
                                                                   kCGImageSourceThumbnailMaxPixelSize: pixels] as CFDictionary)
        }.value
        guard let image else {
            unreadable.insert(key)
            return nil
        }
        let small = NSImage(cgImage: image, size: NSSize(width: CGFloat(image.width) / 2, height: CGFloat(image.height) / 2))
        thumbnails.setObject(small, forKey: key as NSString)
        return small
    }

    /// What changed in `version`, since the one before it.
    func changes(of id: String, version: Int) async throws -> ArtifactChanges {
        try await box.value(ArtifactChanges.self, "GET", "kuvo/artifacts/\(id)/versions/\(version)/changes")
    }

    /// Pinned by you, or not.
    func pin(_ id: String, _ pinned: Bool) async throws {
        struct Pin: Encodable { var pinned: Bool }
        _ = try await box.value(Artifact.self, "POST", "kuvo/artifacts/\(id)/pin", body: Pin(pinned: pinned))
        if !streams { await reread() }
    }

    /// Version `version` written back to the file; what it replaces is kept as a version first.
    func restore(_ id: String, version: Int) async throws -> Artifact {
        struct Restore: Encodable { var version: Int }
        let artifact = try await box.value(Artifact.self, "POST", "kuvo/artifacts/\(id)/restore", body: Restore(version: version))
        if !streams { await reread() }
        return artifact
    }
}
