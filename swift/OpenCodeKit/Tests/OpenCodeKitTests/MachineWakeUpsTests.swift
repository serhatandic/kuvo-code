import Foundation
import Testing
@testable import OpenCodeKit

/// Wake-ups on a machine with the Mac closed: every minute its watchdog runs `kuvo-wake fire`,
/// which sends what's due to each bot's or session's conversation, once, on the engine or, for a
/// coding agent's, on the agents bridge. A repeat comes back at its next time, and isn't queued
/// again while the last one waits; a paused bot's wait; a session the engine no longer has goes
/// to the trash, and a subagent's go to the conversation that started it. Run with this Mac's
/// sh (and dash), with a stand-in `curl` for the engine and the bridge, answering from files.
@Suite struct MachineWakeUpsTests {
    let k: URL
    var bots: URL { k.appending(path: "bots") }
    var sessions: URL { k.appending(path: "wakes") }

    static let enginePort = 41001
    static let bridgePort = 41002

    init() throws {
        k = FileManager.default.temporaryDirectory.appending(path: "machine-wakes-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: k.appending(path: "run"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: k.appending(path: "answers"), withIntermediateDirectories: true)
        let installed = try sh(Wakes.installScript)
        #expect(installed.status == 0, "\(installed.output)")
        try write(k.appending(path: "run/engine.json"), #"{"pid":1,"port":\#(Self.enginePort),"password":"engine-pass","version":"x","notes":{},"agents":{"port":9,"password":"nested"}}"#)
        // The engine or the bridge, behind curl: answers what's in `answers` (by port, method and
        // path; 404 for the rest), and notes each request with what it sent.
        let bin = k.appending(path: "testbin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try write(bin.appending(path: "curl"), #"""
            #!/bin/sh
            cat >/dev/null
            url= body= method=GET write= fail=
            while [ $# -gt 0 ]; do
              case "$1" in
                --data-binary) method=POST; body=$2; shift ;;
                -w) write=$2; shift ;;
                -H) case "$2" in x-opencode-directory:*) printf '%s\n' "${2#*: }" >>"$K/folders" ;; esac; shift ;;
                -K|-m|--noproxy) shift ;;
                -*f*) fail=1 ;;
                http://*) url=$1 ;;
              esac
              shift
            done
            rest=${url#http://127.0.0.1:}; port=${rest%%/*}; path=${rest#*/}
            printf '%s %s %s %s\n' "$port" "$method" "$path" "$body" >>"$K/requests"
            # The watchdog stopping it as it asks (its machine shutting down, say).
            if [ -f "$K/stop-on-ask" ]; then rm "$K/stop-on-ask"; kill -TERM "$(cat "$K/fire.pid")"; exit 22; fi
            # Or as it sends a wake-up, which the engine takes.
            case "$method $path" in "POST "*/prompt) if [ -f "$K/stop-on-send" ]; then rm "$K/stop-on-send"; kill -TERM "$(cat "$K/fire.pid")"; fi ;; esac
            key=$(printf '%s %s %s' "$port" "$method" "$path" | tr '/ ?' '___')
            # A prompt is taken, unless an answer says otherwise; the rest isn't there.
            code=404; out=
            case "$method $path" in "POST "*/prompt) code=200; out='{}' ;; esac
            if [ -f "$K/answers/$key" ]; then out=$(cat "$K/answers/$key"); code=$(cat "$K/answers/$key.code" 2>/dev/null || echo 200); fi
            # Answers given in turn, one a request, before the one that stays.
            next=$(ls "$K/answers/$key.turns" 2>/dev/null | sort -n | head -1)
            if [ -n "$next" ]; then out=$(cat "$K/answers/$key.turns/$next"); code=200; rm "$K/answers/$key.turns/$next"; fi
            if [ -n "$fail" ] && [ "$code" -ge 400 ]; then exit 22; fi
            printf '%s' "$out"
            case "$write" in *http_code*) printf '\n%s' "$code" ;; esac
            exit 0
            """#, executable: true)
    }

    private func cleanUp() { try? FileManager.default.removeItem(at: k) }

    private func write(_ file: URL, _ text: String, executable: Bool = false) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
        if executable { try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path) }
    }

    @discardableResult
    private func sh(_ script: String, shell: String = "/bin/sh") throws -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(filePath: shell)
        process.arguments = ["-c", script]
        process.currentDirectoryURL = k
        process.environment = ["PATH": "\(k.path)/testbin:/usr/bin:/bin", "K": k.path, "TZ": "UTC"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))
    }

    /// One minute of the watchdog's: the wake-ups that are due, sent.
    private func fire(shell: String = "/bin/sh") throws {
        let fired = try sh(#""$K/bin/kuvo-wake" fire "$K/bots" "$K/run/engine.json""#, shell: shell)
        #expect(fired.status == 0, "\(fired.output)")
    }

    /// What `port` answers `method path` with.
    private func answer(_ port: Int, _ method: String, _ path: String, _ body: String, code: Int = 200) throws {
        let key = "\(port) \(method) \(path)".map { "/ ?".contains($0) ? "_" : String($0) }.joined()
        try write(k.appending(path: "answers/\(key)"), body)
        try write(k.appending(path: "answers/\(key).code"), "\(code)")
    }

    /// What `port` answers `method path` with, in turn (one a request), before what `answer` says.
    private func answers(_ port: Int, _ method: String, _ path: String, _ bodies: [String]) throws {
        let key = "\(port) \(method) \(path)".map { "/ ?".contains($0) ? "_" : String($0) }.joined()
        for (index, body) in bodies.enumerated() { try write(k.appending(path: "answers/\(key).turns/\(index + 1)"), body) }
    }

    /// The requests made, as `port method path`, in order.
    private func requests() -> [String] {
        let log = (try? String(contentsOf: k.appending(path: "requests"), encoding: .utf8)) ?? ""
        return log.split(separator: "\n").map { $0.split(separator: " ").prefix(3).joined(separator: " ") }
    }

    /// The prompts sent, as `port session text`.
    private func prompts() -> [String] {
        let log = (try? String(contentsOf: k.appending(path: "requests"), encoding: .utf8)) ?? ""
        return log.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: " ", maxSplits: 3).map(String.init)
            guard parts.count == 4, parts[1] == "POST", parts[2].hasSuffix("/prompt") else { return nil }
            let session = parts[2].split(separator: "/")[2]
            let text = (try? JSONSerialization.jsonObject(with: Data(parts[3].utf8)) as? [String: Any])?["text"] as? String ?? "?"
            return "\(parts[0]) \(session) \(text)"
        }
    }

    /// A bot's (or, in `wakes`, a session's) folder for `session`, with a wake-up due `due` seconds
    /// from now, repeating `every` ("" for once).
    @discardableResult
    private func folder(_ name: String, in parent: URL? = nil, session: String, wake note: String? = nil, due: Int = -60, every: String = "") throws -> URL {
        let folder = (parent ?? bots).appending(path: name)
        try write(folder.appending(path: "session"), session)
        if let note {
            let at = Int(Date.now.timeIntervalSince1970) + due
            try write(folder.appending(path: "wakes/\(at)-abcd\(every.isEmpty ? "" : "-" + every)"), note)
        }
        return folder
    }

    private func wakes(of folder: URL) -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: folder.appending(path: "wakes").path).sorted()) ?? []
    }

    @Test(arguments: WakesTests.shells)
    func aDueWakeUpReachesItsBotOnceAndOneNotDueWaits(_ shell: String) throws {
        defer { cleanUp() }
        let bot = try folder("bot_a", session: "ses_a", wake: "Check whether CI passed")
        let later = try folder("bot_b", session: "ses_b", wake: "Tomorrow's report", due: 3600)
        try fire(shell: shell)
        #expect(prompts() == ["\(Self.enginePort) ses_a [Wake-up] Check whether CI passed"], "\(shell)")
        #expect(wakes(of: bot).isEmpty, "sent once, and done")
        #expect(wakes(of: later).count == 1, "not due yet")
        // The next minute: nothing again.
        try fire(shell: shell)
        #expect(prompts().count == 1)
    }

    /// Where the box can't take it to wait in the conversation's list (no box command named; the
    /// box's own test, `wakes-mac.test.js`, has it taken there), it waits here.
    @Test(arguments: WakesTests.shells)
    func aConversationYouStoppedGetsItsWakeUpOnceYouResumeIt(_ shell: String) throws {
        defer { cleanUp() }
        let bot = try folder("bot_a", session: "ses_a", wake: "Check whether CI passed")
        try folder("bot_b", session: "ses_b", wake: "Read the release notes")
        // Stopped: its queue paused on the box, as `run/queues.json` keeps it.
        try write(k.appending(path: "run/queues.json"), #"{"ses_a":{"paused":true,"held":[]},"ses_b":{"paused":false,"held":["msg_1"]}}"#)
        try fire(shell: shell)
        #expect(prompts() == ["\(Self.enginePort) ses_b [Wake-up] Read the release notes"], "\(shell): the stopped one's waits")
        #expect(wakes(of: bot).count == 1, "kept")
        // Resumed.
        try write(k.appending(path: "run/queues.json"), #"{}"#)
        try fire(shell: shell)
        #expect(prompts().last == "\(Self.enginePort) ses_a [Wake-up] Check whether CI passed", "\(shell)")
        #expect(wakes(of: bot).isEmpty)
    }

    /// When a folder's next try is (`.retry`), and how long it waited, in seconds.
    private func retry(of folder: URL) -> (at: Int, wait: Int)? {
        guard let text = try? String(contentsOf: folder.appending(path: ".retry"), encoding: .utf8) else { return nil }
        let parts = text.split(whereSeparator: \.isWhitespace).compactMap { Int($0) }
        return parts.count == 2 ? (parts[0], parts[1]) : nil
    }

    /// As if its wait were over.
    private func waitOver(_ folder: URL) throws {
        let wait = try #require(retry(of: folder)).wait
        try write(folder.appending(path: ".retry"), "\(Int(Date.now.timeIntervalSince1970) - 1) \(wait)\n")
    }

    @Test func oneTheEngineCouldntTakeWaitsLongerEachTimeUntilItGoes() throws {
        defer { cleanUp() }
        let bot = try folder("bot_a", session: "ses_a", wake: "Check the build")
        try answer(Self.enginePort, "POST", "api/session/ses_a/prompt", #"{"error":"busy"}"#, code: 503)
        let now = Int(Date.now.timeIntervalSince1970)
        try fire()
        #expect(prompts().count == 1)
        #expect(wakes(of: bot).count == 1, "kept")
        let first = try #require(retry(of: bot))
        #expect(first.wait == 60)
        #expect(first.at >= now + 60 && first.at <= now + 70, "a minute from now")
        // Within the minute: not tried.
        try fire()
        #expect(prompts().count == 1)
        // Its minute over, it still can't go: twice as long.
        try waitOver(bot)
        try fire()
        #expect(prompts().count == 2)
        #expect(retry(of: bot)?.wait == 120)
        // And it goes.
        try FileManager.default.removeItem(at: k.appending(path: "answers"))
        try waitOver(bot)
        try fire()
        #expect(prompts().count == 3)
        #expect(wakes(of: bot).isEmpty, "sent")
        #expect(retry(of: bot) == nil, "waiting no more")
    }

    @Test func aRepeatComesBackAtItsNextTimeAndIsntQueuedTwice() throws {
        defer { cleanUp() }
        let bot = try folder("bot_a", session: "ses_a", wake: "Standup", every: "1d")
        try fire()
        #expect(prompts() == ["\(Self.enginePort) ses_a [Wake-up] Standup"])
        let next = try #require(wakes(of: bot).first)
        let due = try #require(Int(next.split(separator: "-")[0]))
        #expect(due > Int(Date.now.timeIntervalSince1970) + 3600 * 20, "tomorrow, at the same time")
        #expect(next.hasSuffix("-abcd-1d") || next.contains("-abcd-"), "its letters kept")

        // Due again while the last one still waits in its queue (the bot busy): moved on, not sent.
        try FileManager.default.moveItem(at: bot.appending(path: "wakes/\(next)"), to: bot.appending(path: "wakes/\(Int(Date.now.timeIntervalSince1970) - 60)-abcd-1d"))
        try answer(Self.enginePort, "GET", "api/session/ses_a/inbox", #"[{"text":"[Wake-up] Standup"}]"#)
        try fire()
        #expect(prompts().count == 1, "not queued a second time")
        #expect(wakes(of: bot).count == 1 && Int(wakes(of: bot)[0].split(separator: "-")[0])! > Int(Date.now.timeIntervalSince1970))
    }

    @Test(arguments: WakesTests.shells)
    func aWakeUpWaitsForItsFoldersToolsThoughTheEngineHasOnlyJustOpenedIt(_ shell: String) throws {
        defer { cleanUp() }
        let bot = try folder("bot_a", session: "ses_a", wake: "Morning report")
        try write(bot.appending(path: "directory"), "/home/me/Çalışma notes")
        // Just opened: none listed yet, then its browser connecting, then connected.
        let none = "{}", pending = #"{"browser":{"status":"pending"}}"#, connected = #"{"browser":{"status":"connected"}}"#
        try answers(Self.enginePort, "GET", "api/mcp", [none, none, pending, connected])
        try answer(Self.enginePort, "GET", "api/mcp", connected)
        try fire(shell: shell)
        let asked = requests()
        let sent = asked.firstIndex(of: "\(Self.enginePort) POST api/session/ses_a/prompt")
        #expect(sent != nil)
        #expect(asked.prefix(sent ?? 0).filter { $0.hasSuffix("api/mcp") }.count == 4, "\(asked)")
        // Its folder named as the engine reads it (encodeURIComponent).
        let folders = (try? String(contentsOf: k.appending(path: "folders"), encoding: .utf8)) ?? ""
        #expect(folders.split(separator: "\n").first.map(String.init) == "/home/me/Çalışma notes".addingPercentEncoding(withAllowedCharacters: .init(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.!~*'()")))
    }

    @Test(arguments: WakesTests.shells)
    func oneStoppedAsItSendsLetsGoOfItsTurnSoTheNextMinuteSendsWhatsDue(_ shell: String) throws {
        defer { cleanUp() }
        let bot = try folder("bot_a", session: "ses_a", wake: "Morning report")
        try write(k.appending(path: "stop-on-ask"), "")
        let stopped = try sh(#"echo $$ >"$K/fire.pid"; exec \#(shell) "$K/bin/kuvo-wake" fire "$K/bots" "$K/run/engine.json""#)
        #expect(stopped.status != 0)
        #expect(!FileManager.default.fileExists(atPath: bots.appending(path: ".firing").path), "\(shell)")
        #expect(wakes(of: bot).count == 1, "not sent yet")
        try fire(shell: shell)
        #expect(prompts().last == "\(Self.enginePort) ses_a [Wake-up] Morning report", "\(shell)")
        #expect(wakes(of: bot).isEmpty, "sent, and done")
    }

    /// Stopped as it sends one the engine takes: it's done, not sent again the next minute.
    @Test(arguments: WakesTests.shells)
    func oneStoppedAsItSendsAWakeUpDoesntSendItTwice(_ shell: String) throws {
        defer { cleanUp() }
        let bot = try folder("bot_a", session: "ses_a", wake: "Morning report")
        try folder("bot_b", session: "ses_b", wake: "Evening report")
        try write(k.appending(path: "stop-on-send"), "")
        let stopped = try sh(#"echo $$ >"$K/fire.pid"; exec \#(shell) "$K/bin/kuvo-wake" fire "$K/bots" "$K/run/engine.json""#)
        #expect(stopped.status != 0)
        #expect(!FileManager.default.fileExists(atPath: bots.appending(path: ".firing").path), "\(shell)")
        #expect(wakes(of: bot).isEmpty, "\(shell): sent, and done")
        #expect(prompts() == ["\(Self.enginePort) ses_a [Wake-up] Morning report"], "\(shell): stopped before the next")
        try fire(shell: shell)
        #expect(prompts() == ["\(Self.enginePort) ses_a [Wake-up] Morning report", "\(Self.enginePort) ses_b [Wake-up] Evening report"], "\(shell)")
    }

    @Test func aPausedBotsWakeUpsWait() throws {
        defer { cleanUp() }
        let bot = try folder("bot_a", session: "ses_a", wake: "Check the build")
        try write(bot.appending(path: "paused"), "")
        try fire()
        #expect(prompts().isEmpty)
        #expect(wakes(of: bot).count == 1)
        // A bot on its way to another computer is paused the same way.
        try write(bot.appending(path: "paused"), "moving")
        try fire()
        #expect(prompts().isEmpty)
    }

    @Test func aCodingAgentsConversationIsWokenOnItsBridge() throws {
        defer { cleanUp() }
        try write(k.appending(path: "run/bridge.json"), #"{"pid":2,"port":\#(Self.bridgePort),"password":"bridge-pass"}"#)
        let bot = try folder("bot_a", session: "ses_agent", wake: "Look at the PR")
        try write(bot.appending(path: "via"), "bridge")
        try fire()
        #expect(prompts() == ["\(Self.bridgePort) ses_agent [Wake-up] Look at the PR"])
    }

    /// A watch that saw a change it hasn't told yet, in `folder`: the next minute tells it.
    private func watchToTell(in folder: URL) throws {
        let watch = folder.appending(path: "watches/AbCd12")
        try write(watch.appending(path: "check"), "echo changed")
        try write(watch.appending(path: "every"), "10m")
        try write(watch.appending(path: "note"), "Tell the user")
        try write(watch.appending(path: "next"), "0")
        try write(watch.appending(path: "last"), "2/0 0")
        try write(watch.appending(path: "pending"), "2/0 0")
    }

    /// The minute's watches, which run beside its wake-ups: done.
    private func watchesDone() {
        let lock = sessions.appending(path: ".watching")
        let end = Date.now.addingTimeInterval(30)
        while FileManager.default.fileExists(atPath: lock.path), Date.now < end { usleep(50_000) }
    }

    /// Archived from any app (a phone's, say, which marks the session itself), with the Mac closed:
    /// its wake-ups and watches wait there, kept and held as archiving holds them (as a folder the
    /// box's sandbox made for it is), until it's brought back; then they go, that same minute.
    @Test func anArchivedSessionsWakeUpsAndWatchesWaitUntilItsBack() throws {
        defer { cleanUp() }
        let old = try folder("ses_old", in: sessions, session: "ses_old", wake: "Follow up")
        try watchToTell(in: old)
        try answer(Self.enginePort, "GET", "api/session/ses_old", #"{"id":"ses_old","metadata":{"kuvo.archived":true}}"#)
        try fire()
        watchesDone()
        #expect(prompts().isEmpty)
        #expect(wakes(of: old).count == 1, "kept for when it's back")
        #expect((try? String(contentsOf: old.appending(path: "paused"), encoding: .utf8)) == "archived", "held, as it shows")
        // The engine's own mark, too.
        try answer(Self.enginePort, "GET", "api/session/ses_old", #"{"id":"ses_old","time":{"created":1,"archived":1760000000000}}"#)
        try fire()
        watchesDone()
        #expect(prompts().isEmpty)
        // Brought back: they go.
        try answer(Self.enginePort, "GET", "api/session/ses_old", #"{"id":"ses_old","metadata":{"kuvo.archived":false},"time":{"created":1,"archived":null}}"#)
        try fire()
        watchesDone()
        let sent = prompts()
        #expect(sent.contains("\(Self.enginePort) ses_old [Wake-up] Follow up"))
        #expect(sent.contains { $0.contains("Tell the user") }, "\(sent)")
    }

    @Test func aSessionTheEngineNoLongerHasGoesToTheTrash() throws {
        defer { cleanUp() }
        let gone = try folder("ses_gone", in: sessions, session: "ses_gone", wake: "Follow up")
        try answer(Self.enginePort, "GET", "api/session/ses_gone", #"{"name":"NotFound"}"#, code: 404)
        try fire()
        #expect(prompts().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: gone.path))
        let trash = try FileManager.default.contentsOfDirectory(atPath: k.appending(path: "trash").path)
        #expect(trash.count == 1 && trash[0].hasPrefix("wakes-ses_gone-"), "kept, not lost")
    }

    /// Held (archived, or paused by you) and then deleted, from a phone say: it goes to the trash
    /// too, rather than waiting for ever. One on its way to another computer stays.
    @Test func aHeldSessionTheEngineNoLongerHasGoesToTheTrash() throws {
        defer { cleanUp() }
        let archived = try folder("ses_gone", in: sessions, session: "ses_gone", wake: "Follow up")
        try write(archived.appending(path: "paused"), "archived")
        let paused = try folder("ses_left", in: sessions, session: "ses_left", wake: "Later")
        try write(paused.appending(path: "paused"), "paused")
        let moving = try folder("ses_away", in: sessions, session: "ses_away", wake: "Carry on")
        try write(moving.appending(path: "paused"), "moving")
        try fire()
        #expect(prompts().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: archived.path))
        #expect(!FileManager.default.fileExists(atPath: paused.path))
        #expect(wakes(of: moving).count == 1, "kept for its move")
        let trash = try FileManager.default.contentsOfDirectory(atPath: k.appending(path: "trash").path).map { String($0.prefix(16)) }.sorted()
        #expect(trash == ["wakes-ses_gone-1", "wakes-ses_left-1"], "kept, not lost")
    }

    /// Held as archived, though the session is back (its bringing back never reached this
    /// computer): let go, and its wake-ups go that minute. One paused by you stays.
    @Test func aSessionHeldAsArchivedThoughItsBackIsLetGo() throws {
        defer { cleanUp() }
        let back = try folder("ses_back", in: sessions, session: "ses_back", wake: "Follow up")
        try write(back.appending(path: "paused"), "archived")
        try answer(Self.enginePort, "GET", "api/session/ses_back", #"{"id":"ses_back","metadata":{"kuvo.archived":false}}"#)
        let mine = try folder("ses_mine", in: sessions, session: "ses_mine", wake: "Later")
        try write(mine.appending(path: "paused"), "paused")
        try answer(Self.enginePort, "GET", "api/session/ses_mine", #"{"id":"ses_mine"}"#)
        try fire()
        #expect(prompts() == ["\(Self.enginePort) ses_back [Wake-up] Follow up"])
        #expect(wakes(of: mine).count == 1, "paused by you")
    }

    /// An archived session's agent schedules a wake-up or a watch with no app open (its own
    /// kuvo-wake, or the box's tools running it): the folder they're kept in is held as archiving
    /// holds one, as the Mac's app makes it, and it waits until the session is back. A coding
    /// agent's session is asked of the agents' bridge. One that isn't archived isn't held. Its box
    /// is found beside the wakes folder, a machine's (`run`) or this Mac's (`box/run`), however the
    /// agent's environment names the bots' folder (the Mac's coding agents aren't told it).
    @Test(arguments: WakesTests.shells, ["run", "box/run"])
    func oneMadeForAnArchivedSessionIsHeldFromTheStart(_ shell: String, records: String) throws {
        defer { cleanUp() }
        let engine = #"{"pid":1,"port":\#(Self.enginePort),"password":"engine-pass"}"#
        try write(k.appending(path: "\(records)/engine.json"), engine)
        try write(k.appending(path: "\(records)/bridge.json"), #"{"pid":2,"port":\#(Self.bridgePort),"password":"bridge-pass"}"#)
        // This Mac's: a machine's record (for the minute's run, below) answers nothing meanwhile.
        if records != "run" { try write(k.appending(path: "run/engine.json"), #"{"pid":1,"port":9,"password":"elsewhere"}"#) }
        try answer(Self.enginePort, "GET", "api/session/ses_old", #"{"id":"ses_old","metadata":{"kuvo.archived":true}}"#)
        try answer(Self.bridgePort, "GET", "api/session/ses_agent", #"{"id":"ses_agent","time":{"created":1,"archived":1760000000000}}"#)
        try answer(Self.enginePort, "GET", "api/session/ses_new", #"{"id":"ses_new","metadata":{}}"#)
        let wake = #"KUVO_WAKES="$K/wakes" \#(shell) "$K/bin/kuvo-wake""#
        let added = try sh(#"\#(wake) ses_old add +2h "Look again""#)
        #expect(added.status == 0, "\(added.output)")
        let watched = try sh(#"KUVO_WAKE_VIA=bridge \#(wake) ses_agent watch 10m "echo same" "Tell the user""#)
        #expect(watched.status == 0, "\(watched.output)")
        let fresh = try sh(#"\#(wake) ses_new add +2h "Look again""#)
        #expect(fresh.status == 0, "\(fresh.output)")

        let held = { (session: String) in try? String(contentsOf: sessions.appending(path: "\(session)/paused"), encoding: .utf8) }
        #expect(held("ses_old") == "archived", "\(shell), \(records)")
        #expect(held("ses_agent") == "archived", "\(shell), \(records): asked of the bridge")
        #expect(held("ses_new") == nil, "\(shell), \(records): not archived")
        #expect(wakes(of: sessions.appending(path: "ses_old")).count == 1, "kept for when it's back")

        // Brought back (somewhere this box didn't hear of): let go, its wake-up waiting for its time.
        try write(k.appending(path: "run/engine.json"), engine)
        try answer(Self.enginePort, "GET", "api/session/ses_old", #"{"id":"ses_old","metadata":{"kuvo.archived":false}}"#)
        try fire(shell: shell)
        watchesDone()
        #expect(held("ses_old") == nil, "\(shell), \(records)")
        #expect(wakes(of: sessions.appending(path: "ses_old")).count == 1)
        #expect(prompts().isEmpty, "not due yet")
    }

    /// A subagent's, paused: it stays as it is, rather than going to the conversation that
    /// started it and being sent there.
    @Test func aPausedSubagentsWakeUpsStayPut() throws {
        defer { cleanUp() }
        let child = try folder("ses_child", in: sessions, session: "ses_child", wake: "Report back")
        try write(child.appending(path: "paused"), "paused")
        try answer(Self.enginePort, "GET", "api/session/ses_child", #"{"id":"ses_child","parentID":"ses_parent"}"#)
        try answer(Self.enginePort, "GET", "api/session/ses_parent", #"{"id":"ses_parent"}"#)
        try fire()
        try fire()
        #expect(prompts().isEmpty)
        #expect(wakes(of: child).count == 1)
        #expect(!FileManager.default.fileExists(atPath: sessions.appending(path: "ses_parent").path))
    }

    @Test func aSessionTheBridgeHasIsWokenThereFromNowOn() throws {
        defer { cleanUp() }
        try write(k.appending(path: "run/bridge.json"), #"{"pid":2,"port":\#(Self.bridgePort),"password":"bridge-pass"}"#)
        let moved = try folder("ses_moved", in: sessions, session: "ses_moved", wake: "Carry on")
        // Moved to the coding agents since: the engine doesn't have it, the bridge does.
        try answer(Self.enginePort, "GET", "api/session/ses_moved", "{}", code: 404)
        try answer(Self.bridgePort, "GET", "api/session/ses_moved", #"{"id":"ses_moved"}"#)
        try fire()
        #expect(prompts() == ["\(Self.bridgePort) ses_moved [Wake-up] Carry on"])
        #expect(try String(contentsOf: moved.appending(path: "via"), encoding: .utf8) == "bridge")
    }

    /// Taken for a coding agent's when it was made (neither answered just then), but the engine's:
    /// woken there, not thrown away for the bridge not having it.
    @Test func aSessionTheEngineHasIsWokenThereThoughItsFolderSaidTheBridge() throws {
        defer { cleanUp() }
        try write(k.appending(path: "run/bridge.json"), #"{"pid":2,"port":\#(Self.bridgePort),"password":"bridge-pass"}"#)
        let mine = try folder("ses_mine", in: sessions, session: "ses_mine", wake: "Carry on")
        try write(mine.appending(path: "via"), "bridge")
        try answer(Self.bridgePort, "GET", "api/session/ses_mine", "{}", code: 404)
        try answer(Self.enginePort, "GET", "api/session/ses_mine", #"{"id":"ses_mine"}"#)
        try fire()
        #expect(prompts() == ["\(Self.enginePort) ses_mine [Wake-up] Carry on"])
        #expect(!FileManager.default.fileExists(atPath: mine.appending(path: "via").path))
    }

    @Test func aSubagentsWakeUpsGoToTheConversationThatStartedIt() throws {
        defer { cleanUp() }
        let child = try folder("ses_child", in: sessions, session: "ses_child", wake: "Report back")
        try answer(Self.enginePort, "GET", "api/session/ses_child", #"{"id":"ses_child","parentID":"ses_parent","location":{"directory":"/home/me/app"}}"#)
        try answer(Self.enginePort, "GET", "api/session/ses_parent", #"{"id":"ses_parent","location":{"directory":"/home/me/app"}}"#)
        try fire()
        #expect(!FileManager.default.fileExists(atPath: child.path))
        let parent = sessions.appending(path: "ses_parent")
        #expect(try String(contentsOf: parent.appending(path: "session"), encoding: .utf8) == "ses_parent")
        #expect(wakes(of: parent).count + prompts().count >= 1, "its wake-up went along")
        // The next minute it's the parent's, and sent there.
        try fire()
        #expect(prompts() == ["\(Self.enginePort) ses_parent [Wake-up] Report back"])
    }
}
