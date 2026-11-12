import CryptoKit
import Foundation
import Security

// Starts processes, so only on the Mac; the phone reaches engines through Kuvo Link.
#if os(macOS)

/// One pinned build of the opencode server: where to download it and how to
/// recognise the genuine file.
public struct EngineRelease: Sendable, Equatable {
    public var version: String
    /// The npm tarball for the platform package.
    public var tarball: URL
    /// npm's `dist.integrity` for that tarball (`sha512-<base64>`).
    public var integrity: String
    /// The Apple team that signs opencode's binaries.
    public var teamIdentifier: String
    /// The binary's own SHA-256 (hex), as that tarball holds it: what's run is checked against it
    /// before each start, as an older build of opencode's, put in its place, carries the same
    /// signature. None for Linux builds, which this Mac only uploads.
    public var binarySHA256: String? = nil

    /// The build this version of the app is written against.
    public static let pinned = EngineRelease(
        version: OpenCodeEngine.version,
        tarball: URL(string: "https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.2.6.tgz")!,
        integrity: "sha512-OZwkLtiDOvcsfWkRS4e0o/Vpgb7vw12xBLlIFyuDZfglsCmOSNzihS3Akg0Wh3kbob8JKDngIbktctgbfHmF8w==",
        teamIdentifier: "5NZ4Q7NXJ4",
        binarySHA256: "90e4d03597b03d2051b65b4d793467764e55bacd8e22bf4824479c7233ea0e15"
    )

    /// The same version for Linux machines reached over SSH, by `uname -m`. Linux builds carry no
    /// Apple signature: npm's checksum, checked on this Mac before upload, is what vouches for them.
    public static func linux(machine: String) -> EngineRelease? {
        switch machine {
        case "x86_64", "amd64":
            EngineRelease(
                version: OpenCodeEngine.version,
                tarball: URL(string: "https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.2.6.tgz")!,
                integrity: "sha512-g1NShGt+20y/7nzQvqAnO7bQshC8nZGaz8WC7J8vjgXIOZ1uzoxz5OiLnCbUWertf2CM3Dlh9tzrmZJf0ic9Aw==",
                teamIdentifier: ""
            )
        case "aarch64", "arm64":
            EngineRelease(
                version: OpenCodeEngine.version,
                tarball: URL(string: "https://registry.npmjs.org/@opencode/cli-linux-arm64/-/cli-linux-arm64-2.2.6.tgz")!,
                integrity: "sha512-/Hr0ZBwHY4t4NSoakRu6SrR4SZiXIQx5Qbgwrsfn6JoZ1/REvTo8ZhOJ2cJjCzoQLt1oToS1tLJgMJBHAdF4Vg==",
                teamIdentifier: ""
            )
        default:
            nil
        }
    }
}

extension EngineRelease {
    /// The same version for Macs reached over SSH, by `uname -m`: an Apple-silicon Mac's is the one
    /// this app runs, an Intel Mac's its own. npm's checksum, checked on this Mac before upload, vouches
    /// for it, and its maker's signature stays on it: an Apple-silicon Mac runs only signed programs.
    public static func darwin(machine: String) -> EngineRelease? {
        switch machine {
        case "arm64", "aarch64": pinned
        case "x86_64", "amd64":
            EngineRelease(
                version: OpenCodeEngine.version,
                tarball: URL(string: "https://registry.npmjs.org/@opencode/cli-darwin-x64/-/cli-darwin-x64-2.2.6.tgz")!,
                integrity: "sha512-wZ+5gMEV11Fbzk+ElfJmYvZ+UseCw82jxBB5DhqNZOELG9SZNNPVco5B1ZY5ZpKq72GPWEmH6/KgTi5bjSC/MQ==",
                teamIdentifier: pinned.teamIdentifier
            )
        default: nil
        }
    }
}

public enum EngineInstallError: LocalizedError {
    case integrityMismatch
    case badSignature(OSStatus)
    case extractionFailed(String)
    /// npm's server, or a proxy on the way, answered with an error: its HTTP status.
    case serverAnswered(Int)

    public var errorDescription: String? {
        switch self {
        case .integrityMismatch: "The downloaded engine didn't match its checksum."
        case .badSignature: "The downloaded engine isn't signed by the opencode team."
        case .extractionFailed(let output): "The engine couldn't be unpacked. \(output)"
        case .serverAnswered(let status):
            "The engine's download (from registry.npmjs.org) was refused, with HTTP \(status)\(status == 407 ? ": a proxy wants you to sign in" : ""). Check that this Mac can reach registry.npmjs.org, then try again."
        }
    }

