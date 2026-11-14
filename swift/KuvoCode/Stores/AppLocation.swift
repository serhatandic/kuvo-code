import AppKit

/// Opened from the disk image (or from where macOS runs a download it hasn't vetted, a read-only
/// copy), Kuvo Code can't update itself: Sparkle won't install into a read-only place. So it offers
/// to move to Applications and open from there.
@MainActor
enum AppLocation {
    private static let declinedKey = "moveToApplications.declined"

    /// Asks once a launch, until you move it or tick Don't Ask Again. Only builds that update
    /// themselves ask (see Updates).
    static func offerMove() {
        var applications = URL(filePath: "/Applications", directoryHint: .isDirectory)
        #if DEBUG
        // KUVO_DEMO_APPLICATIONS=<folder>: a debug copy asks too, and moves there instead.
        if let folder = ProcessInfo.processInfo.environment["KUVO_DEMO_APPLICATIONS"] {
            applications = URL(filePath: folder, directoryHint: .isDirectory)
        } else if Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") == nil {
            return
        }
        #else
        guard Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil else { return }
        #endif
        let running = Bundle.main.bundleURL
        guard isReadOnly(running), !UserDefaults.standard.bool(forKey: declinedKey) else { return }
        let source = originalLocation(of: running) ?? running
        let fromDiskImage = source.path.hasPrefix("/Volumes/") && isReadOnly(source)
        let destination = applications.appending(path: source.lastPathComponent, directoryHint: .isDirectory)
        // In Applications already, run from a hidden copy because it came as a download (and
        // wasn't moved there by Finder): nothing to move, only that to clear.
        let inPlace = source.resolvingSymlinksInPath().path == destination.resolvingSymlinksInPath().path

        let alert = NSAlert()
        if inPlace {
            alert.messageText = "Open \(AppInfo.name) again from Applications?"
            alert.informativeText = "macOS runs it from a temporary copy, as it does a download it hasn't seen opened, so it can't update itself. Opened again, it runs from your Applications folder."
            alert.addButton(withTitle: "Open Again")
        } else {
            alert.messageText = "Move \(AppInfo.name) to Applications?"
            alert.informativeText = fromDiskImage
                ? "It's open from the disk image, so it can't update itself, and it's gone once you eject the disk image. Moved to your Applications folder, it opens from there."
                : "It's open from where it was downloaded, so it can't update itself. Moved to your Applications folder, it opens from there."
            alert.addButton(withTitle: "Move to Applications")
        }
        alert.addButton(withTitle: "Not Now")
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "Don't ask again"
        // Asked before the window opens, so it comes forward to be seen.
        if !AppInfo.staysInBackground { NSApp.activate() }
        let answer = alert.runModal()
        if alert.suppressionButton?.state == .on { UserDefaults.standard.set(true, forKey: declinedKey) }
        guard answer == .alertFirstButtonReturn else { return }

