import Foundation
import Testing
@testable import OpenCodeKit

/// The `kuvo-wake` command, run with this Mac's sh, as a bot runs it.
struct WakesTests {
    /// This Mac's sh, and dash, a Linux machine's sh, where it's here too.
    static let shells = ["/bin/sh", "/bin/dash"].filter { FileManager.default.isExecutableFile(atPath: $0) }

    /// Runs `script` with sh in a fresh folder, as `$K` for `installScript`, and returns its output.
    private func sh(_ script: String, in folder: URL, shell: String = "/bin/sh") throws -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(filePath: shell)
        process.arguments = ["-c", script]
        process.currentDirectoryURL = folder
        process.environment = ["PATH": "/usr/bin:/bin", "K": folder.path]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))
    }

    private func folder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "wakes-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    @Test func installsAndSchedulesListsAndCancels() throws {
        let k = try folder()
        defer { try? FileManager.default.removeItem(at: k) }
        #expect(try sh(Wakes.installScript, in: k).status == 0)
        let wake = k.appending(path: "bin/kuvo-wake").path
        let bot = k.appending(path: "bots/bot_test")
        try FileManager.default.createDirectory(at: bot, withIntermediateDirectories: true)

        let added = try sh("\"\(wake)\" \"\(bot.path)\" add +2h 'check whether CI passed'", in: k)
        #expect(added.status == 0)
        #expect(added.output.hasPrefix("Scheduled "))
        let files = try FileManager.default.contentsOfDirectory(atPath: bot.appending(path: "wakes").path)
        #expect(files.count == 1)
        let pending = try #require(Wakes.Pending(id: files[0], note: "check whether CI passed"))
        #expect(abs(pending.due.timeIntervalSinceNow - 7200) < 60)

        #expect(try sh("\"\(wake)\" \"\(bot.path)\" list", in: k).output.contains("check whether CI passed"))
        #expect(try sh("\"\(wake)\" \"\(bot.path)\" add 2001-01-01T09:00 'too late'", in: k).status != 0)
        #expect(try sh("\"\(wake)\" \"\(bot.path)\" add soon 'unreadable'", in: k).status != 0)
        #expect(try sh("\"\(wake)\" \"\(bot.path)\" add +1d", in: k).status != 0)

        #expect(try sh("\"\(wake)\" \"\(bot.path)\" cancel \(files[0])", in: k).status == 0)
        #expect(try sh("\"\(wake)\" \"\(bot.path)\" list", in: k).output.contains("No wake-ups"))
    }

    /// A summary for the card, kept by the wake-up's letters (a watch's in its folder), on one line,
    /// and gone with it; the note stays whole.
    @Test(arguments: WakesTests.shells)
    func keepsASummaryForTheCard(shell: String) throws {
        let k = try folder()
        defer { try? FileManager.default.removeItem(at: k) }
        #expect(try sh(Wakes.installScript, in: k).status == 0)
        let bot = k.appending(path: "bots/bot_test")
        try FileManager.default.createDirectory(at: bot, withIntermediateDirectories: true)
        let run = { (command: String) in try self.sh("\(shell) \"$K/bin/kuvo-wake\" \"\(bot.path)\" \(command)", in: k) }
        let read = { (path: String) in try? String(contentsOf: bot.appending(path: path), encoding: .utf8) }

        #expect(try run("add +2h --every 1d --summary 'Check CI\nand the deploy' 'Look at the last run. If it failed, read the log and tell the user.'").status == 0)
        let name = try #require(try FileManager.default.contentsOfDirectory(atPath: bot.appending(path: "wakes").path).first)
        let wake = try #require(Wakes.Pending(id: name, note: ""))
        #expect(wake.every == .days(1))
        #expect(read("wakes/\(name)") == "Look at the last run. If it failed, read the log and tell the user.")
        #expect(read("summaries/\(wake.letters)") == "Check CI and the deploy")
        #expect(try run("cancel \(wake.letters)").status == 0)
        #expect(read("summaries/\(wake.letters)") == nil, "it goes with its wake-up")

        let long = String(repeating: "a", count: 301)
        #expect(try run("add +2h --summary '\(long)' 'note'").status == 2)
        #expect(try run("add +2h 'Without one'").status == 0)
        #expect(try FileManager.default.contentsOfDirectory(atPath: bot.appending(path: "summaries").path).isEmpty)

        #expect(try run("watch 10m 'cat state.txt' --summary 'CI finished' 'Tell the user how CI went'").status == 0)
        let letters = try #require(try FileManager.default.contentsOfDirectory(atPath: bot.appending(path: "watches").path).first)
        #expect(read("watches/\(letters)/summary") == "CI finished")
        #expect(read("watches/\(letters)/note") == "Tell the user how CI went")
    }

    @Test func readsTheCommandsABotRuns() {
        let add = Wakes.command(in: #"kuvo-wake bot_abc add +2h "check whether CI passed""#)
        #expect(add == Wakes.Command(verb: .add, when: "+2h", note: "check whether CI passed"))
        let full = Wakes.command(in: #""/Users/me/Library/Application Support/x/bin/kuvo-wake" bot_abc add 2026-10-16T09:00 'morning report'"#)
        #expect(full?.when == "2026-10-16T09:00")
        #expect(full?.note == "morning report")
        // Its summary is the card's, not the note.
        let summed = Wakes.command(in: #"kuvo-wake add +2h --summary "Check CI" --every 1d "check whether CI passed and tell the user""#)
        #expect(summed == Wakes.Command(verb: .add, when: "+2h", note: "check whether CI passed and tell the user", every: .days(1)))
        #expect(Wakes.command(in: #"kuvo-wake add +2h --summary short 'the note'"#)?.note == "the note")
        #expect(Wakes.command(in: "kuvo-wake bot_abc list")?.verb == .list)
        #expect(Wakes.command(in: "kuvo-wake bot_abc cancel 1792080986-CkytYD")?.verb == .cancel)
        #expect(Wakes.command(in: "npm test") == nil)
    }

    @Test func namesABotByItsID() throws {
        let k = try folder()
        defer { try? FileManager.default.removeItem(at: k) }
        #expect(try sh(Wakes.installScript, in: k).status == 0)
        try FileManager.default.createDirectory(at: k.appending(path: "bots/bot_x"), withIntermediateDirectories: true)
        let added = try sh("KUVO_BOTS=\"$K/bots\" \"$K/bin/kuvo-wake\" bot_x add +1d 'tomorrow'", in: k)
        #expect(added.status == 0)
        #expect(try sh("KUVO_BOTS=\"$K/bots\" \"$K/bin/kuvo-wake\" nobody list", in: k).status != 0)
        // An ID is only letters, digits, _ and -: never the folder above.
        try FileManager.default.createDirectory(at: k.appending(path: "wakes"), withIntermediateDirectories: true)
        for name in ["..", ".", "-x", "bot_x .."] {
            #expect(try sh("KUVO_BOTS=\"$K/bots\" \"$K/bin/kuvo-wake\" '\(name)' add +1d 'up there'", in: k).status != 0, "\(name)")
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: k.appending(path: "wakes").path).isEmpty)
    }

    @Test func cancelsOnlyInTheBotsOwnFolder() throws {
        let k = try folder()
        defer { try? FileManager.default.removeItem(at: k) }
        #expect(try sh(Wakes.installScript, in: k).status == 0)
        let other = k.appending(path: "bots/bot_y")
        for folder in ["bots/bot_x/watches/AbCd12", "bots/bot_x/wakes", "bots/bot_y/watches/Zz9", "bots/bot_y/wakes", "app"] {
            try FileManager.default.createDirectory(at: k.appending(path: folder), withIntermediateDirectories: true)
        }
        try "x".write(to: other.appending(path: "MEMORY.md"), atomically: true, encoding: .utf8)
        try "note".write(to: other.appending(path: "wakes/1792080986-Zz9"), atomically: true, encoding: .utf8)
        let cancel = { (id: String, shell: String) in try self.sh("KUVO_BOTS=\"$K/bots\" \(shell) \"$K/bin/kuvo-wake\" bot_x cancel '\(id)'", in: k) }
        for id in ["../../bot_y", "../../../app", "..", ".", "../bot_y/watches/Zz9", "*", "1-../../bot_y", "1792080986-*", "", "-Zz9", "Zz9/.."] {
            for shell in Self.shells {
                let result = try cancel(id, shell)
                #expect(result.status != 0, "\(id) in \(shell)")
                #expect(!result.output.contains("Canceled"), "\(id) in \(shell)")
            }
        }
        #expect(FileManager.default.fileExists(atPath: other.appending(path: "MEMORY.md").path))
        #expect(FileManager.default.fileExists(atPath: other.appending(path: "watches/Zz9").path))
        #expect(FileManager.default.fileExists(atPath: other.appending(path: "wakes/1792080986-Zz9").path))
        #expect(FileManager.default.fileExists(atPath: k.appending(path: "app").path))
        // Its own, by its letters, still goes.
        #expect(try cancel("AbCd12", "/bin/sh").status == 0)
        #expect(!FileManager.default.fileExists(atPath: k.appending(path: "bots/bot_x/watches/AbCd12").path))
    }

    @Test func schedulesOneThatRepeats() throws {
        let k = try folder()
        defer { try? FileManager.default.removeItem(at: k) }
        #expect(try sh(Wakes.installScript, in: k).status == 0)
        let wake = k.appending(path: "bin/kuvo-wake").path
        let bot = k.appending(path: "bots/bot_test")
        try FileManager.default.createDirectory(at: bot, withIntermediateDirectories: true)

        let added = try sh("\"\(wake)\" \"\(bot.path)\" add +1h --every 1d 'morning digest'", in: k)
        #expect(added.status == 0)
        #expect(added.output.contains("every 1d"))
        let files = try FileManager.default.contentsOfDirectory(atPath: bot.appending(path: "wakes").path)
        let pending = try #require(Wakes.Pending(id: files[0], note: "morning digest"))
        #expect(pending.every == .days(1))
        #expect(try String(contentsOf: bot.appending(path: "wakes/\(files[0])"), encoding: .utf8) == "morning digest")
        #expect(try sh("\"\(wake)\" \"\(bot.path)\" list", in: k).output.contains("(every 1d)"))
        #expect(try sh("\"\(wake)\" \"\(bot.path)\" add +1h --every 2m 'too often'", in: k).status != 0)
        #expect(try sh("\"\(wake)\" \"\(bot.path)\" add +1h --every often 'unreadable'", in: k).status != 0)

        // On weekdays, from a Saturday: the first one goes on Monday.
        try FileManager.default.removeItem(at: bot.appending(path: "wakes"))
        #expect(try sh("TZ=UTC \"\(wake)\" \"\(bot.path)\" add 2099-01-03T09:00 --every weekdays 'standup'", in: k).status == 0)
        let weekday = try FileManager.default.contentsOfDirectory(atPath: bot.appending(path: "wakes").path)
        let monday = try #require(Wakes.Pending(id: weekday[0], note: ""))
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        #expect(utc.component(.weekday, from: monday.due) == 2)
        #expect(utc.component(.hour, from: monday.due) == 9)
        // It keeps its time of day, for when clocks change.
        #expect(monday.at == 9 * 60)
        #expect(try sh("\"\(wake)\" \"\(bot.path)\" list", in: k).output.contains("(every weekdays)"))

        // Canceled by its letters, which it keeps as its time moves on.
        #expect(try sh("\"\(wake)\" \"\(bot.path)\" cancel \(monday.letters)", in: k).status == 0)
        #expect(try FileManager.default.contentsOfDirectory(atPath: bot.appending(path: "wakes").path).isEmpty)

        // On a machine, the times are in the user's time zone, which the bot's folder names.
        try "America/New_York".write(to: bot.appending(path: "timezone"), atomically: true, encoding: .utf8)
        #expect(try sh("TZ=UTC \"\(wake)\" \"\(bot.path)\" add 2099-01-05T09:00 --every 1d 'in New York'", in: k).status == 0)
        let names = try FileManager.default.contentsOfDirectory(atPath: bot.appending(path: "wakes").path)
        let newYork = try #require(Wakes.Pending(id: names[0], note: ""))
        #expect(utc.component(.hour, from: newYork.due) == 14)
        #expect(newYork.at == 9 * 60)
    }

    @Test(arguments: WakesTests.shells)
    func watchesWakeOnlyWhenTheirCheckChanges(shell: String) throws {
        let k = try folder()
        defer { try? FileManager.default.removeItem(at: k) }
        #expect(try sh(Wakes.installScript, in: k).status == 0)
        let wake = k.appending(path: "bin/kuvo-wake").path
        let bot = k.appending(path: "bots/bot_test")
        try FileManager.default.createDirectory(at: bot, withIntermediateDirectories: true)
        let run = { (command: String) in try self.sh("\(shell) \"\(wake)\" \"\(bot.path)\" \(command)", in: k) }

        #expect(try run("watch 2m 'cat state.txt' 'too often'").status != 0)
        #expect(try run("watch 10m '' 'no check'").status != 0)
        let added = try run("watch 10m 'cat state.txt' 'Tell the user what changed'")
        #expect(added.status == 0)
        let letters = try #require(try FileManager.default.contentsOfDirectory(atPath: bot.appending(path: "watches").path).first)
        #expect(try run("list").output.contains("watch every 10m: cat state.txt"))

        // The first run only notes what it prints; a change wakes the bot once a second look, two
        // minutes later, sees one too, the same output doesn't.
        let due = { try "0".write(to: bot.appending(path: "watches/\(letters)/next"), atomically: true, encoding: .utf8) }
        try "open".write(to: bot.appending(path: "state.txt"), atomically: true, encoding: .utf8)
        #expect(try run("check").output.isEmpty)
        #expect(try run("check").output.isEmpty, "not due again yet")
        try due()
        // A carriage return and a line that looks like kuvo-wake's own don't get in the way.
        try "closed\r\nKUVO-WATCH nope\n\nsecond paragraph".write(to: bot.appending(path: "state.txt"), atomically: true, encoding: .utf8)
        #expect(try run("check").output.isEmpty, "seen once")
        let next = try #require(Int(String(contentsOf: bot.appending(path: "watches/\(letters)/next"), encoding: .utf8)))
        #expect(abs(Double(next) - Date.now.timeIntervalSince1970 - 120) < 30, "looks again in two minutes")
        try due()
        #expect(Wakes.changedWatches(in: try run("check").output) == [letters])
        let message = try #require(Wakes.watchMessage(letters, inBot: bot.path))
        #expect(message.hasPrefix("Tell the user what changed"))
        #expect(message.contains("closed"))
        #expect(message.contains("\n\nsecond paragraph"))

        // Not delivered: the next check tells it again; delivered, it's what the bot heard.
        try due()
        #expect(Wakes.changedWatches(in: try run("check").output) == [letters])
        Wakes.watchDelivered(letters, inBot: bot.path)
        #expect(Wakes.watchMessage(letters, inBot: bot.path) == nil)
        try due()
        #expect(try run("check").output.isEmpty)

        // A hiccup (a page that didn't load, say) for one run, then as before: no wake-up.
        let watch = bot.appending(path: "watches/\(letters)")
        let last = try String(contentsOf: watch.appending(path: "last"), encoding: .utf8)
        try "".write(to: bot.appending(path: "state.txt"), atomically: true, encoding: .utf8)
        try due()
        #expect(try run("check").output.isEmpty)
        try "closed\r\nKUVO-WATCH nope\n\nsecond paragraph".write(to: bot.appending(path: "state.txt"), atomically: true, encoding: .utf8)
        try due()
        #expect(try run("check").output.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: watch.appending(path: "seen").path))

        // A check that ran out of time, or couldn't run, is as if it hadn't run: what the bot
        // heard stays, however often it happens.
        for failing in ["echo 'curl: timed out'; exit 124", "nosuchcommand-kuvo"] {
            try failing.write(to: watch.appending(path: "check"), atomically: true, encoding: .utf8)
            for _ in 0..<2 {
                try due()
                #expect(try run("check").output.isEmpty, "\(failing)")
            }
            #expect(try String(contentsOf: watch.appending(path: "last"), encoding: .utf8) == last)
            #expect(!FileManager.default.fileExists(atPath: watch.appending(path: "seen").path))
            #expect(!FileManager.default.fileExists(atPath: watch.appending(path: "run-status").path))
            #expect(!FileManager.default.fileExists(atPath: watch.appending(path: "run-failed").path))
        }
        try "cat state.txt".write(to: watch.appending(path: "check"), atomically: true, encoding: .utf8)

        let command = Wakes.command(in: #"kuvo-wake bot_abc watch 30m "curl -s https://example.com | grep -i outage" "Tell me about it""#)
        #expect(command == Wakes.Command(verb: .watch, when: "30m", note: "Tell me about it"))

        #expect(try run("cancel \(letters)").status == 0)
        #expect(try FileManager.default.contentsOfDirectory(atPath: bot.appending(path: "watches").path).isEmpty)
    }

    /// A watch's runs, each at its next time on a clock of the test's own, with what its check prints
    /// and how it exits: a value that moves wakes the bot once a period, one that changes and stays
    /// wakes it once, and runs that fail, are killed or read once oddly never wake it nor become
    /// what it compares with. Through `timeout` (as on Linux) and without it (perl, on a Mac).
    @Test(arguments: WakesTests.shells, [false, true])
    func watchesWakeForChangesNotFailures(shell: String, gnuTimeout: Bool) throws {
        let k = try folder()
        defer { try? FileManager.default.removeItem(at: k) }
        #expect(try sh(Wakes.installScript, in: k).status == 0)
        let fm = FileManager.default
        let bin = k.appending(path: "testbin")
        try fm.createDirectory(at: bin, withIntermediateDirectories: true)
        func write(_ text: String, _ file: URL) throws { try text.write(to: file, atomically: true, encoding: .utf8) }
        func read(_ file: URL) -> String? { try? String(contentsOf: file, encoding: .utf8) }
        func executable(_ name: String, _ text: String) throws {
            try write(text, bin.appending(path: name))
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bin.appending(path: name).path)
        }
        try executable("date", "#!/bin/sh\nif [ \"$1\" = +%s ]; then cat \"$K/clock\"; else exec /bin/date \"$@\"; fi\n")
        // As GNU's takes them: its options (-k 5, -s KILL), then the time, then the command.
        if gnuTimeout { try executable("timeout", "#!/bin/sh\nwhile [ \"$1\" = -k ] || [ \"$1\" = -s ]; do shift 2; done\nshift\nexec \"$@\"\n") }
        // A curl that prints what it's given and exits with it: with the network down, `curl -s`
        // prints nothing and exits 6 or 7, or prints 000 when asked for its status code.
        try executable("curl", "#!/bin/sh\ncat \"$K/out\"\nexit \"$(cat \"$K/code\")\"\n")
        let bot = k.appending(path: "bots/bot_test")
        let watch = bot.appending(path: "watches/AbCd12")
        try fm.createDirectory(at: watch, withIntermediateDirectories: true)
        let reads = #"cat "$K/out"; exit "$(cat "$K/code")""#
        try write("10m", watch.appending(path: "every"))
        try write(reads, watch.appending(path: "check"))
        try write("Look", watch.appending(path: "note"))

        var clock = 1_800_000_000
        var woke: [(time: Int, message: String)] = []
        /// Runs the watch at its next time, printing `output` and exiting with `code`; true if it woke the bot.
        func step(_ output: String, _ code: Int = 0, deliver: Bool = true) throws -> Bool {
            clock = max(clock, Int(read(watch.appending(path: "next")) ?? "") ?? 0)
            try write(String(clock), k.appending(path: "clock"))
            try write(output, k.appending(path: "out"))
            try write(String(code), k.appending(path: "code"))
            let process = Process()
            process.executableURL = URL(filePath: shell)
            process.arguments = [k.appending(path: "bin/kuvo-wake").path, bot.path, "check"]
            process.environment = ["PATH": bin.path + ":/usr/bin:/bin", "K": k.path]
            let pipe = Pipe()
            process.standardOutput = pipe
            try process.run()
            process.waitUntilExit()
            let printed = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            guard Wakes.changedWatches(in: printed) == ["AbCd12"] else { return false }
            woke.append((clock, Wakes.watchMessage("AbCd12", inBot: bot.path) ?? ""))
            if deliver { Wakes.watchDelivered("AbCd12", inBot: bot.path) }
            return true
        }
        func reset() throws {
            for file in ["last", "seen", "pending", "message"] { try? fm.removeItem(at: watch.appending(path: file)) }
            try write("0", watch.appending(path: "next"))
            woke = []
        }
        let label = "\(shell)\(gnuTimeout ? ", timeout" : "")"

        // A moving value: the first reading is where it starts; then each period, a change and a
        // second look two minutes later that sees another, which wakes the bot with it.
        try reset()
        for (value, wakes) in [("1", false), ("2", false), ("3", true), ("4", false), ("5", true), ("6", false), ("7", true)] {
            #expect(try step(value) == wakes, "\(value), \(label)")
        }
        #expect(woke.map { $0.time - woke[0].time } == [0, 600, 1200], "\(label)")
        #expect(woke.last?.message.contains("now prints:\n7") == true, "\(label)")

        // A change that stays wakes it once.
        try reset()
        #expect(try ["A", "B", "B", "B", "B"].map { try step($0) } == [false, false, true, false, false], "\(label)")

        // One odd reading between two as before: nothing.
        try reset()
        #expect(try ["A", "X", "A", "A"].map { try step($0) } == [false, false, false, false], "\(label)")
        #expect(!fm.fileExists(atPath: watch.appending(path: "seen").path), "\(label)")

        // An outage longer than the second look: a check failing quietly (6, 7, as curl -s does).
        try reset()
        #expect(try step("A") == false)
        let heard = read(watch.appending(path: "last"))
        for code in [6, 7, 2, 6] { #expect(try step("", code) == false, "\(code), \(label)") }
        #expect(try step("A") == false, "\(label)")
        #expect(try step("A") == false, "\(label)")
        #expect(woke.isEmpty, "\(label)")
        #expect(read(watch.appending(path: "last")) == heard, "\(label)")

        // Something appearing and going away: grep finding nothing (1, nothing printed) is a
        // reading, while curl failing before it (grep's 1 too), or before sed or jq (0), isn't.
        try write("curl -s https://example.com/shop | grep -o 'In stock'", watch.appending(path: "check"))
        try reset()
        let soldOut = ("<b>Sold out</b>", 0), inStock = ("<b>In stock</b>", 0), down = ("", 7)
        let flips = [soldOut, soldOut, down, down, soldOut, inStock, inStock, down, inStock, soldOut, soldOut, soldOut]
        #expect(try flips.map { try step($0.0, $0.1) } == [false, false, false, false, false, false, true, false, false, false, true, false], "\(label)")
        #expect(woke.map { $0.message.contains("now prints:\nIn stock") } == [true, false], "\(label)")
        #expect(woke.last?.message.contains("now prints nothing.") == true, "\(label)")
        // Down from its very first run: no first reading until it's back.
        try reset()
        #expect(try [down, down, soldOut, inStock, inStock].map { try step($0.0, $0.1) } == [false, false, false, false, true], "\(label)")
        for check in ["curl -s https://example.com/api | sed -n 's/.*\"price\":\\([0-9]*\\).*/\\1/p'", "echo \"$(curl -s https://example.com/api)\" | grep -c 42"] {
            try write(check, watch.appending(path: "check"))
            try reset()
            let price = (#"{"price":42}"#, 0)
            #expect(try [price, down, down, down, price].map { try step($0.0, $0.1) } == [false, false, false, false, false], "\(check), \(label)")
            #expect(read(watch.appending(path: "last")) != nil, "\(label)")
        }
        // A curl that writes out its own result counts whatever happens: a site's status code,
        // 000 when it can't be reached.
        for check in ["curl -s -o /dev/null -w '%{http_code}' https://example.com", "curl -so /dev/null -w%{http_code} https://example.com"] {
            try write(check, watch.appending(path: "check"))
            try reset()
            #expect(try [("200", 0), ("000", 7), ("000", 7), ("200", 0), ("200", 0)].map { try step($0.0, $0.1) } == [false, false, true, false, true], "\(check), \(label)")
        }
        try write(reads, watch.appending(path: "check"))

        // A change seen, then no reading for its second look: the next reading that differs too wakes it.
        try reset()
        #expect(try step("A") == false)
        #expect(try step("B") == false)
        #expect(try step("", 7) == false, "\(label)")
        #expect(try step("B") == true, "\(label)")
        #expect(try step("B") == false, "\(label)")

        // A failing check prints something: that's a reading (grep -c finding none prints 0, exits 1).
        try reset()
        #expect(try ["3", "0", "0", "0"].map { try step($0, $0 == "0" ? 1 : 0) } == [false, false, true, false], "\(label)")

        // Not delivered: told again at the next run, without another look; delivered, it's heard.
        try reset()
        #expect(try step("A") == false)
        #expect(try step("B") == false)
        #expect(try step("B", deliver: false) == true, "\(label)")
        #expect(try step("B") == true, "\(label)")
        #expect(try step("B") == false, "\(label)")

        // No reading never becomes the first one: a check that fails, or is killed (on a Mac, its
        // status was the one of a check that worked).
        try reset()
        #expect(try step("", 2) == false)
        #expect(read(watch.appending(path: "last")) == nil, "\(label)")
        try write("printf partial; kill -9 $$", watch.appending(path: "check"))
        #expect(try step("") == false)
        #expect(read(watch.appending(path: "last")) == nil, "killed, \(label)")
        try write(reads, watch.appending(path: "check"))
        #expect(try step("A") == false)
        #expect(read(watch.appending(path: "last")) != nil, "\(label)")

        // A second look from an older kuvo-wake (it kept the output's sum) is a first one now.
        try write("123456789 1", watch.appending(path: "seen"))
        #expect(try step("B") == false, "\(label)")
        #expect(try step("B") == true, "\(label)")

        // What an older kuvo-wake read (errors too) gives way to the first reading, silently,
        // with a wake-up it hadn't delivered; from then on, changes wake the bot as before.
        try reset()
        try write("1234567890 12", watch.appending(path: "last"))
        try write("1234567890 13", watch.appending(path: "pending"))
        try write("Look\n\nYour watch saw a change.", watch.appending(path: "message"))
        #expect(try ["B", "B", "C", "C"].map { try step($0) } == [false, false, false, true], "\(label)")
        #expect(read(watch.appending(path: "last"))?.hasPrefix("2/") == true, "\(label)")
    }

    /// Check Now: `kuvo-wake <bot> try <letters>` runs a watch's check as its runs do and says why
    /// a run like it wouldn't count, without counting it.
    @Test(arguments: WakesTests.shells)
    func checkNowRunsTheCheckAsTheWatchDoes(shell: String) throws {
        let k = try folder()
        defer { try? FileManager.default.removeItem(at: k) }
        #expect(try sh(Wakes.installScript, in: k).status == 0)
        let fm = FileManager.default
        let bin = k.appending(path: "testbin")
        try fm.createDirectory(at: bin, withIntermediateDirectories: true)
        try "#!/bin/sh\ncat \"$K/out\"\nexit \"$(cat \"$K/code\")\"\n".write(to: bin.appending(path: "curl"), atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bin.appending(path: "curl").path)
        let bot = k.appending(path: "bots/bot_test")
        let watch = bot.appending(path: "watches/AbCd12")
        try fm.createDirectory(at: watch, withIntermediateDirectories: true)
        try "10m".write(to: watch.appending(path: "every"), atomically: true, encoding: .utf8)
        try "Look".write(to: watch.appending(path: "note"), atomically: true, encoding: .utf8)
        try "0".write(to: watch.appending(path: "next"), atomically: true, encoding: .utf8)
        func tried(_ check: String, page: String = "", code: Int = 0, letters: String = "AbCd12") throws -> (status: Int32, output: String) {
            try check.write(to: watch.appending(path: "check"), atomically: true, encoding: .utf8)
            try page.write(to: k.appending(path: "out"), atomically: true, encoding: .utf8)
            try String(code).write(to: k.appending(path: "code"), atomically: true, encoding: .utf8)
            return try sh("PATH=\"$K/testbin:$PATH\" \(shell) \"$K/bin/kuvo-wake\" \"$K/bots/bot_test\" try '\(letters)'", in: k)
        }
        let shop = "curl -s https://example.com/shop | grep -o 'In stock'"
        #expect(Wakes.tried(try tried(shop, page: "In stock").output)! == ("In stock", nil), "\(shell)")
        // Nothing found counts; the network down doesn't, and says so.
        #expect(Wakes.tried(try tried(shop, page: "Sold out").output)! == ("", nil), "\(shell)")
        #expect(Wakes.tried(try tried(shop, code: 6).output)?.skipped == "curl failed (exit 6)", "\(shell)")
        #expect(Wakes.tried(try tried("echo partial >&2; exit 3").output)?.skipped == "the check failed (exit 3) without printing anything", "\(shell)")
        #expect(Wakes.tried(try tried("nosuchcommand-kuvo").output)?.skipped == "the check couldn't run (exit 127)", "\(shell)")
        #expect(Wakes.tried(try tried("printf 'a\\nb'; exit 3").output)! == ("a\nb", nil), "\(shell)")
        // In the folder the bot works in, its errors left out, with no arguments of its own.
        try fm.createDirectory(at: k.appending(path: "project"), withIntermediateDirectories: true)
        try k.appending(path: "project").path.write(to: bot.appending(path: "directory"), atomically: true, encoding: .utf8)
        #expect(Wakes.tried(try tried("echo \"${PWD##*/} $#\"; echo oops >&2").output)! == ("project 0", nil), "\(shell)")
        // With the computer's own folders, as the watchdog on a machine keeps them.
        let own = "KUVO_OWN_XDG_CONFIG_HOME=/home/me/.config KUVO_OWN_XDG_DATA_HOME= XDG_CONFIG_HOME=\"$K/config\" XDG_DATA_HOME=\"$K/data\" "
        try #"printf '%s|%s|%s' "$XDG_CONFIG_HOME" "${XDG_DATA_HOME-unset}" "${KUVO_OWN_XDG_CONFIG_HOME-unset}""#.write(to: watch.appending(path: "check"), atomically: true, encoding: .utf8)
        let folders = try sh(own + "\(shell) \"$K/bin/kuvo-wake\" \"$K/bots/bot_test\" try AbCd12", in: k)
        #expect(Wakes.tried(folders.output)?.output == "/home/me/.config|unset|unset", "\(shell)")
        // It counts nothing, and leaves nothing behind.
        #expect(try fm.contentsOfDirectory(atPath: watch.path).sorted() == ["check", "every", "next", "note"], "\(shell)")
        #expect(try String(contentsOf: watch.appending(path: "next"), encoding: .utf8) == "0")
        for letters in ["", "..", "../AbCd12", "AbCd12/..", "nope"] {
            let result = try tried("echo hi", letters: letters)
            #expect(result.status == 2 && Wakes.tried(result.output) == nil, "\(letters), \(shell)")
        }
        #expect(Wakes.tried("Usage:\n  kuvo-wake <bot> add") == nil)
    }

    /// The script's next time for a repeat (as a wake-up's name has it), from its own functions, at `now`.
    private func scriptNext(_ due: Date, _ every: String, now: Date, zone: String, shell: String = "/bin/sh") throws -> Date {
        let functions = try #require(Wakes.script.components(separatedBy: "if [ \"$1\" = fire ]").first)
        let k = try folder()
        defer { try? FileManager.default.removeItem(at: k) }
        let run = try sh("export TZ=\(zone)\n" + functions + "\nnow=\(Int(now.timeIntervalSince1970))\nnext \(Int(due.timeIntervalSince1970)) \(every)", in: k, shell: shell)
        return Date(timeIntervalSince1970: try #require(TimeInterval(run.output.trimmingCharacters(in: .whitespacesAndNewlines))))
    }

    @Test func aRepeatComesBackAtTheSameTimeOfDay() throws {
        var berlin = Calendar(identifier: .gregorian)
        berlin.timeZone = TimeZone(identifier: "Europe/Berlin")!
        let at = { (day: Int, hour: Int) in berlin.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour))! }
        // Clocks go back on Sunday the 25th: a 9:00 wake-up stays at 9:00.
        let cases: [(due: Date, every: Wakes.Repeat, now: Date, next: Date)] = [
            (at(24, 9), .days(1), at(24, 9).addingTimeInterval(5), at(25, 9)),
            (at(20, 9), .days(1), at(24, 12), at(25, 9)),
            (at(23, 9), .weekdays, at(23, 9).addingTimeInterval(5), at(26, 9)),
            (at(19, 9), .weeks(1), at(19, 10), at(26, 9)),
            (at(24, 9), .hours(2), at(24, 12), at(24, 13)),
            (at(24, 9), .minutes(30), at(24, 9).addingTimeInterval(60), at(24, 9).addingTimeInterval(1800)),
        ]
        for test in cases {
            #expect(test.every.next(after: test.due, now: test.now, calendar: berlin) == test.next, "\(test.every)")
            #expect(try scriptNext(test.due, test.every.text, now: test.now, zone: "Europe/Berlin") == test.next, "\(test.every) in sh")
        }
    }

    @Test func aRepeatKeepsItsTimeOfDayAcrossDaylightSaving() throws {
        var newYork = Calendar(identifier: .gregorian)
        newYork.timeZone = TimeZone(identifier: "America/New_York")!
        let at = { (month: Int, day: Int, hour: Int, minute: Int) in
            newYork.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute))!
        }
        // Clocks go forward on Sunday, March 8 (2:00 is 3:00) and back on Sunday, November 1
        // (2:00 is 1:00 again).
        let cases: [(due: Date, every: Wakes.Repeat, at: Int?, now: Date, next: Date)] = [
            // 2:30 doesn't exist on March 8: 3:30 that day, and 2:30 again the day after.
            (at(3, 7, 2, 30), .days(1), 150, at(3, 7, 2, 31), at(3, 8, 3, 30)),
            (at(3, 8, 3, 30), .days(1), 150, at(3, 8, 3, 31), at(3, 9, 2, 30)),
            (at(3, 6, 2, 30), .weekdays, 150, at(3, 6, 2, 31), at(3, 9, 2, 30)),
            (at(3, 1, 2, 30), .weeks(1), 150, at(3, 1, 2, 31), at(3, 8, 3, 30)),
            (at(3, 8, 9, 0), .days(1), 540, at(3, 8, 9, 1), at(3, 9, 9, 0)),
            // 1:30 comes twice on November 1: the first.
            (at(10, 31, 1, 30), .days(1), 90, at(10, 31, 1, 31), at(11, 1, 1, 30)),
            // Due the day before, sent after clocks went back, before its time: still today's.
            (at(10, 31, 9, 0), .days(1), 540, at(11, 1, 8, 30), at(11, 1, 9, 0)),
            (at(10, 31, 9, 0), .weeks(1), 540, at(11, 7, 8, 30), at(11, 7, 9, 0)),
            (at(10, 30, 9, 0), .weekdays, 540, at(11, 2, 8, 30), at(11, 2, 9, 0)),
            // Several days missed.
            (at(10, 28, 9, 0), .days(1), 540, at(11, 2, 10, 0), at(11, 3, 9, 0)),
        ]
        for test in cases {
            #expect(test.every.next(after: test.due, now: test.now, at: test.at, calendar: newYork) == test.next, "\(test.every) from \(test.due)")
            let text = Wakes.text(of: test.every, at: test.at)
            for shell in Self.shells {
                #expect(try scriptNext(test.due, text, now: test.now, zone: "America/New_York", shell: shell) == test.next, "\(text) from \(test.due) in \(shell)")
            }
        }
        // One made before it kept its time of day: the time it was due at.
        #expect(Wakes.Repeat.days(1).next(after: at(10, 31, 9, 0), now: at(10, 31, 9, 1), calendar: newYork) == at(11, 1, 9, 0))
        #expect(try scriptNext(at(10, 31, 9, 0), "1d", now: at(10, 31, 9, 1), zone: "America/New_York") == at(11, 1, 9, 0))
    }

    @Test func aRepeatKeepsItsTimeOfDayInANewTimeZone() throws {
        var istanbul = Calendar(identifier: .gregorian)
        istanbul.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        var london = Calendar(identifier: .gregorian)
        london.timeZone = TimeZone(identifier: "Europe/London")!
        // Set for 9:00 in Istanbul, then the Mac moves to London: 9:00 there.
        let due = istanbul.date(from: DateComponents(year: 2026, month: 11, day: 10, hour: 9))!
        let wake = try #require(Wakes.Pending(id: Wakes.name(due: due, every: .days(1), calendar: istanbul), note: ""))
        #expect(wake.at == 540)
        let next = london.date(from: DateComponents(year: 2026, month: 11, day: 11, hour: 9))!
        #expect(wake.nextID(after: due.addingTimeInterval(60), calendar: london)?.hasPrefix("\(Int(next.timeIntervalSince1970))-") == true)
        for shell in Self.shells {
            #expect(try scriptNext(due, "1d@0900", now: due.addingTimeInterval(60), zone: "Europe/London", shell: shell) == next, "\(shell)")
        }
    }

    /// A weekly repeat keeps its day of the week as it keeps its time of day: Monday at 10:00 in New
    /// York is Tuesday at midnight in Tokyo, but once the Mac is there, it's Mondays at 10:00 there.
    @Test func aWeeklyRepeatKeepsItsDayInANewTimeZone() throws {
        func calendar(_ zone: String) -> Calendar {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: zone)!
            return calendar
        }
        let newYork = calendar("America/New_York"), tokyo = calendar("Asia/Tokyo")
        let at = { (calendar: Calendar, day: Int, hour: Int) in calendar.date(from: DateComponents(year: 2026, month: 11, day: day, hour: hour))! }
        // From one zone to the other, Mondays (November 16 and 23, 2026) both ways, and every two weeks.
        let cases: [(due: Date, every: Wakes.Repeat, made: Calendar, now: Calendar, zone: String, next: Date)] = [
            (at(newYork, 16, 10), .weeks(1), newYork, tokyo, "Asia/Tokyo", at(tokyo, 23, 10)),
            (at(tokyo, 16, 9), .weeks(1), tokyo, newYork, "America/New_York", at(newYork, 23, 9)),
            (at(newYork, 16, 10), .weeks(2), newYork, tokyo, "Asia/Tokyo", calendar("Asia/Tokyo").date(from: DateComponents(year: 2026, month: 11, day: 30, hour: 10))!),
            (at(newYork, 16, 10), .weeks(1), newYork, newYork, "America/New_York", at(newYork, 23, 10)),
        ]
        for test in cases {
            let wake = try #require(Wakes.Pending(id: Wakes.name(due: test.due, every: test.every, calendar: test.made), note: ""))
            #expect(wake.weekday == 2)
            let next = try #require(wake.nextID(after: test.due.addingTimeInterval(60), calendar: test.now))
            #expect(next.hasPrefix("\(Int(test.next.timeIntervalSince1970))-"), "\(test.zone): \(next)")
            #expect(next.hasSuffix("w@Mon\(test.made == newYork ? "1000" : "0900")"))
            let text = Wakes.text(of: test.every, at: wake.at, weekday: wake.weekday)
            for shell in Self.shells {
                #expect(try scriptNext(test.due, text, now: test.due.addingTimeInterval(60), zone: test.zone, shell: shell) == test.next, "\(text) in \(test.zone), \(shell)")
            }
        }

        // The script names a weekly one with its day, and one from before with the day it was due.
        let functions = try #require(Wakes.script.components(separatedBy: "if [ \"$1\" = fire ]").first)
        let k = try folder()
        defer { try? FileManager.default.removeItem(at: k) }
        let due = Int(at(newYork, 16, 10).timeIntervalSince1970)
        for shell in Self.shells {
            let run = try sh("export TZ=America/New_York\n\(functions)\nkept \(due) 1w; kept \(due) 2w@1000; kept \(due) 1w@Tue1000; kept \(due) 1d; repeats 1w@Mon0900 && echo ok; repeats 1d@Mon0900 || echo no; repeats 1w@Xyz0900 || echo no", in: k, shell: shell)
            #expect(run.output == "1w@Mon1000\n2w@Mon1000\n1w@Tue1000\n1d@1000\nok\nno\nno\n", "\(shell)")
        }
    }

    @Test func readsARepeat() {
        #expect(Wakes.Repeat("30m") == .minutes(30))
        #expect(Wakes.Repeat("1w") == .weeks(1))
        #expect(Wakes.Repeat("weekdays") == .weekdays)
        #expect(Wakes.Repeat("4m") == nil)
        #expect(Wakes.Repeat("-1d") == nil)
        #expect(Wakes.Repeat("d") == nil)
        // At most a year, and no leading zero: one past it made the app crash on every launch.
        #expect(Wakes.Repeat("525600m") == .minutes(525_600))
        #expect(Wakes.Repeat("8760h") == .hours(8760))
        #expect(Wakes.Repeat("3000000000000000h") == nil)
        #expect(Wakes.Repeat("367d") == nil)
        #expect(Wakes.Repeat("53w") == nil)
        #expect(Wakes.Repeat("08m") == nil)
        #expect(Wakes.Pending(id: "1792080986-CkytYD-3000000000000000h", note: "")?.every == nil)
        let wake = Wakes.Pending(id: "1792080986-CkytYD-1d", note: "hi")
        #expect(wake?.every == .days(1))
        #expect(wake?.at == nil)
        #expect(wake?.nextID()?.contains("-CkytYD-1d@") == true, "keeps its time of day from then on")
        #expect(wake?.letters == "CkytYD")
        let kept = Wakes.Pending(id: "1792080986-CkytYD-weekdays@0230", note: "hi")
        #expect(kept?.every == .weekdays)
        #expect(kept?.at == 150)
        #expect(kept?.nextID()?.hasSuffix("-CkytYD-weekdays@0230") == true)
        #expect(kept?.letters == "CkytYD")
        #expect(Wakes.Pending(id: "1792080986-CkytYD-1d@2460", note: "")?.at == nil)
        let weekly = Wakes.Pending(id: "1792080986-CkytYD-2w@Mon0930", note: "hi")
        #expect(weekly?.every == .weeks(2))
        #expect(weekly?.at == 570)
        #expect(weekly?.weekday == 2)
        #expect(weekly?.nextID()?.hasSuffix("-CkytYD-2w@Mon0930") == true)
        #expect(Wakes.Pending(id: "1792080986-CkytYD-1w@Xyz0930", note: "")?.at == nil)
        #expect(Wakes.Pending(id: "1792080986-CkytYD-1w", note: "")?.nextID()?.contains("-CkytYD-1w@") == true)
        #expect(Wakes.Pending(id: "1792080986-CkytYD-2h", note: "")?.nextID()?.hasSuffix("-CkytYD-2h") == true)
        #expect(Wakes.Pending(id: "1792080986-CkytYD", note: "hi")?.nextID() == nil)
        let command = Wakes.command(in: #"kuvo-wake bot_abc add 2026-10-17T09:00 --every weekdays "standup""#)
        #expect(command == Wakes.Command(verb: .add, when: "2026-10-17T09:00", note: "standup", every: .weekdays))
    }

    /// Weekdays are Monday to Friday whatever the locale calls the weekend, as on a machine.
    @Test func weekdaysAreMondayToFriday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Jerusalem")!
        calendar.locale = Locale(identifier: "he_IL")
        let friday = Date(timeIntervalSince1970: 4_070_995_200)  // Fri, Jan 2, 2099, 00:00 UTC
        #expect(!Wakes.isWeekend(friday.addingTimeInterval(12 * 3600), calendar: calendar))
        #expect(Wakes.isWeekend(friday.addingTimeInterval(36 * 3600), calendar: calendar))
        #expect(Wakes.isWeekend(friday.addingTimeInterval(60 * 3600), calendar: calendar))
    }

    /// The script takes a repeat within the same limits, and a time with its zone on any sh.
    @Test func theScriptKeepsRepeatsAndTimesInBounds() throws {
        for shell in Self.shells {
            let k = try folder()
            defer { try? FileManager.default.removeItem(at: k) }
            #expect(try sh(Wakes.installScript, in: k).status == 0)
            let wake = k.appending(path: "bin/kuvo-wake").path
            let bot = k.appending(path: "bots/bot_test")
            try FileManager.default.createDirectory(at: bot, withIntermediateDirectories: true)
            for bad in ["3000000000000000h", "08m", "367d", "53w"] {
                #expect(try sh("\"\(wake)\" \"\(bot.path)\" add +1h --every \(bad) 'x'", in: k, shell: shell).status != 0, "\(shell) \(bad)")
            }
            #expect(try sh("\"\(wake)\" \"\(bot.path)\" add +99999999h 'too far'", in: k, shell: shell).status != 0)
            // A leading zero isn't read as octal: 010 isn't eight.
            for bad in ["+08h", "+010m"] {
                let added = try sh("\"\(wake)\" \"\(bot.path)\" add \(bad) 'x'", in: k, shell: shell)
                #expect(added.status != 0 && added.output.hasPrefix("Couldn't read the time"), "\(shell) \(bad): \(added.output)")
            }
            #expect(try sh("\"\(wake)\" \"\(bot.path)\" watch 010m 'cat x' 'x'", in: k, shell: shell).status != 0, "\(shell)")
            // The same moment, written in UTC and in another zone, is one time.
            try? FileManager.default.removeItem(at: bot.appending(path: "wakes"))
            #expect(try sh("TZ=America/New_York \"\(wake)\" \"\(bot.path)\" add 2099-01-05T06:00:00Z 'utc'", in: k, shell: shell).status == 0)
            #expect(try sh("TZ=America/New_York \"\(wake)\" \"\(bot.path)\" add 2099-01-05T09:00:00+03:00 'offset'", in: k, shell: shell).status == 0)
            let times = Set(try FileManager.default.contentsOfDirectory(atPath: bot.appending(path: "wakes").path).compactMap { Wakes.Pending(id: $0, note: "")?.due })
            #expect(times == [Date(timeIntervalSince1970: 4_071_276_000)], "\(shell): \(times)")
        }
    }

    @Test func aWakeUpsTimeComesFromItsName() {
        let wake = Wakes.Pending(id: "1792080986-CkytYD", note: "hi")
        #expect(wake?.due == Date(timeIntervalSince1970: 1_792_080_986))
        #expect(Wakes.Pending(id: "notes.txt", note: "") == nil)
    }

    /// The machine's keeper sends them each minute (RebootTests runs it); the launch puts
    /// `kuvo-wake` there.
    @Test func theKeeperSendsWakeUps() {
        #expect(RemoteServer.bootScript.contains("kuvo-wake\" fire"))
        #expect(RemoteServer.launchScript.contains("KUVO_WAKE"))
    }
}
