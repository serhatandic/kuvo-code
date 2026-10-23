import Foundation
import KuvoLink
import OpenCodeKit

/// Settings › Worktrees for a phone (PROTOCOL.md, "Worktrees"): the worktrees this Mac's
/// sessions run in, on it and on your machines, and removing one as the page does.
extension PhoneLink {
    func answerWorktrees(_ request: LinkRequest) async -> (Int, Data) {
        guard let workspace else { return (503, Self.message("Kuvo Code isn't ready yet. Try again in a moment.")) }
        switch (request.method.uppercased(), request.path.split(separator: "?").first.map(String.init)) {
        case ("GET", "kuvo/worktrees"):
            return (200, Self.json(["worktrees": await Self.worktrees(workspace)]))
        case ("POST", "kuvo/worktrees/remove"):
            guard let root = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any])?["path"] as? String,
                  let (folder, tree) = workspace.worktrees.first(where: { $0.value.root == root }).map({ ($0.key, $0.value) }) else { return (404, Data()) }
            if workspace.api(forFolder: folder) == nil {
                let machine = RemoteFolder.machine(of: tree.root) ?? "This Mac"
                return (409, Self.message("\(machine) isn’t connected, so the worktree of \(tree.branch) can’t be removed now."))
            }
            do {
                try await workspace.removeWorktree(folder)
                return (200, Data("{}".utf8))
            } catch {
                return (409, Self.message(error.localizedDescription))
            }
        case (_, "kuvo/worktrees"), (_, "kuvo/worktrees/remove"):
            return (405, Data())
        default:
            return (404, Data())
        }
    }

    /// One per worktree (several session folders can share one), as Settings › Worktrees lists
    /// them, with what to know before removing one: whether an agent works there, changes that
    /// aren't committed, commits its base doesn't have. Git is asked where it is (a machine's over
    /// SSH, while connected); its size only on this Mac.
    private static func worktrees(_ workspace: Workspace) async -> [[String: Any]] {
        var seen = Set<String>()
        let trees = workspace.worktrees.values.sorted { $0.root < $1.root }.filter { seen.insert($0.root).inserted }
        let reachable = Set(trees.filter { tree in
            workspace.worktrees.contains { $0.value.root == tree.root && workspace.api(forFolder: $0.key) != nil }
        }.map(\.root))
        struct Look: Sendable { var uncommitted: Bool?; var ahead: Int?; var size: Int64? }
        let looks = await withTaskGroup(of: (String, Look).self) { group in
            for tree in trees where reachable.contains(tree.root) {
                group.addTask {
                    let local = RemoteFolder.machine(of: tree.root) == nil
                    // Gone from disk (deleted by hand): nothing to ask git.
                    if local, !FileManager.default.fileExists(atPath: tree.root) { return (tree.root, Look()) }
                    return (tree.root, Look(uncommitted: Git.hasUncommittedChanges(in: tree.root, includingHidden: true),
                                            ahead: tree.base.map { Git.commitsAhead(of: $0, in: tree.root) },
                                            size: local ? StorageReport.size(of: URL(filePath: tree.root)) : nil))
                }
            }
            var looks: [String: Look] = [:]
            for await (root, look) in group { looks[root] = look }
            return looks
        }
        return trees.map { tree in
            let sessions = workspace.sessions.filter { workspace.worktrees[$0.location.directory]?.root == tree.root }
            var entry: [String: Any] = [
                "path": tree.root, "project": tree.project, "projectName": workspace.projectName(tree.project), "branch": tree.branch,
                "sessions": sessions.count, "working": sessions.contains { workspace.isWorking($0.id) },
            ]
            if let base = tree.base { entry["base"] = base }
            if let machine = RemoteFolder.machine(of: tree.root) { entry["machine"] = machine }
            if let look = looks[tree.root] {
                if let uncommitted = look.uncommitted { entry["uncommitted"] = uncommitted }
                if let ahead = look.ahead { entry["ahead"] = ahead }
                if let size = look.size { entry["size"] = size }
            }
            return entry
        }
    }
}
