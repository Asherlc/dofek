import Foundation
import XCTest
@testable import WatchMotionLib

final class WatchCollectionActivityReporterTests: XCTestCase {
    func testConfirmedBackgroundRecordingDoesNotRequireWatchReachability() {
        let center = NotificationCenter()
        let now = Date(timeIntervalSince1970: 20_000)
        var context: [String: Any] = [:]
        var syncEnabled = true
        var cutoff: Date?
        let reporter = WatchCollectionActivityReporter(
            notificationCenter: center,
            recordingContext: { context },
            isWatchReachable: { false },
            isSyncEnabled: { syncEnabled },
            deviceErasureCutoff: { cutoff },
            now: { now }
        )
        withExtendedLifetime(reporter) {
            XCTAssertFalse(isActive(center))
            context = ["recordingStartedAt": 10_000.0, "recordingUntil": 30_000.0]
            XCTAssertTrue(isActive(center))
            syncEnabled = false
            XCTAssertFalse(isActive(center))
            syncEnabled = true
            cutoff = Date(timeIntervalSince1970: 15_000)
            XCTAssertFalse(isActive(center))
            cutoff = nil
            context["recordingUntil"] = now.timeIntervalSince1970
            XCTAssertFalse(isActive(center))
            context["recordingUntil"] = Double.infinity
            XCTAssertFalse(isActive(center))
            context = ["recordingStartedAt": 40_000.0, "recordingUntil": 30_000.0]
            XCTAssertFalse(isActive(center))
        }
    }

    func testReporterStopsAnsweringWhenReleased() {
        let center = NotificationCenter()
        var reporter: WatchCollectionActivityReporter? = WatchCollectionActivityReporter(
            notificationCenter: center,
            recordingContext: {
                ["recordingStartedAt": 10_000.0, "recordingUntil": 30_000.0]
            },
            isWatchReachable: { false },
            isSyncEnabled: { true },
            deviceErasureCutoff: { nil },
            now: { Date(timeIntervalSince1970: 20_000) }
        )
        XCTAssertNotNil(reporter)
        XCTAssertTrue(isActive(center))
        reporter = nil
        XCTAssertFalse(isActive(center))
    }

    func testForegroundCollectorsCountIndependentlyOfTheAccelerometerWindow() {
        let center = NotificationCenter()
        var context: [String: Any] = ["gyroscopeStartedAt": 19_000.0]
        let reporter = WatchCollectionActivityReporter(
            notificationCenter: center,
            recordingContext: { context },
            isWatchReachable: { true },
            isSyncEnabled: { true },
            deviceErasureCutoff: { nil },
            now: { Date(timeIntervalSince1970: 20_000) }
        )

        withExtendedLifetime(reporter) {
            XCTAssertTrue(isActive(center), "Gyroscope capture does not require accelerometer capture")
            context = ["altimeterStartedAt": 19_000.0]
            XCTAssertTrue(isActive(center), "Altitude capture does not require accelerometer capture")
            context = [
                "recordingStartedAt": 10_000.0,
                "recordingUntil": 15_000.0,
                "gyroscopeStartedAt": 19_000.0,
            ]
            XCTAssertTrue(isActive(center), "An expired accelerometer window must not hide current gyroscope capture")
        }
    }

    func testForegroundCaptureRequiresLiveReachabilityAndAccountSync() {
        let center = NotificationCenter()
        var context: [String: Any] = [:]
        var reachable = true
        var syncEnabled = true
        let reporter = WatchCollectionActivityReporter(
            notificationCenter: center,
            recordingContext: { context },
            isWatchReachable: { reachable },
            isSyncEnabled: { syncEnabled },
            deviceErasureCutoff: { nil },
            now: { Date(timeIntervalSince1970: 20_000) }
        )

        withExtendedLifetime(reporter) {
            for key in ["gyroscopeStartedAt", "altimeterStartedAt"] {
                context = [key: 19_000.0]
                XCTAssertTrue(isActive(center), key)
                reachable = false
                XCTAssertFalse(isActive(center), "An unreachable or inactive Watch cannot confirm \(key)")
                reachable = true
                syncEnabled = false
                XCTAssertFalse(isActive(center), "Account cleanup disables \(key)")
                syncEnabled = true
                context[key] = 0.0
                XCTAssertFalse(isActive(center), "A stopped collector must not count: \(key)")
            }
        }
    }

    func testForegroundDatesRejectErasedFutureAndMalformedSessions() {
        let center = NotificationCenter()
        var context: [String: Any] = [:]
        var cutoff: Date?
        let reporter = WatchCollectionActivityReporter(
            notificationCenter: center,
            recordingContext: { context },
            isWatchReachable: { true },
            isSyncEnabled: { true },
            deviceErasureCutoff: { cutoff },
            now: { Date(timeIntervalSince1970: 20_000) }
        )

        withExtendedLifetime(reporter) {
            for key in ["gyroscopeStartedAt", "altimeterStartedAt"] {
                for invalid: Any in [0.0, -1.0, Double.nan, Double.infinity, 20_001.0, "19000", NSNull()] {
                    context = [key: invalid]
                    XCTAssertFalse(isActive(center), "Invalid \(key): \(invalid)")
                }
                context = [key: 19_000.0]
                cutoff = Date(timeIntervalSince1970: 19_001)
                XCTAssertFalse(isActive(center), "A pre-erasure \(key) must not count")
                cutoff = Date(timeIntervalSince1970: 19_000)
                XCTAssertFalse(isActive(center), "A \(key) at the erasure boundary must not count")
                cutoff = Date(timeIntervalSince1970: 18_999)
                XCTAssertTrue(isActive(center), "A current \(key) after erasure must count")
                cutoff = nil
            }
        }
    }

    private func isActive(_ center: NotificationCenter) -> Bool {
        let sources = NSMutableSet()
        center.post(name: Notification.Name("Dofek.collectionActivityRequested"), object: sources)
        return sources.contains("watch-motion")
    }
}
