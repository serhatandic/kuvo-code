import Foundation
import KuvoLink
import OpenCodeKit

extension AppModel {
    /// A box's routes, for the app's stores, as a phone reaches them: this Mac's (`BoxClient.mac`),
    /// or a machine's by its id.
    func box(_ id: String) -> BoxClient {
        guard id == BoxClient.mac else {
            return BoxClient(box: id, transport: MachineBoxTransport(connection: SSHConnection(destination: id)))
        }
        // While the engine's down, the box's own routes still answer; the engine's say it's down.
        let endpoint = server?.endpoint ?? ServerEndpoint(url: URL(string: "http://127.0.0.1:9/")!, password: nil)
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url : URL(string: endpoint.url.absoluteString + "/")!
        let password = endpoint.password
        let agents = agents.address
        let link = phoneLink
        return BoxClient(box: id, transport: LocalBox { request in
            PhoneLink.respond(to: request, link: link, engine: base, password: password, agents: agents)
        })
    }
}
