import Foundation
import KuvoLink

/// This Mac's side of the documents your computers copy between them (PROTOCOL.md, "Documents"),
/// as kept in phone-link.json: how far each of its own has come, the phones documents its machines
/// signed (whose removals count here, and which it passes on), how far each machine's view of your
/// personalities has come, and the machines it removed, which its peers document names so they let
/// it go. The rules are the bridge's (`takeDoc`, `docsWork` in kuvo-link.js).
struct MacDocuments: Codable, Equatable {
    /// One of this Mac's own: its version, its bytes' hash, and its body's (to tell it changed).
    struct Own: Codable, Equatable {
        var n: Int
        var h: String
        var b: String
    }

    /// How far another's has come.
    struct Seen: Codable, Equatable {
        var n: Int
        var h: String
    }

    var own: [String: Own] = [:]
    /// Machines' phones documents, by "<origin> phones".
    var held: [String: Documents.Envelope] = [:]
    var views: [String: Seen] = [:]
    /// The keys of machines this Mac removed, the newest last.
    var left: [String] = []

    static let mostLeft = 64

    /// This Mac's own document of `kind` with `body`, signed with `key`: the version it has, or the
    /// next when `body` changed.
    mutating func own(_ kind: String, body: Data, key: Documents.SigningKey) -> (envelope: Documents.Envelope, changed: Bool) {
        let b = Documents.bodyHash(body)
        let had = own[kind]
        let changed = had?.b != b
        let n = changed ? (had?.n ?? 0) + 1 : had!.n
        let envelope = Documents.sign(key, kind: kind, n: n, body: body)
        if changed, let doc = Documents.read(envelope) { own[kind] = Own(n: n, h: doc.h, b: b) }
        return (envelope, changed)
    }

    /// What this Mac has, as it tells its machines: `[origin, kind, n, h]` each.
    func digest(origin: String) -> [[Any]] {
        var have: [[Any]] = held.values.compactMap(Documents.read).map { [$0.origin, $0.kind, $0.n, $0.h] }
        have += views.map { [$0.key, "personalities", $0.value.n, $0.value.h] }
        have += own.map { [origin, $0.key, $0.value.n, $0.value.h] }
        return have
    }

    /// A document a machine gave, taken when it verifies, its origin is one of `machines` (or this
    /// Mac, a copy of its own it lost count of), and it's newer than what this Mac has (at the same
    /// version, the one whose hash sorts first). Who a Mac's boxes are is that Mac's alone to say.
    mutating func take(_ envelope: Documents.Envelope, machines: Set<String>, origin: String) -> (doc: Documents.Document, mine: Bool)? {
        guard let doc = Documents.read(envelope) else { return nil }
        if doc.origin == origin {
            let had = own[doc.kind]
            if let had, doc.n < had.n || (doc.n == had.n && doc.h == had.h) { return nil }
            own[doc.kind] = Own(n: max(doc.n, had?.n ?? 0), h: doc.h, b: Documents.bodyHash(doc.body))
            return (doc, true)
        }
        guard machines.contains(doc.origin), doc.kind != "peers" else { return nil }
        func newer(_ n: Int?, _ h: String?) -> Bool { n.map { doc.n > $0 || (doc.n == $0 && doc.h < (h ?? "")) } ?? true }
        if doc.kind == "personalities" {
            guard newer(views[doc.origin]?.n, views[doc.origin]?.h) else { return nil }
            views[doc.origin] = Seen(n: doc.n, h: doc.h)
            return (doc, false)
        }
        let key = "\(doc.origin) \(doc.kind)"
        let had = held[key].flatMap(Documents.read)
        guard newer(had?.n, had?.h) else { return nil }
        held[key] = envelope
        return (doc, false)
    }

    /// What's kept of machines that no longer count (removed, or their keys made anew): let go.
    mutating func prune(machines: Set<String>) {
        held = held.filter { machines.contains(String($0.key.split(separator: " ").first ?? "")) }
        views = views.filter { machines.contains($0.key) }
    }

    /// One of this Mac's own a machine's digest says is further on than this Mac knew (it lost
    /// count): the next one goes past it.
    mutating func catchUp(_ kind: String, to n: Int) {
        guard n > (own[kind]?.n ?? 0) else { return }
        own[kind] = Own(n: n, h: "", b: "")
    }

    /// A machine removed: its own documents' let go, and named in this Mac's peers document so it
    /// lets this Mac go too.
    mutating func removed(machine key: String) {
        left = Array((left.filter { $0 != key } + [key]).suffix(Self.mostLeft))
    }

    /// A machine set up again: no longer one this Mac removed.
    mutating func added(machine key: String) {
        left.removeAll { $0 == key }
    }
}
