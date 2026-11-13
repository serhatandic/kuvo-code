import Foundation
import Testing
@testable import KuvoCode

/// The tests' stand-in for a box's session list (`ListingBox`) says what the box says, on the same
/// vectors the box's own test holds it to (Packages/KuvoLink/Vectors/session-lists.json), so a test
/// drawing the sidebar from it draws what a box would give.
struct ListingBoxTests {
    @Test func theStandInSaysWhatTheBoxSays() throws {
        let file = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../Packages/KuvoLink/Vectors/session-lists.json").standardized
        let read = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let cases = try #require(read["cases"] as? [[String: Any]])
        #expect(!cases.isEmpty)
        for each in cases {
            let box = try #require(each["box"] as? [String: Any])
            let list = (box["projects"] as? [[String: Any]] ?? []).filter { $0["removed"] as? Bool != true }
            let place = ListingBox.Place(chats: box["chats"] as? String ?? "", bots: box["bots"] as? String ?? "",
                                         botSessions: Set(box["botSessions"] as? [String] ?? []), filed: box["filed"] as? [String: String] ?? [:],
                                         projects: Dictionary(list.map { ($0["directory"] as? String ?? "", $0["name"] as? String) }) { first, _ in first })
            let listed = ListingBox.list(each["sessions"] as? [[String: Any]] ?? [], place: place, running: Set(box["running"] as? [String] ?? []),
                                         asked: (box["asked"] as? [String: NSNumber] ?? [:]).mapValues(\.doubleValue), away: Set(box["away"] as? [String] ?? []))
            let expect = try #require(each["expect"] as? [String: Any])
            #expect(NSDictionary(dictionary: listed.sessions).isEqual(to: expect["sessions"] as? [String: Any] ?? [:]), "\(each["name"] ?? "")")
            #expect(NSDictionary(dictionary: listed.projects).isEqual(to: expect["projects"] as? [String: Any] ?? [:]), "\(each["name"] ?? "")")
        }
    }
}
