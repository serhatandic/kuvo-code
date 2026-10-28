import Foundation
import WhisperKit

/// Whisper, loaded. WhisperKit isn't marked Sendable; one dictation uses it at a time.
struct LoadedWhisper: @unchecked Sendable {
    let kit: WhisperKit
}

/// Whisper, loaded: one for the app, kept a few minutes after voice input last used it (loading
/// takes a second or two), then let go, for the memory it holds.
actor WhisperRuntime {
    static let shared = WhisperRuntime()

    /// Whether this device can run it: every Mac this app runs on, and iPhones from the A14 on (as Argmax lists them).
    nonisolated static var isSupported: Bool {
        #if os(iOS) && !targetEnvironment(simulator)
        ModelUtilities.modelSupport(for: WhisperKit.deviceName()).supported.contains("openai_whisper-large-v3-v20240930_turbo_632MB")
        #else
        true
        #endif
    }

    private var loaded: LoadedWhisper?
    private var folder: URL?
    private var loading: Task<LoadedWhisper, Error>?
    private var release: Task<Void, Never>?
    /// The dictations using it now: it's let go only once none is.
    private var users = 0
    private static let keep: Duration = .seconds(300)

    /// Whisper from `folder`, loaded if it isn't, for one more user (who calls `idle` when done).
    func kit(_ folder: URL) async throws -> LoadedWhisper {
        users += 1
        do { return try await load(folder) } catch {
            users -= 1
            throw error
        }
    }

    private func load(_ folder: URL) async throws -> LoadedWhisper {
        release?.cancel()
        if let loaded, self.folder == folder { return loaded }
        if let loading, self.folder == folder { return try await loading.value }
        self.folder = folder
        let loading = Task { try await Self.make(folder) }
        self.loading = loading
        do {
            let loaded = try await loading.value
            if self.folder == folder { self.loaded = loaded }
            self.loading = nil
            return loaded
        } catch {
            self.loading = nil
            self.folder = nil
            throw error
        }
    }

    /// A user done with it for now: once none is, it's let go after a while unless it's used again.
    func idle() {
        users = max(0, users - 1)
        guard users == 0 else { return }
        release?.cancel()
        release = Task {
            try? await Task.sleep(for: Self.keep)
            guard !Task.isCancelled else { return }
            await unload()
        }
    }

    /// Let go, and once a load under way has ended (it can't be stopped), nothing of it is written after.
    func unload() async {
        release?.cancel()
        let loading = loading
        users = 0
        loaded = nil
        folder = nil
        self.loading = nil
        _ = try? await loading?.value
    }

    /// The first load after the download: Core ML makes the model ready for this device's chip,
    /// which takes minutes, once. Then it's let go at once, unless voice input is using it.
    func prepare(_ folder: URL) async throws {
        _ = try await kit(folder)
        users = max(0, users - 1)
        guard users == 0 else { return }
        loaded = nil
        self.folder = nil
    }

    private static func make(_ folder: URL) async throws -> LoadedWhisper {
        let config = WhisperKitConfig(modelFolder: folder.path, tokenizerFolder: folder, verbose: false, logLevel: .error,
                                      prewarm: false, load: true, download: false)
        return LoadedWhisper(kit: try await WhisperKit(config))
    }
}

