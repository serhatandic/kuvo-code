import Foundation
import OpenCodeKit

extension AppModel {
    /// Integrations whose servers keep their sign-in in files of their own (Outlook's, from its
    /// code sign-in), in the integration's folder: for one this Mac and a machine both have, those
    /// files go between them together, the side whose sign-in (the first file) is newer winning,
    /// so a sign-in that renews itself, copied there before each computer had its own, keeps
    /// working on both. Each copy keeps the time it was changed, so the two settle rather than
    /// going back and forth.
    func syncSignInFiles(with engine: MachineEngine) async {
        // In its turn with the other copying of sign-ins (and a machine being signed out of), and
        // only while it's connected: one disconnected or removed meanwhile gets none.
        let previous = engine.signInTurn
        let turn = Task { [weak self, weak engine] in
            await previous?.value
            guard let self, let engine, engine.activeConnection != nil else { return }
            await copySignInFiles(with: engine)
        }
        engine.signInTurn = turn
        await turn.value
    }

    private func copySignInFiles(with engine: MachineEngine) async {
        let machine = engine.machine.id
        // Those added on both.
        let here = Set(engineConfig.value(at: MCPSettings.path)?.object?.keys.map(\.self) ?? [])
        let added = here.intersection(engine.config.value(at: MCPSettings.path)?.object?.keys.map(\.self) ?? [])
        for (id, names) in Integrations.signInFiles where added.contains(id) {
            // Each file here and there, the sign-in first.
            let files = names.map { name in
                (local: AppInfo.supportDirectory.appending(path: "integrations/\(id)/\(name)"), remote: "\"$HOME/\(RemoteEngineInstaller.root)/integrations/\(id)/\(name)\"")
            }
            guard let lead = files.first else { continue }
            await Task.detached {
                let here = (try? lead.local.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)?.timeIntervalSince1970 ?? 0
                // Unknown when SSH failed (left for the next pass): taken as none there, a
                // sign-in the machine renewed would be overwritten with this Mac's older one.
                guard let output = RemoteShell.run("stat -c %Y \(lead.remote) 2>/dev/null || echo 0", on: machine),
                      let there = Double(String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
                if here > there + 1 {
                    // Over SSH's own connection, readable by you alone there; the sign-in last, so
                    // it's never there without its key.
                    for file in files.reversed() where FileManager.default.fileExists(atPath: file.local.path) {
                        let changed = (try? file.local.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)?.timeIntervalSince1970 ?? here
                        _ = try? await SSHConnection(destination: machine).run(
                            "umask 077; mkdir -p \"$(dirname \(file.remote))\" && cat >\(file.remote).new && mv -f \(file.remote).new \(file.remote) && touch -d @\(Int(changed)) \(file.remote)",
                            input: file.local)
                    }
                } else if there > here + 1 {
                    for file in files.reversed() {
                        guard let data = RemoteShell.run("cat \(file.remote) 2>/dev/null", on: machine), !data.isEmpty,
                              let stamp = RemoteShell.run("stat -c %Y \(file.remote) 2>/dev/null", on: machine),
                              let changed = Double(String(decoding: stamp, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)) else { continue }
                        try? FileManager.default.createDirectory(at: file.local.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                        guard (try? data.write(to: file.local, options: .atomic)) != nil else { continue }
                        try? FileManager.default.setAttributes([.posixPermissions: 0o600, .modificationDate: Date(timeIntervalSince1970: changed)], ofItemAtPath: file.local.path)
                    }
                }
            }.value
        }
    }
}
