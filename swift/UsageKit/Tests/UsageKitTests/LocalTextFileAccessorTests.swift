import Foundation
import XCTest
@testable import UsageKit

/// Real-filesystem coverage for the credential writer. Every test stays inside a unique temporary
/// directory and verifies both data integrity and the POSIX boundary that protects local secrets.
final class LocalTextFileAccessorTests: XCTestCase {
    private var temporaryDirectory: URL!

    override func setUpWithError() throws {
        temporaryDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("OpenUsageTests.LocalTextFileAccessor.\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        if let temporaryDirectory,
           FileManager.default.fileExists(atPath: temporaryDirectory.path)
        {
            try FileManager.default.removeItem(at: temporaryDirectory)
        }
    }

    func testFreshCredentialFileIsOwnerReadWriteOnly() throws {
        let file = temporaryDirectory
            .appendingPathComponent("nested", isDirectory: true)
            .appendingPathComponent("credentials.json")

        try LocalTextFileAccessor().writeText(file.path, #"{"token":"s3cr3t"}"#)

        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), #"{"token":"s3cr3t"}"#)
        XCTAssertEqual(try permissions(of: file), 0o600)
        XCTAssertEqual(try siblingNames(of: file), ["credentials.json"])
    }

    func testOverwriteTightensExistingPermissiveFile() throws {
        let file = temporaryDirectory.appendingPathComponent("api-key")
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
        try "old-key".write(to: file, atomically: false, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        XCTAssertEqual(try permissions(of: file), 0o644)

        try LocalTextFileAccessor().writeText(file.path, "new-key")

        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "new-key")
        XCTAssertEqual(try permissions(of: file), 0o600)
        XCTAssertEqual(try siblingNames(of: file), ["api-key"])
    }

    func testFailedReplacementRemovesPrivateTemporaryFile() throws {
        let destinationDirectory = temporaryDirectory.appendingPathComponent("credential", isDirectory: true)
        try FileManager.default.createDirectory(at: destinationDirectory, withIntermediateDirectories: true)

        XCTAssertThrowsError(try LocalTextFileAccessor().writeText(destinationDirectory.path, "secret"))

        XCTAssertEqual(try siblingNames(of: destinationDirectory), ["credential"])
        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: destinationDirectory.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
    }

    private func permissions(of file: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        return try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).intValue & 0o777
    }

    private func siblingNames(of file: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path).sorted()
    }
}
