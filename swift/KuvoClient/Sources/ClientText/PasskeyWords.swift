import Foundation

/// What both apps say when a site asks for a passkey, which Kuvo Code's browsers can't use yet:
/// in the panel's browser, and on an agent's card for that site.
public enum PasskeyWords {
    /// The note in the browser.
    public static let note = "This browser can’t use passkeys yet. Choose another way to sign in, like a password, a code or an email link."

    /// On an agent's card for `host`, the site that asked: away from the browser, it names it.
    public static func onCard(host: String) -> String {
        "\(host) asked for a passkey, which Kuvo Code’s browser can’t use yet. Choose another way to sign in, like a password, a code or an email link."
    }
}
