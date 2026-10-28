import AVFoundation
import Foundation
import Observation
import Speech

/// Voice input, as each way of showing it uses it (the composer listening, or the voice field):
/// it listens on this device's microphone, writes what you say as you say it (`transcript`), says
/// how loud you are (`level`, for the motion), and goes on, through any silence, until you say
/// done. Then `ended` gets the words, for the composer to take. Speech is recognized on the
/// device, by Whisper (`SpeechModel`), and only once it's here: until then voice input doesn't
/// start. A device that can't run Whisper listens with Apple's dictation. Each is told the words
/// you're likely to say (the project's names).
@MainActor
@Observable
public final class VoiceInput {
    public enum Phase: Equatable, Sendable {
        case idle
        /// Getting ready: asking to use the microphone, or, where Apple's dictation listens,
        /// downloading its model for your language (`progress`, 0 to 1, when it says).
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
    /// Whisper is writing what you say (not Apple's dictation, on a device that can't run it).
    public private(set) var usesWhisper = false
    /// The speech model it listens with.
    public let model: SpeechModel
    /// Told the words once `finish` has ended it (none, when nothing was heard),
    /// never after `cancel`.
    public var ended: ((String) -> Void)?

    /// Stopped by a failure after some words were written: Done (`finish`) puts them in the message.
    public var keepsWords: Bool {
        if case .failed = phase { !transcript.isEmpty } else { false }
    }

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
    @ObservationIgnored private var samples: AsyncStream<[Float]>.Continuation?
    /// The project's names, to put back as they're written in what Apple's dictation heard.
    @ObservationIgnored private var names = ProjectNames([])
    @ObservationIgnored private var meter = VoiceLevel()
    #if os(iOS)
    @ObservationIgnored private var interruption: (any NSObjectProtocol)?
    #endif
    /// Counts each start: what comes from an earlier one (a cancel, then a start) is dropped.
    @ObservationIgnored private(set) var run = 0

    public init(model: SpeechModel = .shared) {
        self.model = model
    }

    /// Starts listening in `locale`'s language, for `words` (the project's names, which it's told
    /// to expect), asking for the microphone the first time. Nothing starts while the model
    /// can't listen yet: the mic brings it in first (`SpeechModel.micPressed`).
    public func start(locale: Locale = .current, words: @escaping @Sendable () async -> [String] = { [] }) {
        start(locale: locale, words: words, clip: nil)
    }

    /// As `start`, with Whisper hearing `clip` rather than the microphone: for tests, which play
    /// it a recording.
    func start(locale: Locale = .current, words: @escaping @Sendable () async -> [String] = { [] }, clip: AsyncStream<[Float]>?) {
        guard !isActive, model.canListen else { return }
        run += 1
        let run = run
        transcript = VoiceTranscript()
        names = ProjectNames([])
        level = 0
        recentLevels = []
        listeningSince = nil
        meter = VoiceLevel()
        phase = .preparing(progress: nil)
        if model.isReady, let folder = model.modelFolder {
            usesWhisper = true
            listening = Task { await listenWithWhisper(folder: folder, locale: locale, words: words, clip: clip, run: run) }
        } else {
            usesWhisper = false
            listening = Task { await listen(locale: locale, words: words, run: run) }
        }
    }

