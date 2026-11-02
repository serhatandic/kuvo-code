import AppKit
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What a model gets of the files you attach: what it can read, with the message (text, folders,
/// pictures for a model that sees them, PDFs for one that reads them); the rest as paths for the
/// agent to open, with the composer saying why; on a machine, what it reads goes inline.
@Suite struct AttachmentRoutesTests {
    let folder: URL

    init() throws {
        TestEnvironment.prepare()
        folder = AppInfo.testRoot.appending(path: "Attach/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder.appending(path: "src"), withIntermediateDirectories: true)
        try Data("let x = 1\n".utf8).write(to: folder.appending(path: "notes.txt"))
        try Data("KEY=value\n".utf8).write(to: folder.appending(path: "Makefile"))
        try Data("%PDF-1.4\n".utf8).write(to: folder.appending(path: "spec.pdf"))
        try Data([0, 1, 2, 3, 0xFF]).write(to: folder.appending(path: "blob.bin"))
        let image = NSImage(size: NSSize(width: 4, height: 4))
        image.lockFocus(); NSColor.red.drawSwatch(in: NSRect(x: 0, y: 0, width: 4, height: 4)); image.unlockFocus()
        let png = NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!
        try png.write(to: folder.appending(path: "shot.png"))
    }

    private func model(input: [String], provider: String = "p") throws -> Model {
        try JSONDecoder().decode(Model.self, from: JSONSerialization.data(withJSONObject: [
            "id": "m-\(input.joined())", "modelID": "m", "providerID": provider, "name": "Test Model",
            "capabilities": ["tools": true, "input": input, "output": ["text"]], "variants": [],
            "time": ["released": 1], "cost": [["input": 1, "output": 1]], "status": "active", "enabled": true,
            "limit": ["context": 1000, "output": 100]]))
    }

    private func url(_ name: String) -> URL { folder.appending(path: name) }

    private func isContent(_ name: String, for model: Model) -> Bool {
        if case .content = Attachments.route(url(name), for: model) { return true }
        return false
    }

    @Test func aModelThatSeesAndReads() throws {
        let all = try model(input: ["text", "image", "pdf"])
        for name in ["notes.txt", "Makefile", "src", "shot.png", "spec.pdf"] { #expect(isContent(name, for: all), "\(name)") }
        #expect(!isContent("blob.bin", for: all))
    }

    /// A model that only reads text: pictures and PDFs as paths, and the composer says why.
    @Test func aTextOnlyModel() throws {
        let text = try model(input: ["text"])
        #expect(isContent("notes.txt", for: text))
        guard case .path(let reason, let warns) = Attachments.route(url("shot.png"), for: text) else { Issue.record("a picture went to a model that can't see"); return }
        #expect(reason.contains("Test Model can't see images") && warns)
        guard case .path(let pdfReason, _) = Attachments.route(url("spec.pdf"), for: text) else { Issue.record("a PDF went to a model that can't read them"); return }
        #expect(pdfReason.contains("can't read PDFs"))
    }

    @Test func whatGoesWithTheMessage() throws {
        let prepared = Attachments.prepare([url("notes.txt"), url("shot.png"), url("blob.bin")], for: try model(input: ["text", "image"]))
        #expect(prepared.files.map(\.name) == ["notes.txt", "shot.png"])
        #expect(prepared.included == [url("notes.txt").path, url("shot.png").path])
        #expect(prepared.paths == [url("blob.bin").path])
    }

    /// A coding agent's session: its bridge puts a text file in the message only up to its limit,
    /// and never a folder, so a long log and a folder go by path, and the message doesn't say
    /// they're in it. A short file is, and the engine's models still get the long one whole.
    @Test func aCodingAgentGetsLongTextAndFoldersByPath() throws {
        let log = url("build.log")
        try Data(repeating: UInt8(ascii: "a"), count: 200_001).write(to: log)  // over the bridge's limit
        let agent = try model(input: ["text", "image"], provider: "claude-code")
        let prepared = Attachments.prepare([url("notes.txt"), log, url("src")], for: agent)
        #expect(prepared.included == [url("notes.txt").path])
        #expect(prepared.paths == [log.path, url("src").path])
        guard case .path(let reason, let warns) = Attachments.route(log, for: agent) else { Issue.record("a long log went in a coding agent's message"); return }
        #expect(reason.contains("gets its path") && !warns)
        #expect(isContent("build.log", for: try model(input: ["text"])))
        // On a machine, a folder goes there as its listing, and its chip doesn't say otherwise.
        guard case .content = Attachments.route(url("src"), for: agent, onMachine: true) else { Issue.record("a folder for a machine was called a path"); return }
    }

    /// On a machine, which can't read this Mac's files: what the model reads goes inline, a
    /// folder as its listing.
    @Test func onAMachineWhatItReadsGoesInline() throws {
        let prepared = Attachments.prepareForMachine([url("notes.txt"), url("src")])
        #expect(prepared.files.map(\.name) == ["notes.txt", "src (list of its files).txt"])
        #expect(prepared.files.allSatisfy { $0.uri.hasPrefix("data:") })
        let notes = try #require(prepared.files.first { $0.name == "notes.txt" })
        #expect(Data(base64Encoded: String(notes.uri.split(separator: ",").last ?? "")) == Data("let x = 1\n".utf8))
        #expect(prepared.unsent.isEmpty && prepared.paths.isEmpty)
    }

    /// On a machine, every file goes inline, the ones its model can't read too: the machine's box
    /// keeps them there for the agent and gives the model what it reads, as it does a phone's.
    /// Nothing is copied over this Mac's SSH, and the note is the box's.
    @Test func onAMachineTheBoxSortsThem() throws {
        let prepared = Attachments.prepareForMachine([url("spec.pdf"), url("shot.png"), url("blob.bin")])
        #expect(prepared.files.map(\.name) == ["spec.pdf", "shot.png", "blob.bin"])
        #expect(prepared.files.allSatisfy { $0.uri.hasPrefix("data:") })
        let pdf = try #require(prepared.files.first)
        #expect(pdf.uri.hasPrefix("data:application/pdf;base64,"))
        #expect(prepared.paths.isEmpty && prepared.unsent.isEmpty && prepared.included.isEmpty)
    }

    /// A picture sent to a machine stays where you picked it, and one turned into a kind the
    /// engine takes leaves no copy behind on this Mac: the machine keeps its own.
    @Test func onAMachineAPictureSentLeavesNothingBehind() throws {
        let tiff = url("scan.tiff")
        let image = try #require(NSImage(contentsOf: url("shot.png")))
        try #require(image.tiffRepresentation).write(to: tiff)
        let before = Set((try? FileManager.default.contentsOfDirectory(atPath: Attachments.directory.path)) ?? [])
        let prepared = Attachments.prepareForMachine([url("shot.png"), tiff])
        #expect(prepared.files.map(\.name) == ["shot.png", "scan.tiff"])
        #expect(FileManager.default.fileExists(atPath: url("shot.png").path))
        #expect(FileManager.default.fileExists(atPath: tiff.path))
        #expect(Set((try? FileManager.default.contentsOfDirectory(atPath: Attachments.directory.path)) ?? []) == before)
    }

    /// One bigger than a machine takes stays on this Mac, and the message says so (one a model
    /// can't take whole goes, for the agent to open there).
    @Test func onAMachineAHugeFileStaysHere() throws {
        let huge = url("huge.log")
        try Data(count: Attachments.maxMachineBytes + 1).write(to: huge)
        defer { try? FileManager.default.removeItem(at: huge) }
        let prepared = Attachments.prepareForMachine([url("notes.txt"), huge])
        #expect(prepared.files.map(\.name) == ["notes.txt"])
        #expect(prepared.unsent == [huge.path])
    }

    /// In the composer of a session on a machine, one too big to send says, before you send, that
    /// it stays on this Mac (in orange, why on hover); sending isn't held up. On this Mac the same
    /// file goes as a path, and a small one goes to the machine as before.
    @Test func onAMachineAHugeFileSaysItStaysHereBeforeYouSend() throws {
        let huge = url("huge.png")
        try Data(count: Attachments.maxMachineBytes + 1).write(to: huge)
        defer { try? FileManager.default.removeItem(at: huge) }
        let sees = try model(input: ["text", "image"])
        guard case .staysHere(let reason) = Attachments.route(huge, for: sees, onMachine: true) else {
            Issue.record("a file too big for a machine didn't say it stays on this Mac"); return
        }
        #expect(reason.contains("stays on this Mac"))
        #expect(Attachments.prepareForMachine([huge]).unsent == [huge.path], "it's still left out, and the note says so")
        guard case .content = Attachments.route(huge, for: sees) else { Issue.record("on this Mac, the engine reads it where it is"); return }
        guard case .content = Attachments.route(url("shot.png"), for: sees, onMachine: true) else { Issue.record("a small picture for a machine said it stays"); return }
    }

    /// A picture only the engine has (a photo from the phone), opened twice: the same copy on
    /// this Mac both times, not a second one.
    @Test func openingAPictureTwiceWritesItOnce() throws {
        let png = try Data(contentsOf: url("shot.png")).base64EncodedString()
        let item = AttachmentItem.stored(.init(mime: "image/png", name: "photo.png", data: png), id: "msg_\(UUID().uuidString)#0")
        let first = try #require(item.localURL())
        defer { try? FileManager.default.removeItem(at: first) }
        #expect(item.localURL() == first)
    }
}
