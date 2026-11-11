import CryptoKit
import Foundation

// Starts processes, so only on the Mac; the phone reaches engines through Kuvo Link.
#if os(macOS)

/// A machine reached over SSH: a host from `~/.ssh/config` (like `my-server`) or `user@host`.
/// Everything goes through the system's `ssh`, so the user's keys, agent and config apply.
public struct SSHConnection: Sendable, Hashable, Codable {
    public var destination: String

    public init(destination: String) {
        self.destination = destination
    }

    /// Where a machine with several addresses (the same computer on the local network and over a
    /// VPN) is reached now, by the name it was added under: the app sets it to the one that
    /// answered. Every connection to it goes there.
    private static let routesLock = NSLock()
    nonisolated(unsafe) private static var routes: [String: String] = [:]

    /// Sends connections to `destination` to `address` from now on (nil: to itself again).
    public static func route(_ destination: String, to address: String?) {
        routesLock.withLock { routes[destination] = address == destination ? nil : address }
    }

    /// Goes to the address itself, whatever machine it's an address of (to ask one that may not
    /// be the one in use).
    private var isDirect: Bool?

    public static func direct(_ address: String) -> SSHConnection {
        var connection = SSHConnection(destination: address)
        connection.isDirect = true
        return connection
    }

    /// The address `ssh` goes to: the one in use for this machine.
    public var address: String {
        isDirect == true ? destination : Self.routesLock.withLock { Self.routes[destination] } ?? destination
    }

    /// For every connection: never a password prompt (there's no terminal to type it in), a
    /// timeout to connect, and a check that notices when the machine goes away. A command and a
    /// terminal of the machine's own in `~/.ssh/config` (`RemoteCommand tmux …`, `RequestTTY
    /// force`) are left out: ssh refuses a command beside one, and a terminal mangles what comes
    /// back. (The panel's terminal asks for one with `-t`, which still counts.)
    static let options = [
        "-o", "BatchMode=yes",
        "-o", "RemoteCommand=none",
        "-o", "RequestTTY=no",
        "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
    ]

    /// Short commands share one connection per machine, kept open a little while after the last,
    /// so each costs a round trip rather than a new login. (Its socket's folder is this user's
    /// alone; `%C` is a hash of the host and user.)
    static var sharing: [String] {
        let folder = "/tmp/kuvo-ssh-\(getuid())"
        // Made private in one step (a umask only takes bits away): made, then narrowed, it would
        // look shared to a connection asking at the same moment, which would then go without it.
        _ = mkdir(folder, 0o700)
        // Only a folder that's really this user's alone: one another account made first could
        // hold a socket of its own, which ssh would hand what it sends (launch secrets on stdin).
        var info = stat()
        guard lstat(folder, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
            return separate
        }
        return ["-o", "ControlMaster=auto", "-o", "ControlPath=\(folder)/%C", "-o", "ControlPersist=120"]
    }

    /// The engine's own connection stays apart, so its tunnels end with it.
    static let separate = ["-o", "ControlMaster=no", "-o", "ControlPath=none"]

    /// The `ssh` arguments that run `script` on the machine with `sh`, whatever its login shell.
    /// sshd hands the command to that shell, and one like fish reads backslashes in quotes its own
    /// way, so the script goes as base64, which no shell changes, for `sh` to decode and run. Its
    /// standard input stays the command's.
    public func arguments(running script: String, extra: [String] = [], shared: Bool = true) -> [String] {
        unreachable + Self.options + (shared ? Self.sharing : Self.separate) + extra + [address, Self.command(running: script)]
    }

    /// A machine under `.invalid`, a name that never resolves (RFC 6761): a stand-in a demo copy
    /// shows (`KUVO_DEMO_MACHINE`), which nothing ever goes to.
    public var isStandIn: Bool { Self.isStandIn(address) || Self.isStandIn(destination) }

    /// Nothing goes to it, so nothing is tried there: a stand-in, unless a test's `standIn`
    /// answers for it (the app's tests name their machines under `.invalid` too).
    public var isNeverContacted: Bool {
        #if DEBUG
        if Self.standIn != nil { return false }
        #endif
        return isStandIn
    }

    public static func isStandIn(_ address: String) -> Bool {
        let host = address.split(separator: "@").last.map(String.init) ?? address
        return host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")).hasSuffix(".invalid")
    }

    /// For a stand-in, `ssh` started any way at all opens no connection: your SSH config is left
    /// out (a jump host it names would be asked for the name), and it connects through `false`.
    /// Nothing else: `run` never starts it for one.
    var unreachable: [String] {
        isStandIn ? ["-F", "/dev/null", "-o", "ProxyCommand=/usr/bin/false"] : []
    }

    /// The command line for the machine's login shell that runs `script` with `sh`. Without a
    /// working `base64` there, it fails (127) rather than running nothing and saying it's done.
    public static func command(running script: String) -> String {
        "exec sh -c 'kuvo_script=$(printf %s " + Data(script.utf8).base64EncodedString() + " | base64 -d) || exit 127; eval \"$kuvo_script\"'"
    }

    #if DEBUG
    /// For the app's tests: what a machine at an address answers to a script (nil: it failed, as
    /// SSH to an unreachable one does), in place of `ssh`. Only `run` and the app's short
    /// commands (`RemoteShell`) go to it.
    nonisolated(unsafe) public static var standIn: (@Sendable (_ address: String, _ script: String) -> String?)?
    /// The same, and what's sent to it: a test that runs what's said on this Mac for real.
    nonisolated(unsafe) public static var fedStandIn: (@Sendable (_ address: String, _ script: String, _ input: URL?) -> String?)?
    #endif

    /// Runs `script` on the machine and returns what it printed. `input` is sent to it. It runs as
    /// long as it takes (an install, a copy), with no limit of its own: SSH notices a machine that
    /// has gone away (`options`). It isn't stopped when the task is cancelled, so a change there
    /// is never left half done; one that only reads (`cancellable`) is, so nothing waits on what
    /// nobody wants any more (a search typed over).
    /// `sent`, given an `input`, hears how much of it has gone, as it goes.
    @discardableResult
    public func run(_ script: String, input: URL? = nil, cancellable: Bool = false, sent: (@Sendable (Int64) -> Void)? = nil) async throws -> String {
        #if DEBUG
        if let fedStandIn = Self.fedStandIn {
            guard let output = fedStandIn(address, script, input) else { throw RemoteEngineError.ssh(status: 255, message: "That failed on \(address)") }
            return output
        }
        if let standIn = Self.standIn {
            guard let output = standIn(address, script) else { throw RemoteEngineError.ssh(status: 255, message: "Couldn't reach \(address)") }
            // All of it, at once.
            if let input, let sent, let size = (try? input.resourceValues(forKeys: [.fileSizeKey]))?.fileSize { sent(Int64(size)) }
            return output
        }
        #endif
        // (A test's stand-in answers first: its machines are under `.invalid` too.)
        guard !isStandIn else { throw RemoteEngineError.ssh(status: 255, message: "Couldn’t reach \(destination).") }
        let stdin: ChildProcess.Input = input.map { url in sent.map { .reported(url, read: $0) } ?? .file(url) } ?? .nothing
        let result = try await ChildProcess.run("/usr/bin/ssh", arguments(running: script), input: stdin, cancellable: cancellable)
        guard result.succeeded else { throw RemoteEngineError.ssh(status: result.status, message: result.errorText) }
        return result.outputText
    }

    /// Runs `script` on the machine with what it prints going to `output` as it is (an archive of
    /// a folder there, say), not read as text. `input` is sent to it. As long as it takes, as `run`.
    public func run(_ script: String, input: URL? = nil, output: URL) async throws {
        guard !isStandIn else { throw RemoteEngineError.ssh(status: 255, message: "Couldn’t reach \(destination).") }
        guard FileManager.default.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
        let result = try await ChildProcess.run("/usr/bin/ssh", arguments(running: script), input: input.map { .file($0) } ?? .nothing,
                                                output: .file(output), cancellable: false)
        guard result.succeeded else { throw RemoteEngineError.ssh(status: result.status, message: result.errorText) }
    }

    /// `text` as one word for `sh`.
    public static func quoted(_ text: String) -> String {
        "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

public enum RemoteEngineError: LocalizedError {
    case ssh(status: Int32, message: String)
    case unsupportedPlatform(String)
    /// A Mac without Apple's Command Line Tools, where `git` only asks to install them.
    case needsDeveloperTools
    /// A Mac on a macOS older than `RemoteEngineInstaller.oldestMacOS`, which the engine doesn't run on.
    case needsNewerMacOS(String)
    /// The Mac this copy of the app runs on, in the account it runs in: its own box is already here.
    case thisMac
    case exited(status: Int32, output: String)
    case unreadableHandshake(String)
    case timedOut
    // COMPAT(0.7 engine-stop): an engine an older Mac's Stop left down. Goes 3 months after 0.8.0.
    /// Its engine is stopped on purpose (Stop), and stays so until it's started.
    case stopped

    public var errorDescription: String? {
        switch self {
        case .ssh(let status, let message):
            let message = message.trimmingCharacters(in: .whitespacesAndNewlines)
            // Its key isn't the one this Mac knows: reinstalled, or someone in between.
            // (The key is kept under the name ssh says, its address rather than a name in
            // ~/.ssh/config, `[address]:port` on another port: quoted for the shell. Only a line
            // that's all ssh's, with an address's characters in it: a machine could print text of
            // its own, which must never be advised to paste.)
            if status == 255, message.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
                let line = /^Host key for ([A-Za-z0-9._:\-\[\]]+) has changed and you have requested strict checking\.$/.anchorsMatchLineEndings()
                let name = message.firstMatch(of: line).map { String($0.1) }
                let remove = name.map { "with ssh-keygen -R '\($0)'" } ?? "with ssh-keygen -R and the machine's address"
                return "The machine's host key has changed since this Mac last connected. If you expect that (it was reinstalled, say), remove the old key in Terminal \(remove), then try again. If not, someone may be intercepting the connection."
            }
            if status == 255, message.contains("Host key verification failed") {
                return "This Mac doesn't know the machine's host key yet. Connect to it once in Terminal with ssh, then try again."
            }
            if status == 255, message.localizedCaseInsensitiveContains("permission denied") {
                return "The machine didn't accept this Mac's SSH key. Kuvo Code connects with your keys and SSH agent, without a password. If your key is in an app like 1Password or Secretive, or on a security key, unlock it, then try again."
            }
            return message.isEmpty ? "SSH stopped (exit code \(status))." : message
        case .unsupportedPlatform(let platform):
            return "The engine runs on macOS, and on Linux with glibc, on x86-64 or ARM64; this machine is \(platform)."
        case .needsDeveloperTools:
            return "This Mac needs a working git first. Run xcode-select --install on it (with Xcode, accept its license), then try again."
        case .needsNewerMacOS(let version):
            return "The engine runs on macOS \(RemoteEngineInstaller.oldestMacOS) or later; this Mac has macOS \(version)."
        case .thisMac:
            return "That’s this Mac, whose box is already here. Add another computer."
        case .exited(let status, let output):
            return "The engine on the machine stopped (exit code \(status)).\(output.isEmpty ? "" : "\n\n\(output)")"
        case .unreadableHandshake(let line):
            return "The engine on the machine said something unexpected when starting: \(line)"
        case .timedOut:
            return "The engine on the machine took too long to start."
        // COMPAT(0.7 engine-stop): an engine an older Mac stopped. Goes 3 months after 0.8.0.
        case .stopped:
            return "The engine on the machine is stopped."
        }
    }
}

/// Puts the pinned engine on a machine, in `~/.kuvo-code/engine/<version>/opencode`: downloaded and
/// checked on this Mac, then sent over SSH and unpacked there, so the machine needs nothing but `sh`
/// and `tar`, and never downloads code itself.
public struct RemoteEngineInstaller: Sendable {
    public var connection: SSHConnection
    /// Where this Mac keeps the checked Linux packages, so a second machine needs no download.
    public var cache: URL