        if inPlace {
            clearDownloadMark(destination)
            relaunch(destination, ejecting: nil)
            return
        }
        do {
            try move(source, to: destination)
        } catch {
            let failed = NSAlert()
            failed.alertStyle = .warning
            failed.messageText = "\(AppInfo.name) couldn't move itself"
            failed.informativeText = "\(error.localizedDescription) Drag it to your Applications folder in Finder instead."
            failed.runModal()
            NSWorkspace.shared.activateFileViewerSelecting([source])
            return
        }
        relaunch(destination, ejecting: fromDiskImage ? volume(of: source) : nil)
    }

    /// Into Applications, in place of a copy that's there already (to the Trash, quit first if
    /// it's open), and opened from there without macOS asking again whether to open a download.
    /// The new copy is made beside it first: if that fails (a full disk), the one there stays.
    static func move(_ source: URL, to destination: URL) throws {
        let files = FileManager.default
        let replaces = files.fileExists(atPath: destination.path)
        if replaces, Bundle(url: destination)?.bundleIdentifier != Bundle.main.bundleIdentifier {
            throw MoveError("Your Applications folder has another app named \(destination.lastPathComponent).")
        }
        // A read-only disk image keeps its copy; a download's copy moves.
        let readOnly = isReadOnly(source)
        let staged = destination.deletingLastPathComponent().appending(path: ".\(destination.lastPathComponent).new-\(UUID().uuidString.prefix(8))")
        if readOnly {
            try files.copyItem(at: source, to: staged)
        } else {
            try files.moveItem(at: source, to: staged)
        }
        do {
            if replaces {
                try quitCopy(at: destination)
                try files.moveToTrash(destination)
            }
            try files.moveItem(at: staged, to: destination)
        } catch {
            // As it was: the download back where it was, the copy from the disk image gone.
            if readOnly { try? files.removeItem(at: staged) } else { try? files.moveItem(at: staged, to: source) }
            throw error
        }
        clearDownloadMark(destination)
    }

    /// You opened it already: opened again from Applications, it isn't a new download, so macOS
    /// neither asks again nor runs it from a temporary copy.
    private static func clearDownloadMark(_ app: URL) {
        let inside = FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL } ?? []
        for file in [app] + inside {
            removexattr(file.path, "com.apple.quarantine", XATTR_NOFOLLOW)
        }
    }

    /// Asks the copy in Applications to quit, if it's open, and waits a little for it.
    private static func quitCopy(at destination: URL) throws {
        let open = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0 != .current && $0.bundleURL?.standardizedFileURL == destination.standardizedFileURL }
        guard !open.isEmpty else { return }
        for app in open { app.terminate() }
        let deadline = Date.now.addingTimeInterval(10)
        while open.contains(where: { !$0.isTerminated }), Date.now < deadline {
            RunLoop.current.run(until: .now.addingTimeInterval(0.1))
        }
        if open.contains(where: { !$0.isTerminated }) {
            throw MoveError("The \(AppInfo.name) in your Applications folder is still open.")
        }
    }

    /// Opens the moved copy once this one has quit, ejecting the disk image it ran from.
    private static func relaunch(_ app: URL, ejecting volume: URL?) {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = [
            "-c",
            #"while /bin/kill -0 "$1" 2>/dev/null; do /bin/sleep 0.2; done; [ -n "$3" ] && /usr/bin/hdiutil detach -quiet "$3"; /usr/bin/open $4 "$2""#,
            "sh", String(ProcessInfo.processInfo.processIdentifier), app.path, volume?.path ?? "", AppInfo.staysInBackground ? "-g" : "",
        ]
        do {
            try process.run()
        } catch {
            NSWorkspace.shared.activateFileViewerSelecting([app])
            return
        }
        NSApp.terminate(nil)
    }

    private static func isReadOnly(_ url: URL) -> Bool {
        var info = statfs()
        guard statfs(url.path, &info) == 0 else { return false }
        return info.f_flags & UInt32(MNT_RDONLY) != 0
    }

    private static func volume(of url: URL) -> URL? {
        try? url.resourceValues(forKeys: [.volumeURLKey]).volume
    }

    /// Where a copy macOS runs from a hidden place ("App Translocation") really is, from
    /// Security's own lookup.
    private static func originalLocation(of url: URL) -> URL? {
        guard url.path.contains("/AppTranslocation/"),
              let security = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY),
              let symbol = dlsym(security, "SecTranslocateCreateOriginalPathForURL") else { return nil }
        typealias OriginalPath = @convention(c) (CFURL, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Unmanaged<CFURL>?
        let original = unsafeBitCast(symbol, to: OriginalPath.self)
        return original(url as CFURL, nil)?.takeRetainedValue() as URL?
    }

    private struct MoveError: LocalizedError {
        let errorDescription: String?
        init(_ description: String) { errorDescription = description }
    }
}
