import AVFoundation
import Foundation
import Observation
import Speech

/// Voice input, as each way of showing it uses it (the composer listening, or the voice field):
/// it listens on this device's microphone, writes what you say as you say it (`transcript`), says
/// how loud you are (`level`, for the motion), and ends once you pause after speaking, or when you
/// say done. Then `ended` gets the words, for the composer to take. Speech is recognized on the
/// device, with its own model for your language, downloaded the first time.
@MainActor
@Observable
public final class VoiceInput {
    public enum Phase: Equatable, Sendable {
        case idle
        /// Getting ready: asking to use the microphone, or downloading the speech model (`progress`, 0 to 1, when it says).
        case preparing(progress: Double?)
        case listening
        /// What was said last being settled, after you finished.
        case finishing
        case failed(Failure)
    }

    public enum Failure: Equatable, Sendable {
        /// The microphone, or recognizing speech, wasn't allowed: it's in System Settings (Settings on iPhone).
        case microphoneDenied
        case speechDenied
        /// This device can't recognize speech in your language.
        case unsupported
        case other(String)

        /// What it says, in plain words.
        public var message: String {
            switch self {
            case .microphoneDenied: "Kuvo Code can’t use the microphone. Allow it in Privacy & Security › Microphone, then try again."
            case .speechDenied: "Kuvo Code can’t recognize speech. Allow it in Privacy & Security › Speech Recognition, then try again."
            case .unsupported: "Speech can’t be recognized in your language on this device."
            case .other(let words): words
            }
        }

        /// It's in the system's settings to change.
        public var opensSettings: Bool { self == .microphoneDenied || self == .speechDenied }
    }

    public private(set) var phase: Phase = .idle
    /// What's been said so far.
    public private(set) var transcript = VoiceTranscript()
    /// How loud you are now, 0 to 1.
    public private(set) var level: Double = 0
    /// How loud you've been, the newest last: a few seconds of it, for a trace that moves with your voice.
    public private(set) var recentLevels: [Double] = []
    /// How many `recentLevels` keeps.
    public static let recentCount = 64
    /// When it started listening, for how long it's been.
    public private(set) var listeningSince: Date?
    /// How long a pause after speaking ends it.
    public var pauseSeconds: Double = 1.8
    /// Told the words once it's ended by your pause or `finish` (none, when nothing was heard),
    /// never after `cancel`.
    public var ended: ((String) -> Void)?

    public var isActive: Bool {
        switch phase {
        case .preparing, .listening, .finishing: true
        case .idle, .failed: false
        }
    }

    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var analyzer: SpeechAnalyzer?
    @ObservationIgnored private var inputs: AsyncStream<AnalyzerInput>.Continuation?
    @ObservationIgnored private var listening: Task<Void, Never>?
    @ObservationIgnored private var results: Task<Void, Never>?
    @ObservationIgnored private var meter = VoiceLevel()
    #if os(iOS)
    @ObservationIgnored private var interruption: (any NSObjectProtocol)?
    #endif
    @ObservationIgnored private var pause = SpeechPause()
    /// Counts each start: what comes from an earlier one (a cancel, then a start) is dropped.
    @ObservationIgnored private var run = 0

    public init() {}

    /// Starts listening in `locale`'s language: asks for the microphone the first time, and
    /// downloads the speech model if this device hasn't one yet.
    public func start(locale: Locale = .current) {
        guard !isActive else { return }
        run += 1
        let run = run
        transcript = VoiceTranscript()
        level = 0
        recentLevels = []
        listeningSince = nil
        meter = VoiceLevel()
        pause = SpeechPause(seconds: pauseSeconds)
        phase = .preparing(progress: nil)
        listening = Task { await listen(locale: locale, run: run) }
    }

