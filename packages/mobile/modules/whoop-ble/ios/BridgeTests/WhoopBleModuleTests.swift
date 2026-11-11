@testable import ExpoModulesCore
import ExpoModulesTestCore
import RNSentry
import XCTest
@testable import ExpoWhoopBle

final class WhoopBleModuleTests: XCTestCase {
    func testCleanupQueueLeavesUnrelatedAsyncProbeResponsiveAndQueuesConfiguration() async throws {
        let logs = CleanupLogRecorder()
        let cleanupStarted = expectation(description: "Native cleanup entered while BLE queue is occupied")
        await logs.start(entry: cleanupStarted)
        defer { SentrySDK.close() }
        let (context, module) = try makeModule()
        defer { XCTAssertNoThrow(try module.uploader.disable()) }
        let runtime = try context.runtime
        let blocked = expectation(description: "BLE queue occupied")
        let release = DispatchSemaphore(value: 0)
        module.connectionManager.bleQueue.async {
            blocked.fulfill()
            release.wait()
        }
        defer { release.signal() }
        await fulfillment(of: [blocked], timeout: 5)

        try await runtime.execute {
            _ = try runtime.eval("""
                globalThis.cleanupFinished = false;
                globalThis.configureFinished = false;
                globalThis.cleanupPromise = expo.modules.WhoopBle.disableUploads().then(() => {
                    globalThis.cleanupFinished = true;
                    return true;
                });
                globalThis.configurePromise = expo.modules.WhoopBle.configureUpload({
                    userId: 'bridge-test-account', serverURL: 'https://example.com',
                    token: 'test-session', headers: {}
                }).then(() => {
                    globalThis.configureFinished = true;
                    return true;
                });
                globalThis.probePromise = expo.modules.BridgeProbe.probe();
                """)
        }
        await fulfillment(of: [cleanupStarted], timeout: 5)
        let probeReturned = expectation(description: "Unrelated Expo async probe promise resolved")
        let probe = Task {
            let result = try await runtime.evalAsync("globalThis.probePromise").ref()
            let value = try await runtime.execute { try result.take().asBool() }
            XCTAssertTrue(value)
            probeReturned.fulfill()
        }
        let probeResponse = await XCTWaiter.fulfillment(of: [probeReturned], timeout: 5)
        XCTAssertEqual(probeResponse, .completed)
        guard probeResponse == .completed else {
            release.signal()
            try await probe.value
            return
        }
        try await probe.value

        try await runtime.execute {
            XCTAssertFalse(try runtime.eval("globalThis.cleanupFinished").asBool())
            XCTAssertFalse(try runtime.eval("globalThis.configureFinished").asBool())
        }

        release.signal()
        let cleanup = try await runtime.evalAsync("globalThis.cleanupPromise").ref()
        let cleanupResult = try await runtime.execute { try cleanup.take().asBool() }
        XCTAssertTrue(cleanupResult)
        let configured = try await runtime.evalAsync("globalThis.configurePromise").ref()
        let configuredResult = try await runtime.execute { try configured.take().asBool() }
        XCTAssertTrue(configuredResult)
    }

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
        let fixture = try makeBodyRemovalFailure()
        defer {
            XCTAssertNoThrow(try restoreBodyDirectory(fixture.directory, backup: fixture.backup))
        }
        let rejection = try await outcome("disableUploads()", in: context)
        XCTAssertNotEqual(rejection, "unexpected success")
        let failure = try XCTUnwrap(logs.snapshot.last)
        XCTAssertEqual(failure.attributes["stage"]?.value as? String, "failed")
        XCTAssertEqual(failure.attributes["failedStage"]?.value as? String, "uploader_remove_bodies")
        XCTAssertEqual(failure.level, .error)
        try logs.assertOperationMetadata()
    }

    func testCleanupFailureKeepsConfigurationFencedUntilSuccessfulRetry() async throws {
        let (context, module) = try makeModule()
        _ = try module.uploader
        let fixture = try makeBodyRemovalFailure()
        defer {
            XCTAssertNoThrow(try restoreBodyDirectory(fixture.directory, backup: fixture.backup))
            XCTAssertNoThrow(try module.uploader.disable())
        }

        let cleanupFailure = try await outcome("disableUploads()", in: context)
        XCTAssertNotEqual(cleanupFailure, "unexpected success")
        module.connectionManager.syncOnBleQueue { XCTAssertTrue(module.captureSuspended) }
        try restoreBodyDirectory(fixture.directory, backup: fixture.backup)

        let configure = "configureUpload({userId: 'bridge-test-account', serverURL: 'https://example.com', token: 'test-session', headers: {}})"
        let rejectedConfiguration = try await outcome(configure, in: context)
        XCTAssertNotEqual(rejectedConfiguration, "unexpected success")
        module.connectionManager.syncOnBleQueue { XCTAssertTrue(module.captureSuspended) }

        let retriedCleanup = try await outcome("disableUploads()", in: context)
        XCTAssertEqual(retriedCleanup, "unexpected success")
        let configured = try await outcome(configure, in: context)
        XCTAssertEqual(configured, "unexpected success")
        module.connectionManager.syncOnBleQueue { XCTAssertFalse(module.captureSuspended) }
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

    func testFreshModuleKeepsCaptureSuspendedUntilSuccessfulConfiguration() async throws {
        let (context, module) = try makeModule()
        defer { XCTAssertNoThrow(try module.uploader.disable()) }

        let initialRejection = try await outcome("connect('invalid-peripheral-id')", in: context)
        XCTAssertTrue(initialRejection.contains("WHOOP_BLE_CAPTURE_SUSPENDED"), initialRejection)
        module.connectionManager.syncOnBleQueue { XCTAssertTrue(module.captureSuspended) }

        let configure = "configureUpload({userId: 'bridge-test-account', serverURL: 'https://example.com', token: 'test-session', headers: {}})"
        let configuration = try await outcome(configure, in: context)
        XCTAssertEqual(configuration, "unexpected success")

        let configuredRejection = try await outcome("connect('invalid-peripheral-id')", in: context)
        XCTAssertTrue(configuredRejection.contains("INVALID_ID"), configuredRejection)
        module.connectionManager.syncOnBleQueue { XCTAssertFalse(module.captureSuspended) }
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
