import ClientDesign
import Foundation
import OpenCodeKit

/// What you changed of bots whose computer is away, kept until it's back (in the app's settings,
/// `botEditOutbox`): one edit a bot, a later one on top of what waited, each field the last you
/// gave it, or a delete for a bot whose machine you removed. Its box takes it as soon as it answers
/// (`Bots.sendWaiting`), and what it then says is what shows. Meanwhile the bot shows as you left it
/// (`applied`), waiting for that computer.
@Observable
final class BotEdits {
    struct Edit: Codable, Equatable {
        /// The box it goes to: "mac", or a machine's id.
        var box: String
        /// Fields as `PATCH kuvo/bots/<id>` takes them.
        var fields: [String: JSONValue] = [:]
        /// Deleted while its machine was away for good (removed from Kuvo Code).
        var delete = false
    }

    /// Edits waiting, by bot.
    private(set) var waiting: [String: Edit]
    private let key: String

    init(key: String = "botEditOutbox") {
        self.key = key
        waiting = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode([String: Edit].self, from: $0) } ?? [:]
    }

    /// `fields` changed on `id`, for `box`: on top of what already waits for it.
    func put(_ id: String, box: String, fields: [String: JSONValue]) {
        var edit = waiting[id] ?? Edit(box: box)
        edit.box = box
        edit.fields.merge(fields) { _, new in new }
        waiting[id] = edit
        save()
    }

    /// `id` deleted, for `box`, once it answers: what else waited for it doesn't matter now.
    func put(_ id: String, box: String, delete: Bool) {
        waiting[id] = Edit(box: box, delete: delete)
        save()
    }

    func drop(_ id: String) {
        guard waiting[id] != nil else { return }
        waiting[id] = nil
        save()
    }

    /// A machine found to be another one at another address: what waited for it waits for the other.
    func fold(_ machine: String, into other: String) {
        var changed = false
        for (id, edit) in waiting where edit.box == machine {
            waiting[id]?.box = other
            changed = true
        }
        if changed { save() }
    }

    /// `bot` as you left it: what waits for it, as made.
    func applied(to bot: Bot) -> Bot {
        guard let edit = waiting[bot.id], !edit.delete else { return bot }
        var shown = bot
        if let name = edit.fields["name"]?.string { shown.name = name }
        if let look = edit.fields["look"].flatMap({ Self.decoded(BotLook.self, $0) }) { shown.look = look }
        if let personality = edit.fields["personality"] { shown.personality = personality.string }
        if let model = edit.fields["model"].flatMap({ Self.decoded(ModelRef.self, $0) }) { shown.model = model }
        if let job = edit.fields["job"] {
            shown.job = job["line"]?.string ?? shown.job
            shown.instructions = job["details"]?.string ?? shown.instructions
        }
        return shown
    }

    private static func decoded<T: Decodable>(_ type: T.Type, _ value: JSONValue) -> T? {
        (try? JSONEncoder().encode(value)).flatMap { try? JSONDecoder().decode(type, from: $0) }
    }

    private func save() {
        UserDefaults.standard.set(waiting.isEmpty ? nil : try? JSONEncoder().encode(waiting), forKey: key)
    }
}

/// A bot's job as Edit Bot changes it: what you typed, beside the job the bot keeps. Until you change
/// it, it follows what the bot keeps (the bot keeps its job as you talk to it, Edit Bot open or
/// not); once you have, yours stays, and a job the bot keeps meanwhile shows beside it
/// (`keptMeanwhile`), for you to take instead (`useKept`) or leave to Save, which keeps yours.
struct JobDraft: Equatable {
    struct Job: Equatable {
        var line: String
        var details: String
    }

    var line: String
    var details: String
    /// What the bot kept as you started, or as you last took it.
    private(set) var base: Job
    /// What the bot kept since, while you'd changed yours.
    private(set) var keptMeanwhile: Job?

    init(line: String, details: String) {
        self.line = line
        self.details = details
        base = Job(line: line, details: details)
    }

    private var typed: Job { Job(line: line, details: details) }

    /// The bot keeps `kept` now.
    mutating func botKept(_ kept: Job) {
        if kept == typed {
            base = kept
            keptMeanwhile = nil
        } else if typed == base {
            line = kept.line
            details = kept.details
            base = kept
            keptMeanwhile = nil
        } else if kept != base {
            keptMeanwhile = kept
        } else {
            keptMeanwhile = nil
        }
    }

    /// The bot's own job in place of yours.
    mutating func useKept() {
        guard let kept = keptMeanwhile else { return }
        line = kept.line
        details = kept.details
        base = kept
        keptMeanwhile = nil
    }
}
