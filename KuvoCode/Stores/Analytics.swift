import ClientText
import Foundation
import MetricKit
import OpenCodeKit
import UsageKit
import os

/// Anonymous usage, sent in small batches to Kuvo's analytics collector so it's known which
/// features get used. On by default and off with Settings › Privacy › Share anonymous usage.
///
/// What goes out: a random ID made for this install, the app and macOS versions, the Mac's
/// architecture, memory (as a range) and language, and events like "a session started with
/// Anthropic's Claude Sonnet 5.5" or "the Changes tab opened". Also a run that ended without
/// quitting, and the crashes and hangs macOS reports: their kind, never what was on the stack.
/// While it's open and has sent nothing else for two minutes, a batch with no events in it, so
/// the dashboard can tell how many installs are open right now.
/// Never prompts, replies, code, file names, folders, account details or custom names: providers
/// outside the public list, models not in the public catalog and agents other than Build and Plan
/// go out as "other" and "custom". Sizes and durations go out as ranges, and what went wrong as a
/// kind ("rate limit", "network"), never its message.
///
/// The developer's own Macs mark themselves internal, so the numbers can leave them out:
/// `defaults write run.kuvo.code analytics.internal -bool true`.
///
/// Debug builds send nothing, unless `KUVO_ANALYTICS_URL` points them at a collector to test with.
@Observable
final class Analytics {
    static let shared = Analytics()

    static let enabledKey = "analytics.enabled"
    static let noticeKey = "analytics.noticeShown"
    private static let installKey = "analytics.installID"
    private static let activeDayKey = "analytics.activeDay"
    private static let versionKey = "analytics.version"
    private static let usageDayKey = "analytics.usageDay"
    private static let internalKey = "analytics.internal"
    private static let installDateKey = "analytics.installDate"
    /// One for each copy of the app running, `analytics.run.<its process>`, with when it launched
    /// and was last seen, removed when it quits: one still there at a launch, whose process has
    /// gone, ended some other way (a crash, Force Quit, the Mac losing power). One for each, so a
    /// second copy running (a development build) isn't taken for one that ended, nor hides one.
    private static let runPrefix = "analytics.run."
    /// Before, one flag for every copy: set while running, with when it launched and was seen.
    private static let oldRunKeys = (running: "analytics.running", launched: "analytics.launchedAt", alive: "analytics.aliveAt")
    private static let onboardedKey = "analytics.onboarded"
    private static let onboardingStepsKey = "analytics.onboardingSteps"
    private static let accountKey = "analytics.accountConnected"
    private static let endpoint = URL(string: "https://analytics.porigam.com.tr/kuvo/code")!

