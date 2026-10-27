import Foundation
import XCTest

@testable import CoreMotionLib

final class CoreMotionAccountStateStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "CoreMotionAccountStateStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testRejectedRecordingRequestDoesNotCreateAnActiveWindow() {
        let now = Date(timeIntervalSince1970: 1_000)
        let store = CoreMotionAccountStateStore(userDefaults: defaults, now: { now })

        store.recordingStarted(forDuration: 60, authorized: false)

        XCTAssertFalse(store.isRecordingActive)
        XCTAssertFalse(
            CoreMotionAccountStateStore(userDefaults: defaults, now: { now }).isRecordingActive
        )
    }

    func testDeniedRestartClearsThePreviouslyAuthorizedRecordingWindow() {
        let now = Date(timeIntervalSince1970: 1_000)
        let store = CoreMotionAccountStateStore(userDefaults: defaults, now: { now })
        store.recordingStarted(forDuration: 60, authorized: true)
        XCTAssertTrue(store.isRecordingActive)

        store.recordingStarted(forDuration: 60, authorized: false)

        XCTAssertFalse(store.isRecordingActive)
        XCTAssertFalse(
            CoreMotionAccountStateStore(userDefaults: defaults, now: { now }).isRecordingActive
        )
    }

    func testRecordingStartsWithTheRequestedDeadlineAndSurvivesStoreRecreation() {
        let now = Date(timeIntervalSince1970: 1_000)
        let store = CoreMotionAccountStateStore(userDefaults: defaults, now: { now })
        XCTAssertFalse(store.isRecordingActive)

        store.recordingStarted(forDuration: 60, authorized: true)

        XCTAssertTrue(store.isRecordingActive)
        XCTAssertEqual(
            defaults.object(forKey: "com.dofek.coreMotion.recordingDeadline") as? Date,
            Date(timeIntervalSince1970: 1_060)
        )
        XCTAssertTrue(
            CoreMotionAccountStateStore(userDefaults: defaults, now: { now }).isRecordingActive
        )
    }

    func testRecordingExpiresAtItsDeadline() {
        var now = Date(timeIntervalSince1970: 1_000)
        let store = CoreMotionAccountStateStore(userDefaults: defaults, now: { now })
        store.recordingStarted(forDuration: 60, authorized: true)

        now = Date(timeIntervalSince1970: 1_059.999)
        XCTAssertTrue(store.isRecordingActive)
        now = Date(timeIntervalSince1970: 1_060)
        XCTAssertFalse(store.isRecordingActive)
        now = Date(timeIntervalSince1970: 1_061)
        XCTAssertFalse(store.isRecordingActive)
    }

    func testRenewingRecordingUsesTheNewStartTimeAndDuration() {
        var now = Date(timeIntervalSince1970: 1_000)
        let store = CoreMotionAccountStateStore(userDefaults: defaults, now: { now })
        store.recordingStarted(forDuration: 60, authorized: true)
        now = Date(timeIntervalSince1970: 1_030)

        store.recordingStarted(forDuration: 60, authorized: true)

        now = Date(timeIntervalSince1970: 1_060)
        XCTAssertTrue(store.isRecordingActive)
        now = Date(timeIntervalSince1970: 1_090)
        XCTAssertFalse(store.isRecordingActive)
    }

    func testRecordingDeadlineDoesNotExceedTheNativeTwelveHourLimit() {
        var now = Date(timeIntervalSince1970: 1_000)
        let store = CoreMotionAccountStateStore(userDefaults: defaults, now: { now })
        store.recordingStarted(forDuration: 86_400, authorized: true)

        now = Date(timeIntervalSince1970: 44_199.999)
        XCTAssertTrue(store.isRecordingActive)
        now = Date(timeIntervalSince1970: 44_200)
        XCTAssertFalse(store.isRecordingActive)
    }

    func testPurgeEndsAnUnexpiredRecordingSession() {
        let now = Date(timeIntervalSince1970: 1_000)
        let store = CoreMotionAccountStateStore(userDefaults: defaults, now: { now })
        store.recordingStarted(forDuration: 60, authorized: true)

        store.purge(at: now)

        XCTAssertFalse(store.isRecordingActive)
        XCTAssertFalse(
            CoreMotionAccountStateStore(userDefaults: defaults, now: { now }).isRecordingActive
        )
    }

    func testPurgeRemovesAccountStateAndPersistsDeviceErasureCutoff() {
        defaults.set(
            "2026-07-26T12:00:00.000Z",
            forKey: CoreMotionAccountStateStore.lastSyncKey
        )
        defaults.set(
            Date(timeIntervalSince1970: 1_785_110_400),
            forKey: "com.dofek.coreMotion.recordingDeadline"
        )
        defaults.set("keep", forKey: "unrelated_setting")
        let cutoff = Date(timeIntervalSince1970: 1_785_067_200)

        CoreMotionAccountStateStore(userDefaults: defaults).purge(at: cutoff)

        XCTAssertNil(defaults.object(forKey: CoreMotionAccountStateStore.lastSyncKey))
        XCTAssertNil(defaults.object(forKey: "com.dofek.coreMotion.recordingDeadline"))
        XCTAssertEqual(
            CoreMotionAccountStateStore(userDefaults: defaults).deviceErasureCutoff,
            cutoff
        )
        XCTAssertEqual(defaults.string(forKey: "unrelated_setting"), "keep")
    }

    func testPurgeNeverMovesDeviceErasureCutoffBackward() {
        let store = CoreMotionAccountStateStore(userDefaults: defaults)
        let laterCutoff = Date(timeIntervalSince1970: 2_000)
        store.purge(at: laterCutoff)

        store.purge(at: Date(timeIntervalSince1970: 1_000))

        XCTAssertEqual(store.deviceErasureCutoff, laterCutoff)
    }

    func testLaterAccountStartsAtCutoffAndOnlyIncludesNewSamples() {
        let store = CoreMotionAccountStateStore(userDefaults: defaults)
        let cutoff = Date(timeIntervalSince1970: 2_000)
        store.purge(at: cutoff)

        XCTAssertEqual(
            store.effectiveSyncStart(Date(timeIntervalSince1970: 1_000)),
            cutoff
        )
        XCTAssertFalse(store.shouldInclude(sampleDate: Date(timeIntervalSince1970: 1_999)))
        XCTAssertFalse(store.shouldInclude(sampleDate: cutoff))
        XCTAssertTrue(store.shouldInclude(sampleDate: Date(timeIntervalSince1970: 2_001)))
    }
}
