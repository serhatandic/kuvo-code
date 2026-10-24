import CryptoKit
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The rules a group chat goes by, as a group chat that lives on a machine goes by them too: the
/// agents bridge's `Agents/src/groups/rules.ts`, which its tests check against what these say
/// (`Agents/test/groups-vectors.json`). `scripts/group-vectors.sh` writes that file from here and
/// records its hash below, so a change to the rules here fails this test until it's run, and the
/// bridge's tests then say whether the machine's rules still match.
@MainActor
struct GroupRulesVectorsTests {
    static let recorded = "af23556ea64fb0ee654a65bbf28fdcb93ff0f8ad4885b4b2670fc95cc0a7aeaa"

    @Test func theMachinesChatsGoByTheseRules() throws {
        let data = try JSONSerialization.data(withJSONObject: Self.vectors(), options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes])
        if let path = ProcessInfo.processInfo.environment["KUVO_WRITE_GROUP_VECTORS"] {
            try data.write(to: URL(filePath: path))
            return
        }
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        #expect(hash == Self.recorded, "The group chat rules changed: run scripts/group-vectors.sh, then the bridge's tests (cd Agents && bun test).")
    }

    // MARK: The cases

    static func vectors() throws -> [String: Any] {
        [
            "isPass": passes.map { ["text": $0, "pass": BotGroups.isPass($0)] },
            "parts": partsCases.map { text, names in
                let (parts, go) = GroupWork.parts(in: text, names: names)
                return ["text": text, "names": names, "go": go, "parts": parts.map { ["name": $0.name, "task": $0.task, "after": $0.after] }]
            },
            "ring": ringCases(),
            "compose": composeCases(),
            "splitText": splitCases.map { names, said in
                ["names": names, "said": said, "text": BotGroups.splitText(members: names.map { bot("bot_\($0)", name: $0) }, said: said)]
            },
            "turnText": try turnCases(),
            "freshText": try freshCases(),
            "guests": try guestCases(),
            "ampersands": ampersandCases.map { text, names in ["text": text, "names": names, "shown": BotGroups.ampersands(in: text, names: names)] },
            "chatBudget": try chatBudgetCases(),
            "outgrew": outgrowCases.map { size, chat in ["size": size, "chat": chat, "outgrew": BotGroups.outgrew(size, chat: chat)] },
            "nextSpeaker": try speakerCases(),
            "mentions": mentionCases.map { text, names in
                ["text": text, "names": names, "ids": BotGroups.mentions(in: text, among: names.map { ("bot_" + $0, $0) })]
            },
            "said": try saidCases(),
            "seatInstructions": try seatCases(),
            "seatRules": try ruleCases(),
            "job": memories.map { text in
                let job = Bots.job(inMemory: text)
                return ["memory": text, "line": job?.line ?? NSNull(), "section": job?.section ?? NSNull()] as [String: Any]
            },
            "next": repeatCases(),
            "planMeeting": planCases(),
        ]
    }

    static let passes = [
        "PASS", "Pass.", "pass", "[pass] nothing to add", "PASS — nothing new", "pass, nothing new from me", "Pass rate is 98% on main.",
        "Passing the build to Ada", "I'll pass", "  PASS  ", "**PASS**", "pass: no new info", "Pass - skip", "Pass. I have nothing",
        "pass n/a", "PASSED the tests", "Şimdilik pass", "PASS " + String(repeating: "x", count: 90), "pass 😀", "PASS\nnothing",
        "pass\n\nI have nothing to add", "Pass: I've nothing", "pass — no comment", "pass — no new points", "PASSİ", "pass🙂",
        "_pass_", "pass_through", "Pass… nothing further", "PASS. Ada covered it.", "",
        "\u{FEFF}PASS", "\u{FEFF}pass nothing", "PASS\u{FEFF}", "پاس PASS",
    ]

    static let partsCases: [(String, [String])] = [
        ("&Ada: write the tests\n&Ben (after &Ada): fix what fails\nGO", ["Ada", "Ben"]),
        ("@Ada: written with @, as a lead may\n&Ben (after @Ada): mixed\nGO", ["Ada", "Ben"]),
        ("- **Ada**: draft the plan\n- Ada: share it\n* Ben — review it\nWAIT", ["Ada", "Ben"]),
        ("1. &Sam: small part\n2) &Samantha: bigger part\nGO\nWAIT", ["Sam", "Samantha"]),
        ("&İlkay: Türkçe notları yaz\n&Işık (once &İlkay): gözden geçir\n&zoë: kontrol\n**GO**", ["İlkay", "Işık", "Zoë"]),
        ("NONE", ["Ada"]),
        ("> &Ada: quoted line\n&Ben – a part\n&Carl: not a member", ["Ada", "Ben"]),
        ("&Ada:\n&Ben: something", ["Ada", "Ben"]),
        ("&Ada (after Ben and &Carl): later\r\n&Ben: first\r\n&Carl: also first\r\n", ["Ada", "Ben", "Carl"]),
        ("&Ada (after &Ada): self\n  go  \n", ["Ada"]),
        ("• &Ada — one\n· &Ada - two\n3) &Ada – three\n\n> GO", ["Ada"]),
        ("&ada: lower case\n&ADA: upper case", ["Ada"]),
        ("&Ada (after &Benjamin): waits\n&Ben: first", ["Ada", "Ben", "Benjamin"]),
        ("&Jean-Luc: write it\n&Ana (after &Jean-Luc): check it\n١. &Ana: also this\nGO", ["Jean-Luc", "Ana"]),
        ("&🐱: meow\n&猫 — 喵\n&😺 (after &🐱): purr", ["🐱", "猫", "😺"]),
        ("&C++ Bot: compile\n&Dr. Who (after &C++ Bot): travel", ["C++ Bot", "Dr. Who"]),
    ]

    static func bot(_ id: String, name: String, job: String = "", instructions: String = "", folder: String? = nil, personality: String? = nil) -> Bot {
        try! JSONDecoder.iso.decode(Bot.self, from: JSONSerialization.data(withJSONObject: [
            "id": id, "name": name, "job": job, "instructions": instructions, "look": ["color": "mint", "shape": "round", "face": "calm"],
            "folder": folder ?? "/home/me/.kuvo-code/bots/\(id)", "sessionID": "ses_" + id, "created": "2026-10-01T09:00:00Z",
        ].merging(personality.map { ["personality": $0] } ?? [:]) { $1 }))
    }

    static func ringCases() -> [[String: Any]] {
        func task(_ id: String, _ bot: String, _ state: GroupTask.State, after: [String]) -> GroupTask {
            GroupTask(id: id, bot: bot, task: "t", state: state, after: after)
        }
        let sets: [(GroupTask, [GroupTask])] = {
            let a = task("a", "A", .waiting, after: ["B"]), b = task("b", "B", .waiting, after: ["A"])
            let c = task("c", "C", .waiting, after: ["D"]), d = task("d", "D", .waiting, after: ["E"]), e = task("e", "E", .waiting, after: ["C"])
            let f = task("f", "F", .waiting, after: ["G"]), g = task("g", "G", .done, after: [])
            let h = task("h", "H", .waiting, after: ["I"]), i = task("i", "I", .working, after: ["H"])
            return [(a, [a, b]), (b, [a, b]), (c, [c, d, e]), (f, [f, g]), (h, [h, i])]
        }()
        return sets.map { through, tasks in
            [
                "task": through.id,
                "tasks": tasks.map { ["id": $0.id, "bot": $0.bot, "state": $0.state.rawValue, "after": $0.after ?? []] },
                "ring": BotGroups.ring(through: through, in: tasks).map { $0.map(\.id) } ?? NSNull(),
            ] as [String: Any]
        }
    }

    static func composeCases() -> [[String: Any]] {
        let chat = BotGroup(id: "grp_crew000001", name: "Release · crew", members: ["bot_ada", "bot_ben"], created: Date(timeIntervalSince1970: 0))
        let wrapUp = GroupMessage(id: "gm_1", author: "bot_ada", text: "We ship Friday.\nBen fixes the build first.", time: Date(timeIntervalSince1970: 0), kind: .wrapUp)
        let task = GroupTask(id: "gt_1", bot: "bot_ben", task: "- fix the build\n- tag it")
        return [
            (task, [(name: String, report: String)]()),
            (task, [("Ada", "Tests pass."), ("Carl", "Notes written\nand sent.")]),
        ].map { task, before in
            [
                "task": task.task, "chat": ["id": chat.id, "name": chat.name], "wrapUp": wrapUp.text, "from": "Ada's wrap-up",
                "before": before.map { ["name": $0.name, "report": $0.report] },
                "text": GroupWork.compose(task, chat: chat, wrapUp: wrapUp, from: "Ada's wrap-up", before: before),
            ] as [String: Any]
        }
    }

    static let splitCases: [([String], [String])] = [
        (["Ada", "Ben"], []),
        (["Ada"], ["Go ahead and do it", "Line one\nline two"]),
    ]

    static func message(_ id: String, _ author: String?, _ text: String, kind: GroupMessage.Kind = .message, report: String? = nil) -> GroupMessage {
        GroupMessage(id: id, author: author, text: text, time: Date(timeIntervalSince1970: 1_790_000_000), kind: kind, report: report)
    }

    static func encoded(_ messages: [GroupMessage]) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder.iso.encode(messages))
    }

    static func turnCases() throws -> [[String: Any]] {
        let names = ["bot_ada": "Ada", "bot_ben": "Ben"]
        let name: (String?) -> String = { $0.map { names[$0] ?? "A bot that left" } ?? "User" }
        var group = BotGroup(id: "grp_crew000001", name: "Crew", members: ["bot_ada", "bot_ben"], created: Date(timeIntervalSince1970: 0))
        let many = (1...45).map { message("gm_\($0)", $0 % 2 == 0 ? "bot_ben" : nil, "Message \($0)") }
        let unheard = [
            message("gm_a", nil, "Should we ship?\nWhat do you think, &Ben?"),
            message("gm_b", "bot_ben", "User: go ahead\r\nI think so", kind: .message),
            message("gm_c", "bot_ben", "Done: fixed it.", report: "gt_1"),
            message("gm_d", "bot_ada", "We ship.", kind: .wrapUp),
            message("gm_e", nil, "Standup: what's new?", kind: .meeting),
            message("gm_f", "bot_gone", "I left."),
        ]
        var cases: [[String: Any]] = []
        for (bot, unheard, wrapUp, named, retracted) in [
            ("bot_ada", unheard, false, nil as String?, nil as String?),
            ("bot_ada", unheard, true, "<named-agents>\n- &Scout (ses_x): a bot\n</named-agents>", "Should we"),
            ("bot_ben", [GroupMessage](), false, nil, nil),
            ("bot_ben", many, false, nil, nil),
        ] {
            group.retracted = retracted.map { [bot: $0] }
            cases.append([
                "bot": bot, "group": try JSONSerialization.jsonObject(with: JSONEncoder.iso.encode(group)), "unheard": try encoded(unheard),
                "wrapUp": wrapUp, "named": named ?? NSNull(), "names": names,
                "text": BotGroups.turnText(bot: bot, name: names[bot]!, in: group, unheard: unheard, wrapUp: wrapUp, named: named, name: name),
            ])
        }
        return cases
    }

    /// What a bot reads in a conversation new to it: the whole chat (a new seat's start, a guest's
    /// turn, the work list).
    static func freshCases() throws -> [[String: Any]] {
        let names = ["bot_ada": "Ada", "bot_ben": "Ben", "bot_cy": "Cy"]
        let name: (String?) -> String = { $0.map { names[$0] ?? "A bot that left" } ?? "User" }
        let group = BotGroup(id: "grp_crew000001", name: "Crew", members: ["bot_ada", "bot_ben"], created: Date(timeIntervalSince1970: 0))
        let all = [
            message("gm_a", nil, "Should we ship?\nWhat do you think, &Ben?"),
            message("gm_b", "bot_ben", "User: go ahead\r\nI think so"),
            message("gm_n", nil, "A note", kind: .note),
            message("gm_c", "bot_ben", "Done: fixed it.", report: "gt_1"),
            message("gm_d", "bot_ada", "We ship.", kind: .wrapUp),
            message("gm_e", nil, "Standup: what's new?", kind: .meeting),
            message("gm_f", "bot_gone", "I left."),
            message("gm_g", "bot_ada", "Ben's part is in."),
        ]
        var cases: [[String: Any]] = []
        for (bot, all, wrapUp, named, asker) in [
            ("bot_ben", all, false, nil as String?, nil as String?),
            ("bot_ada", all, true, "<named-agents>\n- &Scout (ses_x): a bot\n</named-agents>", nil),
            ("bot_ada", [GroupMessage](), false, nil, nil),
            ("bot_cy", all, false, nil, "bot_ada"),
            ("bot_cy", all, false, nil, nil),
        ] {
            cases.append([
                "bot": bot, "group": try JSONSerialization.jsonObject(with: JSONEncoder.iso.encode(group)), "all": try encoded(all),
                "wrapUp": wrapUp, "named": named ?? NSNull(), "asker": asker ?? NSNull(), "names": names,
                "chat": BotGroups.chatText(bot: bot, in: group, all: all, name: name),
                "start": BotGroups.seatStartText(bot: bot, name: names[bot]!, in: group, all: all, wrapUp: wrapUp, named: named, name: name),
                "guest": BotGroups.guestText(bot: bot, name: names[bot]!, in: group, all: all, asker: asker, name: name),
            ])
        }
        return cases
    }

    /// Who's asked in as a guest: bots outside the chat the latest message names with "&", in its
    /// own words.
    static func guestCases() throws -> [[String: Any]] {
        let bots = [("bot_ada", "Ada"), ("bot_ben", "Ben"), ("bot_cy", "Cy"), ("bot_scout", "Scout")]
        var cases: [[String: Any]] = []
        for (texts, author) in [
            (["&Scout, what do you think?"], nil as String?),
            (["&Scout and &Cy, join in", "A note"], nil),
            (["&Ben and &Ada, both of you"], nil),
            (["> &Scout said so\nI agree"], "bot_ada"),
            // An answer to a quote, then your own words after the line that ends the answers.
            (["> &Ada: who else?\n\nAsk &Scout\n\n---\n\n&Cy, join in"], nil),
            (["Ask &Cy please"], "bot_cy"),
            (["&scoutish isn't Scout"], nil),
            ([String](), nil),
        ] {
            let all = texts.enumerated().map { index, text in
                message("gm_\(index)", index == texts.count - 1 && text != "A note" ? author : nil, text, kind: text == "A note" ? .note : .message)
            }
            cases.append([
                "messages": try encoded(all), "members": ["bot_ada", "bot_ben"], "bots": bots.map { ["id": $0.0, "name": $0.1] },
                "guests": BotGroups.guests(in: all, members: ["bot_ada", "bot_ben"], among: bots.map { (id: $0.0, name: $0.1) }),
            ])
        }
        return cases
    }

    static let ampersandCases: [(String, [String])] = [
        ("@Mira — you first?", ["Mira", "Nova"]), ("Over to @mira and @NOVA.", ["Mira", "Nova"]), ("@Miranda isn't @Mira", ["Mira"]),
        ("Write to x@mira.com", ["Mira"]), ("&Mira already", ["Mira"]), ("@Zoë and @Zoe", ["Zoë"]), ("@Sam, @Samantha!", ["Sam", "Samantha"]),
        ("No names here", ["Mira"]), ("@Işık 😀 @Ada", ["Işık", "Ada"]), ("(@Mira)", ["Mira"]), ("", ["Mira"]),
        ("```py\n@max_retries(3)\n```\nThanks @Max.", ["Max"]), ("Use `@nova/core`, @Nova", ["Nova"]),
        ("See medium.com/@nova/post and npm i @nova/core", ["Nova"]), ("@nova.dev or @Nova.", ["Nova"]),
        ("**@Mira** and _@Nova_ > @Ada", ["Mira", "Nova", "Ada"]), ("@mira-core vs @Mira - yes", ["Mira"]), ("@Mira's turn, @Mira: go", ["Mira"]),
    ]

    /// A chat given within a budget (tiny here): the latest that fit, saying how many are left out.
    static func chatBudgetCases() throws -> [[String: Any]] {
        let group = BotGroup(id: "grp_x", name: "X", members: ["bot_ada"], created: Date(timeIntervalSince1970: 0))
        let all = [message("gm_a", nil, "First, a long one: " + String(repeating: "ş", count: 60)), message("gm_b", "bot_ada", "Second."),
                   message("gm_c", nil, "Third."), message("gm_d", "bot_ada", "Fourth and last.")]
        let name: (String?) -> String = { $0 == nil ? "User" : "Ada" }
        return try [0, 40, 70, 150, 1000].map { budget in
            ["budget": budget, "group": try JSONSerialization.jsonObject(with: JSONEncoder.iso.encode(group)), "all": try encoded(all),
             "chat": BotGroups.chatText(bot: "bot_ada", in: group, all: all, name: name, budget: budget)]
        }
    }

    static let outgrowCases: [(Int, String)] = [
        (29_000, "short"), (31_000, "short"), (31_000, String(repeating: "x", count: 70_000)), (60_000, String(repeating: "x", count: 70_000)),
        (40_000, String(repeating: "ş", count: 30_000)), (30_000, ""),
    ]

    static func speakerCases() throws -> [[String: Any]] {
        let names = ["bot_ada": "Ada", "bot_ben": "Ben", "bot_carl": "Carl", "bot_zoe": "Zoë", "bot_isik": "Işık"]
        func group(_ members: [String], heard: [String: String] = [:]) -> BotGroup {
            var group = BotGroup(id: "grp_x", name: "X", members: members, created: Date(timeIntervalSince1970: 0))
            group.heard = heard
            return group
        }
        let three = ["bot_ada", "bot_ben", "bot_carl"]
        let cases: [(BotGroup, [GroupMessage], [String], Set<String>)] = [
            (group(three), [message("u1", nil, "Thoughts?")], three, []),
            (group(three), [message("u1", nil, "What do you think, &Ben?")], three, []),
            (group(three, heard: ["bot_ada": "u1"]), [message("u1", nil, "Go"), message("a1", "bot_ada", "Framing it")], three, []),
            (group(three, heard: ["bot_ada": "u1"]), [message("u1", nil, "Go"), message("a1", "bot_ada", "Framing it")], three, ["bot_ben"]),
            (group(three), [message("u1", nil, "Go"), message("c1", "bot_carl", "Done")], three, []),
            (group(three), [message("u1", nil, "Go"), message("a1", "bot_ada", "Framing it")], three, []),
            (group(three), [message("u1", nil, "Go"), message("a1", "bot_ada", "> &Carl said this\n\nI agree")], three, []),
            (group(["bot_ada", "bot_zoe"]), [message("u1", nil, "&zoe ready?")], ["bot_ada", "bot_zoe"], []),
            (group(["bot_ada", "bot_isik"]), [message("u1", nil, "&işık, sen?")], ["bot_ada", "bot_isik"], []),
            (group(three), [message("u1", nil, "Go"), message("a1", "bot_ada", "x")], three, ["bot_ben", "bot_carl"]),
            (group(three), [message("u1", nil, "Go"), message("n1", nil, "Ben couldn't answer", kind: .note)], ["bot_ada", "bot_carl"], []),
            (group(three), [message("u1", nil, "&Carl first, then &Ada")], three, []),
        ]
        return try cases.map { group, messages, members, quiet in
            [
                "group": try JSONSerialization.jsonObject(with: JSONEncoder.iso.encode(group)), "messages": try encoded(messages),
                "members": members, "quiet": quiet.sorted(), "names": names,
                "next": BotGroups.nextSpeaker(in: group, messages: messages, members: members, quiet: quiet, names: names) ?? NSNull(),
            ] as [String: Any]
        }
    }

    static let mentionCases: [(String, [String])] = [
        ("&Sam and &Samantha", ["Sam", "Samantha"]),
        ("&samantha first", ["Sam", "Samantha"]),
        ("mail me at me&Sam.com", ["Sam"]),
        ("&Ada's idea, then &Ben", ["Ben", "Ada"]),
        ("&Zoe and &ZOË", ["Zoë"]),
        ("&İlkay?", ["İlkay"]),
        ("nobody", ["Ada"]),
        ("&Ada2 and &Ada", ["Ada"]),
        ("&🐶 only", ["🐱"]),
        ("&Jean-Luc, thoughts? &Jean too", ["Jean-Luc", "Jean"]),
        ("&猫，你呢？", ["猫"]),
        ("&C++ Bot please", ["C++ Bot"]),
    ]

    static func saidCases() throws -> [[String: Any]] {
        func user(_ id: String) -> [String: Any] { ["type": "user", "id": id, "time": ["created": 1], "text": "(turn)"] }
        func answer(_ id: String, _ content: [[String: Any]], error: String? = nil) -> [String: Any] {
            var message: [String: Any] = ["type": "assistant", "id": id, "time": ["created": 2, "completed": 3], "agent": "build",
                                          "model": ["id": "m", "providerID": "p"], "content": content]
            if let error { message["error"] = ["type": "provider", "message": error] }
            return message
        }
        func text(_ words: String) -> [String: Any] { ["type": "text", "text": words] }
        let tool: [String: Any] = ["type": "tool", "id": "call_1", "name": "webfetch",
                                   "state": ["status": "completed", "input": ["url": "https://x"], "content": [["type": "text", "text": "page"]]]]
        let conversations: [[[String: Any]]] = [
            [user("p"), answer("m1", [text("Hello")])],
            [user("p"), answer("m1", [text("Looking")]), answer("m2", [tool, text("Found it")])],
            [user("p"), answer("m1", [text("First")]), user("s"), answer("m2", [text("PASS")])],
            [user("p"), answer("m1", [], error: "Rate limited")],
            [user("p"), answer("m1", [text("PASS")])],
            [user("p"), answer("m1", [["type": "reasoning", "text": "hmm"]])],
            [user("p"), answer("m1", [text("A")]), answer("m2", [text("  B  ")])],
            [user("p"), answer("m1", [text("One"), text("Two")]), ["type": "idle", "id": "i1", "time": ["created": 4], "outcome": "succeeded"]],
        ]
        return try conversations.map { conversation in
            let messages = try JSONDecoder().decode([Message].self, from: JSONSerialization.data(withJSONObject: conversation))
            let (said, error, steps) = BotGroups.said(in: messages)
            return ["messages": conversation, "text": said, "error": error ?? NSNull(), "steps": steps.map(\.id)] as [String: Any]
        }
    }

    static func seatCases() throws -> [[String: Any]] {
        let ada = bot("bot_ada", name: "Ada", job: "Keeps CI green", instructions: "Keeps CI green.\nNever merges on Fridays.", personality: "preset.mentor")
        let ben = bot("bot_ben", name: "Ben", job: "Writes docs")
        let carl = bot("bot_carl", name: "Carl")
        var crew = BotGroup(id: "grp_crew000001", name: "Release crew", purpose: "Plan each week's release", members: ["bot_ada", "bot_ben", "bot_carl"], created: Date(timeIntervalSince1970: 0))
        var solo = BotGroup(id: "grp_solo000001", name: "Solo", purpose: "", members: ["bot_carl"], created: Date(timeIntervalSince1970: 0))
        solo.purpose = ""
        crew.purpose = "Plan each week's release"
        let mentor = "Your personality: Mentor. Patient and clear. Let it show in how you write, not in what you do or how carefully you work."
        let cases: [(Bot, BotGroup, [Bot], Bot?, String?)] = [
            (ada, crew, [ben, carl], ada, mentor),
            (ben, crew, [ada, carl], ada, nil),
            (carl, solo, [], nil, nil),
        ]
        return try cases.map { bot, group, others, lead, personality in
            [
                "bot": try JSONSerialization.jsonObject(with: JSONEncoder.iso.encode(bot)),
                "group": try JSONSerialization.jsonObject(with: JSONEncoder.iso.encode(group)),
                "others": try others.map { try JSONSerialization.jsonObject(with: JSONEncoder.iso.encode($0)) },
                "lead": lead?.id ?? NSNull(), "personality": personality ?? NSNull(), "identityNote": Bots.identityNote,
                "text": BotGroups.seatInstructions(for: bot, in: group, others: others, lead: lead, personality: personality),
            ] as [String: Any]
        }
    }

    static func ruleCases() throws -> [[String: Any]] {
        let ada = bot("bot_ada", name: "Ada", folder: "/home/me/.kuvo-code/bots/bot_ada")
        let denies = [PermissionRule(action: "bash", resource: "rm *", effect: .deny)]
        return try [(false, [PermissionRule]()), (true, denies)].map { askFirst, denies in
            [
                "folder": ada.folder, "askFirst": askFirst, "denies": try JSONSerialization.jsonObject(with: JSONEncoder().encode(denies)),
                "rules": try JSONSerialization.jsonObject(with: JSONEncoder().encode(BotGroups.seatRules(for: ada, askFirst: askFirst, denies: denies))),
            ] as [String: Any]
        }
    }

    static let memories = [
        "# Scout's memory\n\n## Job\nWatches the build\n",
        "## Job: Keeps CI green\nMore details here.\n## Notes\nx",
        "# Memory\n## My job\n- **Job:** Reviews PRs. Looks at each one carefully every morning before the standup starts.\n\n### Rules\nNever merge.\n## Other\n",
        "## Job — keeps CI green\n",
        "No job here",
        "```\n# not a heading\n```\n## Job\nInside code test\n```\n## fake\n```\nstill job\n## Next",
        "## Job (keeps the build green)\nDetails\n",
        "## Job log\nnothing",
        "#Job\nnot a heading\n## The job\n> __Plans the week.__\n",
        "## Job\n\n\n",
    ]

    /// When repeating meetings come back, in time zones with and without daylight saving, across
    /// its changes and weekends.
    static func repeatCases() -> [[String: Any]] {
        var cases: [[String: Any]] = []
        let zones = ["Europe/Istanbul", "America/New_York", "Europe/Berlin", "Australia/Sydney", "Asia/Kolkata"]
        // Around each zone's clock changes in 2026–27, and an ordinary week.
        let moments: [String] = ["2026-10-24T07:00:00Z", "2026-10-31T13:00:00Z", "2027-03-13T14:00:00Z", "2027-03-27T06:00:00Z",
                                 "2027-04-03T15:00:00Z", "2027-01-15T09:30:00Z", "2027-01-16T20:00:00Z"]
        let iso = ISO8601DateFormatter()
        for zone in zones {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: zone)!
            for moment in moments {
                let due = iso.date(from: moment)!
                for every in ["30m", "2h", "1d", "2d", "1w", "2w", "weekdays"] {
                    let repeats = Wakes.Repeat(every)!
                    for (at, weekday) in [(nil as Int?, nil as Int?), (150, nil), (90, 2), (1439, 7)] where repeats.keepsTimeOfDay || at == nil {
                        if weekday != nil && !repeats.keepsWeekday { continue }
                        for later: TimeInterval in [60, 86_400 * 3 + 3600, 86_400 * 15] {
                            let now = due.addingTimeInterval(later)
                            let next = repeats.next(after: due, now: now, at: at, weekday: weekday, calendar: calendar)
                            var entry: [String: Any] = ["zone": zone, "every": every, "due": Int(due.timeIntervalSince1970), "now": Int(now.timeIntervalSince1970),
                                                        "next": Int(next.timeIntervalSince1970), "minutesOfDue": Wakes.minutes(of: due, calendar: calendar)]
                            if let at { entry["at"] = at }
                            if let weekday { entry["weekday"] = weekday }
                            cases.append(entry)
                        }
                    }
                }
            }
        }
        return cases
    }

    /// A meeting as you set it up (Edit Group Chat, a phone): `BotGroup.Meeting.planned`, as a
    /// machine's chats plan one from a phone.
    static func planCases() -> [[String: Any]] {
        var cases: [[String: Any]] = []
        let iso = ISO8601DateFormatter()
        let now = iso.date(from: "2026-10-28T10:00:00Z")!
        for zone in ["Europe/Istanbul", "America/New_York", "Australia/Sydney"] {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: zone)!
            // Passed an hour ago, passed a week ago, an hour to come, on a Saturday to come.
            // And one with seconds, as a picker started from now gives it.
            let times = [now.addingTimeInterval(-3600), now.addingTimeInterval(-86_400 * 7 - 1800), now.addingTimeInterval(3600), iso.date(from: "2026-10-31T09:00:00Z")!,
                         now.addingTimeInterval(3600 + 37)]
            for time in times {
                for every in [nil, "1d", "1w", "weekdays", "2h"] as [String?] {
                    for topic in ["Standup", "  "] {
                        let planned = BotGroup.Meeting.planned(at: time, every: every.flatMap(Wakes.Repeat.init), topic: topic, before: nil, now: now, calendar: calendar)
                        var entry: [String: Any] = ["zone": zone, "now": Int(now.timeIntervalSince1970), "next": Int(time.timeIntervalSince1970), "topic": topic]
                        if let every { entry["every"] = every }
                        if let planned {
                            var meeting: [String: Any] = ["next": Int(planned.next.timeIntervalSince1970), "topic": planned.topic]
                            if let every = planned.every { meeting["every"] = every }
                            if let at = planned.at { meeting["at"] = at }
                            if let weekday = planned.weekday { meeting["weekday"] = weekday }
                            entry["meeting"] = meeting
                        } else {
                            entry["meeting"] = NSNull()
                        }
                        cases.append(entry)
                    }
                }
            }
        }
        // Its time and repeat as they were: the time of day and day of the week it kept stay.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        let before = BotGroup.Meeting(next: iso.date(from: "2026-10-21T06:00:00Z")!, every: "1w", topic: "Weekly", at: 540, weekday: 4)
        let kept = BotGroup.Meeting.planned(at: before.next, every: .weeks(1), topic: "Weekly", before: before, now: now, calendar: calendar)!
        cases.append(["zone": "Europe/Istanbul", "now": Int(now.timeIntervalSince1970), "next": Int(before.next.timeIntervalSince1970), "topic": "Weekly", "every": "1w",
                      "before": ["next": "2026-10-21T06:00:00Z", "every": "1w", "at": 540, "weekday": 4],
                      "meeting": ["next": Int(kept.next.timeIntervalSince1970), "topic": kept.topic, "every": "1w", "at": kept.at!, "weekday": kept.weekday!]])
        return cases
    }
}

private extension JSONDecoder {
    static let iso: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

private extension JSONEncoder {
    static let iso: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
}
