// @bacons/apple-targets includes all Swift files in the target directory as app
// sources. Name XCTest suites `*.test.swift` so Xcode synchronized-folder
// exclusion matches DofekWatch; compile them only through Package.swift.
#if canImport(XCTest)
@testable import DofekSleepWidgetCore
import Foundation
import XCTest

final class SleepWidgetSnapshotTests: XCTestCase {
    private let sleepData = Data(
        #"{"version":1,"kind":"sleep","date":"2026-11-24","durationMinutes":444,"expiresAt":1795593600000}"#.utf8
    )
    private let emptyData = Data(#"{"version":1,"kind":"empty","expiresAt":1795593600000}"#.utf8)
    private let signedOutData = Data(#"{"version":1,"kind":"signedOut"}"#.utf8)
    private let expiresAt: Int64 = 1_795_593_600_000

    func testDecodesSleepSnapshot() throws {
        let snapshot = try XCTUnwrap(SleepWidgetSnapshot.decode(data: sleepData))
        XCTAssertEqual(
            snapshot,
            .sleep(date: "2026-11-24", durationMinutes: 444, expiresAt: expiresAt)
        )
        XCTAssertEqual(snapshot.destinationURL, URL(string: "dofek://sleep"))
    }

    func testDecodesEmptySnapshot() throws {
        let snapshot = try XCTUnwrap(SleepWidgetSnapshot.decode(data: emptyData))
        XCTAssertEqual(snapshot, .empty(expiresAt: expiresAt))
        XCTAssertEqual(snapshot.destinationURL, URL(string: "dofek://sleep"))
    }

    func testDecodesSignedOutSnapshot() throws {
        let snapshot = try XCTUnwrap(SleepWidgetSnapshot.decode(data: signedOutData))
        XCTAssertEqual(snapshot, .signedOut)
        XCTAssertEqual(snapshot.destinationURL, URL(string: "dofek://login"))
    }

    func testExpiryAtExactBoundaryNeedsUpdate() {
        let before = SleepWidgetSnapshot.resolve(data: sleepData, nowMilliseconds: expiresAt - 1)
        XCTAssertEqual(
            before,
            .sleep(date: "2026-11-24", durationMinutes: 444, expiresAt: expiresAt)
        )

        XCTAssertEqual(
            SleepWidgetSnapshot.resolve(data: sleepData, nowMilliseconds: expiresAt),
            .needsUpdate
        )
        XCTAssertEqual(
            SleepWidgetSnapshot.resolve(data: emptyData, nowMilliseconds: expiresAt),
            .needsUpdate
        )
        XCTAssertEqual(
            SleepWidgetSnapshot.resolve(data: sleepData, nowMilliseconds: expiresAt).destinationURL,
            URL(string: "dofek:///")
        )
    }

    func testSignedOutIgnoresClock() {
        XCTAssertEqual(
            SleepWidgetSnapshot.resolve(data: signedOutData, nowMilliseconds: expiresAt),
            .signedOut
        )
        XCTAssertEqual(
            SleepWidgetSnapshot.resolve(data: signedOutData, nowMilliseconds: expiresAt + 1),
            .signedOut
        )
    }

    func testLockedPlaceholderIsDistinctFromExpiredNeedsUpdate() {
        XCTAssertEqual(SleepWidgetSnapshot.locked.destinationURL, URL(string: "dofek:///"))
        XCTAssertEqual(
            SleepWidgetSnapshot.locked.resolved(nowMilliseconds: expiresAt),
            .locked
        )
        XCTAssertNotEqual(SleepWidgetSnapshot.locked, SleepWidgetSnapshot.needsUpdate)
    }

    func testMissingUnreadableInvalidBecomeNeedsUpdate() {
        XCTAssertEqual(SleepWidgetSnapshot.resolve(data: nil, nowMilliseconds: 0), .needsUpdate)
        XCTAssertEqual(SleepWidgetSnapshot.resolve(data: Data(), nowMilliseconds: 0), .needsUpdate)
        XCTAssertEqual(SleepWidgetSnapshot.resolve(data: Data("{".utf8), nowMilliseconds: 0), .needsUpdate)
        XCTAssertEqual(
            SleepWidgetSnapshot.resolve(data: Data(#"{"version":2,"kind":"sleep"}"#.utf8), nowMilliseconds: 0),
            .needsUpdate
        )
        XCTAssertEqual(
            SleepWidgetSnapshot.resolve(
                data: Data(
                    #"{"version":1,"kind":"sleep","date":"2026-11-24","durationMinutes":444}"#.utf8
                ),
                nowMilliseconds: 0
            ),
            .needsUpdate
        )
        XCTAssertEqual(
            SleepWidgetSnapshot.resolve(data: Data(#"{"version":1,"kind":"unknown"}"#.utf8), nowMilliseconds: 0),
            .needsUpdate
        )
        XCTAssertEqual(
            SleepWidgetSnapshot.resolve(data: nil, nowMilliseconds: 0).destinationURL,
            URL(string: "dofek:///")
        )
    }

    func testRejectsInvalidCalendarDates() {
        XCTAssertNil(
            SleepWidgetSnapshot.decode(
                data: Data(
                    #"{"version":1,"kind":"sleep","date":"2026-02-30","durationMinutes":444,"expiresAt":1795593600000}"#.utf8
                )
            )
        )
        XCTAssertNil(
            SleepWidgetSnapshot.decode(
                data: Data(
                    #"{"version":1,"kind":"sleep","date":"2026-13-01","durationMinutes":444,"expiresAt":1795593600000}"#.utf8
                )
            )
        )
        XCTAssertNil(
            SleepWidgetSnapshot.decode(
                data: Data(
                    #"{"version":1,"kind":"sleep","date":"26-11-24","durationMinutes":444,"expiresAt":1795593600000}"#.utf8
                )
            )
        )
        XCTAssertEqual(
            SleepWidgetSnapshot.resolve(
                data: Data(
                    #"{"version":1,"kind":"sleep","date":"2026-02-30","durationMinutes":444,"expiresAt":1795593600000}"#.utf8
                ),
                nowMilliseconds: 0
            ),
            .needsUpdate
        )
    }

    func testRejectsFractionalAndBooleanNumerics() {
        XCTAssertNil(
            SleepWidgetSnapshot.decode(
                data: Data(
                    #"{"version":1,"kind":"sleep","date":"2026-11-24","durationMinutes":444.5,"expiresAt":1795593600000}"#.utf8
                )
            )
        )
        XCTAssertNil(
            SleepWidgetSnapshot.decode(
                data: Data(
                    #"{"version":1,"kind":"sleep","date":"2026-11-24","durationMinutes":true,"expiresAt":1795593600000}"#.utf8
                )
            )
        )
        XCTAssertNil(
            SleepWidgetSnapshot.decode(
                data: Data(#"{"version":1,"kind":"empty","expiresAt":1795593600000.5}"#.utf8)
            )
        )
        XCTAssertNil(
            SleepWidgetSnapshot.decode(
                data: Data(#"{"version":1,"kind":"empty","expiresAt":false}"#.utf8)
            )
        )
        XCTAssertEqual(
            SleepWidgetSnapshot.resolve(
                data: Data(
                    #"{"version":1,"kind":"sleep","date":"2026-11-24","durationMinutes":444.5,"expiresAt":1795593600000}"#.utf8
                ),
                nowMilliseconds: 0
            ),
            .needsUpdate
        )
    }
}
#endif
