import AVFoundation
import CryptoKit
import Foundation
import Synchronization
import Testing
@testable import KuvoVoice

// Whisper's side of voice input: what it's given of what you say (phrases, never the silence
// between them), and its model coming onto the device (downloaded, resumed, checked, removed).

// MARK: Phrases

/// Something like speech: a tone that comes and goes, as loud as talking near a microphone.
private func speech(_ seconds: Double) -> [Float] {
    let count = Int(seconds * 16_000)
    return (0..<count).map { index in
        let t = Double(index) / 16_000
        return Float(0.25 * sin(2 * .pi * 180 * t) * (0.6 + 0.4 * sin(2 * .pi * 3 * t)))
    }
}

/// A quiet room: a faint, steady hiss (about -55 dBFS), so a pause isn't digital silence.
private func quiet(_ seconds: Double) -> [Float] {
    var seed: UInt32 = 7
    return (0..<Int(seconds * 16_000)).map { _ in
        seed = seed &* 1_664_525 &+ 1_013_904_223
        return (Float(seed >> 8) / Float(1 << 24) - 0.5) * 0.004
    }
}

/// Fed as the microphone gives it, in tenths of a second; what it cut, and what was left at the end.
private func cut(_ samples: [Float]) -> [PhraseCutter.Phrase] {
    var cutter = PhraseCutter()
    var phrases: [PhraseCutter.Phrase] = []
    stride(from: 0, to: samples.count, by: 1_600).forEach { phrases += cutter.take(Array(samples[$0..<min($0 + 1_600, samples.count)])) }
    if let last = cutter.flush() { phrases.append(last) }
    return phrases
}

@Test func minutesOfThinkingGiveWhisperNothingToWrite() {
    // Two sentences, three minutes apart.
    let phrases = cut(quiet(1) + speech(3) + quiet(180) + speech(2.5) + quiet(2))
    #expect(phrases.count == 2)
    #expect(abs(phrases[0].start - 0.7) < 0.1)
    #expect(abs(phrases[1].start - 183.7) < 0.1)
    // Each is its speech and a moment either side, not the pause.
    #expect(phrases[0].seconds < 3.8)
    #expect(phrases[1].seconds < 3.3)
}

/// A café or a fan: loud, steady noise (about -34 dBFS), with speech well over it.
private func noisy(_ seconds: Double) -> [Float] {
    var seed: UInt32 = 11
    return (0..<Int(seconds * 16_000)).map { _ in
        seed = seed &* 1_664_525 &+ 1_013_904_223
        return (Float(seed >> 8) / Float(1 << 24) - 0.5) * 0.07
    }
}

@Test func aNoisyRoomIsntSpeech() {
    let room = noisy(36)
    var clip = room
    // Two sentences over it, 30 s apart.
    for (at, speech) in [(1.0, speech(2)), (33.0, speech(2))] {
        let start = Int(at * 16_000)
        for (index, sample) in speech.enumerated() { clip[start + index] += sample }
    }
    let phrases = cut(clip)
    #expect(phrases.count == 2)
    #expect(phrases.allSatisfy { $0.seconds < 3 })
}

@Test func aBreathMidSentenceDoesntCutItButAPauseDoes() {
    let phrases = cut(speech(1.5) + quiet(0.3) + speech(1.5) + quiet(1.2) + speech(1))
    #expect(phrases.count == 2)
    #expect(phrases[0].seconds > 3.2)
}

@Test func aClickIsntSpeech() {
    #expect(cut(quiet(1) + speech(0.06) + quiet(2)).isEmpty)
}

@Test func talkingWithoutAPauseIsCutBeforeWhispersWindowIsFull() {
    let phrases = cut(speech(40) + quiet(1))
    #expect(phrases.count == 2)
    #expect(phrases.allSatisfy { $0.seconds <= PhraseCutter.longest + 0.05 })
}

@Test func whatWhisperWritesForNoWordsIsDropped() {
    #expect(WhisperDictation.clean(" [BLANK_AUDIO] ").isEmpty)
    #expect(WhisperDictation.clean("(music)").isEmpty)
    #expect(WhisperDictation.clean(" Run npm test.") == "Run npm test.")
}

