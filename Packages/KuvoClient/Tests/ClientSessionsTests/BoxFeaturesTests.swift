import ClientSessions
import Foundation
import Testing

/// A client's one reader of what its boxes have (`kuvo/info`'s `features`): read once a box and
/// kept, one read shared by whoever asks meanwhile, and an answer that can't tell taken as nothing,
/// old or new, asked again the next time, as the update gate takes it.
@MainActor
@Suite(.timeLimit(.minutes(1))) struct BoxFeaturesTests {
    /// A box's `kuvo/info`, as the test has it answer: each answer in turn, the last one again.
    @MainActor final class Box {
        var answers: [Result<(status: Int, body: Data), any Error>]
        private(set) var asked = 0
        /// While set, each ask waits here until the test lets it answer.
        var held: [CheckedContinuation<Void, Never>] = []
        var holds = false

        init(_ answers: Result<(status: Int, body: Data), any Error>...) { self.answers = answers }

        func answer() async throws -> (status: Int, body: Data) {
            asked += 1
            // (Each ask's answer is the one in turn as it's asked, whenever it's let answer.)
            let next = answers.count > 1 ? answers.removeFirst() : answers[0]
            if holds { await withCheckedContinuation { held.append($0) } }
            return try next.get()
        }

        func letAnswer() {
            holds = false
            let waiting = held
            held = []
            for each in waiting { each.resume() }
        }
    }

    struct Unreached: Error {}

    static func info(_ features: [String]?) -> Result<(status: Int, body: Data), any Error> {
        var info: [String: Any] = ["kind": "machine"]
        if let features { info["features"] = features }
        return .success((200, try! JSONSerialization.data(withJSONObject: info)))
    }

    static func status(_ code: Int, _ body: String = "{}") -> Result<(status: Int, body: Data), any Error> {
        .success((code, Data(body.utf8)))
    }

    static func reader(_ box: Box, hasEverything: @escaping (String) -> Bool = { _ in false }) -> BoxFeatures {
        BoxFeatures(hasEverything: hasEverything) { _ in try await box.answer() }
    }

    /// Lets the tasks started so far run until `count` asks wait on `box`.
    static func untilHeld(_ box: Box, _ count: Int = 1) async {
        while box.held.count < count { await Task.yield() }
    }

    @Test func aBoxIsReadOnceAndWhatItSaidKept() async {
        let box = Box(Self.info(["usage.settings", "queue"]))
        let features = Self.reader(box)
        #expect(features.knows("usage.settings", on: "m") == nil)
        #expect(await features.has("usage.settings", on: "m") == true)
        #expect(await features.has("sign-in.methods", on: "m") == false)
        #expect(features.knows("usage.settings", on: "m") == true)
        #expect(box.asked == 1)
    }

    @Test func whoeverAsksDuringARead() async {
        let box = Box(Self.info(["usage.settings"]))
        box.holds = true
        let features = Self.reader(box)
        let first = Task { await features.has("usage.settings", on: "m") }
        await Self.untilHeld(box)
        let second = Task { await features.has("sign-in.methods", on: "m") }
        for _ in 0..<5 { await Task.yield() }
        box.letAnswer()
        #expect(await first.value == true)
        #expect(await second.value == false)
        #expect(box.asked == 1)
    }

    // Not reached, refused for now, or an answer that isn't one: nothing is assumed, and the next
    // ask reads it again.
    @Test func whatCantTellIsAskedAgain() async {
        for failed in [Result<(status: Int, body: Data), any Error>.failure(Unreached()), Self.status(503), Self.status(500), Self.status(200, "<html>")] {
            let box = Box(failed, Self.info(["usage.settings"]))
            let features = Self.reader(box)
            var told: [Set<String>] = []
            features.onSaid = { _, said in told.append(said) }
            #expect(await features.has("usage.settings", on: "m") == nil)
            #expect(features.knows("usage.settings", on: "m") == nil)
            #expect(told.isEmpty)
            #expect(await features.has("usage.settings", on: "m") == true)
            #expect(box.asked == 2)
            #expect(told == [["usage.settings"]])
        }
    }

    // As the update gate has it: a box from before `kuvo/info` (404, 405) or before it said its
    // features has none, and is held.
    @Test func aBoxFromBeforeItSaidHasNothing() async {
        for older in [Self.status(404), Self.status(405), Self.info(nil)] {
            let box = Box(older)
            let features = Self.reader(box)
            var told: Set<String>?
            features.onSaid = { _, said in told = said }
            #expect(await features.features(of: "m") == [])
            #expect(told == [])
            #expect(!BoxGate.isCurrent(told ?? ["?"]))
        }
    }

    @Test func eachSayingTellsTheGate() async {
        let box = Box(Self.info(BoxGate.required))
        let features = Self.reader(box)
        var told: [String: Set<String>] = [:]
        features.onSaid = { box, said in told[box] = said }
        _ = await features.features(of: "m")
        #expect(told["m"].map(BoxGate.isCurrent) == true)
        features.take(.has(["typed"]), for: "other")
        #expect(told["other"] == ["typed"])
    }

    // Updated meanwhile: read again, what it says now replaces what it said; one that can't tell
    // now keeps what it said.
    @Test func readAgainAfterAnUpdate() async {
        let box = Box(Self.info([]), Self.info(["usage.settings"]), .failure(Unreached()))
        let features = Self.reader(box)
        #expect(await features.has("usage.settings", on: "m") == false)
        #expect(await features.readAgain("m") == .has(["usage.settings"]))
        #expect(await features.has("usage.settings", on: "m") == true)
        #expect(await features.readAgain("m") == .cantTell)
        #expect(features.knows("usage.settings", on: "m") == true)
        #expect(box.asked == 3)
    }

    // Another read of `kuvo/info` (a phone's of its engine, say) is kept as one made here, and a
    // read under way that ends after it doesn't put back what was before.
    @Test func whatAnotherReadFoundIsKept() async {
        let box = Box(Self.info([]))
        box.holds = true
        let features = Self.reader(box)
        let reading = Task { await features.features(of: "m") }
        await Self.untilHeld(box)
        features.take(.has(["usage.settings"]), for: "m")
        box.letAnswer()
        _ = await reading.value
        #expect(features.knows("usage.settings", on: "m") == true)
        #expect(await features.has("usage.settings", on: "m") == true)
        #expect(box.asked == 1)
        features.take(.cantTell, for: "m")
        #expect(features.knows("usage.settings", on: "m") == true)
    }

    // Asked again, or forgotten, while a read is under way: what that read brings isn't kept over
    // what's newer.
    @Test func aReadOvertakenIsntKept() async {
        let box = Box(Self.info([]), Self.info(["usage.settings"]))
        box.holds = true
        let features = Self.reader(box)
        let older = Task { await features.features(of: "m") }
        await Self.untilHeld(box)
        let newer = Task { await features.readAgain("m") }
        await Self.untilHeld(box, 2)
        box.letAnswer()
        _ = await older.value
        #expect(await newer.value == .has(["usage.settings"]))
        #expect(features.knows("usage.settings", on: "m") == true)

        let gone = Box(Self.info(["usage.settings"]))
        gone.holds = true
        let forgetting = Self.reader(gone)
        let reading = Task { await forgetting.features(of: "m") }
        await Self.untilHeld(gone)
        forgetting.forget("m")
        gone.letAnswer()
        #expect(await reading.value == ["usage.settings"])
        #expect(forgetting.knows("usage.settings", on: "m") == nil, "forgotten meanwhile: read again next time")
    }

    @Test func aBoxForgottenIsReadAgain() async {
        let box = Box(Self.info([]), Self.info(["usage.settings"]))
        let features = Self.reader(box)
        #expect(await features.has("usage.settings", on: "m") == false)
        features.forget("m")
        #expect(features.knows("usage.settings", on: "m") == nil)
        #expect(await features.has("usage.settings", on: "m") == true)
        #expect(box.asked == 2)
    }

    // Each box its own: what one said isn't another's.
    @Test func eachBoxItsOwn() async {
        let answers: [String: Result<(status: Int, body: Data), any Error>] = ["a": Self.info(["usage.settings"]), "b": Self.info([])]
        let features = BoxFeatures { box in try answers[box]!.get() }
        #expect(await features.has("usage.settings", on: "a") == true)
        #expect(await features.has("usage.settings", on: "b") == false)
    }

    @Test func aBoxWithEverythingIsNeverAsked() async {
        let box = Box(Self.info([]))
        let features = Self.reader(box) { $0 == "mac" }
        #expect(await features.has("usage.settings", on: "mac") == true)
        #expect(features.knows("sign-in.methods", on: "mac") == true)
        #expect(box.asked == 0)
    }
}
