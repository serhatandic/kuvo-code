import ClientSessions
import ClientText
import Foundation
import KuvoLink
import Observation
import SwiftUI

/// The Work Queue as each box keeps it (`kuvo/work-queue`, PROTOCOL.md "The Work Queue"): a
/// conversation's view (its own items, and those of the sessions it oversees) or every item, as it
/// changes; one item whole; what `#n` refs in messages name, for their chips; and what you do to
/// the queue (reorder, move to a category, delete, bring back). The box keeps and works out all of
/// it: this only reads what it says and sends what you do.
@MainActor @Observable
final class WorkQueues {
    @ObservationIgnored weak var app: AppModel?
    /// A box's client (a test's own); the app's otherwise.
    @ObservationIgnored var boxes: ((String) -> BoxClient)?

    /// A view: whose (a conversation's address, a group chat's id, or `all`) on which box.
    struct Key: Hashable {
        var box: String
        var owner: String
    }

    /// Each view followed, as the box last told it.
    private(set) var views: [Key: WorkQueueView] = [:]
    /// A view the box couldn't give, and why, in its words.
    private(set) var failures: [Key: String] = [:]
    /// Boxes that have no Work Queue yet (an older version).
    private(set) var older: Set<String> = []
    /// Items whole, by box and id, as last read.
    private(set) var details: [String: WorkItemDetail] = [:]
    /// What each `#n` names, by box: known ones only (one the box doesn't know stays plain text).
    private(set) var refs: [String: [Int: WorkRef]] = [:]
    /// The last item you deleted, for Undo, until you do something else.
    private(set) var undoable: (box: String, item: WorkItem)?
    /// What the box said when it refused something you did.
    var refusal: String?

    /// The panel's own state, by the conversation whose panel it is: the scope, the filter, the
    /// item open, and one a chip asked to open.
    var scopes: [String: Scope] = [:]
    var filters: [String: WorkQueue.Filter] = [:]
    var opened: [String: Opened] = [:]

    enum Scope: Hashable { case own, all }

    /// An item open in the panel, by its id (from a list) or its number (from a chip).
    struct Opened: Hashable {
        var box: String
        var id: String?
        var number: Int?

        func matches(_ item: WorkItem) -> Bool {
            if let id { return item.id == id }
            return number != nil && item.number == number
        }
    }

    @ObservationIgnored private var asked: [String: [Int: Date]] = [:]
    @ObservationIgnored private var following: [Key: UUID] = [:]

    private func client(_ box: String) -> BoxClient? {
        #if DEBUG
        if isStandIn { return nil }
        #endif
        return boxes?(box) ?? app?.box(box)
    }

    #if DEBUG
    /// Shows `view` (and `details`) as a box told them, with no box asked: for pictures of the panel.
    @ObservationIgnored var isStandIn = false

    func standIn(_ view: WorkQueueView, for key: Key, details: [WorkItemDetail] = []) {
        isStandIn = true
        take(view, for: key)
        for detail in details { self.details[key.box + "|" + detail.item.id] = detail }
    }
    #endif

    // MARK: Views

    /// A view as it changes, until the task following it ends: this Mac's box tells each change as
    /// it's made; a machine's is asked again every few seconds.
    func follow(_ key: Key) async {
        let me = UUID()
        following[key] = me
        defer { if following[key] == me { following[key] = nil } }
        while !Task.isCancelled {
            #if DEBUG
            if isStandIn { return }
            #endif
            var wait: Duration = key.box == BoxClient.mac ? .seconds(2) : .seconds(4)
            if let client = client(key.box) {
                do {
                    for try await line in client.follow("kuvo/work-queue/events?owner=\(query(key.owner))") {
                        guard following[key] == me, let view = try? JSONDecoder().decode(WorkQueueView.self, from: line) else { continue }
                        take(view, for: key)
                    }
                } catch let refusal as BoxRefusal {
                    if refusal.status == 404 || refusal.status == 403 {
                        older.insert(key.box)
                        wait = .seconds(300)
                    } else {
                        failures[key] = refusal.message
                    }
                } catch {
                    if views[key] == nil { failures[key] = error.localizedDescription }
                }
            }
            try? await Task.sleep(for: wait)
        }
    }

