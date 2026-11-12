import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// "/" at the start of a message lists the keywords and commands its name matches: a command typed
/// in full is what Return picks. (How "/" reads a message is KuvoClient's: ClientSessions'
/// SlashCommandsTests.)
@Suite struct SlashItemTests {
    /// A project's command typed in full is what Return picks, though a keyword has its name
    /// inside (/review has "view"; /goal starts with "go") and is listed first.
    @MainActor @Test func aCommandTypedInFullIsPickedOverAKeywordThatHasItsName() throws {
        let own = try ["view", "go"].map { try JSONDecoder().decode(Command.self, from: Data(#"{"name":"\#($0)"}"#.utf8)) }
        for name in ["view", "go"] {
            let items = SlashItem.matches(name, keywords: Keyword.allCases, commands: own)
            #expect(items[SlashItem.chosen(name, in: items)] == .command(own.first { $0.name == name }!), "\(name)")
        }
        // Half typed, the first as before.
        let items = SlashItem.matches("vi", keywords: Keyword.allCases, commands: own)
        #expect(SlashItem.chosen("vi", in: items) == 0)
    }
}
