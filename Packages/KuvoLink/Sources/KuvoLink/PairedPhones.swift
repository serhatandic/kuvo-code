import Foundation

/// The phones a computer lets in (PROTOCOL.md, "Paired phones"). A pairing adds one; a removal,
/// from a phone on the list or a Mac, takes one off for good, noting the pairing it ended, so only
/// a pairing of its own (a new pairing id) lets it back in. Nobody removes a Mac. A machine's
/// bridge keeps the same rules (`kuvo-link.js`), with Macs' lists besides, and both are held to
/// `Vectors/link.json`.
public struct PairedPhones: Equatable, Sendable {
    public struct Phone: Codable, Hashable, Sendable, Identifiable {
        /// Its static key, base64url.
        public var key: String
        public var name: String
        public var added: Date
        /// Its address on the relay, where its notifications go: learned as it comes in.
        public var address: String?
        /// The pairing it came in with: made where it paired, new each time ("" from before
        /// pairings had one).
        public var pairing: String
        public var id: String { key }

        public init(key: String, name: String, added: Date, address: String? = nil, pairing: String) {
            self.key = key
            self.name = name
            self.added = added
            self.address = address
            self.pairing = pairing
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            key = try container.decode(String.self, forKey: .key)
            name = try container.decode(String.self, forKey: .name)
            added = try container.decode(Date.self, forKey: .added)
            address = try container.decodeIfPresent(String.self, forKey: .address)
            pairing = try container.decodeIfPresent(String.self, forKey: .pairing) ?? ""
        }
    }

    /// A phone's pairing, taken off.
    public struct Removal: Codable, Hashable, Sendable {
        public var key: String
        public var pairing: String

        public init(key: String, pairing: String) {
            self.key = key
            self.pairing = pairing
        }
    }

    /// One to remove, as asked: its pairing, or the one it has here when none is given.
    public struct Entry: Codable, Hashable, Sendable {
        public var key: String
        public var pairing: String?

        public init(key: String, pairing: String? = nil) {
            self.key = key
            self.pairing = pairing
        }
    }

    public var phones: [Phone]
    public var removed: [Removal]

    /// At most so many in one removal, and so many removals kept (the oldest go first).
    public static let mostAtOnce = 16
    public static let mostKept = 256

    public init(phones: [Phone] = [], removed: [Removal] = []) {
        self.phones = phones
        self.removed = removed
    }

    /// A new pairing id, made where a phone pairs.
    public static func newPairing() -> String { randomBytes(12).base64URL }

    /// A phone paired here: in, with a pairing of its own, which nothing removed. What removed its
    /// others still keeps them out.
    public mutating func pair(_ phone: Phone) {
        phones.removeAll { $0.key == phone.key }
        phones.append(phone)
    }

    /// Phones `sender` removes: only a phone on the list, or a Mac (`macs`), removes, and only
    /// phones, a few at a time. False, changing nothing, otherwise.
    public mutating func remove(_ entries: [Entry], by sender: String, macs: Set<String>) -> Bool {
        guard macs.contains(sender) || phones.contains(where: { $0.key == sender }),
              !entries.isEmpty, entries.count <= Self.mostAtOnce, entries.allSatisfy({ Self.fits($0, macs: macs) })
        else { return false }
        for entry in entries { takeOff(entry.key, pairing: entry.pairing) }
        return true
    }

    /// Removals another computer's phones document carries (PROTOCOL.md, "Documents"), noted here
    /// too: each pairing named stays out here, and one paired here with it goes. Never a Mac's
    /// key. Whether anything changed.
    @discardableResult
    public mutating func takeRemovals(_ removals: [Removal], macs: Set<String>) -> Bool {
        let before = self
        for removal in removals.prefix(Self.mostKept) where Self.fits(Entry(key: removal.key, pairing: removal.pairing), macs: macs) {
            takeOff(removal.key, pairing: removal.pairing)
        }
        return self != before
    }

    /// A phone's key (32 bytes, base64url), and its pairing if given, as a removal names it:
    /// never a Mac's.
    private static func fits(_ entry: Entry, macs: Set<String>) -> Bool {
        let key = /[A-Za-z0-9_-]{43}/, pairing = /[A-Za-z0-9_-]{0,32}/
        return entry.key.wholeMatch(of: key) != nil && !macs.contains(entry.key) && (entry.pairing.map { $0.wholeMatch(of: pairing) != nil } ?? true)
    }

    /// `key`'s pairing `pairing` (the one it has here, when not given) taken off: one paired again
    /// since, with another pairing, stays.
    private mutating func takeOff(_ key: String, pairing: String?) {
        let current = phones.first { $0.key == key }
        let which = pairing ?? current?.pairing ?? ""
        let removal = Removal(key: key, pairing: which)
        if !removed.contains(removal) {
            removed.append(removal)
            removed = Array(removed.suffix(Self.mostKept))
        }
        if current?.pairing == which { phones.removeAll { $0.key == key } }
    }
}