    /// You're done: what was said last is settled, and `ended` gets the words. Stopped by a
    /// failure, `ended` gets what was written before it.
    public func finish() {
        // Still getting ready: nothing was heard, and the microphone mustn't come on after.
        if isPreparing {
            cancel()
            ended?("")
            return
        }
        if case .failed = phase {
            let words = transcript.text
            cancel()
            ended?(words)
            return
        }
        guard phase == .listening else { return }
        phase = .finishing
        let run = run
        stopMicrophone()
        Task {
            try? await analyzer?.finalizeAndFinishThroughEndOfInput()
            if usesWhisper { await listening?.value }
            await results?.value
            // Failed meanwhile: it says so, and Done there takes what was written.
            guard self.run == run, phase == .finishing else { return }
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
        usesWhisper = model.isReady
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

    /// Listening with Apple's dictation, on a device that can't run Whisper.
    private func listen(locale: Locale, words: @escaping @Sendable () async -> [String], run: Int) async {
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
            try startSession()
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
            // The project's names, as they come (they're asked of the box).
            Task { [weak self] in
                let names = await words()
                guard !names.isEmpty else { return }
                if self?.run == run { self?.names = ProjectNames(names) }
                let context = AnalysisContext()
                // Apple's dictation takes at most 100.
                context.contextualStrings[.general] = Array(names.prefix(100))
                try? await analyzer.setContext(context)
            }
            Self.tap(input, natural: natural, format: format, deliver: { continuation.yield(AnalyzerInput(buffer: $0)) }) { [weak self] rms in
                Task { @MainActor in self?.heard(rms: rms, run: run) }
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
                transcript.take(names.fix(String(result.text.characters)), start: result.range.start.seconds, isFinal: result.isFinal)
            }
        } catch {
            guard self.run == run, phase == .listening else { return }
            fail(Self.failure(of: error), run: run)
        }
    }

    /// Listening with Whisper: loaded first (getting ready, which Cancel stops), and only then
    /// the microphone (or `clip`), so nothing seems to listen before anything can be written.
    /// Each phrase is written as it ends.
    private func listenWithWhisper(folder: URL, locale: Locale, words: @escaping @Sendable () async -> [String], clip: AsyncStream<[Float]>?, run: Int) async {
        if clip == nil {
            guard await Self.microphoneAllowed() else { return fail(.microphoneDenied, run: run) }
        }
        guard self.run == run else { return }
        let dictation = WhisperDictation(folder: folder, locale: locale, words: words) { [weak self] heard in
            Task { @MainActor in self?.take(heard, run: run) }
        }
        do {
            try await dictation.prepare()
        } catch {
            await dictation.stop()
            return fail(.other("Voice input couldn’t start: \(error.localizedDescription)"), run: run)
        }
        guard self.run == run else { return await dictation.stop() }
        // A clip goes on until whoever plays it ends it, after Done.
        if let clip {
            phase = .listening
            listeningSince = .now
            return await dictation.run(clip)
        }
        let (stream, continuation) = AsyncStream<[Float]>.makeStream()
        do {
            try startSession()
            let engine = AVAudioEngine()
            let input = engine.inputNode
            let natural = input.outputFormat(forBus: 0)
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(PhraseCutter.rate), channels: 1, interleaved: false)!
            self.engine = engine
            Self.tap(input, natural: natural, format: format, deliver: { buffer in
                guard let channel = buffer.floatChannelData?[0] else { return }
                continuation.yield(Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength))))
            }) { [weak self] rms in
                Task { @MainActor in self?.heard(rms: rms, run: run) }
            }
            engine.prepare()
            try engine.start()
        } catch {
            continuation.finish()
            await dictation.stop()
            return fail(.other("Voice input couldn’t use the microphone: \(error.localizedDescription)"), run: run)
        }
        samples = continuation
        phase = .listening
        listeningSince = .now
        await dictation.run(stream)
    }

    private func take(_ heard: WhisperDictation.Heard, run: Int) {
        guard self.run == run else { return }
        switch heard {
        case .guess(let text, let start): transcript.take(text, start: start, isFinal: false)
        case .final(let text, let start): transcript.take(text, start: start, isFinal: true)
        case .failed(let words):
            // What was written stays, for Done to take.
            fail(.other("Whisper couldn’t write what you said: \(words)"), run: run)
        }
    }

    /// The phone's audio, set for listening.
    private func startSession() throws {
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
    }

    func heard(rms: Float, run: Int) {
        guard self.run == run, phase == .listening else { return }
        meter.take(rms: rms)
        level = meter.value
        recentLevels.append(meter.value)
        if recentLevels.count > Self.recentCount { recentLevels.removeFirst(recentLevels.count - Self.recentCount) }
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
        samples?.finish()
        samples = nil
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

    /// Taps `node` for what it hears: on the audio engine's own queue, each buffer goes to
    /// `deliver` (converted to `format`), and how loud it is to `level`. Done here, off the main
    /// actor: a tap installed from `listen` would be the main actor's, and Swift traps when the
    /// audio queue calls it.
    nonisolated static func tap(_ node: AVAudioNode, natural: AVAudioFormat, format: AVAudioFormat, deliver: @escaping @Sendable (AVAudioPCMBuffer) -> Void, level: @escaping @Sendable (Float) -> Void) {
        let tap = Tap(format: format, converter: natural == format ? nil : AVAudioConverter(from: natural, to: format), deliver: deliver, level: level)
        node.installTap(onBus: 0, bufferSize: 1024, format: natural) { buffer, _ in tap.take(buffer) }
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
/// format the recognizer takes.
private final class Tap: @unchecked Sendable {
    let format: AVAudioFormat
    let converter: AVAudioConverter?
    let deliver: @Sendable (AVAudioPCMBuffer) -> Void
    let level: @Sendable (Float) -> Void

    init(format: AVAudioFormat, converter: AVAudioConverter?, deliver: @escaping @Sendable (AVAudioPCMBuffer) -> Void, level: @escaping @Sendable (Float) -> Void) {
        self.format = format
        self.converter = converter
        self.deliver = deliver
        self.level = level
    }

    func take(_ buffer: AVAudioPCMBuffer) {
        if let samples = buffer.floatChannelData?[0] {
            let rms = VoiceLevel.rms(UnsafeBufferPointer(start: samples, count: Int(buffer.frameLength)))
            level(rms)
        }
        guard let converter else {
            deliver(buffer)
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
        if error == nil, converted.frameLength > 0 { deliver(converted) }
    }

}
