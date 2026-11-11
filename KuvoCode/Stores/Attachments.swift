import AppKit
import ClientText
import OpenCodeKit
import UniformTypeIdentifiers

/// Gets what the user attached ready for the engine. The engine gives the model text,
/// images (PNG, JPEG, GIF, WebP), PDFs and folder listings, up to 20 MB each, and drops
/// anything else. So other image formats are converted first, and files the model can't
/// take (an archive, a video, an image for a model without vision, anything too big)
/// go as paths in a note, for the agent to open with its tools.
nonisolated enum Attachments {
    static let maxBytes = 20 * 1024 * 1024
    /// The most text the coding agents' bridge puts in a message (the box's `AGENTS_TEXT_BYTES`).
    static let agentsTextBytes = 200_000
    private static let engineImageTypes: [UTType] = [.png, .jpeg, .gif, .webP]

    enum Kind { case text, image, pdf, folder, other }

    struct Prepared {
        var files: [OpenCodeAPI.PromptFile] = []
        /// Sent as paths, in the note.
        var paths: [String] = []
        /// Where the files sent with their contents are, in the note too: the model gets what's in
        /// them, and their names, but not where they are, so it went looking for them.
        var included: [String] = []
        /// Files that stayed on this Mac: they couldn't be read, or copied to the machine.
        var unsent: [String] = []
    }

    /// Where pasted images and converted copies are kept: waiting to be sent at the top, and
    /// once sent, in a folder of their session's (`claim`).
    static var directory: URL {
        AppInfo.supportDirectory.appending(path: "Attachments")
    }

    /// Where the files `session` sent are kept, so they go with it: this Mac's box deletes the
    /// folder as the session's deleted, and the app does a machine's session's.
    static func folder(for session: String) -> URL {
        directory.appending(path: session, directoryHint: .isDirectory)
    }

    /// `files` as `session` sends them: those waiting in the attachments folder (pasted, converted,
    /// written out to attach again) moved into the session's folder, and those in another
    /// session's copied there, so each session's go with it and no other's do. Your own files stay
    /// where they are.
    static func claim(_ files: [URL], for session: String) -> [URL] {
        guard isSession(session) else { return files }
        let root = directory.standardizedFileURL.path
        let own = folder(for: session)
        return files.map { url in
            guard url.isFileURL else { return url }
            let parent = url.deletingLastPathComponent().standardizedFileURL
            let waiting = parent.path == root
            let another = parent.deletingLastPathComponent().path == root && isSession(parent.lastPathComponent) && parent.lastPathComponent != session
            guard waiting || another else { return url }
            do {
                try FileManager.default.createDirectory(at: own, withIntermediateDirectories: true)
                let to = unique(url.deletingPathExtension().lastPathComponent, extension: url.pathExtension, in: own)
                if waiting { try FileManager.default.moveItem(at: url, to: to) } else { try FileManager.default.copyItem(at: url, to: to) }
                return to
            } catch {
                return url
            }
        }
    }

    /// A machine's session's files, as it's deleted (its box lets its own copies go).
    static func forget(session: String) {
        guard isSession(session) else { return }
        try? FileManager.default.removeItem(at: folder(for: session))
    }

    /// A session's ID, as its folder is named (the box names its own the same way).
    private static func isSession(_ name: String) -> Bool {
        name.hasPrefix("ses_") && (5...124).contains(name.count) && name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    }

    static func kind(of url: URL) -> Kind {
        let url = target(of: url)
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .contentTypeKey])
        if values?.isDirectory == true { return .folder }
        if let type = values?.contentType ?? UTType(filenameExtension: url.pathExtension) {
            if type.conforms(to: .image) { return .image }
            if type.conforms(to: .pdf) { return .pdf }
            if type.conforms(to: .text) { return .text }
        }
        // Makefile, .env, a log without an extension: the engine reads these as text too.
        return looksLikeText(url) ? .text : .other
    }

    /// How a file will be sent to `model`.
    enum Route {
        case content
        /// As a path, with why (shown on the composer's chip). A warning means the model
        /// would have read it, if it could.
        case path(reason: String, isWarning: Bool)
        /// Too big to send to a machine: it stays on this Mac, and the message's note says so.
        case staysHere(reason: String)
    }

    /// The composer asks again at every keystroke, and finding a file's kind can read it (one in
    /// iCloud downloads): what was found, by file and model, until a couple of hundred pile up.
    nonisolated(unsafe) private static var routes: [String: Route] = [:]
    private static let routesLock = NSLock()

    static func route(_ url: URL, for model: Model?, onMachine: Bool = false) -> Route {
        let key = url.path + "\n" + (model?.key ?? "") + (onMachine ? "\nmachine" : "")
        if let known = routesLock.withLock({ routes[key] }) { return known }
        let route = findRoute(url, for: model, onMachine: onMachine)
        routesLock.withLock {
            if routes.count > 200 { routes.removeAll() }
            routes[key] = route
        }
        return route
    }

    private static func findRoute(_ url: URL, for model: Model?, onMachine: Bool) -> Route {
        let input = model?.capabilities.input
        let name = model?.name ?? "This model"
        let size = (try? target(of: url).resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        let tooBig = Route.path(reason: "It's over 20 MB, so the agent gets its path and opens it with its tools.", isWarning: true)
        // A machine takes a file with the message, up to its limit (`prepareForMachine`); a folder
        // goes as its listing.
        if onMachine, size > maxMachineBytes, kind(of: url) != .folder {
            return .staysHere(reason: "It's over 50 MB, more than a machine takes with a message, so it stays on this Mac and the agent there can't open it.")
        }
        // The coding agents' bridge puts a text file in the message only up to its limit, and
        // never a folder's listing: those go by path (but a folder for a machine, which goes
        // there as its listing).
        let agents = OutsideAgents.runsInBridge(model?.providerID)
        switch kind(of: url) {
        case .folder:
            return agents && !onMachine ? .path(reason: "The agent gets the folder's path and looks inside with its tools.", isWarning: false) : .content
        case .text:
            if agents, size > agentsTextBytes { return .path(reason: "It's long, so the agent gets its path and opens it with its tools.", isWarning: false) }
            return size <= maxBytes ? .content : tooBig
        case .pdf:
            if input.map({ !$0.contains("pdf") }) == true { return .path(reason: "\(name) can't read PDFs, so the agent gets its path and opens it with its tools.", isWarning: true) }
            return size <= maxBytes ? .content : tooBig
        case .image:
            if input.map({ !$0.contains("image") }) == true { return .path(reason: "\(name) can't see images, so the agent gets its path instead.", isWarning: true) }
            return .content
        case .other:
            return .path(reason: "The model can't read this kind of file directly, so the agent gets its path and opens it with its tools.", isWarning: false)
        }
    }

    /// The file a symbolic link points to, or the file itself: a link's own type and size are
    /// the link's.
    private static func target(of url: URL) -> URL {
        (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]))?.isSymbolicLink == true ? url.resolvingSymlinksInPath() : url
    }

    /// Splits `urls` into files the engine gets and paths for the note, for `model`. The note
    /// names each file where it was picked; the engine reads a link's file.
    /// `folder`: where a converted copy goes (its session's).
    static func prepare(_ urls: [URL], for model: Model?, in folder: URL = directory) -> Prepared {
        var prepared = Prepared()
        for url in urls {
            let file = target(of: url)
            switch route(url, for: model) {
            case .content where kind(of: url) == .image:
                let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                if let image = engineImage(from: file, named: url.lastPathComponent, size: size, in: folder) {
                    prepared.files.append(image)
                    prepared.included.append(url.path)
                } else {
                    prepared.paths.append(url.path)
                }
            case .content:
                prepared.files.append(.init(uri: file.absoluteString, name: url.lastPathComponent))
                prepared.included.append(url.path)
            case .path, .staysHere:
                prepared.paths.append(url.path)
            }
        }
        return prepared
    }

    /// The same, for an engine on a machine, which can't read this Mac's files: each goes to the
    /// machine's box with its contents, whatever it is (a folder as its listing, as the engine lists
    /// one; a picture as the engine takes one), as a phone's do. The box keeps it there for the agent
    /// and gives the model what it reads (`MachineBox.prompt`), and its note says where. One that
    /// can't be read, or is too big to send, stays here, and the note says so.
    static func prepareForMachine(_ urls: [URL]) -> Prepared {
        var prepared = Prepared()
        var total = 0
        for url in urls {
            var file = target(of: url)
            var copy: URL?
            let kind = kind(of: url)
            if kind == .image {
                let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                if let image = engineImage(from: file, named: url.lastPathComponent, size: size), let converted = URL(string: image.uri), converted.path != file.path {
                    copy = converted
                    file = converted
                }
            }
            // A folder goes as the list of what's in it, named so.
            let name = kind == .folder ? "\(url.lastPathComponent) (list of its files).txt" : url.lastPathComponent
            let inline = inlined(file)
            // A converted copy, read now: the machine keeps its own. Only ever one made here.
            if let copy, copy.standardizedFileURL.path.hasPrefix(directory.standardizedFileURL.path + "/") { try? FileManager.default.removeItem(at: copy) }
            if let inline, total + inline.utf8.count / 4 * 3 <= maxMessageBytes {
                total += inline.utf8.count / 4 * 3
                prepared.files.append(.init(uri: inline, name: name))
            } else {
                prepared.unsent.append(url.path)
            }
        }
        return prepared
    }

    /// What a file sent to a machine can weigh, and a message's files together: the machine's box
    /// gives the model one up to `maxBytes`, and the agent a bigger one to open with its tools.
    static let maxMachineBytes = 50 * 1024 * 1024
    static let maxMessageBytes = 100 * 1024 * 1024

    /// Where on a machine, in its box's folder there, the files sent to it are kept.
    private static let machineFolder = "attachments"

    /// A file as a data URI, or a folder as the engine lists one; nil when it can't be read.
    private static func inlined(_ url: URL) -> String? {
        if kind(of: url) == .folder {
            guard let names = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey]) else { return nil }
            let entries = names.map { entry in
                let isFolder = (try? entry.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
                return (name: entry.lastPathComponent + (isFolder ? "/" : ""), isFolder: isFolder)
            }
            .sorted { $0.isFolder != $1.isFolder ? $0.isFolder : $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            return "data:text/plain;base64," + Data(entries.map(\.name).joined(separator: "\n").utf8).base64EncodedString()
        }
        guard ((try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0) <= maxMachineBytes, let data = try? Data(contentsOf: url) else { return nil }
        let type = UTType(filenameExtension: url.pathExtension)
        let mime = kind(of: url) == .text ? "text/plain" : (type?.preferredMIMEType ?? "application/octet-stream")
        return "data:\(mime);base64," + data.base64EncodedString()
    }

    /// The image as a format and size the engine takes, converting it if needed; nil when it
    /// can't be, so it goes as a path.
    private static func engineImage(from url: URL, named name: String, size: Int, in folder: URL = directory) -> OpenCodeAPI.PromptFile? {
        let type = UTType(filenameExtension: url.pathExtension)
        if size <= maxBytes, let type, engineImageTypes.contains(where: { type.conforms(to: $0) }) {
            return .init(uri: url.absoluteString, name: name)
        }
        guard let image = NSImage(contentsOf: url), let copy = save(image, named: url.deletingPathExtension().lastPathComponent, in: folder) else { return nil }
        // Still too big (a large picture with transparency stays a PNG): the engine would drop it.
        guard ((try? copy.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0) <= maxBytes else {
            try? FileManager.default.removeItem(at: copy)
            return nil
        }
        return .init(uri: copy.absoluteString, name: name)
    }

    // MARK: The note

    private static let includedHeading = AttachedFilesNote.includedHeading
    private static let pathsHeading = AttachedFilesNote.pathsHeading
    private static let unsentHeading = AttachedFilesNote.unsentHeading
    private static let note = AttachedFilesNote.block

    /// The message text with the note: where the files sent with it are, the files sent as
    /// paths, and those that couldn't be sent.
    static func text(_ text: String, for prepared: Prepared) -> String {
        let text = note.escaping(text)
        var lines: [String] = []
        if !prepared.included.isEmpty { lines += [includedHeading] + prepared.included }
        if !prepared.paths.isEmpty { lines += [pathsHeading] + prepared.paths }
        if !prepared.unsent.isEmpty { lines += [unsentHeading] + prepared.unsent }
        guard !lines.isEmpty else { return text }
        return (text.isEmpty ? "" : text + "\n\n") + ([note.start] + lines + [note.end]).joined(separator: "\n")
    }

    /// A message's text without the note that ends it, and the paths of the files it sent as
    /// paths or couldn't send (the others are the message's own files): KuvoClient's, as the phone reads it.
    static func split(_ text: String) -> (text: String, paths: [String]) {
        AttachedFilesNote.split(text)
    }

    /// The paths a message's note names that aren't among its own `files`: a message on its way
    /// has every file as picked, and its note names those sent as paths too (on a machine, as
    /// the copies there, by the same names).
    static func paths(_ paths: [String], besides files: [URL]) -> [String] {
        var own = files.filter(\.isFileURL)
        return paths.filter { path in
            let name = (path as NSString).lastPathComponent
            let match = own.firstIndex { $0.path == path }
                ?? (isMachineCopy(path) ? own.firstIndex { $0.lastPathComponent == name } : nil)
            guard let match else { return true }
            own.remove(at: match)
            return false
        }
    }

    /// The files to put back in the composer for a message: its own, then those its note names
    /// that are on this Mac (a machine's copies aren't), each once.
    static func restored(_ files: [URL], noting paths: [String]) -> [URL] {
        let named = Self.paths(paths, besides: files)
            .filter { FileManager.default.fileExists(atPath: $0) }
            .map { URL(filePath: $0, directoryHint: .checkFileSystem) }
        var seen: Set<String> = []
        return (files + named).filter { seen.insert($0.path).inserted }
    }

    /// Where a file sent to a machine was copied, there: `…/attachments/<session>/<folder>/<name>`,
    /// or before its session had a folder, `…/attachments/<folder>/<name>`.
    private static func isMachineCopy(_ path: String) -> Bool {
        let parts = path.split(separator: "/")
        guard parts.count >= 3 else { return false }
        let folder = parts[parts.count - 2]
        guard folder.count == 8, folder.allSatisfy(\.isHexDigit) else { return false }
        return parts[parts.count - 3] == machineFolder
            || parts.count >= 4 && parts[parts.count - 4] == machineFolder && isSession(String(parts[parts.count - 3]))
    }

    // MARK: Files we write

    /// Saves a pasted or converted image as PNG (JPEG for opaque photos, which would
    /// otherwise be huge), and returns where.
    static func save(_ image: NSImage, named name: String, in folder: URL = directory) -> URL? {
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
        let opaque = !bitmap.hasAlpha
        let large = bitmap.pixelsWide * bitmap.pixelsHigh > 4_000_000
        let (data, ext) = opaque && large
            ? (bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9]), "jpg")
            : (bitmap.representation(using: .png, properties: [:]), "png")
        guard let data else { return nil }
        return write(data, named: name, extension: ext, in: folder)
    }

    /// A unique file in the attachments folder (or `folder`, a session's in it), whatever `name`
    /// says: it never lands elsewhere, or replaces a file.
    static func write(_ data: Data, named name: String, extension ext: String, in folder: URL = directory) -> URL? {
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = unique(name, extension: ext, in: folder)
            try data.write(to: url, options: .withoutOverwriting)
            return url
        } catch {
            return nil
        }
    }

    /// A name for a new file in `folder` from `name` and `ext` that no file there has: a counter
    /// after the name where one does.
    private static func unique(_ name: String, extension ext: String, in folder: URL) -> URL {
        let name = fileName(name)
        let ext = ext.isEmpty || ext.contains { !$0.isASCII || !($0.isLetter || $0.isNumber || "+-_".contains($0)) } ? "dat" : ext
        var url = folder.appending(path: "\(name).\(ext)")
        var counter = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = folder.appending(path: "\(name) \(counter).\(ext)")
            counter += 1
        }
        return url
    }

    /// Writes out a file that came as data (a picture a tool returned, a file sent from the
    /// phone) to open it: with the extension of `type`, not the one its name says, and marked as
    /// downloaded, so Gatekeeper checks it like one.
    static func writeReceived(_ data: Data, named name: String, type: UTType?, keepingExtension: Bool = false) -> URL? {
        let base = (fileName(name) as NSString).deletingPathExtension
        let own = (fileName(name) as NSString).pathExtension
        guard let url = write(data, named: base, extension: keepingExtension && !own.isEmpty ? own : type?.preferredFilenameExtension ?? "dat") else { return nil }
        var values = URLResourceValues()
        values.quarantineProperties = [kLSQuarantineTypeKey as String: kLSQuarantineTypeOtherDownload as String]
        var quarantined = url
        try? quarantined.setResourceValues(values)
        return url
    }

    /// The files a message carries in itself (a photo from the phone, a file sent to a machine),
    /// written out to attach again: when it's edited, put back or branched from.
    static func writeCarried(_ files: [Message.User.Attachment]) -> [URL] {
        files.compactMap { file in
            guard file.fileURL == nil, let bytes = file.bytes else { return nil }
            // By its own name: a text file goes to a machine as text/plain, whatever kind it is.
            return writeReceived(bytes, named: file.name ?? "Attachment", type: UTType(mimeType: file.mime), keepingExtension: true)
        }
    }

    /// `name` as one file's name in the folder: its last part, without `:`, control characters or
    /// leading dots (a hidden file), and short enough to take a counter and an extension.
    static func fileName(_ name: String) -> String {
        let last = name.split(separator: "/").last.map(String.init) ?? ""
        var clean = ""
        clean.unicodeScalars.append(contentsOf: last.unicodeScalars.filter { $0 != ":" && !CharacterSet.controlCharacters.contains($0) })
        clean = clean.trimmingCharacters(in: .whitespaces)
        while clean.hasPrefix(".") { clean = clean.dropFirst().trimmingCharacters(in: .whitespaces) }
        var fitting = ""
        for character in clean {
            guard fitting.utf8.count + character.utf8.count <= 200 else { break }
            fitting.append(character)
        }
        return fitting.isEmpty ? "Attachment" : fitting
    }

    /// Whether opening the file could run something: an app, a script, an installer, a disk
    /// image, a link to one. These show in Finder instead of opening.
    static func canRun(_ url: URL) -> Bool {
        let file = url.resolvingSymlinksInPath()
        guard let type = (try? file.resourceValues(forKeys: [.contentTypeKey]))?.contentType ?? UTType(filenameExtension: file.pathExtension) else { return false }
        return ([type] + type.supertypes).contains { runnable.contains($0.identifier) }
    }

    /// Kinds of files that run, or install or open something else, when opened.
    private static let runnable: Set<String> = Set([UTType.executable, .script, .application, .bundle, .diskImage, .internetLocation, .internetShortcut, .aliasFile].map(\.identifier)).union([
        "com.apple.terminal.settings", // .terminal: runs its commands
        "com.apple.installer-package-archive", "com.apple.installer-meta-package",
        "com.apple.mobileconfig", "com.apple.configprofile",
        "com.apple.automator-workflow", "com.apple.shortcut", "com.apple.shortcuts.workflow-file",
        "com.sun.java-web-start",
    ])

    /// A picture pasted into a composer (saved here under `pastedImageName`), which has no name of
    /// its own to go by.
    static func isPasted(_ url: URL) -> Bool {
        let folder = url.deletingLastPathComponent().standardizedFileURL
        let root = directory.standardizedFileURL.path
        return (folder.path == root || folder.deletingLastPathComponent().path == root && isSession(folder.lastPathComponent))
            && url.lastPathComponent.hasPrefix("Pasted Image ")
    }

    /// A name like the system's screenshots: "Pasted Image 2026-10-13 at 15.32.10".
    static var pastedImageName: String {
        "Pasted Image " + Date().formatted(.verbatim("\(year: .defaultDigits)-\(month: .twoDigits)-\(day: .twoDigits) at \(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)).\(minute: .twoDigits).\(second: .twoDigits)", timeZone: .current, calendar: .current))
    }

    private static func looksLikeText(_ url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: 8192), !data.isEmpty else { return false }
        if data.contains(0) { return false }
        // A multi-byte character can be cut at the end of the sample.
        return (0...3).contains { String(data: data.dropLast($0), encoding: .utf8) != nil }
    }
}
