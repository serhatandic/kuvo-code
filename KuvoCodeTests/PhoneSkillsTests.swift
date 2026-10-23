import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// Settings › Skills from a phone, as this Mac answers it: its skills folder and which skills came
/// from GitHub; writing one (a new one's name as Settings would make it, and never over another);
/// and GitHub's collections, listed and installed from by this Mac. GitHub is stubbed (StubWeb).
@MainActor
@Suite(.serialized) struct PhoneSkillsTests {
    let app = AppModel()
    let link = PhoneLink()

    init() {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["api.github.com", "raw.githubusercontent.com"])
        app.bots.app = app
        link.bots = app.bots
        try? FileManager.default.removeItem(at: app.skillsFolder)
    }

    private func done() {
        StubWeb.stop()
        try? FileManager.default.removeItem(at: app.skillsFolder)
    }

    private func ask(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> (status: Int, json: [String: Any]) {
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data()
        let request = LinkRequest(method: method, path: path, headers: ["content-type": "application/json"], body: data)
        var status = 0
        var answer = Data()
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:47997/")!, password: nil, agents: nil) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): answer += chunk
            }
        }
        return (status, (try? JSONSerialization.jsonObject(with: answer) as? [String: Any]) ?? [:])
    }

    @Test func aPhoneWritesAndReadsThisMacsSkills() async throws {
        defer { done() }
        let listed = try await ask("kuvo/skills")
        #expect(listed.status == 200)
        #expect(listed.json["folder"] as? String == app.skillsFolder.path)

        let text = "---\nname: release-notes\ndescription: Writes the release notes\n---\nKeep them short.\n"
        #expect(try await ask("kuvo/skills/release-notes", method: "PUT", body: ["text": text, "new": true]).status == 200)
        #expect(FileManager.default.contents(atPath: app.skillsFolder.appending(path: "release-notes/SKILL.md").path) == Data(text.utf8))
        #expect(try await ask("kuvo/skills/release-notes").json["text"] as? String == text)
        let again = try await ask("kuvo/skills/release-notes", method: "PUT", body: ["text": text, "new": true])
        #expect(again.status == 409, "a new one never goes over another")
        #expect(try await ask("kuvo/skills/Release%20Notes", method: "PUT", body: ["text": text, "new": true]).status == 400)
        #expect(try await ask("kuvo/skills/..%2Fescape", method: "PUT", body: ["text": text]).status == 400)
        // Changed, as it's edited.
        #expect(try await ask("kuvo/skills/release-notes", method: "PUT", body: ["text": text + "And kind.\n"]).status == 200)
        #expect(try await ask("kuvo/skills/nowhere").status == 404)
        #expect(try await ask("kuvo/skills", method: "POST").status == 405)
        #expect(try await ask("kuvo/skills/%E0%A4%A").status == 400, "a name that can't be read")
    }

    /// A machine's bridge lists the same well-known collections as this Mac, in the same order.
    @Test func aMachineListsTheSameCollections() throws {
        let script = String(decoding: try Bridge.script, as: UTF8.self)
        let start = try #require(script.range(of: "export const SKILL_REPOSITORIES = ["))
        let end = try #require(script.range(of: "].map(", range: start.upperBound..<script.endIndex))
        let listed = script[start.upperBound..<end.lowerBound].split(separator: "\n").compactMap { line -> String? in
            let quoted = line.split(separator: "\"").enumerated().filter { $0.offset % 2 == 1 }.map(\.element)
            return quoted.count >= 4 ? "\(quoted[0])/\(quoted[1])|\(quoted[2])|\(quoted[3])" : nil
        }
        #expect(listed == SkillLibrary.repositories.map { "\($0.owner)/\($0.name)|\($0.title)|\($0.summary)" })
    }

    @Test func aPhoneInstallsFromGitHubThroughThisMac() async throws {
        defer { done() }
        try StubWeb.answer("https://api.github.com/repos/acme/skills", json: ["default_branch": "main", "description": "Acme's skills"])
        try StubWeb.answer("https://api.github.com/repos/acme/skills/git/trees/main?recursive=1", json: ["tree": [
            ["path": "skills/pdf/SKILL.md", "type": "blob"], ["path": "skills/pdf/fill.py", "type": "blob"],
        ], "truncated": false])
        StubWeb.answer("https://raw.githubusercontent.com/acme/skills/main/skills/pdf/SKILL.md", text: "---\nname: pdf\ndescription: Fills PDF forms\n---\nFill them.\n")
        StubWeb.answer("https://raw.githubusercontent.com/acme/skills/main/skills/pdf/fill.py", text: "print('hi')\n")

        let library = try await ask("kuvo/skill-library")
        #expect((library.json["repositories"] as? [[String: Any]])?.contains { $0["id"] as? String == "anthropics/skills" } == true)
        let listing = try await ask("kuvo/skill-library/acme/skills")
        #expect(listing.status == 200)
        #expect((listing.json["skills"] as? [[String: Any]])?.map { $0["name"] as? String } == ["pdf"])
        #expect(listing.json["partial"] as? Bool == false)
        let about = try await ask("kuvo/skill-library/acme/skills/about?path=skills%2Fpdf")
        #expect(about.json["description"] as? String == "Fills PDF forms")

        let installed = try await ask("kuvo/skill-library/install", method: "POST", body: ["repository": "acme/skills", "path": "skills/pdf"])
        #expect(installed.status == 200)
        #expect(installed.json["name"] as? String == "pdf")
        #expect(FileManager.default.contents(atPath: app.skillsFolder.appending(path: "pdf/fill.py").path) == Data("print('hi')\n".utf8))
        let github = try await ask("kuvo/skills").json["github"] as? [String: [String: String]]
        #expect(github?["pdf"] == ["repository": "acme/skills", "path": "skills/pdf"])
        #expect(try await ask("kuvo/skill-library/install", method: "POST", body: ["repository": "acme/skills", "path": "skills/pdf"]).status == 409)
        #expect(try await ask("kuvo/skill-library/install", method: "POST", body: ["repository": "acme/skills", "path": "skills/none"]).status == 404)
        // As it came, as Settings has it: not edited.
        #expect(try await ask("kuvo/skills/pdf", method: "PUT", body: ["text": "---\nname: pdf\n---\nMine now.\n"]).status == 409)
    }
}
