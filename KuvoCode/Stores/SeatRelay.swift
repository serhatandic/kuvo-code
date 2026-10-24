import Foundation
import KuvoLink
import OpenCodeKit
import os

/// This Mac's link carrying its group chats' mail to your machines and back (PROTOCOL.md, "Peers",
/// `seat`), as a machine's link does (`kuvo-link.js`: `watchSeats`, `carrySeat`, `takeSeat`,
/// `tellSeatPeers`, `giveUpSeat`). This Mac's coding agents' bridge writes and reads the mail
/// (`Agents/src/groups/peer.ts`) and decides everything about it; this only passes it on, over the
/// relay connection the phone link holds: what goes now, sent now; what mustn't be lost, kept until
/// the machine says it has it, sent again each minute, and given up after two days of the link
/// online (the bridge told, which decides what goes again); what came, to the bridge; and who your
/// machines and their bots are, to the bridge (PROTOCOL.md, "The rule for these letters").
///
/// A stopgap: it holds only what a machine's link holds, in parity with it (how long a letter waits
/// online before it's given up, and a newer memory of a bot and chat going for one still waiting),
/// and decides nothing about the mail itself. It goes when this Mac's box process takes the relay
/// connection over (D1c), and the box's link carries this Mac's mail as a machine's does.
@MainActor
final class SeatRelay {
    weak var app: AppModel?
    private let log = Logger(subsystem: "run.kuvo.code", category: "seats")

    /// A letter of mail that mustn't be lost, until its machine says it has it.
    struct Letter: Codable, Equatable {
        /// The machine's key.
        var peer: String
        /// The mail, as the bridge wrote it (its JSON).
        var seat: Data
        /// When the bridge gave it (milliseconds).
        var at: Double
        /// The machine it was last sent to (its key): only that one's word counts.
        var sentTo: String?
        /// Given up: kept, not sent, until the bridge has heard.
        var gaveUp: Bool?
        /// How long it's waited with this Mac online (milliseconds): only that counts towards
        /// giving it up, so a Mac asleep or offline never gives up what it sent.
        var aged: Double?
    }

    static var file: URL { BoxProcess.run.appending(path: "seat-letters.json") }
    private(set) var letters: [String: Letter] = JSONFile.read([String: Letter].self, from: SeatRelay.file) ?? [:]
    private var tried: [String: Double] = [:]
    /// Each letter's last round, as counted (none yet since launch: its first round doesn't count).
    private var rounds: [String: Double] = [:]
    private var telling: Set<String> = []
    private var assembler = Documents.Assembler()
    private var following: Task<Void, Never>?
    private var toldPeers: Data?

    /// A mail's whole seat at most this big; bigger, in parts (as a document's, `Documents.parts`).
    nonisolated static let whole = 48_000
    static let letterMemory: Double = 2 * 86_400_000
    /// From one round to the next counts this much at most: a longer gap is this Mac asleep.
    static let onlineStep: Double = 5 * 60_000

    /// The time, in milliseconds (tests give their own).
    var clock: () -> Double = { (Date.now.timeIntervalSince1970 * 1000).rounded() }
    private var now: Double { clock() }

    // MARK: What the bridge sends

    /// Follows what this Mac's bridge sends, while it runs, from now (and each time it starts
    /// again): what mustn't be lost is the link's once it's kept here. Each time it follows anew,
    /// it tells the bridge who your machines are.
    func follow() {
        following?.cancel()
        following = Task { [weak self] in
            var attempt = 0
            while !Task.isCancelled {
                guard let self, let endpoint = self.link.bridge() else { return }
                if await self.followOnce(endpoint) { attempt = 0 }
                // Gone (the bridge restarted, the stream dropped): followed again, a little later each time.
                attempt += 1
                try? await Task.sleep(for: .milliseconds(min(30_000, 250 * (1 << min(attempt, 7)))))
            }
        }
    }

