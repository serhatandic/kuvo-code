import ClientSessions
import Foundation

extension CommandMessages {
    /// The app's notes of which messages ran a command (KuvoClient's `CommandMessages`), kept in
    /// its settings.
    static let shared = CommandMessages(defaults: .standard)
}
