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
        let priorCutoff = UserDefaults.standard.object(forKey: "dofek_device_erasure_cutoff_v1")
        defer {
            if let priorCutoff {
                UserDefaults.standard.set(priorCutoff, forKey: "dofek_device_erasure_cutoff_v1")
            } else {
                UserDefaults.standard.removeObject(forKey: "dofek_device_erasure_cutoff_v1")
            }
        }
        let (context, module) = try makeModule()
        defer { XCTAssertNoThrow(try module.uploader.disable()) }
        let runtime = try context.runtime
        let initialGeneration = try XCTUnwrap(try module.uploader.diagnostics()["bufferInstanceId"] as? String)
        let blocked = expectation(description: "BLE queue occupied")
        let release = DispatchSemaphore(value: 0)
        blockBleQueue(module, until: release, signals: blocked)
        defer { release.signal() }
        await fulfillment(of: [blocked], timeout: 5)

        try await startCleanupAndProbe(runtime)
        await fulfillment(of: [cleanupStarted], timeout: 5)
        guard try await probeResolvesBeforeRelease(runtime, release: release) else { return }
        try await assertCleanupIsStillQueued(runtime)

        release.signal()
        try await assertCleanupResolves(runtime)
        try assertCutoffAndGeneration(module, initialGeneration: initialGeneration, priorCutoff: priorCutoff)
        try await assertCaptureStaysSuspended(context)
    }

    func testCleanupLeavesJavaScriptResponsiveWhileWaitingForBleQueue() async throws {
        let hasRetainedCutoff =
            UserDefaults.standard.object(forKey: "dofek_device_erasure_cutoff_v1") is Date
        let logs = CleanupLogRecorder()
        let entered = expectation(description: "Native cleanup entry while BLE queue is occupied")
        await logs.start(entry: entered)
        defer { SentrySDK.close() }
        let (context, module) = try makeModule()
        let runtime = try context.runtime
        let blocked = expectation(description: "BLE queue occupied")
        let release = DispatchSemaphore(value: 0)
        blockBleQueue(module, until: release, signals: blocked)
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
        XCTAssertEqual(
            records.map { $0.attributes["stage"]?.value as? String },
            expectedCleanupStages(hasRetainedCutoff: hasRetainedCutoff)
        )
        try logs.assertOperationMetadata()
        module.connectionManager.syncOnBleQueue { XCTAssertTrue(module.captureSuspended) }
    }
}

extension WhoopBleModuleTests {
    func testExplicitConnectRejectsRetainedCaptureFailure() async throws {
        let (context, module) = try makeModule()
        module.failCapture(captureError)
        let rejection = try await outcome("connect('invalid-peripheral-id')", in: context)
        XCTAssertTrue(rejection.contains("WHOOP_BLE_CAPTURE_FAILED"), rejection)
        XCTAssertTrue(rejection.contains("The capture database is unavailable"), rejection)
    }

