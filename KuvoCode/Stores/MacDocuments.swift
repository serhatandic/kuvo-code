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
}
