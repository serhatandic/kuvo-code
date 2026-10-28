import ClientChanges
import Foundation
import Testing
@testable import KuvoCode

/// Binary files in the Changes panel (J4), on a real repository: a picture or a compiled file the
/// agent changed or added is listed as binary, without lines of text made of its bytes; Stage
/// stages it and Discard puts back the committed one exactly, byte for byte.
@MainActor
@Suite struct ChangesBinaryTests {
    let repo: TestRepository
    let changes: ProjectChanges
    /// A PNG's first bytes, then bytes no text has.
    let logo = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0xFF, 0x00, 0x10])

    init() throws {
        repo = try TestRepository()
        try repo.write("README.md", "Hello\n")
        try logo.write(to: repo.url.appending(path: "logo.png"))
        try repo.commitAll("Start")
        changes = ProjectChanges(directory: repo.path)
    }

    private func row(_ path: String) async throws -> ChangedFile {
        await changes.refresh()
        return try #require(changes.files.first { $0.path == path }, "\(path) isn't listed; listed: \(changes.files.map(\.path))")
    }

    @Test func aChangedPictureIsListedAsBinaryAndDiscardPutsItBack() async throws {
        var changed = logo
        changed[18] = 0x7F
        changed.append(contentsOf: [0x00, 0x01, 0x02])
        try changed.write(to: repo.url.appending(path: "logo.png"))
        let file = try await row("logo.png")
        #expect(file.isBinary)
        #expect(file.lines.isEmpty, "no lines made of its bytes")

        #expect(await changes.perform(.discard, on: file) == nil)
        #expect(try Data(contentsOf: repo.url.appending(path: "logo.png")) == logo, "the committed bytes, exactly")
        #expect(try repo.status().isEmpty)
    }

    @Test func aNewBinaryFileIsListedAndStaged() async throws {
        try FileManager.default.createDirectory(at: repo.url.appending(path: "build"), withIntermediateDirectories: true)
        try Data((0..<2048).map { UInt8($0 % 256) }).write(to: repo.url.appending(path: "build/app.bin"))
        let file = try await row("build/app.bin")
        #expect(file.status == .added)
        #expect(file.isBinary)
        #expect(await changes.perform(.stage, on: file) == nil)
        #expect(try repo.git("diff", "--cached", "--name-only").contains("build/app.bin"))
    }
}
