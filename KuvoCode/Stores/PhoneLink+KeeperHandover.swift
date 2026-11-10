import Foundation
import KuvoLink
import OpenCodeKit

// COMPAT(0.8 keeper handover): an older keeper's box, before bridge 0.9.210, answers kuvo/info as a machine's; remove 3 months after 0.8.0.
//
// While an older app's keeper makes way for this one's (it goes once nothing is under way, which can
// take hours), this app's box is that keeper's, from before boxes answered `kuvo/info` for their
// Mac: it says it's a machine, with its own chats folder, its engine not running (a Mac's isn't
// where a machine's is) and a machine's features. The app says it as this Mac in its place, from
// what that box said, as it did before the box answered it. A box that says it's this Mac's is
// passed on as it is: the box's is the one answer.
extension PhoneLink {
    /// The one route whose answer the app looks at on its way back from its box.
    nonisolated static let handoverRoute = "kuvo/info"

    /// The box's answer to `kuvo/info`, as it came, or this Mac's from an older keeper's box's.
    nonisolated static func handedOver(_ answer: AsyncThrowingStream<LinkResponsePart, Error>) -> AsyncThrowingStream<LinkResponsePart, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var status = 0
                    var headers: [String: String] = [:]
                    var body = Data()
                    for try await part in answer {
                        switch part {
                        case .head(let code, let given): status = code; headers = given
                        case .body(let chunk): body += chunk
                        }
                    }
                    if status == 200, let info = try? JSONSerialization.jsonObject(with: body) as? [String: Any], info["kind"] as? String == "machine" {
                        body = await macInfo(fromOlderBox: info)
                    }
                    continuation.yield(.head(status: status, headers: headers))
                    continuation.yield(.body(body))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// This Mac's `kuvo/info` from what an older keeper's box said: its engine's version, whether
    /// the coding agents run and when the engine came up, as it said them; the rest this Mac's, its
    /// features those of every box and the Mac's own, without a machine's (`macFeatures`, as the
    /// box has them).
    static func macInfo(fromOlderBox info: [String: Any]) -> Data {
        let machineOwn: Set = ["engine.start", "update"]
        var features = (info["features"] as? [String] ?? []).filter { !machineOwn.contains($0) }
        features += ["accounts.ended", "claude-code", "hosts", "mac", "machines", "usage"].filter { !features.contains($0) }
        let said: [String: Any] = [
            "kind": "mac", "name": computerName, "app": AppInfo.version, "engine": info["engine"] as? String ?? OpenCodeEngine.version,
            "chats": Workspace.chatsFolder, "agents": info["agents"] as? Bool ?? false, "started": info["started"] as? Double ?? NSNull(),
            "integrations": Dictionary(Integrations.all.map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first }), "features": features,
        ]
        return (try? JSONSerialization.data(withJSONObject: said, options: [.sortedKeys])) ?? Data("{}".utf8)
    }
}
