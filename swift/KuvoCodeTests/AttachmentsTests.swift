import Foundation
import OpenCodeKit
import Testing
import UniformTypeIdentifiers
@testable import KuvoCode

/// Files you paste or the agent hands back are written into Kuvo Code's Attachments folder, never
/// elsewhere and never over another file, whatever their names say; once sent, they're kept in a
/// folder of their session's, and go with it; a message you edit gets its files back, each once.
@Suite(.serialized) struct AttachmentsTests {
    init() { TestEnvironment.prepare() }

    private var folder: String { Attachments.directory.standardizedFileURL.path }

    /// A name that tries to lead elsewhere (../, an absolute path, a hidden name, control
    /// characters) still lands in the folder, as a plain file.
    @Test(arguments: ["../../../../tmp/escaped", "/etc/passwd", ".hidden", "a\u{0}b:c", "..", "   "])
    func aNameCantLeadOutOfTheFolder(name: String) throws {
        let url = try #require(Attachments.write(Data("x".utf8), named: name, extension: "txt"))
        #expect(url.standardizedFileURL.deletingLastPathComponent().path == folder)
        #expect(!url.lastPathComponent.hasPrefix("."))
        #expect(!url.lastPathComponent.contains(":"))
    }

    /// The same name twice: two files, the first kept as it was.
    @Test func theSameNameTwiceKeepsBoth() throws {
        let name = "screenshot-\(UUID().uuidString.prefix(8))"
        let first = try #require(Attachments.write(Data("one".utf8), named: name, extension: "png"))
        let second = try #require(Attachments.write(Data("two".utf8), named: name, extension: "png"))
        #expect(first != second)
        #expect(try Data(contentsOf: first) == Data("one".utf8))
        #expect(try Data(contentsOf: second) == Data("two".utf8))
    }

    /// A file that came as data opens as what it is (its type's extension, not its name's), marked
    /// as downloaded so macOS checks it.
    @Test func aReceivedFileIsWhatItsTypeSays() throws {
        let url = try #require(Attachments.writeReceived(Data("%PDF-1.4".utf8), named: "invoice.pdf.app", type: .pdf))
        #expect(url.pathExtension == "pdf")
        let quarantine = try url.resourceValues(forKeys: [.quarantinePropertiesKey]).quarantineProperties
        #expect(quarantine != nil)
    }

    /// Edit on a sent message: its own files, then the ones its note names that are still on this
    /// Mac, each once; a machine's copy of one of its own isn't named again.
    @Test func editingAMessageRestoresItsFilesOnce() throws {
        let own = try #require(Attachments.write(Data("a".utf8), named: "own", extension: "png"))
        let named = try #require(Attachments.write(Data("b".utf8), named: "named", extension: "log"))
        let gone = Attachments.directory.appending(path: "deleted-\(UUID().uuidString).txt").path
        let machineCopy = "/home/me/.kuvo-code/attachments/0a1b2c3d/\(own.lastPathComponent)"
        let restored = Attachments.restored([own], noting: [named.path, own.path, gone, machineCopy])
        #expect(restored.map(\.path) == [own.path, named.path])
    }

    /// A message sent to a machine lists its files once under it: the machine's copies its note
    /// names aren't listed again, kept in a folder of the session's there or, from before, not.
    @Test func aMachinesCopiesArentListedTwice() throws {
        let own = try #require(Attachments.write(Data("a".utf8), named: "shot", extension: "png"))
        let other = try #require(Attachments.write(Data("b".utf8), named: "plan", extension: "pdf"))
        let copies = ["/home/me/.kuvo-code/attachments/0a1b2c3d/\(own.lastPathComponent)", "/home/me/.kuvo-code/attachments/ses_m4ch1ne/0a1b2c3e/\(other.lastPathComponent)"]
        #expect(Attachments.paths(copies, besides: [own, other]).isEmpty)
        // A path of its own the agent was told of, in a folder that's not a copy's, still shows.
        let named = "/home/me/project/attachments/ses_m4ch1ne/notes/\(own.lastPathComponent)"
        #expect(Attachments.paths([named], besides: [own]) == [named])
    }

    /// Sent in a session, a picture you pasted moves into a folder of the session's, so it goes
    /// with it (this Mac's box deletes the folder with the session); a file you picked from your
    /// own folders stays where it is; one sent before in another session (a branch's, put back in
    /// the composer) is copied, so it stays when either goes. It's still a pasted picture.
    @Test func sentFilesAreKeptWithTheirSession() throws {
        let session = "ses_kept\(UUID().uuidString.prefix(8))", source = "ses_from\(UUID().uuidString.prefix(8))"
        defer { Attachments.forget(session: session); Attachments.forget(session: source) }
        let pasted = try #require(Attachments.write(Data("p".utf8), named: Attachments.pastedImageName, extension: "png"))
        let yours = AppInfo.testRoot.appending(path: "Yours \(UUID().uuidString.prefix(8)).txt")
        try Data("y".utf8).write(to: yours)
        defer { try? FileManager.default.removeItem(at: yours) }
        let earlier = try #require(Attachments.write(Data("e".utf8), named: "design", extension: "png", in: Attachments.folder(for: source)))

        let claimed = Attachments.claim([pasted, yours, earlier], for: session)
        let own = Attachments.folder(for: session).standardizedFileURL.path
        #expect(claimed[0].deletingLastPathComponent().standardizedFileURL.path == own)
        #expect(!FileManager.default.fileExists(atPath: pasted.path), "moved, not left waiting")
        #expect(Attachments.isPasted(claimed[0]))
        #expect(claimed[1] == yours)
        #expect(claimed[2].deletingLastPathComponent().standardizedFileURL.path == own)
        #expect(FileManager.default.fileExists(atPath: earlier.path), "the other session's stays its own")
        // Sent again from there (Try Again, put back after an error): it stays where it is.
        #expect(Attachments.claim(claimed, for: session) == claimed)
    }

    /// A machine's session deleted: this Mac's copies of the files you sent in it go (the machine's
    /// box lets its own go). One on this Mac is left to this Mac's box, which keeps what a branch
    /// still shows.
    @MainActor @Test func aMachinesSessionDeletedTakesThisMacsCopies() throws {
        let workspace = Workspace()
        workspace.machines = ["box"]
        let remote = "ses_m\(UUID().uuidString.prefix(8))", local = "ses_l\(UUID().uuidString.prefix(8))"
        defer { Attachments.forget(session: local) }
        for session in [remote, local] { _ = try #require(Attachments.write(Data("x".utf8), named: "shot", extension: "png", in: Attachments.folder(for: session))) }
        let deleted = { (session: String) in
            try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "type": "session.deleted", "created": 1, "data": ["sessionID": session]]))
        }
        workspace.handle(try deleted(remote), machine: "box")
        workspace.handle(try deleted(local))
        #expect(!FileManager.default.fileExists(atPath: Attachments.folder(for: remote).path))
        #expect(FileManager.default.fileExists(atPath: Attachments.folder(for: local).path))
    }
}
