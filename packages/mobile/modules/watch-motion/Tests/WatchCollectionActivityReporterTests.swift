import Foundation
import XCTest
@testable import WatchMotionLib

final class WatchCollectionActivityReporterTests: XCTestCase {
    func testOnlyConfirmedUnexpiredWatchRecordingCountsAsCollection() {
        let center = NotificationCenter()
        let now = Date(timeIntervalSince1970: 20_000)
        var context: [String: Any] = [:]
        var syncEnabled = true
        var cutoff: Date?
        let reporter = WatchCollectionActivityReporter(
            notificationCenter: center,
            recordingContext: { context },
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
            isSyncEnabled: { true },
            deviceErasureCutoff: { nil },
            now: { Date(timeIntervalSince1970: 20_000) }
        )
        XCTAssertNotNil(reporter)
        XCTAssertTrue(isActive(center))
        reporter = nil
        XCTAssertFalse(isActive(center))
    }

    private func isActive(_ center: NotificationCenter) -> Bool {
        let sources = NSMutableSet()
        center.post(name: Notification.Name("Dofek.collectionActivityRequested"), object: sources)
        return sources.contains("watch-motion")
    }
}
