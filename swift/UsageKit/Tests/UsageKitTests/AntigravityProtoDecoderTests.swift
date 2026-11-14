import XCTest
@testable import UsageKit

final class AntigravityProtoDecoderTests: XCTestCase {
    func testDecodeVarintsAndRejectMalformedValues() {
        XCTAssertEqual(AntigravityProtoDecoder.decodeVarint([0x05])?.value, 5)
        XCTAssertEqual(AntigravityProtoDecoder.decodeVarint([0xac, 0x02])?.value, 300)
        XCTAssertNil(AntigravityProtoDecoder.decodeVarint([0x80]))
        XCTAssertNil(AntigravityProtoDecoder.decodeVarint(Array(repeating: 0xff, count: 11)))
        XCTAssertNil(AntigravityProtoDecoder.decodeVarint(Array(repeating: 0xff, count: 9) + [0x02]))
    }

    func testMalformedLengthCannotOverflowOrTrap() {
        let validField = antigravityVarintField(1, 42)
        let oversizedLength = antigravityVarint(UInt64(2) << 3 | 2) + antigravityVarint(UInt64.max)
        let fields = validField + oversizedLength

        XCTAssertEqual(AntigravityProtoDecoder.varintField(1, in: fields), 42)
        XCTAssertNil(AntigravityProtoDecoder.bytesField(2, in: fields))
    }

    func testExtractsCompleteGenerationRecord() throws {
        let blob = antigravityGenerationBlob(
            model: "gemini-3.1-pro-low",
            input: 1_000,
            output: 200,
            cacheRead: 50,
            systemPrompt: 1_132,
            timestamp: 1_800_000_000
        )
        let event = try XCTUnwrap(AntigravityProtoDecoder.generationEvent(from: blob))

        XCTAssertEqual(event.modelID, "gemini-3.1-pro-low")
        XCTAssertNil(event.label)
        XCTAssertEqual(event.inputTokens, 2_132)
        XCTAssertEqual(event.outputTokens, 200)
        XCTAssertEqual(event.cacheReadTokens, 50)
        XCTAssertEqual(event.timestampSeconds, 1_800_000_000)
    }

    func testRejectsMissingTimestampZeroUsageAndUnrepresentableCounts() {
        let missingTimestamp = antigravityGenerationBlob(model: "gemini-3.6-flash", input: 1, output: 0, timestamp: nil)
        let zeroUsage = antigravityGenerationBlob(model: "gemini-3.6-flash", input: 0, output: 0, timestamp: 1_800_000_000)
        let overflowingTokens = antigravityGenerationBlob(model: "gemini-3.6-flash", input: UInt64.max, output: 0, timestamp: 1_800_000_000)
        let overflowingSystemPrompt = antigravityGenerationBlob(
            model: "gemini-3.6-flash", input: UInt64(Int.max), output: 0,
            systemPrompt: 1, timestamp: 1_800_000_000
        )

        XCTAssertNil(AntigravityProtoDecoder.generationEvent(from: missingTimestamp))
        XCTAssertNil(AntigravityProtoDecoder.generationEvent(from: zeroUsage))
        XCTAssertNil(AntigravityProtoDecoder.generationEvent(from: overflowingTokens))
        XCTAssertNil(AntigravityProtoDecoder.generationEvent(from: overflowingSystemPrompt))
        XCTAssertNil(AntigravityProtoDecoder.generationEvent(from: [0xff, 0xff, 0xff]))
    }

    func testDecoderExposesModelIDAndLabelWithoutChoosing() throws {
        let blob = antigravityGenerationBlob(
            model: "gemini-pro-default", input: 10, output: 1, label: " Gemini 3.1 Pro (High) ", timestamp: 1_800_000_000
        )
        let event = try XCTUnwrap(AntigravityProtoDecoder.generationEvent(from: blob))
        XCTAssertEqual(event.modelID, "gemini-pro-default")
        XCTAssertEqual(event.label, "Gemini 3.1 Pro (High)")
    }

    func testModelCandidatesPreferLabelsForPlaceholdersAndFoldTieredIDs() {
        typealias Scanner = AntigravityDbUsageScanner
        XCTAssertEqual(Scanner.modelCandidates(id: "gemini-default", label: "Gemini 3.5 Flash (Low)"), ["Gemini 3.5 Flash (Low)", "gemini-default"])
        XCTAssertEqual(Scanner.modelCandidates(id: "gemini-pro-default", label: nil), ["gemini-pro-default"])
        XCTAssertEqual(Scanner.modelCandidates(id: nil, label: "Claude Opus 4.6 (Thinking)"), ["Claude Opus 4.6 (Thinking)"])
        XCTAssertEqual(Scanner.modelCandidates(id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)"), ["gemini-3.7-flash-high", "Gemini 3.7 Flash (High)"])
        XCTAssertEqual(Scanner.modelCandidates(id: "gemini-3.7-flash-tiered", label: nil), ["gemini-3.7-flash"])
        XCTAssertEqual(Scanner.modelCandidates(id: nil, label: nil), [])
    }

    func testSystemPromptOnlyRowsWithoutAnyModelAreBookkeepingNotGenerations() {
        let bookkeeping = antigravityGenerationBlob(model: nil, input: 0, output: 0, systemPrompt: 1_298, timestamp: 1_800_000_000)
        let labelled = antigravityGenerationBlob(
            model: nil, input: 0, output: 0, systemPrompt: 1_298, label: "Gemini 3.1 Pro (Low)", timestamp: 1_800_000_000
        )
        let named = antigravityGenerationBlob(model: "gemini-3.6-flash", input: 0, output: 0, systemPrompt: 1_298, timestamp: 1_800_000_000)

        XCTAssertNil(AntigravityProtoDecoder.generationEvent(from: bookkeeping))
        XCTAssertEqual(AntigravityProtoDecoder.generationEvent(from: labelled)?.inputTokens, 1_298)
        XCTAssertEqual(AntigravityProtoDecoder.generationEvent(from: named)?.inputTokens, 1_298)
    }

    func testExtractsStepMetadataTimestamp() {
        let stepMeta = antigravityStepMetadata(timestamp: 1_800_000_000)
        XCTAssertEqual(AntigravityProtoDecoder.timestamp(fromStepMetadata: stepMeta), 1_800_000_000)
        XCTAssertNil(AntigravityProtoDecoder.timestamp(fromStepMetadata: []))
        XCTAssertNil(AntigravityProtoDecoder.timestamp(fromStepMetadata: [0xff]))
    }

    func testUsesFallbackTimestampWhenTimingBytesMissing() throws {
        let blobWithoutTimestamp = antigravityGenerationBlob(
            model: "gemini-3.8-flash",
            input: 500,
            output: 100,
            timestamp: nil
        )
        let event = try XCTUnwrap(AntigravityProtoDecoder.generationEvent(
            from: blobWithoutTimestamp, stepMetadata: antigravityStepMetadata(timestamp: 1_800_000_123)
        ))
        XCTAssertEqual(event.modelID, "gemini-3.8-flash")
        XCTAssertEqual(event.inputTokens, 500)
        XCTAssertEqual(event.outputTokens, 100)
        XCTAssertEqual(event.timestampSeconds, 1_800_000_123)
    }
}
