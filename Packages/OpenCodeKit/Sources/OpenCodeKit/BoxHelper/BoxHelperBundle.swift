#if os(macOS)
import Darwin
import Foundation
import Security

/// Kuvo Code Box, the helper a Mac's box runs under once it lives in a home of its own (#333 piece
/// 4; KuvoLink's PROTOCOL.md, "This Mac's box: its helper"): its names and places, and the checks
/// on its signature. The app carries it (`Contents/Helpers/Kuvo Code Box.app`), the box's release
/// brings it into the box's `bin`, and it runs from there.
public enum BoxHelperBundle {
    /// What macOS shows for it: in Login Items, and in every permission it asks about.
    public static let name = "Kuvo Code Box"
    public static let bundleName = "\(name).app"
    /// Its bundle ID is the app's with this after it (`run.kuvo.code.box`), so a test or demo copy's
    /// keeps its own, and its Keychain items are named apart from the app's.
    public static let idSuffix = ".box"
    /// The launch agent that starts a box at login on a Mac: one per computer, whatever set it up
    /// (a machine's runs `kuvo-start` with `/bin/sh`; a Mac's own box's runs this).
    public static let launchAgent = "run.kuvo.code.machine"

    public static func helperID(ofApp app: String) -> String { app + idSuffix }
    public static func appID(ofHelper helper: String) -> String? {
        helper.hasSuffix(idSuffix) && helper.count > idSuffix.count ? String(helper.dropLast(idSuffix.count)) : nil
    }

    /// The one the app at `app` carries.
    public static func bundled(in app: URL) -> URL { app.appending(path: "Contents/Helpers").appending(path: bundleName) }
    /// The one installed in a box's home (`~/.kuvo-code/bin`).
    public static func installed(in home: URL) -> URL { home.appending(path: "bin").appending(path: bundleName) }
    public static func executable(of bundle: URL) -> URL { bundle.appending(path: "Contents/MacOS").appending(path: name) }

    // MARK: Signatures

    /// The team that signed the code at `url` (or the running process: nil), if any (ad hoc, none).
    public static func team(of url: URL? = nil) -> String? {
        guard let code = staticCode(url) else { return nil }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let information = information as? [String: Any] else { return nil }
        return information[kSecCodeInfoTeamIdentifier as String] as? String
    }

    private static func staticCode(_ url: URL?) -> SecStaticCode? {
        var code: SecStaticCode?
        if let url {
            return SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess ? code : nil
        }
        var running: SecCode?
        guard SecCodeCopySelf([], &running) == errSecSuccess, let running, SecCodeCopyStaticCode(running, [], &code) == errSecSuccess else { return nil }
        return code
    }

    /// Who signed a program: a team (Developer ID), or no one (ad hoc, a contributor's build).
    public enum Signer: Equatable, Sendable {
        case team(String)
        case adHoc

        /// This running program's, or nil when that can't be told (its signing can't be read, or
        /// it's signed by no team without being ad hoc): then nothing is taken for genuine.
        public static var ofThisProgram: Signer? {
            if let team = BoxHelperBundle.team() { return .team(team) }
            var running: SecCode?
            var code: SecStaticCode?
            var information: CFDictionary?
            guard SecCodeCopySelf([], &running) == errSecSuccess, let running, SecCodeCopyStaticCode(running, [], &code) == errSecSuccess, let code,
                  SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
                  let flags = (information as? [String: Any])?[kSecCodeInfoFlags as String] as? UInt32 else { return nil }
            return flags & SecCodeSignatureFlags.adhoc.rawValue != 0 ? .adHoc : nil
        }
    }