    /// What kind of trouble getting or starting the engine ran into, in a word, for anonymous
    /// usage: never the error's words.
    public static func kind(of error: any Error) -> String {
        switch error {
        case EngineInstallError.integrityMismatch: return "checksum"
        case EngineInstallError.badSignature: return "signature"
        case EngineInstallError.extractionFailed: return "unpack"
        case EngineInstallError.serverAnswered(let status): return "http_\(status)"
        case let error as URLError:
            switch error.code {
            case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff: return "offline"
            case .timedOut: return "timeout"
            case .cannotFindHost, .dnsLookupFailed: return "dns"
            case .cannotConnectToHost: return "connect"
            case .networkConnectionLost: return "dropped"
            case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .clientCertificateRejected, .clientCertificateRequired: return "tls"
            case .cancelled: return "cancelled"
            case .cannotCreateFile, .cannotWriteToFile, .cannotMoveFile: return "disk"
            default: return "network"
            }
        case let error as CocoaError where error.code == .fileWriteOutOfSpace: return "disk"
        case let error as POSIXError where error.code == .ENOSPC: return "disk"
        default: return "other"
        }
    }
}

/// Keeps one verified copy of the opencode binary per version, in a folder the app owns:
/// `<root>/<version>/opencode`.
public struct EngineInstaller: Sendable {
    public var root: URL
    public var release: EngineRelease

    public init(root: URL, release: EngineRelease = .pinned) {
        self.root = root
        self.release = release
    }

    public var executable: URL {
        root.appending(path: release.version).appending(path: "opencode")
    }

    /// The installed binary, if it's there and still the pinned build: opencode's signature, and
    /// the pinned binary's own hash. One that isn't is moved aside, so it's downloaded again.
    public func installed() -> URL? {
        let url = executable
        guard FileManager.default.isExecutableFile(atPath: url.path) else { return nil }
        if Self.isPinnedBuild(url, release: release) { return url }
        try? FileManager.default.moveItem(at: url, to: url.deletingLastPathComponent().appending(path: "opencode.replaced-\(UUID().uuidString.prefix(8))"))
        return nil
    }

    /// Whether `binary` is the pinned build: opencode's signature, and the binary's own hash.
    public static func isPinnedBuild(_ binary: URL, release: EngineRelease = .pinned) -> Bool {
        guard carriesSignature(binary, release: release) else { return false }
        guard let expected = release.binarySHA256 else { return true }
        return (try? sha256(of: binary)) == expected
    }

