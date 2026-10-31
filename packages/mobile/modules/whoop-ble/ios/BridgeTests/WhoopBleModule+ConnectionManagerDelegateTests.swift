@testable import ExpoModulesCore
import ExpoModulesTestCore
import XCTest
@testable import ExpoWhoopBle

import SQLite3

final class WhoopBleModuleConnectionManagerDelegateTests: XCTestCase {
    func testReadinessAfterCaptureFailureDoesNotPublishOrStartWatchdog() async throws {
        let (context, module) = try makeModule()
        module.failCapture(captureError)
        try await assertReadinessDoesNotActivate(module, context: context)
    }

    func testReadinessSnapshotFailureDoesNotPublishOrRestartWatchdog() async throws {
        let (context, module) = try makeModule()
        let directory = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: false
        )
        let path = directory.appendingPathComponent("WhoopBleUploads/samples.sqlite").path
        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(path, &database), SQLITE_OK)
        defer { sqlite3_close(database) }
        XCTAssertEqual(sqlite3_exec(database, "ALTER TABLE stats RENAME TO unavailable_stats", nil, nil, nil), SQLITE_OK)
        defer {
            XCTAssertEqual(sqlite3_exec(database, "ALTER TABLE unavailable_stats RENAME TO stats", nil, nil, nil), SQLITE_OK)
        }

        try await assertReadinessDoesNotActivate(module, context: context)
        module.connectionManager.syncOnBleQueue {
            XCTAssertTrue(module.captureFailure?.contains("stats") == true)
        }
    }

    private func assertReadinessDoesNotActivate(
        _ module: WhoopBleModule, context: TestAppContext
    ) async throws {
        let runtime = try context.runtime
        try await runtime.execute {
            _ = try runtime.eval("""
                globalThis.connectedEvents = 0;
                expo.modules.WhoopBle.addListener('onConnectionStateChanged', event => {
                    if (event.state === 'connected') globalThis.connectedEvents++;
                });
                """)
        }
        let silence = expectation(description: "Failed capture must not start its watchdog")
        silence.isInverted = true
        let observer = WatchdogSilenceObserver(expectation: silence)
        module.connectionManager.syncOnBleQueue {
            module.watchdog = WhoopBleDataWatchdog(queue: module.connectionManager.bleQueue, timeoutSeconds: 0.01)
            module.watchdog.delegate = observer
            module.connectionManager.setState(.ready)
            module.publishReadyConnection(peripheralId: "test-strap", peripheralName: "WHOOP", wasStreaming: false)
        }
        defer { module.connectionManager.syncOnBleQueue { module.watchdog.stop() } }
        await fulfillment(of: [silence], timeout: 0.1)
        await MainActor.run {}
        let connectedEvents = try await runtime.execute {
            try runtime.eval("String(globalThis.connectedEvents)").asString()
        }
        XCTAssertEqual(connectedEvents, "0")
        module.connectionManager.syncOnBleQueue {
            XCTAssertEqual(module.connectionManager.state, .idle)
            XCTAssertFalse(module.connectionManager.autoReconnect)
        }
    }
}

private final class WatchdogSilenceObserver: WhoopBleDataWatchdogDelegate {
    private let expectation: XCTestExpectation

    init(expectation: XCTestExpectation) { self.expectation = expectation }

    func watchdogDidDetectSilence(_ watchdog: WhoopBleDataWatchdog, retryCount: UInt64) {
        expectation.fulfill()
    }
}
