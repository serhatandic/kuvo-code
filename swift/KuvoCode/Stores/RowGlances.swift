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
    /// When each box may be asked again: a machine answers once a minute at most, and one from
    /// before this only every few minutes, however often the rows on screen change.
    @ObservationIgnored private var notBefore: [String: ContinuousClock.Instant] = [:]
    /// When each session was last asked of, and when its last row went off screen (its glance is let
    /// go a while after).
    @ObservationIgnored private var askedAt: [String: ContinuousClock.Instant] = [:]
    @ObservationIgnored private var hiddenAt: [String: ContinuousClock.Instant] = [:]
    /// Boxes from before this, with no glance to give.
    @ObservationIgnored private var older: Set<String> = []
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
        if counts[session] == 0 {
            counts[session] = nil
            hiddenAt[session] = .now
        } else {
            hiddenAt[session] = nil
        }
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
        // What's been off screen a while goes: its row asks again as it comes back.
        let stale = hiddenAt.filter { ContinuousClock.now - $0.value > .seconds(600) }.map(\.key)
        for id in stale {
            hiddenAt[id] = nil
            askedAt[id] = nil
            glances[id] = nil
        }
    }

    /// Stops following anything (a test's end).
    func stop() {
        settling?.cancel()
        for (_, each) in following { each.task.cancel() }
        following = [:]
    }

    private func follow(_ sessions: Set<String>, on box: String) async {
        let path = SessionGlances.path(sessions.sorted(), events: true)
        // (A box that streams has them followed: the app's own, and the one attached in place while
        // it's reached over its server, asked each round; every other answers once.)
        var isMac: Bool { BoxClient.streams(box) }
        while !Task.isCancelled {
            // Not asked again before its time: unless (on a machine) a row came that wasn't asked of
            // lately, whose glance is wanted now.
            if let due = notBefore[box], due > .now {
                let fresh = sessions.allSatisfy { askedAt[$0].map { ContinuousClock.now - $0 < .seconds(60) } ?? false }
                if isMac || fresh || older.contains(box) { try? await Task.sleep(until: due) }
                guard !Task.isCancelled else { return }
            }
            var heard = false
            var isOlder = false
            if let client = boxes?(box) {
                do {
                    for try await line in client.follow(path) {
                        heard = true
                        guard let answer = try? JSONDecoder().decode(SessionGlances.self, from: line) else { continue }
                        take(answer.sessions, for: sessions)
                    }
                } catch let refusal as BoxRefusal {
                    // A box from before this, which has none to give: asked again only now and then.
                    isOlder = refusal.status == 404 || refusal.status == 403
                } catch {}
            }
            // Let go of (the rows changed): the next one asks when it's time.
            if Task.isCancelled { return }
            if isOlder { older.insert(box) } else if heard { older.remove(box) }
            // This Mac's box streams, and a dropped stream is followed again at once; a machine's
            // answers once, and is asked again a minute later.
            notBefore[box] = .now + .seconds(isOlder ? 300 : isMac ? (heard ? 2 : 10) : 60)
        }
    }

    private func take(_ found: [String: SessionGlance], for sessions: Set<String>) {
        for id in sessions {
            askedAt[id] = .now
            if glances[id] != found[id] { glances[id] = found[id] }
        }
    }

    #if DEBUG
    /// What a test or the shots show, in place of a box's.
    func show(_ glance: SessionGlance?, for session: String) { glances[session] = glance }
    #endif
}
