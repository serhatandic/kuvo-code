import ClientSessions
import Foundation
import Testing

/// The lists both apps draw come from what the box says of each session (`kuvo/sessions/list`):
/// drawn from the box's facts alone, they're what the vectors say the Mac's sidebar showed
/// (`Packages/KuvoLink/Vectors/session-lists.json`, which the box's own test holds its facts to).
struct SessionListsTests {
    private static func vectors() throws -> [[String: Any]] {
        let file = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../KuvoLink/Vectors/session-lists.json").standardized
        let read = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        return try #require(read["cases"] as? [[String: Any]])
    }

    private static func decoded<T: Decodable>(_ value: Any?, as type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: try #require(value)))
    }

    @Test func theSidebarIsTheBoxsFactsDrawn() throws {
        let cases = try Self.vectors().filter { ($0["expect"] as? [String: Any])?["sidebar"] != nil }
        #expect(!cases.isEmpty)
        for each in cases {
            let expect = try #require(each["expect"] as? [String: Any])
            let facts = try Self.decoded(expect["sessions"], as: [String: SessionLists.Facts].self)
            let projects = try Self.decoded(expect["projects"], as: [String: SessionLists.Project].self)
            let sidebar = try #require(expect["sidebar"] as? [String: Any])
            let ids = Array(facts.keys)
            let place = { (id: String) in SessionLists.place(of: facts[id]) }
            let updated = { (id: String) in facts[id]?.updated ?? 0 }
            let shown = ids.filter { place($0) != nil }
            #expect(SessionLists.newestFirst(shown.filter { facts[$0]?.pinned == true }, updated: updated) == sidebar["pinned"] as? [String])
            #expect(SessionLists.newestFirst(shown.filter { place($0) == .chat }, updated: updated) == sidebar["chats"] as? [String])
            let drawn = SessionLists.projects(shown, directories: projects.keys, project: { id in
                if case .project(let directory) = place(id) { return directory }
                return nil
            }, updated: updated, name: { SessionLists.name(of: $0, in: projects) })
            let wanted = try #require(sidebar["projects"] as? [[String: Any]])
            #expect(drawn.map(\.directory) == wanted.map { $0["directory"] as? String ?? "" })
            #expect(drawn.map(\.rows) == wanted.map { $0["sessions"] as? [String] ?? [] })
        }
    }

    /// Lines taken in turn: a whole one replaces what was; one of changes merges them and lets go of
    /// those gone; one of a kind this client doesn't know yet is read, and shows nowhere.
    @Test func linesTakenInTurn() throws {
        func line(_ json: String) throws -> SessionLists.Line { try JSONDecoder().decode(SessionLists.Line.self, from: Data(json.utf8)) }
        var listing = SessionLists.Listing()
        #expect(!listing.isRead)
        #expect(listing.take(try line(#"{"at":"e.1","full":true,"sessions":{"ses_a":{"kind":"project","project":"/p","directory":"/p","created":1,"updated":2},"ses_b":{"kind":"chat","directory":"/c","created":1,"updated":3}},"projects":{"/p":{"updated":2}}}"#)))
        #expect(listing.isRead && listing.at == "e.1" && listing.sessions.count == 2)
        #expect(listing.take(try line(#"{"at":"e.2","sessions":{"ses_c":{"kind":"lens","directory":"/p","created":1,"updated":4}},"gone":["ses_b"],"projects":{"/p":{"updated":2}}}"#)))
        #expect(Set(listing.sessions.keys) == ["ses_a", "ses_c"])
        #expect(SessionLists.place(of: listing.sessions["ses_c"]) == nil)
        #expect(SessionLists.place(of: listing.sessions["ses_a"]) == .project("/p"))
        // Nothing new: said so.
        #expect(!listing.take(try line(#"{"at":"e.3","sessions":{},"projects":{"/p":{"updated":2}}}"#)))
        #expect(listing.at == "e.3")
        #expect(listing.take(try line(#"{"at":"f.1","full":true,"sessions":{},"projects":{}}"#)))
        #expect(listing.sessions.isEmpty)
        #expect(SessionLists.route(since: "e.3") == "kuvo/sessions/list?since=e.3")
        #expect(SessionLists.eventsRoute() == "kuvo/sessions/list/events")
    }