// MARK: The real model

// What you say, written by Whisper itself: a spoken clip (macOS's own voice) with a long pause in
// it, through the same phrases and prompt as the microphone's. Needs the model downloaded, in the
// folder `KUVO_TEST_WHISPER_MODEL` names, so it runs here, not on CI.
@Test(.enabled(if: ProcessInfo.processInfo.environment["KUVO_TEST_WHISPER_MODEL"] != nil))
func whisperWritesTheProjectsNamesAsTheyreWrittenAndNothingInThePause() async throws {
    let folder = URL(fileURLWithPath: ProcessInfo.processInfo.environment["KUVO_TEST_WHISPER_MODEL"]!)
    let scratch = FileManager.default.temporaryDirectory.appending(path: "kuvo-voice-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: scratch) }
    let first = try spoken("Open S R C slash timer dot T S, and run N P M test.", in: scratch)
    let second = try spoken("Then add a use effect hook that calls fetch user.", in: scratch)
    let clip = quiet(0.5) + first + quiet(60) + second + quiet(1.5)

    let heard = Mutex<[WhisperDictation.Heard]>([])
    let dictation = WhisperDictation(folder: folder, locale: Locale(identifier: "en_US"), words: {
        ["src/timer.ts", "npm test", "useEffect", "fetchUser", "startTimer", "ContentView.swift"]
    }) { one in heard.withLock { $0.append(one) } }
    try await dictation.prepare()
    let (stream, continuation) = AsyncStream<[Float]>.makeStream()
    stride(from: 0, to: clip.count, by: 1_600).forEach { continuation.yield(Array(clip[$0..<min($0 + 1_600, clip.count)])) }
    continuation.finish()
    await dictation.run(stream)

    var transcript = VoiceTranscript()
    let finals = heard.withLock { $0 }.compactMap { one -> (String, Double)? in
        if case .final(let text, let start) = one { return (text, start) } else { return nil }
    }
    finals.forEach { transcript.take($0.0, start: $0.1, isFinal: true) }
    #expect(finals.filter { !$0.0.isEmpty }.count == 2, "\(finals)")
    for name in ["src/timer.ts", "npm test", "useEffect", "fetchUser"] {
        #expect(transcript.text.contains(name), "\(transcript.text)")
    }
}

// Voice input as you'd use it, with a recording for the microphone: once Whisper is loaded it
// listens, each phrase is written after its pause while you go on, and Done writes the last one
// and puts it all in the message. (Once, nothing was written and Done stayed dimmed: Whisper
// loaded for minutes behind a listening line.) Needs the model, as above.
@MainActor
@Test(.enabled(if: ProcessInfo.processInfo.environment["KUVO_TEST_WHISPER_MODEL"] != nil))
func eachPhraseIsWrittenAfterItsPauseAndDonePutsInTheLast() async throws {
    let folder = URL(fileURLWithPath: ProcessInfo.processInfo.environment["KUVO_TEST_WHISPER_MODEL"]!)
    let scratch = FileManager.default.temporaryDirectory.appending(path: "kuvo-voice-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: scratch) }
    // A clone of the model in the test's own folder (instant, and no room taken), made ready for
    // this system: the model's own folder is never touched.
    let speech = scratch.appending(path: "Speech")
    try FileManager.default.createDirectory(at: speech, withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: folder, to: speech.appending(path: folder.lastPathComponent))
    try Data(SpeechModel.system.utf8).write(to: speech.appending(path: folder.lastPathComponent).appending(path: SpeechModel.preparedMark))
    let model = SpeechModel(defaults: MemoryDefaults.make(), compiled: [])
    model.use(folder: speech)
    try #require(model.listensWithWhisper)
    let voice = VoiceInput(model: model)
    var told: [String] = []
    voice.ended = { told.append($0) }
    let (clip, feed) = AsyncStream<[Float]>.makeStream()
    voice.start(locale: Locale(identifier: "en_US"), words: { ["src/timer.ts", "npm test", "useEffect", "fetchUser"] }, clip: clip)
    while voice.phase != .listening {
        if case .failed(let failure) = voice.phase { Issue.record("\(failure.message)"); return }
        await Task.yield()
    }
    // A phrase, then a pause: it's written while you go on.
    let first = try spoken("Open S R C slash timer dot T S.", in: scratch) + quiet(1.5)
    stride(from: 0, to: first.count, by: 1_600).forEach { feed.yield(Array(first[$0..<min($0 + 1_600, first.count)])) }
    while voice.transcript.confirmed.isEmpty { await Task.yield() }
    #expect(voice.transcript.confirmed.contains("src/timer.ts"), "\(voice.transcript.text)")
    // Another, and Done straight after it.
    let second = try spoken("Then add a use effect hook that calls fetch user.", in: scratch)
    stride(from: 0, to: second.count, by: 1_600).forEach { feed.yield(Array(second[$0..<min($0 + 1_600, second.count)])) }
    voice.finish()
    // The microphone stops: what it heard is all there is.
    feed.finish()
    while voice.phase != .idle { await Task.yield() }
    #expect(told.count == 1)
    for name in ["src/timer.ts", "useEffect", "fetchUser"] {
        #expect(told.first?.contains(name) == true, "\(told)")
    }
}

// Whisper loads before anything listens (once, a listening line ran for minutes with nothing
// written while it loaded, and Done waited on it): Done while it loads ends at once, with
// nothing heard. A model that can't load says so, plainly, and Done and Cancel still close it.
@MainActor
@Test func doneWhileWhisperLoadsEndsAtOnceAndAModelThatWontLoadSaysSo() async throws {
    let rig = Rig()
    defer { rig.done() }
    // Downloaded and made ready, as far as it knows: its files aren't Whisper's.
    let model = rig.model()
    model.isOn = true
    #expect(await settled(model) == .ready)
    let voice = VoiceInput(model: model)
    var told: [String] = []
    voice.ended = { told.append($0) }
    let (clip, feed) = AsyncStream<[Float]>.makeStream()
    defer { feed.finish() }
    voice.start(clip: clip)
    #expect(voice.phase == .preparing(progress: nil))
    voice.finish()
    #expect(voice.phase == .idle)
    #expect(told == [""])
    // Left to load, it can't; and while it tries, nothing seems to listen.
    voice.start(clip: clip)
    var listened = false
    while voice.isActive {
        if voice.phase == .listening { listened = true }
        await Task.yield()
    }
    #expect(!listened)
    guard case .failed(let failure) = voice.phase else { Issue.record("not failed: \(voice.phase)"); return }
    #expect(failure.message.hasPrefix("Whisper couldn’t load"))
    #expect(!voice.keepsWords)
    voice.finish()
    #expect(voice.phase == .idle)
    #expect(told == ["", ""])
}

// A start that never listened (the microphone not allowed or not coming on, a model that wouldn't
// get ready) never says voice input stopped, which it hadn't started (#522): the voice field's
// heading said "Voice input stopped" over a model that wouldn't load.
@MainActor
@Test func aStartThatNeverListenedSaysItCouldntStartNotThatItStopped() async throws {
    let rig = Rig()
    defer { rig.done() }
    // Downloaded and made ready, as far as it knows: its files aren't Whisper's.
    let model = rig.model()
    model.isOn = true
    #expect(await settled(model) == .ready)
    let voice = VoiceInput(model: model)
    let (clip, feed) = AsyncStream<[Float]>.makeStream()
    defer { feed.finish() }
    voice.start(clip: clip)
    #expect(voice.status == "Getting voice ready…")
    while voice.isActive { await Task.yield() }
    guard case .failed(let failure) = voice.phase else { Issue.record("not failed: \(voice.phase)"); return }
    #expect(!voice.listened)
    #expect(voice.status == "Voice input couldn’t start")
    #expect(!voice.status.contains("stopped") && !failure.message.contains("stopped"))
    // One that listened, then failed, did stop.
    voice.showSample(confirmed: "", guess: "")
    #expect(voice.listened)
    #expect(voice.status == "Listening")
    voice.fail(VoiceInput.stopped(wroteSome: false), run: voice.run)
    #expect(voice.status == "Voice input stopped")
    // A new start forgets the one before listened.
    voice.cancel()
    voice.start(clip: clip)
    #expect(!voice.listened)
    while voice.isActive { await Task.yield() }
    #expect(voice.status == "Voice input couldn’t start")
}

/// `words`, said by macOS's own voice, as 16 kHz samples.
private func spoken(_ words: String, in folder: URL) throws -> [Float] {
    let file = folder.appending(path: "\(UUID().uuidString).wav")
    let say = Process()
    say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    say.arguments = ["-v", "Samantha", "-o", file.path, "--data-format=LEF32@16000", words]
    try say.run()
    say.waitUntilExit()
    let audio = try AVAudioFile(forReading: file)
    let buffer = AVAudioPCMBuffer(pcmFormat: audio.processingFormat, frameCapacity: AVAudioFrameCount(audio.length))!
    try audio.read(into: buffer)
    return Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
}

// MARK: Downloading it

/// The network, as Hugging Face would answer: each file's bytes, from a range when it's asked
/// for one. Each test has a host of its own.
final class StubHub: URLProtocol, @unchecked Sendable {
    struct Host: Sendable {
        var files: [String: Data] = [:]
        var requests: [(path: String, range: String?)] = []
    }
    static let hosts = Mutex<[String: Host]>([:])

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".stub") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!, range = request.value(forHTTPHeaderField: "Range")
        let data = Self.hosts.withLock { hosts -> Data? in
            hosts[url.host!]?.requests.append((url.path, range))
            return hosts[url.host!]?.files[url.path]
        }
        guard let data else {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 404, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            return client!.urlProtocolDidFinishLoading(self)
        }
        let from = range.flatMap { Int($0.dropFirst("bytes=".count).dropLast()) } ?? 0
        // Past its end, as Hugging Face answers.
        guard from < data.count else {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 416, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            return client!.urlProtocolDidFinishLoading(self)
        }
        let response = HTTPURLResponse(url: url, statusCode: from > 0 ? 206 : 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data.subdata(in: from..<data.count))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Settings kept in memory. A named `UserDefaults` suite leaves a plist in ~/Library/Preferences that
/// no call removes while the process runs (the system writes it again), one for every test run.
private final class MemoryDefaults: UserDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Any] = [:]

    override init?(suiteName: String?) { super.init(suiteName: suiteName) }
    static func make() -> MemoryDefaults { MemoryDefaults(suiteName: nil)! }

    private func get(_ key: String) -> Any? { lock.withLock { values[key] } }
    private func put(_ key: String, _ value: Any?) { lock.withLock { values[key] = value } }

    override func object(forKey key: String) -> Any? { get(key) }
    override func set(_ value: Any?, forKey key: String) { put(key, value) }
    override func set(_ value: Bool, forKey key: String) { put(key, value) }
    override func removeObject(forKey key: String) { put(key, nil) }
    override func bool(forKey key: String) -> Bool { get(key) as? Bool ?? false }
    override func string(forKey key: String) -> String? { get(key) as? String }
}