    /// Whether events are sent. Turning it off drops what hasn't gone out yet.
    var isEnabled: Bool {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: Self.enabledKey)
            if !isEnabled { queue.removeAll() }
        }
    }

    /// Whether the first-launch note about it has been dismissed.
    var noticeShown: Bool {
        didSet { UserDefaults.standard.set(noticeShown, forKey: Self.noticeKey) }
    }

    private let target: URL?
    private let installID: String
    /// No copy of Kuvo Code had run here before this launch.
    let isFirstLaunch: Bool
    /// When this install first ran; nil for one from before it was noted.
    private let installDate: Date?
    private let launchedAt = Date.now
    /// Whether this install has sent its first message: the first run is over.
    private var isOnboarded: Bool
    private var lastOnboardingStep: String?
    private var queue: [[String: Any]] = []
    private var flushTask: Task<Void, Never>?
    /// After a send that didn't go through, how long until the next try: longer each time, up
    /// to an hour, and nil again once one goes through.
    private var backoff: Duration?
    private var isQuitting = false
    private var dayTimer: Timer?
    private var heartbeatTimer: Timer?
    /// When a batch last went through, so a heartbeat goes only when nothing else has lately.
    private var lastSent = Date.distantPast
    private var sentOnce: Set<String> = []
    private let log = Logger(subsystem: AppInfo.bundleID, category: "analytics")

    private init() {
        let defaults = UserDefaults.standard
        defaults.register(defaults: [Self.enabledKey: true])
        isEnabled = defaults.bool(forKey: Self.enabledKey)
        noticeShown = defaults.bool(forKey: Self.noticeKey)
        if let id = defaults.string(forKey: Self.installKey) {
            installID = id
            isFirstLaunch = false
            // An install from before the first run was followed has long been through it.
            if defaults.object(forKey: Self.onboardedKey) == nil { defaults.set(true, forKey: Self.onboardedKey) }
        } else {
            installID = UUID().uuidString.lowercased()
            defaults.set(installID, forKey: Self.installKey)
            defaults.set(Date.now, forKey: Self.installDateKey)
            defaults.set(false, forKey: Self.onboardedKey)
            isFirstLaunch = true
        }
        installDate = defaults.object(forKey: Self.installDateKey) as? Date
        isOnboarded = defaults.bool(forKey: Self.onboardedKey)
        #if DEBUG
        target = ProcessInfo.processInfo.environment["KUVO_ANALYTICS_URL"].flatMap(URL.init(string:))
        #else
        target = Self.endpoint
        #endif
    }

    // MARK: Recording

    /// Records an event; it goes out with the next batch.
    func track(_ name: String, _ props: [String: Any] = [:]) {
        guard isEnabled, target != nil else { return }
        queue.append(["name": name, "ts": Date.now.ISO8601Format(), "props": props])
        if queue.count > 300 { queue.removeFirst(queue.count - 300) }
        // At quit, all at once (see flushBeforeQuit); while the collector is having trouble, at
        // the next try.
        guard !isQuitting else { return }
        if queue.count >= 25, backoff == nil { flush() } else { scheduleFlush() }
    }

    /// Records an event the first time it happens while the app runs (one of each `key`, if given).
    func trackOnce(_ name: String, key: String? = nil, _ props: [String: Any] = [:]) {
        guard sentOnce.insert(key.map { name + "." + $0 } ?? name).inserted else { return }
        track(name, props)
    }

    /// At launch: the launch itself, then one "active" a day for as long as the app stays open.
    func start() {
        let defaults = UserDefaults.standard
        // Runs that didn't quit: how long each had been open when it was last seen.
        var ended: [[String: Date]] = []
        if defaults.bool(forKey: Self.oldRunKeys.running), let launched = defaults.object(forKey: Self.oldRunKeys.launched) as? Date {
            ended.append(["launched": launched, "alive": defaults.object(forKey: Self.oldRunKeys.alive) as? Date ?? launched])
        }
        for key in [Self.oldRunKeys.running, Self.oldRunKeys.launched, Self.oldRunKeys.alive] { defaults.removeObject(forKey: key) }
        for (key, value) in defaults.dictionaryRepresentation() where key.hasPrefix(Self.runPrefix) {
            guard !Self.isRunning(String(key.dropFirst(Self.runPrefix.count))) else { continue }
            defaults.removeObject(forKey: key)
            if let run = value as? [String: Date] { ended.append(run) }
        }
        for run in ended {
            guard let launched = run["launched"] else { continue }
            track("app_exited_unexpectedly", ["minutes": Self.minutes((run["alive"] ?? launched).timeIntervalSince(launched))])
        }
        noteAlive()
        var props: [String: Any] = ["ram": Self.memory]
        if isFirstLaunch { props["first"] = true }
        track("app_launched", props)
        if let previous = defaults.string(forKey: Self.versionKey), previous != AppInfo.version {
            track("app_updated", ["from": previous])
        }
        defaults.set(AppInfo.version, forKey: Self.versionKey)
        defaults.set(Self.today, forKey: Self.activeDayKey)
        dayTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
            Task { @MainActor in
                Analytics.shared.noteAlive()
                Analytics.shared.markActiveDay()
            }
        }
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: Self.heartbeatInterval, repeats: true) { _ in
            Task { @MainActor in Analytics.shared.heartbeat() }
        }
        // Crashes and hangs, as macOS reports them (a day or so later, at a launch).
        MXMetricManager.shared.add(CrashReports.shared)
        // The usage panel reads its providers in the first minutes.
        Task {
            try? await Task.sleep(for: .seconds(180))
            noteUsageProviders()
        }
    }

    /// This run, as seen now (see `runPrefix`).
    private func noteAlive() {
        UserDefaults.standard.set(["launched": launchedAt, "alive": Date.now], forKey: Self.runPrefix + Self.thisRun)
    }

    private static let thisRun = process(getpid()) ?? "\(getpid())"

    private static func isRunning(_ run: String) -> Bool {
        guard let pid = run.split(separator: "-").first.flatMap({ pid_t($0) }) else { return false }
        return process(pid) == run
    }

    /// A running process as "<ID>-<when it started>", which no later process has (IDs are used
    /// again); nil when there's none with that ID.
    private static func process(_ pid: pid_t) -> String? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&name, u_int(name.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let started = info.kp_proc.p_un.__p_starttime
        return "\(pid)-\(started.tv_sec).\(started.tv_usec)"
    }

    /// Once a day: which AI tools the menu bar's usage panel follows (their public IDs).
    private func noteUsageProviders() {
        let defaults = UserDefaults.standard
        let providers = UsageMenuBar.shared.trackedProviderIDs
        guard defaults.string(forKey: Self.usageDayKey) != Self.today, !providers.isEmpty else { return }
        defaults.set(Self.today, forKey: Self.usageDayKey)
        // The tool only: an account's own ID ("codex@1a2b3c4d", a hash of who it is) would be the
        // same on every Mac it's used on.
        for provider in Set(providers.map { String($0.split(separator: "@").first ?? Substring($0)) }).sorted() {
            track("usage_tracked", ["provider": provider])
        }
    }

    private func markActiveDay() {
        noteUsageProviders()
        guard UserDefaults.standard.string(forKey: Self.activeDayKey) != Self.today else { return }
        UserDefaults.standard.set(Self.today, forKey: Self.activeDayKey)
        track("app_active")
    }

    // MARK: The first run

    /// A step of the first run seen, once each, until the first message is sent.
    func onboardingStep(_ step: String, _ props: [String: Any] = [:]) {
        guard !isOnboarded else { return }
        lastOnboardingStep = step
        let defaults = UserDefaults.standard
        var seen = defaults.stringArray(forKey: Self.onboardingStepsKey) ?? []
        guard !seen.contains(step) else { return }
        seen.append(step)
        defaults.set(seen, forKey: Self.onboardingStepsKey)
        var props = props
        props["step"] = step
        track("onboarding_step_viewed", props)
    }

    /// The first message this install sent: in a project, a chat or a bot's conversation.
    func messageSent(path: @autoclosure () -> String) {
        guard !isOnboarded else { return }
        isOnboarded = true
        UserDefaults.standard.set(true, forKey: Self.onboardedKey)
        var props: [String: Any] = ["path": path(), "account": UserDefaults.standard.bool(forKey: Self.accountKey)]
        if let since = sinceInstall { props["since_install"] = since }
        track("onboarding_completed", props)
    }

    /// A message that couldn't go, before the first one has.
    func firstMessageBlocked(_ reason: String) {
        guard !isOnboarded else { return }
        track("first_message_blocked", ["reason": reason])
    }

    /// An account was connected (it's said with the first message).
    func accountConnected() {
        UserDefaults.standard.set(true, forKey: Self.accountKey)
    }

    /// How long since this install first ran, as a range; nil when that isn't known.
    var sinceInstall: String? {
        installDate.map { Self.bucket(Date.now.timeIntervalSince($0), [60, 300, 900, 3600, 86400, 604_800], ["<1m", "1-5m", "5-15m", "15-60m", "1-24h", "1-7d", "7d+"]) }
    }

    // MARK: How far sessions go

    private struct SessionUse {
        var messages = 0
        var chars = 0
        var turns = 0
        let since = Date.now
    }

    private var sessionUse: [String: SessionUse] = [:]

    /// A message you sent in a session.
    func noteMessage(in session: String, chars: Int) {
        sessionUse[session, default: SessionUse()].messages += 1
        sessionUse[session]?.chars += chars
    }

    /// A run of a session you sent to here ended.
    func noteTurn(in session: String) {
        sessionUse[session]?.turns += 1
    }

    /// A session you worked in left the window (its tab closed) or the app quits.
    func sessionEnded(_ session: String) {
        guard let use = sessionUse.removeValue(forKey: session) else { return }
        track("session_ended", [
            "messages": Self.count(use.messages),
            "turns": Self.count(use.turns),
            "minutes": Self.minutes(Date.now.timeIntervalSince(use.since)),
            "chars": Self.bucket(Double(use.chars), [100, 500, 2000, 10000], ["0-100", "100-500", "500-2k", "2k-10k", "10k+"]),
        ])
    }

    // MARK: What went wrong

    /// The kind of trouble an error was, from its status and words (which never leave the Mac).
    nonisolated static func trouble(status: Int?, _ text: String) -> String {
        let text = text.lowercased()
        func says(_ words: String...) -> Bool { words.contains { text.contains($0) } }
        if says("usage limit", "usagelimit", "quota", "insufficient", "credit", "billing") { return "quota" }
        if status == 429 || says("rate limit", "ratelimit", "too many requests") { return "rate_limit" }
        if status == 401 || status == 403 || says("unauthorized", "invalid api key", "invalid_api_key", "authentication", "forbidden") { return "auth" }
        if status == 408 || status == 504 || says("timed out", "timeout") { return "timeout" }
        if status == 413 || says("context length", "context window", "maximum context", "too many tokens", "too long") { return "context_too_long" }
        if (status ?? 0) >= 500 || says("overloaded", "unavailable", "internal server error", "bad gateway") { return "provider_down" }
        if says("network", "connection", "econn", "enotfound", "fetch failed", "socket") { return "network" }
        return "other"
    }

    /// The kind of trouble a request ran into: the network, or what the engine said.
    nonisolated static func trouble(_ error: any Error) -> String {
        if let error = error as? URLError { return error.code == .timedOut ? "timeout" : "network" }
        if let error = error as? ServerError { return trouble(status: error.status, error.message) }
        return trouble(status: nil, error.localizedDescription)
    }

    // MARK: Ranges

    /// The label of the range `value` falls in: below the first bound, the first label, and so on.
    nonisolated static func bucket(_ value: Double, _ bounds: [Double], _ labels: [String]) -> String {
        labels[bounds.firstIndex { value < $0 } ?? bounds.count]
    }

    nonisolated static func minutes(_ seconds: TimeInterval) -> String {
        bucket(seconds / 60, [1, 5, 15, 60, 240], ["0-1", "1-5", "5-15", "15-60", "60-240", "240+"])
    }

    nonisolated static func count(_ count: Int) -> String {
        bucket(Double(count), [1, 2, 6, 21, 51], ["0", "1", "2-5", "6-20", "21-50", "51+"])
    }

    nonisolated static func tokens(_ count: Double) -> String {
        bucket(count, [1000, 10000, 50000, 200_000], ["0-1k", "1k-10k", "10k-50k", "50k-200k", "200k+"])
    }

    nonisolated static func cost(_ dollars: Double) -> String {
        dollars <= 0 ? "0" : bucket(dollars, [0.01, 0.1, 1], ["<0.01", "0.01-0.1", "0.1-1", "1+"])
    }

    /// This Mac's memory in GB, rounded down to a common size.
    private static var memory: String {
        let gigabytes = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824
        return bucket(gigabytes, [12, 20, 28, 40, 80], ["8", "16", "24", "32", "48-64", "96+"])
    }

    private static var today: String {
        Date.now.formatted(.iso8601.year().month().day().timeZone(separator: .omitted))
    }

    // MARK: What's safe to name

    /// Public providers by their catalog IDs; anything else (a custom provider, named by you) is "other".
    private static let publicProviders: Set<String> = [
        "opencode", "opencode-go", "anthropic", "openai", "google", "google-vertex", "github-copilot", "openrouter",
        "xai", "deepseek", "mistral", "groq", "cerebras", "fireworks-ai", "togetherai", "moonshotai", "zai",
        "zai-coding-plan", "amazon-bedrock", "azure", "vercel", "alibaba", "huggingface", "nvidia", "perplexity",
        "ollama", "lmstudio", "minimax", "baseten", "venice", "inception", "llama",
    ]

    static func provider(_ id: String?) -> String {
        guard let id else { return "none" }
        return publicProviders.contains(id) ? id : "other"
    }

    /// This Mac's engine's models, to tell the public catalog's from yours (set by the app).
    @ObservationIgnored weak var catalog: Catalog?

    /// The provider, and the model when it's one of a public provider's, by its name in the public
    /// catalog; one set up by you (a deployment, an ARN, a fine-tune, a local model, a name of
    /// your own for one) is "custom".
    static func model(provider id: String?, model: String?) -> [String: Any] {
        let provider = provider(id)
        guard provider != "other", provider != "none", let model else { return ["provider": provider] }
        let known = shared.catalog?.models.first { $0.providerID == id && $0.id == model }
        // Set up on any of your computers, as each has its own settings.
        let yours = ([EngineConfig.current].compactMap(\.self) + EngineConfig.machines()).contains { $0.value(at: ["providers", provider, "models", model]) != nil }
        return ["provider": provider, "model": known?.isPublished == true && !yours ? String(model.prefix(80)) : "custom"]
    }

    /// What a permission was for, by kind.
    static func action(_ action: String) -> String {
        switch action {
        case "edit", "write", "patch": "edit"
        case "shell", "bash": "shell"
        case "read", "external_directory", "webfetch", "websearch", "subagent", "skill", "question": action
        default: action.hasPrefix("kuvo-browser_") ? "browser" : "other"
        }
    }

    /// Build and Plan by name; agents you made are "custom".
    static func mode(_ agent: String?) -> String {
        guard let agent else { return "default" }
        return ["build", "plan"].contains(agent) ? agent : "custom"
    }

    // MARK: Sending

    /// How often an open app says it's still open, when it has sent nothing else since.
    private static let heartbeatInterval: TimeInterval = 120

    /// A batch with no events: the app is open. The collector stores no event for it, only that
    /// the install was seen, which is how the admin dashboard counts installs open right now.
    private func heartbeat() {
        guard isEnabled, !isQuitting, backoff == nil, queue.isEmpty, flushTask == nil,
              Date.now.timeIntervalSince(lastSent) >= Self.heartbeatInterval - 20,
              let request = request(for: [], heartbeat: true) else { return }
        Task {
            guard let (_, response) = try? await URLSession.shared.data(for: request),
                  ((response as? HTTPURLResponse)?.statusCode ?? 0) < 500 else { return }
            lastSent = .now
        }
    }

    /// The most events one send carries.
    private static let batchSize = 100

    private func scheduleFlush() {
        guard flushTask == nil else { return }
        let delay = backoff ?? .seconds(60)
        flushTask = Task {
            try? await Task.sleep(for: delay)
            // Sent already (flush cancels this).
            guard !Task.isCancelled else { return }
            flushTask = nil
            flush()
        }
    }

    /// Sends what's queued, a batch at a time. A batch that doesn't go through is kept for a later
    /// try, further off each time.
    func flush() {
        flushTask?.cancel()
        flushTask = nil
        let batch = Array(queue.prefix(Self.batchSize))
        guard isEnabled, let request = request(for: batch) else { return }
        queue.removeFirst(batch.count)
        Task {
            var delivered = false
            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                // Refused outright (a bad batch): dropped. Server trouble: tried again later.
                delivered = status < 500 && status != 429
            } catch {}
            if delivered { lastSent = .now; sent() } else { requeue(batch) }
        }
    }

    /// A batch went: what's left goes as usual (the next batch now, if there's a full one).
    private func sent() {
        backoff = nil
        if queue.count >= 25 { flush() } else if !queue.isEmpty { scheduleFlush() }
    }

    private func requeue(_ batch: [[String: Any]]) {
        guard isEnabled else { return }
        queue = Array((batch + queue).suffix(300))
        backoff = min((backoff ?? .seconds(30)) * 2, .seconds(3600))
        // The next try, no sooner than that.
        flushTask?.cancel()
        flushTask = nil
        scheduleFlush()
    }

    /// At quit: how long it was open (and where a first run stopped), then one last send,
    /// waiting a moment for it.
    func flushBeforeQuit() {
        isQuitting = true
        UserDefaults.standard.removeObject(forKey: Self.runPrefix + Self.thisRun)
        for session in Array(sessionUse.keys) { sessionEnded(session) }
        if !isOnboarded {
            var props: [String: Any] = ["step": lastOnboardingStep ?? "none"]
            if let since = sinceInstall { props["since_install"] = since }
            track("onboarding_left", props)
        }
        track("app_closed", ["minutes": Self.minutes(Date.now.timeIntervalSince(launchedAt))])
        flushTask?.cancel()
        flushTask = nil
        guard isEnabled else { return }
        // Every batch at once, waited for together.
        let done = DispatchGroup()
        while let request = request(for: Array(queue.prefix(Self.batchSize))) {
            queue.removeFirst(min(Self.batchSize, queue.count))
            done.enter()
            URLSession.shared.dataTask(with: request) { _, _, _ in done.leave() }.resume()
        }
        _ = done.wait(timeout: .now() + 2)
    }

    private func request(for events: [[String: Any]], heartbeat: Bool = false) -> URLRequest? {
        guard let target, heartbeat || !events.isEmpty else { return nil }
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let language = Locale.current.language
        var body: [String: Any] = [
            "install_id": installID,
            "app_version": AppInfo.version,
            "build": AppInfo.build,
            "os_version": "\(os.majorVersion).\(os.minorVersion)",
            "arch": Self.architecture,
            "events": events,
        ]
        if UserDefaults.standard.bool(forKey: Self.internalKey) { body["internal"] = true }
        if let code = language.languageCode?.identifier {
            body["locale"] = [code, language.region?.identifier].compactMap(\.self).joined(separator: "_")
        }
        guard let data = try? JSONSerialization.data(withJSONObject: body) else {
            log.error("Couldn't encode an analytics batch")
            return nil
        }
        var request = URLRequest(url: target, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        return request
    }

    private static var architecture: String {
        #if arch(arm64)
        "arm64"
        #else
        "x86_64"
        #endif
    }
}

