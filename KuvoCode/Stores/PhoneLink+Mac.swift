import Foundation
import KuvoLink

/// Settings › General's While Agents Work for a phone (PROTOCOL.md, `kuvo/mac`): this Mac opening
/// at login, and staying awake while agents work.
extension PhoneLink {
    func answerMac(_ request: LinkRequest) -> (Int, Data) {
        let login = OpenAtLogin.shared
        switch request.method.uppercased() {
        case "GET":
            login.refresh()
        case "PATCH":
            let body = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
            if let keeps = body["keepsAwake"] as? Bool {
                UserDefaults.standard.set(keeps, forKey: Awake.key)
                Awake.shared.update()
            }
            if let open = body["openAtLogin"] as? Bool {
                login.refresh()
                if open != login.isOn {
                    login.set(open)
                    if let failure = login.failure { return (409, Self.message(failure)) }
                }
            }
        default:
            return (405, Data())
        }
        return (200, Self.json(["openAtLogin": login.isOn, "keepsAwake": Awake.isOn, "awakeNow": Awake.shared.isHolding]))
    }
}