/// A model of a few small files, served by its own stub host, kept in a folder of its own.
@MainActor
private final class Rig {
    let host = "hub-\(UUID().uuidString.prefix(8)).stub"
    let folder = FileManager.default.temporaryDirectory.appending(path: "kuvo-speech-\(UUID().uuidString)")
    let contents: [String: Data] = [
        "Encoder.mlmodelc/weights/weight.bin": Data((0..<300_000).map { UInt8($0 % 251) }),
        "Encoder.mlmodelc/model.mil": Data("program".utf8),
        "tokenizer.json": Data(#"{"model":{}}"#.utf8),
    ]
    nonisolated let prepared = Mutex<[URL]>([])
    /// How much room the disk has.
    nonisolated let free = Mutex<Int64>(10_000_000_000)
    /// Where Core ML would keep its copy made ready for the chip.
    var compiled: URL { folder.appending(path: "compiled") }
    /// How large a copy Core ML keeps when it's made ready (nil: kept where the app can't see).
    nonisolated let keeps = Mutex<Int64?>(nil)
    let defaults: UserDefaults = MemoryDefaults.make()

    init() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let host = host, contents = contents
        StubHub.hosts.withLock { $0[host] = .init(files: Dictionary(uniqueKeysWithValues: contents.map { ("/m/\($0.key)", $0.value) })) }
    }

