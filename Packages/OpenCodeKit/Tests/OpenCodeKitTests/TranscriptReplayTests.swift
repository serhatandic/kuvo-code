import Foundation
import Testing
@testable import OpenCodeKit

/// Events that come after a read already has them (they came while it was made, or waited out a
/// reconnect), and events that never came.
struct TranscriptReplayTests {
    private static let session = "ses_ecb63eb0fffeLZyYgRmShX9IVf"

    /// A read made at any point, with the events since any point before it applied on top, ends as
    /// the events alone do: no message, block, tool call or turn's end twice.
    @Test func eventsAReadHasChangeNothingAgain() throws {
        let events = try Fixture.events()
        var all = Transcript(sessionID: Self.session)
        for event in events { all.apply(event) }

        for read in events.indices {
            // The engine's copy then: where blocks start and end, without the words streamed between.
            var engine = Transcript(sessionID: Self.session)
            for event in events[..<read] where !Transcript.isStreamed(event.type) { engine.apply(event) }
            let inbox = engine.pending.map {
                InboxItem(id: $0.id, sessionID: Self.session, type: "user", payload: .object(["text": .string($0.text)]), delivery: $0.delivery)
            }
            // From the start, half way, and just before (every point takes long, and passes too).
            for since in Set([0, read / 2, max(read - 2, 0), read]).sorted() {
                var transcript = Transcript(sessionID: Self.session)
                transcript.load(messages: engine.messages, inbox: inbox, permissions: engine.permissions, forms: engine.forms, isRunning: engine.isRunning)
                for event in events[since...] { transcript.apply(event) }
                let what = "read before event \(read), events from \(since)"
                #expect(transcript.messages == all.messages, "\(what)")
                #expect(transcript.pending == all.pending, "\(what)")
                #expect(transcript.forms == all.forms, "\(what)")
                #expect(transcript.isRunning == all.isRunning, "\(what)")
                #expect(!transcript.isStale, "\(what)")
            }
        }
    }

    /// Without the event that starts a block of words, thinking or a tool call, what comes after it
    /// finds nothing to change: the copy is stale, to be read again, instead of the block missing
    /// until then.
    @Test func aMissedStartMakesTheCopyStale() throws {
        let events = try Fixture.events()
        let starts = ["session.text.started", "session.reasoning.started", "session.tool.input.started"]
        for missed in events.indices where starts.contains(events[missed].type) {
            var transcript = Transcript(sessionID: Self.session)
            for (index, event) in events.enumerated() where index != missed {
                transcript.apply(event)
                if transcript.isStale { break }
            }
            #expect(transcript.isStale, "without \(events[missed].type) (event \(missed))")
        }
    }

