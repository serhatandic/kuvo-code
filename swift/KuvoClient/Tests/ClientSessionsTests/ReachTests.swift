import ClientSessions
import Foundation
import Testing

/// When a computer counts as out of reach (#443): a busy one, slow to answer or with its link
/// down for a moment, never does; one that doesn't answer a check after the grace does.
@MainActor
struct ReachTests {
    /// The waits it made, without waiting.
    private final class Waits {
        var made: [Duration] = []
    }

    // Its link back within the grace (a busy computer dropping it for a moment): nothing says it
    // was ever out of reach, and it isn't even checked.
    @Test func aLinkBackWithinTheGraceIsNeverOutOfReach() async {
        let waits = Waits()
        var back = false
        var checks = 0
        let away = await Reach.isAway(isBack: { back }, check: { checks += 1; return false }, wait: { waits.made.append($0); back = true })
        #expect(!away)
        #expect(checks == 0)
        #expect(waits.made == [Reach.grace])
    }

    // Down past the grace, but it answers when checked (late, as a loaded computer does): still in
    // reach, checked again while its link stays down, and not out of reach once it's back.
    @Test func aComputerThatAnswersLateStaysInReach() async {
        let waits = Waits()
        var checks = 0
        let away = await Reach.isAway(isBack: { checks == 3 }, check: { checks += 1; return true }, wait: { waits.made.append($0) })
        #expect(!away)
        #expect(checks == 3)
        #expect(waits.made == [Reach.grace, Reach.again, Reach.again])
    }

    // A real outage: down through the grace, then a check fails. Out of reach then, not before.
    @Test func aComputerThatDoesntAnswerAfterTheGraceIsOutOfReach() async {
        let waits = Waits()
        var checks = 0
        let away = await Reach.isAway(isBack: { false }, check: { checks += 1; return checks < 2 }, wait: { waits.made.append($0) })
        #expect(away)
        #expect(checks == 2)
        #expect(waits.made == [Reach.grace, Reach.again])
    }

    // A check still asking once its patience runs out has failed, rather than hanging the decision.
    @Test func aCheckWithNoAnswerInTimeFails() async {
        let answered = await Reach.answers(within: .milliseconds(1)) {
            try? await Task.sleep(for: .seconds(3600))
            return true
        }
        #expect(!answered)
        #expect(await Reach.answers(within: .seconds(3600)) { true })
    }

    // The link failing is told apart from the request failing: what was read is read again then,
    // soon at first, then less often while the computer stays slow.
    @Test func linkFailuresAreToldApartFromTheRequestsOwn() {
        #expect(Reach.readAgain(after: 1) == .seconds(2))
        #expect(Reach.readAgain(after: 3) == .seconds(8))
        #expect(Reach.readAgain(after: 9) == .seconds(30))
        #expect(Reach.isTransient(URLError(.timedOut)))
        #expect(Reach.isTransient(URLError(.networkConnectionLost)))
        #expect(Reach.isTransient(NSError(domain: NSURLErrorDomain, code: URLError.cannotConnectToHost.rawValue)))
        #expect(!Reach.isTransient(URLError(.cancelled)))
        #expect(!Reach.isTransient(URLError(.badServerResponse)))
        #expect(!Reach.isTransient(NSError(domain: "engine", code: 503, userInfo: [NSLocalizedDescriptionKey: "The engine isn't running."])))
    }
}
