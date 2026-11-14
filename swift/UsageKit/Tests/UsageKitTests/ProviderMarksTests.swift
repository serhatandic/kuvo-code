import SwiftUI
import XCTest
@testable import UsageKit

@MainActor
final class ProviderMarksTests: XCTestCase {
    func testProviderVectorMarksLoadWithoutFallbacks() throws {
        for id in ["claude", "codex", "cursor", "devin", "grok"] {
            let mark = try XCTUnwrap(ProviderMarks.mark(for: id), "\(id) should load a vector mark")
            XCTAssertFalse(mark.path.isEmpty, "\(id) mark must carry SVG path data")
        }
    }

    private func png(_ id: String, named name: String) throws -> Data {
        let view = HStack(spacing: 0) {
            ProviderIcon(source: .providerMark(id)).frame(width: 14, height: 14)
            ProviderIcon(source: .providerMark(id)).frame(width: 14, height: 14)
        }
        .padding(8)
        .background(Color.white)
        let renderer = ImageRenderer(content: view.environment(\.colorScheme, .light))
        renderer.scale = 4
        let image = try XCTUnwrap(renderer.nsImage?.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:))?.representation(using: .png, properties: [:]))
        if let out = ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] {
            try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
            try image.write(to: URL(fileURLWithPath: out).appending(path: name + ".png"))
        }
        return image
    }

    /// With several Claude logins each card is `claude@<hash>`: its row wears Claude's logo, as the
    /// single one does, and not the placeholder an unknown provider gets.
    func testAClaudeAccountCardWearsClaudesLogo() throws {
        let plain = try png("claude", named: "claude")
        let account = try png("claude@ab12cd34", named: "claude-account")
        let unknown = try png("nobody-knows", named: "unknown")
        XCTAssertEqual(account, plain)
        XCTAssertNotEqual(account, unknown)
        XCTAssertNotNil(ProviderMarks.mark(for: "codex@0f0f0f0f"))
    }
}