    /// You're done: what was said last is settled, and `ended` gets the words.
    public func finish() {
        // Still getting ready: nothing was heard, and the microphone mustn't come on after.
        if isPreparing {
            cancel()
            ended?("")
            return
        }
        guard phase == .listening else { return }
        phase = .finishing
        let run = run
        stopMicrophone()
        Task {
            try? await analyzer?.finalizeAndFinishThroughEndOfInput()
            await results?.value
            guard self.run == run else { return }
            end(run: run)
        }
    }

    /// Stops without keeping anything.
    public func cancel() {
        run += 1
        stopMicrophone()
        let analyzer = analyzer
        Task { await analyzer?.cancelAndFinishNow() }
        listening?.cancel()
        results?.cancel()
        clear()
        phase = .idle
    }

    #if DEBUG
    /// Listening, with `confirmed` heard and `guess` its newest guess, without the microphone: for
    /// a demo copy's screenshots, which mustn't ask for it.
    public func showSample(confirmed: String, guess: String, level: Double = 0.5) {
        run += 1
        transcript = VoiceTranscript()
        transcript.take(confirmed, start: 0, isFinal: true)
        if !guess.isEmpty { transcript.take(guess, start: 1, isFinal: false) }
        self.level = level
        recentLevels = (0..<Self.recentCount).map { index in 0.15 + 0.8 * abs(sin(Double(index) / 4.3)) * (0.6 + 0.4 * abs(cos(Double(index) / 1.7))) }
        listeningSince = Date().addingTimeInterval(-7)
        phase = .listening
    }
    #endif

    private var isPreparing: Bool {
        if case .preparing = phase { true } else { false }
    }

    // MARK: Listening

