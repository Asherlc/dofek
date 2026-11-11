@testable import ExpoModulesCore
import ExpoModulesTestCore
import RNSentry
import XCTest
@testable import ExpoWhoopBle

final class WhoopBleModuleTests: XCTestCase {
    func testCleanupLeavesJavaScriptResponsiveWhileWaitingForBleQueue() async throws {
        let logs = CleanupLogRecorder()
        let entered = expectation(description: "Native cleanup entry while BLE queue is occupied")
        await logs.start(entry: entered)
        defer { SentrySDK.close() }
        let (context, module) = try makeModule()
        let runtime = try context.runtime
        let blocked = expectation(description: "BLE queue occupied")
        let release = DispatchSemaphore(value: 0)
        module.connectionManager.bleQueue.async {
            blocked.fulfill()
            release.wait()
        }
        defer { release.signal() }
        await fulfillment(of: [blocked], timeout: 5)

        let returned = expectation(description: "Native bridge returns before cleanup completes")
        let cleanup = Task {
            try await runtime.execute {
                _ = try runtime.eval("""
                    globalThis.cleanupFinished = false;
                    globalThis.cleanupPromise = Promise.resolve(expo.modules.WhoopBle.disableUploads()).then(() => {
                        globalThis.cleanupFinished = true;
                        return 'cleanup-completed';
                    });
                    globalThis.summaryPromise = Promise.resolve(expo.modules.WhoopBle.getDeviceSummary());
                    """)
            }
            returned.fulfill()
        }
        await fulfillment(of: [entered], timeout: 5)
        XCTAssertEqual(logs.snapshot.map { $0.attributes["stage"]?.value as? String }, ["ble_suspend"])
        let response = await XCTWaiter.fulfillment(of: [returned], timeout: 5)
        XCTAssertEqual(response, .completed)
        guard response == .completed else {
            release.signal()
            try await cleanup.value
            return
        }
        try await runtime.execute {
            XCTAssertEqual(try runtime.eval("1 + 1").asInt(), 2)
            XCTAssertFalse(try runtime.eval("globalThis.cleanupFinished").asBool())
        }
        release.signal()
        try await cleanup.value
        let completed = try await runtime.evalAsync("globalThis.cleanupPromise").ref()
        let result = try await runtime.execute { try completed.take().asString() }
        XCTAssertEqual(result, "cleanup-completed")
        let summary = try await runtime.evalAsync("globalThis.summaryPromise.then(value => value.imuBufferedSamples)").ref()
        let count = try await runtime.execute { try summary.take().asInt() }
        XCTAssertEqual(count, 0)

        let records = logs.snapshot
        XCTAssertEqual(records.map { $0.attributes["stage"]?.value as? String }, [
            "ble_suspend", "disconnect", "uploader_bootstrap", "uploader_disable",
            "uploader_queue_wait", "uploader_cancel_tasks", "uploader_store_purge",
            "store_lock_wait", "store_begin", "store_reset_stats", "store_delete_samples",
            "store_delete_batches", "store_clear_binding", "store_rotate_generation",
            "store_commit", "store_completed",
            "uploader_remove_bodies", "completed"
        ])
        try logs.assertOperationMetadata()
        module.connectionManager.syncOnBleQueue { XCTAssertTrue(module.captureSuspended) }
    }

    func testExplicitConnectRejectsRetainedCaptureFailure() async throws {
        let (context, module) = try makeModule()
        module.failCapture(captureError)
        let rejection = try await outcome("connect('invalid-peripheral-id')", in: context)
        XCTAssertTrue(rejection.contains("WHOOP_BLE_CAPTURE_FAILED"), rejection)
        XCTAssertTrue(rejection.contains("The capture database is unavailable"), rejection)
    }