    func testCleanupFailureLogsTheStageAndStillThrows() async throws {
        let logs = CleanupLogRecorder()
        let captures = SentryCaptureRecorder()
        let cleanupStarted = expectation(description: "Disable reached cleanup while BLE is blocked")
        await MainActor.run {
            captures.start(userId: "account-A", logs: logs, logEntry: cleanupStarted)
        }
        defer { SentrySDK.close() }
        let cleanupEventCaptured = expectation(description: "Disable failure passed through Sentry beforeSend")
        let controlEventCaptured = expectation(description: "Control event passed through Sentry beforeSend")
        captures.expect(cleanupEventCaptured, matching: "bodies")
        captures.expect(controlEventCaptured, matching: "NativeAttributionControl")
        let (context, module) = try makeModule()
        _ = try module.uploader
        let fixture = try makeBodyRemovalFailure()
        defer {
            XCTAssertNoThrow(try restoreBodyDirectory(fixture.directory, backup: fixture.backup))
        }
        let blocked = expectation(description: "BLE queue occupied during disable failure")
        let release = DispatchSemaphore(value: 0)
        module.connectionManager.bleQueue.async {
            blocked.fulfill()
            release.wait()
        }
        defer { release.signal() }
        await fulfillment(of: [blocked], timeout: 5)

        let cleanup = Task { try await outcome("disableUploads()", in: context) }
        await fulfillment(of: [cleanupStarted], timeout: 5)
        await MainActor.run {
            identifySyntheticSentryUser("account-B")
        }
        release.signal()
        let rejection = try await cleanup.value
        XCTAssertNotEqual(rejection, "unexpected success")
        await fulfillment(of: [cleanupEventCaptured], timeout: 5)
        XCTAssertEqual(captures.snapshot.count, 1, "Captured Sentry events: \(captures.snapshot)")
        let cleanupEvents = captures.snapshot.filter { $0.errorText.contains("bodies") }
        XCTAssertEqual(cleanupEvents.count, 1, "Captured Sentry events: \(captures.snapshot)")
        if let cleanupEvent = cleanupEvents.first {
            XCTAssertNotEqual(cleanupEvent.userId, "account-B")
        } else {
            XCTFail("Expected the disable failure event to reach beforeSend")
        }

        SentrySDK.capture(error: NSError(domain: "NativeAttributionControl", code: 1))
        await fulfillment(of: [controlEventCaptured], timeout: 5)
        XCTAssertEqual(captures.snapshot.count, 2, "Captured Sentry events: \(captures.snapshot)")
        let controlEvents = captures.snapshot.filter { $0.errorText.contains("NativeAttributionControl") }
        XCTAssertEqual(controlEvents.count, 1, "Captured Sentry events: \(captures.snapshot)")
        if let controlEvent = controlEvents.first {
            XCTAssertEqual(controlEvent.userId, "account-B")
        } else {
            XCTFail("Expected the control event to reach beforeSend")
        }

        let failure = try XCTUnwrap(logs.snapshot.last)
        XCTAssertEqual(failure.attributes["stage"]?.value as? String, "failed")
        XCTAssertEqual(failure.attributes["failedStage"]?.value as? String, "uploader_remove_bodies")
        XCTAssertEqual(failure.level, .error)
        SentrySDK.logger.info("NativeAttributionLogControl")
        logs.assertAnonymousCleanupAndAttributedControl(userId: "account-B")
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

        let configure = """
            configureUpload({
                userId: 'bridge-test-account', serverURL: 'https://example.com',
                token: 'test-session', headers: {}
            })
            """
        let rejectedConfiguration = try await outcome(configure, in: context)
        XCTAssertNotEqual(rejectedConfiguration, "unexpected success")
        module.connectionManager.syncOnBleQueue { XCTAssertTrue(module.captureSuspended) }

        let retriedCleanup = try await outcome("disableUploads()", in: context)
        XCTAssertEqual(retriedCleanup, "unexpected success")
        let configured = try await outcome(configure, in: context)
        XCTAssertEqual(configured, "unexpected success")
        module.connectionManager.syncOnBleQueue { XCTAssertFalse(module.captureSuspended) }
    }

    func testFailedErasureRejectsConfigurationQueuedBehindPurge() async throws {
        let captures = SentryCaptureRecorder()
        await MainActor.run { captures.start(userId: "account-A") }
        defer { SentrySDK.close() }
        let cleanupEventCaptured = expectation(description: "Erasure failure passed through Sentry beforeSend")
        let controlEventCaptured = expectation(description: "Control event passed through Sentry beforeSend")
        captures.expect(cleanupEventCaptured, matching: "bodies")
        captures.expect(controlEventCaptured, matching: "NativeAttributionControl")
        let (context, module) = try makeModule()
        _ = try module.uploader
        let priorCutoff = UserDefaults.standard.object(forKey: "dofek_device_erasure_cutoff_v1")
        defer {
            if let priorCutoff {
                UserDefaults.standard.set(priorCutoff, forKey: "dofek_device_erasure_cutoff_v1")
            } else {
                UserDefaults.standard.removeObject(forKey: "dofek_device_erasure_cutoff_v1")
            }
        }
        let requestedCutoff = try XCTUnwrap(ISO8601DateFormatter().date(from: "2001-01-01T00:00:00Z"))
        let expectedCutoff = max(priorCutoff as? Date ?? requestedCutoff, requestedCutoff)
        let cutoffWritten = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                UserDefaults.standard.object(forKey: "dofek_device_erasure_cutoff_v1") as? Date == expectedCutoff
            },
            object: nil
        )
        let fixture = try makeBodyRemovalFailure()
        defer {
            XCTAssertNoThrow(try restoreBodyDirectory(fixture.directory, backup: fixture.backup))
            XCTAssertNoThrow(try module.uploader.disable())
        }

        let blocked = expectation(description: "BLE queue occupied before erasure")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let runtime = try await queueErasureWhileBleQueueIsBlocked(
            context, module: module, blocked: blocked, release: release, cutoffWritten: cutoffWritten
        )
        await MainActor.run {
            SentrySDK.configureScope { scope in scope.setUser(Sentry.User(userId: "account-B")) }
        }

        let configureWaiter = await assertConfigureWaitsBehindPurge(runtime)
        release.signal()
        try await assertBlockedPurgeResults(
            runtime, expectedCutoff: expectedCutoff, configureWaiter: configureWaiter
        )
        await assertSentryErasureAttribution(
            captures, cleanupCaptured: cleanupEventCaptured, controlCaptured: controlEventCaptured
        )
        try await assertFailureFencePersistsAfterRestore(
            directory: fixture.directory, backup: fixture.backup, context: context, module: module
        )
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

        let configure = """
            configureUpload({
                userId: 'bridge-test-account', serverURL: 'https://example.com',
                token: 'test-session', headers: {}
            })
            """
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

