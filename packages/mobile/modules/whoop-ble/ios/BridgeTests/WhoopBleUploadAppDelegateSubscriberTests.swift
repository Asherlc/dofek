import UIKit
import XCTest
@testable import ExpoWhoopBle

final class WhoopBleUploadAppDelegateSubscriberTests: XCTestCase {
    @MainActor
    func testUnrelatedBackgroundSessionInvokesCompletion() {
        let subscriber = WhoopBleUploadAppDelegateSubscriber()
        let completed = expectation(description: "Unrelated session completion is released")
        completed.assertForOverFulfill = true

        subscriber.application(
            UIApplication.shared,
            handleEventsForBackgroundURLSession: "app.dofek.another-module.upload",
            completionHandler: { completed.fulfill() }
        )

        wait(for: [completed], timeout: 1)
    }
}
