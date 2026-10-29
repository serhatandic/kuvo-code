import AppKit
import ClientDesign
import SwiftUI

/// Asks Kuvo Code can't show in a conversation: from a bot in a group chat, or from an agent it
/// couldn't tell. A card at the top of the window, over whatever is in view, for the oldest one.
/// The rest show in the conversation that asked, over its composer.
struct BrowserAskOverlay: View {
    @Environment(AppModel.self) private var app

    private var loose: [BrowserAsks.Ask] {
        app.browserAsks.asks.filter { ask in ask.session.map { app.workspace.seats.contains($0) } ?? true }
    }

    var body: some View {
        if let ask = loose.first {
            BrowserAskCard(ask: ask, inThread: false, waiting: loose.count - 1)
                .id(ask.id)
                .frame(width: 400)
                .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                .shadow(color: .black.opacity(0.18), radius: 18, y: 6)
                .padding(.top, 52)
                .frame(maxHeight: .infinity, alignment: .top)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}

/// The agent asks for your sign-in, a code, or a step only you can do. What you type goes into
/// the page, never to the agent: the card says so, and names the page's real site.
struct BrowserAskCard: View {
    let ask: BrowserAsks.Ask
    /// In the conversation that asked, rather than over the window.
    var inThread = true
    /// More asks after this one.
    var waiting = 0
    @Environment(AppModel.self) private var app
    @Environment(\.takesCardKeys) private var takesKeys
    @State private var username = ""
    @State private var password = ""
    @State private var code = ""
    @State private var saves = false
    /// Let agents sign in to this site with its saved password from now on, without asking.
    @State private var allowsAgents = false
    @FocusState private var focus: Field?

    /// A text field with something in it has the keyboard.
    private static var typingElsewhere: Bool {
        (NSApp.keyWindow?.firstResponder as? NSTextView).map { !$0.string.isEmpty } ?? false
    }

    private enum Field { case username, password, code }

    /// A site an ask names that's over https: a plain host, not "http://…" nor a file.
    private static func isSecure(_ host: String) -> Bool {
        !host.hasPrefix("http://") && !host.hasPrefix("a file")
    }

    /// The site's saved logins, read once from the keychain rather than on every redraw.
    @State private var saved: [Passwords.Login] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            switch ask.kind {
            case .signIn: signIn
            case .code(let prompt): codeField(prompt)
            case .action(let instruction):
                Text(instruction)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            footer
        }
        .padding(16)
        .onAppear {
            // Not while you're writing something else (a message, the other half's card): what you
            // type next would go into the field, and Return into the page.
            let mayFocus = takesKeys && !Self.typingElsewhere
            switch ask.kind {
            case .signIn:
                saved = Passwords.logins(for: ask.host)
                if let login = saved.first { use(login) }
                saves = Self.isSecure(ask.host) && saved.isEmpty && Passwords.offersToSave && !Passwords.neverSites.contains(ask.host)
                if mayFocus { focus = username.isEmpty ? .username : .password }
            case .code: if mayFocus { focus = .code }
            case .action: break
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(.tint)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(app.browserAsks.title(ask))
                    .font(.headline)
                Text(subtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if waiting > 0 {
                Text("+\(waiting)")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.primary.opacity(0.07), in: .capsule)
                    .help("\(waiting) more waiting")
            }
        }
    }

    private var symbol: String {
        switch ask.kind {
        case .signIn: "key.fill"
        case .code: "number"
        case .action: "hand.raised.fill"
        }
    }

    /// Where the browser runs, and who asks when it isn't the conversation's own agent.
    private var subtitle: String {
        let browser = ask.machine.map { "the browser on \($0)" } ?? "the browser"
        let who = inThread ? "" : "\(ask.asker ?? "The agent") asks, in \(browser). "
        switch ask.kind {
        case .signIn, .code:
            return inThread ? "It goes straight into the page in \(browser); the agent doesn’t see it." : who + "It goes straight into the page; the agent doesn’t see it."
        case .action:
            return inThread ? "In \(browser). The agent waits until you’re done." : "\(ask.asker ?? "The agent") needs you to do this in \(browser)."
        }
    }

    private var signIn: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Username or email", text: $username)
                .wellField()
                .focused($focus, equals: .username)
                .onSubmit { focus = .password }
            SecureField("Password", text: $password)
                .wellField()
                .focused($focus, equals: .password)
                .onSubmit(send)
            HStack(alignment: .top) {
                if !saved.isEmpty {
                    Menu {
                        ForEach(saved) { login in
                            Button(login.account.isEmpty ? "No username" : login.account) { use(login) }
                        }
                    } label: {
                        Label("Saved Passwords", systemImage: "key")
                    }
                    .menuStyle(.button)
                    .fixedSize()
                    .controlSize(.small)
                }
                Spacer()
                // Saved and filled over https only (a page over http, or a file, gets neither).
                if Self.isSecure(ask.host) {
                    VStack(alignment: .leading, spacing: 6) {
                        Toggle("Save in the Vault", isOn: $saves)
                            .disabled(!saved.isEmpty && saved.contains { $0.account == username })
                        if saves || saved.contains(where: { $0.account == username }) {
                            Toggle("Let agents sign in here on their own", isOn: $allowsAgents)
                                .help("Next time, with its saved password, without asking you; it still goes straight into the page. Settings › Vault shows who may use it.")
                        }
                    }
                    .toggleStyle(.checkbox)
                    .controlSize(.small)
                }
            }
        }
    }

