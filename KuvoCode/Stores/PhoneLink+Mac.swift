import Foundation
import KuvoLink

/// Settings › General's While Agents Work for a phone (PROTOCOL.md, `kuvo/mac`): this Mac opening
/// at login, and staying awake while agents work.
extension PhoneLink {
    /// `awakeNow`: whether it's kept awake now, by the app or by the keeper it follows (which reads
    /// the setting as it changes, so a change here reaches it on its next look).
    func answerMac(_ request: LinkRequest) async -> (Int, Data) {
        let login = OpenAtLogin.shared
        switch request.method.uppercased() {
        case "GET":
            login.refresh()
        case "PATCH":
            let body = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
            // Open at Login first: when macOS won't change it, nothing changes.
            if let open = body["openAtLogin"] as? Bool {
                login.refresh()
                if open != login.isOn {
                    login.set(open)
                    if let failure = login.failure { return (409, Self.message(failure)) }
                }
            }
            if let keeps = body["keepsAwake"] as? Bool {
                UserDefaults.standard.set(keeps, forKey: Awake.key)
                Awake.shared.update()
            }
        default:
            return (405, Data("{}".utf8))
        }
        return (200, Self.json(["openAtLogin": login.isOn, "keepsAwake": Awake.isOn, "awakeNow": await Awake.shared.holdsNow()]))
    }
}