    var files: [SpeechModel.File] {
        contents.keys.sorted().map { path in
            let data = contents[path]!
            return SpeechModel.File(path, Int64(data.count), SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), from: URL(string: "https://\(host)/m/\(path)")!)
        }
    }

    func model(free: Int64? = nil) -> SpeechModel {
        if let free { self.free.withLock { $0 = free } }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubHub.self]
        let model = SpeechModel(files: files, defaults: defaults, session: configuration, supported: true, freeSpace: { [self] _ in self.free.withLock { $0 } },
                                prepare: { [self, compiled] folder in
                                    prepared.withLock { $0.append(folder) }
                                    // As Core ML would: its copy, without taking the room (a sparse file).
                                    guard let size = keeps.withLock({ $0 }) else { return }
                                    let copy = compiled.appending(path: "26A434/encoder.bundle")
                                    try FileManager.default.createDirectory(at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
                                    FileManager.default.createFile(atPath: copy.path, contents: nil)
                                    let handle = try FileHandle(forWritingTo: copy)
                                    try handle.truncate(atOffset: UInt64(size))
                                    try handle.close()
                                }, compiled: [compiled])
        model.use(folder: folder)
        return model
    }

    var requests: [(path: String, range: String?)] { StubHub.hosts.withLock { $0[host]?.requests ?? [] } }
    func serve(_ path: String, _ data: Data) { StubHub.hosts.withLock { $0[host]?.files["/m/\(path)"] = data } }

    func done() {
        try? FileManager.default.removeItem(at: folder)
        StubHub.hosts.withLock { $0[host] = nil }
    }
}

