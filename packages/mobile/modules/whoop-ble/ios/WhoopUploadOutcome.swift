import Foundation

typealias WhoopUploadCompletionContext = (
    attempt: Int?, responseURL: URL?, taskIdentifier: Int?, transportPath: String?
)
typealias WhoopUploadCompletion = (
    String, Int?, Data, WhoopUploadCompletionContext, Error?
) -> Void

struct WhoopUploadOutcome {
    let batchIdentity: String
    let stream: String
    let route: String
    var stage: String
    let statusCode: Int?
    var responseOriginValidated: Bool?
    var acknowledgmentValidated: Bool
    var outboxState: String
    let batchSampleCount: Int?
    let attempt: Int?
    let taskIdentifier: Int?
    let transportPath: String?
    let siblingTaskPending: Bool?
    let occurredAt: String
    var transportConnectionLost = false
    var connectionLossRecoveryDuration: Duration?

    static func isNetworkConnectionLost(_ error: Error?) -> Bool {
        guard let error else { return false }
        let networkError = error as NSError
        return networkError.domain == NSURLErrorDomain && networkError.code == NSURLErrorNetworkConnectionLost
    }

    var isValidatedHttp5xxRejection: Bool {
        responseOriginValidated == true && stage == "http_status_rejected" &&
            statusCode.map { (500..<600).contains($0) } == true
    }

    var isValidatedHttp408Rejection: Bool {
        responseOriginValidated == true && stage == "http_status_rejected" &&
            statusCode == 408
    }

    var sentryData: [String: Any] {
        var data: [String: Any] = [
            "batchIdentity": batchIdentity,
            "stream": stream,
            "route": route,
            "stage": stage,
            "acknowledgmentValidated": acknowledgmentValidated,
            "outboxState": outboxState,
            "occurredAt": occurredAt,
        ]
        if let statusCode { data["statusCode"] = statusCode }
        if let responseOriginValidated { data["responseOriginValidated"] = responseOriginValidated }
        if let batchSampleCount { data["batchSampleCount"] = batchSampleCount }
        if let attempt { data["attempt"] = attempt }
        if let taskIdentifier { data["taskIdentifier"] = taskIdentifier }
        if let transportPath { data["transportPath"] = transportPath }
        if let siblingTaskPending { data["siblingTaskPending"] = siblingTaskPending }
        return data
    }

    static func received(
        identity: String,
        batch: WhoopStoredBatch,
        response: WhoopUploadResponse,
        context: WhoopUploadCompletionContext,
        occurredAt: String
    ) -> Self {
        Self(
            batchIdentity: identity, stream: batch.stream.rawValue, route: batch.stream.route,
            stage: response.error == nil ? "response_received" : "transport_error", statusCode: response.status,
            responseOriginValidated: nil, acknowledgmentValidated: false, outboxState: "pending",
            batchSampleCount: batch.sampleCount, attempt: context.attempt,
            taskIdentifier: context.taskIdentifier, transportPath: context.transportPath,
            siblingTaskPending: nil, occurredAt: occurredAt,
            transportConnectionLost: isNetworkConnectionLost(response.error))
    }

    static func batchNotFound(
        identity: String,
        status: Int?,
        context: WhoopUploadCompletionContext,
        occurredAt: String
    ) -> Self {
        Self(
            batchIdentity: identity, stream: "unknown", route: "unknown", stage: "batch_not_found",
            statusCode: status, responseOriginValidated: nil, acknowledgmentValidated: false,
            outboxState: "absent", batchSampleCount: nil, attempt: context.attempt,
            taskIdentifier: context.taskIdentifier, transportPath: context.transportPath,
            siblingTaskPending: nil, occurredAt: occurredAt)
    }
}

/// Queue-confined counters and recovery state for the pending durable reservations.
struct WhoopUploadMetrics {
    private let now: () -> ContinuousClock.Instant
    private var http5xxResponseCount = 0
    private var http408ResponseCount = 0
    private var http408RecoveredBatchCount = 0
    private var http408BatchIdentities: Set<String> = []
    private var firstConnectionLoss: [WhoopUploadStream: (identity: String, instant: ContinuousClock.Instant)] = [:]

    init(now: @escaping () -> ContinuousClock.Instant) {
        self.now = now
    }

    var counters: [String: Int] {
        [
            "http5xxResponseCount": http5xxResponseCount,
            "http408ResponseCount": http408ResponseCount,
            "http408RecoveredBatchCount": http408RecoveredBatchCount,
        ]
    }

    mutating func recordOperationalHTTPRejection(_ outcome: WhoopUploadOutcome?) -> Bool {
        guard let outcome else { return false }
        if outcome.isValidatedHttp5xxRejection {
            http5xxResponseCount += 1
            return true
        }
        if outcome.isValidatedHttp408Rejection {
            http408ResponseCount += 1
            http408BatchIdentities.insert(outcome.batchIdentity)
            return true
        }
        return false
    }

    mutating func recordConnectionLoss(_ outcome: WhoopUploadOutcome?, stream: WhoopUploadStream) {
        guard let outcome, outcome.transportConnectionLost,
              firstConnectionLoss[stream]?.identity != outcome.batchIdentity else { return }
        firstConnectionLoss[stream] = (outcome.batchIdentity, now())
    }

    mutating func finishReservation(_ identity: String, stream: WhoopUploadStream, retired: Bool) -> Duration? {
        let hadHTTP408 = http408BatchIdentities.remove(identity) != nil
        if retired, hadHTTP408 { http408RecoveredBatchCount += 1 }
        guard let loss = firstConnectionLoss[stream], loss.identity == identity else { return nil }
        firstConnectionLoss[stream] = nil
        return retired ? loss.instant.duration(to: now()) : nil
    }

    mutating func retainReservations(_ identities: Set<String>) {
        http408BatchIdentities.formIntersection(identities)
        firstConnectionLoss = firstConnectionLoss.filter { identities.contains($0.value.identity) }
    }

    mutating func resetReservations() {
        http408BatchIdentities.removeAll()
        firstConnectionLoss.removeAll()
    }
}

enum WhoopUploadTelemetry {
    static let contextKey = "com.dofek.whoop_upload_context"
    static let transportContextKey = "com.dofek.whoop_upload_transport_context"

    static func adding(_ context: [String: Any], to error: Error, key: String = contextKey) -> NSError {
        let original = error as NSError
        var userInfo = original.userInfo
        userInfo[key] = context
        return NSError(domain: original.domain, code: original.code, userInfo: userInfo)
    }
}