    /// Reads a view once more now (after you change something on a box that doesn't stream).
    func read(_ key: Key) async {
        guard let client = client(key.box) else { return }
        if let view = try? await client.value(WorkQueueView.self, "GET", "kuvo/work-queue?owner=\(query(key.owner))") {
            take(view, for: key)
        }
    }

    private func take(_ view: WorkQueueView, for key: Key) {
        if views[key] != view { views[key] = view }
        failures[key] = nil
        older.remove(key.box)
        // What a view says of its items is what their chips show.
        var known = refs[key.box] ?? [:]
        for item in view.items + view.removed {
            guard let number = item.number else { continue }
            let ref = WorkRef(item)
            if known[number] != ref { known[number] = ref }
        }
        if refs[key.box] != known { refs[key.box] = known }
    }

    // MARK: One item

    /// An item whole (by its id, or its number), read now.
    @discardableResult
    func load(box: String, item: String) async -> WorkItemDetail? {
        guard let client = client(box) else { return details[box + "|" + item] ?? details[box + "|#" + item] }
        do {
            let detail = try await client.value(DetailAnswer.self, "GET", "kuvo/work-queue/items/\(path(item))").item
            details[box + "|" + detail.item.id] = detail
            if let number = detail.item.number { details[box + "|#\(number)"] = detail }
            return detail
        } catch {
            return nil
        }
    }

    func detail(box: String, id: String?, number: Int?) -> WorkItemDetail? {
        if let id, let found = details[box + "|" + id] { return found }
        if let number { return details[box + "|#\(number)"] }
        return nil
    }

    /// A file kept with an item: its bytes.
    func file(box: String, item: String, name: String) async -> Data? {
        guard let client = client(box) else { return nil }
        guard let answer = try? await client.send("GET", "kuvo/work-queue/items/\(path(item))/files/\(path(name))"), answer.status == 200 else { return nil }
        return answer.body
    }

    private struct DetailAnswer: Decodable { var item: WorkItemDetail }
    private struct ItemAnswer: Decodable { var item: WorkItem }

    // MARK: What you do

    enum Place {
        case top(String)
        case before(WorkItem)
        case after(WorkItem)
        case category(String)
    }

    /// Moves an item: to the top of a category, before or after another (in that one's category),
    /// or to the end of a category.
    func move(_ item: WorkItem, to place: Place, on box: String) async {
        struct Move: Encodable {
            var category: String?
            var before: String?
            var after: String?
            var top: Bool?
        }
        let body: Move = switch place {
        case .top(let category): Move(category: category, top: true)
        case .before(let other): Move(category: other.category, before: other.id)
        case .after(let other): Move(category: other.category, after: other.id)
        case .category(let category): Move(category: category)
        }
        undoable = nil
        await act(box) { try await $0.value(ItemAnswer.self, "POST", "kuvo/work-queue/items/\(self.path(item.id))/move", body: body) }
    }

    /// Deletes an item: Undo brings it back, as does Recently Deleted for 30 days.
    func delete(_ item: WorkItem, on box: String) async {
        if let answer = await act(box, { try await $0.value(ItemAnswer.self, "DELETE", "kuvo/work-queue/items/\(self.path(item.id))") }) {
            undoable = (box, answer.item)
        }
    }

    /// Brings back a deleted item, into the category it was in.
    func restore(_ item: WorkItem, on box: String) async {
        if undoable?.item.id == item.id { undoable = nil }
        await act(box) { try await $0.value(ItemAnswer.self, "POST", "kuvo/work-queue/items/\(self.path(item.id))/restore") }
    }