/// Dictation with Whisper: the microphone's samples (16 kHz, mono) in, phrases cut at the pauses
/// (`PhraseCutter`), each written once it ends, and a guess at the one under way as you speak.
/// Prompted with the words you're likely to say (the project's names), so they come out as
/// they're written.
actor WhisperDictation {
    enum Heard: Equatable, Sendable {
        case guess(String, start: Double)
        case final(String, start: Double)
        /// Whisper couldn't write a phrase: why, once; nothing more is written.
        case failed(String)
    }

    private let folder: URL
    private let language: String?
    private let words: @Sendable () async -> [String]
    private let heard: @Sendable (Heard) -> Void
    private var cutter = PhraseCutter()
    /// Seconds of the phrase under way at its last guess.
    private var guessedAt = 0.0
    private var whisper: LoadedWhisper?
    private var prompt: [Int]?
    private var names = ProjectNames([])
    private var asking: Task<Void, Never>?
    /// A phrase couldn't be written: the rest isn't tried.
    private var failed = false
    /// When it started taking samples, and how much it's taken: behind the microphone, it doesn't guess.
    private var since: ContinuousClock.Instant?
    private var taken = 0.0
    /// How often it guesses at the phrase under way, in seconds of it.
    private static let guessEvery = 1.2
    /// Whisper's prompt holds at most 224 tokens; the words get most of it.
    private static let promptTokens = 200

    init(folder: URL, locale: Locale, words: @escaping @Sendable () async -> [String], heard: @escaping @Sendable (Heard) -> Void) {
        self.folder = folder
        let code = locale.language.languageCode?.identifier
        language = code.flatMap { Constants.languages.values.contains($0) ? $0 : nil }
        self.words = words
        self.heard = heard
    }

    /// Loads Whisper (if it isn't), and asks for the words for its prompt, which it uses from
    /// when they come (a slow computer doesn't hold up what you say).
    func prepare() async throws {
        let words = words
        asking = Task { [weak self] in
            let names = await words()
            await self?.take(names)
        }
        whisper = try await WhisperRuntime.shared.kit(folder)
        if let pending { take(pending) }
    }

    private var pending: [String]?

    private func take(_ words: [String]) {
        guard let kit = whisper?.kit else { return pending = words }
        prompt = Self.prompt(words, kit: kit)
        names = ProjectNames(words)
        pending = nil
    }

    /// Writes all that `samples` gives, until it ends (you're done), then the phrase under way.
    func run(_ samples: AsyncStream<[Float]>) async {
        for await chunk in samples {
            since = since ?? .now
            taken += Double(chunk.count) / Double(PhraseCutter.rate)
            for phrase in cutter.take(chunk) { await write(phrase) }
            // A guess at the phrase under way, unless it's behind what you've said.
            if !failed, let partial = cutter.partial, partial.seconds - guessedAt >= Self.guessEvery, !isBehind {
                guessedAt = partial.seconds
                if let text = try? await transcribe(partial.samples, guess: true) { heard(.guess(text, start: partial.start)) }
            }
        }
        // Canceled: nothing more is written.
        if !Task.isCancelled, let last = cutter.flush() { await write(last) }
        await stop()
    }

    /// Done with Whisper: the app may let it go once no one else uses it.
    func stop() async {
        asking?.cancel()
        guard whisper != nil else { return }
        whisper = nil
        await WhisperRuntime.shared.idle()
    }

    /// More than half a second of what the microphone gave is still to take.
    private var isBehind: Bool {
        guard let since else { return false }
        let elapsed = ContinuousClock.now - since
        return Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18 - taken > 0.5
    }

    private func write(_ phrase: PhraseCutter.Phrase) async {
        guard !failed else { return }
        guessedAt = 0
        do {
            // What it settles on replaces its guess, nothing included.
            heard(.final(try await transcribe(phrase.samples) ?? "", start: phrase.start))
        } catch {
            failed = true
            heard(.failed(error.localizedDescription))
        }
    }

    private func transcribe(_ samples: [Float], guess: Bool = false) async throws -> String? {
        guard let kit = whisper?.kit else { return nil }
        // A guess is tried once; what it settles on may try again, warmer, when it's unsure.
        let options = DecodingOptions(task: .transcribe, language: language, temperature: 0, temperatureFallbackCount: guess ? 0 : 5,
                                      usePrefillPrompt: true, detectLanguage: language == nil,
                                      skipSpecialTokens: true, withoutTimestamps: true, promptTokens: prompt, suppressBlank: true)
        let results = try await kit.transcribe(audioArray: samples, decodeOptions: options)
        return names.fix(Self.clean(results.map(\.text).joined(separator: " ")))
    }

    /// Whisper's text, without what it writes for no words ("[BLANK_AUDIO]", "(music)").
    static func clean(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let noise = trimmed.replacingOccurrences(of: #"^[\[(][^\])]*[\])]$"#, with: "", options: .regularExpression)
        return noise.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The words as Whisper's prompt, as a sentence it would have heard before (which also keeps
    /// its capitals and full stops): as many as fit, most useful first.
    private static func prompt(_ words: [String], kit: WhisperKit) -> [Int]? {
        guard let tokenizer = kit.tokenizer, !words.isEmpty else { return nil }
        let encode = { (text: String) in tokenizer.encode(text: text).filter { $0 < tokenizer.specialTokens.specialTokenBegin } }
        var tokens = encode(" Names in this project:")
        let opening = tokens.count
        for word in words {
            let next = encode((tokens.count == opening ? " " : ", ") + word)
            guard tokens.count + next.count < promptTokens else { break }
            tokens += next
        }
        return tokens.count == opening ? nil : tokens + encode(".")
    }
}
