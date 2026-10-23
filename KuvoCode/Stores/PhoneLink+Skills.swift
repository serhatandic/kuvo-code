import Foundation
import KuvoLink

/// Settings › Skills for a phone (PROTOCOL.md, "Skills"): this Mac's skills folder, the skills you
/// write there, and GitHub's collections, which this Mac reaches, never the phone. A machine's
/// bridge answers the same paths for its own folder.
extension PhoneLink {
    /// `kuvo/skills…` and `kuvo/skill-library…`.
    func answerSkills(_ request: LinkRequest) async -> (Int, Data) {
        guard let app = bots?.app else { return (503, Self.message("Kuvo Code isn't ready yet. Try again in a moment.")) }
        let parts = URLComponents(string: request.path)
        // Split as written, then each part read: a name can't bring a "/" of its own in.
        let path = parts?.percentEncodedPath ?? request.path
        let method = request.method.uppercased()
        let place = SkillsPlace.mac(app.skillsFolder)
        let segments = path.split(separator: "/", omittingEmptySubsequences: false).map { String($0).removingPercentEncoding ?? String($0) }
        switch (method, segments.count, segments.dropFirst().first) {
        case ("GET", 2, "skills"):
            return (200, Self.json(["folder": await place.path() ?? app.skillsFolder.path, "github": Self.sources(await place.installed())]))
        case (_, 3, "skills"):
            return await answerSkill(segments[2], method, request.body, place)
        case ("GET", 2, "skill-library"):
            return (200, Self.json(["repositories": SkillLibrary.repositories.map(Self.described)]))
        case ("POST", 3, "skill-library") where segments[2] == "install":
            return await installSkill(request.body, place)
        case ("GET", 4, "skill-library"):
            return await listing(segments[2], segments[3])
        case ("GET", 5, "skill-library") where segments[4] == "about":
            let skillPath = parts?.queryItems?.first { $0.name == "path" }?.value ?? ""
            return await about(segments[2], segments[3], skillPath)
        default:
            return (404, Data())
        }
    }

    /// One skill: GET its SKILL.md (`{text}`); PUT `{text, new?}` writes it (`new`: a name that's
    /// taken is turned away); DELETE puts its folder in the Trash.
    private func answerSkill(_ name: String, _ method: String, _ body: Data, _ place: SkillsPlace) async -> (Int, Data) {
        guard Self.isFolderName(name) else { return (400, Self.message("That isn't a skill's name.")) }
        switch method {
        case "GET":
            guard let text = await place.read(name) else { return (404, Data()) }
            return (200, Self.json(["text": text]))
        case "PUT":
            let given = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            guard let text = given["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return (400, Self.message("Send the skill's SKILL.md as {\"text\": …}."))
            }
            let isNew = given["new"] as? Bool == true
            if isNew {
                guard SkillFile.name(from: name) == name else { return (400, Self.message("Names use lowercase letters a to z, digits and hyphens.")) }
                if await place.exists(name) { return (409, Self.message("There's a skill called \(name) already.")) }
            } else if !(await place.exists(name)) {
                return (404, Data())
            }
            do {
                try await place.write(name, text)
                if isNew { Analytics.shared.track("skill_written") }
                return (200, Data("{}".utf8))
            } catch {
                return (500, Self.message(error.localizedDescription))
            }
        case "DELETE":
            guard await place.exists(name) else { return (404, Data()) }
            do {
                try await place.remove(name)
                return (200, Data("{}".utf8))
            } catch {
                return (500, Self.message(error.localizedDescription))
            }
        default:
            return (405, Data())
        }
    }

    /// A collection's skills, by their folder: `{repository, skills: [{name, path, files}], partial}`.
    private func listing(_ owner: String, _ name: String) async -> (Int, Data) {
        do {
            let repository = try await Self.repository(owner, name)
            let listed = try await SkillLibrary.skills(in: repository)
            let skills = listed.skills.map { ["name": $0.name, "path": $0.path, "files": $0.files] as [String: Any] }
            return (200, Self.json(["repository": Self.described(repository), "skills": skills, "partial": listed.isPartial]))
        } catch {
            return Self.failed(error)
        }
    }

    /// What a skill's SKILL.md says it is: `{name?, description?}`, asked for as it's shown.
    private func about(_ owner: String, _ name: String, _ skillPath: String) async -> (Int, Data) {
        do {
            let repository = try await Self.repository(owner, name)
            let about = await SkillLibrary.about(SkillLibrary.RemoteSkill(repository: repository, path: skillPath, files: []))
            var answer: [String: Any] = [:]
            if let name = about.name { answer["name"] = name }
            if let description = about.description { answer["description"] = description }
            return (200, Self.json(answer))
        } catch {
            return Self.failed(error)
        }
    }

    /// `POST kuvo/skill-library/install` with `{repository: "owner/name", path}`: fetched from
    /// GitHub here and put in this Mac's folder, under its folder's name: `{name}`.
    private func installSkill(_ body: Data, _ place: SkillsPlace) async -> (Int, Data) {
        let given = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
        let parts = (given["repository"] as? String ?? "").split(separator: "/").map(String.init)
        guard parts.count == 2, let path = given["path"] as? String else { return (400, Self.message("Send {\"repository\": \"owner/name\", \"path\": …}.")) }
        do {
            let repository = try await Self.repository(parts[0], parts[1])
            guard let skill = try await SkillLibrary.skills(in: repository).skills.first(where: { $0.path == path }) else {
                return (404, Self.message("There's no skill at \(path) in \(repository.id)."))
            }
            try await place.install(skill)
            let listed = SkillLibrary.repositories.contains(repository)
            Analytics.shared.track("skill_added", ["collection": listed ? "\(repository.owner)/\(repository.name)" : "other"])
            return (200, Self.json(["name": skill.name]))
        } catch {
            return Self.failed(error)
        }
    }

    /// One of the well-known collections as listed, or any other by its name on GitHub.
    private static func repository(_ owner: String, _ name: String) async throws -> SkillLibrary.Repository {
        if let known = SkillLibrary.repositories.first(where: { $0.owner.lowercased() == owner.lowercased() && $0.name.lowercased() == name.lowercased() }) {
            return known
        }
        return try await SkillLibrary.repository(named: owner + "/" + name)
    }

    private static func described(_ repository: SkillLibrary.Repository) -> [String: Any] {
        ["id": repository.id, "owner": repository.owner, "name": repository.name, "title": repository.title, "summary": repository.summary]
    }

    private static func sources(_ installed: [String: SkillLibrary.Source]) -> [String: Any] {
        installed.mapValues { ["repository": $0.repository, "path": $0.path] }
    }

    /// A folder's name in the skills folder: not a path, nor hidden.
    private static func isFolderName(_ name: String) -> Bool {
        !name.isEmpty && name.count <= 128 && !name.hasPrefix(".") && !name.contains("/") && !name.contains("\\") && !name.contains("\0")
    }

    private static func failed(_ error: Error) -> (Int, Data) {
        switch error as? SkillLibrary.Failure {
        case .notFound: (404, message(error.localizedDescription))
        case .taken: (409, message(error.localizedDescription))
        case .limited: (503, message(error.localizedDescription))
        case nil: (502, message(error.localizedDescription))
        }
    }

    private static func json(_ value: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
    }
}
