import Foundation
import OpenCodeKit
@testable import KuvoCode

/// A box's settings kept in memory, for a test of what Kuvo Code makes of settings (importing into
/// them, naming models) rather than of where a box keeps them, which
/// the box's own tests and the settings-on-the-box tests cover.
final class MemorySettings: RemoteSettings {
    private(set) var settings: [String: JSONValue]

    init(_ settings: [String: JSONValue] = [:]) { self.settings = settings }

    func read() async throws -> [String: JSONValue] { settings }

    struct ChangedMeanwhile: Error {}

    func change(_ changes: [(path: [String], value: JSONValue?)], was: [JSONValue?]) async throws -> [String: JSONValue] {
        // As the box checks: a list changed since it was read is refused.
        for (change, was) in zip(changes, was) where was != nil {
            if (EngineConfig.value(at: change.path, in: settings) ?? .null) != was { throw ChangedMeanwhile() }
        }
        for change in changes { settings = Self.setting(change.value, at: change.path[...], in: settings) }
        return settings
    }

    private static func setting(_ value: JSONValue?, at path: ArraySlice<String>, in object: [String: JSONValue]) -> [String: JSONValue] {
        var object = object
        guard let key = path.first else { return object }
        if path.count == 1 {
            object[key] = value
        } else {
            let inner = setting(value, at: path.dropFirst(), in: object[key]?.object ?? [:])
            object[key] = inner.isEmpty ? nil : .object(inner)
        }
        return object
    }
}

extension EngineConfig {
    /// Settings kept in memory (`MemorySettings`), read already.
    @MainActor static func inMemory(_ settings: [String: JSONValue] = [:]) -> EngineConfig {
        let config = EngineConfig(remote: MemorySettings(settings))
        config.took(settings)
        return config
    }
}