    func testCleanupFailureLogsTheStageAndStillThrows() async throws {
        let logs = CleanupLogRecorder()
        await MainActor.run {
            SentrySDK.start { options in
                options.dsn = "https://key@sentry.example/123"
                options.beforeSend = { _ in nil }
                options.beforeSendLog = { log in
                    if log.attributes["operation"]?.value as? String == "disableUploads" { logs.append(log) }
                    return nil
                }
            }
        }
        defer { SentrySDK.close() }
        let (context, module) = try makeModule()
        _ = try module.uploader
        let directory = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ).appendingPathComponent("WhoopBleUploads/bodies")
        let backup = directory.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
        try FileManager.default.moveItem(at: directory, to: backup)
        defer {
            if FileManager.default.fileExists(atPath: directory.path) {
                XCTAssertNoThrow(try FileManager.default.removeItem(at: directory))
            }
            XCTAssertNoThrow(try FileManager.default.moveItem(at: backup, to: directory))
        }
        try Data().write(to: directory)
        let rejection = try await outcome("disableUploads()", in: context)
        XCTAssertNotEqual(rejection, "unexpected success")
        let failure = try XCTUnwrap(logs.snapshot.last)
        XCTAssertEqual(failure.attributes["stage"]?.value as? String, "failed")
        XCTAssertEqual(failure.attributes["failedStage"]?.value as? String, "uploader_remove_bodies")
        XCTAssertEqual(failure.level, .error)
        try logs.assertOperationMetadata()
    }

    func testExplicitRetryRejectsRetainedCaptureFailure() async throws {
        let (context, module) = try makeModule()
        module.failCapture(captureError)
        let rejection = try await outcome("retryConnection()", in: context)
        XCTAssertTrue(rejection.contains("WHOOP_BLE_CAPTURE_FAILED"), rejection)
        XCTAssertTrue(rejection.contains(captureError.localizedDescription), rejection)
    }

    func testSuspendedCaptureRejectsConnectAndRetry() async throws {
        let (context, module) = try makeModule()
        module.connectionManager.syncOnBleQueue { module.captureSuspended = true }
        for call in ["connect('invalid-peripheral-id')", "retryConnection()"] {
            let rejection = try await outcome(call, in: context)
            XCTAssertTrue(rejection.contains("WHOOP_BLE_CAPTURE_SUSPENDED"), rejection)
        }
    }

    func testSuccessfulUploadConfigurationRestoresConnectionEligibility() async throws {
        let (context, module) = try makeModule()
        module.failCapture(captureError)
        let runtime = try context.runtime
        let configured = try await runtime.evalAsync("""
                expo.modules.WhoopBle.configureUpload({
                    userId: 'bridge-test-account', serverURL: 'https://example.com',
                    token: 'test-session', headers: {}
                }).then(() => 'configured');
                """).ref()
        let configuration = try await runtime.execute { try configured.take().asString() }
        XCTAssertEqual(configuration, "configured")
        defer { XCTAssertNoThrow(try module.uploader.disable()) }

        let rejection = try await outcome("connect('invalid-peripheral-id')", in: context)
        XCTAssertTrue(rejection.contains("INVALID_ID"), rejection)
        module.connectionManager.syncOnBleQueue {
            XCTAssertNil(module.captureFailure)
            XCTAssertFalse(module.captureSuspended)
        }
    }

    func testQueuedCaptureFailureIsObservedBeforeConnectDispatch() async throws {
        let (context, module) = try makeModule()
        let error = captureError
        let failure = DispatchWorkItem { module.failCapture(error) }
        module.connectionManager.bleQueue.async(execute: failure)
        let rejection = try await outcome("connect('invalid-peripheral-id')", in: context)
        XCTAssertTrue(rejection.contains("WHOOP_BLE_CAPTURE_FAILED"), rejection)
        module.connectionManager.syncOnBleQueue {
            XCTAssertEqual(module.connectionManager.state, .idle)
            XCTAssertFalse(module.connectionManager.autoReconnect)
        }
    }
}