private extension Model {
    /// As the public catalog (models.dev) has it, rather than set up by you. One of your own (in a
    /// settings file, or found on a local server) has no release date or price there unless you
    /// give it one; another name for a public one, and an Azure deployment, are sent to the
    /// provider by a name of their own. The catalog's own variants of a model ("…-fast") keep
    /// the model's name and add the mode's.
    var isPublished: Bool {
        guard time.released > 0, !cost.isEmpty, providerID != "azure" else { return false }
        guard let modelID, modelID != id else { return true }
        let mode = id.dropFirst(modelID.count + 1)
        return id.hasPrefix(modelID + "-") && name.lowercased().hasSuffix(" " + mode.lowercased())
    }
}

/// Crashes and hangs macOS noticed, as it hands them over (at a launch, up to a day later): their
/// kind and the version they happened in, never what was on the stack.
final class CrashReports: NSObject, MXMetricManagerSubscriber {
    static let shared = CrashReports()

    nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
        var events: [(String, [String: String])] = []
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                events.append(("app_crashed", [
                    "source": "metrickit",
                    "kind": Self.kind(exception: crash.exceptionType?.intValue, signal: crash.signal?.intValue),
                    "version": String(crash.metaData.applicationBuildVersion.prefix(32)),
                ]))
            }
            for hang in payload.hangDiagnostics ?? [] {
                let seconds = hang.hangDuration.converted(to: .seconds).value
                events.append(("app_hang", [
                    "seconds": Analytics.bucket(seconds, [5, 15, 60], ["2-5", "5-15", "15-60", "60+"]),
                    "version": String(hang.metaData.applicationBuildVersion.prefix(32)),
                ]))
            }
        }
        guard !events.isEmpty else { return }
        Task { @MainActor in
            for (name, props) in events { Analytics.shared.track(name, props) }
        }
    }

    /// The Mach exception's name, else the signal's.
    private nonisolated static func kind(exception: Int?, signal: Int?) -> String {
        let exceptions = [1: "EXC_BAD_ACCESS", 2: "EXC_BAD_INSTRUCTION", 3: "EXC_ARITHMETIC", 5: "EXC_SOFTWARE", 6: "EXC_BREAKPOINT", 10: "EXC_CRASH", 11: "EXC_RESOURCE", 12: "EXC_GUARD"]
        let signals = [4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 8: "SIGFPE", 9: "SIGKILL", 10: "SIGBUS", 11: "SIGSEGV"]
        return exception.flatMap { exceptions[$0] } ?? signal.flatMap { signals[$0] } ?? "other"
    }
}
