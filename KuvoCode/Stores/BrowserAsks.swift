import AppKit
import SwiftUI
import Foundation
import KuvoLink

/// What the agent asks you for while it browses: your sign-in for a site, a one-time code, or a
/// step only you can do (a CAPTCHA, approving the sign-in on your phone). You answer in a card in
/// the conversation that asked; a sign-in or a code goes straight into the page, in this Mac's
/// browser or a machine's, and never to the agent or the model. They're kept in memory a few
/// minutes, for a sign-in that asks for the username and the password on pages of their own, and
/// only kept after that if you save the password.
@Observable
final class BrowserAsks {
    enum Kind: Equatable {
        /// The fields the page has now.
        case signIn(username: Bool, password: Bool)
        case code(prompt: String)
        case action(instruction: String)
    }

    enum Answer {
        case signIn(username: String?, password: String?)
        case code(String)
        case done
        case declined
        case timedOut
    }

    struct Ask: Identifiable, Equatable {
        let id: String
        let kind: Kind
        /// The page's own site, whatever the agent says it is.
        let host: String
        /// The machine whose browser it is; nil for this Mac's.
        let machine: String?
        /// Who's asking, and their session, when the conversation says.
        var asker: String?
        var session: String?
        /// The page it's about, for Show Page: on a machine its target, on this Mac its tab.
        var page: String?
        /// The session whose agent asks, when it's a subagent of `session`'s: the run whose end
        /// takes the card away.
        var asking: String?
    }

    /// Waiting for you, the oldest first.
    private(set) var asks: [Ask] = []

    @ObservationIgnored private var responders: [String: (Answer) -> Void] = [:]
    /// Sign-ins you gave in the last few minutes, by machine and site, with the conversation they
    /// were for; each is forgotten once those minutes are up.
    @ObservationIgnored private var remembered: [String: (username: String?, password: String?, at: Date, session: String?)] = [:]
    private static let remembering: TimeInterval = 300

