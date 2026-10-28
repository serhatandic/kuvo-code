import CryptoKit
import Foundation
import Network
import Observation

/// Whisper, the speech model voice input uses once it's on this device: it downloads the first
/// time you talk (or when you choose it in Settings), and until it's in, voice input goes on with
/// Apple's dictation. Kept in a folder of the app's own; Remove takes it all away, and it doesn't
/// come back by itself after that.
@MainActor
@Observable
public final class SpeechModel {
    public enum State: Equatable, Sendable {
        /// Not on this device.
        case absent
        case downloading
        /// Stopped until the network lets it go on: Wi-Fi (the phone, with cellular not allowed) or any.
        case waiting(Wait)
        case paused
        /// The phone is on cellular, and you haven't said whether to download over it.
        case askingCellular
        /// Not enough room for it: how much is free.
        case lowSpace(free: Int64)
        case failed(String)
        /// Downloaded, and made ready for this device's chip (once, the first time).
        case preparing
        case ready
        /// This device can't run it (an older iPhone): Apple's dictation it is.
        case unsupported
    }

    public enum Wait: Equatable, Sendable { case wifi, network }

    /// Whether the phone may download it over cellular: asked once, then kept.
    public enum Cellular: String, Sendable { case ask, allowed, wifiOnly }

    /// The one on this device, which each app points at its folder as it starts (`use(folder:)`).
    public static let shared = SpeechModel()

    public private(set) var state: State = .absent
    /// How much of it is here.
    public private(set) var received: Int64 = 0
    /// It came while the app was open, for a word once that voice input is on it now.
    public private(set) var isNewlyReady = false

    public var fraction: Double { Double(received) / Double(size) }
    /// Its whole size.
    public var size: Int64 { files.reduce(0) { $0 + $1.size } }
    public var isReady: Bool { state == .ready }
    /// It's coming (or was, and will go on): the ring on the mic shows it.
    public var isUnderway: Bool {
        switch state {
        case .downloading, .waiting, .paused, .preparing, .askingCellular: true
        default: false
        }
    }

    public var cellular: Cellular {
        get { Cellular(rawValue: defaults.string(forKey: Self.cellularKey) ?? "") ?? .ask }
        set {
            defaults.set(newValue.rawValue, forKey: Self.cellularKey)
            if state == .askingCellular { download() }
        }
    }

    /// Where it's kept: `<folder>/whisper-large-v3-turbo`, and the file still coming in `<folder>/partial`.
    public private(set) var folder: URL?
    public var modelFolder: URL? { folder?.appending(path: Self.name, directoryHint: .isDirectory) }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var fetch: Fetch?
    @ObservationIgnored private var work: Task<Void, Never>?
    @ObservationIgnored private let path = NWPathMonitor()
    @ObservationIgnored private var lastPath: (satisfied: Bool, expensive: Bool) = (true, false)
    @ObservationIgnored let session: URLSessionConfiguration
    @ObservationIgnored let freeSpace: (URL) -> Int64?
    @ObservationIgnored let prepare: @Sendable (URL) async throws -> Void
    @ObservationIgnored private let supported: Bool
    @ObservationIgnored let files: [File]

    private static let cellularKey = "voice.whisper.cellular"
    private static let removedKey = "voice.whisper.removed"
    static let name = "whisper-large-v3-turbo"
    /// In the model's folder once it's been made ready.
    static let preparedMark = ".prepared"

    init(files: [File] = SpeechModel.whisper, defaults: UserDefaults = .standard, session: URLSessionConfiguration = .default, supported: Bool = WhisperRuntime.isSupported,
         freeSpace: @escaping (URL) -> Int64? = SpeechModel.volumeFree, prepare: @escaping @Sendable (URL) async throws -> Void = { try await WhisperRuntime.shared.prepare($0) }) {
        self.files = files
        self.defaults = defaults
        self.session = session
        self.supported = supported
        self.freeSpace = freeSpace
        self.prepare = prepare
        path.pathUpdateHandler = { [weak self] path in
            let now = (path.status == .satisfied, path.isExpensive)
            Task { @MainActor in self?.pathChanged(satisfied: now.0, expensive: now.1) }
        }
        path.start(queue: .global(qos: .utility))
    }

    /// Keeps it in `folder` (made if it isn't there), and says what's there already.
    public func use(folder: URL) {
        guard self.folder != folder else { return }
        cancelFetch()
        self.folder = folder
        #if os(iOS)
        // It can always be downloaded again, so it stays out of the phone's backups.
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = folder
        try? excluded.setResourceValues(values)
        #endif
        guard supported else { return state = .unsupported }
        if isComplete {
            received = size
            if FileManager.default.fileExists(atPath: folder.appending(path: Self.name).appending(path: Self.preparedMark).path) {
                state = .ready
            } else {
                // Downloaded, but the app closed before it was made ready.
                makeReady()
            }
        } else {
            received = presentBytes
            state = received > 0 ? .paused : .absent
        }
    }

