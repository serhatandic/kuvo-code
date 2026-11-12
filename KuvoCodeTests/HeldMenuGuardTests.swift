import Foundation
import Testing

/// SwiftUI's `.contextMenu` puts new items in its menu while it's open, each time the view around it
/// is drawn again, so an open right-click menu lost its highlighted row or closed its submenu each
/// time a session started or ended a turn (#556). Every right-click menu in the app is a held one
/// (`.heldContextMenu`, KuvoCode/Design/HeldMenu.swift): a SwiftUI `.contextMenu` anywhere else in
/// the app's code fails here. (SwiftUI's `Menu` buttons keep their items while open, and stay.)
@Suite struct HeldMenuGuardTests {
    @Test func noSwiftUIContextMenuInTheApp() throws {
        let app = try SourceRoot.url().appending(path: "KuvoCode")
        // By their paths in the app's code: the enumerator's URLs name a folder under /var by its
        // real path, /private/var, which a batch's sources are in.
        let files = try #require(FileManager.default.enumerator(atPath: app.path))
            .compactMap { $0 as? String }
            .filter { $0.hasSuffix(".swift") && ($0 as NSString).lastPathComponent != "HeldMenu.swift" }
        #expect(files.count > 100, "the app's code, read from \(app.path)")

        var found: [String] = []
        for file in files {
            let lines = try String(contentsOf: app.appending(path: file), encoding: .utf8).components(separatedBy: .newlines)
            for (index, line) in lines.enumerated() where line.contains("contextMenu") {
                // What's said about it in a comment is fine.
                let code = line.components(separatedBy: "//").first ?? ""
                if code.range(of: #"\.contextMenu\b"#, options: .regularExpression) != nil {
                    found.append("\(file):\(index + 1)")
                }
            }
        }
        #expect(found.isEmpty, "SwiftUI's .contextMenu changes a menu while it's open; use .heldContextMenu: \(found.joined(separator: ", "))")
    }
}