    /// Adds a category of your own (after Later, or after `after`), renames or removes one: the
    /// box refuses to remove one that has items, saying how many.
    func addCategory(_ name: String, on box: String) async {
        struct Add: Encodable { var add: String }
        await act(box) { try await $0.value(CategoriesAnswer.self, "POST", "kuvo/work-queue/categories", body: Add(add: name)) }
    }

    func renameCategory(_ id: String, to name: String, on box: String) async {
        struct Rename: Encodable { var rename: String; var to: String }
        await act(box) { try await $0.value(CategoriesAnswer.self, "POST", "kuvo/work-queue/categories", body: Rename(rename: id, to: name)) }
    }

    func removeCategory(_ id: String, on box: String) async {
        struct Remove: Encodable { var remove: String }
        await act(box) { try await $0.value(CategoriesAnswer.self, "POST", "kuvo/work-queue/categories", body: Remove(remove: id)) }
    }

    private struct CategoriesAnswer: Decodable { var categories: [WorkCategory] }

    func undo() async {
        guard let undoable else { return }
        await restore(undoable.item, on: undoable.box)
    }

    func dismissUndo() { undoable = nil }

    @discardableResult
    private func act<T>(_ box: String, _ work: @escaping (BoxClient) async throws -> T) async -> T? {
        guard let client = client(box) else { return nil }
        do {
            let answer = try await work(client)
            refusal = nil
            // A box that doesn't stream shows the change once it's asked again.
            if box != BoxClient.mac { for key in views.keys where key.box == box { await read(key) } }
            return answer
        } catch let refused as BoxRefusal {
            refusal = refused.message
        } catch {
            refusal = error.localizedDescription
        }
        return nil
    }

    // MARK: Chips

    /// What the refs in `text` name on `box`, as far as it's known now; the ones not known yet are
    /// asked (once a minute at most each), and their chips come when the box answers.
    func refs(in text: String, box: String) -> [Int: WorkRef] {
        let numbers = WorkItemRefs.numbers(in: text)
        guard !numbers.isEmpty else { return [:] }
        let known = refs[box] ?? [:]
        let now = Date()
        let wanted = numbers.filter { known[$0] == nil && (asked[box]?[$0].map { now.timeIntervalSince($0) > 60 } ?? true) }
        if !wanted.isEmpty {
            for number in wanted { asked[box, default: [:]][number] = now }
            Task { await lookUp(wanted, on: box) }
        }
        return known.filter { numbers.contains($0.key) }
    }

    /// Asks the box what `numbers` name.
    func lookUp(_ numbers: [Int], on box: String) async {
        guard let client = client(box), !numbers.isEmpty else { return }
        let list = numbers.prefix(200).map(String.init).joined(separator: ",")
        guard let answer = try? await client.value(WorkRefs.self, "GET", "kuvo/work-queue/refs?refs=\(list)") else { return }
        var known = refs[box] ?? [:]
        for (key, ref) in answer.refs {
            guard let number = Int(key) else { continue }
            known[number] = ref
        }
        if refs[box] != known { refs[box] = known }
    }

    // MARK: Opening

    /// Opens item `number` in the panel of the conversation in view: from a chip. The panel shows
    /// All when its own view doesn't have it.
    func open(_ number: Int, on box: String, panel: String) {
        opened[panel] = Opened(box: box, number: number)
        filters[panel] = .all
    }

    private func query(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "_-"))) ?? value
    }

    private func path(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "_-."))) ?? value
    }
}

extension AppModel {
    /// Opens Work Queue item `number` (a chip clicked) in the panel of the conversation in view.
    func openWorkItem(_ number: Int) {
        workQueues.open(number, on: utilities.queueBox, panel: utilities.panelKey)
        withAnimation(.ui) {
            utilities.showWorkQueue()
            tabs.showPanel()
            showsSettings = false
        }
    }
}
