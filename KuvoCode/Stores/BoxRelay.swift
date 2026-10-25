import Foundation
import KuvoLink

/// This Mac's relay connection, which its box holds (KuvoLink's PROTOCOL.md, "This Mac's box: the
/// relay"), as the app still uses it for what hasn't moved to the box yet: mail to your machines,
/// sealed here with this Mac's key (its documents, its agents' letters, its group chats'), and
/// notices for your phones, which the box seals for each. Both go out on the box's connection
/// (`kuvo/link/send`, `kuvo/link/push`).
struct BoxRelay: Sendable {
    let key: LinkKey
    let box: BoxClient

    /// `payload` to a machine's bridge (`remote` its key, at `address`): sent, not now (the box
    /// isn't on the relay, or isn't answering), or too big for the relay.
    func mail(_ payload: Data, to remote: Data, at address: LinkAddress) async -> LinkServer.MailOutcome {
        guard let frame = try? Mail.seal(payload, from: key, to: remote), frame.count <= RelayMessage.maxPayload else { return .tooBig }
        struct Sending: Encodable { var to: String; var frame: String }
        guard let body = try? JSONEncoder().encode(Sending(to: address.text, frame: frame.base64EncodedString())),
              let (status, _) = try? await box.send("POST", "kuvo/link/send", body: body) else { return .offline }
        switch status {
        case 200: return .sent
        case 413: return .tooBig
        default: return .offline
        }
    }

    /// `notice` (a `Notice`'s JSON) to your paired phones' notifications: false when it can't go
    /// now, to be tried again.
    func push(_ notice: Data) async -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: notice),
              let body = try? JSONSerialization.data(withJSONObject: ["notice": object]),
              let (status, _) = try? await box.send("POST", "kuvo/link/push", body: body) else { return false }
        return status == 200
    }
}
