import Foundation
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "app")

/// The app registered with this Mac's own box in a home of its own (#333 piece 3; KuvoLink's
/// PROTOCOL.md, "This Mac's app"), once it's attached to it in place: where the panel's browser tools
/// answer, for its agents' browser calls (the box's `kuvo-browser.js` sends them there, as the
/// keeper's tools do for the app's box in its folder), and where the app is installed, for the box to
/// open it by (its helper or keeper, at the box's ask) when an agent needs the browser while it's
/// closed. Only with `movesOwnBox` on, and only for a box that says it's a Mac's and takes it
/// (`box.app`): the box decides everything else. (What it's told as the app quits comes with the
/// rest of the app's side, #333 piece 6b: meanwhile the box finds the app gone when its tools stop
/// answering.)
extension AppModel {
    struct OwnBoxInfo: Decodable { var kind: String?; var features: [String]? }

    func registerWithOwnBox() async {
        guard Self.movesOwnBox, attached != nil else { return }
        let client = box(SSHConnection.thisMac)
        guard let info = try? await client.value(OwnBoxInfo.self, "GET", "kuvo/info"),
              info.kind == "mac", info.features?.contains("box.app") == true else { return }
        do {
            _ = try await browserTools.start()
            browserTools.owner = { [weak self] id in await self?.workspace.engineRunOwner(id) }
            browserTools.ready = { [weak self] in await self?.workspace.firstLoad(within: 20) }
        } catch {
            log.error("Browser tools didn't start for this Mac's box: \(error.localizedDescription, privacy: .public)")
            return
        }
        guard let tools = browserTools.agentsServer else { return }
        let body: [String: Any] = ["tools": ["url": tools.url, "token": tools.token], "bundle": Bundle.main.bundleURL.path(percentEncoded: false)]
        do {
            let (status, _) = try await client.send("POST", "kuvo/box/app", body: try JSONSerialization.data(withJSONObject: body))
            if status != 200 { log.error("This Mac's box didn't take the app's registration (\(status))") }
        } catch {
            log.error("The app couldn't register with this Mac's box: \(error.localizedDescription, privacy: .public)")
        }
    }
}
