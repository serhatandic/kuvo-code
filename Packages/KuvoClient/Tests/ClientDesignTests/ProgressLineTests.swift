import ClientDesign
import Testing

/// What a download's bar says under it, on the Mac and the phone.
@Suite struct ProgressLineTests {
    typealias Words = ProgressLine.Words

    @Test func howMuchInTheTotalsUnit() {
        #expect(Words.amount(done: 34_400_000, of: 92_000_000) == "34 of 92 MB")
        #expect(Words.amount(done: 1_230_000_000, of: 3_400_000_000) == "1.2 of 3.4 GB")
        #expect(Words.amount(done: 640_000, of: 2_100_000) == "0.6 of 2.1 MB")
        #expect(Words.amount(done: 34_000_000, of: nil) == "34 MB")
        #expect(Words.spokenAmount(done: 34_400_000, of: 92_000_000) == "34 of 92 megabytes")
    }

    @Test func neverAllThereBeforeItIs() {
        #expect(Words.amount(done: 91_990_000, of: 92_000_000) == "91 of 92 MB")
        #expect(Words.percent(0.999) == "99%")
        #expect(Words.percent(0.34) == "34%")
        #expect(Words.percent(1) == "100%")
    }

    @Test func timeLeftFromItsRecentPace() {
        // Half way, a tenth more every 2 seconds: 10 seconds to go.
        let steady: [Words.Sample] = [(0, 0.4), (1, 0.45), (2, 0.5)]
        #expect(Words.secondsLeft(steady).map(Words.timeLeft) == "About 10 seconds")
        // Too soon to tell, or stalled: nothing.
        #expect(Words.secondsLeft([(0, 0.4), (0.5, 0.45)]) == nil)
        #expect(Words.secondsLeft([(0, 0.4), (3, 0.4)]) == nil)
    }

    @Test func timeLeftInRoundWords() {
        #expect(Words.timeLeft(4) == "A few seconds")
        #expect(Words.timeLeft(21) == "About 20 seconds")
        #expect(Words.timeLeft(70) == "About a minute")
        #expect(Words.timeLeft(250) == "About 4 minutes")
        #expect(Words.timeLeft(3700) == "About an hour")
        #expect(Words.timeLeft(3 * 3600) == "About 3 hours")
    }
}
