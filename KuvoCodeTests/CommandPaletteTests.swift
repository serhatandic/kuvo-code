import Foundation
import Testing
@testable import KuvoCode

/// The command palette (⌘K): before anything's typed, the latest sessions and the usual actions;
/// typed, the actions, sessions in any project and this project's files that match, the best
/// first: a name's start, then a word's, then the words' first letters ("nt" for New Terminal),
/// then anywhere, then each word ("set mcp"); choosing a file opens it. Real files in a repository.
@MainActor
@Suite struct CommandPaletteTests {
    private func item(_ kind: PaletteItem.Kind, _ title: String, ran: (() -> Void)? = nil) -> PaletteItem {
        PaletteItem(id: "\(kind):\(title)", kind: kind, title: title, run: ran ?? {})
    }

    private var actions: [PaletteItem] {
        ["New Session", "New Terminal", "Toggle Sidebar", "Settings › MCP Servers", "Settings › Accounts", "Find in Conversation", "Close Tab", "Open Beside", "Archive Session"]
            .map { item(.action, $0) }
    }

    /// The latest first, in two projects.
    private var sessions: [PaletteItem] {
        ["Fix the login crash", "Release notes for 0.6", "Dark mode polish", "Terminal colors", "Pricing page", "Onboarding copy"]
            .map { item(.session, $0) }
    }

    private func titles(_ sections: [CommandPalette.Section]) -> [String: [String]] {
        Dictionary(uniqueKeysWithValues: sections.map { ($0.title, $0.items.map(\.title)) })
    }

    @Test func itFindsSessionsFilesAndActions() throws {
        let repo = try TestRepository()
        for path in ["Sources/LoginView.swift", "Sources/Settings.swift", "README.md"] { try repo.write(path, "x\n") }
        let files = ProjectFiles.mentionable([repo.url])
        var opened: URL?
        func listed(_ query: String) -> [String: [String]] {
            titles(CommandPalette.sections(for: query, actions: actions, sessions: sessions, files: files) { opened = $0 })
        }

        let empty = CommandPalette.sections(for: "  ", actions: actions, sessions: sessions, files: files) { _ in }
        #expect(empty.map(\.title) == ["Recent Sessions", "Actions"])
        #expect(empty[0].items.map(\.title) == Array(sessions.prefix(5).map(\.title)), "the five latest")
        #expect(empty[1].items.count == 7)

        // A session (in any project) and a file (in this one) by a word of it.
        let login = listed("login")
        #expect(login["Sessions"] == ["Fix the login crash"])
        #expect(login["Files"] == ["LoginView.swift"])
        #expect(login["Actions"] == nil)
        // An action by its words' first letters, the start of a name first.
        #expect(listed("nt")["Actions"] == ["New Terminal", "Settings › Accounts"], "and after, anywhere in a name")
        #expect(listed("term")["Actions"] == ["New Terminal"])
        #expect(listed("term")["Sessions"] == ["Terminal colors"])
        // Each word starting one of its words.
        #expect(listed("set mcp")["Actions"] == ["Settings › MCP Servers"])
        #expect(listed("settings")["Actions"] == ["Settings › MCP Servers", "Settings › Accounts"], "in their order, as they match alike")
        #expect(listed("zzz").isEmpty)

        // Choosing a file opens it.
        let file = try #require(CommandPalette.sections(for: "loginview", actions: actions, sessions: sessions, files: files) { opened = $0 }
            .first { $0.title == "Files" }?.items.first)
        file.run()
        #expect(opened?.lastPathComponent == "LoginView.swift")
    }
}
