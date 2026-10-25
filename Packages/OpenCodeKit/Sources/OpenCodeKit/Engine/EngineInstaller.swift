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

    /// The build this version of the app is written against.
    public static let pinned = EngineRelease(
        version: OpenCodeEngine.version,
        tarball: URL(string: "https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.0.32.tgz")!,
        integrity: "sha512-wASwXBsWaOAYcZrh4ZLl4oaVxPCUAGVb7zZvXBBF8TjWE4uWgY0D2tj6gn80JfcO3b/s9woM6dP/gKqYKK2EdQ==",
        teamIdentifier: "5NZ4Q7NXJ4"
    )

    /// The same version for Linux machines reached over SSH, by `uname -m`. Linux builds carry no
    /// Apple signature: npm's checksum, checked on this Mac before upload, is what vouches for them.
    public static func linux(machine: String) -> EngineRelease? {
        switch machine {
        case "x86_64", "amd64":
            EngineRelease(
                version: OpenCodeEngine.version,
                tarball: URL(string: "https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.32.tgz")!,
                integrity: "sha512-Q50ofBQ3gdwjD6ZQhrVR8fVlm8D2xPMshy4dynY6l6b+qLdKgBSJ9WpoaDyrQX1YWmf2s7IN4RbXmoXXdJitDA==",
                teamIdentifier: ""
            )
        case "aarch64", "arm64":
            EngineRelease(
                version: OpenCodeEngine.version,
                tarball: URL(string: "https://registry.npmjs.org/@opencode/cli-linux-arm64/-/cli-linux-arm64-2.0.32.tgz")!,
                integrity: "sha512-YR5O03irvmot/G0f8W49ehvhn5uqCFN3vf9JTsChvf47W6ldjKCNvsaCSXS2SP26dPOUMQBn7WqbKnyHzrNR5w==",
                teamIdentifier: ""
            )
        default:
            nil
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

    /// The installed binary, if it's there and still carries opencode's signature.
    public func installed() -> URL? {
        let url = executable
        guard FileManager.default.isExecutableFile(atPath: url.path) else { return nil }
        return (try? verifySignature(of: url)) != nil ? url : nil
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
        var hasher = SHA512()
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        guard Data(hasher.finalize()) == expected else { throw EngineInstallError.integrityMismatch }
    }

    /// Checks the binary is intact and signed with a Developer ID from opencode's team.
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
