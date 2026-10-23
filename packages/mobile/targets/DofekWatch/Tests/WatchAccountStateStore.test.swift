#if canImport(XCTest)
@testable import DofekWatchTransferCore
import Foundation
import XCTest

final class WatchAccountStateStoreTests: XCTestCase {
    func testGyroscopeRecordingContextDoesNotRequireAnAccelerometerWindow() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)

        let context = store.recordingContext(
            at: Date(timeIntervalSince1970: 10_100),
            recorderAvailable: false,
            authorized: false,
            gyroscopeStartedAt: Date(timeIntervalSince1970: 10_000),
            altimeterStartedAt: nil
        )

        XCTAssertEqual(context, [
            "recordingStartedAt": 0, "recordingUntil": 0,
            "gyroscopeStartedAt": 10_000, "altimeterStartedAt": 0,
        ])
    }

    func testAltimeterRecordingContextDoesNotRequireAnAccelerometerWindow() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)

        let context = store.recordingContext(
            at: Date(timeIntervalSince1970: 10_100),
            recorderAvailable: false,
            authorized: false,
            gyroscopeStartedAt: nil,
            altimeterStartedAt: Date(timeIntervalSince1970: 10_000)
        )

        XCTAssertEqual(context, [
            "recordingStartedAt": 0, "recordingUntil": 0,
            "gyroscopeStartedAt": 0, "altimeterStartedAt": 10_000,
        ])
    }

    func testForegroundRecordersRemainReportedAfterTheAccelerometerWindowExpires() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)
        store.recordRecording(until: Date(timeIntervalSince1970: 53_200))

        let context = store.recordingContext(
            at: Date(timeIntervalSince1970: 53_200),
            recorderAvailable: true,
            authorized: true,
            gyroscopeStartedAt: Date(timeIntervalSince1970: 53_100),
            altimeterStartedAt: Date(timeIntervalSince1970: 53_150)
        )

        XCTAssertEqual(context, [
            "recordingStartedAt": 0, "recordingUntil": 0,
            "gyroscopeStartedAt": 53_100, "altimeterStartedAt": 53_150,
        ])
    }

    func testStoppingForegroundRecordersClearsTheirPublishedContext() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)
        let now = Date(timeIntervalSince1970: 10_100)
        let startedAt = Date(timeIntervalSince1970: 10_000)
        let active = store.recordingContext(
            at: now, recorderAvailable: false, authorized: false,
            gyroscopeStartedAt: startedAt, altimeterStartedAt: startedAt
        )
        XCTAssertEqual(active["gyroscopeStartedAt"], 10_000)
        XCTAssertEqual(active["altimeterStartedAt"], 10_000)

        let stopped = store.recordingContext(
            at: now, recorderAvailable: false, authorized: false,
            gyroscopeStartedAt: nil, altimeterStartedAt: nil
        )

        XCTAssertEqual(stopped["gyroscopeStartedAt"], 0)
        XCTAssertEqual(stopped["altimeterStartedAt"], 0)
    }

    func testAccountSyncAndErasureCutoffGateEveryRecordingSource() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)
        let cutoff = Date(timeIntervalSince1970: 10_000)
        let now = Date(timeIntervalSince1970: 10_100)
        store.purge(at: cutoff)
        let disabled = store.recordingContext(
            at: now, recorderAvailable: true, authorized: true,
            gyroscopeStartedAt: Date(timeIntervalSince1970: 10_001),
            altimeterStartedAt: Date(timeIntervalSince1970: 10_002)
        )
        XCTAssertEqual(disabled, [
            "recordingStartedAt": 0, "recordingUntil": 0,
            "gyroscopeStartedAt": 0, "altimeterStartedAt": 0,
        ])

        store.enableSync()
        store.recordRecording(until: Date(timeIntervalSince1970: 53_200))
        let erased = store.recordingContext(
            at: now, recorderAvailable: true, authorized: true,
            gyroscopeStartedAt: Date(timeIntervalSince1970: 9_999), altimeterStartedAt: cutoff
        )
        XCTAssertEqual(erased, [
            "recordingStartedAt": 0, "recordingUntil": 0,
            "gyroscopeStartedAt": 0, "altimeterStartedAt": 0,
        ])

        store.recordRecording(until: Date(timeIntervalSince1970: 53_201))
        let current = store.recordingContext(
            at: now, recorderAvailable: true, authorized: true,
            gyroscopeStartedAt: Date(timeIntervalSince1970: 10_001),
            altimeterStartedAt: Date(timeIntervalSince1970: 10_002)
        )
        XCTAssertEqual(current, [
            "recordingStartedAt": 10_001, "recordingUntil": 53_201,
            "gyroscopeStartedAt": 10_001, "altimeterStartedAt": 10_002,
        ])
    }

    func testInvalidOrFutureForegroundStartDatesPublishInactiveContext() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)
        for timestamp in [Double.nan, .infinity, 0, 10_101] {
            let context = store.recordingContext(
                at: Date(timeIntervalSince1970: 10_100),
                recorderAvailable: false,
                authorized: false,
                gyroscopeStartedAt: Date(timeIntervalSince1970: timestamp),
                altimeterStartedAt: Date(timeIntervalSince1970: timestamp)
            )
            XCTAssertEqual(context["gyroscopeStartedAt"], 0)
            XCTAssertEqual(context["altimeterStartedAt"], 0)
        }
    }

    func testRecordingContextPublishesTheActualWindowAndExpiresAtItsDeadline() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)
        let start = Date(timeIntervalSince1970: 10_000)
        let end = Date(timeIntervalSince1970: 53_200)

        XCTAssertEqual(
            store.recordingContext(at: start, recorderAvailable: true, authorized: true, gyroscopeStartedAt: nil, altimeterStartedAt: nil),
            ["recordingStartedAt": 0, "recordingUntil": 0, "gyroscopeStartedAt": 0, "altimeterStartedAt": 0]
        )
        store.recordRecording(until: end)
        XCTAssertEqual(
            store.recordingContext(at: start, recorderAvailable: true, authorized: true, gyroscopeStartedAt: nil, altimeterStartedAt: nil),
            [
                "recordingStartedAt": 10_000, "recordingUntil": 53_200,
                "gyroscopeStartedAt": 0, "altimeterStartedAt": 0,
            ]
        )
        XCTAssertEqual(
            store.recordingContext(at: end, recorderAvailable: true, authorized: true, gyroscopeStartedAt: nil, altimeterStartedAt: nil),
            ["recordingStartedAt": 0, "recordingUntil": 0, "gyroscopeStartedAt": 0, "altimeterStartedAt": 0]
        )
    }

    func testRevokedAuthorizationClearsThePublishedWindowUntilRecordingRestarts() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)
        let start = Date(timeIntervalSince1970: 10_000)
        store.recordRecording(until: Date(timeIntervalSince1970: 53_200))

        XCTAssertEqual(
            store.recordingContext(at: start, recorderAvailable: true, authorized: false, gyroscopeStartedAt: nil, altimeterStartedAt: nil),
            ["recordingStartedAt": 0, "recordingUntil": 0, "gyroscopeStartedAt": 0, "altimeterStartedAt": 0]
        )
        XCTAssertFalse(store.isRecordingActive(at: start))
        XCTAssertEqual(
            store.recordingContext(at: start, recorderAvailable: true, authorized: true, gyroscopeStartedAt: nil, altimeterStartedAt: nil),
            ["recordingStartedAt": 0, "recordingUntil": 0, "gyroscopeStartedAt": 0, "altimeterStartedAt": 0]
        )
        store.recordRecording(until: Date(timeIntervalSince1970: 53_201))
        XCTAssertEqual(
            store.recordingContext(
                at: Date(timeIntervalSince1970: 10_001), recorderAvailable: true, authorized: true,
                gyroscopeStartedAt: nil, altimeterStartedAt: nil
            ),
            ["recordingStartedAt": 10_001, "recordingUntil": 53_201, "gyroscopeStartedAt": 0, "altimeterStartedAt": 0]
        )
    }

    func testUnavailableRecorderClearsThePublishedWindow() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)
        let start = Date(timeIntervalSince1970: 10_000)
        store.recordRecording(until: Date(timeIntervalSince1970: 53_200))

        XCTAssertEqual(
            store.recordingContext(at: start, recorderAvailable: false, authorized: true, gyroscopeStartedAt: nil, altimeterStartedAt: nil),
            ["recordingStartedAt": 0, "recordingUntil": 0, "gyroscopeStartedAt": 0, "altimeterStartedAt": 0]
        )
        XCTAssertFalse(store.isRecordingActive(at: start))
    }

    func testAccountPurgePublishesAnInactiveWindowAfterSyncIsReenabled() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)
        let start = Date(timeIntervalSince1970: 10_000)
        store.recordRecording(until: Date(timeIntervalSince1970: 53_200))

        store.purge(at: start)
        store.enableSync()

        XCTAssertEqual(
            store.recordingContext(at: start, recorderAvailable: true, authorized: true, gyroscopeStartedAt: nil, altimeterStartedAt: nil),
            ["recordingStartedAt": 0, "recordingUntil": 0, "gyroscopeStartedAt": 0, "altimeterStartedAt": 0]
        )
    }

    func testRecordingWindowExpiresAndIsClearedByAccountPurge() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)
        let start = Date(timeIntervalSince1970: 10_000)
        let end = start.addingTimeInterval(43_200)

        XCTAssertFalse(store.isRecordingActive(at: start))
        store.recordRecording(until: end)
        XCTAssertTrue(store.isRecordingActive(at: start))
        XCTAssertFalse(store.isRecordingActive(at: end))
        XCTAssertEqual(WatchAccountStateStore(defaults: defaults).recordingDeadline, end)

        store.purge(at: start.addingTimeInterval(1))
        store.enableSync()
        XCTAssertNil(store.recordingDeadline)
        XCTAssertFalse(store.isRecordingActive(at: start))
    }

    func testPurgeDisablesSyncAndRetainsMonotonicDeviceCutoff() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)

        store.purge(at: Date(timeIntervalSince1970: 2_000))
        store.purge(at: Date(timeIntervalSince1970: 1_000))

        XCTAssertFalse(store.isSyncEnabled)
        XCTAssertEqual(store.deviceErasureCutoff, Date(timeIntervalSince1970: 2_000))
        store.enableSync()
        XCTAssertTrue(store.isSyncEnabled)
        XCTAssertEqual(store.deviceErasureCutoff, Date(timeIntervalSince1970: 2_000))
    }
}
#endif
