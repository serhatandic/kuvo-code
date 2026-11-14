import ClientAccounts
import ClientSessions
import Foundation
import KuvoLink
import Observation

/// What bots ask you before they do it (`kuvo/work/asks`, PROTOCOL.md "Work"): making a project,
/// on this Mac's box or a machine's. Followed as it changes on each box, shown as a card on the
/// conversation asking, and answered there, on its box, where it's done. A phone answering it
/// first takes it away here too.
@MainActor @Observable
final class BotAsks {
    @ObservationIgnored weak var app: AppModel?
    /// What's asked on each box, by its id ("mac", or a machine's).
    private(set) var asked: [String: [WorkAsk]] = [:]
    /// Those being answered now, by id: their cards wait, wherever they show.
    private(set) var answering: Set<String> = []
    /// A box's client (a test's own); the app's otherwise.
    @ObservationIgnored var boxes: ((String) -> BoxClient)?
    /// The conversations asking now, for their marks in the sidebar and the Dock's count.
    @ObservationIgnored var onChange: ((Set<String>) -> Void)?
    /// What's been told, so each ask is told once.
    @ObservationIgnored private var told: Set<String> = []
    /// Each box's follow now, so one that ended (a reconnect) leaves the next one's asks alone.
    @ObservationIgnored private var following: [String: UUID] = [:]

    private func client(_ box: String) -> BoxClient? {
        boxes?(box) ?? app?.box(box)
    }

    /// What the conversation `session` asks now, with the box it's asked on.
    func asks(for session: String) -> [(box: String, ask: WorkAsk)] {
        all.flatMap { box, asks in asks.filter { $0.session == session }.map { (box: box, ask: $0) } }.sorted { $0.ask.at < $1.ask.at }
    }

    private var all: [String: [WorkAsk]] {
        var all = asked
        #if DEBUG
        if !demo.isEmpty { all[BoxClient.mac, default: []] += demo }
        #endif
        return all
    }

    #if DEBUG
    /// An ask on this Mac, for a look at its card (KUVO_DEMO_BOT_ASK): beside what its box asks.
    var demo: [WorkAsk] = [] {
        didSet { changed() }
    }
    #endif

    /// What `box` asks, from now on, until the task following it ends (a machine disconnecting,
    /// or removed). This Mac's box tells each change as it's made; a machine's, reached over SSH,
    /// is read as it connects (`read`, one of its connection's steps), then again every half
    /// minute while it's connected, and as a bot's work there says it asks something. A box from
    /// before bots made projects is asked again only now and then.
    func follow(_ box: String) async {
        let me = UUID()
        following[box] = me
        // (Followed as it changes on a box that streams (the app's own, and the one attached in place
        // while it's reached over its server: asked each round); read now and then on any other, which
        // answers once a read.)
        var onThisMac: Bool { BoxClient.streams(box) }
        var older = false
        while !Task.isCancelled {
            if !onThisMac {
                try? await Task.sleep(for: .seconds(older ? 300 : 30))
                // Not while it's away or starting over: nothing goes to it then.
                guard !Task.isCancelled, isConnected(box) else { continue }
            }
            older = false
            if let client = client(box) {
                do {
                    for try await line in client.follow("kuvo/work/asks/events") {
                        guard let list = try? JSONDecoder().decode(WorkAskList.self, from: line) else { continue }
                        take(list.asks, from: box)
                    }
                } catch let refusal as BoxRefusal {
                    older = refusal.status == 404 || refusal.status == 403
                } catch {}
            }
            if onThisMac { try? await Task.sleep(for: .seconds(older ? 300 : 2)) }
        }
        // Gone with its connection: nothing it asked can be answered from here now. What it still
        // asks keeps its notification, and isn't told again when it's back.
        if following[box] == me {
            following[box] = nil
            asked[box] = nil
            changed()
        }
    }

    /// A machine connected and ready, which its asks are read from (a test's own answer).
    @ObservationIgnored var connected: ((String) -> Bool)?
    private func isConnected(_ box: String) -> Bool {
        connected?(box) ?? (app?.machines.engine(box)?.isReady == true)
    }

    /// What `box` asks now, read once (as it connects, and as a bot's work there says it asks
    /// something new).
    func read(_ box: String) async {
        guard BoxClient.isThisMac(box) || isConnected(box), let client = client(box), let list = try? await client.value(WorkAskList.self, "GET", "kuvo/work/asks") else { return }
        take(list.asks, from: box)
    }

    /// What `box` asks now, in place of what it asked before: each new one told once, and each
    /// gone (answered here, on a phone, or no longer asked) taken off Notification Center and
    /// your phones.
    func take(_ asks: [WorkAsk], from box: String) {
        let before = asked[box] ?? []
        guard asks != before else { return }
        asked[box] = asks.isEmpty ? nil : asks
        for ask in asks where !told.contains(ask.id) {
            told.insert(ask.id)
            tell(ask, on: box)
        }
        for gone in before where !asks.contains(where: { $0.id == gone.id }) {
            Notifier.shared.clear(request: gone.id)
        }
        changed()
    }

    private func changed() {
        onChange?(Set(all.values.joined().map(\.session)))
    }

    // A notification for it: this Mac's box tells your phones its own; a machine tells them itself.
    private func tell(_ ask: WorkAsk, on box: String) {
        // (A reset's, in its box's words, as its phones get them.)
        let title = ask.words?.title ?? (ask.action == .cloneProject ? "\(ask.name) asks to clone a project" : "\(ask.name) asks to make a project")
        let body = ask.words?.body ?? ask.folder.map { BoxClient.isThisMac(box) ? ($0 as NSString).abbreviatingWithTildeInPath : $0 } ?? ask.project
        Notifier.shared.notify(session: ask.session, title: title, body: body, push: .init(.ask, ask: ask.id, machine: box == BoxClient.mac ? nil : box, answerable: false))
    }

    /// How an answer went: what was done, in words (the bot is told too), and whether it failed.
    struct Answered: Decodable {
        var text: String
        var isError: Bool
    }

    /// Your answer, on its box, where what's asked is done. `folder`: where projects go on that box
    /// from now on, picked as you answer the first one there. Nil for one answered meanwhile on
    /// another client (or no longer asked), which is gone here then too.
    @discardableResult
    func answer(_ ask: WorkAsk, on box: String, _ answer: WorkAskAnswer, folder: String? = nil) async throws -> Answered? {
        guard let client = client(box) else { throw BoxRefusal(status: 503, message: "\(app?.machines.engine(box)?.machine.name ?? "Its computer") can’t be reached now. Try again once it’s connected.") }
        guard answering.insert(ask.id).inserted else { return nil }
        defer { answering.remove(ask.id) }
        struct Given: Encodable {
            var answer: WorkAskAnswer
            var folder: String?
        }
        let done: Answered?
        do {
            done = try await client.value(Answered.self, "POST", "kuvo/work/asks/\(ask.id)", body: Given(answer: answer, folder: ask.needsFolder && answer != .deny ? folder : nil))
        } catch let refusal as BoxRefusal where refusal.status == 404 {
            done = nil
        }
        // Gone here at once; its box's next line says so too.
        take((asked[box] ?? []).filter { $0.id != ask.id }, from: box)
        guard let done else { return nil }
        if answer == .always { await app?.bots.refresh(box) }
        // A machine's projects are read as it connects: the new one, now. (This Mac's are followed.)
        if answer != .deny, !BoxClient.streams(box) { await app?.workspace.loadProjects(on: box) }
        return done
    }
}
