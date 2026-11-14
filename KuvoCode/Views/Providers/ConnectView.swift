import ClientAccounts
import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// Signing in to one provider, whichever way it supports: browser sign-in,
/// a device code, an API key, or credentials the Mac already has (AWS, gcloud).
/// The engine runs the OAuth exchange and stores the result; its box says which ways to offer, in
/// what order and words, and what to say when one didn't work (`kuvo/sign-in/methods`,
/// `kuvo/sign-in/status`); this view guides the person through it.
struct ConnectView: View {
    let integrationID: String
    /// What it's called and its mark, when the engine's name for it isn't the one you know
    /// (an integration's server is named by its ID).
    var name: String? = nil
    var symbol: String? = nil
    /// What the last step says the connection gives you.
    var connectedNote = "Its models are now in the model picker."
    /// What it gives you, as a few lines under the note on the last step.
    var highlights: [Highlight] = []
    /// Back to the account list (after "Done").
    var onDone: () -> Void = {}
    /// Leaves without connecting. When set (in a sheet), every step but the last has a Cancel
    /// beside its own buttons.
    var onCancel: (() -> Void)? = nil
    /// Only its API key: a plan an agent signs in to (ChatGPT's) is signed in to there, never here
    /// too (the first launch's API Keys).
    var keysOnly = false

    @Environment(AppModel.self) private var app
    @Environment(Catalog.self) private var catalog
    @Environment(\.openURL) private var openURL

    private enum Step: Equatable {
        case choose
        case details(Integration.Method)
        case key(Integration.Method)
        case waiting(OAuthAttempt)
        case connected
        case failed(String)
    }

    @State private var step = Step.choose
    /// The ways in, as its box offers them; nil until it has said.
    @State private var offered: SignInMethods?
    /// Why its box couldn't say them.
    @State private var offeredFailure: String?
    @State private var answers: FormAnswer = [:]
    @State private var key = ""
    @FocusState private var isKeyFocused: Bool
    @FocusState private var isCodeFocused: Bool
    @State private var pastedCode = ""
    /// A sign-in that finishes by itself, whose page gave a code instead: the field to paste it.
    @State private var isPastingCode = false
    @State private var isCheckingCode = false
    @State private var codeError: String?
    /// The sign-in said how it's going at least once (a page without a link is waited on as any).
    @State private var hasStatus = false
    @State private var isWorking = false
    /// Why the engine didn't take the key, shown under it until you change it.
    @State private var keyError: String?
    @State private var copied = false
    @State private var linkCopied = false
    /// The browser didn't take the page (none set, say): opened by hand from here.
    @State private var browserRefused = false
    @State private var copyReset: Task<Void, Never>?
    @State private var pollTask: Task<Void, Never>?
    /// The page to sign in on, once known: the attempt's, or one its status brought later.
    @State private var signInURL = ""
    /// How a sign-in that's getting ready is going ("Downloading… 40%").
    @State private var progress: String?
    /// The page was closed: a sign-in still starting then is called off, not opened.
    @State private var left = false
    /// Sign-ins started, and Backs: one still starting when you went Back is called off too.
    @State private var starts = 0
    /// For one on a machine: the port its page comes back to, forwarded there meanwhile.
    @State private var forward = SignInForward()
    /// The way being started now.
    @State private var startedID: String?

    struct Highlight: Hashable {
        let symbol: String
        let title: String
        let detail: String
    }

    private var integration: Integration? {
        catalog.integrations.first { $0.id == integrationID }
    }

    private var title: String { name ?? integration?.name ?? "" }

    var body: some View {
        // In a sheet it's as tall as its step; on a page it scrolls.
        if onCancel != nil {
            steps.padding(.top, 8)
        } else {
            ScrollView { steps }
        }
    }

