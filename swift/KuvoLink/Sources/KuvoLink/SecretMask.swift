import Foundation

/// What a notification shows of an agent's words: what looks like a secret (a key, a token, a
/// password) as dots, everything else as written, so a notification on a lock screen or a phone
/// never shows one and still says what happened. A box's notices for your phones (`kuvo-link.js`,
/// `masked`) mask by the same rules, held to `protocol/vectors/masking.json`.
public enum SecretMask {
    /// `text` with what looks like a secret's value as dots: after a name like token, key, secret,
    /// password or Authorization (Bearer), and long runs of letters and digits like a key's.
    public static func masked(_ text: String) -> String {
        // No more than a notification shows (and the patterns stay quick on a long reply).
        let text = maskedNamed(text.count > shownLength ? Self.cut(text) : text)
        // A long run of letters and digits, as a key is: 24 or more with both, or a key's own
        // start (sk-, ghp_, xoxb-, AKIA…). Not a commit's hash or a UUID, nor a path or a name
        // made of words (a branch, a package, a test), which aren't secret. An AWS access key's
        // ID is shorter, 20: that one by its shape.
        guard let long = try? NSRegularExpression(pattern: #"[A-Za-z0-9_\-+/=]{20,}"#) else { return text }
        let source = text as NSString
        var result = ""
        var at = 0
        for match in long.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            let run = source.substring(with: match.range)
            if run.count < 24 {
                guard run.range(of: #"^(AKIA|ASIA)[0-9A-Z]{16}$"#, options: .regularExpression) != nil else { continue }
                result += source.substring(with: NSRange(location: at, length: match.range.location - at)) + "•••"
                at = match.range.location + match.range.length
                continue
            }
            // A key's own start, also as a part of a path (…/keys/sk-…).
            let prefixed = run.split(separator: "/").contains { part in
                part.range(of: #"^(sk-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|ghp_|gho_|ghs_|github_pat_|xox[abpe]-|AKIA|AIza|glpat-|dop_v1_|sbp_|pul-|npm_|hf_|gsk_|xai-|pplx-|r8_|lin_api_|ntn_|shp(at|ss|ca)_)"#, options: .regularExpression) != nil
            }
            let isHash = run.range(of: #"^([0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$"#, options: .regularExpression) != nil
            // A path or a name made of words (a branch, a package, a test, web3Provider,
            // parseHTML5Document): each long part reads as words and numbers, a few letters
            // each on average, where a key's change case or turn to digits every letter or two.
            // UUIDs, a hash (see markingHashes), macOS's temporary
            // folders and short hex names (a crate's registry, a container) are names too; a
            // longer run of hex digits with letters in it is a key's. A number (a timestamp) is a
            // word.
            let before = source.substring(with: NSRange(location: max(0, match.range.location - 32), length: min(32, match.range.location)))
            let plain = Self.markingHashes(in: run, after: before)
                .replacingOccurrences(of: #"(?<![0-9A-Fa-f])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Fa-f])"#, with: "u", options: .regularExpression)
                .replacingOccurrences(of: #"/var/folders/[^/]+/[^/]+"#, with: "/var/folders/t/t", options: .regularExpression)
            let wordy = plain.split(whereSeparator: { "/-_.".contains($0) }).allSatisfy { part in
                if part.count < 12 { return true }
                if part.range(of: #"^[0-9]*[a-fA-F][0-9a-fA-F]*$"#, options: .regularExpression) != nil { return part.count < 20 }
                return Double(part.count) / Double(max(1, Self.words.numberOfMatches(in: String(part), range: NSRange(location: 0, length: (part as Substring).utf16.count)))) >= 3.5
            }
            let mixed = run.range(of: #"[A-Za-z]"#, options: .regularExpression) != nil && run.range(of: #"\d"#, options: .regularExpression) != nil
            // A key's start with letters and digits after it: a name that starts alike, all words
            // (npm_config_registry), isn't one.
            guard (prefixed && mixed) || (mixed && !isHash && !wordy) else { continue }
            result += source.substring(with: NSRange(location: at, length: match.range.location - at)) + "•••"
            at = match.range.location + match.range.length
        }
        return result + source.substring(from: at)
    }

    /// Names that say the hex after them is a hash, not a key: a commit's, an object's, a
    /// checksum, a cache key, a public key (GIT_COMMIT=…, --sha256=…, "cacheKey": …, md5: …).
    static let hashNames = #"commit|sha|sha1|sha256|sha512|md5|rev|revision|hash|ref|head|onto|checksum|digest|etag|integrity|fingerprint|cache[ _.-]?key|public[ _.-]?key|object|oid|tree|parent|blob|base|id|uuid|tag|build|version|release"#

    /// The name just before a value (in `prefix`, the text up to it), without what's between
    /// them: `"encryptionKey` of `"encryptionKey": "`.
    static func trimmedName(_ prefix: String) -> String {
        prefix.replacingOccurrences(of: #"[\s:=>"'\]\\_-]+$"#, with: "", options: .regularExpression)
    }

    /// Whether the name ending `prefix` is a secret's: one with secret, private, pass or token in
    /// it (SECRET_KEY_BASE), or a key's (not a cache key's or a public key's).
    public static func isSecretName(_ prefix: String) -> Bool {
        let name = trimmedName(prefix)
        let word = name.split(whereSeparator: { $0.isWhitespace || "([{,;\"'=/".contains($0) }).last.map(String.init) ?? ""
        if word.range(of: #"(?i)secret|private|pass|pwd|token|credential"#, options: .regularExpression) != nil { return true }
        return name.range(of: #"(?i)key$"#, options: .regularExpression) != nil
            && name.range(of: #"(?i)(cache|public)[ _.-]?key$"#, options: .regularExpression) == nil
    }

    /// Whether `prefix`, the text just before a hex value, says it's a hash: a hash's name ends it
    /// and no secret's word is in that name, or it's an image's tag (ghcr.io/acme/web:…).
    public static func namesHash(_ prefix: String) -> Bool {
        if prefix.hasSuffix(":"), let token = prefix.dropLast().split(whereSeparator: \.isWhitespace).last,
           token.contains(where: { "/.".contains($0) }), prefix.dropLast().last.map({ !$0.isWhitespace }) == true {
            return true
        }
        return !isSecretName(prefix) && trimmedName(prefix).range(of: "(?i)(?:" + hashNames + ")s?$", options: .regularExpression) != nil
    }

    /// A run of hex digits after a name, a separator and maybe quotes (=, :, :=, =>,
    /// ENV['…'] =, an escaped JSON quote), on one line: a key's value, as it's written.
    static let hexAfterName = try! NSRegularExpression(pattern: #"(?<=[A-Za-z0-9_])(?:\\?["'])?\]?[ \t]*(?::=|=>|[:=])[ \t]*(?:\\?["'])?([0-9a-fA-F]{32,})(?![0-9A-Za-z])"#)

    /// `text` with each run of hex digits after a name as dots, unless the name says it's a hash:
    /// ENCRYPTION_KEY="…", "AESKey": …, SIGNATURE=… hidden; GIT_COMMIT=…, sha256: … shown.
    public static func maskedHexValues(_ text: String) -> String {
        let source = text as NSString
        var result = text
        for match in hexAfterName.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
            let value = match.range(at: 1)
            let start = max(0, value.location - 32)
            let prefix = source.substring(with: NSRange(location: start, length: value.location - start))
            guard !namesHash(prefix), let range = Range(value, in: result) else { continue }
            result.replaceSubrange(range, with: "•••")
        }
        return result
    }

    static let hexPart = try! NSRegularExpression(pattern: #"(?<![0-9A-Za-z])[0-9a-f]{32,}(?![0-9A-Za-z])"#)

    /// `run` (after `before`, the text ahead of it) with each hash in it as "h", to be read as a
    /// name: a commit's (40 or 64 digits) on its own, in a path or after + or - (not a key's, as
    /// api-key-…), or any run of hex digits a hash's name comes before (md5: …, GIT_COMMIT=…).
    public static func markingHashes(in run: String, after before: String) -> String {
        let source = run as NSString
        var result = run
        for hit in hexPart.matches(in: run, range: NSRange(location: 0, length: source.length)).reversed() {
            let prefix = String((before + source.substring(to: hit.range.location)).suffix(32))
            let isCommit = hit.range.length == 40 || hit.range.length == 64
            let isHash: Bool
            if isCommit, prefix.last.map({ $0.isWhitespace || "/+\"'([".contains($0) }) ?? true {
                isHash = true
            } else if isCommit, prefix.hasSuffix("-") {
                isHash = !isSecretName(prefix)
            } else {
                isHash = namesHash(prefix)
            }
            if isHash, let range = Range(hit.range, in: result) { result.replaceSubrange(range, with: "h") }
        }
        return result
    }

    /// The words of a name: "parse", "HTML", "5", "Document".
    static let words = try! NSRegularExpression(pattern: #"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+"#)

    /// Whether a notification shows all of `text`: one that hides some of it doesn't answer from
    /// its buttons, as you'd answer what you can't see.
    public static func showsAll(_ text: String) -> Bool { text.count <= shownLength && masked(text) == text }

    static let shownLength = 4000

    /// `text` cut to what a notification shows, between words (a space, a quote, a comma), so a
    /// key isn't cut short of looking like one.
    static func cut(_ text: String) -> String {
        let start = text.prefix(shownLength)
        let end = start.suffix(100).lastIndex { !($0.isLetter || $0.isNumber || "_-+/=".contains($0)) } ?? start.endIndex
        return String(start[..<end]) + "…"
    }

    /// `text` with the secrets it names as dots: after a name that says it's one (token=…,
    /// "password": …, Authorization: Bearer …, --token …, aws_secret_access_key …; after a token's
    /// name, not a number, as in max_tokens=4096), in an address (https://user:pass@host, https://TOKEN@host, a Slack
    /// webhook's), curl -u user:pass and mysql -pPASS.
    public static func maskedNamed(_ text: String) -> String {
        var text = text
        let named = #"(?i)((?:api[_-]?key|secret(?:[_-]?access[_-]?key)?|password|passwd|authorization)["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+|token\s+(?:token=)?["']?)?+|bearer\s+|(?<![\w-])--(?=\w)[\w-]{0,60}?(?:password|passwd|secret)[=\s]+(?!-))[^\s"'&;]{3,}"#
        text = text.replacingOccurrences(of: named, with: "$1•••", options: .regularExpression)
        // --key, --private-key, --access-token…: the short ones take other things too, a field
        // (sort --key 2,3), a count.
        let flag = #"(?i)((?<![\w-])--(?=\w)[\w-]{0,60}?(?<!(?:sort|foreign|partition|group|cache|order|index|range|lookup|hash)[-_])(?<!hot|turn|mon)(?:token|key)[=\s]+(?!-))(?![0-9][^\s"'&;]{0,7}(?:[\s"'&;]|$))[^\s"'&;]{3,}"#
        text = text.replacingOccurrences(of: flag, with: "$1•••", options: .regularExpression)
        // A run of hex digits after a name: a secret's, as a commit's hash would look, unless the
        // name says it's a hash.
        text = maskedHexValues(text)
        // After a token's name, a number is a count (max_tokens=4096), not one.
        let token = #"(?i)(token["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+)?+)(?![0-9]+(?:[\s"'&;,}]|$))[^\s"'&;]{3,}"#
        text = text.replacingOccurrences(of: token, with: "$1•••", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(://[^\s/:@]+:)[^\s/@]+@"#, with: "$1•••@", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(://)[^\s/:@]{20,}@"#, with: "$1•••@", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(\bcurl\b[^\n]*?\s(?:-u|--user)\s+[^\s:]+:)\S+"#, with: "$1•••", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?i)(secret[_-]?access[_-]?key\s+)\S+"#, with: "$1•••", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(hooks\.slack\.com/services/)[^\s"'<>]+"#, with: "$1•••", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(\b(?i:mysql|mariadb|mysqldump|mysqladmin)\b[^\n]*?\s-p)\S+"#, with: "$1•••", options: .regularExpression)
        return text
    }
}
