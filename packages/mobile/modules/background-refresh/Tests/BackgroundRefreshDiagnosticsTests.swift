import XCTest
@testable import BackgroundRefreshLib

final class BackgroundRefreshDiagnosticsTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "background-refresh-tests-\(UUID().uuidString)")!
    }

    override func tearDown() {
        for key in defaults.dictionaryRepresentation().keys { defaults.removeObject(forKey: key) }
        defaults = nil
        super.tearDown()
    }

    func testRetainsStableEventsAcrossRecreationAndReadsDoNotConsume() throws {
        let journal = BackgroundRefreshDiagnostics(userDefaults: defaults, now: { Date(timeIntervalSince1970: 42) })
        journal.record("task_launched", fields: .init(taskId: "11111111-1111-4111-8111-111111111111"))
        let first = journal.payload
        let recreated = BackgroundRefreshDiagnostics(userDefaults: defaults)
        let event = try XCTUnwrap((recreated.payload["events"] as? [[String: Any]])?.first)
        let original = try XCTUnwrap((first["events"] as? [[String: Any]])?.first)
        XCTAssertEqual(event["eventId"] as? String, original["eventId"] as? String)
        XCTAssertEqual(event["nativeSessionId"] as? String, original["nativeSessionId"] as? String)
        XCTAssertEqual(event["occurredAt"] as? String, "1970-01-01T00:00:42.000Z")
        XCTAssertEqual(event["processId"] as? Int, Int(ProcessInfo.processInfo.processIdentifier))
        XCTAssertEqual((journal.payload["events"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual((recreated.payload["events"] as? [[String: Any]])?.count, 1)
    }

    func testBoundsHistoryAndClearsPersistedOverflow() throws {
        let journal = BackgroundRefreshDiagnostics(userDefaults: defaults)
        for index in 0..<70 {
            let taskId = String(format: "00000000-0000-4000-8000-%012d", index)
            journal.record("schedule_requested", fields: .init(taskId: taskId))
        }
        let events = try XCTUnwrap(journal.payload["events"] as? [[String: Any]])
        XCTAssertEqual(events.count, 64)
        XCTAssertEqual(events.first?["taskId"] as? String, "00000000-0000-4000-8000-000000000006")
        XCTAssertEqual(journal.payload["overflowCount"] as? Int, 6)
        XCTAssertEqual(BackgroundRefreshDiagnostics(userDefaults: defaults).payload["overflowCount"] as? Int, 6)
        journal.clear()
        let recreated = BackgroundRefreshDiagnostics(userDefaults: defaults)
        XCTAssertEqual((recreated.payload["events"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(recreated.payload["overflowCount"] as? Int, 0)
    }

    func testRecordsOnlyTypedLifecycleAndStructuredErrorMetadata() throws {
        let journal = BackgroundRefreshDiagnostics(userDefaults: defaults)
        journal.record("schedule_failed", fields: .init(
            taskIdentifier: "com.dofek.accelerometer-refresh", earliestBeginAt: Date(timeIntervalSince1970: 900),
            success: false, reason: "submit_failed", backgroundRefreshStatus: "denied", lowPowerModeEnabled: true,
            error: NSError(domain: "BGTaskSchedulerErrorDomain", code: 1)
        ))
        let event = try XCTUnwrap((journal.payload["events"] as? [[String: Any]])?.first)
        XCTAssertEqual(event["errorDomain"] as? String, "BGTaskSchedulerErrorDomain")
        XCTAssertEqual(event["errorCode"] as? Int, 1)
        XCTAssertNotNil(event["errorDescription"] as? String)
        XCTAssertEqual(event["earliestBeginAt"] as? String, "1970-01-01T00:15:00.000Z")
        XCTAssertEqual(event["backgroundRefreshStatus"] as? String, "denied")
        XCTAssertEqual(event["lowPowerModeEnabled"] as? Bool, true)
        XCTAssertEqual(event["success"] as? Bool, false)
    }

    func testUntrustedTaskIdsCannotPersistCredentials() throws {
        let journal = BackgroundRefreshDiagnostics(userDefaults: defaults)
        journal.record("js_received", fields: .init(taskId: "private-token"))
        journal.record("js_received", fields: .init(taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
        let events = try XCTUnwrap(journal.payload["events"] as? [[String: Any]])
        XCTAssertNil(events[0]["taskId"])
        XCTAssertEqual(events[1]["taskId"] as? String, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")
        XCTAssertFalse(String(describing: journal.payload).contains("private-token"))
    }

    func testConcurrentRecordingKeepsBoundedHistoryAndAccurateOverflow() {
        let journal = BackgroundRefreshDiagnostics(userDefaults: defaults)
        DispatchQueue.concurrentPerform(iterations: 100) { _ in journal.record("schedule_requested") }
        XCTAssertEqual((journal.payload["events"] as? [[String: Any]])?.count, 64)
        XCTAssertEqual(journal.payload["overflowCount"] as? Int, 36)
    }
}
