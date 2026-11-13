import ClientText
import Foundation
import KuvoLink
import OpenCodeKit

/// One box as a client sees it: its routes (KuvoLink's PROTOCOL.md), wherever it is. The app's
/// stores call a box's routes through this, as a phone does through the link, and never know more
/// of a box than its id: this Mac's (`BoxClient.mac`) goes through PhoneLink's answer, which hands
/// a moved area to this Mac's box process (`BoxProcess`); a machine's, through its box over SSH.
struct BoxClient: Sendable {
    /// "mac", or a machine's id.
    let box: String
    let transport: any BoxTransport

    nonisolated static let mac = "mac"

    // MARK: This Mac's box (#333)

    /// This Mac's box: the app's own (`mac`), or the box already here that the app attached to in
    /// place (`SSHConnection.thisMac`, a machine to the app, reached with no SSH). What something
    /// with no computer of its own is on. Follows `AppModel.attached`.
    @MainActor static var thisMac: String = mac

    /// Whether `id` is this Mac's box, either way: what's on it is on this disk, under this account
    /// (its folders open here, its apps open here, it's named "this Mac"), and it's never away or
    /// removed like a machine.
    nonisolated static func isThisMac(_ id: String) -> Bool { id == mac || id == SSHConnection.thisMac }

    /// Whether its routes stream (`follow` keeps sending as things change): the app's own box,
    /// answered in this process. Every other box, the one attached in place too, answers each
    /// request once (a process run for it, over SSH or not), so what follows it reads it again on
    /// a timer, as slowly as a machine.
    nonisolated static func streams(_ id: String) -> Bool { id == mac }

    /// How long what follows a box that doesn't stream waits before it reads the box again: as long
    /// as a machine's bots wait (`Bots.machineFollowPause`), so the one attached in place, whose
    /// every read runs a process, isn't read more often than a machine over SSH. (A test's shorter.)
    nonisolated(unsafe) static var readAgainAfter: Duration = .seconds(30)

    /// Whether a request to its vault carries this Mac's proof (PROTOCOL.md, "Vault"): every box but
    /// the app's own, which answers in this process. The one attached in place takes a request
    /// through its CLI as a Mac's, so it asks for one too; but it takes only its own Macs' proofs
    /// (`link.macs`), and this Mac isn't one of those for a box another Mac set up, so its vault
    /// (and the saved passwords in it) can't be reached from here yet (#333).
    nonisolated static func needsVaultProof(_ id: String) -> Bool { id != mac }

    /// Whether it has everything this app knows of, without asking it (`kuvo/info`'s features): the
    /// app's own box, of this version. One attached in place is whatever version it is, and is asked,
    /// as a machine is.
    nonisolated static func hasEveryFeature(_ id: String) -> Bool { id == mac }

    /// Whether `machine` (nil: this Mac) is one of your machines, as analytics counts where
    /// something happened: this Mac's box attached in place is this Mac.
    nonisolated static func isMachine(_ machine: String?) -> Bool { machine.map { !isThisMac($0) } ?? false }


    /// A box's routes by its id, as the app reaches them (`AppModel.box`, which sets this as it
    /// starts): for a store made where the app's model isn't at hand (the Changes panel's). Until
    /// then, `unwired`.
    @MainActor static var routes: (String) -> BoxClient = { unwired($0) }

    /// A box's routes with no app's model to reach them through (before it starts, or once it's
    /// gone): a machine's over SSH; this Mac's (`mac`) isn't reached, never a host named "mac".
    nonisolated static func unwired(_ id: String) -> BoxClient {
        guard id == mac else { return .machine(id) }
        return BoxClient(box: id, transport: LocalBox { _ in AsyncThrowingStream { $0.finish(throwing: URLError(.cannotConnectToHost)) } })
    }

    /// A machine's box, by the machine's id, through `kuvo-link.js box route` over its SSH connection.
    nonisolated static func machine(_ id: String) -> BoxClient {
        BoxClient(box: id, transport: MachineBoxTransport(connection: SSHConnection(destination: id)))
    }

    /// What the box answered.
    func send(_ method: String, _ path: String, body: Data? = nil, headers: [String: String] = [:]) async throws -> (status: Int, body: Data) {
        var status = 502
        var answer = Data()
        let request = LinkRequest(method: method, path: path, headers: headers.merging(body == nil ? [:] : ["content-type": "application/json"]) { $1 }, body: body ?? Data())
        for try await part in transport.send(request) {
            switch part {
            case .head(let code, _): status = code
            case .body(let data): answer += data
            }
        }
        return (status, answer)
    }

