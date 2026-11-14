import XCTest
@testable import UsageKit

final class GeminiArgonPricingTests: XCTestCase {
    private let pricing = ModelPricing(
        supplement: TestPricing.bundled.supplement,
        primary: PricingCatalog(),
        secondary: PricingCatalog()
    )

    func testBundledSupplementPricesArgonIDsAndLabelsWithoutRemoteCatalogs() {
        let expected = ModelRates(
            inputPerMillion: 2, outputPerMillion: 10,
            cacheWritePerMillion: 2, cacheReadPerMillion: 0.1
        )
        let models = [
            "gemini-4-argon", "gemini-4-argon-trial", "gemini-4-argon-preview",
            "gemini-4-argon-none", "gemini-4-argon-n", "gemini-4-argon-low",
            "gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-xhigh",
            "gemini-4-argon-trial-high", "gemini-4-argon-high-trial",
            "gemini-4-argon-preview-high", "gemini-4-argon-xhigh-preview",
            "Gemini 4 Argon", "Gemini 4 Argon (None)", "Gemini 4 Argon (Low)",
            "Gemini 4 Argon (Medium)", "Gemini 4 Argon (High)", "Gemini 4 Argon (XHigh)",
            "Gemini 4 Argon (Trial)", "Gemini 4 Argon (Preview)"
        ]

        for model in models {
            XCTAssertEqual(pricing.resolve(model: model), expected, model)
            XCTAssertEqual(pricing.supplement.canonicalName(for: model), "gemini-4-argon", model)
            XCTAssertEqual(pricing.familyName(for: model, stripping: ["-preview"]), "gemini-4-argon", model)
        }
    }

    func testArgonAliasesLeaveOtherVersionsAndUnrecognizedVariantsUnpriced() {
        for model in [
            "gemini-5-argon", "gemini-4.1-argon", "gemini-4-argon-turbo",
            "gemini-4-argon-fast", "gemini-4-argon-high-fast",
            "gemini-4-argon-contributor", "gemini-4-argon-contributor-high",
            "Gemini 4 Argon (Contributor)", "Gemini 4 Argon (Fast)", "Gemini 5 Argon (High)"
        ] {
            XCTAssertNil(pricing.supplement.canonicalName(for: model), model)
            XCTAssertNil(pricing.resolve(model: model), model)
        }
    }

    func testArgonCostIncludesInputCacheWritesCacheReadsAndOutput() throws {
        let tokens = TokenBreakdown(input: 1_000_000, cacheWrite5m: 250_000, cacheRead: 200_000, output: 500_000)
        let cost = try XCTUnwrap(pricing.estimatedCostDollars(model: "gemini-4-argon-trial", tokens: tokens))

        // $2 input + $0.50 cache writes + $0.02 cache reads + $5 output.
        XCTAssertEqual(cost, 7.52, accuracy: 0.000_001)
    }
}
