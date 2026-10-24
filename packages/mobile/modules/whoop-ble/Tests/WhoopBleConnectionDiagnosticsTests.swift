import XCTest
@testable import WhoopBLE

final class WhoopBleConnectionDiagnosticsTests: XCTestCase {
    func testEventsSurviveRecreationWithStableIdentityAndNativeOccurrenceTime() throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let date = Date(timeIntervalSince1970: 1_792_800_000)
        let journal = WhoopBleConnectionDiagnostics(diagnosticDefaults: defaults, now: { date })
        journal.record(event: "disconnected", connectionState: "streaming", centralState: "poweredOn",
                       reconnectIntent: true, peripheralId: "strap", error: NSError(
                        domain: "CBErrorDomain", code: 6,
                        userInfo: [NSLocalizedDescriptionKey: "Connection timed out", "payload": "private"]
                       ))
        let original = try XCTUnwrap((journal.payload["events"] as? [[String: Any]])?.first)
        let recreated = WhoopBleConnectionDiagnostics(diagnosticDefaults: defaults)
        let replay = try XCTUnwrap((recreated.payload["events"] as? [[String: Any]])?.first)
        XCTAssertEqual(replay["eventId"] as? String, original["eventId"] as? String)
        XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(replay["nativeSessionId"] as? String)))
        XCTAssertEqual(replay["processId"] as? Int, Int(ProcessInfo.processInfo.processIdentifier))
        XCTAssertEqual(replay["occurredAt"] as? String, "2026-10-24T00:00:00.000Z")
        XCTAssertEqual(replay["errorDomain"] as? String, "CBErrorDomain")
        XCTAssertEqual(replay["errorCode"] as? Int, 6)
        XCTAssertEqual(replay["errorDescription"] as? String, "Connection timed out")
        XCTAssertFalse(String(describing: recreated.payload).contains("private"))
        XCTAssertEqual((recreated.payload["events"] as? [[String: Any]])?.count, 1)
    }

    func testHistoryIsBoundedAndReadsDoNotConsumeIt() {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let journal = WhoopBleConnectionDiagnostics(diagnosticDefaults: defaults)
        for index in 0..<67 {
            journal.record(event: "central_state", connectionState: "idle", centralState: "poweredOff",
                           reconnectIntent: false, reason: String(index))
        }
        let events = journal.payload["events"] as? [[String: Any]]
        XCTAssertEqual(events?.count, 64)
        XCTAssertEqual(events?.first?["reason"] as? String, "3")
        XCTAssertEqual(journal.payload["overflowCount"] as? Int, 3)
        let recreated = WhoopBleConnectionDiagnostics(diagnosticDefaults: defaults)
        XCTAssertEqual((recreated.payload["events"] as? [[String: Any]])?.count, 64)
        XCTAssertEqual(recreated.payload["overflowCount"] as? Int, 3)
        journal.clear()
        let cleared = WhoopBleConnectionDiagnostics(diagnosticDefaults: defaults)
        XCTAssertEqual((cleared.payload["events"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(cleared.payload["overflowCount"] as? Int, 0)
    }
}
