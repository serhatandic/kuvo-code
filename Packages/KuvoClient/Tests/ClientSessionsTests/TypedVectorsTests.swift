import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// What a typed message says, read by the Swift both apps draw the composer with (OpenCodeKit's
/// `Keyword`, `LoopCommand`, `GoalCommand`, `ReviewCommand`; `SlashCommands`) as the box reads it
/// when it's sent (`kuvo/sessions/<id>/typed`): both held to Packages/KuvoLink/Vectors/typed.json,
/// so the keyword drawn as you type is the one the box runs.
struct TypedVectorsTests {
    nonisolated(unsafe) static let vectors: [String: Any] = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../KuvoLink/Vectors/typed.json")
        return (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any] ?? [:]
    }()

    static func cases(_ name: String) -> [[String: Any]] { vectors[name] as? [[String: Any]] ?? [] }

    /// `value` as the vectors write it (JSON's null as NSNull).
    static func same(_ value: Any?, _ expected: Any?) -> Bool {
        let value = value ?? NSNull(), expected = expected ?? NSNull()
        return NSArray(object: value).isEqual(NSArray(object: expected))
    }

    static func ref(_ ref: ModelRef?) -> Any { ref.map { ["providerID": $0.providerID, "id": $0.id] } ?? NSNull() }

    static func scope(_ scope: ReviewScope?) -> Any {
        guard let scope, let data = try? JSONEncoder().encode(scope) else { return NSNull() }
        return (try? JSONSerialization.jsonObject(with: data)) ?? NSNull()
    }

    @Test func theFileIsThere() {
        #expect(!Self.cases("keywords").isEmpty && !Self.cases("reviews").isEmpty)
    }

    @Test(arguments: cases("keywords").indices) func keyword(_ at: Int) {
        let each = Self.cases("keywords")[at]
        let text = each["text"] as! String
        let parsed: Any = Keyword.parse(text).map { ["keyword": $0.keyword.rawValue, "rest": $0.rest] } ?? NSNull()
        #expect(Self.same(parsed, each["parsed"]), "\(text)")
    }

    @Test(arguments: cases("goals").indices) func goal(_ at: Int) {
        let each = Self.cases("goals")[at]
        let text = each["text"] as! String
        let goal: Any = switch GoalCommand(text) {
        case .set(let words)?: ["kind": "set", "words": words]
        case .show?: ["kind": "show"]
        case .pause?: ["kind": "pause"]
        case .resume?: ["kind": "resume"]
        case .clear?: ["kind": "clear"]
        case nil: NSNull()
        }
        #expect(Self.same(goal, each["goal"]), "\(text)")
    }

    @Test(arguments: cases("loops").indices) func loop(_ at: Int) {
        let each = Self.cases("loops")[at]
        let rest = each["rest"] as! String
        let loop = LoopCommand(rest)
        let schedule: Any = loop.schedule.map { schedule -> [String: Any] in
            var said: [String: Any] = ["every": schedule.every.text]
            if let hour = schedule.hour { said["hour"] = hour; said["minute"] = schedule.minute ?? 0 }
            return said
        } ?? NSNull()
        #expect(Self.same(schedule, each["schedule"]), "\(rest)")
        #expect(loop.message == each["message"] as? String, "\(rest)")
        #expect(loop.scheduleLength == each["scheduleLength"] as? Int, "\(rest)")
        #expect(loop.scheduleText == each["scheduleText"] as? String, "\(rest)")
    }

    @Test(arguments: cases("firstWakes").indices) func firstWake(_ at: Int) throws {
        let each = Self.cases("firstWakes")[at]
        let rest = each["rest"] as! String
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: each["timeZone"] as! String))
        let now = try Date.ISO8601FormatStyle().parse(each["now"] as! String)
        let due = try #require(LoopCommand(rest).schedule).firstWake(now: now, calendar: calendar)
        // ("2026-11-13T10:30:00.000Z", as JavaScript writes a date.)
        let expected = try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(each["due"] as! String)
        #expect(due == expected, "\(rest) at \(each["now"]!) in \(each["timeZone"]!)")
    }

    static let readers: [ReviewCommand.Reader] = (vectors["reviewReaders"] as? [[String: Any]] ?? []).map { reader in
        let ref = reader["ref"] as! [String: String]
        return ReviewCommand.Reader(name: reader["name"] as! String, ref: ModelRef(id: ref["id"]!, providerID: ref["providerID"]!), provider: reader["provider"] as! String)
    }

    @Test(arguments: cases("reviews").indices) func review(_ at: Int) {
        let each = Self.cases("reviews")[at]
        let rest = each["rest"] as! String
        let preferring = (each["preferring"] as? [String: String]).map { ModelRef(id: $0["id"]!, providerID: $0["providerID"]!) }
        let review = ReviewCommand(rest, readers: Self.readers, preferring: preferring)
        let asking: Any = switch review.asking {
        case .what(let typed)?: ["list": "what", "typed": typed]
        case .commit(let typed)?: ["list": "commit", "typed": typed]
        case .folder(let typed)?: ["list": "folder", "typed": typed]
        case .lookFor(let typed)?: ["list": "lookFor", "typed": typed]
        case nil: NSNull()
        }
        let read: [String: Any] = [
            "scope": Self.scope(review.scope), "described": review.described ?? NSNull(), "preset": review.preset?.rawValue ?? NSNull(),
            "reader": Self.ref(review.reader?.ref), "focus": review.focus, "readerLength": review.readerLength, "searching": review.searching ?? NSNull(),
            "asking": asking, "head": review.head, "scopeAsked": Self.scope(review.scopeAsked), "focusAsked": review.focusAsked ?? NSNull(),
            "unfinished": ReviewList.unfinished(review) ?? NSNull(),
        ]
        for (key, value) in read {
            #expect(Self.same(value, each[key]), "\(rest): \(key)")
        }
    }

    @Test(arguments: cases("commands").indices) func command(_ at: Int) {
        let each = Self.cases("commands")[at]
        let text = each["text"] as! String
        let commands = (each["commands"] as! [String]).map { try! JSONDecoder().decode(Command.self, from: Data(#"{"name":"\#($0)"}"#.utf8)) }
        let keywords = (each["keywords"] as! [String]).compactMap(Keyword.init(rawValue:))
        let offered = Keyword.commands(commands, keywords: keywords)
        #expect(offered.map(\.name) == each["offered"] as? [String], "\(text)")
        let split: Any = SlashCommands.split(text).map { ["name": $0.name, "arguments": $0.arguments] } ?? NSNull()
        #expect(Self.same(split, each["split"]), "\(text)")
        let parsed: Any = SlashCommands.parse(text, commands: offered).map { ["name": $0.name, "arguments": $0.arguments] } ?? NSNull()
        #expect(Self.same(parsed, each["parsed"]), "\(text)")
    }
}