    /// Voice input started: it comes now, unless it's here, on its way, or was removed.
    public func voiceStarted() {
        switch state {
        case .absent where !defaults.bool(forKey: Self.removedKey): download()
        case .failed, .lowSpace: download()
        default: break
        }
    }

    /// Download it, or go on with it from where it stopped.
    public func download() {
        guard let folder, supported else { return }
        defaults.set(false, forKey: Self.removedKey)
        guard state != .ready, state != .preparing else { return }
        cancelFetch()
        if isComplete { return makeReady() }
        #if os(iOS)
        if lastPath.expensive, cellular == .ask { return state = .askingCellular }
        #endif
        let have = presentBytes
        received = have
        // Room for what's still to come, and a little over.
        if let free = freeSpace(folder.deletingLastPathComponent()), free < size - have + 50_000_000 {
            return state = .lowSpace(free: free)
        }
        state = .downloading
        let configuration = session
        #if os(iOS)
        configuration.allowsExpensiveNetworkAccess = cellular == .allowed
        #endif
        let fetch = Fetch(configuration: configuration)
        self.fetch = fetch
        work = Task { [weak self] in await self?.run(fetch) }
    }

    /// Stops for now, keeping what's come; `download` goes on from there.
    public func pause() {
        guard state == .downloading || state == .waiting(.wifi) || state == .waiting(.network) || state == .askingCellular else { return }
        cancelFetch()
        received = presentBytes
        state = .paused
    }

    /// Takes it off this device. Voice input goes back to Apple's dictation, and it doesn't come
    /// back unless you download it again.
    public func remove() {
        cancelFetch()
        if let folder {
            try? FileManager.default.removeItem(at: folder.appending(path: Self.name))
            try? FileManager.default.removeItem(at: folder.appending(path: "partial"))
        }
        Task { await WhisperRuntime.shared.unload() }
        defaults.set(true, forKey: Self.removedKey)
        received = 0
        isNewlyReady = false
        state = supported ? .absent : .unsupported
    }

    /// Its word that it's ready was shown.
    public func sawReady() { isNewlyReady = false }

    #if DEBUG
    /// As if it were `named` ("downloading", "paused", "waiting", "failed", "space", "preparing",
    /// "ready"), without the network: for a demo copy's screenshots.
    public func showSample(_ named: String) {
        cancelFetch()
        received = named == "ready" || named == "preparing" ? size : size * 42 / 100
        isNewlyReady = named == "ready"
        state = switch named {
        case "downloading": .downloading
        case "paused": .paused
        case "waiting": .waiting(.wifi)
        case "failed": .failed("Couldn’t finish downloading. Try again when you’re online.")
        case "space": .lowSpace(free: 410_000_000)
        case "preparing": .preparing
        case "ready": .ready
        default: .absent
        }
    }
    #endif

    // MARK: Downloading

