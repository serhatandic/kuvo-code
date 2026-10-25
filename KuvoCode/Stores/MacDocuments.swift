import Foundation
import KuvoLink

/// This Mac's side of the documents your computers copy between them (PROTOCOL.md, "Documents"), as
/// its box keeps them and its app copies them into phone-link.json, so an older Kuvo Code goes on
/// from them: how far each of its own has come (never back, or your machines would refuse what comes
/// next), the phones documents its machines signed, how far each machine's view of your
/// personalities has come, and the machines it removed. The box keeps the rules (`takeDoc`,
/// `docsWork` in kuvo-link.js).
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

    /// `other` (the box's, as it is now) met with this copy: each count the higher of the two, so the
    /// copy an older Kuvo Code goes on from never goes back; the machines removed, `other`'s.
    func merged(with other: MacDocuments) -> MacDocuments {
        var merged = other
        for (kind, mine) in own where mine.n > (other.own[kind]?.n ?? 0) { merged.own[kind] = mine }
        for (key, mine) in held {
            let n = { (envelope: Documents.Envelope?) in envelope.flatMap(Documents.read)?.n ?? 0 }
            if n(mine) > n(other.held[key]) { merged.held[key] = mine }
        }
        for (origin, mine) in views where mine.n > (other.views[origin]?.n ?? 0) { merged.views[origin] = mine }
        return merged
    }
}
