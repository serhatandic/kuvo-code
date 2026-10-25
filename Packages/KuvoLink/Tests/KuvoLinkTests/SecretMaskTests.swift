import Foundation
import Testing
@testable import KuvoLink

/// What a notification shows of an agent's words: secrets it saw (keys, tokens, passwords) as
/// dots, everything else as written, so a notification on a lock screen or a phone never shows a
/// key, and still says what happened. The bridge masks a box's notices for your phones by the same
/// rules: both are held to `Vectors/masking.json`, which `KUVO_WRITE_VECTORS=1 swift test --filter
/// SecretMaskTests` writes from these rules.
@Suite struct SecretMaskTests {
    static let vectors = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../Vectors/masking.json").standardized

    /// Each line's secret, which the notification must not show.
    static let secrets: [(String, String)] = [
        ("export OPENAI_API_KEY=sk-proj-4fJk29dLqZx81mNbVc7TyQ", "sk-proj-4fJk29dLqZx81mNbVc7TyQ"),
        ("curl -H \"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl\" https://api.example.com", "eyJhbGciOiJIUzI1NiJ9"),
        ("git remote add origin https://kuvo:ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8@github.com/acme/app", "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
        ("DATABASE_URL=postgres://admin:hunter2secret@db.internal:5432/app", "hunter2secret"),
        ("\"password\": \"correct-horse-battery\"", "correct-horse-battery"),
        ("aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"),
        ("Set ENCRYPTION_KEY=\"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\" in .env", "9f86d081884c7d659a2feaa0c55ad015"),
        ("mysql -u root --password=S3cr3tPassw0rd app", "S3cr3tPassw0rd"),
        ("Posting to https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX", "T000/B000"),
        ("Deployed with --access-token tok_9KfL2mQx7RpZ4wYb", "tok_9KfL2mQx7RpZ4wYb"),
        ("The key is AKIAIOSFODNN7EXAMPLE, rotate it", "AKIAIOSFODNN7EXAMPLE"),
        ("curl -u deploy:Pl4inPassw0rd https://ci.example.com/hook", "Pl4inPassw0rd"),
        ("mysql -uroot -pS3cretPass app", "S3cretPass"),
        ("Authorization: Basic dXNlcjpzZWNyZXRwYXNzd29yZA==", "dXNlcjpzZWNyZXRwYXNzd29yZA"),
        ("api_key = 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'", "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"),
        ("SECRET_KEY_BASE=0123456789abcdef0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"),
        ("token: abc123def456ghi", "abc123def456ghi"),
        ("https://x-access-token:ghs_Abc123Def456Ghi789Jkl012Mno345Pqr678@github.com/acme/app.git", "ghs_Abc123"),
        ("Résumé sent with token=Zx9Qw8Er7Ty6Ui5Op4As", "Zx9Qw8Er7Ty6Ui5Op4As"),
        ("{\"private_key\": \"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\"}", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw"),
    ]

    /// What isn't secret stays as written: hashes, ids, paths, names, counts.
    static let plain = [
        "Committed 3f2a9c1b7e4d6a8f0b2c4e6a8d0f1b3c5e7a9d2f on main",
        "GIT_COMMIT=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "Session 6f1c2e3a-4b5d-4c7e-8f90-a1b2c3d4e5f6 finished",
        "Tests in src/components/UserProfileSettingsPanel.test.tsx passed",
        "Opened /var/folders/vg/ymy_cd692kq_cbj2j1d_44n40000gn/T/build-output.log",
        "Set max_tokens=4096 and retried",
        "sort --key 2,3 data.csv",
        "Pushed feature/add-password-reset-flow-for-enterprise-users",
        "pulled ghcr.io/acme/web:4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        "Set npm_config_registry_mirror to the internal one",
        "Renamed AKIAComponentRenderer to KeyRenderer",
        "\"cacheKey\": \"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b\"",
        "publicKey=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "The web3Provider and parseHTML5Document helpers moved",
        "Ran 1730000000123 tests in 12.5s",
        "Fixed it.",
        "",
    ]

    /// Every case, as the vectors have it: the text, what's shown of it, and whether that's all.
    static var cases: [(text: String, masked: String, showsAll: Bool)] {
        let dashes = String(repeating: "-", count: 4000)
        let long = [
            dashes + " --token abc123def456",
            String(repeating: "word ", count: 795) + "OPENAI_API_KEY=sk-proj-4fJk29dLqZx81mNbVc7TyQ and more after",
            dashes + dashes,
        ]
        return (secrets.map(\.0) + plain + long).map { ($0, SecretMask.masked($0), SecretMask.showsAll($0)) }
    }

    @Test(arguments: secrets)
    func hidesSecrets(text: String, secret: String) {
        let shown = SecretMask.masked(text)
        #expect(!shown.contains(secret), "showed a secret: \(shown)")
        #expect(shown.contains("•••"))
        #expect(!SecretMask.showsAll(text))
    }

    @Test(arguments: plain)
    func showsWhatIsntSecret(text: String) {
        #expect(SecretMask.masked(text) == text)
        #expect(SecretMask.showsAll(text))
    }

    /// A long reply is cut to what a notification shows, and stays quick to mask whatever it
    /// holds: a run of dashes once took half a minute.
    @Test func longTextIsCutAndQuick() {
        let dashes = String(repeating: "-", count: 4000)
        let started = ContinuousClock.now
        let shown = SecretMask.masked(dashes + " --token abc123def456")
        #expect(ContinuousClock.now - started < .seconds(1))
        #expect(shown.count <= 4001)
        #expect(!SecretMask.showsAll(dashes + dashes))
    }

    /// A secret right where a long reply is cut isn't left half shown.
    @Test func cutDoesntSplitASecret() {
        let filler = String(repeating: "word ", count: 795)
        let text = filler + "OPENAI_API_KEY=sk-proj-4fJk29dLqZx81mNbVc7TyQ and more after"
        #expect(!SecretMask.masked(text).contains("4fJk29dLqZx81"))
    }

    /// The bridge's rules are these: what the vectors say is what these rules make of each.
    @Test func vectorsAreTheseRules() throws {
        let made = Self.cases.map { ["text": $0.text, "masked": $0.masked, "showsAll": $0.showsAll] as [String: Any] }
        if ProcessInfo.processInfo.environment["KUVO_WRITE_VECTORS"] == "1" {
            let data = try JSONSerialization.data(withJSONObject: ["cases": made], options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            try (data + Data("\n".utf8)).write(to: Self.vectors)
        }
        let kept = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: Self.vectors)) as? [String: Any])
        let cases = try #require(kept["cases"] as? [[String: Any]])
        #expect(cases.count == made.count, "run KUVO_WRITE_VECTORS=1 swift test --filter SecretMaskTests")
        for (kept, made) in zip(cases, Self.cases) {
            #expect(kept["text"] as? String == made.text)
            #expect(kept["masked"] as? String == made.masked, "\(made.text.prefix(80))")
            #expect(kept["showsAll"] as? Bool == made.showsAll, "\(made.text.prefix(80))")
        }
    }
}
