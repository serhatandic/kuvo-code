import XCTest
@testable import UsageKit

final class ProviderParseTests: XCTestCase {
    func testURLFormEncodingPreservesOnlyRFC3986UnreservedASCII() {
        XCTAssertEqual("AZaz09-._~".urlFormEncoded, "AZaz09-._~")
        XCTAssertEqual(
            "space & equals= plus+ slash/ question? percent%".urlFormEncoded,
            "space%20%26%20equals%3D%20plus%2B%20slash%2F%20question%3F%20percent%25"
        )
        XCTAssertEqual("café".urlFormEncoded, "caf%C3%A9")
    }

    func testNumberDistinguishesJSONBooleansFromNumbers() throws {
        let object = try XCTUnwrap(ProviderParse.jsonObject(Data(
            #"{"true":true,"false":false,"one":1,"zero":0,"decimal":1.5,"string":" 2.5 "}"#.utf8
        )))

        XCTAssertNil(ProviderParse.number(object["true"]))
        XCTAssertNil(ProviderParse.number(object["false"]))
        XCTAssertEqual(ProviderParse.number(object["one"]), 1)
        XCTAssertEqual(ProviderParse.number(object["zero"]), 0)
        XCTAssertEqual(ProviderParse.number(object["decimal"]), 1.5)
        XCTAssertEqual(ProviderParse.number(object["string"]), 2.5)
        XCTAssertEqual(ProviderParse.bool(object["true"]), true)
    }
}
