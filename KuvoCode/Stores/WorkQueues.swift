import ClientDesign
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
    /// What each ref names, by box and by the ref as it was asked ("243", `gh:owner/repo#12`):
    /// known ones only (one the box doesn't know stays plain text).
    private(set) var refs: [String: [String: WorkRef]] = [:]
    /// The last item you deleted, for Undo, until you do something else.
    private(set) var undoable: (box: String, item: WorkItem)?
    /// What a box said when it refused something you did there.
    var refusal: (box: String, text: String)?
    /// An item that couldn't be read for another reason than not being there (its box away), and why.
    private(set) var loadFailures: [String: String] = [:]

    /// Views read from this Mac's own box because their computer isn't answering: what this Mac
    /// last heard from it, said so over the list.
    private(set) var fellBack: Set<Key> = []

    /// The panel's own state, by the conversation whose panel it is: the scope, the filter, the
    /// item open, one a chip asked to open, and where an item being dragged over the list would land.
    var scopes: [String: Scope] = [:]
    var filters: [String: WorkQueue.Filter] = [:]
    var opened: [String: Opened] = [:]
    var dropTargets: [String: DropTarget] = [:]
    /// Which row or category set each panel's drop target (leaving it clears only its own).
    @ObservationIgnored var dropOwners: [String: String] = [:]

    /// Where a dragged item would land: before the item at `index` of a section's items (its count
    /// for after the last), or on a category's name (`index` nil: its top).
    struct DropTarget: Hashable {
        var section: String
        var index: Int?
    }

    enum Scope: Hashable { case own, all }

    /// An item open in the panel, by its id (from a list), its number or the issue it is (from a
    /// chip: `gh:owner/repo#12`).
    struct Opened: Hashable {
        var box: String
        var id: String?
        var number: Int?
        var source: String?

        func matches(_ item: WorkItem) -> Bool {
            if let id { return item.id == id }
            if let source { return item.source?.ref.lowercased() == source.lowercased() }
            return number != nil && item.number == number
        }

        /// How it's asked of the box: its id, its number, or the issue it is.
        var name: String { id ?? number.map(String.init) ?? source ?? "" }
    }

    @ObservationIgnored private var asked: [String: [String: Date]] = [:]
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

    @Observable final class ChipView {
        var refs: [String: WorkRef] = [:]
    }
    @ObservationIgnored private var chipViews: [Key: ChipView] = [:]
    private func chipView(_ key: Key) -> ChipView {
        if let view = chipViews[key] { return view }
        let view = ChipView()
        chipViews[key] = view
        return view
    }

    // MARK: Views

    /// A view as it changes, until the task following it ends: this Mac's box tells each change as
    /// it's made; a machine's is asked again every few seconds.
    @ObservationIgnored private var streams: [Key: Task<Void, Never>] = [:]
    @ObservationIgnored private var subscribers: [Key: Int] = [:]

    func follow(_ key: Key) async {
        guard !key.owner.isEmpty else { return }
        subscribers[key, default: 0] += 1
        if streams[key] == nil { streams[key] = Task { await stream(key) } }
        defer {
            subscribers[key, default: 1] -= 1
            if subscribers[key] == 0 {
                streams.removeValue(forKey: key)?.cancel()
                subscribers[key] = nil
            }
        }
        // Cancellation of the view's task ends its subscription; the final subscriber stops SSE.
        let lifetime = AsyncStream<Void> { _ in }
        for await _ in lifetime {}
    }

    private func stream(_ key: Key) async {
        let me = UUID()
        following[key] = me
        defer { if following[key] == me { following[key] = nil } }
        // (Failures in a row: a stream that drops once is only connected again; one that can't be
        // connected again either is a machine that isn't answering.)
        var failed = 0
        while !Task.isCancelled {
            #if DEBUG
            if isStandIn { return }
            #endif
            var wait: Duration = BoxClient.streams(key.box) ? .seconds(2) : .seconds(4)
            if let client = client(key.box) {
                do {
                    for try await line in client.follow("kuvo/work-queue/events?owner=\(query(key.owner))") {
                        guard following[key] == me, let view = try? JSONDecoder().decode(WorkQueueView.self, from: line) else { continue }
                        failed = 0
                        take(view, for: key)
                    }
                } catch let refusal as BoxRefusal {
                    failed += 1
                    if refusal.status == 404 || refusal.status == 403 {
                        older.insert(key.box)
                        wait = .seconds(300)
                    } else {
                        var fell = false
                        if failed >= 2 { fell = await fallBack(key) }
                        if !fell, views[key] == nil { failures[key] = refusal.message }
                    }
                } catch {
                    failed += 1
                    var fell = false
                    if failed >= 2 { fell = await fallBack(key) }
                    if !fell, views[key] == nil { failures[key] = error.localizedDescription }
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

    /// A machine that doesn't answer (switched off, asleep): its view as this Mac's own box has it,
    /// which every computer tells what it keeps, rather than what it said last as if it were now.
    /// This Mac's own items in it say so ("on" this Mac), as another box's view says of them: what
    /// you do to them goes to this Mac's box, and they're never taken for the machine's.
    private func fallBack(_ key: Key) async -> Bool {
        let thisMac = BoxClient.thisMac
        guard !BoxClient.isThisMac(key.box), following[key] != nil, let client = client(thisMac),
              var view = try? await client.value(WorkQueueView.self, "GET", "kuvo/work-queue?owner=\(query(key.owner))") else { return false }
        let here = WorkComputer(key: known.mac ?? "", name: PhoneLink.computerName, kind: "mac", id: thisMac)
        for index in view.items.indices where view.items[index].computer == nil { view.items[index].computer = here }
        for index in view.removed.indices where view.removed[index].computer == nil { view.removed[index].computer = here }
        take(view, for: key, refs: false)
        fellBack.insert(key)
        return true
    }

    /// `view` as the box gave it, and what its items say kept for their chips (not for one read
    /// from another box than the key's: `refs` false).
    private func take(_ view: WorkQueueView, for key: Key, refs keepsRefs: Bool = true) {
        if views[key] != view { views[key] = view }
        let visible = WorkQueue.visibleRefs(in: view)
        let chips = chipView(key)
        if chips.refs != visible { chips.refs = visible }
        if keepsRefs { fellBack.remove(key) }
        failures[key] = nil
        older.remove(key.box)
        guard keepsRefs else { return }
        // What a view says of its items is what their chips show.
        var known = refs[key.box] ?? [:]
        for item in view.items + view.removed {
            let ref = WorkRef(item)
            // (By its number, and an issue's by its ref too: either names it in a message.)
            for key in [item.number.map(String.init), item.source?.ref].compactMap({ $0 }) where known[key] != ref { known[key] = ref }
        }
        if refs[key.box] != known { refs[key.box] = known }
    }

    // MARK: One item

    /// An item whole (by its id, or its number), read now. One on another of your computers is read
    /// whole there by the box asked (`told` when that one can't be asked now: as it last told it).
    @discardableResult
    func load(box: String, item: String) async -> WorkItemDetail? {
        guard client(box) != nil else { return details[box + "|" + item] ?? details[box + "|#" + item] }
        do {
            // (An issue's ref has a "/", which no path may carry: it's asked by the id its chip knows.)
            let asked = refs[box]?[item]?.id ?? item
            // (As you, so the box reads one on another computer whole for you.)
            let (status, data) = try await send("GET", "kuvo/work-queue/items/\(path(asked))", to: box)
            guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
            let detail = try JSONDecoder().decode(DetailAnswer.self, from: data).item
            details[box + "|" + detail.item.id] = detail
            if let number = detail.item.number { details[box + "|#\(number)"] = detail }
            if let source = detail.item.source { details[box + "|" + source.ref.lowercased()] = detail }
            loadFailures[box + "|" + item] = nil
            return detail
        } catch let refused as BoxRefusal where refused.status == 404 {
            loadFailures[box + "|" + item] = nil
        } catch {
            // A machine that isn't answering: as this Mac's own box has it (as it last told it).
            if !BoxClient.isThisMac(box), let mac = self.client(BoxClient.thisMac), var told = try? await mac.value(DetailAnswer.self, "GET", "kuvo/work-queue/items/\(path(refs[box]?[item]?.id ?? item))").item {
                if told.item.computer == nil { told.item.computer = WorkComputer(key: known.mac ?? "", name: PhoneLink.computerName, kind: "mac", id: BoxClient.thisMac) }
                details[box + "|" + told.item.id] = told
                if let number = told.item.number { details[box + "|#\(number)"] = told }
                loadFailures[box + "|" + item] = nil
                return told
            }
            loadFailures[box + "|" + item] = (error as? BoxRefusal)?.message ?? error.localizedDescription
        }
        return nil
    }

    /// Why item `item` (an id or a number) couldn't be read just now, other than not being there.
    func loadFailure(box: String, item: String) -> String? { loadFailures[box + "|" + item] }

    func detail(box: String, id: String?, number: Int?, source: String? = nil) -> WorkItemDetail? {
        if let id, let found = details[box + "|" + id] { return found }
        if let number { return details[box + "|#\(number)"] }
        if let source { return details[box + "|" + source.lowercased()] }
        return nil
    }

    /// A file kept with an item: its bytes (`box`: the one it's kept on, `box(of:in:)`).
    func file(box: String, item: String, name: String) async -> Data? {
        guard let client = client(box) else { return nil }
        guard let answer = try? await client.send("GET", "kuvo/work-queue/items/\(path(item))/files/\(path(name))"), answer.status == 200 else { return nil }
        return answer.body
    }

    private struct DetailAnswer: Decodable { var item: WorkItemDetail }
    private struct ItemAnswer: Decodable { var item: WorkItem }

    // MARK: Where an item is

    /// Who this Mac and its machines are to your other computers: this Mac's key, and each
    /// machine's, by its id here. A test's own; this Mac's link's otherwise.
    @ObservationIgnored var computers: (() -> (mac: String?, machines: [String: String]))?

    private var known: (mac: String?, machines: [String: String]) {
        if let computers { return computers() }
        guard let link = app?.phoneLink else { return (nil, [:]) }
        return (link.macKey, link.machineHosts.mapValues(\.key))
    }

    /// The box an item's files are read from: the one the view is from, or the computer it says
    /// it's on, by its key: this Mac's own box, or one of your machines by its id on this Mac. Nil for
    /// one on another Mac (or a machine only another Mac set up). (Only for its files' bytes, which
    /// a box doesn't bring from another computer yet: what you do to an item, and reading it whole,
    /// go to the box the panel shows, which hands them on itself.)
    func box(of item: WorkItem, in box: String) -> String? {
        guard let computer = item.computer else { return box }
        let known = known
        // (This Mac's own, in a view read from its box for a machine that isn't answering.)
        if computer.kind == "mac", let id = computer.id, BoxClient.isThisMac(id) { return BoxClient.thisMac }
        if computer.kind == "mac" { return computer.key == known.mac ? BoxClient.thisMac : nil }
        if let id = known.machines.first(where: { $0.value == computer.key })?.key { return id }
        // (A machine this Mac has, whose key it doesn't know yet: by the id the box gave, unless
        // that's another of this Mac's machines.)
        guard let id = computer.id, known.machines[id] == nil else { return nil }
        return id
    }

    /// The box what you do to an item in a view is sent to: the one the view was read from (this
    /// Mac's own, for a machine that isn't answering). That box does it where the item is kept,
    /// handing it on to that computer's box itself, and answers (or says why it couldn't).
    private func source(_ box: String) -> String {
        fellBack.contains { $0.box == box } ? BoxClient.thisMac : box
    }

    // MARK: What you do

    typealias Place = WorkQueue.Place

    /// Moves an item: to the top of a category, before or after another (in that one's category),
    /// or to the end of a category. It shows there at once, until the box says how it is.
    func move(_ item: WorkItem, to place: Place, on box: String) async {
        for (key, view) in views where key.box == box { views[key] = WorkQueue.moving(item, to: place, in: view) }
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
        let moved = await act(ItemAnswer.self, "POST", "kuvo/work-queue/items/\(path(item.id))/move", body: body, on: source(box), shownOn: box)
        // Refused: as the box has it. (Done, it stays shown there until the box says so: one on
        // another computer comes once that computer tells this one, never back meanwhile.)
        if moved == nil { await readAll(box) }
    }

    /// The item dragged (as it's written, "#243" or `gh:owner/repo#12`, as the composer takes it too) put where `target`
    /// says in the view `key`: beside the item the line was drawn at (into that one's category), or
    /// at the top of a category it was dropped on. Nothing where it wouldn't move.
    /// `shown`: the view as the list draws it (a search's), whose rows the target counts.
    func drop(_ dragged: String, at target: DropTarget, in key: Key, shown: WorkQueueView? = nil) async {
        guard let view = shown ?? views[key] else { return }
        let found = view.items.filter { $0.written == dragged }
        let items = found.isEmpty ? view.items.filter { $0.written == nil && $0.title == dragged } : found
        // (Where two computers gave one number twice: the one on this view's own box.)
        guard let item = items.first(where: { $0.computer == nil }) ?? items.first,
              let section = WorkQueue.sections(view).first(where: { $0.id == target.section }) else { return }
        // (On a category's name: its top, which is before its first item there.)
        let place = WorkQueue.place(of: item, at: target.index ?? 0, in: section)
        guard let place else { return }
        await move(item, to: place, on: key.box)
    }

    /// Deletes an item: Undo brings it back, as does Recently Deleted for 30 days.
    func delete(_ item: WorkItem, on box: String) async {
        if let answer = await act(ItemAnswer.self, "DELETE", "kuvo/work-queue/items/\(path(item.id))", on: source(box), shownOn: box) {
            // (Undo goes where it was deleted.)
            var deleted = answer.item
            deleted.computer = item.computer
            undoable = (box, deleted)
        }
        if item.computer != nil { await readAll(box) }
    }

    /// The views from `box` read again now: one told of an item on another computer you changed
    /// there shows it once that computer tells it again.
    private func readAll(_ box: String) async {
        for key in views.keys where key.box == box { await read(key) }
    }

    /// Brings back a deleted item, into the category it was in.
    func restore(_ item: WorkItem, on box: String) async {
        if undoable?.item.id == item.id { undoable = nil }
        await act(ItemAnswer.self, "POST", "kuvo/work-queue/items/\(path(item.id))/restore", on: source(box), shownOn: box)
        if item.computer != nil { await readAll(box) }
    }

    /// Adds a category of your own (after Later, or after `after`), renames or removes one: the
    /// box refuses to remove one that has items, saying how many.
    func addCategory(_ name: String, on box: String) async {
        struct Add: Encodable { var add: String }
        await act(CategoriesAnswer.self, "POST", "kuvo/work-queue/categories", body: Add(add: name), on: box)
    }

    func renameCategory(_ id: String, to name: String, on box: String) async {
        struct Rename: Encodable { var rename: String; var to: String }
        await act(CategoriesAnswer.self, "POST", "kuvo/work-queue/categories", body: Rename(rename: id, to: name), on: box)
    }

    func removeCategory(_ id: String, on box: String) async {
        struct Remove: Encodable { var remove: String }
        await act(CategoriesAnswer.self, "POST", "kuvo/work-queue/categories", body: Remove(remove: id), on: box)
    }

    private struct CategoriesAnswer: Decodable { var categories: [WorkCategory] }

    func undo() async {
        guard let undoable else { return }
        await restore(undoable.item, on: undoable.box)
    }

    func dismissUndo() { undoable = nil }

    /// A request sent as you: to a machine's box with this Mac's proof for that request alone (as
    /// its vault takes one), since anything on that computer could ask its box otherwise.
    private func send(_ method: String, _ path: String, body: Data? = nil, to box: String) async throws -> (status: Int, body: Data) {
        guard let client = client(box) else { throw BoxRefusal(status: 503, message: "This Mac can’t reach that computer now.") }
        var headers: [String: String] = [:]
        if BoxClient.needsVaultProof(box) {
            guard let proof = proof(box, method, path, body ?? Data()) else { throw BoxRefusal(status: 503, message: "This Mac can’t prove it’s yours to that machine right now. Try again in a moment.") }
            headers["x-kuvo-vault-proof"] = proof
        }
        return try await client.send(method, path, body: body, headers: headers)
    }

    /// What you do, sent as you (`send`) to `box`; what it refused said over the panel `shownOn`.
    @discardableResult
    private func act<T: Decodable>(_ type: T.Type, _ method: String, _ path: String, body: (any Encodable)? = nil, on box: String, shownOn: String? = nil) async -> T? {
        guard client(box) != nil else { return nil }
        do {
            let sent = try body.map { try JSONEncoder().encode($0) }
            let (status, data) = try await send(method, path, body: sent, to: box)
            guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
            let answer = try JSONDecoder().decode(T.self, from: data)
            refusal = nil
            // A box that doesn't stream shows the change once it's asked again.
            if !BoxClient.streams(box) { for key in views.keys where key.box == box { await read(key) } }
            return answer
        } catch let refused as BoxRefusal {
            refusal = (shownOn ?? box, refused.message)
        } catch {
            refusal = (shownOn ?? box, error.localizedDescription)
        }
        return nil
    }

    /// This Mac's proof for one request to a machine (the vault's, `PhoneLink.vaultRequestProof`).
    @ObservationIgnored var proof: (_ machine: String, _ method: String, _ path: String, _ body: Data) -> String? = { machine, method, path, body in
        Vaults.shared.requestProof(machine, method, path, body)
    }

    // MARK: Chips

    /// What the refs in `text` name on `box` (by the ref as asked: "243", `gh:owner/repo#12`), as
    /// far as it's known now; the ones not known yet are asked (once a minute at most each), and
    /// their chips come when the box answers.
    func refs(in text: String, box: String, owner: String? = nil, typing: Bool = false) -> [String: WorkRef] {
        var found = WorkItemRefs.findRefs(in: text)
        // One being typed at the end of a draft isn't asked for until it's whole ("#2" of "#243").
        if typing, let last = found.last, last.range.upperBound == text.endIndex { found.removeLast() }
        guard !found.isEmpty else { return [:] }
        let keys = Set(found.map(\.ref))
        let now = Date()
        // Known ones too, a minute on: a chip shows where its item stands now, not when it came.
        let wanted = keys.filter { $0.hasPrefix("gh:") && (asked[box]?[$0].map { now.timeIntervalSince($0) > refreshAfter } ?? true) }
        if !wanted.isEmpty {
            for key in wanted { asked[box, default: [:]][key] = now }
            Task { await lookUp(Array(wanted), on: box) }
        }
        if keys.contains(where: { $0.hasPrefix("gh:") }) { startRefreshing() }
        let known = keys.contains(where: { $0.hasPrefix("gh:") }) ? refs[box] ?? [:] : [:]
        let visible = owner.flatMap { $0.isEmpty ? nil : chipView(Key(box: box, owner: $0)).refs } ?? [:]
        return WorkItemRefs.chipRefs(in: text, known: known, visible: visible)
            .filter { keys.contains($0.key) }
    }

    /// Every half minute, what the chips asked for lately name now: a chip on screen follows its
    /// item (in progress, then done) without anything else on screen changing.
    private func startRefreshing() {
        guard refreshing == nil else { return }
        refreshing = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self else { return }
                let now = Date()
                for (box, keys) in asked {
                    let recent = keys.filter { now.timeIntervalSince($0.value) < 600 }.map(\.key)
                    if !recent.isEmpty { await lookUp(recent, on: box) }
                }
            }
        }
    }

    @ObservationIgnored private var refreshing: Task<Void, Never>?
    /// How long before a chip's item is asked about again when it's drawn (a test's own).
    @ObservationIgnored var refreshAfter: TimeInterval = 60

    /// Asks the box what `keys` name ("243", `gh:owner/repo#12`), in a list (a box that doesn't
    /// know one says null).
    private func lookUp(_ keys: [String], on box: String) async {
        let keys = keys.filter { $0.hasPrefix("gh:") }
        guard let client = client(box), !keys.isEmpty else { return }
        struct Asked: Encodable { var refs: [String] }
        guard let answer = try? await client.value(WorkRefs.self, "POST", "kuvo/work-queue/refs", body: Asked(refs: Array(keys.prefix(200)))) else { return }
        var known = refs[box] ?? [:]
        for (key, ref) in answer.refs { known[key] = ref }
        if refs[box] != known { refs[box] = known }
    }

    /// The view the panel of the conversation in view shows: its own queue, or All.
    func key(for utilities: Utilities) -> Key {
        let owner = utilities.queueOwner
        let scope: Scope = owner == nil ? .all : scopes[utilities.panelKey] ?? .own
        return Key(box: utilities.queueBox, owner: scope == .all ? WorkQueueView.all : owner ?? WorkQueueView.all)
    }

    // MARK: Opening

    /// Opens the item `ref` names ("243", `gh:owner/repo#12`) in the panel of the conversation in
    /// view: from a chip. It's read by that, so one from another conversation's queue opens too.
    func open(ref: String, on box: String, panel: String) {
        opened[panel] = Int(ref).map { Opened(box: box, number: $0) } ?? Opened(box: box, source: ref)
    }

    private func query(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "_-"))) ?? value
    }

    private func path(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "_-."))) ?? value
    }
}

extension AppModel {
    /// Opens the Work Queue item `ref` names (a chip clicked: "243", `gh:owner/repo#12`) in the
    /// panel of the conversation in view.
    func openWorkItem(_ ref: String, box: String? = nil) {
        workQueues.open(ref: ref, on: box ?? utilities.queueBox, panel: utilities.panelKey)
        withAnimation(.ui) {
            utilities.showWorkQueue()
            tabs.showPanel()
            showsSettings = false
        }
    }
}

extension EnvironmentValues {
    /// The conversation drawing this text, independent of which split pane has focus.
    @Entry var workChipQueue: WorkQueues.Key?
}

private struct WorkChipContext: ViewModifier {
    let key: WorkQueues.Key?
    @Environment(AppModel.self) private var app
    func body(content: Content) -> some View {
        content.environment(\.workChipQueue, key)
            .task(id: key) { if let key { await app.workQueues.follow(key) } }
    }
}
extension View {
    func workChipContext(_ key: WorkQueues.Key?) -> some View { modifier(WorkChipContext(key: key)) }
}
