import AppKit
import ClientDesign
import Foundation

/// What each session's row and card show beyond the session itself, as its box says it
/// (`kuvo/sessions/glance`, KuvoLink's PROTOCOL.md, "A session at a glance"): followed for the rows
/// on screen only, a box at a time, and not at all while the window can't be seen. This Mac's box
/// sends each change as it comes; a machine's answers once (`box route`), so it's asked again a
/// minute later. The box reads GitHub at most once a minute however often it's asked.
@MainActor @Observable
final class RowGlances {
    /// What each session's box last said of it, by session.
    private(set) var glances: [String: SessionGlance] = [:]
    /// Each box's routes (`AppModel.box`).
    @ObservationIgnored var boxes: ((String) -> BoxClient?)?
    /// Whether any of the app's windows can be seen now: none, and no row is on screen.
    @ObservationIgnored var isSeen: () -> Bool = { NSApp.occlusionState.contains(.visible) }
    /// How long what's on screen settles before it's followed (a scroll goes by many rows).
    @ObservationIgnored var settles: Duration = .milliseconds(400)

    /// The rows on screen, by their box: how many rows show each session (Recents and its project
    /// can both).
    @ObservationIgnored private var shown: [String: [String: Int]] = [:]
    /// What's followed now, by box: its sessions, and the task following them.
    @ObservationIgnored private var following: [String: (sessions: Set<String>, task: Task<Void, Never>)] = [:]
    @ObservationIgnored private var settling: Task<Void, Never>?
    @ObservationIgnored private var occlusion: (any NSObjectProtocol)?

    init() {
        occlusion = NotificationCenter.default.addObserver(forName: NSApplication.didChangeOcclusionStateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.settle() }
        }
    }

    /// A row of `session`'s on screen (or off it): what its box says of it is followed while one is.
    func show(_ session: String, on box: String, _ visible: Bool) {
        var counts = shown[box] ?? [:]
        counts[session] = max(0, (counts[session] ?? 0) + (visible ? 1 : -1))
        if counts[session] == 0 { counts[session] = nil }
        shown[box] = counts.isEmpty ? nil : counts
        settle()
    }

    /// Follows what's on screen a moment after it stops changing (a scroll goes by many rows).
    private func settle() {
        settling?.cancel()
        settling = Task { [weak self] in
            if let settles = self?.settles, settles > .zero { try? await Task.sleep(for: settles) }
            guard !Task.isCancelled else { return }
            self?.followShown()
        }
    }

    private func followShown() {
        // A window no one can see shows no rows.
        let seen = isSeen()
        var wanted: [String: Set<String>] = [:]
        if seen { for (box, counts) in shown { wanted[box] = Set(counts.keys) } }
        for (box, now) in following where wanted[box] != now.sessions {
            now.task.cancel()
            following[box] = nil
        }
        for (box, sessions) in wanted where following[box] == nil && !sessions.isEmpty {
            following[box] = (sessions, Task { [weak self] in await self?.follow(sessions, on: box) })
        }
    }

    private func follow(_ sessions: Set<String>, on box: String) async {
        let path = SessionGlances.path(sessions.sorted(), events: true)
        while !Task.isCancelled {
            var heard = false
            var older = false
            if let client = boxes?(box) {
                do {
                    for try await line in client.follow(path) {
                        heard = true
                        guard let answer = try? JSONDecoder().decode(SessionGlances.self, from: line) else { continue }
                        take(answer.sessions, for: sessions)
                    }
                } catch let refusal as BoxRefusal {
                    // A box from before this, which has none to give: asked again only now and then.
                    older = refusal.status == 404 || refusal.status == 403
                } catch {}
            }
            // This Mac's box streams, and a dropped stream is followed again at once; a machine's
            // answers once, and is asked again a minute later.
            try? await Task.sleep(for: .seconds(older ? 300 : box == BoxClient.mac ? (heard ? 2 : 10) : 60))
        }
    }

    private func take(_ found: [String: SessionGlance], for sessions: Set<String>) {
        for id in sessions where glances[id] != found[id] { glances[id] = found[id] }
    }

    #if DEBUG
    /// What a demo or a test shows, in place of a box's (KUVO_DEMO_GLANCES).
    func show(_ glance: SessionGlance?, for session: String) { glances[session] = glance }
    #endif
}