    private func codeField(_ prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if !prompt.isEmpty {
                Text(prompt)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
            TextField("Code", text: $code)
                .font(.body.monospaced().weight(.medium))
                .wellField()
                .focused($focus, equals: .code)
                .onSubmit(send)
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            switch ask.kind {
            case .signIn, .code:
                Button("Not Now", role: .cancel) { app.browserAsks.answer(ask.id, .declined) }
                    .keyboardShortcut(takesKeys ? .cancelAction : nil)
                Spacer()
                Button(isSignIn ? "Sign In" : "Fill", action: send)
                    .buttonStyle(.glassProminent)
                    .keyboardShortcut(takesKeys ? .defaultAction : nil)
                    .disabled(isSignIn ? username.isEmpty && password.isEmpty : code.isEmpty)
            case .action:
                Button("I Can’t", role: .cancel) { app.browserAsks.answer(ask.id, .declined) }
                    .keyboardShortcut(takesKeys ? .cancelAction : nil)
                Spacer()
                if inThread {
                    Button("Show Page") { app.utilities.revealBrowser(page: ask.page) }
                        .help("Show the browser in the panel")
                }
                Button("Done") { app.browserAsks.answer(ask.id, .done) }
                    .buttonStyle(.glassProminent)
                    .keyboardShortcut(takesKeys ? .defaultAction : nil)
            }
        }
        .buttonStyle(.glass)
        .controlSize(.large)
    }

    private var isSignIn: Bool {
        if case .signIn = ask.kind { return true }
        return false
    }

    /// What answering a sign-in does with its password: saved when you asked to save a new one,
    /// or when a saved account's password changed (or agents allowed to sign in on their own would
    /// keep using the old one); and whether it's one you typed now, which allowing agents doesn't
    /// ask your Touch ID for (one filled in from Passwords does).
    static func handling(password: String, saving: Bool, secure: Bool, savedPassword: String?) -> (saves: Bool, typedNow: Bool) {
        let typedNow = !password.isEmpty && password != savedPassword
        return (secure && typedNow && (saving || savedPassword != nil), typedNow)
    }

    private func use(_ login: Passwords.Login) {
        username = login.account
        password = Passwords.password(for: login) ?? ""
    }

    private func send() {
        switch ask.kind {
        case .signIn:
            guard !username.isEmpty || !password.isEmpty else { return }
            let savedPassword = saved.first { $0.account == username }.flatMap(Passwords.password(for:))
            let handling = Self.handling(password: password, saving: saves, secure: Self.isSecure(ask.host), savedPassword: savedPassword)
            let typed = handling.typedNow, saving = handling.saves
            let answer = BrowserAsks.Answer.signIn(username: username.isEmpty ? nil : username, password: password.isEmpty ? nil : password)
            let wantsAgents = allowsAgents && Self.isSecure(ask.host) && !password.isEmpty
            // A password you typed now is yours to allow; one filled in from the vault asks you
            // first, as showing it in Settings does. Saved once the page has it.
            let host = ask.host, id = ask.id, asks = app.browserAsks, answerUsername = username, answerPassword = password
            Task {
                let allowed = wantsAgents ? (typed ? true : await Passwords.authenticate(reason: "let agents sign in to \(host) with its saved password")) : false
                asks.answer(id, answer)
                if saving {
                    if await Passwords.save(host: host, account: answerUsername, password: answerPassword, allowAgents: allowed) == nil {
                        Notifier.shared.notify(session: "", title: "Couldn’t save the password for \(host)", body: "This Mac’s vault didn’t answer. Sign in again to save it.")
                    }
                } else if allowed {
                    await Passwords.setAgentSignIn(host, true, account: answerUsername)
                }
            }
        case .code:
            guard !code.isEmpty else { return }
            app.browserAsks.answer(ask.id, .code(code.trimmingCharacters(in: .whitespaces)))
        case .action:
            app.browserAsks.answer(ask.id, .done)
        }
    }
}
