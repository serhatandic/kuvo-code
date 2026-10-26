import AppKit
import OpenCodeKit
import UniformTypeIdentifiers

/// Gets what the user attached ready for the engine. The engine gives the model text,
/// images (PNG, JPEG, GIF, WebP), PDFs and folder listings, up to 20 MB each, and drops
/// anything else. So other image formats are converted first, and files the model can't
/// take (an archive, a video, an image for a model without vision, anything too big)
/// go as paths in a note, for the agent to open with its tools.
nonisolated enum Attachments {
    static let maxBytes = 20 * 1024 * 1024
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

    /// Where pasted images and converted copies are kept.
    static var directory: URL {
        AppInfo.supportDirectory.appending(path: "Attachments")
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
    }

    /// The composer asks again at every keystroke, and finding a file's kind can read it (one in
    /// iCloud downloads): what was found, by file and model, until a couple of hundred pile up.
    nonisolated(unsafe) private static var routes: [String: Route] = [:]
    private static let routesLock = NSLock()

    static func route(_ url: URL, for model: Model?) -> Route {
        let key = url.path + "\n" + (model?.key ?? "")
        if let known = routesLock.withLock({ routes[key] }) { return known }
        let route = findRoute(url, for: model)
        routesLock.withLock {
            if routes.count > 200 { routes.removeAll() }
            routes[key] = route
        }
        return route
    }

    private static func findRoute(_ url: URL, for model: Model?) -> Route {
        let input = model?.capabilities.input
        let name = model?.name ?? "This model"
        let size = (try? target(of: url).resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        let tooBig = Route.path(reason: "It's over 20 MB, so the agent gets its path and opens it with its tools.", isWarning: true)
        switch kind(of: url) {
        case .folder:
            return .content
        case .text:
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
    static func prepare(_ urls: [URL], for model: Model?) -> Prepared {
        var prepared = Prepared()
        for url in urls {
            let file = target(of: url)
            switch route(url, for: model) {
            case .content where kind(of: url) == .image:
                let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                if let image = engineImage(from: file, named: url.lastPathComponent, size: size) {
                    prepared.files.append(image)
                    prepared.included.append(url.path)
                } else {
                    prepared.paths.append(url.path)
                }
            case .content:
                prepared.files.append(.init(uri: file.absoluteString, name: url.lastPathComponent))
                prepared.included.append(url.path)
            case .path:
                prepared.paths.append(url.path)
            }
        }
        return prepared
    }

    /// The same, for an engine on `machine`, which can't read this Mac's files: what the model
    /// takes goes inline, as data (a folder as its listing, as the engine lists one); anything
    /// else is copied to the machine, into Kuvo Code's folder there, for the agent to open with
    /// its tools, each in a folder of its own (two can have the same name). A file that can't be
    /// read or copied goes in the note as on the user's Mac. Where the inline ones are on the Mac
    /// isn't said: the agent there couldn't open them.
    static func prepare(_ urls: [URL], for model: Model?, machine: String) -> Prepared {
        let here = prepare(urls, for: model)
        var prepared = Prepared()
        // Each file sent with its contents, with where it was picked.
        for (file, picked) in zip(here.files, here.included) {
            if let url = URL(string: file.uri), url.isFileURL, let inline = inlined(url) {
                prepared.files.append(.init(uri: inline, name: file.name))
            } else {
                prepared.unsent.append(picked)
            }
        }
        for path in here.paths {
            let folder = "\(RemoteEngineInstaller.root)/\(machineFolder)/\(UUID().uuidString.prefix(8).lowercased())"
            if let copy = RemoteShell.upload(URL(filePath: path), into: folder, on: machine) {
                prepared.paths.append(copy)
            } else {
                prepared.unsent.append(path)
            }
        }
        return prepared
    }

    /// Where on a machine, in Kuvo Code's folder there, the files sent to it are copied.
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
        guard let data = try? Data(contentsOf: url) else { return nil }
        let type = UTType(filenameExtension: url.pathExtension)
        let mime = kind(of: url) == .text ? "text/plain" : (type?.preferredMIMEType ?? "application/octet-stream")
        return "data:\(mime);base64," + data.base64EncodedString()
    }

    /// The image as a format and size the engine takes, converting it if needed; nil when it
    /// can't be, so it goes as a path.
    private static func engineImage(from url: URL, named name: String, size: Int) -> OpenCodeAPI.PromptFile? {
        let type = UTType(filenameExtension: url.pathExtension)
        if size <= maxBytes, let type, engineImageTypes.contains(where: { type.conforms(to: $0) }) {
            return .init(uri: url.absoluteString, name: name)
        }
        guard let image = NSImage(contentsOf: url), let copy = save(image, named: url.deletingPathExtension().lastPathComponent) else { return nil }
        // Still too big (a large picture with transparency stays a PNG): the engine would drop it.
        guard ((try? copy.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0) <= maxBytes else {
            try? FileManager.default.removeItem(at: copy)
            return nil
        }
        return .init(uri: copy.absoluteString, name: name)
    }

    // MARK: The note

    private static let includedHeading = "The attached files are on disk here (what's in them is in this message already):"
    private static let pathsHeading = "Open these attached files with your tools if you need them:"
    private static let unsentHeading = "These attached files stayed on the user's Mac (they couldn't be read, or copied to this machine):"
    private static let note = MessageBlock(start: "<attached-files>", end: "</attached-files>", headings: [includedHeading, pathsHeading, unsentHeading])
    /// How a file that stayed on the Mac used to be listed, on its path's line.
    private static let unsentSuffix = " (on the user's Mac: it couldn't be copied to this machine)"

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
    /// paths or couldn't send (the others are the message's own files).
    static func split(_ text: String) -> (text: String, paths: [String]) {
        guard let (before, lines) = note.split(text) else { return (text, []) }
        var heading = ""
        var paths: [String] = []
        for line in lines.map(String.init) {
            if note.headings.contains(line) {
                heading = line
            } else if line.hasPrefix("/"), heading != includedHeading {
                paths.append(line.hasSuffix(unsentSuffix) ? String(line.dropLast(unsentSuffix.count)) : line)
            }
        }
        return (before.trimmingCharacters(in: .whitespacesAndNewlines), paths)
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

    /// Where a file sent to a machine was copied, there: `…/attachments/<folder>/<name>`.
    private static func isMachineCopy(_ path: String) -> Bool {
        let parts = path.split(separator: "/")
        guard parts.count >= 3, parts[parts.count - 3] == machineFolder else { return false }
        let folder = parts[parts.count - 2]
        return folder.count == 8 && folder.allSatisfy(\.isHexDigit)
    }

    // MARK: Files we write

    /// Saves a pasted or converted image as PNG (JPEG for opaque photos, which would
    /// otherwise be huge), and returns where.
    static func save(_ image: NSImage, named name: String) -> URL? {
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
        let opaque = !bitmap.hasAlpha
        let large = bitmap.pixelsWide * bitmap.pixelsHigh > 4_000_000
        let (data, ext) = opaque && large
            ? (bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9]), "jpg")
            : (bitmap.representation(using: .png, properties: [:]), "png")
        guard let data else { return nil }
        return write(data, named: name, extension: ext)
    }

    /// A unique file in the attachments folder, whatever `name` says: it never lands elsewhere,
    /// or replaces a file.
    static func write(_ data: Data, named name: String, extension ext: String) -> URL? {
        let name = fileName(name)
        let ext = ext.isEmpty || ext.contains { !$0.isASCII || !($0.isLetter || $0.isNumber || "+-_".contains($0)) } ? "dat" : ext
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var url = directory.appending(path: "\(name).\(ext)")
            var counter = 2
            while FileManager.default.fileExists(atPath: url.path) {
                url = directory.appending(path: "\(name) \(counter).\(ext)")
                counter += 1
            }
            try data.write(to: url, options: .withoutOverwriting)
            return url
        } catch {
            return nil
        }
    }

    /// Writes out a file that came as data (a picture a tool returned, a file sent from the
    /// phone) to open it: with the extension of `type`, not the one its name says, and marked as
    /// downloaded, so Gatekeeper checks it like one.
    static func writeReceived(_ data: Data, named name: String, type: UTType?) -> URL? {
        let base = (fileName(name) as NSString).deletingPathExtension
        guard let url = write(data, named: base, extension: type?.preferredFilenameExtension ?? "dat") else { return nil }
        var values = URLResourceValues()
        values.quarantineProperties = [kLSQuarantineTypeKey as String: kLSQuarantineTypeOtherDownload as String]
        var quarantined = url
        try? quarantined.setResourceValues(values)
        return url
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

    /// A name like the system's screenshots: "Pasted Image 2026-10-13 at 15.32.10".
    /// A picture pasted into a composer (saved here under `pastedImageName`), which has no name of
    /// its own to go by.
    static func isPasted(_ url: URL) -> Bool {
        url.deletingLastPathComponent().standardizedFileURL.path == directory.standardizedFileURL.path
            && url.lastPathComponent.hasPrefix("Pasted Image ")
    }

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
