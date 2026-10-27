import ClientDesign
import Testing

/// How long a step has run, as it reads beside the step on the Mac and the phone.
@Suite struct StepActivityTests {
    @Test func secondsThenMinutesThenHours() {
        #expect(StepActivity.Elapsed.text(14) == "14s")
        #expect(StepActivity.Elapsed.text(72) == "1m 12s")
        #expect(StepActivity.Elapsed.text(3600 + 5 * 60 + 9) == "1h 5m")
    }
}
