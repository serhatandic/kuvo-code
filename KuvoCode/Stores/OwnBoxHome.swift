import Foundation
import KuvoLink
import OpenCodeKit
import os

/// Where this Mac's own box is once it has moved out of the app's folder into a home of its own,
/// `~/.kuvo-code`, laid out as a machine's (#333; KuvoLink's PROTOCOL.md, "Moving this Mac's box"):
/// the box's facts, as it records them there, for the app's few writes that still go into the box's
/// folder (your machines' list, your machines' bridges) and for the Keychain, which is the box's
/// helper's then. Everything else the app does with that box goes through its routes, as a client.
nonisolated enum OwnBoxHome {
    /// The box's home: the machines' folder `here` looks in (`Here.root` in `AppModel.hereHome`), or
    /// nil for a copy that has none.
    static var folder: URL? {
        Here.root.map { AppModel.hereHome.appending(path: $0, directoryHint: .isDirectory) }
    }

    /// The kind the box there recorded (`box/kind`: `mac` once this Mac's box moved there).
    static func kind(in folder: URL) -> String? {
        (try? String(contentsOf: folder.appending(path: "box/kind"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether this Mac's box lives in its own home now (`movesOwnBox`, and the box there says it's
    /// this Mac's): the app writes nothing in its own folder for it, and reads none of its keys.
    /// Read once for where it looks (views ask it often), and again after `recheck` (the app
    /// attaching to a box, or no longer).
    static var hasMoved: Bool {
        guard AppModel.movesOwnBox, let folder else { return false }
        return seen.withLock { seen in
            if let seen = seen, seen.folder == folder { return seen.moved }
            let moved = kind(in: folder) == "mac"
            seen = (folder, moved)
            return moved
        }
    }
    private static let seen = OSAllocatedUnfairLock<(folder: URL, moved: Bool)?>(initialState: nil)

    /// Looks again whether the box has moved, the next time it's asked.
    static func recheck() {
        seen.withLock { $0 = nil }
    }

    /// Where the app keeps `name` for this Mac's box: in its home once it has moved, else beside it in
    /// the app's folder (`inSupport`, as today).
    static func file(_ name: String, inSupport: String) -> URL {
        if hasMoved, let folder { return folder.appending(path: name) }
        return AppInfo.supportDirectory.appending(path: inSupport)
    }

    /// This Mac's box, moved, as its own app reaches its routes: over the box's own server, where
    /// `run/serve.json` says it answers (its helper keeps it up, PROTOCOL.md "Kept for clients"), as
    /// Kuvo Code on this Mac (`x-kuvo-from: app`): what only its app may ask (its keys' proofs, the
    /// keys kept for a machine's bots, its vault's values to show) is the app's there. Read again for
    /// each request, so a server started again is found; while there's none, as any box attached in
    /// place (`box route`), which answers those as it would anyone on this Mac: refused.
    static var client: BoxClient {
        let folder = folder
        return BoxClient(box: SSHConnection.thisMac, transport: LocalBox { request in
            guard let folder, let served = served(in: folder) else {
                // (`box route`'s transport is the main actor's.)
                return AsyncThrowingStream { answer in
                    let task = Task { @MainActor in
                        do {
                            for try await part in MachineBoxTransport(connection: SSHConnection(destination: SSHConnection.thisMac)).send(request) { answer.yield(part) }
                            answer.finish()
                        } catch {
                            answer.finish(throwing: error)
                        }
                    }
                    answer.onTermination = { _ in task.cancel() }
                }
            }
            return EngineRoutes.forward(request, to: served.base, password: served.password, session: PhoneLink.boxSession, adding: ["x-kuvo-from": "app"],
                                        allowing: { path, _ in path.hasPrefix("kuvo/") })
        })
    }

    /// Where the box's server answers, as `run/serve.json` says: on this Mac, with its password.
    static func served(in folder: URL) -> (base: URL, password: String)? {
        guard let data = try? Data(contentsOf: folder.appending(path: "run/serve.json")),
              let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let port = record["port"] as? Int, (1...65535).contains(port), let password = record["password"] as? String, !password.isEmpty,
              let base = URL(string: "http://127.0.0.1:\(port)/") else { return nil }
        return (base, password)
    }

    /// Whether this Mac's keys are its box's own, whether or not the app uses that box yet: it moved
    /// there (`box/kind`), or a move of it is under way or left part way (its journal not done, as
    /// `here` reads it, or the Keychain's copies' journal, in `updates/rehome`). Then nothing in the
    /// app makes a key for it, even one it finds missing: the box's helper holds them, and refuses to
    /// make one the box had (`BoxHelperHost.keep`). Made anew here, it would be another Mac to every
    /// phone and machine. (With `movesOwnBox` off, nothing moves, so none of these is there.)
    static var keysAreTheBoxs: Bool {
        guard let folder else { return false }
        if kind(in: folder) == "mac" { return true }
        let rehome = folder.appending(path: "updates/rehome")
        if FileManager.default.fileExists(atPath: rehome.appending(path: "keychain.json").path) { return true }
        let journal = rehome.appending(path: "journal.json")
        guard FileManager.default.fileExists(atPath: journal.path) else { return false }
        // (One that can't be read is under way, as `here` takes it.)
        guard let data = try? Data(contentsOf: journal) else { return true }
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["step"] as? String != "done"
    }
}