/// Waits for `model` to settle somewhere other than downloading or preparing.
@MainActor
private func settled(_ model: SpeechModel) async -> SpeechModel.State {
    while model.state == .downloading || model.state == .preparing { await Task.yield() }
    return model.state
}

// Apple's dictation is voice input until you turn more accurate voice input on: pressing the
// mic downloads nothing, and nothing comes from the network.
@MainActor
@Test func voiceInputListensWithDictationAndDownloadsNothingUntilWhisperIsTurnedOn() async throws {
    let rig = Rig()
    defer { rig.done() }
    let model = rig.model()
    #expect(model.state == .absent)
    #expect(!model.isOn)
    #expect(!model.listensWithWhisper)
    #expect(!model.isUnderway)
    #expect(model.progressWords == nil)
    #expect(rig.model().state == .absent)
    #expect(rig.requests.isEmpty)
}

// Turned on, it comes while Apple's dictation goes on listening, and voice input uses it from
// the time it's ready; turned off, dictation again, with what came kept until Remove.
@MainActor
@Test func turnedOnWhisperTakesOverOnceReadyAndTurnedOffDictationIsBack() async throws {
    let rig = Rig()
    defer { rig.done() }
    let model = rig.model()
    model.isOn = true
    #expect(model.state == .downloading)
    #expect(!model.listensWithWhisper)
    #expect(model.isUnderway)
    #expect(model.progressWords?.hasPrefix("More accurate voice input: downloading") == true)
    #expect(await settled(model) == .ready)
    #expect(model.listensWithWhisper)
    #expect(model.progressWords == nil)
    // In its folder, checked, made ready once; nothing left half-done.
    let kept = rig.folder.appending(path: "whisper-large-v3-turbo")
    #expect(FileManager.default.contents(atPath: kept.appending(path: "tokenizer.json").path) == rig.contents["tokenizer.json"])
    #expect(!FileManager.default.fileExists(atPath: rig.folder.appending(path: "partial").path))
    #expect(rig.prepared.withLock { $0 }.map(\.path) == [kept.path])
    // Opened again later, it's there and on, without downloading.
    let again = rig.model()
    #expect(again.listensWithWhisper)
    #expect(rig.requests.count == rig.contents.count)
    // Off: dictation again, and the download stays until it's removed.
    again.isOn = false
    #expect(!again.listensWithWhisper)
    #expect(FileManager.default.fileExists(atPath: kept.path))
    #expect(again.status(device: "Mac").hasPrefix("Off · "))
    // On again: at once, nothing downloaded.
    again.isOn = true
    #expect(again.listensWithWhisper)
    #expect(rig.requests.count == rig.contents.count)
}

