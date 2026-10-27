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
}