extension SQLiteCutoffFailureFixture {
    var configurationCall: String {
        """
        configureUpload({
            userId: 'bridge-test-account', serverURL: 'https://example.com',
            token: 'test-session', headers: {}
        })
        """
    }

    func assertPurgeFailure(context: TestAppContext, module: WhoopBleModule) async throws {
        let date = ISO8601DateFormatter().string(from: cutoff)
        let result = try await outcome("purgeAccountState('\(date)')", in: context)
        XCTAssertTrue(result.contains("WHOOP_BLE_PURGE_FAILED"), result)
        XCTAssertTrue(result.contains("cutoff fixture rejected write"), result)
        XCTAssertEqual(
            UserDefaults.standard.object(forKey: "dofek_device_erasure_cutoff_v1") as? Date,
            cutoff
        )
        XCTAssertEqual(try persistedCutoff, originalCutoff)
        module.connectionManager.syncOnBleQueue { XCTAssertTrue(module.captureSuspended) }
        let configure = try await outcome(configurationCall, in: context)
        XCTAssertTrue(configure.contains("configuration is blocked because cleanup failed"), configure)
    }

    func assertDisableFailure(
        context: TestAppContext,
        module: WhoopBleModule,
        logs: CleanupLogRecorder
    ) async throws {
        let results = try await queuedOutcomes(["disableUploads()", configurationCall], in: context)
        XCTAssertEqual(results.count, 2)
        let disable = try XCTUnwrap(results.first)
        let configure = try XCTUnwrap(results.dropFirst().first)
        XCTAssertTrue(disable.contains("cutoff fixture rejected write"), disable)
        XCTAssertTrue(configure.contains("configuration is blocked because cleanup failed"), configure)
        XCTAssertTrue(configure.contains("cutoff fixture rejected write"), configure)
        XCTAssertEqual(
            UserDefaults.standard.object(forKey: "dofek_device_erasure_cutoff_v1") as? Date,
            cutoff
        )
        XCTAssertEqual(try persistedCutoff, originalCutoff)
        module.connectionManager.syncOnBleQueue { XCTAssertTrue(module.captureSuspended) }
        let failedStage = logs.snapshot.last { $0.attributes["stage"]?.value as? String == "failed" }
            .flatMap { $0.attributes["failedStage"]?.value as? String }
        XCTAssertEqual(
            failedStage, "uploader_advance_erasure_cutoff", "Captured stages: \(logs.snapshot)"
        )
    }

    func assertRecovery(
        context: TestAppContext,
        module: WhoopBleModule,
        uploader: WhoopBleBackgroundUploader
    ) async throws {
        let disabled = try await outcome("disableUploads()", in: context)
        XCTAssertEqual(disabled, "unexpected success")
        let retainedUploader = try module.uploader
        XCTAssertTrue(retainedUploader === uploader)
        let stored = try XCTUnwrap(Double(try XCTUnwrap(persistedCutoff)))
        XCTAssertEqual(stored, cutoff.timeIntervalSince1970)
        let configured = try await outcome(configurationCall, in: context)
        XCTAssertEqual(configured, "unexpected success")
        module.connectionManager.syncOnBleQueue { XCTAssertFalse(module.captureSuspended) }
    }

