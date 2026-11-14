import Foundation

/// A field every box sends as `null` when it has none, never leaves out (PROTOCOL.md, "Messages in
/// a session"), as a machine's box does: `JSONEncoder` would leave a nil out.
@propertyWrapper
public struct SentAsNull<Value: Encodable>: Encodable {
    public var wrappedValue: Value?

    public init(wrappedValue: Value?) {
        self.wrappedValue = wrappedValue
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let wrappedValue { try container.encode(wrappedValue) } else { try container.encodeNil() }
    }
}
