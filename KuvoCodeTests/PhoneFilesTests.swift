import ClientChanges
import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// A phone opens a file an agent's reply or tool names on this Mac (a picture it made, a file it
/// shows) by its `file://` address: its bytes with its type, and words for one that's gone, too
/// big or not a file's address. This Mac's box answers it, as a machine's does; the box is the
/// real one, its engine a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PhoneFilesTests {
    let folder: URL

    init() throws {
        TestEnvironment.prepare()
        folder = AppInfo.testRoot.appending(path: "PhoneFiles/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    /// The biggest file the box sends.
    static let limit = 25 * 1024 * 1024

    /// As a phone asks it, through this Mac's link, which hands it to the box.
    private func ask(_ uri: String, of box: SettingsBox) async throws -> (status: Int, type: String?, body: Data) {
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "uri", value: uri)]
        var status = 0
        var type: String?
        var body = Data()
        let request = LinkRequest(path: "kuvo/file?" + (query.percentEncodedQuery ?? ""))
        for try await part in PhoneLink.respond(to: request, link: nil, engine: URL(string: box.engine.url + "/")!, password: "test", agents: nil, asking: Data(repeating: 1, count: 32)) {
            switch part {
            case .head(let code, let headers):
                status = code
                type = headers["content-type"]
            case .body(let chunk): body += chunk
            }
        }
        return (status, type, body)
    }

    @Test func aFileComesWithItsType() async throws {
        let box = try await SettingsBox(port: 47_968)
        defer { box.stop(); try? FileManager.default.removeItem(at: folder) }
        let picture = folder.appending(path: "a chart #1.png")
        let bytes = Data((0..<100_000).map { UInt8($0 % 251) })
        try bytes.write(to: picture)
        let sent = try await ask(picture.absoluteString, of: box)
        #expect(sent.status == 200)
        #expect(sent.type == "image/png")
        #expect(sent.body == bytes)
    }

    @Test func oneGoneTooBigOrNotAFileSaysSo() async throws {
        let box = try await SettingsBox(port: 47_968)
        defer { box.stop(); try? FileManager.default.removeItem(at: folder) }
        let gone = try await ask(folder.appending(path: "gone.png").absoluteString, of: box)
        #expect(gone.status == 404)
        #expect((try JSONSerialization.jsonObject(with: gone.body) as? [String: String])?["message"] != nil)
        #expect(try await ask(folder.absoluteString, of: box).status == 404, "a folder isn't a file")
        #expect(try await ask("https://example.com/a.png", of: box).status == 400)
        let big = folder.appending(path: "big.bin")
        FileManager.default.createFile(atPath: big.path, contents: nil)
        let handle = try FileHandle(forWritingTo: big)
        try handle.truncate(atOffset: UInt64(Self.limit + 1))
        try handle.close()
        #expect(try await ask(big.absoluteString, of: box).status == 413)
    }

    /// The Mac's panel reads a machine's file as a phone does, from that computer's box
    /// (`BoxClient.file`, never its own SSH): any name, and the box's words for one that's gone.
    @Test func theMacsPanelReadsABoxsFileAsAPhoneDoes() async throws {
        let box = try await SettingsBox(port: 47_968)
        defer { box.stop(); try? FileManager.default.removeItem(at: folder) }
        let engine = URL(string: box.engine.url + "/")!
        let client = BoxClient(box: "test", transport: LocalBox { request in
            PhoneLink.respond(to: request, link: nil, engine: engine, password: "test", agents: nil, asking: Data(repeating: 1, count: 32))
        })
        let notes = folder.appending(path: "plans & notes #2 100%+=?.md")
        try Data("# Plans\n".utf8).write(to: notes)
        #expect(try await client.file(notes.path) == Data("# Plans\n".utf8))
        do {
            _ = try await client.file(folder.appending(path: "gone.md").path)
            Issue.record("A file that's gone came back")
        } catch let refusal as BoxRefusal {
            #expect(refusal.status == 404)
            #expect(refusal.message == "That file isn’t there anymore.")
        }
    }

    /// A name with letters like "ş" goes as it's written (one character, not "s" and a mark), which
    /// a Linux machine's disk needs to find it; and a file bigger than what's shown is refused with
    /// the box's words, before any of it is sent.
    @Test func aNameGoesAsWrittenAndOnlyWhatsShownIsSent() async throws {
        let box = try await SettingsBox(port: 47_968)
        defer { box.stop(); try? FileManager.default.removeItem(at: folder) }
        let engine = URL(string: box.engine.url + "/")!
        let asked = Asked()
        let client = BoxClient(box: "test", transport: LocalBox { request in
            asked.add(request.path)
            return PhoneLink.respond(to: request, link: nil, engine: engine, password: "test", agents: nil, asking: Data(repeating: 1, count: 32))
        })
        let name = "\u{015F}eker.md"
        let sugar = folder.appending(path: name)
        try Data("sweet\n".utf8).write(to: sugar)
        #expect(try await client.file(folder.path + "/" + name) == Data("sweet\n".utf8))
        #expect(asked.paths.last?.contains("%25C5%259Feker.md") == true, "precomposed ş, as UTF-8, percent-encoded twice")
        let log = folder.appending(path: "long.log")
        try Data(repeating: UInt8(ascii: "x"), count: 3_000_000).write(to: log)
        do {
            _ = try await client.file(log.path, max: 2_000_000)
            Issue.record("A file over max came whole")
        } catch let refusal as BoxRefusal {
            #expect(refusal.status == 413)
            #expect(refusal.message == "That file is too big to show here.")
        }
        #expect(try await client.file(log.path).count == 3_000_000)
    }

    /// Changes shows a machine's new file from that machine's box, as the panel does: its lines,
    /// a picture as binary, and one too big to read through as too big (refused by its box, not
    /// sent whole). The next look reads only a file whose bytes changed (git's hash says).
    @Test func changesShowsAMachinesNewFileFromItsBox() async throws {
        let box = try await SettingsBox(port: 47_968)
        defer { box.stop(); try? FileManager.default.removeItem(at: folder) }
        let engine = URL(string: box.engine.url + "/")!
        let client = BoxClient(box: "test", transport: LocalBox { request in
            PhoneLink.respond(to: request, link: nil, engine: engine, password: "test", agents: nil, asking: Data(repeating: 1, count: 32))
        })
        try Data("one\ntwo\n".utf8).write(to: folder.appending(path: "notes.md"))
        try Data([0x89, 0x50, 0x4E, 0x47, 0, 1]).write(to: folder.appending(path: "chart.png"))
        try Data(repeating: UInt8(ascii: "x"), count: 2_500_000).write(to: folder.appending(path: "big.log"))
        let root = RemoteFolder.folder(folder.path, on: "test")
        let names = ["notes.md", "chart.png", "big.log"]
        func listed(_ hashes: [String]) -> [ChangedFile] {
            zip(names, hashes).map { name, hash in
                var file = ChangedFile(path: name, status: .added, url: RemoteFolder.url(root).appending(path: name))
                file.root = root
                file.unread = true
                file.hash = hash
                return file
            }
        }
        let asked = Asked()
        let read = await Git.readNew(listed(["a1", "b1", "c1"])) { machine in
            asked.add(machine)
            return client
        }
        #expect(asked.paths == ["test", "test", "test"])
        #expect(read[0].lines.map(\.text) == ["one", "two"])
        #expect(read[1].isBinary)
        #expect(read[2].isTooBig && !read[2].isBinary)
        #expect(read.allSatisfy { !$0.unread })

        // The agent adds a line to the notes; the rest are as they were.
        try Data("one\ntwo\nthree\n".utf8).write(to: folder.appending(path: "notes.md"))
        let again = Asked()
        let next = await Git.readNew(listed(["a2", "b1", "c1"]), known: Git.kept(read)) { machine in
            again.add(machine)
            return client
        }
        #expect(again.paths == ["test"], "only the changed file is read again")
        #expect(next[0].lines.map(\.text) == ["one", "two", "three"])
        #expect(next[1].isBinary && next[2].isTooBig)
    }

    /// The panel's Files shows a machine's code and text, whatever this Mac's apps call the kind
    /// (`.ts` is a video to macOS), and doesn't fetch a PDF or an archive only to say it can't.
    @Test func filesFetchesAMachinesCodeButNotItsArchives() {
        #expect(["ts", "mts", "mod", "pem", "swift", "", "rst"].allSatisfy(MachineFiles.shows))
        #expect(!["pdf", "zip", "MP4", "dmg"].contains(where: MachineFiles.shows))
    }

    /// What a test's stand-in transport was asked.
    nonisolated private final class Asked: @unchecked Sendable {
        private let lock = NSLock()
        private var asked: [String] = []
        var paths: [String] { lock.withLock { asked } }
        func add(_ path: String) { lock.withLock { asked.append(path) } }
    }
}
