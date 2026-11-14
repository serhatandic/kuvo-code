import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Each computer's settings are its own. A machine's are read there and changed there key by key,
/// so another computer's change to another key stays; one that doesn't get there shows as it is
/// there again; a read that comes back after a change never undoes it; and a session on a machine
/// goes by that machine's rules, never this Mac's. The machine's settings tool is stood in for;
/// its engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BoxSettingsTests {
    /// A machine's settings file, as its own tool keeps it (`kuvo-link.js box`).
    @MainActor @Observable final class Box: RemoteSettings {
        var settings: [String: JSONValue]
        var refusesChanges = false
        var refusesReads = false
        var changes: [[[String]]] = []
        /// Changes wait here until let go.
        var holdsChanges = false
        private var heldChanges: [CheckedContinuation<Void, Never>] = []
        var waitingChanges: Int { heldChanges.count }
        /// Reads wait here until let go, answering with the file as it was when they were asked.
        var holdsReads = false
        private var held: [CheckedContinuation<Void, Never>] = []
        var waitingReads: Int { held.count }

        init(_ settings: [String: JSONValue]) { self.settings = settings }

        func read() async throws -> [String: JSONValue] {
            if refusesReads { throw MachineBox.Failure.refused("ssh: connect to host box port 22: Connection refused") }
            let asked = settings
            if holdsReads { await withCheckedContinuation { held.append($0) } }
            return asked
        }

        func change(_ changes: [(path: [String], value: JSONValue?)], was: [JSONValue?]) async throws -> [String: JSONValue] {
            if holdsChanges { await withCheckedContinuation { heldChanges.append($0) } }
            if refusesChanges { throw MachineBox.Failure.refused("ssh: connect to host box port 22: Connection refused") }
            self.changes.append(changes.map(\.path))
            for change in changes { settings = Self.setting(change.value, at: change.path[...], in: settings) }
            return settings
        }

        func letChangesGo() {
            holdsChanges = false
            heldChanges.forEach { $0.resume() }
            heldChanges.removeAll()
        }

        func letReadsGo() {
            holdsReads = false
            held.forEach { $0.resume() }
            held.removeAll()
        }

        private static func setting(_ value: JSONValue?, at path: ArraySlice<String>, in object: [String: JSONValue]) -> [String: JSONValue] {
            var object = object
            if path.count == 1 { object[path.first!] = value } else { object[path.first!] = .object(setting(value, at: path.dropFirst(), in: object[path.first!]?.object ?? [:])) }
            return object
        }
    }

    static func rule(_ resource: String, _ effect: String = "deny") -> JSONValue {
        .object(["action": .string("shell"), "resource": .string(resource), "effect": .string(effect)])
    }

    @Test func aMachinesSettingsAreReadThereAndChangedKeyByKey() async throws {
        let box = Box(["model": .string("openai/luna"), "permissions": .array([Self.rule("git push *")])])
        let config = EngineConfig(remote: box)
        // Nothing to show until it's read (as the machine is started, or its tab opened).
        #expect(!config.isLoaded)
        config.reload()
        try await until { config.isLoaded }
        #expect(config.value(at: ["model"]) == .string("openai/luna"))
        #expect(config.permissionRules.map(\.resource) == ["git push *"])

        // A phone changes another key there meanwhile; this one changes the model.
        box.settings["small_model"] = .string("openai/luna-mini")
        config.set(.string("anthropic/sonnet"), at: ["model"])
        #expect(config.value(at: ["model"]) == .string("anthropic/sonnet"))
        try await until { !box.changes.isEmpty }
        #expect(box.changes == [[["model"]]])
        try await until { config.value(at: ["small_model"]) != nil }
        // Both: the phone's change stays, and this one's is there.
        #expect(box.settings["model"] == .string("anthropic/sonnet"))
        #expect(config.value(at: ["small_model"]) == .string("openai/luna-mini"))
        #expect(config.value(at: ["model"]) == .string("anthropic/sonnet"))
        #expect(config.notSaved == nil)
    }

    @Test func aChangeThatDoesntGetThereShowsAsItIsThere() async throws {
        let box = Box(["model": .string("openai/luna")])
        let config = EngineConfig(remote: box)
        config.took(box.settings)
        box.refusesChanges = true
        config.set(.string("anthropic/sonnet"), at: ["model"])
        try await until { config.notSaved != nil }
        #expect(config.notSaved?.contains("Connection refused") == true)
        try await until { config.value(at: ["model"]) == .string("openai/luna") }
        #expect(config.value(at: ["model"]) == .string("openai/luna"))
        // Still yours to change: the next one that gets there clears it.
        #expect(config.problem == nil)
        box.refusesChanges = false
        config.set(.string("anthropic/sonnet"), at: ["model"])
        try await until { config.notSaved == nil }
        #expect(box.settings["model"] == .string("anthropic/sonnet"))
    }

    @Test func aReadThatComesBackLateDoesntUndoAChange() async throws {
        let box = Box(["model": .string("openai/luna")])
        let config = EngineConfig(remote: box)
        config.took(box.settings)
        // A read on its way (the engine said its settings changed), slow to come back.
        box.holdsReads = true
        config.reload()
        try await until { box.waitingReads == 1 }
        config.set(.string("anthropic/sonnet"), at: ["model"])
        try await until { box.settings["model"] == .string("anthropic/sonnet") }
        box.letReadsGo()
        try await Task.sleep(for: .milliseconds(100))
        #expect(config.value(at: ["model"]) == .string("anthropic/sonnet"))
    }

    /// Two changes on their way, and a read in between (the engine said its settings changed):
    /// the later change is what shows, and what's there in the end.
    @Test func changesOnTheirWayKeepTheirOrder() async throws {
        let box = Box(["permissions": .array([])])
        let config = EngineConfig(remote: box)
        config.took(box.settings)
        box.holdsChanges = true
        config.set(.array([Self.rule("a *")]), at: ["permissions"])
        try await until { box.waitingChanges == 1 }
        config.set(.array([Self.rule("b *")]), at: ["permissions"])
        // The read comes back before either change is answered.
        config.took(box.settings)
        #expect(config.permissionRules.map(\.resource) == ["b *"])
        box.letChangesGo()
        try await until { box.changes.count == 2 }
        try await until { config.permissionRules.map(\.resource) == ["b *"] && box.settings["permissions"] == .array([Self.rule("b *")]) }
        #expect(config.permissionRules.map(\.resource) == ["b *"])
    }

    /// The machine out of reach: a change shows as it is there at once (reading it again fails
    /// too), and the next one is still sent.
    @Test func aChangeThatFailsWhileAwayShowsAsItIsThereAndTheNextGoes() async throws {
        let box = Box(["model": .string("openai/luna"), "small_model": .string("openai/mini")])
        let config = EngineConfig(remote: box)
        config.took(box.settings)
        box.refusesChanges = true
        box.refusesReads = true
        config.set(.string("anthropic/sonnet"), at: ["model"])
        try await until { config.notSaved != nil }
        #expect(config.value(at: ["model"]) == .string("openai/luna"))
        #expect(config.problem == nil, "still read, still yours to change")
        box.refusesChanges = false
        box.refusesReads = false
        config.set(.string("anthropic/haiku"), at: ["small_model"])
        try await until { box.settings["small_model"] == .string("anthropic/haiku") }
        try await until { config.notSaved == nil }
        #expect(config.value(at: ["model"]) == .string("openai/luna"))
    }

    @Test func aMachineThatCantBeReachedSaysSo() async throws {
        struct Away: RemoteSettings {
            func read() async throws -> [String: JSONValue] { throw MachineBox.Failure.refused("ssh: connect to host box port 22: Connection refused") }
            func change(_ changes: [(path: [String], value: JSONValue?)], was: [JSONValue?]) async throws -> [String: JSONValue] { throw MachineBox.Failure.refused("ssh: connect to host box port 22: Connection refused") }
        }
        let config = EngineConfig(remote: Away())
        config.reload()
        try await until { config.problem != nil }
        #expect(config.problem == "Its settings couldn't be read: ssh: connect to host box port 22: Connection refused")
        #expect(!config.isLoaded)
        // Nothing's changed while it can't be read.
        config.set(.string("anthropic/sonnet"), at: ["model"])
        #expect(config.value(at: ["model"]) == nil)
    }
}
