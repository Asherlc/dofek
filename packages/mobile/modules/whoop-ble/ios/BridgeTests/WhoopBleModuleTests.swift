@testable import ExpoModulesCore
import ExpoModulesTestCore
import RNSentry
import XCTest
@testable import ExpoWhoopBle

final class WhoopBleModuleTests: XCTestCase {
    func testCleanupLogsReachNativeSdkWhileJavaScriptWaitsForBleQueue() async throws {
        let logs = CleanupLogRecorder()
        let entered = expectation(description: "Native cleanup entry while JavaScript is blocked")
        await MainActor.run {
            SentrySDK.start { options in
                options.dsn = "https://key@sentry.example/123"
                options.beforeSendLog = { log in
                    guard log.attributes["operation"]?.value as? String == "disableUploads" else { return nil }
                    logs.append(log)
                    if log.attributes["stage"]?.value as? String == "ble_suspend" {
                        entered.fulfill()
                    }
                    return nil
                }
            }
        }
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

        let cleanup = Task {
            try await runtime.execute {
                _ = try runtime.eval("expo.modules.WhoopBle.disableUploads()")
            }
        }
        await fulfillment(of: [entered], timeout: 5)
        XCTAssertEqual(logs.snapshot.map { $0.attributes["stage"]?.value as? String }, ["ble_suspend"])
        release.signal()
        try await cleanup.value

        let records = logs.snapshot
        XCTAssertEqual(records.map { $0.attributes["stage"]?.value as? String }, [
            "ble_suspend", "disconnect", "uploader_bootstrap", "uploader_disable", "completed"
        ])
        let operationId = try XCTUnwrap(records.first?.attributes["operationId"]?.value as? String)
        XCTAssertNotNil(UUID(uuidString: operationId))
        XCTAssertTrue(records.allSatisfy { $0.attributes["operationId"]?.value as? String == operationId })
        XCTAssertNotNil(records.last?.attributes["durationMs"]?.value as? Double)
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
        let runtime = try context.runtime
        try await runtime.execute {
            XCTAssertThrowsError(try runtime.eval("expo.modules.WhoopBle.disableUploads(); true").asBool())
        }
        let failure = try XCTUnwrap(logs.snapshot.last)
        XCTAssertEqual(failure.attributes["stage"]?.value as? String, "failed")
        XCTAssertEqual(failure.attributes["failedStage"]?.value as? String, "uploader_disable")
        XCTAssertEqual(failure.level, .error)
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
        try await runtime.execute {
            _ = try runtime.eval("""
                expo.modules.WhoopBle.configureUpload({
                    userId: 'bridge-test-account', serverURL: 'https://example.com',
                    token: 'test-session', headers: {}
                });
                """)
        }
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
