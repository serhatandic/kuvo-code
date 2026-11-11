import Foundation
import OpenCodeKit

// Which project a session is filed under (PROTOCOL.md, "Projects"), the same on the Mac and the
// phone: as its box says of its folder (`worktrees` in `kuvo/projects`: a worktree's, or one of a
// project's other folders); else the project it carries from when it was made (`kuvo.filed`), as a
// client may hear of a session from its engine before its box's list names a new worktree, and the
// list never names a subfolder; else its own folder.

public enum SessionProject {
    /// The project its box filed `session` under as it was made (`metadata.kuvo.filed`: `{folder,
    /// project}`), while it still runs in that folder (`folder`, as its box names it): nil for one
    /// made in its project's own folder, or moved since.
    public static func filed(_ session: Session, folder: String) -> String? {
        guard let filed = session.metadata?["kuvo"]?["filed"], filed["folder"]?.string == folder,
              let project = filed["project"]?.string, !project.isEmpty, project != folder else { return nil }
        return project
    }

    /// The project `session` is filed under, by its `folder`: as its box says of that folder
    /// (`listed`, nil where it says nothing), else as its own mark says (`filed`), the project that
    /// names as its box says of it too, else the folder itself.
    public static func project(of session: Session, folder: String, listed: (String) -> String?) -> String {
        if let said = listed(folder) { return said }
        guard let filed = filed(session, folder: folder) else { return folder }
        return listed(filed) ?? filed
    }

    /// What a client gives a session it makes in a worktree its box just made (`POST
    /// kuvo/worktrees`'s `folder` and `project`), as `kuvo.filed` in its metadata, as the box's own
    /// start does: so every client files it under its project from its first listing.
    public static func mark(folder: String, project: String) -> JSONValue {
        .object(["folder": .string(folder), "project": .string(project)])
    }
}