    private var steps: some View {
        VStack(spacing: 24) {
            header
            Group {
                switch step {
                case .choose: methods
                case .details(let method): details(method)
                case .key(let method): keyEntry(method)
                case .waiting(let attempt): waiting(attempt)
                case .connected: connected
                case .failed(let message): failed(message)
                }
            }
            .frame(maxWidth: 420)
            .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 10)), removal: .opacity))
        }
        .padding(32)
        .frame(maxWidth: .infinity)
        .animation(.ui, value: step)
        .onAppear {
            Analytics.shared.onboardingStep("connect_account", ["provider": Analytics.provider(integrationID)])
        }
        .task {
            await readMethods()
            // (Closed meanwhile: nothing starts.)
            guard !left, !Task.isCancelled else { return }
            chooseOnlyMethod()
        }
        .onDisappear {
            left = true
            cancelAttempt()
            forward.stop()
        }
    }

    // MARK: Steps

    private var header: some View {
        VStack(spacing: 14) {
            Group {
                if let symbol {
                    // An integration: its mark, else the plain symbol for what it is.
                    BrandMarkView(integrationID, size: 32, fallback: symbol)
                        .fontWeight(.medium)
                        .foregroundStyle(.primary)
                } else {
                    ProviderLogo(id: OutsideAgents.logo(integrationID), size: 40)
                }
            }
            .frame(width: 72, height: 72)
            .glassEffect(.regular, in: .rect(cornerRadius: 20))
            .overlay(alignment: .bottomTrailing) {
                if step == .connected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(.white, .green)
                        .background(Circle().fill(.background).padding(2))
                        .offset(x: 7, y: 7)
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .animation(.spring(response: 0.4, dampingFraction: 0.6), value: step == .connected)
            Text(step == .connected ? "\(title) is connected" : "Connect \(title)")
                .font(.title2.weight(.semibold))
                .contentTransition(.opacity)
        }
    }

    @ViewBuilder private var methods: some View {
        if let offeredFailure {
            failed(offeredFailure)
        } else if offered == nil {
            VStack(spacing: 10) {
                Spinner(size: 18)
                    .frame(maxWidth: .infinity, minHeight: 60)
                    .accessibilityLabel("Getting the ways to sign in")
                if onCancel != nil {
                    trailingCancel
                        .padding(.top, 14)
                }
            }
        } else {
            offeredMethods
        }
    }

    private var offeredMethods: some View {
        // In the box's order: signing in with a subscription leads; an API key is the fallback.
        let primary = supportedMethods.filter { !$0.legacy }
        let legacy = supportedMethods.filter(\.legacy)
        return VStack(spacing: 10) {
            if supportedMethods.isEmpty {
                Text("There’s no way to sign in to \(title) from here.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(primary.enumerated()), id: \.element.id) { index, way in
                let method = way.method
                Button { start(method) } label: {
                    // The one getting ready (an agent installed first): no more taps meanwhile.
                    if isWorking, startedID == method.id {
                        HStack(spacing: 8) {
                            Spinner(size: 14)
                            Text(way.label)
                        }
                        .frame(maxWidth: .infinity)
                    } else {
                        Label(way.label, systemImage: symbol(for: method))
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(index == 0 ? AnyPrimitiveButtonStyle(.glassProminent) : AnyPrimitiveButtonStyle(.glass))
                .markInk(index == 0 ? .onFill : .control)
                .controlSize(.extraLarge)
                .disabled(isWorking)
            }
            if !legacy.isEmpty {
                DisclosureGroup("Other ways to sign in") {
                    VStack(spacing: 8) {
                        ForEach(legacy) { way in
                            Button(way.label) { start(way.method) }
                                .buttonStyle(.link)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.top, 6)
                }
                .padding(.top, 6)
            }
            if let names = offered?.environment, !names.isEmpty {
                Text("Or set \(names.joined(separator: " or ")) in your shell profile.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
            }
            if onCancel != nil {
                trailingCancel
                    .padding(.top, 14)
            }
        }
    }

    private func details(_ method: Integration.Method) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            FormFieldsView(fields: method.form, answers: $answers)
            HStack {
                backButton
                Spacer()
                cancelButton
                Button("Continue") { proceed(method) }
                    .buttonStyle(.glassProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!FormFieldsView.isComplete(method.form, answers) || isWorking)
            }
            .controlSize(.large)
        }
    }

    private func keyEntry(_ method: Integration.Method) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("API key")
                    .font(.callout.weight(.medium))
                SecureField("Paste your key", text: $key)
                    .wellField(isFocused: isKeyFocused)
                    .focused($isKeyFocused)
                    .onSubmit { connectKey(method) }
                    .onChange(of: key) { keyError = nil }
                    .accessibilityLabel("API key")
                // A key that comes with a subscription says so, so it doesn't read as pay-as-you-go.
                // VoiceOver reads it once, as one element that opens the link.
                if let keyPage {
                    // (Its link with the pointing hand, as links anywhere else.)
                    MessageMentions.text(keyPage.linkedLine, size: NSFont.preferredFont(forTextStyle: .callout).pointSize)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .modifier(LinkPointer(isOn: keyPage.url != nil, isSelectable: false))
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(keyPage.spokenLine)
                        .accessibilityAddTraits(keyPage.url == nil ? [] : .isLink)
                        .accessibilityAction {
                            if let url = keyPage.url { openURL(url) }
                        }
                }
            }
            if !method.form.isEmpty {
                FormFieldsView(fields: method.form, answers: $answers)
            }
            if let keyError {
                ErrorCard(message: keyError)
                    .transition(.opacity)
            }
            HStack {
                backButton
                Spacer()
                cancelButton
                Button("Connect") { connectKey(method) }
                    .buttonStyle(.glassProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty || !FormFieldsView.isComplete(method.form, answers) || isWorking)
            }
            .controlSize(.large)
        }
        .animation(.ui, value: keyError)
    }

    private var keyPage: KeyPage? {
        KeyPage.page(for: integrationID, name: title, docs: integration?.metadata?["doc"]?.string.flatMap(URL.init(string:)))
    }

    /// Getting ready (an agent downloading first, its page not there yet): what it's doing, not
    /// yet waiting on you.
    /// A coding agent's page always comes (late, from one slow to start): until then, it isn't
    /// waiting on you, whatever its status said.
    private var gettingReady: String? {
        progress ?? (signInURL.isEmpty && (!hasStatus || OutsideAgents.isAgent(integrationID)) ? "Getting ready…" : nil)
    }

    private func waiting(_ attempt: OAuthAttempt) -> some View {
        VStack(spacing: 18) {
            // A machine's sign-in whose page can't come back to it.
            if let problem = forward.problem {
                ErrorCard(message: problem)
            }
            if let gettingReady {
                HStack(spacing: 8) {
                    Spinner(size: 16)
                    Text(gettingReady)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                }
            }
            if let code = attempt.userCode {
                VStack(spacing: 10) {
                    Text("Enter this code on the page that opened")
                        .foregroundStyle(.secondary)
                    Text(code)
                        .font(.system(size: 34, weight: .semibold, design: .monospaced))
                        .kerning(3)
                        .textSelection(.enabled)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 12)
                        .glassEffect(.regular, in: .rect(cornerRadius: 16))
                    Button(copied ? "Copied" : "Copy Code", systemImage: copied ? "checkmark" : "doc.on.doc") { copy(code) }
                        .buttonStyle(TextButtonStyle())
                        .contentTransition(.symbolEffect(.replace))
                }
            } else if attempt.mode == .auto, gettingReady == nil {
                Text(browserRefused ? "Your browser didn’t open. Open the page to sign in. This updates on its own." : "Finish signing in with your browser. This updates on its own.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }

            if attempt.mode == .code {
                VStack(alignment: .leading, spacing: 8) {
                    Text(attempt.instructions)
                        .foregroundStyle(.secondary)
                    TextField("Paste the code", text: $pastedCode)
                        .wellField(isFocused: isCodeFocused)
                        .focused($isCodeFocused)
                        .onSubmit { complete(attempt) }
                    HStack {
                        Spacer()
                        cancelButton
                        Button("Continue") { complete(attempt) }
                            .buttonStyle(.glassProminent)
                            .keyboardShortcut(.defaultAction)
                            .disabled(pastedCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking)
                    }
                    .controlSize(.large)
                    .padding(.top, 8)
                }
            } else if gettingReady == nil {
                // Checking a pasted code is a moment's wait here, not on you.
                if isCheckingCode {
                    HStack(spacing: 8) {
                        Spinner(size: 16)
                        Text("Checking the code…")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    HandoffWait("Waiting for you to finish…", to: .browser)
                    // On a Mac, Claude Code signs in to its own folder here, apart from the one you use.
                    if catalog.machine == nil, OutsideAgents.base(integrationID) == "claude-code" {
                        Text("Separate from Claude Code in Terminal")
                            .font(.callout)
                            .foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                    }
                }
                if attempt.acceptsCode == true, isPastingCode, !isCheckingCode {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("If the page gave you a code, paste it here.")
                            .foregroundStyle(.secondary)
                        HStack(spacing: 8) {
                            TextField("Paste the code", text: $pastedCode)
                                .wellField(isFocused: isCodeFocused)
                                .focused($isCodeFocused)
                                .onSubmit { submitCode(attempt) }
                            Button("Continue") { submitCode(attempt) }
                                .buttonStyle(.glassProminent)
                                .keyboardShortcut(.defaultAction)
                                .disabled(pastedCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        if let codeError {
                            Text(codeError)
                                .font(.callout)
                                .foregroundStyle(.red)
                        }
                    }
                }
            }

            HStack(spacing: 16) {
                if !signInURL.isEmpty {
                    Button(browserRefused ? "Open the Page" : "Open the Page Again") { open(signInURL) }
                    // Wherever the browser is (another one, another Mac): the page by hand.
                    Button(linkCopied ? "Link Copied" : "Copy Link") { copyLink() }
                }
                if attempt.mode == .auto, attempt.acceptsCode == true, !isPastingCode, gettingReady == nil {
                    Button("Paste a Code") { isPastingCode = true }
                }
                // In a sheet, Cancel leaves it; here it goes back to the ways to sign in.
                if onCancel == nil {
                    Button("Cancel") {
                        cancelAttempt()
                        step = .choose
                    }
                }
            }
            .buttonStyle(.link)

            if onCancel != nil, attempt.mode != .code {
                trailingCancel
            }
        }
    }

    private var connected: some View {
        VStack(spacing: 20) {
            if !connectedNote.isEmpty {
                Text(connectedNote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            if !highlights.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(highlights, id: \.self) { highlight in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Image(systemName: highlight.symbol)
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(.tint)
                                .frame(width: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(highlight.title)
                                    .fontWeight(.medium)
                                Text(highlight.detail)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                        }
                    }
                }
                .padding(16)
                .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 14))
            }
            Button("Done", action: onDone)
                .buttonStyle(.glassProminent)
                .controlSize(.extraLarge)
                .keyboardShortcut(.defaultAction)
        }
    }

    private func failed(_ message: String) -> some View {
        VStack(spacing: 16) {
            ErrorCard(message: message)
            // Centered on its own; in a sheet, at the trailing edge beside Cancel.
            HStack {
                if onCancel != nil {
                    Spacer()
                    cancelButton
                }
                Button("Try Again") { tryAgain() }
                    .buttonStyle(.glass)
            }
            .controlSize(.large)
        }
    }

    /// Back to the ways to sign in, when there's more than one.
    @ViewBuilder private var backButton: some View {
        if supportedMethods.count > 1 {
            Button("Back") {
                starts += 1
                step = .choose
            }
            .buttonStyle(TextButtonStyle(outset: true))
        }
    }

    /// Leaves the sheet without connecting; nothing outside a sheet.
    @ViewBuilder private var cancelButton: some View {
        if let onCancel {
            Button("Cancel", action: onCancel)
                .buttonStyle(.glass)
                .keyboardShortcut(.cancelAction)
        }
    }

    /// Cancel on its own, at the trailing edge, for steps without a row of buttons.
    private var trailingCancel: some View {
        HStack {
            Spacer()
            cancelButton
        }
        .controlSize(.large)
    }

    // MARK: Actions

    /// The ways its box offers, in its order; on the first launch's API Keys, only a key.
    private var supportedMethods: [SignInMethods.Offered] {
        (offered?.methods ?? []).filter { way in
            guard keysOnly else { return true }
            if case .key = way.method { return true }
            return false
        }
    }

    /// Asks its box for the ways in. A box from before it can't say them: it needs updating.
    private func readMethods() async {
        guard let box = catalog.box else { return offeredFailure = unreachable }
        // (One that said it hasn't is asked again: it may have been updated since, Try Again.)
        if app.boxFeatures.knows(SignInMethods.feature, on: box.box) == false { await app.boxFeatures.readAgain(box.box) }
        guard let says = await app.boxFeatures.has(SignInMethods.feature, on: box.box) else { return offeredFailure = unreachable }
        guard says else {
            guard let machine = catalog.machine else { return offeredFailure = "This Mac’s box needs a newer Kuvo Code to sign in. It updates by itself overnight." }
            return offeredFailure = "\(app.name(of: .machine(machine))) needs a newer Kuvo Code to sign in from here. Update it, then try again."
        }
        let path = SignInMethods.path(integration: integrationID, agents: OutsideAgents.isAgent(integrationID))
        // Its box still starting is asked again each second, for half a minute at most.
        var tries = 0
        while !Task.isCancelled, !left {
            tries += 1
            do {
                offered = try await box.value(SignInMethods.self, "GET", path)
                offeredFailure = nil
                return
            } catch let refusal as BoxRefusal where refusal.reason == "starting" && tries < 30 {
                // Its box still starting (with the app, or after an update): asked again in a moment.
                try? await Task.sleep(for: .seconds(1))
            } catch let refusal as BoxRefusal where refusal.reason == "starting" {
                // Starting for too long: as when it can't be reached.
                offeredFailure = unreachable
                return
            } catch {
                offeredFailure = error.localizedDescription
                return
            }
        }
    }

    /// Back to the ways in, read again if its box couldn't say them.
    private func tryAgain() {
        step = .choose
        guard offeredFailure != nil else { return }
        offeredFailure = nil
        offered = nil
        Task {
            await readMethods()
            // (Closed meanwhile: nothing starts.)
            guard !left else { return }
            chooseOnlyMethod()
        }
    }

    private func chooseOnlyMethod() {
        #if DEBUG
        // KUVO_DEMO_CONNECTED: opens on the last step, as after signing in.
        if ProcessInfo.processInfo.environment["KUVO_DEMO_CONNECTED"] != nil {
            step = .connected
            return
        }
        // KUVO_DEMO_CONNECT_METHOD=<id>: that way to sign in, started.
        if let id = ProcessInfo.processInfo.environment["KUVO_DEMO_CONNECT_METHOD"], let way = supportedMethods.first(where: { $0.id == id }) {
            start(way.method)
            return
        }
        #endif
        if supportedMethods.count == 1, let way = supportedMethods.first { start(way.method) }
    }

    private func start(_ method: Integration.Method) {
        guard !isWorking else { return }
        startedID = method.id
        answers = FormFieldsView.defaults(for: method.form)
        switch method {
        case .key:
            key = ""
            keyError = nil
            step = .key(method)
        default:
            // Ask for details first if the method has any visible fields.
            if method.form.contains(where: { !$0.isHidden }) {
                step = .details(method)
            } else {
                proceed(method)
            }
        }
    }

    private func proceed(_ method: Integration.Method) {
        guard let api = catalog.api(forIntegration: integrationID) else { return step = .failed(unreachable) }
        let answer = FormFieldsView.payload(method.form, answers)
        isWorking = true
        starts += 1
        let started = starts
        Task {
            defer { isWorking = false }
            do {
                switch method {
                case .oauth(let id, _, _):
                    let attempt = try await api.startOAuth(integration: integrationID, method: id, answer: answer.isEmpty ? nil : answer)
                    guard !left, starts == started else {
                        try? await api.cancelOAuth(integration: integrationID, attempt: attempt.attemptID)
                        return
                    }
                    step = .waiting(attempt)
                    progress = nil
                    pastedCode = ""
                    isPastingCode = false
                    isCheckingCode = false
                    codeError = nil
                    hasStatus = false
                    browserRefused = false
                    signInURL = attempt.url
                    if let code = attempt.userCode { copy(code) }
                    open(attempt.url)
                    if attempt.mode == .auto { poll(attempt) }
                case .external(let id, _, _):
                    try await api.connectExternal(integration: integrationID, method: id, answer: answer.isEmpty ? nil : answer)
                    finish(method: "external")
                default:
                    break
                }
            } catch {
                noteFailure(method: Self.kind(of: method), Analytics.trouble(error))
                // (Not over the ways to sign in, gone Back to meanwhile.)
                if starts == started { step = .failed(error.localizedDescription) }
            }
        }
    }

    private func connectKey(_ method: Integration.Method) {
        // Return in the field gets here too, past the disabled button.
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, FormFieldsView.isComplete(method.form, answers), !isWorking else { return }
        guard let api = catalog.api(forIntegration: integrationID) else { return keyError = unreachable }
        let answer = FormFieldsView.payload(method.form, answers)
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                try await api.connectKey(integration: integrationID, key: trimmed, answer: answer.isEmpty ? nil : answer)
                finish(method: "api_key")
            } catch {
                let trouble = Analytics.trouble(error)
                noteFailure(method: "key", trouble == "auth" || trouble == "other" ? "invalid_key" : trouble)
                // Stay on the key, so it can be fixed rather than pasted again.
                keyError = error.localizedDescription
            }
        }
    }

    /// The engine finishes the sign-in by itself; ask its box how it's going once a second.
    private func poll(_ attempt: OAuthAttempt) {
        pollTask?.cancel()
        pollTask = Task {
            // The engine not knowing the sign-in for ten seconds running: it started over, and the
            // sign-in went with it.
            var misses = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                // Not there (the coding agents starting over) counts as not knowing it. A box asked
                // through a process run each time (a machine's) waits for a change before it answers.
                let box = catalog.box
                let path = SignInStatus.path(integration: integrationID, attempt: attempt.attemptID, agents: OutsideAgents.isAgent(integrationID),
                                             wait: box.map { BoxClient.streams($0.box) } == false ? 20 : nil)
                guard let box, let status = try? await box.value(SignInStatus.self, "GET", path) else {
                    misses += 1
                    if misses >= 10 {
                        noteFailure(method: "oauth", "engine")
                        let who = OutsideAgents.isAgent(integrationID) ? "The coding agents" : "The engine"
                        step = .failed("\(who) started over while you were signing in. Try again.")
                        return
                    }
                    continue
                }
                // Closed while it asked: nothing to open or say.
                guard !Task.isCancelled else { return }
                misses = 0
                hasStatus = true
                switch status.status {
                case .pending:
                    // The page came later (an agent was downloaded first): opened once, as it comes.
                    if let url = status.url, !url.isEmpty, url != signInURL {
                        signInURL = url
                        open(url)
                    }
                    withAnimation(.ui) { progress = status.url == nil ? status.message : nil }
                    continue
                case .complete: finish(method: "oauth"); return
                case .failed:
                    noteFailure(method: "oauth", Analytics.trouble(status: nil, status.message ?? ""))
                    step = .failed(status.failure ?? status.message ?? "")
                    return
                case .expired:
                    noteFailure(method: "oauth", "timeout")
                    step = .failed(status.failure ?? "")
                    return
                }
            }
        }
    }

    private func complete(_ attempt: OAuthAttempt) {
        let code = pastedCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, !isWorking else { return }
        guard let api = catalog.api(forIntegration: integrationID) else { return codeError = unreachable }
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                try await api.completeOAuth(integration: integrationID, attempt: attempt.attemptID, code: code)
                finish(method: "oauth")
            } catch {
                noteFailure(method: "oauth", Analytics.trouble(error))
                step = .failed(error.localizedDescription)
            }
        }
    }

    /// The code the page gave, typed into the sign-in; how it went comes with the next status.
    private func submitCode(_ attempt: OAuthAttempt) {
        let code = pastedCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, !isCheckingCode else { return }
        guard let api = catalog.api(forIntegration: integrationID) else { return codeError = unreachable }
        isCheckingCode = true
        codeError = nil
        Task {
            do {
                try await api.completeOAuth(integration: integrationID, attempt: attempt.attemptID, code: code)
                // Still waiting a while later (it didn't take that code, and waits for another):
                // the field again.
                try? await Task.sleep(for: .seconds(10))
                if isCheckingCode, case .waiting(let current) = step, current.attemptID == attempt.attemptID {
                    isCheckingCode = false
                }
            } catch {
                // It may have finished in the browser meanwhile: the poll says how it went.
                isCheckingCode = false
                codeError = error.localizedDescription
            }
        }
    }

    /// Why it can't sign in now: the computer's engine isn't there, or, for a coding agent, its
    /// agents' bridge.
    private var unreachable: String {
        Self.unreachable(agent: OutsideAgents.isAgent(integrationID), machine: catalog.machine.map { app.name(of: .machine($0)) },
                         engineUp: catalog.api != nil, agentsFailure: catalog.outsideAgents?.failure)
    }

    /// `machine`: its name (nil: this Mac). `engineUp`: that computer's engine answers.
    static func unreachable(agent: Bool, machine: String?, engineUp: Bool, agentsFailure: String?) -> String {
        guard agent, machine == nil || engineUp else { return AppModel.Unreachable(computer: machine).localizedDescription }
        guard let machine else { return OutsideAgents.Failure.notRunning(agentsFailure).localizedDescription }
        return agentsFailure.map { "\(machine)’s coding agents couldn’t start: \($0)" } ?? "\(machine)’s coding agents aren’t running. Try again in a moment."
    }

    private func finish(method: String) {
        forward.stop()
        // Signed in anew: Custom Auto tries it again where you signed in (an agent's sign-in is
        // that place's own; a plan's goes to your machines too).
        if OutsideAgents.isAgent(integrationID) {
            if let agents = catalog.outsideAgents { Task { await agents.releaseLimit(integrationID) } }
        } else {
            app.releaseLimit(integrationID)
        }
        Analytics.shared.track("account_connected", ["provider": Analytics.provider(integrationID), "method": method])
        Analytics.shared.accountConnected()
        pollTask?.cancel()
        pollTask = nil
        step = .connected
        NSApp.activate()
        Task { await catalog.refresh() }
    }

    /// A connection that didn't work, for anonymous usage: the kind of trouble, never its words.
    private func noteFailure(method: String, _ reason: String) {
        Analytics.shared.track("account_connect_failed", ["provider": Analytics.provider(integrationID), "method": method, "reason": reason])
    }

    private static func kind(of method: Integration.Method) -> String {
        switch method {
        case .oauth: "oauth"
        case .key: "key"
        default: "other"
        }
    }

    private func cancelAttempt() {
        pollTask?.cancel()
        pollTask = nil
        if case .waiting(let attempt) = step, let api = catalog.api(forIntegration: integrationID) {
            noteFailure(method: "oauth", "cancelled")
            Task { try? await api.cancelOAuth(integration: integrationID, attempt: attempt.attemptID) }
        }
    }

    /// A sign-in page, in your browser: a web address only (one from a server's own sign-in
    /// metadata could name a file or another app).
    private func open(_ url: String) {
        guard !url.isEmpty, let url = URL(string: url), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        // An agent on a machine: the page comes back to it there.
        if let machine = catalog.machine { forward.start(for: url, on: machine) }
        #if DEBUG
        // KUVO_DEMO_NO_BROWSER: a demo copy's sign-in waits as if the page had opened, without
        // taking over the browser.
        if ProcessInfo.processInfo.environment["KUVO_DEMO_NO_BROWSER"] != nil { return }
        #endif
        withAnimation(.ui) { browserRefused = !NSWorkspace.shared.open(url) }
    }

    /// The sign-in page's link, for a browser you open yourself.
    private func copyLink() {
        Clipboard.copy(signInURL)
        withAnimation(.ui) { linkCopied = true }
        copyReset?.cancel()
        copyReset = Task {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            withAnimation(.ui) { linkCopied = false; copied = false }
        }
    }

    /// Copies the code, and says so for a moment.
    private func copy(_ code: String) {
        Clipboard.copy(code)
        withAnimation(.ui) { copied = true }
        copyReset?.cancel()
        copyReset = Task {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            withAnimation(.ui) { copied = false; linkCopied = false }
        }
    }

    // MARK: Describing methods

    private func symbol(for method: Integration.Method) -> String {
        switch method {
        case .oauth: "person.crop.circle"
        case .key: "key"
        case .external: "cloud"
        default: "link"
        }
    }
}

/// Lets one call site pick between two button styles.
struct AnyPrimitiveButtonStyle: PrimitiveButtonStyle {
    private let make: (Configuration) -> AnyView

    init(_ style: some PrimitiveButtonStyle) {
        make = { AnyView(style.makeBody(configuration: $0)) }
    }

    func makeBody(configuration: Configuration) -> some View {
        make(configuration)
    }
}
