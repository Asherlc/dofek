import XCTest
@testable import WhoopBleLib

final class WhoopBleConstantsTests: XCTestCase {

    func testAllServiceUUIDsContainsThreeGenerations() {
        XCTAssertEqual(WhoopBleConstants.allServiceUUIDs.count, 3)
    }

    func testCmdToStrapUUIDForGen4() {
        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: WhoopBleConstants.gen4ServiceUUID)
        XCTAssertEqual(cmdUUID.uuidString, "61080002-8D6D-82B8-614A-1C8CB0F8DCC6")
    }

    func testDataFromStrapUUIDForGen4() {
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: WhoopBleConstants.gen4ServiceUUID)
        XCTAssertEqual(dataUUID.uuidString, "61080005-8D6D-82B8-614A-1C8CB0F8DCC6")
    }

    func testCmdToStrapUUIDForMaverick() {
        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: WhoopBleConstants.maverickServiceUUID)
        XCTAssertEqual(cmdUUID.uuidString, "FD4B0002-CCE1-4033-93CE-002D5875F58A")
    }

    func testDataFromStrapUUIDForMaverick() {
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: WhoopBleConstants.maverickServiceUUID)
        XCTAssertEqual(dataUUID.uuidString, "FD4B0005-CCE1-4033-93CE-002D5875F58A")
    }

    func testCmdToStrapUUIDForPuffin() {
        let cmdUUID = WhoopBleConstants.cmdToStrapUUID(forService: WhoopBleConstants.puffinServiceUUID)
        XCTAssertEqual(cmdUUID.uuidString, "11500002-6215-11EE-8C99-0242AC120002")
    }

    func testDataFromStrapUUIDForPuffin() {
        let dataUUID = WhoopBleConstants.dataFromStrapUUID(forService: WhoopBleConstants.puffinServiceUUID)
        XCTAssertEqual(dataUUID.uuidString, "11500005-6215-11EE-8C99-0242AC120002")
    }
}