// Downloaded before it was a setting, it stays on.
@MainActor
@Test func aModelDownloadedBeforeItWasASettingStaysOn() async throws {
    let rig = Rig()
    defer { rig.done() }
    let first = rig.model()
    first.isOn = true
    #expect(await settled(first) == .ready)
    rig.defaults.removeObject(forKey: "voice.whisper.on")
    #expect(rig.model().listensWithWhisper)
}

// After the first dictation, never before it, the tip that voice input can be more accurate
// shows once; not while it's on, nor on a device that can't run it.
@MainActor
@Test func theTipAboutMoreAccurateVoiceInputShowsOnceAfterTheFirstDictation() async throws {
    let rig = Rig()
    defer { rig.done() }
    let model = rig.model()
    #expect(VoiceTip.takeTurn(model: model, defaults: rig.defaults))
    #expect(!VoiceTip.takeTurn(model: model, defaults: rig.defaults))
    // Turned on before the first dictation: no tip.
    let other = Rig()
    defer { other.done() }
    let on = other.model()
    on.isOn = true
    #expect(!VoiceTip.takeTurn(model: on, defaults: other.defaults))
    // A device that can't run it: none.
    let old = Rig()
    defer { old.done() }
    let unsupported = SpeechModel(files: old.files, defaults: old.defaults, supported: false)
    unsupported.use(folder: old.folder)
    #expect(!VoiceTip.takeTurn(model: unsupported, defaults: old.defaults))
    #expect(VoiceTip.line(device: "Mac") == "Uses a more capable model that runs on this Mac.")
}

// An iPhone too old for Whisper keeps voice input, with Apple's dictation, and never downloads a
// model it can't run.
@MainActor
@Test func aDeviceThatCantRunWhisperListensWithoutDownloadingIt() async throws {
    let rig = Rig()
    defer { rig.done() }
    let model = SpeechModel(files: rig.files, defaults: rig.defaults, supported: false)
    model.use(folder: rig.folder)
    #expect(model.state == .unsupported)
    model.isOn = true
    #expect(model.state == .unsupported)
    #expect(!model.listensWithWhisper)
    #expect(rig.requests.isEmpty)
}

// Made ready once, voice input opens within seconds after that; a system update needs it made
// ready again, which happens in the background as the app opens, not once you press the mic.
// Without room for the copy made ready for the chip, Core ML couldn't keep it and every load would
// take minutes: it says how much it needs instead, and goes on once there's room.
@MainActor
@Test func aSystemUpdateMakesItReadyAgainInTheBackgroundIfThereIsRoom() async throws {
    let rig = Rig()
    defer { rig.done() }
    let model = rig.model()
    model.isOn = true
    #expect(await settled(model) == .ready)
    #expect(rig.model().state == .ready)
    #expect(rig.prepared.withLock { $0.count } == 1)
    // Made ready for an older system.
    let mark = rig.folder.appending(path: "whisper-large-v3-turbo").appending(path: ".prepared")
    try Data("Version 26.0 (Build 25A1)".utf8).write(to: mark)
    rig.free.withLock { $0 = 1_000_000_000 }
    let updated = rig.model()
    guard case .lowSpace(let free) = updated.state else { Issue.record("not low on space: \(updated.state)"); return }
    #expect(free == 1_000_000_000)
    #expect(updated.status(device: "Mac").contains("GB free"))
    #expect(!updated.listensWithWhisper)
    // Room made: Try Again makes it ready, without downloading anything again.
    rig.free.withLock { $0 = 10_000_000_000 }
    let before = rig.requests.count
    updated.download()
    #expect(await settled(updated) == .ready)
    #expect(rig.prepared.withLock { $0.count } == 2)
    #expect(rig.requests.count == before)
    #expect(rig.model().state == .ready)
}