    /// The file's SHA-256, in hex.
    static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        return try handle.digest(SHA256.self).map { String(format: "%02x", $0) }.joined()
    }

    /// Downloads, verifies and unpacks the pinned release. `progress` gets the fraction downloaded.
    public func install(progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> URL {
        if let url = installed() { return url }

        let download = try await Self.download(release, progress: progress)
        defer { try? FileManager.default.removeItem(at: download) }

        // Unpack next to the final location, then move into place, so a crash never
        // leaves a half-written binary where `installed()` would find it.
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let staging = root.appending(path: ".staging-\(UUID().uuidString)")
        try fm.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: staging) }
        try await untar(download, into: staging)

        let binary = staging.appending(path: "package/bin/opencode")
        try verifySignature(of: binary)
        guard Self.isPinnedBuild(binary, release: release) else { throw EngineInstallError.integrityMismatch }
        let destination = executable.deletingLastPathComponent()
        try? fm.removeItem(at: destination)
        try fm.createDirectory(at: destination, withIntermediateDirectories: true)
        try fm.moveItem(at: binary, to: executable)
        removeOtherVersions()
        progress(1)
        return executable
    }

    /// Downloads a release's tarball to a temporary file and checks it against npm's checksum.
    /// A connection that drops or stalls is tried again, twice, from where it stopped.
    static func download(_ release: EngineRelease, progress: @escaping @Sendable (Double) -> Void) async throws -> URL {
        let observer = DownloadProgress(report: progress)
        var resume: Data?
        var attempt = 0
        var finished: (URL, URLResponse)?
        while finished == nil {
            do {
                if let resume {
                    finished = try await URLSession.shared.download(resumeFrom: resume, delegate: observer)
                } else {
                    finished = try await URLSession.shared.download(from: release.tarball, delegate: observer)
                }
            } catch let error as URLError where attempt < 2 && Self.retries.contains(error.code) {
                attempt += 1
                resume = error.downloadTaskResumeData
                try await Task.sleep(for: .seconds(2 * attempt))
            }
        }
        guard let (download, response) = finished else { throw URLError(.unknown) }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            try? FileManager.default.removeItem(at: download)
            throw EngineInstallError.serverAnswered(http.statusCode)
        }
        do {
            try verifyIntegrity(of: download, against: release)
        } catch {
            try? FileManager.default.removeItem(at: download)
            throw error
        }
        return download
    }

    /// Network trouble that's often gone a moment later.
    private static let retries: Set<URLError.Code> = [.networkConnectionLost, .timedOut, .cannotConnectToHost, .notConnectedToInternet, .dnsLookupFailed]

    static func verifyIntegrity(of file: URL, against release: EngineRelease) throws {
        guard release.integrity.hasPrefix("sha512-") else { throw EngineInstallError.integrityMismatch }
        let expected = Data(base64Encoded: String(release.integrity.dropFirst("sha512-".count)))
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        guard Data(try handle.digest(SHA512.self)) == expected else { throw EngineInstallError.integrityMismatch }
    }

    /// Checks the binary is intact and signed with a Developer ID from opencode's team.
    /// Whether `binary` still carries opencode's signature (the pinned release's team): checked
    /// before each start of what runs with it, as a file in the app's folder could be replaced.
    public static func carriesSignature(_ binary: URL, release: EngineRelease = .pinned) -> Bool {
        (try? EngineInstaller(root: binary.deletingLastPathComponent(), release: release).verifySignature(of: binary)) != nil
    }

    private func verifySignature(of binary: URL) throws {
        var code: SecStaticCode?
        var status = SecStaticCodeCreateWithPath(binary as CFURL, [], &code)
        guard status == errSecSuccess, let code else { throw EngineInstallError.badSignature(status) }
        var requirement: SecRequirement?
        let text = "anchor apple generic and certificate leaf[subject.OU] = \"\(release.teamIdentifier)\""
        status = SecRequirementCreateWithString(text as CFString, [], &requirement)
        guard status == errSecSuccess else { throw EngineInstallError.badSignature(status) }
        status = SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures), requirement)
        guard status == errSecSuccess else { throw EngineInstallError.badSignature(status) }
    }

    /// Unpacked by this Mac's tar (`ChildProcess`: waited for without holding a thread, with what
    /// it says read as it comes). The engine's archive takes seconds: one still going after five
    /// minutes is stuck, and stopped.
    private func untar(_ archive: URL, into directory: URL) async throws {
        let result = try await ChildProcess.run("/usr/bin/tar", ["-xzf", archive.path, "-C", directory.path], output: .discard,
                                                limit: .seconds(300))
        guard result.succeeded else {
            throw EngineInstallError.extractionFailed(result.timedOut ? "tar didn't finish in five minutes." : result.errorText)
        }
    }

    private func removeOtherVersions() {
        let fm = FileManager.default
        for entry in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] where entry != release.version {
            try? fm.removeItem(at: root.appending(path: entry))
        }
    }
}

/// Reports a download task's progress while `URLSession.download(from:delegate:)` runs.
private final class DownloadProgress: NSObject, URLSessionTaskDelegate, Sendable {
    let report: @Sendable (Double) -> Void
    nonisolated(unsafe) private var observation: NSKeyValueObservation?

    init(report: @escaping @Sendable (Double) -> Void) {
        self.report = report
    }

    func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
        observation = task.progress.observe(\.fractionCompleted) { [report] progress, _ in
            report(progress.fractionCompleted)
        }
    }
}

#endif

extension FileHandle {
    /// The rest of the file's `H` hash, read a megabyte at a time. Each chunk read is autoreleased:
    /// without a pool of its own, the whole file (the 200 MB engine, at each start) stays in memory
    /// until the task that reads it ends.
    public func digest<H: HashFunction>(_: H.Type) throws -> H.Digest {
        var hasher = H()
        while let chunk = try autoreleasepool(invoking: { try read(upToCount: 1 << 20) }), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize()
    }
}
