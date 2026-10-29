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
    /// A box's client (a test's own); the app's otherwise.
    @ObservationIgnored var boxes: ((String) -> BoxClient)?
    /// The conversations asking now, for their marks in the sidebar and the Dock's count.
    @ObservationIgnored var onChange: ((Set<String>) -> Void)?
    /// What's been told, so each ask is told once.
    @ObservationIgnored private var told: Set<String> = []

    private func client(_ box: String) -> BoxClient? {
        boxes?(box) ?? app?.box(box)
    }

    /// What the conversation `session` asks now, with the box it's asked on.
    func asks(for session: String) -> [(box: String, ask: WorkAsk)] {
        var all = asked
        #if DEBUG
        if !demo.isEmpty { all[BoxClient.mac, default: []] += demo }
        #endif
        return all.flatMap { box, asks in asks.filter { $0.session == session }.map { (box: box, ask: $0) } }.sorted { $0.ask.at < $1.ask.at }
    }

    #if DEBUG
    /// An ask on this Mac, for a look at its card (KUVO_DEMO_BOT_ASK): beside what its box asks.
    var demo: [WorkAsk] = [] {
        didSet { onChange?(Set((asked.values.joined() + demo).map(\.session))) }
    }
    #endif

    /// What `box` asks, from now on, until the task following it ends (a machine disconnecting);
    /// a box from before bots made projects is asked again only now and then.
    func follow(_ box: String) async {
        while !Task.isCancelled {
            var older = false
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
            try? await Task.sleep(for: .seconds(older ? 300 : 2))
        }
        // Gone with its connection: nothing it asked can be answered from here now.
        take([], from: box)
    }

    /// What `box` asks now, read once.
    func read(_ box: String) async {
        guard let client = client(box), let list = try? await client.value(WorkAskList.self, "GET", "kuvo/work/asks") else { return }
        take(list.asks, from: box)
    }

    /// What `box` asks now, in place of what it asked before: each new one told once.
    func take(_ asks: [WorkAsk], from box: String) {
        let before = asked[box] ?? []
        guard asks != before else { return }
        asked[box] = asks.isEmpty ? nil : asks
        for ask in asks where !told.contains(ask.id) {
            told.insert(ask.id)
            tell(ask, on: box)
        }
        onChange?(Set(asked.values.joined().map(\.session)))
    }

    // A notification for it: this Mac's sends your phones theirs; a machine sends its own.
    private func tell(_ ask: WorkAsk, on box: String) {
        let title = ask.action == .cloneProject ? "\(ask.name) asks to clone a project" : "\(ask.name) asks to make a project"
        let body = ask.folder.map { BoxPaths.display($0, home: box == BoxClient.mac ? NSHomeDirectory() : nil) } ?? ask.project
        Notifier.shared.notify(session: ask.session, title: title, body: body, push: box == BoxClient.mac ? .init(.ask, ask: ask.id, answerable: false) : nil)
    }

    /// Your answer, on its box, where what's asked is done: what was done, in words (what went
    /// wrong, if it did, which the bot is told too). `folder`: where projects go on that box from now on, picked as
    /// you answer the first one there.
    @discardableResult
    func answer(_ ask: WorkAsk, on box: String, _ answer: WorkAskAnswer, folder: String? = nil) async throws -> String {
        guard let client = client(box) else { throw CancellationError() }
        struct Given: Encodable {
            var answer: WorkAskAnswer
            var folder: String?
        }
        struct Answered: Decodable {
            var text: String
            var isError: Bool
        }
        let done = try await client.value(Answered.self, "POST", "kuvo/work/asks/\(ask.id)", body: Given(answer: answer, folder: folder))
        // Gone here at once; its box's next line says so too.
        take((asked[box] ?? []).filter { $0.id != ask.id }, from: box)
        if answer == .always { await app?.bots.refresh(box) }
        // A machine's projects are read as it connects: the new one, now. (This Mac's are followed.)
        if answer != .deny, box != BoxClient.mac { await app?.workspace.loadProjects(on: box) }
        return done.text
    }
}
