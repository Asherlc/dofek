#if canImport(XCTest)
@testable import DofekWatchTransferCore
import Foundation
import XCTest

final class WatchAccountStateStoreTests: XCTestCase {
    func testRecordingContextPublishesTheActualWindowAndExpiresAtItsDeadline() {
        let suite = "WatchAccountStateStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WatchAccountStateStore(defaults: defaults)
        let start = Date(timeIntervalSince1970: 10_000)
        let end = Date(timeIntervalSince1970: 53_200)

        XCTAssertEqual(
            store.recordingContext(at: start, recorderAvailable: true, authorized: true),
            ["recordingStartedAt": 0, "recordingUntil": 0]
        )
        store.recordRecording(until: end)
        XCTAssertEqual(
            store.recordingContext(at: start, recorderAvailable: true, authorized: true),
            ["recordingStartedAt": 10_000, "recordingUntil": 53_200]
        )
        XCTAssertEqual(
            store.recordingContext(at: end, recorderAvailable: true, authorized: true),
            ["recordingStartedAt": 0, "recordingUntil": 0]
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
            store.recordingContext(at: start, recorderAvailable: true, authorized: false),
            ["recordingStartedAt": 0, "recordingUntil": 0]
        )
        XCTAssertFalse(store.isRecordingActive(at: start))
        XCTAssertEqual(
            store.recordingContext(at: start, recorderAvailable: true, authorized: true),
            ["recordingStartedAt": 0, "recordingUntil": 0]
        )
        store.recordRecording(until: Date(timeIntervalSince1970: 53_201))
        XCTAssertEqual(
            store.recordingContext(
                at: Date(timeIntervalSince1970: 10_001), recorderAvailable: true, authorized: true
            ),
            ["recordingStartedAt": 10_001, "recordingUntil": 53_201]
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
            store.recordingContext(at: start, recorderAvailable: false, authorized: true),
            ["recordingStartedAt": 0, "recordingUntil": 0]
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
            store.recordingContext(at: start, recorderAvailable: true, authorized: true),
            ["recordingStartedAt": 0, "recordingUntil": 0]
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
