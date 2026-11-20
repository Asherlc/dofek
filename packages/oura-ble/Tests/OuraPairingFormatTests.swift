import Foundation
import XCTest
@testable import OuraBLE

final class OuraPairingFormatTests: XCTestCase {
    func testInitializerGeneratesSixteenByteKeyAndDefaultFlags() throws {
        let serial = "OURA-1234"
        let peripheralID = UUID()

        let pairing = try OuraPairing(serialNumber: serial, peripheralID: peripheralID)

        XCTAssertEqual(pairing.key.count, 16)
        XCTAssertEqual(pairing.serialNumber, serial)
        XCTAssertEqual(pairing.peripheralID, peripheralID)
        XCTAssertFalse(pairing.confirmed)
        XCTAssertFalse(pairing.archived)
    }

    func testDecodesLegacyPairingWithoutFlags() throws {
        let id = UUID()
        let peripheralID = UUID()
        let key = Data(repeating: 0xAB, count: 16)
        let legacy: [String: Any] = [
            "id": id.uuidString,
            "serialNumber": "OURA-legacy",
            "peripheralID": peripheralID.uuidString,
            "key": key.base64EncodedString(),
        ]
        let data = try JSONSerialization.data(withJSONObject: legacy)

        let pairing = try JSONDecoder().decode(OuraPairing.self, from: data)

        XCTAssertEqual(pairing.id, id)
        XCTAssertEqual(pairing.serialNumber, "OURA-legacy")
        XCTAssertEqual(pairing.peripheralID, peripheralID)
        XCTAssertEqual(pairing.key, key)
        XCTAssertFalse(pairing.confirmed)
        XCTAssertFalse(pairing.archived)
    }

    func testRoundTripsAllFields() throws {
        var pairing = try OuraPairing(serialNumber: "OURA-5678", peripheralID: UUID())
        pairing.confirmed = true
        pairing.archived = true

        let data = try JSONEncoder().encode(pairing)
        let decoded = try JSONDecoder().decode(OuraPairing.self, from: data)

        XCTAssertEqual(decoded.id, pairing.id)
        XCTAssertEqual(decoded.serialNumber, pairing.serialNumber)
        XCTAssertEqual(decoded.peripheralID, pairing.peripheralID)
        XCTAssertEqual(decoded.key, pairing.key)
        XCTAssertTrue(decoded.confirmed)
        XCTAssertTrue(decoded.archived)

        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for field in ["id", "serialNumber", "peripheralID", "key", "confirmed", "archived"] {
            XCTAssertNotNil(json[field], "Missing encoded pairing field: \(field)")
        }
    }
}