    private func run(_ fetch: Fetch) async {
        guard let folder else { return }
        let partial = folder.appending(path: "partial", directoryHint: .isDirectory)
        let done = folder.appending(path: Self.name, directoryHint: .isDirectory)
        do {
            // Each file into `partial`, then, once its hash is checked, into the model's folder.
            for file in files where Self.size(of: done.appending(path: file.path)) != file.size {
                let target = partial.appending(path: file.path)
                try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                let before = presentBytes - min(Self.size(of: target) ?? 0, file.size)
                try await fetch.get(file.url, to: target, expected: file.size) { [weak self] bytes, isWaiting in
                    Task { @MainActor in
                        guard let self, self.fetch === fetch else { return }
                        self.received = before + bytes
                        self.state = isWaiting ? .waiting(self.lastPath.satisfied && self.lastPath.expensive ? .wifi : .network) : .downloading
                    }
                }
                guard self.fetch === fetch else { return }
                guard try await Self.sha256(of: target) == file.sha256 else {
                    try? FileManager.default.removeItem(at: target)
                    throw Problem("A downloaded file didn’t match. Try again.")
                }
                let final = done.appending(path: file.path)
                try FileManager.default.createDirectory(at: final.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? FileManager.default.removeItem(at: final)
                try FileManager.default.moveItem(at: target, to: final)
            }
            guard self.fetch === fetch else { return }
            try? FileManager.default.removeItem(at: partial)
            self.fetch = nil
            received = size
            makeReady()
        } catch {
            guard self.fetch === fetch else { return }
            self.fetch = nil
            received = presentBytes
            state = .failed((error as? Problem)?.words ?? Self.describe(error))
        }
    }

    /// Made ready for this device's chip, the first time: then voice input uses it.
    private func makeReady() {
        guard let done = modelFolder else { return }
        state = .preparing
        let prepare = prepare
        work = Task { [weak self] in
            do {
                try await prepare(done)
                guard let self, self.state == .preparing else { return }
                FileManager.default.createFile(atPath: done.appending(path: Self.preparedMark).path, contents: nil)
                self.state = .ready
                self.isNewlyReady = true
            } catch {
                guard let self, self.state == .preparing else { return }
                self.state = .failed("Whisper couldn’t start on this device: \(error.localizedDescription)")
            }
        }
    }

    private func cancelFetch() {
        fetch?.cancel()
        fetch = nil
        work?.cancel()
        work = nil
    }

    private func pathChanged(satisfied: Bool, expensive: Bool) {
        lastPath = (satisfied, expensive)
        if case .waiting = state { state = .waiting(satisfied && expensive ? .wifi : .network) }
    }

    private var isComplete: Bool {
        guard let done = modelFolder else { return false }
        return files.allSatisfy { Self.size(of: done.appending(path: $0.path)) == $0.size }
    }

    /// What's come so far: the files that are in, and what's come of the next.
    private var presentBytes: Int64 {
        guard let folder else { return 0 }
        let partial = folder.appending(path: "partial"), done = folder.appending(path: Self.name)
        return files.reduce(0) { sum, file in
            sum + (Self.size(of: done.appending(path: file.path)) == file.size ? file.size : min(Self.size(of: partial.appending(path: file.path)) ?? 0, file.size))
        }
    }

    static func size(of url: URL) -> Int64? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int64
    }

    nonisolated static func volumeFree(_ url: URL) -> Int64? {
        #if os(iOS)
        try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage
        #else
        (try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage).flatMap { $0 > 0 ? $0 : nil }
            ?? (try? url.resourceValues(forKeys: [.volumeAvailableCapacityKey]).volumeAvailableCapacity).map(Int64.init)
        #endif
    }

    nonisolated static func sha256(of url: URL) async throws -> String {
        try await Task.detached(priority: .utility) {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var hash = SHA256()
            while let chunk = try handle.read(upToCount: 4 << 20), !chunk.isEmpty { hash.update(data: chunk) }
            return hash.finalize().map { String(format: "%02x", $0) }.joined()
        }.value
    }