    /// A step's words go to their own block: with the second one's start missed, its words don't
    /// replace the first's; read again, the events that come after the read change nothing twice.
    @Test func wordsGoToTheirOwnBlock() throws {
        func event(_ number: Int, _ type: String, _ fields: String) throws -> ServerEvent {
            try ServerEvent(json: Data(#"""
            {"id":"evt_\#(number)","created":\#(number),"type":"\#(type)","data":{"sessionID":"ses_1","assistantMessageID":"msg_1",\#(fields)}}
            """#.utf8))
        }
        func step(_ texts: [String]) -> [Message] {
            [.assistant(Message.Assistant(id: "msg_1", time: Message.Time(created: 1), agent: "build", model: ModelRef(id: "m", providerID: "p"),
                                          content: texts.map { .text(Message.Content.Text(text: $0)) }))]
        }
        func texts(_ transcript: Transcript) -> [String] {
            guard case .assistant(let step)? = transcript.messages.last else { return [] }
            return step.content.compactMap { if case .text(let block) = $0 { block.text } else { nil } }
        }
        let first = try [
            event(2, "session.text.started", #""ordinal":0"#),
            event(3, "session.text.delta", #""ordinal":0,"delta":"First""#),
            event(4, "session.text.ended", #""ordinal":0,"text":"First.""#),
        ]
        let second = try [
            event(5, "session.text.started", #""ordinal":1"#),
            event(6, "session.text.delta", #""ordinal":1,"delta":"Sec""#),
            event(7, "session.text.delta", #""ordinal":1,"delta":"ond""#),
            event(8, "session.text.ended", #""ordinal":1,"text":"Second.""#),
        ]

        var transcript = Transcript(sessionID: "ses_1")
        transcript.load(messages: step([]), inbox: [], permissions: [], forms: [], isRunning: true)
        for event in first + second.dropFirst() { transcript.apply(event) }
        #expect(texts(transcript) == ["First.", "Second."])
        #expect(transcript.isStale)

        // Read again (the engine had started the second block), then the events since the first
        // block started come too.
        transcript.load(messages: step(["First.", ""]), inbox: [], permissions: [], forms: [], isRunning: true)
        for event in first + second { transcript.apply(event) }
        #expect(texts(transcript) == ["First.", "Second."])
        #expect(!transcript.isStale)
    }

    /// "Retrying (attempt 2)…" goes once the step it was for is over: stopped during the wait, or
    /// the engine going on in a new step, as the engine's own reading of the conversation has it.
    @Test func aRetryGoesWithItsStep() throws {
        func event(_ number: Int, _ type: String, _ fields: String) throws -> ServerEvent {
            try ServerEvent(json: Data(#"""
            {"id":"evt_\#(number)","created":\#(number),"type":"\#(type)","data":{"sessionID":"ses_1",\#(fields)}}
            """#.utf8))
        }
        func retries(_ transcript: Transcript) -> [String: Int] {
            Dictionary(uniqueKeysWithValues: transcript.messages.compactMap { message in
                if case .assistant(let step) = message, let retry = step.retry { (step.id, retry.attempt) } else { nil }
            })
        }
        let waiting = try [
            event(1, "session.execution.started", #""inputID":"in_1""#),
            event(2, "session.step.started", #""assistantMessageID":"msg_1","agent":"build","model":{"id":"m","providerID":"p"}"#),
            event(3, "session.retry.scheduled", #""assistantMessageID":"msg_1","attempt":2,"at":9000,"error":{"type":"overloaded","message":"Overloaded"}"#),
        ]

        var stopped = Transcript(sessionID: "ses_1")
        for event in waiting { stopped.apply(event) }
        #expect(retries(stopped) == ["msg_1": 2])
        stopped.apply(try event(4, "session.execution.interrupted", #""reason":"user""#))
        #expect(retries(stopped) == [:])

        var goneOn = Transcript(sessionID: "ses_1")
        for event in waiting { goneOn.apply(event) }
        goneOn.apply(try event(4, "session.step.started", #""assistantMessageID":"msg_2","agent":"build","model":{"id":"m","providerID":"p"}"#))
        #expect(retries(goneOn) == [:])
    }

    /// Instructions changed mid-conversation (a project's folders, say) and the engine's own notices
    /// show as they happen, as reading the conversation has them: what changed, and what it's about.
    @Test func noticesShowAsTheyHappenAsAReadHasThem() throws {
        var transcript = Transcript(sessionID: "ses_1")
        transcript.apply(try ServerEvent(json: Data(#"""
        {"id":"evt_1","created":1,"type":"session.instructions.updated","metadata":{"by":"kuvo"},"data":{"sessionID":"ses_1","delta":{"kuvo/project-folders":"Also /src/web"},"text":"Folders: /src/web"}}
        """#.utf8)))
        transcript.apply(try ServerEvent(json: Data(#"""
        {"id":"evt_2","created":2,"type":"session.instructions.updated","data":{"sessionID":"ses_1","delta":{"core/x":"y"}}}
        """#.utf8)))
        transcript.apply(try ServerEvent(json: Data(#"""
        {"id":"evt_3","created":3,"type":"session.synthetic","data":{"sessionID":"ses_1","text":"Exited 0","description":"npm test","metadata":{"source":"shell","state":"completed","exit":0}}}
        """#.utf8)))

        guard transcript.messages.count == 2,
              case .system(let instructions) = transcript.messages[0],
              case .synthetic(let ended) = transcript.messages[1] else {
            Issue.record("Expected the instructions' notice and the command's, got \(transcript.messages)")
            return
        }
        #expect(instructions.id == "msg_1")
        #expect(instructions.text == "Folders: /src/web")
        #expect(instructions.description == "Instructions updated: kuvo/project-folders")
        #expect(instructions.instructionSources == ["kuvo/project-folders"])
        #expect(instructions.metadata?["by"]?.string == "kuvo")
        #expect(ended.description == "npm test")
        #expect(ended.metadata?["source"]?.string == "shell")
    }

    /// Stopped while it asks you something: the engine lets the ask go without a word, and its card
    /// goes with the run. A subagent's ask stays while the subagent's own run goes on.
    @Test func anAskGoesWithItsRun() throws {
        func event(_ number: Int, _ type: String, _ data: String) throws -> ServerEvent {
            try ServerEvent(json: Data(#"{"id":"evt_\#(number)","created":\#(number),"type":"\#(type)","data":{\#(data)}}"#.utf8))
        }
        var transcript = Transcript(sessionID: "ses_1")
        transcript.helpers = ["ses_helper"]
        transcript.asksEndWithRuns = true
        transcript.apply(try event(1, "session.execution.started", #""sessionID":"ses_1","inputID":"in_1""#))
        transcript.apply(try event(2, "permission.asked", #""id":"per_1","sessionID":"ses_1","action":"shell","resources":["npm test"]"#))
        transcript.apply(try event(3, "permission.asked", #""id":"per_2","sessionID":"ses_helper","action":"shell","resources":["curl example.com"]"#))
        transcript.apply(try event(4, "session.execution.interrupted", #""sessionID":"ses_1","reason":"user""#))
        #expect(transcript.permissions.map(\.id) == ["per_2"])
        transcript.apply(try event(5, "session.execution.failed", #""sessionID":"ses_helper","error":{"type":"aborted","message":"Aborted"}"#))
        #expect(transcript.permissions.isEmpty)
    }

    /// A reply cut off (its stream broke, or it ran out of room) that the engine carries on: the
    /// conversation says so in a few words, not with the engine's word to the model.
    @Test func aReplyCarriedOnSaysSoPlainly() throws {
        var transcript = Transcript(sessionID: "ses_1")
        for (number, text) in [
            (1, "The previous response was interrupted. Continue from where you left off without repeating completed content."),
            (2, "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces."),
            (3, "Command `npm test` finished"),
        ] {
            transcript.apply(try ServerEvent(json: Data(#"""
            {"id":"evt_\#(number)","created":\#(number),"type":"session.synthetic","data":{"sessionID":"ses_1","text":"\#(text)"}}
            """#.utf8)))
        }
        let words: [String?] = transcript.messages.map { message in
            if case .synthetic(let notice) = message { notice.carriedOn } else { nil }
        }
        #expect(words == ["The reply was cut off, so it carried on", "Hit the length limit for one reply, so it carried on", nil])
    }

    /// The engine's own notice (a background command finished) waiting to go in when the
    /// conversation was read: it shows when it goes in, once, as one that waited while it was open does.
    @Test func aNoticeWaitingWhenReadShowsWhenItGoesIn() throws {
        let delivered = try ServerEvent(json: Data(#"""
        {"id":"evt_9","created":9,"type":"session.inbox.delivered","data":{"sessionID":"ses_1","inboxID":"msg_n1"}}
        """#.utf8))
        let waiting = InboxItem(id: "msg_n1", sessionID: "ses_1", type: "synthetic",
                                payload: .object(["text": .string("Command `npm test` finished"), "description": .string("Background command")]), delivery: .steer)
        func notices(_ transcript: Transcript) -> [String] {
            transcript.messages.compactMap { if case .synthetic(let notice) = $0 { notice.text } else { nil } }
        }

        var transcript = Transcript(sessionID: "ses_1")
        transcript.load(messages: [], inbox: [waiting], permissions: [], forms: [], isRunning: true)
        #expect(notices(transcript).isEmpty, "not before it goes in")
        transcript.apply(delivered)
        #expect(notices(transcript) == ["Command `npm test` finished"])

        // Read again, with the engine's copy of it, then the event again: still once.
        let engine = transcript.messages
        transcript.load(messages: engine, inbox: [], permissions: [], forms: [], isRunning: true)
        transcript.apply(delivered)
        #expect(notices(transcript) == ["Command `npm test` finished"])

        // One seen queued while it was open, then a read whose queue couldn't be read: it still
        // shows when it goes in, as of when it was queued.
        var open = Transcript(sessionID: "ses_1")
        open.load(messages: [], inbox: [], permissions: [], forms: [], isRunning: true)
        open.apply(try ServerEvent(json: Data(#"""
        {"id":"evt_5","created":5,"type":"session.inbox.enqueued","data":{"sessionID":"ses_1","inboxID":"msg_n1","item":{"type":"synthetic","payload":{"text":"Command `npm test` finished"},"delivery":"steer"}}}
        """#.utf8)))
        open.load(messages: [], inbox: [], permissions: [], forms: [], isRunning: true)
        open.apply(delivered)
        #expect(notices(open) == ["Command `npm test` finished"])
        #expect(open.messages.first?.created == 5)
    }

    /// A conversation read again while the agent writes: what shows has every word once, whether
    /// the read has none of the words so far (the engine's) or some (the coding agents' bridge),
    /// and whether the conversation was showing already or is opened now.
    @Test func aReadMadeMidReplyShowsEveryWordOnce() throws {
        func event(_ number: Int, _ type: String, _ fields: String) throws -> ServerEvent {
            try ServerEvent(json: Data(#"""
            {"id":"evt_\#(number)","created":\#(number),"type":"\#(type)","data":{"sessionID":"ses_1","assistantMessageID":"msg_1",\#(fields)}}
            """#.utf8))
        }
        func step(text: String, thinking: String, input: String) -> [Message] {
            [.assistant(Message.Assistant(id: "msg_1", time: Message.Time(created: 1), agent: "build", model: ModelRef(id: "m", providerID: "p"), content: [
                .reasoning(Message.Content.Text(text: thinking, time: Message.Time(created: 1))),
                .text(Message.Content.Text(text: text)),
                .tool(Message.ToolCall(id: "call_1", name: "read", state: .streaming(input: input))),
            ]))]
        }
        func shown(_ transcript: Transcript) -> [String] {
            guard case .assistant(let step)? = transcript.messages.last else { return [] }
            return step.content.compactMap {
                switch $0 {
                case .text(let block), .reasoning(let block): block.text
                case .tool(let call): if case .streaming(let input) = call.state { input } else { nil }
                default: nil
                }
            }
        }
        // Before the read began, then while it was on its way: as the engine sends them, and as the
        // coding agents' bridge does, saying where each goes.
        func pieces(saying: Bool) throws -> (before: [ServerEvent], during: [ServerEvent]) {
            func at(_ at: Int) -> String { saying ? #","at":\#(at)"# : "" }
            return try ([
                event(2, "session.reasoning.delta", #""ordinal":0,"delta":"Look at ""# + at(0)),
                event(3, "session.text.delta", #""ordinal":0,"delta":"Hello ""# + at(0)),
                event(4, "session.tool.input.delta", #""id":"call_1","delta":"{\"pa""# + at(0)),
            ], [
                event(5, "session.reasoning.delta", #""ordinal":0,"delta":"it""# + at(8)),
                event(6, "session.text.delta", #""ordinal":0,"delta":"wor""# + at(6)),
                event(7, "session.text.delta", #""ordinal":0,"delta":"ld""# + at(9)),
                event(8, "session.tool.input.delta", #""id":"call_1","delta":"th\"""# + at(4)),
            ])
        }
        let whole = ["Look at it", "Hello world", #"{"path""#]
        let reads = [
            ("the engine's, none of the words", false, step(text: "", thinking: "", input: "")),
            ("the bridge's, some of the pieces since", true, step(text: "Hello wor", thinking: "Look at ", input: #"{"pa"#)),
            ("the bridge's, all of them", true, step(text: "Hello world", thinking: "Look at it", input: #"{"path""#)),
        ]
        for (what, saying, read) in reads {
            let (before, during) = try pieces(saying: saying)
            var showing = Transcript(sessionID: "ses_1")
            showing.load(messages: step(text: "", thinking: "", input: ""), inbox: [], permissions: [], forms: [], isRunning: true)
            for event in before + during { showing.apply(event) }
            #expect(shown(showing) == whole)

            var fresh = showing
            fresh.load(messages: read, inbox: [], permissions: [], forms: [], isRunning: true)
            fresh.catchUp(on: during, shown: showing)
            #expect(shown(fresh) == whole, "read again: \(what)")

            // Opened while it writes: over the bridge, the pieces its read has already go once.
            guard saying else { continue }
            var opened = Transcript(sessionID: "ses_1")
            opened.load(messages: read, inbox: [], permissions: [], forms: [], isRunning: true)
            opened.catchUp(on: during, shown: Transcript(sessionID: "ses_1"))
            #expect(shown(opened) == whole, "opened: \(what)")
        }

        // Opened over the bridge, its read ending as the next piece does (a blank line): that one
        // is still added.
        var opened = Transcript(sessionID: "ses_1")
        opened.load(messages: step(text: "Line.\n", thinking: "", input: ""), inbox: [], permissions: [], forms: [], isRunning: true)
        opened.catchUp(on: try [
            event(9, "session.text.delta", #""ordinal":0,"delta":"\n","at":6"#),
            event(10, "session.text.delta", #""ordinal":0,"delta":"Next","at":7"#),
        ], shown: Transcript(sessionID: "ses_1"))
        #expect(shown(opened)[1] == "Line.\n\nNext")

        // Read further than the copy on screen had come (the bridge keeps a piece before it's sent):
        // the pieces that come after, during the read and once it's in, are there once.
        var behind = Transcript(sessionID: "ses_1")
        behind.load(messages: step(text: "Hello ", thinking: "", input: ""), inbox: [], permissions: [], forms: [], isRunning: true)
        let wor = try event(11, "session.text.delta", #""ordinal":0,"delta":"wor","at":6"#)
        behind.apply(wor)
        var ahead = behind
        ahead.load(messages: step(text: "Hello world", thinking: "", input: ""), inbox: [], permissions: [], forms: [], isRunning: true)
        ahead.catchUp(on: [wor], shown: behind)
        ahead.apply(try event(12, "session.text.delta", #""ordinal":0,"delta":"ld","at":9"#))
        #expect(shown(ahead)[1] == "Hello world")
    }
}