    /// Keeps a sign-in for the page after its username's, and drops it once that can't come.
    private func remember(_ key: String, username: String?, password: String?, session: String?) {
        let at = Date.now
        remembered[key] = (username, password, at, session)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.remembering))
            if self?.remembered[key]?.at == at { self?.remembered[key] = nil }
        }
    }
    /// Sessions whose agent started asking, by machine ("" for this Mac), oldest first: the asks
    /// that arrive go to them in that order.
    @ObservationIgnored private var askers: [String: [(name: String, session: String, at: Date)]] = [:]
    /// Told when the asks change, with the sessions waiting for you.
    @ObservationIgnored var onChange: (Set<String>) -> Void = { _ in }
    /// The name of who's asking from a session: a bot's, or the conversation's title.
    @ObservationIgnored var askerName: (String) -> String? = { _ in nil }
    /// The tab that shows an ask, for its notification: its conversation, or a bot's group chat.
    @ObservationIgnored var tab: (Ask) -> String? = { $0.session }
    /// The conversation a session's agent works for: a subagent's, its parent's.
    @ObservationIgnored var conversation: (String) -> String = { $0 }

    /// The asks of one conversation.
    func asks(for session: String) -> [Ask] {
        asks.filter { $0.session == session }
    }

    /// How long the agent waits for you.
    static let patience: Duration = .seconds(900)

    /// An agent in `session` (`name`) started asking for something in `machine`'s browser (nil for
    /// this Mac); its ask follows in a moment.
    func noteAsker(_ name: String, session: String, machine: String?) {
        // A session asks one thing at a time; an earlier start of its own that never asked (the
        // page wasn't ready) goes.
        askers[machine ?? "", default: []].removeAll { $0.session == session }
        askers[machine ?? "", default: []].append((name, session, .now))
    }

    /// Whose ask this is: the oldest asker on its machine from the last half minute.
    private func nextAsker(on machine: String?) -> (name: String, session: String)? {
        var waiting = askers[machine ?? ""] ?? []
        waiting.removeAll { Date.now.timeIntervalSince($0.at) > 30 }
        guard !waiting.isEmpty else {
            askers[machine ?? ""] = nil
            return nil
        }
        let first = waiting.removeFirst()
        askers[machine ?? ""] = waiting
        return (first.name, first.session)
    }

    /// For this Mac's browser: waits for your answer (or the agent's patience to run out). When
    /// the tool call that asks ends first (stopped, timed out), its card goes.
    func ask(_ kind: Kind, host: String, session: String? = nil, page: String? = nil) async -> Answer {
        let id = UUID().uuidString
        guard !Task.isCancelled else { return .declined }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                add(Ask(id: id, kind: kind, host: host, machine: nil, session: session, page: page)) { continuation.resume(returning: $0) }
                Task { [weak self] in
                    try? await Task.sleep(for: Self.patience)
                    self?.answer(id, .timedOut)
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.end(id) }
        }
    }

    /// A conversation's run ended (done, stopped or failed): nothing of its waits for an answer on
    /// this Mac any more, so its cards here go.
    func runEnded(_ session: String) {
        for ask in asks where (ask.asking ?? ask.session) == session && ask.machine == nil { end(ask.id) }
    }

    /// An ask on this Mac whose tool call has ended: its card goes, and the call hears no.
    private func end(_ id: String) {
        guard let respond = responders.removeValue(forKey: id) else { return }
        Notifier.shared.clear(request: id)
        withAnimation(.ui) { asks.removeAll { $0.id == id } }
        changed()
        respond(.declined)
    }

    /// An ask from a machine's browser; `respond` sends the answer back there.
    func add(_ ask: Ask, respond: @escaping (Answer) -> Void) {
        var ask = ask
        var noted: String?
        if let asking = ask.session {
            // The engine said whose it is: that session's start of asking is accounted for.
            askers[ask.machine ?? ""]?.removeAll { $0.session == asking }
            ask.asking = asking
        } else if let asker = nextAsker(on: ask.machine) {
            ask.asking = asker.session
            noted = asker.name
        }
        // A subagent's goes to the conversation it works for, which shows it and waits on you.
        ask.session = ask.asking.map(conversation)
        ask.asker = ask.session.flatMap(askerName) ?? noted
        // A site you let agents sign in to on their own: its saved password, without asking.
        if case .signIn = ask.kind, let login = Passwords.agentLogin(for: ask.host), let password = Passwords.password(for: login) {
            remember(key(ask), username: login.account.isEmpty ? nil : login.account, password: password, session: ask.session)
            respond(.signIn(username: login.account.isEmpty ? nil : login.account, password: password))
            Notifier.shared.notify(session: tab(ask) ?? "", title: "Signed in to \(ask.host)", subtitle: ask.asker, body: "With your saved password, as you allowed for this site.")
            return
        }
        // The rest of a sign-in you just gave the same conversation (its password, on the page
        // after the username's).
        if case .signIn(let needsUsername, let needsPassword) = ask.kind, let saved = remembered[key(ask)], saved.session == ask.session,
           Date.now.timeIntervalSince(saved.at) < Self.remembering, !needsUsername || saved.username != nil, !needsPassword || saved.password != nil {
            respond(.signIn(username: saved.username, password: saved.password))
            return
        }
        responders[ask.id] = respond
        withAnimation(.ui) { asks.append(ask) }
        changed()
        Notifier.shared.notify(session: tab(ask) ?? "", title: title(ask), subtitle: ask.asker, body: body(ask), push: .init(.ask, ask: ask.id, machine: ask.machine))
        #if DEBUG
        answerForDemo(ask)
        #endif
    }

    /// Your answer.
    func answer(_ id: String, _ answer: Answer) {
        guard let respond = responders.removeValue(forKey: id) else { return }
        Notifier.shared.clear(request: id)
        if case .signIn(let username, let password) = answer, let ask = asks.first(where: { $0.id == id }) {
            remember(key(ask), username: username, password: password, session: ask.session)
        }
        withAnimation(.ui) { asks.removeAll { $0.id == id } }
        changed()
        respond(answer)
    }

    /// An ask that ended elsewhere: the agent stopped waiting, or another Mac answered it.
    func closed(_ id: String) {
        responders[id] = nil
        Notifier.shared.clear(request: id)
        withAnimation(.ui) { asks.removeAll { $0.id == id } }
        changed()
    }

    private func changed() {
        onChange(Set(asks.compactMap(\.session)))
    }

    /// A machine's asks, when it's gone.
    func closeAll(on machine: String) {
        for ask in asks where ask.machine == machine { closed(ask.id) }
    }

    private func key(_ ask: Ask) -> String { (ask.machine ?? "") + "|" + ask.host }

    func title(_ ask: Ask) -> String {
        switch ask.kind {
        case .signIn: "Sign in to \(ask.host)"
        case .code: "Code for \(ask.host)"
        case .action: "Your turn on \(ask.host)"
        }
    }

    private func body(_ ask: Ask) -> String {
        switch ask.kind {
        case .signIn: "The agent needs your sign-in to go on."
        case .code(let prompt): prompt.isEmpty ? "The agent needs a code to go on." : prompt
        case .action(let instruction): instruction
        }
    }

    #if DEBUG
    /// KUVO_DEMO_ANSWER_ASKS=<username>|<password>|<code>[|<seconds>]: answers every ask after a
    /// moment (2 seconds unless given), as if typed in (a step to do is answered as done).
    private func answerForDemo(_ ask: Ask) {
        guard let values = ProcessInfo.processInfo.environment["KUVO_DEMO_ANSWER_ASKS"]?.split(separator: "|", omittingEmptySubsequences: false).map(String.init) else { return }
        Task {
            try? await Task.sleep(for: .seconds(values.count > 3 ? Double(values[3]) ?? 2 : 2))
            switch ask.kind {
            case .signIn: answer(ask.id, .signIn(username: values.first, password: values.count > 1 ? values[1] : nil))
            case .code: answer(ask.id, .code(values.count > 2 ? values[2] : ""))
            case .action: answer(ask.id, .done)
            }
        }
    }
    #endif
}