    /// Follows what the bridge sends until it stops, the bridge first told who your machines are.
    /// Whether it followed (the bridge answered).
    private func followOnce(_ endpoint: ServerEndpoint) async -> Bool {
        var request = URLRequest(url: endpoint.url.appending(path: "api/kuvo/peers/mail"))
        request.timeoutInterval = .infinity
        if let password = endpoint.password { request.setValue("Basic " + Data("opencode:\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization") }
        guard let (bytes, response) = try? await URLSession.shared.bytes(for: request), (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
        await tellPeers(force: true)
        do {
            for try await line in bytes.lines {
                guard let data = line.data(using: .utf8), let given = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                if await carry(given), given["durable"] as? Bool == true, let id = given["id"] as? String {
                    await ask("POST", "sent", ["ids": [id]])
                }
            }
        } catch {}
        return true
    }

    func stop() {
        following?.cancel()
        following = nil
    }

    /// One line of what the bridge sends (`{id, to, mail, durable}`): what goes now, sent; what
    /// mustn't be lost, kept as a letter and sent at once (a newer memory of the same bot and chat
    /// goes for one still waiting). Whether it's this link's to deliver now.
    func carry(_ given: [String: Any]) async -> Bool {
        guard let to = given["to"] as? String, let mail = given["mail"] as? [String: Any], let rawID = given["id"] as? String,
              let json = try? JSONSerialization.data(withJSONObject: mail) else { return false }
        guard given["durable"] as? Bool == true else {
            _ = await send(json, to: to, id: nil)
            return true
        }
        let id = String(rawID.filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }.prefix(60))
        guard AgentMail.isLetterID(id) else { return false }
        if mail["kind"] as? String == "memory", let memory = mail["memory"] as? [String: Any] {
            for (other, letter) in letters where letter.peer == to {
                guard let kept = try? JSONSerialization.jsonObject(with: letter.seat) as? [String: Any], kept["kind"] as? String == "memory",
                      let was = kept["memory"] as? [String: Any], was["bot"] as? String == memory["bot"] as? String, was["chat"] as? String == memory["chat"] as? String else { continue }
                letters[other] = nil
                tried[other] = nil
            }
        }
        letters[id] = Letter(peer: to, seat: json, at: now)
        save()
        await sendLetter(id)
        return true
    }

    /// The mail for `to` (a machine's key), now, whole or in parts: whether it all went, or nil
    /// for one too big ever to go.
    private func send(_ json: Data, to key: String, id: String?) async -> Bool? {
        guard let machine = link.machine(key) else { return false }
        guard let payloads = Self.payloads(json, id: id) else {
            log.error("A group chat's mail for \(machine, privacy: .public) is too big to send, so it wasn't.")
            return nil
        }
        for payload in payloads {
            guard await link.mail(payload.merging(["at": now]) { $1 }, machine) == .sent else { return false }
        }
        return true
    }

    /// What goes for one mail: whole, or in parts put together where it goes (its JSON's bytes,
    /// base64url, so each part fits whatever the words are); nil for one too big to put together.
    nonisolated static func payloads(_ json: Data, id: String?) -> [[String: Any]]? {
        if json.count <= whole, let mail = try? JSONSerialization.jsonObject(with: json) {
            return [["seat": mail].merging(id.map { ["seatID": $0] } ?? [:]) { $1 }]
        }
        let parts = Documents.parts(of: json.base64URL, s: id ?? "")
        guard parts.count <= Documents.mostParts else { return nil }
        return parts.map { ["seatPart": $0] }
    }

    /// A letter sent to its machine now: noted as tried (sent again in a minute), or, too big ever
    /// to go, given up.
    private func sendLetter(_ id: String) async {
        guard var letter = letters[id], letter.gaveUp != true else { return }
        if letter.sentTo != letter.peer {
            letter.sentTo = letter.peer
            letters[id] = letter
            save()
        }
        tried[id] = now
        if await send(letter.seat, to: letter.peer, id: id) == nil { await giveUp(id) }
    }

    /// A letter given up (two days online without a word, too big to send, or refused): the bridge
    /// is told, and decides what comes of it (what still matters goes again as a new letter); the
    /// letter goes once it has answered (2xx or 4xx), and is kept, not sent, until then (it answers
    /// 503 until it has heard who your machines are).
    private func giveUp(_ id: String) async {
        guard var letter = letters[id] else { return }
        tried[id] = nil
        if letter.gaveUp != true {
            letter.gaveUp = true
            letters[id] = letter
            save()
        }
        guard !telling.contains(id), let mail = try? JSONSerialization.jsonObject(with: letter.seat) else { return }
        telling.insert(id)
        defer { telling.remove(id) }
        if let status = await status("POST", "gaveup", ["to": letter.peer, "mail": mail, "at": letter.at]), (200..<500).contains(status) {
            letters[id] = nil
            save()
        }
    }

    /// Each minute: letters not there yet, again; those two days old with this Mac online, given
    /// up; and the bridge told who your machines are, when that changed.
    func tick() async {
        let online = link.online()
        let now = clock()
        for id in Array(letters.keys) {
            // As it is now: one that went, or was given up, meanwhile is gone.
            guard var letter = letters[id] else { continue }
            let last = rounds[id]
            rounds[id] = now
            if online, let last, now > last {
                letter.aged = (letter.aged ?? 0) + min(now - last, Self.onlineStep)
                letters[id] = letter
            }
            if letter.gaveUp == true || (letter.aged ?? 0) > Self.letterMemory {
                await giveUp(id)
                continue
            }
            guard let machine = link.machine(letter.peer), link.reaches(machine),
                  now - (tried[id] ?? 0) >= 55_000 else { continue }
            await sendLetter(id)
        }
        save()
        await tellPeers()
    }

    // MARK: What a machine sends

    /// How a letter went, from the machine it went to: there, so it goes; not now, so it's sent
    /// again (for as long as a letter); or refused, so it's given up. Whether it was one of these.
    func went(_ delivered: [String: Any], from machine: String) async -> Bool {
        guard let id = delivered["id"] as? String, let letter = letters[id], let key = link.key(machine), letter.sentTo == key else { return false }
        let ok = delivered["ok"] as? Bool == true
        if ok {
            letters[id] = nil
            tried[id] = nil
            save()
        } else if delivered["retry"] as? Bool == true {
            // Not now: sent again at the next minute, for as long as it takes (its time online counts).
        } else {
            await giveUp(id)
        }
        return true
    }

    /// Mail a machine sent (`seat`, or a part of one): to the bridge, once it's whole; one that
    /// mustn't be lost said to have come once the bridge has it, or to be sent again.
    func take(_ payload: [String: Any], from machine: String) async {
        guard let key = link.key(machine) else { return }
        var mail: Any?
        var id: String?
        if let seat = payload["seat"] as? [String: Any] {
            mail = seat
            id = payload["seatID"] as? String
        } else if let part = payload["seatPart"] as? [String: Any] {
            guard let whole = assembler.take(part, from: key), let data = Data(base64URL: whole.d) else { return }
            mail = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            id = whole.s.isEmpty ? nil : whole.s
        }
        guard let mail, id.map(AgentMail.isLetterID) ?? true else { return }
        let taken = await ask("POST", "mail", ["from": key, "mail": mail])
        guard let id else { return }
        let delivered: [String: Any] = taken ? ["id": id, "ok": true] : ["id": id, "ok": false, "why": "Not now.", "retry": true]
        _ = await link.mail(["delivered": delivered, "at": now], machine)
    }

    // MARK: Who your machines are

    /// Your machines that talk to other computers, each taking a chat's turns when its `features`
    /// say `groups.seats`, and the bots each told of, by their id, to the bridge.
    func tellPeers(force: Bool = false) async {
        guard let peers = link.peers() else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: peers, options: [.sortedKeys]), force || data != toldPeers else { return }
        if await ask("PUT", "", peers) { toldPeers = data }
    }