// Core ML's copy for the chip is what makes loading take seconds: the system may clear it, and
// then it's made ready again in the background; a copy Core ML couldn't keep (no room) is said
// as such, rather than every press taking minutes.
@MainActor
@Test func aCopyForTheChipThatsGoneIsMadeAgainAndOneThatWasntKeptSaysWhatItNeeds() async throws {
    let rig = Rig()
    defer { rig.done() }
    rig.keeps.withLock { $0 = 600_000_000 }
    let model = rig.model()
    model.isOn = true
    #expect(await settled(model) == .ready)
    #expect(model.status(device: "Mac").hasPrefix("In use · about"))
    // The system cleared caches: made ready again as the app opens.
    try FileManager.default.removeItem(at: rig.compiled)
    let reopened = rig.model()
    #expect(reopened.state == .preparing)
    #expect(await settled(reopened) == .ready)
    #expect(rig.prepared.withLock { $0.count } == 2)
    // Core ML ran out of room for it: not ready, and it says so.
    rig.keeps.withLock { $0 = 1_000 }
    try FileManager.default.removeItem(at: rig.compiled)
    let full = rig.model()
    guard case .lowSpace = await settled(full) else { Issue.record("not low on space: \(full.state)"); return }
    #expect(full.status(device: "Mac").hasPrefix("Needs "))
    #expect(!full.listensWithWhisper)
}

// Made ready before this version kept the size of Core ML's copy: with that copy still here,
// it's made ready again in seconds, even without room for a new one.
@MainActor
@Test func aCopyMadeReadyBeforeIsUsedWithoutAskingForRoomAgain() async throws {
    let rig = Rig()
    defer { rig.done() }
    rig.keeps.withLock { $0 = 3_100_000_000 }
    let model = rig.model()
    model.isOn = true
    #expect(await settled(model) == .ready)
    let mark = rig.folder.appending(path: "whisper-large-v3-turbo").appending(path: ".prepared")
    try Data().write(to: mark)
    rig.free.withLock { $0 = 1_000_000_000 }
    let updated = rig.model()
    #expect(updated.state == .preparing)
    #expect(await settled(updated) == .ready)
    #expect(updated.wasPrepared)
}

@MainActor
@Test func aDownloadThatStoppedGoesOnFromWhereItWas() async throws {
    let rig = Rig()
    defer { rig.done() }
    // Half the weights came before the app quit.
    let path = "Encoder.mlmodelc/weights/weight.bin", whole = rig.contents[path]!
    let partial = rig.folder.appending(path: "partial").appending(path: path)
    try FileManager.default.createDirectory(at: partial.deletingLastPathComponent(), withIntermediateDirectories: true)
    try whole.prefix(120_000).write(to: partial)
    rig.defaults.set(true, forKey: "voice.whisper.on")
    let model = rig.model()
    // On, and not paused by you: it goes on by itself as the app opens.
    #expect(model.state == .downloading)
    #expect(model.isUnderway)
    #expect(await settled(model) == .ready)
    #expect(rig.requests.first { $0.path.hasSuffix("weight.bin") }?.range == "bytes=120000-")
    #expect(FileManager.default.contents(atPath: rig.folder.appending(path: "whisper-large-v3-turbo").appending(path: path).path) == whole)
}

