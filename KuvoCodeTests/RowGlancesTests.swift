import ClientDesign
import Foundation
import AppKit
import KuvoLink
import Testing
@testable import KuvoCode

/// A session's row at a glance (#395): what its box says of it is followed only for the rows on
/// screen, a box at a time, with every row of theirs (Recents and its project) counted, and not at
/// all while no window can be seen. A row going takes its session out; the last one going stops it.
@MainActor
@Suite struct RowGlancesTests {
    /// A box that follows `kuvo/sessions/glance/events` as this Mac's does: each request heard as
    /// it comes, answered with what's set, and told when the client stops following it.
    final class FollowedBox: BoxTransport, @unchecked Sendable {
        struct Asked { let path: String; let line: AsyncStream<String>.Continuation }
        let asked: AsyncStream<Asked>
        private let ask: AsyncStream<Asked>.Continuation
        let stopped: AsyncStream<String>
        private let stop: AsyncStream<String>.Continuation

        init() {
            (asked, ask) = AsyncStream.makeStream()
            (stopped, stop) = AsyncStream.makeStream()
        }

        func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
            let (lines, line) = AsyncStream<String>.makeStream()
            let path = request.path
            ask.yield(Asked(path: path, line: line))
            let stop = stop
            return AsyncThrowingStream { continuation in
                continuation.yield(.head(status: 200, headers: ["content-type": "application/x-ndjson"]))
                let task = Task {
                    for await each in lines { continuation.yield(.body(Data((each + "\n").utf8))) }
                }
                continuation.onTermination = { _ in
                    task.cancel()
                    stop.yield(path)
                }
            }
        }
    }

    let box = FollowedBox()
    let glances = RowGlances()

    init() {
        let transport = box
        glances.boxes = { id in BoxClient(box: id, transport: transport) }
        glances.settles = .zero
        glances.isSeen = { true }
    }

    @Test func onlyTheRowsOnScreenAreFollowedAndWhatTheirBoxSaysShows() async throws {
        var asked = box.asked.makeAsyncIterator()
        var stopped = box.stopped.makeAsyncIterator()
        glances.show("ses_tree", on: "mac", true)
        let first = try #require(await asked.next())
        #expect(first.path == "kuvo/sessions/glance/events?sessions=ses_tree")
        first.line.yield(#"{"sessions": {"ses_tree": {"branch": "kuvo/timer", "pull": {"number": 42, "url": "u", "state": "open", "checks": {"passed": 13, "failed": 1, "pending": 0}}}}}"#)
        while glances.glances["ses_tree"] == nil { await Task.yield() }
        #expect(glances.glances["ses_tree"]?.pull?.isFailing == true)

        // Another row comes on screen: followed together, the first stream let go.
        glances.show("ses_home", on: "mac", true)
        let both = try #require(await asked.next())
        #expect(both.path == "kuvo/sessions/glance/events?sessions=ses_home,ses_tree")
        #expect(await stopped.next() == first.path)

        // Its row in Recents and in its project: followed until both have gone.
        glances.show("ses_home", on: "mac", true)
        glances.show("ses_home", on: "mac", false)
        glances.show("ses_tree", on: "mac", false)
        let one = try #require(await asked.next())
        #expect(one.path == "kuvo/sessions/glance/events?sessions=ses_home")
        #expect(await stopped.next() == both.path)
        glances.show("ses_home", on: "mac", false)
        #expect(await stopped.next() == one.path)
    }

    @Test func aMachinesRowsAreFollowedOnTheirOwnAndNothingWhileNoWindowCanBeSeen() async throws {
        var asked = box.asked.makeAsyncIterator()
        var stopped = box.stopped.makeAsyncIterator()
        var visible = true
        glances.isSeen = { visible }
        glances.show("ses_mac", on: "mac", true)
        let mac = try #require(await asked.next())
        glances.show("ses_lab", on: "lab", true)
        let lab = try #require(await asked.next())
        #expect(mac.path.hasSuffix("sessions=ses_mac") && lab.path.hasSuffix("sessions=ses_lab"))
        // The window hidden: nothing followed, until it's back.
        visible = false
        NotificationCenter.default.post(name: NSApplication.didChangeOcclusionStateNotification, object: nil)
        let gone = [await stopped.next(), await stopped.next()]
        #expect(Set(gone.compactMap(\.self)) == [mac.path, lab.path])
        visible = true
        NotificationCenter.default.post(name: NSApplication.didChangeOcclusionStateNotification, object: nil)
        let back = [try #require(await asked.next()).path, try #require(await asked.next()).path]
        #expect(Set(back) == [mac.path, lab.path])
    }
}
