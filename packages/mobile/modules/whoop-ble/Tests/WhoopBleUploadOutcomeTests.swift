import Foundation
import XCTest
@testable import WhoopBLE

extension WhoopBleBackgroundUploaderTests {
    func testOnlyValidatedOriginHttp5xxOutcomesAreSuppressed() {
        func outcome(stage: String, status: Int, originValidated: Bool?) -> WhoopUploadOutcome {
            WhoopUploadOutcome(
                batchIdentity: "generation.batch", stream: "imu", route: "inertialMeasurementUnitSync.pushSamples",
                stage: stage, statusCode: status, responseOriginValidated: originValidated,
                acknowledgmentValidated: false, outboxState: "pending", batchSampleCount: 1,
                attempt: 1, taskIdentifier: 7, transportPath: "live", siblingTaskPending: false,
                occurredAt: "2026-11-16T00:00:00Z")
        }

        XCTAssertTrue(outcome(stage: "http_status_rejected", status: 503, originValidated: true).isValidatedHttp5xxRejection)
        XCTAssertFalse(outcome(stage: "response_origin_rejected", status: 503, originValidated: false).isValidatedHttp5xxRejection)
        XCTAssertFalse(outcome(stage: "transport_error", status: 503, originValidated: nil).isValidatedHttp5xxRejection)
    }

    func testAttemptFailureReportsDurableBatchAndTransportTaskContext() throws {
        var errors: [Error] = []
        let (uploader, store, transport) = try setup(reportError: { errors.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.imu: rows])
        try uploader.flush(); try settle(uploader)
        let identity = try XCTUnwrap(transport.requests.first?.2)
        let transportContext: [String: Any] = [
            "taskIdentifier": 2806,
            "transportPath": "background",
            "siblingTaskPending": true,
        ]
        let error = NSError(domain: NSURLErrorDomain, code: -1001, userInfo: [
            NSLocalizedDescriptionKey: "The request timed out.",
            "com.dofek.whoop_upload_transport_context": transportContext,
        ])

        transport.failOnePath(identity: identity, error: error)
        try settle(uploader)

        let capturedError = try XCTUnwrap(errors.first as NSError?)
        let context = try XCTUnwrap(capturedError.userInfo["com.dofek.whoop_upload_context"] as? [String: Any])
        XCTAssertEqual(capturedError.domain, NSURLErrorDomain)
        XCTAssertEqual(capturedError.code, -1001)
        XCTAssertEqual(context["batchIdentity"] as? String, identity)
        XCTAssertEqual(context["stream"] as? String, "imu")
        XCTAssertEqual(context["batchSampleCount"] as? Int, 1)
        XCTAssertEqual(context["attempt"] as? Int, 1)
        XCTAssertEqual(context["taskIdentifier"] as? Int, 2806)
        XCTAssertEqual(context["transportPath"] as? String, "background")
        XCTAssertEqual(context["siblingTaskPending"] as? Bool, true)
        XCTAssertEqual(context["stage"] as? String, "path_failed_fallback_active")
        XCTAssertEqual(context["route"] as? String, "inertialMeasurementUnitSync.pushSamples")
        XCTAssertEqual(context["outboxState"] as? String, "pending")
        XCTAssertEqual(try store.pendingBatches().map { $0.generation + "." + $0.id }, [identity])
    }

    func testValidatedAcknowledgmentReportsBatchAndOutboxRetirement() throws {
        let (uploader, store, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.imu: rows])
        try uploader.flush(); try settle(uploader)
        let identity = try XCTUnwrap(transport.requests.first?.2)

        transport.complete(0)
        try settle(uploader)

        let outcome = try XCTUnwrap(uploader.diagnostics()["lastUploadOutcome"] as? [String: Any])
        XCTAssertEqual(outcome["stage"] as? String, "outbox_retired")
        XCTAssertEqual(outcome["batchIdentity"] as? String, identity)
        XCTAssertEqual(outcome["stream"] as? String, "imu")
        XCTAssertEqual(outcome["route"] as? String, "inertialMeasurementUnitSync.pushSamples")
        XCTAssertEqual(outcome["batchSampleCount"] as? Int, 1)
        XCTAssertEqual(outcome["statusCode"] as? Int, 200)
        XCTAssertEqual(outcome["responseOriginValidated"] as? Bool, true)
        XCTAssertEqual(outcome["acknowledgmentValidated"] as? Bool, true)
        XCTAssertEqual(outcome["outboxState"] as? String, "retired")
        XCTAssertEqual(outcome["taskIdentifier"] as? Int, 1)
        XCTAssertEqual(outcome["transportPath"] as? String, "test")
        XCTAssertTrue(try store.pendingBatches().isEmpty)
    }

    func testCompletionAfterPurgeReportsAbsentBatchWithoutCreatingAnError() throws {
        var errors: [Error] = []
        var outcomes: [WhoopUploadOutcome] = []
        let (uploader, store, transport) = try setup(
            reportError: { errors.append($0) }, reportUploadOutcome: { outcomes.append($0) })
        try uploader.append(deviceId: "a", samplesByStream: [.imu: rows])
        try uploader.flush(); try settle(uploader)

        try uploader.purge(cutoff: Date(timeIntervalSince1970: 1_792_000_000))
        transport.complete(0)
        try settle(uploader)

        XCTAssertTrue(try store.pendingBatches().isEmpty)
        XCTAssertTrue(errors.isEmpty)
        XCTAssertEqual(outcomes.last?.stage, "batch_not_found")
        XCTAssertEqual(outcomes.last?.outboxState, "absent")
    }

    func testBodyFileCleanupFailureReportsRetiredOutcomeBeforeErrorOnce() throws {
        var errors: [Error] = []
        var outcomes: [WhoopUploadOutcome] = []
        var reportOrder: [String] = []
        let (uploader, store, transport) = try setup(
            reportError: { errors.append($0); reportOrder.append("error") },
            reportUploadOutcome: { outcomes.append($0); reportOrder.append("outcome") },
            removeBodyFile: { _ in throw NSError(domain: "WhoopUploadTest", code: 1) })
        try uploader.append(deviceId: "a", samplesByStream: [.imu: rows])
        try uploader.flush(); try settle(uploader)

        transport.complete(0)
        try settle(uploader)

        XCTAssertEqual(outcomes.count, 1)
        XCTAssertEqual(outcomes.first?.stage, "outbox_retired_cleanup_failed")
        XCTAssertEqual(outcomes.first?.outboxState, "retired")
        XCTAssertEqual(reportOrder, ["outcome", "error"])
        XCTAssertTrue(try store.pendingBatches().isEmpty)
        XCTAssertEqual(errors.count, 1)
    }
}