    private func listen(locale: Locale, run: Int) async {
        // The microphone, asked for once.
        guard await Self.microphoneAllowed() else { return fail(.microphoneDenied, run: run) }
        guard let language = await DictationTranscriber.supportedLocale(equivalentTo: locale) else { return fail(.unsupported, run: run) }
        let transcriber = DictationTranscriber(locale: language, contentHints: [], transcriptionOptions: [.punctuation],
                                               reportingOptions: [.volatileResults, .frequentFinalization], attributeOptions: [.audioTimeRange])
        do {
            // Its model for your language, the first time.
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                let progress = request.progress
                let watching = Task { @MainActor [weak self] in
                    while !Task.isCancelled, self?.run == run, self?.isPreparing == true {
                        self?.phase = .preparing(progress: progress.totalUnitCount > 0 ? progress.fractionCompleted : nil)
                        try? await Task.sleep(for: .milliseconds(250))
                    }
                }
                defer { watching.cancel() }
                try await request.downloadAndInstall()
            }
            guard self.run == run else { return }
            #if os(iOS)
            // AirPods' microphone too, when they're in.
            try AVAudioSession.sharedInstance().setCategory(.record, mode: .spokenAudio, options: [.duckOthers, .allowBluetoothHFP])
            try AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
            // A call, Siri or an alarm takes the microphone: what was said so far is kept, rather
            // than listening on to nothing.
            interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                guard (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began else { return }
                MainActor.assumeIsolated { self?.finish() }
            }
            #endif
            let engine = AVAudioEngine()
            let input = engine.inputNode
            let natural = input.outputFormat(forBus: 0)
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: natural) else { return fail(.unsupported, run: run) }
            let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            try await analyzer.prepareToAnalyze(in: format)
            guard self.run == run else { return }
            self.engine = engine
            self.analyzer = analyzer
            inputs = continuation
            results = Task { [weak self] in await self?.read(transcriber, run: run) }
            Self.tap(input, natural: natural, format: format, continuation: continuation) { [weak self] rms, time in
                Task { @MainActor in self?.heard(rms: rms, at: time, run: run) }
            }
            engine.prepare()
            try engine.start()
            phase = .listening
            listeningSince = .now
            try await analyzer.start(inputSequence: stream)
        } catch {
            guard self.run == run else { return }
            fail(Self.failure(of: error), run: run)
        }
    }

    /// What it heard, as it settles it.
    private func read(_ transcriber: DictationTranscriber, run: Int) async {
        do {
            for try await result in transcriber.results {
                guard self.run == run else { return }
                transcript.take(String(result.text.characters), start: result.range.start.seconds, isFinal: result.isFinal)
                pause.heardWords(at: result.range.end.seconds)
            }
        } catch {
            guard self.run == run, phase == .listening else { return }
            fail(Self.failure(of: error), run: run)
        }
    }

    private func heard(rms: Float, at time: Double, run: Int) {
        guard self.run == run, phase == .listening else { return }
        meter.take(rms: rms)
        level = meter.value
        recentLevels.append(meter.value)
        if recentLevels.count > Self.recentCount { recentLevels.removeFirst(recentLevels.count - Self.recentCount) }
        if pause.take(level: meter.value, at: time) { finish() }
    }

    private func end(run: Int) {
        let words = transcript.text
        clear()
        phase = .idle
        ended?(words)
    }

    private func fail(_ failure: Failure, run: Int) {
        guard self.run == run else { return }
        stopMicrophone()
        clear()
        phase = .failed(failure)
    }

    private func stopMicrophone() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        inputs?.finish()
        inputs = nil
        level = 0
        #if os(iOS)
        if let interruption { NotificationCenter.default.removeObserver(interruption) }
        interruption = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    private func clear() {
        analyzer = nil
        listening = nil
        results = nil
        listeningSince = nil
    }

    /// Taps `node` for what it hears: on the audio engine's own queue, each buffer goes to the
    /// analyzer (converted to `format`), and how loud it is to `level`. Done here, off the main
    /// actor: a tap installed from `listen` would be the main actor's, and Swift traps when the
    /// audio queue calls it.
    nonisolated static func tap(_ node: AVAudioNode, natural: AVAudioFormat, format: AVAudioFormat, continuation: AsyncStream<AnalyzerInput>.Continuation, level: @escaping @Sendable (Float, Double) -> Void) {
        let tap = Tap(format: format, converter: natural == format ? nil : AVAudioConverter(from: natural, to: format), continuation: continuation, level: level)
        node.installTap(onBus: 0, bufferSize: 1024, format: natural) { buffer, when in tap.take(buffer, at: when) }
    }

    // MARK: Permission

    /// Whether the microphone may be used: asked the first time.
    static func microphoneAllowed() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    /// Whether it has been asked for, and what was answered (nil: not asked yet).
    public static var microphoneAnswer: Bool? {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: true
        case .denied: false
        default: nil
        }
    }

    private static func failure(of error: Error) -> Failure {
        let words = error.localizedDescription
        if words.localizedCaseInsensitiveContains("not authorized") || words.localizedCaseInsensitiveContains("authoriz") { return .speechDenied }
        return .other("Voice input stopped: \(words)")
    }
}

/// The microphone's samples, on the audio thread: how loud they are, and each converted to the
/// format the analyzer takes.
private final class Tap: @unchecked Sendable {
    let format: AVAudioFormat
    let converter: AVAudioConverter?
    let continuation: AsyncStream<AnalyzerInput>.Continuation
    let level: @Sendable (Float, Double) -> Void

    init(format: AVAudioFormat, converter: AVAudioConverter?, continuation: AsyncStream<AnalyzerInput>.Continuation, level: @escaping @Sendable (Float, Double) -> Void) {
        self.format = format
        self.converter = converter
        self.continuation = continuation
        self.level = level
    }

    func take(_ buffer: AVAudioPCMBuffer, at when: AVAudioTime) {
        if let samples = buffer.floatChannelData?[0] {
            let rms = VoiceLevel.rms(UnsafeBufferPointer(start: samples, count: Int(buffer.frameLength)))
            level(rms, Double(when.sampleTime) / max(when.sampleRate, 1))
        }
        guard let converter else {
            continuation.yield(AnalyzerInput(buffer: buffer))
            return
        }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var given = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return buffer
        }
        if error == nil, converted.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: converted)) }
    }

}
