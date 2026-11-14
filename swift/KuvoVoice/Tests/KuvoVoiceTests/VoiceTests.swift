import AVFoundation
import Speech
import Synchronization
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

// You may think for minutes between words: silence never ends it, only Done, Cancel or Escape.
@MainActor
@Test func silenceNeverEndsListening() {
    let voice = VoiceInput()
    var ended: [String] = []
    voice.ended = { ended.append($0) }
    voice.showSample(confirmed: "Make the timer pause", guess: "")
    voice.heard(rms: 0.3, run: voice.run)
    // Five minutes of it, as the microphone gives it (a level about ten times a second).
    for _ in 0..<3_000 { voice.heard(rms: 0.0001, run: voice.run) }
    #expect(voice.phase == .listening)
    #expect(ended.isEmpty)
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

// Finished, it says so to whoever listens, words or not: one finished before anything was heard
// never stays listening, with its timer running and nothing to press but Cancel.
@MainActor @Test func finishingTellsTheWordsAndFinishingWithNoneEndsToo() async {
    let voice = VoiceInput()
    var told: [String] = []
    voice.ended = { told.append($0) }
    voice.showSample(confirmed: "Make the timer pause", guess: "")
    voice.finish()
    while voice.phase != .idle { await Task.yield() }
    #expect(told == ["Make the timer pause"])

    voice.showSample(confirmed: "", guess: "")
    voice.finish()
    while voice.phase != .idle { await Task.yield() }
    #expect(told == ["Make the timer pause", ""])
    #expect(voice.listeningSince == nil)
}

// The microphone's samples come on the audio engine's own queue, as it calls its tap: taking them
// there mustn't need the main actor (Swift traps when it does: voice input quit the app as soon as
// it listened). A muted engine playing a tone stands in for the microphone, through the same tap,
// converted to what the analyzer takes. It needs the Mac's audio output, so it runs here, not on CI.
@MainActor
@Test func theMicrophonesSamplesAreTakenOnTheAudioQueue() async throws {
    let natural = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    let analyzed = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: natural)
    engine.mainMixerNode.outputVolume = 0
    let tone = AVAudioPCMBuffer(pcmFormat: natural, frameCapacity: 48_000)!
    tone.frameLength = 48_000
    for index in 0..<48_000 { tone.floatChannelData![0][index] = Float(sin(Double(index) / 10)) * 0.5 }

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    let levels = Mutex<Int>(0)
    VoiceInput.tap(player, natural: natural, format: analyzed, deliver: { continuation.yield(AnalyzerInput(buffer: $0)) }) { _ in levels.withLock { $0 += 1 } }
    try engine.start()
    player.scheduleBuffer(tone, at: nil, options: .loops, completionHandler: nil)
    player.play()
    var taken = 0
    for await input in stream {
        #expect(input.buffer.format.sampleRate == 16_000)
        taken += 1
        if taken == 3 { break }
    }
    player.removeTap(onBus: 0)
    engine.stop()
    #expect(levels.withLock { $0 } >= 3)
}

// What stopped it is said in plain words, with what to do, never in the system's own (#363: an
// iPhone showed "Voice input stopped: The operation couldn’t be completed. (OSStatus error -50.)").
@MainActor
@Test func whatStoppedItIsSaidInPlainWords() {
    let refused = NSError(domain: NSOSStatusErrorDomain, code: -50)
    let stages: [VoiceInput.Stage] = [.gettingReady, .microphone, .listening(wroteSome: false), .listening(wroteSome: true)]
    for stage in stages {
        let words = VoiceInput.failure(of: refused, stage).message
        #expect(!words.contains("OSStatus") && !words.contains("-50") && !words.contains("couldn’t be completed"), "\(stage): \(words)")
    }
    #expect(VoiceInput.failure(of: refused, .microphone).message == "Voice input couldn’t use the microphone. Try again.")
    // Stopped after some words, they're kept for Done.
    #expect(VoiceInput.failure(of: refused, .listening(wroteSome: true)).message == "Voice input stopped. What was written so far is kept.")
    // Getting ready offline says so, the network's error bare or inside the download's own.
    let offline = NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)
    let wrapped = NSError(domain: "SFSpeechErrorDomain", code: 3, userInfo: [NSUnderlyingErrorKey: offline])
    for error in [offline, wrapped] {
        #expect(VoiceInput.failure(of: error, .gettingReady).message.contains("Check that you’re online"))
    }
    #expect(!VoiceInput.failure(of: refused, .gettingReady).message.contains("online"))
    // Speech recognition not allowed still says where to allow it.
    let notAllowed = NSError(domain: "SFSpeechErrorDomain", code: 1, userInfo: [NSLocalizedDescriptionKey: "Speech recognition is not authorized"])
    #expect(VoiceInput.failure(of: notAllowed, .listening(wroteSome: false)) == .speechDenied)
}