    /// Whether the bundle at `url` is the program `identifier` names, its signature whole and made by
    /// the team that signed this running program (`signer`). For a build signed ad hoc there's no
    /// team to go by (anything can be signed ad hoc with any identifier): only what the caller proved
    /// is this very build's (`adHocMatch`) passes, else nothing.
    public static func isGenuine(_ url: URL, identifier: String, signer: Signer? = .ofThisProgram, adHocMatch: Bool = false) -> Bool {
        guard let signer, identifier.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" }),
              Bundle(url: url)?.bundleIdentifier == identifier, let code = staticCode(url) else { return false }
        var text = "identifier \"\(identifier)\""
        switch signer {
        case .team(let team):
            guard team.allSatisfy({ $0.isLetter || $0.isNumber }) else { return false }
            text += " and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
        case .adHoc:
            guard adHocMatch else { return false }
        }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement else { return false }
        return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate), requirement) == errSecSuccess
    }

    /// Kuvo Code itself at `url`, as the helper running now trusts it: signed by its team, or, for an
    /// ad hoc build where `adHoc` allows one, an app carrying this very helper (which anything could
    /// copy into an app of its own: an ad hoc build has no identity to go by).
    public static func isKuvoCode(_ url: URL, identifier: String, adHoc: Bool = true) -> Bool {
        let signer = Signer.ofThisProgram
        guard signer != .adHoc || adHoc else { return false }
        return isGenuine(url, identifier: identifier, signer: signer, adHocMatch: signer == .adHoc && CodeSeal.isSealed(bundled(in: url)))
    }

    /// The code directory's hash of the code at `url` (what a `cdhash` requirement names).
    static func cdhash(_ url: URL) -> Data? {
        guard let code = staticCode(url) else { return nil }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(code, [], &information) == errSecSuccess else { return nil }
        return (information as? [String: Any])?[kSecCodeInfoUnique as String] as? Data
    }

    /// Why the helper installed in `home` won't be opened: missing, or not Kuvo Code Box as the app
    /// asking (`app`, its bundle ID) carries it. Nil: it's well.
    public static func trouble(installedIn home: URL, app: String, signer: Signer? = .ofThisProgram, carrier: URL = Bundle.main.bundleURL) -> String? {
        let bundle = installed(in: home)
        guard FileManager.default.fileExists(atPath: executable(of: bundle).path(percentEncoded: false)) else {
            return "\(name) isn’t in this Mac’s box. Open Kuvo Code again to put it back."
        }
        // (Ad hoc: the very one the app running now carries.)
        let carried = cdhash(bundled(in: carrier))
        guard isGenuine(bundle, identifier: helperID(ofApp: app), signer: signer, adHocMatch: carried != nil && cdhash(bundle) == carried) else {
            return "\(name) in this Mac’s box was changed since it was installed, so it didn’t start. Open Kuvo Code again to put it back."
        }
        return nil
    }

    // MARK: Opening it

    /// The helper in `home`, opened as its own program (`open -g -j`: no window, nothing in front),
    /// for the box to run while Login Items doesn't start it: never started as the app's child,
    /// which would make the app what macOS asks about, and leave it without its Keychain. One that
    /// runs already stays (it holds the box's lock). Checked first (`trouble`).
    public static func open(home: URL, app: String, opener: String = "/usr/bin/open", signer: Signer? = .ofThisProgram, carrier: URL = Bundle.main.bundleURL) async throws {
        if let trouble = trouble(installedIn: home, app: app, signer: signer, carrier: carrier) { throw Refused(trouble) }
        let result = try await ChildProcess.run(opener, ["-g", "-j", "-n", installed(in: home).path(percentEncoded: false), "--args", "keep", "--home", home.path(percentEncoded: false)],
                                                output: .discard, errors: .collect, limit: .seconds(20), cancellable: false)
        guard result.succeeded else {
            let said = result.errorText.trimmingCharacters(in: .whitespacesAndNewlines)
            throw Refused(result.timedOut ? "macOS didn’t open \(name) in time." : said.isEmpty ? "macOS didn’t open \(name)." : said)
        }
    }

    public struct Refused: LocalizedError {
        public let why: String
        public init(_ why: String) { self.why = why }
        public var errorDescription: String? { why }
    }
}

/// Whether a bundle on disk is the very one this process was launched from: its code directory's
/// hash (which seals every resource too) as the kernel has it for the running process, not as the
/// bundle on disk says, which a swapped and signed-again copy would say of itself. The app checks
/// itself before its box starts (`BoxIntegrity`), and the box's helper itself.
public enum CodeSeal {
    public static func isSealed(_ bundle: URL) -> Bool {
        guard let requirement = launchRequirement else { return false }
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess, let code else { return false }
        return SecStaticCodeCheckValidity(code, [], requirement) == errSecSuccess
    }

    /// `cdhash H"<the running process's>"`, from the kernel (`csops`), made once.
    nonisolated(unsafe) public static let launchRequirement: SecRequirement? = {
        var hash = [UInt8](repeating: 0, count: 20)
        guard csops(getpid(), 5 /* CS_OPS_CDHASH */, &hash, hash.count) == 0, hash.contains(where: { $0 != 0 }) else { return nil }
        var requirement: SecRequirement?
        let text = "cdhash H\"" + hash.map { String(format: "%02x", $0) }.joined() + "\""
        return SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess ? requirement : nil
    }()
}

/// The kernel's code-signing calls for a process (`<sys/codesign.h>`): here, its code directory's hash.
@_silgen_name("csops")
private func csops(_ pid: pid_t, _ ops: UInt32, _ address: UnsafeMutableRawPointer?, _ size: Int) -> Int32

/// A file only you can read, written whole: a new file made that way, synced, then moved over the
/// old one, in a folder only you can open.
enum PrivateFile {
    static func write(_ data: Data, to file: URL) throws {
        let folder = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = folder.appending(path: ".\(file.lastPathComponent).\(UUID().uuidString)")
        let descriptor = open(temporary.path(percentEncoded: false), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw CocoaError(.fileWriteNoPermission) }
        let written = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, $0.count) }
        let synced = fsync(descriptor)
        let closed = close(descriptor)
        guard written == data.count, synced == 0, closed == 0, rename(temporary.path(percentEncoded: false), file.path(percentEncoded: false)) == 0 else {
            unlink(temporary.path(percentEncoded: false))
            throw CocoaError(.fileWriteUnknown)
        }
    }
}
#endif
