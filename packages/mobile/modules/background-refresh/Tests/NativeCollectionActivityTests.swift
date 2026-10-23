import Foundation
import XCTest
@testable import BackgroundRefreshLib

final class NativeCollectionActivityTests: XCTestCase {
    func testNoNativeCollectorMeansNoActiveCollection() {
        XCTAssertFalse(NativeCollectionActivity.isActive(notificationCenter: NotificationCenter()))
    }

    func testQueriesEveryCollectorSynchronously() {
        let center = NotificationCenter()
        let state = ActivityState()
        let observers = ["whoop", "ble-heart-rate", "core-motion", "watch-motion"].map { source in
            center.addObserver(
                forName: Notification.Name("Dofek.collectionActivityRequested"),
                object: nil,
                queue: nil
            ) { notification in
                state.sourcesObserved.insert(source)
                (notification.object as? NSMutableSet)?.add(source)
            }
        }
        defer { observers.forEach(center.removeObserver) }

        XCTAssertTrue(NativeCollectionActivity.isActive(notificationCenter: center))
        XCTAssertEqual(state.sourcesObserved, ["whoop", "ble-heart-rate", "core-motion", "watch-motion"])
    }

    func testEachQueryUsesCurrentNativeState() {
        let center = NotificationCenter()
        let state = ActivityState()
        let observer = center.addObserver(
            forName: Notification.Name("Dofek.collectionActivityRequested"),
            object: nil,
            queue: nil
        ) { notification in
            if state.collecting { (notification.object as? NSMutableSet)?.add("core-motion") }
        }
        defer { center.removeObserver(observer) }

        XCTAssertTrue(NativeCollectionActivity.isActive(notificationCenter: center))
        state.collecting = false
        XCTAssertFalse(NativeCollectionActivity.isActive(notificationCenter: center))
    }
}

private final class ActivityState {
    var collecting = true
    var sourcesObserved: Set<String> = []
}
