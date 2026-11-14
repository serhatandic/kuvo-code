import Foundation

/// Decodes the generation-accounting fields in Antigravity's undocumented conversation protobufs.
/// Based on FelixIsaac's original implementation in openusage#1058 and the follow-up in #1120.
enum AntigravityProtoDecoder {
    enum WireValue {
        case varint(UInt64)
        case bytes([UInt8])
    }

    struct GenerationEvent: Equatable, Sendable {
        /// Field 19, Antigravity's internal model ID (`gemini-3.7-flash-high`, or a placeholder such as
        /// `gemini-pro-default` when the picker is on its default choice).
        var modelID: String?
        /// Field 21, the product label for the model that served the turn ("Gemini 3.1 Pro (High)").
        var label: String?
        var inputTokens: Int
        var outputTokens: Int
        var cacheReadTokens: Int
        var timestampSeconds: Int64
    }

    static func decodeVarint(_ bytes: [UInt8], at offset: Int = 0) -> (value: UInt64, nextOffset: Int)? {
        guard offset >= 0, offset < bytes.count else { return nil }

        var value: UInt64 = 0
        for byteIndex in 0..<10 {
            let position = offset + byteIndex
            guard position < bytes.count else { return nil }

            let byte = bytes[position]
            let payload = UInt64(byte & 0x7f)
            guard byteIndex < 9 || payload <= 1 else { return nil }

            value |= payload << (byteIndex * 7)
            if byte & 0x80 == 0 {
                return (value, position + 1)
            }
        }
        return nil
    }

    private static func field(_ requested: UInt32, in bytes: [UInt8]) -> WireValue? {
        var offset = 0

        while offset < bytes.count {
            guard let tag = decodeVarint(bytes, at: offset),
                  let number = UInt32(exactly: tag.value >> 3), number != 0
            else { return nil }

            switch tag.value & 0x7 {
            case 0:
                guard let value = decodeVarint(bytes, at: tag.nextOffset) else { return nil }
                if number == requested { return .varint(value.value) }
                offset = value.nextOffset

            case 2:
                guard let length = decodeVarint(bytes, at: tag.nextOffset),
                      length.value <= UInt64(bytes.count - length.nextOffset),
                      let count = Int(exactly: length.value)
                else { return nil }

                let end = length.nextOffset + count
                if number == requested { return .bytes(Array(bytes[length.nextOffset..<end])) }
                offset = end

            case 1, 5:
                let width = tag.value & 0x7 == 1 ? 8 : 4
                guard bytes.count - tag.nextOffset >= width else { return nil }
                offset = tag.nextOffset + width

            default:
                return nil
            }
        }
        return nil
    }

    static func bytesField(_ number: UInt32, in bytes: [UInt8]) -> [UInt8]? {
        guard case .bytes(let value) = field(number, in: bytes) else { return nil }
        return value
    }

    static func varintField(_ number: UInt32, in bytes: [UInt8]) -> UInt64? {
        guard case .varint(let value) = field(number, in: bytes) else { return nil }
        return value
    }

    /// Seconds from a `google.protobuf.Timestamp` message (field 1), rejecting zero and overflow.
    private static func timestampSeconds(in message: [UInt8]) -> Int64? {
        guard let seconds = varintField(1, in: message),
              let timestampSeconds = Int64(exactly: seconds), timestampSeconds > 0
        else { return nil }
        return timestampSeconds
    }

    /// The step's wall-clock time from `steps.metadata`, whose field 1 is a Timestamp message.
    static func timestamp(fromStepMetadata stepMetadata: [UInt8]) -> Int64? {
        bytesField(1, in: stepMetadata).flatMap(timestampSeconds(in:))
    }

    private static func trimmedString(_ number: UInt32, in message: [UInt8]) -> String? {
        bytesField(number, in: message)
            .flatMap { String(bytes: $0, encoding: .utf8) }?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    /// `gen_metadata.data` wraps its event in field 1: internal model ID 19, display label 21, token
    /// counts 4, and optional timing 9 (whose field 4 is a Timestamp message). Which name to price by is
    /// the scanner's call; the decoder only extracts. Rows with neither ID nor label that carry only a
    /// system-prompt count are bookkeeping (prompt-context records), not generations, and produce no
    /// event. `stepMetadata` is the correlated `steps.metadata` blob, consulted only when the embedded
    /// timing is missing; it is the sole fallback because file modification times move on every write.
    /// With neither timestamp the event is dropped rather than assigned to a day.
    static func generationEvent(from blob: [UInt8], stepMetadata: [UInt8]? = nil) -> GenerationEvent? {
        guard let wrapped = bytesField(1, in: blob) else { return nil }

        let modelID = trimmedString(19, in: wrapped)
        let label = trimmedString(21, in: wrapped)

        guard let usage = bytesField(4, in: wrapped) else { return nil }

        guard let systemPromptTokens = Int(exactly: varintField(1, in: usage) ?? 0),
              let inputTokens = Int(exactly: varintField(2, in: usage) ?? 0),
              let outputTokens = Int(exactly: varintField(3, in: usage) ?? 0),
              let cacheReadTokens = Int(exactly: varintField(5, in: usage) ?? 0)
        else { return nil }

        let billableInputTokens = systemPromptTokens.addingReportingOverflow(inputTokens)
        let generated = inputTokens != 0 || outputTokens != 0 || cacheReadTokens != 0
        guard !billableInputTokens.overflow,
              modelID != nil || label != nil || generated,
              generated || billableInputTokens.partialValue != 0
        else { return nil }

        let embeddedTimestamp = bytesField(9, in: wrapped)
            .flatMap { bytesField(4, in: $0) }
            .flatMap(timestampSeconds(in:))
        guard let timestampSeconds = embeddedTimestamp ?? stepMetadata.flatMap(timestamp(fromStepMetadata:))
        else { return nil }

        return GenerationEvent(
            modelID: modelID,
            label: label,
            inputTokens: billableInputTokens.partialValue,
            outputTokens: outputTokens,
            cacheReadTokens: cacheReadTokens,
            timestampSeconds: timestampSeconds
        )
    }
}
