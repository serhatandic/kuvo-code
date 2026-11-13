import Foundation
import ClientSessions
import KuvoLink

/// What each box told you lately (`kuvo/notices/events`, PROTOCOL.md "kuvo/notices"), on this Mac's
/// box and each machine's: a run's news, a group chat's, and what an agent sent you on purpose
/// (notify_user). The box alone decides what's news (a reply to you, not a bot's wake-up) and says it
/// in a sentence; this Mac shows it as it says it. What's asked of you (a permission, a question, a
/// browser's ask) it still shows from its own cards, with their buttons.
@MainActor
final class BoxNotices {
    weak var app: AppModel?
    /// A box's client (a test's own); the app's otherwise.
    var boxes: ((String) -> BoxClient)?
    /// A machine connected and ready (a test's own answer).
    var connected: ((String) -> Bool)?
    /// Shows a notice of `box`'s (a test's own; Notifier's otherwise).
    var show: ((_ notice: Told.Notice, _ box: String) -> Void)?
    /// Usage delivery is global to this app, survives relaunch, and includes the initial read.
    var usageDelivery = UsageNoticeDelivery()
    var showUsage: ((_ notice: Told.Notice, _ id: String) async -> Bool)?
    /// What's been shown, by box: a box's first read was news before this Mac was there.
    private var shown: [String: Set<String>] = [:]
    /// Whether each box tells its news now (its bridge runs), as it last said.
    private var telling: [String: Bool] = [:]

    /// What a box says it told (`kuvo/notices`).
    struct Told: Decodable, Equatable {
        struct Notice: Decodable, Equatable {
            var title: String?
            var subtitle: String?
            var body: String?
            var category: KuvoLink.Notice.Category
            var thread: String?
            var data: [String: String]?
        }
        struct Entry: Decodable, Equatable {
            var id: String
            var notice: Notice
        }
        var telling: Bool?
        var notices: [Entry]

        private enum Keys: String, CodingKey { case telling, notices }
        /// One that can't be read: left out, not the rest with it.
        private struct Maybe: Decodable {
            var entry: Entry?
            init(from decoder: Decoder) throws { entry = try? Entry(from: decoder) }
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: Keys.self)
            telling = try container.decodeIfPresent(Bool.self, forKey: .telling)
            notices = (try container.decodeIfPresent([Maybe].self, forKey: .notices) ?? []).compactMap(\.entry)
        }
    }

    /// The kinds of news shown from here: the rest are asks, shown from their own cards.
    static let news: Set<KuvoLink.Notice.Category> = [.finished, .failed, .report, .message]

    /// Whether `box` tells its own news, so this Mac shows its notices and words none itself.
    func tells(_ box: String) -> Bool { telling[box] == true }

    func client(_ box: String) -> BoxClient? {
        boxes?(box) ?? app?.box(box)
    }

    /// `box`'s notices, from now on, until the task following it ends (a machine disconnecting, or
    /// removed): read as it connects, and followed while it's connected and ready. A box from before them is asked again only
    /// now and then, and words its own as it did.
    func follow(_ box: String) async {
        // (Followed as it changes on the app's own box, which streams; read now and then on any
        // other, the one attached in place too, which answers once a read.)
        let onThisMac = BoxClient.streams(box)
        var older = false
        var first = true
        while !Task.isCancelled {
            // A machine's read as it connects, then again a while after its stream ends.
            if !onThisMac {
                if !first { try? await Task.sleep(for: .seconds(older ? 300 : 30)) }
                first = false
                guard !Task.isCancelled, connected?(box) ?? (app?.machines.engine(box)?.isReady == true) else { continue }
            }
            older = false
            if let client = client(box) {
                do {
                    for try await line in client.follow("kuvo/notices/events") {
                        guard let told = try? JSONDecoder().decode(Told.self, from: line) else { continue }
                        take(told, from: box)
                    }
                } catch let refusal as BoxRefusal {
                    older = refusal.status == 404 || refusal.status == 403
                } catch {}
            }
            // (Not heard for a moment: it still tells its news as it last said, and what it told
            // meanwhile shows once it's heard again.)
            if onThisMac { try? await Task.sleep(for: .seconds(older ? 300 : 2)) }
        }
    }

    /// What `box` told lately: each not shown yet, shown once (all of it, the first time it's read).
    @discardableResult
    func take(_ told: Told, from box: String) -> Task<Void, Never> {
        telling[box] = told.telling ?? true
        let first = shown[box] == nil
        var seen = shown[box] ?? []
        for entry in told.notices where seen.insert(entry.id).inserted && !first && Self.news.contains(entry.notice.category) {
            (show ?? Self.notify)(entry.notice, box)
        }
        // (Only what it still lists: older ones won't come again.)
        shown[box] = seen.intersection(told.notices.map(\.id))
        return Task {
            for entry in told.notices where entry.notice.category == .usage {
                guard let id = entry.notice.data?["notice"], !id.isEmpty else { continue }
                await usageDelivery.deliver(id: id) {
                    if let showUsage { return await showUsage(entry.notice, id) }
                    return await Notifier.shared.usage(id: id, title: entry.notice.title ?? "",
                                                       subtitle: entry.notice.subtitle, body: entry.notice.body ?? "")
                }
            }
        }
    }

    /// A notice as this Mac's notification: its conversation or group chat opens from it, Reply
    /// writes back; its box tells your phones itself.
    static func notify(_ notice: Told.Notice, box: String) {
        // (The box it's from, told it's shown here, and that tells phones itself; nil: the app's own.)
        let machine = box == BoxClient.mac ? nil : box
        let group = notice.data?["group"]
        guard let session = group.map(BotGroups.tabKey) ?? notice.data?["session"] else { return }
        Notifier.shared.notify(session: session, title: notice.title ?? "", subtitle: notice.subtitle, body: notice.body ?? "",
                               replies: true, push: .init(notice.category, group: group, machine: machine))
    }
}
