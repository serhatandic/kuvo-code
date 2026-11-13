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
            let place = { (id: String) in SessionLists.place(of: facts[id], isArchived: facts[id]?.archived == true) }
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
        #expect(SessionLists.place(of: listing.sessions["ses_c"], isArchived: false) == nil)
        #expect(SessionLists.place(of: listing.sessions["ses_a"], isArchived: false) == .project("/p"))
        #expect(SessionLists.place(of: listing.sessions["ses_a"], isArchived: true) == nil, "archived as the client just made it")
        // Nothing new: said so.
        #expect(!listing.take(try line(#"{"at":"e.3","sessions":{},"projects":{"/p":{"updated":2}}}"#)))
        #expect(listing.at == "e.3")
        #expect(listing.take(try line(#"{"at":"f.1","full":true,"sessions":{},"projects":{}}"#)))
        #expect(listing.sessions.isEmpty)
        #expect(SessionLists.route(since: "e.3") == "kuvo/sessions/list?since=e.3")
        #expect(SessionLists.eventsRoute() == "kuvo/sessions/list/events")
    }
}