    /// Its answer, read as `T`; what a box refuses, as it said it (`BoxRefusal`).
    func value<T: Decodable>(_ type: T.Type = T.self, _ method: String = "GET", _ path: String, body: (any Encodable)? = nil) async throws -> T {
        let (status, data) = try await send(method, path, body: try body.map { try JSONEncoder().encode($0) })
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// A file on this box by its path (`kuvo/file`), as a phone reads one: its bytes, or what the
    /// box said (`BoxRefusal`: not there, can't be read, too big).
    /// `max`: refused (413) over it, for what's only shown up to a size.
    func file(_ path: String, max: Int? = nil) async throws -> Data {
        // Its path as written, byte for byte, as the phone names it too (`FileAddresses`).
        let (status, data) = try await send("GET", FileAddresses.route(path, max: max))
        guard status == 200 else { throw BoxRefusal(status: status, data: data) }
        return data
    }

    /// A route that follows something (`kuvo/…/events`): each line it sends, as it comes. It ends
    /// when the box stops sending; one that doesn't stream (a machine's, over SSH) sends its answer
    /// once and ends.
    func follow(_ path: String) -> AsyncThrowingStream<Data, Error> {
        let transport = transport
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var buffer = Data()
                    var status = 200
                    for try await part in transport.send(LinkRequest(method: "GET", path: path)) {
                        switch part {
                        case .head(let code, _): status = code
                        case .body(let data):
                            guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
                            buffer += data
                            while let end = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                                let line = buffer[buffer.startIndex..<end]
                                if !line.isEmpty { continuation.yield(Data(line)) }
                                buffer.removeSubrange(buffer.startIndex...end)
                            }
                        }
                    }
                    // Refused with nothing said: still refused, not a stream that ended.
                    guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: buffer) }
                    if !buffer.isEmpty { continuation.yield(buffer) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// What a box said when it said no: its status, and its words (`{"message"}`) or, without them,
/// that it said no. `problem`: why a file it keeps can't be used, alone (`kuvo/config`'s, with
/// comments in it), for a page that names the file already.
struct BoxRefusal: LocalizedError {
    var status: Int
    var message: String
    var problem: String?
    /// Why, as a word a client maps (`reason`): Full Access not confirmed on that computer, say.
    var reason: String?
    /// The box hasn't the route at all: one from before it (`olderBox`).
    var isOlderBox = false
    var errorDescription: String? { message }

    /// Whether a box answered as one from before the route asked: `404` with nothing said, as every
    /// box answers a route of its own it hasn't; or a released one's `403` in plain words.
    nonisolated static func olderBox(status: Int, data: Data) -> Bool {
        let said = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if status == 404 && said?["message"] == nil { return true }
        // COMPAT(beta.1 git-older-box): a box of 0.7 or 0.8.0-beta.1 refuses a route it hasn't with `403 "That isn't available over the link."`, words but no JSON (a path refused as not what it seems has no words). Goes when 0.8.0 ships.
        return status == 403 && said == nil && !data.isEmpty
    }

    init(status: Int, message: String, problem: String? = nil, reason: String? = nil) {
        self.status = status
        self.message = message
        self.problem = problem
        self.reason = reason
    }

    init(status: Int, data: Data) {
        let said = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        self.init(status: status, message: said?["message"] as? String ?? "It said no (\(status)).", problem: said?["problem"] as? String, reason: said?["reason"] as? String)
        isOlderBox = Self.olderBox(status: status, data: data)
    }
}

/// Where a box's routes are reached.
protocol BoxTransport: Sendable {
    func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error>
}

/// This Mac's box: PhoneLink's own answer, as a phone gets it, which hands what's moved to the
/// box process.
struct LocalBox: BoxTransport {
    let respond: @Sendable (LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error>

    func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> { respond(request) }
}

/// A machine's box, through `kuvo-link.js box route` over SSH: one answer, never a stream.
struct MachineBoxTransport: BoxTransport {
    let connection: SSHConnection

    func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
        let connection = connection
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let body = request.body.isEmpty ? nil : try JSONSerialization.jsonObject(with: request.body) as? [String: Any]
                    // This Mac's proof for a request to the machine's vault (PROTOCOL.md, "Vault"),
                    // which covers its body as sent: that body as it is, not as JSON again.
                    let vault = request.headers["x-kuvo-vault-proof"] != nil
                    // And the folder it's about, as a phone's request names it (a command to stop).
                    let (status, data) = try await MachineBox.route(request.method, request.path, body: body, bodyText: vault ? String(decoding: request.body, as: UTF8.self) : nil,
                                                                    headers: request.headers.filter { $0.key == "x-kuvo-vault-proof" || $0.key == "x-opencode-directory" }, on: connection)
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(data))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