    private static func describe(_ error: Error) -> String {
        if let error = error as? URLError {
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
                return "The download stopped: no connection. Try again when you’re online."
            default: break
            }
        }
        if (error as NSError).domain == NSCocoaErrorDomain, (error as NSError).code == NSFileWriteOutOfSpaceError {
            return "The download stopped: this device is out of space."
        }
        return "The download stopped: \(error.localizedDescription)"
    }

    struct Problem: Error { let words: String; init(_ words: String) { self.words = words } }

    // MARK: What it's made of

    /// One of its files, as Hugging Face has it at a fixed revision: where it goes, how big it is,
    /// and its SHA-256, checked once it's in.
    struct File: Sendable {
        let path: String
        let size: Int64
        let sha256: String
        let url: URL

        init(_ path: String, _ size: Int64, _ sha256: String, from url: URL? = nil) {
            self.path = path
            self.size = size
            self.sha256 = sha256
            self.url = url ?? (path.hasPrefix("tokenizer")
                ? URL(string: "https://huggingface.co/openai/whisper-large-v3/resolve/06f233fe06e710322aca913c1bc4249a0d71fce1/\(path)")!
                : URL(string: "https://huggingface.co/argmaxinc/whisperkit-coreml/resolve/0f63a7800b00dd0226abd051b906c246e1907482/openai_whisper-large-v3-v20240930_turbo_632MB/\(path)")!)
        }
    }

    /// Whisper large-v3-turbo as Argmax built it for Core ML (MIT), and OpenAI's tokenizer for it.
    static let whisper: [File] = [
        File("AudioEncoder.mlmodelc/analytics/coremldata.bin", 243, "0dd9f529c744ed3c6be67f699588f7aadc4f366b5b7301dc31bd3f199944fbcc"),
        File("AudioEncoder.mlmodelc/coremldata.bin", 348, "ffa9eb76e8e9d9be75a4d527e5249e61d67fd43081c5aa110fd24efa6c8c5ea3"),
        File("AudioEncoder.mlmodelc/metadata.json", 1974, "2cd0538f90a012de3f07d38669026d527490eff1dcfd2479a81c48206a90f0a2"),
        File("AudioEncoder.mlmodelc/model.mil", 7589739, "ef5a252831e61bb91d6547fe1add3d0658895b518d47d70004322b40a2192668"),
        File("AudioEncoder.mlmodelc/weights/weight.bin", 421968768, "e4740fa28ed65907af754af893dfce98473fafb84dd8d718ad346985fe7678c1"),
        File("MelSpectrogram.mlmodelc/analytics/coremldata.bin", 243, "c5be419f8622083ac7046306400643539f0e7577c843448c36defc090d41e7ce"),
        File("MelSpectrogram.mlmodelc/coremldata.bin", 329, "98efa1e351b759e078c4044668926d32bee886caf7596ae897e08e21da45565a"),
        File("MelSpectrogram.mlmodelc/metadata.json", 1850, "2bc552e09a6f124d9e6c178dd1a6979e010206acb26308b2224887c9dcbeb35f"),
        File("MelSpectrogram.mlmodelc/model.mil", 10143, "c270b95b5f81d7f7d0b8a3e8f991d4e5812a37cad29349868a35b91f3a6a4463"),
        File("MelSpectrogram.mlmodelc/weights/weight.bin", 373376, "009d9fb8f6b589accfa08cebf1c712ef07c3405229ce3cfb3a57ee033c9d8a49"),
        File("TextDecoder.mlmodelc/analytics/coremldata.bin", 243, "4b5119bdc621c3c494f63846dc3ed43852e88826fc3b6345d42272d4b7e67724"),
        File("TextDecoder.mlmodelc/coremldata.bin", 633, "605dad4099a82cf2c7afe93e6d8e322f1c16d4160ab27bd017ec2517b81c1bdd"),
        File("TextDecoder.mlmodelc/metadata.json", 4924, "e3ce6d83884552ffcc2c34799e8e1211dcda59f1aaea5a79bf988c6cd16abbf0"),
        File("TextDecoder.mlmodelc/model.mil", 217177, "ebaf8566f367b6465276c3ed57bb99063888fa955b67828585bf19db24c85f56"),
        File("TextDecoder.mlmodelc/weights/weight.bin", 203199860, "d69700903d518ada33170ab77faaaf464496fb9ff65752c6d5a6109aa2fb02db"),
        File("TextDecoderContextPrefill.mlmodelc/analytics/coremldata.bin", 243, "97639d36c7b137ea51c3c39b175911788f4d4a601ab03cd67a4b14164c3145e1"),
        File("TextDecoderContextPrefill.mlmodelc/coremldata.bin", 380, "2c159f5c862ec187092ea58e755d8c0b298952e22f3d75da023d7693c1c7389e"),
        File("TextDecoderContextPrefill.mlmodelc/metadata.json", 2240, "eb88dc350fa6748a8bc3fa5fb10958152c138752ebbbac1824d2f99b4c9fc068"),
        File("TextDecoderContextPrefill.mlmodelc/model.mil", 4092, "990ff5052fd817e28ba7c34d9d06d324c69c7c0630b6eaac9cfdf08329dbcb34"),
        File("TextDecoderContextPrefill.mlmodelc/weights/weight.bin", 12288192, "1310070082639173e9d81508c5f220692d489e85655aa6883cc1c7506da7fcfd"),
        File("config.json", 1149, "f01d83dd891791d6f12421c05d3ed8ebbe70866f10d6c9a7a7e80b558ce5a0f1"),
        File("generation_config.json", 2767, "7fbb053a023be11fbeccd8421811610308143daa93d9617c52aab4a0fa1491c6"),
        File("tokenizer.json", 2480617, "6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca"),
        File("tokenizer_config.json", 282843, "844b642c73a91359722f47b35705f7174686df33d252695d8572cf9ac03a6389"),
    ]
}