    func assertBoundary() throws {
        var store: WhoopBleSampleStore? = try WhoopBleSampleStore(directory: databaseDirectory)
        try XCTUnwrap(store).configure(
            WhoopUploadBinding(userId: "boundary-owner", serverURL: "https://example.com")
        )
        let dates = [-1.0, 0.0, 1.0].map { cutoff.addingTimeInterval($0) }
        let formatter = ISO8601DateFormatter()
        let samples = dates.map {
            ["timestamp": formatter.string(from: $0), "heartRateBpm": 70] as [String: Any]
        }
        try XCTUnwrap(store).append(deviceId: "test-device", samplesByStream: [.realtime: samples])
        let statistics = try XCTUnwrap(store).statistics(stream: .realtime)
        XCTAssertEqual(statistics["receivedCount"] as? Int, 3)
        XCTAssertEqual(statistics["erasureDiscardedCount"] as? Int, 2)
        XCTAssertEqual(statistics["count"] as? Int, 1)
        let batch = try XCTUnwrap(try XCTUnwrap(store).reserve(stream: .realtime))
        XCTAssertEqual(try realtimeBatchTimestamps(batch), [formatter.string(from: dates[2])])
        store = nil

        let reopened = try WhoopBleSampleStore(directory: databaseDirectory)
        XCTAssertEqual(try reopened.queuedCount(stream: .realtime), 1)
        let recovered = try XCTUnwrap(try reopened.reserve(stream: .realtime))
        XCTAssertEqual(try realtimeBatchTimestamps(recovered), [formatter.string(from: dates[2])])
    }

    private func realtimeBatchTimestamps(_ batch: WhoopStoredBatch) throws -> [String] {
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: batch.body) as? [String: Any])
        let samples = try XCTUnwrap(body["samples"] as? [[String: Any]])
        return try samples.map { try XCTUnwrap($0["timestamp"] as? String) }
    }
}

extension WhoopBleModuleTests {
    func blockBleQueue(
        _ module: WhoopBleModule,
        until release: DispatchSemaphore,
        signals blocked: XCTestExpectation
    ) {
        module.connectionManager.bleQueue.async {
            blocked.fulfill()
            release.wait()
        }
    }

    func assertCleanupIsStillQueued(_ runtime: JavaScriptRuntime) async throws {
        try await runtime.execute {
            XCTAssertFalse(try runtime.eval("globalThis.cleanupFinished").asBool())
            XCTAssertFalse(try runtime.eval("globalThis.configureFinished").asBool())
            XCTAssertFalse(try runtime.eval("globalThis.purgeFinished").asBool())
        }
    }

    func assertCutoffAndGeneration(
        _ module: WhoopBleModule,
        initialGeneration: String,
        priorCutoff: Any?
    ) throws {
        let retainedCutoff = try XCTUnwrap(
            UserDefaults.standard.object(forKey: "dofek_device_erasure_cutoff_v1") as? Date
        )
        let requested = try XCTUnwrap(ISO8601DateFormatter().date(from: "2000-01-01T00:00:00Z"))
        XCTAssertEqual(retainedCutoff, max(priorCutoff as? Date ?? requested, requested))
        let generation = try XCTUnwrap(try module.uploader.diagnostics()["bufferInstanceId"] as? String)
        XCTAssertNotEqual(generation, initialGeneration)
    }
}

extension WhoopBleModuleTests {
    func testFailedCutoffCommitRecoversThroughDisableOnSameUploader() async throws {
        let userDefaultsCutoff = UserDefaults.standard.object(forKey: "dofek_device_erasure_cutoff_v1")
        let (context, module) = try makeModule()
        let uploader = try module.uploader
        let fixture = try SQLiteCutoffFailureFixture(
            databaseDirectory: try whoopUploadDatabaseDirectory(),
            userDefaultsCutoff: userDefaultsCutoff
        )
        let logs = CleanupLogRecorder()
        await MainActor.run {
            logs.start()
        }
        defer {
            restoreCutoffFixture(fixture, uploader: uploader)
            SentrySDK.close()
        }

        try uploader.disable()
        try fixture.installFailureTrigger()
        let configured = try await outcome(fixture.configurationCall, in: context)
        XCTAssertEqual(configured, "unexpected success")
        try await fixture.assertPurgeFailure(context: context, module: module)
        try await fixture.assertDisableFailure(context: context, module: module, logs: logs)
        try fixture.dropFailureTrigger()
        try await fixture.assertRecovery(context: context, module: module, uploader: uploader)
        try uploader.disable()
        try fixture.assertBoundary()
    }
}
