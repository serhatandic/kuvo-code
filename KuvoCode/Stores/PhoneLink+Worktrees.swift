import Foundation
import KuvoLink
import OpenCodeKit

/// Settings › Worktrees for a phone (PROTOCOL.md, "Worktrees"): the worktrees this Mac's
/// sessions run in, and removing one as the page does. A machine answers for its own.
extension PhoneLink {
    func answerWorktrees(_ request: LinkRequest) async -> (Int, Data) {
        guard let workspace else { return (503, Self.message("Kuvo Code isn't ready yet. Try again in a moment.")) }
        switch (request.method.uppercased(), request.path.split(separator: "?").first.map(String.init)) {
        case ("GET", "kuvo/worktrees"):
            return (200, Self.json(["worktrees": await Self.worktrees(workspace)]))
        case ("POST", "kuvo/worktrees"):
            // One for a new session, as the composer's Worktree makes it; the phone makes the
            // session in its folder.
            var isFolder: ObjCBool = false
            guard let project = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any])?["project"] as? String,
                  project.hasPrefix("/"), RemoteFolder.machine(of: project) == nil,
                  FileManager.default.fileExists(atPath: project, isDirectory: &isFolder), isFolder.boolValue else {
                return (400, Self.message("Send the project's folder on this Mac as {\"project\"}."))
            }
            guard workspace.api(forFolder: project) != nil else { return (503, Self.message("This Mac's engine isn't running.")) }
            do {
                let (folder, tree) = try await workspace.makeWorktree(forNewSessionIn: project)
                var made: [String: Any] = ["project": tree.project, "root": tree.root, "folder": folder, "branch": tree.branch]
                if let base = tree.base { made["base"] = base }
                return (200, Self.json(made))
            } catch let refused as GitFailure {
                return (409, Self.message(refused.message))
            } catch {
                return (502, Self.message(error.localizedDescription))
            }
        case ("POST", "kuvo/worktrees/remove"):
            let given = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
            guard let root = given["path"] as? String,
                  let (folder, tree) = workspace.worktrees.first(where: { $0.value.root == root && RemoteFolder.machine(of: $0.value.root) == nil }).map({ ($0.key, $0.value) })
            else { return (404, Data("{}".utf8)) }
            if workspace.api(forFolder: folder) == nil {
                return (409, Self.message("This Mac's engine isn't running, so the worktree of \(tree.branch) can't be removed now."))
            }
            // Made for a session that never started: taken back, branch and all, as the composer
            // takes one back (not one you removed). Not one a session has after all.
            if given["forget"] as? Bool == true {
                if workspace.sessions.contains(where: { workspace.worktrees[$0.location.directory]?.root == tree.root }) {
                    return (409, Self.message("A session works in the worktree of \(tree.branch), so it stays. Remove it with the session, or in Settings › Worktrees."))
                }
                if given["discard"] as? Bool == false,
                   await Task.detached(operation: { Git.hasUncommittedChanges(in: tree.root, includingHidden: true) }).value {
                    return (409, Self.message("The worktree of \(tree.branch) has changes that aren’t committed, so it stays."))
                }
                guard await workspace.discardWorktree(folder) else { return (502, Self.message("The worktree of \(tree.branch) couldn't be removed. Try again, or remove it in Settings › Worktrees.")) }
                return (200, Data("{}".utf8))
            }
            do {
                // With changes not committed only when they're to go (`"discard": false` keeps one that has some).
                try await workspace.removeWorktree(folder, discardingChanges: given["discard"] as? Bool != false)
                return (200, Data("{}".utf8))
            } catch let refused as GitFailure {
                return (409, Self.message(refused.message))
            } catch {
                // The engine couldn't.
                return (502, Self.message(error.localizedDescription))
            }
        case (_, "kuvo/worktrees"), (_, "kuvo/worktrees/remove"):
            return (405, Data())
        default:
            return (404, Data())
        }
    }

    /// One per worktree on this Mac (several session folders can share one), as Settings ›
    /// Worktrees lists them, with what to know before removing one: whether an agent works there,
    /// changes that aren't committed, commits its base doesn't have (left out where git can't say:
    /// a folder deleted by hand), and its size. Git is asked one worktree at a time, off the main
    /// thread.
    private static func worktrees(_ workspace: Workspace) async -> [[String: Any]] {
        var seen = Set<String>()
        let trees = workspace.worktrees.values.filter { RemoteFolder.machine(of: $0.root) == nil }.sorted { $0.root < $1.root }.filter { seen.insert($0.root).inserted }
        struct Look: Sendable { var uncommitted: Bool?; var ahead: Int?; var size: Int64? }
        let looks = await Task.detached {
            var looks: [String: Look] = [:]
            for tree in trees where FileManager.default.fileExists(atPath: tree.root) {
                let uncommitted = Git.uncommittedChanges(in: tree.root, includingHidden: true)
                looks[tree.root] = Look(uncommitted: uncommitted,
                                        ahead: uncommitted == nil ? nil : tree.base.flatMap { Git.commitsAhead(of: $0, in: tree.root) },
                                        size: StorageReport.size(of: URL(filePath: tree.root)))
            }
            return looks
        }.value
        return trees.map { tree in
            let sessions = workspace.sessions.filter { workspace.worktrees[$0.location.directory]?.root == tree.root }
            // Where its sessions run: the project's place in the worktree, as it was made.
            let folder = workspace.worktrees.filter { $0.value.root == tree.root }.keys.sorted().first ?? tree.root
            var entry: [String: Any] = [
                "path": tree.root, "folder": folder, "project": tree.project, "projectName": workspace.projectName(tree.project), "branch": tree.branch,
                "sessions": sessions.count, "working": sessions.contains { workspace.isWorking($0.id) },
            ]
            if let base = tree.base { entry["base"] = base }
            if let look = looks[tree.root] {
                if let uncommitted = look.uncommitted { entry["uncommitted"] = uncommitted }
                if let ahead = look.ahead { entry["ahead"] = ahead }
                if let size = look.size { entry["size"] = size }
            }
            return entry
        }
    }
}
