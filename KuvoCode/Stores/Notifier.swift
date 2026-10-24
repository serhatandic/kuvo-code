import AppKit
import KuvoLink
import UserNotifications

/// Tells you when a session finishes or needs your answer while you're in another app, and
/// counts the sessions waiting for you on the Dock icon. Clicking a notification opens the
/// session; a permission request's buttons answer it, a question's its choices, and a finished
/// one's Reply writes back, without opening the app. macOS asks for permission the first time there's something to tell.
/// What's about a session or a chat goes to your paired phones too (see PhoneLink).
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    /// Settings › Notifications: notifications, their sound and the Dock badge, each on unless
    /// turned off.
    static let enabledKey = "notifications.enabled"
    static let soundKey = "notifications.sound"
    static let badgeKey = "notifications.badge"

    static var isEnabled: Bool {
        UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true
    }

    static var playsSound: Bool {
        UserDefaults.standard.object(forKey: soundKey) as? Bool ?? true
    }

    static var showsBadge: Bool {
        UserDefaults.standard.object(forKey: badgeKey) as? Bool ?? true
    }

    /// Shows a session in the window, for a clicked notification.
    var open: ((String) -> Void)?
    /// Answers a permission request from its notification: the request's session, the request,
    /// and the decision.
    var answer: ((String, String, PermissionAnswer) -> Void)?
    /// Sends what you wrote in a notification's Reply to its session.
    var reply: ((String, String) -> Void)?
    /// Answers a question from its notification: the question's session, the question, its field
    /// and the answer.
    var answerQuestion: ((String, String, String, String) -> Void)?
    /// Sends a notification to your paired phones (set by AppModel).
    var toPhones: ((Notice) -> Void)?
    /// A request, a question or an ask answered (or gone), whose notice for your phones, if it's
    /// still waiting, never goes (set with `toPhones`, by `PhoneLink.listen`).
    var answeredForPhones: ((String) -> Void)?
    /// A notification this Mac showed of news that goes to phones (its own, or a machine's): its
    /// conversation and kind, for the boxes to count as seen while you're here (set by the app,
    /// `Attention`).
    var shownHere: ((NoticeHold.Shown) -> Void)?

    /// What goes to your phones too, as their notification (KuvoLink's PROTOCOL.md,
    /// "Notifications"): nil for what's only about this Mac.
    struct Push {
        var category: Notice.Category
        /// A group chat's: its id, for the session's place.
        var group: String?
        /// The permission or form it asks you to answer, and the session asking (a subagent's,
        /// maybe).
        var request: (session: String, id: String)?
        /// The browser ask.
        var ask: String?
        /// The machine it happened on (its engine, its browser, a group chat that lives there): the
        /// machine tells your phones itself, Mac connected or not, so this Mac doesn't.
        var machine: String?

        /// Whether its notification's buttons may answer it (see `Workspace.showsAll`).
        var answerable = true

        init(_ category: Notice.Category, group: String? = nil, request: (session: String, id: String)? = nil, ask: String? = nil, machine: String? = nil, answerable: Bool = true) {
            self.answerable = answerable
            self.category = category
            self.group = group
            self.request = request
            self.ask = ask
            self.machine = machine
        }
    }

    /// A question asked with one field: its choices become the notification's buttons, and one
    /// you can answer in words gets a field for that.
    struct Question {
        let session: String
        let form: String
        let key: String
        let text: String
        let choices: [(value: String, label: String)]
        let allowsText: Bool
    }

    enum PermissionAnswer: String, CaseIterable {
        case once, always, reject

        var title: String {
            switch self {
            case .once: "Allow"
            case .always: "Always Allow"
            case .reject: "Deny"
            }
        }
    }

    private static let permissionCategory = "permission"
    private static let replyCategory = "reply"
    nonisolated static let replyAction = "reply"
    nonisolated static let answerAction = "answer"
    nonisolated static let choicePrefix = "choice."
    /// The categories every notification can have, and each waiting question's own.
    private var categories: [UNNotificationCategory] = []
    private var questionCategories: [String: UNNotificationCategory] = [:]
    private var isAuthorized: Bool?

    /// `text` with what looks like a secret's value as dots: after a name like token, key, secret,
    /// password or Authorization (Bearer), and long runs of letters and digits like a key's.
    nonisolated static func masked(_ text: String) -> String {
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
    private nonisolated static let hashNames = #"commit|sha|sha1|sha256|sha512|md5|rev|revision|hash|ref|head|onto|checksum|digest|etag|integrity|fingerprint|cache[ _.-]?key|public[ _.-]?key|object|oid|tree|parent|blob|base|id|uuid|tag|build|version|release"#

    /// The name just before a value (in `prefix`, the text up to it), without what's between
    /// them: `"encryptionKey` of `"encryptionKey": "`.
    private nonisolated static func trimmedName(_ prefix: String) -> String {
        prefix.replacingOccurrences(of: #"[\s:=>"'\]\\_-]+$"#, with: "", options: .regularExpression)
    }

    /// Whether the name ending `prefix` is a secret's: one with secret, private, pass or token in
    /// it (SECRET_KEY_BASE), or a key's (not a cache key's or a public key's).
    nonisolated static func isSecretName(_ prefix: String) -> Bool {
        let name = trimmedName(prefix)
        let word = name.split(whereSeparator: { $0.isWhitespace || "([{,;\"'=/".contains($0) }).last.map(String.init) ?? ""
        if word.range(of: #"(?i)secret|private|pass|pwd|token|credential"#, options: .regularExpression) != nil { return true }
        return name.range(of: #"(?i)key$"#, options: .regularExpression) != nil
            && name.range(of: #"(?i)(cache|public)[ _.-]?key$"#, options: .regularExpression) == nil
    }

    /// Whether `prefix`, the text just before a hex value, says it's a hash: a hash's name ends it
    /// and no secret's word is in that name, or it's an image's tag (ghcr.io/acme/web:…).
    nonisolated static func namesHash(_ prefix: String) -> Bool {
        if prefix.hasSuffix(":"), let token = prefix.dropLast().split(whereSeparator: \.isWhitespace).last,
           token.contains(where: { "/.".contains($0) }), prefix.dropLast().last.map({ !$0.isWhitespace }) == true {
            return true
        }
        return !isSecretName(prefix) && trimmedName(prefix).range(of: "(?i)(?:" + hashNames + ")s?$", options: .regularExpression) != nil
    }

    /// A run of hex digits after a name, a separator and maybe quotes (=, :, :=, =>,
    /// ENV['…'] =, an escaped JSON quote), on one line: a key's value, as it's written.
    private nonisolated static let hexAfterName = try! NSRegularExpression(pattern: #"(?<=[A-Za-z0-9_])(?:\\?["'])?\]?[ \t]*(?::=|=>|[:=])[ \t]*(?:\\?["'])?([0-9a-fA-F]{32,})(?![0-9A-Za-z])"#)

    /// `text` with each run of hex digits after a name as dots, unless the name says it's a hash:
    /// ENCRYPTION_KEY="…", "AESKey": …, SIGNATURE=… hidden; GIT_COMMIT=…, sha256: … shown.
    nonisolated static func maskedHexValues(_ text: String) -> String {
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

    private nonisolated static let hexPart = try! NSRegularExpression(pattern: #"(?<![0-9A-Za-z])[0-9a-f]{32,}(?![0-9A-Za-z])"#)

    /// `run` (after `before`, the text ahead of it) with each hash in it as "h", to be read as a
    /// name: a commit's (40 or 64 digits) on its own, in a path or after + or - (not a key's, as
    /// api-key-…), or any run of hex digits a hash's name comes before (md5: …, GIT_COMMIT=…).
    nonisolated static func markingHashes(in run: String, after before: String) -> String {
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
    private nonisolated static let words = try! NSRegularExpression(pattern: #"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+"#)

    /// Whether a notification shows all of `text`: one that hides some of it doesn't answer from
    /// its buttons, as you'd answer what you can't see.
    nonisolated static func showsAll(_ text: String) -> Bool { text.count <= shownLength && masked(text) == text }

    private nonisolated static let shownLength = 4000

    /// `text` cut to what a notification shows, between words (a space, a quote, a comma), so a
    /// key isn't cut short of looking like one.
    private nonisolated static func cut(_ text: String) -> String {
        let start = text.prefix(shownLength)
        let end = start.suffix(100).lastIndex { !($0.isLetter || $0.isNumber || "_-+/=".contains($0)) } ?? start.endIndex
        return String(start[..<end]) + "…"
    }

    /// `text` with the secrets it names as dots: after a name that says it's one (token=…,
    /// "password": …, Authorization: Bearer …, --token …, aws_secret_access_key …; after a token's
    /// name, not a number, as in max_tokens=4096), in an address (https://user:pass@host, https://TOKEN@host, a Slack
    /// webhook's), curl -u user:pass and mysql -pPASS.
    nonisolated static func maskedNamed(_ text: String) -> String {
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

    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        categories = [
            // Allowing needs the Mac unlocked: from the lock screen it asks for your password first.
            UNNotificationCategory(identifier: Self.permissionCategory, actions: PermissionAnswer.allCases.map { answer in
                UNNotificationAction(identifier: answer.rawValue, title: answer.title, options: answer == .reject ? [.destructive] : [.authenticationRequired])
            }, intentIdentifiers: []),
            UNNotificationCategory(identifier: Self.replyCategory, actions: [
                // Replying gives the agent work: it needs the Mac unlocked too.
                UNTextInputNotificationAction(identifier: Self.replyAction, title: "Reply", options: [.authenticationRequired], textInputButtonTitle: "Send", textInputPlaceholder: "Message"),
            ], intentIdentifiers: []),
        ]
        center.setNotificationCategories(Set(categories))
    }

    /// A question's own category: its choices, and a field to answer in words if it takes one.
    private func category(for question: Question) -> String {
        let identifier = "question.\(question.form)"
        var actions: [UNNotificationAction] = question.choices.prefix(4).enumerated().map { index, choice in
            UNNotificationAction(identifier: Self.choicePrefix + "\(index)", title: Self.masked(choice.label), options: [.authenticationRequired])
        }
        if question.allowsText {
            actions.append(UNTextInputNotificationAction(identifier: Self.answerAction, title: question.choices.isEmpty ? "Answer" : "Other…", options: [.authenticationRequired],
                                                         textInputButtonTitle: "Send", textInputPlaceholder: "Your answer"))
        }
        questionCategories[question.form] = UNNotificationCategory(identifier: identifier, actions: actions, intentIdentifiers: [])
        UNUserNotificationCenter.current().setNotificationCategories(Set(categories + questionCategories.values))
        return identifier
    }

    /// Posts a notification about `session`, unless you're in the app (its sidebar and tabs
    /// already show it) or notifications are off.
    /// A `permission` (its session, and the request) gets the buttons that answer it; one that
    /// `replies` gets Reply, to write back to the session from the notification; a `question`, its
    /// choices. With `push`, it goes to your phones too, whether the Mac shows it or not.
    func notify(session: String, title: String, subtitle: String? = nil, body: String, permission: (session: String, request: String)? = nil,
                question: Question? = nil, replies: Bool = false, push: Push? = nil) {
        // What looks like a secret in a command or reply (a token, a key) isn't shown: these stay
        // in Notification Center, and a phone's lock screen.
        let body = Self.masked(body)
        if let push { send(push, session: session, title: Self.masked(title), subtitle: subtitle.map(Self.masked), body: body) }
        guard Self.isEnabled else { return }
        // In the app, its sidebar and tabs show it: shown here as much as a notification would be.
        guard !NSApp.isActive else {
            if let push { shownHere?(Self.shown(push, session: session)) }
            return
        }
        Task {
            guard await authorize() else { return }
            let content = UNMutableNotificationContent()
            content.title = Self.masked(title)
            if let subtitle { content.subtitle = Self.masked(subtitle) }
            content.body = body
            if Self.playsSound { content.sound = .default }
            content.threadIdentifier = session
            content.userInfo = Self.info(session: session, permission: permission, question: question)
            // A browser's ask: cleared as it's answered, or goes unanswered.
            if let ask = push?.ask { content.userInfo["ask"] = ask }
            if permission != nil {
                content.categoryIdentifier = Self.permissionCategory
            } else if let question {
                content.categoryIdentifier = category(for: question)
            } else if replies, !session.isEmpty {
                content.categoryIdentifier = Self.replyCategory
            }
            // One with no buttons still goes once it's answered elsewhere.
            if content.userInfo["request"] == nil, let request = push?.request { content.userInfo["request"] = request.id }
            let center = UNUserNotificationCenter.current()
            guard (try? await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))) != nil else { return }
            // Shown here (unless its style in System Settings is None): while you're at this Mac,
            // your phones needn't tell you again. (A Focus that silences it can't be told.)
            if let push, await center.notificationSettings().alertStyle != .none { shownHere?(Self.shown(push, session: session)) }
        }
    }

    private func send(_ push: Push, session: String, title: String, subtitle: String?, body: String) {
        guard let toPhones, push.machine == nil else { return }
        var data = push.group.map { ["group": $0] } ?? (session.isEmpty ? [:] : ["session": session])
        if let request = push.request {
            data["request"] = request.id
            if request.session != session { data["requestSession"] = request.session }
            if !push.answerable { data["answerable"] = "0" }
        }
        if let ask = push.ask { data["ask"] = ask }
        toPhones(Notice(title: title, subtitle: subtitle, body: body, category: push.category, thread: Self.thread(push, session: session), data: data))
    }

    /// What a notice for phones is grouped under: the group chat, the session, or the browser ask.
    private static func thread(_ push: Push, session: String) -> String {
        push.group ?? (session.isEmpty ? push.ask ?? "" : session)
    }

    /// A notification shown here, as the boxes match it with their notices for phones (this Mac's,
    /// or a machine's of the same news).
    static func shown(_ push: Push, session: String) -> NoticeHold.Shown {
        NoticeHold.Shown(session: thread(push, session: session), ask: NoticeHold.isAsked(push.category), request: push.request?.id ?? push.ask, machine: push.machine)
    }

    /// Takes a session's notifications away once you've looked at it.
    func clear(session: String) {
        Task {
            let center = UNUserNotificationCenter.current()
            let delivered = await center.deliveredNotifications()
            let ids = delivered.filter { $0.request.content.threadIdentifier == session }.map(\.request.identifier)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    /// Takes a request's or a question's notification away once it's answered (in the app, say).
    func clear(request: String) {
        answeredForPhones?(request)
        if questionCategories.removeValue(forKey: request) != nil {
            UNUserNotificationCenter.current().setNotificationCategories(Set(categories + questionCategories.values))
        }
        Task {
            let center = UNUserNotificationCenter.current()
            let delivered = await center.deliveredNotifications()
            let ids = delivered.filter { notification in
                let info = notification.request.content.userInfo
                return info["request"] as? String == request || info["form"] as? String == request || info["ask"] as? String == request
            }
            .map(\.request.identifier)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    /// The number on the Dock icon: sessions that finished while you were elsewhere, or
    /// wait for your answer.
    func setBadge(_ count: Int) {
        NSApp.dockTile.badgeLabel = Self.showsBadge && count > 0 ? "\(count)" : nil
    }

    /// Whether notifications may show. A yes is kept; a no is asked again each time (macOS shows
    /// its prompt once, and answers at once after), so turning them on in System Settings works
    /// without starting Kuvo Code again.
    private func authorize() async -> Bool {
        if isAuthorized == true { return true }
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
        isAuthorized = granted
        return granted
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let done = Self.response(to: response.actionIdentifier, info: response.notification.request.content.userInfo,
                                 text: (response as? UNTextInputNotificationResponse)?.userText)
        await MainActor.run {
            switch done {
            case .permission(let session, let request, let answer): Notifier.shared.answer?(session, request, answer)
            case .question(let session, let form, let key, let answer): Notifier.shared.answerQuestion?(session, form, key, answer)
            case .reply(let session, let text): Notifier.shared.reply?(session, text)
            case .open(let session):
                NSApp.activate()
                if !session.isEmpty { Notifier.shared.open?(session) }
            case nil: break
            }
        }
    }

    /// What a notification about `session` carries for its buttons: the permission or question
    /// they answer, and its choices.
    static func info(session: String, permission: (session: String, request: String)?, question: Question?) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = ["session": session]
        if let permission {
            info["requestSession"] = permission.session
            info["request"] = permission.request
        } else if let question {
            info["requestSession"] = question.session
            info["form"] = question.form
            info["key"] = question.key
            info["choices"] = question.choices.prefix(4).map(\.value)
        }
        return info
    }

    /// What a notification's button or reply does.
    nonisolated enum Response: Equatable {
        case permission(session: String, request: String, PermissionAnswer)
        case question(session: String, form: String, key: String, String)
        case reply(session: String, String)
        /// Clicked: its conversation opens ("" for none, the app alone).
        case open(session: String)
    }

    /// What `action` on a notification with `info` (and the words typed in it) does.
    nonisolated static func response(to action: String, info: [AnyHashable: Any], text: String?) -> Response? {
        if let answer = PermissionAnswer(rawValue: action), let session = info["requestSession"] as? String, let request = info["request"] as? String {
            return .permission(session: session, request: request, answer)
        }
        if let form = info["form"] as? String, let session = info["requestSession"] as? String, let key = info["key"] as? String {
            if action.hasPrefix(choicePrefix), let index = Int(action.dropFirst(choicePrefix.count)), let values = info["choices"] as? [String], values.indices.contains(index) {
                return .question(session: session, form: form, key: key, values[index])
            }
            if action == answerAction, let text { return .question(session: session, form: form, key: key, text) }
        }
        guard let session = info["session"] as? String else { return nil }
        if action == replyAction, let text { return .reply(session: session, text) }
        return .open(session: session)
    }
}