@MainActor
@Test func aFileThatDoesntMatchIsNeverUsedAndTryAgainFetchesIt() async throws {
    let rig = Rig()
    defer { rig.done() }
    rig.serve("tokenizer.json", Data(#"{"model":[]}"#.utf8))
    let model = rig.model()
    model.isOn = true
    guard case .failed(let words) = await settled(model) else { Issue.record("not failed: \(model.state)"); return }
    #expect(words.contains("didn’t match"))
    #expect(rig.prepared.withLock { $0 }.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: rig.folder.appending(path: "whisper-large-v3-turbo").appending(path: "tokenizer.json").path))
    // Fixed on the server: Try Again fetches only what's missing.
    rig.serve("tokenizer.json", rig.contents["tokenizer.json"]!)
    let before = rig.requests.count
    model.download()
    #expect(await settled(model) == .ready)
    #expect(rig.requests.dropFirst(before).map(\.path) == ["/m/tokenizer.json"])
}

@MainActor
@Test func withoutRoomForItNothingDownloadsAndItSaysHowMuchIsFree() async throws {
    let rig = Rig()
    defer { rig.done() }
    let model = rig.model(free: 40_000_000)
    model.isOn = true
    #expect(model.state == .lowSpace(free: 40_000_000))
    #expect(model.status(device: "Mac").hasSuffix("40 MB free"))
    #expect(rig.requests.isEmpty)
}

@MainActor
@Test func removedItsGoneAndDictationListensAgain() async throws {
    let rig = Rig()
    defer { rig.done() }
    let model = rig.model()
    model.isOn = true
    #expect(await settled(model) == .ready)
    try FileManager.default.createDirectory(at: rig.compiled.appending(path: "encoder.bundle"), withIntermediateDirectories: true)
    model.remove()
    #expect(model.state == .absent)
    #expect(model.received == 0)
    #expect(!FileManager.default.fileExists(atPath: rig.folder.appending(path: "whisper-large-v3-turbo").path))
    // The copy made ready for the chip goes too, once Whisper is let go: it's larger than the model.
    while FileManager.default.fileExists(atPath: rig.compiled.path) { await Task.yield() }
    // It stays gone and off: Apple's dictation listens, and turning it on brings it back.
    #expect(rig.model().state == .absent)
    #expect(!model.isOn)
    #expect(!model.listensWithWhisper)
    model.isOn = true
    #expect(await settled(model) == .ready)
}

@MainActor
@Test func pausedByYouItWaitsForYouEvenAfterARestart() async throws {
    let rig = Rig()
    defer { rig.done() }
    let model = rig.model()
    model.isOn = true
    model.pause()
    #expect(model.state == .paused)
    #expect(!model.isUnderway)
    let reopened = rig.model()
    #expect(reopened.isPausedByYou)
    #expect(!reopened.isUnderway)
    // Resume, in Settings: it goes on.
    reopened.download()
    let end = await settled(reopened)
    #expect(end == .ready)
}

@MainActor
@Test func aFileThatCameWholeButWasntCheckedIsCheckedNotFetchedAgain() async throws {
    let rig = Rig()
    defer { rig.done() }
    // The app quit while the weights were being checked.
    let path = "Encoder.mlmodelc/weights/weight.bin"
    let partial = rig.folder.appending(path: "partial").appending(path: path)
    try FileManager.default.createDirectory(at: partial.deletingLastPathComponent(), withIntermediateDirectories: true)
    try rig.contents[path]!.write(to: partial)
    rig.defaults.set(true, forKey: "voice.whisper.on")
    let model = rig.model()
    #expect(await settled(model) == .ready)
    #expect(!rig.requests.contains { $0.path.hasSuffix("weight.bin") })
}

// MARK: The project's names

@Test func theProjectsNamesComeOutAsTheyreWritten() {
    let names = ProjectNames(["fetchUser", "ContentView.swift", "useEffect", "README", "npm test", "Codex", "test", "docs"])
    // Said apart, run together, or in the wrong case (as Apple's dictation and Whisper wrote them).
    #expect(names.fix("Add a use effect hook that calls fetch user.") == "Add a useEffect hook that calls fetchUser.")
    #expect(names.fix("then callsFetchUser") == "then calls fetchUser")
    #expect(names.fix("Open content view.swift, and the readme") == "Open ContentView.swift, and the README")
    // Other words stay as they were said: a plain name in a sentence's case, and words that only
    // sound like a name.
    #expect(names.fix("Test it, then fetch the user.") == "Test it, then fetch the user.")
    #expect(names.fix("Run npm test") == "Run npm test")
}