    // MARK: Plumbing

    /// What it carries mail over, and to: the phone link's relay connection and this Mac's bridge
    /// (tests give their own).
    struct Link {
        var bridge: () -> ServerEndpoint?
        var online: () -> Bool
        /// A machine's link key, and the machine with a key: those whose bridge talks to your other computers.
        var key: (String) -> String?
        var machine: (String) -> String?
        var reaches: (String) -> Bool
        var mail: ([String: Any], String) async -> LinkServer.MailOutcome
        /// Your machines and their bots, as the bridge takes them (`{boxes, bots}`).
        var peers: () -> [String: Any]?
    }

    var given: Link?

    private var link: Link {
        if let given { return given }
        let app = app
        return Link(bridge: { app?.agents.api?.client.endpoint }, online: { app?.phoneLink.status == .connected },
                    key: { app?.phoneLink.key(of: $0) }, machine: { app?.phoneLink.machine(withKey: $0) },
                    reaches: { app?.phoneLink.reachesByMail($0) == true },
                    mail: { payload, machine in await app?.phoneLink.mail(payload, to: machine) ?? .offline },
                    peers: { app.map { AgentMail.shared.seatPeers(app: $0) } })
    }

    /// The bridge's `api/kuvo/peers` routes: whether it answered as asked.
    @discardableResult
    private func ask(_ method: String, _ route: String, _ body: Any) async -> Bool {
        await status(method, route, body).map { (200..<300).contains($0) } ?? false
    }

    /// What the bridge answered, by its status; nil for no answer.
    private func status(_ method: String, _ route: String, _ body: Any) async -> Int? {
        guard let endpoint = link.bridge() else { return nil }
        var request = URLRequest(url: endpoint.url.appending(path: route.isEmpty ? "api/kuvo/peers" : "api/kuvo/peers/\(route)"))
        request.httpMethod = method
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let password = endpoint.password { request.setValue("Basic " + Data("opencode:\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization") }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return nil }
        return (response as? HTTPURLResponse)?.statusCode
    }

    private func save() {
        if letters.isEmpty { try? FileManager.default.removeItem(at: Self.file) } else { JSONFile.write(letters, to: Self.file) }
    }
}
