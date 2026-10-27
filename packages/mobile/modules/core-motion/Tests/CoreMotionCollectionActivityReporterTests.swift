import Foundation
import XCTest

@testable import CoreMotionLib

final class CoreMotionCollectionActivityReporterTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!
    private var notificationCenter: NotificationCenter!

    override func setUp() {
        super.setUp()
        suiteName = "CoreMotionCollectionActivityReporterTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        notificationCenter = NotificationCenter()
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        notificationCenter = nil
        super.tearDown()
    }

    func testSnapshotSynchronouslyIncludesOnlyAuthorizedUnexpiredRecording() {
        var now = Date(timeIntervalSince1970: 1_000)
        var canRecord = true
        let store = CoreMotionAccountStateStore(userDefaults: defaults, now: { now })
        let reporter = CoreMotionCollectionActivityReporter(
            accountStateStore: store,
            notificationCenter: notificationCenter,
            canRecord: { canRecord }
        )

        withExtendedLifetime(reporter) {
            XCTAssertEqual(snapshotSources(), [])
            store.recordingStarted(forDuration: 60, authorized: true)
            XCTAssertEqual(snapshotSources(), ["core-motion"])

            canRecord = false
            XCTAssertEqual(snapshotSources(), [])
            canRecord = true
            XCTAssertEqual(snapshotSources(), ["core-motion"])

            now = Date(timeIntervalSince1970: 1_060)
            XCTAssertEqual(snapshotSources(), [])
        }
    }

    func testPurgedAccountStopsReportingAnActiveCollection() {
        let now = Date(timeIntervalSince1970: 1_000)
        let store = CoreMotionAccountStateStore(userDefaults: defaults, now: { now })
        let reporter = CoreMotionCollectionActivityReporter(
            accountStateStore: store,
            notificationCenter: notificationCenter,
            canRecord: { true }
        )
        store.recordingStarted(forDuration: 60, authorized: true)

        withExtendedLifetime(reporter) {
            XCTAssertEqual(snapshotSources(), ["core-motion"])
            store.purge(at: now)
            XCTAssertEqual(snapshotSources(), [])
        }
    }

    func testReporterRemovesItsObserverWhenItsNativeOwnerIsDestroyed() {
        let now = Date(timeIntervalSince1970: 1_000)
        let store = CoreMotionAccountStateStore(userDefaults: defaults, now: { now })
        store.recordingStarted(forDuration: 60, authorized: true)
        var reporter: CoreMotionCollectionActivityReporter? = CoreMotionCollectionActivityReporter(
            accountStateStore: store,
            notificationCenter: notificationCenter,
            canRecord: { true }
        )
        withExtendedLifetime(reporter) {
            XCTAssertEqual(snapshotSources(), ["core-motion"])
        }

        reporter = nil

        XCTAssertEqual(snapshotSources(), [])
    }

    private func snapshotSources() -> Set<String> {
        let sources = NSMutableSet()
        notificationCenter.post(
            name: Notification.Name("Dofek.collectionActivityRequested"),
            object: sources
        )
        return Set(sources.compactMap { $0 as? String })
    }
}
