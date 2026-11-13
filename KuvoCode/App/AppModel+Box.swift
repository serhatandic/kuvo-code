import Foundation
import KuvoLink
import OpenCodeKit

extension AppModel {
    /// A box's routes, for the app's stores, as a phone reaches them: this Mac's (`BoxClient.mac`),
    /// or a machine's by its id.
    func box(_ id: String) -> BoxClient {
        // This Mac's own box, moved into a home of its own: its app is its own client there.
        if id == SSHConnection.thisMac, OwnBoxHome.hasMoved { return OwnBoxHome.client }
        guard id == BoxClient.mac else { return .machine(id) }
        // While the engine's down, the box's own routes still answer; the engine's say it's down.
        let endpoint = api?.client.endpoint ?? ServerEndpoint(url: URL(string: "http://127.0.0.1:9/")!, password: nil)
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url : URL(string: endpoint.url.absoluteString + "/")!
        let password = endpoint.password
        let agents = agents.address
        let link = phoneLink
        return BoxClient(box: id, transport: LocalBox { request in
            PhoneLink.respond(to: request, link: link, engine: base, password: password, agents: agents)
        })
    }
}
