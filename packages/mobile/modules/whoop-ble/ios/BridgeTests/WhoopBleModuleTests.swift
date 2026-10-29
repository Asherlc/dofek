@testable import ExpoModulesCore
import ExpoModulesTestCore
import XCTest
@testable import ExpoWhoopBle

final class WhoopBleModuleTests: XCTestCase {
    func testExplicitConnectRejectsRetainedCaptureFailure() async throws {
        let (context, module) = try makeModule()
        module.failCapture(captureError)
        let rejection = try await outcome("connect('invalid-peripheral-id')", in: context)
        XCTAssertTrue(rejection.contains("WHOOP_BLE_CAPTURE_FAILED"), rejection)
        XCTAssertTrue(rejection.contains("The capture database is unavailable"), rejection)
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
