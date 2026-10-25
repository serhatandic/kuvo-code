import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// This Mac's group chats' mail to your machines and back, as its link carries it until this Mac's
/// box takes the relay over: what a machine sends reaches this Mac's bridge, and the machine hears
/// it came; what the bridge sends goes, what mustn't be lost is kept and sent again until it's
/// there, in parts when it's big; given up after two days with this Mac online (never while it's
/// asleep or offline), the bridge told and the letter kept until it has heard. The bridge and the
/// relay are stand-ins.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SeatRelayTests {
    let bridge = StubEngine(port: 47952)
    let sent = Sent()

    init() {
        try? FileManager.default.removeItem(at: SeatRelay.file)
    }

    /// What went to the machine, and what the bridge was told, from any thread.
    nonisolated final class Sent: @unchecked Sendable {
        private let lock = NSLock()
        private var mails: [[String: Any]] = []
        var all: [[String: Any]] { lock.withLock { mails } }
        func add(_ mail: [String: Any]) { lock.withLock { mails.append(mail) } }
    }

    private func relay(online: @escaping () -> Bool = { true }, clock: @escaping () -> Double) -> SeatRelay {
        let relay = SeatRelay()
        let sent = sent
        let endpoint = ServerEndpoint(url: URL(string: bridge.url)!, password: "test")
        relay.given = .init(bridge: { endpoint }, online: online, key: { $0 == "box" ? "key_box" : nil }, machine: { $0 == "key_box" ? "box" : nil },
                            reaches: { _ in true }, mail: { payload, _ in sent.add(payload); return .sent },
                            peers: { ["boxes": [["key": "key_box", "name": "box", "seats": true]], "bots": []] })
        relay.clock = clock
        return relay
    }

    @Test func whatAMachineSendsReachesThisMacsBridgeAndItHearsItCame() async throws {
        defer { bridge.stop(); try? FileManager.default.removeItem(at: SeatRelay.file) }
        var refusing = false
        bridge.on("POST", "/api/kuvo/peers/mail") { _ in refusing ? StubWeb.json(["message": "No."], status: 503) : StubWeb.json([:]) }
        let relay = relay(clock: { 1 })
        let work: [String: Any] = ["kind": "work", "work": ["task": "gt_1", "wrapUp": "gm_1", "chat": "grp_x", "bot": "bot_ada", "text": "Tag it", "started": "2026-10-24T09:00:00Z"]]

        await relay.take(["seat": work, "seatID": "sm_letter000001"], from: "box")
        let given = try #require(bridge.requests("POST", "/api/kuvo/peers/mail").last?.body)
        #expect(given["from"] as? String == "key_box" && (given["mail"] as? [String: Any])?["kind"] as? String == "work")
        #expect(sent.all.last?["delivered"] as? [String: AnyHashable] == ["id": "sm_letter000001", "ok": true])

        // The bridge not taking it now: the machine sends it again.
        refusing = true
        await relay.take(["seat": work, "seatID": "sm_letter000002"], from: "box")
        #expect((sent.all.last?["delivered"] as? [String: Any])?["retry"] as? Bool == true)
        // From a computer that isn't one of yours: nothing.
        let before = bridge.requests("POST", "/api/kuvo/peers/mail").count
        await relay.take(["seat": work], from: "stranger")
        #expect(bridge.requests("POST", "/api/kuvo/peers/mail").count == before)
    }

    /// What the bridge sends is followed again whenever its stream drops, the bridge told who your
    /// machines are each time, so what goes now (a turn's result) still goes.
    @Test func whatTheBridgeSendsIsFollowedAgainWhenItsStreamDrops() async throws {
        defer { bridge.stop(); try? FileManager.default.removeItem(at: SeatRelay.file) }
        bridge.on("PUT", "/api/kuvo/peers", json: [:])
        let line = #"{"id":"sm_now0000001","to":"key_box","durable":false,"mail":{"kind":"result","id":"trn_1","result":{"ok":true,"text":"Done","steps":[]}}}"# + "\n"
        // Each time: one line, then the stream ends.
        bridge.on("GET", "/api/kuvo/peers/mail") { _ in
            TestPulse.beat()
            return StubWeb.Answer(status: 200, body: Data(line.utf8))
        }
        let relay = relay(clock: { 1 })
        relay.follow()
        defer { relay.stop() }
        try await until { bridge.requests("GET", "/api/kuvo/peers/mail").count >= 3 && sent.all.filter { $0["seat"] != nil }.count >= 3 }
        #expect(bridge.requests("PUT", "/api/kuvo/peers").count >= 3, "told who your machines are each time")
    }

    @Test func bigMailGoesInPartsAndIsPutTogetherWhereItGoes() async throws {
        defer { bridge.stop(); try? FileManager.default.removeItem(at: SeatRelay.file) }
        bridge.on("POST", "/api/kuvo/peers/mail", json: [:])
        let relay = relay(clock: { 1 })
        let words = String(repeating: "Ünïcödé words, ", count: 9_000)
        let memory: [String: Any] = ["kind": "memory", "memory": ["chat": "grp_x", "bot": "bot_ada", "at": 5, "transcript": words]]

        let carried = await relay.carry(["id": "sm_big0000001", "to": "key_box", "mail": memory, "durable": true])
        #expect(carried)
        let parts = sent.all.compactMap { $0["seatPart"] as? [String: Any] }
        #expect(parts.count > 1 && parts.allSatisfy { ($0["d"] as? String)?.count ?? .max <= Documents.partLength })
        // What the machine's link would put together, as this Mac's does for what comes.
        for part in parts { await relay.take(["seatPart": part], from: "box") }
        let whole = try #require(bridge.requests("POST", "/api/kuvo/peers/mail").last?.body["mail"] as? [String: Any])
        #expect((whole["memory"] as? [String: Any])?["transcript"] as? String == words)
    }

    @Test func whatMustntBeLostIsKeptUntilItsThereAndGivenUpOnlyAfterTwoDaysOnline() async throws {
        defer { bridge.stop(); try? FileManager.default.removeItem(at: SeatRelay.file) }
        var answer = 503
        bridge.on("POST", "/api/kuvo/peers/gaveup") { _ in StubWeb.json([:], status: answer) }
        bridge.on("PUT", "/api/kuvo/peers", json: [:])
        var now: Double = 1_800_000_000_000
        var online = true
        let relay = relay(online: { online }, clock: { now })
        let drop: [String: Any] = ["kind": "drop", "seat": "ses_seat1", "agents": false, "bot": "bot_ada", "chat": "grp_x"]

        #expect(await relay.carry(["id": "sm_drop000001", "to": "key_box", "mail": drop, "durable": true]))
        #expect(sent.all.last?["seatID"] as? String == "sm_drop000001")
        // Sent again each minute while there's no word.
        now += 60_000
        await relay.tick()
        #expect(sent.all.filter { $0["seatID"] as? String == "sm_drop000001" }.count == 2)
        // A week asleep counts five minutes: not given up.
        online = true
        now += 7 * 86_400_000
        await relay.tick()
        #expect(bridge.requests("POST", "/api/kuvo/peers/gaveup").isEmpty)
        // Offline doesn't count at all.
        online = false
        for _ in 0..<10 { now += 60_000; await relay.tick() }
        #expect(relay.letters["sm_drop000001"]?.aged ?? 0 <= 5 * 60_000 + 60_000)
        // Two days online, a round each few minutes: given up, the bridge told; kept while it says
        // not now (503), gone once it has heard (4xx counts).
        online = true
        for _ in 0..<(2 * 24 * 12 + 2) { now += 5 * 60_000; await relay.tick() }
        let told = try #require(bridge.requests("POST", "/api/kuvo/peers/gaveup").last?.body)
        #expect(told["to"] as? String == "key_box" && (told["mail"] as? [String: Any])?["kind"] as? String == "drop")
        #expect(relay.letters["sm_drop000001"]?.gaveUp == true, "kept until the bridge has heard")
        let sends = sent.all.filter { $0["seatID"] as? String == "sm_drop000001" }.count
        answer = 400
        await relay.tick()
        #expect(relay.letters["sm_drop000001"] == nil)
        #expect(sent.all.filter { $0["seatID"] as? String == "sm_drop000001" }.count == sends, "not sent once given up")
    }

    @Test func aLetterThereGoesAndOneTurnedDownIsGivenUp() async throws {
        defer { bridge.stop(); try? FileManager.default.removeItem(at: SeatRelay.file) }
        bridge.on("POST", "/api/kuvo/peers/gaveup", json: [:])
        let relay = relay(clock: { 1 })
        let report: [String: Any] = ["kind": "report", "task": "gt_1", "wrapUp": "gm_1", "chat": "grp_x", "result": ["ok": true, "text": "Done", "steps": 1]]
        #expect(await relay.carry(["id": "sm_rep0000001", "to": "key_box", "mail": report, "durable": true]))
        #expect(await relay.carry(["id": "sm_rep0000002", "to": "key_box", "mail": report, "durable": true]))
        // Only the machine it went to counts.
        #expect(await relay.went(["id": "sm_rep0000001", "ok": true], from: "stranger") == false)
        #expect(await relay.went(["id": "sm_rep0000001", "ok": true], from: "box"))
        #expect(relay.letters["sm_rep0000001"] == nil && SeatRelay().letters["sm_rep0000001"] == nil, "gone, across a relaunch too")
        #expect(await relay.went(["id": "sm_rep0000002", "ok": false, "why": "No."], from: "box"))
        #expect(bridge.requests("POST", "/api/kuvo/peers/gaveup").count == 1 && relay.letters["sm_rep0000002"] == nil)
        // A newer memory of the same bot and chat goes for one still waiting.
        let memory = { (at: Int) -> [String: Any] in ["kind": "memory", "memory": ["chat": "grp_x", "bot": "bot_ada", "at": at]] }
        _ = await relay.carry(["id": "sm_mem0000001", "to": "key_box", "mail": memory(1), "durable": true])
        _ = await relay.carry(["id": "sm_mem0000002", "to": "key_box", "mail": memory(2), "durable": true])
        #expect(Set(relay.letters.keys) == ["sm_mem0000002"])
    }
}
