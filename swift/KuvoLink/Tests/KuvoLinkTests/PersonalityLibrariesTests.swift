import Foundation
import Testing
@testable import KuvoLink

/// `Vectors/personalities.json`, which the bridge's `mergePersonalities` checks against too.
@Suite struct PersonalityLibrariesTests {
    /// A personality as a vector writes it: some aren't ones (no words, a preset), which a copy
    /// drops as it reads them.
    struct Written: Decodable {
        var id: String
        var name: String?
        var description: String?
        var symbol: String?
        var updated: Double?
    }

    struct Library: Decodable {
        var personalities: [Written]?
        var removed: [PersonalityLibraries.Removal]?
    }

    struct Case: Decodable {
        var name: String
        var libraries: [Library]
        var expected: PersonalityLibraries.Library
    }

    @Test func theyMeetAsTheVectorsSay() throws {
        struct Vectors: Decodable { var cases: [Case] }
        let data = try Data(contentsOf: KuvoLinkTests.Vectors.folder.appending(path: "personalities.json"))
        let cases = try JSONDecoder().decode(Vectors.self, from: data).cases
        #expect(!cases.isEmpty)
        for each in cases {
            let libraries = each.libraries.map { library in
                PersonalityLibraries.Library(
                    personalities: (library.personalities ?? []).compactMap { written in
                        guard let name = written.name, let description = written.description else { return nil }
                        return PersonalityLibraries.Kept(id: written.id, name: name, description: description, symbol: written.symbol ?? "person.crop.circle", updated: written.updated ?? 0)
                    },
                    removed: library.removed ?? [])
            }
            #expect(PersonalityLibraries.merged(libraries) == each.expected, "\(each.name)")
        }
    }
}
