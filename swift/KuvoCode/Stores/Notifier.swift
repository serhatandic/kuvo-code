import AppKit
import KuvoLink
import OpenCodeKit
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
    var openUsage: (() -> Void)?
    /// Answers a permission request from its notification: the request's session, the request,
    /// and the decision.
    var answer: ((String, String, PermissionAnswer) -> Void)?
    /// Sends what you wrote in a notification's Reply to its session.
    var reply: ((String, String) -> Void)?
    /// Answers a question from its notification: the question's session, the question, its field
    /// and the answer.
    var answerQuestion: ((String, String, String, String) -> Void)?
    /// Sends a notification to your paired phones, of what only the app knows (an ask from its
    /// panel's browser): this Mac's box makes the rest from its engine's news itself, as a
    /// machine's does (set by `PhoneLink.listen`).
    var toPhones: ((Notice) -> Void)?
    /// A request, a question or an ask answered (or gone), whose notice for your phones, if it's
    /// still waiting, never goes (set with `toPhones`, by `PhoneLink.listen`).
    var answeredForPhones: ((String) -> Void)?
    /// A notification this Mac showed of news that goes to phones (its own, or a machine's): its
    /// conversation and kind, for the boxes to count as seen while you're here (set by the app,
    /// `Attention`).
    var shownHere: ((Attention.Shown) -> Void)?

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

        /// The button's words; Always's names what it saves (`AlwaysWords`).
        func title(always: String) -> String {
            switch self {
            case .once: "Allow Once"
            case .always: always
            case .reject: "Don’t Allow"
            }
        }
    }

    /// A permission's buttons, with its Always naming what it saves: a category for each name.
    private static let permissionCategory = "permission.always."
    /// A permission with no Always.
    private static let permissionOnceCategory = "permission.once"
    private static let replyCategory = "reply"
    nonisolated static let replyAction = "reply"
    nonisolated static let answerAction = "answer"
    nonisolated static let choicePrefix = "choice."
    /// The categories every notification can have, and each waiting question's own.
    private var categories: [UNNotificationCategory] = []
    private var questionCategories: [String: UNNotificationCategory] = [:]
    private var alwaysCategories: [String: UNNotificationCategory] = [:]
    private var isAuthorized: Bool?

    /// `text` with what looks like a secret's value as dots (KuvoLink's `SecretMask`, which a box's
    /// notices for your phones mask by too).
    nonisolated static func masked(_ text: String) -> String { SecretMask.masked(text) }

    /// Whether a notification shows all of `text` (`SecretMask.showsAll`).
    nonisolated static func showsAll(_ text: String) -> Bool { SecretMask.showsAll(text) }

    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        categories = [
            // Allowing needs the Mac unlocked: from the lock screen it asks for your password first.
            Self.permissionCategory(Self.permissionOnceCategory, always: nil),
            // From a copy before Always said what it saves.
            Self.permissionCategory("permission", always: "Always Allow"),
            UNNotificationCategory(identifier: Self.replyCategory, actions: [
                // Replying gives the agent work: it needs the Mac unlocked too.
                UNTextInputNotificationAction(identifier: Self.replyAction, title: "Reply", options: [.authenticationRequired], textInputButtonTitle: "Send", textInputPlaceholder: "Message"),
            ], intentIdentifiers: []),
        ]
        // Always's words seen before, so notifications from an earlier run keep their buttons.
        for always in Self.commonAlways + (UserDefaults.standard.stringArray(forKey: Self.alwaysSeenKey) ?? []) {
            alwaysCategories[always] = Self.permissionCategory(Self.permissionCategory + always, always: always)
        }
        center.setNotificationCategories(Set(categories + alwaysCategories.values))
    }

    private static let commonAlways = ["Always Allow Edits", "Always Allow Commands", "Always Allow These Commands"]
    private static let alwaysSeenKey = "notifications.alwaysSeen"

    private static func permissionCategory(_ identifier: String, always: String?) -> UNNotificationCategory {
        UNNotificationCategory(identifier: identifier, actions: buttons(always: always).map { answer, title in
            UNNotificationAction(identifier: answer.rawValue, title: title, options: answer == .reject ? [.destructive] : [.authenticationRequired])
        }, intentIdentifiers: [])
    }

    /// A permission's buttons and their words: Always, named for what it saves, where it has one.
    static func buttons(always: String?) -> [(answer: PermissionAnswer, title: String)] {
        PermissionAnswer.allCases.compactMap { answer in
            guard answer != .always || always != nil else { return nil }
            return (answer, answer.title(always: always ?? ""))
        }
    }

    /// The category for a permission whose Always says `always`.
    private func category(always: String?) -> String {
        guard let always else { return Self.permissionOnceCategory }
        let identifier = Self.permissionCategory + always
        if alwaysCategories[always] == nil {
            alwaysCategories[always] = Self.permissionCategory(identifier, always: always)
            let seen = UserDefaults.standard.stringArray(forKey: Self.alwaysSeenKey) ?? []
            UserDefaults.standard.set(Array((seen.filter { $0 != always } + [always]).suffix(20)), forKey: Self.alwaysSeenKey)
            UNUserNotificationCenter.current().setNotificationCategories(Set(categories + questionCategories.values + alwaysCategories.values))
        }
        return identifier
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
        UNUserNotificationCenter.current().setNotificationCategories(Set(categories + questionCategories.values + alwaysCategories.values))
        return identifier
    }

    /// Posts a notification about `session`, unless you're in the app (its sidebar and tabs
    /// already show it) or notifications are off.
    /// A `permission` (its session, and the request) gets the buttons that answer it; one that
    /// `replies` gets Reply, to write back to the session from the notification; a `question`, its
    /// choices. With `push`, the news your phones get too (made by the box it happened on, or for an
    /// ask from the panel's browser, sent from here whether the Mac shows it or not): shown here,
    /// the boxes count it as seen while you're at this Mac. An `ask` the box tells your phones itself
    /// (a sandbox's): cleared here as it's answered anywhere.
    /// A `quiet` one shows in Notification Center without lighting the screen or a sound (a
    /// night's blockers and its morning report).
    func notify(session: String, title: String, subtitle: String? = nil, body: String, permission: (session: String, request: String)? = nil, always: String? = nil,
                question: Question? = nil, replies: Bool = false, quiet: Bool = false, push: Push? = nil, ask: String? = nil) {
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
            if quiet {
                content.interruptionLevel = .passive
            } else if Self.playsSound {
                content.sound = .default
            }
            content.threadIdentifier = session
            content.userInfo = Self.info(session: session, permission: permission, question: question, offersAlways: always != nil)
            // A browser's ask: cleared as it's answered, or goes unanswered.
            if let ask = push?.ask ?? ask { content.userInfo["ask"] = ask }
            if permission != nil {
                content.categoryIdentifier = category(always: always)
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

    func usageVisible() async -> Bool {
        await UNUserNotificationCenter.current().notificationSettings().alertStyle != .none
    }

    /// A box's usage verdict, with a stable OS identifier. It has no conversation or Reply action.
    @MainActor
    func usage(id: String, title: String, subtitle: String?, body: String) async -> Bool {
        guard NSClassFromString("XCTestCase") == nil, Self.isEnabled, await authorize() else { return false }
        let content = UNMutableNotificationContent()
        content.title = Self.masked(title)
        content.subtitle = subtitle.map(Self.masked) ?? ""
        content.body = Self.masked(body)
        content.threadIdentifier = "usage"
        content.userInfo = ["usage": true]
        if Self.playsSound { content.sound = .default }
        do {
            try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "usage-" + id, content: content, trigger: nil))
            return true
        } catch { return false }
    }

    private func send(_ push: Push, session: String, title: String, subtitle: String?, body: String) {
        guard let toPhones, push.ask != nil, push.machine == nil else { return }
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
    static func shown(_ push: Push, session: String) -> Attention.Shown {
        Attention.Shown(session: thread(push, session: session), ask: [.permission, .question, .ask].contains(push.category), request: push.request?.id ?? push.ask, machine: push.machine)
    }

    /// Takes a session's notifications away once you've looked at it.
    func clear(session: String) {
        Task {
            let ids = await delivered().filter { $0.thread == session }.map(\.id)
            if !ids.isEmpty { removeDelivered(ids) }
        }
    }

    /// A notification in Notification Center: its thread (a session's, a chat's), and the request,
    /// question or ask it answers, if it does.
    struct Delivered {
        var id: String
        var thread: String
        var answers: [String] = []
    }

    /// What Notification Center shows of this app, and taking some of it away: macOS's; a test
    /// gives its own.
    var delivered: () async -> [Delivered] = {
        await UNUserNotificationCenter.current().deliveredNotifications().map { notification in
            let info = notification.request.content.userInfo
            return Delivered(id: notification.request.identifier, thread: notification.request.content.threadIdentifier,
                             answers: ["request", "form", "ask"].compactMap { info[$0] as? String })
        }
    }
    var removeDelivered: ([String]) -> Void = { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: $0) }

    /// Takes a request's or a question's notification away once it's answered (in the app, say).
    func clear(request: String) {
        answeredForPhones?(request)
        if questionCategories.removeValue(forKey: request) != nil {
            UNUserNotificationCenter.current().setNotificationCategories(Set(categories + questionCategories.values + alwaysCategories.values))
        }
        Task {
            let ids = await delivered().filter { $0.answers.contains(request) }.map(\.id)
            if !ids.isEmpty { removeDelivered(ids) }
        }
    }

    /// The number on the Dock icon: sessions that finished while you were elsewhere, or
    /// wait for your answer.
    func setBadge(_ count: Int) {
        NSApp.dockTile.badgeLabel = Self.showsBadge && count > 0 ? "\(count)" : nil
    }

    /// What macOS was told about this copy's notifications, without asking: nil when it never was.
    nonisolated static func answered(_ status: UNAuthorizationStatus) -> Bool? {
        switch status {
        case .authorized, .provisional: true
        case .denied: false
        case .notDetermined: nil
        default: nil
        }
    }

    /// Whether notifications may show. A yes is kept; a no is asked again each time (macOS shows
    /// its prompt once, and answers at once after), so turning them on in System Settings works
    /// without starting Kuvo Code again.
    private func authorize() async -> Bool {
        if isAuthorized == true { return true }
        // The tests' copy never asks, nor posts: macOS would show its prompt for it, then the
        // tests' notifications.
        if AppInfo.isHostingTests { return false }
        // A demo copy that never prompts goes by what macOS was told for it before, and asks
        // only when it never was (the e2e copy, allowed once, keeps its banners).
        if AppInfo.neverPrompts {
            let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            if let answer = Self.answered(status) {
                if answer { isAuthorized = true }
                return answer
            }
            _ = AppInfo.mayPrompt("asking to show notifications")
            return false
        }
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
        isAuthorized = granted
        return granted
    }

    /// Quota alerts remain visible while the usage panel is open, as they were in UsageKit.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        notification.request.content.threadIdentifier == "usage" ? [.banner, .sound] : []
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let done = Self.response(to: response.actionIdentifier, info: response.notification.request.content.userInfo,
                                 text: (response as? UNTextInputNotificationResponse)?.userText)
        await MainActor.run { Notifier.shared.handle(done) }
    }

    /// Runs a decoded notification action; keeping routing here lets tests exercise taps safely.
    func handle(_ done: Response?) {
        switch done {
        case .permission(let session, let request, let decision): answer?(session, request, decision)
        case .question(let session, let form, let key, let value): answerQuestion?(session, form, key, value)
        case .reply(let session, let text): reply?(session, text)
        case .open(let session):
            NSApp.activate()
            if !session.isEmpty { open?(session) }
        case .usage: openUsage?()
        case nil: break
        }
    }

    /// What a notification about `session` carries for its buttons: the permission or question
    /// they answer, and its choices.
    static func info(session: String, permission: (session: String, request: String)?, question: Question?, offersAlways: Bool = true) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = ["session": session]
        if let permission {
            info["requestSession"] = permission.session
            info["request"] = permission.request
            if !offersAlways { info["always"] = false }
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
        case usage
    }

    /// What `action` on a notification with `info` (and the words typed in it) does.
    nonisolated static func response(to action: String, info: [AnyHashable: Any], text: String?) -> Response? {
        if action == UNNotificationDefaultActionIdentifier, info["usage"] as? Bool == true { return .usage }
        // (Always only from one that offered it: one that didn't opens the conversation.)
        if let answer = PermissionAnswer(rawValue: action), answer != .always || info["always"] as? Bool != false,
           let session = info["requestSession"] as? String, let request = info["request"] as? String {
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
