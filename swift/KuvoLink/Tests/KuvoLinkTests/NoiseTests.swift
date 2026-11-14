import CryptoKit
import Foundation
import Testing
@testable import KuvoLink

/// The vectors both implementations run against, in `Vectors/`.
enum Vectors {
    static let folder = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../Vectors").standardized

    static func load(_ name: String) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appending(path: name))) as! [String: Any]
    }
}

private struct NoiseVector {
    let name: String
    let prologue: Data
    let initStatic: LinkKey
    let initEphemeral: LinkKey
    let initRemoteStatic: Data
    let respStatic: LinkKey
    let respEphemeral: LinkKey?
    let handshakeHash: Data
    let messages: [(payload: Data, ciphertext: Data)]

    init(_ json: [String: Any]) throws {
        func bytes(_ key: String) -> Data? { (json[key] as? String).flatMap(Data.init(hex:)) }
        name = json["protocol_name"] as! String
        prologue = bytes("init_prologue")!
        initStatic = try LinkKey(rawRepresentation: bytes("init_static")!)
        initEphemeral = try LinkKey(rawRepresentation: bytes("init_ephemeral")!)
        initRemoteStatic = bytes("init_remote_static")!
        respStatic = try LinkKey(rawRepresentation: bytes("resp_static")!)
        respEphemeral = try bytes("resp_ephemeral").map(LinkKey.init(rawRepresentation:))
        handshakeHash = bytes("handshake_hash")!
        messages = (json["messages"] as! [[String: String]]).map { (Data(hex: $0["payload"]!)!, Data(hex: $0["ciphertext"]!)!) }
    }
}

@Suite struct NoiseTests {
    private func vectors(_ name: String) throws -> [NoiseVector] {
        let all = try Vectors.load("noise.json")["vectors"] as! [[String: Any]]
        let picked = try all.map(NoiseVector.init).filter { $0.name == name }
        #expect(!picked.isEmpty)
        return picked
    }

    @Test func ikMatchesTheVectors() throws {
        for vector in try vectors("Noise_IK_25519_AESGCM_SHA256") {
            var initiator = IKInitiator(staticKey: vector.initStatic, remoteStatic: vector.initRemoteStatic, prologue: vector.prologue, ephemeral: vector.initEphemeral)
            var responder = IKResponder(staticKey: vector.respStatic, prologue: vector.prologue, ephemeral: vector.respEphemeral!)

            let first = try initiator.writeMessage1(payload: vector.messages[0].payload)
            #expect(first == vector.messages[0].ciphertext)
            #expect(try responder.readMessage1(first) == vector.messages[0].payload)
            #expect(responder.remoteStatic == vector.initStatic.publicBytes)

            let (second, respTransport) = try responder.writeMessage2(payload: vector.messages[1].payload)
            #expect(second == vector.messages[1].ciphertext)
            let (payload, initTransport) = try initiator.readMessage2(second)
            #expect(payload == vector.messages[1].payload)
            #expect(initTransport.handshakeHash == vector.handshakeHash)
            #expect(respTransport.handshakeHash == vector.handshakeHash)

            // Then transport messages, alternating, the initiator first.
            var sides = [initTransport, respTransport]
            for (index, message) in vector.messages.enumerated().dropFirst(2) {
                let (sender, receiver) = index % 2 == 0 ? (0, 1) : (1, 0)
                #expect(try sides[sender].seal(message.payload) == message.ciphertext)
                #expect(try sides[receiver].open(message.ciphertext) == message.payload)
            }
        }
    }

    @Test func kMatchesTheVectors() throws {
        for vector in try vectors("Noise_K_25519_AESGCM_SHA256") {
            let (message, sending) = try OneWay.seal(vector.messages[0].payload, from: vector.initStatic, to: vector.initRemoteStatic, prologue: vector.prologue, ephemeral: vector.initEphemeral)
            #expect(message == vector.messages[0].ciphertext)
            let (payload, receiving) = try OneWay.open(message, to: vector.respStatic, from: vector.initStatic.publicBytes, prologue: vector.prologue)
            #expect(payload == vector.messages[0].payload)

            // A one-way pattern's later messages all go the same way.
            var sender = sending, receiver = receiving
            for message in vector.messages.dropFirst() {
                #expect(try sender.encrypt(message.payload, ad: Data()) == message.ciphertext)
                #expect(try receiver.decrypt(message.ciphertext, ad: Data()) == message.payload)
            }
        }
    }

    @Test func aTamperedMessageDoesNotOpen() throws {
        let phone = LinkKey(), host = LinkKey()
        var initiator = IKInitiator(staticKey: phone, remoteStatic: host.publicBytes, prologue: Data("p".utf8))
        var responder = IKResponder(staticKey: host, prologue: Data("p".utf8))
        var first = try initiator.writeMessage1(payload: Data("hi".utf8))
        first[first.count - 1] ^= 1
        #expect(throws: Noise.Failure.decrypt) { try responder.readMessage1(first) }
    }

    @Test func theWrongHostCannotAnswer() throws {
        let phone = LinkKey(), host = LinkKey(), impostor = LinkKey()
        var initiator = IKInitiator(staticKey: phone, remoteStatic: host.publicBytes, prologue: Data())
        var responder = IKResponder(staticKey: impostor, prologue: Data())
        let first = try initiator.writeMessage1(payload: Data())
        #expect(throws: Noise.Failure.decrypt) { try responder.readMessage1(first) }
    }

    @Test func messagesOutOfOrderDoNotOpen() throws {
        let phone = LinkKey(), host = LinkKey()
        var initiator = IKInitiator(staticKey: phone, remoteStatic: host.publicBytes, prologue: Data())
        var responder = IKResponder(staticKey: host, prologue: Data())
        _ = try responder.readMessage1(initiator.writeMessage1(payload: Data()))
        let (second, hostSide) = try responder.writeMessage2(payload: Data())
        var phoneSide = try initiator.readMessage2(second).transport
        var receiving = hostSide
        let one = try phoneSide.seal(Data("one".utf8))
        let two = try phoneSide.seal(Data("two".utf8))
        #expect(throws: Noise.Failure.decrypt) { try receiving.open(two) }
        #expect(try receiving.open(one) == Data("one".utf8))
        #expect(try receiving.open(two) == Data("two".utf8))
        // And a replay fails.
        #expect(throws: Noise.Failure.decrypt) { try receiving.open(two) }
    }
}