/// One file coming, into a file of its own: it goes on from what's there (a range request), so
/// a pause, a dropped connection or a restart loses nothing.
final class Fetch: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var session: URLSession!
    private var handle: FileHandle?
    private var written: Int64 = 0
    private var expected: Int64 = 0
    private var progress: (@Sendable (Int64, Bool) -> Void)?
    private var done: CheckedContinuation<Void, Error>?
    private var task: URLSessionDataTask?
    private var isCanceled = false

    init(configuration: URLSessionConfiguration) {
        super.init()
        configuration.waitsForConnectivity = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }

    /// Fetches `url` into `target`, after what's there; `progress` gets the bytes in it, and
    /// whether it's waiting for a connection.
    func get(_ url: URL, to target: URL, expected: Int64, progress: @escaping @Sendable (Int64, Bool) -> Void) async throws {
        if !FileManager.default.fileExists(atPath: target.path) { FileManager.default.createFile(atPath: target.path, contents: nil) }
        let handle = try FileHandle(forWritingTo: target)
        let have = try handle.seekToEnd()
        var request = URLRequest(url: url)
        if have > 0 { request.setValue("bytes=\(have)-", forHTTPHeaderField: "Range") }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.withLock {
                    guard !isCanceled else { return continuation.resume(throwing: CancellationError()) }
                    self.handle = handle
                    self.written = Int64(have)
                    self.expected = expected
                    self.progress = progress
                    self.done = continuation
                    let task = session.dataTask(with: request)
                    self.task = task
                    task.resume()
                }
                progress(Int64(have), false)
            }
        } onCancel: { cancel() }
    }

    func cancel() {
        let (task, done) = lock.withLock {
            isCanceled = true
            defer { self.done = nil }
            return (self.task, self.done)
        }
        task?.cancel()
        done?.resume(throwing: CancellationError())
        session.invalidateAndCancel()
    }

    func urlSession(_ session: URLSession, taskIsWaitingForConnectivity task: URLSessionTask) {
        let (written, progress) = lock.withLock { (self.written, self.progress) }
        progress?(written, true)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        lock.withLock {
            // The whole file again (the server ignored the range): start it over.
            if status == 200, written > 0 {
                try? handle?.truncate(atOffset: 0)
                written = 0
            }
        }
        guard status == 200 || status == 206 else {
            completionHandler(.cancel)
            return finish(with: SpeechModel.Problem("The download stopped: the server answered \(status). Try again later."))
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let (written, progress) = lock.withLock { () -> (Int64, (@Sendable (Int64, Bool) -> Void)?) in
            do {
                try handle?.write(contentsOf: data)
                self.written += Int64(data.count)
            } catch {
                return (-1, nil)
            }
            return (self.written, self.progress)
        }
        if written < 0 { return finish(with: CocoaError(.fileWriteOutOfSpace)) }
        progress?(written, false)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { return finish(with: error) }
        let (written, expected) = lock.withLock { (self.written, self.expected) }
        finish(with: written == expected ? nil : SpeechModel.Problem("The download stopped before the end. Try again."))
    }

    private func finish(with error: Error?) {
        let done = lock.withLock {
            try? handle?.close()
            handle = nil
            defer { self.done = nil }
            return self.done
        }
        if let error { done?.resume(throwing: error) } else { done?.resume() }
    }
}

// MARK: What each app says about it

extension SpeechModel {
    /// A few words beside the trace while you talk (nil: nothing to say): it's on its way, so
    /// Apple's dictation is listening meanwhile, or it's what's listening now, the first time.
    /// `device` is "Mac" or "iPhone".
    public func note(usesWhisper: Bool, device: String) -> String? {
        if usesWhisper { return isNewlyReady ? "Whisper, on this \(device)" : nil }
        switch state {
        case .downloading: return "Better model · \(Int(fraction * 100))%"
        case .waiting(.wifi), .askingCellular: return "Better model · waiting for Wi-Fi"
        case .waiting(.network): return "Better model · waiting for the network"
        case .preparing: return "Better model · almost ready"
        default: return nil
        }
    }

    /// Its line in Settings › Voice Input; without how much has come (`amount` false) where a bar under it says so.
    public func status(device: String, amount: Bool = true) -> String {
        let of = amount ? " · \(Self.megabytes(received)) of \(Self.megabytes(size)) MB" : ""
        switch state {
        case .absent: return "Writes what you say more accurately, and the project’s names as they’re written. \(Self.megabytes(size)) MB, kept on this \(device)."
        case .downloading: return "Downloading\(of)"
        case .waiting(.wifi), .askingCellular: return "Waiting for Wi-Fi\(of)"
        case .waiting(.network): return "Waiting for the network\(of)"
        case .paused: return "Paused\(of)"
        case .lowSpace(let free): return "Needs \(Self.megabytes(size - received)) MB · \(Self.megabytes(free)) MB free"
        case .failed(let words): return words
        case .preparing: return "Getting ready for this \(device)…"
        case .ready: return "Downloaded · \(Self.megabytes(size)) MB · in use"
        case .unsupported: return "Needs a newer \(device). Apple’s dictation writes what you say."
        }
    }

    static func megabytes(_ bytes: Int64) -> Int { Int((Double(bytes) / 1_000_000).rounded()) }
}
