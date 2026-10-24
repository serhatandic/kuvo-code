import CryptoKit
import Foundation
import Testing
@testable import KuvoLink

/// Signed documents (`Vectors/docs.json`, which the bridge checks against too): the ones a machine
/// signs verify here, the ones it must turn away are turned away here, and what this side signs and
/// splits into parts reads back as it was.
@Suite struct DocumentsTests {
    private static var vectors: [String: Any] {
        get throws {
            let data = try Data(contentsOf: Vectors.folder.appending(path: "docs.json"))
            return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
    }

    @Test func theBridgesDocumentsVerifyAndTheBadOnesDont() throws {
        let vectors = try Self.vectors
        for each in try #require(vectors["taken"] as? [[String: Any]]) {
            let name = each["name"] as? String ?? ""
            let envelope = try #require(Documents.Envelope(each["envelope"]), "\(name)")
            let doc = try #require(Documents.read(envelope), "\(name)")
            #expect(doc.origin == each["origin"] as? String, "\(name)")
            #expect(doc.kind == each["kind"] as? String, "\(name)")
            #expect(doc.n == (each["n"] as? NSNumber)?.intValue, "\(name)")
            #expect(doc.h == each["h"] as? String, "\(name)")
        }
        for each in try #require(vectors["refused"] as? [[String: Any]]) {
            let envelope = try #require(Documents.Envelope(each["envelope"]))
            #expect(Documents.read(envelope) == nil, "\(each["name"] ?? "")")
        }
    }

    @Test func aBigDocumentGoesInTheSamePartsAndComesBackWhole() throws {
        let all = try Self.vectors
        let vectors = try #require(all["parts"] as? [String: Any])
        let parts = try #require(vectors["parts"] as? [[String: Any]])
        var assembler = Documents.Assembler()
        var whole: Documents.Envelope?
        for part in parts { whole = assembler.take(part, from: "machine") }
        let envelope = try #require(whole)
        let doc = try #require(Documents.read(envelope))
        #expect(doc.origin == vectors["origin"] as? String)
        #expect(doc.n == 3)
        // Split here, the same parts as the bridge's.
        let mails = Documents.mails(give: [envelope])
        #expect(mails.count == parts.count)
        for (mail, part) in zip(mails, parts) {
            let mine = try #require(mail["part"] as? [String: Any])
            #expect(mine["d"] as? String == part["d"] as? String)
            #expect(mine["whole"] as? String == part["whole"] as? String)
            #expect(mine["i"] as? Int == part["i"] as? Int)
        }
        // One part changed on the way: nothing.
        var changed = parts
        let d = try #require(changed[0]["d"] as? String)
        changed[0]["d"] = (d.first == "A" ? "B" : "A") + d.dropFirst()
        var other = Documents.Assembler()
        #expect(changed.compactMap { other.take($0, from: "machine") }.isEmpty)
    }

    @Test func whatThisSideSignsReadsBackAndAChangeBreaksIt() throws {
        let key = Documents.SigningKey()
        let body = Data(#"{"boxes":[],"left":[],"moved":[]}"#.utf8)
        let envelope = Documents.sign(key, kind: "peers", n: 4, body: body)
        let doc = try #require(Documents.read(envelope))
        #expect(doc.origin == Documents.origin(of: key))
        #expect(doc.kind == "peers")
        #expect(doc.n == 4)
        #expect(doc.object["boxes"] as? [Any] != nil)
        // Signed by another, as if by this one.
        let forged = Documents.sign(Documents.SigningKey(), kind: "peers", n: 5, body: body)
        let bytes = try #require(Data(base64URL: forged.d))
        let forger = try #require(Documents.read(forged))
        let claimed = String(decoding: bytes, as: UTF8.self).replacingOccurrences(of: forger.origin, with: doc.origin)
        #expect(Documents.read(.init(d: Data(claimed.utf8).base64URL, s: forged.s)) == nil)
        // A digest's mail last, marked an answer when it is one.
        let mails = Documents.mails(give: [envelope], have: [[doc.origin, "peers", 4, doc.h]], reply: true)
        #expect(mails.count == 2)
        #expect(mails[1]["reply"] as? Bool == true)
    }
}