    public init(connection: SSHConnection, cache: URL) {
        self.connection = connection
        self.cache = cache
    }

    /// The folder in the machine's home with everything Kuvo Code keeps there. A copy of the app
    /// for testing can take another, so its engine there is its own; set before connecting. Within
    /// `$scopedRoot.withValue(…)`, that one instead, for those tasks alone.
    public static var root: String {
        get { scopedRoot ?? appRoot }
        set { appRoot = newValue }
    }
    nonisolated(unsafe) private static var appRoot = ".kuvo-code"

    /// A folder for some tasks alone (tests against a real machine, beside others that run the
    /// scripts on this Mac with the app's), which `root` names for them.
    @TaskLocal public static var scopedRoot: String?

    /// The newest engine's runtime there, by version, as a shell expression (a box that updated
    /// itself, or another Mac's, may have only that one).
    public static let newestEngine = #"$K/engine/$(for d in "$K"/engine/*/; do [ -x "${d}opencode" ] && basename "$d"; done | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)/opencode"#

    var remoteExecutable: String { "$HOME/\(Self.root)/engine/\(OpenCodeEngine.version)/opencode" }

    /// Gives the engine folders of its own in `~/.kuvo-code` (`$K`), for everything it runs there,
    /// so it never touches the machine's own opencode, if it has one. Only you can open `$K`: what's
    /// in it (conversations, bots' memory, settings) is yours, wherever the home folder is open. (The commands the agent
    /// runs get the machine's own back: [CommandEnvironment].)
    /// Worked out each time, never kept, so a `root` set later is the one it names.
    static var folders: String {
        """
        K="$HOME/\(root)"
        mkdir -p "$K" && chmod 700 "$K"
        \(CommandEnvironment.keepScript)
        export XDG_DATA_HOME="$K/data" XDG_CONFIG_HOME="$K/config" XDG_STATE_HOME="$K/state" XDG_CACHE_HOME="$K/cache" npm_config_cache="$K/cache/npm" BUN_INSTALL="$K/cache/bun" KUVO_INTEGRATIONS="$K/integrations" TMPDIR="$K/tmp"
        mkdir -p "$K/data" "$K/config" "$K/state" "$K/cache" "$K/workspace" "$K/integrations" "$K/tmp"
        find "$K/tmp" -mindepth 1 -maxdepth 1 -mtime +3 -exec rm -rf {} + 2>/dev/null
        """
    }

    /// `command` as the engine's own helpers run on the machine: with its folders in `$K` (and
    /// the XDG folders pointed there), from its workspace, its runtime at `$E`: this version's,
    /// or the newest there (a box that updated itself, or another Mac's, may have only that).
    public static func script(_ command: String) -> String {
        """
        \(folders)
        E="$K/engine/\(OpenCodeEngine.version)/opencode"
        [ -x "$E" ] || E="\(newestEngine)"
        mkdir -p "$K/bin" "$K/run" && chmod 700 "$K/run"
        cd "$K/workspace" || exit 1
        \(command)
        """
    }

    /// The SHA-256 of file `$f` on the machine, as a shell expression, in hex (empty when it isn't
    /// there): `sha256sum` where it has one, `shasum`, which every Mac has, elsewhere.
    public static let sumOfFile = #"$( (sha256sum "$f" || shasum -a 256 "$f") 2>/dev/null | cut -c1-64)"#

    /// Connects and checks that the machine can run the engine: the build it needs, and whether
    /// it's there already. On a Mac, also what it can't work without (git, from Apple's Command
    /// Line Tools, which without them only asks on its screen each time it runs), and that it isn't
    /// the Mac this runs on, in this account, whose own box is already here. `found`: what's already
    /// on it (`foundProbe`), for this Mac's box to judge.
    @discardableResult
    public func check() async throws -> (release: EngineRelease, isInstalled: Bool, found: String) {
        try checked(try await connection.run(probe))
    }

    /// The first macOS the engine runs on.
    static let oldestMacOS = 13

    /// What `check` asks the machine.
    var probe: String {
        """
        uname -sm
        if [ "$(uname -s)" = Darwin ]; then
          if xcode-select -p >/dev/null 2>&1 && /usr/bin/git --version >/dev/null 2>&1; then echo tools; else echo no-tools; fi
          echo "macos $(sw_vers -productVersion 2>/dev/null)"
          echo "computer $(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | sed -n 's/.*"IOPlatformUUID" = "\\(.*\\)".*/\\1/p') $(id -u)"
        elif ldd --version 2>&1 | grep -qi musl; then echo musl; else echo glibc; fi
        test -x "\(remoteExecutable)" && (\(Self.folders.replacingOccurrences(of: "\n", with: "; ")); "\(remoteExecutable)" --version) 2>/dev/null || true
        \(Self.foundProbe)
        """
    }

