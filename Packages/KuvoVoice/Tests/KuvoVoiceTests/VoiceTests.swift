import Testing
@testable import KuvoVoice

// What voice input writes as you speak, and when it knows you've finished: fed what the recognizer
// and the microphone would give, on the audio's own clock.

@Test func wordsAppearAsYouSpeakAndItsGuessesAreCorrected() {
    var heard = VoiceTranscript()
    heard.take("Make the time", start: 0, isFinal: false)
    #expect(heard.text == "Make the time")
    #expect(heard.confirmed.isEmpty)
    // A better guess for the same stretch replaces it.
    heard.take("Make the timer", start: 0, isFinal: false)
    #expect(heard.text == "Make the timer")
    // Settled, then the next stretch guessed.
    heard.take("Make the timer pause", start: 0, isFinal: true)
    heard.take("when the window", start: 1.4, isFinal: false)
    #expect(heard.confirmed == "Make the timer pause")
    #expect(heard.guess == "when the window")
    #expect(heard.text == "Make the timer pause when the window")
    heard.take("when the window loses focus.", start: 1.4, isFinal: true)
    #expect(heard.text == "Make the timer pause when the window loses focus.")
    #expect(heard.guess.isEmpty)
    // Punctuation that starts a stretch joins the words before it.
    heard.take(", please", start: 3.0, isFinal: true)
    #expect(heard.text == "Make the timer pause when the window loses focus., please")
}

@Test func aPauseAfterSpeakingEndsItButSilenceBeforeDoesnt() {
    var pause = SpeechPause(seconds: 1.5)
    // Quiet before you start: it waits, however long.
    let early = [pause.take(level: 0.02, at: 0), pause.take(level: 0.02, at: 10)]
    #expect(early == [false, false])
    // You speak, then stop: it ends once you've been quiet that long.
    let after = [pause.take(level: 0.6, at: 10.2), pause.take(level: 0.05, at: 10.5), pause.take(level: 0.05, at: 11.9), pause.take(level: 0.05, at: 12.0)]
    #expect(after == [false, false, false, true])
}

@Test func newWordsKeepItListening() {
    var pause = SpeechPause(seconds: 1.5)
    _ = pause.take(level: 0.6, at: 0)
    _ = pause.take(level: 0.05, at: 0.2)
    // Words still coming in (a soft voice the meter barely hears): not finished.
    pause.heardWords(at: 1.5)
    let soon = pause.take(level: 0.05, at: 1.7)
    let later = pause.take(level: 0.05, at: 3.3)
    #expect(!soon)
    #expect(later)
}

@Test func theLevelRisesAtOnceAndFallsBackGently() {
    var level = VoiceLevel()
    level.take(rms: 0.2)
    let loud = level.value
    #expect(loud > 0.5)
    level.take(rms: 0.0001)
    #expect(level.value < loud && level.value > loud * 0.7)
    for _ in 0..<40 { level.take(rms: 0.0001) }
    #expect(level.value < 0.05)
}
