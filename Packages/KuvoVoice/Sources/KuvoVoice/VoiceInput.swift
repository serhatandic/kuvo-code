import AVFoundation
import Foundation
import Observation
import OSLog
import Speech

/// Voice input, as each way of showing it uses it (the composer listening, or the voice field):
/// it listens on this device's microphone, writes what you say as you say it (`transcript`), says
/// how loud you are (`level`, for the motion), and goes on, through any silence, until you say
/// done. Then `ended` gets the words, for the composer to take. Speech is recognized on the
/// device: by Apple's dictation, or by Whisper once it's turned on and ready (`SpeechModel`),
/// each told the words you're likely to say (the project's names).
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
    /// The phone's audio is set up (or being set up) for this, to let go of once it stops.
    @ObservationIgnored private var holdsSession = false
    #endif
    /// Counts each start: what comes from an earlier one (a cancel, then a start) is dropped.
    @ObservationIgnored private(set) var run = 0

    public init(model: SpeechModel = .shared) {
        self.model = model
    }

    /// Starts listening in `locale`'s language, for `words` (the project's names, which it's told
    /// to expect), asking for the microphone the first time: with Whisper if it's on and ready,
    /// otherwise with Apple's dictation (which never waits on Whisper's download).
    public func start(locale: Locale = .current, words: @escaping @Sendable () async -> [String] = { [] }) {
        start(locale: locale, words: words, clip: nil)
    }

    /// As `start`, with Whisper (on and ready) hearing `clip` rather than the microphone: for
    /// tests, which play it a recording.
    func start(locale: Locale = .current, words: @escaping @Sendable () async -> [String] = { [] }, clip: AsyncStream<[Float]>?) {
        guard !isActive else { return }
        run += 1
        let run = run
        transcript = VoiceTranscript()
        names = ProjectNames([])
        level = 0
        recentLevels = []
        listeningSince = nil
        meter = VoiceLevel()
        phase = .preparing(progress: nil)
        if model.listensWithWhisper, let folder = model.modelFolder {
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
        // Still getting ready, before the microphone came on: nothing was heard, and it mustn't
        // come on after. (With it on, while Whisper loads, what you said is written once it has.)
        if isPreparing, samples == nil {
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
        guard phase == .listening || isPreparing else { return }
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
        usesWhisper = model.listensWithWhisper
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
        // Its model for your language, the first time (not for a test's microphone that refuses,
        // which mustn't wait on a download).
        #if DEBUG
        let fetchesModel = !Self.microphoneRefuses
        #else
        let fetchesModel = true
        #endif
        do {
            if fetchesModel, let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
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
        } catch {
            guard self.run == run else { return }
            return fail(Self.failure(of: error, .gettingReady), run: run)
        }
        guard self.run == run else { return }
        // The microphone, as it hears once the phone's audio is set for recording (before, it may
        // have no input, or another route's rate): AirPods' own, when they're in.
        let engine: AVAudioEngine
        let input: AVAudioInputNode
        let natural: AVAudioFormat
        do {
            try await startSession(run: run)
            engine = AVAudioEngine()
            input = engine.inputNode
            natural = try Self.microphoneFormat(of: input)
        } catch {
            guard self.run == run else { return }
            return fail(Self.failure(of: error, .microphone), run: run)
        }
        self.engine = engine
        do {
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: natural) else { return fail(.unsupported, run: run) }
            let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            try await analyzer.prepareToAnalyze(in: format)
            // Canceled while it got ready: it lets go of the model it prepared.
            guard self.run == run else { return await analyzer.cancelAndFinishNow() }
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
            do {
                engine.prepare()
                try engine.start()
            } catch {
                return fail(Self.failure(of: error, .microphone), run: run)
            }
            phase = .listening
            listeningSince = .now
            try await analyzer.start(inputSequence: stream)
        } catch {
            guard self.run == run else { return }
            fail(Self.failure(of: error, .listening(wroteSome: !transcript.isEmpty)), run: run)
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
            fail(Self.failure(of: error, .listening(wroteSome: !transcript.isEmpty)), run: run)
        }
    }

    /// Listening with Whisper: the microphone comes on at once and what you say waits while
    /// Whisper loads (a few seconds, since its copy for this chip is kept), getting ready until
    /// then; or `clip` plays once it's loaded. Each phrase is written as it ends.
    private func listenWithWhisper(folder: URL, locale: Locale, words: @escaping @Sendable () async -> [String], clip: AsyncStream<[Float]>?, run: Int) async {
        let (stream, continuation) = AsyncStream<[Float]>.makeStream()
        if clip == nil {
            guard await Self.microphoneAllowed() else { return fail(.microphoneDenied, run: run) }
            guard self.run == run else { return }
            do {
                try await startMicrophone(continuation, run: run)
            } catch {
                continuation.finish()
                guard self.run == run else { return }
                return fail(Self.failure(of: error, .microphone), run: run)
            }
            samples = continuation
        }
        let dictation = WhisperDictation(folder: folder, locale: locale, words: words) { [weak self] heard in
            Task { @MainActor in self?.take(heard, run: run) }
        }
        do {
            try await dictation.prepare()
        } catch {
            await dictation.stop()
            return fail(.other("Voice input couldn’t start. Try again; if it keeps stopping, remove the voice model in Settings and download it again."), run: run)
        }
        guard self.run == run else { return await dictation.stop() }
        // Done while it loaded: it's finishing, and writes what was said.
        if isPreparing {
            phase = .listening
            listeningSince = .now
        }
        await dictation.run(clip ?? stream)
    }

    /// The microphone on, its samples (16 kHz, mono) into `continuation`.
    private func startMicrophone(_ continuation: AsyncStream<[Float]>.Continuation, run: Int) async throws {
        try await startSession(run: run)
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let natural = try Self.microphoneFormat(of: input)
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
    }

    private func take(_ heard: WhisperDictation.Heard, run: Int) {
        guard self.run == run else { return }
        switch heard {
        case .guess(let text, let start): transcript.take(text, start: start, isFinal: false)
        case .final(let text, let start): transcript.take(text, start: start, isFinal: true)
        case .failed:
            // After Done, it ends with what was written; before, it says so, and what was
            // written stays for Done to take.
            guard phase != .finishing else { return }
            fail(Self.stopped(wroteSome: !transcript.isEmpty), run: run)
        }
    }

    #if os(iOS)
    /// The phone's audio, set for listening: recording, in the default mode, with AirPods'
    /// microphone too when they're in; each of them iOS takes for recording. It asked for others'
    /// audio ducked, in the spoken-audio mode, which iOS takes only for a category that plays
    /// (`AVAudioSessionTypes.h`), and on an iPhone it refused the whole setting (OSStatus -50):
    /// voice input stopped before it listened, every time (#363). Recording quiets what else plays
    /// anyway, as the system's own dictation does, and lets it play on once it's done.
    nonisolated public static func setUpSession(_ session: AVAudioSession = .sharedInstance()) throws {
        try session.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    /// The phone's audio is set up and let go of here, one after the other, off the main thread:
    /// each blocks until the system's audio answers, which can take long enough to freeze the app
    /// (iOS 27 warns of it on the main thread), and one start's let-go must never land after the
    /// next one's set-up.
    private static let sessionQueue = DispatchQueue(label: "run.kuvo.voice.session")

    private static func setUpSessionInTurn() async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, any Error>) in
            sessionQueue.async {
                do {
                    try setUpSession()
                    done.resume()
                } catch {
                    done.resume(throwing: error)
                }
            }
        }
    }

    private static func letGoOfSessionInTurn() {
        sessionQueue.async { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }
    #endif

    #if DEBUG
    /// For the apps' tests: the microphone refuses to come on, as an iPhone's audio did with
    /// OSStatus -50 (#363), once the phone's audio is set up (and so let go of again), before the
    /// microphone itself is asked for (a simulator would use the Mac's).
    public static var microphoneRefuses = false
    #endif

    /// The phone's audio, set for listening (for start `run`: canceled meanwhile, it throws).
    private func startSession(run: Int) async throws {
        #if os(iOS)
        // Held from here: a cancel while it's set up lets go of it after.
        holdsSession = true
        try await Self.setUpSessionInTurn()
        // Canceled while it was set up: the cancel's let-go comes after it, and nothing listens.
        try Task.checkCancellation()
        guard self.run == run else { throw CancellationError() }
        #endif
        #if DEBUG
        if Self.microphoneRefuses { throw NSError(domain: NSOSStatusErrorDomain, code: -50) }
        #endif
        #if os(iOS)
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
        // Apple's dictation lets go of its model, as when it's canceled: nothing more comes.
        let analyzer = analyzer
        Task { await analyzer?.cancelAndFinishNow() }
        results?.cancel()
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
        // Only audio it set up: a start that stopped before (the microphone not allowed, the
        // model's download) leaves the app's audio as it was.
        if holdsSession {
            holdsSession = false
            Self.letGoOfSessionInTurn()
        }
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

    /// Where voice input was when something went wrong, for what it says.
    enum Stage: Equatable {
        /// Getting Apple's dictation ready for your language.
        case gettingReady
        /// Turning the microphone on.
        case microphone
        /// Listening: some words written, or none yet.
        case listening(wroteSome: Bool)
    }

    /// What it says when `error` stopped it at `stage`: in plain words, never the system's own
    /// (“The operation couldn’t be completed. (OSStatus error -50.)”), which goes to the log, for
    /// whoever looks into it.
    static func failure(of error: Error, _ stage: Stage) -> Failure {
        log.error("Voice input stopped at \(String(describing: stage), privacy: .public): \(String(describing: error), privacy: .public)")
        if (error as? VoiceError) == .noMicrophone {
            #if os(iOS)
            return .other("Voice input couldn’t hear the microphone. Try again.")
            #else
            return .other("Voice input can’t hear a microphone. Check that one is connected, then try again.")
            #endif
        }
        let words = error.localizedDescription
        if words.localizedCaseInsensitiveContains("authoriz") { return .speechDenied }
        return switch stage {
        case .gettingReady where isNetwork(error):
            .other("Voice input couldn’t download what it needs for your language. Check that you’re online, then try again.")
        case .gettingReady: .other("Voice input couldn’t get ready. Try again.")
        case .microphone: .other("Voice input couldn’t use the microphone. Try again.")
        case .listening(let wroteSome): stopped(wroteSome: wroteSome)
        }
    }

    /// The network failed it, said by the error or one it wraps (a download's own error, around
    /// the connection's).
    static func isNetwork(_ error: any Error) -> Bool {
        let error = error as NSError
        if error.domain == NSURLErrorDomain { return true }
        return error.underlyingErrors.contains { isNetwork($0) }
    }

    /// Stopped while it listened: what was written, if anything, stays for Done to take.
    static func stopped(wroteSome: Bool) -> Failure {
        .other(wroteSome ? "Voice input stopped. What was written so far is kept." : "Voice input stopped before anything was written. Try again.")
    }

    /// The microphone's own format, to tap it with: none (no rate or channels, as with no input
    /// to record from) is an error here, rather than a tap the audio engine ends the app over.
    nonisolated static func microphoneFormat(of input: AVAudioNode) throws -> AVAudioFormat {
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw VoiceError.noMicrophone }
        return format
    }

    private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "run.kuvo.code", category: "voice")
}

enum VoiceError: Error, Equatable {
    /// No microphone to listen with.
    case noMicrophone
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