    /// The probe's part that says what's already on the computer (PROTOCOL.md, "Your setup",
    /// "Already in a setup?"): each box there, Kuvo Code's own in a Mac's app folder too (only for
    /// the real `~/.kuvo-code`: a test's or a demo copy's own folder is a box of its own), by its
    /// card, and for an older box with none, a few fields of its link.json, never its keys. Only
    /// `sed`, so a machine still needs nothing but `sh` and `tar`. The box judges what it printed
    /// (`POST kuvo/setup/judge`): `box machine|app <folder>`, `card <json>`, `link …`.
    static var foundProbe: String {
        let apps = root == ".kuvo-code" ? #" "$HOME"/Library/*/run.kuvo.code*/box"# : ""
        return #"""
            for b in "$HOME/\#(root)"\#(apps); do
              [ -f "$b/run/link.json" ] || [ -f "$b/run/setup-card.json" ] || continue
              if [ "$b" = "$HOME/\#(root)" ]; then echo "box machine ${b#"$HOME"/}"; else echo "box app ${b#"$HOME"/}"; fi
              [ -f "$b/run/setup-card.json" ] && printf 'card %s\n' "$(sed -n 1p "$b/run/setup-card.json")"
              [ -f "$b/run/link.json" ] && sed -n -e 's/^  "mac": "\([A-Za-z0-9_-]*\)",\{0,1\}$/link mac \1/p' \
                -e '/^  "macs": \[$/,/^  \]/s/^    "\([A-Za-z0-9_-]*\)",\{0,1\}$/link macs \1/p' \
                -e '/^  "macSeen": {$/,/^  }/s/^    "\([A-Za-z0-9_-]*\)": \([0-9][0-9.e+]*\),\{0,1\}$/link seen \1 \2/p' \
                -e '/^  "macNames": {$/,/^  }/s/^    "\([A-Za-z0-9_-]*\)": \(".*"\),\{0,1\}$/link name \1 \2/p' \
                -e 's/^  "phones": \[\],\{0,1\}$/link phones none/p' -e 's/^  "phones": \[$/link phones some/p' "$b/run/link.json"
            done
            true
            """#
    }

    /// What `probe` found already on the computer, as it printed it, for its box to judge
    /// (`foundProbe`).
    static func found(in answer: String) -> String {
        answer.split(separator: "\n").filter { line in ["box ", "card ", "link "].contains { line.hasPrefix($0) } }.joined(separator: "\n")
    }

    /// What a machine's answer to `probe` means.
    func checked(_ answer: String) throws -> (release: EngineRelease, isInstalled: Bool, found: String) {
        let lines = answer.split(separator: "\n").map(String.init)
        let platform = lines.first ?? ""
        let parts = platform.split(separator: " ")
        let second = lines.dropFirst().first
        let machine = parts.last.map(String.init) ?? ""
        let release: EngineRelease?
        switch parts.first {
        case "Linux": release = second == "glibc" ? EngineRelease.linux(machine: machine) : nil
        case "Darwin":
            if let version = lines.first(where: { $0.hasPrefix("macos ") })?.dropFirst(6), let major = Int(version.prefix { $0.isNumber }), major < Self.oldestMacOS {
                throw RemoteEngineError.needsNewerMacOS(String(version))
            }
            if second == "no-tools" { throw RemoteEngineError.needsDeveloperTools }
            release = EngineRelease.darwin(machine: machine)
        default: release = nil
        }
        guard let release else { throw RemoteEngineError.unsupportedPlatform(platform + (second == "musl" ? " (musl)" : "")) }
        let rest = lines.dropFirst(2)
        if let computer = rest.first(where: { $0.hasPrefix("computer ") }), Self.isThisAccount(computer) { throw RemoteEngineError.thisMac }
        let found = Self.found(in: answer)
        let said = rest.filter { line in !["computer ", "macos ", "box ", "card ", "link "].contains { line.hasPrefix($0) } }
        return (release, said.contains { $0.hasSuffix(OpenCodeEngine.version) }, found)
    }

    /// Whether a Mac's `computer <its id> <account>` is this Mac, in the account this runs in. (Another
    /// account on it is a box of its own, in its own home; so is a test's or a demo copy's own folder.)
    static func isThisAccount(_ computer: String) -> Bool {
        let words = computer.split(separator: " ").map(String.init)
        return words.count == 3 && root == ".kuvo-code" && words[1] == ThisMac.identifier && words[2] == String(getuid())
    }

    /// How far an install has come: the package downloading to this Mac (a share of it), then
    /// copying to the machine (bytes sent of its size).
    public enum Progress: Sendable, Equatable {
        case downloading(fraction: Double)
        case copying(sent: Int64, total: Int64)
    }

    /// Makes sure the engine is on the machine. `progress` hears how far it's come: the download,
    /// when there is one (this Mac keeps the package for the next machine), then the copy.
    public func install(progress: @escaping @Sendable (Progress) -> Void = { _ in }) async throws {
        let (release, isInstalled, _) = try await check()
        if isInstalled { return }
        let package = try await checkedPackage(release) { progress(.downloading(fraction: $0)) }
        let total = Int64((try? package.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
        progress(.copying(sent: 0, total: total))
        let folder = "$HOME/\(Self.root)/engine"
        try await connection.run("""
            set -e
            mkdir -p "\(folder)/.staging"
            tar xzf - -C "\(folder)/.staging" package/bin/opencode
            rm -rf "\(folder)/\(release.version)"
            mkdir -p "\(folder)/\(release.version)"
            mv "\(folder)/.staging/package/bin/opencode" "\(folder)/\(release.version)/opencode"
            chmod +x "\(folder)/\(release.version)/opencode"
            rm -rf "\(folder)/.staging"
            find "\(folder)" -mindepth 1 -maxdepth 1 ! -name "\(release.version)" -exec rm -rf {} +
            """, input: package, sent: { progress(.copying(sent: min($0, total), total: total)) })
    }

    /// The release's tarball, from this Mac's cache when it's there and still matches its checksum.
    private func checkedPackage(_ release: EngineRelease, progress: @escaping @Sendable (Double) -> Void) async throws -> URL {
        let fm = FileManager.default
        let file = cache.appending(path: release.tarball.lastPathComponent)
        if fm.fileExists(atPath: file.path), (try? EngineInstaller.verifyIntegrity(of: file, against: release)) != nil {
            return file
        }
        let download = try await EngineInstaller.download(release, progress: progress)
        try fm.createDirectory(at: cache, withIntermediateDirectories: true)
        try? fm.removeItem(at: file)
        try fm.moveItem(at: download, to: file)
        // Older versions' packages aren't needed again.
        for entry in (try? fm.contentsOfDirectory(atPath: cache.path)) ?? [] where !entry.contains(release.version) {
            try? fm.removeItem(at: cache.appending(path: entry))
        }
        return file
    }
}

/// Whether a process there is what a script takes it for, after a crash or a restart may have given
/// its number to something else.
public enum RemoteProcess {
    /// Shell for `kuvo_runs <pid> <pattern>`: it's alive and its command line has the pattern. Linux's
    /// /proc, or on a Mac, which has none, `ps`.
    public static let check = #"""
        kuvo_runs() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null || return 1; if [ -d /proc/self ]; then grep -q -- "$2" "/proc/$1/cmdline" 2>/dev/null; else ps -ww -o command= -p "$1" 2>/dev/null | grep -q -- "$2"; fi; }
        """#

    /// Shell that makes `$S` what starts a command in a session of its own, as a process that stays
    /// the one started (needs `$K`). Linux's `setsid`; a Mac has none, and its `bin/kuvo-setsid` does it.
    public static let session = #"S=setsid; command -v setsid >/dev/null 2>&1 || S="$K/bin/kuvo-setsid""#

    /// `bin/kuvo-setsid`, for a computer without `setsid`: the command in a session of its own, by
    /// the Perl every Mac has. Without Perl, the command on its own, which at least outlives its
    /// connection (its group can't be stopped as one then, so what stops it stops it by its process).
    static let setsidScript = #"""
        #!/bin/sh
        # Kuvo Code: starts a command in a session of its own, as Linux's setsid does.
        if [ -x /usr/bin/perl ]; then exec /usr/bin/perl -e 'use POSIX (); POSIX::setsid(); exec { $ARGV[0] } @ARGV; die "$ARGV[0]: $!\n"' -- "$@"; fi
        trap '' HUP
        exec "$@"
        """#
}

public enum BoxVersion {
    /// This app's version: X.Y.Z, or X.Y.Z-beta.N for a beta (which comes before X.Y.Z). Set by
    /// the app before connecting; anything else is "0".
    nonisolated(unsafe) public static var mine = "0" {
        didSet { if order(mine) == nil { mine = "0" } }
    }

    /// A version as versions are ordered: its numbers, then its beta's (none, for a release, comes
    /// after every beta of it).
    static func order(_ version: String) -> [Int]? {
        let parts = version.split(separator: "-", maxSplits: 1)
        let numbers = parts[0].split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard numbers.count == 3, numbers.allSatisfy({ $0 != nil }) else { return version == "0" ? [0, 0, 0, Int.max] : nil }
        guard parts.count == 2 else { return numbers.compactMap(\.self) + [Int.max] }
        guard parts[1].hasPrefix("beta."), let beta = Int(parts[1].dropFirst(5)) else { return nil }
        return numbers.compactMap(\.self) + [beta]
    }

    /// Whether a box's `version` is newer than this app's.
    public static func isNewer(_ version: String?) -> Bool {
        guard let version, let theirs = order(version), let ours = order(mine) else { return false }
        return theirs.lexicographicallyPrecedes(ours) == false && theirs != ours
    }

    /// Shell: `kuvo_newer` is true when the box at `$HOME/<root>` was set up by a newer Kuvo Code
    /// than this app (a beta before its release, by number as `order`).
    static var newerTest: String {
        """
        kuvo_order() { case "$1" in *-beta.*) printf '%s.%s' "${1%-beta.*}" "${1##*-beta.}" ;; *) printf '%s.999999999' "$1" ;; esac; }
        kuvo_box=$(cat "$HOME/\(RemoteEngineInstaller.root)/bin/box-version" 2>/dev/null | tr -cd '0-9a-z.-')
        case "$kuvo_box" in [0-9]*.[0-9]*.[0-9]*) ;; *) kuvo_box= ;; esac
        kuvo_newer() { [ -n "$kuvo_box" ] && [ "$kuvo_box" != "\(mine)" ] && [ "$(printf '%s\\n%s\\n' "$(kuvo_order "$kuvo_box")" "$(kuvo_order "\(mine)")" | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -n 1)" = "$(kuvo_order "$kuvo_box")" ]; }
        """
    }

    /// For a script that puts this app's files on the machine: if the box there is newer, it reads
    /// what it was given and stops, writing nothing.
    public static var guardScript: String {
        newerTest + "\nif kuvo_newer; then cat >/dev/null; exit 0; fi"
    }

    /// For a script that starts this app's engine there: on a newer box, it fails, starting nothing.
    public static var refuseScript: String {
        newerTest + "\nif kuvo_newer; then echo 'This machine has a newer Kuvo Code than this Mac.' >&2; exit 75; fi"
    }

    /// The box's version, if a Kuvo Code that marks it put its files there.
    public static func read(on connection: SSHConnection) async throws -> String? {
        let text = try await connection.run("cat \"$HOME/\(RemoteEngineInstaller.root)/bin/box-version\" 2>/dev/null | tr -cd '0-9a-z.-'; true")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    // COMPAT(0.7 files): `run/mac-installing`, so the box doesn't take this Mac's files for an older Mac's. Goes 3 months after 0.8.0.
    /// Notes there that this app puts its files in place now (`run/mac-installing`), so the box
    /// doesn't take them for an older Mac's, put back over what it updated itself to.
    public static func installing(on connection: SSHConnection) async throws {
        try await connection.run("R=\"$HOME/\(RemoteEngineInstaller.root)/run\"; mkdir -p \"$R\" && touch \"$R/mac-installing\"")
    }

    // COMPAT(0.7 files): `run/mac-installing` taken back. Goes 3 months after 0.8.0.
    /// Takes `installing`'s note back, for a connect that ends before it puts its files in place.
    public static func notInstalling(on connection: SSHConnection) async throws {
        try await connection.run("rm -f \"$HOME/\(RemoteEngineInstaller.root)/run/mac-installing\"")
    }

    // COMPAT(0.7 files): the tools an older Mac puts its own over, which the box keeps copies of in `bin/.own`. Goes 3 months after 0.8.0.
    /// The box's tools that an older Kuvo Code on a Mac (0.7 and before) puts its own over as it
    /// connects. The box keeps copies of its own (`bin/.own`), which its keeper puts back.
    public static let ownTools = ["kuvo-agents.js", "kuvo-browser.js", "kuvo-wake", "kuvo-npx"]

    /// Marks the box as this app's, once what it put there runs (not over a newer one's): its tools
    /// this version's (`kuvo-wake` and `kuvo-npx` are put there otherwise only as an engine starts),
    /// and kept as the box's own. `marks`: the line this app's own of a tool it put there before
    /// carries (its first or last). One that doesn't, an older Mac's put there meanwhile, isn't
    /// kept: the box's own goes back instead, when it's this app's.
    public static func mark(on connection: SSHConnection, marks: [String: String] = [:]) async throws {
        try await connection.run(markScript(marks: marks))
    }

    static func markScript(marks: [String: String]) -> String {
        // COMPAT(0.7 files): this app's tools kept in `bin/.own`, or the box's put back over an older Mac's. Goes 3 months after 0.8.0.
        let keep = ownTools.map { tool in
            let kept = "cp -p \"$B/\(tool)\" \"$O/.\(tool).new\" && mv -f \"$O/.\(tool).new\" \"$O/\(tool)\" || exit 1"
            // COMPAT(0.7 files): `kuvo-npx` kept only with this version's engine there. Goes 3 months after 0.8.0.
            // Put there by this script only with this version's engine there, which it runs.
            if tool == "kuvo-npx" { return "if [ -n \"$npx\" ]; then \(kept); fi" }
            guard let mark = marks[tool].map(SSHConnection.quoted) else {
                return "if [ -f \"$B/\(tool)\" ]; then \(kept); else rm -f \"$O/\(tool)\"; fi"
            }
            return """
            if [ ! -f "$B/\(tool)" ]; then rm -f "$O/\(tool)"
            elif ours "$B/\(tool)" \(mark); then \(kept)
            elif [ -f "$O/\(tool)" ] && ours "$O/\(tool)" \(mark); then cp -p "$O/\(tool)" "$B/.\(tool).new" && mv -f "$B/.\(tool).new" "$B/\(tool)"
            fi
            """
        }.joined(separator: "\n")
        return guardScript + "\n" + RemoteEngineInstaller.folders + "\n" + Wakes.installScript + "\n" + """
        npx=
        if [ -x "$K/engine/\(OpenCodeEngine.version)/opencode" ]; then
        \(Launcher.installScript)
        npx=1
        fi
        # COMPAT(0.7 files): bin/.own, the box copies of its tools. Goes 3 months after 0.8.0.
        B="$K/bin"; O="$B/.own"; mkdir -p "$O" || exit 1
        # COMPAT(0.7 visits): run/older-mac, an older Mac visit the mark would hide. Goes 3 months after 0.8.0.
        # An older Mac here since the box was last marked: noted for the box (its updates), which
        # the mark that follows would hide.
        if [ -f "$B/box-version" ] && [ "$K/run/attached" -nt "$B/box-version" ]; then touch -r "$K/run/attached" "$K/run/older-mac"; fi
        ours() { [ "$(head -n 1 "$1")" = "$2" ] || [ "$(tail -n 1 "$1")" = "$2" ]; }
        \(keep)
        printf '%s' "\(mine)" >"$B/box-version.new" && mv -f "$B/box-version.new" "$B/box-version" && rm -f "$K/run/mac-installing"
        """
    }
}

/// The engine on a machine, and the connection to it.
///
/// The engine runs there on its own, apart from any connection, so a task carries on while this
/// Mac sleeps, shuts down or loses the network; the app finds it again next time. It listens on
/// the machine's localhost only, behind a password, and this Mac reaches it through an SSH tunnel.
/// Its settings and secrets
/// (the password, accounts) go over the session's input rather than a command line, so other users
/// of the machine can't read them in its process list. Accounts copied there are kept in its
/// engine's own store, in `~/.kuvo-code/data`, readable by that user only, and signed out when the
/// machine is removed. What's needed to find it again (its process, port and password) is kept in
/// `~/.kuvo-code/run/engine.json`, readable by that user only, who could read it from the engine's
/// process anyway. The machine keeps it running on its own (`bootScript`'s keeper): after a crash
/// or a restart, with or without a Mac; only a Stop, from any Mac or phone, stops it.
public final class RemoteServer: @unchecked Sendable {
    /// The engine running on a machine.
    public struct Engine: Codable, Sendable, Equatable {
        public var pid: Int
        public var port: Int
        public var password: String
        public var version: String
        /// The app's own notes on how it started it, kept with it.
        public var notes: [String: String]
        /// The agents bridge beside it (`kuvo-agents.js`), when it was started with one: where it
        /// listens on the machine's localhost, behind its own password.
        public var agents: Agents?

        public struct Agents: Codable, Sendable, Equatable {
            public var port: Int
            public var password: String
        }

        public init(pid: Int, port: Int, password: String, version: String, notes: [String: String], agents: Agents?) {
            self.pid = pid
            self.port = port
            self.password = password
            self.version = version
            self.notes = notes
            self.agents = agents
        }

        // The record keeps the bridge's port and password under names of their own, at the top
        // (`agentsPort`, `agentsPassword`): scripts on the machine (kuvo-wake's) take the first
        // `"port"` and `"password"` they find, whatever order the keys come in.
        private enum CodingKeys: String, CodingKey { case pid, port, password, version, notes, agentsPort, agentsPassword, agents }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            pid = try container.decodeIfPresent(Int.self, forKey: .pid) ?? 0
            port = try container.decode(Int.self, forKey: .port)
            password = try container.decode(String.self, forKey: .password)
            version = try container.decode(String.self, forKey: .version)
            notes = try container.decodeIfPresent([String: String].self, forKey: .notes) ?? [:]
            if let port = try container.decodeIfPresent(Int.self, forKey: .agentsPort), let password = try container.decodeIfPresent(String.self, forKey: .agentsPassword) {
                agents = Agents(port: port, password: password)
            } else {
                // As test builds wrote it.
                agents = try container.decodeIfPresent(Agents.self, forKey: .agents)
            }
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(pid, forKey: .pid)
            try container.encode(port, forKey: .port)
            try container.encode(password, forKey: .password)
            try container.encode(version, forKey: .version)
            try container.encode(notes, forKey: .notes)
            try container.encodeIfPresent(agents?.port, forKey: .agentsPort)
            try container.encodeIfPresent(agents?.password, forKey: .agentsPassword)
        }
    }

    public let engine: Engine
    public let endpoint: ServerEndpoint
    /// The agents bridge beside it, through the same tunnel.
    public let agentsEndpoint: ServerEndpoint?
    public let connection: SSHConnection
    private let tunnel: Process
    private let log: LogTail

    private init(engine: Engine, endpoint: ServerEndpoint, agentsEndpoint: ServerEndpoint?, connection: SSHConnection, tunnel: Process, log: LogTail) {
        self.engine = engine
        self.endpoint = endpoint
        self.agentsEndpoint = agentsEndpoint
        self.connection = connection
        self.tunnel = tunnel
        self.log = log
    }

    public var isConnected: Bool { tunnel.isRunning }

    /// The last lines ssh wrote, for error reports.
    public var recentOutput: String { log.text }

    static var run: String { "$HOME/\(RemoteEngineInstaller.root)/run" }

    // COMPAT(0.7 engine-stop): `stopped`, an engine an older Mac stopped. Goes 3 months after 0.8.0.
    /// What runs on the machine: its engine, or that it's stopped on purpose, or nothing.
    public enum Found: Sendable, Equatable {
        case running(Engine)
        case stopped
        case none

        public var engine: Engine? {
            if case .running(let engine) = self { return engine }
            return nil
        }
    }

    /// The engine running on the machine, if there is one, or whether it's stopped on purpose;
    /// and the box's keeper made sure of (a machine set up by an older version gets it here).
    public static func find(on connection: SSHConnection) async throws -> Found {
        let text = try await connection.run("""
            K="$HOME/\(RemoteEngineInstaller.root)"; R="\(run)"
            \(RemoteProcess.check)
            [ -f "$K/bin/kuvo-start" ] && sh "$K/bin/kuvo-start" box >/dev/null 2>&1
            pid=$(sed -n 's/^{"pid":\\([0-9]*\\),.*/\\1/p' "$R/engine.json" 2>/dev/null)
            if kuvo_runs "$pid" opencode; then
              cat "$R/engine.json"
            # COMPAT(0.7 engine-stop): an engine an older Mac stopped. Goes 3 months after 0.8.0.
            elif [ -f "$R/stopped" ]; then
              echo stopped
            fi
            """)
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // COMPAT(0.7 engine-stop): an engine an older Mac stopped. Goes 3 months after 0.8.0.
        if line == "stopped" { return .stopped }
        guard !line.isEmpty, let engine = try? JSONDecoder().decode(Engine.self, from: Data(line.utf8)) else { return .none }
        return .running(engine)
    }

    /// The engine already running on the machine, if there is one.
    public static func running(on connection: SSHConnection) async throws -> Engine? {
        try await find(on: connection).engine
    }

    /// Starts the engine on the machine, on its own, and waits until it's listening. `environment`
    /// is handed to it, with values on one line each; `notes` are kept with it. `withAgents`: the
    /// agents bridge (`bin/kuvo-agents.js`, put there first) starts beside it.
    /// `replace`: the one running there that this replaces (another version, other settings), by
    /// its process, stopped first, in the same start, so nothing starts one in between; another
    /// found running instead is used as it is. `start`: one stopped on purpose is started
    /// (Start); otherwise it stays stopped, and this throws `stopped`.
    public static func launch(on connection: SSHConnection, environment base: [String: String], notes: [String: String] = [:], withAgents: Bool = false,
                              replace: Int? = nil, start: Bool = false) async throws -> Engine {
        // What starts it again after a restart, as this launch does.
        try await installBoot(on: connection)
        var lastError: Error = RemoteEngineError.timedOut
        // A port someone else took on the machine: try another.
        for _ in 0..<3 {
            let port = Int.random(in: 20_000..<60_000)
            let agents = withAgents ? Engine.Agents(port: (port - 20_000 + Int.random(in: 1..<40_000)) % 40_000 + 20_000, password: ServerProcess.randomPassword()) : nil
            var engine = Engine(pid: 0, port: port, password: ServerProcess.randomPassword(), version: OpenCodeEngine.version, notes: notes, agents: agents)
            var environment = base
            environment["OPENCODE_PASSWORD"] = engine.password
            environment["OPENCODE_CLIENT"] = "desktop"
            environment.removeValue(forKey: "OPENCODE_SERVER_PASSWORD")
            if let replace { environment["KUVO_REPLACE"] = String(replace) }
            // COMPAT(0.7 engine-stop): Start, for an engine an older Mac stopped. Goes 3 months after 0.8.0.
            if start { environment["KUVO_START"] = "1" }
            // What's kept to find it again, but its process, which the script adds.
            struct Record: Encodable { var port: Int, password: String, version: String, notes: [String: String], agentsPort: Int?, agentsPassword: String? }
            let record = String(decoding: try JSONEncoder().encode(Record(port: engine.port, password: engine.password, version: engine.version, notes: engine.notes, agentsPort: agents?.port, agentsPassword: agents?.password)), as: UTF8.self)
            environment["KUVO_RECORD"] = String(record.dropFirst())
            environment["KUVO_PORT"] = String(engine.port)
            if let agents {
                environment["KUVO_AGENTS_PORT"] = String(agents.port)
                environment["KUVO_AGENTS_PASSWORD"] = agents.password
            }
            let lines = environment.sorted { $0.key < $1.key }
                .filter { !$0.value.contains("\n") }
                .map { "\($0.key)=\($0.value)\n" }
                .joined() + "\n"
            _ = clearedLeftovers
            let input = FileManager.default.temporaryDirectory.appending(path: "kuvo-engine-\(UUID().uuidString)")
            // Only this user can read it, and it's gone as soon as ssh has sent it (or, if the app
            // stopped first, the next time it starts one).
            FileManager.default.createFile(atPath: input.path, contents: Data(lines.utf8), attributes: [.posixPermissions: 0o600])
            defer { try? FileManager.default.removeItem(at: input) }
            do {
                // Its process, and the agents bridge's port when it had to take another.
                // Never this app's engine over a newer box's (`BoxVersion`).
                let said = try await connection.run(BoxVersion.refuseScript + "\n" + launchScript, input: input).trimmingCharacters(in: .whitespacesAndNewlines)
                let parts = said.split(separator: " ").map(String.init)
                guard let pid = parts.first.flatMap({ Int($0) }) else { throw RemoteEngineError.unreadableHandshake(said) }
                engine.pid = pid
                if parts.count > 1, let port = Int(parts[1]) { engine.agents?.port = port }
                return engine
            } catch RemoteEngineError.ssh(let status, _) where status == 5 {
                // One started meanwhile (after a restart, or by another Mac): that one, as it is.
                if let running = try await running(on: connection) { return running }
                lastError = RemoteEngineError.timedOut
            // COMPAT(0.7 engine-stop): an engine an older Mac stopped (status 6). Goes 3 months after 0.8.0.
            } catch RemoteEngineError.ssh(let status, _) where status == 6 {
                throw RemoteEngineError.stopped
            } catch RemoteEngineError.ssh(let status, let message) where status == 75 {
                throw RemoteEngineError.exited(status: status, output: message.trimmingCharacters(in: .whitespacesAndNewlines))
            } catch RemoteEngineError.ssh(let status, let message) where status == 3 && message.localizedCaseInsensitiveContains("in use") {
                lastError = RemoteEngineError.exited(status: status, output: message)
            } catch RemoteEngineError.ssh(let status, let message) where status == 3 {
                throw RemoteEngineError.exited(status: status, output: message.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
        throw lastError
    }

    /// Settings for the engine that stay out of its environment (see `launchScript`).
    public static let privateSettingsVariable = "KUVO_PRIVATE_SETTINGS"

    /// Reads the settings from the input, gives the engine its own folders under `~/.kuvo-code`,
    /// starts it in a session of its own on the machine's localhost, writes down how to find it,
    /// and makes sure the box's keeper runs (`bootScript`). Prints its process once it listens.
    ///
    /// `KUVO_SETTINGS`, when it's given, becomes the engine's settings file there (its global
    /// settings, which a project's own outrank), in place of what was there.
    ///
    /// `privateSettingsVariable`, when it's given, is the rest of your settings, which can hold
    /// secrets (a server's environment or headers): written to a file only this user can read in
    /// `keys`, which the engine reads (`OPENCODE_CONFIG`, above its settings file and below a
    /// project's own), never left in its environment.
    ///
    /// Integrations' keys (`KUVO_KEY_…`) go in files only this user can read, in `keys`, which the
    /// settings name with `{file:…}`, never in the engine's environment, where the agent's own
    /// commands (`env`, say) would print them. Each start from the Mac puts its keys there in place
    /// of what was there; they stay when the engine stops, so the machine works on its own after a
    /// restart (see `bootScript`), and go when the machine is removed.
    ///
    /// Stopped on purpose (`run/stopped`), it starts none, unless `KUVO_START` is given (Start):
    /// it exits 6. With `KUVO_REPLACE`, one running is stopped first, under its lock. An engine it
    /// started but couldn't note in `engine.json` (cut off) is stopped as it ends.
    ///
    /// With `KUVO_AGENTS_PORT` and `KUVO_AGENTS_PASSWORD`, the agents bridge starts beside the
    /// engine once it listens, with the same settings, and stops with it ([agentsScript]). Only it
    /// gets its password, never the engine (whose agent's commands could print it) nor what starts
    /// after it.
    ///
    /// One launch at a time (`run/.launching`): one that finds an engine started meanwhile (after a
    /// restart, or by another Mac) starts none, and the Mac uses that one. Started from
    /// the Mac, it also keeps how it was started for `kuvo-start` (`run/launch.env`: everything but
    /// its port, passwords and keys, with the session's PATH, shell and language; `run/launch.notes`),
    /// and on Kuvo Code's own folder (not a test's) makes sure the machine's crontab runs
    /// `kuvo-start` after a restart (`rebootLine`).
    static var launchScript: String { launch(boot: false) }

    /// `launchScript` as `kuvo-start` runs it after a restart (`KUVO_BOOT` among its settings),
    /// from `bin/kuvo-launch`: it keeps the keys and the helpers there as they are, and puts
    /// nothing in place.
    static var bootLaunchScript: String { launch(boot: true) }

    /// The tag on the machine's crontab line that starts Kuvo Code's engine again after a restart.
    static let rebootTag = "# kuvo-code: starts its engine again after a restart"

    /// The crontab line itself.
    static var rebootLine: String { "@reboot sh \"$HOME/\(RemoteEngineInstaller.root)/bin/kuvo-start\" >/dev/null 2>&1 \(rebootTag)" }

    /// The box's own tool on the machine (`bin/kuvo-start`): what keeps its engine, coding agents
    /// and phone link running on their own, whatever a Mac does. The crontab's `@reboot` line and
    /// every connect run it plainly, which starts its keeper once; the Mac and the phone link run
    /// `start`, `stop` and `restart`, and removing the machine `off`.
    ///
    /// The keeper (`keep`, its process in `run/box.pid`): every 15 seconds it starts the engine
    /// when it's down and not stopped on purpose (`run/stopped`), as Kuvo Code last started it
    /// (`run/launch.env`, with a new port and passwords), waiting longer between starts that keep
    /// failing; it starts the phone link while a phone is paired (`run/link.needed`); and each
    /// minute it sends the bots' and sessions' wake-ups that are due ([Wakes]). It takes the place
    /// of the watchdog each engine had before, and carries on from its new script when that's
    /// replaced. It ends when its script goes or another keeper takes over.
    ///
    /// Starts and stops take the launch's lock (`run/.launching`), one at a time.
    static var bootScript: String {
        #"""
        #!/bin/sh
        # Kuvo Code's box on this machine: keeps its engine, coding agents and phone link running on
        # their own, with or without a Mac. From the @reboot line in your crontab, and from Kuvo Code:
        #   kuvo-start           keeps the box running (starts its keeper, once)
        #   kuvo-start start     starts the engine, after a stop
        #   kuvo-start stop      stops the engine until it's started again
        #   kuvo-start restart   starts the engine over
        K="$HOME/\#(RemoteEngineInstaller.root)"; R="$K/run"
        mkdir -p "$R" 2>/dev/null && chmod 700 "$R" 2>/dev/null
        # Whether process $1 runs and is $2 (in its command line).
        \#(RemoteProcess.check)
        is() { kuvo_runs "$1" "$2"; }
        \#(RemoteProcess.session)
        engine() { sed -n 's/^{"pid":\([0-9]*\),.*/\1/p' "$R/engine.json" 2>/dev/null; }
        up() { is "$(engine)" "$K/engine/"; }
        # The engine's version to start: this one's, or while that isn't there (Kuvo Code updated
        # while an engine of another version was at work), the newest one there is.
        V=\#(OpenCodeEngine.version)
        [ -x "$K/engine/$V/opencode" ] || V=$(for d in "$K"/engine/*/; do [ -x "${d}opencode" ] && basename "$d"; done | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
        # What it runs gets the box's own folders, as the engine does, and how Kuvo Code last
        # started it (in a subshell).
        environment() {
          if [ -f "$R/launch.env" ]; then while IFS= read -r line; do [ -n "$line" ] && export "$line"; done <"$R/launch.env"; fi
          unset KUVO_SETTINGS
          \#(RemoteEngineInstaller.folders)
          export PATH="$K/bin:$PATH" KUVO_BOTS="$K/bots" KUVO_WAKES="$K/wakes"
        }
        # One start or stop at a time, as the launch takes it; one left by a start cut off goes after
        # five minutes. False when it isn't had within $1 tenths of a second.
        lock() {
          n=0
          until mkdir "$R/.launching" 2>/dev/null; do
            [ -z "$(find "$R/.launching" -maxdepth 0 -mmin +5 2>/dev/null)" ] || rmdir "$R/.launching" 2>/dev/null
            n=$((n + 1)); [ $n -lt "${1:-2400}" ] || return 1
            sleep 0.1
          done
        }
        # The engine and its coding agents' bridge, stopped (under the lock).
        halt() {
          a=$(cat "$R/agents.pid" 2>/dev/null)
          if is "$a" kuvo-agents; then kill -- "-$a" 2>/dev/null || kill "$a" 2>/dev/null; fi
          rm -f "$R/agents.pid"
          p=$(engine)
          if is "$p" "$K/engine/"; then
            kill "$p"; n=0
            while kill -0 "$p" 2>/dev/null && [ $n -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
            # Never two on the same data: one that won't end is ended.
            kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null
          fi
          rm -f "$R/engine.json"
        }
        case "${1:-box}" in
        box)
          [ -f "$K/bin/kuvo-start" ] || exit 0
          is "$(cat "$R/box.pid" 2>/dev/null)" kuvo-start && exit 0
          cd "$K" || exit 0
          # This script (kuvo-start, or the copy below), as the keeper.
          env -i HOME="$HOME" PATH="$PATH" "$S" sh "$0" keep </dev/null >/dev/null 2>&1 &
          ;;
        keep)
          echo $$ >"$R/box.pid"
          # A Mac sleeps by itself, and a box works with nobody there: awake while it's on power,
          # for as long as this keeper runs (its display still sleeps). No setting of yours changes.
          # Looked at each round: one held for a keeper that has since gone is gone with it.
          hold() {
            if command -v caffeinate >/dev/null 2>&1 && ! is "$(cat "$R/awake.pid" 2>/dev/null)" caffeinate; then
              caffeinate -s -w $$ </dev/null >/dev/null 2>&1 &
              echo $! >"$R/awake.pid"
            fi
          }
          hold
          boot=$(cat "$K/bin/.kuvo-boot" 2>/dev/null)
          # COMPAT(0.7 keeper): its own copies, bin/.kuvo-start-keeper and bin/.kuvo-launch-keeper. Goes 3 months after 0.8.0.
          # A copy of itself and of its launcher, which it runs its starts from and puts back when an
          # older Kuvo Code on a Mac (0.7 and before) put its own there as it started the engine:
          # a kuvo-start that only starts the engine after a restart, and a launcher that knows
          # neither Stop nor the box's settings. (The phone link starts the keeper from it then.)
          me="$K/bin/.kuvo-start-keeper"
          if [ "$0" != "$me" ]; then
            cp -f "$0" "$me.new" 2>/dev/null && mv -f "$me.new" "$me" || me=$0
            [ "$me" = "$0" ] || { cp -f "$K/bin/kuvo-launch" "$K/bin/.kuvo-launch-keeper.new" && mv -f "$K/bin/.kuvo-launch-keeper.new" "$K/bin/.kuvo-launch-keeper"; } 2>/dev/null
          fi
          # COMPAT(0.7 keeper): the kuvo-start of an older Mac, replaced by the copy. Goes 3 months after 0.8.0.
          # Whether kuvo-start is a keeper; an older Mac's is replaced, with the launcher it put there
          # (one removed stays removed).
          mine() {
            grep -q '^keep)' "$K/bin/kuvo-start" 2>/dev/null && return 0
            if [ -f "$K/bin/kuvo-start" ] && [ "$me" != "$K/bin/kuvo-start" ]; then
              { [ ! -f "$K/bin/.kuvo-launch-keeper" ] || { cp -f "$K/bin/.kuvo-launch-keeper" "$K/bin/.kuvo-launch.new" && chmod 700 "$K/bin/.kuvo-launch.new" && mv -f "$K/bin/.kuvo-launch.new" "$K/bin/kuvo-launch"; }
                cp -f "$me" "$K/bin/.kuvo-start.new" && chmod 700 "$K/bin/.kuvo-start.new" && mv -f "$K/bin/.kuvo-start.new" "$K/bin/kuvo-start"; } 2>/dev/null
            fi
            return 1
          }
          mine
          # COMPAT(0.7 keeper): the watchdogs an older Mac start brings. Goes 3 months after 0.8.0.
          # The watchdogs engines had before, one each: this keeper does their work now.
          pkill -f "watchdog [0-9]+ $R" 2>/dev/null
          fails=0; next=0; started=; round=0
          while :; do
            [ -f "$K/bin/kuvo-start" ] && [ "$(cat "$R/box.pid" 2>/dev/null)" = "$$" ] || exit 0
            hold
            # COMPAT(0.7 keeper): checked each round. Goes 3 months after 0.8.0.
            # Its script replaced: a newer keeper carries on; an older Mac's gets this one back (its
            # mark left as it is, so that Mac doesn't put its own there again).
            if mine; then
              [ "$(cat "$K/bin/.kuvo-boot" 2>/dev/null)" = "$boot" ] || exec sh "$K/bin/kuvo-start" keep
            else
              boot=$(cat "$K/bin/.kuvo-boot" 2>/dev/null)
            fi
            # COMPAT(0.7 files): the box tools put back from bin/.own. Goes 3 months after 0.8.0.
            # An older Kuvo Code on a Mac (which touches run/attached as it connects) put its own
            # tools over the box's since the box was last marked: the box's back, as the Kuvo Code
            # that marked it put them there (bin/.own). Not while a Mac puts its files in place, or
            # the box updates itself.
            if [ -d "$K/bin/.own" ] && [ "$R/attached" -nt "$K/bin/box-version" ] && [ ! -d "$R/.updating" ] && [ -z "$(find "$R/mac-installing" -mmin -60 2>/dev/null)" ]; then
              for f in "$K"/bin/.own/*; do
                n=${f##*/}; t="$K/bin/$n"
                [ -f "$f" ] && { [ ! -f "$t" ] || [ "$f" -nt "$t" ] || [ "$t" -nt "$f" ]; } || continue
                if cmp -s "$f" "$t"; then touch -r "$f" "$t"; else cp -p "$f" "$K/bin/.$n.new" && mv -f "$K/bin/.$n.new" "$t"; fi
              done 2>/dev/null
            fi
            # COMPAT(0.7 engine-stop): run/stopped taken away once an older Mac started the engine. Goes 3 months after 0.8.0.
            # Running though stopped: an older Kuvo Code on a Mac, which doesn't know Stop, started
            # it as it connected. It runs, so it isn't stopped (under the lock, so a stop under way
            # finishes first).
            if [ -f "$R/stopped" ] && up && lock 1; then
              up && rm -f "$R/stopped"
              rmdir "$R/.launching" 2>/dev/null
            fi
            now=$(date +%s)
            if ! up && [ ! -f "$R/stopped" ] && [ -f "$R/launch.env" ] && [ "$now" -ge "$next" ]; then
              # Down: one this started that ran under ten minutes counts as failing, and makes it
              # wait longer before the next start; one that ran longer starts the count again.
              if [ -n "$started" ]; then
                if [ $((now - started)) -lt 600 ]; then fails=$((fails + 1)); else fails=0; fi
              fi
              sh "$me" engine >/dev/null 2>&1
              if up; then started=$now; else started=; fails=$((fails + 1)); fi
              case $fails in 0) wait=0 ;; 1) wait=15 ;; 2) wait=30 ;; 3) wait=60 ;; 4) wait=120 ;; 5) wait=300 ;; *) wait=600 ;; esac
              next=$((now + wait))
            fi
            # Down and waiting for its next start: when, for the box to tell whoever asks.
            if ! up && [ ! -f "$R/stopped" ] && [ "$next" -gt "$now" ]; then
              [ "$(cat "$R/engine.retry" 2>/dev/null)" = "$next" ] || { echo "$next" >"$R/engine.retry.new" && mv -f "$R/engine.retry.new" "$R/engine.retry"; }
            else
              rm -f "$R/engine.retry"
            fi
            # An update whose new link never said it's well (it doesn't start, the machine went
            # down halfway): after twenty minutes, back to what was there (PROTOCOL.md, "Updates").
            # Five minutes between tries; after six, it gives up and starts what's there.
            if [ -f "$R/update-trial" ] && [ -f "$K/updates/rollback/restore.sh" ]; then
              tried=$(stat -c %Y "$R/update-trial" 2>/dev/null || stat -f %m "$R/update-trial" 2>/dev/null || echo "$now")
              last=$(stat -c %Y "$R/update-restore" 2>/dev/null || stat -f %m "$R/update-restore" 2>/dev/null || echo 0)
              tries=$(cat "$R/update-restore" 2>/dev/null || echo 0)
              if [ $((now - tried)) -gt 1200 ] && [ $((now - last)) -gt 300 ]; then
                if [ "$tries" -lt 6 ]; then
                  echo $((tries + 1)) >"$R/update-restore"
                  sh "$K/updates/rollback/restore.sh" >/dev/null 2>&1 && rm -f "$R/update-restore"
                else
                  rm -f "$R/update-trial" "$R/update-restore" "$R/stopped"
                fi
              fi
            fi
            # The browser agents use here: the box sets it up itself (PROTOCOL.md, "The browser on a
            # machine"), as the keeper starts (a newer Kuvo Code may pin a newer one) and, each
            # minute, while it's missing or its last setup didn't go well, once the box says it may
            # try again (run/browser.next, which it waits longer for after each failure).
            if [ -f "$K/bin/kuvo-link.js" ] && [ -n "$V" ] && { [ "$round" -eq 0 ] || { [ $((round % 4)) -eq 0 ] && [ "$now" -ge "$(cat "$R/browser.next" 2>/dev/null || echo 0)" ] && { { [ ! -x "$K/browser/current/chrome" ] && [ ! -x "$K/browser/current/chrome-headless-shell" ]; } || ! grep -q '"state":"ready"' "$R/browser-install.json" 2>/dev/null; }; }; } && ! is "$(cat "$R/.browser-installing/pid" 2>/dev/null)" kuvo-link; then
              (environment; cd "$K"; KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$S" "$K/engine/$V/opencode" --config=/dev/null --no-env-file "$K/bin/kuvo-link.js" browser install >/dev/null 2>&1 </dev/null &)
            fi
            # The phone link, while a phone is paired with it or a pairing's open.
            if [ -f "$R/link.needed" ] && [ -f "$K/bin/kuvo-link.js" ] && [ -n "$V" ] && ! is "$(cat "$R/link.pid" 2>/dev/null)" kuvo-link; then
              (environment; cd "$K/workspace" 2>/dev/null || cd "$K"; KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$S" "$K/engine/$V/opencode" --config=/dev/null --no-env-file "$K/bin/kuvo-link.js" run >"$R/link.log" 2>&1 </dev/null &)
            fi
            # Wake-ups that are due, each minute, while the engine's up, as the engine was started:
            # beside this loop, which a slow watch never holds up, one round at a time.
            round=$((round + 1))
            if [ $((round % 4)) -eq 0 ] && up && ! is "${waking-}" kuvo-wake; then
              # COMPAT(0.7 keeper): the watchdogs an older Mac start brings, stopped. Goes 3 months after 0.8.0.
              # (Not beside the watchdog an older Mac's start brings, which would also stop the
              # engine after a day without that Mac.)
              pkill -f "watchdog [0-9]+ $R" 2>/dev/null
              # (With the box's own command, which a wake-up due in a conversation you stopped is
              # handed to, to wait there.)
              (environment; cd "$K/workspace" 2>/dev/null || cd "$K"
                if [ -f "$K/bin/kuvo-link.js" ] && [ -n "$V" ]; then
                  export KUVO_LINK_RUNTIME="$K/engine/$V/opencode" KUVO_LINK_FLAGS="--config=/dev/null --no-env-file" KUVO_LINK_SCRIPT="$K/bin/kuvo-link.js"
                fi
                exec "$K/bin/kuvo-wake" fire "$K/bots" "$R/engine.json") >/dev/null 2>&1 </dev/null &
              waking=$!
            fi
            sleep 15
          done
          ;;
        engine)
          # As Kuvo Code last started it, with a new port and passwords: not when it's stopped on
          # purpose, or running.
          [ -f "$R/stopped" ] && exit 0
          [ -f "$R/launch.env" ] && [ -f "$K/bin/kuvo-launch" ] && [ -n "$V" ] || exit 0
          up && exit 0
          notes=$(cat "$R/launch.notes" 2>/dev/null); [ -n "$notes" ] || notes='{}'
          word() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
          number() { echo $(( $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 40000 + 20000 )); }
          for try in 1 2 3; do
            port=$(number); password=$(word); record="\"port\":$port,\"password\":\"$password\",\"version\":\"$V\",\"notes\":$notes"
            agents=
            if [ -f "$K/bin/kuvo-agents.js" ]; then aport=$(number); apassword=$(word); record="$record,\"agentsPort\":$aport,\"agentsPassword\":\"$apassword\""; agents="KUVO_AGENTS_PORT=$aport
        KUVO_AGENTS_PASSWORD=$apassword"; fi
            { cat "$R/launch.env"; printf 'KUVO_BOOT=1\nKUVO_VERSION=%s\nOPENCODE_PASSWORD=%s\nKUVO_PORT=%s\nKUVO_RECORD=%s}\n' "$V" "$password" "$port" "$record"; [ -z "$agents" ] || printf '%s\n' "$agents"; printf '\n'; } | sh "$K/bin/kuvo-launch" >/dev/null 2>&1 && up && exit 0
            [ -f "$R/stopped" ] && exit 0
            sleep 2
          done
          exit 1
          ;;
        start)
          rm -f "$R/stopped"
          sh "$K/bin/kuvo-start" engine
          sh "$K/bin/kuvo-start" box
          up
          ;;
        stop)
          # Under the lock, so a start under way finishes first, and then stays stopped.
          lock || { echo "A start of the engine is under way there." >&2; exit 4; }
          trap 'rmdir "$R/.launching" 2>/dev/null' EXIT
          touch "$R/stopped"
          halt
          ;;
        restart)
          rm -f "$R/stopped"
          lock || { echo "A start of the engine is under way there." >&2; exit 4; }
          halt
          rmdir "$R/.launching" 2>/dev/null
          sh "$K/bin/kuvo-start" engine
          sh "$K/bin/kuvo-start" box
          up
          ;;
        off)
          # Everything it runs, for good (the machine removed, a demo copy done): the phone link
          # first, which would start the keeper again, then the keeper, which would start the
          # rest again, then the engine and its agents' bridge. Then it's as before its first
          # start, for when it's added again.
          touch "$R/stopped"
          rm -f "$R/link.needed"
          l=$(cat "$R/link.pid" 2>/dev/null); is "$l" kuvo-link && kill "$l" 2>/dev/null
          b=$(cat "$R/box.pid" 2>/dev/null); is "$b" kuvo-start && kill "$b" 2>/dev/null; rm -f "$R/box.pid"
          if lock 600; then halt; rmdir "$R/.launching" 2>/dev/null; else halt; fi
          rm -f "$R/stopped"
          ;;
        esac
        """#
    }

    /// Puts `kuvo-launch` and `kuvo-start` in the machine's `bin` (unless it has these ones
    /// already), apart from the launch, whose command line has a size limit.
    /// The keeper, its launcher and what starts them in a session of their own (a Mac has no
    /// `setsid`), by their names in `bin`, and what `.kuvo-boot` says of them.
    static var bootFiles: (files: [(name: String, text: String)], hash: String) {
        let files = [("kuvo-launch", bootLaunchScript), ("kuvo-start", bootScript), ("kuvo-setsid", RemoteProcess.setsidScript)]
        return (files, SHA256.hash(data: Data(files.map { $0.0 + "\n" + $0.1 }.joined(separator: "\n").utf8)).map { String(format: "%02x", $0) }.joined())
    }

    public static func installBoot(on connection: SSHConnection, while wanted: @Sendable () async -> Bool = { true }) async throws {
        let (files, hash) = bootFiles
        let marker = "\"$HOME/\(RemoteEngineInstaller.root)/bin/.kuvo-boot\""
        if try await connection.run("cat \(marker) 2>/dev/null || true").trimmingCharacters(in: .whitespacesAndNewlines) == hash { return }
        guard await wanted() else { throw CancellationError() }
        let input = FileManager.default.temporaryDirectory.appending(path: "kuvo-boot-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: input) }
        try Data((files.map { $0.0 + "\t" + Data($0.1.utf8).base64EncodedString() }.joined(separator: "\n") + "\n").utf8).write(to: input)
        try await connection.run(BoxVersion.guardScript + "\n" + """
            B="$HOME/\(RemoteEngineInstaller.root)/bin"; mkdir -p "$B" || exit 1
            t="$(printf '\\t')"
            while IFS="$t" read -r name body; do
              printf '%s' "$body" | base64 -d >"$B/$name.new" && chmod 700 "$B/$name.new" && mv -f "$B/$name.new" "$B/$name" || exit 1
            done
            printf '%s' \(hash) >"$B/.kuvo-boot"
            """, input: input)
    }

    /// Reads the settings from the input, gives the engine its own folders, starts it, and so on
    /// (see `launchScript`); `boot`, as `kuvo-start` runs it.
    private static func launch(boot: Bool) -> String {
        """
        \(boot ? "" : "kuvo_env=$(env | grep -E '^(PATH|SHELL|LANG|LC_[A-Z_]+)=' || true)")
        lines=
        while IFS= read -r line && [ -n "$line" ]; do export "$line"; lines="$lines$line
        "; done
        port=$KUVO_PORT; record=$KUVO_RECORD; unset KUVO_PORT KUVO_RECORD
        aport=${KUVO_AGENTS_PORT-}; unset KUVO_AGENTS_PORT
        replace=${KUVO_REPLACE-}; starting=${KUVO_START-}; unset KUVO_REPLACE KUVO_START
        \(boot ? "V=${KUVO_VERSION:-\(OpenCodeEngine.version)}; unset KUVO_VERSION" : "V=\(OpenCodeEngine.version)")
        \(RemoteEngineInstaller.folders)
        R="$K/run"; mkdir -p "$R"; chmod 700 "$R"
        \(RemoteProcess.check)
        \(RemoteProcess.session)
        # One launch at a time; one left by a launch that was cut off goes after five minutes (a
        # launch takes three at most). Never one without it.
        i=0
        until mkdir "$R/.launching" 2>/dev/null; do
          [ -z "$(find "$R/.launching" -maxdepth 0 -mmin +5 2>/dev/null)" ] || rmdir "$R/.launching" 2>/dev/null
          i=$((i + 1))
          [ $i -lt 2400 ] || \(boot ? "exit 0" : "{ echo \"Another start of the engine is under way there.\" >&2; exit 4; }")
          sleep 0.1
        done
        # The lock goes as it ends, and an engine it started but didn't get to note with it: nothing
        # else would know to stop that one.
        trap 'rmdir "$R/.launching" 2>/dev/null; [ -z "${pid-}" ] || [ -n "${noted-}" ] || kill "$pid" 2>/dev/null' EXIT
        trap 'exit 1' HUP INT TERM PIPE
        # COMPAT(0.7 engine-stop): an engine an older Mac stopped stays down until Start. Goes 3 months after 0.8.0.
        # Stopped on purpose (Stop, from the Mac or a phone): it stays stopped, unless this is Start.
        if [ -f "$R/stopped" ]; then
          \(boot ? "exit 0" : "if [ -n \"$starting\" ]; then rm -f \"$R/stopped\"; else echo \"Its engine is stopped.\" >&2; exit 6; fi")
        fi
        # One that started meanwhile (after a restart, or for another Mac) is used as it is; from
        # the Mac, the one it found to replace (another version, other settings), and only that
        # one, is stopped here, under the lock, so nothing starts one in between.
        old=$(sed -n 's/^{"pid":\\([0-9]*\\),.*/\\1/p' "$R/engine.json" 2>/dev/null)
        if kuvo_runs "$old" "$K/engine/"; then
          \(boot ? "exit 0" : "[ \"$replace\" = \"$old\" ] || { echo \"An engine runs there now.\" >&2; exit 5; }")
          \(boot ? "" : stopAgentsScript)
          \(boot ? "" : "kill \"$old\"; n=0; while kill -0 \"$old\" 2>/dev/null && [ $n -lt 100 ]; do sleep 0.1; n=$((n + 1)); done; kill -0 \"$old\" 2>/dev/null && kill -9 \"$old\" 2>/dev/null; rm -f \"$R/engine.json\"")
        fi
        \(boot ? "unset KUVO_BOOT" : "rm -rf \"$K/keys\"")
        # COMPAT(0.7 settings): the settings an older Mac still sends, left out. Goes 3 months after 0.8.0.
        # A box of its own (KuvoLink's PROTOCOL.md, "Settings per box"): its own settings and keys,
        # in `box`, never a Mac's, which an older Mac may still send. What's below them goes as
        # this start begins, the engine that read it gone: the Mac's copy, and the global file once
        # it came into the box whole.
        if [ -f "$K/box/opencode.json" ]; then
          unset KUVO_SETTINGS \(privateSettingsVariable)
          rm -f "$K/keys/settings.json"
          [ -f "$K/box/global-adopted" ] && mkdir -p "$K/config/opencode" && (umask 077; printf '{}\\n' >"$K/config/opencode/opencode.json")
        fi
        # Its settings only once it's the start that goes ahead: one that finds an engine running
        # (another Mac's, started at the same moment) leaves that one's as they are.
        if [ -n "${KUVO_SETTINGS+set}" ]; then
          mkdir -p "$K/config/opencode" && (umask 077; printf '%s\\n' "$KUVO_SETTINGS" >"$K/config/opencode/opencode.json")
          unset KUVO_SETTINGS
        fi
        mkdir -p "$K/keys"; chmod 700 "$K/keys"
        for v in $(env | sed -n 's/^\\(KUVO_KEY_[A-Za-z0-9_]*\\)=.*/\\1/p'); do
          (umask 077; printf '%s' "$(printenv "$v")" >"$K/keys/$v"); unset "$v"
        done
        if [ -n "${\(privateSettingsVariable)+set}" ]; then
          (umask 077; printenv \(privateSettingsVariable) >"$K/keys/settings.json")
          unset \(privateSettingsVariable)
        fi
        [ -f "$K/keys/settings.json" ] && export OPENCODE_CONFIG="$K/keys/settings.json"
        [ -f "$K/box/opencode.json" ] && export OPENCODE_CONFIG="$K/box/opencode.json"
        # What the engine starts with, as its box gives it (its link's `engine-config`), which also
        # puts what some providers need from the engine, as the box learned it, beside its
        # settings: after a restart with no Mac there too. A box too old to know it starts as before.
        if [ -f "$K/bin/kuvo-link.js" ]; then
          c=$(cd "$K" && KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$K/engine/$V/opencode" --config=/dev/null --no-env-file "$K/bin/kuvo-link.js" engine-config 2>/dev/null) && case "$c" in "{"*"}") export OPENCODE_CONFIG_CONTENT="$c" ;; esac
        fi
        \(boot ? "" : Wakes.installScript)
        \(boot ? "" : Launcher.installScript)
        \(boot ? "" : CommandEnvironment.installScript)
        # The PATH your login shell sets up there (`~/.local/bin`, nvm's node), which a start over
        # SSH or from cron doesn't get, for the engine and what it starts, as the box reads it (its
        # link's `login-path`). Without it (a box too old to know it), the PATH it has.
        if [ -f "$K/bin/kuvo-link.js" ]; then
          p=$(cd "$K" && KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$K/engine/$V/opencode" "$K/bin/kuvo-link.js" login-path 2>/dev/null </dev/null) && case "$p" in /*) PATH=$p ;; esac
        fi
        export PATH="$K/bin:$PATH"
        # Bots' and sessions' folders under this root, for `kuvo-wake` (its default is the app's own root).
        export KUVO_BOTS="$K/bots" KUVO_WAKES="$K/wakes"
        cd "$K/workspace"
        env -u KUVO_AGENTS_PASSWORD -u BUN_BE_BUN "$S" "$K/engine/$V/opencode" serve --port "$port" --hostname 127.0.0.1 >"$R/engine.log" 2>&1 </dev/null &
        pid=$!
        i=0
        until grep -q "server listening" "$R/engine.log" 2>/dev/null; do
          if ! kill -0 "$pid" 2>/dev/null || [ $i -ge 900 ]; then tail -n 5 "$R/engine.log" >&2; kill "$pid" 2>/dev/null; exit 3; fi
          sleep 0.1; i=$((i + 1))
        done
        # Noted, or it's stopped (by the trap): one nothing knows of would run on unseen.
        (umask 077; printf '{"pid":%s,%s\\n' "$pid" "$record" >"$R/engine.json") || { echo "Its engine couldn't be noted down there." >&2; exit 3; }
        noted=1
        \(agentsScript)
        \(boot ? "" : startAgainScript)
        # The box's keeper, which keeps it all running from here on (the phone link, wake-ups, the
        # engine itself after a crash or a restart): once.
        [ -f "$K/bin/kuvo-start" ] && sh "$K/bin/kuvo-start" box
        echo "$pid${aport:+ $aport}"
        """
    }

    /// After a start from the Mac: how it started (but its port, passwords and keys), for
    /// `kuvo-start`, with the session's PATH, shell and language, which cron doesn't give it; and,
    /// for Kuvo Code's own folder, what runs it after a restart, added once: the crontab line,
    /// and on a Mac its launch agent too. A crontab that can't be read is left as it is, never
    /// written over.
    private static var startAgainScript: String {
        """
        (umask 077; { printf '%s\\n' "$kuvo_env"; printf '%s' "$lines" | grep -v -E '^(OPENCODE_PASSWORD|KUVO_PORT|KUVO_RECORD|KUVO_AGENTS_PORT|KUVO_AGENTS_PASSWORD|KUVO_BOOT|KUVO_VERSION|KUVO_REPLACE|KUVO_START|KUVO_SETTINGS|\(privateSettingsVariable)|KUVO_KEY_[A-Za-z0-9_]*)='; } | grep -v '^$' >"$R/launch.env.new"; mv -f "$R/launch.env.new" "$R/launch.env")
        (umask 077; printf '%s' "$record" | sed -n 's/.*"notes":\\({[^}]*}\\).*/\\1/p' >"$R/launch.notes")
        \(RemoteEngineInstaller.root == ".kuvo-code" ? rebootCrontabScript + "\n" + launchAgentScript : "")
        """
    }

    /// `cron_tab`, `crontab` given a while, where `perl` can see to it: what runs it waits, and all that
    /// waits on that, should macOS ask something on a screen nobody's at.
    private static let limitedCrontab = #"cron_tab() { if command -v perl >/dev/null 2>&1; then perl -e 'alarm 15; exec @ARGV' crontab "$@"; else crontab "$@"; fi; }"#

    /// Adds `rebootLine` to the machine's crontab, once, keeping what's there; a crontab that
    /// can't be read (for another reason than there being none) is left alone. On a Mac, cron can
    /// write it only where Remote Login has full disk access; it's what starts the box there with
    /// nobody logged in, and where it can't, the launch agent starts it once someone is.
    static var rebootCrontabScript: String {
        """
        if command -v crontab >/dev/null 2>&1; then
          \(limitedCrontab)
          cron_now=$(cron_tab -l 2>"$R/.crontab.err"); cron_read=$?
          if [ $cron_read -eq 0 ] || grep -qi 'no crontab' "$R/.crontab.err" 2>/dev/null; then
            case "$cron_now" in
              *"\(rebootTag)"*) ;;
              *) { [ -z "$cron_now" ] || printf '%s\\n' "$cron_now"; printf '%s\\n' \(SSHConnection.quoted(rebootLine)); } | cron_tab - >/dev/null 2>&1 ;;
            esac
          fi
          rm -f "$R/.crontab.err"
        fi
        """
    }

    /// The launch agent that starts the box as you log in to a Mac (automatically, on one set to):
    /// its one file outside `~/.kuvo-code`, as the crontab line is on Linux. launchd reads it by itself.
    static let launchAgent = "run.kuvo.code.machine"

    /// The agent's file.
    static var launchAgentPlist: String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
        <key>Label</key><string>\(launchAgent)</string>
        <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>exec sh "$HOME/\(RemoteEngineInstaller.root)/bin/kuvo-start"</string></array>
        <key>RunAtLoad</key><true/>
        <key>AbandonProcessGroup</key><true/>
        </dict>
        </plist>
        """
    }

    /// Puts the launch agent in place on a Mac, once.
    static var launchAgentScript: String {
        """
        if [ "$(uname -s)" = Darwin ] && [ ! -f "$HOME/Library/LaunchAgents/\(launchAgent).plist" ]; then
          mkdir -p "$HOME/Library/LaunchAgents" && printf '%s\\n' \(SSHConnection.quoted(launchAgentPlist)) >"$HOME/Library/LaunchAgents/\(launchAgent).plist"
        fi
        """
    }

    /// Takes the launch agent away again, if this home has it: `launchctl` is the account's, whatever
    /// `$HOME` says, so a test's or another home's removal never reaches one it didn't add.
    static var launchAgentRemovalScript: String {
        """
        if [ "$(uname -s)" = Darwin ] && [ -f "$HOME/Library/LaunchAgents/\(launchAgent).plist" ]; then
          launchctl bootout "gui/$(id -u)/\(launchAgent)" >/dev/null 2>&1
          rm -f "$HOME/Library/LaunchAgents/\(launchAgent).plist"
        fi
        """
    }

    /// Takes `rebootLine` out of the machine's crontab as the machine is removed, keeping the
    /// rest: only from Kuvo Code's own folder (a test's or a demo copy's never added it, and
    /// leaves the app's).
    public static var rebootCrontabRemoval: String {
        RemoteEngineInstaller.root == ".kuvo-code" ? crontabRemovalScript + "\n" + launchAgentRemovalScript : ""
    }

    static var crontabRemovalScript: String {
        """
        \(limitedCrontab)
        if command -v crontab >/dev/null 2>&1 && cron_now=$(cron_tab -l 2>/dev/null); then
          case "$cron_now" in *"\(rebootTag)"*) printf '%s\\n' "$cron_now" | grep -vF \(SSHConnection.quoted(rebootTag)) | cron_tab - >/dev/null 2>&1 ;; esac
        fi
        """
    }

    /// Connects to `engine` through a tunnel of its own, and waits until it answers. `onExit` is
    /// called if the tunnel closes without being asked to.
    public static func attach(
        to engine: Engine,
        on connection: SSHConnection,
        timeout: Duration = .seconds(90),
        onExit: @escaping @Sendable (Int32) -> Void = { _ in }
    ) async throws -> RemoteServer {
        let localPort = try freeLocalPort()
        var forwards = ["-o", "ExitOnForwardFailure=yes", "-L", "\(localPort):127.0.0.1:\(engine.port)"]
        // The agents bridge beside it, through the same connection.
        var agentsEndpoint: ServerEndpoint?
        if let agents = engine.agents {
            let agentsPort = try freeLocalPort(besides: localPort)
            forwards += ["-L", "\(agentsPort):127.0.0.1:\(agents.port)"]
            agentsEndpoint = ServerEndpoint(url: URL(string: "http://127.0.0.1:\(agentsPort)")!, password: agents.password)
        }

        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/ssh")
        // Not `-N`: a command on the machine that reads this app's end of a pipe, so the tunnel
        // ends when the app does, however it ends (a crash, a force quit), like this Mac's engine.
        process.arguments = connection.unreachable + SSHConnection.options + SSHConnection.separate + forwards + [connection.address, "cat >/dev/null"]
        process.standardInput = Pipe.unshared()
        process.standardOutput = FileHandle.nullDevice
        let stderr = Pipe.unshared()
        process.standardError = stderr
        let log = LogTail()
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { log.append(data) }
        }
        let exits = ExitSignal()
        // How it ended, from its handler: never `waitUntilExit`, which can miss it.
        let ended = Arrival<Int32>()
        process.terminationHandler = { process in
            ended.deliver(process.terminationStatus)
            if exits.fire() { onExit(process.terminationStatus) }
        }
        try process.run()

        let endpoint = ServerEndpoint(url: URL(string: "http://127.0.0.1:\(localPort)")!, password: engine.password)
        let client = HTTPClient(endpoint: endpoint)
        struct Info: Decodable { var version: String }
        let deadline = ContinuousClock.now + timeout
        do {
            while true {
                if !process.isRunning {
                    guard let status = await ended.wait() else { throw CancellationError() }
                    throw RemoteEngineError.exited(status: status, output: log.text.trimmingCharacters(in: .whitespacesAndNewlines))
                }
                if (try? await client.send(client.request("GET", "api/info"), as: Info.self)) != nil { break }
                if ContinuousClock.now > deadline { throw RemoteEngineError.timedOut }
                try await Task.sleep(for: .milliseconds(150))
            }
        } catch {
            // Given up on, or cancelled (a reconnect called off): the tunnel goes with it.
            _ = exits.fire()
            if process.isRunning { process.terminate() }
            throw error
        }
        return RemoteServer(engine: engine, endpoint: endpoint, agentsEndpoint: agentsEndpoint, connection: connection, tunnel: process, log: log)
    }

    /// Closes the tunnel. The engine keeps running on the machine.
    public func disconnect() {
        tunnel.terminationHandler = nil
        if tunnel.isRunning { tunnel.terminate() }
    }

    deinit { disconnect() }

    /// Starts the agents bridge beside the engine (`$pid`, listening on `$port`), when it's asked
    /// for (`$aport`, and its password in the environment) and on the machine: in a session of its
    /// own, from the engine's workspace, with everything it keeps in `$K/agents`; an older one there
    /// stops first. It stops by itself when the engine does; one that stops otherwise (it crashed)
    /// starts again, a few times in a row (one that ran ten minutes or more starts the count again). A port someone else has (it says so, exiting 98) gives way to
    /// another, written in the engine's record and said with its process (`$aport`). What runs it
    /// is kept in `run/agents.pid`.
    static var agentsScript: String {
        """
        if [ -n "$aport" ] && [ -n "${KUVO_AGENTS_PASSWORD-}" ] && [ -f "$K/bin/kuvo-agents.js" ]; then
          \(stopAgentsScript)
          mkdir -p "$K/agents" && chmod 700 "$K/agents"
          try=0
          while :; do
            : >"$R/agents.log"
            KUVO_AGENTS_REMOTE=1 KUVO_AGENTS_HOME="$K/agents" KUVO_HOME="$K" KUVO_AGENTS_PORT="$aport" KUVO_ENGINE_PORT="$port" KUVO_ENGINE_PID="$pid" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$S" sh -c 'n=0; while kill -0 "$1" 2>/dev/null && [ $n -lt 5 ]; do s=$(date +%s); "$2" --config=/dev/null --no-env-file "$3" >>"$4" 2>&1 </dev/null; e=$?; [ $e -eq 98 ] && exit 98; [ $(($(date +%s) - s)) -ge 600 ] && n=0; n=$((n + 1)); sleep 5; done' kuvo-agents "$pid" "$K/engine/$V/opencode" "$K/bin/kuvo-agents.js" "$R/agents.log" </dev/null >/dev/null 2>&1 &
            apid=$!
            echo "$apid" >"$R/agents.pid"
            i=0; until grep -q '"url"' "$R/agents.log" 2>/dev/null || ! kill -0 "$apid" 2>/dev/null || [ $i -ge 100 ]; do sleep 0.1; i=$((i + 1)); done
            kill -0 "$apid" 2>/dev/null && break
            try=$((try + 1)); [ $try -ge 3 ] && break
            old=$aport; aport=$(( $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 40000 + 20000 ))
            (umask 077; sed "s/\\"agentsPort\\":$old\\([,}]\\)/\\"agentsPort\\":$aport\\1/" "$R/engine.json" >"$R/engine.json.new" && mv -f "$R/engine.json.new" "$R/engine.json")
          done
        fi
        unset KUVO_AGENTS_PASSWORD
        """
    }

    /// Stops the agents bridge running there, if one is (needs `$R`), and waits a moment for it to
    /// put away what it has.
    static var stopAgentsScript: String {
        """
        apid=$(cat "$R/agents.pid" 2>/dev/null)
        if kuvo_runs "$apid" kuvo-agents; then kill -- "-$apid" 2>/dev/null || kill "$apid" 2>/dev/null; i=0; while kill -0 "$apid" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i + 1)); done; fi
        rm -f "$R/agents.pid"
        """
    }

    /// Everything the box runs, stopped for good (the machine removed, a test done): its keeper
    /// first, so it starts nothing again, then the phone link, the engine and its agents bridge.
    /// On a machine without the keeper's script yet, as before: the agents bridge and the engine.
    static var stopScript: String {
        """
        K="$HOME/\(RemoteEngineInstaller.root)"; R="\(run)"
        \(RemoteProcess.check)
        # COMPAT(0.7 keeper): a box whose kuvo-start has no off case, stopped the old way. Goes 3 months after 0.8.0.
        # Its keeper's script, if it's one that knows `off` (an older one would start the engine).
        if grep -q '^off)' "$K/bin/kuvo-start" 2>/dev/null; then sh "$K/bin/kuvo-start" off; exit 0; fi
        \(stopAgentsScript)
        [ -f "$R/engine.json" ] || exit 0
        pid=$(sed -n 's/^{"pid":\\([0-9]*\\),.*/\\1/p' "$R/engine.json")
        kuvo_runs "$pid" opencode && kill "$pid"
        rm -f "$R/engine.json"
        """
    }

    /// What stops everything there, as part of a longer script (in a shell of its own).
    public static var stopCommand: String { "(\n" + stopScript + "\n)" }

    /// Stops everything the box runs on the machine, for good (see `stopScript`).
    public static func stop(on connection: SSHConnection) async throws {
        try await connection.run(stopScript)
    }

    // COMPAT(0.7 engine-stop): Start, for an engine an older Mac stopped. Goes 3 months after 0.8.0.
    /// Starts the machine's engine after a stop, as it was last started there (Start). False when
    /// it didn't come up.
    @discardableResult
    public static func startEngine(on connection: SSHConnection) async throws -> Bool {
        try await installBoot(on: connection)
        return (try? await connection.run("sh \"$HOME/\(RemoteEngineInstaller.root)/bin/kuvo-start\" start")) != nil
    }

    /// Starts the machine's engine over, as it was last started there (Restart). False when it
    /// didn't come up. `wanted`, asked before each step after the first: no longer (the machine
    /// removed meanwhile), and nothing more goes there.
    @discardableResult
    public static func restartEngine(on connection: SSHConnection, while wanted: @Sendable () async -> Bool) async throws -> Bool {
        try await installBoot(on: connection, while: wanted)
        guard await wanted() else { return false }
        return (try? await connection.run("sh \"$HOME/\(RemoteEngineInstaller.root)/bin/kuvo-start\" restart")) != nil
    }

    /// Stops everything there without waiting more than `timeout`, for when the app quits (a demo
    /// or test copy's machine, which leaves nothing running).
    public static func stopNow(on connection: SSHConnection, timeout: TimeInterval = 3) {
        runNow(stopScript, on: connection, timeout: timeout)
    }

    /// Runs `script` on the machine without waiting more than `timeout`, for when the app quits.
    public static func runNow(_ script: String, on connection: SSHConnection, timeout: TimeInterval = 3) {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/ssh")
        process.arguments = connection.arguments(running: script)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return }
        let deadline = Date.now.addingTimeInterval(timeout)
        while process.isRunning, Date.now < deadline { usleep(50_000) }
        if process.isRunning { process.terminate() }
    }

    /// A port nobody on this Mac is listening on right now, other than `taken`.
    static func freeLocalPort(besides taken: Int) throws -> Int {
        for _ in 0..<5 {
            let port = try freeLocalPort()
            if port != taken { return port }
        }
        throw POSIXError(.EADDRINUSE)
    }

    /// A port nobody on this Mac is listening on right now.
    static func freeLocalPort() throws -> Int {
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { throw POSIXError(.EMFILE) }
        defer { close(socket) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = 0
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socket, $0, length) == 0 && getsockname(socket, $0, &length) == 0
            }
        }
        guard bound else { throw POSIXError(.EADDRINUSE) }
        return Int(UInt16(bigEndian: address.sin_port))
    }
}

/// True the first time only: whichever comes first of the tunnel closing and giving up on it.
final class ExitSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false

    func fire() -> Bool {
        lock.withLock {
            defer { fired = true }
            return !fired
        }
    }
}

#endif

/// Launch files an earlier run of the app left when it stopped mid-launch: they hold every key
/// and the engine's password. Cleared once, before the first launch.
private let clearedLeftovers: Void = {
    let folder = FileManager.default.temporaryDirectory
    let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
    for name in names where name.hasPrefix("kuvo-engine-") {
        let file = folder.appending(path: name)
        let changed = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        if changed.timeIntervalSinceNow < -600 { try? FileManager.default.removeItem(at: file) }
    }
}()