    /// Archived is the box's word, wherever it was archived; one this client just archived or
    /// brought back shows so at once, and stays so through lines its box worked out before, until
    /// its box says the same; a refused one is the box's word again.
    @Test func archivedIsTheBoxsWordAndOneJustArchivedHereShowsSoAtOnce() throws {
        func line(_ json: String) throws -> SessionLists.Line { try JSONDecoder().decode(SessionLists.Line.self, from: Data(json.utf8)) }
        var listing = SessionLists.Listing()
        listing.take(try line(#"{"at":"e.1","full":true,"sessions":{"ses_a":{"kind":"project","project":"/p","directory":"/p","created":1,"updated":2},"ses_b":{"kind":"chat","directory":"/c","created":1,"updated":3}},"projects":{}}"#))
        // Archived elsewhere (a phone, Remove Project): its box says so, and it shows nowhere.
        listing.take(try line(#"{"at":"e.2","sessions":{"ses_b":{"kind":"chat","directory":"/c","created":1,"updated":4,"archived":true}},"projects":{}}"#))
        #expect(SessionLists.place(of: listing.facts(of: "ses_b")) == nil)
        // Archived here: at once, and through a line its box worked out before it heard.
        listing.noteArchived("ses_a", true)
        #expect(SessionLists.place(of: listing.facts(of: "ses_a")) == nil)
        listing.take(try line(#"{"at":"e.3","sessions":{"ses_a":{"kind":"project","project":"/p","directory":"/p","created":1,"updated":5}},"projects":{}}"#))
        #expect(SessionLists.place(of: listing.facts(of: "ses_a")) == nil)
        // Its box says so too: the note's done, and its word stands.
        listing.take(try line(#"{"at":"e.4","sessions":{"ses_a":{"kind":"project","project":"/p","directory":"/p","created":1,"updated":6,"archived":true}},"projects":{}}"#))
        #expect(listing.noted.isEmpty)
        #expect(SessionLists.place(of: listing.facts(of: "ses_a")) == nil)
        // Brought back here, and the engine refused: its box's word again.
        listing.noteArchived("ses_b", false)
        #expect(SessionLists.place(of: listing.facts(of: "ses_b")) == .chat)
        listing.forgetArchived("ses_b", false)
        #expect(SessionLists.place(of: listing.facts(of: "ses_b")) == nil)
        // Archived and brought back at once: back, through its box's line for the archive, until
        // its line for the bring-back.
        listing.noteArchived("ses_a", false)
        listing.noteArchived("ses_a", true)
        listing.noteArchived("ses_a", false)
        listing.take(try line(#"{"at":"e.5","sessions":{"ses_a":{"kind":"project","project":"/p","directory":"/p","created":1,"updated":7,"archived":true}},"projects":{}}"#))
        #expect(SessionLists.place(of: listing.facts(of: "ses_a")) == .project("/p"))
        listing.take(try line(#"{"at":"e.6","sessions":{"ses_a":{"kind":"project","project":"/p","directory":"/p","created":1,"updated":8}},"projects":{}}"#))
        #expect(listing.noted.isEmpty && SessionLists.place(of: listing.facts(of: "ses_a")) == .project("/p"))
        // One its box hasn't listed isn't noted.
        listing.noteArchived("ses_new", true)
        #expect(listing.facts(of: "ses_new") == nil && listing.noted.isEmpty)
    }

    /// A session a client just started shows at once, as its box's start answer says, until its list
    /// says (a line naming it, or a whole one without it); one its list already names stays as listed.
    @Test func aSessionJustMadeShowsUntilItsListSays() throws {
        func line(_ json: String) throws -> SessionLists.Line { try JSONDecoder().decode(SessionLists.Line.self, from: Data(json.utf8)) }
        var listing = SessionLists.Listing()
        listing.take(try line(#"{"at":"e.1","full":true,"sessions":{"ses_a":{"kind":"project","project":"/p","directory":"/p","created":1,"updated":2}},"projects":{}}"#))
        listing.noteMade("ses_new", facts: .init(kind: .chat, directory: "/c", updated: 5))
        listing.noteMade("ses_a", facts: .init(kind: .chat, directory: "/c", updated: 5))
        #expect(SessionLists.place(of: listing.facts(of: "ses_new")) == .chat)
        #expect(listing.facts(of: "ses_a")?.kind == .project)
        listing.take(try line(#"{"at":"e.2","sessions":{"ses_new":{"kind":"project","project":"/p","directory":"/p/tree","created":5,"updated":6}},"projects":{}}"#))
        #expect(SessionLists.place(of: listing.facts(of: "ses_new")) == .project("/p"))
        listing.noteMade("ses_other", facts: .init(kind: .chat, directory: "/c", updated: 7))
        listing.take(try line(#"{"at":"e.3","full":true,"sessions":{},"projects":{}}"#))
        #expect(listing.sessions["ses_other"] == nil)
    }

    /// What its box said of a session it let go (deleted, or moved away) is kept for a row a client
    /// still holds, until it's listed again: then as it's listed.
    @Test func aSessionLetGoKeepsWhatItsBoxSaid() throws {
        func line(_ json: String) throws -> SessionLists.Line { try JSONDecoder().decode(SessionLists.Line.self, from: Data(json.utf8)) }
        var listing = SessionLists.Listing()
        listing.take(try line(#"{"at":"e.1","full":true,"sessions":{"ses_a":{"kind":"project","project":"/p","directory":"/p","created":1,"updated":2},"ses_b":{"kind":"chat","directory":"/c","created":1,"updated":3}},"projects":{}}"#))
        listing.take(try line(#"{"at":"e.2","sessions":{},"gone":["ses_a"],"projects":{}}"#))
        listing.take(try line(#"{"at":"f.1","full":true,"sessions":{},"projects":{}}"#))
        #expect(listing.sessions.isEmpty)
        #expect(listing.facts(of: "ses_a")?.project == "/p")
        #expect(listing.facts(of: "ses_b")?.kind == .chat)
        listing.take(try line(#"{"at":"f.2","sessions":{"ses_a":{"kind":"chat","directory":"/c","created":1,"updated":9}},"projects":{}}"#))
        #expect(listing.facts(of: "ses_a")?.kind == .chat)
        #expect(listing.former["ses_a"] == nil)
    }
}
